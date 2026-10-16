/**
 * DEV-A · A5/TD-001 — E2E REAL aislado: crear bot → código pegado → submit →
 * cola `jobs` → worker de builds (MISMO cableado que build-worker-main) →
 * sandbox en contenedor → artefacto firmado → validated → publish → published.
 *
 * Sin UPDATE manual, sin mock del worker ni del sandbox. Docker: el de esta
 * máquina (rootless de ia02) tras el s9-docker-proxy REAL. Opt-in:
 * S9_RUN_DOCKER_SANDBOX_E2E=1 (sin ella el fichero queda SKIPPED, no verde).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { runBuildWorkerOnce } from "../../bot-manager/src/build-worker.js";
import { createBuildExecutor } from "../../bot-manager/src/build-worker-wiring.js";
import { generateServiceKeypair, verifyArtifact } from "../../bot-manager/src/signing.js";
import { resolveBotLaunch } from "../../bot-manager/src/bot-launch.js";
import {
  DOCKER_E2E,
  startDockerSandboxEnv,
  leftoverBotContainers,
  type DockerSandboxEnv,
} from "../../bot-manager/tests/docker-sandbox-env.js";
import { PY_GOOD, PY_CRASH } from "../../bot-manager/tests/sandbox-bots.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOOD_LOADOUT = JSON.parse(
  readFileSync(
    join(__dirname, "..", "..", "..", "packages", "module-catalog", "examples", "loadout-medium-gunner.json"),
    "utf8",
  ),
);

let h: TestDbHandle;
let app: Express;
let env: DockerSandboxEnv;
let dev: string;
const signer = generateServiceKeypair();
const hdr = () => ({ Authorization: `Bearer ${dev}` });

async function createBotWithCode(name: string, code: string) {
  const bot = await request(app).post("/bots").set(hdr()).send({ name });
  expect(bot.status).toBe(201);
  expect((await request(app).post(`/bots/${bot.body.id}/loadouts`).set(hdr()).send(GOOD_LOADOUT)).status).toBe(201);
  const v = await request(app)
    .post(`/bots/${bot.body.id}/versions`)
    .set(hdr())
    .field("runtime", "python")
    .field("loadoutRevision", "1")
    .attach("source", Buffer.from(code), "bot.py");
  expect(v.status).toBe(201);
  return { botId: bot.body.id as string, version: v.body.version as number };
}

function workerEnv(proxyUrl: string): NodeJS.ProcessEnv {
  return { DOCKER_PROXY_URL: proxyUrl, BUILD_SANDBOX_HOST: env.advertiseHost, ARENA_NETWORK: "arena" };
}

describe.skipIf(!DOCKER_E2E)("A5 · E2E real: código de usuario → published (Docker)", () => {
  beforeAll(async () => {
    await initPhysics();
    h = await startTestDb();
    await seedDev(h.db);
    app = createApp({ db: h.db }); // botManager por defecto: QueueBotManager (cola real)
    dev = await tokenFor(h.db, DEV_USERS.developer);
    env = await startDockerSandboxEnv();
  }, 120_000);

  afterAll(async () => {
    await env?.stop();
    await h?.stop();
  });

  it("bot válido: queued → running → passed; versión validated → published con artefacto firmado lanzable", async () => {
    const { botId, version } = await createBotWithCode("fc-a-e2e-ok", PY_GOOD);
    const submit = await request(app).post(`/bots/${botId}/versions/${version}/actions/submit`).set(hdr());
    expect(submit.status).toBe(202);
    expect(submit.body.status).toBe("queued");
    const buildId = submit.body.id as string;

    const { executor, sandbox } = createBuildExecutor(h.db, signer, workerEnv(env.proxyUrl));
    expect(sandbox).not.toBeNull();
    const tick = await runBuildWorkerOnce(h.db, executor, { workerId: "fc-a-e2e" });
    expect(tick.outcome).toBe("done");

    const build = await request(app).get(`/builds/${buildId}`).set(hdr());
    expect(build.body.status, JSON.stringify(build.body.stages)).toBe("passed");
    for (const s of build.body.stages) expect(s.status, s.name).toBe("passed");
    const res = build.body.stages.find((s: { name: string }) => s.name === "resource_limits");
    expect(res.metrics.validCommands).toBeGreaterThan(50);
    expect(build.body.stages.find((s: { name: string }) => s.name === "protocol_test").logs.join("\n")).toMatch(
      /postura del contenedor conforme/,
    );

    const detail = await request(app).get(`/bots/${botId}/versions/${version}`).set(hdr());
    expect(detail.body.state).toBe("validated");
    expect(detail.body.artifact.buildId).toBe(buildId);

    const pub = await request(app).post(`/bots/${botId}/versions/${version}/actions/publish`).set(hdr()).send({});
    expect(pub.status).toBe(200);
    expect(pub.body.state).toBe("published");

    const row = await h.db("bot_versions").where({ bot_id: botId, version }).first();
    const art = await h.db("artifacts").where({ build_id: row.validated_build_id }).first();
    expect(
      verifyArtifact({
        artifactBytes: Buffer.from(art.bytes),
        signedHash: art.hash,
        signature: art.signature,
        publicKey: signer.publicKey,
      }).ok,
    ).toBe(true);
    const launch = await resolveBotLaunch(h.db, botId, version, { publicKey: signer.publicKey });
    expect(launch.artifactHash).toBe(row.artifact_hash);
  });

  it("NEGATIVO · bot que revienta: build failed, versión rejected con la traza del bot, sin publicar", async () => {
    const { botId, version } = await createBotWithCode("fc-a-e2e-crash", PY_CRASH);
    await request(app).post(`/bots/${botId}/versions/${version}/actions/submit`).set(hdr());
    const { executor } = createBuildExecutor(h.db, signer, workerEnv(env.proxyUrl));
    expect((await runBuildWorkerOnce(h.db, executor, { workerId: "fc-a-e2e" })).outcome).toBe("done");
    const v = await h.db("bot_versions").where({ bot_id: botId, version }).first();
    expect(v.state).toBe("rejected");
    expect(v.rejection_reason).toMatch(/fallo deliberado del bot/);
    const pub = await request(app).post(`/bots/${botId}/versions/${version}/actions/publish`).set(hdr()).send({});
    expect(pub.status).toBe(409);
  });

  it("NEGATIVO · fallo del sandbox (proxy caído): reintentos y cierre fail-closed «no verificable», nunca validated", async () => {
    const { botId, version } = await createBotWithCode("fc-a-e2e-infra", PY_GOOD);
    await request(app).post(`/bots/${botId}/versions/${version}/actions/submit`).set(hdr());
    const { executor } = createBuildExecutor(h.db, signer, workerEnv("http://127.0.0.1:9"));
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      await h.db("jobs").where({ kind: "bot_build", status: "queued" }).update({ run_after: h.db.fn.now() });
      outcomes.push((await runBuildWorkerOnce(h.db, executor, { workerId: "fc-a-e2e" })).outcome);
    }
    expect(outcomes).toEqual(["retry", "retry", "needs_review"]);
    const v = await h.db("bot_versions").where({ bot_id: botId, version }).first();
    expect(v.state).toBe("rejected");
    expect(v.rejection_reason).toMatch(/build no verificable: el sandbox no pudo lanzar el contenedor/);
  });

  it("SIN sandbox configurado el worker sigue fallando cerrado (rejected «sandbox no verificado»)", async () => {
    const { botId, version } = await createBotWithCode("fc-a-e2e-nosb", PY_GOOD);
    await request(app).post(`/bots/${botId}/versions/${version}/actions/submit`).set(hdr());
    const { executor, sandbox } = createBuildExecutor(h.db, signer, {});
    expect(sandbox).toBeNull();
    await runBuildWorkerOnce(h.db, executor, { workerId: "fc-a-e2e" });
    const v = await h.db("bot_versions").where({ bot_id: botId, version }).first();
    expect(v.state).toBe("rejected");
    expect(v.rejection_reason).toMatch(/sandbox no verificado/);
  });

  it("no quedan contenedores de bot", async () => {
    expect(await leftoverBotContainers()).toEqual([]);
  });
});
