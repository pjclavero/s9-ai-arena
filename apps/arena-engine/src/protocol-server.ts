/**
 * T5.1 · Servidor de protocolo arena/1 (cap. 15).
 *
 * Puente entre WebSocket real y la interfaz interna `BotAgent` que `Battle` ya sabe
 * usar. NO reimplementa reglas de juego, observaciones ni validación de energía/
 * munición/arco — todo eso ya lo hace `Battle` (autoritativo, D-regla 1). La única
 * responsabilidad de este archivo es TRANSPORTE + VALIDACIÓN DE FORMA.
 *
 * El truco de diseño que hace posible conectar un socket asíncrono a un bucle
 * síncrono (`Battle.step()` llama a `agent.decide(observation)` y espera un valor
 * de vuelta AHORA, sin await): el propio protocolo ya está pensado para esto. El
 * diagrama de packages/protocol/README.md dice `OBSERVATION (tick N) → COMMAND
 * (forTick N+3)` — el bot no responde a la observación que acaba de recibir, responde
 * a la ANTERIOR. Así que `decide()` no espera a nada: siempre devuelve la respuesta
 * al ciclo previo (recogida de forma asíncrona por el manejador de mensajes del
 * socket durante los ~100 ms entre ciclos de decisión) y de paso envía la
 * observación de este ciclo, que se responderá en la SIGUIENTE llamada.
 *
 * Vive en apps/arena-engine/src/, FUERA de src/sim/: aquí SÍ es legítimo usar
 * setTimeout y el reloj real (deadlines de red), cosas prohibidas dentro de sim/
 * por scripts/lint-determinism.mjs.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { WebSocket, WebSocketServer } from "ws";
import {
  DECISION_DEADLINE_MS,
  DECISION_EVERY_N_TICKS,
  RADIO_DELIVERY_DELAY_DECISIONS,
  RADIO_MAX_MESSAGE_BYTES,
  RADIO_MAX_MESSAGES_PER_SECOND,
  TICK_DT,
  TICK_HZ,
} from "../../../packages/game-rules/index.js";
import { Battle, type BattleResult, type BotAgent } from "./sim/battle.js";
import { replayFromBattle, type Replay } from "./replay.js";
import deps from "./engine-deps.json" with { type: "json" };

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(__dirname, "..", "..", "..", "packages", "protocol", "schemas");

// ------------------------------------------------------------------------- Ajv
// Misma forma de cargar los esquemas que packages/protocol/scripts/validate.js de
// E1: registrar cada archivo por su nombre para que los $ref relativos resuelvan.
function buildEnvelopeValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".json"))) {
    const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8"));
    ajv.addSchema(schema, f);
  }
  const v = ajv.getSchema("envelope.schema.json");
  if (!v) throw new Error("No se pudo compilar envelope.schema.json");
  return v;
}

let cachedValidator: ReturnType<typeof buildEnvelopeValidator> | null = null;
function envelopeValidator() {
  if (!cachedValidator) cachedValidator = buildEnvelopeValidator();
  return cachedValidator;
}

// -------------------------------------------------------------------- mensajería
let globalSeq = 0;
function nextSeq(): number {
  return globalSeq++;
}

function envelope(type: string, payload: unknown, tick?: number) {
  const msg: Record<string, unknown> = { proto: "arena/1", type, seq: nextSeq(), payload };
  if (tick !== undefined) msg.tick = tick;
  return msg;
}

function safeSend(ws: WebSocket, msg: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // El socket puede cerrarse justo entre la comprobación y el send; no es fatal.
  }
}

function sendShutdown(ws: WebSocket, reason: string, detail?: string, result?: unknown, gracePeriodMs = 500): void {
  safeSend(
    ws,
    envelope("SHUTDOWN", { reason, ...(detail ? { detail } : {}), ...(result ? { result } : {}), gracePeriodMs }),
  );
}

// --------------------------------------------------------------- configuración
export interface ExpectedBot {
  botId: string;
  vehicleId: string;
  battleToken: string;
  suspended?: boolean;
}

export interface ProtocolServerOptions {
  battle: Battle;
  expected: ExpectedBot[];
  /** Versión del catálogo con la que se resolvieron los vehículos de esta batalla (WELCOME.versions.catalog). */
  catalogVersion: string;
  /** ms reales por tick del bucle. Por defecto TICK_DT*1000 (~33,3 ms); los tests lo bajan para no esperar de verdad. */
  tickIntervalMs?: number;
  /** Deadline de decisión, ms reales. Por defecto DECISION_DEADLINE_MS (80). */
  decisionDeadlineMs?: number;
  /** Reutiliza un WebSocketServer ya creado (p. ej. en tests). Si no se da, se crea uno propio en `port`. */
  wss?: WebSocketServer;
  /** Puerto para el WebSocketServer propio. 0 = puerto libre asignado por el SO (útil en tests). */
  port?: number;
  /**
   * ms reales para completar el handshake tras conectar, antes de cerrar con
   * SHUTDOWN(invalid_message). Por defecto 5000. Sin este timeout, un HELLO que no
   * valida contra el esquema (regla 4: "se trata como ausente") deja al bot
   * conectado sin ninguna señal — indistinguible de un servidor colgado. Encontrado
   * de verdad depurando un botId con un carácter no permitido (T5.4).
   */
  handshakeTimeoutMs?: number;
}

type ConnectionState = "awaiting_hello" | "connected" | "closed";

// ------------------------------------------------------------------- BotAgent
/**
 * Implementa BotAgent para una conexión WebSocket. decide() NUNCA espera al socket:
 * devuelve la respuesta al ciclo anterior y dispara el envío/deadline del actual.
 */
class WebSocketBotAgent implements BotAgent {
  readonly botId: string;
  ws: WebSocket;
  private decisionDeadlineMs: number;
  private pendingCommand: any | null = null;
  private windowOpen = false;
  private expectedForTick: number | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private onSend: (msg: unknown) => void;

  constructor(botId: string, ws: WebSocket, decisionDeadlineMs: number) {
    this.botId = botId;
    this.ws = ws;
    this.decisionDeadlineMs = decisionDeadlineMs;
    this.onSend = (msg) => safeSend(this.ws, msg);
  }

  /** Reengancha un socket nuevo (reconexión dentro de la ventana de gracia del motor). */
  rebind(ws: WebSocket): void {
    this.ws = ws;
    this.onSend = (msg) => safeSend(this.ws, msg);
  }

  decide(observation: any): any | null {
    const result = this.pendingCommand;
    this.pendingCommand = null;
    this.windowOpen = false;
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }

    if (this.ws.readyState !== WebSocket.OPEN) return result;

    const forTick = observation.tick + DECISION_EVERY_N_TICKS;
    this.expectedForTick = forTick;
    this.windowOpen = true;
    this.onSend(envelope("OBSERVATION", observation, observation.tick));

    this.deadlineTimer = setTimeout(() => {
      this.windowOpen = false;
    }, this.decisionDeadlineMs);

    return result;
  }

  onEvent(event: any): void {
    this.onSend(envelope("EVENT", event, event.tick));
  }

  /** Llamado por el servidor cuando llega un COMMAND ya validado contra el esquema. */
  receiveCommand(payload: any): void {
    // expectedForTick nunca es null con la ventana abierta (se asigna justo antes de
    // abrirla); el guard existe para que el narrowing de TS estricto lo sepa también.
    if (!this.windowOpen || this.expectedForTick === null) return; // llegó tarde (D2): se descarta, sin evento.
    const expectedForTick = this.expectedForTick;
    if (payload.forTick !== expectedForTick) return; // no es para el ciclo que espera.
    if (this.pendingCommand !== null) {
      // Ya había un COMMAND válido para este ciclo: el segundo se descarta con evento.
      this.onSend(
        envelope(
          "EVENT",
          {
            tick: expectedForTick - DECISION_EVERY_N_TICKS,
            kind: "rejected_action",
            reason: "extra_command_discarded",
          },
          expectedForTick - DECISION_EVERY_N_TICKS,
        ),
      );
      return;
    }
    this.pendingCommand = payload;
  }

  /** Se desconecta el transporte: decide() seguirá devolviendo null indefinidamente.
   * El motor ya cuenta timeouts consecutivos y descalifica solo (D2); no hay que
   * duplicar la ventana de gracia aquí. */
  disconnect(): void {
    this.pendingCommand = null;
    this.windowOpen = false;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }
}

// ------------------------------------------------------------------- servidor
export class ProtocolServer {
  readonly battle: Battle;
  readonly wss: WebSocketServer;
  private readonly ownsWss: boolean;
  private readonly expectedByKey = new Map<string, ExpectedBot>(); // `${botId}:${battleToken}`
  private readonly expectedByBotId = new Map<string, ExpectedBot>();
  private readonly agents = new Map<string, WebSocketBotAgent>(); // vehicleId -> agent
  private readonly states = new Map<WebSocket, ConnectionState>();
  private readonly tickIntervalMs: number;
  private readonly decisionDeadlineMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly catalogVersion: string;
  private readonly handshakeTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private resultResolvers: ((r: BattleResult) => void)[] = [];
  private allConnectedResolvers: (() => void)[] = [];

  constructor(opts: ProtocolServerOptions) {
    this.battle = opts.battle;
    this.catalogVersion = opts.catalogVersion;
    this.tickIntervalMs = opts.tickIntervalMs ?? TICK_DT * 1000;
    this.decisionDeadlineMs = opts.decisionDeadlineMs ?? DECISION_DEADLINE_MS;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 5000;

    for (const e of opts.expected) {
      this.expectedByKey.set(`${e.botId}:${e.battleToken}`, e);
      this.expectedByBotId.set(e.botId, e);
    }

    if (opts.wss) {
      this.wss = opts.wss;
      this.ownsWss = false;
    } else {
      this.wss = new WebSocketServer({ port: opts.port ?? 0 });
      this.ownsWss = true;
    }
    this.wss.on("connection", (ws) => this.handleConnection(ws));
  }

  /** Puerto real en el que escucha (útil cuando se pidió port:0). */
  get port(): number {
    const addr = this.wss.address();
    if (typeof addr === "string" || addr === null) throw new Error("Servidor sin dirección TCP");
    return addr.port;
  }

  private handleConnection(ws: WebSocket): void {
    this.states.set(ws, "awaiting_hello");
    ws.on("message", (raw) => this.handleRawMessage(ws, raw));
    ws.on("close", () => this.handleDisconnect(ws));
    ws.on("error", () => this.handleDisconnect(ws));

    const timer = setTimeout(() => {
      if (this.states.get(ws) !== "awaiting_hello") return;
      sendShutdown(
        ws,
        "invalid_message",
        `No se completó el handshake en ${this.handshakeTimeoutMs} ms (¿HELLO ausente o con forma inválida?)`,
      );
      ws.close();
    }, this.handshakeTimeoutMs);
    this.handshakeTimers.set(ws, timer);
  }

  private handleDisconnect(ws: WebSocket): void {
    this.states.set(ws, "closed");
    const timer = this.handshakeTimers.get(ws);
    if (timer) {
      clearTimeout(timer);
      this.handshakeTimers.delete(ws);
    }
    for (const agent of this.agents.values()) {
      if (agent.ws === ws) agent.disconnect();
    }
  }

  private handleRawMessage(ws: WebSocket, raw: unknown): void {
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return; // JSON inválido: se descarta, se trata como si no hubiera llegado (regla 4).
    }
    if (typeof msg !== "object" || msg === null) return;

    // D5: proto desconocido se rechaza SIN inspeccionar el resto del mensaje.
    if (msg.proto !== "arena/1") {
      sendShutdown(ws, "protocol_version_unsupported", `proto no soportado: ${String(msg.proto)}`);
      ws.close();
      return;
    }

    if (!envelopeValidator()(msg)) return; // forma inválida: se descarta (regla 4).

    const state = this.states.get(ws);
    if (state === "awaiting_hello") {
      if (msg.type === "HELLO") this.handleHello(ws, msg.payload);
      return; // cualquier otro type mientras se espera HELLO: se ignora.
    }
    if (state === "connected" && msg.type === "COMMAND") {
      this.handleCommand(ws, msg.payload);
    }
    // Otros types en estado "connected" (el bot nunca los manda de verdad): ignorados.
  }

  private handleHello(ws: WebSocket, hello: any): void {
    const timer = this.handshakeTimers.get(ws);
    if (timer) {
      clearTimeout(timer);
      this.handshakeTimers.delete(ws);
    }
    const expected = this.expectedByKey.get(`${hello.botId}:${hello.battleToken}`);
    if (!expected) {
      sendShutdown(ws, "handshake_failed", "botId o battleToken desconocidos para esta batalla");
      ws.close();
      return;
    }
    if (expected.suspended) {
      sendShutdown(ws, "suspended", "Este bot está suspendido y no puede participar");
      ws.close();
      return;
    }

    const vehicle = this.battle.getVehicle(expected.vehicleId);
    if (!vehicle) {
      sendShutdown(ws, "handshake_failed", `Vehículo desconocido: ${expected.vehicleId}`);
      ws.close();
      return;
    }

    let agent = this.agents.get(expected.vehicleId);
    if (agent) {
      // Reconexión: mismo bot, socket nuevo. El motor no ha descalificado (si lo
      // hubiera hecho, no reconectamos: se deja actuar al mecanismo existente).
      agent.rebind(ws);
    } else {
      agent = new WebSocketBotAgent(expected.botId, ws, this.decisionDeadlineMs);
      this.agents.set(expected.vehicleId, agent);
      this.battle.attachBot(expected.vehicleId, agent);
    }

    this.states.set(ws, "connected");
    safeSend(ws, envelope("WELCOME", this.buildWelcome(expected)));

    // Señal para whenAllConnected(): todos los bots esperados ya han hecho handshake.
    if (this.agents.size >= this.expectedByBotId.size) {
      for (const resolve of this.allConnectedResolvers.splice(0)) resolve();
    }
  }

  /**
   * Resuelve cuando TODOS los bots esperados han completado el handshake (WELCOME
   * enviado). Permite arrancar el bucle SOLO cuando los agentes están enganchados
   * desde el tick 0 — necesario para la batalla-en-contenedores, donde el
   * orquestador no intercepta cada handshake como sí hacen los tests. Rechaza si no
   * conectan todos dentro de `timeoutMs`.
   */
  whenAllConnected(timeoutMs = 15000): Promise<void> {
    if (this.agents.size >= this.expectedByBotId.size) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `whenAllConnected: solo ${this.agents.size}/${this.expectedByBotId.size} bots conectaron en ${timeoutMs} ms`,
            ),
          ),
        timeoutMs,
      );
      this.allConnectedResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private handleCommand(ws: WebSocket, command: any): void {
    for (const agent of this.agents.values()) {
      if (agent.ws === ws) {
        agent.receiveCommand(command);
        return;
      }
    }
  }

  private buildWelcome(expected: ExpectedBot): unknown {
    const vehicle = this.battle.getVehicle(expected.vehicleId)!;
    const ruleset = this.battle.config.ruleset;
    const map = this.battle.config.map;

    const modules = vehicle.spec.modules.map((m) => {
      const { slot, moduleId, category, ...specs } = m;
      return { slot, moduleId, category, specs };
    });

    const teammates = this.battle
      .getVehicles()
      .filter((v) => v.team === vehicle.team && v.id !== vehicle.id)
      .map((v) => v.id);

    return {
      battleId: this.battle.config.battleId,
      selfId: vehicle.id,
      team: vehicle.team,
      encoding: "json",
      timing: {
        tickHz: TICK_HZ,
        decisionEveryNTicks: DECISION_EVERY_N_TICKS,
        decisionDeadlineMs: this.decisionDeadlineMs,
        maxConsecutiveTimeouts: ruleset.maxConsecutiveTimeouts,
      },
      rules: {
        mode: ruleset.mode,
        rulesetId: ruleset.rulesetId,
        budgetCredits: ruleset.budgetCredits,
        timeLimitTicks: ruleset.timeLimitTicks,
        scoreToWin: ruleset.scoreToWin,
        friendlyFire: ruleset.friendlyFire,
        respawn: ruleset.respawn,
        sharedTeamVision: ruleset.sharedTeamVision,
        radio: {
          maxMessageBytes: RADIO_MAX_MESSAGE_BYTES,
          maxMessagesPerSecond: RADIO_MAX_MESSAGES_PER_SECOND,
          deliveryDelayDecisions: RADIO_DELIVERY_DELAY_DECISIONS,
        },
      },
      vehicle: {
        chassis: { moduleId: vehicle.spec.chassisId, hullHp: vehicle.spec.hullHp, radiusM: vehicle.spec.radiusM },
        modules,
        massKg: vehicle.spec.massKg,
        energy: { capacityEU: vehicle.energyCapacity(), generationEUs: vehicle.energyGeneration() },
      },
      map: {
        mapId: map.mapId,
        mapVersion: map.version,
        checksum: map.checksum,
        widthM: map.widthM,
        heightM: map.heightM,
        // welcome.schema.json solo admite {team, position} — el ArenaMap interno de
        // E2 añade "heading" (y las bases no llevan campos extra tampoco); se recorta.
        spawns: map.spawns.map((s) => ({ team: s.team, position: s.position })),
        bases: map.bases.map((b) => ({ team: b.team, position: b.position })),
      },
      teammates,
      versions: {
        engine: deps.engine.version,
        physics: `${deps.physics.package}@${deps.physics.version}`,
        rules: ruleset.rulesetId,
        catalog: this.catalogVersion,
        protocol: "arena/1",
      },
    };
  }

  // ------------------------------------------------------------------- bucle
  /** Arranca el bucle de batalla, con paso real de tickIntervalMs (fuera de sim/, es legítimo). */
  start(): void {
    const step = () => {
      if (this.battle.isFinished()) {
        this.finish();
        return;
      }
      const t0 = Date.now();
      this.battle.step();
      if (this.battle.isFinished()) {
        this.finish();
        return;
      }
      // Descuenta lo que ha costado ESTE step() real (física + sensores + red) del
      // intervalo, para que tickIntervalMs sea el ritmo real del reloj, no
      // tickIntervalMs + coste de step() acumulándose tick a tick.
      const elapsed = Date.now() - t0;
      this.loopTimer = setTimeout(step, Math.max(0, this.tickIntervalMs - elapsed));
    };
    step();
  }

  private finish(): void {
    const result = this.battle.getResult()!;
    for (const agent of this.agents.values()) {
      const outcome: string = result.disqualified.includes(this.vehicleIdOf(agent))
        ? "disqualified"
        : result.winner === "draw"
          ? "draw"
          : this.teamOf(agent) === result.winner
            ? "win"
            : "loss";
      safeSend(
        agent.ws,
        envelope("SHUTDOWN", {
          reason: "battle_finished",
          result: { outcome, score: result.score, ticks: result.ticks },
          gracePeriodMs: 500,
        }),
      );
    }
    for (const resolve of this.resultResolvers) resolve(result);
    this.resultResolvers = [];
  }

  private vehicleIdOf(agent: WebSocketBotAgent): string {
    for (const [vid, a] of this.agents) if (a === agent) return vid;
    return "";
  }
  private teamOf(agent: WebSocketBotAgent): string {
    return this.battle.getVehicle(this.vehicleIdOf(agent))?.team ?? "";
  }

  /**
   * Replay de ESTA ejecución en vivo (batalla terminada y creada con
   * `recordReplay: true`). Contiene los comandos REALMENTE aplicados por el motor
   * — incluidos los ticks en los que un bot no llegó a tiempo (timeout ⇒ sin
   * comando) — así que `verify()` de replay.ts puede comprobar que la partida en
   * vivo es autoconsistente: re-simulada desde su cabecera reproduce bit a bit
   * sus propios hashes. Reutiliza el ensamblado de record(); no lo duplica.
   */
  getReplay(): Replay {
    const result = this.battle.getResult();
    if (!result) throw new Error("La batalla aún no ha terminado; no hay replay que devolver");
    return replayFromBattle(this.battle, result);
  }

  waitForResult(): Promise<BattleResult> {
    const existing = this.battle.getResult();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => this.resultResolvers.push(resolve));
  }

  stop(): void {
    if (this.loopTimer) clearTimeout(this.loopTimer);
    this.loopTimer = null;
    for (const timer of this.handshakeTimers.values()) clearTimeout(timer);
    this.handshakeTimers.clear();
    for (const ws of this.states.keys()) ws.close();
    if (this.ownsWss) this.wss.close();
  }
}
