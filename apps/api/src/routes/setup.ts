/**
 * V1 ADM-SETUP (D-OP-44) · Asistente de primer arranque desde el navegador.
 *
 *  - `GET /setup/status`: sólo `{ open }`. Abierto ⇔ 0 admins, `install_state` sin completar y token de
 *    instalación presente (services/install-state.ts). No dice cuál falta.
 *  - `POST /setup/admin`: token de instalación (tiempo constante) + email, nombre y contraseña. Reutiliza
 *    `createAdmin` (transacción + cerrojo consultivo, política de contraseñas) con `via: "web"`, que dentro
 *    del cerrojo vuelve a comprobar el estado, cierra la instalación PARA SIEMPRE y emite el kit de
 *    recuperación. Responde 201 con la sesión iniciada y el kit (una sola vez).
 *
 * Seguridad: `Cache-Control: no-store` en ambas; límite de intentos (por IP y global); cada token
 * erróneo se audita (`setup.token_rejected`) sin su valor; el token nunca va a logs ni a la auditoría.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { audit } from "../audit.js";
import { ApiError, badRequest, conflict, notFound, tooMany, unauthorized } from "../errors.js";
import { rateLimit } from "../middleware/rate-limit.js";
import type { RateLimiterLike } from "../middleware/shared-rate-limit.js";
import { readSetupState } from "../services/install-state.js";
import { setupTokenFingerprint, setupTokenMatches, type SetupTokenSource } from "../services/setup-token.js";
import { createAdminWithHooks, CreateAdminError, type CreateAdminTestHooks } from "../services/create-admin.js";
import { createSession, setRefreshCookie } from "./auth.js";

export interface SetupDeps {
  db: Db;
  tokenSource: SetupTokenSource;
  /** 5 intentos / 15 min por IP (por defecto, compartido en BD). */
  ipLimiter: RateLimiterLike;
  /** 20 intentos / hora en total (por defecto, compartido en BD). */
  globalLimiter: RateLimiterLike;
  /** SÓLO tests: ensanchar la ventana de carrera del alta. */
  testHooks?: CreateAdminTestHooks;
}

const setupClosed = () =>
  new ApiError(410, "setup_closed", "La instalación ya tiene administrador: el asistente está cerrado para siempre");

function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store");
  next();
}

function globalLimit(limiter: RateLimiterLike) {
  return async (_req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!(await limiter.hit("setup:all"))) return next(tooMany());
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function setupRoutes(deps: SetupDeps): Router {
  const { db, tokenSource } = deps;
  const router = Router();

  defineOperation(
    router,
    "getSetupStatus",
    async (_req, res) => {
      const state = await readSetupState(db, tokenSource() !== null);
      res.json({ open: state.open });
    },
    noStore,
  );

  defineOperation(
    router,
    "createFirstAdmin",
    async (req, res) => {
      const token = tokenSource();
      const state = await readSetupState(db, token !== null);
      if (!state.open) {
        if (state.reason === "no_token") throw notFound("Asistente de primer arranque no disponible");
        throw setupClosed();
      }
      const { setupToken, email, displayName, password } = req.body ?? {};
      if (!setupTokenMatches(token!, setupToken)) {
        await audit(db, {
          action: "setup.token_rejected",
          target: "install:setup",
          detail: { ip: req.ip ?? null, userAgent: String(req.headers["user-agent"] ?? "") },
          correlationId: req.correlationId,
        });
        throw unauthorized("Token de instalación inválido");
      }
      let result;
      try {
        result = await createAdminWithHooks(
          db,
          {
            email,
            displayName,
            password,
            via: "web",
            webContext: {
              ip: req.ip ?? null,
              userAgent: String(req.headers["user-agent"] ?? ""),
              tokenFingerprint: setupTokenFingerprint(token!),
              correlationId: req.correlationId,
            },
          },
          deps.testHooks ?? {},
        );
      } catch (e) {
        if (e instanceof CreateAdminError) {
          if (e.code === "invalid_input") throw badRequest(e.message);
          if (e.code === "setup_closed" || e.code === "admin_exists") throw setupClosed();
          if (e.code === "email_taken") throw conflict("email_taken", e.message);
          throw conflict(e.code, e.message);
        }
        throw e;
      }
      const session = await createSession(db, result.userId, req);
      setRefreshCookie(res, session.refreshToken, req);
      res.status(201).json({ ...session, recoveryKit: result.recoveryKit });
    },
    noStore,
    rateLimit(deps.ipLimiter, "setup"),
    globalLimit(deps.globalLimiter),
  );

  return router;
}
