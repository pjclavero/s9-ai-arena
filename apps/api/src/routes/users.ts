/** T7.2 · Usuarios: perfil propio, perfil público y asignación de roles (auditada). */
import { Router } from "express";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { audit } from "../audit.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { publicProfile, userToJson } from "../serialize.js";
import { ROLES, type RoleName } from "../db/migrations.js";
import { lockAdminChanges, otherActiveAdminExists } from "../services/account-recovery.js";

export function userRoutes(db: Db): Router {
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
    const { roles } = req.body ?? {};
    if (!Array.isArray(roles) || roles.some((r) => !ROLES.includes(r as RoleName))) {
      throw badRequest(`roles debe ser un subconjunto de [${ROLES.join(", ")}]`);
    }
    const user = await db("users")
      .where({ id: req.params.userId })
      .first()
      .catch(() => null);
    if (!user) throw notFound();

    await db.transaction(async (trx) => {
      // ADM-3 · nunca se deja el sistema sin un administrador ACTIVO: quitar «admin» al último es un 409.
      await lockAdminChanges(trx as unknown as Db);
      const wasAdmin = await trx("user_roles").where({ user_id: user.id, role: "admin" }).first("user_id");
      if (wasAdmin && !roles.includes("admin") && !(await otherActiveAdminExists(trx as unknown as Db, user.id))) {
        throw conflict("last_admin", "No se puede quitar el rol admin al último administrador activo");
      }
      await trx("user_roles").where({ user_id: user.id }).delete();
      if (roles.length > 0) {
        await trx("user_roles").insert(roles.map((role: string) => ({ user_id: user.id, role })));
      }
    });
    await audit(db, {
      actorId: req.auth!.userId,
      action: "admin.user.roles_set",
      target: `user:${user.id}`,
      detail: { roles },
      correlationId: req.correlationId,
    });
    res.json(userToJson(user, roles, { includePrivate: true }));
  });

  return router;
}
