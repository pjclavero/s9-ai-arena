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

function pairingOf(m: MatchRow): Pairing {
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
  let homeWins = 0;
  let awayWins = 0;
  let homeScore = 0;
  let awayScore = 0;
  for (const b of battles) {
    const result = typeof b.result === "string" ? JSON.parse(b.result) : (b.result ?? {});
    const homeTeam = b.game_index % 2 === 1 ? "A" : "B";
    const awayTeam = b.game_index % 2 === 1 ? "B" : "A";
    if (result.winner === homeTeam) homeWins++;
    else if (result.winner === awayTeam) awayWins++;
    homeScore += Number(result.score?.[homeTeam] ?? 0);
    awayScore += Number(result.score?.[awayTeam] ?? 0);
  }
  if (homeWins !== awayWins) {
    const homeWon = homeWins > awayWins;
    return { winner: homeWon ? p.home : p.away, loser: homeWon ? p.away : p.home, draw: false };
  }
  if (homeScore !== awayScore) {
    const homeWon = homeScore > awayScore;
    return { winner: homeWon ? p.home : p.away, loser: homeWon ? p.away : p.home, draw: false };
  }
  // En eliminatorias no puede haber empate de serie: decide el mejor seed
  // (orden de inscripción; documentado). En liga/RR/suizo, empate real.
  if (p.bracket !== "main") return { winner: p.home, loser: p.away, draw: false };
  return { winner: null, loser: null, draw: true };
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
  if (!finished || finished.state !== "finished") return;
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
  const unfinished = await db("matches").where({ tournament_id: t.id }).whereNot({ state: "finished" }).first();
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

  const table = await leagueTable(db, tournamentId, isTeams);
  return table[0]?.id ?? null;
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

/** Tabla de liga/RR/suizo/equipos con los desempates documentados. */
export async function leagueTable(db: Knex, tournamentId: string, isTeams: boolean): Promise<TableRow[]> {
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
    const battles = await db("battles").where({ match_id: m.id });
    for (const b of battles) {
      const result = typeof b.result === "string" ? JSON.parse(b.result) : (b.result ?? {});
      const homeTeam = b.game_index % 2 === 1 ? "A" : "B";
      const awayTeam = b.game_index % 2 === 1 ? "B" : "A";
      home.scoreDiff += Number(result.score?.[homeTeam] ?? 0) - Number(result.score?.[awayTeam] ?? 0);
      away.scoreDiff += Number(result.score?.[awayTeam] ?? 0) - Number(result.score?.[homeTeam] ?? 0);
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      b.points - a.points ||
      (headToHead.get(`${b.id}|${a.id}`) ?? 0) - (headToHead.get(`${a.id}|${b.id}`) ?? 0) ||
      b.scoreDiff - a.scoreDiff ||
      a.seed - b.seed,
  );
}

// --------------------------------------------------------------- handler

/**
 * Handler de `process_result` (uno por batalla terminada). Idempotente: si el
 * match ya está cerrado, solo re-verifica el estado del torneo.
 */
export async function handleProcessResult(job: JobRow, ctx: HandlerContext): Promise<void> {
  const db = ctx.db;
  const battleId = String(job.payload.battleId ?? "");
  const battle = await db("battles").where({ id: battleId }).first();
  if (!battle) throw new Error(`process_result: batalla ${battleId} inexistente`);
  if (!battle.match_id || !battle.tournament_id) return; // batalla de práctica: nada que avanzar

  const mctx = await buildMaterializeContext(db, battle.tournament_id);
  const isTeams = mctx.tournament.format === "teams";
  const match = (await db("matches").where({ id: battle.match_id }).first()) as MatchRow;
  const p = pairingOf(match);

  if (match.state !== "finished") {
    const pendingGames = await db("battles").where({ match_id: match.id }).whereNotIn("status", ["finished"]).first();
    if (pendingGames) return; // la serie sigue en juego
    const series = await resolveSeries(db, match, p);
    await db("matches")
      .where({ id: match.id })
      .update({
        state: "finished",
        winner_bot_id: !isTeams && series.winner ? series.winner : null,
        winner_team_id: isTeams && series.winner ? series.winner : null,
      });
    await resolveDependents(mctx, match.slot);
  }

  if (mctx.tournament.format === "swiss") await maybeScheduleNextSwissRound(mctx);

  // 19.1: actualización de clasificación tras cada resultado verificado.
  await enqueueJob(
    db,
    "update_standings",
    { tournamentId: battle.tournament_id, battleId },
    { dedupeKey: `update_standings:${battleId}` },
  );

  // ¿Torneo completo? (ningún match sin terminar y ninguna batalla pendiente)
  const openMatch = await db("matches")
    .where({ tournament_id: battle.tournament_id })
    .whereNot({ state: "finished" })
    .first();
  const openBattle = await db("battles")
    .where({ tournament_id: battle.tournament_id })
    .whereNotIn("status", ["finished"])
    .first();
  if (!openMatch && !openBattle) {
    const champion = await computeChampion(db, battle.tournament_id, isTeams);
    await db("tournaments")
      .where({ id: battle.tournament_id })
      .update({ state: "finished", champion_bot_id: isTeams ? null : champion });
  }
}
