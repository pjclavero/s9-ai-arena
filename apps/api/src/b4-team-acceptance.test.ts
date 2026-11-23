/**
 * V1 · B4 · ACEPTACIÓN TDM (D-OP-18/19/20): torneo por equipos con presupuesto.
 *  - un equipo que cabe se inscribe, cierra y juega;
 *  - uno que no cabe recibe un 409 claro y no entra nadie;
 *  - si se manipula DESPUÉS de inscribir, se bloquea en el cierre o, ya cerrado, en la ejecución.
 * BD efímera + API real + manejador real de batalla del worker con un ejecutor guionizado.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEV_USERS, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";
import { createLoadoutRevision } from "./services/bots.js";
import { handleGenerateSchedule } from "../../tournament-worker/src/scheduler.js";
import {
  makeRunBattleHandler,
  type BattleContext,
  type BattleExecution,
} from "../../tournament-worker/src/battle-runner.js";
import type { JobRow } from "../../tournament-worker/src/queue.js";

let h: TestDbHandle;
let app: Express;
let devTok: string;
let orgTok: string;
let devId: string;
let seq = 0;
const as = (tok: string) => ({ Authorization: `Bearer ${tok}` });
const SUMMARY = { massKg: 0, costCredits: 0, energyBalanceEUs: 0 };

/** 900 cr con la munición embebida. */
const GUNNER = {
  catalogVersion: "mvp@1",
  chassis: "chassis.medium@1",
  modules: [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: "power.battery@1" },
    { slot: "sensor_a", moduleId: "sensor.lidar360@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
    { slot: "armor_front", moduleId: "armor.steel_front@1" },
  ],
};

async function mkTeam(n = 2): Promise<{ teamId: string; bots: string[] }> {
  const [team] = await h
    .db("teams")
    .insert({ name: `b4tdm-team-${++seq}`, captain_id: devId })
    .returning("*");
  await h.db("team_members").insert({ team_id: team.id, user_id: devId, role: "captain" });
  const bots: string[] = [];
  for (let i = 0; i < n; i++) {
    const [bot] = await h
      .db("bots")
      .insert({ name: `b4tdm-${++seq}`, owner_id: devId, team_id: team.id, visibility: "private" })
      .returning("*");
    await createLoadoutRevision(h.db, bot.id, GUNNER as never, SUMMARY);
    await h.db("bot_versions").insert({
      bot_id: bot.id,
      version: 1,
      state: "published",
      runtime: "python",
      loadout_revision: 1,
      source: Buffer.from("# b4\n"),
      source_filename: "bot.py",
      artifact_hash: `sha256:b4tdm-${bot.id}`,
      code_public: false,
      published_at: h.db.fn.now(),
    });
    bots.push(bot.id as string);
  }
  return { teamId: team.id as string, bots };
}
async function tdmTournament(budgetCredits: number) {
  const r = await request(app)
    .post("/tournaments")
    .set(as(orgTok))
    .send({
      name: `b4tdm-t-${++seq}`,
      format: "teams",
      mode: "team_deathmatch",
      rulesetId: "team-deathmatch-mvp",
      rules: { preset: "team_deathmatch", teamSize: 2 },
      budgetCredits,
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}
const members = (bots: string[]) => bots.map((botId) => ({ botId, version: 1 }));
const enterTeam = (t: string, teamId: string, bots: string[]) =>
  request(app)
    .post(`/tournaments/${t}/team-entries`)
    .set(as(devTok))
    .send({ teamId, members: members(bots) });
const close = (t: string) => request(app).post(`/tournaments/${t}/actions/close-entries`).set(as(orgTok)).send({});

function scripted(log: string[]) {
  return async (ctx: BattleContext): Promise<BattleExecution> => {
    log.push(ctx.battle.id);
    return {
      winner: "A",
      ticks: 10,
      score: { A: 1, B: 0 },
      finalStateHash: "h",
      disqualified: [],
      versions: { engine: "test" },
    };
  };
}
async function scheduleAndRun(t: string) {
  await handleGenerateSchedule({ payload: { tournamentId: t } } as unknown as JobRow, { db: h.db, workerId: "b4tdm" });
  const battle = await h.db("battles").where({ tournament_id: t }).orderBy("game_index").first();
  const log: string[] = [];
  await makeRunBattleHandler({ executor: scripted(log) })(
    {
      id: `00000000-0000-0000-0000-0000000b4${String(++seq).padStart(3, "0")}`,
      kind: "run_battle",
      payload: { battleId: battle.id },
      attempts: 1,
    } as unknown as JobRow,
    { db: h.db, workerId: "B4TDM" },
  );
  return { battleId: battle.id as string, log };
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

describe("B4 · aceptación TDM con presupuesto", () => {
  it("B4_TDM_FITS · el equipo que cabe se inscribe, cierra y juega", async () => {
    const A = await mkTeam();
    const B = await mkTeam();
    const t = await tdmTournament(1000);
    expect((await enterTeam(t, A.teamId, A.bots)).status).toBe(201);
    expect((await enterTeam(t, B.teamId, B.bots)).status).toBe(201);
    const c = await close(t);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const { battleId, log } = await scheduleAndRun(t);
    expect(log).toEqual([battleId]);
    expect((await h.db("battles").where({ id: battleId }).first()).status).toBe("finished");
  });

  it("B4_TDM_OVER · el equipo que no cabe recibe un 409 claro y no entra nadie", async () => {
    const A = await mkTeam();
    const t = await tdmTournament(600);
    const r = await enterTeam(t, A.teamId, A.bots);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error).toBe("bot_version_not_eligible");
    expect(r.body.message).toContain("600");
    expect(r.body.message).toContain("900");
    expect(await h.db("entries").where({ tournament_id: t })).toHaveLength(0);
  });

  it("B4_TDM_TAMPER_CLOSE · bajar el presupuesto tras inscribir bloquea el cierre", async () => {
    const A = await mkTeam();
    const B = await mkTeam();
    const t = await tdmTournament(1000);
    expect((await enterTeam(t, A.teamId, A.bots)).status).toBe(201);
    expect((await enterTeam(t, B.teamId, B.bots)).status).toBe(201);
    await h.db("tournaments").where({ id: t }).update({ budget_credits: 600 });
    const c = await close(t);
    expect(c.status, JSON.stringify(c.body)).toBe(409);
    expect(c.body.error).toBe("entries_not_eligible");
    expect((await h.db("tournaments").where({ id: t }).first()).state).toBe("open");
  });

  it("B4_TDM_TAMPER_EXEC · bajar el presupuesto DESPUÉS de cerrar bloquea la ejecución (walkover explícito)", async () => {
    const A = await mkTeam();
    const B = await mkTeam();
    const t = await tdmTournament(1000);
    expect((await enterTeam(t, A.teamId, A.bots)).status).toBe(201);
    expect((await enterTeam(t, B.teamId, B.bots)).status).toBe(201);
    expect((await close(t)).status).toBe(200);
    await h.db("tournaments").where({ id: t }).update({ budget_credits: 600 });
    const { battleId, log } = await scheduleAndRun(t);
    expect(log).toEqual([]);
    const row = await h.db("battles").where({ id: battleId }).first();
    expect(row.result.endReason).toBe("walkover");
    const parts = await h.db("participants").where({ battle_id: battleId });
    expect(parts.every((p: { outcome: string }) => p.outcome === "disqualified")).toBe(true);
  });
});
