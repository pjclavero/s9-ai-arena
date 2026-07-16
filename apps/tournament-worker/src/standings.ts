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
import type { JobRow } from "./queue.js";
import type { HandlerContext } from "./worker.js";

export const INITIAL_RATING = 1000;

export async function handleUpdateStandings(job: JobRow, ctx: HandlerContext): Promise<void> {
  const db = ctx.db;
  const tournamentId = String(job.payload.tournamentId ?? "");
  const t = await db("tournaments").where({ id: tournamentId }).first();
  if (!t) throw new Error(`update_standings: torneo ${tournamentId} inexistente`);

  const isTeams = t.format === "teams";
  const table = await leagueTable(db, tournamentId, isTeams);
  if (!isTeams) {
    const ratingRows = await db("ratings").where({ season_id: t.season_id, mode: t.mode });
    const ratings = new Map<string, number>(ratingRows.map((r: Record<string, unknown>) => [r.bot_id as string, r.rating as number]));
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
