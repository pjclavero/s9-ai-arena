/**
 * EQ2 · `STANDINGS_POLICY = official_played_not_reverted` (política del operador,
 * 2026-11-02), contra PostgreSQL REAL. La clasificación y el Elo dependen de resultados
 * OFICIALES realmente DISPUTADOS, no del estado administrativo del torneo:
 *  1. torneo open sin batallas ⇒ no aparecen bots 0-0-0;
 *  2. running con una batalla terminada ⇒ aparece;
 *  3. finished ⇒ permanece;
 *  4. cancelled tras una batalla ⇒ permanece (y draft no aporta);
 *  5. batalla revertida (mecanismo de Elo existente) ⇒ desaparece de V-D-E, standings y Elo;
 *  6. dos torneos del mismo modo y temporada ⇒ suman los dos (P2 del EQ6, #220);
 *  7. modos distintos no se mezclan;  8. temporadas distintas no se mezclan;
 *  9. final técnico ⇒ sin Elo, sin V-D-E y sin standings.
 * Además: orden inverso, idempotencia, concurrencia y desempate final por id.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "../../api/src/db/seeds/dev.js";
import { clearStandingsCache, getStandings } from "../../api/src/services/standings.js";
import { handleUpdateStandings, recomputeSeasonStandings, revertOfficialBattle, seasonTable } from "./standings.js";
import { applyBattleRating } from "./ratings.js";
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

async function tournament(o: { season: string; mode?: string; state?: string; bots: TestBot[] }): Promise<string> {
  const [t] = await h
    .db("tournaments")
    .insert({
      name: `pol-${Math.random().toString(36).slice(2, 8)}`,
      format: "league",
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

/** Enfrentamiento home–away con UN juego oficial terminado (A = home en el juego 1). */
async function played(
  tid: string,
  home: TestBot,
  away: TestBot,
  winner: "home" | "away" | "draw" | "technical",
  o: { mode?: string; official?: boolean } = {},
): Promise<string> {
  const slot = `S${Math.random().toString(36).slice(2, 8)}`;
  const winnerBot = winner === "home" ? home.botId : winner === "away" ? away.botId : null;
  const [m] = await h
    .db("matches")
    .insert({
      tournament_id: tid,
      round: 1,
      slot,
      state: "finished",
      pairing: JSON.stringify({ slot, round: 1, bracket: "main", home: home.botId, away: away.botId }),
      winner_bot_id: winnerBot,
    })
    .returning("id");
  const result =
    winner === "technical"
      ? { winner: null, endReason: "technical_limit", score: { A: 0, B: 0 } }
      : {
          winner: winner === "home" ? "A" : winner === "away" ? "B" : "draw",
          score: { A: winner === "home" ? 1 : 0, B: winner === "away" ? 1 : 0 },
          endReason: "completed",
        };
  const [b] = await h
    .db("battles")
    .insert({
      tournament_id: tid,
      match_id: m.id,
      status: "finished",
      official: o.official ?? true,
      mode: o.mode ?? "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      game_index: 1,
      result: JSON.stringify(result),
    })
    .returning("id");
  const outcome = (team: "home" | "away") =>
    winner === "technical" ? null : winner === "draw" ? "draw" : winner === team ? "win" : "loss";
  await h.db("participants").insert([
    { battle_id: b.id, bot_id: home.botId, version: 1, team: "A", outcome: outcome("home") },
    { battle_id: b.id, bot_id: away.botId, version: 1, team: "B", outcome: outcome("away") },
  ]);
  await applyBattleRating(h.db, b.id); // Elo de la batalla oficial (no-op si técnica)
  return b.id as string;
}

const job = (tournamentId: string) =>
  ({ id: "j", kind: "update_standings", payload: { tournamentId }, attempts: 1 }) as unknown as JobRow;
async function update(tid: string) {
  await handleUpdateStandings(job(tid), { db: h.db } as never);
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

describe("STANDINGS_POLICY = official_played_not_reverted", () => {
  it("1 · torneo open sin batallas: nadie aparece a 0-0-0 por estar inscrito", async () => {
    const [a, b, c] = await createBots(h.db, 3, "p1");
    const t = await tournament({ season: "S1", state: "open", bots: [a, b, c] });
    await update(t);
    expect(await table("S1")).toEqual([]);
    // open aporta lo ya disputado, pero sólo de quien ha jugado: c (inscrito) sigue fuera.
    await played(t, a, b, "home");
    await update(t);
    const rows = await table("S1");
    expect(rows.map((r) => r.id).sort()).toEqual([a.botId, b.botId].sort());
    expect(vde(rows, c)).toBeNull();
  });

  it("2 · torneo running con una batalla terminada: el resultado aparece al instante", async () => {
    const [a, b] = await createBots(h.db, 2, "p2");
    const t = await tournament({ season: "S2", state: "running", bots: [a, b] });
    await played(t, a, b, "home");
    await update(t);
    const rows = await table("S2");
    expect(vde(rows, a)).toEqual([1, 0, 0]);
    expect(vde(rows, b)).toEqual([0, 1, 0]);
    expect(rows.find((r) => r.id === a.botId)!.rating).toBeGreaterThan(1000);
  });

  it("3 · torneo finished: el resultado permanece", async () => {
    const [a, b] = await createBots(h.db, 2, "p3");
    const t = await tournament({ season: "S3", state: "running", bots: [a, b] });
    await played(t, a, b, "away");
    await update(t);
    const before = await table("S3");
    await h.db("tournaments").where({ id: t }).update({ state: "finished" });
    await update(t);
    const rows = await table("S3");
    expect(rows).toEqual(before);
    expect(vde(rows, b)).toEqual([1, 0, 0]);
    expect(vde(rows, a)).toEqual([0, 1, 0]);
  });

  it("4 · torneo cancelled después de una batalla: el resultado permanece (draft, en cambio, no aporta)", async () => {
    const [a, b] = await createBots(h.db, 2, "p4");
    const t = await tournament({ season: "S4", state: "running", bots: [a, b] });
    await played(t, a, b, "draw");
    await update(t);
    const before = await table("S4");
    await h.db("tournaments").where({ id: t }).update({ state: "cancelled" });
    await update(t);
    const rows = await table("S4");
    expect(rows).toEqual(before);
    expect(vde(rows, a)).toEqual([0, 0, 1]);
    expect(vde(rows, b)).toEqual([0, 0, 1]);
    // draft no aporta nada (regla explícita de la política).
    await h.db("tournaments").where({ id: t }).update({ state: "draft" });
    await recomputeSeasonStandings(h.db, "S4", "deathmatch");
    expect(await table("S4")).toEqual([]);
  });

  it("5 · batalla revertida: fuera de V-D-E y standings, y Elo devuelto (mecanismo existente)", async () => {
    const [a, b, c] = await createBots(h.db, 3, "p5");
    const t = await tournament({ season: "S5", bots: [a, b, c] });
    const keep = await played(t, a, c, "home");
    const bad = await played(t, a, b, "home");
    await update(t);
    expect(vde(await table("S5"), a)).toEqual([2, 0, 0]);
    expect(await revertOfficialBattle(h.db, bad)).toBe("reverted");
    const rows = await table("S5");
    expect(vde(rows, a)).toEqual([1, 0, 0]);
    expect(vde(rows, b)).toBeNull(); // su único enfrentamiento se revirtió
    const ra = await h.db("ratings").where({ bot_id: a.botId, season_id: "S5", mode: "deathmatch" }).first();
    expect([ra.wins, ra.losses, ra.draws]).toEqual([1, 0, 0]);
    const rb = await h.db("ratings").where({ bot_id: b.botId, season_id: "S5", mode: "deathmatch" }).first();
    expect(rb.rating).toBeCloseTo(1000, 6); // Elo de vuelta al inicial
    expect(rows.find((r) => r.id === a.botId)!.rating).toBeCloseTo(ra.rating, 6);
    // Idempotente: revertir otra vez no cambia nada; y la que se conserva sigue contando.
    expect(await revertOfficialBattle(h.db, bad)).toBe("already_reverted");
    expect(await table("S5")).toEqual(rows);
    void keep;
  });

  it("6 · dos torneos del mismo modo y temporada contribuyen los dos (orden inverso e idempotencia)", async () => {
    const [a, b, d] = await createBots(h.db, 3, "p6");
    const t1 = await tournament({ season: "S6", bots: [a, b] });
    const t2 = await tournament({ season: "S6", bots: [a, d] });
    await played(t1, a, b, "home");
    await played(t2, d, a, "home");
    await update(t1);
    await update(t2);
    const fwd = await table("S6");
    expect(vde(fwd, a)).toEqual([1, 1, 0]);
    expect(vde(fwd, b)).toEqual([0, 1, 0]);
    expect(vde(fwd, d)).toEqual([1, 0, 0]);
    await update(t2);
    await update(t1);
    await update(t1);
    expect(await table("S6")).toEqual(fwd);
    await h.db("standings").where({ season_id: "S6" }).delete();
    await Promise.all([update(t1), update(t2), recomputeSeasonStandings(h.db, "S6", "deathmatch")]);
    expect(await table("S6")).toEqual(fwd);
  });

  it("7 · modos distintos no se mezclan", async () => {
    const [a, b] = await createBots(h.db, 2, "p7");
    const tdm = await tournament({ season: "S7", mode: "team_deathmatch", bots: [a, b] });
    const dm = await tournament({ season: "S7", mode: "deathmatch", bots: [a, b] });
    await played(tdm, a, b, "home", { mode: "team_deathmatch" });
    await played(dm, b, a, "home");
    await update(tdm);
    await update(dm);
    expect(vde(await table("S7", "team_deathmatch"), a)).toEqual([1, 0, 0]);
    expect(vde(await table("S7", "deathmatch"), a)).toEqual([0, 1, 0]);
  });

  it("8 · temporadas distintas no se mezclan", async () => {
    const [a, b] = await createBots(h.db, 2, "p8");
    const t1 = await tournament({ season: "S8a", bots: [a, b] });
    const t2 = await tournament({ season: "S8b", bots: [a, b] });
    await played(t1, a, b, "home");
    await played(t2, a, b, "draw");
    await update(t1);
    await update(t2);
    expect(vde(await table("S8a"), a)).toEqual([1, 0, 0]);
    expect(vde(await table("S8b"), a)).toEqual([0, 0, 1]);
  });

  it("9 · final técnico: sin Elo, sin V-D-E y sin standings", async () => {
    const [a, b] = await createBots(h.db, 2, "p9");
    const t = await tournament({ season: "S9", bots: [a, b] });
    const bid = await played(t, a, b, "technical");
    await update(t);
    expect(await table("S9")).toEqual([]);
    expect(await h.db("rating_events").where({ battle_id: bid })).toHaveLength(0);
    expect(await h.db("ratings").where({ season_id: "S9" })).toHaveLength(0);
  });

  it("9b · en una serie, el juego técnico no cuenta y el disputado sí", async () => {
    const [a, b] = await createBots(h.db, 2, "p9b");
    const t = await tournament({ season: "S9b", bots: [a, b] });
    const tech = await played(t, a, b, "technical");
    // Segundo juego (real) del MISMO enfrentamiento: los lados se alternan (home = equipo B
    // en los juegos pares, results.ts seriesOutcome) y gana away (b, equipo A).
    const m = await h.db("battles").where({ id: tech }).first("match_id");
    const [g2] = await h
      .db("battles")
      .insert({
        tournament_id: t,
        match_id: m.match_id,
        status: "finished",
        official: true,
        mode: "deathmatch",
        ruleset_id: DEFAULT_RULESET_ID,
        map_id: "mvp-arena-01",
        map_version: 1,
        game_index: 2,
        result: JSON.stringify({ winner: "A", score: { A: 1, B: 0 }, endReason: "completed" }),
      })
      .returning("id");
    await h.db("participants").insert([
      { battle_id: g2.id, bot_id: a.botId, version: 1, team: "B", outcome: "loss" },
      { battle_id: g2.id, bot_id: b.botId, version: 1, team: "A", outcome: "win" },
    ]);
    await applyBattleRating(h.db, g2.id);
    await update(t);
    const rows = await table("S9b");
    expect(vde(rows, b)).toEqual([1, 0, 0]);
    expect(vde(rows, a)).toEqual([0, 1, 0]);
    expect(await h.db("rating_events").where({ battle_id: tech })).toHaveLength(0);
  });

  it("bye (pasar ronda sin rival) no es un enfrentamiento disputado: no hace aparecer ni suma", async () => {
    const [a, b, c] = await createBots(h.db, 3, "pbye");
    const t = await tournament({ season: "Sbye", bots: [a, b, c] });
    await h.db("matches").insert({
      tournament_id: t,
      round: 1,
      slot: "BYE1",
      state: "finished",
      pairing: JSON.stringify({ slot: "BYE1", round: 1, bracket: "main", home: c.botId, away: null, bye: true }),
      winner_bot_id: c.botId,
    });
    await played(t, a, b, "home");
    await update(t);
    const rows = await table("Sbye");
    expect(vde(rows, c)).toBeNull();
    expect(vde(rows, a)).toEqual([1, 0, 0]);
  });

  it("práctica (no oficial) no cuenta aunque cuelgue de un torneo", async () => {
    const [a, b] = await createBots(h.db, 2, "p10");
    const t = await tournament({ season: "S10", bots: [a, b] });
    await played(t, a, b, "home", { official: false });
    await update(t);
    expect(await table("S10")).toEqual([]);
  });

  it("empate total entre torneos: lo decide el id del bot, no el orden de los enfrentamientos", async () => {
    // Dos torneos, un empate en cada uno: los cuatro a 1 punto, diferencia 0; seeds 1 y 2.
    const bots = await createBots(h.db, 4, "p11");
    const [p, q, r, s] = bots;
    const tx = await tournament({ season: "S11", bots: [p, q] });
    const ty = await tournament({ season: "S11", bots: [r, s] });
    await played(tx, p, q, "draw");
    await played(ty, r, s, "draw");
    // Orden esperado: seed 1 antes que seed 2 y, a igualdad, el id (determinista).
    await recomputeSeasonStandings(h.db, "S11", "deathmatch");
    const ids = (await table("S11")).map((x) => x.id);
    const seed1 = [p.botId, r.botId].sort();
    const seed2 = [q.botId, s.botId].sort();
    expect(ids).toEqual([...seed1, ...seed2]);
  });
});

// ---------------------------------------------------------------------------------------
// EQ2c · H7 del revisor (#229): cada test mata un mutante concreto de `seasonTable` y
// comprueba PUNTOS y ORDEN (no sólo presencia), directamente sobre la tabla calculada.
// ---------------------------------------------------------------------------------------

/** Torneo de cualquier formato; las inscripciones en el orden dado fijan el seed. */
async function tournamentF(o: { season: string; format?: string; state?: string; bots: TestBot[] }): Promise<string> {
  const [t] = await h
    .db("tournaments")
    .insert({
      name: `h7-${Math.random().toString(36).slice(2, 8)}`,
      format: o.format ?? "league",
      mode: "deathmatch",
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

/**
 * Enfrentamiento home–away de UN juego (juego 1: home = A) con marcador `hs`-`as` y el estado
 * de batalla indicado. Gana quien más puntúa; a igual marcador, empate. No aplica Elo.
 */
async function scored(
  tid: string,
  home: TestBot,
  away: TestBot,
  hs: number,
  as: number,
  o: { status?: string } = {},
): Promise<string> {
  const slot = `S${Math.random().toString(36).slice(2, 8)}`;
  const [m] = await h
    .db("matches")
    .insert({
      tournament_id: tid,
      round: 1,
      slot,
      state: "finished",
      pairing: JSON.stringify({ slot, round: 1, bracket: "main", home: home.botId, away: away.botId }),
    })
    .returning("id");
  const winner = hs > as ? "A" : hs < as ? "B" : "draw";
  const [b] = await h
    .db("battles")
    .insert({
      tournament_id: tid,
      match_id: m.id,
      status: o.status ?? "finished",
      official: true,
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      game_index: 1,
      result: JSON.stringify({ winner, score: { A: hs, B: as }, endReason: "completed" }),
    })
    .returning("id");
  const out = (mine: number, theirs: number) => (mine > theirs ? "win" : mine < theirs ? "loss" : "draw");
  await h.db("participants").insert([
    { battle_id: b.id, bot_id: home.botId, version: 1, team: "A", outcome: out(hs, as) },
    { battle_id: b.id, bot_id: away.botId, version: 1, team: "B", outcome: out(as, hs) },
  ]);
  return b.id as string;
}

/** Filas de seasonTable como [bot, puntos, V, D, E, diferencia], en su orden. */
async function pts(season: string, names: Map<string, string>) {
  return (await seasonTable(h.db, season, "deathmatch")).map((r) => [
    names.get(r.id),
    r.points,
    r.wins,
    r.losses,
    r.draws,
    r.scoreDiff,
  ]);
}
const named = (bots: Record<string, TestBot>) => new Map(Object.entries(bots).map(([n, b]) => [b.botId, n]));

describe("EQ2c · H7: mutantes de seasonTable (puntos y orden)", () => {
  it("H7.1 · sólo batallas TERMINADAS: una fallida con resultado y una programada no cuentan", async () => {
    const [a, b, c, d] = await createBots(h.db, 4, "h71");
    const t = await tournamentF({ season: "H71", bots: [a, b, c, d] });
    await scored(t, a, b, 3, 0, { status: "failed" }); // con resultado escrito, pero fallida
    await scored(t, c, d, 0, 0, { status: "scheduled" }); // pendiente: no es un empate
    await scored(t, b, a, 2, 1); // la única que cuenta
    expect(await pts("H71", named({ a, b, c, d }))).toEqual([
      ["b", 3, 1, 0, 0, 1],
      ["a", 0, 0, 1, 0, -1],
    ]);
  });

  it("H7.2 · enfrentamientos directos: a igualdad de puntos manda el directo sobre diferencia y seed", async () => {
    // b tiene mejor seed (inscrito antes) y mejor diferencia (+4 frente a +1), pero a le ganó.
    const [b, a, c, d] = await createBots(h.db, 4, "h72");
    const t = await tournamentF({ season: "H72", bots: [b, a, c, d] });
    await scored(t, a, b, 1, 0);
    await scored(t, b, d, 5, 0);
    await scored(t, a, c, 0, 0);
    await scored(t, b, c, 0, 0);
    expect(await pts("H72", named({ a, b, c, d }))).toEqual([
      ["a", 4, 1, 0, 1, 1],
      ["b", 4, 1, 1, 1, 4],
      ["c", 2, 0, 0, 2, 0],
      ["d", 0, 0, 1, 0, -5],
    ]);
  });

  it("H7.3 · diferencia de puntuación con su signo: a igualdad de puntos y sin directo, gana la mayor", async () => {
    // f tiene mejor seed; e, más diferencia (+3 frente a +1). h pierde por menos que g.
    const [f, e, g, hh] = await createBots(h.db, 4, "h73");
    const t = await tournamentF({ season: "H73", bots: [f, e, g, hh] });
    await scored(t, e, g, 3, 0);
    await scored(t, f, hh, 1, 0);
    expect(await pts("H73", named({ e, f, g, h: hh }))).toEqual([
      ["e", 3, 1, 0, 0, 3],
      ["f", 3, 1, 0, 0, 1],
      ["h", 0, 0, 1, 0, -1],
      ["g", 0, 0, 1, 0, -3],
    ]);
  });

  it("H7.4 · el empate vale 1 punto: dos empates superan a un empate y una derrota, y no a una victoria", async () => {
    const [w, x, y, z] = await createBots(h.db, 4, "h74");
    const t = await tournamentF({ season: "H74", bots: [z, y, x, w] }); // seeds al revés del orden esperado
    await scored(t, w, z, 1, 0); // w 3
    await scored(t, x, y, 0, 0); // x 1, y 1
    await scored(t, x, z, 0, 0); // x 2, z 1
    expect(await pts("H74", named({ w, x, y, z }))).toEqual([
      ["w", 3, 1, 0, 0, 1],
      ["x", 2, 0, 0, 2, 0],
      ["y", 1, 0, 0, 1, 0],
      ["z", 1, 0, 1, 1, -1],
    ]);
  });

  it("H7.5 · un torneo de EQUIPOS de la misma temporada y modo no entra en la tabla por bot", async () => {
    const [a, b, c] = await createBots(h.db, 3, "h75");
    const tt = await tournamentF({ season: "H75", format: "teams", bots: [a, b] });
    await scored(tt, a, b, 4, 0);
    await scored(tt, a, b, 3, 0);
    const tl = await tournamentF({ season: "H75", bots: [b, c] });
    await scored(tl, c, b, 1, 0);
    expect(await pts("H75", named({ a, b, c }))).toEqual([
      ["c", 3, 1, 0, 0, 1],
      ["b", 0, 0, 1, 0, -1],
    ]);
  });
});

// ---------------------------------------------------------------------------------------
// EQ2c · H2/H5: la reversión es una marca propia de la batalla (no depende del Elo) y
// distingue los casos en su valor de retorno; draft tampoco recibe Elo.
// ---------------------------------------------------------------------------------------
describe("EQ2c · reversión independiente del Elo", () => {
  it("revertOfficialBattle distingue revertida, ya revertida y nada que revertir", async () => {
    const [a, b] = await createBots(h.db, 2, "rv1");
    const t = await tournament({ season: "RV1", bots: [a, b] });
    const practice = await played(t, a, b, "home", { official: false });
    const technical = await played(t, a, b, "technical");
    expect(await revertOfficialBattle(h.db, "00000000-0000-0000-0000-000000000000")).toBe("nothing_to_revert");
    expect(await revertOfficialBattle(h.db, practice)).toBe("nothing_to_revert");
    expect(await revertOfficialBattle(h.db, technical)).toBe("nothing_to_revert");
    expect(await h.db("battles").whereIn("id", [practice, technical]).whereNotNull("reverted_at")).toHaveLength(0);
    const good = await played(t, a, b, "home");
    expect(await revertOfficialBattle(h.db, good)).toBe("reverted");
    expect(await revertOfficialBattle(h.db, good)).toBe("already_reverted");
    expect((await h.db("battles").where({ id: good }).first()).reverted_at).not.toBeNull();
  });

  it("revertida antes de puntuar: el job que llega después no aplica Elo y no cuenta", async () => {
    const [a, b] = await createBots(h.db, 2, "rv2");
    const t = await tournament({ season: "RV2", bots: [a, b] });
    const bid = await scored(t, a, b, 1, 0); // sin Elo todavía
    await recomputeSeasonStandings(h.db, "RV2", "deathmatch");
    expect(vde(await table("RV2"), a)).toEqual([1, 0, 0]);
    expect(await revertOfficialBattle(h.db, bid)).toBe("reverted");
    expect(await applyBattleRating(h.db, bid)).toBe(false);
    await handleUpdateStandings(
      { id: "j", kind: "update_standings", payload: { tournamentId: t, battleId: bid }, attempts: 1 } as never,
      { db: h.db } as never,
    );
    expect(await h.db("rating_events").where({ battle_id: bid })).toHaveLength(0);
    expect(await h.db("ratings").where({ season_id: "RV2" })).toHaveLength(0);
    expect(await table("RV2")).toEqual([]);
  });

  it("draft: ni clasificación ni Elo, aunque se procese el job de su batalla", async () => {
    const [a, b] = await createBots(h.db, 2, "rv3");
    const t = await tournament({ season: "RV3", state: "draft", bots: [a, b] });
    const bid = await played(t, a, b, "home"); // played() ya intenta aplicar el Elo
    expect(await applyBattleRating(h.db, bid)).toBe(false);
    expect(await h.db("rating_events").where({ battle_id: bid })).toHaveLength(0);
    expect(await h.db("ratings").where({ season_id: "RV3" })).toHaveLength(0);
    await recomputeSeasonStandings(h.db, "RV3", "deathmatch");
    expect(await table("RV3")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// EQ2c · H3: Elo simultáneos del mismo bot. No basta con que la suma cuadre (un incremento
// atómico la haría cuadrar aunque el delta se calculara con un rating viejo): cada evento
// tiene que partir del rating que dejó el anterior (cadena before/after continua).
// ---------------------------------------------------------------------------------------
describe("EQ2c · H3: Elo concurrente del mismo bot", () => {
  it("cadena del libro mayor continua y rating = inicial + Σ deltas", async () => {
    const broken: string[] = [];
    for (let round = 0; round < 6; round++) {
      const season = `EC-${round}`;
      const [a, b, c, d] = await createBots(h.db, 4, `ec${round}`);
      const t = await tournament({ season, bots: [a, b, c, d] });
      const ids = [await scored(t, a, b, 1, 0), await scored(t, c, a, 1, 0), await scored(t, a, d, 0, 0)];
      await Promise.all(ids.map((id) => applyBattleRating(h.db, id)));
      const ev = await h.db("rating_events").where({ bot_id: a.botId, season_id: season }).orderBy("id", "asc");
      if (ev.length !== 3) broken.push(`${season}: ${ev.length} eventos`);
      for (let i = 1; i < ev.length; i++) {
        if (Math.abs(Number(ev[i].rating_before) - Number(ev[i - 1].rating_after)) > 1e-9)
          broken.push(`${season}: evento ${i} parte de ${ev[i].rating_before}, no de ${ev[i - 1].rating_after}`);
      }
      const r = await h.db("ratings").where({ bot_id: a.botId, season_id: season }).first();
      const sum = ev.reduce((s: number, e: Record<string, unknown>) => s + Number(e.delta), 1000);
      if (Math.abs(Number(r.rating) - sum) > 1e-9) broken.push(`${season}: rating ${r.rating} ≠ libro ${sum}`);
      if (r.wins + r.losses + r.draws !== 3)
        broken.push(`${season}: V-D-E del rating ${r.wins}-${r.losses}-${r.draws}`);
    }
    expect(broken).toEqual([]);
  });

  it("la MISMA batalla: dos Elo simultáneos puntúan una vez, y Elo junto a su reversión no deja Elo vivo", async () => {
    const broken: string[] = [];
    for (let round = 0; round < 6; round++) {
      const season = `ES-${round}`;
      const [a, b] = await createBots(h.db, 2, `es${round}`);
      const t = await tournament({ season, bots: [a, b] });
      // Dos jobs de la misma batalla a la vez: uno puntúa, el otro es no-op (sin error).
      const twice = await scored(t, a, b, 1, 0);
      const r = await Promise.allSettled([applyBattleRating(h.db, twice), applyBattleRating(h.db, twice)]);
      const ok = r.filter((x) => x.status === "fulfilled").map((x) => (x as PromiseFulfilledResult<boolean>).value);
      if (ok.length !== 2 || ok.filter(Boolean).length !== 1) broken.push(`${season}: doble Elo ${JSON.stringify(r)}`);
      // Reversión de una batalla sin puntuar a la vez que su job: nunca queda Elo vivo.
      const rev = await scored(t, b, a, 1, 0);
      await Promise.all([revertOfficialBattle(h.db, rev), applyBattleRating(h.db, rev)]);
      const live = await h.db("rating_events").where({ battle_id: rev, reverted: false });
      if (live.length !== 0) broken.push(`${season}: ${live.length} eventos vivos de una batalla revertida`);
    }
    expect(broken).toEqual([]);
  });
});
