/**
 * E8/T8.2 · Gateway WebSocket de espectador — la pieza que E7 dejó declarada
 * "pendiente de reconciliación con E8" (docs/entrega-E7.md): consume el ticket
 * firmado que emite `getSpectateTicket` y sirve el canal de SOLO snapshots
 * públicos (D8) a 10 Hz + eventos públicos del motor de E2.
 *
 * Decisiones:
 *  - El ticket es de UN SOLO USO (jti): un ticket robado del historial de red no
 *    sirve para abrir una segunda conexión. Reconectar = pedir otro ticket a la
 *    API (gratis para el visor: son 60 s de TTL y cuota anónima aparte).
 *  - El gateway NO toca la simulación: lee `battle.snapshots` y
 *    `battle.publicEvents`, los arrays PÚBLICOS que E2 mantiene (T2.6, "el
 *    snapshot público jamás contiene observaciones privadas"). Nada de
 *    observationFor() aquí: ese método es del canal de BOT (E5), no del de
 *    espectador. La prueba de fuga de gateway.test recorre el stream real.
 *  - Capas de depuración (sensores/colisiones/minas ocultas): solo si el ticket
 *    trae `debug: true`, y ese flag lo FIRMA la API según el rol (T8.2).
 *  - Retardo de espectador (E8.M, anti-coaching): si el ruleset declara
 *    `spectator.delaySeconds`, los mensajes se difieren ese tiempo.
 *
 * Quién registra batallas: en producción el worker de E9 llama a attachBattle()
 * al arrancar cada batalla (pendiente de reconciliación con E9, documentado en
 * la entrega). Los tests lo hacen con batallas reales del motor.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { verifySpectateTicket, type VerifiedSpectateTicket } from "../auth/tokens.js";

/**
 * R2.6 (ERR-SEC-16): el ticket viaja FUERA de la URL, como subprotocolo
 * WebSocket (`Sec-WebSocket-Protocol: spectate.v1, ticket.<jwt>`): las URLs
 * acaban en logs de acceso (Nginx/Loki) y el ticket no debe acabar ahí.
 * El primer subprotocolo ofrecido es el de la aplicación (el servidor lo
 * ecoa, requisito del handshake en navegador); el segundo transporta el
 * ticket (base64url + puntos: caracteres de token válidos en la cabecera).
 */
export const SPECTATE_SUBPROTOCOL = "spectate.v1";
export const TICKET_SUBPROTOCOL_PREFIX = "ticket.";

/** Subprotocolos que debe ofrecer un cliente de espectador. */
export function spectateProtocols(ticket: string): string[] {
  return [SPECTATE_SUBPROTOCOL, TICKET_SUBPROTOCOL_PREFIX + ticket];
}

/** Lo que el gateway necesita de una batalla de E2. Estructural: no importa la clase. */
export interface SpectatableBattle {
  /** Snapshots públicos acumulados (E2 los añade cada snapshotEveryNTicks). */
  snapshots: any[];
  /** Eventos públicos acumulados (marcador, banderas, destrucciones…). */
  publicEvents: any[];
  isFinished(): boolean;
  getResult(): unknown | null;
}

export interface AttachOptions {
  /** Config de espectador del ruleset (ADR-000: todo configurable por ruleset). */
  spectator?: { allowFogView?: boolean; delaySeconds?: number };
  /** Info pública de cabecera para el mensaje init (mapa, modo, equipos…). */
  meta?: Record<string, unknown>;
  /**
   * Capas de depuración para tickets autorizados. Es un PROVEEDOR explícito:
   * el gateway no escarba en los privados de Battle. Quien registra la batalla
   * decide qué expone (p. ej. minas ocultas, rayos de sensores).
   */
  debugLayers?: () => Record<string, unknown>;
  /** ms entre sondeos de los arrays públicos. 33 ms sigue el ritmo de 30 Hz. */
  pollIntervalMs?: number;
}

interface Feed {
  battle: SpectatableBattle;
  opts: AttachOptions;
  clients: Set<SpectatorConnection>;
  sentSnapshots: number;
  sentEvents: number;
  timer: ReturnType<typeof setInterval> | null;
  finished: boolean;
}

interface SpectatorConnection {
  ws: WebSocket;
  debug: boolean;
  delayMs: number;
  timers: Set<ReturnType<typeof setTimeout>>;
}

export interface SpectateGatewayOptions {
  wss?: WebSocketServer;
  port?: number;
  /**
   * R13.2 (hardening) · Tope de conexiones simultáneas por batalla, para que un
   * enjambre de espectadores en una sola batalla no agote memoria/handles del
   * gateway. Configurable para tests (límites bajos); default 100 en producción.
   */
  maxClientsPerBattle?: number;
}

/** R13.2 (hardening) · frame WS entrante máximo (protege contra floods de payload). */
const MAX_INCOMING_PAYLOAD_BYTES = 64 * 1024;

/** R13.2 (hardening) · default de conexiones simultáneas por batalla. */
const DEFAULT_MAX_CLIENTS_PER_BATTLE = 100;

export class SpectateGateway {
  readonly wss: WebSocketServer;
  private readonly ownsWss: boolean;
  private readonly feeds = new Map<string, Feed>();
  /** jti ya consumidos → epoch ms de expiración (para poder purgarlos). */
  private readonly usedTickets = new Map<string, number>();
  private readonly maxClientsPerBattle: number;

  constructor(opts: SpectateGatewayOptions = {}) {
    this.maxClientsPerBattle = opts.maxClientsPerBattle ?? DEFAULT_MAX_CLIENTS_PER_BATTLE;
    if (opts.wss) {
      this.wss = opts.wss;
      this.ownsWss = false;
    } else {
      // R13.2 (hardening): maxPayload acota el frame WS entrante — el canal es
      // de solo lectura para el cliente (no se procesan mensajes suyos), así
      // que cualquier frame grande es ruido/abuso, nunca protocolo legítimo.
      this.wss = new WebSocketServer({ port: opts.port ?? 0, maxPayload: MAX_INCOMING_PAYLOAD_BYTES });
      this.ownsWss = true;
    }
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
  }

  get port(): number {
    const addr = this.wss.address();
    if (typeof addr === "string" || addr === null) throw new Error("Gateway sin dirección TCP");
    return addr.port;
  }

  /** Registra una batalla en vivo. La llama el worker (E9) o el arranque local. */
  attachBattle(battleId: string, battle: SpectatableBattle, opts: AttachOptions = {}): void {
    const feed: Feed = {
      battle,
      opts,
      clients: new Set(),
      sentSnapshots: battle.snapshots.length, // el init entrega el último; el stream sigue desde aquí
      sentEvents: battle.publicEvents.length,
      timer: null,
      finished: false,
    };
    feed.timer = setInterval(() => this.pump(battleId, feed), opts.pollIntervalMs ?? 33);
    this.feeds.set(battleId, feed);
  }

  detachBattle(battleId: string): void {
    const feed = this.feeds.get(battleId);
    if (!feed) return;
    if (feed.timer) clearInterval(feed.timer);
    for (const c of feed.clients) this.dropClient(feed, c, 1001, "battle_detached");
    this.feeds.delete(battleId);
  }

  close(): void {
    for (const id of [...this.feeds.keys()]) this.detachBattle(id);
    if (this.ownsWss) this.wss.close();
  }

  // ------------------------------------------------------------- conexión
  private handleConnection(ws: WebSocket, req: IncomingMessage | undefined): void {
    // URL esperada: /spectate/<battleId> — SIN ticket. El ticket llega como
    // subprotocolo (`Sec-WebSocket-Protocol: spectate.v1, ticket.<jwt>`),
    // nunca en la query: las URLs acaban en logs de acceso (R2.6 · ERR-SEC-16).
    const parsed = new URL(req?.url ?? "", "http://gateway.local");
    const m = /^\/spectate\/([^/]+)$/.exec(parsed.pathname);
    if (!m) {
      ws.close(4400, "bad_request");
      return;
    }
    // Falla cerrado: un ticket en la URL ya se ha filtrado a los logs — se
    // rechaza aunque fuera válido, para que ningún cliente siga usándola.
    if (parsed.searchParams.has("ticket")) {
      ws.close(4400, "ticket_in_url");
      return;
    }
    const rawHeader = req?.headers["sec-websocket-protocol"];
    const offered = (Array.isArray(rawHeader) ? rawHeader.join(",") : (rawHeader ?? ""))
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const ticketProto = offered.find((p) => p.startsWith(TICKET_SUBPROTOCOL_PREFIX));
    const ticket = ticketProto?.slice(TICKET_SUBPROTOCOL_PREFIX.length);
    if (!ticket) {
      ws.close(4400, "bad_request");
      return;
    }
    const battleId = decodeURIComponent(m[1]);

    // Verificación completa (secreto de espectador propio, algoritmo fijo,
    // issuer/audience): un ticket firmado con el secreto de SESIÓN no valida aquí.
    const claims: VerifiedSpectateTicket | null = verifySpectateTicket(ticket);
    if (!claims) {
      ws.close(4401, "invalid_ticket");
      return;
    }
    if (claims.battleId !== battleId) {
      ws.close(4403, "ticket_battle_mismatch");
      return;
    }
    // Un solo uso: el jti se quema en la primera conexión (los tickets antiguos
    // sin jti — anteriores a E8 — se tratan como su propia firma completa).
    const key = claims.jti ?? ticket;
    this.purgeUsedTickets();
    if (this.usedTickets.has(key)) {
      ws.close(4403, "ticket_already_used");
      return;
    }
    this.usedTickets.set(key, claims.exp * 1000);

    const feed = this.feeds.get(battleId);
    if (!feed) {
      ws.close(4404, "battle_not_live");
      return;
    }
    // R13.2 (hardening) · límite de conexiones por batalla: rechaza ANTES de
    // reservar el ticket (el jti ya se marcó usado arriba a propósito — un
    // ticket rechazado por saturación no debe poder reintentarse indefinidamente
    // con el mismo ticket para amplificar el intento).
    if (feed.clients.size >= this.maxClientsPerBattle) {
      ws.close(4429, "too_many_spectators");
      return;
    }

    const conn: SpectatorConnection = {
      ws,
      debug: claims.debug === true,
      delayMs: Math.max(0, (feed.opts.spectator?.delaySeconds ?? 0) * 1000),
      timers: new Set(),
    };
    feed.clients.add(conn);
    ws.on("close", () => this.dropClient(feed, conn));
    ws.on("error", () => this.dropClient(feed, conn));

    // Recuperación de estado por snapshot COMPLETO (DoD de reconexión): los
    // snapshots de E2 son estado íntegro, así que el último basta para pintar.
    this.sendTo(
      conn,
      {
        type: "init",
        battleId,
        // R3.2: reloj del servidor (opcional, compatible hacia atrás). Va a nivel
        // de MENSAJE, no dentro del snapshot: el snapshot público (D8) conserva su
        // whitelist estructural exacta (test de fugas) y los replays no cambian.
        serverTimeMs: Date.now(),
        spectator: {
          allowFogView: feed.opts.spectator?.allowFogView === true,
          delaySeconds: feed.opts.spectator?.delaySeconds ?? 0,
          debug: conn.debug,
        },
        meta: feed.opts.meta ?? {},
        snapshot: feed.battle.snapshots.at(-1) ?? null,
        finished: feed.battle.isFinished(),
        result: feed.battle.isFinished() ? feed.battle.getResult() : undefined,
      },
      /*immediate*/ true,
    );
  }

  private dropClient(feed: Feed, conn: SpectatorConnection, code?: number, reason?: string): void {
    for (const t of conn.timers) clearTimeout(t);
    conn.timers.clear();
    feed.clients.delete(conn);
    if (code && conn.ws.readyState === WebSocket.OPEN) conn.ws.close(code, reason);
  }

  private purgeUsedTickets(): void {
    const now = Date.now();
    for (const [k, exp] of this.usedTickets) {
      if (exp + 60_000 < now) this.usedTickets.delete(k);
    }
  }

  // ---------------------------------------------------------------- bombeo
  private pump(battleId: string, feed: Feed): void {
    const { battle } = feed;
    while (feed.sentSnapshots < battle.snapshots.length) {
      const snapshot = battle.snapshots[feed.sentSnapshots++];
      // serverTimeMs a nivel de mensaje (R3.2): campo opcional, ver init.
      this.broadcast(feed, { type: "snapshot", snapshot, serverTimeMs: Date.now() });
      if (feed.opts.debugLayers) {
        // Solo la reciben los tickets con debug firmado; ver sendTo().
        this.broadcast(feed, { type: "debug", tick: snapshot.tick, layers: feed.opts.debugLayers() }, true);
      }
    }
    while (feed.sentEvents < battle.publicEvents.length) {
      this.broadcast(feed, { type: "event", event: battle.publicEvents[feed.sentEvents++] });
    }
    if (battle.isFinished() && !feed.finished) {
      feed.finished = true;
      this.broadcast(feed, { type: "result", result: battle.getResult() });
      if (feed.timer) clearInterval(feed.timer);
      feed.timer = null;
    }
  }

  private broadcast(feed: Feed, msg: Record<string, unknown>, debugOnly = false): void {
    for (const c of feed.clients) {
      if (debugOnly && !c.debug) continue;
      this.sendTo(c, msg);
    }
  }

  private sendTo(conn: SpectatorConnection, msg: Record<string, unknown>, immediate = false): void {
    const payload = JSON.stringify({ v: 1, id: randomUUID(), ...msg });
    const deliver = () => {
      if (conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.send(payload);
        } catch {
          /* carrera de cierre: no es fatal */
        }
      }
    };
    // El init va inmediato incluso con retardo: es estado YA retrasado para el
    // que se conecta tarde; el retardo anti-coaching aplica al stream en vivo.
    if (conn.delayMs > 0 && !immediate) {
      const t = setTimeout(() => {
        conn.timers.delete(t);
        deliver();
      }, conn.delayMs);
      conn.timers.add(t);
    } else {
      deliver();
    }
  }
}
