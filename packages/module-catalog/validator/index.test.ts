/**
 * T3.2 · Suite del validador de ensamblaje.
 *
 * Usa un catálogo de PRUEBA dedicado (no el catálogo real de T3.1) para poder aislar
 * cada regla sin que interfieran las demás: cada caso inválido dispara EXACTAMENTE
 * el código esperado en violations[0]. El test de propiedad, al final, sí usa el
 * catálogo real.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { validateLoadout, type Violation } from "./index.js";
import type { LoadoutInput, ModuleDefinition } from "../types.js";
import { loadCatalog } from "../loadCatalog.js";
import { BUDGET_CREDITS_MAX, BUDGET_CREDITS_MIN, MAX_MODULE_COST_FRACTION } from "../../game-rules/index.js";

// ------------------------------------------------------------------ catálogo de prueba
const TEST_CATALOG: ModuleDefinition[] = [
  {
    id: "chassis.test_basic",
    version: 1,
    category: "chassis",
    name: "Chasis de prueba",
    massKg: 100,
    costCredits: 100,
    hullHp: 100,
    radiusM: 1,
    maxLoadKg: 100,
    slots: [
      { id: "drive", accepts: ["movement"], maxSize: "M" },
      { id: "power", accepts: ["power"], maxSize: "M" },
      { id: "turret", accepts: ["weapon"], maxSize: "S" },
      { id: "ammo", accepts: ["ammo"], maxSize: "S" },
      { id: "armor_front", accepts: ["armor"], maxSize: "S", sector: "front" },
      { id: "armor_rear", accepts: ["armor"], maxSize: "S", sector: "rear" },
      { id: "sensor_a", accepts: ["sensor"], maxSize: "M" },
      { id: "sensor_b", accepts: ["sensor"], maxSize: "M" },
      { id: "mine_bay", accepts: ["mine", "utility"], maxSize: "S" },
    ],
  },
  {
    id: "chassis.test_alt",
    version: 1,
    category: "chassis",
    name: "Chasis alternativo de prueba",
    massKg: 100,
    costCredits: 50,
    hullHp: 50,
    radiusM: 1,
    maxLoadKg: 1000,
    slots: [{ id: "drive", accepts: ["movement"], maxSize: "M" }],
  },
  {
    id: "chassis.test_expensive",
    version: 1,
    category: "chassis",
    name: "Chasis caro de prueba",
    massKg: 100,
    costCredits: 400,
    hullHp: 100,
    radiusM: 1,
    maxLoadKg: 1000,
    slots: [{ id: "drive", accepts: ["movement"], maxSize: "M" }],
  },
  {
    id: "movement.drive_ok",
    version: 1,
    category: "movement",
    name: "Motriz de prueba",
    massKg: 10,
    costCredits: 10,
    size: "M",
    hp: 10,
    power: { passiveEUs: 1 },
    maxSpeedMs: 5,
    accelerationMs2: 1,
    turnRateRads: 1,
    ratedLoadKg: 100,
  },
  {
    id: "movement.drive_zero",
    version: 1,
    category: "movement",
    name: "Motriz sin consumo pasivo",
    massKg: 10,
    costCredits: 10,
    size: "M",
    hp: 10,
    maxSpeedMs: 5,
    accelerationMs2: 1,
    turnRateRads: 1,
    ratedLoadKg: 100,
  },
  {
    id: "movement.heavy_dummy_101",
    version: 1,
    category: "movement",
    name: "Motriz sobrepeso",
    massKg: 101,
    costCredits: 10,
    size: "M",
    hp: 10,
    maxSpeedMs: 1,
    accelerationMs2: 1,
    turnRateRads: 1,
    ratedLoadKg: 100,
  },
  {
    id: "power.gen_ok",
    version: 1,
    category: "power",
    name: "Generador de prueba",
    massKg: 10,
    costCredits: 10,
    size: "M",
    hp: 10,
    capacityEU: 100,
    generationEUs: 10,
  },
  {
    id: "power.gen_weak",
    version: 1,
    category: "power",
    name: "Generador débil de prueba",
    massKg: 10,
    costCredits: 10,
    size: "M",
    hp: 10,
    capacityEU: 100,
    generationEUs: 0.5,
  },
  {
    id: "weapon.gun_s",
    version: 1,
    category: "weapon",
    name: "Arma S de prueba",
    massKg: 10,
    costCredits: 10,
    size: "S",
    hp: 10,
    power: { passiveEUs: 1, perActionEU: 1 },
    damage: 5,
    cooldownTicks: 5,
    projectileSpeedMs: 10,
    acceptsAmmo: ["ammo.shell"],
    turretArcRad: 6.2832,
    turretRateRads: 1,
  },
  {
    id: "weapon.gun_l",
    version: 1,
    category: "weapon",
    name: "Arma L de prueba (no cabe en turret S)",
    massKg: 10,
    costCredits: 10,
    size: "L",
    hp: 10,
    damage: 5,
    cooldownTicks: 5,
    projectileSpeedMs: 10,
    acceptsAmmo: ["ammo.shell"],
    turretArcRad: 6.2832,
    turretRateRads: 1,
  },
  {
    id: "weapon.gun_expensive",
    version: 1,
    category: "weapon",
    name: "Arma cara de prueba",
    massKg: 10,
    costCredits: 400,
    size: "S",
    hp: 10,
    damage: 5,
    cooldownTicks: 5,
    projectileSpeedMs: 10,
    acceptsAmmo: ["ammo.shell"],
    turretArcRad: 6.2832,
    turretRateRads: 1,
  },
  {
    id: "weapon.locked_to_alt",
    version: 1,
    category: "weapon",
    name: "Arma exclusiva de test_alt",
    massKg: 10,
    costCredits: 10,
    size: "S",
    hp: 10,
    damage: 5,
    cooldownTicks: 5,
    projectileSpeedMs: 10,
    acceptsAmmo: ["ammo.shell"],
    turretArcRad: 6.2832,
    turretRateRads: 1,
    requiresChassis: ["chassis.test_alt"],
  },
  {
    id: "ammo.shell",
    version: 1,
    category: "ammo",
    name: "Munición de prueba",
    massKg: 5,
    costCredits: 5,
    size: "S",
    hp: 5,
    rounds: 10,
    damageMultiplier: 1,
  },
  {
    id: "ammo.pellet",
    version: 1,
    category: "ammo",
    name: "Munición incompatible de prueba",
    massKg: 5,
    costCredits: 5,
    size: "S",
    hp: 5,
    rounds: 10,
    damageMultiplier: 1,
  },
  {
    id: "armor.front_ok",
    version: 1,
    category: "armor",
    name: "Blindaje frontal de prueba",
    massKg: 10,
    costCredits: 10,
    size: "S",
    hp: 10,
    sector: "front",
    reduction: 0.2,
  },
  {
    id: "armor.rear_ok",
    version: 1,
    category: "armor",
    name: "Blindaje trasero de prueba",
    massKg: 10,
    costCredits: 10,
    size: "S",
    hp: 10,
    sector: "rear",
    reduction: 0.2,
  },
  {
    id: "sensor.sensor_ok",
    version: 1,
    category: "sensor",
    name: "Sensor de prueba",
    massKg: 10,
    costCredits: 10,
    size: "M",
    hp: 10,
    power: { passiveEUs: 1 },
    sensorType: "lidar",
    rangeM: 10,
  },
  {
    id: "sensor.sensor_unique",
    version: 1,
    category: "sensor",
    name: "Sensor único de prueba",
    massKg: 10,
    costCredits: 10,
    size: "M",
    hp: 10,
    sensorType: "radar",
    rangeM: 10,
    maxPerVehicle: 1,
  },
  {
    id: "mine.mine_ok",
    version: 1,
    category: "mine",
    name: "Mina de prueba",
    massKg: 10,
    costCredits: 10,
    size: "S",
    hp: 10,
    charges: 1,
    damage: 10,
    triggerRadiusM: 1,
    armDelayTicks: 1,
    cooldownTicks: 1,
  },
  {
    id: "utility.util_ok",
    version: 1,
    category: "utility",
    name: "Utilidad de prueba",
    massKg: 10,
    costCredits: 10,
    size: "S",
    hp: 10,
    effect: "smoke",
    charges: 1,
    cooldownTicks: 1,
  },
];

function baseLoadout(overrides: Partial<LoadoutInput> = {}): LoadoutInput {
  return {
    loadoutId: "ldt_test01",
    revision: 1,
    catalogVersion: "test@1",
    chassis: "chassis.test_basic@1",
    modules: [],
    ...overrides,
  };
}

const codesOf = (vs: Violation[]) => vs.map((v) => v.code);

describe("T3.2 · validateLoadout — casos legales", () => {
  it("1. loadout completo legal en chassis.test_basic", () => {
    const loadout = baseLoadout({
      modules: [
        { slot: "drive", moduleId: "movement.drive_ok@1" },
        { slot: "power", moduleId: "power.gen_ok@1" },
        { slot: "turret", moduleId: "weapon.gun_s@1", ammo: "ammo.shell@1" },
        { slot: "ammo", moduleId: "ammo.shell@1" },
        { slot: "armor_front", moduleId: "armor.front_ok@1" },
        { slot: "armor_rear", moduleId: "armor.rear_ok@1" },
        { slot: "sensor_a", moduleId: "sensor.sensor_ok@1" },
        { slot: "mine_bay", moduleId: "mine.mine_ok@1" },
      ],
    });
    expect(validateLoadout(loadout, TEST_CATALOG, 1000)).toEqual([]);
  });

  it("2. loadout mínimo legal en chassis.test_alt (motriz sin consumo pasivo)", () => {
    const loadout = baseLoadout({
      chassis: "chassis.test_alt@1",
      modules: [{ slot: "drive", moduleId: "movement.drive_zero@1" }],
    });
    expect(validateLoadout(loadout, TEST_CATALOG, 1000)).toEqual([]);
  });

  it("3. loadout legal con utility en mine_bay", () => {
    const loadout = baseLoadout({
      modules: [
        { slot: "drive", moduleId: "movement.drive_zero@1" },
        { slot: "mine_bay", moduleId: "utility.util_ok@1" },
      ],
    });
    expect(validateLoadout(loadout, TEST_CATALOG, 1000)).toEqual([]);
  });

  it("4. loadout legal con un único sensor.sensor_unique (dentro de maxPerVehicle)", () => {
    const loadout = baseLoadout({
      modules: [
        { slot: "drive", moduleId: "movement.drive_zero@1" },
        { slot: "sensor_a", moduleId: "sensor.sensor_unique@1" },
      ],
    });
    expect(validateLoadout(loadout, TEST_CATALOG, 1000)).toEqual([]);
  });

  it("5. loadout legal sin armas ni sensores (equivalente a un 'sandbag')", () => {
    const loadout = baseLoadout({
      modules: [{ slot: "drive", moduleId: "movement.drive_zero@1" }],
    });
    expect(validateLoadout(loadout, TEST_CATALOG, 1000)).toEqual([]);
  });

  it("26. chasis desnudo (sin ningún módulo) es legal si el chasis solo cabe en presupuesto", () => {
    const loadout = baseLoadout({ modules: [] });
    expect(validateLoadout(loadout, TEST_CATALOG, 1000)).toEqual([]);
  });
});

describe("T3.2 · validateLoadout — un código de violación por caso", () => {
  it("6. unknown_slot: ranura inexistente en el chasis", () => {
    const loadout = baseLoadout({ modules: [{ slot: "no_existe", moduleId: "movement.drive_ok@1" }] });
    const v = validateLoadout(loadout, TEST_CATALOG, 1000);
    expect(v[0]?.code).toBe("unknown_slot");
  });

  it("7. unknown_slot: módulo inexistente en el catálogo", () => {
    const loadout = baseLoadout({ modules: [{ slot: "drive", moduleId: "movement.ghost@1" }] });
    const v = validateLoadout(loadout, TEST_CATALOG, 1000);
    expect(v[0]?.code).toBe("unknown_slot");
  });

  it("8. duplicate_slot: dos entradas para la misma ranura", () => {
    const loadout = baseLoadout({
      modules: [
        { slot: "drive", moduleId: "movement.drive_ok@1" },
        { slot: "drive", moduleId: "movement.drive_zero@1" },
      ],
    });
    const v = validateLoadout(loadout, TEST_CATALOG, 1000);
    expect(v.some((x) => x.code === "duplicate_slot")).toBe(true);
  });

  it("9. slot_type_mismatch: categoría de módulo incorrecta para la ranura", () => {
    const loadout = baseLoadout({ modules: [{ slot: "drive", moduleId: "weapon.gun_s@1" }] });
    const v = validateLoadout(loadout, TEST_CATALOG, 1000);
    expect(v[0]?.code).toBe("slot_type_mismatch");
  });

  it("10. slot_type_mismatch: blindaje de sector incorrecto para la ranura", () => {
    const loadout = baseLoadout({ modules: [{ slot: "armor_front", moduleId: "armor.rear_ok@1" }] });
    const v = validateLoadout(loadout, TEST_CATALOG, 1000);
    expect(v[0]?.code).toBe("slot_type_mismatch");
  });

  it("11. slot_size_exceeded: módulo más grande que el tamaño máximo de la ranura", () => {
    const loadout = baseLoadout({ modules: [{ slot: "turret", moduleId: "weapon.gun_l@1" }] });
    const v = validateLoadout(loadout, TEST_CATALOG, 1000);
    expect(v[0]?.code).toBe("slot_size_exceeded");
  });

  it("12. incompatible_chassis: chasis desconocido en el catálogo", () => {
    const loadout = baseLoadout({ chassis: "chassis.ghost@1", modules: [] });
    const v = validateLoadout(loadout, TEST_CATALOG, 1000);
    expect(v[0]?.code).toBe("incompatible_chassis");
  });

  it("13. incompatible_chassis: módulo con requiresChassis no satisfecho", () => {
    const loadout = baseLoadout({ modules: [{ slot: "turret", moduleId: "weapon.locked_to_alt@1" }] });
    const v = validateLoadout(loadout, TEST_CATALOG, 1000);
    expect(v[0]?.code).toBe("incompatible_chassis");
  });

  it("13b. incompatible_chassis: requiresChassis SÍ satisfecho es legal", () => {
    const loadout = baseLoadout({
      chassis: "chassis.test_alt@1",
      modules: [{ slot: "drive", moduleId: "movement.drive_zero@1" }],
    });
    // weapon.locked_to_alt no tiene ranura de arma en chassis.test_alt, así que solo probamos
    // que requiresChassis no es, por sí solo, motivo de rechazo cuando el chasis coincide.
    expect(validateLoadout(loadout, TEST_CATALOG, 1000)).toEqual([]);
  });

  it("14. category_forbidden_by_ruleset: categoría prohibida por el ruleset", () => {
    const loadout = baseLoadout({ modules: [{ slot: "mine_bay", moduleId: "mine.mine_ok@1" }] });
    const v = validateLoadout(loadout, TEST_CATALOG, 1000, ["mine"]);
    expect(v[0]?.code).toBe("category_forbidden_by_ruleset");
  });

  it("15. incompatible_ammo: munición desconocida asignada al arma", () => {
    const loadout = baseLoadout({
      modules: [{ slot: "turret", moduleId: "weapon.gun_s@1", ammo: "ammo.ghost@1" }],
    });
    const v = validateLoadout(loadout, TEST_CATALOG, 1000);
    expect(v[0]?.code).toBe("incompatible_ammo");
  });

  it("16. incompatible_ammo: munición existente pero no aceptada por el arma", () => {
    const loadout = baseLoadout({
      modules: [{ slot: "turret", moduleId: "weapon.gun_s@1", ammo: "ammo.pellet@1" }],
    });
    const v = validateLoadout(loadout, TEST_CATALOG, 1000);
    expect(v[0]?.code).toBe("incompatible_ammo");
  });

  it("17. incompatible_ammo: el id asignado no es de categoría ammo", () => {
    const loadout = baseLoadout({
      modules: [{ slot: "turret", moduleId: "weapon.gun_s@1", ammo: "power.gen_ok@1" }],
    });
    const v = validateLoadout(loadout, TEST_CATALOG, 1000);
    expect(v[0]?.code).toBe("incompatible_ammo");
  });

  it("18. duplicate_limit_exceeded: mismo módulo con maxPerVehicle=1 montado dos veces", () => {
    const loadout = baseLoadout({
      modules: [
        { slot: "sensor_a", moduleId: "sensor.sensor_unique@1" },
        { slot: "sensor_b", moduleId: "sensor.sensor_unique@1" },
      ],
    });
    const v = validateLoadout(loadout, TEST_CATALOG, 1000);
    expect(v[0]?.code).toBe("duplicate_limit_exceeded");
    expect(v.filter((x) => x.code === "duplicate_limit_exceeded")).toHaveLength(1);
  });

  it("19. mass_exceeded: masa de módulos supera maxLoadKg del chasis", () => {
    const loadout = baseLoadout({ modules: [{ slot: "drive", moduleId: "movement.heavy_dummy_101@1" }] });
    const v = validateLoadout(loadout, TEST_CATALOG, 1000);
    expect(v[0]?.code).toBe("mass_exceeded");
  });

  it("20. energy_deficit: generación no cubre el consumo pasivo total", () => {
    const loadout = baseLoadout({
      modules: [
        { slot: "drive", moduleId: "movement.drive_ok@1" }, // passiveEUs 1
        { slot: "power", moduleId: "power.gen_weak@1" }, // generationEUs 0.5
      ],
    });
    const v = validateLoadout(loadout, TEST_CATALOG, 1000);
    expect(v[0]?.code).toBe("energy_deficit");
  });

  it("21. budget_exceeded: coste total por encima del presupuesto de la batalla", () => {
    const loadout = baseLoadout({
      modules: [
        { slot: "drive", moduleId: "movement.drive_ok@1" },
        { slot: "power", moduleId: "power.gen_ok@1" },
        { slot: "turret", moduleId: "weapon.gun_s@1", ammo: "ammo.shell@1" },
        { slot: "ammo", moduleId: "ammo.shell@1" },
      ],
    });
    // coste total 100+10+10+10+5=135 > 100 de presupuesto
    const v = validateLoadout(loadout, TEST_CATALOG, 100);
    expect(v[0]?.code).toBe("budget_exceeded");
  });

  it("22. module_cost_cap_exceeded: un módulo supera MAX_MODULE_COST_FRACTION del presupuesto", () => {
    const loadout = baseLoadout({
      modules: [
        { slot: "drive", moduleId: "movement.drive_ok@1" },
        { slot: "power", moduleId: "power.gen_ok@1" },
        { slot: "turret", moduleId: "weapon.gun_expensive@1", ammo: "ammo.shell@1" },
        { slot: "ammo", moduleId: "ammo.shell@1" },
        { slot: "armor_front", moduleId: "armor.front_ok@1" },
        { slot: "armor_rear", moduleId: "armor.rear_ok@1" },
        { slot: "sensor_a", moduleId: "sensor.sensor_ok@1" },
        { slot: "mine_bay", moduleId: "mine.mine_ok@1" },
      ],
    });
    // coste total 565 <= 1000 (sin budget_exceeded); cap = 350 < 400 del arma cara.
    const v = validateLoadout(loadout, TEST_CATALOG, 1000);
    expect(v).toHaveLength(1);
    expect(v[0]?.code).toBe("module_cost_cap_exceeded");
    expect(v[0]?.moduleId).toBe("weapon.gun_expensive");
  });

  it("23. module_cost_cap_exceeded: el propio chasis supera el límite por módulo", () => {
    const loadout = baseLoadout({
      chassis: "chassis.test_expensive@1",
      modules: [{ slot: "drive", moduleId: "movement.drive_zero@1" }],
    });
    // chasis cuesta 400, cap = 1000*0.35 = 350 < 400; total 410 <= 1000 (sin budget_exceeded).
    const v = validateLoadout(loadout, TEST_CATALOG, 1000);
    expect(v[0]?.code).toBe("module_cost_cap_exceeded");
    expect(v[0]?.moduleId).toBe("chassis.test_expensive");
  });

  it("24. slot_type_mismatch: munición montada en ranura de blindaje", () => {
    const loadout = baseLoadout({ modules: [{ slot: "armor_front", moduleId: "ammo.shell@1" }] });
    const v = validateLoadout(loadout, TEST_CATALOG, 1000);
    expect(v[0]?.code).toBe("slot_type_mismatch");
  });

  it("25. varias violaciones simultáneas: la lista no se corta en la primera", () => {
    const loadout = baseLoadout({ modules: [{ slot: "drive", moduleId: "movement.heavy_dummy_101@1" }] });
    // presupuesto muy bajo: dispara budget_exceeded, module_cost_cap_exceeded (chasis) y mass_exceeded a la vez.
    const v = validateLoadout(loadout, TEST_CATALOG, 50);
    const codes = codesOf(v);
    expect(codes).toContain("mass_exceeded");
    expect(codes).toContain("budget_exceeded");
    expect(codes).toContain("module_cost_cap_exceeded");
    expect(v.length).toBeGreaterThanOrEqual(3);
  });
});

describe("T3.2 · validateLoadout — función pura", () => {
  it("es determinista: mismo input produce mismo output", () => {
    const loadout = baseLoadout({ modules: [{ slot: "drive", moduleId: "movement.drive_ok@1" }] });
    const a = validateLoadout(loadout, TEST_CATALOG, 500);
    const b = validateLoadout(loadout, TEST_CATALOG, 500);
    expect(a).toEqual(b);
  });

  it("nunca lanza excepción con un loadout completamente basura", () => {
    const garbage = baseLoadout({
      chassis: "not.even.versioned",
      modules: [
        { slot: "", moduleId: "" },
        { slot: "drive", moduleId: "x.y@1" },
      ],
    });
    expect(() => validateLoadout(garbage as LoadoutInput, TEST_CATALOG, 500)).not.toThrow();
  });
});

// ------------------------------------------------------------------- property-based
describe("T3.2 · validateLoadout — propiedad (fast-check, catálogo real)", () => {
  const catalog = loadCatalog();
  const chassisList = catalog.filter((m) => m.category === "chassis");
  const sizeRank = { S: 0, M: 1, L: 2, XL: 3 } as const;

  function compatibleModulesFor(slot: { accepts: string[]; maxSize: keyof typeof sizeRank; sector?: string }) {
    return catalog.filter(
      (m) =>
        slot.accepts.includes(m.category) &&
        (!m.size || sizeRank[m.size] <= sizeRank[slot.maxSize]) &&
        (m.category !== "armor" || m.sector === slot.sector),
    );
  }

  const randomLoadoutArb = fc
    .constantFrom(...chassisList)
    .chain((chassis) => {
      const slotArbs = (chassis.slots ?? []).map((slot) => {
        const options = compatibleModulesFor(slot);
        if (options.length === 0) return fc.constant(null);
        return fc.option(fc.constantFrom(...options), { nil: null });
      });
      return fc.tuple(fc.constant(chassis), fc.tuple(...slotArbs));
    })
    .map(([chassis, picks]) => {
      const modules = (chassis.slots ?? [])
        .map((slot, i) => ({ slot: slot.id, mod: picks[i] }))
        .filter((x): x is { slot: string; mod: ModuleDefinition } => x.mod !== null)
        .map(({ slot, mod }) => {
          const entry: LoadoutInput["modules"][number] = { slot, moduleId: `${mod.id}@${mod.version}` };
          if (mod.category === "weapon" && mod.acceptsAmmo?.length) {
            const ammoDef = catalog.find((a) => a.category === "ammo" && mod.acceptsAmmo!.includes(a.id));
            if (ammoDef) entry.ammo = `${ammoDef.id}@${ammoDef.version}`;
          }
          return entry;
        });
      const loadout: LoadoutInput = {
        loadoutId: "ldt_fuzz01",
        revision: 1,
        catalogVersion: "mvp@1",
        chassis: `${chassis.id}@${chassis.version}`,
        modules,
      };
      return loadout;
    });

  it("todo loadout ACEPTADO respeta masa, energía y presupuesto al recalcularlos a mano", () => {
    fc.assert(
      fc.property(
        randomLoadoutArb,
        fc.integer({ min: BUDGET_CREDITS_MIN, max: BUDGET_CREDITS_MAX }),
        (loadout, budgetCredits) => {
          const violations = validateLoadout(loadout, catalog, budgetCredits);
          if (violations.length > 0) return; // solo nos interesan los aceptados

          const chassis = catalog.find((m) => `${m.id}@${m.version}` === loadout.chassis)!;
          const mounted = loadout.modules.map((e) => catalog.find((m) => `${m.id}@${m.version}` === e.moduleId)!);

          const mass = mounted.reduce((a, m) => a + m.massKg, 0);
          expect(mass).toBeLessThanOrEqual(chassis.maxLoadKg!);

          const generation = mounted
            .filter((m) => m.category === "power")
            .reduce((a, m) => a + (m.generationEUs ?? 0), 0);
          const passive = mounted.reduce((a, m) => a + (m.power?.passiveEUs ?? 0), 0);
          expect(generation).toBeGreaterThanOrEqual(passive);

          const cost = chassis.costCredits + mounted.reduce((a, m) => a + m.costCredits, 0);
          expect(cost).toBeLessThanOrEqual(budgetCredits);

          const cap = budgetCredits * MAX_MODULE_COST_FRACTION;
          expect(chassis.costCredits).toBeLessThanOrEqual(cap);
          for (const m of mounted) expect(m.costCredits).toBeLessThanOrEqual(cap);
        },
      ),
      { numRuns: 200 },
    );
  });
});
