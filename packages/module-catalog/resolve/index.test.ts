/**
 * T3.3 · DoD:
 *  - Golden files: 4 arquetipos producen fichas EXACTAS versionadas en resolve/golden/*.json.
 *  - Integración real: una ficha resuelta funciona en new Vehicle() y en una Battle real
 *    del motor de E2 (importados con ruta relativa real, no reimplementados).
 *  - Rendimiento: resolver 100 loadouts < 50 ms, medido FUERA de apps/arena-engine/src/sim/.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVehicle, UnresolvableLoadoutError } from "./index.js";
import { loadCatalog } from "../loadCatalog.js";
import { ARCHETYPES } from "./archetypes.js";
import { loadRuleset } from "../../game-rules/index.js";
import { Vehicle } from "../../../apps/arena-engine/src/sim/vehicle.js";
import { Battle } from "../../../apps/arena-engine/src/sim/battle.js";
import { emptyArena } from "../../../apps/arena-engine/src/fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalog = loadCatalog();

function readGolden(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, "golden", `${name}.json`), "utf8"));
}

describe("T3.3 · resolveVehicle — golden files por arquetipo", () => {
  for (const [name, loadout] of Object.entries(ARCHETYPES)) {
    it(`${name}: coincide exactamente con resolve/golden/${name}.json`, () => {
      const resolved = resolveVehicle(loadout, catalog);
      expect(resolved).toEqual(readGolden(name));
    });
  }

  it("massKg total = masa del chasis + suma de masas de módulos, para los 4 arquetipos", () => {
    for (const loadout of Object.values(ARCHETYPES)) {
      const resolved = resolveVehicle(loadout, catalog);
      const chassisDef = catalog.find((m) => `${m.id}@${m.version}` === loadout.chassis)!;
      const expected = chassisDef.massKg + resolved.modules.reduce((a, m) => a + m.massKg, 0);
      expect(resolved.massKg).toBe(expected);
    }
  });
});

describe("T3.3 · resolveVehicle — errores", () => {
  it("lanza UnresolvableLoadoutError si el chasis no existe en el catálogo", () => {
    expect(() =>
      resolveVehicle({ ...ARCHETYPES.scout, chassis: "chassis.ghost@1" }, catalog),
    ).toThrow(UnresolvableLoadoutError);
  });

  it("lanza UnresolvableLoadoutError si un módulo no existe en el catálogo", () => {
    const loadout = { ...ARCHETYPES.scout, modules: [{ slot: "drive", moduleId: "movement.ghost@1" }] };
    expect(() => resolveVehicle(loadout, catalog)).toThrow(UnresolvableLoadoutError);
  });
});

describe("T3.3 · resolveVehicle — integración real con el motor (E2)", () => {
  it("una ficha resuelta funciona en new Vehicle() del motor", () => {
    const spec = resolveVehicle(ARCHETYPES.gunner, catalog);
    const v = new Vehicle("veh_1", "red", "bot_1", spec);
    expect(v.hullHp).toBe(spec.hullHp);
    expect(v.modules.size).toBe(spec.modules.length);
    expect(v.armor.front?.reduction).toBe(0.35);
  });

  it("una batalla real con dos vehículos resueltos corre varios ticks sin lanzar", async () => {
    const battle = await Battle.create({
      battleId: "battle_t33_integration",
      seed: "t33-integration",
      ruleset: loadRuleset("dm_practice@1"),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "bot_1", team: "red", spec: resolveVehicle(ARCHETYPES.gunner, catalog) },
        { id: "veh_2", botId: "bot_2", team: "blue", spec: resolveVehicle(ARCHETYPES.scout, catalog) },
      ],
    });

    expect(() => {
      for (let i = 0; i < 30; i++) battle.step();
    }).not.toThrow();

    battle.free();
  });
});

describe("T3.3 · rendimiento (medido fuera de apps/arena-engine/src/sim/)", () => {
  it("resuelve 100 loadouts en menos de 50 ms", () => {
    const loadouts = Object.values(ARCHETYPES);
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      resolveVehicle(loadouts[i % loadouts.length], catalog);
    }
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(50);
  });
});
