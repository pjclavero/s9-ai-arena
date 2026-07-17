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
import { WebSocket, WebSocketServer } from "ws";
import { verifySpectateTicket, type VerifiedSpectateTicket } from "../auth/tokens.js";

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
}

export class SpectateGateway {
  readonly wss: WebSocketServer;
  private readonly ownsWss: boolean;
  private readonly feeds = new Map<string, Feed>();
  /** jti ya consumidos → epoch ms de expiración (para poder purgarlos). */
  private readonly usedTickets = new Map<string, number>();

  constructor(opts: SpectateGatewayOptions = {}) {
    if (opts.wss) {
      this.wss = opts.wss;
      this.ownsWss = false;
    } else {
      this.wss = new WebSocketServer({ port: opts.port ?? 0 });
      this.ownsWss = true;
    }
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req?.url ?? ""));
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
  private handleConnection(ws: WebSocket, url: string): void {
    // URL esperada: /spectate/<battleId>?ticket=<jwt>
    const parsed = new URL(url, "http://gateway.local");
    const m = /^\/spectate\/([^/]+)$/.exec(parsed.pathname);
    const ticket = parsed.searchParams.get("ticket");
    if (!m || !ticket) {
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
      this.broadcast(feed, { type: "snapshot", snapshot });
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
