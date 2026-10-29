/**
 * [AMMO-REVIEW] Diferencial validador ↔ motor sobre la regla arma ↔ munición.
 *
 * Para cada loadout generado: si validateLoadout da 0 violaciones, el vehículo que sale de
 * resolveVehicle tiene que poder disparar CADA arma (canFire ≠ no_ammo). Y al revés: si la
 * única objeción es `incompatible_ammo` sobre un ARMA, el motor no debe poder disparar
 * con esa arma (si no, es un falso positivo).
 *
 * Catálogo REAL (loadCatalog) y un catálogo sintético con un chasis de DOS torretas y
 * DOS bahías, que el MVP no tiene pero el validador y el resolutor admiten.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { validateLoadout, validateAmmo } from "./index.js";
import { loadCatalog } from "../loadCatalog.js";
import { resolveVehicle } from "../resolve/index.js";
import { ARCHETYPES } from "../resolve/archetypes.js";
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
const WEIRD_AMMO = [
  "ammo.ap@01",
  "ammo.ap@1.0",
  "ammo.ap@ 1",
  "AMMO.AP@1",
  " ammo.ap@1",
  "ammo.ap@9",
  "ammo.ap",
  "__proto__",
  "constructor@1",
  "mine.explosive@1",
  "weapon.mg@1",
];
const WEAPONS = ["weapon.cannon@1", "weapon.mg@1", "weapon.mg@2"];
const WEIRD_WEAPONS = ["weapon.cannon@01", "WEAPON.CANNON@1", "weapon.cannon@2", "weapon.mg@1.0"];

const optAmmo = fc.option(fc.constantFrom(...AMMO_IDS, ...WEIRD_AMMO), { nil: undefined });

const realLoadout = fc
  .record({
    chassis: fc.constantFrom("chassis.heavy@1", "chassis.medium@1", "chassis.medium@2", "chassis.light@1"),
    weapon: fc.option(fc.constantFrom(...WEAPONS, ...WEIRD_WEAPONS), { nil: undefined }),
    embedded: optAmmo,
    bayAmmo: optAmmo,
    baySlot: fc.constantFrom(
      "ammo_main",
      "AMMO_MAIN",
      " ammo_main",
      "sensor_b",
      "mine_bay",
      "__proto__",
      "turret_main",
    ),
    mine: fc.boolean(),
    order: fc.constantFrom("weapon-first", "ammo-first"),
  })
  .map((r): LoadoutInput => {
    const w: LoadoutModuleEntry[] = r.weapon
      ? [{ slot: "turret_main", moduleId: r.weapon, ...(r.embedded ? { ammo: r.embedded } : {}) }]
      : [];
    const a: LoadoutModuleEntry[] = r.bayAmmo ? [{ slot: r.baySlot, moduleId: r.bayAmmo }] : [];
    const mods = r.order === "weapon-first" ? [...w, ...a] : [...a, ...w];
    return {
      loadoutId: "x",
      revision: 1,
      catalogVersion: "mvp@1",
      chassis: r.chassis,
      modules: [
        { slot: "drive", moduleId: "movement.tracks@1" },
        { slot: "power", moduleId: "power.generator@2" },
        ...mods,
        ...(r.mine ? [{ slot: "mine_bay", moduleId: "mine.explosive@1" }] : []),
      ],
    };
  });

describe("diferencial validador ↔ motor · catálogo real", () => {
  it("0 violaciones ⇒ toda arma montada dispara (sin no_ammo)", () => {
    let valid = 0;
    fc.assert(
      fc.property(realLoadout, (l) => {
        const v = validateLoadout(l, CATALOG, BUDGET);
        if (v.length > 0) return true;
        valid++;
        for (const [slot, ok] of engineFire(l, CATALOG)) {
          if (!ok) throw new Error(`validador OK pero ${slot} no dispara: ${JSON.stringify(l.modules)}`);
        }
        return true;
      }),
      { numRuns: 3000, seed: 42 },
    );
    expect(valid).toBeGreaterThan(20);
  });

  it("incompatible_ammo sobre un arma ⇒ el motor tampoco la dispararía (sin falsos positivos)", () => {
    fc.assert(
      fc.property(realLoadout, (l) => {
        const v = validateLoadout(l, CATALOG, BUDGET);
        const weaponAmmo = v.filter((x) => x.code === "incompatible_ammo" && x.slot === "turret_main");
        if (weaponAmmo.length === 0 || v.length !== weaponAmmo.length) return true;
        let fire: Map<string, boolean>;
        try {
          fire = engineFire(l, CATALOG);
        } catch {
          return true; // el resolutor tampoco lo acepta
        }
        // Falso positivo sólo si el motor la dispara SEA CUAL SEA el orden de los módulos
        // (con munición embebida + módulo en la misma bahía, el resolutor pisa la ranura y
        // el resultado depende del orden: rechazarlo es lo correcto).
        const rev = { ...l, modules: [...l.modules].reverse() };
        if (fire.get("turret_main") && engineFire(rev, CATALOG).get("turret_main"))
          throw new Error(`falso positivo: ${JSON.stringify(l.modules)} → ${v[0]!.message}`);
        return true;
      }),
      { numRuns: 3000, seed: 7 },
    );
  });

  // P3: promete «Nunca lanza» y lanza TypeError con `ammo` no-string.
  it.fails("validateAmmo (pipeline) nunca lanza con entradas raras", () => {
    const weird = [{ slot: "turret_main", moduleId: "weapon.cannon@1", ammo: {} as unknown as string }];
    expect(() =>
      validateAmmo(
        { loadoutId: "x", revision: 1, catalogVersion: "mvp@1", chassis: "chassis.heavy@1", modules: weird },
        CATALOG,
      ),
    ).not.toThrow();
  });

  it("todos los arquetipos validan y disparan", () => {
    for (const [name, a] of Object.entries(ARCHETYPES)) {
      const l = { loadoutId: name, revision: 1, catalogVersion: "mvp@1", chassis: a.chassis, modules: a.modules };
      expect(validateLoadout(l, CATALOG, BUDGET), name).toEqual([]);
      for (const ok of engineFire(l, CATALOG).values()) expect(ok, name).toBe(true);
    }
  });
});

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
