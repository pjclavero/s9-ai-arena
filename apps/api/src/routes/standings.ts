/** T7.5 · Clasificaciones públicas con caché ≤60 s (invalidada al actualizar). */
import { Router } from "express";
import type { Db } from "../db/connection.js";
import { badRequest, notFound } from "../errors.js";
import { defineOperation } from "../registry.js";
import { pathParam } from "../params.js";
import { ROLE_RANK } from "../openapi.js";
import { getStandings } from "../services/standings.js";
import { PRIVATE_BOT_LABEL, hiddenBotIds } from "../battle-access.js";
// H6 (issue #10) · Se expone el libro mayor REAL de E9, no una reimplementación.
import { INITIAL_RATING, ratingAt, ratingHistory } from "../../../tournament-worker/src/ratings.js";
// TD-029 · STAT_SEASON: ÚNICA fuente de la temporada activa (la comparte el worker).
import { resolveSeasonId } from "../../../tournament-worker/src/season.js";

const MODES = ["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"];

export function standingsRoutes(db: Db): Router {
  const router = Router();

  defineOperation(router, "getStandings", async (req, res) => {
    // Antes: `?? "current"`, una temporada que nadie escribe ⇒ clasificación SIEMPRE
    // vacía. Ahora ausente/"current" ⇒ la temporada activa real.
    const seasonId = resolveSeasonId(req.query.seasonId);
    const mode = typeof req.query.mode === "string" ? req.query.mode : undefined;
    const { standings } = await getStandings(db, seasonId, mode);
    // UX-F (DEF-R3) · un bot privado ajeno conserva su puesto (el ranking no se
    // reordena ni salta posiciones) pero no se identifica: sin botId y «Bot privado».
    const hidden = await hiddenBotIds(
      db,
      req.auth,
      standings.map((r) => r.botId),
    );
    const projected = standings.map((r) =>
      !hidden.has(r.botId) ? r : { ...r, botId: null, botName: PRIVATE_BOT_LABEL, private: true },
    );
    // Depende de quién pregunta si hay bots no públicos: nunca en una caché compartida.
    res.setHeader("Cache-Control", hidden.size > 0 || req.auth ? "private, no-store" : "public, max-age=60");
    res.setHeader("X-S9-Season", seasonId);
    res.json(projected);
  });

  /**
   * H6 (issue #10) · Historial público de rating: `rating_events` de E9
   * (T9.3) por bot-versión, con reconstrucción histórica opcional (?at=).
   * Funciones listas y probadas desde la entrega de E9; faltaba la ruta.
   */
  defineOperation(router, "getBotRatingHistory", async (req, res) => {
    const botId = pathParam(req, "botId");
    const bot = await db("bots")
      .where({ id: botId })
      .first()
      .catch(() => null);
    if (!bot) throw notFound();
    // TD-005 · el historial de un bot NO público sólo lo ve su dueño, un miembro
    // de su equipo (visibility=team) o un admin; para el resto, 404 (igual que
    // inexistente: no se revela que existe).
    if (bot.visibility !== "public") {
      const userId = req.auth?.userId;
      let allowed = Boolean(userId) && (bot.owner_id === userId || (req.auth?.rank ?? 0) >= ROLE_RANK.admin);
      if (!allowed && userId && bot.visibility === "team" && bot.team_id) {
        allowed = Boolean(await db("team_members").where({ team_id: bot.team_id, user_id: userId }).first());
      }
      if (!allowed) throw notFound();
    }
    const seasonId = resolveSeasonId(req.query.seasonId);
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
    // REVIEW (cierre funcional, R8) · el historial de un bot NO público ya pasó el
    // control de acceso: una caché compartida no debe servírselo a terceros.
    res.setHeader("Cache-Control", bot.visibility === "public" ? "public, max-age=60" : "private, no-store");
    res.setHeader("X-S9-Season", seasonId);
    res.json(body);
  });

  return router;
}
