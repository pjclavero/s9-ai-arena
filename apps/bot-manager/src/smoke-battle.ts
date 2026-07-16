/**
 * E6 · bot-manager — prueba de protocolo y partida de humo EN PROCESO (T6.1).
 *
 * DoD T6.1:
 *  - "pruebas de protocolo (el artefacto arranca, hace HELLO válido y responde a una
 *     observación sintética)"
 *  - "partida de humo contra un bot de referencia de E5 en el motor real"
 *  - "La partida de humo detecta un bot que compila pero incumple protocolo y lo rechaza."
 *
 * Cómo se hace SIN Docker (estrategia de dos capas, honesta):
 *   El "artefacto" en ejecución es, en producción, un contenedor que se conecta por
 *   WebSocket al ProtocolServer real de E5. Aquí, el pipeline recibe un
 *   CandidateAgentFactory que produce un BotAgent EN PROCESO. La partida de humo monta
 *   una `Battle` REAL de E2 (misma clase, mismo catálogo E3, mismo ruleset) y enfrenta al
 *   candidato contra un bot de referencia (stub de E5). El COMMAND del candidato se valida
 *   contra el ESQUEMA REAL command.schema.json del protocolo arena/1 (packages/protocol),
 *   igual que hace protocol-server.ts. Lo único que no se ejercita es el transporte
 *   WebSocket + el aislamiento de contenedor: eso es T6.2 (verificación pendiente de Docker).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { loadCatalog } from "../../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import { Battle, type BotAgent, type Participant } from "../../arena-engine/src/sim/battle.js";
import { emptyArena } from "../../arena-engine/src/fixtures.js";
import type { CandidateAgentFactory } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(__dirname, "..", "..", "..", "packages", "protocol", "schemas");

let cachedCommandValidator: ReturnType<Ajv2020["getSchema"]> | null = null;
function commandValidator() {
  if (cachedCommandValidator) return cachedCommandValidator;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ["common.schema.json", "command.schema.json"]) {
    ajv.addSchema(JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8")), f);
  }
  cachedCommandValidator = ajv.getSchema("command.schema.json")!;
  return cachedCommandValidator;
}

export interface ProtocolTestResult {
  ok: boolean;
  reason?: string;
  logs: string[];
}

/** Observación sintética mínima pero realista (misma forma que buildObservation de E2). */
function syntheticObservation(tick = 0) {
  return {
    tick,
    self: { position: { x: 0, y: 0 }, heading: 0, turretHeading: 0 },
    sensors: { radar: [] },
  };
}

/**
 * Prueba de protocolo: el candidato "arranca" (se instancia), responde a una observación
 * sintética y su COMMAND valida contra command.schema.json. Un bot que devuelve algo que
 * no valida (o que lanza excepción) se rechaza.
 */
export function runProtocolTest(factory: CandidateAgentFactory, botId: string): ProtocolTestResult {
  const logs: string[] = [];
  let agent: { decide(obs: unknown): unknown };
  try {
    agent = factory.create(botId);
    logs.push("arranque: agente instanciado");
  } catch (e) {
    return { ok: false, reason: `el artefacto no arranca: ${(e as Error).message}`, logs };
  }

  const validate = commandValidator();
  for (const tick of [0, 3, 6]) {
    let cmd: unknown;
    try {
      cmd = agent.decide(syntheticObservation(tick));
    } catch (e) {
      return { ok: false, reason: `decide() lanzó excepción en tick ${tick}: ${(e as Error).message}`, logs };
    }
    if (cmd === null || cmd === undefined) {
      logs.push(`tick ${tick}: COMMAND nulo (aceptable: 'sin cambios')`);
      continue;
    }
    if (!validate(cmd)) {
      const msg = (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join("; ");
      return { ok: false, reason: `COMMAND no cumple command.schema.json en tick ${tick}: ${msg}`, logs };
    }
    logs.push(`tick ${tick}: COMMAND válido`);
  }
  return { ok: true, logs };
}

export interface SmokeBattleResult {
  ok: boolean;
  reason?: string;
  logs: string[];
  ticks: number;
  disqualified: string[];
}

export interface SmokeBattleOptions {
  candidate: CandidateAgentFactory;
  candidateBotId: string;
  candidateArchetype: keyof typeof ARCHETYPES;
  /** Fábrica del bot de referencia (stub de E5). */
  referenceAgent: (botId: string) => BotAgent;
  referenceArchetype?: keyof typeof ARCHETYPES;
  ticks: number;
  seed?: string;
}

/** Adaptador: un CandidateAgentFactory a un BotAgent del motor. */
function toBotAgent(factory: CandidateAgentFactory, botId: string): BotAgent {
  const inner = factory.create(botId);
  return { botId, decide: (obs: unknown) => inner.decide(obs) as unknown as ReturnType<BotAgent["decide"]> };
}

/**
 * Partida de humo: `Battle` real de E2, candidato vs bot de referencia de E5. Si la batalla
 * no termina, o el candidato acaba descalificado (comandos ilegales sostenidos, timeouts),
 * la etapa falla.
 */
export async function runSmokeBattle(opts: SmokeBattleOptions): Promise<SmokeBattleResult> {
  const logs: string[] = [];
  const catalog = loadCatalog();
  const refArche = opts.referenceArchetype ?? "gunner";
  const participants: Participant[] = [
    { id: "veh_1", botId: opts.candidateBotId, team: "red", spec: resolveVehicle(ARCHETYPES[opts.candidateArchetype], catalog) },
    { id: "veh_2", botId: "ref_bot", team: "blue", spec: resolveVehicle(ARCHETYPES[refArche], catalog) },
  ];
  const battle = await Battle.create({
    battleId: "smoke_" + Date.now(),
    seed: opts.seed ?? "smoke",
    ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: opts.ticks }),
    map: emptyArena(),
    participants,
  });
  try {
    battle.attachBot("veh_1", toBotAgent(opts.candidate, opts.candidateBotId));
    battle.attachBot("veh_2", opts.referenceAgent("ref_bot"));
    const result = battle.run(opts.ticks + 10);
    logs.push(`batalla terminada en ${result.ticks} ticks; ganador ${result.winner}`);
    const dq = result.disqualified ?? [];
    if (dq.includes(opts.candidateBotId) || dq.includes("veh_1")) {
      return { ok: false, reason: `candidato descalificado en la partida de humo`, logs, ticks: result.ticks, disqualified: dq };
    }
    return { ok: true, logs, ticks: result.ticks, disqualified: dq };
  } catch (e) {
    return { ok: false, reason: `la partida de humo lanzó excepción: ${(e as Error).message}`, logs, ticks: 0, disqualified: [] };
  } finally {
    battle.free();
  }
}
