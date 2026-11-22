/** T7.2 · Contraseñas con Argon2id (E7.M fija el algoritmo). */
import argon2 from "argon2";

/** Política de contraseñas (registro, reset y cambio): longitud mínima. */
export const MIN_PASSWORD_LENGTH = 12;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password).catch(() => false);
}
