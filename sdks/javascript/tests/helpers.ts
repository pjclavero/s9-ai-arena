/**
 * Helper de test compartido: envoltorio fino sobre src/local-simulator.ts (la
 * implementación real, que también usa el CLI `arena-sim` de R2.8) con los
 * defaults RÁPIDOS de test: 3 ms/tick y deadline de 60 ms, para no correr las
 * batallas de la suite en tiempo real (~33 ms/tick).
 */
import {
  startLocalBattle as startShared,
  type LocalBattleOptions,
  type LocalBattleHandle,
} from "../src/local-simulator.js";

export type { LocalBattleHandle };

export function startLocalBattle(opts: LocalBattleOptions): Promise<LocalBattleHandle> {
  return startShared({ tickIntervalMs: 3, decisionDeadlineMs: 60, ...opts });
}
