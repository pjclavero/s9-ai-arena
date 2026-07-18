/**
 * T8.2 · Cliente de espectador: consume el canal WebSocket del gateway.
 *
 * Framework-agnóstico y sin dependencia de Phaser: toda la lógica de conexión,
 * reconexión y estado vive aquí y se prueba con vitest contra el gateway REAL
 * (apps/web/tests/spectator.e2e.test.ts). El render (PhaserViewer) solo pinta.
 *
 * Reconexión: el ticket es de UN SOLO USO y caduca en 60 s, así que reconectar
 * significa PEDIR OTRO TICKET a la API (getTicket) y abrir socket nuevo. El
 * estado se recupera con el snapshot COMPLETO del mensaje init — no hay que
 * recargar la página (DoD T8.2).
 *
 * R3.2 (ERR-VIS-08) · transporte robusto:
 *  - Backoff EXPONENCIAL con JITTER entre reintentos: mil visores caídos a la
 *    vez no vuelven en estampida sincronizada contra la API.
 *  - El FALLO INICIAL también entra al bucle de reconexión: si la API o el
 *    gateway están caídos en el primer connect(), el visor reintenta igual que
 *    tras un corte (antes: excepción y pantalla muerta).
 *  - Heartbeat/watchdog: el gateway bombea a ≥10 Hz; si no llega NINGÚN mensaje
 *    en `watchdogTimeoutMs`, la conexión está zombi (NAT caído, cable fuera) y
 *    se cierra para forzar la reconexión — sin esperar al timeout de TCP.
 *  - Buffer CIRCULAR de eventos: una batalla larga no crece sin límite en RAM.
 */

export interface SpectateTicket {
  ticket: string;
  wsUrl: string;
}

export interface SpectatorClientOptions {
  /** Pide un ticket fresco a la API (POST /battles/{id}/spectate-ticket). */
  getTicket: () => Promise<SpectateTicket>;
  /** Implementación de WebSocket (window.WebSocket en navegador; `ws` en tests). */
  WebSocketImpl?: typeof WebSocket;
  /** Base del backoff exponencial (delay del primer reintento, antes del jitter). */
  reconnectDelayMs?: number;
  /** Techo del backoff exponencial. */
  reconnectMaxDelayMs?: number;
  /** Reintentos máximos por caída antes de rendirse (∞ por defecto es mala idea). */
  maxReconnectAttempts?: number;
  /** Sin ningún mensaje en este tiempo ⇒ conexión zombi, se fuerza el cierre. */
  watchdogTimeoutMs?: number;
  /** Capacidad del buffer circular de eventos. */
  maxBufferedEvents?: number;
  /** Fuente de aleatoriedad del jitter (inyectable en tests). */
  random?: () => number;
}

export type SpectatorMessage = { type: string; [k: string]: any };

type Listener = (msg: any) => void;

/**
 * Backoff exponencial con jitter "equal jitter": delay = min(cap, base·2^(n−1))
 * y de ahí se sortea uniformemente en [delay/2, delay] — reintentos crecientes
 * y DESINCRONIZADOS entre clientes (sin estampida).
 */
export function backoffDelayMs(attempt: number, baseMs: number, capMs: number, random: () => number = Math.random): number {
  const exp = Math.min(capMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
  return exp / 2 + random() * (exp / 2);
}

/** Buffer circular acotado: conserva los N elementos MÁS RECIENTES. */
export class RingBuffer<T> {
  private buf: (T | undefined)[];
  private head = 0; // próxima posición de escritura
  private count = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error("RingBuffer: capacidad inválida");
    this.buf = new Array(capacity);
  }

  push(item: T): void {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  get length(): number {
    return this.count;
  }

  /** Del más antiguo conservado al más reciente. */
  toArray(): T[] {
    const out: T[] = [];
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) out.push(this.buf[(start + i) % this.capacity] as T);
    return out;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.buf = new Array(this.capacity);
  }
}

export interface SpectatorState {
  connected: boolean;
  /** Último snapshot completo recibido (init o stream). */
  snapshot: any | null;
  /** serverTimeMs del último mensaje del gateway que lo trajo (R3.2, opcional). */
  serverTimeMs: number | null;
  /** init del servidor: qué permite el ruleset al espectador (fog, delay, debug). */
  spectator: { allowFogView: boolean; delaySeconds: number; debug: boolean } | null;
  meta: Record<string, unknown>;
  /** Buffer circular: los últimos N eventos (una batalla larga no come RAM). */
  events: RingBuffer<any>;
  result: any | null;
  reconnects: number;
}

export class SpectatorClient {
  readonly state: SpectatorState;

  private readonly opts: SpectatorClientOptions;
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private stopped = false;
  private everConnected = false;
  private reconnecting = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;

  constructor(opts: SpectatorClientOptions) {
    this.opts = opts;
    this.state = {
      connected: false,
      snapshot: null,
      serverTimeMs: null,
      spectator: null,
      meta: {},
      events: new RingBuffer(opts.maxBufferedEvents ?? 500),
      result: null,
      reconnects: 0,
    };
  }

  on(
    type:
      | "init"
      | "snapshot"
      | "event"
      | "debug"
      | "result"
      | "disconnect"
      | "reconnected"
      | "reconnect_scheduled"
      | "gave_up",
    fn: Listener,
  ): () => void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
    return () => this.listeners.get(type)!.delete(fn);
  }

  private emit(type: string, payload: any): void {
    for (const fn of this.listeners.get(type) ?? []) fn(payload);
  }

  /**
   * Arranca el cliente. NUNCA lanza por un fallo transitorio: si la primera
   * conexión falla (API caída, gateway caído), el fallo se enruta al MISMO
   * bucle de reconexión con backoff que un corte a mitad de batalla.
   */
  async connect(): Promise<void> {
    this.stopped = false;
    try {
      await this.openOnce();
    } catch {
      void this.reconnectLoop();
    }
  }

  stop(): void {
    this.stopped = true;
    this.stopWatchdog();
    this.ws?.close();
    this.ws = null;
  }

  /**
   * Un intento de conexión COMPLETO: pide ticket, abre socket y espera al open.
   * Si el socket no llega a abrirse (conexión rechazada, gateway caído), la
   * promesa RECHAZA — así el bucle de reconexión cuenta el intento y aplica el
   * backoff siguiente, en vez de dar el intento por bueno sin haber conectado.
   */
  private async openOnce(): Promise<void> {
    const { ticket, wsUrl } = await this.opts.getTicket();
    const WS = this.opts.WebSocketImpl ?? WebSocket;
    // R2.6 (ERR-SEC-16): el ticket viaja como SUBPROTOCOLO WebSocket
    // (`Sec-WebSocket-Protocol: spectate.v1, ticket.<jwt>`), nunca en la URL:
    // las URLs acaban en logs de acceso (Nginx/Loki). El gateway rechaza
    // cualquier ticket que llegue en la query.
    const ws = new WS(wsUrl, ["spectate.v1", `ticket.${ticket}`]);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      let opened = false;
      ws.onopen = () => {
        opened = true;
        this.state.connected = true;
        this.lastMessageAt = Date.now();
        this.startWatchdog();
        if (this.everConnected) {
          this.state.reconnects++;
          this.emit("reconnected", { reconnects: this.state.reconnects });
        }
        this.everConnected = true;
        resolve();
      };
      ws.onmessage = (ev: MessageEvent) => {
        this.lastMessageAt = Date.now();
        this.handleMessage(String(ev.data));
      };
      ws.onclose = () => {
        const wasConnected = this.state.connected;
        this.state.connected = false;
        this.stopWatchdog();
        this.emit("disconnect", { wasConnected });
        if (!opened) {
          // El intento ni llegó a abrirse: se lo comunicamos al bucle (backoff)
          // en vez de arrancar otro bucle desde aquí.
          reject(new Error("conexión rechazada"));
          return;
        }
        // La batalla terminó o paramos nosotros: no hay nada que reconectar.
        if (this.stopped || this.state.result) return;
        void this.reconnectLoop();
      };
      ws.onerror = () => {
        /* onclose llega igualmente; el error solo no debe tumbar al visor */
      };
    });
  }

  // ------------------------------------------------------ watchdog (R3.2)
  private startWatchdog(): void {
    this.stopWatchdog();
    const timeout = this.opts.watchdogTimeoutMs ?? 10_000;
    // Se sondea a un cuarto del timeout: detección temprana sin coste apreciable.
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastMessageAt > timeout) {
        // Conexión zombi: cerrar dispara onclose ⇒ bucle de reconexión.
        this.stopWatchdog();
        try {
          this.ws?.close();
        } catch {
          /* ya cerrada */
        }
      }
    }, Math.max(50, Math.floor(timeout / 4)));
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  // ------------------------------------------------- reconexión con backoff
  private async reconnectLoop(): Promise<void> {
    if (this.reconnecting) return; // un solo bucle a la vez
    this.reconnecting = true;
    try {
      const base = this.opts.reconnectDelayMs ?? 1000;
      const cap = this.opts.reconnectMaxDelayMs ?? 30_000;
      const random = this.opts.random ?? Math.random;
      const maxAttempts = this.opts.maxReconnectAttempts ?? 30;
      for (let attempt = 1; attempt <= maxAttempts && !this.stopped; attempt++) {
        const delayMs = backoffDelayMs(attempt, base, cap, random);
        this.emit("reconnect_scheduled", { attempt, delayMs });
        await new Promise((r) => setTimeout(r, delayMs));
        if (this.stopped) return;
        try {
          await this.openOnce();
          return; // el init repondrá el estado
        } catch {
          // La API puede estar caída también; se sigue intentando hasta el límite.
        }
      }
      if (!this.stopped) this.emit("gave_up", {});
    } finally {
      this.reconnecting = false;
    }
  }

  private handleMessage(raw: string): void {
    let msg: SpectatorMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // basura en el canal: se ignora, el visor no debe morir por esto
    }
    if (typeof msg.serverTimeMs === "number") this.state.serverTimeMs = msg.serverTimeMs;
    switch (msg.type) {
      case "init":
        // Recuperación de estado íntegro: snapshot completo del servidor.
        this.state.snapshot = msg.snapshot ?? this.state.snapshot;
        this.state.spectator = msg.spectator ?? null;
        this.state.meta = msg.meta ?? {};
        if (msg.finished && msg.result) this.state.result = msg.result;
        this.emit("init", msg);
        break;
      case "snapshot":
        this.state.snapshot = msg.snapshot;
        this.emit("snapshot", msg.snapshot);
        break;
      case "event":
        this.state.events.push(msg.event);
        this.emit("event", msg.event);
        break;
      case "debug":
        this.emit("debug", msg);
        break;
      case "result":
        this.state.result = msg.result;
        this.emit("result", msg.result);
        break;
      default:
        break; // tipos futuros: tolerancia hacia delante
    }
  }
}
