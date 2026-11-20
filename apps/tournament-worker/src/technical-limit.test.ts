/**
 * EQ2 · ADR-022 · La SALVAGUARDA TÉCNICA de la prórroga (decisión del operador
 * 2026-11-02) NO es un resultado deportivo. Una batalla detenida por ella:
 *  - termina `finished` con su replay, con `result.endReason = "technical_limit"` y
 *    `result.winner = null` (nunca "draw");
 *  - deja `participants.outcome` en NULL (ni win, ni loss, ni draw);
 *  - no genera rating_events ni cambia `ratings` (Elo ni V-D-E), aunque sea OFICIAL.
 * Control: la misma batalla con `winner: "draw"` (empate deportivo) SÍ puntúa 0,5 y
 * suma un empate: lo que distingue los dos finales es el motivo, no la casualidad.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enqueueJob, type JobRow } from "./queue.js";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev } from "../../api/src/db/seeds/dev.js";
import { TournamentWorker } from "./worker.js";
import { makeRunBattleHandler, markBattleForReview, type BattleExecution } from "./battle-runner.js";
import { applyBattleRating } from "./ratings.js";
import { createBots, insertScheduledBattle, type TestBot } from "./testing/fixtures.js";

let h: TestDbHandle;
let bots: TestBot[];

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  bots = await createBots(h.db, 4, "tl");
}, 120_000);

afterAll(async () => {
  await h.stop();
});

async function runWith(execution: BattleExecution, a: TestBot, b: TestBot) {
  const id = await insertScheduledBattle(h.db, a, b, { official: true });
  const w = new TournamentWorker({
    db: h.db,
    workerId: `tl-${id.slice(0, 6)}`,
    handlers: { run_battle: makeRunBattleHandler({ executor: async () => execution }) },
    onExhausted: (job: JobRow) => markBattleForReview(h.db, job),
  });
  await enqueueJob(h.db, "run_battle", { battleId: id }, { dedupeKey: `tl:${id}` });
  for (let i = 0; i < 5; i++) if ((await w.drain()) === 0) break;
  return id;
}

const base = {
  ticks: 37_890,
  score: { A: 0, B: 0 },
  finalStateHash: "h",
  disqualified: [],
  versions: { engine: "0.4.0" },
};

describe("salvaguarda técnica de la prórroga: sin resultado deportivo", () => {
  it("finished con endReason technical_limit, winner null, outcome NULL y sin Elo ni V-D-E", async () => {
    const id = await runWith({ ...base, winner: null, endReason: "technical_limit" }, bots[0], bots[1]);
    const row = await h.db("battles").where({ id }).first();
    expect(row.status).toBe("finished");
    expect(row.result.endReason).toBe("technical_limit");
    expect(row.result.winner).toBeNull();
    expect(row.result.winner).not.toBe("draw");
    const ps = await h.db("participants").where({ battle_id: id });
    expect(ps.map((p: { outcome: string | null }) => p.outcome)).toEqual([null, null]);
    expect(await applyBattleRating(h.db, id)).toBe(false);
    expect(await h.db("rating_events").where({ battle_id: id })).toHaveLength(0);
    const ratings = await h.db("ratings").whereIn("bot_id", [bots[0].botId, bots[1].botId]);
    expect(ratings).toHaveLength(0);
  });

  it("control: un EMPATE deportivo sí puntúa (0,5) y suma un empate en V-D-E", async () => {
    const id = await runWith({ ...base, winner: "draw" }, bots[2], bots[3]);
    const ps = await h.db("participants").where({ battle_id: id });
    expect(ps.map((p: { outcome: string | null }) => p.outcome)).toEqual(["draw", "draw"]);
    expect(await applyBattleRating(h.db, id)).toBe(true);
    const r = await h.db("ratings").where({ bot_id: bots[2].botId }).first();
    expect(r.draws).toBe(1);
    expect(r.wins + r.losses).toBe(0);
  });
});
