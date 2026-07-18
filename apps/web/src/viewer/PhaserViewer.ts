/**
 * T8.2/T8.3 · Capa de RENDER del visor con Phaser (cap. 20.1).
 *
 * Deliberadamente tonta: toda la lógica (conexión, interpolación, balística
 * local, overlay, cámara suavizada, niebla con fundido, reproducción) vive en
 * módulos puros probados con vitest. Este archivo solo dibuja el frame que le
 * dan y cablea la entrada (rueda/arrastre/teclas) hacia CameraInteraction.
 * No hay navegador en el entorno de desarrollo (sin Playwright): esta capa se
 * verifica con el test manual guionizado de la entrega (docs/entrega-E8.md).
 *
 * R3.2 (ERR-VIS-06/07):
 *  - los snapshots entran ÍNTEGROS al buffer de interpolación (delta de ticks);
 *  - los proyectiles se simulan localmente (BallisticsTracker);
 *  - la niebla se aplica DESPUÉS de interpolar, con fundido e histéresis;
 *  - la cámara pasa por SmoothCamera (amortiguación crítica + deadzone + clamp).
 *
 * Presupuesto de render por frame (60 fps ⇒ 16,6 ms): 4 bots + 20 proyectiles +
 * 50 obstáculos = ~74 Graphics/Sprites reutilizados (object pool, cero allocs por
 * frame en el camino caliente); el trabajo por frame es O(entidades) sin física
 * de vehículos en cliente (la balística local es una integración lineal por
 * proyectil). Es el presupuesto del DoD, medible con el guion manual.
 */
import Phaser from "phaser";
import { InterpolationBuffer } from "./interpolation.js";
import { BallisticsTracker } from "./ballistics.js";
import { OverlayState } from "./overlay.js";
import { computeCamera, SmoothCamera, type CameraConfig, type CameraMode } from "./camera.js";
import { CameraInteraction } from "./camera-interaction.js";
import { FogFader, type FogOptions } from "./fog.js";
import { canvasSizeFor } from "./viewport.js";

export interface ViewerWorld {
  widthM: number;
  heightM: number;
  walls?: { position: { x: number; y: number }; halfW: number; halfH: number }[];
  destructibles?: { position: { x: number; y: number }; halfW: number; halfH: number }[];
}

const TEAM_COLORS: Record<string, number> = { red: 0xe05555, blue: 0x5588e0 };

export class ViewerScene extends Phaser.Scene {
  readonly interpolator = new InterpolationBuffer();
  readonly ballistics = new BallisticsTracker();
  readonly overlay = new OverlayState();
  readonly fogFader = new FogFader();
  readonly smoothCamera = new SmoothCamera();
  readonly interaction = new CameraInteraction({ kind: "global" });
  fog: FogOptions = { allowFogView: false, enabled: false, team: "red" };
  /** Capas de depuración: solo llegan si el ticket firmado lo autoriza (T8.2). */
  debugLayers: Record<string, unknown> | null = null;
  showDebug = false;

  private world: ViewerWorld = { widthM: 120, heightM: 80 };
  private vehicleGfx = new Map<string, Phaser.GameObjects.Container>();
  private projectilePool: Phaser.GameObjects.Arc[] = [];
  private staticLayer: Phaser.GameObjects.Graphics | null = null;
  private debugGfx: Phaser.GameObjects.Graphics | null = null;
  private readonly pxPerM = 8;
  /** Último encuadre aplicado (para que la interacción parta de lo que se ve). */
  private lastCamera: { centerX: number; centerY: number; zoom: number } | null = null;

  constructor() {
    super("viewer");
  }

  /** Compatibilidad con las páginas: el modo de cámara vive en CameraInteraction. */
  get cameraMode(): CameraMode {
    return this.interaction.current;
  }

  set cameraMode(mode: CameraMode) {
    this.interaction.setMode(mode);
  }

  setWorld(world: ViewerWorld): void {
    this.world = world;
    this.drawStatic();
  }

  /**
   * Reloj de reproducción explícito (R3.1 · ERR-VIS-01): la escena muestrea el
   * interpolador SIEMPRE con este reloj, y es el mismo eje temporal en el que los
   * llamantes fechan sus snapshots. En directo es el DelayClock de LiveFeed
   * (eje de partida con ~2 intervalos de retardo, R3.2); en replay es el playhead
   * del reproductor convertido a ms. Directo y replay comparten la misma ruta de
   * interpolación sin duplicarla.
   */
  private playbackClock: () => number = () => performance.now();

  setPlaybackClock(clock: () => number): void {
    this.playbackClock = clock;
  }

  /** Instante actual del reloj de reproducción (eje temporal de los snapshots). */
  playbackNow(): number {
    return this.playbackClock();
  }

  /**
   * Entrada de datos desde LiveFeed / ReplayFeed. El snapshot entra ÍNTEGRO:
   * la niebla se aplica DESPUÉS de interpolar (R3.2 · ERR-VIS-07).
   */
  pushSnapshot(snapshot: any, atMs = this.playbackNow()): void {
    this.interpolator.push(snapshot, atMs);
    this.ballistics.observe(snapshot, atMs);
    this.overlay.applySnapshot(snapshot);
  }

  resetTo(snapshot: any, atMs = this.playbackNow()): void {
    this.interpolator.reset(snapshot, atMs);
    this.ballistics.reset(snapshot, atMs);
    this.fogFader.reset();
    this.smoothCamera.reset();
    this.overlay.applySnapshot(snapshot);
  }

  pushEvent(event: any): void {
    this.overlay.applyEvent(event);
  }

  create(): void {
    this.drawStatic();
    this.debugGfx = this.add.graphics().setDepth(10);
    this.wireInput();
  }

  /** Rueda = zoom al cursor; arrastre = pan; teclas 1–4 = seguir bots; G = global. */
  private wireInput(): void {
    const view = () => ({
      current: this.lastCamera ?? {
        centerX: this.world.widthM / 2,
        centerY: this.world.heightM / 2,
        zoom: this.pxPerM,
      },
      cfg: this.cameraConfig(),
    });

    this.input.on(
      "wheel",
      (pointer: Phaser.Input.Pointer, _objs: unknown, _dx: number, deltaY: number) => {
        this.interaction.onWheel(deltaY, { x: pointer.x, y: pointer.y }, view());
      },
    );

    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (!pointer.isDown) return;
      const dx = pointer.x - pointer.prevPosition.x;
      const dy = pointer.y - pointer.prevPosition.y;
      if (dx !== 0 || dy !== 0) this.interaction.onDrag(dx, dy, view());
    });

    this.input.keyboard?.on("keydown", (ev: KeyboardEvent) => {
      // Orden estable de bots: el de aparición en el overlay (el del snapshot).
      this.interaction.onKey(ev.key, [...this.overlay.vehicles.keys()]);
    });
  }

  private cameraConfig(): CameraConfig {
    return {
      viewportW: this.scale.width,
      viewportH: this.scale.height,
      mapW: this.world.widthM,
      mapH: this.world.heightM,
    };
  }

  private drawStatic(): void {
    if (!this.staticLayer) {
      if (!this.sys?.isActive?.()) return;
      this.staticLayer = this.add.graphics().setDepth(0);
    }
    const g = this.staticLayer;
    g.clear();
    g.fillStyle(0x18201a).fillRect(0, 0, this.world.widthM * this.pxPerM, this.world.heightM * this.pxPerM);
    g.fillStyle(0x3a4440);
    for (const w of this.world.walls ?? []) {
      g.fillRect(
        (w.position.x - w.halfW) * this.pxPerM,
        (w.position.y - w.halfH) * this.pxPerM,
        w.halfW * 2 * this.pxPerM,
        w.halfH * 2 * this.pxPerM,
      );
    }
    g.fillStyle(0x6a5a30);
    for (const d of this.world.destructibles ?? []) {
      g.fillRect(
        (d.position.x - d.halfW) * this.pxPerM,
        (d.position.y - d.halfH) * this.pxPerM,
        d.halfW * 2 * this.pxPerM,
        d.halfH * 2 * this.pxPerM,
      );
    }
  }

  update(_time: number, delta: number): void {
    const now = this.playbackNow();
    const frame = this.interpolator.sampleAt(now);
    if (!frame) return;
    // Niebla DESPUÉS de interpolar, con fundido e histéresis (ERR-VIS-07); los
    // proyectiles vienen de la simulación balística local (ERR-VIS-06).
    const faded = this.fogFader.apply(
      { tick: frame.tick, vehicles: frame.vehicles, projectiles: this.ballistics.sampleAt(now) },
      this.fog,
      delta,
    );
    this.renderFrame(faded);
    this.applyCamera(faded, delta);
    this.renderDebug();
  }

  private renderFrame(frame: {
    vehicles: Map<string, { x: number; y: number; heading: number; turretHeading: number; alive: boolean; alpha: number }>;
    projectiles: { id: string; x: number; y: number }[];
  }): void {
    // Vehículos: contenedor por id, reutilizado entre frames (cero allocs en caliente).
    for (const [id, pose] of frame.vehicles) {
      let c = this.vehicleGfx.get(id);
      if (!c) {
        c = this.buildVehicle(id);
        this.vehicleGfx.set(id, c);
      }
      c.setVisible(true);
      c.setPosition(pose.x * this.pxPerM, pose.y * this.pxPerM);
      c.setRotation(pose.heading);
      (c.getByName("turret") as Phaser.GameObjects.Rectangle | null)?.setRotation(pose.turretHeading - pose.heading);
      // Fundido de niebla × atenuación de destruido: sin saltos de alfa.
      c.setAlpha((pose.alive ? 1 : 0.25) * pose.alpha);
    }
    for (const [id, c] of this.vehicleGfx) {
      if (!frame.vehicles.has(id)) c.setVisible(false); // fundido terminado o destruido
    }

    // Proyectiles: pool fijo.
    while (this.projectilePool.length < frame.projectiles.length) {
      this.projectilePool.push(this.add.circle(0, 0, 2, 0xffe066).setDepth(5));
    }
    this.projectilePool.forEach((dot, i) => {
      const p = frame.projectiles[i];
      if (p) dot.setVisible(true).setPosition(p.x * this.pxPerM, p.y * this.pxPerM);
      else dot.setVisible(false);
    });
  }

  private buildVehicle(id: string): Phaser.GameObjects.Container {
    const team = this.overlay.vehicles.get(id)?.team ?? "red";
    const color = TEAM_COLORS[team] ?? 0xaaaaaa;
    const body = this.add.rectangle(0, 0, 3.2 * this.pxPerM, 2.2 * this.pxPerM, color);
    const turret = this.add
      .rectangle(0.8 * this.pxPerM, 0, 2.4 * this.pxPerM, 0.5 * this.pxPerM, 0xffffff, 0.9)
      .setName("turret")
      .setOrigin(0.1, 0.5);
    const label = this.add.text(0, -2 * this.pxPerM, id, { fontSize: "10px", color: "#ffffff" }).setOrigin(0.5, 1);
    return this.add.container(0, 0, [body, turret, label]).setDepth(3);
  }

  private applyCamera(
    frame: { vehicles: Map<string, { x: number; y: number; alive: boolean; team?: string }> },
    deltaMs: number,
  ): void {
    const mode = this.interaction.current;
    const snapshotLike = {
      vehicles: [...frame.vehicles.entries()].map(([id, p]) => ({
        id,
        team: p.team ?? this.overlay.vehicles.get(id)?.team,
        alive: p.alive,
        position: { x: p.x, y: p.y },
      })),
    };
    const cfg = this.cameraConfig();
    const target = computeCamera(mode, snapshotLike, cfg);
    // Amortiguación crítica + deadzone (follow) + clamp al mapa (R3.2 · ERR-VIS-07).
    const smoothed = this.smoothCamera.update(mode, target, cfg, deltaMs);
    this.lastCamera = smoothed;
    const cam = this.cameras.main;
    cam.centerOn(smoothed.centerX * this.pxPerM, smoothed.centerY * this.pxPerM);
    // computeCamera devuelve px/m deseados; la escena ya dibuja a pxPerM px/m.
    cam.setZoom(smoothed.zoom / this.pxPerM);
  }

  private renderDebug(): void {
    if (!this.debugGfx) return;
    this.debugGfx.clear();
    if (!this.showDebug || !this.debugLayers) return;
    const mines = (this.debugLayers.mines as { position: { x: number; y: number } }[]) ?? [];
    this.debugGfx.lineStyle(1, 0xff4444, 0.9);
    for (const m of mines) {
      this.debugGfx.strokeCircle(m.position.x * this.pxPerM, m.position.y * this.pxPerM, 2.5 * this.pxPerM);
    }
  }
}

export interface ViewerGameOptions {
  /**
   * FPS objetivo de ESTA vista (R3.2): 60 en el visor/replay interactivos; la
   * vista /broadcast lo fija a los fps de captura del streamer (30 por defecto)
   * para no renderizar frames que la emisión nunca capturará.
   */
  targetFps?: number;
}

export function createViewerGame(parent: HTMLElement, opts: ViewerGameOptions = {}): Phaser.Game {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const initial = canvasSizeFor(parent.clientWidth || 960, parent.clientHeight || 640, dpr);
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: initial.width,
    height: initial.height,
    backgroundColor: "#101410",
    // Escala tipo RESIZE con devicePixelRatio (R3.2): Phaser.Scale.RESIZE ignora
    // el dpr (buffer = px CSS ⇒ borroso en HiDPI), así que el "sigue a tu
    // contenedor" se hace con ResizeObserver + scale.resize(css×dpr) y el zoom
    // del ScaleManager devuelve el canvas a su tamaño CSS.
    scale: { mode: Phaser.Scale.NONE, zoom: initial.zoom },
    fps: { target: opts.targetFps ?? 60 },
    scene: [ViewerScene],
  });

  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => {
      const size = canvasSizeFor(parent.clientWidth || 960, parent.clientHeight || 640, window.devicePixelRatio || 1);
      game.scale.setZoom(size.zoom);
      game.scale.resize(size.width, size.height);
    });
    observer.observe(parent);
    game.events.once(Phaser.Core.Events.DESTROY, () => observer.disconnect());
  }
  return game;
}
