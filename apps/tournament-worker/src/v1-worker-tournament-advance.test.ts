/**
 * V1-P0 (R329-03) · el TORNEO avanza cuando una batalla de torneo agota sus intentos, con torneo,
 * match y batallas REALES (PG embebida, sin stubs de `onExhausted`):
 *   - camino del CLAIM: `claimJob` aparca => `onParked` => `onExhausted` (= `onBattleJobExhausted`, el
 *     mismo que cablea main.ts) => `settleFailedBattle`.
 *   - camino del BARRIDO: `startOrphanSweeper` => `onBattleFailed` (= `settleOrphanFailed`, el mismo que
 *     cablea main.ts) => `settleFailedBattle`.
 * Repetir el cierre no cambia nada (idempotente).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "../../api/src/db/seeds/dev.js";
import { tokenFor } from "../../api/src/testing/helpers.js";
import { createApp } from "../../api/src/app.js";
import { FakeBotManager } from "../../api/src/services/bot-manager.js";
import { clearStandingsCache } from "../../api/src/services/standings.js";
import { claimJob, type JobRow } from "./queue.js";
import { TournamentWorker } from "./worker.js";
import { claimBattle, makeRunBattleHandler } from "./battle-runner.js";
import { onBattleJobExhausted, settleOrphanFailed } from "./battle-failure.js";
import { startOrphanSweeper } from "./orphan-recovery.js";
import { handleGenerateSchedule } from "./scheduler.js";
import { createBots, type TestBot } from "./testing/fixtures.js";

let h: TestDbHandle;
let app: Express;
let organizer: string;
let bots: TestBot[];
let n = 0;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  clearStandingsCache();
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  organizer = await tokenFor(h.db, DEV_USERS.organizer);
  bots = await createBots(h.db, 2, "adv");
}, 180_000);
afterAll(async () => {
  await h.stop();
});

/** Torneo round robin de 2 bots: 1 match, 1 batalla `scheduled` y su trabajo `run_battle`. */
async function scheduleTournament(): Promise<{ tid: string; battleId: string }> {
  const t = await request(app)
    .post("/tournaments")
    .set("Authorization", `Bearer ${organizer}`)
    .send({
      name: `adv-${++n}`,
      format: "round_robin",
      mode: "deathmatch",
      rulesetId: DEFAULT_RULESET_ID,
      budgetCredits: 900,
      roundsPerPairing: 1,
    });
  expect(t.status).toBe(201);
  const tid = t.body.id as string;
  for (const b of bots) {
    await h.db("entries").insert({
      tournament_id: tid,
      bot_id: b.botId,
      version: b.version,
      loadout_revision: b.loadoutRevision,
      frozen: false,
    });
  }
  const close = await request(app)
    .post(`/tournaments/${tid}/actions/close-entries`)
    .set("Authorization", `Bearer ${organizer}`);
  expect(close.status).toBe(200);
  const gen = await h
    .db("jobs")
    .where({ dedupe_key: `generate_schedule:${tid}` })
    .first();
  await handleGenerateSchedule(gen as JobRow, { db: h.db, workerId: "adv-sched" });
  const battle = await h.db("battles").where({ tournament_id: tid }).first();
  return { tid, battleId: battle.id as string };
}

/** El worker muere a mitad de la batalla en su ULTIMO intento: lock vencido y lease vencido. */
async function exhaustedOrphan(battleId: string): Promise<void> {
  const job = await claimJob(h.db, {
    workerId: "adv-dead",
    kinds: ["run_battle"],
    lockTimeoutMs: 1000,
    now: new Date(),
  });
  expect(job?.payload.battleId).toBe(battleId);
  expect(await claimBattle(h.db, battleId, `adv-dead:${job!.id}:1`, 45_000)).not.toBeNull();
  await h
    .db("jobs")
    .where({ id: job!.id })
    .update({ attempts: job!.max_attempts, locked_at: h.db.raw("now() - interval '10 minutes'") });
  await h
    .db("battles")
    .where({ id: battleId })
    .update({ lease_expires_at: h.db.raw("now() - interval '5 minutes'") });
}

async function snapshot(tid: string) {
  return {
    t: (await h.db("tournaments").where({ id: tid }).first()).state,
    m: await h.db("matches").where({ tournament_id: tid }).orderBy("slot").select("state", "winner_bot_id"),
    b: await h.db("battles").where({ tournament_id: tid }).select("status", "failure_kind"),
  };
}

function expectClosed(s: Awaited<ReturnType<typeof snapshot>>) {
  expect(s.b).toEqual([{ status: "failed", failure_kind: "infrastructure" }]);
  expect(s.m).toEqual([{ state: "failed", winner_bot_id: null }]);
  expect(s.t).toBe("finished");
}

describe("V1-P0 · el torneo avanza al agotarse una batalla de torneo", () => {
  it("avance de torneo vía claim: onParked y onExhausted reales cierran match y torneo, y repetir no cambia nada", async () => {
    const { tid, battleId } = await scheduleTournament();
    await exhaustedOrphan(battleId);
    const worker = new TournamentWorker({
      db: h.db,
      workerId: "adv-claim",
      handlers: {
        run_battle: makeRunBattleHandler({
          executor: async () => {
            throw new Error("una batalla agotada NO debe ejecutarse");
          },
        }),
      },
      onExhausted: onBattleJobExhausted, // el mismo cableado que main.ts
      lockTimeoutMs: 1000,
    });
    expect(await worker.runOnce(new Date())).toBe(false); // nada que ejecutar: el claim sólo aparcó
    const s1 = await snapshot(tid);
    expectClosed(s1);
    await worker.runOnce(new Date());
    expect(await snapshot(tid)).toEqual(s1);
  });

  it("avance de torneo vía barrido: onBattleFailed real cierra match y torneo, y repetir no cambia nada", async () => {
    const { tid, battleId } = await scheduleTournament();
    await exhaustedOrphan(battleId);
    const pass = () =>
      new Promise<void>((resolve) => {
        const stop = startOrphanSweeper({
          db: h.db,
          lockTimeoutMs: 1000,
          everyMs: 3_600_000,
          onBattleFailed: settleOrphanFailed(h.db), // el mismo cableado que main.ts
          onReport: () => {
            stop();
            resolve();
          },
        });
      });
    await pass();
    const s1 = await snapshot(tid);
    expectClosed(s1);
    await pass();
    expect(await snapshot(tid)).toEqual(s1);
  });
});
