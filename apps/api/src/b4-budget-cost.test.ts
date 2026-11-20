/**
 * V1 · B4 · budgetCredits como regla real y una sola fuente para el coste (D-OP-10, D-OP-15;
 * AUD1-01, AUD1-01b, AUD1-04). BD efímera + API real. Cada `it` lleva una etiqueta B4_…:
 * es la que `scripts/budget-ammo-mutants.mjs` exige que caiga para cada mutante.
 *
 * Los bots usan el loadout de ejemplo (artillero medio con `ammo:` embebida): el validador
 * lo cuesta 900 créditos; antes, el editor y las reglas de batalla contaban 850.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEV_USERS, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";
import { validateLoadoutServerSide } from "./services/bots.js";
import { createPublishedBot, EXAMPLE_LOADOUT, type TestBot } from "../../tournament-worker/src/testing/fixtures.js";

let h: TestDbHandle;
let app: Express;
let userTok: string;
let devTok: string;
let orgTok: string;
let userId: string;
let devId: string;
let seq = 0;
const COST = 900; // chasis + módulos + munición embebida del loadout de ejemplo
const as = (tok: string) => ({ Authorization: `Bearer ${tok}` });

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  userTok = await tokenFor(h.db, DEV_USERS.user);
  devTok = await tokenFor(h.db, DEV_USERS.developer);
  orgTok = await tokenFor(h.db, DEV_USERS.organizer);
  userId = (await h.db("users").where({ email: DEV_USERS.user }).first()).id;
  devId = (await h.db("users").where({ email: DEV_USERS.developer }).first()).id;
}, 180_000);
afterAll(async () => {
  await h.stop();
});

const mkBot = (ownerId: string) => createPublishedBot(h.db, `b4-${++seq}`, { ownerId });
async function mkTournament(extra: Record<string, unknown>) {
  const r = await request(app)
    .post("/tournaments")
    .set(as(orgTok))
    .send({ name: `b4-t-${++seq}`, format: "round_robin", mode: "deathmatch", rulesetId: "deathmatch-mvp", ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}
const enter = (tok: string, t: string, b: TestBot) =>
  request(app).post(`/tournaments/${t}/entries`).set(as(tok)).send({ botId: b.botId, version: 1 });

describe("B4 · una sola fuente de coste", () => {
  it("B4_SUMMARY · el summary guardado cuenta la munición embebida (900, no 850)", async () => {
    const r = await validateLoadoutServerSide(h.db, {
      catalogVersion: EXAMPLE_LOADOUT.catalogVersion,
      chassis: EXAMPLE_LOADOUT.chassis,
      modules: EXAMPLE_LOADOUT.modules,
    });
    expect(r.violations).toEqual([]);
    expect(r.summary?.costCredits).toBe(COST);
  });

  it("B4_RULES_BOT_CAP · botCredits de las reglas de batalla usa el coste real: 899 rechaza, 900 acepta", async () => {
    const bots = [await mkBot(userId), await mkBot(userId), await mkBot(userId), await mkBot(userId)];
    const side = (l: TestBot[], team: string) => l.map((b) => ({ botId: b.botId, version: 1, team }));
    const check = (botCredits: number) =>
      request(app)
        .post("/battles/rules-check")
        .set(as(userTok))
        .send({
          mode: "team_deathmatch",
          rulesetId: "team-deathmatch-mvp",
          mapId: "mvp-arena-01",
          participants: [...side(bots.slice(0, 2), "red"), ...side(bots.slice(2), "blue")],
          rules: {
            preset: "custom",
            teamSize: 2,
            params: {
              respawn: { mode: "limited", maxRespawns: 2, delaySeconds: 5 },
              victory: "elimination",
              timeLimitMinutes: 10,
              botCredits,
            },
          },
        });
    const low = await check(COST - 1);
    expect(low.status).toBe(200);
    expect(low.body.ok).toBe(false);
    expect(low.body.composition.teams[0].bots[0].costCredits).toBe(COST);
    const exact = await check(COST);
    expect(exact.status).toBe(200);
    expect(exact.body.ok).toBe(true);
  });
});

describe("B4 · budgetCredits del torneo es una regla real (inscripción individual)", () => {
  it("B4_ENROLL_REJECT · un torneo de 200 créditos rechaza un bot de 900 con motivo claro", async () => {
    const bot = await mkBot(userId);
    const t = await mkTournament({ budgetCredits: 200 });
    const r = await enter(userTok, t, bot);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error).toBe("bot_version_not_eligible");
    expect(r.body.details?.reason ?? r.body.reason).toBe("exceeds_tournament_budget");
    expect(r.body.message).toContain("900");
    expect(r.body.message).toContain("200");
    expect(await h.db("entries").where({ tournament_id: t })).toHaveLength(0);
  });

  it("B4_ENROLL_BOUNDARY · el borde: presupuesto = coste inscribe; coste − 1 no", async () => {
    const bot = await mkBot(userId);
    const tLow = await mkTournament({ budgetCredits: COST - 1 });
    expect((await enter(userTok, tLow, bot)).status).toBe(409);
    const tEq = await mkTournament({ budgetCredits: COST });
    const ok = await enter(userTok, tEq, bot);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it("B4_ENROLL_NO_BUDGET · un torneo sin presupuesto propio no restringe (comportamiento anterior)", async () => {
    const bot = await mkBot(userId);
    const t = await mkTournament({});
    expect((await enter(userTok, t, bot)).status).toBe(201);
  });

  it("B4_PUBLISHED_UNTOUCHED · rechazarlo en un torneo no toca la versión: sigue publicada y elegible", async () => {
    const bot = await mkBot(userId);
    const t = await mkTournament({ budgetCredits: 200 });
    expect((await enter(userTok, t, bot)).status).toBe(409);
    const v = await h.db("bot_versions").where({ bot_id: bot.botId, version: 1 }).first();
    expect(v.state).toBe("published");
    // Sigue valiendo para una batalla suelta (rules-check sin topes ni presupuesto de torneo).
    const rc = await request(app)
      .post("/battles/rules-check")
      .set(as(userTok))
      .send({
        mode: "deathmatch",
        rulesetId: "deathmatch-mvp",
        mapId: "mvp-arena-01",
        participants: [{ botId: bot.botId, version: 1 }],
      });
    expect(rc.status, JSON.stringify(rc.body)).toBe(200);
  });
});

describe("B4 · budgetCredits en torneos por equipos", () => {
  async function mkTeam(n: number) {
    const [team] = await h.db("teams").insert({ name: `b4-team-${++seq}`, captain_id: devId }).returning("*");
    await h.db("team_members").insert({ team_id: team.id, user_id: devId, role: "captain" });
    const bots: TestBot[] = [];
    for (let i = 0; i < n; i++) {
      const b = await mkBot(devId);
      await h.db("bots").where({ id: b.botId }).update({ team_id: team.id });
      bots.push(b);
    }
    return { teamId: team.id as string, bots };
  }
  async function teamsTournament(budgetCredits?: number) {
    const r = await request(app)
      .post("/tournaments")
      .set(as(orgTok))
      .send({
        name: `b4-tt-${++seq}`,
        format: "teams",
        mode: "team_deathmatch",
        rulesetId: "team-deathmatch-mvp",
        rules: { preset: "team_deathmatch", teamSize: 2 },
        ...(budgetCredits ? { budgetCredits } : {}),
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  }

  it("B4_TEAM_ENTER · inscribir un equipo con un bot por encima del presupuesto ⇒ 409 y no entra nadie", async () => {
    const { teamId, bots } = await mkTeam(2);
    const t = await teamsTournament(200);
    const r = await request(app)
      .post(`/tournaments/${t}/team-entries`)
      .set(as(devTok))
      .send({ teamId, members: bots.map((b) => ({ botId: b.botId, version: 1 })) });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error).toBe("bot_version_not_eligible");
    expect(await h.db("entries").where({ tournament_id: t })).toHaveLength(0);
    // Sin presupuesto propio el mismo equipo entra.
    const t2 = await teamsTournament();
    const ok = await request(app)
      .post(`/tournaments/${t2}/team-entries`)
      .set(as(devTok))
      .send({ teamId, members: bots.map((b) => ({ botId: b.botId, version: 1 })) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it("B4_TEAM_CONSENT · la autorización de un bot por encima del presupuesto ⇒ 409", async () => {
    const { teamId, bots } = await mkTeam(2);
    const t = await teamsTournament(200);
    const r = await request(app)
      .put(`/tournaments/${t}/team-consents/${bots[0].botId}`)
      .set(as(devTok))
      .send({ teamId, version: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error).toBe("bot_version_not_eligible");
    expect(await h.db("team_entry_consents").where({ tournament_id: t })).toHaveLength(0);
  });
});
