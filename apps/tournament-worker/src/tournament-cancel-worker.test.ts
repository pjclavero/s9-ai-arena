/**
 * #288 · Ninguna batalla después de cancelar (worker). Por diseño un torneo sólo se
 * cancela en `draft`/`open` (sin calendario); estas pruebas fuerzan el estado
 * `cancelled` por SQL —como haría una operación manual o un cambio futuro— para
 * probar la defensa en profundidad de cada camino que crea o ejecuta batallas:
 *
 *  - TW-1 generate_schedule de un torneo cancelado: no-op limpio (job `done`), ni
 *         matches ni batallas.
 *  - TW-2 run_battle de una batalla `scheduled` de un torneo cancelado: NO se ejecuta,
 *         la batalla queda intacta y el job termina `done`.
 *  - TW-3 materializeBattles (cuadros y suizo pasan por aquí) no crea batallas.
 *  - TW-4 process_result nunca pisa `cancelled` con `finished`.
 *  - TW-5 regresión: el mismo camino con el torneo `closed` sí genera calendario.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev } from "../../api/src/db/seeds/dev.js";
import { enqueueJob } from "./queue.js";
import { TournamentWorker } from "./worker.js";
import {
  makeRunBattleHandler,
  markBattleForReview,
  type BattleContext,
  type BattleExecution,
} from "./battle-runner.js";
import { buildMaterializeContext, handleGenerateSchedule, materializeBattles } from "./scheduler.js";
import { handleProcessResult } from "./results.js";
import { createBots, insertScheduledBattle, type TestBot } from "./testing/fixtures.js";

let h: TestDbHandle;
let bots: TestBot[];
let seq = 0;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  bots = await createBots(h.db, 4, "tw288");
}, 120_000);

afterAll(async () => {
  await h?.stop();
});

/** Torneo `closed` con 4 inscritos y semillas reveladas, como lo deja close-entries. */
async function closedTournament(): Promise<string> {
  const [t] = await h
    .db("tournaments")
    .insert({
      name: `tw288-${++seq}`,
      format: "single_elimination",
      mode: "deathmatch",
      ruleset_id: "mvp-default",
      state: "closed",
      seeds_revealed: JSON.stringify(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]),
    })
    .returning("id");
  for (const b of bots) {
    await h.db("entries").insert({
      tournament_id: t.id,
      bot_id: b.botId,
      version: b.version,
      loadout_revision: b.loadoutRevision,
      frozen: true,
    });
  }
  return t.id as string;
}

const counts = async (id: string) => ({
  matches: Number((await h.db("matches").where({ tournament_id: id }).count("* as n").first())!.n),
  battles: Number((await h.db("battles").where({ tournament_id: id }).count("* as n").first())!.n),
});

function scriptedExecutor(calls: string[]) {
  return async (ctx: BattleContext): Promise<BattleExecution> => {
    calls.push(ctx.battle.id);
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

describe("#288 · el worker no crea ni ejecuta batallas de un torneo cancelado", () => {
  it("TW-1 generate_schedule de un torneo cancelado: job done, ni matches ni batallas", async () => {
    const id = await closedTournament();
    await h.db("tournaments").where({ id }).update({ state: "cancelled" });
    await enqueueJob(h.db, "generate_schedule", { tournamentId: id }, { dedupeKey: `generate_schedule:${id}` });
    const w = new TournamentWorker({
      db: h.db,
      workerId: "tw1",
      handlers: { generate_schedule: handleGenerateSchedule },
    });
    await w.drain();
    const job = await h
      .db("jobs")
      .where({ dedupe_key: `generate_schedule:${id}` })
      .first();
    expect(job.status).toBe("done");
    expect(await counts(id)).toEqual({ matches: 0, battles: 0 });
    expect((await h.db("tournaments").where({ id }).first()).state).toBe("cancelled");
  });

  it("TW-2 run_battle de una batalla scheduled de un torneo cancelado: no se ejecuta ni se toca", async () => {
    const id = await closedTournament();
    const battleId = await insertScheduledBattle(h.db, bots[0], bots[1], { tournamentId: id, official: true });
    await h.db("tournaments").where({ id }).update({ state: "cancelled" });
    const before = await h.db("battles").where({ id: battleId }).first();
    await enqueueJob(h.db, "run_battle", { battleId }, { dedupeKey: `run_battle:${battleId}` });
    const calls: string[] = [];
    const w = new TournamentWorker({
      db: h.db,
      workerId: "tw2",
      handlers: { run_battle: makeRunBattleHandler({ executor: scriptedExecutor(calls) }) },
      onExhausted: (job) => markBattleForReview(h.db, job),
    });
    await w.drain();
    expect(calls).toEqual([]); // el ejecutor NUNCA se llamó
    const after = await h.db("battles").where({ id: battleId }).first();
    expect(after).toEqual(before); // ni running, ni failed, ni resultado: intacta
    const job = await h
      .db("jobs")
      .where({ dedupe_key: `run_battle:${battleId}` })
      .first();
    expect(job.status).toBe("done");
    expect(await h.db("jobs").where({ dedupe_key: `process_result:${battleId}` })).toEqual([]);
  });

  it("TW-3 materializeBattles no crea batallas en un torneo cancelado", async () => {
    const id = await closedTournament();
    const [m] = await h
      .db("matches")
      .insert({ tournament_id: id, round: 2, state: "scheduled", slot: "W2-1", final: true, pairing: "{}" })
      .returning("id");
    const mctx = await buildMaterializeContext(h.db, id);
    await h.db("tournaments").where({ id }).update({ state: "cancelled" });
    const ids = await materializeBattles(
      mctx,
      m.id as string,
      {
        slot: "W2-1",
        round: 2,
        home: bots[0].botId,
        away: bots[1].botId,
        final: true,
      } as never,
    );
    expect(ids).toEqual([]);
    expect((await counts(id)).battles).toBe(0);
  });

  it("TW-4 process_result de la última batalla no pisa cancelled con finished", async () => {
    const id = await closedTournament();
    const [m] = await h
      .db("matches")
      .insert({
        tournament_id: id,
        round: 1,
        state: "scheduled",
        slot: "W1-1",
        final: true,
        pairing: JSON.stringify({ slot: "W1-1", round: 1, home: bots[0].botId, away: bots[1].botId, final: true }),
      })
      .returning("id");
    const battleId = await insertScheduledBattle(h.db, bots[0], bots[1], {
      tournamentId: id,
      matchId: m.id as string,
      official: true,
    });
    await h
      .db("battles")
      .where({ id: battleId })
      .update({ status: "finished", result: JSON.stringify({ winner: "A", score: { A: 1, B: 0 } }) });
    await h.db("tournaments").where({ id }).update({ state: "cancelled" });
    await handleProcessResult({ id: "x", kind: "process_result", payload: { battleId } } as never, {
      db: h.db,
      workerId: "tw4",
    });
    expect((await h.db("tournaments").where({ id }).first()).state).toBe("cancelled");
  });

  it("TW-5 regresión: un torneo closed sí genera calendario y pasa a running", async () => {
    const id = await closedTournament();
    await enqueueJob(h.db, "generate_schedule", { tournamentId: id }, { dedupeKey: `generate_schedule:${id}` });
    const w = new TournamentWorker({
      db: h.db,
      workerId: "tw5",
      handlers: { generate_schedule: handleGenerateSchedule },
    });
    await w.drain();
    const job = await h
      .db("jobs")
      .where({ dedupe_key: `generate_schedule:${id}` })
      .first();
    expect(job.status).toBe("done");
    const c = await counts(id);
    expect(c.matches).toBeGreaterThan(0);
    expect(c.battles).toBe(2); // 4 bots, eliminatoria: 2 semifinales materializadas
    expect((await h.db("tournaments").where({ id }).first()).state).toBe("running");
  });
});
