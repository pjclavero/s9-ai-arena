/**
 * UX-EDITOR · Historial deshacer/rehacer PURO e inmutable.
 *
 * - `commit` apila el estado anterior. Con la misma `key` que el último commit
 *   (p. ej. teclear en el campo «Anchura» del mismo objeto) se FUSIONA: una sola
 *   entrada por ráfaga de edición, no una por tecla.
 * - Los gestos continuos (arrastrar para mover o redimensionar) usan `live` durante
 *   el gesto (sin apilar) y `commitFrom(antes)` al soltar: un gesto = una entrada.
 */
export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  lastKey?: string;
}

export const HISTORY_LIMIT = 200;

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

export function commit<T>(h: History<T>, next: T, key?: string): History<T> {
  if (Object.is(next, h.present)) return h;
  if (key !== undefined && key === h.lastKey && h.past.length > 0) {
    return { past: h.past, present: next, future: [], lastKey: key };
  }
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: [], lastKey: key };
}

/** Cambia el presente SIN apilar (durante un gesto). */
export function live<T>(h: History<T>, next: T): History<T> {
  return { ...h, present: next };
}

/** Cierra un gesto: apila `before` (el estado al empezar) si el presente cambió. */
export function commitFrom<T>(h: History<T>, before: T): History<T> {
  if (Object.is(before, h.present)) return h;
  return { past: [...h.past, before].slice(-HISTORY_LIMIT), present: h.present, future: [], lastKey: undefined };
}

export function canUndo<T>(h: History<T>): boolean {
  return h.past.length > 0;
}
export function canRedo<T>(h: History<T>): boolean {
  return h.future.length > 0;
}

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  const prev = h.past[h.past.length - 1];
  return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future], lastKey: undefined };
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  const [next, ...rest] = h.future;
  return { past: [...h.past, h.present], present: next, future: rest, lastKey: undefined };
}
