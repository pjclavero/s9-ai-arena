/**
 * T3.1 · DoD: todo módulo valida contra module.schema.json, ninguna referencia
 * (acceptsAmmo, requiresChassis) apunta a un id inexistente, y existe al menos
 * un loadout legal por chasis dentro de presupuesto/masa/energía por defecto.
 */
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog, DATA_DIR, CATALOG_VERSION } from "./loadCatalog.js";
import { validateLoadout } from "./validator/index.js";
import { BUDGET_CREDITS_MVP } from "../game-rules/index.js";
import type { LoadoutInput } from "./types.js";

const SCHEMA_PATH = join(DATA_DIR, "..", "schema", "module.schema.json");
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validateModule = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")));

const catalog = loadCatalog();

describe("T3.1 · catálogo v1 — validación de esquema", () => {
  it("carga al menos 20 módulos", () => {
    expect(catalog.length).toBeGreaterThanOrEqual(20);
  });

  for (const m of loadCatalog()) {
    it(`${m.id}@${m.version} valida contra module.schema.json`, () => {
      // `: boolean` evita que el type-predicate de Ajv estreche `m` a `never` en la
      // rama !ok (2 errores de tsc de H7, issue #11); misma semántica.
      const ok: boolean = validateModule(m);
      if (!ok) {
        throw new Error(
          `${m.id}@${m.version}: ${JSON.stringify(validateModule.errors, null, 2)}`,
        );
      }
      expect(ok).toBe(true);
    });
  }

  it("ningún id de módulo está duplicado (misma id@version dos veces)", () => {
    const seen = new Set<string>();
    for (const m of catalog) {
      const key = `${m.id}@${m.version}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe("T3.1 · integridad referencial", () => {
  const byBaseId = new Set(catalog.map((m) => m.id));

  it("acceptsAmmo de toda arma referencia un id base de munición existente en el catálogo", () => {
    const weapons = catalog.filter((m) => m.category === "weapon");
    expect(weapons.length).toBeGreaterThan(0);
    for (const w of weapons) {
      expect(w.acceptsAmmo && w.acceptsAmmo.length).toBeTruthy();
      for (const ammoBaseId of w.acceptsAmmo!) {
        expect(byBaseId.has(ammoBaseId), `${w.id} referencia ${ammoBaseId}, inexistente`).toBe(true);
        const ammoMod = catalog.find((m) => m.id === ammoBaseId);
        expect(ammoMod?.category).toBe("ammo");
      }
    }
  });

  it("requiresChassis de todo módulo referencia un id base de chasis existente en el catálogo", () => {
    for (const m of catalog) {
      if (!m.requiresChassis) continue;
      for (const chassisBaseId of m.requiresChassis) {
        expect(byBaseId.has(chassisBaseId), `${m.id} referencia ${chassisBaseId}, inexistente`).toBe(true);
        const chassisMod = catalog.find((mm) => mm.id === chassisBaseId);
        expect(chassisMod?.category).toBe("chassis");
      }
    }
  });

  it("todo slot de blindaje de todo chasis tiene sector, y viceversa ningún otro slot lo tiene", () => {
    for (const c of catalog.filter((m) => m.category === "chassis")) {
      for (const s of c.slots ?? []) {
        const isArmorSlot = s.accepts.includes("armor");
        expect(Boolean(s.sector), `${c.id}:${s.id}`).toBe(isArmorSlot);
      }
    }
  });
});

// ---------------------------------------------------------------- loadouts legales
/** Construye un loadout mínimo pero completo para un chasis, con los módulos base del catálogo. */
function loadoutFor(chassisId: string): LoadoutInput {
  const modules: LoadoutInput["modules"] = [];
  if (chassisId === "chassis.light") {
    modules.push(
      { slot: "drive", moduleId: "movement.wheels@1" },
      { slot: "power", moduleId: "power.battery@1" },
      { slot: "sensor_a", moduleId: "sensor.lidar_front@1" },
      { slot: "turret_main", moduleId: "weapon.mg@1", ammo: "ammo.standard@1" },
      { slot: "ammo_main", moduleId: "ammo.standard@1" },
      { slot: "radio_a", moduleId: "radio.short@1" },
    );
  } else if (chassisId === "chassis.medium") {
    modules.push(
      { slot: "drive", moduleId: "movement.tracks@1" },
      { slot: "power", moduleId: "power.generator@1" },
      { slot: "sensor_a", moduleId: "sensor.radar@1" },
      { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
      { slot: "ammo_main", moduleId: "ammo.ap@1" },
      { slot: "armor_front", moduleId: "armor.steel_front@1" },
      { slot: "radio_a", moduleId: "radio.short@1" },
    );
  } else if (chassisId === "chassis.heavy") {
    modules.push(
      { slot: "drive", moduleId: "movement.tracks@1" },
      { slot: "power", moduleId: "power.generator@1" },
      { slot: "sensor_a", moduleId: "sensor.lidar360@1" },
      { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
      { slot: "ammo_main", moduleId: "ammo.ap@1" },
      { slot: "armor_front", moduleId: "armor.steel_front@1" },
    );
  } else {
    throw new Error(`sin fixture de loadout para ${chassisId}`);
  }
  return {
    loadoutId: `ldt_${chassisId.split(".")[1]}01`,
    revision: 1,
    catalogVersion: CATALOG_VERSION,
    chassis: `${chassisId}@1`,
    modules,
  };
}

describe("T3.1 · al menos un loadout legal por chasis (budget/masa/energía por defecto)", () => {
  for (const chassisId of ["chassis.light", "chassis.medium", "chassis.heavy"]) {
    it(`${chassisId}: existe un loadout legal con BUDGET_CREDITS_MVP`, () => {
      const loadout = loadoutFor(chassisId);
      const violations = validateLoadout(loadout, catalog, BUDGET_CREDITS_MVP);
      expect(violations, JSON.stringify(violations)).toEqual([]);
    });
  }
});
