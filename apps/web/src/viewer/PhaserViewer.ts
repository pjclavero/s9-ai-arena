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
 * R3.3 (ERR-VIS-09/11) — presupuesto de RENDER, no solo de lógica:
 *  - todas las entidades son Sprites/BitmapText de UN atlas procedural
 *    (atlas.ts) con setTint por equipo: el renderer los batchea y los draw
 *    calls por frame bajan de ~35 (Shapes+Text, uno por entidad) a un puñado;
 *  - la capa estática del mapa (suelo+muros+destructibles) se HORNEA a una
 *    RenderTexture al recibir el mundo: 1 draw call, no O(obstáculos);
 *  - el pool de proyectiles tiene TECHO (MAX_PROJECTILE_SPRITES): un snapshot
 *    hostil no puede crear sprites sin límite;
 *  - cero asignaciones por frame en el camino caliente: el interpolador
 *    reutiliza sus mapas (FrameScratch) y applyCamera su snapshotLike;
 *  - la medición vive en render-stats.ts (FPS + draw calls reales), expuesta en
 *    `window.__s9perf` para la prueba de rendimiento de CI (Playwright).
 */
import Phaser from "phaser";
import { InterpolationBuffer } from "./interpolation.js";
import { BallisticsTracker } from "./ballistics.js";
import { OverlayState } from "./overlay.js";
import { computeCamera, SmoothCamera, type CameraConfig, type CameraMode } from "./camera.js";
import { CameraInteraction } from "./camera-interaction.js";
import { FogFader, type FogOptions } from "./fog.js";
import { canvasSizeFor } from "./viewport.js";
import { installAtlas, ATLAS_KEY, ATLAS_FONT_KEY, FRAME_SCALE } from "./atlas.js";
import { attachRenderStats, type PerfHandle } from "./render-stats.js";
import { CameraSnapshotScratch } from "./camera-snapshot.js";
import { MAX_PROJECTILE_SPRITES, visibleProjectileCount } from "./render-pools.js";
import { EffectSystem, sampleEffect, type EffectSpec } from "./effects.js";
import { damageVisualFor } from "./damage-visuals.js";
import { buildObjectivesLayer, type ObjectivesLayer } from "./objectives-overlay.js";
import {
  S9_ENV,
  resolveTeamColors,
  NEUTRAL_TEAM_COLOR,
  bodyFrameForChassis,
  barrelLengthForChassis,
  vehicleLabel,
  type ViewerRoster,
} from "./art-direction.js";

export interface ViewerWorld {
  widthM: number;
  heightM: number;
  walls?: { position: { x: number; y: number }; halfW: number; halfH: number }[];
  destructibles?: { position: { x: number; y: number }; halfW: number; halfH: number }[];
  /**
   * R3.5 · Bases del mapa (cabecera del mundo). Opcional: si la cabecera no las
   * trae, el visor no pinta bases (degrada con elegancia, sin inventar puntos).
   */
  bases?: { team: string; position: { x: number; y: number }; radiusM?: number }[];
}

export class ViewerScene extends Phaser.Scene {
  readonly interpolator = new InterpolationBuffer();
  readonly ballistics = new BallisticsTracker();
  readonly overlay = new OverlayState();
  /** R3.5 · Efectos visuales (fogonazos, impactos, explosiones, humo, decals). */
  readonly effects = new EffectSystem();
  readonly fogFader = new FogFader();
  readonly smoothCamera = new SmoothCamera();
  readonly interaction = new CameraInteraction({ kind: "global" });
  fog: FogOptions = { allowFogView: false, enabled: false, team: "red" };
  /** Capas de depuración: solo llegan si el ticket firmado lo autoriza (T8.2). */
  debugLayers: Record<string, unknown> | null = null;
  showDebug = false;

  private world: ViewerWorld = { widthM: 120, heightM: 80 };
  private vehicleGfx = new Map<string, Phaser.GameObjects.Container>();
  /**
   * R3.4 · Nómina pública (id de vehículo → bot: nombre, chasis, equipo). Llega en
   * la CABECERA `init.meta.roster` (directo) o el índice del replay; el visor NO
   * inventa campos de red. Vacía por defecto: el vehículo cae con elegancia al id
   * corto y al chasis medio si aún no hay nómina.
   */
  private roster: ViewerRoster = new Map();
  /** Colores por equipo resueltos DESDE game-rules (nunca literales en el render). */
  private teamColors = new Map<string, number>();
  /** Firma del conjunto de equipos ya resuelto, para recalcular sólo al cambiar. */
  private teamsSignature = "";
  /** Pool de sprites de proyectil con TECHO (R3.3): nunca supera MAX_PROJECTILE_SPRITES. */
  private projectilePool: Phaser.GameObjects.Sprite[] = [];
  /** Capa estática HORNEADA (suelo+muros+destructibles): 1 draw call, no O(obstáculos). */
  private staticLayer: Phaser.GameObjects.RenderTexture | null = null;
  /** R3.5 · Decals PERSISTENTES (scorch de explosiones) horneados a una RenderTexture. */
  private decalLayer: Phaser.GameObjects.RenderTexture | null = null;
  /** R3.5 · Pool de sprites de partícula (chispa/humo), con techo implícito por MAX_LIVE_EFFECTS. */
  private effectPool: Phaser.GameObjects.Sprite[] = [];
  /** R3.5 · Graphics para objetivos con forma (bases, zonas, minas). */
  private objectivesGfx: Phaser.GameObjects.Graphics | null = null;
  /** R3.5 · Sprites de bandera por team (reutilizados entre frames). */
  private flagGfx = new Map<string, Phaser.GameObjects.Sprite>();
  /** R3.5 · Última posición conocida por vehículo (para eventos sin campo position). */
  private lastVehiclePos = new Map<string, { x: number; y: number }>();
  private debugGfx: Phaser.GameObjects.Graphics | null = null;
  private perf: PerfHandle | null = null;
  /** Cuaderno reutilizado para computeCamera: cero asignaciones por frame (R3.3). */
  private readonly cameraScratch = new CameraSnapshotScratch();
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
   * R3.4 · Fija la nómina pública. Reconstruye los vehículos ya dibujados para que
   * adopten sprite por chasis, tinte de equipo y NOMBRE (no el UUID). Idempotente
   * y barato: en directo llega una vez, en el init, antes del primer snapshot.
   */
  setRoster(roster: ViewerRoster): void {
    this.roster = roster ?? new Map();
    this.teamsSignature = ""; // fuerza recálculo de colores con los equipos de la nómina
    for (const [, c] of this.vehicleGfx) c.destroy();
    this.vehicleGfx.clear();
  }

  /**
   * Color del equipo, resuelto DESDE game-rules (art-direction) sobre el conjunto
   * de equipos presentes. Recalcula sólo cuando ese conjunto cambia. Nunca hay un
   * literal de color de equipo en el render: red/blue y cualquier otro equipo
   * obtienen su tinte propio desde la capa de reglas.
   */
  private tintForTeam(team: string): number {
    const teams = new Set<string>();
    for (const v of this.overlay.vehicles.values()) teams.add(v.team);
    for (const e of this.roster.values()) if (e.team) teams.add(e.team);
    teams.add(team);
    const sig = [...teams].sort().join("|");
    if (sig !== this.teamsSignature) {
      this.teamColors = resolveTeamColors(teams);
      this.teamsSignature = sig;
    }
    return this.teamColors.get(team) ?? NEUTRAL_TEAM_COLOR;
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
    this.trackPositions(snapshot);
  }

  resetTo(snapshot: any, atMs = this.playbackNow()): void {
    this.interpolator.reset(snapshot, atMs);
    this.ballistics.reset(snapshot, atMs);
    this.fogFader.reset();
    this.smoothCamera.reset();
    this.overlay.applySnapshot(snapshot);
    // Seek/reconexión: no arrastrar partículas ni posiciones a través del hueco.
    this.effects.reset();
    this.lastVehiclePos.clear();
    this.trackPositions(snapshot);
  }

  pushEvent(event: any): void {
    this.overlay.applyEvent(event);
    // R3.5 · el mismo evento público genera su efecto (fogonazo/impacto/explosión).
    // Puramente visual: sólo LEE el evento; nunca lo muta ni toca la simulación.
    this.effects.ingestEvent(event, this.playbackNow(), (id) => this.lastVehiclePos.get(id));
  }

  /** Registra la última pose pública de cada vehículo (para eventos sin position). */
  private trackPositions(snapshot: any): void {
    for (const v of snapshot?.vehicles ?? []) {
      if (v?.position && Number.isFinite(v.position.x)) {
        this.lastVehiclePos.set(v.id, { x: v.position.x, y: v.position.y });
      }
    }
  }

  create(): void {
    // Atlas procedural (una textura para todas las entidades) + RetroFont: el
    // renderer batchea sprites y BitmapText en un puñado de draw calls (ERR-VIS-09).
    installAtlas(this);
    this.drawStatic();
    // R3.5 · capa de DECALS persistentes sobre el suelo (depth 1) y bajo los
    // vehículos (depth 3): las manchas de explosión perduran sin objetos por decal.
    this.decalLayer = this.add
      .renderTexture(0, 0, this.world.widthM * this.pxPerM, this.world.heightM * this.pxPerM)
      .setOrigin(0, 0)
      .setDepth(1);
    // R3.5 · objetivos con forma (bases/zonas/minas): un Graphics reusado por frame.
    this.objectivesGfx = this.add.graphics().setDepth(2);
    this.debugGfx = this.add.graphics().setDepth(10);
    this.wireInput();
    // Medición de rendimiento (ERR-VIS-11): FPS + draw calls reales del contexto
    // WebGL, publicados en window.__s9perf para la prueba de rendimiento de CI.
    const parent = (this.game.canvas?.parentElement as HTMLElement | null) ?? undefined;
    this.perf = attachRenderStats(this.game, parent ? { overlayParent: parent } : {});
    (globalThis as Record<string, unknown>).__s9perf = this.perf;
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.perf?.dispose();
      this.perf = null;
    });
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

    this.input.on("wheel", (pointer: Phaser.Input.Pointer, _objs: unknown, _dx: number, deltaY: number) => {
      this.interaction.onWheel(deltaY, { x: pointer.x, y: pointer.y }, view());
    });

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

  /**
   * R3.3 (ERR-VIS-09): la capa estática (suelo + muros + destructibles) se HORNEA
   * una sola vez a una RenderTexture del tamaño del mapa. Antes era un Graphics
   * con un fillRect por obstáculo REDIBUJADO — decenas de operaciones por frame;
   * ahora es una única textura que el visor pinta en 1 draw call. Sólo se re-hornea
   * cuando cambia el mundo (setWorld), no por frame.
   */
  private drawStatic(): void {
    if (!this.sys?.isActive?.()) return;
    const w = this.world.widthM * this.pxPerM;
    const h = this.world.heightM * this.pxPerM;
    if (!this.staticLayer) {
      this.staticLayer = this.add.renderTexture(0, 0, w, h).setOrigin(0, 0).setDepth(0);
    } else {
      this.staticLayer.setSize(w, h);
    }
    const rt = this.staticLayer;
    rt.clear();
    rt.fill(S9_ENV.ground, 1, 0, 0, w, h);
    // Un único Graphics temporal con TODOS los rects se hornea de un golpe y se
    // descarta: fuera de él no queda ningún objeto de escena por obstáculo.
    const g = this.make.graphics({}, false);
    g.fillStyle(S9_ENV.wall);
    for (const wall of this.world.walls ?? []) {
      g.fillRect(
        (wall.position.x - wall.halfW) * this.pxPerM,
        (wall.position.y - wall.halfH) * this.pxPerM,
        wall.halfW * 2 * this.pxPerM,
        wall.halfH * 2 * this.pxPerM,
      );
    }
    g.fillStyle(S9_ENV.destructible);
    for (const d of this.world.destructibles ?? []) {
      g.fillRect(
        (d.position.x - d.halfW) * this.pxPerM,
        (d.position.y - d.halfH) * this.pxPerM,
        d.halfW * 2 * this.pxPerM,
        d.halfH * 2 * this.pxPerM,
      );
    }
    rt.draw(g);
    g.destroy();
    // El lienzo de decals sigue el tamaño del mundo y se limpia al re-hornear el mapa.
    if (this.decalLayer) {
      this.decalLayer.setSize(w, h);
      this.decalLayer.clear();
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
    // R3.5 · efectos: los proyectiles nuevos disparan fogonazos; el casco bajo
    // humea; se pintan partículas vivas, decals y objetivos. Todo visual, sin
    // tocar la simulación (los datos de entrada sólo se leen).
    this.effects.ingestProjectiles(faded.projectiles, now);
    this.emitHullSmoke(faded, now);
    this.bakeDecals();
    this.renderEffects(now);
    this.renderObjectives(faded);
    this.applyCamera(faded, delta);
    this.renderDebug();
  }

  /** Humo creciente del casco: nivel derivado del estado PÚBLICO (damage-visuals). */
  private emitHullSmoke(frame: { vehicles: Map<string, { x: number; y: number; alive: boolean }> }, now: number): void {
    for (const [id, pose] of frame.vehicles) {
      const ov = this.overlay.vehicles.get(id);
      if (!ov) continue;
      const level = damageVisualFor(ov).smoke;
      if (level > 0) this.effects.hullSmoke(id, level, pose.x, pose.y, now);
    }
  }

  /** Hornea a la RenderTexture los decals nuevos (una sola vez por decal). */
  private bakeDecals(): void {
    if (!this.decalLayer) return;
    const decals = this.effects.drainDecals();
    if (decals.length === 0) return;
    const g = this.make.graphics({}, false);
    for (const d of decals) {
      g.fillStyle(0x000000, d.alpha);
      g.fillCircle(d.x * this.pxPerM, d.y * this.pxPerM, d.radiusM * this.pxPerM);
    }
    this.decalLayer.draw(g);
    g.destroy();
  }

  /** Pinta las partículas vivas con un pool de sprites del atlas (chispa/humo). */
  private renderEffects(now: number): void {
    const live = this.effects.active(now);
    while (this.effectPool.length < live.length) {
      const s = this.add.sprite(0, 0, ATLAS_KEY, "spark").setDepth(6);
      s.setVisible(false);
      this.effectPool.push(s);
    }
    for (let i = 0; i < this.effectPool.length; i++) {
      const s = this.effectPool[i];
      const e: EffectSpec | undefined = i < live.length ? live[i] : undefined;
      if (!e) {
        s.setVisible(false);
        continue;
      }
      const sm = sampleEffect(e, now);
      s.setFrame(e.frame);
      s.setTint(e.frame === "smoke" ? S9_ENV.wall : S9_ENV.tracer);
      s.setVisible(true)
        .setPosition(sm.x * this.pxPerM, sm.y * this.pxPerM)
        .setRotation(sm.rotation)
        .setAlpha(Math.max(0, sm.alpha))
        // El frame mide (radio·2)·pxPerM·FRAME_SCALE px de textura: reescalar a metros.
        .setDisplaySize(sm.radiusM * 2 * this.pxPerM, sm.radiusM * 2 * this.pxPerM);
    }
  }

  /**
   * R3.5 · Dibuja los objetivos públicos que hoy se ignoran: bases y zonas de
   * captura (círculos con su color de equipo/estado) y las banderas CTF con su
   * estado (en base, o sobre el portador). Deriva TODO de datos públicos vía
   * objectives-overlay (puro y probado); aquí sólo se colocan formas y sprites.
   */
  private renderObjectives(frame: { vehicles: Map<string, { x: number; y: number }> }): void {
    const g = this.objectivesGfx;
    if (!g) return;
    g.clear();
    const layer: ObjectivesLayer = buildObjectivesLayer({
      objectives: this.overlay.objectives,
      bases: this.world.bases,
      carriers: this.overlay.carriers,
      mines: (this.debugLayers?.mines as { position: { x: number; y: number } }[]) ?? [],
      canSeeMines: this.showDebug,
    });

    // Bases: anillo del color del equipo.
    for (const b of layer.bases) {
      g.lineStyle(2, this.tintForTeam(b.team), 0.8);
      g.strokeCircle(b.at.x * this.pxPerM, b.at.y * this.pxPerM, b.radiusM * this.pxPerM);
    }
    // Zonas: disco tenue + anillo; neutral en gris, en control con color de equipo.
    for (const z of layer.zones) {
      const owned = z.state !== "neutral" && z.team !== "neutral";
      const color = owned ? this.tintForTeam(z.team) : NEUTRAL_TEAM_COLOR;
      g.fillStyle(color, owned ? 0.16 : 0.08);
      g.fillCircle(z.at.x * this.pxPerM, z.at.y * this.pxPerM, z.radiusM * this.pxPerM);
      g.lineStyle(2, color, 0.9);
      g.strokeCircle(z.at.x * this.pxPerM, z.at.y * this.pxPerM, z.radiusM * this.pxPerM);
    }
    // Minas (sólo con permiso): aspa roja donde la capa de depuración las revela.
    g.lineStyle(1.5, 0xff4444, 0.9);
    for (const m of layer.mines) {
      const cx = m.at.x * this.pxPerM;
      const cy = m.at.y * this.pxPerM;
      g.strokeCircle(cx, cy, 1.2 * this.pxPerM);
    }

    // Banderas: sprite del atlas por team, tinte de equipo, colocado según estado.
    const drawn = new Set<string>();
    for (const f of layer.flags) {
      let at = f.at;
      if (!at && f.carrierId) {
        const pose = frame.vehicles.get(f.carrierId);
        if (pose) at = { x: pose.x, y: pose.y };
      }
      if (!at) continue;
      drawn.add(f.team);
      let spr = this.flagGfx.get(f.team);
      if (!spr) {
        spr = this.add
          .sprite(0, 0, ATLAS_KEY, "flag")
          .setOrigin(0, 1)
          .setScale(1 / FRAME_SCALE)
          .setDepth(4);
        this.flagGfx.set(f.team, spr);
      }
      spr
        .setVisible(true)
        .setTint(this.tintForTeam(f.team))
        .setPosition(at.x * this.pxPerM, at.y * this.pxPerM)
        // Llevada/caída se ven "inclinadas"; en base, erguida.
        .setRotation(f.state === "carried" ? 0.5 : f.state === "dropped" ? 1.2 : 0)
        .setAlpha(f.state === "captured" || f.state === "returning" ? 0.5 : 1);
    }
    for (const [team, spr] of this.flagGfx) if (!drawn.has(team)) spr.setVisible(false);
  }

  private renderFrame(frame: {
    vehicles: Map<
      string,
      { x: number; y: number; heading: number; turretHeading: number; alive: boolean; alpha: number }
    >;
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
      // R3.5 · daño VISIBLE derivado del estado público (damage-visuals): la
      // torreta BLOQUEADA (arma destruida/offline) se congela y se atenúa; el
      // casco muy dañado se oscurece. La correspondencia con el motor la prueba
      // damageVisualFor; aquí sólo se traduce a atributos de dibujo.
      const ov = this.overlay.vehicles.get(id);
      const dmg = ov ? damageVisualFor(ov) : null;
      const turret = c.getByName("turret") as Phaser.GameObjects.Container | null;
      if (turret) {
        // Bloqueada: NO gira con la torreta objetivo (se queda como está) y se atenúa.
        if (!dmg?.turretLocked) turret.setRotation(pose.turretHeading - pose.heading);
        turret.setAlpha(dmg?.turretLocked ? 0.4 : 1);
      }
      // Fundido de niebla × atenuación de destruido: sin saltos de alfa.
      c.setAlpha((pose.alive ? 1 : 0.25) * pose.alpha);
    }
    for (const [id, c] of this.vehicleGfx) {
      if (!frame.vehicles.has(id)) c.setVisible(false); // fundido terminado o destruido
    }

    // Proyectiles: pool de sprites del atlas con TECHO (R3.3). El pool crece bajo
    // demanda pero nunca por encima de MAX_PROJECTILE_SPRITES; los proyectiles
    // sobrantes de un snapshot anómalo simplemente no se dibujan.
    const visible = visibleProjectileCount(frame.projectiles.length, MAX_PROJECTILE_SPRITES);
    while (this.projectilePool.length < visible) {
      const dot = this.add
        .sprite(0, 0, ATLAS_KEY, "projectile")
        .setScale(4 / FRAME_SCALE / 3) // frame 12 px → ~4 px de diámetro en pantalla
        .setTint(S9_ENV.tracer)
        .setDepth(5);
      this.projectilePool.push(dot);
    }
    for (let i = 0; i < this.projectilePool.length; i++) {
      const dot = this.projectilePool[i];
      const p = i < visible ? frame.projectiles[i] : undefined;
      if (p) dot.setVisible(true).setPosition(p.x * this.pxPerM, p.y * this.pxPerM);
      else dot.setVisible(false);
    }
  }

  private buildVehicle(id: string): Phaser.GameObjects.Container {
    // R3.4 · Sprite MODULAR derivado del loadout (nómina) + tinte por equipo desde
    // el ruleset + NOMBRE del bot. Todo del MISMO atlas: setTint no rompe el batch
    // (cambiar de textura sí); los frames se hornean a FRAME_SCALE× px, de ahí el
    // reescalado 1/FRAME_SCALE.
    const entry = this.roster.get(id);
    const team = entry?.team ?? this.overlay.vehicles.get(id)?.team ?? "red";
    const color = this.tintForTeam(team);
    // Casco según el arquetipo del chasis: explorador/artillero/pesado a un vistazo.
    const body = this.add
      .sprite(0, 0, ATLAS_KEY, bodyFrameForChassis(entry?.chassis))
      .setScale(1 / FRAME_SCALE)
      .setTint(color);
    // Torreta = base redonda + cañón; el largo del cañón varía con el arquetipo.
    const turretBase = this.add
      .sprite(0, 0, ATLAS_KEY, "turret")
      .setScale(1 / FRAME_SCALE)
      .setTint(color);
    const barrel = this.add
      .sprite(0, 0, ATLAS_KEY, "barrel")
      .setScale(barrelLengthForChassis(entry?.chassis) / FRAME_SCALE, 1 / FRAME_SCALE)
      .setOrigin(0, 0.5)
      .setTint(color);
    const turret = this.add.container(0, 0, [turretBase, barrel]).setName("turret");
    // BitmapText del atlas (RetroFont): el NOMBRE del bot, no el UUID. Comparte
    // textura, no genera un canvas de fuente por etiqueta ni rompe el batch.
    const label = this.add
      .bitmapText(0, -2 * this.pxPerM, ATLAS_FONT_KEY, vehicleLabel(this.roster, id), 10)
      .setOrigin(0.5, 1)
      .setTint(S9_ENV.label);
    return this.add.container(0, 0, [body, turret, label]).setDepth(3);
  }

  private applyCamera(
    frame: { vehicles: Map<string, { x: number; y: number; alive: boolean; team?: string }> },
    deltaMs: number,
  ): void {
    const mode = this.interaction.current;
    // R3.3: el snapshot que consume computeCamera se REUTILIZA (cameraScratch):
    // cero asignaciones por frame en el camino caliente de la cámara.
    const snapshotLike = this.cameraScratch.fill(frame.vehicles, (id) => this.overlay.vehicles.get(id)?.team);
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
    // R3.5 · las MINAS pasaron a la capa de objetivos (renderObjectives), donde su
    // visibilidad se decide por permisos de espectador (objectives-overlay, puro y
    // probado). Este Graphics queda para futuras capas de depuración autorizadas.
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
    backgroundColor: S9_ENV.background,
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
