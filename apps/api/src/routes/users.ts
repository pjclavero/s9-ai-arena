/** T7.2 · Usuarios: perfil propio, perfil público y asignación de roles (auditada). */
import { Router } from "express";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { badRequest, notFound, tooMany } from "../errors.js";
import { publicProfile, userToJson } from "../serialize.js";
import { ROLES, type RoleName } from "../db/migrations.js";
import { currentRoles, planRoleChange, setUserRoles } from "../services/account-recovery.js";
import { requireStrongReauth } from "./auth.js";
import type { RateLimiterLike } from "../middleware/shared-rate-limit.js";
import { isUuid } from "../params.js";

export function userRoutes(db: Db, deps: { actionLimiter: RateLimiterLike }): Router {
  const router = Router();

  defineOperation(router, "getMe", async (req, res) => {
    const user = await db("users").where({ id: req.auth!.userId }).first();
    res.json(userToJson(user, req.auth!.roles, { includePrivate: true }));
  });

  defineOperation(router, "updateMe", async (req, res) => {
    const { displayName } = req.body ?? {};
    if (typeof displayName !== "string" || !displayName || displayName.length > 48) {
      throw badRequest("displayName obligatorio (máx. 48)");
    }
    const [user] = await db("users")
      .where({ id: req.auth!.userId })
      .update({ display_name: displayName, updated_at: db.fn.now() })
      .returning("*");
    res.json(userToJson(user, req.auth!.roles, { includePrivate: true }));
  });

  defineOperation(router, "getUserPublic", async (req, res) => {
    const user = await db("users")
      .where({ id: req.params.userId })
      .first()
      .catch(() => null);
    if (!user) throw notFound();
    res.json(publicProfile(user));
  });

  defineOperation(router, "setUserRoles", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { roles } = body;
    if (!Array.isArray(roles) || roles.some((r) => !ROLES.includes(r as RoleName))) {
      throw badRequest(`roles debe ser un subconjunto de [${ROLES.join(", ")}]`);
    }
    const userId = String(req.params.userId);
    const user = isUuid(userId) ? await db("users").where({ id: userId }).first() : null;
    if (!user) throw notFound();

    // ADM-3 · conceder o quitar «admin» exige reautenticación fuerte (contraseña y, si hay 2FA, TOTP).
    const plan = planRoleChange(await currentRoles(db, user.id), roles as string[]);
    const reauthed = plan.grantsAdmin || plan.revokesAdmin;
    if (reauthed) {
      if (!(await deps.actionLimiter.hit(`admin-users:${req.auth!.userId}`))) {
        throw tooMany("Demasiados intentos: espera unos minutos");
      }
      const me = await db("users").where({ id: req.auth!.userId }).first();
      await requireStrongReauth(db, me, { password: body.password, totp: body.totp });
    }
    const final = await setUserRoles(
      db,
      { actorId: req.auth!.userId, correlationId: req.correlationId },
      user.id,
      roles as string[],
      { reauthed },
    );
    res.json(userToJson(user, final, { includePrivate: true }));
  });

  return router;
}
