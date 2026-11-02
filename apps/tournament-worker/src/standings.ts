/**
 * E9 · T9.2 — Handler de `update_standings`: materializa la clasificación de
 * la temporada llamando al punto de entrada REAL de E7 (updateStandings, caché
 * ≤60 s con invalidación inmediata; no se duplica).
 *
 * EQ2 (P2 del EQ6) · La clasificación de (temporada, modo) es el AGREGADO de TODOS los
 * torneos individuales de esa temporada y modo, recalculado desde la fuente de verdad
 * (los enfrentamientos de cada torneo, `leagueTableDetailed`) y no la tabla del último
 * torneo que se actualizó. Antes, `updateStandings` borraba la (temporada, modo) y
 * escribía sólo la tabla del torneo que la llamaba: con dos torneos del mismo modo, el
 * ranking enseñaba uno u otro según cuál se procesara el último.
 *
 * Semántica (la misma de siempre, ahora sumada):
 *  - por ENFRENTAMIENTOS: victoria 3 puntos, empate 1, derrota 0; bye = victoria;
 *    enfrentamiento terminado sin ganador = empate;
 *  - ADR-022: un enfrentamiento cuyas batallas terminaron TODAS por la salvaguarda técnica
 *    (`technical_limit`) no cuenta (ni empate);
 *  - orden: puntos, enfrentamientos directos (sumados), diferencia de puntuación (sumada)
 *    y, por último, la mejor posición de inscripción (seed) y el id del bot. Con un solo
 *    torneo es EXACTAMENTE el orden de su tabla (`leagueTable`).
 * Determinista e idempotente: no depende del orden de procesamiento. Concurrencia: dos
 * recálculos de la misma (temporada, modo) se serializan con un cerrojo consultivo de
 * transacción, y cada uno lee lo ya confirmado: el último en entrar ve todos los torneos.
 *
 * El rating es el Elo del libro mayor rating_events (T9.3), ya por temporada y modo;
 * mientras un bot no tenga eventos, su rating es el inicial (1000).
 */
import type { Knex } from "knex";
import { invalidateStandingsCache, updateStandings } from "../../api/src/services/standings.js";
import { leagueTableDetailed, sortTable, type TableRow } from "./results.js";
import { applyBattleRating, seasonRatings, INITIAL_RATING } from "./ratings.js";
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

/** Tabla agregada (sin escribir) de los torneos individuales de una temporada y modo. */
export async function seasonTable(db: Knex, seasonId: string, mode: string): Promise<TableRow[]> {
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
  // Orden de siempre (sortTable acaba en el id: total y estable en cualquier orden).
  return sortTable(total.values(), h2h);
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
