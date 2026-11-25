/**
 * V1 ADM-SETUP · D-5 · Kit de recuperación del ADMIN (services/recovery-kit.ts).
 *
 *  - `GET  /auth/recovery-kit`         (admin): ¿hay kit activo? Nunca devuelve el kit.
 *  - `POST /auth/recovery-kit`         (admin + reautenticación fuerte): genera uno nuevo y lo muestra UNA vez.
 *  - `POST /auth/recovery-kit/redeem`  (público): email + kit + contraseña nueva (+ TOTP o código de
 *    recuperación de la 2FA si la cuenta la tiene) ⇒ contraseña nueva, kit consumido, sesiones revocadas.
 *
 * Sin oráculo de existencia de cuenta: email inexistente, cuenta sin kit, cuenta que ya no es admin y kit
 * erróneo dan la MISMA respuesta (401) con el MISMO coste (Argon2id contra un hash señuelo).
 *
 * Relación con #347 (ADM-3): ese flujo es «un admin recupera a OTRO usuario» (token emitido por un admin);
 * éste es la AUTORRECUPERACIÓN del admin que no tiene a nadie por encima. No se solapan.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { audit } from "../audit.js";
import { ApiError, badRequest, tooMany, unauthorized } from "../errors.js";
import { rateLimit } from "../middleware/rate-limit.js";
import type { LoginGuardLike, RateLimiterLike } from "../middleware/shared-rate-limit.js";
import { hashPassword, passwordPolicyViolation, verifyPassword } from "../auth/passwords.js";
import { verifyTotp } from "../auth/totp.js";
import {
  issueRecoveryKit,
  normalizeRecoveryKit,
  recoveryKitMatches,
  recoveryKitStatus,
} from "../services/recovery-kit.js";
import { consumeRecoveryCode, requireStrongReauth } from "./auth.js";

export interface RecoveryKitDeps {
  db: Db;
  /** Canje: intentos por IP (por defecto 10 / 15 min, compartido en BD). */
  redeemIpLimiter: RateLimiterLike;
  /** Canje: intentos en total (por defecto 60 / hora, compartido en BD). */
  redeemGlobalLimiter: RateLimiterLike;
  /** Regenerar: fallos de reautenticación por usuario (por defecto 5 ⇒ 15 min de bloqueo). */
  regenerateGuard: LoginGuardLike;
  /**
   * REV352-04 · Canje: fallos del SEGUNDO FACTOR por cuenta (por defecto 5 ⇒ 15 min de bloqueo, como el
   * cambio de contraseña). Sólo lo alcanza quien ya presentó un kit válido: no es un oráculo de cuentas.
   */
  secondFactorGuard: LoginGuardLike;
}

/**
 * REV352-03 · ¿La cuenta está activa? `users.status` llega con #347 (migración 025: `active` | `blocked`).
 * Sin la columna (main antes de #347) toda cuenta está activa. Cualquier otro valor ⇒ NO activa
 * (fallo cerrado).
 */
export function accountIsActive(user: Record<string, unknown>): boolean {
  return user.status === undefined || user.status === null || user.status === "active";
}

/** Hash señuelo: un intento sobre una cuenta que no existe paga el mismo Argon2id. */
const decoyHashPromise: Promise<string> = hashPassword(randomBytes(32).toString("base64url"));

const GENERIC = "Email o kit de recuperación inválidos";

function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store");
  next();
}

function globalLimit(limiter: RateLimiterLike) {
  return async (_req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!(await limiter.hit("recovery-kit:all"))) return next(tooMany());
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function recoveryKitRoutes(deps: RecoveryKitDeps): Router {
  const { db } = deps;
  const router = Router();

  defineOperation(
    router,
    "getRecoveryKitStatus",
    async (req, res) => {
      res.json(await recoveryKitStatus(db, req.auth!.userId));
    },
    noStore,
  );

  defineOperation(
    router,
    "regenerateRecoveryKit",
    async (req, res) => {
      const userId = req.auth!.userId;
      const key = `recovery-kit|${userId}`;
      if (await deps.regenerateGuard.isBlocked(key)) throw tooMany("Demasiados intentos fallidos: bloqueo temporal");
      const user = await db("users").where({ id: userId }).first();
      if (!user) throw unauthorized();
      try {
        await requireStrongReauth(db, user, req.body ?? {});
      } catch (e) {
        await deps.regenerateGuard.recordFailure(key);
        throw e;
      }
      await deps.regenerateGuard.recordSuccess(key);
      const recoveryKit = await db.transaction((trx) => issueRecoveryKit(trx, userId));
      await audit(db, {
        actorId: userId,
        action: "auth.recovery_kit.generated",
        target: `user:${userId}`,
        detail: { via: "account", reauth: user.totp_secret ? "password+totp" : "password" },
        correlationId: req.correlationId,
      });
      const status = await recoveryKitStatus(db, userId);
      res.status(200).json({ recoveryKit, createdAt: status.createdAt });
    },
    noStore,
  );

  defineOperation(
    router,
    "redeemRecoveryKit",
    async (req, res) => {
      const { email, recoveryKit, newPassword, totp } = req.body ?? {};
      if (typeof email !== "string" || !email) throw badRequest("email obligatorio");
      // Política ANTES de tocar la cuenta: no revela nada y no gasta Argon2 ni códigos de recuperación.
      // PUNTO DE INTEGRACIÓN con #348: pasar `{ email }` como contexto cuando su política entre en main
      // (sólo el email de la PETICIÓN, nunca datos de la cuenta: serían un oráculo).
      const violation = passwordPolicyViolation(newPassword, "La nueva contraseña");
      if (violation) throw badRequest(violation);
      const normalizedEmail = email.toLowerCase();
      const kit = normalizeRecoveryKit(recoveryKit);

      const user = kit ? await db("users").where({ email: normalizedEmail }).first() : undefined;
      const row = user ? await db("admin_recovery_kits").where({ user_id: user.id }).first() : undefined;
      const isAdmin = row ? !!(await db("user_roles").where({ user_id: user.id, role: "admin" }).first()) : false;
      // Mismo coste en todas las ramas: Argon2id contra el hash real o contra el señuelo.
      // REV352-03 · una cuenta bloqueada no canjea el kit: misma 401 genérica y mismo coste (Argon2id).
      const active = user ? accountIsActive(user) : false;
      const ok =
        kit !== null && row && isAdmin && active
          ? await recoveryKitMatches(row.kit_hash, kit)
          : (await verifyPassword(await decoyHashPromise, kit ?? "x"), false);

      const reject = async (reason: string) => {
        await audit(db, {
          actorId: null,
          action: "auth.recovery_kit.rejected",
          target: `email:${normalizedEmail}`,
          detail: { ip: req.ip ?? null, reason },
          correlationId: req.correlationId,
        });
      };
      if (!ok) {
        await reject("invalid");
        throw unauthorized(GENERIC);
      }
      // NO se resetea la 2FA: si la cuenta la tiene, el kit solo no basta (dos posesiones).
      if (user.totp_secret) {
        const guardKey = `recovery-kit-2fa|${user.id}`;
        if (await deps.secondFactorGuard.isBlocked(guardKey)) {
          await reject("second_factor_blocked");
          throw tooMany("Demasiados códigos erróneos para esta cuenta: bloqueo temporal");
        }
        // PUNTO DE INTEGRACIÓN con #351 (REV352-02): sustituir estas dos llamadas por su `verifySecondFactor`
        // (anti-replay del TOTP y consumo atómico del código de recuperación), con `replay` ⇒ 401 propio, y
        // quitar el `export` de `consumeRecoveryCode` si #351 lo deja privado.
        const second =
          (typeof totp === "string" && (await verifyTotp(totp, String(user.totp_secret)))) ||
          (typeof totp === "string" && (await consumeRecoveryCode(db, user, totp)));
        if (!second) {
          const blocked = await deps.secondFactorGuard.recordFailure(guardKey);
          await reject(blocked ? "second_factor_blocked" : "second_factor");
          throw new ApiError(
            401,
            "totp_required",
            "La cuenta tiene verificación en dos pasos: añade un código TOTP o un código de recuperación",
          );
        }
        await deps.secondFactorGuard.recordSuccess(guardKey);
      }

      const newHash = await hashPassword(newPassword);
      const revoked = await db.transaction(async (trx) => {
        // UN SOLO USO también ante canjes simultáneos: sólo una petición borra la fila con ESE hash.
        const consumed = await trx("admin_recovery_kits")
          .where({ user_id: user.id, kit_hash: row.kit_hash })
          .del()
          .returning("user_id");
        if (consumed.length !== 1) return null;
        await trx("users").where({ id: user.id }).update({ password_hash: newHash, updated_at: trx.fn.now() });
        // Ningún token de recuperación anterior puede deshacer el cambio.
        await trx("password_resets").where({ user_id: user.id }).whereNull("used_at").update({ used_at: trx.fn.now() });
        return trx("sessions").where({ user_id: user.id }).whereNull("revoked_at").update({ revoked_at: trx.fn.now() });
      });
      if (revoked === null) {
        await reject("already_consumed");
        throw unauthorized(GENERIC);
      }
      await audit(db, {
        actorId: user.id,
        action: "auth.recovery_kit.redeemed",
        target: `user:${user.id}`,
        detail: { ip: req.ip ?? null, sessionsRevoked: revoked, secondFactor: !!user.totp_secret },
        correlationId: req.correlationId,
      });
      res.status(204).end();
    },
    noStore,
    rateLimit(deps.redeemIpLimiter, "recovery-kit"),
    globalLimit(deps.redeemGlobalLimiter),
  );

  return router;
}
