/** T7.5 · Clasificaciones públicas con caché ≤60 s (invalidada al actualizar). */
import { Router } from "express";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { getStandings } from "../services/standings.js";

export function standingsRoutes(db: Db): Router {
  const router = Router();

  defineOperation(router, "getStandings", async (req, res) => {
    const seasonId = typeof req.query.seasonId === "string" ? req.query.seasonId : "current";
    const mode = typeof req.query.mode === "string" ? req.query.mode : undefined;
    const { standings } = await getStandings(db, seasonId, mode);
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(standings);
  });

  return router;
}
