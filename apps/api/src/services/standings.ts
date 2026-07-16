/**
 * T7.5 · Clasificaciones con caché de 60 s como máximo (DoD: la caché no sirve
 * datos obsoletos más de 60 s tras una actualización; aquí la invalidación es
 * inmediata porque updateStandings purga la entrada).
 */
import type { Db } from "../db/connection.js";

export const STANDINGS_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  data: unknown[];
  at: number;
}

const cache = new Map<string, CacheEntry>();

export function clearStandingsCache(): void {
  cache.clear();
}

export interface StandingRow {
  rank: number;
  botId: string;
  botName: string;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
}

export async function getStandings(
  db: Db,
  seasonId: string,
  mode: string | undefined,
  now = Date.now(),
): Promise<{ standings: StandingRow[]; fromCache: boolean }> {
  const key = `${seasonId}|${mode ?? "*"}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < STANDINGS_CACHE_TTL_MS) {
    return { standings: hit.data as StandingRow[], fromCache: true };
  }
  let q = db("standings")
    .join("bots", "bots.id", "standings.bot_id")
    .where({ season_id: seasonId })
    .orderBy("rank", "asc")
    .select("standings.*", "bots.name as bot_name");
  if (mode) q = q.andWhere("standings.mode", mode);
  const rows = await q;
  const standings = rows.map((r: Record<string, unknown>) => ({
    rank: r.rank as number,
    botId: r.bot_id as string,
    botName: r.bot_name as string,
    rating: r.rating as number,
    wins: r.wins as number,
    losses: r.losses as number,
    draws: r.draws as number,
  }));
  cache.set(key, { data: standings, at: now });
  return { standings, fromCache: false };
}

/** La escriben E9/E8 (pipeline de ratings). Invalida la caché al instante. */
export async function updateStandings(
  db: Db,
  seasonId: string,
  mode: string,
  rows: { botId: string; rank: number; rating: number; wins?: number; losses?: number; draws?: number }[],
): Promise<void> {
  await db.transaction(async (trx) => {
    await trx("standings").where({ season_id: seasonId, mode }).delete();
    if (rows.length > 0) {
      await trx("standings").insert(
        rows.map((r) => ({
          season_id: seasonId,
          mode,
          bot_id: r.botId,
          rank: r.rank,
          rating: r.rating,
          wins: r.wins ?? 0,
          losses: r.losses ?? 0,
          draws: r.draws ?? 0,
          updated_at: trx.fn.now(),
        })),
      );
    }
  });
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${seasonId}|`)) cache.delete(key);
  }
}
