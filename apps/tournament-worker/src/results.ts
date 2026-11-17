/**
 * E9 · T9.2 — Procesado de resultados (flujo 19.1, tramo final): verificar el
 * resultado, cerrar la serie del match, avanzar brackets/rondas, detectar el
 * fin del torneo (campeón + clasificación) y encolar la actualización de
 * standings/ratings.
 *
 * Reglas de la serie (rounds_per_pairing juegos, desempates documentados en
 * formats.ts): 1) victorias en la serie; 2) puntuación agregada del motor;
 * 3) mejor seed (= orden de inscripción). Un empate de serie en formatos de
 * liga se registra como empate (draw) para ambos.
 */
import type { Knex } from "knex";
import { generateSwissRound, recommendedSwissRounds, type Pairing, type SwissStanding } from "./formats.js";
import { buildMaterializeContext, materializeBattles, type MaterializeContext } from "./scheduler.js";
import { enqueueJob, type JobRow } from "./queue.js";
import type { HandlerContext } from "./worker.js";

interface MatchRow {
  id: string;
  tournament_id: string;
  round: number;
  state: string;
  slot: string;
  final: boolean;
  pairing: Pairing | string;
  winner_bot_id: string | null;
  winner_team_id: string | null;
}

export function pairingOf(m: Pick<MatchRow, "pairing">): Pairing {
  return typeof m.pairing === "string" ? (JSON.parse(m.pairing) as Pairing) : m.pairing;
}

// ------------------------------------------------------------- serie del match

interface SeriesOutcome {
  winner: string | null; // botId o teamId (null = empate de serie)
  loser: string | null;
  draw: boolean;
}

/**
 * Resuelve la serie de un match cuyos juegos han terminado todos. El lado
 * (home/away) de cada juego se recupera del intercambio de lados de T9.4:
 * juego impar → home era el equipo A del motor; juego par → el B.
 */
async function resolveSeries(db: Knex, match: MatchRow, p: Pairing): Promise<SeriesOutcome> {
  const battles = await db("battles").where({ match_id: match.id }).orderBy("game_index", "asc");
  return seriesOutcome(battles, p);
}

/**
 * Serie de un enfrentamiento a partir de SUS juegos (puro: lo comparten el cierre del
 * match y la clasificación de temporada). Los juegos terminados por la salvaguarda
 * técnica (ADR-022) no cuentan. Victorias de juego; luego puntuación; si siguen iguales,
 * en eliminatorias decide el mejor seed (home) y en liga/RR/suizo es empate.
 *
 * EQ2c (#229) · `closed: false` = la serie SIGUE EN JUEGO (la clasificación de temporada
 * cuenta lo ya disputado de un torneo running): el desempate por seed es de una serie
 * CERRADA, así que una serie a medias igualada cuenta como empate, no como victoria del
 * seed. Por defecto `closed: true` (el cierre del match no cambia).
 */
export function seriesOutcome(
  battles: Record<string, any>[],
  p: Pairing,
  o: { closed?: boolean } = {},
): SeriesOutcome & { homeScore: number; awayScore: number } {
  let homeWins = 0;
  let awayWins = 0;
  let homeScore = 0;
  let awayScore = 0;
  for (const b of battles) {
    // B (ciclo de vida) · un juego `failed` (agotado por infraestructura) no tiene resultado:
    // no cuenta ni como victoria ni como puntuación; la serie se resuelve con los demás.
    if (b.status === "failed") continue;
    const result = typeof b.result === "string" ? JSON.parse(b.result) : (b.result ?? {});
    if (isTechnicalLimit(result)) continue; // ADR-022 · sin resultado deportivo
    const homeTeam = b.game_index % 2 === 1 ? "A" : "B";
    const awayTeam = b.game_index % 2 === 1 ? "B" : "A";
    if (result.winner === homeTeam) homeWins++;
    else if (result.winner === awayTeam) awayWins++;
    homeScore += Number(result.score?.[homeTeam] ?? 0);
    awayScore += Number(result.score?.[awayTeam] ?? 0);
  }
  const scores = { homeScore, awayScore };
  if (homeWins !== awayWins) {
    const homeWon = homeWins > awayWins;
    return { winner: homeWon ? p.home : p.away, loser: homeWon ? p.away : p.home, draw: false, ...scores };
  }
  if (homeScore !== awayScore) {
    const homeWon = homeScore > awayScore;
    return { winner: homeWon ? p.home : p.away, loser: homeWon ? p.away : p.home, draw: false, ...scores };
  }
  // En eliminatorias no puede haber empate de serie: decide el mejor seed
  // (orden de inscripción; documentado). En liga/RR/suizo, empate real.
  if (p.bracket !== "main" && (o.closed ?? true)) return { winner: p.home, loser: p.away, draw: false, ...scores };
  return { winner: null, loser: null, draw: true, ...scores };
}

// -------------------------------------------------- avance de brackets (T9.2)

/**
 * Resuelve los matches que dependían del slot recién terminado (homeSource/
 * awaySource) y materializa sus batallas cuando ambos lados quedan conocidos.
 * Exportada porque los byes de la generación inicial también desbloquean.
 */
export async function resolveDependents(mctx: MaterializeContext, finishedSlot: string): Promise<void> {
  const db = mctx.db;
  const finished = (await db("matches").where({ tournament_id: mctx.tournament.id, slot: finishedSlot }).first()) as
    MatchRow | undefined;
  if (!finished || !isClosedMatch(finished.state)) return;
  const fp = pairingOf(finished);
  const isTeams = mctx.tournament.format === "teams";
  const winner = isTeams ? finished.winner_team_id : finished.winner_bot_id;
  // El perdedor de la serie es el otro lado (para dobles eliminaciones).
  const loser = fp.home === winner ? fp.away : fp.home;

  const candidates = (await db("matches").where({
    tournament_id: mctx.tournament.id,
    state: "scheduled",
  })) as MatchRow[];
  for (const m of candidates) {
    const p = pairingOf(m);
    let changed = false;
    for (const side of ["home", "away"] as const) {
      const srcKey = side === "home" ? "homeSource" : "awaySource";
      const src = p[srcKey];
      if (p[side] === null && src && src.slot === finishedSlot) {
        // El valor puede ser null (el "perdedor" de un bye no existe): la
        // fuente queda CONSUMIDA igualmente y el lado se resuelve a null.
        p[side] = src.take === "winner" ? winner : loser;
        delete p[srcKey];
        changed = true;
      }
    }
    if (!changed) continue;
    await db("matches")
      .where({ id: m.id })
      .update({ pairing: JSON.stringify(p) });

    const homePending = p.home === null && p.homeSource !== undefined;
    const awayPending = p.away === null && p.awaySource !== undefined;
    if (homePending || awayPending) continue; // aún falta un resultado

    const finishWithout = async (matchWinner: string | null) => {
      await db("matches")
        .where({ id: m.id })
        .update({
          state: "finished",
          winner_bot_id: !isTeams ? matchWinner : null,
          winner_team_id: isTeams ? matchWinner : null,
        });
      await resolveDependents(mctx, m.slot);
    };

    if (p.home && p.away) {
      // Bracket reset (doble eliminación): si el ganador del slot condicional
      // (final del bracket W) también ganó la GF, el rival ya tiene dos
      // derrotas: GF2 es una formalidad y se resuelve sin jugarse.
      if (p.conditionalOn) {
        const cond = (await db("matches")
          .where({ tournament_id: mctx.tournament.id, slot: p.conditionalOn })
          .first()) as MatchRow | undefined;
        const condWinner = cond ? (isTeams ? cond.winner_team_id : cond.winner_bot_id) : null;
        if (condWinner && condWinner === p.home) {
          await finishWithout(condWinner);
          continue;
        }
      }
      const existing = await db("battles").where({ match_id: m.id }).first();
      if (!existing) await materializeBattles(mctx, m.id, p);
    } else if (p.home || p.away) {
      // Solo un lado existe (byes en cascada): pasa sin jugar.
      await finishWithout(p.home ?? p.away);
    } else {
      await finishWithout(null);
    }
  }
}

// ------------------------------------------------------- suizo: ronda siguiente

/** Puntos de liga: victoria 3, empate 1 (documentado en formats.ts). Bye = victoria. */
async function swissStandings(
  db: Knex,
  tournamentId: string,
): Promise<{ standings: SwissStanding[]; played: Set<string>; rounds: number }> {
  const matches = (await db("matches").where({ tournament_id: tournamentId })) as MatchRow[];
  const points = new Map<string, number>();
  const hadBye = new Set<string>();
  const played = new Set<string>();
  const entries = await db("entries").where({ tournament_id: tournamentId }).orderBy("created_at", "asc");
  const seedByBot = new Map<string, number>(
    entries.map((e: Record<string, unknown>, i: number) => [e.bot_id as string, i + 1]),
  );
  for (const e of entries) points.set(e.bot_id as string, 0);
  let rounds = 0;
  for (const m of matches) {
    const p = pairingOf(m);
    rounds = Math.max(rounds, m.round);
    if (p.bye && p.home) {
      hadBye.add(p.home);
      points.set(p.home, (points.get(p.home) ?? 0) + 3);
      continue;
    }
    if (p.home && p.away) played.add(p.home < p.away ? `${p.home}|${p.away}` : `${p.away}|${p.home}`);
    if (m.state !== "finished") continue;
    if (m.winner_bot_id) points.set(m.winner_bot_id, (points.get(m.winner_bot_id) ?? 0) + 3);
    else if (p.home && p.away) {
      points.set(p.home, (points.get(p.home) ?? 0) + 1);
      points.set(p.away, (points.get(p.away) ?? 0) + 1);
    }
  }
  const standings: SwissStanding[] = [...points.entries()].map(([id, pts]) => ({
    id,
    points: pts,
    seed: seedByBot.get(id) ?? 999,
    hadBye: hadBye.has(id),
  }));
  return { standings, played, rounds };
}

async function maybeScheduleNextSwissRound(mctx: MaterializeContext): Promise<boolean> {
  const db = mctx.db;
  const t = mctx.tournament;
  const unfinished = await db("matches")
    .where({ tournament_id: t.id })
    .whereNotIn("state", [...CLOSED_MATCH_STATES])
    .first();
  if (unfinished) return false; // la ronda actual no ha terminado
  const { standings, played, rounds } = await swissStandings(db, t.id);
  const total = recommendedSwissRounds(standings.length);
  if (rounds >= total) return false; // torneo suizo completo
  const pairings = generateSwissRound(standings, played, rounds + 1);
  for (const p of pairings) {
    const [m] = await db("matches")
      .insert({
        tournament_id: t.id,
        round: p.round,
        state: "scheduled",
        slot: p.slot,
        final: false,
        pairing: JSON.stringify(p),
      })
      .returning("id");
    if (p.bye) {
      await db("matches").where({ id: m.id }).update({ state: "finished", winner_bot_id: p.home });
    } else {
      await materializeBattles(mctx, m.id as string, p);
    }
  }
  return true;
}

// ------------------------------------------------------------- fin del torneo

/**
 * Campeón: el ganador del match final (eliminatorias) o el líder de la tabla
 * (liga/RR/suizo/equipos) con los desempates documentados en formats.ts
 * (puntos → enfrentamiento directo → diferencia de puntuación → seed).
 */
async function computeChampion(db: Knex, tournamentId: string, isTeams: boolean): Promise<string | null> {
  const finalMatch = (await db("matches").where({ tournament_id: tournamentId, final: true }).first()) as
    MatchRow | undefined;
  if (finalMatch?.state === "finished") return isTeams ? finalMatch.winner_team_id : finalMatch.winner_bot_id;
  // B · una final SIN RESULTADO (todas sus batallas `failed`) no corona a nadie: el torneo
  // termina sin campeón antes que coronar por una partida que no se jugó.
  if (finalMatch?.state === "failed") return null;

  const table = await leagueTable(db, tournamentId, isTeams);
  // B · si ningún enfrentamiento llegó a puntuar (todo `failed`), no hay campeón.
  if (!table[0] || table[0].wins + table[0].draws + table[0].losses === 0) return null;
  return table[0].id;
}

export interface TableRow {
  id: string;
  points: number;
  wins: number;
  losses: number;
  draws: number;
  scoreDiff: number;
  seed: number;
}

/** ADR-022 · ¿El resultado es la salvaguarda técnica (sin resultado deportivo)? */
export function isTechnicalLimit(result: unknown): boolean {
  const r = typeof result === "string" ? safeJson(result) : result;
  return Boolean(r && typeof r === "object" && (r as { endReason?: unknown }).endReason === "technical_limit");
}
function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Tabla de liga/RR/suizo/equipos con los desempates documentados. */
export async function leagueTable(db: Knex, tournamentId: string, isTeams: boolean): Promise<TableRow[]> {
  const { rows, headToHead } = await leagueTableDetailed(db, tournamentId, isTeams);
  return sortTable(rows.values(), headToHead);
}

/**
 * Orden de la tabla: puntos, enfrentamientos directos, diferencia de puntuación, seed.
 *
 * DEUDA (H6 del revisor de #229, no corregida a propósito): el criterio de directos es POR
 * PAREJAS, así que con un ciclo de victorias entre tres o más empatados a puntos (a>b, b>c,
 * c>a) el comparador no es transitivo y el orden resultante depende del algoritmo de
 * ordenación. El arreglo (mini-tabla de los empatados) cambia una regla de orden visible y
 * queda pendiente de decisión del operador.
 */
export function sortTable(rows: Iterable<TableRow>, headToHead: Map<string, number>): TableRow[] {
  return [...rows].sort(
    (a, b) =>
      b.points - a.points ||
      (headToHead.get(`${b.id}|${a.id}`) ?? 0) - (headToHead.get(`${a.id}|${b.id}`) ?? 0) ||
      b.scoreDiff - a.scoreDiff ||
      a.seed - b.seed ||
      // Sólo decide al agregar torneos (en uno, los seeds son únicos): orden total.
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * Filas SIN ordenar de la tabla de un torneo y sus enfrentamientos directos (para poder
 * AGREGAR varios torneos de una temporada: standings.ts).
 */
export async function leagueTableDetailed(
  db: Knex,
  tournamentId: string,
  isTeams: boolean,
): Promise<{ rows: Map<string, TableRow>; headToHead: Map<string, number> }> {
  const matches = (await db("matches").where({ tournament_id: tournamentId })) as MatchRow[];
  const rows = new Map<string, TableRow>();
  const entries = await db("entries")
    .join("bots", "bots.id", "entries.bot_id")
    .where({ tournament_id: tournamentId })
    .orderBy("entries.created_at", "asc")
    .select("entries.bot_id", "bots.team_id");
  const ids = isTeams
    ? [...new Set(entries.map((e: Record<string, unknown>) => e.team_id as string))]
    : entries.map((e: Record<string, unknown>) => e.bot_id as string);
  ids.forEach((id: string, i: number) =>
    rows.set(id, { id, points: 0, wins: 0, losses: 0, draws: 0, scoreDiff: 0, seed: i + 1 }),
  );

  const headToHead = new Map<string, number>(); // "a|b" → victorias de a sobre b
  for (const m of matches) {
    if (m.state !== "finished") continue;
    const p = pairingOf(m);
    const winner = isTeams ? m.winner_team_id : m.winner_bot_id;
    if (p.bye && p.home) {
      const r = rows.get(p.home);
      if (r) {
        r.points += 3;
        r.wins++;
      }
      continue;
    }
    if (!p.home || !p.away) continue;
    const home = rows.get(p.home);
    const away = rows.get(p.away);
    if (!home || !away) continue;
    // B · los juegos `failed` no cuentan: la serie se resuelve sólo con los que se jugaron.
    const battles = (await db("battles").where({ match_id: m.id })).filter(
      (b: Record<string, unknown>) => b.status !== "failed",
    );
    // ADR-022 · un enfrentamiento cuyas batallas JUGADAS terminaron TODAS por la salvaguarda
    // técnica no tiene resultado deportivo: no puntúa ni cuenta como empate en V-D-E.
    if (battles.length > 0 && battles.every((b: Record<string, unknown>) => isTechnicalLimit(b.result))) continue;
    if (winner === p.home) {
      home.points += 3;
      home.wins++;
      away.losses++;
      headToHead.set(`${p.home}|${p.away}`, (headToHead.get(`${p.home}|${p.away}`) ?? 0) + 1);
    } else if (winner === p.away) {
      away.points += 3;
      away.wins++;
      home.losses++;
      headToHead.set(`${p.away}|${p.home}`, (headToHead.get(`${p.away}|${p.home}`) ?? 0) + 1);
    } else {
      home.points += 1;
      away.points += 1;
      home.draws++;
      away.draws++;
    }
    // diferencia de puntuación agregada de la serie
    for (const b of battles) {
      const result = typeof b.result === "string" ? JSON.parse(b.result) : (b.result ?? {});
      const homeTeam = b.game_index % 2 === 1 ? "A" : "B";
      const awayTeam = b.game_index % 2 === 1 ? "B" : "A";
      home.scoreDiff += Number(result.score?.[homeTeam] ?? 0) - Number(result.score?.[awayTeam] ?? 0);
      away.scoreDiff += Number(result.score?.[awayTeam] ?? 0) - Number(result.score?.[homeTeam] ?? 0);
    }
  }
  return { rows, headToHead };
}

// --------------------------------------------------------------- handler

/** Estados de match TERMINALES: `finished` (con resultado) y `failed` (sin resultado, B). */
export const CLOSED_MATCH_STATES = ["finished", "failed"] as const;
function isClosedMatch(state: string): boolean {
  return (CLOSED_MATCH_STATES as readonly string[]).includes(state);
}
/** Estados de batalla TERMINALES (no volverán a cambiar sin intervención). */
const CLOSED_BATTLE_STATES = ["finished", "failed"];

/**
 * POLÍTICA DE BATALLA `failed` DEFINITIVA (release 0.5.0, B).
 *
 * Una batalla `failed` es TERMINAL (la dejó así `markBattleForReview` tras agotar los
 * reintentos de infraestructura). El match se cierra en cuanto TODOS sus juegos son terminales:
 *  - con al menos un juego `finished`: la serie se resuelve con los juegos jugados (los
 *    `failed` no cuentan), igual que la salvaguarda técnica;
 *  - con TODOS los juegos `failed`: el match queda `failed` = «sin resultado». No puntúa, no
 *    mueve el Elo (sólo se calcula con batallas `finished`), no cuenta en V-D-E.
 *      · liga / RR / suizo / equipos: sin ganador, sin puntos para nadie;
 *      · eliminatorias: avanza el mejor seed (el lado `home`), la misma regla que ya
 *        desempata una serie igualada; queda anotado en `winner_*`. Si es la FINAL, el torneo
 *        termina sin campeón.
 * El torneo llega siempre a un estado terminal (`finished`): nunca queda `running` por ello.
 * Sin migración: `matches.state` ya admite `failed` desde la 001.
 */
async function settleMatch(mctx: MaterializeContext, match: MatchRow): Promise<boolean> {
  if (isClosedMatch(match.state)) return false;
  const db = mctx.db;
  const isTeams = mctx.tournament.format === "teams";
  const games = (await db("battles").where({ match_id: match.id })) as Record<string, any>[];
  if (games.length === 0) return false; // aún sin materializar: no hay nada que cerrar
  if (games.some((g) => !CLOSED_BATTLE_STATES.includes(g.status))) return false; // la serie sigue en juego
  const p = pairingOf(match);
  if (games.every((g) => g.status === "failed")) {
    const advances = p.bracket !== "main" ? p.home : null; // eliminatoria: mejor seed
    await db("matches")
      .where({ id: match.id })
      .update({
        state: "failed",
        winner_bot_id: !isTeams ? advances : null,
        winner_team_id: isTeams ? advances : null,
      });
  } else {
    const series = await resolveSeries(db, match, p);
    await db("matches")
      .where({ id: match.id })
      .update({
        state: "finished",
        winner_bot_id: !isTeams && series.winner ? series.winner : null,
        winner_team_id: isTeams && series.winner ? series.winner : null,
      });
  }
  await resolveDependents(mctx, match.slot);
  return true;
}

/** ¿Torneo completo? (todo match y toda batalla en estado terminal) → `finished`. */
async function finishTournamentIfDone(mctx: MaterializeContext): Promise<void> {
  const db = mctx.db;
  const tournamentId = mctx.tournament.id;
  const isTeams = mctx.tournament.format === "teams";
  const openMatch = await db("matches")
    .where({ tournament_id: tournamentId })
    .whereNotIn("state", [...CLOSED_MATCH_STATES])
    .first();
  const openBattle = await db("battles")
    .where({ tournament_id: tournamentId })
    .whereNotIn("status", CLOSED_BATTLE_STATES)
    .first();
  if (openMatch || openBattle) return;
  const champion = await computeChampion(db, tournamentId, isTeams);
  // Idempotente y sólo desde `running`: un torneo cancelado no resucita.
  await db("tournaments")
    .where({ id: tournamentId, state: "running" })
    .update({ state: "finished", champion_bot_id: isTeams ? null : champion });
}

/**
 * Punto de inyección SÓLO para pruebas (interleaving forzado): se invoca dentro de la
 * transacción, tras cerrar los matches y antes de comprobar el fin del torneo. En producción
 * no hay hook.
 */
export const settleHooks: { beforeFinishCheck?: (tournamentId: string) => Promise<void> } = {};

/** Cerrojo por torneo: serializa «último resultado» y «otra batalla que falla». */
async function lockTournament(trx: Knex, tournamentId: string): Promise<void> {
  await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [`tournament-settle:${tournamentId}`]);
}

/**
 * Handler de `process_result` (uno por batalla terminada). Idempotente: si el
 * match ya está cerrado, solo re-verifica el estado del torneo.
 */
export async function handleProcessResult(job: JobRow, ctx: HandlerContext): Promise<void> {
  const battleId = String(job.payload.battleId ?? "");
  await settleBattle(ctx.db, battleId, { standings: true });
}

/**
 * Cierra el match de la batalla (si todos sus juegos son terminales) y comprueba el fin del
 * torneo. Lo comparten `process_result` (batalla `finished`) y `settleFailedBattle` (batalla
 * `failed`). Todo dentro de UNA transacción con cerrojo por torneo.
 */
async function settleBattle(db: Knex, battleId: string, o: { standings: boolean }): Promise<void> {
  const battle = await db("battles").where({ id: battleId }).first();
  if (!battle) throw new Error(`process_result: batalla ${battleId} inexistente`);
  if (!battle.match_id || !battle.tournament_id) return; // batalla de práctica: nada que avanzar

  await db.transaction(async (trx) => {
    await lockTournament(trx, battle.tournament_id);
    const mctx = await buildMaterializeContext(trx, battle.tournament_id);
    const match = (await trx("matches").where({ id: battle.match_id }).first()) as MatchRow;
    await settleMatch(mctx, match);

    if (mctx.tournament.format === "swiss") await maybeScheduleNextSwissRound(mctx);

    // 19.1: actualización de clasificación tras cada resultado verificado.
    if (o.standings) {
      await enqueueJob(
        trx,
        "update_standings",
        { tournamentId: battle.tournament_id, battleId },
        { dedupeKey: `update_standings:${battleId}` },
      );
    }
    await settleHooks.beforeFinishCheck?.(battle.tournament_id);
    await finishTournamentIfDone(mctx);
  });
}

/**
 * Una batalla ha quedado `failed` de forma DEFINITIVA (tras `markBattleForReview`): avanza el
 * match y el torneo. Idempotente; no encola Elo ni standings (no hay resultado).
 */
export async function settleFailedBattle(db: Knex, battleId: string): Promise<void> {
  const battle = await db("battles").where({ id: battleId }).first();
  if (!battle || battle.status !== "failed") return; // sólo una batalla terminada en `failed`
  await settleBattle(db, battleId, { standings: false });
}

/**
 * RESCATE idempotente de torneos atascados: `running` SIN batallas vivas (`scheduled` o
 * `running`). Cierra los matches cuyos juegos ya son todos terminales, avanza brackets/suizo y
 * termina el torneo si procede. Cada torneo se trata en su transacción y con su cerrojo;
 * ejecutarlo dos veces no cambia nada la segunda. Devuelve los ids de torneos modificados.
 */
export async function rescueStuckTournaments(db: Knex): Promise<string[]> {
  const stuck = (await db("tournaments")
    .where({ state: "running" })
    .whereNotExists(function () {
      this.select(db.raw("1"))
        .from("battles")
        .whereRaw("battles.tournament_id = tournaments.id")
        .whereIn("battles.status", ["scheduled", "running"]);
    })
    .select("id")) as { id: string }[];
  const touched: string[] = [];
  for (const { id } of stuck) {
    await db.transaction(async (trx) => {
      await lockTournament(trx, id);
      const t = await trx("tournaments").where({ id }).first();
      if (!t || t.state !== "running") return; // otro trabajo ya lo resolvió
      const mctx = await buildMaterializeContext(trx, id);
      let changed = false;
      // Cada cierre puede materializar batallas nuevas (brackets/suizo): se itera hasta fijo.
      for (let i = 0; i < 1000; i++) {
        const open = (await trx("matches")
          .where({ tournament_id: id })
          .whereNotIn("state", [...CLOSED_MATCH_STATES])
          .orderBy("round", "asc")) as MatchRow[];
        let progressed = false;
        for (const m of open) {
          if (await settleMatch(mctx, m)) {
            // Elo/standings coherentes: las batallas `finished` de un match cerrado aquí pueden
            // tener su `process_result` aparcado (needs_review) y no haber encolado nunca
            // `update_standings`. Idempotente por dedupe_key (y applyBattleRating por battle_id).
            const done = await trx("battles").where({ match_id: m.id, status: "finished" }).select("id");
            for (const b of done) {
              await enqueueJob(
                trx,
                "update_standings",
                { tournamentId: id, battleId: b.id },
                { dedupeKey: `update_standings:${b.id}` },
              );
            }
            progressed = true;
            changed = true;
            break; // el bracket pudo cambiar: se relee
          }
        }
        if (!progressed) break;
      }
      if (mctx.tournament.format === "swiss") {
        if (await maybeScheduleNextSwissRound(mctx)) changed = true;
      }
      await finishTournamentIfDone(mctx);
      const after = await trx("tournaments").where({ id }).first();
      if (changed || after?.state !== "running") touched.push(id);
    });
  }
  return touched;
}
