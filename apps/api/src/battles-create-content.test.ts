/**
 * REVIEW (cierre funcional, R4.5 · TD-NEW-C1 → TD-032) — POST /battles valida la
 * compatibilidad modo ↔ ruleset ↔ mapa con `checkBattleContent` (DEV-C), la MISMA
 * regla que usa la web. Antes la API aceptaba un ruleset de otro modo o un mapa
 * que no soporta el modo y la batalla fallaba tarde, en el worker.
 *
 * Cada rechazo se comprueba también por su EFECTO: no se crea batalla ni trabajo.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEFAULT_RULESET_ID, DEV_USERS, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { createPublishedBot, type TestBot } from "../../tournament-worker/src/testing/fixtures.js";

let h: TestDbHandle;
let app: Express;
let tok: string;
let a: TestBot;
let b: TestBot;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, anonQuota: { max: 10_000, windowMs: 3600_000 } });
  const user = await h.db("users").where({ email: DEV_USERS.user }).first();
  tok = await tokenFor(h.db, DEV_USERS.user);
  a = await createPublishedBot(h.db, "fcrev-content-a", { ownerId: user.id });
  b = await createPublishedBot(h.db, "fcrev-content-b", { ownerId: user.id });
}, 120_000);

afterAll(async () => {
  await h.stop();
});

function body(over: Record<string, unknown>) {
  return {
    mode: "deathmatch",
    rulesetId: DEFAULT_RULESET_ID,
    mapId: "mvp-arena-02",
    participants: [
      { botId: a.botId, version: 1, team: "red" },
      { botId: b.botId, version: 1, team: "blue" },
    ],
    ...over,
  };
}

async function counts() {
  const [bt] = await h.db("battles").count({ n: "*" });
  const [jb] = await h.db("jobs").where({ kind: "run_battle" }).count({ n: "*" });
  return { battles: Number(bt.n), jobs: Number(jb.n) };
}

async function expectRejected(over: Record<string, unknown>, status: number, code: string) {
  const before = await counts();
  const r = await request(app).post("/battles").set("Authorization", `Bearer ${tok}`).send(body(over));
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  expect(r.body.error).toBe(code);
  expect(await counts()).toEqual(before);
}

describe("POST /battles · compatibilidad modo ↔ ruleset ↔ mapa (checkBattleContent)", () => {
  it("control positivo: deathmatch + ruleset agnóstico + mapa que soporta deathmatch ⇒ 202", async () => {
    const before = await counts();
    const r = await request(app).post("/battles").set("Authorization", `Bearer ${tok}`).send(body({}));
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(await counts()).toEqual({ battles: before.battles + 1, jobs: before.jobs + 1 });
  });

  it("ruleset de OTRO modo ⇒ 409 ruleset_mode_mismatch", async () => {
    await expectRejected({ rulesetId: "capture-the-flag-mvp" }, 409, "ruleset_mode_mismatch");
  });

  it("mapa que NO soporta el modo ⇒ 409 map_mode_unsupported", async () => {
    // mvp-arena-01 v1 declara CTF + TDM (meta.supportedModes), no deathmatch.
    await expectRejected({ mapId: "mvp-arena-01" }, 409, "map_mode_unsupported");
  });

  it("ruleset inexistente ⇒ 400 ruleset_unknown", async () => {
    await expectRejected({ rulesetId: "no-existe" }, 400, "ruleset_unknown");
  });

  it("mapa inexistente o versión no publicada ⇒ 400 map_not_published", async () => {
    await expectRejected({ mapId: "no-existe" }, 400, "map_not_published");
    await expectRejected({ mapVersion: 99 }, 400, "map_not_published");
  });

  it("ruleset del modo correcto + mapa compatible ⇒ 202 (team_deathmatch en mvp-arena-01)", async () => {
    const r = await request(app)
      .post("/battles")
      .set("Authorization", `Bearer ${tok}`)
      .send(body({ mode: "team_deathmatch", rulesetId: "team-deathmatch-mvp", mapId: "mvp-arena-01" }));
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.mapId).toBe("mvp-arena-01");
    expect(r.body.mode).toBe("team_deathmatch");
  });
});
