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
 *  - OLA 2 · MA · El gateway NO toca la simulación ni envía estado crudo del
 *    motor: `battle.snapshots` son FRAMES INTERNOS (ids internos, estado exacto,
 *    minas) y `battle.publicEvents` lleva ids internos. Todo sale por
 *    `projectFrame()` de packages/projection, con UN proyector por AUDIENCIA
 *    (`public_live`, `broadcast`, `staff`): mapper de ids, historial del retardo
 *    y último estado separados por audiencia. La audiencia viaja FIRMADA en el
 *    ticket (`view`). Nada de observationFor() aquí: es del canal de BOT (E5).
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
import { AudienceProjector, audienceKey, type InternalRosterEntry } from "../../../../packages/projection/index.js";
import { verifySpectateTicket, type SpectatorView, type VerifiedSpectateTicket } from "../auth/tokens.js";

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
  /** Frames INTERNOS acumulados (el motor los añade cada snapshotEveryNTicks). Nunca salen tal cual. */
  snapshots: any[];
  /** Eventos «públicos por definición» del motor, con ids INTERNOS: se proyectan por audiencia. */
  publicEvents: any[];
  isFinished(): boolean;
  getResult(): unknown | null;
}

export interface AttachOptions {
  /** Config de espectador del ruleset (ADR-000: todo configurable por ruleset). */
  spectator?: { allowFogView?: boolean; delaySeconds?: number };
  /**
   * Cabecera para el mensaje init (mapa, modo, equipos…). Lista blanca: sólo salen las
   * claves de `META_KEYS`; `meta.roster` es la nómina INTERNA y se proyecta por audiencia.
   */
  meta?: Record<string, unknown>;
  /** Nómina interna (id interno ↔ bot). Si falta, se toma de `meta.roster`. */
  roster?: InternalRosterEntry[];
  /** Ids PÚBLICOS del mapa (muros, destructibles, zonas) que pueden aparecer en eventos/objetivos. */
  mapEntityIds?: string[];
  /**
   * Capas de depuración para tickets autorizados. Es un PROVEEDOR explícito:
   * el gateway no escarba en los privados de Battle. Quien registra la batalla
   * decide qué expone (p. ej. minas ocultas, rayos de sensores).
   */
  debugLayers?: () => Record<string, unknown>;
  /** ms entre sondeos de los arrays públicos. 33 ms sigue el ritmo de 30 Hz. */
  pollIntervalMs?: number;
}

/** Audiencias del canal de espectador (cerradas; la firma la API en el ticket). */
const FEED_VIEWS: readonly SpectatorView[] = ["public_live", "broadcast", "staff"];

/** Claves de `meta` que pueden salir en el init (el resto no sale). */
const META_KEYS = ["mode", "mapId", "mapVersion", "tournamentId", "matchId", "round", "official", "world"] as const;

/** Estado de UNA audiencia de una batalla: nunca se comparte con otra (M3). */
interface AudienceFeed {
  view: SpectatorView;
  projector: AudienceProjector;
  clients: Set<SpectatorConnection>;
  /** Cabecera ya proyectada para esta audiencia. */
  meta: Record<string, unknown>;
  /** Último snapshot YA proyectado (base del init sin retardo). */
  lastSnapshot: unknown | null;
  /**
   * EQ5 · Sólo con retardo: mensajes YA PROYECTADOS para esta audiencia con su instante
   * de producción, dentro de la ventana del retardo.
   */
  history: { at: number; msg: Record<string, unknown>; debugOnly: boolean }[];
  /** Último snapshot (y fin de partida) YA fuera de la ventana: base del init retrasado. */
  dueSnapshot: unknown | null;
  dueResult: { result: unknown } | null;
}

interface Feed {
  battle: SpectatableBattle;
  opts: AttachOptions;
  sentSnapshots: number;
  sentEvents: number;
  timer: ReturnType<typeof setInterval> | null;
  finished: boolean;
  /** Retardo anti-coaching del feed en ms (0 = directo sin retardo). */
  delayMs: number;
  audiences: Map<SpectatorView, AudienceFeed>;
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
  /**
   * Carril J · capability de espectador PÚBLICO (S9_PUBLIC_SPECTATE_ENABLED),
   * apagada por defecto. Segunda línea de defensa, en OTRO proceso que el de la
   * API: con la capability apagada, un ticket ANÓNIMO criptográficamente válido
   * NO abre el canal. Los tickets de sesión autenticada no dependen de ella (el
   * espectador interno del producto no es "espectador público").
   *
   * Que la API deje de emitir tickets anónimos y que el gateway rechace los
   * anónimos son dos controles independientes A PROPÓSITO: un despliegue con la
   * variable puesta en un servicio y no en el otro falla CERRADO en el canal.
   *
   * MG · booleano fijo (tests) o getter SÍNCRONO de los ajustes de runtime
   * (RuntimeSettingsStore.getter en el tournament-worker): se evalúa en cada
   * conexión, así que un cambio desde la admin se aplica sin reiniciar el worker.
   */
  publicSpectateEnabled?: boolean | (() => boolean);
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
  private readonly publicSpectateEnabled: () => boolean;

  constructor(opts: SpectateGatewayOptions = {}) {
    this.maxClientsPerBattle = opts.maxClientsPerBattle ?? DEFAULT_MAX_CLIENTS_PER_BATTLE;
    const ps = opts.publicSpectateEnabled ?? false;
    this.publicSpectateEnabled = typeof ps === "function" ? ps : () => ps;
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
    const delayMs = Math.max(0, (opts.spectator?.delaySeconds ?? 0) * 1000);
    const rawMeta = opts.meta ?? {};
    const roster: InternalRosterEntry[] =
      opts.roster ?? (Array.isArray(rawMeta.roster) ? (rawMeta.roster as InternalRosterEntry[]) : []);
    const audiences = new Map<SpectatorView, AudienceFeed>();
    const at = Date.now();
    for (const view of FEED_VIEWS) {
      const projector = new AudienceProjector({
        battleId,
        audience: audienceKey(view),
        roster,
        mapEntityIds: opts.mapEntityIds,
      });
      // Lo que ya existía al registrar la batalla se proyecta EN ORDEN (la numeración
      // pública es por primera visibilidad desde el tick 0).
      let lastSnapshot: unknown | null = null;
      for (const f of battle.snapshots) lastSnapshot = projector.project(f).body;
      const meta: Record<string, unknown> = {};
      for (const k of META_KEYS) if (rawMeta[k] !== undefined) meta[k] = rawMeta[k];
      meta.roster = projector.projectRoster(roster);
      const af: AudienceFeed = {
        view,
        projector,
        clients: new Set(),
        meta,
        lastSnapshot,
        history: [],
        dueSnapshot: null,
        dueResult: null,
      };
      // EQ5 · Con retardo, lo que ya existía se fecha AHORA: no se entrega hasta pasado
      // el retardo. Falla hacia «menos información», nunca hacia el estado vivo.
      if (delayMs > 0 && lastSnapshot !== null)
        af.history.push({
          at,
          msg: { type: "snapshot", snapshot: lastSnapshot, mappingId: projector.mappingId },
          debugOnly: false,
        });
      audiences.set(view, af);
    }
    // Los eventos ya emitidos no se reenvían (igual que antes): el stream sigue desde aquí.
    const feed: Feed = {
      battle,
      opts,
      sentSnapshots: battle.snapshots.length, // el init entrega el último; el stream sigue desde aquí
      sentEvents: battle.publicEvents.length,
      timer: null,
      finished: false,
      delayMs,
      audiences,
    };
    feed.timer = setInterval(() => this.pump(battleId, feed), opts.pollIntervalMs ?? 33);
    this.feeds.set(battleId, feed);
  }

  detachBattle(battleId: string): void {
    const feed = this.feeds.get(battleId);
    if (!feed) return;
    if (feed.timer) clearInterval(feed.timer);
    for (const af of feed.audiences.values())
      for (const c of af.clients) this.dropClient(af, c, 1001, "battle_detached");
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
    // Carril J · FAIL-CLOSED del espectador PÚBLICO: con S9_PUBLIC_SPECTATE_ENABLED
    // apagada, un ticket ANÓNIMO no abre el canal aunque su firma sea válida y la
    // batalla esté en directo. Se comprueba ANTES de quemar el jti y ANTES de mirar
    // los feeds: el rechazo no distingue "batalla en directo" de "batalla
    // inexistente" (no filtra la existencia de un id concreto, igual que
    // getPublicLiveBattle responde 404 con la capability apagada).
    if (claims.anon === true && !this.publicSpectateEnabled()) {
      ws.close(4403, "public_spectate_disabled");
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
    // OLA 2 · MA · la audiencia viene FIRMADA en el ticket; sin ella el ticket ya se
    // rechazó en verifySpectateTicket. Cada audiencia tiene su proyector y su historial.
    const af = feed.audiences.get(claims.view);
    if (!af) {
      ws.close(4403, "invalid_ticket_audience");
      return;
    }
    // R13.2 (hardening) · límite de conexiones por batalla (todas las audiencias): el
    // jti ya se marcó usado arriba a propósito — un ticket rechazado por saturación no
    // debe poder reintentarse indefinidamente para amplificar el intento.
    let total = 0;
    for (const x of feed.audiences.values()) total += x.clients.size;
    if (total >= this.maxClientsPerBattle) {
      ws.close(4429, "too_many_spectators");
      return;
    }

    const conn: SpectatorConnection = {
      ws,
      // Las capas de depuración sólo van con la audiencia `staff` (y su flag firmado).
      debug: claims.debug === true && claims.view === "staff",
      delayMs: feed.delayMs,
      timers: new Set(),
    };
    af.clients.add(conn);
    ws.on("close", () => this.dropClient(af, conn));
    ws.on("error", () => this.dropClient(af, conn));

    // EQ5 · Retardo anti-coaching: el init NO puede llevar el estado vivo. Lleva el
    // estado de `ahora - retardo` (o null si aún no hay ninguno tan antiguo) y el tramo
    // intermedio se entrega después, cada mensaje en su hora de producción + retardo.
    // Todo lo que sale aquí está YA proyectado para la audiencia del ticket.
    let snapshot: unknown = af.lastSnapshot;
    let finished = feed.battle.isFinished();
    let result: unknown = finished ? af.projector.projectResult(feed.battle.getResult()) : undefined;
    let serverTimeMs = Date.now();
    let backlog: AudienceFeed["history"] = [];
    if (conn.delayMs > 0) {
      this.trimHistory(af, feed.delayMs);
      const cutoff = Date.now() - conn.delayMs;
      snapshot = af.dueSnapshot;
      finished = af.dueResult !== null;
      result = af.dueResult?.result;
      serverTimeMs = cutoff;
      backlog = [...af.history];
    }

    // Recuperación de estado por snapshot COMPLETO (DoD de reconexión).
    this.sendTo(
      conn,
      {
        type: "init",
        battleId,
        // Opaco: cambia con la audiencia. El cliente vacía sus cachés si cambia.
        mappingId: af.projector.mappingId,
        // R3.2: reloj del servidor, a nivel de MENSAJE (no dentro del snapshot).
        serverTimeMs,
        spectator: {
          allowFogView: feed.opts.spectator?.allowFogView === true,
          delaySeconds: feed.opts.spectator?.delaySeconds ?? 0,
          debug: conn.debug,
        },
        meta: af.meta,
        snapshot,
        finished,
        result,
      },
      /*immediate*/ true,
    );
    // Tramo de la ventana del retardo: cada mensaje a su hora (producción + retardo).
    for (const h of backlog) {
      if (h.debugOnly && !conn.debug) continue;
      this.sendTo(conn, h.msg, false, Math.max(0, h.at + conn.delayMs - Date.now()));
    }
  }

  /** EQ5 · Saca de la ventana lo ya vencido, recordando el último snapshot y el fin. */
  private trimHistory(af: AudienceFeed, delayMs: number): void {
    const cutoff = Date.now() - delayMs;
    while (af.history.length > 0 && af.history[0].at <= cutoff) {
      const h = af.history.shift()!;
      if (h.msg.type === "snapshot") af.dueSnapshot = h.msg.snapshot;
      if (h.msg.type === "result") af.dueResult = { result: h.msg.result };
    }
  }

  private dropClient(af: AudienceFeed, conn: SpectatorConnection, code?: number, reason?: string): void {
    for (const t of conn.timers) clearTimeout(t);
    conn.timers.clear();
    af.clients.delete(conn);
    if (code && conn.ws.readyState === WebSocket.OPEN) conn.ws.close(code, reason);
  }

  private purgeUsedTickets(): void {
    const now = Date.now();
    for (const [k, exp] of this.usedTickets) {
      if (exp + 60_000 < now) this.usedTickets.delete(k);
    }
  }

  // ---------------------------------------------------------------- bombeo
  /**
   * PUBLIC_PROJECTION_BOUNDARY · cada frame interno y cada evento pasan por el proyector
   * de CADA audiencia (aunque no tenga clientes: la numeración es por primera visibilidad
   * desde el tick 0). Nunca se envía un elemento de `battle.snapshots`/`publicEvents`.
   */
  private pump(battleId: string, feed: Feed): void {
    const { battle } = feed;
    while (feed.sentSnapshots < battle.snapshots.length) {
      const frame = battle.snapshots[feed.sentSnapshots++];
      const now = Date.now();
      for (const af of feed.audiences.values()) {
        const projected = af.projector.project(frame);
        af.lastSnapshot = projected.body;
        // serverTimeMs a nivel de mensaje (R3.2): campo opcional, ver init.
        this.broadcast(feed, af, {
          type: "snapshot",
          snapshot: projected.body,
          mappingId: projected.mappingId,
          serverTimeMs: now,
        });
      }
      const staff = feed.audiences.get("staff");
      if (feed.opts.debugLayers && staff) {
        // Sólo la audiencia staff con debug firmado; ver sendTo(). Lo decide quien
        // registra la batalla (proveedor explícito), no el gateway.
        this.broadcast(feed, staff, { type: "debug", tick: frame.tick, layers: feed.opts.debugLayers() }, true);
      }
    }
    while (feed.sentEvents < battle.publicEvents.length) {
      const ev = battle.publicEvents[feed.sentEvents++];
      for (const af of feed.audiences.values()) {
        const projected = af.projector.projectEvent(ev);
        if (projected) this.broadcast(feed, af, { type: "event", event: projected });
      }
    }
    if (battle.isFinished() && !feed.finished) {
      feed.finished = true;
      const result = battle.getResult();
      for (const af of feed.audiences.values()) {
        this.broadcast(feed, af, { type: "result", result: af.projector.projectResult(result) });
      }
      if (feed.timer) clearInterval(feed.timer);
      feed.timer = null;
    }
    void battleId;
  }

  private broadcast(feed: Feed, af: AudienceFeed, msg: Record<string, unknown>, debugOnly = false): void {
    if (feed.delayMs > 0) {
      af.history.push({ at: Date.now(), msg, debugOnly });
      this.trimHistory(af, feed.delayMs);
    }
    for (const c of af.clients) {
      if (debugOnly && !c.debug) continue;
      this.sendTo(c, msg);
    }
  }

  private sendTo(
    conn: SpectatorConnection,
    msg: Record<string, unknown>,
    immediate = false,
    delayOverrideMs?: number,
  ): void {
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
    // El init va inmediato incluso con retardo: lleva estado YA retrasado (el de
    // `ahora - retardo`, ver handleConnection); el retardo aplica al stream.
    if (conn.delayMs > 0 && !immediate) {
      const t = setTimeout(() => {
        conn.timers.delete(t);
        deliver();
      }, delayOverrideMs ?? conn.delayMs);
      conn.timers.add(t);
    } else {
      deliver();
    }
  }
}
