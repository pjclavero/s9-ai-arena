/**
 * Guard contra digests placeholder (issue #12, auditoría 2026-07-16 §3.2).
 *
 * runtimes/DIGESTS.lock y los hashes de los lockfiles de runtimes/ llevan
 * placeholders (000…0, 111…1, …) hasta que se construyan las imágenes reales
 * con Docker. Tienen APARIENCIA de configuración real y serían desplegables
 * por error. Este módulo da la detección pura que usan:
 *   - el bot-manager (container-runner.ts): NO lanza un bot sobre una imagen
 *     con digest placeholder;
 *   - scripts/verify-runtime-digests.ts: la CI NO da OK mientras queden
 *     placeholders en runtimes/.
 *
 * Un placeholder es un sha256 de 64 hex con el MISMO carácter repetido
 * (así se escribieron todos los del MVP: 000…0, 111…1, 222…2).
 */

/** Mensaje canónico del guard (issue #12). */
export const PLACEHOLDER_MSG = "digests placeholder: ejecuta el build real";

const SHA256_RE = /sha256:([0-9a-fA-F]{64})/;

/** true si un hex de 64 caracteres es un placeholder (mismo carácter repetido). */
export function isPlaceholderSha256(hex: string): boolean {
  return /^([0-9a-fA-F])\1{63}$/.test(hex);
}

/** Extrae el hex del primer `sha256:<64hex>` de una referencia (imagen, --hash…). */
export function extractSha256(ref: string): string | null {
  const m = SHA256_RE.exec(ref);
  return m ? m[1] : null;
}

/** true si la referencia contiene un digest sha256 placeholder. */
export function isPlaceholderDigest(ref: string): boolean {
  const hex = extractSha256(ref);
  return hex !== null && isPlaceholderSha256(hex);
}

export class PlaceholderDigestError extends Error {}

/**
 * Lanza PlaceholderDigestError si la referencia lleva un digest placeholder.
 * `context` identifica qué se intentaba usar (imagen del bot, entrada del lock…).
 */
export function assertRealDigest(ref: string, context: string): void {
  if (isPlaceholderDigest(ref)) {
    throw new PlaceholderDigestError(
      `${PLACEHOLDER_MSG} (${context}: ${ref}). Construye las imágenes de runtime ` +
        `y fija los digests reales en runtimes/DIGESTS.lock antes de lanzar bots.`,
    );
  }
}
