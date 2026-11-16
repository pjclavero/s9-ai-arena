/**
 * FIX-DIRECTOR-DELAY · Línea temporal PÚBLICA retrasada del director de /broadcast.
 *
 * Defecto demostrado en C2 (2026-11-16): el feed público va retrasado
 * `spectator.delaySeconds` (anti-coaching), pero el director decidía las pantallas con el
 * estado REAL de la API. La última batalla terminó en real y el director anunció «Torneo
 * terminado» con ~18 s de batalla retrasada aún por emitir; cada cambio de batalla cortaba
 * igual los 30 s finales de la anterior.
 *
 * Aquí vive la ÚNICA fuente de tiempo de las decisiones del director: el propio canal de
 * espectador del gateway, que ya es la línea temporal retrasada (init con el estado de
 * `ahora − retardo`, stream y `result` a su hora). Una conexión por batalla seguida, propiedad
 * del director (no de la pantalla): el visor de la emisión pinta ESA MISMA conexión, así que
 * lo que se ve y lo que decide el director comparten conexión y reloj. Ningún temporizador
 * del navegador decide una transición: sólo los mensajes del feed retrasado.
 *
 * Fases de una batalla seguida (monótonas; `unavailable` sólo antes de `ended`):
 *   connecting → pending (init sin imagen retrasada) → playing (contenido retrasado) → ended
 *   (`result` retrasado, o init que ya trae el fin vencido)
 *   unavailable: rechazo terminal del ticket o del socket, o el cliente se rindió.
 */
import { announcedDelayMs } from "../viewer/delay-wait.js";

export type FeedPhase = "connecting" | "pending" | "playing" | "ended" | "unavailable";

export interface FeedStatus {
  phase: FeedPhase;
  /** Retardo que anunció el init del feed (ms); null hasta el primer init. */
  delayMs: number | null;
  /**
   * Hora LOCAL del último cambio de fase. Sólo sirve para espaciar reintentos de un feed no
   * disponible; NUNCA decide una transición visible.
   */
  sinceMs: number;
}

/** Lo que el director necesita de la línea temporal (inyectable en tests). */
export interface PublicTimeline {
  /** Empieza a seguir el feed retrasado de una batalla (idempotente). */
  track(battleId: string): void;
  /** Deja de seguirla y cierra su conexión. */
  release(battleId: string): void;
  status(battleId: string): FeedStatus | undefined;
  /** Batallas seguidas ahora mismo. */
  tracked(): string[];
  /** Aviso de cambio de fase (coalescido). Devuelve la baja. */
  onChange(fn: () => void): () => void;
}

/** Lo que la línea temporal usa de un cliente de espectador (SpectatorClient lo cumple). */
export interface TimelineClient {
  readonly state: { snapshot: any; result: any; serverTimeMs: number | null; connected: boolean };
  on(type: string, fn: (msg: any) => void): () => void;
  connect(): Promise<void>;
  stop(): void;
}

/** Lo que la pantalla en directo recibe para pintar el feed que decide el director. */
export interface LiveFeedSource {
  readonly client: TimelineClient;
  /** Último init recibido (null si aún no llegó). */
  lastInit(): any | null;
  /** Rechazo terminal del feed (null si no lo hubo). */
  rejection(): { code?: number; status?: number } | null;
}

const RANK: Record<FeedPhase, number> = { connecting: 0, pending: 1, playing: 2, unavailable: 2.5, ended: 3 };

interface Entry {
  client: TimelineClient;
  phase: FeedPhase;
  delayMs: number | null;
  sinceMs: number;
  init: any | null;
  rejection: { code?: number; status?: number } | null;
  unsubs: (() => void)[];
  /** Fuente estable para la pantalla (la misma identidad mientras dure la entrada). */
  source: LiveFeedSource;
}

export interface SpectatorTimelineOptions {
  /** Cliente de espectador de una batalla (en producción, SpectatorClient con ticket anónimo). */
  createClient: (battleId: string) => TimelineClient;
  /** Reloj local inyectable (tests). */
  now?: () => number;
}

export class SpectatorTimeline implements PublicTimeline {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private notifyQueued = false;

  constructor(private readonly opts: SpectatorTimelineOptions) {}

  track(battleId: string): void {
    if (this.entries.has(battleId)) return;
    const client = this.opts.createClient(battleId);
    const e = {
      client,
      phase: "connecting",
      delayMs: null,
      sinceMs: this.now(),
      init: null,
      rejection: null,
      unsubs: [],
    } as unknown as Entry;
    e.source = { client, lastInit: () => e.init, rejection: () => e.rejection };
    this.entries.set(battleId, e);
    const advance = (p: FeedPhase) => {
      if (this.entries.get(battleId) !== e) return; // liberada: ya no cuenta
      if (e.phase === "ended" || e.phase === "unavailable") return;
      if (RANK[p] <= RANK[e.phase]) return;
      e.phase = p;
      e.sinceMs = this.now();
      this.notify();
    };
    e.unsubs.push(
      client.on("init", (msg) => {
        e.init = msg;
        e.delayMs = announcedDelayMs(msg?.spectator);
        // El init del gateway YA va retrasado: `finished` es el fin vencido, `snapshot` el
        // estado de `ahora − retardo` (null si todavía no hay ninguno tan antiguo).
        if (msg?.finished) advance("ended");
        else if (msg?.snapshot) advance("playing");
        else advance("pending");
      }),
      client.on("snapshot", () => advance("playing")),
      client.on("result", () => advance("ended")),
      client.on("rejected", (r) => {
        e.rejection = { code: r?.code, status: r?.status };
        advance("unavailable");
      }),
      client.on("gave_up", () => advance("unavailable")),
    );
    void client.connect();
  }

  release(battleId: string): void {
    const e = this.entries.get(battleId);
    if (!e) return;
    this.entries.delete(battleId);
    for (const u of e.unsubs) u();
    e.client.stop();
  }

  stopAll(): void {
    for (const id of [...this.entries.keys()]) this.release(id);
    this.listeners.clear();
  }

  status(battleId: string): FeedStatus | undefined {
    const e = this.entries.get(battleId);
    return e ? { phase: e.phase, delayMs: e.delayMs, sinceMs: e.sinceMs } : undefined;
  }

  tracked(): string[] {
    return [...this.entries.keys()];
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Feed de una batalla seguida, para que la pantalla en directo pinte la MISMA conexión. */
  feed(battleId: string): LiveFeedSource | undefined {
    return this.entries.get(battleId)?.source;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /**
   * Coalescido en un microtask: el director re-evalúa FUERA del despacho de eventos del
   * cliente (puede liberar ese mismo cliente) y una ráfaga de cambios es una sola re-evaluación.
   */
  private notify(): void {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      for (const fn of [...this.listeners]) fn();
    });
  }
}
