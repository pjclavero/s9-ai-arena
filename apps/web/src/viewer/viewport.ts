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
