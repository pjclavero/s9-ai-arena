/**
 * T7.5 · Cuotas de uso anónimo sobre api_usage (DoD: 429 al superarse y
 * registro persistente del consumo por actor/ruta/ventana).
 */
import type { NextFunction, Request, Response } from "express";
import type { Db } from "../db/connection.js";
import { tooMany } from "../errors.js";

export interface AnonQuotaConfig {
  /** Peticiones anónimas permitidas por actor y ruta en cada ventana. */
  max: number;
  windowMs: number;
}

export const DEFAULT_ANON_QUOTA: AnonQuotaConfig = { max: 300, windowMs: 60 * 60 * 1000 };

export function anonQuota(db: Db, route: string, cfg: AnonQuotaConfig) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.auth) return next(); // la cuota anónima solo aplica a visitantes
      const windowStart = new Date(Math.floor(Date.now() / cfg.windowMs) * cfg.windowMs);
      const actorKey = `ip:${req.ip}`;
      const [row] = await db("api_usage")
        .insert({ actor_key: actorKey, route, window_start: windowStart, count: 1 })
        .onConflict(["actor_key", "route", "window_start"])
        .merge({ count: db.raw("api_usage.count + 1") })
        .returning("count");
      if (Number(row.count) > cfg.max) return next(tooMany("Cuota anónima superada"));
      next();
    } catch (e) {
      next(e);
    }
  };
}
