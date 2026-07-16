/**
 * E9 · T9.2 — Handler de `update_standings`: materializa la clasificación de
 * la temporada del torneo llamando al punto de entrada REAL de E7
 * (updateStandings, caché ≤60 s con invalidación inmediata; no se duplica).
 *
 * La posición sale de la tabla de liga (puntos y desempates documentados en
 * formats.ts). El rating es el Elo del libro mayor rating_events (T9.3);
 * mientras un bot no tenga eventos, su rating es el inicial (1000).
 */
import { updateStandings } from "../../api/src/services/standings.js";
import { leagueTable } from "./results.js";
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

  const isTeams = t.format === "teams";
  const table = await leagueTable(db, tournamentId, isTeams);
  if (!isTeams) {
    const ratings = await seasonRatings(db, t.season_id, t.mode);
    await updateStandings(
      db,
      t.season_id,
      t.mode,
      table.map((row, i) => ({
        botId: row.id,
        rank: i + 1,
        rating: ratings.get(row.id) ?? INITIAL_RATING,
        wins: row.wins,
        losses: row.losses,
        draws: row.draws,
      })),
    );
  }
  // Equipos: la tabla standings de E7 es por bot; la clasificación por equipos
  // vive en matches/leagueTable (reconciliación pendiente con E7 si la API
  // pública quiere tabla por equipos, documentada en la entrega).
}
