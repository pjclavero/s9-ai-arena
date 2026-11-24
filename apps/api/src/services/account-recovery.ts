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
import { MIN_PASSWORD_LENGTH, hashPassword, passwordPolicyViolation } from "../auth/passwords.js";
import { hashToken } from "../auth/tokens.js";
import { ApiError, badRequest, conflict, forbidden, notFound, unauthorized } from "../errors.js";
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
  p: { q?: unknown; limit: number; cursor?: string },
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
): Promise<{ id: string; status: "active" | "blocked"; changed: boolean; sessionsRevoked: number }> {
  if (status !== "active" && status !== "blocked") throw badRequest("status debe ser active o blocked");
  if (targetId === ctx.actorId) {
    throw forbidden("No puedes bloquearte ni desbloquearte a ti mismo: pídeselo a otro administrador");
  }
  return db.transaction(async (trx) => {
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
      await t("users")
        .where({ id: targetId })
        .update({ status: "blocked", blocked_at: t.fn.now(), blocked_by: ctx.actorId, updated_at: t.fn.now() });
      sessionsRevoked = await revokeAllSessions(t, targetId);
      const voided = await voidOpenResets(t, targetId);
      await audit(t, {
        actorId: ctx.actorId,
        action: "admin.user.blocked",
        target: `user:${targetId}`,
        detail: { sessionsRevoked, recoveryTokensVoided: voided },
        correlationId: ctx.correlationId,
      });
    } else {
      await t("users")
        .where({ id: targetId })
        .update({ status: "active", blocked_at: null, blocked_by: null, updated_at: t.fn.now() });
      await audit(t, {
        actorId: ctx.actorId,
        action: "admin.user.unblocked",
        target: `user:${targetId}`,
        correlationId: ctx.correlationId,
      });
    }
    return { id: targetId, status, changed: true, sessionsRevoked };
  });
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

/** Consume (UNA vez) la aprobación de segundo admin de una cuenta ADMIN. Falla con un código claro si no vale. */
async function consumeSecondAdminApproval(trx: Db, ctx: Ctx, targetId: string, operationId: unknown): Promise<string> {
  if (typeof operationId !== "string" || operationId === "") {
    throw new ApiError(
      403,
      "second_admin_required",
      "La cuenta objetivo es de administrador: hace falta la aprobación de un segundo administrador (operationId)",
    );
  }
  const invalid = (msg: string) => new ApiError(403, "second_admin_approval_invalid", msg);
  if (!isUuid(operationId)) throw invalid("La aprobación no existe, ya se usó o no está vigente");
  const op = await trx("admin_operations")
    .where({ id: operationId, kind: "user.recovery_admin", status: "pending" })
    .forUpdate()
    .first();
  if (!op) throw invalid("La aprobación no existe, ya se usó o no está vigente");
  const params = op.params as { userId?: string };
  if (params.userId !== targetId) throw invalid("La aprobación es para otra cuenta");
  if (op.requested_by !== ctx.actorId) throw invalid("La aprobación la solicitó otro administrador");
  if (!op.confirmed_by || op.confirmed_by === ctx.actorId) {
    throw invalid("La aprobación debe ser de un segundo administrador distinto del solicitante");
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
      result: JSON.stringify({ tokenIssued: true }),
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
  const out = await db.transaction(async (trx) => {
    const t = trx as unknown as Db;
    const user = await t("users").where({ id: targetId }).forUpdate().first("id", "status");
    if (!user) throw notFound();
    if (user.status !== "active") {
      throw conflict("account_blocked", "La cuenta está bloqueada: desbloquéala antes de emitir un token");
    }
    const targetIsAdmin = !!(await t("user_roles").where({ user_id: targetId, role: "admin" }).first("user_id"));
    let operationId: string | null = null;
    if (targetIsAdmin) operationId = await consumeSecondAdminApproval(t, ctx, targetId, opts.operationId);
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
  });
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
  // Mismo texto que tenía la ruta (los clientes y tests existentes lo conocen).
  if (
    typeof token !== "string" ||
    token === "" ||
    token.length > 256 ||
    passwordPolicyViolation(newPassword) !== null
  ) {
    throw badRequest(`token y newPassword (≥${MIN_PASSWORD_LENGTH}) obligatorios`);
  }
  const passwordHash = await hashPassword(newPassword as string);
  return db.transaction(async (trx) => {
    const t = trx as unknown as Db;
    const [reset] = await t("password_resets")
      .where({ token_hash: hashToken(token) })
      .whereNull("used_at")
      .where("expires_at", ">", t.fn.now())
      .update({ used_at: t.fn.now() })
      .returning(["id", "user_id", "created_by", "issued_via_operation"]);
    if (!reset) throw unauthorized(INVALID_TOKEN);
    const user = await t("users").where({ id: reset.user_id }).forUpdate().first("id", "status");
    if (!user || user.status !== "active") throw unauthorized(INVALID_TOKEN); // deshace el consumo
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
  });
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
