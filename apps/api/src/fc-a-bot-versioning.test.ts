/**
 * DEV-A · A9 — versionado REAL de bots sobre el modelo de BD (sin Git).
 *
 * Pipeline real de E6 (análisis, empaquetado, firma) con el agente EN PROCESO
 * para las etapas de ejecución: aquí se prueba el VERSIONADO, no el sandbox
 * (el sandbox real lo cubre fc-a-bot-pipeline-e2e.test.ts con Docker).
 *
 * A9.10 inmutabilidad · A9.11 API de versiones · A9.12 diff · A9.13 clonado ·
 * A9.14/15 batalla → versión exacta · A9.16 permisos · A9.17 v1/v2/v3.
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
import { E6PipelineBotManager } from "./services/e6-bot-manager.js";
import { battleCodeProvenance } from "./services/bot-provenance.js";
import { generateServiceKeypair } from "../../bot-manager/src/signing.js";
import { resolveBotLaunch } from "../../bot-manager/src/bot-launch.js";
import { goodCandidate, referenceAgent } from "../../bot-manager/tests/fixtures.js";
import { PY_GOOD, PY_GOOD_V2 } from "../../bot-manager/tests/sandbox-bots.js";
import { createPublishedBot, insertScheduledBattle } from "../../tournament-worker/src/testing/fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOOD_LOADOUT = JSON.parse(
  readFileSync(
    join(__dirname, "..", "..", "..", "packages", "module-catalog", "examples", "loadout-medium-gunner.json"),
    "utf8",
  ),
);
const PY_GOOD_V3 = PY_GOOD.replace('"throttle": 0.6', '"throttle": 0.5');

let h: TestDbHandle;
let app: Express;
const signer = generateServiceKeypair();
let owner: string;
let other: string;
let botId: string;
const hdr = (t: string) => ({ Authorization: `Bearer ${t}` });

async function newVersion(code: string, extra: Record<string, string> = {}) {
  let r = request(app)
    .post(`/bots/${botId}/versions`)
    .set(hdr(owner))
    .field("runtime", "python")
    .field("loadoutRevision", "1");
  for (const [k, v] of Object.entries(extra)) r = r.field(k, v);
  const res = await r.attach("source", Buffer.from(code), "bot.py");
  return res;
}

async function submitAndValidate(version: number) {
  const s = await request(app).post(`/bots/${botId}/versions/${version}/actions/submit`).set(hdr(owner));
  expect(s.status).toBe(202);
  expect(s.body.status, JSON.stringify(s.body.stages)).toBe("passed");
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({
    db: h.db,
    botManager: new E6PipelineBotManager(h.db, { signer, agentResolver: () => goodCandidate, referenceAgent }),
  });
  owner = await tokenFor(h.db, DEV_USERS.developer);
  other = await tokenFor(h.db, DEV_USERS.team_captain);
  const bot = await request(app).post("/bots").set(hdr(owner)).send({ name: "fc-a-versionado" });
  expect(bot.status).toBe(201);
  botId = bot.body.id;
  expect((await request(app).post(`/bots/${botId}/loadouts`).set(hdr(owner)).send(GOOD_LOADOUT)).status).toBe(201);
}, 120_000);

afterAll(async () => {
  await h?.stop();
});

describe("A9.17 · v1, v2, v3 coexisten con source, build y artefacto propios", () => {
  it("tres versiones validadas: tres builds, tres artefactos, tres fuentes", async () => {
    for (const code of [PY_GOOD, PY_GOOD_V2, PY_GOOD_V3]) {
      const v = await newVersion(code);
      expect(v.status).toBe(201);
      await submitAndValidate(v.body.version);
    }
    const list = await request(app).get(`/bots/${botId}/versions`).set(hdr(owner));
    expect(list.body.map((v: { version: number }) => v.version)).toEqual([1, 2, 3]);
    expect(list.body.every((v: { state: string }) => v.state === "validated")).toBe(true);

    const rows = await h.db("bot_versions").where({ bot_id: botId }).orderBy("version");
    expect(new Set(rows.map((r) => r.artifact_hash)).size).toBe(3);
    expect(new Set(rows.map((r) => r.validated_build_id)).size).toBe(3);
    expect(new Set(rows.map((r) => r.source_sha256)).size).toBe(3);

    for (const [i, code] of [PY_GOOD, PY_GOOD_V2, PY_GOOD_V3].entries()) {
      const n = i + 1;
      const d = await request(app).get(`/bots/${botId}/versions/${n}`).set(hdr(owner));
      expect(d.status).toBe(200);
      expect(d.body.artifact.hash).toBe(rows[i].artifact_hash);
      expect(d.body.artifact.buildId).toBe(rows[i].validated_build_id);
      expect(d.body.latestBuild.id).toBe(rows[i].validated_build_id);
      expect(d.body.latestBuild.status).toBe("passed");
      const f = await request(app).get(`/bots/${botId}/versions/${n}/files`).set(hdr(owner));
      expect(f.status).toBe(200);
      expect(f.body.packaged).toBe(false);
      expect(f.body.files.find((x: { path: string }) => x.path === "src/bot.py").content).toBe(code);
      const a = await request(app).get(`/bots/${botId}/versions/${n}/artifact`).set(hdr(owner));
      expect(a.body.hash).toBe(rows[i].artifact_hash);
    }
  });
});

describe("A9.10 · inmutabilidad garantizada por la BD", () => {
  it("una versión validada no admite cambiar su código, runtime, loadout ni artefacto; tampoco borrarse", async () => {
    const q = () => h.db("bot_versions").where({ bot_id: botId, version: 1 });
    await expect(q().update({ source: Buffer.from("print('pisado')") })).rejects.toThrow(/bot_version_immutable/);
    await expect(q().update({ runtime: "node" })).rejects.toThrow(/bot_version_immutable/);
    await expect(q().update({ loadout_revision: 1, source_filename: "otro.py" })).rejects.toThrow(
      /bot_version_immutable/,
    );
    await expect(q().update({ artifact_hash: "e".repeat(64) })).rejects.toThrow(/bot_version_immutable/);
    await expect(q().update({ version: 99 })).rejects.toThrow(/bot_version_immutable/);
    await expect(q().del()).rejects.toThrow(/bot_version_immutable/);
    // La BD calcula la huella del source: no la elige el cliente.
    const v1 = await q().first();
    expect(v1.source_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("un draft sí es editable (todavía no es historia)", async () => {
    const d = await newVersion("# borrador\n");
    await h
      .db("bot_versions")
      .where({ bot_id: botId, version: d.body.version })
      .update({ source: Buffer.from("# editado\n") });
    const row = await h.db("bot_versions").where({ bot_id: botId, version: d.body.version }).first();
    expect(Buffer.from(row.source).toString()).toBe("# editado\n");
  });
});

describe("A9.13 · nueva versión desde otra; la original queda intacta", () => {
  it("clonar v1 crea una versión draft con el mismo código y parentVersion=1", async () => {
    const before = await h.db("bot_versions").where({ bot_id: botId, version: 1 }).first();
    const c = await request(app).post(`/bots/${botId}/versions/1/actions/clone`).set(hdr(owner)).send({});
    expect(c.status).toBe(201);
    expect(c.body.state).toBe("draft");
    expect(c.body.parentVersion).toBe(1);
    const clone = await h.db("bot_versions").where({ bot_id: botId, version: c.body.version }).first();
    expect(clone.source_sha256).toBe(before.source_sha256);
    const after = await h.db("bot_versions").where({ bot_id: botId, version: 1 }).first();
    expect(after).toEqual(before);
    const d1 = await request(app).get(`/bots/${botId}/versions/1`).set(hdr(owner));
    expect(d1.body.childVersions).toContain(c.body.version);
  });

  it("subir código editado con parentVersion lo registra; un padre inexistente es 400", async () => {
    const ok = await newVersion(PY_GOOD_V2 + "\n# editado desde v2\n", { parentVersion: "2" });
    expect(ok.status).toBe(201);
    expect(ok.body.parentVersion).toBe(2);
    const bad = await newVersion(PY_GOOD, { parentVersion: "999" });
    expect(bad.status).toBe(400);
  });
});

describe("A9.12 · diff entre versiones almacenadas", () => {
  it("v1 → v2: sólo src/bot.py cambia, con un hunk unificado", async () => {
    const r = await request(app).get(`/bots/${botId}/versions/2/diff?against=1`).set(hdr(owner));
    expect(r.status).toBe(200);
    const bot = r.body.files.find((f: { path: string }) => f.path === "src/bot.py");
    expect(bot.status).toBe("modified");
    expect(bot.additions).toBe(1);
    expect(bot.deletions).toBe(1);
    expect(bot.diff).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(bot.diff).toContain('-            return {"move": {"throttle": 0.8, "steer": 0.2}}');
    expect(bot.diff).toContain('+            return {"move": {"throttle": 0.9, "steer": -0.3}}');
    for (const f of r.body.files.filter((x: { path: string }) => x.path !== "src/bot.py"))
      expect(f.status).toBe("unchanged");
    const bad = await request(app).get(`/bots/${botId}/versions/2/diff`).set(hdr(owner));
    expect(bad.status).toBe(400);
  });
});

describe("A9.14/15 · la batalla referencia la versión EXACTA", () => {
  it("batalla con v1; se publica v2; la batalla sigue en v1 y su código/artefacto son los de v1", async () => {
    expect((await request(app).post(`/bots/${botId}/versions/1/actions/publish`).set(hdr(owner)).send({})).status).toBe(
      200,
    );
    const rival = await createPublishedBot(h.db, "fc-a-rival");
    const battleId = await insertScheduledBattle(h.db, { ...rival, botId, version: 1, name: "fc-a" } as never, rival);
    const before = await battleCodeProvenance(h.db, battleId);

    expect((await request(app).post(`/bots/${botId}/versions/2/actions/publish`).set(hdr(owner)).send({})).status).toBe(
      200,
    );

    const part = await h.db("participants").where({ battle_id: battleId, bot_id: botId }).first();
    expect(part.version).toBe(1);
    const after = await battleCodeProvenance(h.db, battleId);
    expect(after).toEqual(before);
    const mine = after.find((p) => p.botId === botId)!;
    const [v1, v2] = await h.db("bot_versions").where({ bot_id: botId }).whereIn("version", [1, 2]).orderBy("version");
    expect(mine.version).toBe(1);
    expect(mine.botVersionId).toBe(v1.id);
    expect(mine.sourceSha256).toBe(v1.source_sha256);
    expect(mine.artifactHash).toBe(v1.artifact_hash);
    expect(mine.artifactHash).not.toBe(v2.artifact_hash);
    expect(mine.buildId).toBe(v1.validated_build_id);

    // El arranque en batalla resuelve el artefacto firmado de v1, no el "último".
    const launch = await resolveBotLaunch(h.db, botId, 1, { publicKey: signer.publicKey });
    expect(launch.artifactHash).toBe(v1.artifact_hash);
    expect(launch.buildId).toBe(v1.validated_build_id);
    expect(launch.imageDigest).toMatch(/bot-runtime-python@sha256:[0-9a-f]{64}$/);
    await expect(resolveBotLaunch(h.db, botId, 3, { publicKey: signer.publicKey })).rejects.toThrow(/validated/);
  });
});

describe("A9.16 · el historial de código es privado", () => {
  it("usuario B no ve las versiones ni el código del bot privado de A (404)", async () => {
    for (const path of [
      "versions",
      "versions/1",
      "versions/1/source",
      "versions/1/files",
      "versions/1/artifact",
      "versions/2/diff?against=1",
    ]) {
      const r = await request(app).get(`/bots/${botId}/${path}`).set(hdr(other));
      expect(r.status, path).toBe(404);
    }
    const anon = await request(app).get(`/bots/${botId}/versions/1`);
    expect(anon.status).toBe(404);
    const clone = await request(app).post(`/bots/${botId}/versions/1/actions/clone`).set(hdr(other)).send({});
    expect(clone.status).toBe(404);
  });

  it("bot público con código privado: B ve metadatos pero NO el código (403) ni puede clonar (403)", async () => {
    await request(app).patch(`/bots/${botId}`).set(hdr(owner)).send({ visibility: "public" });
    const meta = await request(app).get(`/bots/${botId}/versions/1`).set(hdr(other));
    expect(meta.status).toBe(200);
    expect(meta.body.canReadSource).toBe(false);
    expect(meta.body.sourceSha256).toBeUndefined();
    expect(meta.body.latestBuild.stages.some((s: { logs?: unknown }) => s.logs !== undefined)).toBe(false);
    for (const path of ["versions/1/source", "versions/1/files", "versions/2/diff?against=1"]) {
      const r = await request(app).get(`/bots/${botId}/${path}`).set(hdr(other));
      expect(r.status, path).toBe(403);
    }
    expect((await request(app).post(`/bots/${botId}/versions/1/actions/clone`).set(hdr(other)).send({})).status).toBe(
      403,
    );
    await request(app).patch(`/bots/${botId}`).set(hdr(owner)).send({ visibility: "private" });
  });
});
