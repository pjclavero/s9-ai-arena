/**
 * T7.2+ · Factoría de la app Express de la plataforma (API /api/v1, cap. 16).
 */
import express, { type NextFunction, type Request, type Response } from "express";
import type { Db } from "./db/connection.js";
import { ApiError } from "./errors.js";
import { requestContext, securityHeaders } from "./middleware/context.js";
import { authenticate } from "./middleware/authenticate.js";
import { FailedLoginGuard, SlidingWindowLimiter } from "./middleware/rate-limit.js";
import { authRoutes } from "./routes/auth.js";
import { userRoutes } from "./routes/users.js";
import { teamRoutes } from "./routes/teams.js";
import { botRoutes, buildRoutes } from "./routes/bots.js";
import { catalogRoutes } from "./routes/catalog.js";
import { adminRoutes } from "./routes/admin.js";
import { battleRoutes } from "./routes/battles.js";
import { standingsRoutes } from "./routes/standings.js";
import { tournamentRoutes } from "./routes/tournaments.js";
import { mapRoutes } from "./routes/maps.js";
import { DEFAULT_ANON_QUOTA, type AnonQuotaConfig } from "./middleware/anon-quota.js";
import type { BotManagerClient } from "./services/bot-manager.js";
import { E6PipelineBotManager } from "./services/e6-bot-manager.js";

export interface AppConfig {
  db: Db;
  corsOrigin?: string;
  loginGuard?: FailedLoginGuard;
  /**
   * Cliente del pipeline de builds. Por defecto, el pipeline REAL de E6 en proceso
   * SIN sandbox (sin agentResolver): mientras no exista el runner containerizado
   * (Docker, T6.2), ese pipeline FALLA CERRADO y RECHAZA las versiones como
   * "no verificable" en vez de validarlas sin ejecutar el bot (R1.5 · ERR-SEC-03).
   * En PRODUCCIÓN debe inyectarse un botManager con un agentResolver real.
   */
  botManager?: BotManagerClient;
  /** Cuota de uso anónimo de los endpoints públicos (T7.5). */
  anonQuota?: AnonQuotaConfig;
}

export function createApp(cfg: AppConfig): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(requestContext);
  app.use(securityHeaders(cfg.corsOrigin ?? process.env.CORS_ORIGIN ?? "http://localhost:5173"));
  app.use(authenticate(cfg.db));

  const loginGuard = cfg.loginGuard ?? new FailedLoginGuard();
  app.use(
    authRoutes({
      db: cfg.db,
      loginGuard,
      // Límites holgados para uso normal, suficientes para frenar abuso por IP.
      registerLimiter: new SlidingWindowLimiter(30, 60_000),
      loginLimiter: new SlidingWindowLimiter(60, 60_000),
    }),
  );
  app.use(userRoutes(cfg.db));
  app.use(teamRoutes(cfg.db));
  // Por defecto SIN agentResolver → el pipeline de E6 falla cerrado (rechaza sin
  // sandbox verificado, R1.5 · ERR-SEC-03). Nunca se cablea aquí un resolver falso ni
  // la escotilla dev/test: en prod se inyecta cfg.botManager con el sandbox real (T6.2).
  app.use(botRoutes(cfg.db, cfg.botManager ?? new E6PipelineBotManager(cfg.db)));
  app.use(buildRoutes(cfg.db));
  app.use(catalogRoutes(cfg.db));
  app.use(adminRoutes(cfg.db));
  app.use(battleRoutes(cfg.db, cfg.anonQuota ?? DEFAULT_ANON_QUOTA));
  app.use(standingsRoutes(cfg.db));
  app.use(tournamentRoutes(cfg.db));
  app.use(mapRoutes(cfg.db));

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: "not_found", message: "Ruta no encontrada", correlationId: req.correlationId });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res
        .status(err.status)
        .json({ error: err.code, message: err.message, correlationId: req.correlationId, ...err.extra });
      return;
    }
    if (err && typeof err === "object" && (err as { type?: string }).type === "entity.parse.failed") {
      res.status(400).json({ error: "bad_request", message: "JSON inválido", correlationId: req.correlationId });
      return;
    }
    console.error(`[${req.correlationId}]`, err);
    res.status(500).json({ error: "internal", message: "Error interno", correlationId: req.correlationId });
  });

  return app;
}
