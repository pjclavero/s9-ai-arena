/**
 * R13.5 · Save/restore de batalla — slice 1: CHECKPOINT POR RESIMULACIÓN.
 *
 * Un checkpoint NO serializa el estado del mundo físico: es la receta para volver
 * a él. Igual que un replay es "cabecera + comandos" (replay.ts), un checkpoint es
 * "cabecera + comandos hasta el tick N + el hash de estado observado en N".
 * Restaurar = re-simular determinísticamente hasta N y VERIFICAR que el hash
 * coincide bit a bit; si no coincide, error explícito — jamás continuar en silencio.
 *
 * Contrato del índice N (fijado en el DESIGN-GATE, docs/R13_5_SAVE_SHARDING.md):
 * N es `battle.tick` en el momento del save — el estado TRAS ejecutar los ticks
 * 0..N-1. Los comandos grabados son estrictamente los de tick < N.
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
import { ReplayAgent, type ReplayHeader } from "./replay.js";
import deps from "./engine-deps.json" with { type: "json" };
import { nowIso } from "./wall-clock.js";

export interface BattleCheckpoint {
  formatVersion: 1;
  header: ReplayHeader;
  /** Tick del checkpoint: estado tras ejecutar los ticks 0..tick-1. */
  tick: number;
  /** Comandos grabados con tick < N. Reproducirlos desde cero llega exactamente a N. */
  commands: { tick: number; vehicleId: string; command: any }[];
  /** stateHash() canónico observado en N. El restore DEBE reproducirlo o fallar. */
  stateHash: string;
}

/** Versiones del motor en ejecución, en el mismo formato que BattleResult.versions. */
function runtimeVersions(rulesetId: string): Record<string, string> {
  return {
    engine: deps.engine.version,
    physics: `${deps.physics.package}@${deps.physics.version}`,
    rules: rulesetId,
    protocol: deps.protocol,
  };
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
  return {
    formatVersion: 1,
    header: {
      formatVersion: 1,
      battleId: b.config.battleId,
      seed: b.config.seed,
      rulesetId: b.config.ruleset.rulesetId,
      ruleset: structuredClone(b.config.ruleset),
      map: structuredClone(b.config.map),
      participants: structuredClone(b.config.participants),
      versions: runtimeVersions(b.config.ruleset.rulesetId),
      // Metadato de pared, NO entra en la simulación ni en el hash (vía wall-clock.ts,
      // única fuente sancionada, ERR-ENG-02).
      recordedAt: nowIso(),
      // N2 · sin esto, restoreCheckpoint() resimularía sin latencia y divergiría del
      // stateHash guardado en cuanto hubiera un comando aceptado bajo latencia.
      simulatedLatency: b.config.simulatedLatency,
    },
    tick,
    commands,
    stateHash: b.stateHash(),
  };
}

/** Rechazo estricto en mismatch de versión: mensaje con ambos valores, sin modo tolerante. */
function checkVersion(field: string, saved: string | undefined, current: string): void {
  if (saved !== current) {
    throw new Error(
      `restoreCheckpoint: versión incompatible de ${field}: el checkpoint se guardó con "${saved}" y este motor es "${current}"`,
    );
  }
}

/**
 * Restaura un checkpoint: re-simula hasta N con los comandos grabados, verifica el
 * hash canónico y acopla los agentes reales. Devuelve una Battle VIVA lista para
 * step()/run(). Exige un agente por participante (para dejar uno "mudo" a propósito,
 * pásalo explícito, p. ej. un DeadBot): reanudar con huecos silenciosos sería un
 * error de operación, no una opción por defecto.
 */
export async function restoreCheckpoint(ckpt: BattleCheckpoint, agents: Record<string, BotAgent>): Promise<Battle> {
  if (ckpt.formatVersion !== 1) {
    throw new Error(
      `restoreCheckpoint: formatVersion desconocida: ${JSON.stringify(ckpt.formatVersion)} (soportada: 1)`,
    );
  }
  const current = runtimeVersions(ckpt.header.rulesetId);
  checkVersion("engine", ckpt.header.versions?.engine, current.engine);
  checkVersion("physics", ckpt.header.versions?.physics, current.physics);
  checkVersion("protocol", ckpt.header.versions?.protocol, current.protocol);
  if (ckpt.header.rulesetId !== ckpt.header.ruleset?.rulesetId) {
    throw new Error(
      `restoreCheckpoint: checkpoint corrupto: rulesetId "${ckpt.header.rulesetId}" no coincide con el ruleset embebido "${ckpt.header.ruleset?.rulesetId}"`,
    );
  }
  const ids = new Set(ckpt.header.participants.map((p: any) => p.id));
  for (const id of Object.keys(agents)) {
    if (!ids.has(id)) throw new Error(`restoreCheckpoint: agente para vehículo desconocido: ${id}`);
  }
  const missing = [...ids].filter((id) => !(id in agents));
  if (missing.length > 0) {
    throw new Error(`restoreCheckpoint: faltan agentes para: ${missing.join(", ")}`);
  }
  for (const c of ckpt.commands) {
    if (c.tick >= ckpt.tick) {
      throw new Error(
        `restoreCheckpoint: checkpoint corrupto: comando en tick ${c.tick} ≥ tick del checkpoint ${ckpt.tick}`,
      );
    }
  }

  // recordReplay: true — la batalla restaurada re-graba los comandos resimulados y
  // sigue grabando la continuación: se puede volver a checkpointear o emitir replay.
  const b = await Battle.create({
    battleId: ckpt.header.battleId,
    seed: ckpt.header.seed,
    ruleset: ckpt.header.ruleset,
    map: ckpt.header.map,
    participants: ckpt.header.participants,
    recordReplay: true,
    // N2 · idem saveCheckpoint(): reconstruir la MISMA BattleConfig, latencia incluida.
    simulatedLatency: ckpt.header.simulatedLatency,
  });
  try {
    const byVehicle = new Map<string, { tick: number; command: any }[]>();
    for (const c of ckpt.commands) {
      if (!byVehicle.has(c.vehicleId)) byVehicle.set(c.vehicleId, []);
      byVehicle.get(c.vehicleId)!.push({ tick: c.tick, command: c.command });
    }
    for (const p of ckpt.header.participants) {
      b.attachBot(p.id, new ReplayAgent(p.botId, byVehicle.get(p.id) ?? []));
    }

    while (!b.isFinished() && b.tick < ckpt.tick) b.step();

    if (b.isFinished() || b.tick !== ckpt.tick) {
      throw new Error(
        `restoreCheckpoint: la resimulación no alcanzó el tick ${ckpt.tick} ` +
          `(terminó=${b.isFinished()} en el tick ${b.tick}): checkpoint corrupto o motor incompatible`,
      );
    }
    const recomputed = b.stateHash();
    if (recomputed !== ckpt.stateHash) {
      throw new Error(
        `restoreCheckpoint: divergencia de estado en el tick ${ckpt.tick}: ` +
          `hash guardado ${ckpt.stateHash} ≠ recalculado ${recomputed}. ` +
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
 * Serialización JSONL, mismo formato de línea que replay.ts (una línea por registro,
 * campo `t`): `ckpt` (metadatos) + `header` + `cmd`*. Sin contenedor binario nuevo.
 */
export function checkpointToJsonl(ckpt: BattleCheckpoint): string {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({ t: "ckpt", formatVersion: ckpt.formatVersion, tick: ckpt.tick, stateHash: ckpt.stateHash }),
  );
  lines.push(JSON.stringify({ t: "header", ...ckpt.header }));
  for (const c of ckpt.commands) lines.push(JSON.stringify({ t: "cmd", ...c }));
  return lines.join("\n") + "\n";
}

export function checkpointFromJsonl(jsonl: string): BattleCheckpoint {
  let meta: { formatVersion: 1; tick: number; stateHash: string } | null = null;
  let header: ReplayHeader | null = null;
  const commands: BattleCheckpoint["commands"] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    const { t, ...rest } = rec;
    switch (t) {
      case "ckpt":
        meta = rest as any;
        break;
      case "header":
        header = rest as ReplayHeader;
        break;
      case "cmd":
        commands.push(rest as any);
        break;
      default:
        // Estricto a propósito: un registro desconocido en un checkpoint es corrupción,
        // no una extensión a ignorar (a diferencia del replay, aquí hay que REANUDAR).
        throw new Error(`Checkpoint corrupto: registro desconocido t=${JSON.stringify(t)}`);
    }
  }
  if (!meta) throw new Error("Checkpoint sin registro ckpt: archivo corrupto");
  if (!header) throw new Error("Checkpoint sin cabecera: archivo corrupto");
  return { formatVersion: meta.formatVersion, header, tick: meta.tick, stateHash: meta.stateHash, commands };
}
