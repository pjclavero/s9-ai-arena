/**
 * FC-D · E2E de navegador — PROVISIÓN DECLARADA de un replay para probar el
 * reproductor antes de que exista una batalla ejecutada de punta a punta.
 *
 * ATAJO DECLARADO (no es el golden path): en la base 0b8c12b ningún bot puede
 * publicarse (TD-001, carril A) y sin bot publicado no hay batalla que el
 * worker ejecute (TD-002/TD-005, carril B). Para recorrer «listar → abrir →
 * cargar → canvas → avanzar ticks → fin» en navegador real, se graba UNA
 * batalla con el MOTOR REAL (`record`, con los bots stub deterministas que el
 * propio worker de la base usa) y se ingesta con `ingestReplay` — la misma
 * función que llama el tournament-worker al terminar una batalla — en el
 * directorio que sirve el replay-service real. NO toca la BD (sin UPDATE ni
 * INSERT manuales). El golden path de REVIEW sustituye esto por una batalla
 * creada desde la UI.
 *
 * Uso: REPLAYS_DIR=<dir> tsx tests/browser/env/seed-replay.ts <battleId> [ticks]
 */
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../../apps/arena-engine/src/sim/physics.js";
import { record } from "../../../apps/arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../../apps/arena-engine/src/fixtures.js";
import { HunterBot } from "../../../apps/arena-engine/src/stubs.js";
import { ingestReplay } from "../../../apps/replay-service/src/store.js";

const battleId = process.argv[2];
const ticks = Number(process.argv[3] ?? 900);
const dir = process.env.REPLAYS_DIR;
if (!battleId || !dir) {
  console.error("uso: REPLAYS_DIR=<dir> tsx seed-replay.ts <battleId> [ticks]");
  process.exit(2);
}

await initPhysics();
const replay = await record(
  {
    battleId,
    seed: `fcd-${battleId}`,
    ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: ticks }),
    map: emptyArena(),
    participants: [
      { id: "v_red", botId: "bot_red", team: "red", spec: gunnerLoadout() },
      { id: "v_blue", botId: "bot_blue", team: "blue", spec: scoutLoadout() },
    ],
  },
  (b) => {
    b.attachBot("v_red", new HunterBot("bot_red"));
    b.attachBot("v_blue", new HunterBot("bot_blue"));
  },
);
const stored = ingestReplay(dir, replay, { official: false });
console.log(JSON.stringify({ msg: "replay sembrado", battleId, ticks: stored.index.ticks, sha256: stored.index.sha256 }));
