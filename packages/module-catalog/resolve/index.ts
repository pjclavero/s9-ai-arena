/**
 * T3.3 · Resolución de capacidades: de loadout a vehículo simulable.
 *
 * resolveVehicle() es la única puerta entre "diseño modular" (LoadoutInput, datos de
 * catálogo) y "vehículo que el motor puede simular" (VehicleSpec, la interfaz exacta
 * de apps/arena-engine/src/sim/vehicle.ts). No valida legalidad — eso es
 * ../validator/index.ts — asume que el loadout que recibe ya es legal y se limita a
 * aplanar los datos del catálogo en la forma que el motor consume.
 */
import type { ModuleCategory, ModuleSpec, VehicleSpec } from "../../../apps/arena-engine/src/sim/vehicle.js";
import { findModule, type LoadoutInput, type ModuleDefinition } from "../types.js";

export class UnresolvableLoadoutError extends Error {}

function toModuleSpec(slot: string, def: ModuleDefinition): ModuleSpec {
  if (def.category === "chassis") {
    throw new UnresolvableLoadoutError(`${def.id}: un chasis no puede ocupar una ranura de módulo`);
  }
  if (def.hp == null) {
    throw new UnresolvableLoadoutError(`${def.id}: módulo no-chasis sin hp (viola module.schema.json)`);
  }

  return {
    slot,
    moduleId: `${def.id}@${def.version}`,
    category: def.category as ModuleCategory,
    hp: def.hp,
    massKg: def.massKg,
    costCredits: def.costCredits,
    passiveEUs: def.power?.passiveEUs,
    perActionEU: def.power?.perActionEU,
    // movement
    maxSpeedMs: def.maxSpeedMs,
    accelerationMs2: def.accelerationMs2,
    turnRateRads: def.turnRateRads,
    ratedLoadKg: def.ratedLoadKg,
    // power
    capacityEU: def.capacityEU,
    generationEUs: def.generationEUs,
    // sensor
    sensorType: def.sensorType,
    rangeM: def.rangeM,
    fovRad: def.fovRad,
    rays: def.rays,
    errorM: def.errorM,
    // weapon
    damage: def.damage,
    cooldownTicks: def.cooldownTicks,
    projectileSpeedMs: def.projectileSpeedMs,
    spreadRad: def.spreadRad,
    turretArcRad: def.turretArcRad,
    turretRateRads: def.turretRateRads,
    acceptsAmmo: def.acceptsAmmo,
    // ammo
    rounds: def.rounds,
    damageMultiplier: def.damageMultiplier,
    explosionRadiusM: def.explosionRadiusM,
    // mine (charges/armDelayTicks/lifetimeTicks arriba, triggerRadiusM aquí)
    charges: def.charges,
    triggerRadiusM: def.triggerRadiusM,
    armDelayTicks: def.armDelayTicks,
    lifetimeTicks: def.lifetimeTicks,
    // armor
    sector: def.sector,
    reduction: def.reduction,
    // radio
    maxMessageBytes: def.maxMessageBytes,
    maxMessagesPerSecond: def.maxMessagesPerSecond,
  };
}

/**
 * Convierte un loadout (diseño) más un catálogo (datos) en la ficha que el motor
 * instancia con `new Vehicle(id, team, botId, spec)`. Asume un loadout legal: si el
 * chasis o algún módulo no existen en el catálogo, lanza UnresolvableLoadoutError —
 * un loadout que no resuelve no debería haber pasado nunca por validateLoadout.
 */
export function resolveVehicle(loadout: LoadoutInput, catalog: ModuleDefinition[]): VehicleSpec {
  const chassisDef = findModule(catalog, loadout.chassis);
  if (!chassisDef || chassisDef.category !== "chassis") {
    throw new UnresolvableLoadoutError(`Chasis desconocido en el catálogo: ${loadout.chassis}`);
  }
  if (chassisDef.hullHp == null || chassisDef.radiusM == null) {
    throw new UnresolvableLoadoutError(`${chassisDef.id}: chasis sin hullHp/radiusM (viola module.schema.json)`);
  }

  const modules: ModuleSpec[] = loadout.modules.map((entry) => {
    const def = findModule(catalog, entry.moduleId);
    if (!def) {
      throw new UnresolvableLoadoutError(`Módulo desconocido en el catálogo: ${entry.moduleId} (ranura ${entry.slot})`);
    }
    return toModuleSpec(entry.slot, def);
  });

  const massKg = chassisDef.massKg + modules.reduce((sum, m) => sum + m.massKg, 0);

  return {
    chassisId: `${chassisDef.id}@${chassisDef.version}`,
    hullHp: chassisDef.hullHp,
    radiusM: chassisDef.radiusM,
    massKg,
    modules,
  };
}

/** Trazabilidad: versión de catálogo usada para resolver, fuera de VehicleSpec (no altera la interfaz del motor). */
export interface ResolvedVehicle {
  spec: VehicleSpec;
  catalogVersion: string;
}

export function resolveVehicleTraced(
  loadout: LoadoutInput,
  catalog: ModuleDefinition[],
): ResolvedVehicle {
  return { spec: resolveVehicle(loadout, catalog), catalogVersion: loadout.catalogVersion };
}
