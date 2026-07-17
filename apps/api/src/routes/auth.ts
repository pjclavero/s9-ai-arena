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

export interface AuthDeps {
  db: Db;
  // R2.5 (ERR-SEC-14): contratos, no clases en memoria — en producción se
  // inyectan las variantes sobre api_usage, cuyo estado sobrevive a reinicios.
  loginGuard: LoginGuardLike;
  registerLimiter: RateLimiterLike;
  loginLimiter: RateLimiterLike;
}

async function createSession(db: Db, userId: string, req: { headers: Record<string, unknown>; ip?: string }) {
  const { token, hash } = newRefreshToken();
  const [session] = await db("sessions")
    .insert({
      user_id: userId,
      refresh_token_hash: hash,
      user_agent: String(req.headers["user-agent"] ?? ""),
      ip: req.ip ?? null,
      expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_S * 1000),
    })
    .returning("*");
  return {
    accessToken: signAccessToken({ sub: userId, sid: session.id }),
    refreshToken: token,
    expiresIn: ACCESS_TOKEN_TTL_S,
  };
}

export function authRoutes(deps: AuthDeps): Router {
  const { db, loginGuard } = deps;
  const router = Router();

  // ------------------------------------------------------------- register
  defineOperation(router, "register", async (req, res) => {
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
  }, rateLimit(deps.registerLimiter, "register"));

  // ---------------------------------------------------------------- login
  defineOperation(router, "login", async (req, res) => {
    const { email, password, totp } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") throw badRequest("email y password obligatorios");
    const key = `${req.ip}|${email.toLowerCase()}`;

    if (await loginGuard.isBlocked(key)) {
      throw tooMany("Demasiados intentos fallidos: bloqueo temporal");
    }

    const user = await db("users").where({ email: email.toLowerCase() }).first();
    const ok = user && (await verifyPassword(user.password_hash, password));
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
    res.status(200).json(await createSession(db, user.id, req));
  }, rateLimit(deps.loginLimiter, "login"));

  // -------------------------------------------------------------- refresh
  defineOperation(router, "refreshToken", async (req, res) => {
    const { refreshToken } = req.body ?? {};
    if (typeof refreshToken !== "string") throw badRequest("refreshToken obligatorio");
    const session = await db("sessions")
      .where({ refresh_token_hash: hashToken(refreshToken) })
      .whereNull("revoked_at")
      .where("expires_at", ">", db.fn.now())
      .first();
    if (!session) throw unauthorized("Refresh token inválido, revocado o expirado");

    // Rotación: el refresh usado deja de valer.
    const { token, hash } = newRefreshToken();
    await db("sessions")
      .where({ id: session.id })
      .update({
        refresh_token_hash: hash,
        last_seen_at: db.fn.now(),
        expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_S * 1000),
      });
    res.status(200).json({
      accessToken: signAccessToken({ sub: session.user_id, sid: session.id }),
      refreshToken: token,
      expiresIn: ACCESS_TOKEN_TTL_S,
    });
  });

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
    await audit(db, {
      actorId: user.id,
      action: "auth.2fa.enabled",
      target: `user:${user.id}`,
      correlationId: req.correlationId,
    });
    res.status(200).json({ otpauthUrl: totpUri(secret, user.email), recoveryCodes: plain });
  });

  defineOperation(router, "disable2fa", async (req, res) => {
    await db("users")
      .where({ id: req.auth!.userId })
      .update({ totp_secret: null, recovery_codes: null, updated_at: db.fn.now() });
    await audit(db, {
      actorId: req.auth!.userId,
      action: "auth.2fa.disabled",
      target: `user:${req.auth!.userId}`,
      correlationId: req.correlationId,
    });
    res.status(204).end();
  });

  // ------------------------------------- recuperación de cuenta (extensión)
  defineExtension(router, { operationId: "recoverAccount", method: "post", path: "/auth/recover", minRole: "visitor" }, async (req, res) => {
    const { email } = req.body ?? {};
    // Respuesta idéntica exista o no la cuenta (no enumerar emails).
    if (typeof email === "string") {
      const user = await db("users").where({ email: email.toLowerCase() }).first();
      if (user) await createPasswordReset(db, user.id);
    }
    res.status(202).json({ status: "accepted" });
  }, rateLimit(deps.loginLimiter, "recover"));

  defineExtension(router, { operationId: "resetPassword", method: "post", path: "/auth/reset", minRole: "visitor" }, async (req, res) => {
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
      await trx("sessions").where({ user_id: reset.user_id }).whereNull("revoked_at").update({ revoked_at: trx.fn.now() });
    });
    await audit(db, {
      actorId: reset.user_id,
      action: "auth.password.reset",
      target: `user:${reset.user_id}`,
      correlationId: req.correlationId,
    });
    res.status(204).end();
  });

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
