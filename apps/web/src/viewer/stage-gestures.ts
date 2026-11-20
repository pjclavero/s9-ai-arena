/**
 * UX-VIEW · Gestos del escenario (ratón, lápiz y táctil) como máquina de estados
 * PURA: recibe punteros ya normalizados (id + posición en píxeles CSS relativos
 * al canvas) y devuelve acciones de cámara. Sin DOM: se prueba en Node.
 *
 *  - un puntero que se arrastra → `pan` (escritorio: clic y arrastrar; móvil: un dedo);
 *  - dos punteros → `pinch` (factor de zoom alrededor del punto medio + pan del punto medio);
 *  - pulsar y soltar casi sin moverse → `tap` (seleccionar el bot más cercano).
 *
 * El primer movimiento de un arrastre sólo cuenta cuando supera TAP_SLOP: así un
 * clic tembloroso selecciona en vez de mover la cámara, y no hay saltos al empezar.
 */

export interface Point {
  x: number;
  y: number;
}

export type GestureAction =
  | { kind: "pan"; dx: number; dy: number }
  | { kind: "pinch"; factor: number; center: Point; dx: number; dy: number }
  | { kind: "tap"; at: Point };

/** Movimiento (px CSS) por debajo del cual pulsar y soltar es un toque, no un arrastre. */
export const TAP_SLOP = 6;
/** Duración máxima de un toque (ms). */
export const TAP_MAX_MS = 600;

interface Tracked {
  start: Point;
  last: Point;
  startMs: number;
  moved: boolean;
}

export class GestureTracker {
  private readonly pointers = new Map<number, Tracked>();
  /** Hubo dos dedos en este gesto: al levantar uno no se convierte en toque ni salta. */
  private multi = false;

  get activePointers(): number {
    return this.pointers.size;
  }

  down(id: number, at: Point, nowMs: number): void {
    this.pointers.set(id, { start: { ...at }, last: { ...at }, startMs: nowMs, moved: false });
    if (this.pointers.size >= 2) this.multi = true;
  }

  move(id: number, at: Point): GestureAction | null {
    const p = this.pointers.get(id);
    if (!p) return null;
    if (this.pointers.size >= 2) {
      // Pinch con los DOS primeros punteros: factor = distancia nueva / anterior.
      const [a, b] = [...this.pointers.entries()].slice(0, 2);
      const other = a[0] === id ? b[1] : b[0] === id ? a[1] : null;
      if (!other) {
        p.last = { ...at };
        return null;
      }
      const before = dist(p.last, other.last);
      const after = dist(at, other.last);
      const midBefore = mid(p.last, other.last);
      const midAfter = mid(at, other.last);
      p.last = { ...at };
      p.moved = true;
      if (before < 1 || after < 1) return null;
      return {
        kind: "pinch",
        factor: after / before,
        center: midAfter,
        dx: midAfter.x - midBefore.x,
        dy: midAfter.y - midBefore.y,
      };
    }
    if (this.multi) {
      // Queda un dedo tras un pinch: se reancla sin saltar.
      p.last = { ...at };
      return null;
    }
    if (!p.moved && dist(at, p.start) < TAP_SLOP) return null;
    // Al superar el umbral el pan arranca DESDE el punto de inicio (sin perder
    // los primeros píxeles ni saltar).
    const from = p.moved ? p.last : p.start;
    p.moved = true;
    p.last = { ...at };
    const dx = at.x - from.x;
    const dy = at.y - from.y;
    return dx === 0 && dy === 0 ? null : { kind: "pan", dx, dy };
  }

  up(id: number, at: Point, nowMs: number): GestureAction | null {
    const p = this.pointers.get(id);
    if (!p) return null;
    this.pointers.delete(id);
    const wasMulti = this.multi;
    if (this.pointers.size === 0) this.multi = false;
    if (wasMulti || p.moved) return null;
    if (nowMs - p.startMs > TAP_MAX_MS || dist(at, p.start) >= TAP_SLOP) return null;
    return { kind: "tap", at: { ...at } };
  }

  /** Cancelación del navegador (pointercancel / pérdida de captura). */
  cancel(id: number): void {
    this.pointers.delete(id);
    if (this.pointers.size === 0) this.multi = false;
  }
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function mid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Teclas del escenario (sólo con el FOCO en él). Devuelve la orden o null si la
 * tecla no es del visor (y entonces no se hace preventDefault: Tab, atajos del
 * navegador y del lector de pantalla siguen funcionando).
 */
export type StageKeyCommand =
  | { kind: "follow-index"; index: number }
  | { kind: "global" }
  | { kind: "zoom-in" }
  | { kind: "zoom-out" }
  | { kind: "fit" }
  | { kind: "native" }
  | { kind: "center-selected" }
  | { kind: "pan"; dx: number; dy: number };

export const KEY_PAN_PX = 60;

export function stageKeyCommand(ev: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): StageKeyCommand | null {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null; // Ctrl/Cmd +/− es el zoom del NAVEGADOR
  const k = ev.key;
  if (k === "g" || k === "G" || k === "0") return { kind: "global" };
  if (/^[1-8]$/.test(k)) return { kind: "follow-index", index: Number(k) - 1 };
  if (k === "+" || k === "=") return { kind: "zoom-in" };
  if (k === "-" || k === "_") return { kind: "zoom-out" };
  if (k === "f" || k === "F") return { kind: "fit" };
  if (k === "c" || k === "C") return { kind: "center-selected" };
  if (k === "n" || k === "N") return { kind: "native" };
  if (k === "ArrowLeft") return { kind: "pan", dx: KEY_PAN_PX, dy: 0 };
  if (k === "ArrowRight") return { kind: "pan", dx: -KEY_PAN_PX, dy: 0 };
  if (k === "ArrowUp") return { kind: "pan", dx: 0, dy: KEY_PAN_PX };
  if (k === "ArrowDown") return { kind: "pan", dx: 0, dy: -KEY_PAN_PX };
  return null;
}
