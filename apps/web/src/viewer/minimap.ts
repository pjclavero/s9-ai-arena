/**
 * UX-VIEW · MINIMAPA FUERA del escenario — geometría PURA.
 *
 * Antes (R3.6) el minimapa era una segunda cámara de Phaser DENTRO del canvas,
 * en la esquina inferior izquierda: tapaba el mapa (un bot podía quedar debajo,
 * invisible), coincidía con el kill feed, no se podía ocultar ni pulsar, no
 * mostraba la vista y no se recolocaba al redimensionar.
 *
 * Ahora es un panel propio (MinimapPanel.tsx, un <canvas> 2D fuera del área del
 * escenario) que dibuja a partir de este modelo:
 *  - el mapa encajado en su caja con margen (límites + muros + destructibles);
 *  - cada vehículo como un punto de radio mínimo garantizado y DENTRO del mapa
 *    dibujado (nunca fuera de la caja ni bajo nada);
 *  - el rectángulo de la cámara principal (lo que se ve en el escenario);
 *  - el seleccionado resaltado.
 * Pulsar o arrastrar en el minimapa centra la cámara en ese punto (minimapToWorld).
 */

export interface WorldSize {
  widthM: number;
  heightM: number;
}

/** Encaje del mapa en la caja del minimapa, en píxeles CSS. */
export interface MinimapLayout {
  /** px CSS por metro. */
  scale: number;
  /** Esquina superior izquierda del mapa dibujado dentro de la caja. */
  offsetX: number;
  offsetY: number;
  /** Tamaño del mapa dibujado. */
  mapW: number;
  mapH: number;
  /** Caja completa. */
  boxW: number;
  boxH: number;
}

export const MINIMAP_PADDING_PX = 6;
/** Radio mínimo de un vehículo en el minimapa: siempre visible, por pequeño que sea el mapa. */
export const MIN_DOT_RADIUS_PX = 3;

export function computeMinimapLayout(
  world: WorldSize,
  boxW: number,
  boxH: number,
  paddingPx = MINIMAP_PADDING_PX,
): MinimapLayout {
  const wM = Math.max(1, world.widthM);
  const hM = Math.max(1, world.heightM);
  const usableW = Math.max(1, boxW - paddingPx * 2);
  const usableH = Math.max(1, boxH - paddingPx * 2);
  const scale = Math.min(usableW / wM, usableH / hM);
  const mapW = wM * scale;
  const mapH = hM * scale;
  return { scale, offsetX: (boxW - mapW) / 2, offsetY: (boxH - mapH) / 2, mapW, mapH, boxW, boxH };
}

/** Alto de la caja para un ancho dado, con la proporción del mapa (acotado). */
export function minimapBoxHeight(world: WorldSize, boxW: number, paddingPx = MINIMAP_PADDING_PX): number {
  const ratio = Math.max(1, world.heightM) / Math.max(1, world.widthM);
  return Math.round(Math.max(60, Math.min(boxW * 1.5, (boxW - paddingPx * 2) * ratio + paddingPx * 2)));
}

export function worldToMinimap(l: MinimapLayout, x: number, y: number): { x: number; y: number } {
  return { x: l.offsetX + x * l.scale, y: l.offsetY + y * l.scale };
}

/** Punto de la caja → metros del mundo, recortado a los límites del mapa. */
export function minimapToWorld(l: MinimapLayout, world: WorldSize, px: number, py: number): { x: number; y: number } {
  const x = (px - l.offsetX) / l.scale;
  const y = (py - l.offsetY) / l.scale;
  return { x: Math.min(world.widthM, Math.max(0, x)), y: Math.min(world.heightM, Math.max(0, y)) };
}

export interface MinimapVehicle {
  id: string;
  x: number;
  y: number;
  alive: boolean;
  team?: string;
}

export interface MinimapDot {
  id: string;
  x: number;
  y: number;
  r: number;
  alive: boolean;
  team?: string;
  selected: boolean;
}

/**
 * Puntos de los vehículos: radio ≥ MIN_DOT_RADIUS_PX y centro recortado al mapa
 * dibujado (un vehículo pegado al borde no se sale de la caja). El seleccionado
 * va el ÚLTIMO para pintarse encima de los demás.
 */
export function minimapDots(
  vehicles: Iterable<MinimapVehicle>,
  l: MinimapLayout,
  selectedId: string | null,
  vehicleRadiusM = 1.6,
): MinimapDot[] {
  const r = Math.max(MIN_DOT_RADIUS_PX, vehicleRadiusM * l.scale);
  const out: MinimapDot[] = [];
  for (const v of vehicles) {
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) continue;
    const p = worldToMinimap(l, v.x, v.y);
    out.push({
      id: v.id,
      x: Math.min(l.offsetX + l.mapW - r, Math.max(l.offsetX + r, p.x)),
      y: Math.min(l.offsetY + l.mapH - r, Math.max(l.offsetY + r, p.y)),
      r: v.id === selectedId ? r + 1.5 : r,
      alive: v.alive,
      team: v.team,
      selected: v.id === selectedId,
    });
  }
  out.sort((a, b) => Number(a.selected) - Number(b.selected));
  return out;
}

export interface CameraView {
  centerX: number;
  centerY: number;
  /** px de búfer por metro. */
  zoom: number;
  /** Viewport de la cámara en px de búfer. */
  viewportW: number;
  viewportH: number;
}

/** Rectángulo de la vista de la cámara principal en la caja, recortado al mapa dibujado. */
export function minimapViewRect(
  l: MinimapLayout,
  cam: CameraView,
): { x: number; y: number; w: number; h: number } | null {
  if (!(cam.zoom > 0)) return null;
  const halfW = cam.viewportW / (2 * cam.zoom);
  const halfH = cam.viewportH / (2 * cam.zoom);
  const a = worldToMinimap(l, cam.centerX - halfW, cam.centerY - halfH);
  const b = worldToMinimap(l, cam.centerX + halfW, cam.centerY + halfH);
  const x0 = Math.max(l.offsetX, a.x);
  const y0 = Math.max(l.offsetY, a.y);
  const x1 = Math.min(l.offsetX + l.mapW, b.x);
  const y1 = Math.min(l.offsetY + l.mapH, b.y);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export type MinimapSize = "s" | "m" | "l";

/** Ancho de la caja del minimapa (px CSS) para la preferencia y el hueco disponible. */
export function minimapWidthFor(size: MinimapSize, availableW: number): number {
  const want = size === "s" ? 160 : size === "l" ? 320 : 240;
  return Math.max(120, Math.min(want, Math.floor(availableW)));
}

/** Dos rectángulos (p. ej. minimapa y escenario, en coordenadas de página) se solapan. */
export function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
