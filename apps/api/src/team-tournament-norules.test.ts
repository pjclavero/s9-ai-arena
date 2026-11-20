/**
 * V1-T1 · Caracterización de la API: un torneo `teams` creado SIN `rules` (lo que la web enviaba con
 * «Por equipos» + modo por defecto) nace sin tamaño de equipo, se inscribe bot a bot y no ofrece
 * la inscripción de equipos; con las reglas NvN, la inscripción bot a bot se rechaza. La web debe
 * enviar siempre las reglas NvN (apps/web/tests/team-tournament-create.test.tsx).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";
import { createLoadoutRevision } from "./services/bots.js";

let h: TestDbHandle;
let app: Express;
let devTok: string;
let orgTok: string;
let devId: string;
const as = (t: string) => ({ Authorization: `Bearer ${t}` });
const GOOD = {
  catalogVersion: "mvp@1",
  chassis: "chassis.medium@2",
  modules: [
    { slot: "drive", moduleId: "movement.wheels@1" },
    { slot: "power", moduleId: "power.generator@2" },
    { slot: "sensor_a", moduleId: "sensor.radar@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1" },
    { slot: "ammo_main", moduleId: "ammo.ap@1" },
    { slot: "radio_a", moduleId: "radio.short@1" },
    { slot: "armor_front", moduleId: "armor.steel_front@1" },
  ],
};

async function mkBot(): Promise<string> {
  const [bot] = await h.db("bots").insert({ name: "V1T1-bot", owner_id: devId, visibility: "private" }).returning("*");
  await createLoadoutRevision(h.db, bot.id, GOOD as never, { massKg: 0, costCredits: 0, energyBalanceEUs: 0 });
  await h.db("bot_versions").insert({
    bot_id: bot.id,
    version: 1,
    state: "published",
    runtime: "python",
    loadout_revision: 1,
    source: Buffer.from("print(1)\n"),
    source_filename: "bot.py",
    artifact_hash: "sha256:v1t1",
    code_public: false,
    published_at: h.db.fn.now(),
  });
  return bot.id as string;
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  devTok = await tokenFor(h.db, DEV_USERS.developer);
  orgTok = await tokenFor(h.db, DEV_USERS.organizer);
  devId = (await h.db("users").where({ email: DEV_USERS.developer }).first()).id;
}, 180_000);
afterAll(async () => {
  await h.stop();
});

describe("V1-T1 · torneo teams con y sin reglas NvN", () => {
  it("V1T1_API_NORULES · sin `rules` el torneo no tiene tamaño y admite bots sueltos (la web no ofrece equipos)", async () => {
    const c = await request(app)
      .post("/tournaments")
      .set(as(orgTok))
      .send({ name: "sin reglas", format: "teams", mode: "deathmatch", rulesetId: "mvp-default" });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body.rules?.params ?? null).toBeNull();
    const botId = await mkBot();
    const e = await request(app).post(`/tournaments/${c.body.id}/entries`).set(as(devTok)).send({ botId, version: 1 });
    expect(e.status, JSON.stringify(e.body)).toBe(201);
  });

  it("V1T1_API_NVN · con el preset team_deathmatch el torneo lleva params.teamSize y rechaza el bot suelto", async () => {
    const c = await request(app)
      .post("/tournaments")
      .set(as(orgTok))
      .send({
        name: "nvn",
        format: "teams",
        mode: "team_deathmatch",
        rulesetId: "team-deathmatch-mvp",
        rules: { preset: "team_deathmatch", teamSize: 4 },
      });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body.rules?.params?.teamSize).toBe(4);
    const botId = await mkBot();
    const e = await request(app).post(`/tournaments/${c.body.id}/entries`).set(as(devTok)).send({ botId, version: 1 });
    expect(e.status).toBe(409);
    expect(e.body.error).toBe("team_enrollment_required");
  });
});
