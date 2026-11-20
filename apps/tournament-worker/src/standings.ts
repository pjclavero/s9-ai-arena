/**
 * E9 · T9.2 — Handler de `update_standings`: materializa la clasificación de
 * la temporada llamando al punto de entrada REAL de E7 (updateStandings, caché
 * ≤60 s con invalidación inmediata; no se duplica).
 *
 * EQ2 · La clasificación de (temporada, modo) es el AGREGADO de todos los torneos de esa
 * temporada y modo (antes, sólo el del último torneo actualizado: P2 del EQ6, #220), con
 * la POLÍTICA del operador `STANDINGS_POLICY = official_played_not_reverted`: sólo cuentan
 * batallas oficiales, terminadas, no técnicas y no revertidas (ver `seasonTable`). Draft
 * no aporta; open/running/finished/cancelled aportan lo ya disputado; inscribirse no hace
 * aparecer a nadie a 0-0-0.
 *
 * Determinista e idempotente: no depende del orden de procesamiento. Concurrencia: dos
 * recálculos de la misma (temporada, modo) se serializan con un cerrojo consultivo de
 * transacción, y cada uno lee lo ya confirmado: el último en entrar ve todos los torneos.
 *
 * El rating es el Elo del libro mayor rating_events (T9.3), ya por temporada y modo;
 * mientras un bot no tenga eventos, su rating es el inicial (1000).
 */
import type { Knex } from "knex";
import { invalidateStandingsCache, updateStandings } from "../../api/src/services/standings.js";
import { isTechnicalLimit, pairingOf, seriesOutcome, sortTable, type TableRow } from "./results.js";
import { applyBattleRating, revertBattleRatingInTrx, seasonRatings, INITIAL_RATING } from "./ratings.js";
import type { JobRow } from "./queue.js";
import type { HandlerContext } from "./worker.js";

export async function handleUpdateStandings(job: JobRow, ctx: HandlerContext): Promise<void> {
  const db = ctx.db;
  const tournamentId = String(job.payload.tournamentId ?? "");
  const battleId = String(job.payload.battleId ?? "");
  const t = await db("tournaments").where({ id: tournamentId }).first();
  if (!t) throw new Error(`update_standings: torneo ${tournamentId} inexistente`);

  // T9.3: rating Elo de la batalla OFICIAL (idempotente por battle_id).
  if (battleId) await applyBattleRating(db, battleId);

  // Equipos: la tabla standings de E7 es por bot; la clasificación por equipos
  // vive en matches/leagueTable (sin cambios).
  if (t.format === "teams") return;
  await recomputeSeasonStandings(db, t.season_id as string, t.mode as string);
}

/**
 * Política de clasificación del operador (2026-11-02). La clasificación y el Elo dependen
 * de resultados OFICIALES realmente DISPUTADOS, no del estado administrativo del torneo.
 */
export const STANDINGS_POLICY = "official_played_not_reverted" as const;

/**
 * ¿Batalla REVERTIDA? La autoridad es la marca propia de la batalla (`battles.reverted_at`,
 * migración 018, puesta por `revertOfficialBattle`), que existe aunque la batalla aún no
 * tuviera Elo. Esta función cubre además la reversión SÓLO de Elo (`revertBattleRating`,
 * ratings.ts, sin marca): tiene eventos de rating y TODOS están revertidos. Así una batalla
 * con su Elo devuelto nunca sigue contando en V-D-E.
 */
async function revertedBattleIds(db: Knex, battleIds: string[]): Promise<Set<string>> {
  if (battleIds.length === 0) return new Set();
  const rows = (await db("rating_events")
    .whereIn("battle_id", battleIds)
    .groupBy("battle_id")
    .havingRaw("bool_and(reverted)")
    .select("battle_id")) as { battle_id: string }[];
  return new Set(rows.map((r) => r.battle_id));
}

/**
 * Tabla de (temporada, modo) según `STANDINGS_POLICY`, sin escribir. SÓLO cuentan batallas:
 *  - OFICIALES, TERMINADAS, del modo y de un torneo NO de equipos de esa temporada;
 *  - de torneos que no estén en `draft` (open/running/finished/cancelled sí: cancelar NO
 *    borra lo disputado);
 *  - que no terminaron por la salvaguarda técnica (`technical_limit`, ADR-022);
 *  - que no estén REVERTIDAS (`battles.reverted_at`; ver `revertedBattleIds`).
 * Unidad de V-D-E: el ENFRENTAMIENTO, resuelto con SUS juegos que cuentan
 * (`seriesOutcome`, el mismo criterio que el cierre del match): 3/1/0. Un bot sólo aparece
 * si tiene al menos un enfrentamiento que cuente: inscribirse no suma, y pasar ronda sin
 * rival (bye) no es un enfrentamiento disputado. Orden: puntos, directos, diferencia de
 * puntuación, mejor seed de inscripción, id. Determinista e independiente del orden.
 */
export async function seasonTable(db: Knex, seasonId: string, mode: string): Promise<TableRow[]> {
  const battles = (await db("battles")
    .join("tournaments", "tournaments.id", "battles.tournament_id")
    .where({
      "tournaments.season_id": seasonId,
      "battles.mode": mode,
      "battles.official": true,
      "battles.status": "finished",
    })
    .whereNot("tournaments.format", "teams")
    .whereNot("tournaments.state", "draft")
    .whereNull("battles.reverted_at")
    .whereNotNull("battles.match_id")
    .orderBy([{ column: "battles.match_id" }, { column: "battles.game_index" }, { column: "battles.id" }])
    .select("battles.id", "battles.match_id", "battles.game_index", "battles.result")) as Record<string, any>[];
  const reverted = await revertedBattleIds(
    db,
    battles.map((b) => b.id as string),
  );
  const byMatch = new Map<string, Record<string, any>[]>();
  for (const b of battles) {
    if (reverted.has(b.id) || isTechnicalLimit(b.result)) continue;
    const list = byMatch.get(b.match_id) ?? [];
    list.push(b);
    byMatch.set(b.match_id, list);
  }
  const matches = byMatch.size
    ? ((await db("matches")
        .whereIn("id", [...byMatch.keys()])
        .orderBy("id", "asc")) as Record<string, any>[])
    : [];
  // Seed = posición de inscripción en su torneo (la mejor si juega varios).
  const seeds = new Map<string, number>();
  const tids = [...new Set(matches.map((m) => m.tournament_id as string))].sort();
  for (const tid of tids) {
    const entries = (await db("entries")
      .where({ tournament_id: tid })
      .orderBy("created_at", "asc")
      .select("bot_id")) as {
      bot_id: string;
    }[];
    entries.forEach((e, i) => seeds.set(e.bot_id, Math.min(seeds.get(e.bot_id) ?? Infinity, i + 1)));
  }
  const rows = new Map<string, TableRow>();
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r) {
      r = { id, points: 0, wins: 0, losses: 0, draws: 0, scoreDiff: 0, seed: seeds.get(id) ?? Number.MAX_SAFE_INTEGER };
      rows.set(id, r);
    }
    return r;
  };
  const h2h = new Map<string, number>();
  for (const m of matches) {
    const p = pairingOf(m as never);
    if (p.bye || !p.home || !p.away) continue;
    // Una serie que sigue en juego (match no cerrado) no recibe el desempate por seed.
    const series = seriesOutcome(byMatch.get(m.id)!, p, { closed: m.state === "finished" });
    const home = row(p.home);
    const away = row(p.away);
    if (series.winner === p.home) {
      home.points += 3;
      home.wins++;
      away.losses++;
      h2h.set(`${p.home}|${p.away}`, (h2h.get(`${p.home}|${p.away}`) ?? 0) + 1);
    } else if (series.winner === p.away) {
      away.points += 3;
      away.wins++;
      home.losses++;
      h2h.set(`${p.away}|${p.home}`, (h2h.get(`${p.away}|${p.home}`) ?? 0) + 1);
    } else {
      home.points += 1;
      away.points += 1;
      home.draws++;
      away.draws++;
    }
    home.scoreDiff += series.homeScore - series.awayScore;
    away.scoreDiff += series.awayScore - series.homeScore;
  }
  return sortTable(rows.values(), h2h);
}

/**
 * Recalcula y ESCRIBE la clasificación de (temporada, modo) dentro de una transacción con
 * cerrojo consultivo por (temporada, modo). Idempotente.
 */
export async function recomputeSeasonStandings(db: Knex, seasonId: string, mode: string): Promise<void> {
  await db.transaction(async (trx) => {
    await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [`standings|${seasonId}|${mode}`]);
    const table = await seasonTable(trx, seasonId, mode);
    const ratings = await seasonRatings(trx, seasonId, mode);
    await updateStandings(
      trx,
      seasonId,
      mode,
      table.map((row, i) => ({
        botId: row.id,
        rank: i + 1,
        rating: ratings.get(row.id) ?? INITIAL_RATING,
        wins: row.wins,
        losses: row.losses,
        draws: row.draws,
      })),
    );
  });
  // Tras el COMMIT: una lectura entre la invalidación interna y el commit no deja en caché
  // la tabla anterior durante 60 s.
  invalidateStandingsCache(seasonId);
}

/** Resultado de `revertOfficialBattle`. */
export type RevertOutcome =
  /** Se ha revertido ahora: marca puesta, Elo devuelto (si lo tenía) y clasificación recalculada. */
  | "reverted"
  /** Ya estaba revertida: no cambia nada (idempotente). */
  | "already_reverted"
  /** No había nada que revertir: no existe, no es oficial, no ha terminado o es técnica. */
  | "nothing_to_revert";

/**
 * Anula a efectos competitivos una batalla OFICIAL terminada, esté o no puntuada ya.
 * En UNA transacción con la fila de la batalla bloqueada: pone la marca propia
 * `battles.reverted_at` (independiente del Elo) y deshace su Elo si lo tenía
 * (`revertBattleRatingInTrx`). Si el job `update_standings` de esa batalla llega después,
 * `applyBattleRating` ve la marca y no aplica Elo. Después recalcula la clasificación de su
 * temporada y modo. Idempotente. (Hoy no la invoca ningún endpoint: es el punto de entrada
 * para quien la necesite; ver informe EQ2.)
 */
export async function revertOfficialBattle(db: Knex, battleId: string): Promise<RevertOutcome> {
  const outcome = await db.transaction(async (trx): Promise<RevertOutcome> => {
    const b = await trx("battles").where({ id: battleId }).forUpdate().first();
    if (!b || !b.official || b.status !== "finished" || isTechnicalLimit(b.result)) return "nothing_to_revert";
    if (b.reverted_at) return "already_reverted";
    await trx("battles").where({ id: battleId }).update({ reverted_at: trx.fn.now() });
    await revertBattleRatingInTrx(trx, battleId);
    return "reverted";
  });
  if (outcome === "nothing_to_revert") return outcome;
  const t = await db("battles")
    .join("tournaments", "tournaments.id", "battles.tournament_id")
    .where({ "battles.id": battleId })
    .first("tournaments.season_id", "battles.mode", "tournaments.format");
  if (t && t.format !== "teams") await recomputeSeasonStandings(db, t.season_id as string, t.mode as string);
  return outcome;
}
