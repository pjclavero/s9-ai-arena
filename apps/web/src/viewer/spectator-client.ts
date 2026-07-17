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
  /** Espera entre reintentos de reconexión. */
  reconnectDelayMs?: number;
  /** Reintentos máximos por caída antes de rendirse (∞ por defecto es mala idea). */
  maxReconnectAttempts?: number;
}

export type SpectatorMessage = { type: string; [k: string]: any };

type Listener = (msg: any) => void;

export interface SpectatorState {
  connected: boolean;
  /** Último snapshot completo recibido (init o stream). */
  snapshot: any | null;
  /** init del servidor: qué permite el ruleset al espectador (fog, delay, debug). */
  spectator: { allowFogView: boolean; delaySeconds: number; debug: boolean } | null;
  meta: Record<string, unknown>;
  events: any[];
  result: any | null;
  reconnects: number;
}

export class SpectatorClient {
  readonly state: SpectatorState = {
    connected: false,
    snapshot: null,
    spectator: null,
    meta: {},
    events: [],
    result: null,
    reconnects: 0,
  };

  private readonly opts: Required<Pick<SpectatorClientOptions, "getTicket">> & SpectatorClientOptions;
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private stopped = false;
  private everConnected = false;

  constructor(opts: SpectatorClientOptions) {
    this.opts = opts;
  }

  on(type: "init" | "snapshot" | "event" | "debug" | "result" | "disconnect" | "reconnected" | "gave_up", fn: Listener): () => void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
    return () => this.listeners.get(type)!.delete(fn);
  }

  private emit(type: string, payload: any): void {
    for (const fn of this.listeners.get(type) ?? []) fn(payload);
  }

  async connect(): Promise<void> {
    this.stopped = false;
    await this.openOnce();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  private async openOnce(): Promise<void> {
    const { ticket, wsUrl } = await this.opts.getTicket();
    const WS = this.opts.WebSocketImpl ?? WebSocket;
    // R2.6 (ERR-SEC-16): el ticket viaja como SUBPROTOCOLO WebSocket
    // (`Sec-WebSocket-Protocol: spectate.v1, ticket.<jwt>`), nunca en la URL:
    // las URLs acaban en logs de acceso (Nginx/Loki). El gateway rechaza
    // cualquier ticket que llegue en la query.
    const ws = new WS(wsUrl, ["spectate.v1", `ticket.${ticket}`]);
    this.ws = ws;

    ws.onopen = () => {
      this.state.connected = true;
      if (this.everConnected) {
        this.state.reconnects++;
        this.emit("reconnected", { reconnects: this.state.reconnects });
      }
      this.everConnected = true;
    };
    ws.onmessage = (ev: MessageEvent) => this.handleMessage(String(ev.data));
    ws.onclose = () => {
      const wasConnected = this.state.connected;
      this.state.connected = false;
      this.emit("disconnect", { wasConnected });
      // La batalla terminó o paramos nosotros: no hay nada que reconectar.
      if (this.stopped || this.state.result) return;
      void this.reconnectLoop();
    };
    ws.onerror = () => {
      /* onclose llega igualmente; el error solo no debe tumbar al visor */
    };
  }

  private async reconnectLoop(): Promise<void> {
    const delay = this.opts.reconnectDelayMs ?? 1000;
    const maxAttempts = this.opts.maxReconnectAttempts ?? 30;
    for (let attempt = 1; attempt <= maxAttempts && !this.stopped; attempt++) {
      await new Promise((r) => setTimeout(r, delay));
      if (this.stopped) return;
      try {
        await this.openOnce();
        return; // el init repondrá el estado
      } catch {
        // La API puede estar caída también; se sigue intentando hasta el límite.
      }
    }
    this.emit("gave_up", {});
  }

  private handleMessage(raw: string): void {
    let msg: SpectatorMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // basura en el canal: se ignora, el visor no debe morir por esto
    }
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
