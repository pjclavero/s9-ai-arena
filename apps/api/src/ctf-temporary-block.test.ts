/**
 * V1 · BLOQUEO TEMPORAL de la creación de batallas CTF (S9_CTF_PRACTICE_ENABLED).
 *
 *  - POST /battles con modo capture_the_flag (clásico, preset o personalizado) ⇒ 400
 *    mode_disabled, sin crear batalla ni trabajo;
 *  - con el interruptor activado, vuelve a funcionar (se puede reactivar sin código);
 *  - GET /rulesets declara el bloqueo (`disabledModes`) para que la web no lo ofrezca;
 *  - DM, TDM y zona no cambian;
 *  - una batalla CTF ya existente (también una fallida) sigue visible.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEV_USERS, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { createPublishedBot, type TestBot } from "../../tournament-worker/src/testing/fixtures.js";

let h: TestDbHandle;
let app: Express;
let tok: string;
const bots: TestBot[] = [];
const ENV = "S9_CTF_PRACTICE_ENABLED";
const saved = process.env[ENV];

beforeAll(async () => {
  delete process.env[ENV]; // por defecto en V1: BLOQUEADO
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, anonQuota: { max: 10_000, windowMs: 3600_000 } });
  const user = await h.db("users").where({ email: DEV_USERS.user }).first();
  tok = await tokenFor(h.db, DEV_USERS.user);
  for (let i = 0; i < 4; i++) bots.push(await createPublishedBot(h.db, `ctfblk-${i + 1}`, { ownerId: user.id }));
}, 120_000);

afterEach(() => {
  delete process.env[ENV];
});

afterAll(async () => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
  await h.stop();
});

const parts = () => bots.map((b, i) => ({ botId: b.botId, version: 1, team: i < 2 ? "red" : "blue" }));
const ctf = (rules?: unknown) => ({
  mode: "capture_the_flag",
  rulesetId: "capture-the-flag-mvp",
  mapId: "mvp-arena-01",
  participants: parts(),
  ...(rules === undefined ? {} : { rules }),
});
const post = (body: object) => request(app).post("/battles").set("Authorization", `Bearer ${tok}`).send(body);
async function counts() {
  const [b] = await h.db("battles").count({ n: "*" });
  const [j] = await h.db("jobs").where({ kind: "run_battle" }).count({ n: "*" });
  return { battles: Number(b.n), jobs: Number(j.n) };
}

describe("POST /battles · CTF bloqueado", () => {
  it.each([
    ["reglas clásicas", undefined],
    ["preset ctf", { preset: "ctf", teamSize: 2 }],
    ["personalizado CTF", { preset: "custom", teamSize: 2, params: { game: "capture_the_flag" } }],
  ])("%s ⇒ 400 mode_disabled y no se crea nada", async (_n, rules) => {
    const before = await counts();
    const r = await post(ctf(rules));
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error).toBe("mode_disabled");
    expect(r.body.message).toMatch(/deshabilitado temporalmente/);
    expect(await counts()).toEqual(before);
  });

  it("con S9_CTF_PRACTICE_ENABLED=1 se reactiva sin tocar código (202)", async () => {
    process.env[ENV] = "1";
    const r = await post(ctf({ preset: "ctf", teamSize: 2 }));
    expect(r.status, JSON.stringify(r.body)).toBe(202);
  });

  it("valores que no son 1/true siguen bloqueando", async () => {
    process.env[ENV] = "0";
    expect((await post(ctf())).status).toBe(400);
    process.env[ENV] = "";
    expect((await post(ctf())).status).toBe(400);
  });

  it("deathmatch y team_deathmatch no cambian", async () => {
    const dm = await post({
      mode: "deathmatch",
      rulesetId: "deathmatch-mvp",
      mapId: "mvp-arena-02",
      participants: [
        { botId: bots[0].botId, version: 1, team: "A" },
        { botId: bots[1].botId, version: 1, team: "B" },
      ],
    });
    expect(dm.status, JSON.stringify(dm.body)).toBe(202);
    const tdm = await post({
      mode: "team_deathmatch",
      rulesetId: "team-deathmatch-mvp",
      mapId: "mvp-arena-01",
      participants: parts(),
    });
    expect(tdm.status, JSON.stringify(tdm.body)).toBe(202);
  });
});

describe("GET /rulesets · disabledModes", () => {
  it("declara CTF bloqueado con motivo y lo conserva en modes", async () => {
    const r = await request(app).get("/rulesets");
    expect(r.status).toBe(200);
    expect(r.body.disabledModes).toHaveLength(1);
    expect(r.body.disabledModes[0].mode).toBe("capture_the_flag");
    expect(r.body.disabledModes[0].reason).toMatch(/temporalmente/);
    expect(r.body.modes).toContain("capture_the_flag");
  });

  it("activado ⇒ lista vacía", async () => {
    process.env[ENV] = "true";
    const r = await request(app).get("/rulesets");
    expect(r.body.disabledModes).toEqual([]);
  });
});

describe("batallas CTF ya existentes", () => {
  it("una CTF fallida sigue visible (detalle y listado) con el bloqueo activo", async () => {
    const [row] = await h
      .db("battles")
      .insert({
        status: "failed",
        official: false,
        mode: "capture_the_flag",
        ruleset_id: "capture-the-flag-mvp",
        map_id: "mvp-arena-01",
        map_version: 1,
        failure_kind: "infrastructure",
      })
      .returning("*");
    for (const [i, b] of bots.entries()) {
      await h
        .db("participants")
        .insert({ battle_id: row.id, bot_id: b.botId, version: 1, team: i < 2 ? "red" : "blue" });
    }
    const one = await request(app).get(`/battles/${row.id}`).set("Authorization", `Bearer ${tok}`);
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body.mode).toBe("capture_the_flag");
    expect(one.body.status).toBe("failed");
    const list = await request(app).get("/battles?limit=100").set("Authorization", `Bearer ${tok}`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((b: { id: string }) => b.id)).toContain(row.id);
  });
});
