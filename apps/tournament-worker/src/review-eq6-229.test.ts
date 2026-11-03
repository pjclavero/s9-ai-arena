/**
 * [REVIEW] #229 (EQ6, revisor independiente) · STANDINGS_POLICY = official_played_not_reverted.
 * NO MERGEAR. Tests de rotura contra PostgreSQL REAL (embedded-postgres):
 *  - bordes de los 9 casos de la política (open sólo técnica, cancelled con revertidas y no
 *    revertidas, revertida dentro de una serie, bye, bot que sólo jugó en un torneo cancelado);
 *  - coherencia Elo ↔ V-D-E ↔ standings con el MISMO conjunto de batallas;
 *  - reversión: idempotencia, doble reversión, revertir y recalcular, revertir y re-aplicar,
 *    revertir una batalla aún no puntuada;
 *  - concurrencia: recálculos simultáneos frente a una reversión;
 *  - réplica del único torneo `finished` de producción (datos de la auditoría EQ4 de solo
 *    lectura, 2026-11-02): main (e3bf2fa) frente al PR (1bcdc51).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "../../api/src/db/seeds/dev.js";
import { clearStandingsCache, getStandings } from "../../api/src/services/standings.js";
import { handleUpdateStandings, recomputeSeasonStandings, revertOfficialBattle, seasonTable } from "./standings.js";
import { applyBattleRating, revertBattleRating, INITIAL_RATING } from "./ratings.js";
import { leagueTableDetailed, sortTable, type TableRow } from "./results.js";
import { createBots, type TestBot } from "./testing/fixtures.js";
import type { JobRow } from "./queue.js";

let h: TestDbHandle;
let adminId: string;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  adminId = (await h.db("users").where({ email: DEV_USERS.admin }).first()).id;
}, 120_000);

afterAll(async () => {
  await h.stop();
});

// ------------------------------------------------------------------ utilidades

async function tournament(o: {
  season: string;
  mode?: string;
  state?: string;
  format?: string;
  bots: TestBot[];
}): Promise<string> {
  const [t] = await h
    .db("tournaments")
    .insert({
      name: `rev-${Math.random().toString(36).slice(2, 8)}`,
      format: o.format ?? "league",
      mode: o.mode ?? "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      state: o.state ?? "running",
      created_by: adminId,
      season_id: o.season,
    })
    .returning("id");
  for (const b of o.bots) {
    await h
      .db("entries")
      .insert({ tournament_id: t.id, bot_id: b.botId, version: b.version, loadout_revision: 1, frozen: true });
  }
  return t.id as string;
}

async function match(
  tid: string,
  home: string,
  away: string | null,
  o: { bracket?: string; state?: string; slot?: string; bye?: boolean; winner?: string | null } = {},
): Promise<string> {
  const slot = o.slot ?? `S${Math.random().toString(36).slice(2, 8)}`;
  const [m] = await h
    .db("matches")
    .insert({
      tournament_id: tid,
      round: 1,
      slot,
      state: o.state ?? "finished",
      pairing: JSON.stringify({ slot, round: 1, bracket: o.bracket ?? "main", home, away, bye: o.bye ?? false }),
      winner_bot_id: o.winner ?? null,
    })
    .returning("id");
  return m.id as string;
}

/**
 * Juego `gi` de un enfrentamiento: gana `w` ("home" | "away" | "draw" | "technical").
 * Lados como en el motor (results.ts): juego impar → home = A; par → home = B.
 */
async function game(
  tid: string,
  mid: string,
  home: TestBot,
  away: TestBot,
  gi: number,
  w: "home" | "away" | "draw" | "technical",
  o: { mode?: string; rate?: boolean; official?: boolean; scoreWin?: number } = {},
): Promise<string> {
  const homeTeam = gi % 2 === 1 ? "A" : "B";
  const awayTeam = gi % 2 === 1 ? "B" : "A";
  const sw = o.scoreWin ?? 1;
  const score: Record<string, number> = { A: 0, B: 0 };
  if (w === "home") score[homeTeam] = sw;
  if (w === "away") score[awayTeam] = sw;
  const result =
    w === "technical"
      ? { winner: null, endReason: "technical_limit", score: { A: 0, B: 0 } }
      : { winner: w === "home" ? homeTeam : w === "away" ? awayTeam : "draw", score, endReason: "completed" };
  const [b] = await h
    .db("battles")
    .insert({
      tournament_id: tid,
      match_id: mid,
      status: "finished",
      official: o.official ?? true,
      mode: o.mode ?? "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      game_index: gi,
      result: JSON.stringify(result),
    })
    .returning("id");
  const outcome = (side: "home" | "away") =>
    w === "technical" ? null : w === "draw" ? "draw" : w === side ? "win" : "loss";
  await h.db("participants").insert([
    { battle_id: b.id, bot_id: home.botId, version: 1, team: homeTeam, outcome: outcome("home") },
    { battle_id: b.id, bot_id: away.botId, version: 1, team: awayTeam, outcome: outcome("away") },
  ]);
  if (o.rate ?? true) await applyBattleRating(h.db, b.id);
  return b.id as string;
}

const job = (tournamentId: string, battleId?: string) =>
  ({ id: "j", kind: "update_standings", payload: { tournamentId, battleId }, attempts: 1 }) as unknown as JobRow;
async function update(tid: string, battleId?: string) {
  await handleUpdateStandings(job(tid, battleId), { db: h.db } as never);
}
async function table(season: string, mode = "deathmatch") {
  clearStandingsCache();
  const { standings } = await getStandings(h.db, season, mode);
  return standings.map((r) => ({ id: r.botId, rank: r.rank, w: r.wins, l: r.losses, d: r.draws, rating: r.rating }));
}
const vde = (rows: Awaited<ReturnType<typeof table>>, b: TestBot) => {
  const r = rows.find((x) => x.id === b.botId);
  return r ? [r.w, r.l, r.d] : null;
};

/**
 * Coherencia Elo ↔ libro mayor: para cada bot de la (temporada, modo), rating materializado
 * = inicial + Σ deltas NO revertidos; y standings.rating = ratings.rating.
 */
async function ledgerCoherent(season: string, mode = "deathmatch") {
  const ratings = await h.db("ratings").where({ season_id: season, mode });
  const bad: string[] = [];
  for (const r of ratings) {
    const ev = await h.db("rating_events").where({ bot_id: r.bot_id, season_id: season, mode, reverted: false });
    const sum = ev.reduce((s: number, e: Record<string, unknown>) => s + Number(e.delta), INITIAL_RATING);
    if (Math.abs(sum - Number(r.rating)) > 1e-9) bad.push(`${r.bot_id}: ratings=${r.rating} ledger=${sum}`);
  }
  for (const s of await h.db("standings").where({ season_id: season, mode })) {
    const r = ratings.find((x: Record<string, unknown>) => x.bot_id === s.bot_id);
    const expected = r ? Number(r.rating) : INITIAL_RATING;
    if (Math.abs(expected - Number(s.rating)) > 1e-9) bad.push(`${s.bot_id}: standings=${s.rating} ratings=${expected}`);
  }
  return bad;
}

/** seasonTable de main @ e3bf2fa (copiada literal) para comparar con el PR. */
async function seasonTableMain(db: Knex, seasonId: string, mode: string): Promise<TableRow[]> {
  const tournaments = await db("tournaments")
    .where({ season_id: seasonId, mode })
    .whereNot({ format: "teams" })
    .orderBy("id", "asc")
    .select("id");
  const total = new Map<string, TableRow>();
  const h2h = new Map<string, number>();
  for (const { id } of tournaments as { id: string }[]) {
    const { rows, headToHead } = await leagueTableDetailed(db, id, false);
    for (const r of rows.values()) {
      const acc = total.get(r.id);
      if (!acc) total.set(r.id, { ...r });
      else {
        acc.points += r.points;
        acc.wins += r.wins;
        acc.losses += r.losses;
        acc.draws += r.draws;
        acc.scoreDiff += r.scoreDiff;
        acc.seed = Math.min(acc.seed, r.seed);
      }
    }
    for (const [k, n] of headToHead) h2h.set(k, (h2h.get(k) ?? 0) + n);
  }
  return sortTable(total.values(), h2h);
}

// ------------------------------------------------------------------ bordes de la política

describe("[REVIEW #229] bordes de la política", () => {
  it("R1 · open con SÓLO una batalla técnica: nadie en standings, sin Elo", async () => {
    const [a, b, c] = await createBots(h.db, 3, "r1");
    const t = await tournament({ season: "R1", state: "open", bots: [a, b, c] });
    const m = await match(t, a.botId, b.botId);
    const bid = await game(t, m, a, b, 1, "technical");
    await update(t, bid);
    expect(await table("R1")).toEqual([]);
    expect(await h.db("rating_events").where({ battle_id: bid })).toHaveLength(0);
    expect(await h.db("ratings").where({ season_id: "R1" })).toHaveLength(0);
  });

  it("R2 · cancelled con jugadas, unas revertidas y otras no: cuentan sólo las no revertidas", async () => {
    const [a, b, c, d] = await createBots(h.db, 4, "r2");
    const t = await tournament({ season: "R2", bots: [a, b, c, d] });
    const keep1 = await game(t, await match(t, a.botId, b.botId), a, b, 1, "home");
    const bad1 = await game(t, await match(t, c.botId, d.botId), c, d, 1, "home");
    const keep2 = await game(t, await match(t, a.botId, c.botId), a, c, 1, "draw");
    const bad2 = await game(t, await match(t, b.botId, d.botId), b, d, 1, "away");
    await update(t);
    await h.db("tournaments").where({ id: t }).update({ state: "cancelled" });
    await revertOfficialBattle(h.db, bad1);
    await revertOfficialBattle(h.db, bad2);
    await update(t);
    const rows = await table("R2");
    expect(vde(rows, a)).toEqual([1, 0, 1]);
    expect(vde(rows, b)).toEqual([0, 1, 0]);
    expect(vde(rows, c)).toEqual([0, 0, 1]); // su victoria sobre d se revirtió
    expect(vde(rows, d)).toBeNull(); // sus dos enfrentamientos se revirtieron
    expect(await ledgerCoherent("R2")).toEqual([]);
    void keep1;
    void keep2;
  });

  it("R3 · revertir un juego de una serie (liga bo3) recalcula la serie: 2-1 ⇒ 1-1 ⇒ empate", async () => {
    const [a, b] = await createBots(h.db, 2, "r3");
    const t = await tournament({ season: "R3", bots: [a, b] });
    const m = await match(t, a.botId, b.botId);
    await game(t, m, a, b, 1, "home");
    await game(t, m, a, b, 2, "away");
    const g3 = await game(t, m, a, b, 3, "home");
    await update(t);
    expect(vde(await table("R3"), a)).toEqual([1, 0, 0]);
    await revertOfficialBattle(h.db, g3);
    const rows = await table("R3");
    expect(vde(rows, a)).toEqual([0, 0, 1]);
    expect(vde(rows, b)).toEqual([0, 0, 1]);
    expect(await ledgerCoherent("R3")).toEqual([]);
  });

  it("R3b · igual en eliminatoria: 1-1 tras revertir ⇒ decide el seed (home), como el cierre", async () => {
    const [a, b] = await createBots(h.db, 2, "r3b");
    const t = await tournament({ season: "R3b", format: "single_elimination", bots: [a, b] });
    const m = await match(t, a.botId, b.botId, { bracket: "winners" });
    await game(t, m, a, b, 1, "home");
    await game(t, m, a, b, 2, "away");
    const g3 = await game(t, m, a, b, 3, "away");
    await update(t);
    expect(vde(await table("R3b"), b)).toEqual([1, 0, 0]);
    await revertOfficialBattle(h.db, g3);
    const rows = await table("R3b");
    expect(vde(rows, a)).toEqual([1, 0, 0]);
    expect(vde(rows, b)).toEqual([0, 1, 0]);
  });

  it("R4 · bye: el bot con bye y un enfrentamiento disputado suma sólo el disputado", async () => {
    const [a, b, c] = await createBots(h.db, 3, "r4");
    const t = await tournament({ season: "R4", bots: [a, b, c] });
    await match(t, c.botId, null, { bye: true, winner: c.botId });
    await game(t, await match(t, a.botId, c.botId), a, c, 1, "home");
    await game(t, await match(t, b.botId, c.botId), b, c, 1, "draw");
    await update(t);
    const rows = await table("R4");
    expect(vde(rows, c)).toEqual([0, 1, 1]);
    expect(await ledgerCoherent("R4")).toEqual([]);
  });

  it("R5 · bot que sólo jugó en un torneo luego cancelado: sigue en standings con su resultado", async () => {
    const [a, b, x] = await createBots(h.db, 3, "r5");
    const t1 = await tournament({ season: "R5", bots: [a, x] });
    const t2 = await tournament({ season: "R5", bots: [a, b] });
    await game(t1, await match(t1, x.botId, a.botId), x, a, 1, "home");
    await game(t2, await match(t2, a.botId, b.botId), a, b, 1, "home");
    await update(t1);
    await h.db("tournaments").where({ id: t1 }).update({ state: "cancelled" });
    await update(t2); // el recálculo lo dispara OTRO torneo de la misma (temporada, modo)
    const rows = await table("R5");
    expect(vde(rows, x)).toEqual([1, 0, 0]);
    expect(vde(rows, a)).toEqual([1, 1, 0]);
  });

  it("R6 · eliminatoria a medias (running): un primer juego en EMPATE no puede dar una victoria", async () => {
    // Política: «running: las batallas oficiales terminadas cuentan en el momento». Un empate
    // de juego no es una victoria de nadie; seriesOutcome aplica el desempate por seed de una
    // serie CERRADA a una serie que todavía se está jugando.
    const [a, b] = await createBots(h.db, 2, "r6");
    const t = await tournament({ season: "R6", format: "single_elimination", bots: [a, b] });
    const m = await match(t, a.botId, b.botId, { bracket: "winners", state: "running" });
    await game(t, m, a, b, 1, "draw");
    await h.db("battles").insert({
      tournament_id: t,
      match_id: m,
      status: "scheduled",
      official: true,
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      game_index: 2,
    });
    await update(t);
    const rows = await table("R6");
    expect(vde(rows, a)).not.toEqual([1, 0, 0]);
  });
});

// ------------------------------------------------------------------ reversión

describe("[REVIEW #229] reversión", () => {
  it("V1 · revertir dos veces, recalcular y re-aplicar el Elo: estado estable y coherente", async () => {
    const [a, b, c] = await createBots(h.db, 3, "v1");
    const t = await tournament({ season: "V1", bots: [a, b, c] });
    await game(t, await match(t, a.botId, c.botId), a, c, 1, "home");
    const bad = await game(t, await match(t, a.botId, b.botId), a, b, 1, "home");
    await update(t);
    expect(await revertOfficialBattle(h.db, bad)).toBe(true);
    const after = await table("V1");
    const ratingsAfter = await h.db("ratings").where({ season_id: "V1" }).orderBy("bot_id");
    expect(await revertOfficialBattle(h.db, bad)).toBe(false);
    expect(await revertBattleRating(h.db, bad)).toBe(false);
    await update(t, bad); // el job de la batalla revertida vuelve a correr (reintento)
    expect(await applyBattleRating(h.db, bad)).toBe(false);
    await recomputeSeasonStandings(h.db, "V1", "deathmatch");
    expect(await table("V1")).toEqual(after);
    expect(await h.db("ratings").where({ season_id: "V1" }).orderBy("bot_id")).toEqual(ratingsAfter);
    expect(await ledgerCoherent("V1")).toEqual([]);
  });

  it("V2 · revertir una batalla AÚN NO puntuada (job update_standings pendiente) debe sacarla", async () => {
    const [a, b] = await createBots(h.db, 2, "v2");
    const t = await tournament({ season: "V2", bots: [a, b] });
    const bid = await game(t, await match(t, a.botId, b.botId), a, b, 1, "home", { rate: false });
    await recomputeSeasonStandings(h.db, "V2", "deathmatch"); // otro job ya la ve en standings
    expect(vde(await table("V2"), a)).toEqual([1, 0, 0]);
    const r = await revertOfficialBattle(h.db, bid);
    // Llega después el job pendiente de esa batalla.
    await update(t, bid);
    const rows = await table("V2");
    expect({ r, a: vde(rows, a), events: (await h.db("rating_events").where({ battle_id: bid })).length }).toEqual({
      r: true,
      a: null,
      events: 0,
    });
  });
});

// ------------------------------------------------------------------ concurrencia

describe("[REVIEW #229] concurrencia", () => {
  it("C1 · reversión simultánea con recálculos y jobs del mismo (temporada, modo): estado final correcto", async () => {
    for (let round = 0; round < 6; round++) {
      const season = `C1-${round}`;
      const [a, b, c] = await createBots(h.db, 3, `c1${round}`);
      const t1 = await tournament({ season, bots: [a, b, c] });
      const t2 = await tournament({ season, bots: [a, c] });
      await game(t1, await match(t1, a.botId, c.botId), a, c, 1, "home");
      const bad = await game(t1, await match(t1, a.botId, b.botId), a, b, 1, "home");
      await game(t2, await match(t2, c.botId, a.botId), c, a, 1, "home");
      await update(t1);
      await Promise.all([
        recomputeSeasonStandings(h.db, season, "deathmatch"),
        update(t2),
        revertOfficialBattle(h.db, bad),
        update(t1),
        recomputeSeasonStandings(h.db, season, "deathmatch"),
      ]);
      const rows = await table(season);
      expect(vde(rows, b)).toBeNull();
      expect(vde(rows, a)).toEqual([1, 1, 0]);
      expect(await ledgerCoherent(season)).toEqual([]);
    }
  });

  it("C2 · reversión simultánea con el Elo de OTRA batalla del mismo bot: el libro mayor cuadra", async () => {
    const bad: string[] = [];
    for (let round = 0; round < 8; round++) {
      const season = `C2-${round}`;
      const [a, b, c] = await createBots(h.db, 3, `c2${round}`);
      const t = await tournament({ season, bots: [a, b, c] });
      const rev = await game(t, await match(t, a.botId, b.botId), a, b, 1, "home");
      const late = await game(t, await match(t, a.botId, c.botId), a, c, 1, "home", { rate: false });
      await Promise.all([revertOfficialBattle(h.db, rev), update(t, late)]);
      await recomputeSeasonStandings(h.db, season, "deathmatch");
      bad.push(...(await ledgerCoherent(season)));
    }
    expect(bad).toEqual([]);
  });

  it("C3 · (preexistente en main, control) dos Elo simultáneos de batallas distintas del mismo bot", async () => {
    const bad: string[] = [];
    for (let round = 0; round < 8; round++) {
      const season = `C3-${round}`;
      const [a, b, c] = await createBots(h.db, 3, `c3${round}`);
      const t = await tournament({ season, bots: [a, b, c] });
      const g1 = await game(t, await match(t, a.botId, b.botId), a, b, 1, "home", { rate: false });
      const g2 = await game(t, await match(t, a.botId, c.botId), a, c, 1, "home", { rate: false });
      await Promise.all([update(t, g1), update(t, g2)]);
      bad.push(...(await ledgerCoherent(season)));
    }
    expect(bad).toEqual([]);
  });
});

// ------------------------------------------------------------------ coherencia y no regresión

describe("[REVIEW #229] coherencia Elo ↔ V-D-E ↔ standings", () => {
  it("K1 · draft con una batalla oficial disputada: ni standings ni Elo (draft no aporta nada)", async () => {
    const [a, b] = await createBots(h.db, 2, "k1");
    const t = await tournament({ season: "K1", state: "draft", bots: [a, b] });
    const bid = await game(t, await match(t, a.botId, b.botId), a, b, 1, "home", { rate: false });
    await update(t, bid);
    expect(await table("K1")).toEqual([]);
    expect(await h.db("ratings").where({ season_id: "K1" })).toHaveLength(0);
  });

  it("K2 · cada bot en standings tiene rating = libro mayor, y cada bot con Elo vigente está en standings", async () => {
    const [a, b, c, d] = await createBots(h.db, 4, "k2");
    const t1 = await tournament({ season: "K2", bots: [a, b, c] });
    const t2 = await tournament({ season: "K2", state: "cancelled", bots: [c, d] });
    const m = await match(t1, a.botId, b.botId);
    await game(t1, m, a, b, 1, "home");
    await game(t1, m, a, b, 2, "technical");
    await game(t1, await match(t1, b.botId, c.botId), b, c, 1, "draw");
    await game(t2, await match(t2, c.botId, d.botId), c, d, 1, "away");
    await update(t1);
    const rows = await table("K2");
    expect(await ledgerCoherent("K2")).toEqual([]);
    const live = await h.db("rating_events").where({ season_id: "K2", reverted: false }).distinct("bot_id");
    expect(rows.map((r) => r.id).sort()).toEqual(live.map((r: { bot_id: string }) => r.bot_id).sort());
  });
});

describe("[REVIEW #229] no regresión: réplica del torneo finished de producción", () => {
  it("P1 · single_elimination de 6 bots con 2 byes (EQ4 RANKING_AUDIT): main frente al PR", async () => {
    // Seeds por posición de sembrado (seedPositions(8) = 1,8,4,5,2,7,3,6) y matches/batallas
    // tal como los devuelve la API de producción (phase1.json de la auditoría EQ4).
    const names = ["A-ATK-2", "A-DEF", "A-ATK-1", "B-DEF", "B-ATK-1", "prueba1"];
    const bots = await createBots(h.db, 6, "prod");
    const by = Object.fromEntries(names.map((n, i) => [n, bots[i]]));
    const t = await tournament({ season: "PROD", format: "single_elimination", state: "running", bots });
    const W = { bracket: "winners" };
    await match(t, by["A-ATK-2"].botId, null, { ...W, slot: "W1M1", bye: true, winner: by["A-ATK-2"].botId });
    const m2 = await match(t, by["B-DEF"].botId, by["B-ATK-1"].botId, { ...W, slot: "W1M2", winner: by["B-ATK-1"].botId });
    await match(t, by["A-DEF"].botId, null, { ...W, slot: "W1M3", bye: true, winner: by["A-DEF"].botId });
    const m4 = await match(t, by["A-ATK-1"].botId, by["prueba1"].botId, { ...W, slot: "W1M4", winner: by["prueba1"].botId });
    const m5 = await match(t, by["A-ATK-2"].botId, by["B-ATK-1"].botId, { ...W, slot: "W2M1", winner: by["B-ATK-1"].botId });
    const m6 = await match(t, by["A-DEF"].botId, by["prueba1"].botId, { ...W, slot: "W2M2", winner: by["A-DEF"].botId });
    const m7 = await match(t, by["B-ATK-1"].botId, by["A-DEF"].botId, { ...W, slot: "W3M1", winner: by["B-ATK-1"].botId });
    await game(t, m2, by["B-DEF"], by["B-ATK-1"], 1, "away");
    await game(t, m4, by["A-ATK-1"], by["prueba1"], 1, "away");
    await game(t, m5, by["A-ATK-2"], by["B-ATK-1"], 1, "away");
    await game(t, m6, by["A-DEF"], by["prueba1"], 1, "draw");
    await game(t, m7, by["B-ATK-1"], by["A-DEF"], 1, "draw");
    await h.db("tournaments").where({ id: t }).update({ state: "finished" });
    const fmt = (rows: TableRow[]) =>
      rows.map((r) => `${names[bots.findIndex((b) => b.botId === r.id)]} ${r.wins}-${r.losses}-${r.draws}`);
    const main = fmt(await seasonTableMain(h.db, "PROD", "deathmatch"));
    const pr = fmt(await seasonTable(h.db, "PROD", "deathmatch"));
    // Lo que publica producción hoy (EQ4): la réplica tiene que reproducirlo con main.
    expect(main).toEqual([
      "B-ATK-1 3-0-0",
      "A-DEF 2-1-0",
      "prueba1 1-1-0",
      "A-ATK-2 1-1-0",
      "A-ATK-1 0-1-0",
      "B-DEF 0-1-0",
    ]);
    // Gate del operador: con el único torneo finished de hoy la clasificación sale idéntica.
    expect(pr).toEqual(main);
  });
});
