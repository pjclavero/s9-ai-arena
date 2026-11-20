/**
 * R3.2 · ERR-VIS-07 — Escala del canvas: tipo RESIZE + devicePixelRatio.
 *
 * Phaser.Scale.RESIZE ignora el dpr (buffer = píxeles CSS ⇒ borroso en HiDPI),
 * así que el visor implementa el "sigue a tu contenedor" con ResizeObserver +
 * scale.resize(css×dpr), y el zoom del ScaleManager devuelve el canvas a su
 * tamaño CSS. Esta es la única matemática de ese cableado, pura y probada; el
 * DOM real queda para la verificación visual del guion manual.
 */

export interface CanvasSize {
  /** Buffer del canvas en píxeles físicos. */
  width: number;
  height: number;
  /** Zoom del ScaleManager que deja el canvas a su tamaño CSS (1/dpr). */
  zoom: number;
}

export function canvasSizeFor(cssW: number, cssH: number, dpr: number): CanvasSize {
  const ratio = Math.max(1, dpr || 1);
  return {
    width: Math.max(1, Math.round(cssW * ratio)),
    height: Math.max(1, Math.round(cssH * ratio)),
    zoom: 1 / ratio,
  };
}

/** Lo que usa `applyCanvasSize` del ScaleManager de Phaser. */
export interface ScaleLike {
  resize(width: number, height: number): unknown;
  setZoom(zoom: number): unknown;
}

/**
 * UX-R · Aplica un tamaño al ScaleManager en el ORDEN que Phaser 4 necesita:
 * primero `resize` y después `setZoom`. En modo NONE, `resize` sólo reescribe
 * el tamaño CSS del canvas si el zoom es distinto de 1 (dpr distinto de 1); con
 * dpr 1 lo deja como estaba y es `setZoom` quien lo recalcula, con el tamaño de
 * juego VIGENTE. Al revés (setZoom y luego resize) el canvas iba un
 * redimensionado por detrás: al estrechar la ventana conservaba el ancho
 * anterior y desbordaba la página (UX-E: 208 px a 768 y 356 px a 390).
 */
export function applyCanvasSize(scale: ScaleLike, size: CanvasSize): void {
  scale.resize(size.width, size.height);
  scale.setZoom(size.zoom);
}
