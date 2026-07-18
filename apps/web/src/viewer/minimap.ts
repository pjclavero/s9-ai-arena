/**
 * R3.6 · MEJ-gráficos — MINIMAPA real como SEGUNDA cámara de Phaser.
 *
 * Regla dura de la tarea: el minimapa es una cámara ADICIONAL (setViewport +
 * ignore()), NUNCA un segundo juego de entidades. Las mismas sprites del mundo
 * (mapa horneado, vehículos, objetivos) las dibujan las DOS cámaras; el minimapa
 * sólo cambia su encuadre (todo el mapa) y su viewport (esquina), e IGNORA las
 * capas de detalle que no aportan a vista de pájaro (partículas, decals, labels,
 * depuración). Así no se duplica ninguna entidad ni se toca la simulación.
 *
 * La GEOMETRÍA (viewport + zoom que encuadra el mapa entero) es pura y se prueba
 * en Node. El CABLEADO con Phaser se hace contra una superficie mínima de cámara
 * (MinimapCameraLike / MinimapSceneLike) para poder verificar en test —sin
 * navegador— que se añade UNA sola cámara y que se ignoran las capas correctas.
 */

/** Tamaño del mundo en metros (para encuadrar el mapa entero). */
export interface WorldSize {
  widthM: number;
  heightM: number;
}

/** Colocación del minimapa dentro del canvas, en píxeles de dispositivo. */
export interface MinimapPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MinimapLayout {
  /** Esquina del canvas donde ancla el minimapa. */
  corner?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  /** Fracción del lado menor del canvas que ocupa el minimapa (0..1). */
  sizeFraction?: number;
  /** Margen en píxeles al borde del canvas. */
  marginPx?: number;
  /** Píxeles por metro con que la ESCENA dibuja el mundo (mismo que el visor). */
  pxPerM: number;
}

const DEFAULT_FRACTION = 0.22;
const DEFAULT_MARGIN = 12;
const MIN_SIDE_PX = 96;
const MAX_SIDE_PX = 320;

/**
 * Viewport del minimapa: un cuadrado (lado = fracción del lado menor del canvas,
 * acotado) anclado a una esquina con margen. Determinista y acotado para que en
 * canvas diminutos o gigantes siga siendo legible.
 */
export function computeMinimapViewport(canvasW: number, canvasH: number, layout: MinimapLayout): MinimapPlacement {
  const fraction = layout.sizeFraction ?? DEFAULT_FRACTION;
  const margin = layout.marginPx ?? DEFAULT_MARGIN;
  const corner = layout.corner ?? "bottom-left";
  const side = Math.round(Math.max(MIN_SIDE_PX, Math.min(MAX_SIDE_PX, Math.min(canvasW, canvasH) * fraction)));
  const w = Math.min(side, Math.max(0, canvasW - margin * 2));
  const h = Math.min(side, Math.max(0, canvasH - margin * 2));
  const left = corner.endsWith("left");
  const top = corner.startsWith("top");
  const x = left ? margin : Math.max(margin, canvasW - w - margin);
  const y = top ? margin : Math.max(margin, canvasH - h - margin);
  return { x, y, width: w, height: h };
}

/**
 * Zoom (px/m efectivo de la cámara del minimapa RELATIVO al del visor) que hace
 * caber el mapa entero en el viewport. La escena dibuja a `pxPerM` px/m; el mundo
 * mide `widthM*pxPerM` px de ancho, así que el factor de cámara es viewport/px.
 * Se toma el menor de ambos ejes para que quepa completo, con un pequeño margen.
 */
export function computeMinimapZoom(
  placement: MinimapPlacement,
  world: WorldSize,
  pxPerM: number,
  paddingFraction = 0.06,
): number {
  const worldPxW = Math.max(1, world.widthM * pxPerM);
  const worldPxH = Math.max(1, world.heightM * pxPerM);
  const usableW = placement.width * (1 - paddingFraction);
  const usableH = placement.height * (1 - paddingFraction);
  return Math.min(usableW / worldPxW, usableH / worldPxH);
}

/** Centro del mundo en píxeles de escena (donde centrar la cámara del minimapa). */
export function worldCenterPx(world: WorldSize, pxPerM: number): { x: number; y: number } {
  return { x: (world.widthM * pxPerM) / 2, y: (world.heightM * pxPerM) / 2 };
}

/** Superficie mínima de una cámara de Phaser que el minimapa necesita. */
export interface MinimapCameraLike {
  setName(name: string): this;
  setViewport(x: number, y: number, width: number, height: number): this;
  setZoom(zoom: number): this;
  centerOn(x: number, y: number): this;
  setBackgroundColor(color: number | string): this;
  setRoundPixels(round: boolean): this;
  ignore(objects: unknown): this;
}

/** Superficie mínima de la escena/gestor de cámaras que el minimapa necesita. */
export interface MinimapSceneLike {
  cameras: {
    add(x: number, y: number, width: number, height: number, makeMain?: boolean, name?: string): MinimapCameraLike;
  };
}

export const MINIMAP_CAMERA_NAME = "minimap";

export interface MinimapConfig {
  world: WorldSize;
  pxPerM: number;
  layout?: Partial<Omit<MinimapLayout, "pxPerM">>;
  /** Color de fondo del recuadro del minimapa. */
  backgroundColor?: number;
  /**
   * Objetos de detalle que el minimapa NO debe dibujar (partículas, decals,
   * labels, depuración, chrome del HUD): se comparten en la cámara principal, se
   * ignoran aquí. Las entidades del mundo (mapa, vehículos, objetivos) NO van
   * aquí: se ven en ambas cámaras SIN duplicarse.
   */
  ignore?: unknown[];
}

/**
 * Controla la SEGUNDA cámara del minimapa. En el constructor añade EXACTAMENTE una
 * cámara a la escena (`cameras.add`), la coloca en su viewport, la encuadra al mapa
 * entero e ignora las capas de detalle. `layout()` la recoloca al redimensionar el
 * canvas. `update()` la mantiene encuadrada si cambia el mundo.
 */
export class MinimapController {
  readonly camera: MinimapCameraLike;
  private world: WorldSize;
  private readonly pxPerM: number;
  private readonly layoutOpts: MinimapLayout;

  constructor(scene: MinimapSceneLike, config: MinimapConfig) {
    this.world = config.world;
    this.pxPerM = config.pxPerM;
    this.layoutOpts = { ...config.layout, pxPerM: config.pxPerM };
    // UNA sola cámara adicional, jamás la principal (makeMain = false).
    this.camera = scene.cameras.add(0, 0, 1, 1, false, MINIMAP_CAMERA_NAME);
    this.camera.setName(MINIMAP_CAMERA_NAME).setRoundPixels(true);
    if (config.backgroundColor !== undefined) this.camera.setBackgroundColor(config.backgroundColor);
    // Ignorar SOLO las capas de detalle: las entidades del mundo se comparten.
    for (const obj of config.ignore ?? []) this.camera.ignore(obj);
  }

  /** Recoloca y reencuadra el minimapa para el tamaño de canvas dado. */
  layout(canvasW: number, canvasH: number): MinimapPlacement {
    const placement = computeMinimapViewport(canvasW, canvasH, this.layoutOpts);
    const zoom = computeMinimapZoom(placement, this.world, this.pxPerM);
    const center = worldCenterPx(this.world, this.pxPerM);
    this.camera
      .setViewport(placement.x, placement.y, placement.width, placement.height)
      .setZoom(zoom)
      .centerOn(center.x, center.y);
    return placement;
  }

  /** El mundo cambió (setWorld): reencuadrar al nuevo tamaño manteniendo viewport. */
  setWorld(world: WorldSize, canvasW: number, canvasH: number): void {
    this.world = world;
    this.layout(canvasW, canvasH);
  }
}
