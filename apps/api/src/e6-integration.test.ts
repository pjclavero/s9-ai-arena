/**
 * T7.3 · Integración REAL con el pipeline de E6 (apps/bot-manager):
 * la API delega el build en BuildPipeline de E6, sin stubs de lógica.
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
import { pyGoodFiles, pySecretFiles, goodCandidate, referenceAgent } from "../../bot-manager/tests/fixtures.js";
import { generateServiceKeypair, signArtifact } from "../../bot-manager/src/signing.js";
import { E6PipelineBotManager } from "./services/e6-bot-manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOOD_LOADOUT = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "packages", "module-catalog", "examples", "loadout-medium-gunner.json"), "utf8"),
);

let h: TestDbHandle;
let app: Express;
let dev: string;
const signer = generateServiceKeypair();

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  // Sandbox EN PROCESO (T6.1): un CandidateAgentFactory que produce el bot en el mismo
  // proceso — lo que en prod hará el contenedor con Docker (T6.2). Con él, las etapas
  // protocol_test/smoke_battle/resource_limits SÍ ejecutan el bot y el pipeline valida de
  // verdad. SIN este resolver, E6 falla cerrado (ver el test "SIN sandbox…" más abajo).
  app = createApp({
    db: h.db,
    botManager: new E6PipelineBotManager(h.db, { signer, agentResolver: () => goodCandidate, referenceAgent }),
  });
  dev = await tokenFor(h.db, DEV_USERS.developer);
}, 120000);

afterAll(async () => {
  await h.stop();
});

const auth = { Authorization: "" };

async function setupBotWithSource(name: string, files: { path: string; content: string }[]) {
  auth.Authorization = `Bearer ${dev}`;
  const bot = await request(app).post("/bots").set(auth).send({ name });
  expect(bot.status).toBe(201);
  const loadout = await request(app).post(`/bots/${bot.body.id}/loadouts`).set(auth).send(GOOD_LOADOUT);
  expect(loadout.status).toBe(201);
  const version = await request(app)
    .post(`/bots/${bot.body.id}/versions`)
    .set(auth)
    .field("runtime", "python")
    .field("loadoutRevision", "1")
    .attach("source", Buffer.from(JSON.stringify({ files })), "package.json");
  expect(version.status).toBe(201);
  return { botId: bot.body.id as string, version: version.body.version as number };
}

describe("T7.3 API → pipeline E6 real", () => {
  it("un paquete Python válido pasa el pipeline de E6 (con sandbox) y deja la versión en validated", async () => {
    const { botId, version } = await setupBotWithSource("e6-good-bot", pyGoodFiles());
    const submit = await request(app).post(`/bots/${botId}/versions/${version}/actions/submit`).set(auth);
    expect(submit.status).toBe(202);
    expect(submit.body.status).toBe("passed");

    // Con el sandbox en proceso, TODAS las etapas se ejecutan y pasan DE VERDAD; las de
    // ejecución (protocol_test/smoke_battle/resource_limits) YA NO quedan `skipped`. Ese
    // "skipped ⇒ validated" era justo el bug ERR-SEC-03 (validar sin ejecutar el bot).
    for (const s of submit.body.stages as { name: string; status: string }[]) {
      expect(s.status, s.name).toBe("passed");
    }

    const v = await h.db("bot_versions").where({ bot_id: botId, version }).first();
    expect(v.state).toBe("validated");
    expect(v.artifact_hash).toMatch(/^[0-9a-f]{64}$/);

    // El artefacto queda registrado con la firma REAL del servicio (E6/signing):
    // firmar el mismo hash con la misma clave produce la misma firma determinista.
    const artifact = await h.db("artifacts").where({ hash: v.artifact_hash }).first();
    expect(artifact.signature).toBeTruthy();
    expect(artifact.signature).toBe(signArtifact(v.artifact_hash, signer.privateKey));
  });

  it("un secreto en el código hace fallar secret_scan y deja la versión rejected", async () => {
    const { botId, version } = await setupBotWithSource("e6-secret-bot", pySecretFiles());
    const submit = await request(app).post(`/bots/${botId}/versions/${version}/actions/submit`).set(auth);
    expect(submit.status).toBe(202);
    expect(submit.body.status).toBe("failed");

    const v = await h.db("bot_versions").where({ bot_id: botId, version }).first();
    expect(v.state).toBe("rejected");
    expect(v.rejection_reason).toBeTruthy();
  });

  it("código 'pegado' de un solo archivo se envuelve en el esqueleto estándar y compila", async () => {
    auth.Authorization = `Bearer ${dev}`;
    const bot = await request(app).post("/bots").set(auth).send({ name: "e6-paste-bot" });
    await request(app).post(`/bots/${bot.body.id}/loadouts`).set(auth).send(GOOD_LOADOUT);
    const version = await request(app)
      .post(`/bots/${bot.body.id}/versions`)
      .set(auth)
      .field("runtime", "python")
      .field("loadoutRevision", "1")
      .attach(
        "source",
        Buffer.from("from arena_sdk import Bot\n\nclass MyBot(Bot):\n    def decide(self, obs):\n        return {'forTick': obs['tick']}\n"),
        "bot.py",
      );
    const submit = await request(app)
      .post(`/bots/${bot.body.id}/versions/${version.body.version}/actions/submit`)
      .set(auth);
    expect(submit.status).toBe(202);
    expect(submit.body.status).toBe("passed");
  });

  it("SIN sandbox (sin agentResolver) la API RECHAZA la versión como 'no verificable', NUNCA la valida (R1.5 · ERR-SEC-03)", async () => {
    // App equivalente a la de producción por DEFECTO: SIN agentResolver. El pipeline de
    // E6 no puede ejecutar el bot y debe FALLAR CERRADO en vez de validarlo.
    const appNoSandbox = createApp({ db: h.db, botManager: new E6PipelineBotManager(h.db, { signer }) });
    auth.Authorization = `Bearer ${dev}`;
    const bot = await request(appNoSandbox).post("/bots").set(auth).send({ name: "e6-no-sandbox-bot" });
    expect(bot.status).toBe(201);
    await request(appNoSandbox).post(`/bots/${bot.body.id}/loadouts`).set(auth).send(GOOD_LOADOUT);
    const version = await request(appNoSandbox)
      .post(`/bots/${bot.body.id}/versions`)
      .set(auth)
      .field("runtime", "python")
      .field("loadoutRevision", "1")
      .attach("source", Buffer.from(JSON.stringify({ files: pyGoodFiles() })), "package.json");
    expect(version.status).toBe(201);
    const submit = await request(appNoSandbox)
      .post(`/bots/${bot.body.id}/versions/${version.body.version}/actions/submit`)
      .set(auth);
    expect(submit.status).toBe(202);
    // El código es válido, pero sin sandbox NO puede validarse: la versión se RECHAZA.
    expect(submit.body.status).toBe("failed");
    const byName = Object.fromEntries(submit.body.stages.map((s: { name: string; status: string }) => [s.name, s.status]));
    for (const stage of ["protocol_test", "smoke_battle", "resource_limits"]) {
      expect(byName[stage], stage).toBe("skipped"); // honesto: no se ejecutaron
    }
    const v = await h.db("bot_versions").where({ bot_id: bot.body.id, version: version.body.version }).first();
    expect(v.state).toBe("rejected"); // NUNCA "validated"
    expect(v.rejection_reason).toMatch(/sandbox no verificado/);
  });
});
