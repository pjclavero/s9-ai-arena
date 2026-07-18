/**
 * R3.2 · ERR-VIS-07 — Interacción de cámara del visor: rueda para zoom (hacia el
 * cursor), arrastre para pan y teclas 1–4 para seguir bots.
 *
 * Máquina de estados PURA: recibe entradas ya normalizadas (deltas de rueda,
 * desplazamientos de arrastre en píxeles, teclas) y produce el CameraMode que la
 * escena debe usar. Rueda o arrastre pasan a modo `manual`; una tecla o un botón
 * de modo devuelven el control a los modos automáticos. El cableado DOM
 * (listeners sobre el canvas) vive en PhaserViewer; aquí no hay navegador.
 */
import { clampToMap, type CameraConfig, type CameraMode, type CameraTarget } from "./camera.js";

export interface InteractionView {
  /** Estado ACTUAL de la cámara (ya suavizado), para partir de lo que se ve. */
  current: CameraTarget;
  cfg: CameraConfig;
}

const ZOOM_STEP = 1.2; // factor por "muesca" de rueda (100 unidades de deltaY)

export class CameraInteraction {
  private mode: CameraMode;

  constructor(initial: CameraMode = { kind: "global" }) {
    this.mode = initial;
  }

  get current(): CameraMode {
    return this.mode;
  }

  /** Cambio de modo desde la UI (botones de la página o teclas). */
  setMode(mode: CameraMode): void {
    this.mode = mode;
  }

  /**
   * Rueda: zoom multiplicativo HACIA el punto del cursor (el punto del mundo
   * bajo el ratón se queda quieto en pantalla). Pasa a modo manual.
   */
  onWheel(deltaY: number, pointerPx: { x: number; y: number }, view: InteractionView): CameraMode {
    const { current, cfg } = view;
    const minZoom = cfg.minZoom ?? 0.5;
    const maxZoom = cfg.maxZoom ?? 40;
    const factor = Math.pow(ZOOM_STEP, -deltaY / 100);
    const zoom = Math.min(maxZoom, Math.max(minZoom, current.zoom * factor));

    // Punto del mundo bajo el cursor antes del zoom…
    const worldX = current.centerX + (pointerPx.x - cfg.viewportW / 2) / current.zoom;
    const worldY = current.centerY + (pointerPx.y - cfg.viewportH / 2) / current.zoom;
    // …que debe seguir bajo el cursor después.
    const centerX = worldX - (pointerPx.x - cfg.viewportW / 2) / zoom;
    const centerY = worldY - (pointerPx.y - cfg.viewportH / 2) / zoom;

    const clamped = clampToMap({ centerX, centerY, zoom }, cfg);
    this.mode = { kind: "manual", centerX: clamped.centerX, centerY: clamped.centerY, zoom: clamped.zoom };
    return this.mode;
  }

  /** Arrastre: pan en píxeles de pantalla → metros según el zoom actual. Modo manual. */
  onDrag(dxPx: number, dyPx: number, view: InteractionView): CameraMode {
    const { current, cfg } = view;
    const clamped = clampToMap(
      {
        centerX: current.centerX - dxPx / current.zoom,
        centerY: current.centerY - dyPx / current.zoom,
        zoom: current.zoom,
      },
      cfg,
    );
    this.mode = { kind: "manual", centerX: clamped.centerX, centerY: clamped.centerY, zoom: clamped.zoom };
    return this.mode;
  }

  /**
   * Teclado: "1"–"4" siguen al bot n-ésimo (orden estable de aparición), "g"
   * vuelve a la vista global. Devuelve el modo nuevo o null si la tecla no es nuestra.
   */
  onKey(key: string, vehicleIds: string[]): CameraMode | null {
    if (key === "g" || key === "G" || key === "0") {
      this.mode = { kind: "global" };
      return this.mode;
    }
    const n = Number(key);
    if (Number.isInteger(n) && n >= 1 && n <= 4) {
      const id = vehicleIds[n - 1];
      if (!id) return null; // no hay tantos bots: la tecla no hace nada
      this.mode = { kind: "follow", vehicleId: id };
      return this.mode;
    }
    return null;
  }
}
