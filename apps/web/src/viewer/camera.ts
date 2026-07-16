/**
 * T8.2 · Modos de cámara del visor: vista global, seguimiento de bot y vista de
 * equipo. Lógica pura (centro + zoom) que PhaserViewer aplica a su cámara.
 */

export type CameraMode =
  | { kind: "global" }
  | { kind: "follow"; vehicleId: string }
  | { kind: "team"; team: string };

export interface CameraTarget {
  centerX: number;
  centerY: number;
  /** píxeles por metro. */
  zoom: number;
}

export interface CameraConfig {
  viewportW: number;
  viewportH: number;
  mapW: number;
  mapH: number;
  /** Margen en metros alrededor del encuadre. */
  paddingM?: number;
  followZoom?: number;
  minZoom?: number;
  maxZoom?: number;
}

export function computeCamera(mode: CameraMode, snapshot: any, cfg: CameraConfig): CameraTarget {
  const pad = cfg.paddingM ?? 4;
  const minZoom = cfg.minZoom ?? 0.5;
  const maxZoom = cfg.maxZoom ?? 40;
  const clampZoom = (z: number) => Math.min(maxZoom, Math.max(minZoom, z));
  const global: CameraTarget = {
    centerX: cfg.mapW / 2,
    centerY: cfg.mapH / 2,
    zoom: clampZoom(Math.min(cfg.viewportW / (cfg.mapW + pad * 2), cfg.viewportH / (cfg.mapH + pad * 2))),
  };

  const vehicles: any[] = snapshot?.vehicles ?? [];
  if (mode.kind === "follow") {
    const v = vehicles.find((x) => x.id === mode.vehicleId && x.position);
    if (!v) return global; // el bot ha muerto o no existe: no dejar la cámara colgada
    return { centerX: v.position.x, centerY: v.position.y, zoom: clampZoom(cfg.followZoom ?? 12) };
  }

  if (mode.kind === "team") {
    const own = vehicles.filter((x) => x.team === mode.team && x.position && x.alive);
    if (own.length === 0) return global;
    const xs = own.map((v) => v.position.x);
    const ys = own.map((v) => v.position.y);
    const minX = Math.min(...xs) - pad;
    const maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad;
    const maxY = Math.max(...ys) + pad;
    return {
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
      zoom: clampZoom(Math.min(cfg.viewportW / Math.max(1, maxX - minX), cfg.viewportH / Math.max(1, maxY - minY))),
    };
  }

  return global;
}
