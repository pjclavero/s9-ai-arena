/**
 * T8.2 · Modos de cámara del visor: vista global, seguimiento de bot y vista de
 * equipo. Lógica pura (centro + zoom) que PhaserViewer aplica a su cámara.
 */

export type CameraMode =
  | { kind: "global" }
  | { kind: "follow"; vehicleId: string }
  | { kind: "team"; team: string }
  /** R3.2 · control manual del usuario (rueda + arrastre). */
  | { kind: "manual"; centerX: number; centerY: number; zoom: number };

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

  if (mode.kind === "manual") {
    return {
      centerX: mode.centerX,
      centerY: mode.centerY,
      zoom: clampZoom(mode.zoom),
    };
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

// ───────────────────────────── R3.2 · cámara suavizada (ERR-VIS-07)

/**
 * Encierra el encuadre dentro de los límites del mapa: la cámara nunca enseña
 * el vacío exterior. Si a este zoom el mapa cabe entero en un eje, ese eje se
 * centra (no hay clamp posible sin enseñar vacío por ambos lados).
 */
export function clampToMap(target: CameraTarget, cfg: CameraConfig): CameraTarget {
  const halfW = cfg.viewportW / (2 * target.zoom); // metros visibles a cada lado
  const halfH = cfg.viewportH / (2 * target.zoom);
  const cx = cfg.mapW <= halfW * 2 ? cfg.mapW / 2 : Math.min(cfg.mapW - halfW, Math.max(halfW, target.centerX));
  const cy = cfg.mapH <= halfH * 2 ? cfg.mapH / 2 : Math.min(cfg.mapH - halfH, Math.max(halfH, target.centerY));
  return { centerX: cx, centerY: cy, zoom: target.zoom };
}

export interface SmoothCameraOptions {
  /** Frecuencia natural del muelle (rad/s). Más alto = respuesta más rápida. */
  omega?: number;
  /** Radio de la zona muerta del modo follow, en metros. */
  deadzoneM?: number;
}

/**
 * Amortiguación CRÍTICA sobre centro y zoom: un muelle x'' = ω²(objetivo−x) − 2ω·x'
 * converge sin oscilar ni dar tirones — cambiar de modo de cámara o de bot seguido
 * es una transición continua, no un corte. El zoom se suaviza en espacio log
 * (multiplicativo: pasar de 4→8 px/m debe sentirse como 8→16).
 *
 * Zona muerta en follow: los micro-ajustes del bot (jitter de interpolación,
 * vaivén al esquivar) no arrastran la cámara; solo la mueve salir del radio.
 *
 * Puro respecto al reloj: avanza con dtMs del llamante. Sin Phaser.
 */
export class SmoothCamera {
  private pos: { cx: number; cy: number; logZoom: number } | null = null;
  private vel = { cx: 0, cy: 0, logZoom: 0 };
  private readonly omega: number;
  private readonly deadzoneM: number;
  /** Ancla de la zona muerta (último objetivo aceptado en follow). */
  private followAnchor: { x: number; y: number } | null = null;
  private lastModeKind: string | null = null;

  constructor(opts: SmoothCameraOptions = {}) {
    this.omega = opts.omega ?? 6;
    this.deadzoneM = opts.deadzoneM ?? 3;
  }

  /** Reset duro (reconexión/seek): saltar directamente al objetivo, sin viaje. */
  reset(): void {
    this.pos = null;
    this.vel = { cx: 0, cy: 0, logZoom: 0 };
    this.followAnchor = null;
    this.lastModeKind = null;
  }

  /**
   * Un paso de cámara: aplica deadzone (solo follow), amortigua críticamente
   * hacia el objetivo y CLAMPA el resultado a los límites del mapa.
   */
  update(mode: CameraMode, target: CameraTarget, cfg: CameraConfig, dtMs: number): CameraTarget {
    let goal = target;

    if (mode.kind === "follow") {
      if (this.lastModeKind !== "follow") this.followAnchor = null;
      const a = this.followAnchor;
      if (a && Math.hypot(target.centerX - a.x, target.centerY - a.y) <= this.deadzoneM) {
        goal = { ...target, centerX: a.x, centerY: a.y }; // dentro de la zona muerta: no perseguir
      } else {
        this.followAnchor = { x: target.centerX, y: target.centerY };
      }
    } else {
      this.followAnchor = null;
    }
    this.lastModeKind = mode.kind;

    // El objetivo ya clampado: el muelle nunca persigue un punto fuera del mapa.
    goal = clampToMap(goal, cfg);
    const goalLogZoom = Math.log(goal.zoom);

    if (!this.pos) {
      // Primer frame: aparecer ya en el objetivo (no viajar desde (0,0)).
      this.pos = { cx: goal.centerX, cy: goal.centerY, logZoom: goalLogZoom };
      return goal;
    }

    // Integración semi-implícita en pasos de ≤ 16 ms: estable ante parones de pestaña.
    let remaining = Math.min(dtMs, 250) / 1000;
    while (remaining > 0) {
      const h = Math.min(remaining, 0.016);
      remaining -= h;
      for (const [axis, goalV] of [
        ["cx", goal.centerX],
        ["cy", goal.centerY],
        ["logZoom", goalLogZoom],
      ] as const) {
        const x = this.pos[axis];
        const v = this.vel[axis];
        const accel = this.omega * this.omega * (goalV - x) - 2 * this.omega * v;
        this.vel[axis] = v + accel * h;
        this.pos[axis] = x + this.vel[axis] * h;
      }
    }

    // El estado suavizado también se clampa: ni en tránsito se enseña el vacío.
    const clamped = clampToMap({ centerX: this.pos.cx, centerY: this.pos.cy, zoom: Math.exp(this.pos.logZoom) }, cfg);
    this.pos.cx = clamped.centerX;
    this.pos.cy = clamped.centerY;
    return clamped;
  }
}
