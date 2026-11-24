/** T7.2 · Contraseñas con Argon2id (E7.M fija el algoritmo). */
import argon2 from "argon2";
import { COMMON_PASSWORDS } from "./common-passwords.js";

/**
 * Política de contraseñas ÚNICA (registro, cambio, recuperación, primer administrador y CLI):
 *  - longitud de 12 a 128 CARACTERES, contados en puntos de código Unicode tras normalizar a NFC
 *    (un emoji o una letra acentuada cuentan 1, no sus bytes; «é» precompuesta y «e»+acento son lo mismo);
 *  - no estar en la lista de contraseñas comunes/filtradas (sin distinguir mayúsculas);
 *  - no ser trivialmente el email o el nombre visible de la propia cuenta;
 *  - SIN reglas de composición (no se exigen mayúsculas, números ni símbolos).
 *
 * Argon2id no trunca la entrada (a diferencia de bcrypt, 72 bytes): no hace falta prehash. El tope de 128
 * puntos de código (≤ 512 bytes en UTF-8) sólo acota el coste de procesar una petición. La normalización
 * NFC se aplica ÚNICAMENTE para evaluar la política; el hash y el login usan la cadena tal cual se recibe.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

/** Datos de la cuenta con los que la contraseña no puede coincidir (todos opcionales). */
export interface PasswordPolicyContext {
  email?: string | null;
  displayName?: string | null;
}

let commonSet: Set<string> | null = null;
function commonPasswords(): Set<string> {
  if (!commonSet) commonSet = new Set(COMMON_PASSWORDS);
  return commonSet;
}

const fold = (s: string): string => s.normalize("NFC").toLowerCase();

/** Cadenas «triviales» de una cuenta: email, parte local del email y nombre visible (≥ 4 caracteres). */
function accountStrings(ctx: PasswordPolicyContext): string[] {
  const out = new Set<string>();
  const add = (s: string | null | undefined): void => {
    if (typeof s !== "string") return;
    const f = fold(s).trim();
    const compact = f.replace(/\s+/g, "");
    for (const c of [f, compact]) if ([...c].length >= 4) out.add(c);
  };
  add(ctx.email);
  if (typeof ctx.email === "string") add(ctx.email.split("@")[0]);
  add(ctx.displayName);
  return [...out];
}

/**
 * Devuelve el motivo del rechazo, o `null` si la contraseña cumple. `sujeto` sólo cambia el texto.
 * `contexto` (email y nombre visible de la cuenta) activa la comprobación «derivada de tus datos».
 * Los mensajes no revelan qué entrada de la lista coincidió.
 */
export function passwordPolicyViolation(
  password: unknown,
  sujeto = "La contraseña",
  contexto: PasswordPolicyContext = {},
): string | null {
  if (typeof password !== "string") {
    return `${sujeto} debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`;
  }
  const folded = fold(password);
  const length = [...folded].length;
  if (length < MIN_PASSWORD_LENGTH) return `${sujeto} debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`;
  if (length > MAX_PASSWORD_LENGTH) return `${sujeto} no puede superar ${MAX_PASSWORD_LENGTH} caracteres`;
  if (commonPasswords().has(folded)) {
    return `${sujeto} es demasiado común o ha aparecido en filtraciones: elige otra`;
  }
  // El email/nombre tal cual, o seguido sólo de cifras y signos (p. ej. «juanperez2024!»).
  const sinCola = folded.replace(/[0-9!._\-+#$%&*@]+$/u, "");
  for (const s of accountStrings(contexto)) {
    if (folded === s || sinCola === s) return `${sujeto} no puede basarse en tu email o nombre visible`;
  }
  return null;
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password).catch(() => false);
}
