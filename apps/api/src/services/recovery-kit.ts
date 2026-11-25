/**
 * V1 ADM-SETUP · D-5 · Kit de recuperación del administrador (AUTORRECUPERACIÓN).
 *
 * Para que un admin ÚNICO que pierde su contraseña recupere el acceso DESDE LA WEB, sin consola:
 *  - código de un solo uso, 160 bits de `randomBytes`, en base32 (`S9RK-XXXX-…`, 8 grupos de 4);
 *  - sólo se guarda su hash Argon2id (`admin_recovery_kits`, migración 027), nunca el valor;
 *  - se muestra UNA vez: al crear el admin en el asistente y al regenerarlo desde la web (con
 *    reautenticación fuerte); regenerar sustituye al anterior;
 *  - canjearlo (email + kit + contraseña nueva, y TOTP o código de recuperación si hay 2FA) fija la
 *    contraseña, revoca TODAS las sesiones y borra el kit (consumido); la web ofrece generar otro.
 *
 * Sólo para cuentas con rol `admin` (decisión documentada en docs/operations/break-glass.md):
 * un usuario normal lo recupera un admin (flujo de #347, «un admin recupera a otro usuario»);
 * el kit cubre el único caso que nadie más puede cubrir, el del admin sin nadie por encima.
 *
 * NO resetea la 2FA: con 2FA activa el canje exige además un TOTP o un código de recuperación
 * de la 2FA. Así el kit nunca sustituye a un segundo factor: hacen falta dos posesiones.
 */
import { randomBytes } from "node:crypto";
import type { Knex } from "knex";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import { audit } from "../audit.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 símbolos, sin 0/O ni 1/I
const KIT_BYTES = 20; // 160 bits ⇒ 32 símbolos base32
export const KIT_PREFIX = "S9RK";

function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Genera un kit nuevo en claro (sólo para mostrarlo UNA vez). */
export function generateRecoveryKit(): string {
  const body = base32(randomBytes(KIT_BYTES));
  return `${KIT_PREFIX}-${body.match(/.{4}/g)!.join("-")}`;
}

/**
 * Forma canónica del kit: mayúsculas, sin espacios ni guiones y sin el prefijo. Así da igual
 * cómo lo copie la persona. Devuelve `null` si no tiene la forma de un kit (no se gasta Argon2).
 */
export function normalizeRecoveryKit(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 128) return null;
  let s = input.toUpperCase().replace(/[\s-]/g, "");
  if (s.startsWith(KIT_PREFIX)) s = s.slice(KIT_PREFIX.length);
  if (s.length !== 32) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

/** Emite (o sustituye) el kit de la cuenta dentro de la transacción dada. Devuelve el valor en claro. */
export async function issueRecoveryKit(trx: Knex, userId: string): Promise<string> {
  const kit = generateRecoveryKit();
  const hash = await hashPassword(normalizeRecoveryKit(kit)!);
  await trx.raw(
    `INSERT INTO admin_recovery_kits (user_id, kit_hash, created_at) VALUES (?, ?, now())
     ON CONFLICT (user_id) DO UPDATE SET kit_hash = EXCLUDED.kit_hash, created_at = EXCLUDED.created_at`,
    [userId, hash],
  );
  return kit;
}

/**
 * REV352-03 · Invalida el kit de la cuenta (si lo tiene) y lo audita. Devuelve si había kit.
 *
 * PUNTO DE INTEGRACIÓN con #347: `setUserStatus` debe llamarla al BLOQUEAR una cuenta (y la emisión de
 * la recuperación de ADM-3, al recuperar una cuenta ajena), dentro de su misma transacción, con el admin
 * que actúa como `actorId`. Así un atacante con el kit de un admin bloqueado no recupera el acceso al
 * desbloquearlo.
 */
export async function revokeRecoveryKit(
  trx: Knex,
  userId: string,
  ctx: { actorId?: string | null; reason: string; correlationId?: string },
): Promise<boolean> {
  const n = await trx("admin_recovery_kits").where({ user_id: userId }).del();
  if (n === 0) return false;
  await audit(trx, {
    actorId: ctx.actorId ?? null,
    action: "auth.recovery_kit.revoked",
    target: `user:${userId}`,
    detail: { reason: ctx.reason },
    correlationId: ctx.correlationId,
  });
  return true;
}

/** Estado del kit de la cuenta (sin el hash). */
export async function recoveryKitStatus(
  db: Knex,
  userId: string,
): Promise<{ active: boolean; createdAt: string | null }> {
  const row = await db("admin_recovery_kits").where({ user_id: userId }).first();
  return { active: !!row, createdAt: row ? new Date(row.created_at).toISOString() : null };
}

/** Comprueba el kit normalizado contra el hash guardado (Argon2id). */
export function recoveryKitMatches(hash: string, normalizedKit: string): Promise<boolean> {
  return verifyPassword(hash, normalizedKit);
}
