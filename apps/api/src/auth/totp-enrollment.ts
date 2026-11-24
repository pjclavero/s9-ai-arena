/**
 * ACC-2FA · Alta de la verificación en dos pasos en DOS fases sin estado en BD.
 *
 * `POST /auth/2fa/setup` genera un secreto TOTP nuevo y lo devuelve al usuario (QR + texto) junto con un
 * «token de alta» SELLADO; NO toca la cuenta. `POST /auth/2fa/confirm` recibe ese token y un código de la
 * app: sólo si el código es válido para ESE secreto se guarda en `users.totp_secret`. Así una alta que el
 * usuario no completa (no escaneó el QR, cerró la pestaña) nunca le deja fuera de su cuenta.
 *
 * El token es AES-256-GCM con una clave DERIVADA del secreto de sesión (HKDF, separación de dominio): el
 * secreto TOTP no viaja legible dentro de él y nadie puede fabricar uno. Va atado al usuario y a la sesión
 * que lo pidió y al estado de la cuenta (`updated_at`: tras confirmar o desactivar ya no se abre, REV-3), como
 * datos asociados autenticados, y caduca a los 10 minutos. No hace falta migración.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { sessionSecret } from "./tokens.js";

export const TOTP_ENROLLMENT_TTL_S = 600;
const VERSION = "e1";
const INFO = "s9-arena/totp-enrollment/v1";

function key(): Buffer {
  return Buffer.from(hkdfSync("sha256", sessionSecret(), "", INFO, 32));
}

function aad(userId: string, sessionId: string, accountState: string): Buffer {
  return Buffer.from(`${INFO}|${userId}|${sessionId}|${accountState}`, "utf8");
}

/** Sella el secreto pendiente para (usuario, sesión). `now` en ms (inyectable en tests). */
export function sealTotpEnrollment(
  input: { userId: string; sessionId: string; accountState: string; secret: string },
  now: number = Date.now(),
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(aad(input.userId, input.sessionId, input.accountState));
  const payload = JSON.stringify({ s: input.secret, exp: Math.floor(now / 1000) + TOTP_ENROLLMENT_TTL_S });
  const body = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), body.toString("base64url"), tag.toString("base64url")].join(".");
}

/**
 * Abre el token. Devuelve el secreto, o `null` si está manipulado, caducado o es de otro usuario o de otra
 * sesión. Nunca lanza.
 */
export function openTotpEnrollment(
  token: unknown,
  ctx: { userId: string; sessionId: string; accountState: string },
  now: number = Date.now(),
): string | null {
  if (typeof token !== "string" || token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const body = Buffer.from(parts[2], "base64url");
    const tag = Buffer.from(parts[3], "base64url");
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAAD(aad(ctx.userId, ctx.sessionId, ctx.accountState));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    const p = JSON.parse(plain) as { s?: unknown; exp?: unknown };
    if (typeof p.s !== "string" || !p.s || typeof p.exp !== "number") return null;
    if (p.exp * 1000 <= now) return null;
    return p.s;
  } catch {
    return null;
  }
}
