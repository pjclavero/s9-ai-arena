/**
 * UX-EDITOR · Borrador LOCAL del editor (sobrevive a recargar la página).
 *
 * Es una comodidad de este navegador, no la fuente de verdad: el mapa se guarda en
 * el servidor con «Guardar». Se guarda un único borrador con el origen del que
 * parte (`map@v` abierto, o `null` si es un mapa nuevo/importado). Al guardar en el
 * servidor o empezar un mapa nuevo se borra. Toda lectura/escritura va en try/catch:
 * sin almacenamiento (modo privado, cuota) el editor funciona igual.
 */
import type { EditorMap } from "./model.js";

export const DRAFT_KEY = "s9.mapEditor.draft.v1";

export interface DraftOrigin {
  mapId: string;
  version: number;
}
export interface LocalDraft {
  origin: DraftOrigin | null;
  map: EditorMap;
  savedAt: number;
}

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readDraft(): LocalDraft | null {
  try {
    const raw = storage()?.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as LocalDraft;
    if (!d || typeof d !== "object" || !d.map || typeof d.map !== "object" || !d.map.layers) return null;
    const o = d.origin;
    if (o !== null && (typeof o?.mapId !== "string" || !Number.isInteger(o?.version))) return null;
    return d;
  } catch {
    return null;
  }
}

export function writeDraft(d: LocalDraft): void {
  try {
    storage()?.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    /* sin almacenamiento: no pasa nada, el servidor sigue siendo la fuente */
  }
}

export function clearDraft(): void {
  try {
    storage()?.removeItem(DRAFT_KEY);
  } catch {
    /* idem */
  }
}

export function sameOrigin(a: DraftOrigin | null, b: DraftOrigin | null): boolean {
  if (a === null || b === null) return a === b;
  return a.mapId === b.mapId && a.version === b.version;
}
