/**
 * T7.2 · Registro, login (Argon2id + TOTP), refresh con rotación, sesiones,
 * 2FA y recuperación de cuenta (extensión documentada: no elude el 2FA).
 */
import { Router } from "express";
import { randomBytes } from "node:crypto";
import type { Db } from "../db/connection.js";
import { defineOperation, defineExtension } from "../registry.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import {
  ACCESS_TOKEN_TTL_S,
  REFRESH_ABSOLUTE_TTL_S,
  REFRESH_TOKEN_TTL_S,
  hashToken,
  newRefreshToken,
  signAccessToken,
} from "../auth/tokens.js";
import { generateRecoveryCodes, generateTotpSecret, totpUri, verifyTotp } from "../auth/totp.js";
import { audit } from "../audit.js";
import { badRequest, conflict, forbidden, notFound, tooMany, unauthorized } from "../errors.js";
import { rateLimit } from "../middleware/rate-limit.js";
import type { LoginGuardLike, RateLimiterLike } from "../middleware/shared-rate-limit.js";
import { sessionToJson, userToJson } from "../serialize.js";
import { ROLE_RANK } from "../openapi.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * R3.7 (ERR-VIS-03) · Sesión persistente del panel: el refresh token viaja
 * además en una cookie httpOnly (inaccesible a JS). El navegador la reenvía en
 * POST /auth/refresh tras un F5, así el panel recupera la sesión sin guardar
 * ningún token en localStorage. El body con refreshToken sigue funcionando
 * (compatibilidad con clientes no-navegador); si vienen ambos, manda el body.
 */
const REFRESH_COOKIE = "s9_refresh";

export function refreshTokenFromCookie(req: { headers: Record<string, unknown> }): string | null {
  const header = req.headers["cookie"];
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === REFRESH_COOKIE) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function setRefreshCookie(
  res: { cookie: (n: string, v: string, o: Record<string, unknown>) => void },
  token: string,
  req: { secure?: boolean },
): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure === true, // tras el gateway TLS el proxy marca la conexión segura
    path: "/", // el panel llama vía /api/v1/auth/* reescrito por el proxy: path amplio a propósito
    maxAge: REFRESH_TOKEN_TTL_S * 1000,
  });
}

function clearRefreshCookie(res: { cookie: (n: string, v: string, o: Record<string, unknown>) => void }): void {
  res.cookie(REFRESH_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
}

export interface AuthDeps {
  db: Db;
  // R2.5 (ERR-SEC-14): contratos, no clases en memoria — en producción se
  // inyectan las variantes sobre api_usage, cuyo estado sobrevive a reinicios.
  loginGuard: LoginGuardLike;
  registerLimiter: RateLimiterLike;
  loginLimiter: RateLimiterLike;
  /** R2.4 (ERR-SEC-08): el refresh también se limita — es un endpoint de credenciales. */
  refreshLimiter: RateLimiterLike;
}

/**
 * R2.4 (ERR-SEC-11) · Anti-enumeración: cuando el email NO existe se verifica la
 * contraseña contra este hash SEÑUELO de Argon2id, de modo que ambas ramas del
 * login pagan el mismo coste computacional y el tiempo de respuesta no delata si
 * la cuenta existe. El señuelo es aleatorio por proceso: nunca coincide con nada.
 */
const decoyHashPromise: Promise<string> = hashPassword(randomBytes(32).toString("base64url"));

async function createSession(db: Db, userId: string, req: { headers: Record<string, unknown>; ip?: string }) {
  const { token, hash } = newRefreshToken();
  const now = Date.now();
  const [session] = await db("sessions")
    .insert({
      user_id: userId,
      refresh_token_hash: hash,
      user_agent: String(req.headers["user-agent"] ?? ""),
      ip: req.ip ?? null,
      expires_at: new Date(now + REFRESH_TOKEN_TTL_S * 1000),
      // R2.4 (ERR-SEC-08): tope ABSOLUTO de la familia; la rotación nunca lo mueve.
      absolute_expires_at: new Date(now + REFRESH_ABSOLUTE_TTL_S * 1000),
    })
    .returning("*");
  // Cabeza de la familia de refresh tokens (detección de reutilización, R2.4).
  await db("session_refresh_tokens").insert({ session_id: session.id, token_hash: hash });
  return {
    accessToken: signAccessToken({ sub: userId, sid: session.id }),
    refreshToken: token,
    expiresIn: ACCESS_TOKEN_TTL_S,
  };
}

/**
 * R2.4 · Reautenticación FUERTE para operaciones sensibles: contraseña + (si hay
 * 2FA activo) TOTP o código de recuperación. Un access token robado NO basta.
 */
async function requireStrongReauth(
  db: Db,
  user: Record<string, unknown>,
  body: { password?: unknown; totp?: unknown },
): Promise<void> {
  if (typeof body.password !== "string" || !(await verifyPassword(String(user.password_hash), body.password))) {
    throw unauthorized("Reautenticación requerida: contraseña inválida");
  }
  if (user.totp_secret) {
    const codeOk =
      (typeof body.totp === "string" && (await verifyTotp(body.totp, String(user.totp_secret)))) ||
      (typeof body.totp === "string" && (await consumeRecoveryCode(db, user, body.totp)));
    if (!codeOk) throw unauthorized("Reautenticación requerida: código TOTP o de recuperación inválido");
  }
}

/** R2.4 · Cambiar el estado del 2FA revoca TODAS las demás sesiones del usuario. */
async function revokeOtherSessions(db: Db, userId: string, keepSessionId: string): Promise<number> {
  return db("sessions")
    .where({ user_id: userId })
    .whereNot({ id: keepSessionId })
    .whereNull("revoked_at")
    .update({ revoked_at: db.fn.now() });
}

export function authRoutes(deps: AuthDeps): Router {
  const { db, loginGuard } = deps;
  const router = Router();

  // ------------------------------------------------------------- register
  defineOperation(
    router,
    "register",
    async (req, res) => {
      const { email, password, displayName } = req.body ?? {};
      if (typeof email !== "string" || !EMAIL_RE.test(email)) throw badRequest("email inválido");
      if (typeof password !== "string" || password.length < 12) {
        throw badRequest("La contraseña debe tener al menos 12 caracteres");
      }
      if (typeof displayName !== "string" || !displayName || displayName.length > 48) {
        throw badRequest("displayName obligatorio (máx. 48)");
      }
      const normalized = email.toLowerCase();
      if (await db("users").where({ email: normalized }).first()) {
        throw conflict("email_taken", "Ya existe una cuenta con ese email");
      }
      const [user] = await db("users")
        .insert({ email: normalized, password_hash: await hashPassword(password), display_name: displayName })
        .returning("*");
      // Una cuenta nueva es usuario y desarrolladora: puede crear bots y subir código.
      await db("user_roles").insert([
        { user_id: user.id, role: "user" },
        { user_id: user.id, role: "developer" },
      ]);
      res.status(201).json(userToJson(user, ["user", "developer"], { includePrivate: true }));
    },
    rateLimit(deps.registerLimiter, "register"),
  );

  // ---------------------------------------------------------------- login
  defineOperation(
    router,
    "login",
    async (req, res) => {
      const { email, password, totp } = req.body ?? {};
      if (typeof email !== "string" || typeof password !== "string") throw badRequest("email y password obligatorios");
      const key = `${req.ip}|${email.toLowerCase()}`;

      if (await loginGuard.isBlocked(key)) {
        throw tooMany("Demasiados intentos fallidos: bloqueo temporal");
      }

      const user = await db("users").where({ email: email.toLowerCase() }).first();
      // R2.4 (ERR-SEC-11) · Anti-enumeración: Argon2id se ejecuta SIEMPRE. Si el
      // email no existe se verifica contra el hash señuelo (siempre falla), de modo
      // que ambas ramas tienen el mismo coste y el timing no delata cuentas.
      const ok = user
        ? await verifyPassword(user.password_hash, password)
        : (await verifyPassword(await decoyHashPromise, password), false);
      if (!ok) {
        const blocked = await loginGuard.recordFailure(key);
        if (blocked) {
          await audit(db, {
            action: "auth.login.blocked",
            target: `email:${email.toLowerCase()}`,
            detail: { ip: req.ip, reason: "brute_force" },
            correlationId: req.correlationId,
          });
        }
        throw unauthorized("Credenciales inválidas");
      }

      if (user.totp_secret) {
        const codeOk =
          (typeof totp === "string" && (await verifyTotp(totp, user.totp_secret))) ||
          (typeof totp === "string" && (await consumeRecoveryCode(db, user, totp)));
        if (!codeOk) {
          await loginGuard.recordFailure(key);
          throw unauthorized("Se requiere un código TOTP válido (2FA activo)");
        }
      }

      await loginGuard.recordSuccess(key);
      const session = await createSession(db, user.id, req);
      setRefreshCookie(res, session.refreshToken, req); // R3.7: sesión persistente del panel
      res.status(200).json(session);
    },
    rateLimit(deps.loginLimiter, "login"),
  );

  // -------------------------------------------------------------- refresh
  // R2.4 (ERR-SEC-08) · Rotación con FAMILIAS: cada sesión es una familia y cada
  // hash emitido queda en session_refresh_tokens. Presentar un token YA ROTADO es
  // señal inequívoca de robo (alguien tiene una copia antigua) → se revoca la
  // familia ENTERA y se deja registro de auditoría. Además: vida máxima absoluta
  // (absolute_expires_at) y rate-limit propio.
  defineOperation(
    router,
    "refreshToken",
    async (req, res) => {
      // R3.7: acepta el token del body (contrato) o de la cookie httpOnly (panel).
      const provided = typeof req.body?.refreshToken === "string" ? req.body.refreshToken : refreshTokenFromCookie(req);
      if (typeof provided !== "string" || !provided) throw badRequest("refreshToken obligatorio (body o cookie)");
      const presented = hashToken(provided);

      const known = await db("session_refresh_tokens").where({ token_hash: presented }).first();
      if (!known) throw unauthorized("Refresh token inválido, revocado o expirado");
      const session = await db("sessions").where({ id: known.session_id }).first();
      if (!session) throw unauthorized("Refresh token inválido, revocado o expirado");

      if (known.rotated_at) {
        // REUTILIZACIÓN detectada: el token ya fue canjeado. Revocar la familia.
        if (!session.revoked_at) {
          await db("sessions").where({ id: session.id }).update({ revoked_at: db.fn.now() });
        }
        await audit(db, {
          actorId: session.user_id,
          action: "auth.refresh.reuse_detected",
          target: `session:${session.id}`,
          detail: { ip: req.ip, reason: "rotated_token_replayed", family: session.id },
          correlationId: req.correlationId,
        });
        throw unauthorized("Refresh token reutilizado: la sesión ha sido revocada");
      }

      const now = Date.now();
      const absolute = session.absolute_expires_at
        ? new Date(session.absolute_expires_at).getTime()
        : new Date(session.created_at).getTime() + REFRESH_ABSOLUTE_TTL_S * 1000;
      if (session.revoked_at || new Date(session.expires_at).getTime() <= now || absolute <= now) {
        throw unauthorized("Refresh token inválido, revocado o expirado");
      }

      // Rotación: el refresh usado deja de valer; la ventana deslizante se renueva
      // pero SIEMPRE recortada al tope absoluto de la familia.
      const { token, hash } = newRefreshToken();
      await db.transaction(async (trx) => {
        await trx("session_refresh_tokens").where({ id: known.id }).update({ rotated_at: trx.fn.now() });
        await trx("session_refresh_tokens").insert({ session_id: session.id, token_hash: hash });
        await trx("sessions")
          .where({ id: session.id })
          .update({
            refresh_token_hash: hash,
            last_seen_at: trx.fn.now(),
            expires_at: new Date(Math.min(now + REFRESH_TOKEN_TTL_S * 1000, absolute)),
          });
      });
      setRefreshCookie(res, token, req); // R3.7: rotación también en la cookie
      res.status(200).json({
        accessToken: signAccessToken({ sub: session.user_id, sid: session.id }),
        refreshToken: token,
        expiresIn: ACCESS_TOKEN_TTL_S,
      });
    },
    rateLimit(deps.refreshLimiter, "refresh"),
  );

  // R3.7 · Extensión: cierre de sesión del panel. Revoca la sesión asociada a la
  // cookie httpOnly (si existe) y la borra; idempotente y accesible sin token.
  defineExtension(
    router,
    { operationId: "logout", method: "post", path: "/auth/logout", minRole: "visitor" },
    async (req, res) => {
      const token = refreshTokenFromCookie(req);
      if (token) {
        await db("sessions")
          .where({ refresh_token_hash: hashToken(token) })
          .whereNull("revoked_at")
          .update({ revoked_at: db.fn.now() });
      }
      clearRefreshCookie(res);
      res.status(204).end();
    },
  );

  // ------------------------------------------------------------- sessions
  defineOperation(router, "listSessions", async (req, res) => {
    const sessions = await db("sessions")
      .where({ user_id: req.auth!.userId })
      .whereNull("revoked_at")
      .where("expires_at", ">", db.fn.now())
      .orderBy("created_at", "desc");
    res.json(sessions.map(sessionToJson));
  });

  defineOperation(router, "revokeSession", async (req, res) => {
    const session = await db("sessions").where({ id: req.params.sessionId }).first();
    if (!session) throw notFound();
    const isAdmin = req.auth!.rank >= ROLE_RANK.admin;
    if (session.user_id !== req.auth!.userId && !isAdmin) throw forbidden();
    await db("sessions").where({ id: session.id }).update({ revoked_at: db.fn.now() });
    if (isAdmin && session.user_id !== req.auth!.userId) {
      await audit(db, {
        actorId: req.auth!.userId,
        action: "auth.session.revoked_by_admin",
        target: `session:${session.id}`,
        correlationId: req.correlationId,
      });
    }
    res.status(204).end();
  });

  // ------------------------------------------------------------------ 2FA
  defineOperation(router, "enable2fa", async (req, res) => {
    const user = await db("users").where({ id: req.auth!.userId }).first();
    if (user.totp_secret) throw conflict("totp_already_enabled", "El 2FA ya está activo");
    const secret = generateTotpSecret();
    const { plain, hashes } = generateRecoveryCodes();
    await db("users")
      .where({ id: user.id })
      .update({ totp_secret: secret, recovery_codes: JSON.stringify(hashes), updated_at: db.fn.now() });
    // R2.4 · Cambiar el estado del 2FA invalida el resto de sesiones: cualquier
    // sesión robada anterior al refuerzo deja de valer.
    const revoked = await revokeOtherSessions(db, user.id, req.auth!.sessionId);
    await audit(db, {
      actorId: user.id,
      action: "auth.2fa.enabled",
      target: `user:${user.id}`,
      detail: { otherSessionsRevoked: revoked },
      correlationId: req.correlationId,
    });
    res.status(200).json({ otpauthUrl: totpUri(secret, user.email), recoveryCodes: plain });
  });

  // R2.4 (ERR-SEC-07) · Desactivar el 2FA es una operación SENSIBLE: exige
  // reautenticación fuerte (contraseña + TOTP o código de recuperación) — un
  // access token robado no basta — y revoca el resto de sesiones.
  defineOperation(router, "disable2fa", async (req, res) => {
    const user = await db("users").where({ id: req.auth!.userId }).first();
    if (!user.totp_secret) throw conflict("totp_not_enabled", "El 2FA no está activo");
    await requireStrongReauth(db, user, req.body ?? {});
    await db("users")
      .where({ id: user.id })
      .update({ totp_secret: null, recovery_codes: null, updated_at: db.fn.now() });
    const revoked = await revokeOtherSessions(db, user.id, req.auth!.sessionId);
    await audit(db, {
      actorId: user.id,
      action: "auth.2fa.disabled",
      target: `user:${user.id}`,
      detail: { otherSessionsRevoked: revoked, reauth: "password+totp" },
      correlationId: req.correlationId,
    });
    res.status(204).end();
  });

  // ------------------------------------- recuperación de cuenta (extensión)
  defineExtension(
    router,
    { operationId: "recoverAccount", method: "post", path: "/auth/recover", minRole: "visitor" },
    async (req, res) => {
      const { email } = req.body ?? {};
      // Respuesta idéntica exista o no la cuenta (no enumerar emails).
      if (typeof email === "string") {
        const user = await db("users").where({ email: email.toLowerCase() }).first();
        if (user) await createPasswordReset(db, user.id);
      }
      res.status(202).json({ status: "accepted" });
    },
    rateLimit(deps.loginLimiter, "recover"),
  );

  defineExtension(
    router,
    { operationId: "resetPassword", method: "post", path: "/auth/reset", minRole: "visitor" },
    async (req, res) => {
      const { token, newPassword } = req.body ?? {};
      if (typeof token !== "string" || typeof newPassword !== "string" || newPassword.length < 12) {
        throw badRequest("token y newPassword (≥12) obligatorios");
      }
      const reset = await db("password_resets")
        .where({ token_hash: hashToken(token) })
        .whereNull("used_at")
        .where("expires_at", ">", db.fn.now())
        .first();
      if (!reset) throw unauthorized("Token de recuperación inválido o expirado");

      await db.transaction(async (trx) => {
        await trx("password_resets").where({ id: reset.id }).update({ used_at: trx.fn.now() });
        // La recuperación cambia la contraseña y revoca sesiones, pero NO toca el
        // 2FA: el siguiente login sigue exigiendo TOTP (DoD T7.2).
        await trx("users")
          .where({ id: reset.user_id })
          .update({ password_hash: await hashPassword(newPassword), updated_at: trx.fn.now() });
        await trx("sessions")
          .where({ user_id: reset.user_id })
          .whereNull("revoked_at")
          .update({ revoked_at: trx.fn.now() });
      });
      await audit(db, {
        actorId: reset.user_id,
        action: "auth.password.reset",
        target: `user:${reset.user_id}`,
        correlationId: req.correlationId,
      });
      res.status(204).end();
    },
  );

  return router;
}

/** Crea un token de recuperación (el transporte real sería email; en dev se loguea). */
export async function createPasswordReset(db: Db, userId: string): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await db("password_resets").insert({
    user_id: userId,
    token_hash: hashToken(token),
    expires_at: new Date(Date.now() + 30 * 60 * 1000),
  });
  return token;
}

async function consumeRecoveryCode(db: Db, user: Record<string, unknown>, code: string): Promise<boolean> {
  const hashes: string[] = Array.isArray(user.recovery_codes)
    ? (user.recovery_codes as string[])
    : JSON.parse((user.recovery_codes as string) ?? "[]");
  const h = hashToken(code);
  if (!hashes.includes(h)) return false;
  await db("users")
    .where({ id: user.id })
    .update({ recovery_codes: JSON.stringify(hashes.filter((x) => x !== h)) });
  return true;
}
