/**
 * EQ2 · P2 del EQ6 · La clasificación de (temporada, modo) es el AGREGADO de todos los
 * torneos de esa temporada y modo, no la tabla del último torneo que se actualizó.
 *
 * Escenario (PostgreSQL REAL), temporada «season-1», modo deathmatch:
 *  - Torneo T1 (A, B, C): A gana a B; A y C empatan; C pasa ronda sin rival (bye).
 *  - Torneo T2 (A, D): D gana a A; y un enfrentamiento A–D cuyas batallas terminaron
 *    TODAS por la salvaguarda técnica (ADR-022): no cuenta.
 * Esperado (3/1/0, bye = victoria, sin ganador = empate):
 *  A 1-1-1 (4 pt), B 0-1-0 (0), C 1-0-1 (4), D 1-0-0 (3).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "../../api/src/db/seeds/dev.js";
import { clearStandingsCache, getStandings } from "../../api/src/services/standings.js";
import { handleUpdateStandings, recomputeSeasonStandings } from "./standings.js";
import { createBots, type TestBot } from "./testing/fixtures.js";
import type { JobRow } from "./queue.js";

let h: TestDbHandle;
let A: TestBot, B: TestBot, C: TestBot, D: TestBot;
let t1: string, t2: string;
const SEASON = "season-1";

async function tournament(name: string, bots: TestBot[], mode = "deathmatch"): Promise<string> {
  const admin = await h.db("users").where({ email: DEV_USERS.admin }).first();
  const [t] = await h
    .db("tournaments")
    .insert({
      name,
      format: "league",
      mode,
      ruleset_id: DEFAULT_RULESET_ID,
      state: "running",
      created_by: admin.id,
      season_id: SEASON,
    })
    .returning("id");
  for (const b of bots) {
    await h
      .db("entries")
      .insert({ tournament_id: t.id, bot_id: b.botId, version: b.version, loadout_revision: 1, frozen: true });
  }
  return t.id as string;
}
async function match(
  tid: string,
  slot: string,
  home: string,
  away: string | null,
  winner: string | null,
  technical = false,
) {
  const [m] = await h
    .db("matches")
    .insert({
      tournament_id: tid,
      round: 1,
      slot,
      state: "finished",
      pairing: JSON.stringify({ slot, round: 1, bracket: "main", home, away, ...(away === null ? { bye: true } : {}) }),
      winner_bot_id: winner,
    })
    .returning("id");
  if (away !== null) {
    await h.db("battles").insert({
      tournament_id: tid,
      match_id: m.id,
      status: "finished",
      official: true,
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      game_index: 1,
      result: JSON.stringify(
        technical
          ? { winner: null, endReason: "technical_limit", score: { A: 0, B: 0 } }
          : {
              winner: winner === home ? "A" : winner === away ? "B" : "draw",
              score: { A: winner === home ? 1 : 0, B: winner === away ? 1 : 0 },
            },
      ),
    });
  }
}
const job = (tournamentId: string) =>
  ({ id: "j", kind: "update_standings", payload: { tournamentId }, attempts: 1 }) as unknown as JobRow;
async function table() {
  clearStandingsCache();
  const { standings } = await getStandings(h.db, SEASON, "deathmatch");
  return standings.map((r) => ({ id: r.botId, rank: r.rank, w: r.wins, l: r.losses, d: r.draws }));
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  [A, B, C, D] = await createBots(h.db, 4, "st");
  t1 = await tournament("st-T1", [A, B, C]);
  t2 = await tournament("st-T2", [A, D]);
  await match(t1, "M1", A.botId, B.botId, A.botId);
  await match(t1, "M2", A.botId, C.botId, null); // empate
  await match(t1, "M3", C.botId, null, null); // bye de C
  await match(t2, "N1", D.botId, A.botId, D.botId);
  await match(t2, "N2", A.botId, D.botId, null, true); // técnico: no cuenta
}, 120_000);

afterAll(async () => {
  await h.stop();
});

const EXPECTED = () => [
  { id: A.botId, w: 1, l: 1, d: 1 },
  { id: B.botId, w: 0, l: 1, d: 0 },
  { id: C.botId, w: 1, l: 0, d: 1 },
  { id: D.botId, w: 1, l: 0, d: 0 },
];
const byId = (rows: { id: string }[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));

describe("standings de temporada = agregado de todos los torneos del modo", () => {
  it("T1 y luego T2: están los 4 bots con V-D-E sumados (antes sólo quedaban los de T2)", async () => {
    await handleUpdateStandings(job(t1), { db: h.db } as never);
    await handleUpdateStandings(job(t2), { db: h.db } as never);
    const rows = await table();
    expect(byId(rows.map(({ id, w, l, d }) => ({ id, w, l, d })))).toEqual(byId(EXPECTED()));
    // Orden: A y C a 4 puntos (empataron entre sí; diferencia 0 los dos ⇒ seed: A); D 3; B 0.
    expect(rows[0].id).toBe(A.botId);
    expect(rows[1].id).toBe(C.botId);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    expect(rows.at(-1)!.id).toBe(B.botId);
    expect(rows[2].id).toBe(D.botId);
  });

  it("orden inverso e idempotencia: misma tabla exacta (rangos incluidos)", async () => {
    const forward = await table();
    await handleUpdateStandings(job(t2), { db: h.db } as never);
    await handleUpdateStandings(job(t1), { db: h.db } as never);
    expect(await table()).toEqual(forward);
    await handleUpdateStandings(job(t1), { db: h.db } as never);
    await handleUpdateStandings(job(t1), { db: h.db } as never);
    expect(await table()).toEqual(forward);
  });

  it("dos recálculos simultáneos no pierden filas", async () => {
    const forward = await table();
    await h.db("standings").delete();
    await Promise.all([
      recomputeSeasonStandings(h.db, SEASON, "deathmatch"),
      recomputeSeasonStandings(h.db, SEASON, "deathmatch"),
      handleUpdateStandings(job(t1), { db: h.db } as never),
      handleUpdateStandings(job(t2), { db: h.db } as never),
    ]);
    expect(await table()).toEqual(forward);
  });

  it("el enfrentamiento técnico (ADR-022) no suma ni empate ni derrota", async () => {
    const a = (await table()).find((r) => r.id === A.botId)!;
    expect(a.d).toBe(1); // sólo el empate real con C
    expect(a.l).toBe(1); // sólo la derrota real con D
  });

  it("empate total entre torneos (mismos puntos, sin directos, misma diferencia y seed): decide el id, no el orden", async () => {
    // Otro modo, para no tocar la tabla de arriba. Dos torneos de un bot con bye cada uno.
    const [x, y] = await createBots(h.db, 2, "st-tie");
    const ta = await tournament("st-tie-a", [], "team_deathmatch");
    const tb = await tournament("st-tie-b", [], "team_deathmatch");
    // El torneo de id MENOR recibe el bot de id MAYOR: sin desempate por id, el orden
    // saldría del orden de los torneos y no del bot.
    const [lowT, highT] = ta < tb ? [ta, tb] : [tb, ta];
    const [lowBot, highBot] = x.botId < y.botId ? [x, y] : [y, x];
    for (const [tid, bot] of [
      [lowT, highBot],
      [highT, lowBot],
    ] as const) {
      await h
        .db("entries")
        .insert({ tournament_id: tid, bot_id: bot.botId, version: bot.version, loadout_revision: 1, frozen: true });
      await match(tid, `bye-${bot.botId.slice(0, 4)}`, bot.botId, null, null);
    }
    await recomputeSeasonStandings(h.db, SEASON, "team_deathmatch");
    clearStandingsCache();
    const { standings } = await getStandings(h.db, SEASON, "team_deathmatch");
    expect(standings.map((r) => r.botId)).toEqual([lowBot.botId, highBot.botId]);
    expect(standings.map((r) => [r.wins, r.losses, r.draws])).toEqual([
      [1, 0, 0],
      [1, 0, 0],
    ]);
  });
});
