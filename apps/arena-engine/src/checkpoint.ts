/**
 * R13.5 · Save/restore de batalla — CHECKPOINT POR RESIMULACIÓN. OLA2-MD · formato v2.
 *
 * Un checkpoint NO serializa el estado del mundo físico: es la receta para volver
 * a él. Igual que un replay es "cabecera + comandos" (replay.ts), un checkpoint es
 * "cabecera v2 + comandos hasta el tick N + el hash de estado observado en N, con su
 * desglose por componentes". Restaurar = re-simular determinísticamente hasta N y
 * VERIFICAR que el hash coincide bit a bit; si no coincide, error explícito con los
 * COMPONENTES que divergen — jamás continuar en silencio.
 *
 * Contrato del índice N (fijado en el DESIGN-GATE, docs/R13_5_SAVE_SHARDING.md):
 * N es `battle.tick` en el momento del save — el estado TRAS ejecutar los ticks
 * 0..N-1. Los comandos grabados son estrictamente los de tick < N.
 *
 * Además (v2) se puede reanudar desde un checkpoint GRABADO EN UN REPLAY
 * (`restoreFromReplayCheckpoint`): el replay v2 lleva checkpoints cada
 * `cadences.checkpointEveryNTicks`, tomados en el paso 8 del tick T.
 *
 * OJO: la resimulación itera `step()` a mano, NUNCA `run(N)`: `run()` remata la
 * batalla con finish("draw") al agotar maxTicks, y una batalla restaurada tiene
 * que quedar VIVA para continuar.
 *
 * La garantía de bit-exactitud cubre el estado del MOTOR en el tick N. No cubre la
 * continuidad de memoria de bots externos stateful tras la reanudación (su estado
 * vive en su proceso, no aquí); ese límite está documentado en el diseño.
 */
import { Battle, type BotAgent } from "./sim/battle.js";
import {
  ReplayAgent,
  REPLAY_FORMAT_VERSION,
  buildHeaderV2,
  configFromHeader,
  headerIncompatibility,
  runningVersions,
  type Replay,
  type ReplayHeader,
} from "./replay.js";
import { diffComponents, type StateHashComponentV2 } from "./sim/state-hash.js";

export const CHECKPOINT_FORMAT_VERSION = 2 as const;

export interface BattleCheckpoint {
  formatVersion: 2;
  header: ReplayHeader;
  /** Tick del checkpoint: estado tras ejecutar los ticks 0..tick-1. */
  tick: number;
  /** Comandos grabados con tick < N. Reproducirlos desde cero llega exactamente a N. */
  commands: { tick: number; vehicleId: string; command: any }[];
  /** stateHash() canónico observado en N. El restore DEBE reproducirlo o fallar. */
  stateHash: string;
  /** Desglose por componentes del hash en N (diagnóstico de la divergencia). */
  components: Record<StateHashComponentV2, string>;
}

/**
 * Captura un checkpoint de una batalla VIVA creada con `recordReplay: true`.
 * No muta la batalla: solo lee su estado y copia los comandos grabados.
 */
export function saveCheckpoint(b: Battle): BattleCheckpoint {
  if (!b.config.recordReplay) {
    throw new Error("saveCheckpoint: la batalla no se creó con recordReplay: true; no hay comandos grabados");
  }
  if (b.isFinished()) {
    throw new Error(
      "saveCheckpoint: la batalla ya terminó; reanudar una batalla terminada no tiene sentido (usa el replay)",
    );
  }
  const tick = b.tick;
  // Copia profunda: el checkpoint debe quedar congelado aunque la batalla siga
  // ejecutándose y empujando más comandos al mismo array.
  const commands = structuredClone(b.replayCommands.filter((c) => c.tick < tick));
  const bd = b.stateHashBreakdown();
  return {
    formatVersion: CHECKPOINT_FORMAT_VERSION,
    header: structuredClone(buildHeaderV2(b.config, runningVersions(b.config.ruleset.rulesetId))),
    tick,
    commands,
    stateHash: bd.hash,
    components: bd.components,
  };
}

function agentsCheck(participants: any[], agents: Record<string, BotAgent>, who: string): void {
  const ids = new Set(participants.map((p: any) => p.id));
  for (const id of Object.keys(agents)) {
    if (!ids.has(id)) throw new Error(`${who}: agente para vehículo desconocido: ${id}`);
  }
  const missing = [...ids].filter((id) => !(id in agents));
  if (missing.length > 0) throw new Error(`${who}: faltan agentes para: ${missing.join(", ")}`);
}

function attachReplayAgents(
  b: Battle,
  participants: any[],
  commands: { tick: number; vehicleId: string; command: any }[],
) {
  const byVehicle = new Map<string, { tick: number; command: any }[]>();
  for (const c of commands) {
    if (!byVehicle.has(c.vehicleId)) byVehicle.set(c.vehicleId, []);
    byVehicle.get(c.vehicleId)!.push({ tick: c.tick, command: c.command });
  }
  for (const p of participants) b.attachBot(p.id, new ReplayAgent(p.botId, byVehicle.get(p.id) ?? []));
}

/**
 * Restaura un checkpoint: re-simula hasta N con los comandos grabados, verifica el
 * hash canónico y acopla los agentes reales. Devuelve una Battle VIVA lista para
 * step()/run(). Exige un agente por participante (para dejar uno "mudo" a propósito,
 * pásalo explícito, p. ej. un DeadBot): reanudar con huecos silenciosos sería un
 * error de operación, no una opción por defecto.
 */
export async function restoreCheckpoint(ckpt: BattleCheckpoint, agents: Record<string, BotAgent>): Promise<Battle> {
  if (ckpt.formatVersion !== CHECKPOINT_FORMAT_VERSION) {
    throw new Error(
      `restoreCheckpoint: formatVersion desconocida: ${JSON.stringify(ckpt.formatVersion)} (soportada: ${CHECKPOINT_FORMAT_VERSION})`,
    );
  }
  // Mismo criterio de compatibilidad que verify(): formato, motor, física, runtime,
  // catálogo y esquemas. Rechazo estricto con motivo explícito, sin modo tolerante.
  const why = headerIncompatibility(ckpt.header);
  if (why) throw new Error(`restoreCheckpoint: incompatible: ${why}`);
  agentsCheck(ckpt.header.participants, agents, "restoreCheckpoint");
  for (const c of ckpt.commands) {
    if (c.tick >= ckpt.tick) {
      throw new Error(
        `restoreCheckpoint: checkpoint corrupto: comando en tick ${c.tick} ≥ tick del checkpoint ${ckpt.tick}`,
      );
    }
  }

  // recordReplay: true — la batalla restaurada re-graba los comandos resimulados y
  // sigue grabando la continuación: se puede volver a checkpointear o emitir replay.
  const b = await Battle.create(configFromHeader(ckpt.header, true));
  try {
    attachReplayAgents(b, ckpt.header.participants, ckpt.commands);
    while (!b.isFinished() && b.tick < ckpt.tick) b.step();

    if (b.isFinished() || b.tick !== ckpt.tick) {
      throw new Error(
        `restoreCheckpoint: la resimulación no alcanzó el tick ${ckpt.tick} ` +
          `(terminó=${b.isFinished()} en el tick ${b.tick}): checkpoint corrupto o motor incompatible`,
      );
    }
    const bd = b.stateHashBreakdown();
    if (bd.hash !== ckpt.stateHash) {
      const comps = diffComponents(ckpt.components ?? {}, bd.components);
      throw new Error(
        `restoreCheckpoint: divergencia de estado en el tick ${ckpt.tick}: ` +
          `hash guardado ${ckpt.stateHash} ≠ recalculado ${bd.hash} (componentes: ${comps.join(",") || "?"}). ` +
          `El checkpoint fue manipulado o el motor no reproduce la ejecución original; NO se continúa`,
      );
    }

    // Verificado bit a bit: fuera los ReplayAgent, dentro los agentes reales.
    for (const p of ckpt.header.participants) b.attachBot(p.id, agents[p.id]);
    return b;
  } catch (err) {
    b.free();
    throw err;
  }
}

/**
 * OLA2-MD · Reanuda desde el checkpoint de un REPLAY v2 grabado en el tick T (paso 8 del
 * tick T). Re-simula con los comandos de tick ≤ T hasta que la batalla registra su propio
 * checkpoint en T, exige el mismo hash (si no, lista los componentes que divergen) y acopla
 * los agentes reales. La batalla queda VIVA en el tick T+1.
 */
export async function restoreFromReplayCheckpoint(
  replay: Replay,
  tick: number,
  agents: Record<string, BotAgent>,
): Promise<Battle> {
  const why = headerIncompatibility(replay.header);
  if (why) throw new Error(`restoreFromReplayCheckpoint: incompatible: ${why}`);
  const rec = (replay.checkpoints ?? []).find((c) => c.tick === tick);
  if (!rec) throw new Error(`restoreFromReplayCheckpoint: el replay no tiene checkpoint en el tick ${tick}`);
  if (rec.tick === replay.result?.ticks && rec.hash === replay.result?.finalStateHash) {
    throw new Error("restoreFromReplayCheckpoint: es el checkpoint FINAL; una batalla terminada no se reanuda");
  }
  agentsCheck(replay.header.participants, agents, "restoreFromReplayCheckpoint");
  const b = await Battle.create(configFromHeader(replay.header, true));
  try {
    attachReplayAgents(
      b,
      replay.header.participants,
      replay.commands.filter((c) => c.tick <= tick),
    );
    const mine = () => b.checkpoints.find((c) => c.tick === tick);
    while (!b.isFinished() && !mine() && b.tick <= tick) b.step();
    const got = mine();
    if (!got || b.isFinished()) {
      throw new Error(`restoreFromReplayCheckpoint: la resimulación no alcanzó el checkpoint ${tick} viva`);
    }
    if (got.hash !== rec.hash) {
      throw new Error(
        `restoreFromReplayCheckpoint: divergencia en el tick ${tick} (componentes: ` +
          `${diffComponents(rec.components ?? {}, got.components).join(",") || "?"}); NO se continúa`,
      );
    }
    for (const p of replay.header.participants) b.attachBot(p.id, agents[p.id]);
    return b;
  } catch (err) {
    b.free();
    throw err;
  }
}

/**
 * Serialización JSONL, mismo formato de línea que replay.ts (una línea por registro,
 * campo `t`): `ckpt` (metadatos) + `header` + `cmd`*. Sin contenedor binario nuevo.
 */
export function checkpointToJsonl(ckpt: BattleCheckpoint): string {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      t: "ckpt",
      formatVersion: ckpt.formatVersion,
      tick: ckpt.tick,
      stateHash: ckpt.stateHash,
      components: ckpt.components,
    }),
  );
  lines.push(JSON.stringify({ t: "header", ...ckpt.header }));
  for (const c of ckpt.commands) lines.push(JSON.stringify({ t: "cmd", ...c }));
  return lines.join("\n") + "\n";
}

export function checkpointFromJsonl(jsonl: string): BattleCheckpoint {
  let meta: { formatVersion: 2; tick: number; stateHash: string; components: any } | null = null;
  let header: ReplayHeader | null = null;
  const commands: BattleCheckpoint["commands"] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    const { t, ...rest } = rec;
    switch (t) {
      case "ckpt":
        if (meta) throw new Error("Checkpoint corrupto: más de un registro ckpt");
        meta = rest as any;
        break;
      case "header":
        if (header) throw new Error("Checkpoint corrupto: más de una cabecera");
        header = rest as ReplayHeader;
        break;
      case "cmd":
        commands.push(rest as any);
        break;
      default:
        // Estricto a propósito: un registro desconocido en un checkpoint es corrupción,
        // no una extensión a ignorar (aquí hay que REANUDAR).
        throw new Error(`Checkpoint corrupto: registro desconocido t=${JSON.stringify(t)}`);
    }
  }
  if (!meta) throw new Error("Checkpoint sin registro ckpt: archivo corrupto");
  if (!header) throw new Error("Checkpoint sin cabecera: archivo corrupto");
  if (header.formatVersion !== REPLAY_FORMAT_VERSION) {
    throw new Error(`Checkpoint: cabecera con formatVersion ${JSON.stringify(header.formatVersion)} (soportada: 2)`);
  }
  return {
    formatVersion: meta.formatVersion,
    header,
    tick: meta.tick,
    stateHash: meta.stateHash,
    components: meta.components,
    commands,
  };
}
