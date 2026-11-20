/**
 * Compatibilidad arma ↔ munición (bug de producción RC5.2, 2026-10-29).
 *
 * Los defensores v2 montaban `weapon.cannon@1` y `ammo.standard@1` como MÓDULO aparte
 * (forma heredada). validateLoadout sólo cruzaba el arma con su munición cuando ésta iba
 * como propiedad del arma (`ammo:`), así que el loadout pasaba con 0 violaciones y en
 * batalla el cañón rechazaba cada disparo con `no_ammo` (combat.ammoFor sólo usa
 * munición cuyo tipo base esté en `acceptsAmmo`).
 *
 * La regla se comprueba contra el CATÁLOGO REAL (loadCatalog), no contra listas copiadas:
 * si mañana un arma acepta otra munición, la matriz la cubre sola.
 */
import { describe, expect, it } from "vitest";
import { validateAmmo, validateLoadout, type Violation } from "./index.js";
import { loadCatalog } from "../loadCatalog.js";
import type { LoadoutInput, ModuleDefinition } from "../types.js";

const CATALOG = loadCatalog();
const vid = (m: ModuleDefinition) => `${m.id}@${m.version}`;
const ammoCodes = (v: Violation[]) => v.filter((x) => x.code === "incompatible_ammo");

/** Defensor v2 de producción con la munición cambiada. Presupuesto holgado: aquí sólo se mira la munición. */
function defender(ammo: string, form: "module" | "embedded" = "module"): LoadoutInput {
  return {
    loadoutId: "def",
    revision: 1,
    catalogVersion: "mvp@1",
    chassis: "chassis.heavy@1",
    modules: [
      { slot: "drive", moduleId: "movement.tracks@1" },
      { slot: "power", moduleId: "power.generator@2" },
      { slot: "sensor_a", moduleId: "sensor.radar@1" },
      form === "embedded"
        ? { slot: "turret_main", moduleId: "weapon.cannon@1", ammo }
        : { slot: "turret_main", moduleId: "weapon.cannon@1" },
      ...(form === "module" ? [{ slot: "ammo_main", moduleId: ammo }] : []),
      { slot: "radio_a", moduleId: "radio.short@1" },
      { slot: "armor_front", moduleId: "armor.steel_front@1" },
    ],
  };
}

describe("regresión exacta del bug: cañón + munición estándar como módulo aparte", () => {
  it("INVALID: weapon.cannon@1 + ammo.standard@1 (módulo aparte) → incompatible_ammo", () => {
    const v = ammoCodes(validateLoadout(defender("ammo.standard@1"), CATALOG, 1200));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      code: "incompatible_ammo",
      slot: "turret_main",
      moduleId: "weapon.cannon",
      ammoId: "ammo.standard@1",
      acceptedAmmo: ["ammo.ap", "ammo.he"],
    });
    expect(v[0]!.message).toBe(
      "El módulo weapon.cannon@1 no admite ammo.standard@1. Municiones compatibles: ammo.ap, ammo.he.",
    );
  });

  it("INVALID también en la forma embebida (ammo: en el arma)", () => {
    const v = ammoCodes(validateLoadout(defender("ammo.standard@1", "embedded"), CATALOG, 1200));
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toBe(
      "El módulo weapon.cannon@1 no admite ammo.standard@1. Municiones compatibles: ammo.ap, ammo.he.",
    );
  });

  for (const ammo of ["ammo.ap@1", "ammo.he@1"]) {
    for (const form of ["module", "embedded"] as const) {
      it(`VALID: weapon.cannon@1 + ${ammo} (${form === "module" ? "módulo aparte" : "embebida"}) → sin violaciones`, () => {
        expect(validateLoadout(defender(ammo, form), CATALOG, 1200)).toEqual([]);
      });
    }
  }
});

// ---------------------------------------------------------------- matriz derivada del catálogo
const weapons = CATALOG.filter((m) => m.category === "weapon" && (m.acceptsAmmo?.length ?? 0) > 0);
const ammos = CATALOG.filter((m) => m.category === "ammo");
const chassisList = CATALOG.filter((m) => m.category === "chassis" && m.slots);
const SIZE: Record<string, number> = { S: 0, M: 1, L: 2, XL: 3 };

/** Primer chasis del catálogo con ranura de arma que admita el tamaño y una bahía de munición. */
function hostFor(w: ModuleDefinition) {
  for (const c of chassisList) {
    if (w.requiresChassis && !w.requiresChassis.includes(c.id)) continue;
    const t = c.slots!.find((s) => s.accepts.includes("weapon") && SIZE[w.size ?? "S"]! <= SIZE[s.maxSize]!);
    const a = c.slots!.find((s) => s.accepts.includes("ammo"));
    if (t && a) return { chassis: vid(c), turret: t.id, bay: a.id };
  }
  return null;
}

describe("matriz ARMA × MUNICIÓN del catálogo real", () => {
  it("el catálogo tiene armas con munición y municiones (si no, la matriz no prueba nada)", () => {
    expect(weapons.length).toBeGreaterThan(0);
    expect(ammos.length).toBeGreaterThan(1);
  });

  for (const w of weapons) {
    const host = hostFor(w);
    it(`${vid(w)} tiene un chasis del catálogo donde montarlo`, () => expect(host).not.toBeNull());
    if (!host) continue;
    for (const a of ammos) {
      const compatible = w.acceptsAmmo!.includes(a.id);
      for (const form of ["module", "embedded"] as const) {
        it(`${vid(w)} × ${vid(a)} (${form}) → ${compatible ? "válido" : "incompatible_ammo"}`, () => {
          const loadout: LoadoutInput = {
            loadoutId: "m",
            revision: 1,
            catalogVersion: "mvp@1",
            chassis: host.chassis,
            modules:
              form === "module"
                ? [
                    { slot: host.turret, moduleId: vid(w) },
                    { slot: host.bay, moduleId: vid(a) },
                  ]
                : [{ slot: host.turret, moduleId: vid(w), ammo: vid(a) }],
          };
          // Presupuesto enorme: sólo interesa la regla de munición (energía/masa no se miran).
          const v = ammoCodes(validateLoadout(loadout, CATALOG, 1_000_000));
          if (compatible) expect(v).toEqual([]);
          else {
            expect(v).toHaveLength(1);
            expect(v[0]!.acceptedAmmo).toEqual(w.acceptsAmmo);
            expect(v[0]!.ammoId).toBe(vid(a));
          }
          // La misma regla, por la entrada que usa el pipeline de build.
          expect(ammoCodes(validateAmmo(loadout, CATALOG))).toEqual(v);
        });
      }
    }
  }
});

// ---------------------------------------------------------------- casos límite (catálogo sintético)
const C: ModuleDefinition[] = [
  {
    id: "chassis.two_guns",
    version: 1,
    category: "chassis",
    massKg: 100,
    costCredits: 10,
    hullHp: 100,
    radiusM: 1,
    maxLoadKg: 10_000,
    slots: [
      { id: "t1", accepts: ["weapon"], maxSize: "M" },
      { id: "t2", accepts: ["weapon"], maxSize: "M" },
      { id: "a1", accepts: ["ammo"], maxSize: "M" },
      { id: "a2", accepts: ["ammo"], maxSize: "M" },
      { id: "bay", accepts: ["mine"], maxSize: "M" },
    ],
  } as ModuleDefinition,
  {
    id: "weapon.gun",
    version: 1,
    category: "weapon",
    size: "S",
    massKg: 1,
    costCredits: 1,
    acceptsAmmo: ["ammo.x", "ammo.y"],
  } as ModuleDefinition,
  {
    id: "weapon.mg",
    version: 1,
    category: "weapon",
    size: "S",
    massKg: 1,
    costCredits: 1,
    acceptsAmmo: ["ammo.z"],
  } as ModuleDefinition,
  { id: "weapon.laser", version: 1, category: "weapon", size: "S", massKg: 1, costCredits: 1 } as ModuleDefinition,
  { id: "ammo.x", version: 1, category: "ammo", size: "S", massKg: 1, costCredits: 1 } as ModuleDefinition,
  { id: "ammo.y", version: 2, category: "ammo", size: "S", massKg: 1, costCredits: 1 } as ModuleDefinition,
  { id: "ammo.z", version: 1, category: "ammo", size: "S", massKg: 1, costCredits: 1 } as ModuleDefinition,
  { id: "mine.m", version: 1, category: "mine", size: "S", massKg: 1, costCredits: 1 } as ModuleDefinition,
];
const L = (modules: LoadoutInput["modules"]): LoadoutInput => ({
  loadoutId: "e",
  revision: 1,
  catalogVersion: "test@1",
  chassis: "chassis.two_guns@1",
  modules,
});
const amm = (modules: LoadoutInput["modules"]) => ammoCodes(validateLoadout(L(modules), C, 1_000_000));

describe("casos límite de la regla de munición", () => {
  it("arma que consume munición SIN ninguna munición → incompatible_ammo con las compatibles", () => {
    const v = amm([{ slot: "t1", moduleId: "weapon.gun@1" }]);
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toBe(
      "El módulo weapon.gun@1 necesita munición y no lleva ninguna. Municiones compatibles: ammo.x, ammo.y.",
    );
    expect(v[0]!.ammoId).toBeUndefined();
  });

  it("arma que NO usa munición (sin acceptsAmmo) → la regla no aplica", () => {
    expect(amm([{ slot: "t1", moduleId: "weapon.laser@1" }])).toEqual([]);
  });

  it("munición sin ningún arma → incompatible_ammo sobre la munición", () => {
    const v = amm([{ slot: "a1", moduleId: "ammo.x@1" }]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ slot: "a1", moduleId: "ammo.x", ammoId: "ammo.x@1" });
    expect(v[0]!.message).toBe("ammo.x@1 está montada pero ningún arma del vehículo la usa.");
  });

  it("mina sin munición → no aplica (no es un arma que consuma munición)", () => {
    expect(amm([{ slot: "bay", moduleId: "mine.m@1" }])).toEqual([]);
  });

  it("dos armas, cada una con su munición compatible → válido", () => {
    expect(
      amm([
        { slot: "t1", moduleId: "weapon.gun@1" },
        { slot: "t2", moduleId: "weapon.mg@1" },
        { slot: "a1", moduleId: "ammo.x@1" },
        { slot: "a2", moduleId: "ammo.z@1" },
      ]),
    ).toEqual([]);
  });

  it("dos armas y una sola munición que sirve sólo a una → la otra se rechaza", () => {
    const v = amm([
      { slot: "t1", moduleId: "weapon.gun@1" },
      { slot: "t2", moduleId: "weapon.mg@1" },
      { slot: "a1", moduleId: "ammo.x@1" },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ slot: "t2", moduleId: "weapon.mg", ammoId: "ammo.x@1", acceptedAmmo: ["ammo.z"] });
  });

  it("varias municiones compatibles con la misma arma → válido", () => {
    expect(
      amm([
        { slot: "t1", moduleId: "weapon.gun@1" },
        { slot: "a1", moduleId: "ammo.x@1" },
        { slot: "a2", moduleId: "ammo.y@2" },
      ]),
    ).toEqual([]);
  });

  it("una compatible y otra que no usa ningún arma → se rechaza sólo la sobrante", () => {
    const v = amm([
      { slot: "t1", moduleId: "weapon.gun@1" },
      { slot: "a1", moduleId: "ammo.x@1" },
      { slot: "a2", moduleId: "ammo.z@1" },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ slot: "a2", ammoId: "ammo.z@1" });
    expect(v[0]!.message).toBe("Ningún arma del vehículo admite ammo.z@1 (weapon.gun@1 admite ammo.x, ammo.y).");
  });

  it("varias municiones, ninguna compatible → un solo error en el arma (no uno por munición)", () => {
    const v = amm([
      { slot: "t1", moduleId: "weapon.gun@1" },
      { slot: "a1", moduleId: "ammo.z@1" },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toBe("El módulo weapon.gun@1 no admite ammo.z@1. Municiones compatibles: ammo.x, ammo.y.");
  });

  it("la compatibilidad va por tipo base: cualquier versión de una munición aceptada vale", () => {
    expect(amm([{ slot: "t1", moduleId: "weapon.gun@1", ammo: "ammo.y@2" }])).toEqual([]);
  });

  it("munición embebida inexistente → incompatible_ammo (y no cuenta como munición del arma)", () => {
    const v = amm([{ slot: "t1", moduleId: "weapon.gun@1", ammo: "ammo.ghost@1" }]);
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toBe("Munición desconocida asignada a t1: ammo.ghost@1");
  });

  it("munición embebida en un arma que no la admite, aunque otra arma sí → se rechaza (va ligada a su arma)", () => {
    const v = amm([
      { slot: "t1", moduleId: "weapon.gun@1", ammo: "ammo.z@1" },
      { slot: "t2", moduleId: "weapon.mg@1" },
    ]);
    // La munición rechazada no cuenta para nadie: la ametralladora se queda sin munición.
    expect(v.map((x) => x.slot)).toEqual(["t1", "t2"]);
    expect(v[1]!.message).toBe(
      "El módulo weapon.mg@1 necesita munición y no lleva ninguna. Municiones compatibles: ammo.z.",
    );
  });

  it("módulo inexistente en el catálogo: lo informa unknown_slot y la regla de munición no inventa nada", () => {
    const v = validateLoadout(L([{ slot: "t1", moduleId: "weapon.ghost@1" }]), C, 1_000_000);
    expect(v.map((x) => x.code)).toEqual(["unknown_slot"]);
  });

  it("un arma rechazada por ranura no genera además un error de munición", () => {
    const v = validateLoadout(L([{ slot: "a1", moduleId: "weapon.gun@1" }]), C, 1_000_000);
    expect(v.map((x) => x.code)).toEqual(["slot_type_mismatch"]);
  });

  it("validateAmmo nunca lanza con basura", () => {
    expect(() => validateAmmo({ modules: [{ slot: 1, moduleId: null }] } as unknown as LoadoutInput, C)).not.toThrow();
  });
});

describe("la regla no rompe otras validaciones", () => {
  it("presupuesto: el defensor v3 real (cañón + AP + generator@1) cabe en 1000 y es válido", () => {
    const v3 = defender("ammo.ap@1");
    v3.modules = v3.modules.map((m) => (m.slot === "power" ? { ...m, moduleId: "power.generator@1" } : m));
    expect(validateLoadout(v3, CATALOG, 1000)).toEqual([]);
  });

  it("presupuesto: el mismo con generator@2 se pasa (1015 > 1000) y sólo da budget_exceeded", () => {
    expect(validateLoadout(defender("ammo.ap@1"), CATALOG, 1000).map((x) => x.code)).toEqual(["budget_exceeded"]);
  });

  it("ranura inválida y energía insuficiente siguen informándose junto al error de munición", () => {
    const bad = defender("ammo.standard@1");
    bad.modules = [
      ...bad.modules.filter((m) => m.slot !== "power"),
      { slot: "no_such_slot", moduleId: "radio.short@1" },
    ];
    const codes = validateLoadout(bad, CATALOG, 1200).map((x) => x.code);
    expect(codes).toContain("unknown_slot");
    expect(codes).toContain("energy_deficit");
    expect(codes).toContain("incompatible_ammo");
  });
});

describe("entradas malformadas (las filtra el esquema de la API, pero la regla no debe lanzar)", () => {
  it("ammo que no es texto → incompatible_ammo, sin excepción, por las dos entradas", () => {
    const bad = L([{ slot: "t1", moduleId: "weapon.gun@1", ammo: {} as unknown as string }]);
    expect(() => validateAmmo(bad, C)).not.toThrow();
    expect(validateAmmo(bad, C).map((v) => v.code)).toContain("incompatible_ammo");
    expect(() => validateLoadout(bad, C, 1_000_000)).not.toThrow();
    expect(ammoCodes(validateLoadout(bad, C, 1_000_000))[0]).toMatchObject({ slot: "t1" });
  });
});
