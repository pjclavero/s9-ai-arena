/**
 * V1 ADM-3 · Usuarios operables desde la web y recuperación de cuentas (B5, D-OP-8).
 *
 * Garantías (cada una tiene su test en `adm3-users-recovery.test.ts` y su mutante en `scripts/adm3-mutants.py`):
 *  - el listado NUNCA devuelve hashes, secretos TOTP ni códigos de recuperación (proyección explícita);
 *  - el token de recuperación es aleatorio (192 bits), de UN solo uso (consumo atómico por UPDATE condicionado),
 *    caduca a los 30 min y en BD sólo está su hash SHA-256; emitir uno revoca los anteriores del usuario;
 *  - el administrador que lo emite NO conoce la contraseña: el usuario elige la suya al canjear el token;
 *  - si el objetivo es una cuenta ADMIN hace falta la aprobación de un SEGUNDO admin con el mecanismo de ADM-1
 *    (orden `user.recovery_admin`, confirmada por otro admin reautenticado, que el solicitante consume UNA vez);
 *  - canjear el token cambia la contraseña, cierra TODAS las sesiones del usuario y anula el resto de tokens,
 *    todo en una transacción, y queda en `audit_log` (sin el token);
 *  - bloquear una cuenta cierra sus sesiones y anula sus tokens abiertos; nunca se bloquea ni se deja sin rol
 *    al ÚLTIMO administrador activo ni uno a sí mismo.
 */
import { randomBytes } from "node:crypto";
import type { Db } from "../db/connection.js";
import { audit } from "../audit.js";
import { hashPassword, passwordPolicyViolation } from "../auth/passwords.js";
import { hashToken } from "../auth/tokens.js";
import { ApiError, badRequest, conflict, forbidden, notFound, unauthorized } from "../errors.js";
import { ROLES, type RoleName } from "../db/migrations.js";
import { isUuid } from "../params.js";
import { applyCursor, cursorTsSql, decodeCursor, encodeCursor, runCursorQuery } from "../serialize.js";

/** Vida de un token de recuperación. */
export const RECOVERY_TTL_MS = 30 * 60_000;
/** Tras la aprobación del segundo admin, el solicitante tiene este plazo para emitir el token. */
export const RECOVERY_APPROVAL_WINDOW_MS = 10 * 60_000;
/** Cerrojo consultivo (transacción) que serializa los cambios que pueden dejar el sistema sin admin activo. */
export const LAST_ADMIN_LOCK_KEY = 90230003;

export interface Ctx {
  actorId: string | null;
  correlationId?: string;
}

/**
 * Un interbloqueo de PostgreSQL (40P01) entre dos operaciones sobre la misma cuenta se deshace solo: se devuelve un
 * 409 controlado y reintentable, nunca un 500.
 */
export async function mapDeadlock<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (e) {
    if ((e as { code?: string }).code === "40P01") {
      throw conflict("concurrent_change", "Otra operación afectó a la misma cuenta a la vez: reintenta");
    }
    throw e;
  }
}

const EMAIL_ESCAPE = /[\\%_]/g;

// ------------------------------------------------------------------ listado
export interface AdminUserView {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  status: "active" | "blocked";
  twoFactorEnabled: boolean;
  recoveryPending: boolean;
  createdAt: string;
  blockedAt: string | null;
}

export const MAX_SEARCH_LENGTH = 100;

/**
 * Listado paginado por cursor (nunca offset) con búsqueda por nombre o email. La proyección es EXPLÍCITA: no se
 * selecciona `password_hash`, `totp_secret` ni `recovery_codes` (2FA sólo como booleano).
 */
export async function listUsers(
  db: Db,
  p: { q?: unknown; limit: number; cursor?: string; id?: string },
): Promise<{ items: AdminUserView[]; nextCursor?: string }> {
  let q: string | undefined;
  if (p.q !== undefined && p.q !== "") {
    if (typeof p.q !== "string") throw badRequest("q debe ser texto");
    q = p.q.trim();
    if (q.length > MAX_SEARCH_LENGTH) throw badRequest(`q admite como máximo ${MAX_SEARCH_LENGTH} caracteres`);
  }
  const cursor = decodeCursor(p.cursor);
  let query = db("users as u")
    .select(
      "u.id",
      "u.email",
      "u.display_name",
      "u.status",
      "u.created_at",
      "u.blocked_at",
      db.raw("(u.totp_secret IS NOT NULL) AS two_factor"),
      db.raw(
        "COALESCE((SELECT array_agg(r.role ORDER BY r.role) FROM user_roles r WHERE r.user_id = u.id), '{}') AS roles",
      ),
      db.raw(
        "EXISTS (SELECT 1 FROM password_resets pr WHERE pr.user_id = u.id AND pr.used_at IS NULL AND pr.expires_at > now()) AS recovery_pending",
      ),
      db.raw(cursorTsSql("u.created_at")),
    )
    .orderBy([
      { column: "u.created_at", order: "desc" },
      { column: "u.id", order: "desc" },
    ])
    .limit(p.limit + 1);
  if (p.id) query = query.where("u.id", p.id);
  if (q) {
    // Los comodines del usuario se escapan: «%» o «_» buscan esos caracteres, no «todo».
    const like = `%${q.toLowerCase().replace(EMAIL_ESCAPE, (c) => `\\${c}`)}%`;
    query = query.where((b) =>
      b.whereRaw("lower(u.display_name) LIKE ? ESCAPE '\\'", [like]).orWhereRaw("u.email LIKE ? ESCAPE '\\'", [like]),
    );
  }
  query = applyCursor(query, cursor, "u.created_at", ["u.id"]);
  const rows = await runCursorQuery(query, cursor);
  const page = rows.slice(0, p.limit);
  return {
    items: page.map((r) => ({
      id: r.id,
      email: r.email,
      displayName: r.display_name,
      roles: r.roles,
      status: r.status,
      twoFactorEnabled: r.two_factor === true,
      recoveryPending: r.recovery_pending === true,
      createdAt: new Date(r.created_at).toISOString(),
      blockedAt: r.blocked_at ? new Date(r.blocked_at).toISOString() : null,
    })),
    nextCursor: rows.length > p.limit ? encodeCursor(page[page.length - 1], [page[page.length - 1].id]) : undefined,
  };
}

/** Un usuario por id (misma proyección que el listado), o 404. */
export async function getAdminUser(db: Db, id: string): Promise<AdminUserView> {
  const r = await listUsers(db, { id, limit: 1 });
  if (r.items.length === 0) throw notFound();
  return r.items[0];
}

// ------------------------------------------------------------ último admin
/** ¿Queda algún administrador ACTIVO distinto de `exceptUserId`? (dentro de la transacción y con el cerrojo). */
export async function otherActiveAdminExists(db: Db, exceptUserId: string): Promise<boolean> {
  const r = await db("user_roles as r")
    .join("users as u", "u.id", "r.user_id")
    .where("r.role", "admin")
    .where("u.status", "active")
    .whereNot("u.id", exceptUserId)
    .first("u.id");
  return !!r;
}

export async function lockAdminChanges(trx: Db): Promise<void> {
  await trx.raw("SELECT pg_advisory_xact_lock(?)", [LAST_ADMIN_LOCK_KEY]);
}

// ------------------------------------------------------------------- estado
async function voidOpenResets(trx: Db, userId: string): Promise<number> {
  return trx("password_resets").where({ user_id: userId }).whereNull("used_at").update({ used_at: trx.fn.now() });
}

async function revokeAllSessions(trx: Db, userId: string): Promise<number> {
  return trx("sessions").where({ user_id: userId }).whereNull("revoked_at").update({ revoked_at: trx.fn.now() });
}

export async function setUserStatus(
  db: Db,
  ctx: Ctx,
  targetId: string,
  status: "active" | "blocked",
  opts: { operationId?: unknown } = {},
): Promise<{ id: string; status: "active" | "blocked"; changed: boolean; sessionsRevoked: number }> {
  if (status !== "active" && status !== "blocked") throw badRequest("status debe ser active o blocked");
  if (targetId === ctx.actorId) {
    throw forbidden("No puedes bloquearte ni desbloquearte a ti mismo: pídeselo a otro administrador");
  }
  return mapDeadlock(
    db.transaction(async (trx) => {
      const t = trx as unknown as Db;
      await lockAdminChanges(t);
      const user = await t("users").where({ id: targetId }).forUpdate().first("id", "status");
      if (!user) throw notFound();
      if (user.status === status) return { id: targetId, status, changed: false, sessionsRevoked: 0 };
      let sessionsRevoked = 0;
      if (status === "blocked") {
        const isAdmin = await t("user_roles").where({ user_id: targetId, role: "admin" }).first("user_id");
        if (isAdmin && !(await otherActiveAdminExists(t, targetId))) {
          throw conflict("last_admin", "No se puede bloquear al último administrador activo");
        }
        // Bloquear a OTRA cuenta admin exige la aprobación de otro admin activo (`user.block_admin`): así un admin no
        // puede quedarse solo a la fuerza (cierra la cadena «bloquear a los demás, conceder a un títere, recuperar»).
        let approval: string | null = null;
        if (isAdmin) {
          approval = await requireSecondAdmin(
            t,
            ctx,
            "user.block_admin",
            targetId,
            opts.operationId,
            "Bloquear a otra cuenta admin exige la aprobación de otro administrador activo y no hay ninguno disponible: hazlo por consola",
          );
        }
        await t("users")
          .where({ id: targetId })
          .update({ status: "blocked", blocked_at: t.fn.now(), blocked_by: ctx.actorId, updated_at: t.fn.now() });
        sessionsRevoked = await revokeAllSessions(t, targetId);
        const voided = await voidOpenResets(t, targetId);
        await audit(t, {
          actorId: ctx.actorId,
          action: "admin.user.blocked",
          target: `user:${targetId}`,
          detail: { sessionsRevoked, recoveryTokensVoided: voided, secondAdminOperation: approval },
          correlationId: ctx.correlationId,
        });
      } else {
        // Desbloquear a una cuenta ADMIN también exige la aprobación de otro admin activo (`user.unblock_admin`).
        const wasAdmin = await t("user_roles").where({ user_id: targetId, role: "admin" }).first("user_id");
        let approval: string | null = null;
        if (wasAdmin) {
          approval = await requireSecondAdmin(
            t,
            ctx,
            "user.unblock_admin",
            targetId,
            opts.operationId,
            "Desbloquear a otra cuenta admin exige la aprobación de otro administrador activo y no hay ninguno disponible: hazlo por consola",
          );
        }
        await t("users")
          .where({ id: targetId })
          .update({ status: "active", blocked_at: null, blocked_by: null, updated_at: t.fn.now() });
        await audit(t, {
          actorId: ctx.actorId,
          action: "admin.user.unblocked",
          target: `user:${targetId}`,
          detail: { secondAdminOperation: approval },
          correlationId: ctx.correlationId,
        });
      }
      return { id: targetId, status, changed: true, sessionsRevoked };
    }),
  );
}

// ------------------------------------------------- emisión del token (admin)
/** Inserta un token de recuperación. Devuelve el token en claro: es la ÚNICA vez que existe fuera del hash. */
export async function createPasswordReset(
  db: Db,
  userId: string,
  opts: { createdBy?: string | null; operationId?: string | null } = {},
): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await db("password_resets").insert({
    user_id: userId,
    token_hash: hashToken(token),
    expires_at: new Date(Date.now() + RECOVERY_TTL_MS),
    created_by: opts.createdBy ?? null,
    issued_via_operation: opts.operationId ?? null,
  });
  return token;
}

/**
 * LINAJE de promoción de `userId` en el grafo `users.admin_granted_by`: todos sus ANCESTROS (quien lo promovió, quien
 * promovió a éste…) y todos sus DESCENDIENTES (a quién promovió, y a quién promovieron ésos…), a cualquier profundidad.
 * Un aprobador del linaje del solicitante NUNCA es válido: es la defensa contra el admin «títere» en ambas direcciones
 * y a cualquier número de saltos (A → X → Y).
 */
export async function lineageIds(db: Db, userId: string): Promise<string[]> {
  const r = await db.raw(
    `WITH RECURSIVE up(id) AS (
       SELECT admin_granted_by FROM users WHERE id = ? AND admin_granted_by IS NOT NULL
       UNION
       SELECT u.admin_granted_by FROM users u JOIN up ON u.id = up.id WHERE u.admin_granted_by IS NOT NULL
     ), down(id) AS (
       SELECT id FROM users WHERE admin_granted_by = ?
       UNION
       SELECT u.id FROM users u JOIN down d ON u.admin_granted_by = d.id
     )
     SELECT id FROM up UNION SELECT id FROM down`,
    [userId, userId],
  );
  return (r.rows as { id: string }[]).map((x) => x.id);
}

/** ¿Existe algún OTRO admin, esté activo o bloqueado? (el bootstrap sólo es posible si NO existe ninguno). */
export async function otherAdminExists(db: Db, exceptUserId: string): Promise<boolean> {
  return !!(await db("user_roles").where({ role: "admin" }).whereNot({ user_id: exceptUserId }).first("user_id"));
}

/**
 * ¿Hay algún admin ACTIVO fuera de `excluded` que pueda aprobar una orden de `requesterId`? Nunca cuentan los de su
 * linaje de promoción (ancestros ni descendientes, a cualquier profundidad).
 */
export async function approverAvailable(db: Db, excluded: string[], requesterId?: string | null): Promise<boolean> {
  const lineage = requesterId ? await lineageIds(db, requesterId) : [];
  return !!(await db("user_roles as r")
    .join("users as u", "u.id", "r.user_id")
    .where({ "r.role": "admin", "u.status": "active" })
    .whereNotIn("u.id", [...excluded, ...lineage])
    .first("u.id"));
}

export type ApprovalKind =
  "user.recovery_admin" | "user.revoke_admin" | "user.grant_admin" | "user.block_admin" | "user.unblock_admin";

/** Sin `operationId`: 409 si no hay quién pueda aprobar, 403 si hace falta pedirla; con él, la consume (una vez). */
async function requireSecondAdmin(
  t: Db,
  ctx: Ctx,
  kind: ApprovalKind,
  targetId: string,
  operationId: unknown,
  unavailableMsg: string,
): Promise<string> {
  if (typeof operationId !== "string" || operationId === "") {
    if (!(await approverAvailable(t, [ctx.actorId ?? "", targetId], ctx.actorId))) {
      throw conflict("second_admin_unavailable", unavailableMsg);
    }
  }
  return consumeSecondAdminApproval(t, ctx, kind, targetId, operationId);
}

/**
 * Consume (UNA vez) la aprobación de segundo admin de una acción sobre una cuenta ADMIN (`kind`:
 * `user.recovery_admin` o `user.revoke_admin`). Falla con un código claro si no vale.
 */
export async function consumeSecondAdminApproval(
  trx: Db,
  ctx: Ctx,
  kind: ApprovalKind,
  targetId: string,
  operationId: unknown,
): Promise<string> {
  if (typeof operationId !== "string" || operationId === "") {
    throw new ApiError(
      403,
      "second_admin_required",
      "La cuenta objetivo es de administrador: hace falta la aprobación de un segundo administrador (operationId)",
    );
  }
  const invalid = (msg: string) => new ApiError(403, "second_admin_approval_invalid", msg);
  if (!isUuid(operationId)) throw invalid("La aprobación no existe, ya se usó o no está vigente");
  const op = await trx("admin_operations").where({ id: operationId, kind, status: "pending" }).forUpdate().first();
  if (!op) throw invalid("La aprobación no existe, ya se usó o no está vigente");
  const params = op.params as { userId?: string };
  if (params.userId !== targetId) throw invalid("La aprobación es para otra cuenta");
  if (op.requested_by !== ctx.actorId) throw invalid("La aprobación la solicitó otro administrador");
  if (!op.confirmed_by || op.confirmed_by === ctx.actorId) {
    throw invalid("La aprobación debe ser de un segundo administrador distinto del solicitante");
  }
  // Quien aprobó debe SEGUIR siendo admin activo al consumirse (puede haberlo bloqueado o degradado desde entonces).
  const approver = await trx("users as u")
    .join("user_roles as r", "r.user_id", "u.id")
    .where({ "u.id": op.confirmed_by, "u.status": "active", "r.role": "admin" })
    .first("u.id");
  if (!approver) throw invalid("Quien aprobó ya no es administrador activo: solicítala de nuevo");
  // El objetivo nunca aprueba lo suyo, ni nadie del LINAJE de promoción del solicitante (admin «títere»).
  if (approver.id === targetId) throw invalid("La cuenta objetivo no puede aprobar la acción sobre sí misma");
  if ((await lineageIds(trx, op.requested_by as string)).includes(approver.id as string)) {
    throw invalid("Quien aprobó está en el linaje de promoción del solicitante: hace falta otro administrador");
  }
  if (!op.confirmed_at || Date.now() - new Date(op.confirmed_at).getTime() > RECOVERY_APPROVAL_WINDOW_MS) {
    throw invalid("La aprobación caducó: solicítala de nuevo");
  }
  // pending → running → done en la misma transacción: un solo uso, con las transiciones legales del trigger.
  await trx("admin_operations")
    .where({ id: op.id, status: "pending" })
    .update({
      status: "running",
      lease_owner: "api:recovery",
      lease_expires_at: new Date(Date.now() + 60_000),
      started_at: trx.fn.now(),
      attempts: 1,
    });
  await trx("admin_operations")
    .where({ id: op.id, status: "running" })
    .update({
      status: "done",
      result: JSON.stringify({ consumed: true }),
      finished_at: trx.fn.now(),
      lease_owner: null,
      lease_expires_at: null,
    });
  return op.id as string;
}

export async function issueRecoveryToken(
  db: Db,
  ctx: Ctx,
  targetId: string,
  opts: { operationId?: unknown },
): Promise<{ token: string; expiresAt: string; userId: string }> {
  if (targetId === ctx.actorId) {
    throw badRequest("Para tu propia cuenta usa «Mi cuenta» (cambio de contraseña), no un token de recuperación");
  }
  const out = await mapDeadlock(
    db.transaction(async (trx) => {
      const t = trx as unknown as Db;
      const user = await t("users").where({ id: targetId }).forUpdate().first("id", "status");
      if (!user) throw notFound();
      if (user.status !== "active") {
        throw conflict("account_blocked", "La cuenta está bloqueada: desbloquéala antes de emitir un token");
      }
      const targetIsAdmin = !!(await t("user_roles").where({ user_id: targetId, role: "admin" }).first("user_id"));
      let operationId: string | null = null;
      if (targetIsAdmin)
        operationId = await consumeSecondAdminApproval(t, ctx, "user.recovery_admin", targetId, opts.operationId);
      const voided = await voidOpenResets(t, targetId);
      const token = await createPasswordReset(t, targetId, { createdBy: ctx.actorId, operationId });
      const expiresAt = new Date(Date.now() + RECOVERY_TTL_MS).toISOString();
      // El token NUNCA va a la auditoría ni a ningún log.
      await audit(t, {
        actorId: ctx.actorId,
        action: "admin.user.recovery_token_issued",
        target: `user:${targetId}`,
        detail: {
          expiresInMinutes: RECOVERY_TTL_MS / 60_000,
          previousTokensVoided: voided,
          secondAdminOperation: operationId,
        },
        correlationId: ctx.correlationId,
      });
      return { token, expiresAt, userId: targetId };
    }),
  );
  return out;
}

// ------------------------------------------------------ canje (el usuario)
const INVALID_TOKEN = "Token de recuperación inválido o expirado";

/**
 * Canjea el token y fija la contraseña elegida por el usuario. El consumo es ATÓMICO (un UPDATE condicionado
 * a «no usado y vigente»): dos canjes simultáneos del mismo token, uno solo gana. Cuenta bloqueada o inexistente:
 * el mismo 401 genérico y el token NO se consume (la transacción se deshace).
 */
export async function redeemRecoveryToken(
  db: Db,
  ctx: { correlationId?: string; ip?: string },
  token: unknown,
  newPassword: unknown,
): Promise<{ userId: string }> {
  if (typeof token !== "string" || token === "" || token.length > 256) throw badRequest("token obligatorio");
  // El texto sale de la función ÚNICA de política: si cambia la política, cambia el mensaje (no hay copia aquí).
  const violation = passwordPolicyViolation(newPassword, "La nueva contraseña");
  if (violation) throw badRequest(violation);
  const passwordHash = await hashPassword(newPassword as string);
  return mapDeadlock(
    db.transaction(async (trx) => {
      const t = trx as unknown as Db;
      const hash = hashToken(token);
      // Mismo orden de bloqueos que bloquear/emitir (primero la fila de `users`, luego los tokens): sin interbloqueo.
      const found = await t("password_resets").where({ token_hash: hash }).first("user_id");
      if (!found) throw unauthorized(INVALID_TOKEN);
      const user = await t("users").where({ id: found.user_id }).forUpdate().first("id", "status");
      const [reset] = await t("password_resets")
        .where({ token_hash: hash })
        .whereNull("used_at")
        .where("expires_at", ">", t.fn.now())
        .update({ used_at: t.fn.now() })
        .returning(["id", "user_id", "created_by", "issued_via_operation"]);
      if (!reset) throw unauthorized(INVALID_TOKEN);
      if (!user || user.status !== "active") throw unauthorized(INVALID_TOKEN); // deshace el consumo
      // El rol se mira AHORA, no al emitir: una cuenta que es admin en el canje sólo se recupera con un token emitido
      // con la aprobación de un segundo admin (cierra «degradar, emitir, re-promover, canjear» y «emitir y promover»).
      const isAdminNow = await t("user_roles").where({ user_id: user.id, role: "admin" }).first("user_id");
      if (isAdminNow && !reset.issued_via_operation) throw unauthorized(INVALID_TOKEN); // deshace el consumo
      await t("users").where({ id: user.id }).update({ password_hash: passwordHash, updated_at: t.fn.now() });
      const sessionsRevoked = await revokeAllSessions(t, user.id);
      const voided = await voidOpenResets(t, user.id);
      // La recuperación NO toca el 2FA (DoD T7.2): el siguiente login sigue exigiendo TOTP.
      await audit(t, {
        actorId: user.id,
        action: "auth.password.reset",
        target: `user:${user.id}`,
        detail: { sessionsRevoked, otherTokensVoided: voided, issuedBy: reset.created_by ?? null, ip: ctx.ip ?? null },
        correlationId: ctx.correlationId,
      });
      return { userId: user.id as string };
    }),
  );
}

// ------------------------------------------------------------------- roles
export interface RoleChangePlan {
  before: string[];
  /** Se concede «admin» a quien no lo tenía. */
  grantsAdmin: boolean;
  /** Se quita «admin» a quien lo tenía. */
  revokesAdmin: boolean;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

export function planRoleChange(before: string[], after: string[]): RoleChangePlan {
  return {
    before,
    grantsAdmin: after.includes("admin") && !before.includes("admin"),
    revokesAdmin: before.includes("admin") && !after.includes("admin"),
  };
}

/** Roles actuales de una cuenta (lectura sin bloqueo, para decidir si hace falta reautenticar). */
export async function currentRoles(db: Db, userId: string): Promise<string[]> {
  return (await db("user_roles").where({ user_id: userId })).map((r: { role: string }) => r.role);
}

/**
 * Asignar roles (reemplaza el conjunto). Reglas de ADM-3:
 *  - cualquier cambio del conjunto anula los tokens de recuperación abiertos de la cuenta;
 *  - conceder «admin» y quitarlo (a uno mismo o a otra cuenta) exigen REAUTENTICACIÓN (`reauthed`, hecha por la ruta);
 *  - quitar «admin» a OTRA cuenta exige además la aprobación de un admin distinto del solicitante (orden
 *    `user.revoke_admin`, consumida una vez); si no hay otro admin que pueda aprobar, 409 `second_admin_unavailable`;
 *  - nunca se deja el sistema sin un admin ACTIVO (409 `last_admin`).
 */
export async function setUserRoles(
  db: Db,
  ctx: Ctx,
  targetId: string,
  roles: string[],
  opts: { operationId?: unknown; reauthed: boolean },
): Promise<string[]> {
  for (const r of roles) if (!ROLES.includes(r as RoleName)) throw badRequest(`rol desconocido: ${r}`);
  const wanted = [...new Set(roles)];
  return mapDeadlock(
    db.transaction(async (trx) => {
      const t = trx as unknown as Db;
      await lockAdminChanges(t);
      const user = await t("users").where({ id: targetId }).forUpdate().first("id");
      if (!user) throw notFound();
      const before = await currentRoles(t, targetId);
      const plan = planRoleChange(before, wanted);
      if ((plan.grantsAdmin || plan.revokesAdmin) && !opts.reauthed) {
        throw conflict("roles_changed_concurrently", "Los roles de la cuenta cambiaron mientras tanto: reintenta");
      }
      let operationId: string | null = null;
      let bootstrap = false;
      if (plan.revokesAdmin) {
        if (!(await otherActiveAdminExists(t, targetId))) {
          throw conflict("last_admin", "No se puede quitar el rol admin al último administrador activo");
        }
        if (targetId !== ctx.actorId) {
          operationId = await requireSecondAdmin(
            t,
            ctx,
            "user.revoke_admin",
            targetId,
            opts.operationId,
            "Quitar el rol admin a otra cuenta exige la aprobación de un tercer administrador y no hay ninguno: que la propia cuenta se lo quite (reautenticada) o hazlo por consola",
          );
          // (Si falla, la transacción se deshace y la aprobación NO se gasta.) Una aprobación de «quitar admin» sólo autoriza eso: los demás roles de la cuenta deben quedar como están.
          if (
            !sameSet(
              wanted,
              before.filter((r) => r !== "admin"),
            )
          ) {
            throw badRequest("Quitar el rol admin a otra cuenta sólo admite los roles actuales menos admin");
          }
        }
      }
      if (plan.grantsAdmin && targetId !== ctx.actorId) {
        // Con OTRO admin activo además del solicitante, conceder admin exige su aprobación (`user.grant_admin`): un
        // admin no se fabrica un segundo admin. Si el solicitante es el ÚNICO admin activo basta la reautenticación
        // (bootstrap del segundo admin), y queda auditado.
        if (await otherAdminExists(t, ctx.actorId ?? "")) {
          operationId = await requireSecondAdmin(
            t,
            ctx,
            "user.grant_admin",
            targetId,
            opts.operationId,
            "Conceder admin exige la aprobación de otro administrador activo y ninguno puede aprobarla (los promovidos por ti no cuentan): hazlo por consola",
          );
        } else {
          bootstrap = true;
        }
      }
      const changed = !sameSet(before, wanted);
      let voided = 0;
      if (changed) {
        await t("user_roles").where({ user_id: targetId }).delete();
        if (wanted.length > 0) await t("user_roles").insert(wanted.map((role) => ({ user_id: targetId, role })));
        voided = await voidOpenResets(t, targetId);
        // Quién concedió el rol admin (para que un promovido no apruebe órdenes de su promotor).
        if (plan.grantsAdmin) await t("users").where({ id: targetId }).update({ admin_granted_by: ctx.actorId });
      }
      await audit(t, {
        actorId: ctx.actorId,
        action: "admin.user.roles_set",
        target: `user:${targetId}`,
        detail: { roles: wanted, changed, recoveryTokensVoided: voided, secondAdminOperation: operationId, bootstrap },
        correlationId: ctx.correlationId,
      });
      return wanted;
    }),
  );
}

// ----------------------------------------------------------------- CLI local
export class ResetPasswordCliError extends Error {
  constructor(
    readonly code: "invalid_input" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Vía de EMERGENCIA con acceso local privilegiado (D-OP-8: instalación con un solo administrador). Fija la contraseña
 * (política única), cierra las sesiones, anula los tokens abiertos y lo audita SIN la contraseña. No cambia el 2FA ni
 * el estado de bloqueo.
 */
export async function resetPasswordLocal(
  db: Db,
  input: { email: string; password: string },
): Promise<{ userId: string; email: string; blocked: boolean; sessionsRevoked: number }> {
  if (typeof input.email !== "string" || input.email === "")
    throw new ResetPasswordCliError("invalid_input", "email obligatorio");
  const violation = passwordPolicyViolation(input.password);
  if (violation) throw new ResetPasswordCliError("invalid_input", violation);
  const email = input.email.toLowerCase();
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (trx) => {
    const t = trx as unknown as Db;
    const user = await t("users").where({ email }).forUpdate().first("id", "status");
    if (!user) throw new ResetPasswordCliError("not_found", "No existe ninguna cuenta con ese email");
    await t("users").where({ id: user.id }).update({ password_hash: passwordHash, updated_at: t.fn.now() });
    const sessionsRevoked = await revokeAllSessions(t, user.id);
    const voided = await voidOpenResets(t, user.id);
    const admins = await t("user_roles").where({ role: "admin" }).countDistinct({ n: "user_id" }).first();
    await audit(t, {
      action: "admin.reset_password_cli",
      target: `user:${user.id}`,
      detail: {
        via: "cli",
        sessionsRevoked,
        recoveryTokensVoided: voided,
        admins: Number((admins as { n: string | number }).n),
      },
    });
    return { userId: user.id as string, email, blocked: user.status === "blocked", sessionsRevoked };
  });
}
