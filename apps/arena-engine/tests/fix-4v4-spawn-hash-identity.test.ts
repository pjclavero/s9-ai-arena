/**
 * 4v4-FIX · La búsqueda amplia de spawns sólo entra cuando la rejilla atrás/lados
 * de 0.3.0 no encuentra hueco. Toda configuración con spawns suficientes (1v1 y
 * 2v2 red/blue) —y el 4v4 sobre mvp-arena-01, que ya cabía atrás/lados— debe dar
 * EXACTAMENTE el mismo hash que antes del fix. Los hashes se midieron con
 * `apps/arena-engine/src/sim/modes.ts` de `7f80e72` (integration/team-4v4).
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { toEngineMap } from "../../map-service/src/to-engine-map.js";
import { Battle, type Participant } from "../src/sim/battle.js";
import type { ArenaMap } from "../src/sim/modes.js";
import { initPhysics } from "../src/sim/physics.js";
import { emptyArena, gunnerLoadout } from "../src/fixtures.js";
import { HunterBot } from "../src/stubs.js";

beforeAll(async () => {
  await initPhysics();
});

const realMap = (): ArenaMap =>
  toEngineMap(JSON.parse(readFileSync(new URL("../../../maps/mvp-arena-01.json", import.meta.url), "utf8")));

// OLA2-MD · regenerado: hash v2 por componentes + flujos RNG con nombre (cambian las tiradas).
const PRE_FIX_HASHES: Record<string, string> = {
  "1v1-real": "d531a8a5985159afbc16b81784e9b226253a11623857d69090cff8c78a2bfee6",
  "2v2-real": "d60432ef194833a1e5f6e2cb743c322c93e9bf3e680b2fac2bbbf84f37bfb366",
  "2v2-open": "caab00a212f0237e874bb0ddb786c3d3c2f4446c0716c474d009f7bf75919982",
  "4v4-real": "66e41b3a3b5c584d8f61f523aa528dcf64bd7f8288c5ad96049043ed892852c2",
};

function run(name: string, n: number, map: ArenaMap): string {
  const parts: Participant[] = Array.from({ length: n }, (_, i) => ({
    id: `veh_${i + 1}`,
    botId: `b${i + 1}`,
    team: i % 2 === 0 ? "red" : "blue",
    spec: gunnerLoadout(),
  }));
  const b = new Battle({ battleId: name, seed: name, ruleset: loadRuleset("tdm_mvp@1"), map, participants: parts });
  for (const p of parts) b.attachBot(p.id, new HunterBot(p.botId));
  for (let t = 0; t < 3000 && !b.isFinished(); t++) b.step();
  const h = b.stateHash();
  b.free();
  return h;
}

describe("4v4-FIX · spawns suficientes: hash idéntico al de antes del fix (7f80e72)", () => {
  const cases: [string, number, () => ArenaMap][] = [
    ["1v1-real", 2, realMap],
    ["2v2-real", 4, realMap],
    ["2v2-open", 4, () => emptyArena()],
    ["4v4-real", 8, realMap],
  ];
  for (const [name, n, mk] of cases) {
    it(`${name}: 3000 ticks con combate y respawn`, () => {
      const h = run(name, n, mk());
      expect(h).toBe(PRE_FIX_HASHES[name]);
    });
  }
});
