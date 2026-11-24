/**
 * V1 ADM-3 · Administración → Usuarios y recuperación. Sólo admin (x-min-role del contrato).
 *
 *  - GET  /admin/users                           listado paginado con búsqueda (sin hashes ni secretos)
 *  - GET  /admin/users/{userId}                  una cuenta por id (roles ACTUALES)
 *  - PUT  /admin/users/{userId}/status           bloquear / desbloquear cualquier cuenta (reautenticación fuerte)
 *  - POST /admin/users/{userId}/recovery-token   emite el token de recuperación de UN solo uso para CUALQUIER cuenta
 *                                                 (reautenticación fuerte)
 * MODELO DE UN ADMINISTRADOR: lo hace UN admin; ninguna acción exige a otro. Nunca queda 0 admins activos (409).
 *
 * Los roles se siguen asignando con `PUT /users/{userId}/roles` (con la guarda del último administrador).
 * Las acciones destructivas llevan límite de intentos POR ADMIN antes de verificar la contraseña: frena la fuerza
 * bruta con un access token robado.
 */
import { Router } from "express";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { badRequest, notFound, tooMany } from "../errors.js";
import { isUuid, pathParam } from "../params.js";
import { parseLimit } from "../serialize.js";
import { requireStrongReauth } from "./auth.js";
import type { RateLimiterLike } from "../middleware/shared-rate-limit.js";
import { getAdminUser, issueRecoveryToken, listUsers, setUserStatus } from "../services/account-recovery.js";

export interface AdminUsersDeps {
  /** Límite de acciones con reautenticación por admin (por defecto: 20 cada 5 min, sobre api_usage). */
  actionLimiter: RateLimiterLike;
}

export function adminUsersRoutes(db: Db, deps: AdminUsersDeps): Router {
  const router = Router();
  const ctx = (req: { auth?: { userId: string }; correlationId?: string }) => ({
    actorId: req.auth?.userId ?? null,
    correlationId: req.correlationId,
  });

  function userIdParam(req: { params: Record<string, string | string[] | undefined> }): string {
    const id = pathParam(req, "userId");
    if (!isUuid(id)) throw notFound();
    return id;
  }

  /** Límite + reautenticación fuerte (contraseña y, si la cuenta tiene 2FA, TOTP o código de recuperación). */
  async function reauth(req: { auth?: { userId: string }; body?: unknown }): Promise<void> {
    if (!(await deps.actionLimiter.hit(`admin-users:${req.auth!.userId}`))) {
      throw tooMany("Demasiados intentos: espera unos minutos");
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const me = await db("users").where({ id: req.auth!.userId }).first();
    if (!me) throw notFound();
    await requireStrongReauth(db, me, { password: body.password, totp: body.totp });
  }

  defineOperation(router, "listAdminUsers", async (req, res) => {
    const limit = parseLimit(req.query.limit);
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    res.setHeader("Cache-Control", "no-store");
    res.json(await listUsers(db, { q: req.query.q, limit, cursor }));
  });

  defineOperation(router, "getAdminUser", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getAdminUser(db, userIdParam(req)));
  });

  defineOperation(router, "setUserStatus", async (req, res) => {
    await reauth(req);
    const id = userIdParam(req);
    const status = (req.body as { status?: unknown } | undefined)?.status;
    if (status !== "active" && status !== "blocked") throw badRequest("status debe ser active o blocked");
    res.setHeader("Cache-Control", "no-store");
    res.json(await setUserStatus(db, ctx(req), id, status));
  });

  defineOperation(router, "issueUserRecoveryToken", async (req, res) => {
    await reauth(req);
    const id = userIdParam(req);
    const r = await issueRecoveryToken(db, ctx(req), id);
    // El token se muestra UNA vez: nunca se cachea ni se vuelve a poder leer.
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json(r);
  });

  return router;
}
