// @vitest-environment jsdom
/**
 * V1 · B4 · AUD1-01 · el coste que enseña el editor de loadout es el MISMO que decide
 * `budget_exceeded` (única fuente: `loadoutCostCredits`, con la munición embebida).
 * Cada `it` lleva una etiqueta B4_… (la usa scripts/budget-ammo-mutants.mjs).
 */
import { describe, it, expect } from "vitest";
import { computeLive } from "../src/pages/LoadoutEditor.js";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";
import { validateLoadout } from "../../../packages/module-catalog/validator/index.js";

const catalog = loadCatalog();
const GUNNER = {
  chassis: "chassis.medium@1",
  modules: [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: "power.battery@1" },
    { slot: "sensor_a", moduleId: "sensor.lidar360@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
    { slot: "armor_front", moduleId: "armor.steel_front@1" },
  ],
};
const draft = { catalogVersion: CATALOG_VERSION, ...GUNNER };

/** Menor presupuesto con el que el validador NO da budget_exceeded. */
function realThreshold(): number {
  const input = { loadoutId: "x", revision: 1, ...draft };
  for (let b = 200; b <= 5000; b++) {
    if (!validateLoadout(input as never, catalog, b).some((v) => v.code === "budget_exceeded")) return b;
  }
  return -1;
}

describe("B4 · coste mostrado = coste validado", () => {
  it("B4_EDITOR_COST · el editor enseña el coste que exige el validador (900, no 850)", () => {
    const real = realThreshold();
    expect(real).toBe(900);
    expect(computeLive(draft, catalog, real).costCredits).toBe(real);
  });

  it("B4_EDITOR_COHERENT · con presupuesto 880 la pantalla no dice 'ok' y budget_exceeded a la vez", () => {
    const live = computeLive(draft, catalog, 880);
    expect(live.violations.map((v) => v.code)).toContain("budget_exceeded");
    expect(live.costCredits).toBeGreaterThan(880);
  });
});
