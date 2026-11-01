/**
 * UX-EDITOR · Transformación de vista PURA (pantalla ↔ mundo), común al editor de
 * mapas y, cuando se integre, al visor.
 *
 * Extrae la fórmula del zoom al cursor de `viewer/camera-interaction.ts` (onWheel,
 * l.48-53) sin modificar ese fichero: un `View` es el mismo `{centerX, centerY,
 * zoom}` del visor, con `zoom` en PÍXELES DE PANTALLA POR UNIDAD DEL MUNDO (metro).
 * El centro de la vista cae en el centro del viewport.
 *
 * Sin navegador ni estado: todas las funciones devuelven un `View` nuevo.
 */

export interface Pt {
  x: number;
  y: number;
}
export interface Size {
  w: number;
  h: number;
}
export interface View {
  /** Punto del mundo que se ve en el centro del viewport. */
  centerX: number;
  centerY: number;
  /** Píxeles de pantalla por unidad del mundo. */
  zoom: number;
}
export interface ZoomLimits {
  minZoom: number;
  maxZoom: number;
}

/** Factor por «muesca» de rueda (100 unidades de deltaY): el mismo que el visor. */
export const WHEEL_ZOOM_STEP = 1.2;

export function worldToScreen(p: Pt, v: View, vp: Size): Pt {
  return { x: (p.x - v.centerX) * v.zoom + vp.w / 2, y: (p.y - v.centerY) * v.zoom + vp.h / 2 };
}

export function screenToWorld(p: Pt, v: View, vp: Size): Pt {
  return { x: v.centerX + (p.x - vp.w / 2) / v.zoom, y: v.centerY + (p.y - vp.h / 2) / v.zoom };
}

export function clampZoom(zoom: number, lim: ZoomLimits): number {
  if (!Number.isFinite(zoom)) return lim.minZoom;
  return Math.min(lim.maxZoom, Math.max(lim.minZoom, zoom));
}

/** Factor multiplicativo de zoom para un deltaY de rueda (deltaY<0 acerca). */
export function wheelZoomFactor(deltaY: number, step = WHEEL_ZOOM_STEP): number {
  return Math.pow(step, -deltaY / 100);
}

/**
 * Zoom multiplicativo manteniendo QUIETO en pantalla el punto del mundo que está
 * bajo `pointerPx` (fórmula de CameraInteraction.onWheel). Respeta los límites.
 */
export function zoomAt(v: View, factor: number, pointerPx: Pt, vp: Size, lim: ZoomLimits): View {
  const zoom = clampZoom(v.zoom * factor, lim);
  const world = screenToWorld(pointerPx, v, vp);
  return {
    centerX: world.x - (pointerPx.x - vp.w / 2) / zoom,
    centerY: world.y - (pointerPx.y - vp.h / 2) / zoom,
    zoom,
  };
}

/** Zoom a un valor absoluto, anclado en el centro del viewport (botones +/−, 100 %). */
export function zoomTo(v: View, zoom: number, vp: Size, lim: ZoomLimits): View {
  return zoomAt(v, zoom / v.zoom, { x: vp.w / 2, y: vp.h / 2 }, vp, lim);
}

/** Pan: arrastrar el contenido `dx,dy` píxeles (el mundo sigue al puntero). */
export function panByPixels(v: View, dxPx: number, dyPx: number): View {
  return { centerX: v.centerX - dxPx / v.zoom, centerY: v.centerY - dyPx / v.zoom, zoom: v.zoom };
}

/** Vista que encaja un mundo de `world` unidades en el viewport, con margen en px. */
export function fitView(world: Size, vp: Size, paddingPx = 16): View {
  const w = Math.max(1, vp.w - 2 * paddingPx);
  const h = Math.max(1, vp.h - 2 * paddingPx);
  const zoom = Math.min(w / Math.max(world.w, 1e-6), h / Math.max(world.h, 1e-6));
  return { centerX: world.w / 2, centerY: world.h / 2, zoom: zoom > 0 && Number.isFinite(zoom) ? zoom : 1 };
}

/**
 * Recorte: el centro de la vista nunca sale del mundo, así que siempre queda al
 * menos un cuarto del mapa a la vista y no se puede «perder» el mapa con el pan.
 */
export function clampCenter(v: View, world: Size): View {
  return {
    centerX: Math.min(world.w, Math.max(0, v.centerX)),
    centerY: Math.min(world.h, Math.max(0, v.centerY)),
    zoom: v.zoom,
  };
}

/**
 * Pellizco con dos dedos: zoom por la razón de distancias, anclado en el punto medio
 * anterior, y pan por el desplazamiento del punto medio.
 */
export function pinchView(v: View, prev: [Pt, Pt], next: [Pt, Pt], vp: Size, lim: ZoomLimits): View {
  const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const d0 = dist(prev[0], prev[1]);
  const d1 = dist(next[0], next[1]);
  const m0 = mid(prev[0], prev[1]);
  const m1 = mid(next[0], next[1]);
  const factor = d0 > 0 && d1 > 0 ? d1 / d0 : 1;
  const zoomed = zoomAt(v, factor, m0, vp, lim);
  return panByPixels(zoomed, m1.x - m0.x, m1.y - m0.y);
}
