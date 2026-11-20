// RESCATE B3 (2026-11) · origen: PR #194 (rama review/ammo, commit b6a83555), test de revisión no integrado.
// Verificado contra main 8f380eb; mutante asociado en scripts/rescue-mutants.{json,mjs} (M03c, fix-flip).
/**
 * [AMMO-REVIEW] Diferencial validador ↔ motor sobre la regla arma ↔ munición, SÓLO el caso que
 * main no cubre: un chasis sintético de DOS torretas y DOS bahías (el MVP no lo tiene, pero el
 * validador y el resolutor lo admiten). Seguimiento: issue #197.
 *
 * Poda de la ronda 2: la parte sobre el catálogo real (0 violaciones ⇒ dispara; sin falsos
 * positivos; `ammo` no-texto; arquetipos) la matan igual `ammo-compat`, `loadout-ammo`,
 * `ammo-loadout-regression` y `combat` de main, así que se quitó del fichero.
 *
 * Los dos `it.fails` documentan un defecto latente y se ponen ROJOS al repararlo (M03c lo
 * demuestra: con la reparación ambos fallan; los tests de main siguen verdes con ella).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { validateLoadout } from "./index.js";
import { loadCatalog } from "../loadCatalog.js";
import { resolveVehicle } from "../resolve/index.js";
import { Vehicle } from "../../../apps/arena-engine/src/sim/vehicle.js";
import { canFire } from "../../../apps/arena-engine/src/sim/combat.js";
import { Rng } from "../../../apps/arena-engine/src/rng.js";
import type { LoadoutInput, LoadoutModuleEntry, ModuleDefinition } from "../types.js";

const CATALOG = loadCatalog();
const BUDGET = 1e9;

/** Para cada ranura de arma del loadout: ¿el motor la deja disparar (munición)? */
function engineFire(loadout: LoadoutInput, catalog: ModuleDefinition[]): Map<string, boolean> {
  const spec = resolveVehicle(loadout, catalog);
  const v = new Vehicle("v", "a", "b", spec);
  v.energyEU = 1e9;
  const out = new Map<string, boolean>();
  for (const [slot, m] of v.modules) {
    if (m.spec.category !== "weapon") continue;
    out.set(slot, canFire(v, slot, 0, new Rng(1)) !== "no_ammo");
  }
  return out;
}

const AMMO_IDS = ["ammo.ap@1", "ammo.he@1", "ammo.standard@1"];
const WEAPONS = ["weapon.cannon@1", "weapon.mg@1", "weapon.mg@2"];

// --------------------------------------------------------------- catálogo sintético
const TWIN: ModuleDefinition = {
  ...(CATALOG.find((m) => m.id === "chassis.heavy" && m.version === 1) as ModuleDefinition),
  id: "chassis.twin",
  version: 1,
  slots: [
    { id: "drive", accepts: ["movement"], maxSize: "XL" },
    { id: "power", accepts: ["power"], maxSize: "L" },
    { id: "turret_a", accepts: ["weapon"], maxSize: "XL" },
    { id: "turret_b", accepts: ["weapon"], maxSize: "XL" },
    { id: "ammo_a", accepts: ["ammo"], maxSize: "L" },
    { id: "ammo_b", accepts: ["ammo"], maxSize: "L" },
  ],
} as ModuleDefinition;
const SYN = [...CATALOG, TWIN].map((m) => (m.category === "weapon" ? { ...m, maxPerVehicle: undefined } : m));

const twinLoadout = fc
  .record({
    wa: fc.option(fc.constantFrom(...WEAPONS), { nil: undefined }),
    wb: fc.option(fc.constantFrom(...WEAPONS), { nil: undefined }),
    ea: fc.option(fc.constantFrom(...AMMO_IDS), { nil: undefined }),
    eb: fc.option(fc.constantFrom(...AMMO_IDS), { nil: undefined }),
    aa: fc.option(fc.constantFrom(...AMMO_IDS), { nil: undefined }),
    ab: fc.option(fc.constantFrom(...AMMO_IDS), { nil: undefined }),
    perm: fc.shuffledSubarray([0, 1, 2, 3], { minLength: 4, maxLength: 4 }),
  })
  .map((r): LoadoutInput => {
    const parts: (LoadoutModuleEntry | null)[] = [
      r.wa ? { slot: "turret_a", moduleId: r.wa, ...(r.ea ? { ammo: r.ea } : {}) } : null,
      r.wb ? { slot: "turret_b", moduleId: r.wb, ...(r.eb ? { ammo: r.eb } : {}) } : null,
      r.aa ? { slot: "ammo_a", moduleId: r.aa } : null,
      r.ab ? { slot: "ammo_b", moduleId: r.ab } : null,
    ];
    const mods = r.perm.map((i) => parts[i]).filter((x): x is LoadoutModuleEntry => x !== null);
    return {
      loadoutId: "t",
      revision: 1,
      catalogVersion: "syn@1",
      chassis: "chassis.twin@1",
      modules: [
        { slot: "drive", moduleId: "movement.tracks@1" },
        { slot: "power", moduleId: "power.generator@2" },
        ...mods,
      ],
    };
  });

describe("diferencial validador ↔ motor · chasis sintético de dos torretas", () => {
  // P2 LATENTE: el resolutor materializa la munición embebida en la PRIMERA bahía y un
  // módulo explícito en esa misma bahía la pisa (Map por ranura en Vehicle). Hoy el MVP
  // tiene una sola torreta y no es alcanzable; con dos, el validador da 0 violaciones y
  // un arma no dispara. it.fails = documenta la divergencia; se pone rojo si se corrige.
  it.fails("0 violaciones ⇒ toda arma montada dispara", () => {
    fc.assert(
      fc.property(twinLoadout, (l) => {
        if (validateLoadout(l, SYN, BUDGET).length > 0) return true;
        for (const [slot, ok] of engineFire(l, SYN)) {
          if (!ok) throw new Error(`validador OK pero ${slot} no dispara: ${JSON.stringify(l.modules)}`);
        }
        return true;
      }),
      { numRuns: 5000, seed: 3 },
    );
  });

  it.fails("caso mínimo: mg con munición embebida + munición explícita en la bahía donde se materializa", () => {
    const l: LoadoutInput = {
      loadoutId: "t",
      revision: 1,
      catalogVersion: "syn@1",
      chassis: "chassis.twin@1",
      modules: [
        { slot: "drive", moduleId: "movement.tracks@1" },
        { slot: "power", moduleId: "power.generator@2" },
        { slot: "turret_a", moduleId: "weapon.mg@1", ammo: "ammo.standard@1" },
        { slot: "ammo_a", moduleId: "ammo.he@1" },
        { slot: "turret_b", moduleId: "weapon.cannon@1" },
      ],
    };
    expect(validateLoadout(l, SYN, BUDGET)).toEqual([]);
    expect(Object.fromEntries(engineFire(l, SYN))).toEqual({ turret_a: true, turret_b: true });
  });
});
