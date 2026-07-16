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
import { Battle, type BattleConfig, type BattleResult, type BotAgent } from "./sim/battle.js";

export interface ReplayHeader {
  formatVersion: 1;
  battleId: string;
  seed: string;
  rulesetId: string;
  ruleset: any;
  map: any;
  participants: any[];
  versions: Record<string, string>;
  recordedAt: string;
}

export interface Replay {
  header: ReplayHeader;
  commands: { tick: number; vehicleId: string; command: any }[];
  events: any[];
  snapshots: any[];
  stateHashes: { tick: number; hash: string }[];
  result: BattleResult;
}

/** Serializa a JSONL: una línea por registro. Compacto, streameable y diffable. */
export function toJsonl(replay: Replay): string {
  const lines: string[] = [];
  lines.push(JSON.stringify({ t: "header", ...replay.header }));
  for (const c of replay.commands) lines.push(JSON.stringify({ t: "cmd", ...c }));
  for (const e of replay.events) lines.push(JSON.stringify({ t: "evt", ...e }));
  for (const s of replay.snapshots) lines.push(JSON.stringify({ t: "snap", ...s }));
  for (const h of replay.stateHashes) lines.push(JSON.stringify({ t: "hash", ...h }));
  lines.push(JSON.stringify({ t: "result", ...replay.result }));
  return lines.join("\n") + "\n";
}

export function fromJsonl(jsonl: string): Replay {
  const replay: Replay = {
    header: null as any,
    commands: [],
    events: [],
    snapshots: [],
    stateHashes: [],
    result: null as any,
  };
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    const { t, ...rest } = rec;
    switch (t) {
      case "header": replay.header = rest as ReplayHeader; break;
      case "cmd": replay.commands.push(rest as any); break;
      case "evt": replay.events.push(rest); break;
      case "snap": replay.snapshots.push(rest); break;
      case "hash": replay.stateHashes.push(rest as any); break;
      case "result": replay.result = rest as BattleResult; break;
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
class ReplayAgent implements BotAgent {
  private byTick = new Map<number, any>();

  constructor(readonly botId: string, commands: { tick: number; command: any }[]) {
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
    header: {
      formatVersion: 1,
      battleId: config.battleId,
      seed: config.seed,
      rulesetId: config.ruleset.rulesetId,
      ruleset: config.ruleset,
      map: config.map,
      participants: config.participants,
      versions: result.versions,
      recordedAt: new Date().toISOString(),
    },
    commands: (b as any).replayCommands,
    events: b.publicEvents,
    snapshots: b.snapshots,
    stateHashes: b.stateHashes,
    result,
  };
}

/** Graba una batalla completa. Los agentes son los reales (o stubs). */
export async function record(
  config: BattleConfig,
  attach: (b: Battle) => void,
): Promise<Replay> {
  const b = await Battle.create({ ...config, recordReplay: true });
  attach(b);
  const result = b.run();
  const replay = replayFromBattle(b, result);
  b.free();
  return replay;
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
 */
export async function resimulateWithEvents(
  replay: Replay,
  onEvent: (vehicleId: string, event: any) => void,
): Promise<BattleResult> {
  const b = await Battle.create({
    battleId: replay.header.battleId,
    seed: replay.header.seed,
    ruleset: replay.header.ruleset,
    map: replay.header.map,
    participants: replay.header.participants,
    recordReplay: false,
  });
  const byVehicle = new Map<string, { tick: number; command: any }[]>();
  for (const c of replay.commands) {
    if (!byVehicle.has(c.vehicleId)) byVehicle.set(c.vehicleId, []);
    byVehicle.get(c.vehicleId)!.push({ tick: c.tick, command: c.command });
  }
  for (const p of replay.header.participants) {
    const agent = new ReplayAgent(p.botId, byVehicle.get(p.id) ?? []) as ReplayAgent & {
      onEvent?: (e: any) => void;
    };
    agent.onEvent = (e: any) => onEvent(p.id, e);
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

export interface VerifyResult {
  matches: boolean;
  officialHash: string;
  recomputedHash: string;
  divergedAtTick: number | null;
  officialResult: BattleResult;
  recomputedResult: BattleResult;
}

/**
 * Re-simula el replay y compara con el resultado oficial.
 *
 * Comprueba los hashes INTERMEDIOS, no solo el final: si dos batallas divergen en el
 * tick 500 y vuelven a converger por casualidad en el final, un test que solo mirara
 * el hash final daría un falso "correcto". Aquí se detecta el tick exacto.
 */
export async function verify(replay: Replay): Promise<VerifyResult> {
  const config: BattleConfig = {
    battleId: replay.header.battleId,
    seed: replay.header.seed,
    ruleset: replay.header.ruleset,
    map: replay.header.map,
    participants: replay.header.participants,
    recordReplay: false,
  };

  const b = await Battle.create(config);

  // Cada vehículo recibe un agente que reproduce sus comandos grabados.
  const byVehicle = new Map<string, { tick: number; command: any }[]>();
  for (const c of replay.commands) {
    if (!byVehicle.has(c.vehicleId)) byVehicle.set(c.vehicleId, []);
    byVehicle.get(c.vehicleId)!.push({ tick: c.tick, command: c.command });
  }
  for (const p of replay.header.participants) {
    b.attachBot(p.id, new ReplayAgent(p.botId, byVehicle.get(p.id) ?? []));
  }

  const recomputedResult = b.run();
  const recomputed = b.stateHashes;
  b.free();

  // Primer tick en el que los hashes intermedios difieren.
  let divergedAtTick: number | null = null;
  const official = replay.stateHashes;
  for (let i = 0; i < Math.min(official.length, recomputed.length); i++) {
    if (official[i].hash !== recomputed[i].hash) {
      divergedAtTick = official[i].tick;
      break;
    }
  }
  if (divergedAtTick === null && official.length !== recomputed.length) {
    divergedAtTick = Math.min(official.length, recomputed.length);
  }

  const matches =
    divergedAtTick === null &&
    recomputedResult.finalStateHash === replay.result.finalStateHash;

  return {
    matches,
    officialHash: replay.result.finalStateHash,
    recomputedHash: recomputedResult.finalStateHash,
    divergedAtTick,
    officialResult: replay.result,
    recomputedResult,
  };
}
