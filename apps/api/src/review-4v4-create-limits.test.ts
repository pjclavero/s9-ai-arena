/**
 * [REVIEW-4v4] · Límites de POST /battles que la suite del carril no cubre:
 * estados no jugables distintos de draft (rejected, retired, suspended,
 * validated), bot privado ajeno, bot de equipo sin ser miembro, el mismo bot en
 * los dos bandos de un 4v4, y que un bot privado ajeno responda IGUAL que uno
 * inexistente aunque la composición sea válida. Cada rechazo se mide por su
 * EFECTO (ni batalla ni trabajo).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const mine: TestBot[] = [];
const byState: Record<string, TestBot> = {};
let foreignPrivate: TestBot;
let foreignTeamBot: TestBot;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, anonQuota: { max: 10_000, windowMs: 3600_000 } });
  const user = await h.db("users").where({ email: DEV_USERS.user }).first();
  tok = await tokenFor(h.db, DEV_USERS.user);
  for (let i = 0; i < 8; i++) mine.push(await createPublishedBot(h.db, `rv4v4-${i + 1}`, { ownerId: user.id }));
  for (const st of ["rejected", "retired", "suspended", "validated", "validating"]) {
    byState[st] = await createPublishedBot(h.db, `rv4v4-${st}`, { ownerId: user.id });
    await h.db("bot_versions").where({ bot_id: byState[st].botId, version: 1 }).update({ state: st });
  }
  foreignPrivate = await createPublishedBot(h.db, "rv4v4-foreign-private");
  await h.db("bots").where({ id: foreignPrivate.botId }).update({ visibility: "private" });
  foreignTeamBot = await createPublishedBot(h.db, "rv4v4-foreign-team");
  const [team] = await h
    .db("teams")
    .insert({ name: "rv4v4-team-ajeno", captain_id: foreignTeamBot.ownerId })
    .returning("id");
  await h.db("bots").where({ id: foreignTeamBot.botId }).update({ visibility: "team", team_id: team.id });
}, 120_000);

afterAll(async () => {
  await h.stop();
});

type P = { botId: string; version: number; team: string };
const tdm = (participants: P[]) => ({
  mode: "team_deathmatch",
  rulesetId: "team-deathmatch-mvp",
  mapId: "mvp-arena-01",
  participants,
});
const roster4v4 = (): P[] => mine.map((b, i) => ({ botId: b.botId, version: 1, team: i < 4 ? "red" : "blue" }));

async function counts() {
  const [bt] = await h.db("battles").count({ n: "*" });
  const [jb] = await h.db("jobs").where({ kind: "run_battle" }).count({ n: "*" });
  return { battles: Number(bt.n), jobs: Number(jb.n) };
}
async function rejected(body: object, status: number, code?: string) {
  const before = await counts();
  const r = await request(app).post("/battles").set("Authorization", `Bearer ${tok}`).send(body);
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  if (code) expect(r.body.error).toBe(code);
  expect(await counts()).toEqual(before);
  return r;
}

describe("[REVIEW-4v4] POST /battles · límites no cubiertos por el carril", () => {
  for (const st of ["rejected", "retired", "suspended", "validated", "validating"]) {
    it(`versión en estado ${st} dentro de un 4v4 ⇒ 409 bot_not_published`, async () => {
      const ps = roster4v4();
      ps[7] = { botId: byState[st].botId, version: 1, team: "blue" };
      await rejected(tdm(ps), 409, "bot_not_published");
    });
  }

  it("el MISMO bot en los dos bandos de un 4v4 ⇒ 400, sin batalla", async () => {
    const ps = roster4v4();
    ps[7] = { ...ps[0], team: "blue" };
    await rejected(tdm(ps), 400);
  });

  it("bot privado ajeno ⇒ 404 idéntico al de un bot inexistente (no se revela que existe)", async () => {
    const a = roster4v4();
    a[7] = { botId: foreignPrivate.botId, version: 1, team: "blue" };
    const b = roster4v4();
    b[7] = { botId: "00000000-0000-4000-8000-000000000000", version: 1, team: "blue" };
    const ra = await rejected(tdm(a), 404, "bot_not_found");
    const rb = await rejected(tdm(b), 404, "bot_not_found");
    const norm = (m: string) => m.replace(/[0-9a-f-]{36}/g, "<id>");
    expect(norm(ra.body.message)).toBe(norm(rb.body.message));
  });

  it("bot de un equipo del que NO soy miembro ⇒ 404 bot_not_found", async () => {
    const ps = roster4v4();
    ps[7] = { botId: foreignTeamBot.botId, version: 1, team: "blue" };
    await rejected(tdm(ps), 404, "bot_not_found");
  });

  it("bot privado ajeno con composición inválida: el 400 de composición no depende del bot", async () => {
    const ps = roster4v4().map((p) => ({ ...p, team: "red" }));
    ps[7] = { botId: foreignPrivate.botId, version: 1, team: "red" };
    const r1 = await rejected(tdm(ps), 400, "team_composition_invalid");
    ps[7] = { botId: "00000000-0000-4000-8000-000000000000", version: 1, team: "red" };
    const r2 = await rejected(tdm(ps), 400, "team_composition_invalid");
    expect(r1.body.message).toBe(r2.body.message);
  });
});
