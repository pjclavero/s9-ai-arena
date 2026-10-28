/**
 * 4v4-STATS · Batalla team_deathmatch 4v4 REAL del motor (8 participantes,
 * respawn), compartida por los tests de stats del replay-service y de la API.
 *
 * - Rojos r1..r4 y azules b1..b4: artilleros con `HunterBot` (se encuentran y
 *   se matan: hay bajas en los dos sentidos y reapariciones).
 * - r1 lleva radio y HABLA (ver `talker`); el resto sólo escucha.
 * - Cada agente registra la radio que OYE en la batalla original: es la verdad
 *   independiente contra la que se comparan los contadores de stats.ts.
 */
import { loadRuleset } from "../../../../packages/game-rules/index.js";
import type { BotAgent } from "../../../arena-engine/src/sim/battle.js";
import type { ArenaMap } from "../../../arena-engine/src/sim/modes.js";
import { record, type Replay } from "../../../arena-engine/src/replay.js";
import { MODULES, emptyArena, gunnerLoadout } from "../../../arena-engine/src/fixtures.js";
import { HunterBot } from "../../../arena-engine/src/stubs.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");
export const RED = ["r1", "r2", "r3", "r4"];
export const BLUE = ["b1", "b2", "b3", "b4"];
/** El emisor calla a partir de aquí, para que TODO lo aceptado se entregue antes del final. */
export const RADIO_UNTIL_TICK = 1800;
export const TIME_LIMIT = 2400;

/** Arena 4v4: un spawn por vehículo, sin superposición (el reparto de spawns es de T-ENGINE). */
export function arena4v4(): ArenaMap {
  const m = emptyArena(140, 90);
  m.mapId = "stats-4v4";
  m.spawns = [
    ...[15, 35, 55, 75].map((y) => ({ team: "red", position: { x: 30, y }, heading: 0 })),
    ...[15, 35, 55, 75].map((y) => ({ team: "blue", position: { x: 110, y }, heading: Math.PI })),
  ];
  return m;
}

function radioGunner() {
  const s = gunnerLoadout();
  s.modules = [...s.modules, { ...MODULES.radio }];
  return s;
}

/** Registra la radio OÍDA en la batalla original (la verdad independiente). */
export class Listening implements BotAgent {
  heard: { from: string }[] = [];
  private d = 0;
  constructor(
    readonly botId: string,
    private inner: BotAgent,
    private extra?: (obs: any, cmd: any, decision: number) => void,
  ) {}
  decide(obs: any) {
    for (const m of obs.radio ?? []) this.heard.push({ from: m.from });
    const cmd = this.inner.decide(obs);
    if (cmd) this.extra?.(obs, cmd, this.d);
    this.d++;
    return cmd;
  }
}

/**
 * r1 caza Y habla: broadcast en 1 de cada 3 decisiones (≈3,3/s, por encima del
 * límite de 2/s del módulo: habrá `rate_limited`), un mensaje DIRIGIDO a r2 cada
 * 20 decisiones y uno demasiado grande (`too_large`) cada 50. Calla en
 * RADIO_UNTIL_TICK.
 */
function talker(obs: any, cmd: any, d: number) {
  if (obs.tick >= RADIO_UNTIL_TICK) return;
  const out: any[] = [];
  if (d % 3 === 0) out.push({ slot: "radio_a", data: b64(`r1-${d}`) });
  if (d % 20 === 0) out.push({ slot: "radio_a", data: b64(`to-r2-${d}`), to: "r2" });
  if (d % 50 === 0) out.push({ slot: "radio_a", data: b64("x".repeat(64)) });
  if (out.length) cmd.radio = out;
}

/**
 * Juega el 4v4. `botIdOf` da el botId de plataforma de cada vehículo (por
 * defecto `bot_<vehículo>`; la API usa los uuid de `bots`).
 */
export async function play4v4(
  seed: string,
  botIdOf: (vehicleId: string) => string = (id) => `bot_${id}`,
): Promise<{ replay: Replay; agents: Map<string, Listening> }> {
  const agents = new Map<string, Listening>();
  const participants = [
    ...RED.map((id) => ({ id, botId: botIdOf(id), team: "red", spec: id === "r1" ? radioGunner() : gunnerLoadout() })),
    ...BLUE.map((id) => ({ id, botId: botIdOf(id), team: "blue", spec: gunnerLoadout() })),
  ];
  const replay = await record(
    {
      battleId: seed,
      seed,
      ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: TIME_LIMIT, scoreToWin: 999 }),
      map: arena4v4(),
      participants,
    },
    (b) => {
      for (const p of participants) {
        const a = new Listening(p.botId, new HunterBot(p.botId), p.id === "r1" ? talker : undefined);
        agents.set(p.id, a);
        b.attachBot(p.id, a);
      }
    },
  );
  return { replay, agents };
}
