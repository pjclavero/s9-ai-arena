/**
 * T7.2+ · Factoría de la app Express de la plataforma (API /api/v1, cap. 16).
 */
import express, { type NextFunction, type Request, type Response } from "express";
import type { Db } from "./db/connection.js";
import { ApiError } from "./errors.js";
import { requestContext, securityHeaders } from "./middleware/context.js";
import { authenticate } from "./middleware/authenticate.js";
import {
  SharedFailedLoginGuard,
  SharedRateLimiter,
  type LoginGuardLike,
  type RateLimiterLike,
} from "./middleware/shared-rate-limit.js";
import { authRoutes } from "./routes/auth.js";
import { userRoutes } from "./routes/users.js";
import { teamRoutes } from "./routes/teams.js";
import { botRoutes, buildRoutes } from "./routes/bots.js";
import { catalogRoutes } from "./routes/catalog.js";
import { adminRoutes } from "./routes/admin.js";
import { battleRoutes } from "./routes/battles.js";
import { battleRunConfigFromEnv, realBattleRunsCapability, type BattleRunConfig } from "./battle-run.js";
import { publicSpectateEnabledFromEnv } from "./public-spectate.js";
import { standingsRoutes } from "./routes/standings.js";
import { tournamentRoutes } from "./routes/tournaments.js";
import { mapRoutes } from "./routes/maps.js";
import { systemRoutes } from "./routes/system.js";
import { DEFAULT_ANON_QUOTA, type AnonQuotaConfig } from "./middleware/anon-quota.js";
import { resolveTrustProxyHops } from "./middleware/proxy-trust.js";
import type { BotManagerClient } from "./services/bot-manager.js";
import { QueueBotManager } from "./services/bot-manager.js";
import { keyRoutes } from "./routes/keys.js";
import type { BotBuildLimiters } from "./routes/bots.js";

export interface AppConfig {
  db: Db;
  corsOrigin?: string;
  loginGuard?: LoginGuardLike;
  /** R2.4: inyectable en tests (límite bajo) — por defecto 60 refresh/min por IP. */
  refreshLimiter?: RateLimiterLike;
  /**
   * Cliente del pipeline de builds. Por defecto (R2.5 · ERR-SEC-12), el ENCOLADOR
   * real: submitBotVersion persiste el trabajo en la tabla `jobs` y responde 202;
   * el pipeline de E6 corre en el worker del bot-manager (build-worker), NUNCA en
   * el proceso de la API. Ese worker sigue fallando cerrado sin sandbox
   * (R1.5 · ERR-SEC-03): rechaza como "no verificable" en vez de validar.
   */
  botManager?: BotManagerClient;
  /** Cuota de uso anónimo de los endpoints públicos (T7.5). */
  anonQuota?: AnonQuotaConfig;
  /**
   * Saltos de proxy de confianza delante de la API (R1.8 · ERR-SEC-05).
   * Por defecto se resuelve de TRUST_PROXY_HOPS (0 si no está definida: sin
   * proxy declarado no se cree ninguna X-Forwarded-For — falla cerrado).
   * Nunca `trust proxy: true` genérico: siempre un número ACOTADO de saltos.
   */
  trustProxyHops?: number;
  /** Limitadores por usuario de creación de versiones/builds (R2.5 · ERR-SEC-12). */
  buildLimiters?: BotBuildLimiters;
  /** Limitadores de registro/login; por defecto, compartidos en BD (ERR-SEC-14). */
  registerLimiter?: RateLimiterLike;
  loginLimiter?: RateLimiterLike;
  /**
   * R6.2/R9-B · Config de ejecución containerizada REAL. Por defecto se resuelve del
   * entorno (apagado salvo S9_ENABLE_REAL_BATTLE_RUNS=1) y SIN runner cableado (→ 503
   * runner_unavailable hasta el paso VM108). El launcher se inyecta aquí; la API nunca
   * llama a Docker. En tests se inyecta un launcher fake.
   */
  realBattleRuns?: BattleRunConfig;
  /**
   * R11 · Capability del slice mínimo de espectador público (S9_PUBLIC_SPECTATE_ENABLED,
   * apagada por defecto). Inyectable en tests; en producción se resuelve del entorno.
   */
  publicSpectateEnabled?: boolean;
}

export function createApp(cfg: AppConfig): express.Express {
  const app = express();
  app.disable("x-powered-by");
  // R1.8 · ERR-SEC-05: confianza de proxy ACOTADA al número de saltos reales
  // (gateway del stack = 1; VM104 + gateway = 2). Con esto `req.ip` es la IP
  // real del cliente para la cuota anónima y la clave `${ip}|${email}` del
  // bloqueo de login, y una X-Forwarded-For inyectada desde fuera se descarta.
  app.set("trust proxy", cfg.trustProxyHops ?? resolveTrustProxyHops());
  app.use(express.json({ limit: "1mb" }));
  app.use(requestContext);
  app.use(securityHeaders(cfg.corsOrigin ?? process.env.CORS_ORIGIN ?? "http://localhost:5173"));
  app.use(authenticate(cfg.db));

  // R2.5 (ERR-SEC-14): guard y limitadores por defecto sobre api_usage — el estado
  // de bloqueo/contadores sobrevive a reinicios y se comparte entre réplicas.
  const loginGuard = cfg.loginGuard ?? new SharedFailedLoginGuard(cfg.db);
  app.use(
    authRoutes({
      db: cfg.db,
      loginGuard,
      // Límites holgados para uso normal, suficientes para frenar abuso por IP.
      registerLimiter:
        cfg.registerLimiter ?? new SharedRateLimiter(cfg.db, "auth.register", { max: 30, windowMs: 60_000 }),
      loginLimiter: cfg.loginLimiter ?? new SharedRateLimiter(cfg.db, "auth.login", { max: 60, windowMs: 60_000 }),
      // R2.4 (ERR-SEC-08): el refresh emite credenciales → rate-limit propio por IP.
      refreshLimiter:
        cfg.refreshLimiter ?? new SharedRateLimiter(cfg.db, "auth.refresh", { max: 60, windowMs: 60_000 }),
    }),
  );
  app.use(userRoutes(cfg.db));
  app.use(teamRoutes(cfg.db));
  // R2.5 (ERR-SEC-12): por defecto el ENCOLADOR real (tabla jobs): el pipeline de
  // builds corre en el worker del bot-manager, nunca aquí. El worker sigue fallando
  // cerrado sin sandbox verificado (R1.5 · ERR-SEC-03).
  app.use(
    botRoutes(
      cfg.db,
      cfg.botManager ?? new QueueBotManager(cfg.db),
      cfg.buildLimiters ?? {
        createVersion: new SharedRateLimiter(cfg.db, "bots.createVersion", { max: 60, windowMs: 60 * 60_000 }),
        submit: new SharedRateLimiter(cfg.db, "bots.submitVersion", { max: 60, windowMs: 60 * 60_000 }),
      },
    ),
  );
  app.use(buildRoutes(cfg.db));
  app.use(keyRoutes());
  app.use(catalogRoutes(cfg.db));
  app.use(adminRoutes(cfg.db));
  const realBattleRuns = cfg.realBattleRuns ?? battleRunConfigFromEnv();
  const publicSpectateEnabled = cfg.publicSpectateEnabled ?? publicSpectateEnabledFromEnv();
  app.use(battleRoutes(cfg.db, cfg.anonQuota ?? DEFAULT_ANON_QUOTA, realBattleRuns, publicSpectateEnabled));
  app.use(standingsRoutes(cfg.db));
  app.use(tournamentRoutes(cfg.db));
  app.use(mapRoutes(cfg.db));
  app.use(systemRoutes(cfg.db, realBattleRunsCapability(realBattleRuns), publicSpectateEnabled));

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
