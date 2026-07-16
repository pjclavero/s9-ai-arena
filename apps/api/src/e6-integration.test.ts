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
import { pyGoodFiles, pySecretFiles } from "../../bot-manager/tests/fixtures.js";
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
  app = createApp({ db: h.db, botManager: new E6PipelineBotManager(h.db, { signer }) });
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
  it("un paquete Python válido pasa el pipeline de E6 y deja la versión en validated", async () => {
    const { botId, version } = await setupBotWithSource("e6-good-bot", pyGoodFiles());
    const submit = await request(app).post(`/bots/${botId}/versions/${version}/actions/submit`).set(auth);
    expect(submit.status).toBe(202);
    expect(submit.body.status).toBe("passed");

    const byName = Object.fromEntries(submit.body.stages.map((s: { name: string; status: string }) => [s.name, s.status]));
    // Etapas de lógica pura: pasan de verdad con el código de E6
    for (const stage of ["structure", "static_analysis", "dependencies", "build", "secret_scan", "sign", "publish"]) {
      expect(byName[stage], stage).toBe("passed");
    }
    // Etapas containerizadas: skipped sin Docker (T6.2) — pendiente de reconciliación
    for (const stage of ["protocol_test", "smoke_battle", "resource_limits"]) {
      expect(byName[stage], stage).toBe("skipped");
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
});
