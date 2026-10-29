/**
 * ELIG · Clasificador de elegibilidad (puro, sin BD) con el catálogo REAL mvp@1.
 * Regresión exacta del encargo: A-DEF v2 (cañón + ammo.standard) → NO elegible;
 * A-DEF v3 (cañón + ammo.ap) → elegible. Y la clasificación H4: sólo lo funcional y lo
 * malformado bloquea; el balance (presupuesto, masa…) se informa sin bloquear.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { loadCatalog } from "../../../packages/module-catalog/loadCatalog.js";
import {
  VIOLATION_CLASS,
  classifyViolations,
  clearEligibilityCache,
  evaluateLoadout,
} from "./services/version-eligibility.js";

const catalog = loadCatalog();
beforeEach(() => clearEligibilityCache());

type M = { slot: string; moduleId: string; ammo?: string };
const row = (chassis: string, modules: M[]) => ({
  catalog_version: "mvp@1",
  chassis,
  modules: JSON.stringify(modules),
});

/** Defensor de la cuenta del operador: rev 1 (v1/v2) y rev 2 (v3). */
const defender = (ammo: string, power: string) =>
  row("chassis.heavy@1", [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: power },
    { slot: "sensor_a", moduleId: "sensor.radar@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1" },
    { slot: "ammo_main", moduleId: ammo },
    { slot: "radio_a", moduleId: "radio.short@1" },
    { slot: "armor_front", moduleId: "armor.steel_front@1" },
  ]);
const attacker = row("chassis.medium@2", [
  { slot: "drive", moduleId: "movement.wheels@1" },
  { slot: "power", moduleId: "power.generator@2" },
  { slot: "sensor_a", moduleId: "sensor.radar@1" },
  { slot: "turret_main", moduleId: "weapon.cannon@1" },
  { slot: "ammo_main", moduleId: "ammo.ap@1" },
  { slot: "radio_a", moduleId: "radio.short@1" },
  { slot: "armor_front", moduleId: "armor.steel_front@1" },
]);
const scout = row("chassis.light@2", [
  { slot: "drive", moduleId: "movement.wheels@1" },
  { slot: "power", moduleId: "power.generator@2" },
  { slot: "sensor_a", moduleId: "sensor.radar@1" },
  { slot: "turret_main", moduleId: "weapon.mg@2" },
  { slot: "ammo_main", moduleId: "ammo.standard@1" },
  { slot: "radio_a", moduleId: "radio.short@1" },
]);
const prueba1 = row("chassis.heavy@1", [
  { slot: "drive", moduleId: "movement.wheels@1" },
  { slot: "power", moduleId: "power.generator@2" },
  { slot: "sensor_a", moduleId: "sensor.radar@1" },
  { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
  { slot: "ammo_main", moduleId: "ammo.ap@1" },
  { slot: "radio_a", moduleId: "radio.short@1" },
  { slot: "armor_front", moduleId: "armor.steel_front@1" },
]);

describe("regresión exacta A-DEF / B-DEF", () => {
  it("v1/v2 (cañón + ammo.standard@1) → NO elegible, INVALID_AMMO, motivo legible", () => {
    const e = evaluateLoadout(defender("ammo.standard@1", "power.generator@2"), catalog);
    expect(e.eligible).toBe(false);
    expect(e.reason).toBe("loadout_no_longer_valid");
    expect(e.category).toBe("INVALID_AMMO");
    expect(e.blocking).toHaveLength(1);
    expect(e.blocking[0]).toMatchObject({
      code: "incompatible_ammo",
      moduleId: "weapon.cannon",
      ammoId: "ammo.standard@1",
    });
    expect(e.message).toContain("se conserva para el histórico");
    expect(e.message).toContain("weapon.cannon@1 no admite ammo.standard@1");
    expect(e.suggestedAction).toMatch(/versión nueva/);
  });

  it("v3 (cañón + ammo.ap@1) → elegible", () => {
    const e = evaluateLoadout(defender("ammo.ap@1", "power.generator@1"), catalog);
    expect(e).toMatchObject({ eligible: true, category: "VALID", blocking: [] });
  });

  it("ATK, SCOUT y prueba1 de la cuenta → elegibles", () => {
    for (const r of [attacker, scout, prueba1]) {
      const e = evaluateLoadout(r, catalog);
      expect(e.eligible, JSON.stringify(e.blocking)).toBe(true);
    }
  });
});

describe("clasificación (H4/H15)", () => {
  it("arma sin munición → MISSING_AMMO; munición que nadie usa → ORPHAN_AMMO", () => {
    const noAmmo = evaluateLoadout(
      row("chassis.medium@1", [
        { slot: "drive", moduleId: "movement.wheels@1" },
        { slot: "power", moduleId: "power.battery@1" },
        { slot: "turret_main", moduleId: "weapon.cannon@1" },
      ]),
      catalog,
    );
    expect(noAmmo).toMatchObject({ eligible: false, category: "MISSING_AMMO" });
    const orphan = evaluateLoadout(
      row("chassis.light@2", [
        { slot: "drive", moduleId: "movement.wheels@1" },
        { slot: "power", moduleId: "power.generator@2" },
        { slot: "ammo_main", moduleId: "ammo.standard@1" },
      ]),
      catalog,
    );
    expect(orphan).toMatchObject({ eligible: false, category: "ORPHAN_AMMO" });
  });

  it("módulo inexistente o JSON ilegible → malformado, bloquea (OTHER_INVALID)", () => {
    const ghost = evaluateLoadout(row("chassis.medium@1", [{ slot: "drive", moduleId: "movement.ghost@9" }]), catalog);
    expect(ghost.eligible).toBe(false);
    expect(ghost.category).toBe("OTHER_INVALID");
    expect(ghost.blocking[0].class).toBe("malformed");
    const broken = evaluateLoadout({ catalog_version: "mvp@1", chassis: "chassis.medium@1", modules: "{no" }, catalog);
    expect(broken).toMatchObject({ eligible: false, category: "OTHER_INVALID" });
  });

  it("catálogo no disponible → UNKNOWN, no elegible (no se puede verificar)", () => {
    const e = evaluateLoadout(attacker, []);
    expect(e).toMatchObject({ eligible: false, reason: "loadout_unverifiable", category: "UNKNOWN" });
  });

  it("una regla de BALANCE (presupuesto, masa, energía…) NO invalida automáticamente", () => {
    for (const code of [
      "budget_exceeded",
      "module_cost_cap_exceeded",
      "mass_exceeded",
      "energy_deficit",
      "duplicate_limit_exceeded",
      "category_forbidden_by_ruleset",
    ] as const) {
      const e = classifyViolations([{ code, message: code }]);
      expect(e.eligible, code).toBe(true);
      expect(e.warnings.map((w) => w.code)).toEqual([code]);
    }
  });

  it("toda clase funcional/malformada bloquea; un código desconocido falla cerrado", () => {
    for (const [code, cls] of Object.entries(VIOLATION_CLASS)) {
      const e = classifyViolations([{ code: code as never, message: code }]);
      expect(e.eligible, code).toBe(cls === "balance");
    }
    expect(classifyViolations([{ code: "nueva_regla_futura" as never, message: "x" }]).eligible).toBe(false);
  });

  it("la evaluación no modifica el loadout recibido", () => {
    const r = defender("ammo.standard@1", "power.generator@2");
    const before = JSON.stringify(r);
    evaluateLoadout(r, catalog);
    expect(JSON.stringify(r)).toBe(before);
  });
});
