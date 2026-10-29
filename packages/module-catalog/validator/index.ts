/**
 * T3.2 · Validador de ensamblaje de loadouts (cap. 10.2).
 *
 * Función pura: mismo input, mismo output, sin leer disco ni red. El catálogo llega
 * ya cargado (packages/module-catalog/loadCatalog.ts es responsabilidad del llamador,
 * NO de este módulo). budgetCredits SIEMPRE es un parámetro — D7 prohíbe leer
 * BUDGET_CREDITS_MVP aquí salvo que el propio llamador decida pasarlo como valor por
 * defecto (ver test de constructivos en ../data.test.ts).
 */
import { MAX_MODULE_COST_FRACTION, safeLookup } from "../../game-rules/index.js";
import {
  findModule,
  splitVersioned,
  type LoadoutInput,
  type ModuleCategory,
  type ModuleDefinition,
  type Size,
} from "../types.js";

export interface Violation {
  code:
    | "slot_type_mismatch"
    | "slot_size_exceeded"
    | "unknown_slot"
    | "duplicate_slot"
    | "mass_exceeded"
    | "energy_deficit"
    | "budget_exceeded"
    | "incompatible_ammo"
    | "incompatible_chassis"
    | "duplicate_limit_exceeded"
    | "category_forbidden_by_ruleset"
    | "module_cost_cap_exceeded";
  moduleId?: string;
  slot?: string;
  message: string;
  /** incompatible_ammo: munición (versionada) que no encaja, si la hay. */
  ammoId?: string;
  /** incompatible_ammo: tipos base de munición que admite el arma afectada. */
  acceptedAmmo?: string[];
}

const SIZE_RANK: Record<Size, number> = { S: 0, M: 1, L: 2, XL: 3 };

interface Accepted {
  slot: string;
  moduleDef: ModuleDefinition;
  ammo?: string;
}

/**
 * Valida un loadout contra un catálogo congelado y un presupuesto concreto.
 * Nunca lanza excepción: un loadout inválido es un resultado esperado (lista de
 * violaciones), no un error de programación.
 */
export function validateLoadout(
  loadout: LoadoutInput,
  catalog: ModuleDefinition[],
  budgetCredits: number,
  forbiddenCategories: ModuleCategory[] = [],
): Violation[] {
  const violations: Violation[] = [];

  const chassisDef = findModule(catalog, loadout.chassis);
  if (!chassisDef || chassisDef.category !== "chassis" || !chassisDef.slots) {
    violations.push({
      code: "incompatible_chassis",
      moduleId: loadout.chassis,
      message: `Chasis desconocido o inválido en el catálogo: ${loadout.chassis}`,
    });
    return violations;
  }

  const slotsById = new Map(chassisDef.slots.map((s) => [s.id, s]));
  const accepted: Accepted[] = [];
  const seenSlots = new Set<string>();

  for (const entry of loadout.modules) {
    if (seenSlots.has(entry.slot)) {
      violations.push({
        code: "duplicate_slot",
        slot: entry.slot,
        moduleId: entry.moduleId,
        message: `Ranura repetida en el loadout: ${entry.slot}`,
      });
      continue;
    }
    seenSlots.add(entry.slot);

    const slotDef = slotsById.get(entry.slot);
    if (!slotDef) {
      violations.push({
        code: "unknown_slot",
        slot: entry.slot,
        moduleId: entry.moduleId,
        message: `${chassisDef.id} no tiene ninguna ranura llamada "${entry.slot}"`,
      });
      continue;
    }

    const moduleDef = findModule(catalog, entry.moduleId);
    if (!moduleDef) {
      violations.push({
        code: "unknown_slot",
        slot: entry.slot,
        moduleId: entry.moduleId,
        message: `Módulo desconocido en el catálogo: ${entry.moduleId}`,
      });
      continue;
    }

    if (!slotDef.accepts.includes(moduleDef.category)) {
      violations.push({
        code: "slot_type_mismatch",
        slot: entry.slot,
        moduleId: entry.moduleId,
        message: `La ranura "${entry.slot}" acepta [${slotDef.accepts.join(", ")}], no "${moduleDef.category}"`,
      });
      continue;
    }

    if (moduleDef.category === "armor" && slotDef.sector && moduleDef.sector !== slotDef.sector) {
      violations.push({
        code: "slot_type_mismatch",
        slot: entry.slot,
        moduleId: entry.moduleId,
        message: `${moduleDef.id} es de sector "${moduleDef.sector}", la ranura "${entry.slot}" es de sector "${slotDef.sector}"`,
      });
      continue;
    }

    // B8 · `safeLookup`, NO indexación directa. `moduleDef.size` y
    // `slotDef.maxSize` vienen del CATÁLOGO (JSON de datos, editable fuera del
    // código). Con un `size: "__proto__"` la indexación directa daba
    // `Object.prototype`, y `Object.prototype > 3` es `false`: la comprobación
    // de tamaño de ranura se saltaba EN SILENCIO y el loadout pasaba validación.
    // Una talla desconocida ahora da `undefined` y se trata como violación.
    const moduleSizeRank = moduleDef.size ? safeLookup(SIZE_RANK, moduleDef.size) : undefined;
    const slotMaxSizeRank = safeLookup(SIZE_RANK, slotDef.maxSize);
    if (
      moduleDef.size &&
      (moduleSizeRank === undefined || slotMaxSizeRank === undefined || moduleSizeRank > slotMaxSizeRank)
    ) {
      violations.push({
        code: "slot_size_exceeded",
        slot: entry.slot,
        moduleId: entry.moduleId,
        message: `${moduleDef.id} es de tamaño ${moduleDef.size}, la ranura "${entry.slot}" admite hasta ${slotDef.maxSize}`,
      });
      continue;
    }

    if (moduleDef.requiresChassis && !moduleDef.requiresChassis.includes(chassisDef.id)) {
      violations.push({
        code: "incompatible_chassis",
        slot: entry.slot,
        moduleId: entry.moduleId,
        message: `${moduleDef.id} requiere uno de [${moduleDef.requiresChassis.join(", ")}], montado en ${chassisDef.id}`,
      });
      continue;
    }

    if (forbiddenCategories.includes(moduleDef.category)) {
      violations.push({
        code: "category_forbidden_by_ruleset",
        slot: entry.slot,
        moduleId: entry.moduleId,
        message: `La categoría "${moduleDef.category}" está prohibida por el ruleset de esta competición`,
      });
      continue;
    }

    if (entry.ammo !== undefined && typeof entry.ammo !== "string") {
      violations.push({
        code: "incompatible_ammo",
        slot: entry.slot,
        moduleId: entry.moduleId,
        message: `Munición inválida asignada a ${entry.slot}`,
      });
      continue;
    }
    accepted.push({ slot: entry.slot, moduleDef, ammo: entry.ammo });
  }

  // -------------------------------------------------------- compatibilidad arma-munición
  violations.push(...ammoRule(accepted, catalog));

  // -------------------------------------------------------- duplicados (maxPerVehicle)
  const countByBaseId = new Map<string, number>();
  for (const a of accepted) {
    countByBaseId.set(a.moduleDef.id, (countByBaseId.get(a.moduleDef.id) ?? 0) + 1);
  }
  const reportedDuplicate = new Set<string>();
  for (const a of accepted) {
    const limit = a.moduleDef.maxPerVehicle;
    const count = countByBaseId.get(a.moduleDef.id) ?? 0;
    if (limit != null && count > limit && !reportedDuplicate.has(a.moduleDef.id)) {
      reportedDuplicate.add(a.moduleDef.id);
      violations.push({
        code: "duplicate_limit_exceeded",
        moduleId: a.moduleDef.id,
        message: `${a.moduleDef.id} está instalado ${count} veces; el máximo por vehículo es ${limit}`,
      });
    }
  }

  // -------------------------------------------------------------------------- masa
  const moduleMass = accepted.reduce((sum, a) => sum + a.moduleDef.massKg, 0);
  if (chassisDef.maxLoadKg != null && moduleMass > chassisDef.maxLoadKg) {
    violations.push({
      code: "mass_exceeded",
      message: `Masa de módulos instalados ${moduleMass} kg supera maxLoadKg ${chassisDef.maxLoadKg} kg de ${chassisDef.id}`,
    });
  }

  // ----------------------------------------------------------------------- energía
  const generationEUs = accepted
    .filter((a) => a.moduleDef.category === "power")
    .reduce((sum, a) => sum + (a.moduleDef.generationEUs ?? 0), 0);
  const passiveEUs = accepted.reduce((sum, a) => sum + (a.moduleDef.power?.passiveEUs ?? 0), 0);
  if (generationEUs < passiveEUs) {
    violations.push({
      code: "energy_deficit",
      message: `Generación ${generationEUs} EU/s no cubre el consumo pasivo total ${passiveEUs} EU/s`,
    });
  }

  // ---------------------------------------------------------------------- presupuesto
  const modulesCost = accepted.reduce((sum, a) => sum + a.moduleDef.costCredits, 0);
  const totalCost = chassisDef.costCredits + modulesCost;
  if (totalCost > budgetCredits) {
    violations.push({
      code: "budget_exceeded",
      message: `Coste total ${totalCost} créditos supera el presupuesto de la batalla (${budgetCredits})`,
    });
  }

  const perModuleCap = budgetCredits * MAX_MODULE_COST_FRACTION;
  if (chassisDef.costCredits > perModuleCap) {
    violations.push({
      code: "module_cost_cap_exceeded",
      moduleId: chassisDef.id,
      message: `${chassisDef.id} cuesta ${chassisDef.costCredits} créditos, por encima del ${MAX_MODULE_COST_FRACTION * 100}% del presupuesto efectivo (${perModuleCap.toFixed(2)})`,
    });
  }
  for (const a of accepted) {
    if (a.moduleDef.costCredits > perModuleCap) {
      violations.push({
        code: "module_cost_cap_exceeded",
        slot: a.slot,
        moduleId: a.moduleDef.id,
        message: `${a.moduleDef.id} cuesta ${a.moduleDef.costCredits} créditos, por encima del ${MAX_MODULE_COST_FRACTION * 100}% del presupuesto efectivo (${perModuleCap.toFixed(2)})`,
      });
    }
  }

  return violations;
}

const versioned = (m: ModuleDefinition) => `${m.id}@${m.version}`;

/**
 * Regla arma ↔ munición, tal como dispara el motor (combat.ammoFor): un arma sólo dispara
 * con munición montada en el vehículo cuyo tipo base esté en su `acceptsAmmo`. La munición
 * puede ir como propiedad del arma (`ammo:`, forma canónica que resolveVehicle materializa
 * en la bahía) o como módulo aparte (forma heredada). Antes sólo se miraba la primera: un
 * cañón con `ammo.standard@1` como módulo pasaba con 0 violaciones y en batalla rechazaba
 * cada disparo con `no_ammo`.
 *
 * 1. La munición embebida tiene que existir, ser munición y admitirla SU arma.
 * 2. Toda arma que consuma munición necesita al menos una compatible entre las montadas.
 * 3. Todo módulo de munición tiene que servir a algún arma del vehículo (más estricto que
 *    el motor, que la ignoraría: munición que nadie usa es casi siempre un error de montaje).
 * Un arma sin `acceptsAmmo` queda fuera de las reglas 2 y 3 (module.schema.json exige
 * `acceptsAmmo` con al menos un tipo en toda arma, así que hoy no existe ninguna).
 */
function ammoRule(items: Accepted[], catalog: ModuleDefinition[]): Violation[] {
  const out: Violation[] = [];
  const pool: ModuleDefinition[] = [];
  const weapons: Accepted[] = [];

  for (const a of items) {
    const def = a.moduleDef;
    if (def.category === "ammo") pool.push(def);
    if (def.category !== "weapon") continue;
    weapons.push(a);
    if (!a.ammo) continue;
    const ammoDef = findModule(catalog, a.ammo);
    if (!ammoDef || ammoDef.category !== "ammo") {
      out.push({
        code: "incompatible_ammo",
        slot: a.slot,
        moduleId: def.id,
        message: `Munición desconocida asignada a ${a.slot}: ${a.ammo}`,
      });
      continue;
    }
    if (!def.acceptsAmmo?.includes(ammoDef.id)) {
      out.push(ammoMismatch(a, versioned(ammoDef)));
      continue;
    }
    pool.push(ammoDef);
  }

  // La munición que ya explica el error de un arma no se vuelve a denunciar sola.
  const explained = new Set<ModuleDefinition>();
  for (const w of weapons) {
    const accepts = w.moduleDef.acceptsAmmo ?? [];
    if (accepts.length === 0) continue;
    if (out.some((v) => v.slot === w.slot)) continue; // su munición embebida ya falló
    if (pool.some((p) => accepts.includes(p.id))) continue;
    if (pool.length === 0) {
      out.push({
        code: "incompatible_ammo",
        slot: w.slot,
        moduleId: w.moduleDef.id,
        acceptedAmmo: accepts,
        message: `El módulo ${versioned(w.moduleDef)} necesita munición y no lleva ninguna. Municiones compatibles: ${accepts.join(", ")}.`,
      });
      continue;
    }
    const mounted = [...new Set(pool.map(versioned))];
    for (const p of pool) explained.add(p);
    out.push(ammoMismatch(w, mounted.join(", ")));
  }

  for (const a of items) {
    if (a.moduleDef.category !== "ammo" || explained.has(a.moduleDef)) continue;
    const users = weapons.filter((w) => w.moduleDef.acceptsAmmo?.includes(a.moduleDef.id));
    if (users.length > 0) continue;
    const id = versioned(a.moduleDef);
    const armed = weapons.filter((w) => (w.moduleDef.acceptsAmmo?.length ?? 0) > 0);
    out.push({
      code: "incompatible_ammo",
      slot: a.slot,
      moduleId: a.moduleDef.id,
      ammoId: id,
      message:
        armed.length === 0
          ? `${id} está montada pero ningún arma del vehículo la usa.`
          : `Ningún arma del vehículo admite ${id} (${armed
              .map((w) => `${versioned(w.moduleDef)} admite ${(w.moduleDef.acceptsAmmo ?? []).join(", ")}`)
              .join("; ")}).`,
    });
  }
  return out;
}

function ammoMismatch(w: Accepted, ammo: string): Violation {
  const accepts = w.moduleDef.acceptsAmmo ?? [];
  return {
    code: "incompatible_ammo",
    slot: w.slot,
    moduleId: w.moduleDef.id,
    ammoId: ammo,
    acceptedAmmo: accepts,
    message:
      accepts.length === 0
        ? `El módulo ${versioned(w.moduleDef)} no usa munición y tiene asignada ${ammo}.`
        : `El módulo ${versioned(w.moduleDef)} no admite ${ammo}. Municiones compatibles: ${accepts.join(", ")}.`,
  };
}

/**
 * Sólo la regla arma ↔ munición, para quien no tiene ruleset ni presupuesto (pipeline de
 * build). Es la MISMA regla que aplica validateLoadout; los módulos desconocidos se ignoran
 * aquí porque los informa el validador completo. Nunca lanza.
 */
export function validateAmmo(loadout: LoadoutInput, catalog: ModuleDefinition[]): Violation[] {
  const out: Violation[] = [];
  const items: Accepted[] = [];
  for (const entry of Array.isArray(loadout?.modules) ? loadout.modules : []) {
    if (!entry || typeof entry.moduleId !== "string") continue;
    const moduleDef = findModule(catalog, entry.moduleId);
    if (!moduleDef) continue;
    if (entry.ammo !== undefined && typeof entry.ammo !== "string") {
      out.push({
        code: "incompatible_ammo",
        slot: String(entry.slot),
        moduleId: moduleDef.id,
        message: `Munición inválida asignada a ${String(entry.slot)}`,
      });
      continue;
    }
    items.push({ slot: String(entry.slot), moduleDef, ammo: entry.ammo });
  }
  return [...out, ...ammoRule(items, catalog)];
}

export type { LoadoutInput, ModuleDefinition, ModuleCategory } from "../types.js";
