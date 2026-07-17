/**
 * T7.2 · Tokens: access JWT de corta duración + refresh opaco con rotación.
 *
 * El refresh token NUNCA se guarda en claro: sessions.refresh_token_hash = sha256.
 * La revocación es efectiva de inmediato porque el middleware de autenticación
 * comprueba la sesión en BD en CADA petición (DoD: un token revocado es rechazado
 * en todos los endpoints, aunque el JWT no haya expirado).
 *
 * R1.4 (ERR-SEC-01) · Secretos: FALLAR CERRADO. El secreto de firma se lee del
 * archivo de secreto (`*_FILE`, patrón Docker secrets — igual que STREAM_KEY_FILE
 * en el streamer) con PRECEDENCIA sobre la variable en claro. No hay literal de
 * respaldo: si no hay secreto explícito el arranque LANZA, salvo que se declare a
 * propósito el modo de desarrollo `ARENA_DEV_INSECURE_SECRETS=1`, que usa un
 * secreto EFÍMERO aleatorio por proceso (nunca un valor conocido versionado).
 * La lógica NO depende de NODE_ENV: se exige secreto por defecto.
 *
 * Los tickets de espectador se firman con un secreto DISTINTO del de sesión y con
 * `audience`/`issuer` propios, y el algoritmo se fija explícitamente (allowlist):
 * un token de un tipo jamás valida como el otro.
 */
import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import jwt from "jsonwebtoken";

export const ACCESS_TOKEN_TTL_S = 900; // 15 min (cap. 16.1: corta duración)
export const REFRESH_TOKEN_TTL_S = 14 * 24 * 3600;
/**
 * R2.4 (ERR-SEC-08) · Vida MÁXIMA ABSOLUTA de una sesión: la rotación del refresh
 * renueva la ventana deslizante (REFRESH_TOKEN_TTL_S) pero jamás más allá de este
 * tope contado desde el login. Sin él, una familia rotada a tiempo viviría para siempre.
 */
export const REFRESH_ABSOLUTE_TTL_S = 30 * 24 * 3600;

/** Algoritmo ÚNICO admitido para firmar y verificar (evita `alg:none` y confusión RS/HS). */
const TOKEN_ALG = "HS256" as const;
const ISSUER = "s9-ai-arena";
/** Audiencias por tipo de token: separan el dominio de cada credencial. */
const AUD_SESSION = "s9-arena/session";
const AUD_SPECTATE = "s9-arena/spectate";

/**
 * Lee un secreto del archivo apuntado por `fileVar` (patrón Docker secrets), con
 * PRECEDENCIA sobre la variable en claro `plainVar`. Un archivo declarado pero
 * ilegible o vacío es un ERROR (fallar cerrado): no se degrada silenciosamente.
 */
function resolveSecret(fileVar: string, plainVar: string): string | undefined {
  const file = process.env[fileVar];
  if (file) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8").trim();
    } catch {
      throw new Error(`${fileVar} apunta a un archivo de secreto ilegible: ${file}`);
    }
    if (!raw) throw new Error(`${fileVar} apunta a un archivo de secreto vacío: ${file}`);
    return raw;
  }
  const plain = process.env[plainVar];
  return plain && plain.length > 0 ? plain : undefined;
}

/** Secreto efímero del modo dev: aleatorio por proceso, cacheado. NUNCA en producción. */
let devSecretCache: string | null = null;
function devInsecureSecret(): string {
  if (!devSecretCache) devSecretCache = randomBytes(32).toString("base64url");
  return devSecretCache;
}

/**
 * Secreto de firma de tokens de SESIÓN. Fallar cerrado: exige secreto explícito
 * (archivo o variable) salvo que se active a propósito el modo dev inseguro.
 */
export function sessionSecret(): string {
  const s = resolveSecret("JWT_SECRET_FILE", "JWT_SECRET");
  if (s) return s;
  if (process.env.ARENA_DEV_INSECURE_SECRETS === "1") return devInsecureSecret();
  throw new Error(
    "Falta el secreto JWT de sesión: define JWT_SECRET_FILE (archivo de secreto Docker) " +
      "o JWT_SECRET. Para desarrollo/tests, ARENA_DEV_INSECURE_SECRETS=1 usa un secreto " +
      "efímero aleatorio por proceso (NUNCA en producción).",
  );
}

/**
 * Secreto de firma de TICKETS DE ESPECTADOR: distinto del de sesión.
 *  - Si el operador provee uno explícito (SPECTATE_TICKET_SECRET_FILE / _SECRET),
 *    se usa tal cual (con la misma precedencia archivo > variable).
 *  - Si no, se DERIVA del secreto de sesión con separación de dominio (HKDF): la
 *    clave resultante es criptográficamente independiente, así que el despliegue
 *    solo necesita provisionar `jwt_secret`, sin romper el fallar-cerrado.
 */
export function spectateTicketSecret(): string {
  const explicit = resolveSecret("SPECTATE_TICKET_SECRET_FILE", "SPECTATE_TICKET_SECRET");
  if (explicit) return explicit;
  const derived = hkdfSync("sha256", sessionSecret(), "", "s9-arena/spectate-ticket/v1", 32);
  return Buffer.from(derived).toString("base64url");
}

export interface AccessClaims {
  sub: string; // userId
  sid: string; // sessionId
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign({ sid: claims.sid }, sessionSecret(), {
    algorithm: TOKEN_ALG,
    subject: claims.sub,
    expiresIn: ACCESS_TOKEN_TTL_S,
    issuer: ISSUER,
    audience: AUD_SESSION,
  });
}

export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    const p = jwt.verify(token, sessionSecret(), {
      algorithms: [TOKEN_ALG],
      issuer: ISSUER,
      audience: AUD_SESSION,
    }) as jwt.JwtPayload;
    if (typeof p.sub !== "string" || typeof p.sid !== "string") return null;
    return { sub: p.sub, sid: p.sid };
  } catch {
    return null;
  }
}

export interface SpectateTicketInput {
  battleId: string;
  jti: string;
  /** Capas de depuración: solo si la API lo firma según el rol (T8.2). */
  debug?: boolean;
}

export interface VerifiedSpectateTicket {
  battleId: string;
  jti?: string;
  debug?: boolean;
  exp: number;
}

export function signSpectateTicket(input: SpectateTicketInput, ttlS: number): string {
  return jwt.sign(
    { battleId: input.battleId, ...(input.debug ? { debug: true } : {}) },
    spectateTicketSecret(),
    {
      algorithm: TOKEN_ALG,
      jwtid: input.jti,
      expiresIn: ttlS,
      issuer: ISSUER,
      audience: AUD_SPECTATE,
    },
  );
}

export function verifySpectateTicket(token: string): VerifiedSpectateTicket | null {
  try {
    const p = jwt.verify(token, spectateTicketSecret(), {
      algorithms: [TOKEN_ALG],
      issuer: ISSUER,
      audience: AUD_SPECTATE,
    }) as jwt.JwtPayload;
    if (typeof p.battleId !== "string" || typeof p.exp !== "number") return null;
    return { battleId: p.battleId, jti: p.jti, debug: p.debug === true, exp: p.exp };
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
