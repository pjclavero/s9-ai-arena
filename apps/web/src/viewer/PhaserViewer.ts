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
import {
  clampToMap,
  computeCamera,
  SmoothCamera,
  type CameraConfig,
  type CameraMode,
  type CameraTarget,
} from "./camera.js";
import { CameraInteraction } from "./camera-interaction.js";
import { FogFader, type FogOptions } from "./fog.js";
import { applyCanvasSize, canvasSizeFor } from "./viewport.js";
import { waitForScene, type GameLike } from "./scene-ready.js";
import { installAtlas, ATLAS_KEY, ATLAS_FONT_KEY, FRAME_SCALE } from "./atlas.js";
import { attachRenderStats, type PerfHandle } from "./render-stats.js";
import { CameraSnapshotScratch } from "./camera-snapshot.js";
import { MAX_PROJECTILE_SPRITES, visibleProjectileCount } from "./render-pools.js";
import { EffectSystem, sampleEffect, type EffectSpec } from "./effects.js";
import { damageVisualFor } from "./damage-visuals.js";
import { buildObjectivesLayer, type ObjectivesLayer } from "./objectives-overlay.js";
import type { CameraView, MinimapVehicle, WorldSize } from "./minimap.js";
import { cameraConfigFor, computeViewScale, zoomPercent, ZOOM_BUTTON_FACTOR, type ViewScale } from "./view-scale.js";
import {
  DEFAULT_TAG_PREFS,
  declutterLabels,
  lifeState,
  markerOutline,
  planTag,
  relationTo,
  type LabelBox,
  type TagPrefs,
} from "./vehicle-tags.js";
import { attachStageInput } from "./stage-input.js";
import type { StageKeyCommand } from "./stage-gestures.js";
import {
  S9_ENV,
  resolveTeamColors,
  NEUTRAL_TEAM_COLOR,
  bodyFrameForChassis,
  barrelLengthForChassis,
  turretFrameForChassis,
  explosionFrameForAge,
  vehicleLabel,
  vehicleTeam,
  sortTeams,
  type ViewerRoster,
} from "./art-direction.js";

/**
 * UX-VIEW · Estado de la cámara que la página enseña (modo visible, % de zoom y
 * bot seleccionado). La escena es la ÚNICA fuente de verdad del modo: la página
 * lo refleja con `subscribeView` y sólo lo cambia ante una acción del usuario
 * (antes un efecto de React lo reaplicaba en cada tick y pisaba el zoom/pan manual).
 */
export interface ViewStatus {
  mode: CameraMode;
  zoomPercent: number;
  selectedId: string | null;
}

/** UX-VIEW · Lo que dibuja el minimapa HTML (fuera del canvas). */
export interface MinimapState {
  world: ViewerWorld;
  vehicles: MinimapVehicle[];
  camera: CameraView | null;
  selectedId: string | null;
  colorOf(team: string | undefined): number;
}

/** Radio (m) de la marca bajo el vehículo. */
const MARKER_RADIUS_M = 2.3;
/** Radio de selección por toque, en px CSS. */
const TAP_PICK_PX = 28;

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
  /**
   * 4v4 · Sin bando por defecto: la página elige uno de la NÓMINA. Con `team` vacío
   * la niebla no filtra a nadie como «propio» (antes era "red" fijo).
   */
  fog: FogOptions = { allowFogView: false, enabled: false, team: "" };
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
  /** UX-VIEW · Marcas bajo los vehículos (bando/relación, selección, reaparición, KO). */
  private markersGfx: Phaser.GameObjects.Graphics | null = null;
  /** UX-VIEW · Barras finas de vida (no rotan ni escalan con el zoom). */
  private tagsGfx: Phaser.GameObjects.Graphics | null = null;
  /** UX-VIEW · Nombre por vehículo, FUERA del contenedor que rota con el casco. */
  private labels = new Map<string, Phaser.GameObjects.BitmapText>();
  /** UX-VIEW · Vida anterior por vehículo, para detectar la reaparición (false → true). */
  private prevAlive = new Map<string, boolean>();
  private respawnedAt = new Map<string, number>();
  /** UX-VIEW · Bot seleccionado (toque, «Seguir …», teclas 1–8). */
  private selectedId: string | null = null;
  /** UX-VIEW · Preferencias de vida/nombres que elige el espectador. */
  tagPrefs: TagPrefs = DEFAULT_TAG_PREFS;
  private readonly viewListeners = new Set<(s: ViewStatus) => void>();
  private lastStatus: ViewStatus | null = null;
  private lastStatusAt = 0;
  /** Último frame dibujado (posiciones para el minimapa y la selección por toque). */
  private lastFrame: Map<string, { x: number; y: number; alive: boolean; team?: string }> | null = null;
  /** R3.6 · Anuncio de FIN DE PARTIDA sobre el canvas (no sólo en el feed HTML). */
  private matchEndBanner: Phaser.GameObjects.Container | null = null;
  private matchEndText: Phaser.GameObjects.BitmapText | null = null;
  private matchEndSub: Phaser.GameObjects.BitmapText | null = null;
  private perf: PerfHandle | null = null;
  /** Cuaderno reutilizado para computeCamera: cero asignaciones por frame (R3.3). */
  private readonly cameraScratch = new CameraSnapshotScratch();
  private readonly pxPerM = 8;
  /** Último encuadre aplicado (para que la interacción parta de lo que se ve). */
  private lastCamera: { centerX: number; centerY: number; zoom: number } | null = null;
  /**
   * UX-VIEW · Encuadre OBJETIVO del último frame (al que va la transición suave).
   * Los botones +/−/100 %/centrar parten de él: pulsar «+» a mitad de la
   * transición de «Seguir …» acercaba desde el zoom de tránsito y se quedaba lejos.
   */
  private lastGoal: CameraTarget | null = null;

  constructor() {
    super("viewer");
  }

  /** Compatibilidad con las páginas: el modo de cámara vive en CameraInteraction. */
  get cameraMode(): CameraMode {
    return this.interaction.current;
  }

  set cameraMode(mode: CameraMode) {
    this.interaction.setMode(mode);
    if (mode.kind === "follow") this.selectedId = mode.vehicleId;
    this.emitStatus();
  }

  setWorld(world: ViewerWorld): void {
    this.world = world;
    this.drawStatic();
  }

  /** Mundo actual (tamaño en metros), para el minimapa. */
  get worldSize(): WorldSize {
    return { widthM: this.world.widthM, heightM: this.world.heightM };
  }

  /**
   * R3.4 · Fija la nómina pública. Reconstruye los vehículos ya dibujados para que
   * adopten sprite por chasis, tinte de equipo y NOMBRE (no el UUID). Idempotente
   * y barato: en directo llega una vez, en el init, antes del primer snapshot.
   */
  /** R3.6 · Nómina pública en curso (para que el HUD HTML resuelva nombres de bot). */
  get rosterView(): ViewerRoster {
    return this.roster;
  }

  setRoster(roster: ViewerRoster): void {
    this.roster = roster ?? new Map();
    this.teamsSignature = ""; // fuerza recálculo de colores con los equipos de la nómina
    for (const [, c] of this.vehicleGfx) c.destroy();
    this.vehicleGfx.clear();
    for (const [, l] of this.labels) l.destroy();
    this.labels.clear();
  }

  /** UX-VIEW · Color de bando (de game-rules) para el minimapa HTML: mismo tinte que el canvas. */
  teamColor(team: string | undefined): number {
    return team ? this.tintForTeam(team) : NEUTRAL_TEAM_COLOR;
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

  /**
   * R3.6 · Fin de partida (mensaje `result` del canal de espectador o init
   * `finished`): lo registra el overlay para que el HUD y el rótulo del canvas lo
   * anuncien. Puramente lectura del resultado público; no toca la simulación.
   */
  applyResult(result: any): void {
    this.overlay.applyResult(result);
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
    // UX-VIEW · marcas bajo los vehículos (depth 2.5) y vida + nombre encima (7–8).
    this.markersGfx = this.add.graphics().setDepth(2.5);
    this.tagsGfx = this.add.graphics().setDepth(7);
    // Medición de rendimiento (ERR-VIS-11): FPS + draw calls reales del contexto
    // WebGL, publicados en window.__s9perf para la prueba de rendimiento de CI.
    const parent = (this.game.canvas?.parentElement as HTMLElement | null) ?? undefined;
    this.perf = attachRenderStats(this.game, parent ? { overlayParent: parent } : {});
    (globalThis as Record<string, unknown>).__s9perf = this.perf;
    // UX-VIEW · el minimapa ya NO es una segunda cámara dentro del canvas: es un
    // panel HTML fuera del escenario (MinimapPanel) que lee minimapState().
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.perf?.dispose();
      this.perf = null;
    });
  }

  // ─────────────────────────── UX-VIEW · cámara e interacción

  private dpr(): number {
    const z = (this.scale as { zoom?: number } | undefined)?.zoom;
    return typeof z === "number" && z > 0 ? 1 / z : 1;
  }

  private scaleInput() {
    return {
      viewportW: this.scale.width,
      viewportH: this.scale.height,
      mapW: this.world.widthM,
      mapH: this.world.heightM,
      dpr: this.dpr(),
      pxPerM: this.pxPerM,
    };
  }

  private viewScale(): ViewScale {
    return computeViewScale(this.scaleInput());
  }

  /** Límites del zoom ligados a la escala (encaje ≤ zoom ≤ 600 %), en px de búfer/m. */
  private cameraConfig(): CameraConfig {
    return cameraConfigFor(this.scaleInput());
  }

  private view() {
    const cfg = this.cameraConfig();
    return {
      current: this.lastCamera ?? computeCamera({ kind: "global" }, { vehicles: [] }, cfg),
      cfg,
    };
  }

  /** Vista desde el OBJETIVO (botones): lo que se va a ver, no el frame de tránsito. */
  private goalView() {
    const v = this.view();
    return this.lastGoal ? { current: this.lastGoal, cfg: v.cfg } : v;
  }

  /** Escena lista para recibir entrada (create() ya corrió). */
  private ready(): boolean {
    return !!this.cameras?.main;
  }

  /** Manipulación directa: el encuadre salta al objetivo (sin muelle que vaya por detrás). */
  private jump(mode: CameraMode): void {
    if (mode.kind !== "manual") return;
    this.lastCamera = this.smoothCamera.jumpTo(mode, this.cameraConfig());
    this.lastGoal = this.lastCamera;
    this.emitStatus();
  }

  /** Pan en px de BÚFER (positivo = el mapa sigue al puntero). */
  panBy(dx: number, dy: number): void {
    if (!this.ready()) return;
    this.jump(this.interaction.onDrag(dx, dy, this.view()));
  }

  /** Zoom por un factor manteniendo fijo el punto (px de búfer) bajo el puntero. */
  zoomAtPx(factor: number, x: number, y: number): void {
    if (!this.ready()) return;
    this.jump(this.interaction.zoomAt(factor, { x, y }, this.view()));
  }

  /** Botones/teclas +/−: zoom suave alrededor del centro. */
  zoomIn(): void {
    if (!this.ready()) return;
    this.interaction.zoomBy(ZOOM_BUTTON_FACTOR, this.goalView());
    this.emitStatus();
  }

  zoomOut(): void {
    if (!this.ready()) return;
    this.interaction.zoomBy(1 / ZOOM_BUTTON_FACTOR, this.goalView());
    this.emitStatus();
  }

  /** «Encajar mapa»: vista completa (modo global). */
  fitMap(): void {
    this.cameraMode = { kind: "global" };
  }

  /** «100 %»: escala nativa de la escena (1 px de escena = 1 px CSS), sin mover el centro. */
  zoomNative(): void {
    if (!this.ready()) return;
    this.interaction.zoomTo(this.viewScale().native, this.goalView());
    this.emitStatus();
  }

  /** «Centrar seleccionado»: centra una vez (cámara libre, mismo zoom) en el bot elegido. */
  centerSelected(): void {
    if (!this.ready() || !this.selectedId) return;
    const p = this.lastFrame?.get(this.selectedId) ?? this.lastVehiclePos.get(this.selectedId);
    if (!p) return;
    this.interaction.centerOn(p.x, p.y, this.goalView());
    this.emitStatus();
  }

  /** Centra en un punto del mundo (metros): lo usa el minimapa al pulsarlo. */
  centerOnWorld(x: number, y: number): void {
    if (!this.ready()) return;
    this.jump(this.interaction.centerOn(x, y, this.view()));
  }

  /** Selecciona (o deselecciona con null) un vehículo sin cambiar la cámara. */
  selectVehicle(id: string | null): void {
    this.selectedId = id;
    this.emitStatus();
  }

  get selectedVehicleId(): string | null {
    return this.selectedId;
  }

  /** Orden estable de los bots para 1–8: el de aparición en el overlay (el del snapshot). */
  vehicleOrder(): string[] {
    return [...this.overlay.vehicles.keys()];
  }

  /** Toque/clic sin arrastre: selecciona el vehículo más cercano bajo el dedo. */
  tapAtPx(x: number, y: number): void {
    if (!this.ready() || !this.lastFrame) return;
    const { current, cfg } = this.view();
    const wx = current.centerX + (x - cfg.viewportW / 2) / current.zoom;
    const wy = current.centerY + (y - cfg.viewportH / 2) / current.zoom;
    const radiusM = Math.max((TAP_PICK_PX * this.dpr()) / current.zoom, MARKER_RADIUS_M);
    let best: string | null = null;
    let bestD = Infinity;
    for (const [id, p] of this.lastFrame) {
      const d = Math.hypot(p.x - wx, p.y - wy);
      if (d <= radiusM && d < bestD) {
        best = id;
        bestD = d;
      }
    }
    if (best) this.selectVehicle(best);
  }

  /** Teclado del escenario (sólo con el foco en él: stage-input.ts). */
  handleKey(cmd: StageKeyCommand): void {
    if (!this.ready()) return;
    switch (cmd.kind) {
      case "global":
      case "fit":
        this.fitMap();
        return;
      case "follow-index": {
        const mode = this.interaction.onKey(String(cmd.index + 1), this.vehicleOrder());
        if (mode) this.cameraMode = mode;
        return;
      }
      case "zoom-in":
        this.zoomIn();
        return;
      case "zoom-out":
        this.zoomOut();
        return;
      case "native":
        this.zoomNative();
        return;
      case "center-selected":
        this.centerSelected();
        return;
      case "pan":
        this.panBy(cmd.dx * this.dpr(), cmd.dy * this.dpr());
        return;
    }
  }

  /** Suscripción al estado visible de la cámara. Devuelve la baja. */
  subscribeView(cb: (s: ViewStatus) => void): () => void {
    this.viewListeners.add(cb);
    cb(this.currentStatus());
    return () => {
      this.viewListeners.delete(cb);
    };
  }

  private currentStatus(): ViewStatus {
    const zoom = this.lastCamera?.zoom ?? 0;
    return {
      mode: this.interaction.current,
      zoomPercent: zoomPercent(zoom, this.viewScale()),
      selectedId: this.selectedId,
    };
  }

  /** Avisa a la página sólo si cambió algo visible (modo, % o selección). */
  private emitStatus(): void {
    if (this.viewListeners.size === 0) return;
    const next = this.currentStatus();
    const prev = this.lastStatus;
    const sameModeAndSelection = !!prev && prev.mode === next.mode && prev.selectedId === next.selectedId;
    if (sameModeAndSelection && prev.zoomPercent === next.zoomPercent) return;
    // Durante una transición suave sólo cambia el %: a ≤ 10 Hz (React no re-renderiza
    // la página a 60 fps por un número); el valor final llega en ≤ 100 ms.
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (sameModeAndSelection && now - this.lastStatusAt < 100) return;
    this.lastStatusAt = now;
    this.lastStatus = next;
    for (const cb of this.viewListeners) cb(next);
  }

  /** UX-VIEW · Datos del minimapa HTML: mundo, vehículos, vista de la cámara y selección. */
  minimapState(): MinimapState {
    const vehicles: MinimapVehicle[] = [];
    for (const [id, p] of this.lastFrame ?? []) {
      vehicles.push({
        id,
        x: p.x,
        y: p.y,
        alive: p.alive,
        team: vehicleTeam(this.roster, id, this.overlay.vehicles.get(id)?.team),
      });
    }
    const cam = this.lastCamera;
    return {
      world: this.world,
      vehicles,
      camera: cam
        ? {
            centerX: cam.centerX,
            centerY: cam.centerY,
            zoom: cam.zoom,
            viewportW: this.scale.width,
            viewportH: this.scale.height,
          }
        : null,
      selectedId: this.selectedId,
      colorOf: (team) => this.teamColor(team),
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
    // P1 · En Phaser 4 clear/fill/draw sólo se ENCOLAN en el commandBuffer de la
    // DynamicTexture y se ejecutan con render(). Sin esta llamada la textura quedaba
    // vacía (escenario negro, sin suelo ni muros). Y el Graphics temporal sólo se
    // destruye DESPUÉS de ejecutar el búfer, que lo referencia.
    rt.render();
    g.destroy();
    // El lienzo de decals sigue el tamaño del mundo y se limpia al re-hornear el mapa.
    if (this.decalLayer) {
      this.decalLayer.setSize(w, h);
      this.decalLayer.clear();
      this.decalLayer.render();
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
    this.lastFrame = faded.vehicles;
    this.renderTags(faded, now);
    this.emitStatus();
    this.renderDebug();
    // R3.6 · fin de partida ANUNCIADO sobre el canvas (no sólo en el feed HTML).
    this.renderMatchEnd();
  }

  /**
   * R3.6 · Anuncia el FIN DE PARTIDA sobre el canvas: un rótulo fijo a la cámara
   * (scrollFactor 0) con el ganador y el marcador final, en cuanto el overlay
   * registra el resultado. Se mantiene fijado a la cámara principal e IGNORADO por
   * el minimapa (es chrome, no entidad del mundo). Sin resultado, permanece oculto.
   */
  private renderMatchEnd(): void {
    const result = this.overlay.result;
    if (!result) {
      this.matchEndBanner?.setVisible(false);
      return;
    }
    if (!this.matchEndBanner) {
      const backdrop = this.add.rectangle(0, 0, 360, 96, 0x000000, 0.72).setOrigin(0.5, 0.5);
      const headline = this.add.bitmapText(0, -14, ATLAS_FONT_KEY, "", 24).setOrigin(0.5, 0.5).setTint(S9_ENV.tracer);
      const sub = this.add.bitmapText(0, 16, ATLAS_FONT_KEY, "", 12).setOrigin(0.5, 0.5).setTint(S9_ENV.label);
      const container = this.add.container(0, 0, [backdrop, headline, sub]).setDepth(20).setScrollFactor(0);
      this.matchEndBanner = container;
      this.matchEndText = headline;
      this.matchEndSub = sub;
    }
    const headline = result.winner ? `GANA ${result.winner.toUpperCase()}` : "EMPATE";
    const scoreLine = Object.entries(result.score)
      .map(([t, n]) => `${t} ${n}`)
      .join("   ");
    this.matchEndText?.setText(headline);
    this.matchEndSub?.setText(scoreLine);
    const cam = this.cameras.main;
    this.matchEndBanner.setVisible(true).setPosition(cam.width / 2, cam.height / 2);
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
    this.decalLayer.render(); // P1 · ejecutar el búfer antes de destruir el Graphics
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
      // R16.1 · "explosion" es un frame LÓGICO: la fase real (explosion-0/1/2)
      // se resuelve aquí, por edad, vía explosionFrameForAge (art-direction.ts,
      // puro y testeado). El resto de frames mapean 1:1 con el nombre del atlas.
      const frameName = e.frame === "explosion" ? explosionFrameForAge(now - e.bornMs) : e.frame;
      s.setFrame(frameName);
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
    for (const [id, l] of this.labels) {
      if (!frame.vehicles.has(id)) l.setVisible(false);
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
    // 4v4 · bando de la nómina o del snapshot; sin ninguno, color NEUTRO (antes "red").
    const team = vehicleTeam(this.roster, id, this.overlay.vehicles.get(id)?.team);
    const color = team ? this.tintForTeam(team) : NEUTRAL_TEAM_COLOR;
    // Casco según el arquetipo del chasis: explorador/artillero/pesado a un vistazo.
    const body = this.add
      .sprite(0, 0, ATLAS_KEY, bodyFrameForChassis(entry?.chassis))
      .setScale(1 / FRAME_SCALE)
      .setTint(color);
    // Torreta = base redonda + cañón; el largo del cañón varía con el arquetipo.
    const turretBase = this.add
      .sprite(0, 0, ATLAS_KEY, turretFrameForChassis(entry?.chassis))
      .setScale(1 / FRAME_SCALE)
      .setTint(color);
    const barrel = this.add
      .sprite(0, 0, ATLAS_KEY, "barrel")
      .setScale(barrelLengthForChassis(entry?.chassis) / FRAME_SCALE, 1 / FRAME_SCALE)
      .setOrigin(0, 0.5)
      .setTint(color);
    const turret = this.add.container(0, 0, [turretBase, barrel]).setName("turret");
    // UX-VIEW · el NOMBRE ya no va en este contenedor (rotaba con el casco y
    // escalaba con el zoom): es un BitmapText aparte que coloca renderTags.
    return this.add.container(0, 0, [body, turret]).setDepth(3);
  }

  /** BitmapText del atlas (RetroFont): el NOMBRE del bot, no el UUID; comparte textura. */
  private labelFor(id: string): Phaser.GameObjects.BitmapText {
    let l = this.labels.get(id);
    if (!l) {
      l = this.add
        .bitmapText(0, 0, ATLAS_FONT_KEY, vehicleLabel(this.roster, id), 14)
        .setOrigin(0.5, 1)
        .setTint(S9_ENV.label)
        // La RetroFont es monoespaciada con celdas anchas: sin esto «A - T K - 1».
        .setLetterSpacing(-3)
        .setDepth(8);
      this.labels.set(id, l);
    }
    return l;
  }

  /**
   * UX-VIEW · Marcas, barra fina de vida y nombre de cada vehículo. Todo en
   * tamaño de PANTALLA constante (se divide por el zoom de la cámara) y sin
   * rotar; qué se enseña lo decide vehicle-tags.ts (puro y probado).
   */
  private renderTags(
    frame: { vehicles: Map<string, { x: number; y: number; alive: boolean; alpha?: number }> },
    now: number,
  ): void {
    const markers = this.markersGfx;
    const tags = this.tagsGfx;
    if (!markers || !tags) return;
    markers.clear();
    tags.clear();
    const cam = this.cameras.main;
    const camZoom = cam.zoom > 0 ? cam.zoom : 1;
    const dpr = this.dpr();
    const k = dpr / camZoom; // px de escena por px CSS de pantalla
    const cssPxPerM = (camZoom * this.pxPerM) / dpr;
    const wv = cam.worldView;
    const teams = sortTeams(
      [...frame.vehicles.keys()]
        .map((id) => vehicleTeam(this.roster, id, this.overlay.vehicles.get(id)?.team))
        .filter((t): t is string => !!t),
    );
    const selTeam = this.selectedId
      ? vehicleTeam(this.roster, this.selectedId, this.overlay.vehicles.get(this.selectedId)?.team)
      : undefined;
    const perspective = selTeam ?? (this.fog.enabled && this.fog.team ? this.fog.team : null);
    let visibleCount = 0;
    for (const [, p] of frame.vehicles) {
      const x = p.x * this.pxPerM;
      const y = p.y * this.pxPerM;
      if (x >= wv.x && x <= wv.x + wv.width && y >= wv.y && y <= wv.y + wv.height) visibleCount++;
    }
    const boxes: LabelBox[] = [];
    const anchors = new Map<string, { x: number; y: number }>();
    for (const [id, pose] of frame.vehicles) {
      const ov = this.overlay.vehicles.get(id);
      const team = vehicleTeam(this.roster, id, ov?.team);
      const prev = this.prevAlive.get(id);
      if (prev === false && pose.alive) this.respawnedAt.set(id, now);
      this.prevAlive.set(id, pose.alive);
      const hpRatio = ov && ov.hullHpMax > 0 && Number.isFinite(ov.hullHp) ? ov.hullHp / ov.hullHpMax : null;
      const plan = planTag(
        {
          id,
          label: vehicleLabel(this.roster, id),
          team,
          teamIndex: team ? teams.indexOf(team) : -1,
          life: lifeState(pose.alive, this.respawnedAt.get(id), now),
          hpRatio,
          selected: id === this.selectedId,
          relation: relationTo(team, perspective),
        },
        { prefs: this.tagPrefs, cssPxPerM, visibleCount },
      );
      const alpha = Math.max(0, Math.min(1, pose.alpha ?? 1));
      const x = pose.x * this.pxPerM;
      const y = pose.y * this.pxPerM;
      const color = team ? this.tintForTeam(team) : NEUTRAL_TEAM_COLOR;
      const r = Math.max(MARKER_RADIUS_M * this.pxPerM, 9 * k);

      // Marca de bando/relación: la FORMA distingue sin depender del color.
      markers.lineStyle(2 * k, color, 0.9 * alpha);
      const outline = markerOutline(plan.shape, r);
      if (outline.length === 0) markers.strokeCircle(x, y, r);
      else {
        markers.beginPath();
        markers.moveTo(x + outline[0].x, y + outline[0].y);
        for (let i = 1; i < outline.length; i++) markers.lineTo(x + outline[i].x, y + outline[i].y);
        markers.closePath();
        markers.strokePath();
      }
      if (plan.dashedRing) {
        // Reaparición: anillo DISCONTINUO que gira (forma y movimiento, no color).
        markers.lineStyle(2 * k, S9_ENV.label, 0.9 * alpha);
        const segs = 10;
        const rr = r + 5 * k;
        const spin = (now / 400) % (Math.PI * 2);
        for (let i = 0; i < segs; i++) {
          const a0 = spin + (i / segs) * Math.PI * 2;
          markers.beginPath();
          markers.arc(x, y, rr, a0, a0 + (Math.PI / segs) * 0.9);
          markers.strokePath();
        }
      }
      if (plan.selectedRing) {
        markers.lineStyle(3 * k, S9_ENV.label, 1);
        markers.strokeCircle(x, y, r + 3 * k);
        // Esquinas de selección (encuadre), visibles sobre cualquier fondo.
        const e = r + 9 * k;
        const len = 6 * k;
        markers.lineStyle(2 * k, S9_ENV.tracer, 1);
        for (const [sx, sy] of [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ] as const) {
          markers.lineBetween(x + sx * e, y + sy * e, x + sx * (e - len), y + sy * e);
          markers.lineBetween(x + sx * e, y + sy * e, x + sx * e, y + sy * (e - len));
        }
      }
      if (plan.cross) {
        const c = r * 0.75;
        markers.lineStyle(2.5 * k, S9_ENV.label, 0.85);
        markers.lineBetween(x - c, y - c, x + c, y + c);
        markers.lineBetween(x - c, y + c, x + c, y - c);
      }

      // Barra FINA de vida encima del vehículo (tamaño de pantalla, no rota).
      const top = y - plan.offsetPx * k;
      if (plan.showBar && hpRatio !== null) {
        const ratio = Math.max(0, Math.min(1, hpRatio));
        const w = plan.barWidthPx * k;
        const h = plan.barHeightPx * k;
        tags.fillStyle(0x000000, 0.65 * alpha);
        tags.fillRect(x - w / 2 - k, top - h - k, w + 2 * k, h + 2 * k);
        tags.fillStyle(ratio > 0.5 ? 0x5fd35f : ratio > 0.25 ? 0xe0c040 : 0xe05a5a, alpha);
        tags.fillRect(x - w / 2, top - h, w * ratio, h);
      }
      const label = this.labelFor(id);
      label.setVisible(false);
      if (!plan.showName) continue;
      label.setText(plan.showDetail ? `${plan.nameText} ${plan.detailText}` : plan.nameText);
      label.setScale(k * 0.86).setAlpha(alpha);
      const ly = top - (plan.barHeightPx + 3) * k;
      anchors.set(id, { x, y: ly });
      boxes.push({
        id,
        x: (x - wv.x) * (camZoom / dpr),
        y: (ly - wv.y) * (camZoom / dpr) - 6,
        w: label.text.length * 6.1 + 4,
        h: 13,
        priority: id === this.selectedId ? 2 : pose.alive ? 1 : 0,
      });
    }
    // Densidad: las etiquetas que se solaparían se ocultan (la del seleccionado, nunca).
    for (const id of declutterLabels(boxes)) {
      const a = anchors.get(id);
      if (a) this.labels.get(id)?.setPosition(a.x, a.y).setVisible(true);
    }
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
    const smoothed: CameraTarget = this.smoothCamera.update(mode, target, cfg, deltaMs);
    this.lastCamera = smoothed;
    this.lastGoal = clampToMap(target, cfg);
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
  /**
   * UX-VIEW · Visor interactivo (directo y replay): rueda, arrastre, pinch, toque y
   * teclado sobre el ELEMENTO del escenario (no sobre `window`). /broadcast no lo
   * activa: es una vista de emisión sin manos.
   */
  interactive?: boolean;
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
    // UX-VIEW · la entrada de Phaser escuchaba el teclado en `window` y no consumía
    // la rueda: la del visor la cablea stage-input.ts sobre el escenario.
    input: { keyboard: false, mouse: false, touch: false, gamepad: false },
    scene: [ViewerScene],
  });

  if (opts.interactive) {
    const scene = (): ViewerScene | null => {
      const s = game.scene?.getScene?.("viewer") as ViewerScene | null | undefined;
      return s ?? null;
    };
    const detach = attachStageInput(parent, () => game.canvas ?? null, {
      pan: (dx, dy) => scene()?.panBy(dx, dy),
      zoomAt: (f, x, y) => scene()?.zoomAtPx(f, x, y),
      tap: (x, y) => scene()?.tapAtPx(x, y),
      key: (cmd) => scene()?.handleKey(cmd),
    });
    game.events.once(Phaser.Core.Events.DESTROY, detach);
  }

  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => {
      const size = canvasSizeFor(parent.clientWidth || 960, parent.clientHeight || 640, window.devicePixelRatio || 1);
      applyCanvasSize(game.scale, size);
    });
    observer.observe(parent);
    game.events.once(Phaser.Core.Events.DESTROY, () => observer.disconnect());
  }
  return game;
}

/** Constantes REALES de Phaser 4 que usa la espera de escena (scene-ready.ts). */
export const PHASER_SCENE_READY = {
  gameReadyEvent: Phaser.Core.Events.READY,
  gameDestroyEvent: Phaser.Core.Events.DESTROY,
  sceneCreateEvent: Phaser.Scenes.Events.CREATE,
  runningStatus: Phaser.Scenes.RUNNING,
} as const;

/**
 * FC-D (D3, TD-009) · Devuelve la escena del visor cuando EXISTE y ya ejecutó
 * su `create()`: espera al `READY` del juego y al `CREATE` de la escena (ver
 * scene-ready.ts). Las páginas DEBEN usar esto en lugar de `getScene` directo.
 */
export function waitForViewerScene(game: Phaser.Game, timeoutMs?: number): Promise<ViewerScene> {
  return waitForScene<ViewerScene>(game as unknown as GameLike<ViewerScene>, "viewer", PHASER_SCENE_READY, timeoutMs);
}
