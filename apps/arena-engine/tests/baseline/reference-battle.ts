/**
 * OLA 2 · ME · Batalla de REFERENCIA de la baseline (no es un test).
 *
 * Gunner (HunterBot, cañón AP) contra Miner (HunterBot con ametralladora que además
 * siembra una mina cada 120 ticks) en el mapa MVP. Ejercita a la vez torreta,
 * proyectiles, minas, daño, blindaje y fin de batalla: es la batalla con la que MD, MA,
 * MB y MC tienen que demostrar que no cambian resultado, orden de eventos ni daño
 * (aunque sí, conscientemente, el hash).
 */
import { loadRuleset } from "../../../../packages/game-rules/index.js";
import type { BattleConfig } from "../../src/sim/battle.js";
import { gunnerLoadout, minerLoadout, mvpArena } from "../../src/fixtures.js";
import { record, type Replay } from "../../src/replay.js";
import { HunterBot } from "../../src/stubs.js";

export const REFERENCE_TICKS = 900;

export function referenceConfig(): BattleConfig {
  return {
    battleId: "me_reference_01",
    seed: "me-baseline-seed-01",
    ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: REFERENCE_TICKS }),
    map: mvpArena(),
    participants: [
      { id: "veh_1", botId: "bot_gunner", team: "red", spec: gunnerLoadout() },
      { id: "veh_2", botId: "bot_miner", team: "blue", spec: minerLoadout() },
    ],
  };
}

/** HunterBot que además pide una mina cada 120 ticks (a partir del 60). */
export class MinerHunterBot extends HunterBot {
  override decide(obs: any) {
    const cmd: any = super.decide(obs);
    if (obs.tick >= 60 && obs.tick % 120 === 0) cmd.deployMine = { slot: "mine_bay", armDelayTicks: 30 };
    return cmd;
  }
}

export async function recordReference(): Promise<Replay> {
  return record(referenceConfig(), (b) => {
    b.attachBot("veh_1", new HunterBot("bot_gunner"));
    b.attachBot("veh_2", new MinerHunterBot("bot_miner"));
  });
}
