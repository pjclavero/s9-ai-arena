/** T7.2 · 2FA TOTP opcional (otplib v13) + códigos de recuperación. */
import { randomBytes } from "node:crypto";
import * as otplib from "otplib";
import { hashToken } from "./tokens.js";

/**
 * R-DEPLOY · R4 — ventana de tolerancia del TOTP.
 *
 * El período es de 30 s. Con tolerancia 0 (el defecto de otplib v13) un código
 * generado en el borde del período (p. ej. a t=29 s) se rechaza al validarlo
 * 1-2 s después: es el fallo "flaky bajo carga". Se fija una tolerancia
 * SIMÉTRICA de un período (±30 s) → se aceptan el paso anterior, el actual y el
 * siguiente (delta ∈ {-1, 0, +1}). Es el estándar de facto (Google Authenticator).
 */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_TOLERANCE_SECONDS = TOTP_PERIOD_SECONDS; // ±1 paso

export interface TotpVerifyOptions {
  /**
   * Instante Unix (en SEGUNDOS) contra el que validar. Por defecto, ahora.
   * Inyectable para tests con reloj controlado (nunca Date.now() real).
   */
  epoch?: number;
  /**
   * Protección anti-replay (ERR-SEC): rechaza tokens cuyo `timeStep` sea <=
   * este valor. El llamante persiste el `timeStep` aceptado y lo pasa aquí en
   * la siguiente verificación para que el MISMO código (o uno anterior) no
   * pueda reutilizarse dentro de la ventana. Ver docs/ronda2/reportes/R4-totp.md.
   */
  afterTimeStep?: number;
}

export interface TotpVerifyResult {
  valid: boolean;
  /** Paso temporal del código aceptado (para persistir y bloquear replay). */
  timeStep?: number;
  /** Desfase en pasos respecto al actual: -1 (anterior), 0, +1 (siguiente). */
  delta?: number;
}

export function generateTotpSecret(): string {
  return otplib.generateSecret();
}

export function totpUri(secret: string, email: string): string {
  return otplib.generateURI({ secret, issuer: "S9 AI Arena", label: email });
}

/**
 * Verificación detallada: devuelve validez + `timeStep`/`delta`. Nunca lanza
 * (un token malformado es simplemente inválido). No registra el secreto ni el
 * token en ningún log.
 */
export async function verifyTotpDetailed(
  token: string,
  secret: string,
  options: TotpVerifyOptions = {},
): Promise<TotpVerifyResult> {
  try {
    const r = await otplib.verify({
      token,
      secret,
      period: TOTP_PERIOD_SECONDS,
      epochTolerance: TOTP_TOLERANCE_SECONDS,
      ...(options.epoch !== undefined ? { epoch: options.epoch } : {}),
      ...(options.afterTimeStep !== undefined ? { afterTimeStep: options.afterTimeStep } : {}),
    });
    if (r.valid === true) return { valid: true, timeStep: r.timeStep, delta: r.delta };
    return { valid: false };
  } catch {
    return { valid: false };
  }
}

/** Compatibilidad: verificación booleana con ventana ±1 (R4). */
export async function verifyTotp(token: string, secret: string, options: TotpVerifyOptions = {}): Promise<boolean> {
  return (await verifyTotpDetailed(token, secret, options)).valid;
}

/** Devuelve códigos en claro (se muestran UNA vez) y sus hashes para la BD. */
export function generateRecoveryCodes(n = 8): { plain: string[]; hashes: string[] } {
  const plain = Array.from({ length: n }, () => randomBytes(6).toString("hex"));
  return { plain, hashes: plain.map(hashToken) };
}
