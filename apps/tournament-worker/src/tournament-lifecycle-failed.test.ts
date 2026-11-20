/**
 * B (release 0.5.0) · Ciclo de vida del torneo con batallas `failed` (hallazgos 5 y 6 del
 * diagnóstico de producción).
 *
 * Política (results.ts, `settleMatch`): una batalla `failed` DEFINITIVA es terminal; el match se
 * cierra «sin resultado» (state `failed`) si todos sus juegos fallaron —no puntúa, no mueve el
 * Elo, en eliminatorias avanza el mejor seed— y el torneo llega SIEMPRE a `finished`.
 * Además: `close-entries` exige ≥2 inscritos (≥2 equipos en `teams`) y hay un rescate
 * idempotente de torneos ya atascados.
 *
 * Los mutantes de scripts/mutants-tournament-lifecycle.mjs matan cada uno por un test de aquí
 * (el nombre del test lleva la etiqueta [Mx]).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "../../api/src/db/seeds/dev.js";
import { tokenFor } from "../../api/src/testing/helpers.js";
import { createApp } from "../../api/src/app.js";
import { FakeBotManager } from "../../api/src/services/bot-manager.js";
import { clearStandingsCache } from "../../api/src/services/standings.js";
import { TournamentWorker } from "./worker.js";
import { makeRunBattleHandler, markBattleForReview, type BattleExecution } from "./battle-runner.js";
import { onBattleJobExhausted } from "./battle-failure.js";
import { InfrastructureFailure } from "./errors.js";
import { handleGenerateSchedule } from "./scheduler.js";
import {
  handleProcessResult,
  leagueTable,
  rescueStuckTournaments,
  settleFailedBattle,
  settleHooks,
} from "./results.js";
import { handleUpdateStandings } from "./standings.js";
import { createBots, type TestBot } from "./testing/fixtures.js";
import type { JobRow } from "./queue.js";

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
  bots = await createBots(h.db, 8, "lc");
}, 180_000);

afterAll(async () => {
  await h.stop();
});

const WIN: BattleExecution = {
  winner: "A",
  ticks: 100,
  score: { A: 1, B: 0 },
  finalStateHash: "h",
  disqualified: [],
  versions: { engine: "0.5.0" },
};

/** Ejecutor guionizado: `failIf(battle)` ⇒ fallo de infraestructura (agota los reintentos). */
function makeWorker(failIf: (b: Record<string, any>) => boolean, onExhausted: "settle" | "old" = "settle") {
  return new TournamentWorker({
    db: h.db,
    workerId: `lc-${++n}`,
    handlers: {
      run_battle: makeRunBattleHandler({
        executor: async ({ battle }) => {
          if (failIf(battle as unknown as Record<string, any>))
            throw new InfrastructureFailure("engine_start_failure", "fallo inyectado");
          return WIN;
        },
      }),
      generate_schedule: handleGenerateSchedule,
      process_result: handleProcessResult,
      update_standings: handleUpdateStandings,
    },
    onExhausted: onExhausted === "settle" ? onBattleJobExhausted : (job: JobRow) => markBattleForReview(h.db, job),
  });
}

/** Drena toda la cascada (con reloj adelantado para saltar los backoff de reintento). */
async function drainAll(w: TournamentWorker): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const later = new Date(Date.now() + 3600_000 * (i + 1));
    if ((await w.drain(1000, later)) === 0) return;
  }
  throw new Error("drainAll: la cola no se vació");
}

async function createTournament(format: string, roundsPerPairing = 1): Promise<string> {
  const t = await request(app)
    .post("/tournaments")
    .set("Authorization", `Bearer ${organizer}`)
    .send({
      name: `lc-${++n}`,
      format,
      mode: "deathmatch",
      rulesetId: DEFAULT_RULESET_ID,
      budgetCredits: 900,
      roundsPerPairing,
    });
  expect(t.status).toBe(201);
  return t.body.id as string;
}

async function enter(tournamentId: string, list: TestBot[]): Promise<void> {
  for (const b of list) {
    await h.db("entries").insert({
      tournament_id: tournamentId,
      bot_id: b.botId,
      version: b.version,
      loadout_revision: b.loadoutRevision,
      frozen: false,
    });
  }
}

const closeEntries = (tid: string) =>
  request(app).post(`/tournaments/${tid}/actions/close-entries`).set("Authorization", `Bearer ${organizer}`);

/** Crea, inscribe, cierra y genera el calendario (sin ejecutar batallas). */
async function schedule(format: string, count: number, rounds = 1): Promise<string> {
  const tid = await createTournament(format, rounds);
  await enter(tid, bots.slice(0, count));
  expect((await closeEntries(tid)).status).toBe(200);
  const job = await h
    .db("jobs")
    .where({ dedupe_key: `generate_schedule:${tid}` })
    .first();
  await handleGenerateSchedule(job as JobRow, { db: h.db, workerId: "lc-sched" });
  return tid;
}

async function snapshot(tid: string) {
  return {
    t: await h.db("tournaments").where({ id: tid }).first(),
    m: await h
      .db("matches")
      .where({ tournament_id: tid })
      .orderBy("slot")
      .select("id", "slot", "state", "winner_bot_id"),
    b: await h.db("battles").where({ tournament_id: tid }).orderBy("id").select("id", "status"),
  };
}

const ratingEventsOf = async (tid: string) =>
  h.db("rating_events").whereIn("battle_id", h.db("battles").where({ tournament_id: tid }).select("id"));

// ---------------------------------------------------------------- regresión

describe("regresión del ciclo normal (sin fallos)", () => {
  it("round robin de 4: finished, campeón, standings con 3 puntos por victoria y Elo de cada batalla", async () => {
    const tid = await schedule("round_robin", 4);
    await drainAll(makeWorker(() => false));
    const s = await snapshot(tid);
    expect(s.t.state).toBe("finished");
    expect(s.t.champion_bot_id).toBeTruthy();
    expect(s.m).toHaveLength(6);
    expect(s.m.every((m: any) => m.state === "finished")).toBe(true);
    expect(s.b.every((b: any) => b.status === "finished")).toBe(true);
    const table = await leagueTable(h.db, tid, false);
    expect(table.reduce((a, r) => a + r.points, 0)).toBe(6 * 3); // 6 matches, todos con ganador
    expect(table[0].id).toBe(s.t.champion_bot_id);
    expect(await ratingEventsOf(tid)).toHaveLength(12); // 6 batallas × 2 bots
  });

  it("eliminatoria de 4: campeón = ganador de la final", async () => {
    const tid = await schedule("single_elimination", 4);
    await drainAll(makeWorker(() => false));
    const s = await snapshot(tid);
    expect(s.t.state).toBe("finished");
    const final = await h.db("matches").where({ tournament_id: tid, final: true }).first();
    expect(final.state).toBe("finished");
    expect(s.t.champion_bot_id).toBe(final.winner_bot_id);
  });
});

// ------------------------------------------------------------- una y varias failed

describe("batalla failed definitiva: el torneo siempre llega a un estado terminal", () => {
  it("[M1][R6] UNA batalla failed en un round robin: el torneo termina (antes quedaba running para siempre)", async () => {
    const tid = await schedule("round_robin", 4);
    const victim = (await h.db("battles").where({ tournament_id: tid }).orderBy("id").first()).id;
    await drainAll(makeWorker((b) => b.id === victim));
    const s = await snapshot(tid);
    expect(s.t.state).toBe("finished");
    expect(s.b.filter((b: any) => b.status === "failed")).toHaveLength(1);
    const failedMatch = s.m.filter((m: any) => m.state === "failed");
    expect(failedMatch).toHaveLength(1);
    expect(s.m.filter((m: any) => m.state === "finished")).toHaveLength(5);
  });

  it("[M2][R8] el match sin resultado NO puntúa: ni 3 ni 1 puntos, ni V-D-E, y no mueve el Elo", async () => {
    const tid = await schedule("round_robin", 4);
    const victim = await h.db("battles").where({ tournament_id: tid }).orderBy("id").first();
    await drainAll(makeWorker((b) => b.id === victim.id));
    const parts = await h.db("participants").where({ battle_id: victim.id });
    const ids = new Set(parts.map((p: any) => p.bot_id));
    // Puntos totales: sólo los 5 matches con resultado (3 cada uno); el fallido aporta 0.
    const table = await leagueTable(h.db, tid, false);
    expect(table.reduce((a, r) => a + r.points, 0)).toBe(5 * 3);
    expect(table.reduce((a, r) => a + r.draws, 0)).toBe(0);
    expect(table.reduce((a, r) => a + r.wins, 0)).toBe(5);
    // Sin eventos de rating para la batalla fallida; sí para las otras 5 (2 bots cada una).
    expect(await h.db("rating_events").where({ battle_id: victim.id })).toHaveLength(0);
    expect(await ratingEventsOf(tid)).toHaveLength(10);
    expect(ids.size).toBe(2);
  });

  it("VARIAS failed (la mitad de las batallas): el torneo termina y el calendario queda todo en estado terminal", async () => {
    const tid = await schedule("round_robin", 4);
    const all = await h.db("battles").where({ tournament_id: tid }).orderBy("id").select("id");
    const failing = new Set(all.slice(0, 3).map((b: any) => b.id));
    await drainAll(makeWorker((b) => failing.has(b.id)));
    const s = await snapshot(tid);
    expect(s.t.state).toBe("finished");
    expect(s.m.filter((m: any) => m.state === "failed")).toHaveLength(3);
    expect(s.m.filter((m: any) => m.state === "finished")).toHaveLength(3);
    expect(s.m.every((m: any) => ["finished", "failed"].includes(m.state))).toBe(true);
  });

  it("[R9] TODAS failed: el torneo termina SIN campeón (no se corona por partidas no jugadas)", async () => {
    const tid = await schedule("round_robin", 4);
    await drainAll(makeWorker(() => true));
    const s = await snapshot(tid);
    expect(s.t.state).toBe("finished");
    expect(s.t.champion_bot_id).toBeNull();
    expect(s.m.every((m: any) => m.state === "failed")).toBe(true);
    expect(await ratingEventsOf(tid)).toHaveLength(0);
  });

  it("serie de 2 juegos con UNO failed: el match se resuelve con el juego jugado", async () => {
    const tid = await schedule("round_robin", 3, 2);
    const g = await h.db("battles").where({ tournament_id: tid, game_index: 2 }).orderBy("id").first();
    await drainAll(makeWorker((b) => b.id === g.id));
    const s = await snapshot(tid);
    expect(s.t.state).toBe("finished");
    const m = await h.db("matches").where({ id: g.match_id }).first();
    expect(m.state).toBe("finished"); // no `failed`: tiene un juego con resultado
    expect(m.winner_bot_id).toBeTruthy();
  });

  it("[R4][R11] eliminatoria: la ronda 1 sin resultado hace avanzar al mejor seed y el torneo completa", async () => {
    const tid = await schedule("single_elimination", 4);
    const r1 = await h.db("matches").where({ tournament_id: tid, round: 1 }).orderBy("slot");
    const victimMatch = r1[0];
    const home = (typeof victimMatch.pairing === "string" ? JSON.parse(victimMatch.pairing) : victimMatch.pairing).home;
    await drainAll(makeWorker((b) => b.match_id === victimMatch.id));
    const s = await snapshot(tid);
    expect(s.t.state).toBe("finished");
    const after = await h.db("matches").where({ id: victimMatch.id }).first();
    expect(after.state).toBe("failed");
    expect(after.winner_bot_id).toBe(home); // avanza el mejor seed (home)
    const final = await h.db("matches").where({ tournament_id: tid, final: true }).first();
    expect(final.state).toBe("finished");
    expect(s.t.champion_bot_id).toBe(final.winner_bot_id);
  });

  it("[R3] eliminatoria: una FINAL sin resultado termina el torneo sin campeón", async () => {
    const tid = await schedule("single_elimination", 4);
    const final = await h.db("matches").where({ tournament_id: tid, final: true }).first();
    await drainAll(makeWorker((b) => b.match_id === final.id));
    // La final se materializa al terminar las semifinales: el fallo se inyecta por match.
    const s = await snapshot(tid);
    expect(s.t.state).toBe("finished");
    expect(s.t.champion_bot_id).toBeNull();
    expect((await h.db("matches").where({ id: final.id }).first()).state).toBe("failed");
  });

  it("[R7] suizo: un match failed no bloquea las rondas siguientes ni el cierre", async () => {
    const tid = await schedule("swiss", 4);
    const victim = await h.db("battles").where({ tournament_id: tid }).orderBy("id").first();
    await drainAll(makeWorker((b) => b.id === victim.id));
    const s = await snapshot(tid);
    expect(s.t.state).toBe("finished");
    expect(s.m.some((m: any) => m.state === "failed")).toBe(true);
    expect(s.m.every((m: any) => ["finished", "failed"].includes(m.state))).toBe(true);
    // R7 · la ronda siguiente SÍ se programó pese al match failed de la ronda 1: 4 bots ⇒ 2
    // rondas × 2 matches, y la ronda 2 se jugó entera (todo cerrado, sin batallas vivas).
    const rounds = await h.db("matches").where({ tournament_id: tid }).select("round");
    expect(Math.max(...rounds.map((r: any) => r.round))).toBe(2);
    expect(s.m).toHaveLength(4);
    const r2 = await h.db("matches").where({ tournament_id: tid, round: 2 });
    expect(r2).toHaveLength(2);
    expect(r2.every((m: any) => m.state === "finished")).toBe(true);
    expect(s.b.every((b: any) => ["finished", "failed"].includes(b.status))).toBe(true);
  });
});

// ------------------------------------------------------------------ concurrencia

describe("concurrencia: el último resultado y otra batalla que falla a la vez", () => {
  it("12 repeticiones: el torneo termina siempre y se cierra UNA vez (sin dobles cierres ni batallas duplicadas)", async () => {
    for (let i = 0; i < 12; i++) {
      // 2 bots, serie de 2 juegos: el juego 1 termina bien y el 2 falla definitivamente.
      const tid = await schedule("round_robin", 2, 2);
      const [g1, g2] = await h.db("battles").where({ tournament_id: tid }).orderBy("game_index");
      await h
        .db("battles")
        .where({ id: g1.id })
        .update({
          status: "finished",
          result: JSON.stringify({ winner: "A", ticks: 10, score: { A: 1, B: 0 } }),
        });
      await h.db("battles").where({ id: g2.id }).update({ status: "failed", failure_kind: "infrastructure" });
      const job = { kind: "process_result", payload: { battleId: g1.id } } as unknown as JobRow;
      const order = i % 2 === 0;
      await Promise.all(
        order
          ? [handleProcessResult(job, { db: h.db, workerId: "c1" }), settleFailedBattle(h.db, g2.id)]
          : [settleFailedBattle(h.db, g2.id), handleProcessResult(job, { db: h.db, workerId: "c1" })],
      );
      const s = await snapshot(tid);
      expect(s.t.state).toBe("finished");
      expect(s.m.map((m: any) => m.state)).toEqual(["finished"]);
      expect(s.b).toHaveLength(2); // nadie materializó batallas de más
      expect(await h.db("jobs").where({ dedupe_key: `update_standings:${g1.id}` })).toHaveLength(1);
    }
  });

  it("el último resultado llega ANTES de que la otra batalla falle: el cierre lo hace quien llega el último", async () => {
    const tid = await schedule("round_robin", 3);
    const bs = await h.db("battles").where({ tournament_id: tid }).orderBy("id");
    // Dos matches terminan; el tercero queda en juego hasta que su batalla falla.
    for (const b of bs.slice(0, 2)) {
      await h
        .db("battles")
        .where({ id: b.id })
        .update({
          status: "finished",
          result: JSON.stringify({ winner: "A", ticks: 10, score: { A: 1, B: 0 } }),
        });
    }
    await handleProcessResult({ payload: { battleId: bs[0].id } } as unknown as JobRow, { db: h.db, workerId: "c" });
    await handleProcessResult({ payload: { battleId: bs[1].id } } as unknown as JobRow, { db: h.db, workerId: "c" });
    expect((await h.db("tournaments").where({ id: tid }).first()).state).toBe("running"); // la 3.ª sigue viva
    await h.db("battles").where({ id: bs[2].id }).update({ status: "failed", failure_kind: "infrastructure" });
    await settleFailedBattle(h.db, bs[2].id);
    expect((await h.db("tournaments").where({ id: tid }).first()).state).toBe("finished");
  });
});

describe("[R2] un torneo cancelado no resucita", () => {
  it("[R2] el último resultado llega con el torneo ya cancelado: sigue cancelled (no pasa a finished)", async () => {
    const tid = await schedule("round_robin", 2);
    const b = await h.db("battles").where({ tournament_id: tid }).first();
    await h
      .db("battles")
      .where({ id: b.id })
      .update({ status: "finished", result: JSON.stringify({ winner: "A", ticks: 10, score: { A: 1, B: 0 } }) });
    await h.db("tournaments").where({ id: tid }).update({ state: "cancelled" });
    await handleProcessResult({ payload: { battleId: b.id } } as unknown as JobRow, { db: h.db, workerId: "c" });
    expect((await h.db("matches").where({ tournament_id: tid }).first()).state).toBe("finished");
    expect((await h.db("tournaments").where({ id: tid }).first()).state).toBe("cancelled");
  });
});

describe("[R12] serie a medias: el match no se cierra mientras quede un juego vivo", () => {
  it("[R12] un juego failed y el otro aún scheduled: el match y el torneo siguen abiertos; al terminar el vivo, se cierra con él", async () => {
    const tid = await schedule("round_robin", 2, 2);
    const [g1, g2] = await h.db("battles").where({ tournament_id: tid }).orderBy("game_index");
    await h.db("battles").where({ id: g1.id }).update({ status: "failed", failure_kind: "infrastructure" });
    await settleFailedBattle(h.db, g1.id);
    const mid = await snapshot(tid);
    expect(mid.m.map((m: any) => m.state)).toEqual(["scheduled"]); // NO se cerró con medio resultado
    expect(mid.t.state).toBe("running");
    // Termina el juego vivo: ahora sí se cierra, con el único juego jugado.
    await h
      .db("battles")
      .where({ id: g2.id })
      .update({ status: "finished", result: JSON.stringify({ winner: "A", ticks: 10, score: { A: 1, B: 0 } }) });
    await handleProcessResult({ payload: { battleId: g2.id } } as unknown as JobRow, { db: h.db, workerId: "c" });
    const end = await snapshot(tid);
    expect(end.m.map((m: any) => m.state)).toEqual(["finished"]);
    expect(end.t.state).toBe("finished");
  });
});

// ------------------------------------------------- cerrojo por torneo (interleaving)

describe("[R1] cerrojo por torneo: dos cierres concurrentes de matches DISTINTOS", () => {
  it("[R1] con el interleaving forzado (ambas transacciones paradas antes de comprobar el fin del torneo) el torneo SÍ termina", async () => {
    const tid = await schedule("round_robin", 3); // 3 matches de 1 juego
    const bs = await h.db("battles").where({ tournament_id: tid }).orderBy("id");
    for (const b of bs) {
      await h
        .db("battles")
        .where({ id: b.id })
        .update({ status: "finished", result: JSON.stringify({ winner: "A", ticks: 10, score: { A: 1, B: 0 } }) });
    }
    const pr = (id: string) =>
      handleProcessResult({ payload: { battleId: id } } as unknown as JobRow, { db: h.db, workerId: "c" });
    await pr(bs[2].id); // el 3.er match se cierra solo; quedan 2 matches con todos sus juegos terminales
    expect((await h.db("tournaments").where({ id: tid }).first()).state).toBe("running");

    // Barrera: cada transacción espera a la otra justo ANTES de comprobar el fin del torneo
    // (con el cerrojo la 2.ª no puede llegar: la 1.ª espera el tope y continúa).
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    settleHooks.beforeFinishCheck = async (t) => {
      if (t !== tid) return;
      if (++arrived === 2) release();
      await Promise.race([both, new Promise((r) => setTimeout(r, 1500))]);
    };
    try {
      await Promise.all([pr(bs[0].id), pr(bs[1].id)]);
    } finally {
      delete settleHooks.beforeFinishCheck;
    }
    const s = await snapshot(tid);
    expect(s.m.every((m: any) => m.state === "finished")).toBe(true);
    // Sin cerrojo cada transacción ve el match de la otra aún sin confirmar y NADIE cierra el torneo.
    expect(s.t.state).toBe("finished");
  }, 30_000);
});

// ---------------------------------------------- INTB-FIX (P2-3) · orden del cerrojo consultivo

/**
 * Traza, en orden, las consultas que emite knex (con el id de transacción). Sirve para fijar un
 * ORDEN de cerrojos sin depender del azar: en cada transacción que toca `tournaments`/`matches`,
 * la primera consulta tras el BEGIN debe ser `pg_advisory_xact_lock` (el cerrojo `tournament-settle`).
 */
function traceQueries() {
  const log: { tx: string | undefined; sql: string }[] = [];
  const fn = (q: { __knexTxId?: string; sql?: string }) => log.push({ tx: q.__knexTxId, sql: String(q.sql ?? "") });
  h.db.on("query", fn);
  return { log, stop: () => h.db.removeListener("query", fn) };
}

/** Por cada transacción que lee torneo/matches: ¿el cerrojo consultivo es lo PRIMERO que hace? */
function lockFirstReport(log: { tx: string | undefined; sql: string }[]) {
  const byTx = new Map<string, string[]>();
  for (const { tx, sql } of log) {
    if (!tx || /^\s*(begin|commit|rollback|savepoint|release)/i.test(sql)) continue;
    byTx.set(tx, [...(byTx.get(tx) ?? []), sql]);
  }
  const txs = [...byTx.values()].filter((qs) => qs.some((q) => /"(tournaments|matches)"/.test(q)));
  return {
    n: txs.length,
    firstIsLock: txs.map((qs) => /pg_advisory_xact_lock/.test(qs[0])),
    firsts: txs.map((qs) => qs[0].slice(0, 80)),
  };
}

describe("[R1b] el cerrojo consultivo tournament-settle se toma ANTES de leer, en todos los caminos", () => {
  it("[R1b] settleBattle (process_result): la 1.ª consulta de la transacción es el cerrojo, antes de leer torneo/matches", async () => {
    const tid = await schedule("round_robin", 3);
    const b = await h.db("battles").where({ tournament_id: tid }).orderBy("id").first();
    await h
      .db("battles")
      .where({ id: b.id })
      .update({ status: "finished", result: JSON.stringify({ winner: "A", ticks: 10, score: { A: 1, B: 0 } }) });
    const tr = traceQueries();
    try {
      await handleProcessResult({ payload: { battleId: b.id } } as unknown as JobRow, { db: h.db, workerId: "r1b" });
    } finally {
      tr.stop();
    }
    const rep = lockFirstReport(tr.log);
    expect(rep.n, "debe verse al menos una transacción que lee el torneo").toBeGreaterThanOrEqual(1);
    expect(rep.firstIsLock, JSON.stringify(rep.firsts)).toEqual(rep.firstIsLock.map(() => true));
  });

  it("[R1b] settleFailedBattle (batalla failed): mismo orden", async () => {
    const tid = await schedule("round_robin", 3);
    const b = await h.db("battles").where({ tournament_id: tid }).orderBy("id").first();
    await h.db("battles").where({ id: b.id }).update({ status: "failed" });
    const tr = traceQueries();
    try {
      await settleFailedBattle(h.db, b.id);
    } finally {
      tr.stop();
    }
    const rep = lockFirstReport(tr.log);
    expect(rep.n).toBeGreaterThanOrEqual(1);
    expect(rep.firstIsLock, JSON.stringify(rep.firsts)).toEqual(rep.firstIsLock.map(() => true));
  });

  it("[R1b] rescueStuckTournaments: cada torneo rescatado toma el cerrojo antes de leer", async () => {
    const tid = await schedule("round_robin", 3);
    await h
      .db("battles")
      .where({ tournament_id: tid })
      .update({ status: "finished", result: JSON.stringify({ winner: "A", ticks: 10, score: { A: 1, B: 0 } }) });
    const tr = traceQueries();
    let touched: string[];
    try {
      touched = await rescueStuckTournaments(h.db);
    } finally {
      tr.stop();
    }
    expect(touched).toContain(tid);
    const rep = lockFirstReport(tr.log);
    expect(rep.n).toBeGreaterThanOrEqual(1);
    expect(rep.firstIsLock, JSON.stringify(rep.firsts)).toEqual(rep.firstIsLock.map(() => true));
  });

  it("[R1b] el cerrojo es EFECTIVO: con el cerrojo del torneo retenido, el rescate espera y no avanza nada", async () => {
    const tid = await schedule("round_robin", 3);
    await h
      .db("battles")
      .where({ tournament_id: tid })
      .update({ status: "finished", result: JSON.stringify({ winner: "A", ticks: 10, score: { A: 1, B: 0 } }) });
    const holder = await h.db.transaction();
    await holder.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [`tournament-settle:${tid}`]);
    const p = rescueStuckTournaments(h.db);
    let waiting = 0;
    for (let i = 0; i < 200 && waiting < 1; i++) {
      waiting = (
        await h.db.raw(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
        )
      ).rows[0].n;
      if (!waiting) await new Promise((r) => setTimeout(r, 25));
    }
    expect(waiting).toBeGreaterThanOrEqual(1);
    expect((await h.db("tournaments").where({ id: tid }).first()).state).toBe("running"); // nada avanzó
    await holder.rollback();
    expect(await p).toContain(tid);
  });
});

// ------------------------------------------------------------------- puntuación

describe("puntuación con juegos failed en la serie", () => {
  it("[S1] serie con un juego failed y otro technical_limit: sin resultado deportivo, NO puntúa ni cuenta como empate", async () => {
    const tid = await schedule("round_robin", 2, 2);
    const [g1, g2] = await h.db("battles").where({ tournament_id: tid }).orderBy("game_index");
    await h.db("battles").where({ id: g1.id }).update({ status: "failed", failure_kind: "infrastructure" });
    await h
      .db("battles")
      .where({ id: g2.id })
      .update({
        status: "finished",
        result: JSON.stringify({ endReason: "technical_limit", ticks: 9, score: { A: 0, B: 0 } }),
      });
    await settleFailedBattle(h.db, g1.id);
    expect((await h.db("tournaments").where({ id: tid }).first()).state).toBe("finished");
    const table = await leagueTable(h.db, tid, false);
    expect(table.map((r) => r.points)).toEqual([0, 0]);
    expect(table.reduce((a, r) => a + r.draws, 0)).toBe(0);
  });

  it("[S1] serie con un juego failed y otro decisivo: se resuelve sólo con el jugado (3-0, sin empate)", async () => {
    const tid = await schedule("round_robin", 2, 2);
    const [g1, g2] = await h.db("battles").where({ tournament_id: tid }).orderBy("game_index");
    await h.db("battles").where({ id: g1.id }).update({ status: "failed", failure_kind: "infrastructure" });
    await h
      .db("battles")
      .where({ id: g2.id })
      .update({ status: "finished", result: JSON.stringify({ winner: "A", ticks: 10, score: { A: 1, B: 0 } }) });
    await settleFailedBattle(h.db, g1.id);
    const table = await leagueTable(h.db, tid, false);
    expect(table.map((r) => r.points).sort()).toEqual([0, 3]);
    expect(table.reduce((a, r) => a + r.draws, 0)).toBe(0);
  });
});

// ------------------------------------------------------------------------ rescate

describe("rescate idempotente de torneos ya atascados", () => {
  it("[M4] un round robin atascado (cableado antiguo) se cierra y el segundo pase no cambia nada", async () => {
    const tid = await schedule("round_robin", 4);
    const victim = (await h.db("battles").where({ tournament_id: tid }).orderBy("id").first()).id;
    await drainAll(makeWorker((b) => b.id === victim, "old"));
    // Control: con el cableado antiguo el torneo queda running para siempre.
    expect((await h.db("tournaments").where({ id: tid }).first()).state).toBe("running");
    expect(await rescueStuckTournaments(h.db)).toContain(tid);
    const after1 = await snapshot(tid);
    expect(after1.t.state).toBe("finished");
    expect(after1.m.filter((m: any) => m.state === "failed")).toHaveLength(1);
    const again = await rescueStuckTournaments(h.db);
    expect(again).not.toContain(tid);
    expect(await snapshot(tid)).toEqual(after1); // idempotente
    expect(await ratingEventsOf(tid)).toHaveLength(10);
  });

  it("una eliminatoria atascada en la ronda 1 se rescata en cascada: materializa la siguiente y se completa", async () => {
    const tid = await schedule("single_elimination", 4);
    const r1 = await h.db("matches").where({ tournament_id: tid, round: 1 }).orderBy("slot");
    const w = makeWorker((b) => b.match_id === r1[0].id, "old");
    await drainAll(w);
    expect((await h.db("tournaments").where({ id: tid }).first()).state).toBe("running");
    expect(await rescueStuckTournaments(h.db)).toContain(tid);
    // El rescate avanzó el bracket: la final tiene ya sus batallas, aún por jugar.
    const live = await h.db("battles").where({ tournament_id: tid }).whereIn("status", ["scheduled", "running"]);
    expect(live.length).toBeGreaterThan(0);
    await drainAll(makeWorker(() => false));
    expect((await h.db("tournaments").where({ id: tid }).first()).state).toBe("finished");
    expect(await rescueStuckTournaments(h.db)).not.toContain(tid);
  });

  it("[S2] el rescate deja el Elo coherente: encola update_standings de las batallas finished cuyo process_result quedó aparcado", async () => {
    const tid = await schedule("round_robin", 3); // 3 matches
    const bs = await h.db("battles").where({ tournament_id: tid }).orderBy("id");
    const keys = bs.map((b: any) => `update_standings:${b.id}`);
    const standingsJobs = () => h.db("jobs").where({ kind: "update_standings" }).whereIn("dedupe_key", keys);
    for (const b of bs.slice(0, 2)) {
      await h
        .db("battles")
        .where({ id: b.id })
        .update({ status: "finished", result: JSON.stringify({ winner: "A", ticks: 10, score: { A: 1, B: 0 } }) });
    }
    await h.db("battles").where({ id: bs[2].id }).update({ status: "failed", failure_kind: "infrastructure" });
    // Ningún process_result se ejecutó (aparcados): no hay update_standings ni Elo.
    expect(await standingsJobs()).toHaveLength(0);
    expect(await rescueStuckTournaments(h.db)).toContain(tid);
    expect((await h.db("tournaments").where({ id: tid }).first()).state).toBe("finished");
    const queued = await standingsJobs();
    // sólo las finished, no la failed
    expect(queued.map((j: any) => j.dedupe_key).sort()).toEqual(keys.slice(0, 2).sort());
    for (const j of queued) await handleUpdateStandings(j as JobRow, { db: h.db, workerId: "lc-s2" });
    expect(await ratingEventsOf(tid)).toHaveLength(4); // 2 batallas × 2 bots; la failed no mueve el Elo
    // Segundo pase: nada cambia (ni jobs duplicados ni eventos duplicados).
    expect(await rescueStuckTournaments(h.db)).not.toContain(tid);
    expect(await standingsJobs()).toHaveLength(2);
    expect(await ratingEventsOf(tid)).toHaveLength(4);
  });

  it("no toca torneos con batallas vivas ni cancelados", async () => {
    const live = await schedule("round_robin", 3); // todas scheduled
    const cancelled = await schedule("round_robin", 3);
    await h.db("battles").where({ tournament_id: cancelled }).update({ status: "failed" });
    await h.db("tournaments").where({ id: cancelled }).update({ state: "cancelled" });
    const touched = await rescueStuckTournaments(h.db);
    expect(touched).not.toContain(live);
    expect(touched).not.toContain(cancelled);
    expect((await h.db("tournaments").where({ id: cancelled }).first()).state).toBe("cancelled");
  });
});

// ------------------------------------------------------ registro del error tragado

describe("onBattleJobExhausted registra el error de settle sin propagarlo", () => {
  it("[S3] si el avance del torneo lanza, se escribe un log estructurado y la promesa resuelve", async () => {
    const tid = await schedule("round_robin", 2);
    const g = await h.db("battles").where({ tournament_id: tid }).first();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    settleHooks.beforeFinishCheck = async () => {
      throw new Error("fallo inyectado en settle");
    };
    try {
      const job = { kind: "run_battle", payload: { battleId: g.id } } as unknown as JobRow;
      await expect(onBattleJobExhausted(job, { db: h.db, workerId: "lc-log" })).resolves.toBeUndefined();
      const parse = (l: string) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      };
      const entry = spy.mock.calls.map((c) => parse(String(c[0]))).find((o) => o?.msg === "settle_failed_battle_error");
      expect(entry).toMatchObject({ level: "error", battleId: g.id });
      expect(entry.err).toContain("fallo inyectado en settle");
    } finally {
      delete settleHooks.beforeFinishCheck;
      spy.mockRestore();
    }
  });
});

// ----------------------------------------------- match failed: winnerBotId en la API

describe("API: un match failed no expone ganador", () => {
  it("[S4] winnerBotId es null y el que avanza por seed va en advancedBotId; un match finished no lo trae", async () => {
    const tid = await schedule("single_elimination", 4);
    const r1 = await h.db("matches").where({ tournament_id: tid, round: 1 }).orderBy("slot");
    const home = (typeof r1[0].pairing === "string" ? JSON.parse(r1[0].pairing) : r1[0].pairing).home;
    await drainAll(makeWorker((b) => b.match_id === r1[0].id));
    const res = await request(app).get(`/tournaments/${tid}/matches`).set("Authorization", `Bearer ${organizer}`);
    expect(res.status).toBe(200);
    const list = (res.body.items ?? res.body.matches ?? res.body) as any[];
    const failed = list.find((m) => m.id === r1[0].id);
    expect(failed.state).toBe("failed");
    expect(failed.winnerBotId).toBeNull();
    expect(failed.advancedBotId).toBe(home);
    const ok = list.find((m) => m.id === r1[1].id);
    expect(ok.state).toBe("finished");
    expect(ok.winnerBotId).toBeTruthy();
    expect(ok).not.toHaveProperty("advancedBotId");
  });
});

// ------------------------------------------------------- mínimo de participantes

describe("close-entries exige al menos 2 participantes (hallazgo 5)", () => {
  it("[M3] 0 inscritos → 409 not_enough_participants; el torneo sigue open y no se encola nada", async () => {
    const tid = await createTournament("round_robin");
    const r = await closeEntries(tid);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("not_enough_participants");
    expect((await h.db("tournaments").where({ id: tid }).first()).state).toBe("open");
    expect(await h.db("jobs").where({ dedupe_key: `generate_schedule:${tid}` })).toHaveLength(0);
  });

  it("[M3] 1 inscrito → 409 y no se congela ninguna versión", async () => {
    const tid = await createTournament("single_elimination");
    await enter(tid, bots.slice(0, 1));
    const r = await closeEntries(tid);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("not_enough_participants");
    expect((await h.db("tournaments").where({ id: tid }).first()).state).toBe("open");
    expect((await h.db("entries").where({ tournament_id: tid }).first()).frozen).toBe(false);
  });

  it("[M3][R5] formato teams con 1 equipo (2 bots del mismo equipo) → 409; con 2 equipos → 200", async () => {
    const owner = bots[0].ownerId;
    const [t1] = await h
      .db("teams")
      .insert({ name: `lc-t1-${++n}`, captain_id: owner })
      .returning("id");
    const [t2] = await h
      .db("teams")
      .insert({ name: `lc-t2-${++n}`, captain_id: owner })
      .returning("id");
    await h.db("bots").where({ id: bots[0].botId }).update({ team_id: t1.id });
    await h.db("bots").where({ id: bots[1].botId }).update({ team_id: t1.id });
    const tid = await createTournament("teams");
    await enter(tid, bots.slice(0, 2));
    const r = await closeEntries(tid);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("not_enough_participants");
    expect((await h.db("tournaments").where({ id: tid }).first()).state).toBe("open");
    // Segundo equipo: ahora sí cierra.
    await h.db("bots").where({ id: bots[2].botId }).update({ team_id: t2.id });
    await enter(tid, bots.slice(2, 3));
    expect((await closeEntries(tid)).status).toBe(200);
  });

  it("2 inscritos → 200 (el mínimo exacto es válido)", async () => {
    const tid = await createTournament("round_robin");
    await enter(tid, bots.slice(0, 2));
    expect((await closeEntries(tid)).status).toBe(200);
  });
});
