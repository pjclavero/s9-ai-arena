/**
 * T3.2 · DoD: "instancia la MISMA función desde apps/arena-engine, con ruta relativa
 * real, para demostrar que motor y validador comparten código, no una copia."
 *
 * Este test no reimplementa nada: importa validateLoadout directamente del paquete
 * de E3. Si algún día el motor necesitara validar un loadout en tiempo real (por
 * ejemplo, al aceptar un WebSocket HELLO con un loadout adjunto), sería este mismo
 * import el que usaría — no una copia mantenida en dos sitios.
 */
import { describe, expect, it } from "vitest";
import { validateLoadout } from "../../../packages/module-catalog/validator/index.js";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";
import { BUDGET_CREDITS_MVP } from "../../../packages/game-rules/index.js";
import type { LoadoutInput } from "../../../packages/module-catalog/types.js";

describe("T3.2 · el motor y el validador comparten la misma función (no una copia)", () => {
  it("valida un loadout real del catálogo de E3 importándolo con una ruta relativa real", () => {
    const catalog = loadCatalog();
    const loadout: LoadoutInput = {
      loadoutId: "ldt_crossimport",
      revision: 1,
      catalogVersion: CATALOG_VERSION,
      chassis: "chassis.medium@1",
      modules: [
        { slot: "drive", moduleId: "movement.tracks@1" },
        { slot: "power", moduleId: "power.generator@1" },
        { slot: "sensor_a", moduleId: "sensor.radar@1" },
        { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
        { slot: "ammo_main", moduleId: "ammo.ap@1" },
        { slot: "armor_front", moduleId: "armor.steel_front@1" },
        { slot: "radio_a", moduleId: "radio.short@1" },
      ],
    };

    const violations = validateLoadout(loadout, catalog, BUDGET_CREDITS_MVP);
    expect(violations).toEqual([]);
  });

  it("el mismo import rechaza un loadout que rompe el techo de coste por módulo", () => {
    const catalog = loadCatalog();
    const loadout: LoadoutInput = {
      loadoutId: "ldt_crossimport_bad",
      revision: 1,
      catalogVersion: CATALOG_VERSION,
      chassis: "chassis.light@1",
      modules: [{ slot: "turret_main", moduleId: "weapon.cannon@1" }], // size L no cabe en turret M de chassis.light
    };
    const violations = validateLoadout(loadout, catalog, BUDGET_CREDITS_MVP);
    expect(violations[0]?.code).toBe("slot_size_exceeded");
  });
});
