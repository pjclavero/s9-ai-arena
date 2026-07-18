/**
 * R3.2 · ERR-VIS-06 — Reloj de reproducción del DIRECTO con delay-buffer.
 *
 * En directo los snapshots llegan con jitter de red; fechar la interpolación por
 * instante de llegada (T8.2) trasladaba ese jitter al movimiento. R3.2 fecha
 * cada snapshot en el eje de PARTIDA por su tick (tickToMs, el mismo eje que el
 * replay, R3.1) y un DelayClock reproduce ese eje con ~2 intervalos de retardo:
 * cuando se va a dibujar un tramo, su snapshot siguiente casi siempre ya ha
 * llegado, y el parámetro de interpolación es proporción del delta de ticks.
 *
 * El reloj avanza a ritmo de reloj de pared y CONVERGE al objetivo (último
 * snapshot − retardo) por deslizamiento limitado (±10 % del dt): la corrección
 * de deriva es inaudible; solo un desfase enorme (parón de pestaña, stall del
 * servidor) provoca un salto franco.
 *
 * Puro: el reloj de pared se inyecta. Sin Phaser, sin WebSocket.
 */
import { tickToMs } from "./replay-player.js";
import type { PlaybackScene } from "./replay-feed.js";

const DEFAULT_INTERVAL_MS = 100; // 10 Hz hasta medir el intervalo real
const SNAP_THRESHOLD_MS = 2000; // desfase a partir del cual se salta en vez de deslizar

export class DelayClock {
  private latestGameMs: number | null = null;
  private latestWallMs = 0;
  private intervalEmaMs: number | null = null;
  private currentGameMs: number | null = null;
  private lastWallMs: number | null = null;
  private readonly targetIntervals: number;

  constructor(targetIntervals = 2) {
    this.targetIntervals = targetIntervals;
  }

  /** Retardo objetivo: ~N intervalos de snapshot medidos (EMA). */
  get delayMs(): number {
    return this.targetIntervals * (this.intervalEmaMs ?? DEFAULT_INTERVAL_MS);
  }

  /** Reset (init/reconexión): posicionarse de golpe, sin deslizar a través del hueco. */
  reset(gameMs: number, wallMs: number): void {
    this.latestGameMs = gameMs;
    this.latestWallMs = wallMs;
    this.intervalEmaMs = null;
    this.currentGameMs = gameMs;
    this.lastWallMs = wallMs;
  }

  /** Llega un snapshot fechado en gameMs (tickToMs del tick). */
  observe(gameMs: number, wallMs: number): void {
    if (this.latestGameMs !== null && gameMs <= this.latestGameMs) return; // reordenado
    if (this.latestGameMs !== null) {
      const interval = gameMs - this.latestGameMs;
      this.intervalEmaMs = this.intervalEmaMs === null ? interval : this.intervalEmaMs * 0.8 + interval * 0.2;
    }
    this.latestGameMs = gameMs;
    this.latestWallMs = wallMs;
  }

  /** Instante actual del eje de partida que la escena debe muestrear. */
  now(wallMs: number): number {
    if (this.latestGameMs === null) return 0;
    // Objetivo: el eje de partida sigue avanzando entre snapshots a ritmo de pared.
    const ideal = this.latestGameMs + (wallMs - this.latestWallMs) - this.delayMs;
    if (this.currentGameMs === null || this.lastWallMs === null) {
      this.currentGameMs = ideal;
      this.lastWallMs = wallMs;
      return this.currentGameMs;
    }
    const dt = Math.max(0, wallMs - this.lastWallMs);
    this.lastWallMs = wallMs;
    let next = this.currentGameMs + dt; // avance nominal 1×
    const err = ideal - next;
    if (Math.abs(err) > SNAP_THRESHOLD_MS) {
      next = ideal; // parón largo: saltar, no perseguir durante minutos
    } else {
      next += Math.max(-0.1 * dt, Math.min(0.1 * dt, err)); // deslizamiento ±10 %
    }
    // Nunca por delante del último dato: no hay nada que enseñar más allá.
    this.currentGameMs = Math.min(next, this.latestGameMs);
    return this.currentGameMs;
  }
}

/**
 * Cableado PURO entre SpectatorClient y la escena para el DIRECTO — el gemelo
 * de ReplayFeed (R3.1): fija el reloj de reproducción de la escena al DelayClock
 * y fecha cada snapshot por su tick en el eje de partida.
 */
export class LiveFeed {
  readonly clock: DelayClock;
  private readonly wallNow: () => number;
  /** Último serverTimeMs anunciado por el gateway (diagnóstico de latencia). */
  lastServerTimeMs: number | null = null;

  constructor(
    private readonly scene: PlaybackScene,
    opts: { clock?: DelayClock; wallNow?: () => number } = {},
  ) {
    this.clock = opts.clock ?? new DelayClock();
    this.wallNow = opts.wallNow ?? (() => performance.now());
    scene.setPlaybackClock(() => this.clock.now(this.wallNow()));
  }

  /** init (conexión o reconexión): estado íntegro, reloj reposicionado de golpe. */
  onInit(msg: any): void {
    if (typeof msg?.serverTimeMs === "number") this.lastServerTimeMs = msg.serverTimeMs;
    const s = msg?.snapshot;
    if (!s) return;
    const atMs = tickToMs(s.tick);
    this.clock.reset(atMs, this.wallNow());
    this.scene.resetTo(s, atMs);
  }

  onSnapshot(s: any, serverTimeMs?: number): void {
    if (typeof serverTimeMs === "number") this.lastServerTimeMs = serverTimeMs;
    if (!s) return;
    const atMs = tickToMs(s.tick);
    this.clock.observe(atMs, this.wallNow());
    this.scene.pushSnapshot(s, atMs);
  }

  onEvent(e: any): void {
    this.scene.pushEvent(e);
  }
}
