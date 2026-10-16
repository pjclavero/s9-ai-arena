/**
 * DEV-B · TD-005 (participantes) + TD-002 (agenda única) en POST /battles.
 *  - Un bot PRIVADO AJENO no puede entrar en una batalla (404, igual que inexistente).
 *  - Propio privado, público ajeno y de mi equipo: sí.
 *  - Un mismo bot dos veces ⇒ 400 explícito (antes 500 por la PK de participants).
 *  - El alta encola `run_battle` con dedupe_key `run_battle:<id>` en la misma transacción.
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
let userTok: string;
let mine: TestBot;
let foreignPrivate: TestBot;
let foreignPublic: TestBot;
let foreignTeam: TestBot;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, anonQuota: { max: 10_000, windowMs: 3600_000 } });
  const user = await h.db("users").where({ email: DEV_USERS.user }).first();
  const dev = await h.db("users").where({ email: DEV_USERS.developer }).first();
  userTok = await tokenFor(h.db, DEV_USERS.user);
  mine = await createPublishedBot(h.db, "own-priv", { ownerId: user.id });
  foreignPrivate = await createPublishedBot(h.db, "alien-priv", { ownerId: dev.id });
  foreignPublic = await createPublishedBot(h.db, "alien-pub", { ownerId: dev.id });
  foreignTeam = await createPublishedBot(h.db, "alien-team", { ownerId: dev.id });
  await h.db("bots").where({ id: mine.botId }).update({ visibility: "private" });
  await h.db("bots").where({ id: foreignPrivate.botId }).update({ visibility: "private" });
  const [team] = await h.db("teams").insert({ name: "fc-b-team", captain_id: dev.id }).returning("id");
  await h.db("team_members").insert({ team_id: team.id, user_id: user.id, role: "member" });
  await h.db("bots").where({ id: foreignTeam.botId }).update({ visibility: "team", team_id: team.id });
}, 120_000);

afterAll(async () => {
  await h.stop();
});

function body(a: TestBot, b: TestBot, teams = ["red", "blue"]) {
  return {
    mode: "deathmatch",
    rulesetId: DEFAULT_RULESET_ID,
    mapId: "mvp-arena-01",
    participants: [
      { botId: a.botId, version: 1, team: teams[0] },
      { botId: b.botId, version: 1, team: teams[1] },
    ],
  };
}

describe("TD-005 · propiedad/visibilidad de los participantes", () => {
  it("bot PRIVADO AJENO ⇒ 404 bot_not_found y NO se crea batalla ni trabajo", async () => {
    const before = await h.db("battles").count({ n: "*" });
    const r = await request(app)
      .post("/battles")
      .set("Authorization", `Bearer ${userTok}`)
      .send(body(mine, foreignPrivate));
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("bot_not_found");
    const after = await h.db("battles").count({ n: "*" });
    expect(Number(after[0].n)).toBe(Number(before[0].n));
  });

  it("el 404 de un privado ajeno es indistinguible del de un bot inexistente", async () => {
    const ghost = { ...foreignPrivate, botId: "00000000-0000-0000-0000-000000000000" };
    const a = await request(app).post("/battles").set("Authorization", `Bearer ${userTok}`).send(body(mine, ghost));
    const b = await request(app)
      .post("/battles")
      .set("Authorization", `Bearer ${userTok}`)
      .send(body(mine, foreignPrivate));
    expect(a.status).toBe(b.status);
    expect(a.body.error).toBe(b.body.error);
  });

  it("propio privado + público ajeno ⇒ 202 y `run_battle` encolado con dedupe_key", async () => {
    const r = await request(app)
      .post("/battles")
      .set("Authorization", `Bearer ${userTok}`)
      .send(body(mine, foreignPublic));
    expect(r.status).toBe(202);
    const jobs = await h.db("jobs").where({ dedupe_key: `run_battle:${r.body.id}` });
    expect(jobs.length).toBe(1);
    expect(jobs[0].kind).toBe("run_battle");
  });

  it("bot de un EQUIPO del que soy miembro ⇒ 202", async () => {
    const r = await request(app)
      .post("/battles")
      .set("Authorization", `Bearer ${userTok}`)
      .send(body(mine, foreignTeam));
    expect(r.status).toBe(202);
  });

  it("el mismo bot dos veces ⇒ 400 explícito (no 500 por la PK)", async () => {
    const r = await request(app).post("/battles").set("Authorization", `Bearer ${userTok}`).send(body(mine, mine));
    expect(r.status).toBe(400);
  });

  it("team con formato inválido ⇒ 400", async () => {
    const r = await request(app)
      .post("/battles")
      .set("Authorization", `Bearer ${userTok}`)
      .send(body(mine, foreignPublic, ["red", "<script>"]));
    expect(r.status).toBe(400);
  });
});
