/**
 * T8.2/T8.3 · Capa de RENDER del visor con Phaser (cap. 20.1).
 *
 * Deliberadamente tonta: toda la lógica (conexión, interpolación, overlay, cámara,
 * niebla, reproducción) vive en módulos puros probados con vitest. Este archivo
 * solo dibuja el frame que le dan. No hay navegador en el entorno de desarrollo
 * (sin Playwright): esta capa se verifica con el test manual guionizado de la
 * entrega (docs/entrega-E8.md) y su presupuesto de 60 fps queda documentado allí.
 *
 * Presupuesto de render por frame (60 fps ⇒ 16,6 ms): 4 bots + 20 proyectiles +
 * 50 obstáculos = ~74 Graphics/Sprites reutilizados (object pool, cero allocs por
 * frame en el camino caliente); el trabajo por frame es O(entidades) sin física
 * en cliente. Es el presupuesto del DoD, medible con el guion manual.
 */
import Phaser from "phaser";
import { SnapshotInterpolator, type InterpolatedFrame } from "./interpolation.js";
import { OverlayState } from "./overlay.js";
import { computeCamera, type CameraMode } from "./camera.js";
import { applyFog, type FogOptions } from "./fog.js";

export interface ViewerWorld {
  widthM: number;
  heightM: number;
  walls?: { position: { x: number; y: number }; halfW: number; halfH: number }[];
  destructibles?: { position: { x: number; y: number }; halfW: number; halfH: number }[];
}

const TEAM_COLORS: Record<string, number> = { red: 0xe05555, blue: 0x5588e0 };

export class ViewerScene extends Phaser.Scene {
  readonly interpolator = new SnapshotInterpolator();
  readonly overlay = new OverlayState();
  cameraMode: CameraMode = { kind: "global" };
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

  constructor() {
    super("viewer");
  }

  setWorld(world: ViewerWorld): void {
    this.world = world;
    this.drawStatic();
  }

  /** Entrada de datos desde SpectatorClient / ReplayPlayer. */
  pushSnapshot(snapshot: any, receivedAtMs = performance.now()): void {
    const filtered = applyFog(snapshot, this.fog);
    this.interpolator.push(filtered, receivedAtMs);
    this.overlay.applySnapshot(filtered);
  }

  resetTo(snapshot: any, receivedAtMs = performance.now()): void {
    const filtered = applyFog(snapshot, this.fog);
    this.interpolator.reset(filtered, receivedAtMs);
    this.overlay.applySnapshot(filtered);
  }

  pushEvent(event: any): void {
    this.overlay.applyEvent(event);
  }

  create(): void {
    this.drawStatic();
    this.debugGfx = this.add.graphics().setDepth(10);
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
      g.fillRect((w.position.x - w.halfW) * this.pxPerM, (w.position.y - w.halfH) * this.pxPerM, w.halfW * 2 * this.pxPerM, w.halfH * 2 * this.pxPerM);
    }
    g.fillStyle(0x6a5a30);
    for (const d of this.world.destructibles ?? []) {
      g.fillRect((d.position.x - d.halfW) * this.pxPerM, (d.position.y - d.halfH) * this.pxPerM, d.halfW * 2 * this.pxPerM, d.halfH * 2 * this.pxPerM);
    }
  }

  update(): void {
    const frame = this.interpolator.sampleAt(performance.now());
    if (!frame) return;
    this.renderFrame(frame);
    this.applyCamera(frame);
    this.renderDebug();
  }

  private renderFrame(frame: InterpolatedFrame): void {
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
      c.setAlpha(pose.alive ? 1 : 0.25);
    }
    for (const [id, c] of this.vehicleGfx) {
      if (!frame.vehicles.has(id)) c.setVisible(false); // fuera de la niebla o destruido
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
    const turret = this.add.rectangle(0.8 * this.pxPerM, 0, 2.4 * this.pxPerM, 0.5 * this.pxPerM, 0xffffff, 0.9).setName("turret").setOrigin(0.1, 0.5);
    const label = this.add.text(0, -2 * this.pxPerM, id, { fontSize: "10px", color: "#ffffff" }).setOrigin(0.5, 1);
    return this.add.container(0, 0, [body, turret, label]).setDepth(3);
  }

  private applyCamera(frame: InterpolatedFrame): void {
    const snapshotLike = {
      vehicles: [...frame.vehicles.entries()].map(([id, p]) => ({
        id,
        team: this.overlay.vehicles.get(id)?.team,
        alive: p.alive,
        position: { x: p.x, y: p.y },
      })),
    };
    const target = computeCamera(this.cameraMode, snapshotLike, {
      viewportW: this.scale.width,
      viewportH: this.scale.height,
      mapW: this.world.widthM,
      mapH: this.world.heightM,
    });
    const cam = this.cameras.main;
    cam.centerOn(target.centerX * this.pxPerM, target.centerY * this.pxPerM);
    // computeCamera devuelve px/m deseados; la escena ya dibuja a pxPerM px/m.
    cam.setZoom(target.zoom / this.pxPerM);
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

export function createViewerGame(parent: HTMLElement): Phaser.Game {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: parent.clientWidth || 960,
    height: parent.clientHeight || 640,
    backgroundColor: "#101410",
    scene: [ViewerScene],
  });
}
