/**
 * E9 · T9.3 — Sistema de rating sobre battle_stats/participants (cap. 20.3).
 *
 * Elo con K CONFIGURABLE POR LIGA (tournaments.elo_k; ADR-E9-002 documenta la
 * elección frente a Glicko-2). La interfaz RatingSystem deja el cambio
 * preparado: swap de implementación sin tocar el pipeline.
 *
 * Principios:
 *  - Solo puntúan batallas OFICIALES (las de práctica no afectan al rating).
 *  - Libro mayor rating_events: CADA aplicación queda registrada con
 *    before/delta/after por bot-versión. De ahí salen la idempotencia por
 *    battle_id (reaplicar es no-op), la reversión de batallas anuladas y la
 *    reconstrucción del rating de cualquier bot en cualquier fecha.
 *  - Ratings separados por temporada (tournaments.season_id) y modo de juego.
 *  - Suma conservada: los deltas son intercambios por pareja (suma cero por
 *    construcción), también en batallas por equipos.
 */
import type { Knex } from "knex";

export const INITIAL_RATING = 1000;
export const DEFAULT_K = 24;

// ------------------------------------------------------------- núcleo puro

export interface RatedSide {
  botId: string;
  team: string;
  rating: number;
  /** Puntuación de la batalla: 1 victoria, 0.5 empate, 0 derrota/DQ. */
  score: number;
}

/** Interfaz de sistema de rating (ADR-E9-002): Elo hoy, Glicko-2 mañana. */
export interface RatingSystem {
  readonly name: string;
  deltas(sides: RatedSide[], k: number): Map<string, number>;
}

export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

/**
 * Elo por parejas entre equipos rivales: cada pareja (a,b) intercambia
 * k' · (S_a − E_a) con k' = k / nº de parejas cruzadas. El intercambio es
 * simétrico → la SUMA GLOBAL de deltas es exactamente 0 (test de propiedad).
 */
export const EloSystem: RatingSystem = {
  name: "elo",
  deltas(sides: RatedSide[], k: number): Map<string, number> {
    const deltas = new Map<string, number>(sides.map((s) => [s.botId, 0]));
    const pairs: [RatedSide, RatedSide][] = [];
    for (let i = 0; i < sides.length; i++) {
      for (let j = i + 1; j < sides.length; j++) {
        if (sides[i].team !== sides[j].team) pairs.push([sides[i], sides[j]]);
      }
    }
    if (pairs.length === 0) return deltas;
    const kPair = k / pairs.length;
    for (const [a, b] of pairs) {
      // Resultado relativo de la pareja a partir de los scores absolutos.
      const sA = a.score > b.score ? 1 : a.score < b.score ? 0 : 0.5;
      const change = kPair * (sA - expectedScore(a.rating, b.rating));
      deltas.set(a.botId, deltas.get(a.botId)! + change);
      deltas.set(b.botId, deltas.get(b.botId)! - change);
    }
    return deltas;
  },
};

// --------------------------------------------------------------- pipeline BD

function outcomeScore(outcome: string | null): number {
  if (outcome === "win") return 1;
  if (outcome === "draw") return 0.5;
  return 0; // loss y disqualified
}

/**
 * Aplica el rating de una batalla OFICIAL terminada. Idempotente por
 * battle_id: si ya hay eventos en el libro mayor, no-op (DoD: reprocesar una
 * batalla no aplica el rating dos veces).
 */
export async function applyBattleRating(db: Knex, battleId: string, system: RatingSystem = EloSystem): Promise<boolean> {
  const battle = await db("battles").where({ id: battleId }).first();
  if (!battle || battle.status !== "finished") return false;
  if (!battle.official) return false; // práctica privada: no puntúa

  const tournament = battle.tournament_id ? await db("tournaments").where({ id: battle.tournament_id }).first() : null;
  const seasonId = (tournament?.season_id as string) ?? "season-1";
  const mode = battle.mode as string;
  const k = (tournament?.elo_k as number) ?? DEFAULT_K;

  return db.transaction(async (trx) => {
    // Idempotencia: candado por batalla contra aplicaciones concurrentes.
    const existing = await trx("rating_events").where({ battle_id: battleId }).forUpdate().first();
    if (existing) return false;

    const participants = await trx("participants").where({ battle_id: battleId });
    if (participants.length < 2) return false;

    const sides: RatedSide[] = [];
    for (const p of participants) {
      const current = await trx("ratings").where({ bot_id: p.bot_id, season_id: seasonId, mode }).first();
      sides.push({
        botId: p.bot_id,
        team: p.team,
        rating: (current?.rating as number) ?? INITIAL_RATING,
        score: outcomeScore(p.outcome),
      });
    }

    const deltas = system.deltas(sides, k);
    for (const p of participants) {
      const side = sides.find((s) => s.botId === p.bot_id)!;
      const delta = deltas.get(p.bot_id) ?? 0;
      const after = side.rating + delta;
      await trx("rating_events").insert({
        battle_id: battleId,
        bot_id: p.bot_id,
        bot_version: p.version,
        season_id: seasonId,
        mode,
        k,
        rating_before: side.rating,
        delta,
        rating_after: after,
      });
      await trx("ratings")
        .insert({
          bot_id: p.bot_id,
          season_id: seasonId,
          mode,
          rating: after,
          wins: side.score === 1 ? 1 : 0,
          losses: side.score === 0 ? 1 : 0,
          draws: side.score === 0.5 ? 1 : 0,
          updated_at: trx.fn.now(),
        })
        .onConflict(["bot_id", "season_id", "mode"])
        .merge({
          rating: after,
          wins: trx.raw("ratings.wins + ?", [side.score === 1 ? 1 : 0]),
          losses: trx.raw("ratings.losses + ?", [side.score === 0 ? 1 : 0]),
          draws: trx.raw("ratings.draws + ?", [side.score === 0.5 ? 1 : 0]),
          updated_at: trx.fn.now(),
        });
    }
    return true;
  });
}

/**
 * Revierte el efecto de una batalla ANULADA (p. ej. fallo técnico detectado a
 * posteriori): aplica el delta inverso y marca los eventos como revertidos.
 * Idempotente: los eventos ya revertidos no se tocan.
 */
export async function revertBattleRating(db: Knex, battleId: string): Promise<boolean> {
  return db.transaction(async (trx) => {
    const events = await trx("rating_events").where({ battle_id: battleId, reverted: false }).forUpdate();
    if (events.length === 0) return false;
    const participants = await trx("participants").where({ battle_id: battleId });
    const scoreByBot = new Map<string, number>(participants.map((p: Record<string, unknown>) => [p.bot_id as string, outcomeScore(p.outcome as string | null)]));
    for (const e of events) {
      const score = scoreByBot.get(e.bot_id as string) ?? 0;
      await trx("ratings")
        .where({ bot_id: e.bot_id, season_id: e.season_id, mode: e.mode })
        .update({
          rating: trx.raw("rating - ?", [e.delta]),
          wins: trx.raw("greatest(wins - ?, 0)", [score === 1 ? 1 : 0]),
          losses: trx.raw("greatest(losses - ?, 0)", [score === 0 ? 1 : 0]),
          draws: trx.raw("greatest(draws - ?, 0)", [score === 0.5 ? 1 : 0]),
          updated_at: trx.fn.now(),
        });
      await trx("rating_events").where({ id: e.id }).update({ reverted: true });
    }
    return true;
  });
}

/** Ratings vigentes de una temporada/modo (para standings materializados). */
export async function seasonRatings(db: Knex, seasonId: string, mode: string): Promise<Map<string, number>> {
  const rows = await db("ratings").where({ season_id: seasonId, mode });
  return new Map(rows.map((r: Record<string, unknown>) => [r.bot_id as string, r.rating as number]));
}

/**
 * Reconstrucción histórica (DoD): rating de un bot en una fecha cualquiera,
 * re-jugando el libro mayor hasta ese instante (eventos revertidos excluidos).
 */
export async function ratingAt(db: Knex, botId: string, seasonId: string, mode: string, at: Date): Promise<number> {
  const events = await db("rating_events")
    .where({ bot_id: botId, season_id: seasonId, mode, reverted: false })
    .where("created_at", "<=", at)
    .orderBy("created_at", "asc")
    .orderBy("id", "asc");
  let rating = INITIAL_RATING;
  for (const e of events) rating += Number(e.delta);
  return rating;
}

/** Historial completo de rating por bot-versión (API/panel; DoD historial). */
export async function ratingHistory(db: Knex, botId: string, seasonId: string, mode: string) {
  const events = await db("rating_events")
    .where({ bot_id: botId, season_id: seasonId, mode })
    .orderBy("created_at", "asc")
    .orderBy("id", "asc");
  return events.map((e: Record<string, unknown>) => ({
    battleId: e.battle_id,
    botVersion: e.bot_version,
    k: Number(e.k),
    before: Number(e.rating_before),
    delta: Number(e.delta),
    after: Number(e.rating_after),
    reverted: e.reverted as boolean,
    at: e.created_at as Date,
  }));
}
