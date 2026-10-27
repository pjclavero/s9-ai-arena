/**
 * UX-01 · G-A05 · la partida de humo del build juega el loadout REAL de la versión
 * (el mismo que la batalla), y el arquetipo sólo de reserva, diciéndolo.
 */
import { describe, it, expect } from "vitest";
import { CATALOG_VERSION, loadCatalog } from "../../../packages/module-catalog/loadCatalog.js";
import { smokeVehicle } from "../src/smoke-vehicle.js";
import { runSmokeBattle } from "../src/smoke-battle.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";

const catalog = loadCatalog();
const LOADOUT = {
  loadoutId: "ldt_ux01",
  revision: 4,
  catalogVersion: CATALOG_VERSION,
  chassis: "chassis.medium@1",
  modules: [
    { slot: "drive", moduleId: "movement.wheels@1" },
    { slot: "power", moduleId: "power.battery@1" },
    { slot: "sensor_a", moduleId: "sensor.lidar_front@1" },
    { slot: "turret_main", moduleId: "weapon.mg@1", ammo: "ammo.standard@1" },
  ],
};
const ids = (spec: { modules: { moduleId: string }[] }) => spec.modules.map((m) => m.moduleId).sort();

describe("UX-01 · G-A05 · vehículo de la partida de humo", () => {
  it("con loadout: juega SUS módulos, no los del arquetipo del chasis", () => {
    const v = smokeVehicle({ archetype: "gunner", loadout: LOADOUT }, catalog);
    expect(v.source).toBe("loadout");
    expect(ids(v.spec)).toEqual(
      ["movement.wheels@1", "power.battery@1", "sensor.lidar_front@1", "weapon.mg@1", "ammo.standard@1"].sort(),
    );
    expect(ids(v.spec)).not.toContain("weapon.cannon@1"); // el cañón es del arquetipo gunner
    expect(v.note).toMatch(/loadout rev 4 de la versión/);
  });

  it("sin loadout o con otro catálogo: arquetipo de reserva y el log dice por qué", () => {
    const none = smokeVehicle({ archetype: "scout" }, catalog);
    expect(none.source).toBe("archetype");
    expect(none.note).toMatch(/arquetipo scout \(la versión no trae loadout\)/);
    const other = smokeVehicle({ archetype: "gunner", loadout: { ...LOADOUT, catalogVersion: "mvp@99" } }, catalog);
    expect(other.source).toBe("archetype");
    expect(other.note).toMatch(/catálogo mvp@99/);
  });

  it("la partida de humo en proceso registra el vehículo jugado", async () => {
    await initPhysics();
    const res = await runSmokeBattle({
      candidate: { create: (id) => new HunterBot(id) },
      candidateBotId: "bot_ux01",
      candidateArchetype: "gunner",
      candidateLoadout: LOADOUT,
      referenceAgent: (id) => new HunterBot(id),
      ticks: 30,
    });
    expect(res.logs[0]).toMatch(/loadout rev 4 de la versión/);
  });
});
