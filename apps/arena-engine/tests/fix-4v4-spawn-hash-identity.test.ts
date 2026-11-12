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

// RE-ANCLADO en la integración OLA2 (M0-I, MD+MB): hash v2 por componentes + flujos RNG con nombre (MD)
// y contrato de daño de MB (orden por slot, hp del blindaje = hp del módulo, turretHeading normalizado,
// armor.profile en el estado del vehículo). Atribución: m0-atribucion.py (INTEGRACION.md).
const PRE_FIX_HASHES: Record<string, string> = {
  "1v1-real": "3f1bb8bb19304936512e7f8bfa9f52c3ab5ebb0f390c6e9ea281f63e6513ecc1",
  "2v2-real": "587aa2e1fb5f32515d35f1d17d2de1eda9cc764c4dfaf6ca48e150ff142a8e40",
  "2v2-open": "e4ab04bdbc7db18c54c9046f10d1ebc9fd060c8160c04d30b0de81ade4bec0ed",
  "4v4-real": "bc7231c2f169744d68c6ecf1627c6c047d05ea3dd57fa77f491c0c0c0d5bf237",
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
