/**
 * R2.5 (ERR-SEC-12) · Encolado real de builds: submitBotVersion persiste el
 * trabajo en la tabla `jobs` y responde 202; el pipeline corre en el worker del
 * bot-manager (build-worker), NUNCA en el proceso de la API.
 *
 * DoD: "Subir una versión devuelve 202 y el build corre en el worker, no en la API."
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { QueueBotManager } from "./services/bot-manager.js";
import { E6PipelineBotManager } from "./services/e6-bot-manager.js";
import { runBuildWorkerOnce } from "../../bot-manager/src/build-worker.js";
import { generateServiceKeypair } from "../../bot-manager/src/signing.js";
import { pyGoodFiles, goodCandidate, referenceAgent } from "../../bot-manager/tests/fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOOD_LOADOUT = JSON.parse(
  readFileSync(
    join(__dirname, "..", "..", "..", "packages", "module-catalog", "examples", "loadout-medium-gunner.json"),
    "utf8",
  ),
);

let h: TestDbHandle;
let app: Express;
const auth = { Authorization: "" };
const signer = generateServiceKeypair();

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  // Cableado POR DEFECTO de la app: QueueBotManager (encola, no ejecuta).
  app = createApp({ db: h.db });
  auth.Authorization = `Bearer ${await tokenFor(h.db, DEV_USERS.developer)}`;
}, 120_000);

afterAll(async () => {
  await h.stop();
});

async function draftVersion(name: string): Promise<{ botId: string; buildlessSubmit: () => request.Test }> {
  const bot = await request(app).post("/bots").set(auth).send({ name });
  expect(bot.status).toBe(201);
  const loadout = await request(app).post(`/bots/${bot.body.id}/loadouts`).set(auth).send(GOOD_LOADOUT);
  expect(loadout.status).toBe(201);
  const version = await request(app)
    .post(`/bots/${bot.body.id}/versions`)
    .set(auth)
    .field("runtime", "python")
    .field("loadoutRevision", "1")
    .attach("source", Buffer.from(JSON.stringify({ files: pyGoodFiles })), "package.json");
  expect(version.status).toBe(201);
  return {
    botId: bot.body.id as string,
    buildlessSubmit: () => request(app).post(`/bots/${bot.body.id}/versions/1/actions/submit`).set(auth),
  };
}

describe("R2.5 · submitBotVersion encola de verdad (jobs) y responde 202", () => {
  it("202 con build `queued`, trabajo persistido en jobs y pipeline SIN ejecutar en la API", async () => {
    const { botId, buildlessSubmit } = await draftVersion("r25-cola-bot");
    const submit = await buildlessSubmit();
    expect(submit.status).toBe(202);
    // El build NO se ha ejecutado en el proceso de la API: sigue en cola.
    expect(submit.body.status).toBe("queued");
    for (const s of submit.body.stages) expect(s.status).toBe("pending");

    // Trabajo durable en la tabla jobs (patrón de las batallas de E9).
    const job = await h
      .db("jobs")
      .where({ kind: "bot_build", dedupe_key: `bot_build:${submit.body.id}` })
      .first();
    expect(job).toBeTruthy();
    expect(job.status).toBe("queued");
    expect(job.payload.buildId).toBe(submit.body.id);

    // La versión queda en validating a la espera del worker.
    const v = await h.db("bot_versions").where({ bot_id: botId, version: 1 }).first();
    expect(v.state).toBe("validating");
  });

  it("encolar dos veces el mismo build es idempotente (dedupe_key)", async () => {
    const q = new QueueBotManager(h.db);
    const [build] = await h
      .db("builds")
      .insert({ bot_id: (await h.db("bots").first()).id, version: 1, status: "queued", stages: "[]" })
      .returning("*");
    const req = { buildId: build.id as string, botId: build.bot_id as string, version: 1, runtime: "python" as const };
    await q.enqueueBuild(req);
    await q.enqueueBuild(req);
    const jobs = await h.db("jobs").where({ dedupe_key: `bot_build:${build.id}` });
    expect(jobs.length).toBe(1);
  });
});

describe("R2.5 · el worker consume la cola y ejecuta el pipeline", () => {
  /** Aísla cada caso: elimina trabajos en cola de tests anteriores. */
  async function clearQueue(): Promise<void> {
    await h.db("jobs").where({ kind: "bot_build", status: "queued" }).del();
  }

  it("con sandbox en proceso, el worker valida la versión (el build corrió en el worker)", async () => {
    await clearQueue();
    const { botId, buildlessSubmit } = await draftVersion("r25-worker-ok");
    const submit = await buildlessSubmit();
    expect(submit.status).toBe(202);
    expect(submit.body.status).toBe("queued");

    const executor = new E6PipelineBotManager(h.db, { signer, agentResolver: () => goodCandidate, referenceAgent });
    const tick = await runBuildWorkerOnce(h.db, executor, { workerId: "test-worker" });
    expect(tick.outcome).toBe("done");

    const build = await h.db("builds").where({ id: submit.body.id }).first();
    expect(build.status).toBe("passed");
    const v = await h.db("bot_versions").where({ bot_id: botId, version: 1 }).first();
    expect(v.state).toBe("validated");
    const job = await h
      .db("jobs")
      .where({ dedupe_key: `bot_build:${submit.body.id}` })
      .first();
    expect(job.status).toBe("done");
  }, 60_000);

  it("sin sandbox, el worker RECHAZA como 'no verificable' (fail-closed heredado de R1.5)", async () => {
    await clearQueue();
    const { botId, buildlessSubmit } = await draftVersion("r25-worker-nosandbox");
    const submit = await buildlessSubmit();
    const executor = new E6PipelineBotManager(h.db, { signer }); // SIN agentResolver
    const tick = await runBuildWorkerOnce(h.db, executor, { workerId: "test-worker" });
    expect(tick.outcome).toBe("done"); // el trabajo terminó; el RESULTADO es rechazo
    const build = await h.db("builds").where({ id: submit.body.id }).first();
    expect(build.status).toBe("failed");
    const v = await h.db("bot_versions").where({ bot_id: botId, version: 1 }).first();
    expect(v.state).toBe("rejected");
    expect(v.rejection_reason).toMatch(/sandbox no verificado/);
  }, 60_000);

  it("si el executor revienta, reintenta con límite y cierra FAIL-CLOSED (needs_review + rejected)", async () => {
    await clearQueue();
    const { botId, buildlessSubmit } = await draftVersion("r25-worker-boom");
    const submit = await buildlessSubmit();
    const boom = {
      enqueueBuild: async () => {
        throw new Error("infraestructura rota");
      },
    };

    // Tres intentos (max_attempts = 3); `now` avanza para saltar el backoff.
    const t0 = Date.now();
    const r1 = await runBuildWorkerOnce(h.db, boom, { workerId: "w", now: new Date(t0) });
    expect(r1.outcome).toBe("retry");
    const r2 = await runBuildWorkerOnce(h.db, boom, { workerId: "w", now: new Date(t0 + 5 * 60_000) });
    expect(r2.outcome).toBe("retry");
    const r3 = await runBuildWorkerOnce(h.db, boom, { workerId: "w", now: new Date(t0 + 10 * 60_000) });
    expect(r3.outcome).toBe("needs_review");

    const job = await h
      .db("jobs")
      .where({ dedupe_key: `bot_build:${submit.body.id}` })
      .first();
    expect(job.status).toBe("needs_review");
    expect(job.last_error).toMatch(/infraestructura rota/);
    // Fail-closed: nada queda eternamente en cola ni, peor, validado.
    const build = await h.db("builds").where({ id: submit.body.id }).first();
    expect(build.status).toBe("failed");
    const v = await h.db("bot_versions").where({ bot_id: botId, version: 1 }).first();
    expect(v.state).toBe("rejected");
    expect(v.rejection_reason).toMatch(/no verificable/);
  }, 60_000);

  it("cola vacía: el worker queda idle sin efectos", async () => {
    await clearQueue();
    const tick = await runBuildWorkerOnce(h.db, { enqueueBuild: async () => {} }, { workerId: "w" });
    expect(tick.outcome).toBe("idle");
  });
});
