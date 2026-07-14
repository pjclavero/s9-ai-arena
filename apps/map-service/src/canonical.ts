/**
 * Serialización canónica + checksum de mapa (E4, regla no negociable de la sección 2).
 *
 * Canonicalización: JSON con TODAS las claves de objeto ordenadas alfabéticamente de
 * forma recursiva, sin espacios. Los arrays conservan su orden (es significativo:
 * el grid `ground.data` es fila a fila, y el orden de spawns/muros importa). Los
 * números se serializan con `JSON.stringify`, que en cualquier motor de JavaScript
 * usa el algoritmo Number→String de ECMAScript (el "shortest round-trippable", ES2015
 * §7.1.12.1). Ese algoritmo NO depende de locale ni de `Intl`: `(0.1).toString()` es
 * "0.1" en cualquier configuración regional. Por eso el checksum es estable entre
 * sistemas operativos y órdenes de ejecución, siempre que el runtime sea un JS estándar.
 *
 * El checksum se calcula sobre el documento SIN su propio campo `checksum` (map.schema
 * de E1 lo exige así: si se incluyera, sería imposible de verificar).
 */
import { createHash } from "node:crypto";
import type { InternalMap, MapWithoutChecksum } from "./types.js";

/** JSON canónico de un valor arbitrario: claves de objeto ordenadas recursivamente, sin espacios. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Serialización canónica de un mapa IGNORANDO su campo checksum. */
export function canonicalMapString(map: MapWithoutChecksum): string {
  const { checksum: _drop, ...rest } = map as InternalMap;
  return canonicalize(rest);
}

/** Checksum canónico `sha256:<64 hex>` de un mapa (sin contar su propio campo checksum). */
export function computeChecksum(map: MapWithoutChecksum): string {
  const hash = createHash("sha256").update(canonicalMapString(map), "utf8").digest("hex");
  return `sha256:${hash}`;
}

/** Devuelve una copia del mapa con su checksum canónico ya calculado y asignado. */
export function withChecksum(map: MapWithoutChecksum): InternalMap {
  const checksum = computeChecksum(map);
  return { ...(map as InternalMap), checksum };
}

/** ¿El checksum declarado del mapa coincide con el recalculado sobre su contenido? */
export function verifyChecksum(map: InternalMap): boolean {
  return map.checksum === computeChecksum(map);
}
