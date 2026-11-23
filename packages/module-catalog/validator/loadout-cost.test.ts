/**
 * V1 · B4 · `loadoutCostCredits` es la ÚNICA fuente del coste de un loadout (D-OP-10/15).
 * Diferencial contra el validador: el umbral real de `budget_exceeded` coincide con la cifra.
 */
import { describe, it, expect } from "vitest";
import { loadCatalog } from "../loadCatalog.js";
import { scoutLoadout, gunnerLoadout, minerLoadout, heavyLoadout } from "../resolve/archetypes.js";
import { findModule, type LoadoutInput } from "../types.js";
import { loadoutCostCredits, validateLoadout } from "./index.js";

const catalog = loadCatalog();
const GUNNER: LoadoutInput = {
  loadoutId: "x",
  revision: 1,
  catalogVersion: "mvp@1",
  chassis: "chassis.medium@1",
  modules: [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: "power.battery@1" },
    { slot: "sensor_a", moduleId: "sensor.lidar360@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
    { slot: "armor_front", moduleId: "armor.steel_front@1" },
  ],
};
const cost = (id: string) => findModule(catalog, id)!.costCredits;
const threshold = (l: LoadoutInput) => {
  for (let b = 200; b <= 5000; b++) {
    if (!validateLoadout(l, catalog, b).some((v) => v.code === "budget_exceeded")) return b;
  }
  return -1;
};

describe("B4 · loadoutCostCredits", () => {
  it("B4_COST_AMMO · suma la munición embebida del arma (chasis + módulos + ammo)", () => {
    const sumNoAmmo = [GUNNER.chassis, ...GUNNER.modules.map((m) => m.moduleId)].reduce((s, id) => s + cost(id), 0);
    expect(loadoutCostCredits(GUNNER, catalog)).toBe(sumNoAmmo + cost("ammo.ap@1"));
    expect(loadoutCostCredits(GUNNER, catalog)).toBe(900);
  });

  it("B4_COST_NO_DOUBLE · una munición ya montada como módulo explícito no se cuenta dos veces", () => {
    const explicit = { ...GUNNER, modules: [...GUNNER.modules, { slot: "ammo_main", moduleId: "ammo.ap@1" }] };
    const sumAll = [explicit.chassis, ...explicit.modules.map((m) => m.moduleId)].reduce((s, id) => s + cost(id), 0);
    expect(loadoutCostCredits(explicit, catalog)).toBe(sumAll);
  });

  it("B4_COST_VALIDATOR · el umbral real de budget_exceeded es exactamente la cifra (ejemplo y arquetipos)", () => {
    expect(threshold(GUNNER)).toBe(loadoutCostCredits(GUNNER, catalog));
    for (const l of [scoutLoadout, gunnerLoadout, minerLoadout, heavyLoadout]) {
      expect(threshold(l)).toBe(loadoutCostCredits(l, catalog));
    }
  });

  it("B4_COST_UNKNOWN · una pieza desconocida no hace lanzar la suma (cuenta 0)", () => {
    expect(() => loadoutCostCredits({ chassis: "nope@1", modules: [{ moduleId: "nada@1" }] }, catalog)).not.toThrow();
  });
});
