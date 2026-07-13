/**
 * T3.2 · Validador de ensamblaje de loadouts (cap. 10.2).
 *
 * Función pura: mismo input, mismo output, sin leer disco ni red. El catálogo llega
 * ya cargado (packages/module-catalog/loadCatalog.ts es responsabilidad del llamador,
 * NO de este módulo). budgetCredits SIEMPRE es un parámetro — D7 prohíbe leer
 * BUDGET_CREDITS_MVP aquí salvo que el propio llamador decida pasarlo como valor por
 * defecto (ver test de constructivos en ../data.test.ts).
 */
import { MAX_MODULE_COST_FRACTION } from "../../game-rules/index.js";
import { findModule, splitVersioned, type LoadoutInput, type ModuleCategory, type ModuleDefinition, type Size } from "../types.js";

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

    if (moduleDef.size && SIZE_RANK[moduleDef.size] > SIZE_RANK[slotDef.maxSize]) {
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

    accepted.push({ slot: entry.slot, moduleDef, ammo: entry.ammo });
  }

  // -------------------------------------------------------- compatibilidad arma-munición
  for (const a of accepted) {
    if (a.moduleDef.category !== "weapon" || !a.ammo) continue;
    const ammoDef = findModule(catalog, a.ammo);
    const ammoBase = splitVersioned(a.ammo).base;
    if (!ammoDef || ammoDef.category !== "ammo") {
      violations.push({
        code: "incompatible_ammo",
        slot: a.slot,
        moduleId: a.moduleDef.id,
        message: `Munición desconocida asignada a ${a.slot}: ${a.ammo}`,
      });
      continue;
    }
    if (!a.moduleDef.acceptsAmmo?.includes(ammoBase)) {
      violations.push({
        code: "incompatible_ammo",
        slot: a.slot,
        moduleId: a.moduleDef.id,
        message: `${a.moduleDef.id} no acepta ${ammoBase} (acepta [${(a.moduleDef.acceptsAmmo ?? []).join(", ")}])`,
      });
    }
  }

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

export type { LoadoutInput, ModuleDefinition, ModuleCategory } from "../types.js";
