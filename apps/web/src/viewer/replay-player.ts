/**
 * T8.3 · Reproductor de replays: carga por id desde el replay-service, play/pausa,
 * velocidad 0,5×–8×, salto por barra temporal usando los KEYFRAMES del índice y
 * enlaces compartibles con tick inicial (?t=1234).
 *
 * Igual que el directo: lógica pura sin Phaser ni fetch global — la fuente de
 * datos se inyecta (ReplaySource), así el MISMO reproductor se prueba con vitest
 * contra el replay-service HTTP real (supertest) y corre en el navegador con fetch.
 *
 * Coherencia eventos/snapshots a 8× (DoD): el reloj del reproductor avanza en
 * TICKS de juego; los eventos se entregan SIEMPRE en orden de tick y solo cuando
 * el playhead los alcanza — la velocidad cambia cuántos ticks avanza cada frame
 * real, nunca el orden ni la pertenencia de un evento a su tick.
 */

export interface ReplayIndexData {
  battleId: string;
  ticks: number;
  snapshotCount: number;
  keyframes: { tick: number; snapshotIndex: number }[];
  result: { winner: string; ticks: number; score: Record<string, number>; finalStateHash: string };
  debugOpen: boolean;
}

export interface ReplaySegment {
  fromKeyframeTick: number;
  snapshots: any[];
  events: any[];
  /** Solo presente si el dueño abrió la depuración del replay (debugOpen). */
  commands?: any[];
}

/** Fuente de datos del reproductor: el replay-service (HTTP) o un stub en tests. */
export interface ReplaySource {
  index(): Promise<ReplayIndexData>;
  segment(fromTick: number, toTick: number): Promise<ReplaySegment>;
}

/** Fuente HTTP real contra el replay-service (fetch inyectable para tests/proxy). */
export function httpReplaySource(
  baseUrl: string,
  battleId: string,
  fetchImpl: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<any> }> = fetch,
): ReplaySource {
  const get = async (path: string) => {
    const res = await fetchImpl(`${baseUrl}${path}`);
    if (!res.ok) throw new Error(`replay-service: HTTP ${res.status} en ${path}`);
    return res.json();
  };
  return {
    index: () => get(`/replays/${encodeURIComponent(battleId)}/index`),
    segment: (fromTick, toTick) =>
      get(`/replays/${encodeURIComponent(battleId)}/segment?fromTick=${fromTick}&toTick=${toTick}`),
  };
}

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 8;
const TICK_HZ = 30;

/**
 * Eje temporal de REPRODUCCIÓN (R3.1): convierte ticks de juego a milisegundos de
 * partida. Es el eje en el que se fechan los snapshots del replay y en el que la
 * escena muestrea el interpolador — independiente del reloj de pared y de la
 * velocidad de reproducción.
 */
export function tickToMs(tick: number): number {
  return (tick / TICK_HZ) * 1000;
}
/** Tamaño de trozo que se pide al servicio por delante del playhead (~20 s de juego). */
const CHUNK_TICKS = 600;

export interface AdvanceResult {
  /** Snapshot vigente tras avanzar (el último con tick <= playhead). */
  snapshot: any | null;
  /** Eventos cruzados por el playhead en ESTE avance, en orden de tick. */
  events: any[];
  finished: boolean;
}

export class ReplayPlayer {
  playing = false;
  speed = 1;
  index: ReplayIndexData | null = null;

  private source: ReplaySource;
  /** Timeline descargada, ordenada y deduplicada por tick. */
  private snapshots: any[] = [];
  private events: any[] = [];
  private commands: any[] = [];
  /** Trozos de timeline ya descargados (tick / CHUNK_TICKS). Sin huecos ocultos. */
  private loadedChunks = new Set<number>();
  /** Playhead en ticks de juego (fraccional para velocidades no enteras). */
  private playhead = 0;
  private lastDeliveredEventIdx = -1;

  constructor(source: ReplaySource) {
    this.source = source;
  }

  async init(startTick = 0): Promise<void> {
    this.index = await this.source.index();
    await this.seekTick(startTick);
  }

  get currentTick(): number {
    return Math.floor(this.playhead);
  }

  /**
   * Playhead en ms de partida (fraccional): el "ahora" del reloj de reproducción.
   * La escena muestrea el interpolador con este valor en replay (R3.1).
   */
  get playheadMs(): number {
    return tickToMs(this.playhead);
  }

  get finished(): boolean {
    return this.index !== null && this.playhead >= this.index.ticks;
  }

  get debugOpen(): boolean {
    return this.index?.debugOpen === true;
  }

  /** Comandos grabados visibles en el tick actual (capa de depuración del replay). */
  commandsAt(tick: number): any[] {
    if (!this.debugOpen) return [];
    return this.commands.filter((c) => c.tick === tick);
  }

  play(): void {
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  setSpeed(x: number): void {
    this.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, x));
  }

  /**
   * Salto por barra temporal (DoD: aterriza en el tick pedido ±1 tick, < 1 s).
   * Usa el keyframe anterior del índice: solo se descarga el trozo necesario.
   */
  async seekTick(tick: number, signal?: AbortSignal): Promise<void> {
    if (!this.index) throw new Error("init() primero");
    if (signal?.aborted) throw new DOMException("seek abortado", "AbortError");
    const target = Math.max(0, Math.min(tick, this.index.ticks));
    await this.ensureLoaded(target, target + CHUNK_TICKS);
    // Un seek posterior (el usuario sigue arrastrando el slider) aborta éste:
    // no reposicionamos con datos de un tick que ya no interesa (R3.3).
    if (signal?.aborted) throw new DOMException("seek abortado", "AbortError");
    // Se aterriza en el snapshot MÁS CERCANO al tick pedido: con snapshots cada
    // 3 ticks la distancia máxima es 1 tick (DoD: ±1 tick).
    this.playhead = this.nearestSnapshotTick(target);
    this.lastDeliveredEventIdx = this.eventIndexBefore(this.playhead);
  }

  /**
   * R3.3 (ERR-VIS-11) — Prefetch del trozo N+1 FUERA del bucle de RAF. La página
   * lo llama en un temporizador aparte para que el trozo siguiente esté ya en
   * memoria cuando el playhead lo alcance y `advance` no bloquee el frame en red.
   * Silencioso: un fallo de red aquí no interrumpe la reproducción (advance
   * reintentará el trozo cuando de verdad lo necesite).
   */
  async prefetch(): Promise<void> {
    if (!this.index) return;
    const nextChunkStart = (Math.floor(this.currentTick / CHUNK_TICKS) + 1) * CHUNK_TICKS;
    if (nextChunkStart > this.index.ticks) return;
    try {
      await this.ensureLoaded(nextChunkStart, nextChunkStart + CHUNK_TICKS);
    } catch {
      /* prefetch best-effort: no propaga */
    }
  }

  /**
   * Avanza el playhead `realDtMs` de reloj de pared a la velocidad vigente.
   * Lo llama el bucle de render (60 fps). Devuelve snapshot y eventos cruzados.
   */
  async advance(realDtMs: number): Promise<AdvanceResult> {
    if (!this.index) throw new Error("init() primero");
    if (this.playing && !this.finished) {
      this.playhead = Math.min(this.index.ticks, this.playhead + (realDtMs / 1000) * TICK_HZ * this.speed);
      await this.ensureLoaded(this.currentTick, this.currentTick + CHUNK_TICKS);
    }
    const events: any[] = [];
    let i = this.lastDeliveredEventIdx + 1;
    while (i < this.events.length && this.events[i].tick <= this.playhead) {
      events.push(this.events[i]);
      i++;
    }
    this.lastDeliveredEventIdx = i - 1;
    return { snapshot: this.snapshotAtOrBefore(this.currentTick), events, finished: this.finished };
  }

  // ---------------------------------------------------------------- interno
  private async ensureLoaded(fromTick: number, toTick: number): Promise<void> {
    const to = Math.min(toTick, this.index!.ticks);
    const firstChunk = Math.floor(Math.max(0, fromTick) / CHUNK_TICKS);
    const lastChunk = Math.floor(to / CHUNK_TICKS);
    for (let c = firstChunk; c <= lastChunk; c++) {
      if (this.loadedChunks.has(c)) continue;
      const seg = await this.source.segment(c * CHUNK_TICKS, Math.min((c + 1) * CHUNK_TICKS - 1, this.index!.ticks));
      this.merge(seg);
      this.loadedChunks.add(c);
    }
  }

  private merge(seg: ReplaySegment): void {
    const have = new Set(this.snapshots.map((s) => s.tick));
    for (const s of seg.snapshots) if (!have.has(s.tick)) this.snapshots.push(s);
    this.snapshots.sort((a, b) => a.tick - b.tick);

    const evKey = (e: any) => JSON.stringify(e);
    const haveEv = new Set(this.events.map(evKey));
    for (const e of seg.events) if (!haveEv.has(evKey(e))) this.events.push(e);
    this.events.sort((a, b) => a.tick - b.tick);

    if (seg.commands) {
      const haveCmd = new Set(this.commands.map((c) => `${c.tick}:${c.vehicleId}`));
      for (const c of seg.commands) if (!haveCmd.has(`${c.tick}:${c.vehicleId}`)) this.commands.push(c);
      this.commands.sort((a, b) => a.tick - b.tick);
    }
  }

  private snapshotAtOrBefore(tick: number): any | null {
    let lo = 0;
    let hi = this.snapshots.length - 1;
    if (hi < 0 || this.snapshots[0].tick > tick) return this.snapshots[0] ?? null;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.snapshots[mid].tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    return this.snapshots[lo];
  }

  private nearestSnapshotTick(tick: number): number {
    const below = this.snapshotAtOrBefore(tick);
    if (!below) return tick;
    const idx = this.snapshots.indexOf(below);
    const above = this.snapshots[idx + 1];
    if (above && Math.abs(above.tick - tick) < Math.abs(below.tick - tick)) return above.tick;
    return below.tick;
  }

  private eventIndexBefore(tick: number): number {
    let idx = -1;
    for (let i = 0; i < this.events.length && this.events[i].tick < tick; i++) idx = i;
    return idx;
  }
}

// -------------------------------------------------------- enlaces compartibles

/** Enlace compartible con tick inicial (DoD T8.3): `#/replay/<id>?t=<tick>`. */
export function buildShareLink(battleId: string, tick: number): string {
  return `#/replay/${encodeURIComponent(battleId)}?t=${Math.max(0, Math.floor(tick))}`;
}

export function parseShareLink(hash: string): { battleId: string; t: number } | null {
  const m = /^#\/replay\/([^/?]+)(?:\?(.*))?$/.exec(hash);
  if (!m) return null;
  const t = Number(new URLSearchParams(m[2] ?? "").get("t") ?? 0);
  return { battleId: decodeURIComponent(m[1]), t: Number.isFinite(t) && t >= 0 ? Math.floor(t) : 0 };
}
