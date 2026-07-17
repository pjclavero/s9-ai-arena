/** T7.5 · Clasificaciones públicas con caché ≤60 s (invalidada al actualizar). */
import { Router } from "express";
import type { Db } from "../db/connection.js";
import { badRequest, notFound } from "../errors.js";
import { defineOperation } from "../registry.js";
import { pathParam } from "../params.js";
import { getStandings } from "../services/standings.js";
// H6 (issue #10) · Se expone el libro mayor REAL de E9, no una reimplementación.
import { INITIAL_RATING, ratingAt, ratingHistory } from "../../../tournament-worker/src/ratings.js";

const MODES = ["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"];

export function standingsRoutes(db: Db): Router {
  const router = Router();

  defineOperation(router, "getStandings", async (req, res) => {
    const seasonId = typeof req.query.seasonId === "string" ? req.query.seasonId : "current";
    const mode = typeof req.query.mode === "string" ? req.query.mode : undefined;
    const { standings } = await getStandings(db, seasonId, mode);
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(standings);
  });

  /**
   * H6 (issue #10) · Historial público de rating: `rating_events` de E9
   * (T9.3) por bot-versión, con reconstrucción histórica opcional (?at=).
   * Funciones listas y probadas desde la entrega de E9; faltaba la ruta.
   */
  defineOperation(router, "getBotRatingHistory", async (req, res) => {
    const botId = pathParam(req, "botId");
    const bot = await db("bots").where({ id: botId }).first().catch(() => null);
    if (!bot) throw notFound();
    const seasonId = typeof req.query.seasonId === "string" ? req.query.seasonId : "season-1";
    const mode = typeof req.query.mode === "string" ? req.query.mode : "deathmatch";
    if (!MODES.includes(mode)) throw badRequest(`mode debe ser uno de: ${MODES.join(", ")}`);

    const events = await ratingHistory(db, botId, seasonId, mode);
    const current = await db("ratings").where({ bot_id: botId, season_id: seasonId, mode }).first();
    const body: Record<string, unknown> = {
      botId,
      seasonId,
      mode,
      rating: current ? Number(current.rating) : INITIAL_RATING,
      events,
    };
    if (req.query.at !== undefined) {
      const at = new Date(String(req.query.at));
      if (Number.isNaN(at.getTime())) throw badRequest("at debe ser una fecha ISO 8601 válida");
      body.ratingAt = await ratingAt(db, botId, seasonId, mode, at);
    }
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(body);
  });

  return router;
}
