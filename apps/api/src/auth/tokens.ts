/**
 * T7.2 · Tokens: access JWT de corta duración + refresh opaco con rotación.
 *
 * El refresh token NUNCA se guarda en claro: sessions.refresh_token_hash = sha256.
 * La revocación es efectiva de inmediato porque el middleware de autenticación
 * comprueba la sesión en BD en CADA petición (DoD: un token revocado es rechazado
 * en todos los endpoints, aunque el JWT no haya expirado).
 */
import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";

export const ACCESS_TOKEN_TTL_S = 900; // 15 min (cap. 16.1: corta duración)
export const REFRESH_TOKEN_TTL_S = 14 * 24 * 3600;

export function jwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET obligatorio en producción");
  }
  return "dev-only-jwt-secret";
}

export interface AccessClaims {
  sub: string; // userId
  sid: string; // sessionId
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, jwtSecret(), { expiresIn: ACCESS_TOKEN_TTL_S });
}

export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    return jwt.verify(token, jwtSecret()) as AccessClaims;
  } catch {
    return null;
  }
}

export function newRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
