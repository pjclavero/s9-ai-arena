/**
 * OLA 2 · MA · Audiencias. Clase CERRADA (`AudienceClass`) + detalle mínimo.
 *
 * `AudienceKey` es INTERNA (puede llevar un id de usuario): sólo se usa en el backend
 * para indexar mappers, feeds y cachés. Nunca se envía al cliente (lo que viaja es el
 * `mappingId`, opaco).
 */
import type { AudienceClass, AudienceKey } from "./contracts.js";

const NEEDS_DETAIL: ReadonlySet<AudienceClass> = new Set(["owner", "team", "bot_team"]);
const NO_DETAIL: ReadonlySet<AudienceClass> = new Set(["public_live", "broadcast", "public_replay", "staff"]);
const DETAIL_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Construye la clave de audiencia. `raw` no es proyectable (F5): lanza. */
export function audienceKey(cls: AudienceClass, detail?: string): AudienceKey {
  if (NO_DETAIL.has(cls)) {
    if (detail !== undefined) throw new Error(`La audiencia ${cls} no lleva detalle`);
    return cls as AudienceKey;
  }
  if (NEEDS_DETAIL.has(cls)) {
    if (detail === undefined || !DETAIL_RE.test(detail)) throw new Error(`La audiencia ${cls} exige un detalle válido`);
    return `${cls}:${detail}` as AudienceKey;
  }
  throw new Error(`Audiencia no proyectable: ${cls}`);
}

export function audienceClassOf(key: AudienceKey): AudienceClass {
  const cls = String(key).split(":", 1)[0] as AudienceClass;
  if (NO_DETAIL.has(cls) || NEEDS_DETAIL.has(cls)) return cls;
  throw new Error(`Clave de audiencia inválida: ${String(key)}`);
}
