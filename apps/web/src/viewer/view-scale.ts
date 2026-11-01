/**
 * UX-VIEW · Escala del visor: qué significa «100 %», «Encajar mapa» y los
 * límites del zoom. Lógica PURA (sin Phaser ni DOM), probada en Node.
 *
 * Unidades: la cámara trabaja en píxeles de BÚFER por metro (el búfer del canvas
 * va en píxeles físicos: CSS × devicePixelRatio). «100 %» es la escala nativa de
 * la escena: 1 píxel de escena = 1 píxel CSS, es decir `pxPerM` píxeles CSS por
 * metro (la escena dibuja el mundo a `pxPerM` px/m). Así el indicador no cambia
 * entre una pantalla normal y una HiDPI.
 */
import { fitZoom, type CameraConfig } from "./camera.js";

export interface ViewScaleInput {
  /** Viewport de la cámara en píxeles de búfer. */
  viewportW: number;
  viewportH: number;
  mapW: number;
  mapH: number;
  /** devicePixelRatio del canvas (búfer / CSS). */
  dpr: number;
  /** Píxeles de escena por metro con que se dibuja el mundo. */
  pxPerM: number;
}

export interface ViewScale {
  /** Zoom (px de búfer/m) del «100 %». */
  native: number;
  /** Zoom que encaja el mapa entero (vista completa). */
  fit: number;
  /**
   * Límite inferior: el menor entre el encaje y el 100 %. Por debajo del encaje
   * el mapa ya se ve entero (centrado), así que alejarse nunca pierde vehículos;
   * y en una pantalla grande «100 %» sigue siendo alcanzable.
   */
  min: number;
  /** Límite superior: MAX_PERCENT de la escala nativa (o el encaje si fuese mayor). */
  max: number;
  /** Zoom del modo seguimiento: cerca, pero nunca por debajo del encaje. */
  follow: number;
}

/** Acercamiento máximo, en % de la escala nativa. */
export const MAX_PERCENT = 600;
/** Zoom de seguimiento, en % de la escala nativa (antes 12 px/m fijos con dpr 1 = 150 %). */
export const FOLLOW_PERCENT = 150;
/** Factor de cada pulsación de +/− (y de cada «muesca» de teclado). */
export const ZOOM_BUTTON_FACTOR = 1.25;

export function computeViewScale(input: ViewScaleInput): ViewScale {
  const dpr = Math.max(1, input.dpr || 1);
  const native = input.pxPerM * dpr;
  const fit = Math.max(1e-6, fitZoom({ ...input }));
  const max = Math.max(fit, (native * MAX_PERCENT) / 100);
  const follow = Math.min(max, Math.max(fit, (native * FOLLOW_PERCENT) / 100));
  return { native, fit, min: Math.min(fit, native), max, follow };
}

/** Zoom → porcentaje entero de la escala nativa (para el indicador). */
export function zoomPercent(zoom: number, scale: Pick<ViewScale, "native">): number {
  if (!Number.isFinite(zoom) || zoom <= 0 || scale.native <= 0) return 0;
  return Math.round((zoom / scale.native) * 100);
}

/** Configuración de cámara con los límites de la escala (la consume computeCamera/CameraInteraction). */
export function cameraConfigFor(input: ViewScaleInput): CameraConfig {
  const s = computeViewScale(input);
  return {
    viewportW: input.viewportW,
    viewportH: input.viewportH,
    mapW: input.mapW,
    mapH: input.mapH,
    minZoom: s.min,
    maxZoom: s.max,
    followZoom: s.follow,
  };
}

/**
 * Deltas de rueda normalizados a «unidades de píxel» (deltaMode 0). Firefox y
 * algunos ratones envían líneas (1) o páginas (2); sin normalizar, una muesca
 * saltaba de golpe al zoom máximo. Cada evento se acota para que un trackpad
 * rápido no acelere el zoom de forma brusca.
 */
export function normalizeWheelDelta(deltaY: number, deltaMode: number): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  if (!Number.isFinite(px)) return 0;
  return Math.max(-240, Math.min(240, px));
}
