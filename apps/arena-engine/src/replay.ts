/**
 * Replays (T2.6). Formato JSONL: una línea por registro, comprimible con zstd por E8.
 *
 * Un replay NO es un vídeo: es la RECETA para volver a cocinar la batalla.
 * Contiene la cabecera (config + semilla + versiones + checksum de mapa) y los comandos
 * recibidos. Los eventos y snapshots se incluyen para que el visor no tenga que
 * re-simular, pero son REDUNDANTES: la verdad es la cabecera + los comandos.
 *
 * De ahí que verify() sea posible: re-simulamos desde la cabecera aplicando los mismos
 * comandos y el resultado debe ser idéntico bit a bit. Si no lo es, o el motor no es
 * determinista, o el replay fue manipulado. Ambas cosas son graves y hay que detectarlas.
 */
import { createHash } from "node:crypto";
import { Battle, type BattleConfig, type BattleResult, type BotAgent } from "./sim/battle.js";
import { nowIso } from "./wall-clock.js";
import deps from "./engine-deps.json" with { type: "json" };
import { RNG_DERIVATION, RNG_STREAM_NAMES } from "./rng.js";
import { canonicalize, diffComponents, hashFromComponents, STATE_HASH_SCHEME, type StateHashComponentV2 } from "./sim/state-hash.js";
import { CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";

/**
 * OLA2-MD · Replay v2 (contrato engine-v2 §13). `formatVersion: 2`; cualquier otra versión
 * se RECHAZA (BACKWARD_COMPATIBILITY_REQUIRED=NO): los replays v1 no se leen ni se verifican.
 *
 * El crudo es INTERNO: receta (cabecera + comandos) e integridad (hashes, checkpoints por
 * componente, resultado). `events`/`snapshots` siguen viajando como flujo DERIVADO del motor
 * (no autoritativo, fuera del hash); el replay PÚBLICO no sale de aquí sino de la proyección
 * (paquete de MA), y este módulo no lo construye ni lo toca.
 */
export const REPLAY_FORMAT_VERSION = 2 as const;
/** Esquema de ids internos de entidades (proj_<seq>/mine_<seq> de un contador único). */
export const REPLAY_ID_SCHEME = "entitySeq/v1";
/** Cadencia por defecto de checkpoints (ticks). */
export const DEFAULT_CHECKPOINT_EVERY_N_TICKS = 300;

/** Etiqueta de runtime del proceso en curso (familia mayor de Node: determina V8). */
export function currentRuntime(): string {
  return `node${String(process.versions.node).split(".")[0]}`;
}

/** Digest de las specs resueltas que consume la simulación (catálogo efectivo de la batalla). */
export function participantsSpecDigest(participants: readonly any[]): string {
  const c = canonicalize(participants.map((p) => ({ id: p.id, botId: p.botId, team: p.team, spec: p.spec })));
  return createHash("sha256").update(JSON.stringify(c), "utf8").digest("hex");
}

export interface ReplayCadences {
  hashEveryNTicks: number;
  snapshotEveryNTicks: number;
  checkpointEveryNTicks: number;
}

export interface ReplayCheckpointRecord {
  tick: number;
  hash: string;
  components: Record<StateHashComponentV2, string>;
}

export interface ReplayHeader {
  formatVersion: 2;
  battleId: string;
  seed: string;
  rulesetId: string;
  ruleset: any;
  map: any;
  participants: any[];
  versions: Record<string, string>;
  /** Runtime con el que se grabó (`node<major>`): un V8 distinto puede cambiar floats. */
  runtime: string;
  /** sha256 del wasm de Rapier con el que se grabó. */
  physicsWasmSha256: string;
  /** Catálogo: versión de temporada + digest de las specs resueltas embebidas. */
  catalog: { version: string; specDigest: string };
  /** Cadencias EFECTIVAS de la batalla original (la re-simulación las reproduce). */
  cadences: ReplayCadences;
  /** Flujos de RNG con nombre y su derivación desde la semilla. */
  rng: { derivation: string; streams: string[] };
  idScheme: string;
  stateHashScheme: string;
  recordedAt: string;
  /**
   * N2 · Config de latencia simulada de la batalla original, si la tuvo. Va en la
   * cabecera (igual que el ruleset o el mapa) porque la re-simulación (verify(),
   * resimulateWithEvents(), checkpoint) tiene que reconstruir EXACTAMENTE la misma
   * BattleConfig: sin este campo, la resimulación correría con la latencia
   * silenciosamente desactivada, el RNG se desincronizaría en el primer ciclo de
   * decisión con comando aceptado, y verify() divergiría desde el tick 0.
   */
  simulatedLatency?: { minCycles: number; maxCycles: number };
}

export interface Replay {
  header: ReplayHeader;
  commands: { tick: number; vehicleId: string; command: any }[];
  events: any[];
  snapshots: any[];
  stateHashes: { tick: number; hash: string }[];
  /** OLA2-MD · checkpoints con desglose por componentes (el último es el estado final). */
  checkpoints: ReplayCheckpointRecord[];
  result: BattleResult;
}

/** Registro JSONL con discriminante `t`; un payload con su propia clave `t` es corrupción. */
function record_(t: string, rec: object): string {
  if (Object.prototype.hasOwnProperty.call(rec, "t")) {
    throw new Error(`Replay: el registro ${t} trae una clave "t" propia; no se serializa con ambigüedad`);
  }
  return JSON.stringify({ t, ...rec });
}

/** Serializa a JSONL: una línea por registro. Compacto, streameable y diffable. */
export function toJsonl(replay: Replay): string {
  const lines: string[] = [];
  lines.push(record_("header", replay.header));
  for (const c of replay.commands) lines.push(record_("cmd", c));
  for (const e of replay.events) lines.push(record_("evt", e));
  for (const s of replay.snapshots) lines.push(record_("snap", s));
  for (const h of replay.stateHashes) lines.push(record_("hash", h));
  for (const k of replay.checkpoints ?? []) lines.push(record_("ckpt", k));
  lines.push(record_("result", replay.result));
  return lines.join("\n") + "\n";
}

/**
 * Lee un replay v2. ESTRICTO: rechaza formatVersion distinta de 2, registros desconocidos,
 * varias cabeceras o resultados, y registros antes de la cabecera.
 */
export function fromJsonl(jsonl: string): Replay {
  const replay: Replay = {
    header: null as any,
    commands: [],
    events: [],
    snapshots: [],
    stateHashes: [],
    checkpoints: [],
    result: null as any,
  };
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    const { t, ...rest } = rec;
    if (t !== "header" && !replay.header) {
      throw new Error(`Replay corrupto: registro ${JSON.stringify(t)} antes de la cabecera`);
    }
    switch (t) {
      case "header":
        if (replay.header) throw new Error("Replay corrupto: más de una cabecera");
        if (rest.formatVersion !== REPLAY_FORMAT_VERSION) {
          throw new Error(
            `format_version_mismatch: replay=${JSON.stringify(rest.formatVersion)}, soportada=${REPLAY_FORMAT_VERSION} (BACKWARD_COMPATIBILITY_REQUIRED=NO: los replays v1 no se leen)`,
          );
        }
        replay.header = rest as ReplayHeader;
        break;
      case "cmd":
        replay.commands.push(rest as any);
        break;
      case "evt":
        replay.events.push(rest);
        break;
      case "snap":
        replay.snapshots.push(rest);
        break;
      case "hash":
        replay.stateHashes.push(rest as any);
        break;
      case "ckpt":
        replay.checkpoints.push(rest as any);
        break;
      case "result":
        if (replay.result) throw new Error("Replay corrupto: más de un resultado");
        replay.result = rest as BattleResult;
        break;
      default:
        throw new Error(`Replay corrupto: registro desconocido t=${JSON.stringify(t)}`);
    }
  }
  if (!replay.header) throw new Error("Replay sin cabecera: archivo corrupto");
  return replay;
}

/**
 * Agente que NO piensa: reproduce los comandos grabados.
 * Es la pieza que permite re-simular un replay sin ejecutar el código del bot original
 * (que puede ser privado, o no estar ya disponible). El motor no distingue este agente
 * de uno real: recibe observaciones y devuelve comandos, igual que cualquier otro.
 */
export class ReplayAgent implements BotAgent {
  private byTick = new Map<number, any>();

  constructor(
    readonly botId: string,
    commands: { tick: number; command: any }[],
  ) {
    for (const c of commands) this.byTick.set(c.tick, c.command);
  }

  decide(obs: any): any | null {
    // Si en ese tick el bot original no envió nada (timeout), devolvemos null:
    // reproducimos también sus fallos, o la re-simulación divergería.
    return this.byTick.get(obs.tick) ?? null;
  }
}

/**
 * Construye el Replay de una batalla YA ejecutada (con `recordReplay: true`).
 * Es la misma lógica que usa record(); se expone por separado para que quien
 * ejecute la batalla por otro camino (p. ej. el bucle en vivo de ProtocolServer)
 * pueda obtener el replay de SU ejecución sin duplicar este ensamblado.
 * Llamar ANTES de b.free().
 */
export function replayFromBattle(b: Battle, result: BattleResult): Replay {
  const config = b.config;
  if (!config.recordReplay) {
    throw new Error("La batalla no se creó con recordReplay: true; no hay comandos grabados");
  }
  return {
    header: buildHeaderV2(config, result.versions),
    commands: (b as any).replayCommands,
    events: b.publicEvents,
    snapshots: b.snapshots,
    stateHashes: b.stateHashes,
    checkpoints: b.checkpoints,
    result,
  };
}

/** Cadencias efectivas de una config (mismo criterio que el bucle de battle.ts). */
export function effectiveCadences(config: BattleConfig): ReplayCadences {
  return {
    hashEveryNTicks: config.hashEveryNTicks ?? config.ruleset.hashEveryNTicks ?? 30,
    snapshotEveryNTicks: config.snapshotEveryNTicks ?? 3,
    checkpointEveryNTicks: config.checkpointEveryNTicks ?? DEFAULT_CHECKPOINT_EVERY_N_TICKS,
  };
}

/** Versiones del motor EN EJECUCIÓN (mismo formato que BattleResult.versions). */
export function runningVersions(rulesetId: string): Record<string, string> {
  return {
    engine: deps.engine.version,
    physics: `${deps.physics.package}@${deps.physics.version}`,
    rules: rulesetId,
    protocol: deps.protocol,
  };
}

/** Cabecera v2 de una config (la comparten replay y checkpoint). */
export function buildHeaderV2(config: BattleConfig, versions: Record<string, string>): ReplayHeader {
  return {
    formatVersion: REPLAY_FORMAT_VERSION,
    battleId: config.battleId,
    seed: config.seed,
    rulesetId: config.ruleset.rulesetId,
    ruleset: config.ruleset,
    map: config.map,
    participants: config.participants,
    versions,
    runtime: currentRuntime(),
    physicsWasmSha256: deps.physics.wasmSha256,
    catalog: { version: CATALOG_VERSION, specDigest: participantsSpecDigest(config.participants) },
    cadences: effectiveCadences(config),
    rng: { derivation: RNG_DERIVATION, streams: [...RNG_STREAM_NAMES] },
    idScheme: REPLAY_ID_SCHEME,
    stateHashScheme: STATE_HASH_SCHEME,
    // Metadato de pared, NO entra en la simulación ni en el hash. Va vía wall-clock.ts,
    // el único fichero exento del lint de determinismo para este uso (ERR-ENG-02).
    recordedAt: nowIso(),
    // N2 · imprescindible para que verify()/resimulateWithEvents() reconstruyan la
    // misma BattleConfig (ver comentario en ReplayHeader).
    simulatedLatency: config.simulatedLatency,
  };
}

/** BattleConfig de re-simulación desde una cabecera v2 (cadencias incluidas: cierra P3-2). */
export function configFromHeader(h: ReplayHeader, recordReplay = false): BattleConfig {
  return {
    battleId: h.battleId,
    seed: h.seed,
    ruleset: h.ruleset,
    map: h.map,
    participants: h.participants,
    recordReplay,
    simulatedLatency: h.simulatedLatency,
    hashEveryNTicks: h.cadences?.hashEveryNTicks,
    snapshotEveryNTicks: h.cadences?.snapshotEveryNTicks,
    checkpointEveryNTicks: h.cadences?.checkpointEveryNTicks,
  };
}

/** Por qué ESTE motor no puede verificar la cabecera (motivo explícito), o null si puede. */
export function headerIncompatibility(h: ReplayHeader): string | null {
  if (!h || h.formatVersion !== REPLAY_FORMAT_VERSION) {
    return `format_version_mismatch: replay=${JSON.stringify(h?.formatVersion)}, soportada=${REPLAY_FORMAT_VERSION}`;
  }
  const cur = runningVersions(h.rulesetId);
  for (const k of ["engine", "physics", "protocol"] as const) {
    if (h.versions?.[k] !== cur[k]) return `${k}_version_mismatch: replay=${h.versions?.[k]}, motor=${cur[k]}`;
  }
  if (h.versions?.rules !== h.rulesetId || h.ruleset?.rulesetId !== h.rulesetId) {
    return `rules_mismatch: versions.rules=${h.versions?.rules}, rulesetId=${h.rulesetId}, ruleset=${h.ruleset?.rulesetId}`;
  }
  if (h.physicsWasmSha256 !== deps.physics.wasmSha256) {
    return `physics_wasm_mismatch: replay=${h.physicsWasmSha256}, motor=${deps.physics.wasmSha256}`;
  }
  if (h.runtime !== currentRuntime()) return `runtime_mismatch: replay=${h.runtime}, motor=${currentRuntime()}`;
  if (h.catalog?.version !== CATALOG_VERSION) {
    return `catalog_version_mismatch: replay=${h.catalog?.version}, motor=${CATALOG_VERSION}`;
  }
  if (h.catalog?.specDigest !== participantsSpecDigest(h.participants ?? [])) {
    return "catalog_digest_mismatch: las specs embebidas no corresponden al digest de la cabecera";
  }
  if (h.stateHashScheme !== STATE_HASH_SCHEME) {
    return `state_hash_scheme_mismatch: replay=${h.stateHashScheme}, motor=${STATE_HASH_SCHEME}`;
  }
  if (h.rng?.derivation !== RNG_DERIVATION || JSON.stringify(h.rng?.streams) !== JSON.stringify(RNG_STREAM_NAMES)) {
    return `rng_scheme_mismatch: replay=${h.rng?.derivation}`;
  }
  if (h.idScheme !== REPLAY_ID_SCHEME) return `id_scheme_mismatch: replay=${h.idScheme}, motor=${REPLAY_ID_SCHEME}`;
  return null;
}

/** Graba una batalla completa. Los agentes son los reales (o stubs). */
export async function record(config: BattleConfig, attach: (b: Battle) => void): Promise<Replay> {
  const b = await Battle.create({ ...config, recordReplay: true });
  attach(b);
  const result = b.run();
  const replay = replayFromBattle(b, result);
  b.free();
  return replay;
}

/**
 * 4v4-STATS · Ganchos OPCIONALES de observación de una re-simulación. Ninguno
 * altera la simulación, el hash ni el protocolo: sólo MIRAN.
 *  - `onObservation(vehicleId, obs)`: la observación que el motor entrega al
 *    `ReplayAgent.decide(obs)` de ese vehículo en cada ciclo de decisión (la
 *    misma que recibió el bot original). Se entrega una COPIA profunda: la
 *    observación real comparte referencias con el estado del motor (p. ej. el
 *    marcador), y un callback que la mutara cambiaría la batalla.
 *  - `onEmission(event, toVehicle)`: cada evento EN EL ORDEN EXACTO en que el
 *    motor lo emite (`toVehicle = null` si es público). `onEvent` entrega los
 *    eventos por vehículo al principio de su siguiente ciclo y pierde el orden
 *    ENTRE vehículos; las estadísticas lo necesitan para atribuir una baja al
 *    autor del golpe que la causó cuando dos atacantes aciertan en el mismo tick.
 *    También se entrega una copia.
 *  - `onKill(kill)` (4v4-FIX): cada baja de un vehículo EXACTAMENTE como la ve el
 *    marcador: se avisa desde la llamada del motor a `mode.onKill(victim,
 *    killerTeam)`, con `killerId` = autor del daño letal (el `ownerId` de
 *    `damageVehicle`: proyectil, explosión o mina) o `null` si la muerte la
 *    causó el entorno (zona de daño). Así las estadísticas no reconstruyen la
 *    causa por el orden de emisión, que confunde un golpe NO letal seguido de la
 *    muerte por ácido en el mismo tick con una baja del autor del golpe.
 */
export interface KillNotice {
  tick: number;
  victimId: string;
  /** Vehículo autor del daño letal; `null` si no hubo autor (zona de daño). */
  killerId: string | null;
  /** Equipo que el motor pasa a `mode.onKill` (el que puntúa); `null` sin autor. */
  killerTeam: string | null;
}

export interface ResimulationHooks {
  onObservation?: (vehicleId: string, observation: any) => void;
  onEmission?: (event: any, toVehicle: string | null) => void;
  onKill?: (kill: KillNotice) => void;
}

/**
 * E8/T8.4 · Re-simula el replay entregando a `onEvent` TODOS los eventos por
 * vehículo (privados incluidos: hit_dealt, rejected_action, decision_timeout…).
 *
 * Existe porque el replay solo persiste los eventos PÚBLICOS (T2.6/D8): las
 * estadísticas por bot (daño, precisión, fallos) necesitan los privados, y la
 * política 23.1 manda calcularlas DESDE EL ARCHIVO, no desde una BD de eventos.
 * Re-simular con los comandos grabados los regenera exactamente (determinismo).
 * Misma mecánica que verify(); vive aquí para no duplicar ReplayAgent fuera.
 *
 * `hooks` (opcional, 4v4-STATS): ver `ResimulationHooks`. Sin ganchos el
 * comportamiento es idéntico al de antes.
 */
export async function resimulateWithEvents(
  replay: Replay,
  onEvent: (vehicleId: string, event: any) => void,
  hooks: ResimulationHooks = {},
): Promise<BattleResult> {
  // OLA2-MD · misma BattleConfig que la original (latencia y cadencias incluidas).
  const b = await Battle.create(configFromHeader(replay.header));
  const byVehicle = new Map<string, { tick: number; command: any }[]>();
  for (const c of replay.commands) {
    if (!byVehicle.has(c.vehicleId)) byVehicle.set(c.vehicleId, []);
    byVehicle.get(c.vehicleId)!.push({ tick: c.tick, command: c.command });
  }
  const { onObservation, onEmission, onKill } = hooks;
  if (onKill) {
    // Envolturas TRANSPARENTES (sólo miran): `damageVehicle` fija quién es el autor
    // del daño en curso y `mode.onKill` avisa con él. Fuera de `damageVehicle`
    // (zona de daño) no hay autor. Si el motor renombra algo, falla en voz alta.
    const target = b as unknown as {
      damageVehicle: (...args: any[]) => void;
      mode: { onKill?: (victim: any, killerTeam: string | null, ctx: any) => void };
      tick: number;
    };
    if (typeof target.damageVehicle !== "function" || !target.mode) {
      throw new Error("resimulateWithEvents: el motor ya no expone damageVehicle()/mode; onKill no es fiable");
    }
    const mode = target.mode;
    let currentOwner: string | null = null;
    const damage = target.damageVehicle.bind(b);
    target.damageVehicle = (...args: any[]) => {
      const outer = currentOwner;
      currentOwner = String(args[4]); // ownerId
      try {
        damage(...args);
      } finally {
        currentOwner = outer;
      }
    };
    // Un modo sin onKill (no puntúa bajas) recibe uno que sólo avisa: el motor lo
    // llama con `?.` y no cambia nada de la simulación.
    const original = typeof mode.onKill === "function" ? mode.onKill.bind(mode) : () => {};
    mode.onKill = (victim: any, killerTeam: string | null, ctx: any) => {
      original(victim, killerTeam, ctx);
      onKill({
        tick: target.tick,
        victimId: String(victim.id),
        killerId: killerTeam === null ? null : currentOwner,
        killerTeam,
      });
    };
  }
  if (onEmission) {
    // Envoltura TRANSPARENTE del emisor del motor: llama al original con los
    // mismos argumentos y después avisa. `emit` es privado de Battle (T-ENGINE):
    // si cambia de nombre, esto falla en voz alta en vez de contar a medias.
    const target = b as unknown as { emit: (ev: any, toVehicle?: string) => void; tick: number };
    if (typeof target.emit !== "function") {
      throw new Error("resimulateWithEvents: el motor ya no expone emit(); onEmission no es fiable");
    }
    const original = target.emit.bind(b);
    target.emit = (ev: any, toVehicle?: string) => {
      original(ev, toVehicle);
      onEmission(structuredClone({ tick: target.tick, ...ev }), toVehicle ?? null);
    };
  }
  for (const p of replay.header.participants) {
    const agent = new ReplayAgent(p.botId, byVehicle.get(p.id) ?? []) as ReplayAgent & {
      onEvent?: (e: any) => void;
    };
    agent.onEvent = (e: any) => onEvent(p.id, e);
    if (onObservation) {
      const decide = agent.decide.bind(agent);
      // La orden se resuelve ANTES de avisar y sobre la observación original:
      // el callback recibe una copia y no puede influir en lo que se reproduce.
      agent.decide = (obs: any) => {
        const cmd = decide(obs);
        onObservation(p.id, structuredClone(obs));
        return cmd;
      };
    }
    b.attachBot(p.id, agent);
  }
  const result = b.run();
  // Drenar la cola de eventos no entregados: el motor entrega los eventos de un bot
  // al PRINCIPIO de su siguiente ciclo de decisión, así que los del último ciclo
  // (p. ej. el vigésimo decision_timeout que descalifica, o los del tick final)
  // quedarían sin contar. Para estadísticas eso sería mentir por poco.
  const pending = (b as unknown as { pendingEvents: Map<string, any[]> }).pendingEvents;
  for (const p of replay.header.participants) {
    for (const e of pending.get(p.id) ?? []) onEvent(p.id, e);
  }
  b.free();
  return result;
}

/** OLA2-MD · Discrepancia concreta de verify() v2: campo, valor oficial y recomputado. */
export interface VerifyMismatch {
  field:
    | "battleId"
    | "winner"
    | "endReason"
    | "score"
    | "disqualified"
    | "ticks"
    | "versions"
    | "finalStateHash"
    | "stateHashes"
    | "checkpoints";
  official: unknown;
  recomputed: unknown;
}

export interface VerifyResult {
  /** true SÓLO si coinciden hashes intermedios, checkpoints, hash final y el RESULTADO completo. */
  matches: boolean;
  /**
   * Motivo explícito por el que ESTE motor se niega a verificar (formato, versión de motor,
   * física, runtime, catálogo, esquemas). Si no es null no se re-simula y `matches` es false.
   */
  rejected: string | null;
  officialHash: string;
  recomputedHash: string | null;
  /** Primer TICK (nunca un índice) en el que divergen los hashes intermedios, o null. */
  divergedAtTick: number | null;
  /** Primer checkpoint divergente y sus componentes distintos (orden canónico). */
  divergedCheckpointTick: number | null;
  divergedComponents: StateHashComponentV2[];
  /** Todas las discrepancias encontradas (vacío si matches). */
  mismatches: VerifyMismatch[];
  officialResult: BattleResult;
  recomputedResult: BattleResult | null;
}

/** Todo lo que una re-simulación produce, capturado ANTES de `b.free()`. */
interface Resimulation {
  result: BattleResult;
  stateHashes: { tick: number; hash: string }[];
  checkpoints: ReplayCheckpointRecord[];
  events: any[];
  snapshots: any[];
}

/** Re-simula un replay reproduciendo sus comandos grabados (una sola vez, varias lecturas). */
async function resimulateReplay(replay: Replay): Promise<Resimulation> {
  const b = await Battle.create(configFromHeader(replay.header));
  const byVehicle = new Map<string, { tick: number; command: any }[]>();
  for (const c of replay.commands) {
    if (!byVehicle.has(c.vehicleId)) byVehicle.set(c.vehicleId, []);
    byVehicle.get(c.vehicleId)!.push({ tick: c.tick, command: c.command });
  }
  for (const p of replay.header.participants) {
    b.attachBot(p.id, new ReplayAgent(p.botId, byVehicle.get(p.id) ?? []));
  }
  try {
    const result = b.run();
    return {
      result,
      stateHashes: b.stateHashes,
      checkpoints: b.checkpoints,
      events: b.publicEvents,
      snapshots: b.snapshots,
    };
  } finally {
    b.free();
  }
}

/**
 * Primer TICK en el que divergen dos series de hashes intermedios, o null si son idénticas.
 * Con longitudes distintas devuelve el tick de la primera entrada que sobra o falta (P3-1:
 * antes devolvía un ÍNDICE).
 */
export function compareStateHashes(
  official: { tick: number; hash: string }[],
  recomputed: { tick: number; hash: string }[],
): number | null {
  const n = Math.min(official.length, recomputed.length);
  for (let i = 0; i < n; i++) {
    if (official[i].tick !== recomputed[i].tick || official[i].hash !== recomputed[i].hash) {
      return Math.min(official[i].tick, recomputed[i].tick);
    }
  }
  if (official.length !== recomputed.length) {
    const extra = official.length > n ? official[n] : recomputed[n];
    return extra.tick;
  }
  return null;
}

function canon(v: unknown): string {
  return JSON.stringify(canonicalize(v ?? null));
}

/** Compara el RESULTADO deportivo y técnico completo (verify v2). */
export function compareResults(official: BattleResult, recomputed: BattleResult): VerifyMismatch[] {
  const out: VerifyMismatch[] = [];
  const cmp = (field: VerifyMismatch["field"], a: unknown, b: unknown, eq: (x: unknown, y: unknown) => boolean) => {
    if (!eq(a, b)) out.push({ field, official: a, recomputed: b });
  };
  const strict = (x: unknown, y: unknown) => x === y;
  cmp("battleId", official?.battleId, recomputed.battleId, strict);
  cmp("winner", official?.winner ?? null, recomputed.winner ?? null, strict);
  cmp("endReason", official?.endReason ?? null, recomputed.endReason ?? null, strict);
  cmp("ticks", official?.ticks, recomputed.ticks, strict);
  cmp("score", official?.score, recomputed.score, (x, y) => canon(x) === canon(y));
  // El orden de `disqualified` es el de this.vehicles (estable): se compara tal cual.
  cmp("disqualified", official?.disqualified, recomputed.disqualified, (x, y) => JSON.stringify(x) === JSON.stringify(y));
  cmp("versions", official?.versions, recomputed.versions, (x, y) => canon(x) === canon(y));
  cmp("finalStateHash", official?.finalStateHash, recomputed.finalStateHash, strict);
  return out;
}

/** Compara checkpoints: mismo conjunto de ticks y mismos hashes; devuelve el primero distinto. */
function compareCheckpoints(
  official: ReplayCheckpointRecord[],
  recomputed: ReplayCheckpointRecord[],
): { tick: number | null; components: StateHashComponentV2[]; mismatch: VerifyMismatch | null } {
  const byTick = new Map(recomputed.map((c) => [c.tick, c]));
  for (const o of official) {
    const r = byTick.get(o.tick);
    if (!r) {
      return { tick: o.tick, components: [], mismatch: { field: "checkpoints", official: o.tick, recomputed: null } };
    }
    // Un checkpoint oficial cuyo desglose no produce su propio hash está adulterado,
    // aunque el hash coincida con el recomputado (review MD P2).
    if (hashFromComponents(o.components) !== o.hash) {
      return {
        tick: o.tick,
        components: diffComponents(o.components ?? {}, r.components),
        mismatch: { field: "checkpoints", official: o.hash, recomputed: hashFromComponents(o.components) },
      };
    }
    if (r.hash !== o.hash) {
      return {
        tick: o.tick,
        components: diffComponents(o.components ?? {}, r.components),
        mismatch: { field: "checkpoints", official: o.hash, recomputed: r.hash },
      };
    }
  }
  if (official.length !== recomputed.length) {
    return {
      tick: null,
      components: [],
      mismatch: { field: "checkpoints", official: official.map((c) => c.tick), recomputed: recomputed.map((c) => c.tick) },
    };
  }
  return { tick: null, components: [], mismatch: null };
}

function judge(replay: Replay, resim: Resimulation): VerifyResult {
  const mismatches: VerifyMismatch[] = [];
  const divergedAtTick = compareStateHashes(replay.stateHashes ?? [], resim.stateHashes);
  if (divergedAtTick !== null) {
    mismatches.push({ field: "stateHashes", official: replay.stateHashes?.length ?? 0, recomputed: resim.stateHashes.length });
  }
  const official = replay.checkpoints ?? [];
  const ck = compareCheckpoints(official, resim.checkpoints);
  if (ck.mismatch) mismatches.push(ck.mismatch);
  // El checkpoint final del replay ES el estado final: debe cuadrar con el resultado.
  const lastOfficial = official[official.length - 1];
  if (!lastOfficial || lastOfficial.hash !== replay.result?.finalStateHash) {
    mismatches.push({ field: "checkpoints", official: lastOfficial?.hash ?? null, recomputed: replay.result?.finalStateHash });
  }
  mismatches.push(...compareResults(replay.result, resim.result));
  return {
    matches: mismatches.length === 0,
    rejected: null,
    officialHash: replay.result?.finalStateHash,
    recomputedHash: resim.result.finalStateHash,
    divergedAtTick,
    divergedCheckpointTick: ck.tick,
    divergedComponents: ck.components,
    mismatches,
    officialResult: replay.result,
    recomputedResult: resim.result,
  };
}

function rejectedResult(replay: Replay, reason: string): VerifyResult {
  return {
    matches: false,
    rejected: reason,
    officialHash: replay.result?.finalStateHash,
    recomputedHash: null,
    divergedAtTick: null,
    divergedCheckpointTick: null,
    divergedComponents: [],
    mismatches: [],
    officialResult: replay.result,
    recomputedResult: null,
  };
}

/**
 * verify() v2. Re-simula el replay y exige que coincidan:
 *   - los hashes intermedios (tick a tick de su cadencia) y todos los checkpoints por
 *     componente (si divergen, `divergedComponents` dice QUÉ parte del estado);
 *   - el hash final, y el último checkpoint con el hash final;
 *   - el RESULTADO completo: winner, endReason, score, disqualified, ticks, versions y
 *     battleId (antes un `winner` falsificado con el mismo hash pasaba: P2-1 de la OLA 1).
 * Antes de re-simular, rechaza con motivo explícito si cambian formato, motor, física,
 * runtime, catálogo o esquemas (`rejected`).
 *
 * Sigue sin cubrir `events`/`snapshots` (flujo derivado): quien vaya a redistribuirlos usa
 * `verifyAndRecompute()` y los sustituye por los recomputados.
 */
export async function verify(replay: Replay): Promise<VerifyResult> {
  const reason = headerIncompatibility(replay.header);
  if (reason) return rejectedResult(replay, reason);
  return judge(replay, await resimulateReplay(replay));
}

export interface VerifyAndRecomputeResult {
  verification: VerifyResult;
  /** SIEMPRE derivados de la re-simulación (null si se rechazó sin re-simular). */
  recomputed: {
    events: any[];
    snapshots: any[];
    stateHashes: { tick: number; hash: string }[];
    checkpoints: ReplayCheckpointRecord[];
    result: BattleResult;
  } | null;
}

/** Como `verify()`, pero además devuelve el flujo derivado RECOMPUTADO (nunca el recibido). */
export async function verifyAndRecompute(replay: Replay): Promise<VerifyAndRecomputeResult> {
  const reason = headerIncompatibility(replay.header);
  if (reason) return { verification: rejectedResult(replay, reason), recomputed: null };
  const resim = await resimulateReplay(replay);
  return {
    verification: judge(replay, resim),
    recomputed: {
      events: resim.events,
      snapshots: resim.snapshots,
      stateHashes: resim.stateHashes,
      checkpoints: resim.checkpoints,
      result: resim.result,
    },
  };
}
