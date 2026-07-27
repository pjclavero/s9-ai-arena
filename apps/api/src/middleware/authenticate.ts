/**
 * T7.2 · Autenticación por access token + sesión viva en BD.
 *
 * Comprueba la sesión en CADA petición: una sesión revocada o expirada rechaza
 * el token aunque el JWT siga siendo criptográficamente válido (DoD T7.2).
 */
import type { NextFunction, Request, Response } from "express";
import type { Db } from "../db/connection.js";
import { verifyAccessToken } from "../auth/tokens.js";
import { ROLE_RANK } from "../openapi.js";
import { unauthorized } from "../errors.js";
import { safeLookup } from "../../../../packages/game-rules/safe-lookup.js";
import type { RoleName } from "../db/migrations.js";

export function authenticate(db: Db) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return next(); // visitante anónimo

    const claims = verifyAccessToken(header.slice("Bearer ".length));
    if (!claims) return next(unauthorized("Token inválido o expirado"));

    const session = await db("sessions")
      .where({ id: claims.sid, user_id: claims.sub })
      .whereNull("revoked_at")
      .where("expires_at", ">", db.fn.now())
      .first();
    if (!session) return next(unauthorized("Sesión revocada o expirada"));

    const roles = (await db("user_roles").where({ user_id: claims.sub })).map((r: { role: RoleName }) => r.role);
    // B8 · `safeLookup`, NO `ROLE_RANK[r]`.
    //
    // Con la indexación directa, un rol "__proto__"/"constructor"/"toString"
    // devolvía `Object.prototype` — TRUTHY, así que el `?? 0` NO aplicaba y
    // `Math.max(0, Object.prototype)` daba NaN. `req.auth.rank = NaN` convierte
    // la guarda RBAC de registry.ts (`if (req.auth.rank < required) forbidden()`)
    // en SIEMPRE FALSA: cualquier ruta quedaría abierta.
    //
    // HONESTIDAD SOBRE EL ALCANCE: hoy NO es explotable desde fuera.
    // `user_roles.role` tiene FK contra `roles(name)` (db/migrations.ts) y esa
    // tabla solo se puebla con `ROLES`, así que una fila envenenada exige acceso
    // de escritura a la BD — quien lo tenga ya no necesita este bug. Esto es
    // DEFENSA EN PROFUNDIDAD: el día que se añada una gestión de roles (o un
    // proveedor de identidad externo que aporte `roles`) la FK deja de ser la
    // única barrera, y entonces el fallo sería una escalada real. Se cierra
    // ahora, que cuesta una línea.
    const rank = Math.max(0, ...roles.map((r: RoleName) => safeLookup(ROLE_RANK, r) ?? 0));
    req.auth = { userId: claims.sub, sessionId: claims.sid, roles, rank };

    // last_seen_at sin bloquear la petición
    db("sessions")
      .where({ id: session.id })
      .update({ last_seen_at: db.fn.now() })
      .catch(() => {});
    next();
  };
}
