/**
 * OLA 2 · MC · CONTRATO DE CAMPOS DEL CATÁLOGO (P-2: «catálogo veraz»).
 *
 * Cada campo que module.schema.json declara tiene aquí su estado (`FieldStatus` del
 * contrato, contracts/engine-v2.ts) y, si cuenta, la MUTACIÓN con la que el gate
 * CATALOG_CONTRACT (catalog-contract.test.ts) demuestra que tiene consumidor:
 *
 *   ACTIVE          · mutar el valor en el catálogo cambia una batalla corta determinista
 *                     (observaciones de los bots + hash de estado), pasando por
 *                     resolveVehicle(), la frontera catálogo → simulación.
 *   VALIDATION_ONLY · mutarlo cambia el veredicto de validateLoadout() y NO la batalla.
 *   FUTURE          · sin consumidor: el esquema NO lo admite (no hay ninguno hoy).
 *   REMOVE          · eliminado del esquema; el gate comprueba que un módulo que lo traiga
 *                     se rechaza.
 *
 * Un campo declarado sin entrada, una entrada ACTIVE cuya mutación no cambia la batalla o
 * una VALIDATION_ONLY que sí la cambia ponen el gate en rojo. Esta tabla NO afirma: la
 * afirmación la comprueba el gate. La tabla de la UI (effect-status.ts) debe coincidir.
 *
 * Rutas: "power.passiveEUs" (objeto anidado) y "slots[].id" (elementos de lista).
 */
import type { FieldStatus } from "./contracts/engine-v2.js";
import type { ModuleCategory, ModuleDefinition } from "./types.js";

/** Nuevo valor del campo a partir del actual (`undefined` = el módulo no lo declaraba). */
export type Perturb = (value: unknown, def: ModuleDefinition) => unknown;

export interface FieldContract {
  readonly status: FieldStatus;
  /** Consumidor real (ACTIVE) o regla del validador (VALIDATION_ONLY). */
  readonly consumer: string;
  /** Mutación del gate (obligatoria en ACTIVE y VALIDATION_ONLY). */
  readonly perturb?: Perturb;
  /** Valor que el gate inyecta si ningún módulo real declara el campo. */
  readonly sample?: unknown;
  readonly reason?: string;
}

const n = (v: unknown): number => v as number;
const scale = (k: number, add = 0): Perturb => (v) => n(v) * k + add;
const intScale = (k: number, min = 1): Perturb => (v) => Math.max(min, Math.round(n(v) * k));
const set =
  (x: unknown): Perturb =>
  () =>
    x;
const rotate =
  (cycle: readonly string[]): Perturb =>
  (v) =>
    cycle[(cycle.indexOf(v as string) + 1) % cycle.length];

const A = (consumer: string, perturb: Perturb): FieldContract => ({ status: "ACTIVE", consumer, perturb });
const V = (consumer: string, perturb: Perturb, sample?: unknown): FieldContract => ({
  status: "VALIDATION_ONLY",
  consumer,
  perturb,
  ...(sample !== undefined ? { sample } : {}),
});

/** Identidad y metadatos: no son datos de juego. El gate exige que no cambien la batalla. */
export const IDENTITY_FIELDS: readonly string[] = ["id", "version", "category", "name", "description", "tags"];

/** Campos comunes a todo módulo (propiedades raíz del esquema). */
export const COMMON_FIELDS: Readonly<Record<string, FieldContract>> = {
  massKg: A("resolve/index.ts → VehicleSpec.massKg → physics.addVehicle / movementCaps (D7)", scale(4, 50)),
  costCredits: V("validator: budget_exceeded / module_cost_cap_exceeded", scale(50, 1000)),
  size: V("validator: slot_size_exceeded (SIZE_RANK de la ranura)", (v) => (v === "XL" ? "S" : "XL")),
  hp: A("vehicle.ts ModuleRuntime.hp → stateFromHealth / applyDamage", scale(0.25)),
  "power.passiveEUs": A("vehicle.ts passiveDrain → energía", scale(6, 1)),
  "power.perActionEU": A("combat.ts canFire / fire / canDeployMine / deployMine (coste por acción)", scale(8, 5)),
  maxPerVehicle: V("validator: duplicate_limit_exceeded (maxPerVehicle)", set(1), 1),
  requiresChassis: V("validator: incompatible_chassis (requiresChassis)", set(["chassis.nonexistent"]), [
    "chassis.nonexistent",
  ]),
};

const SENSOR_TYPES = ["lidar", "radar", "proximity", "acoustic"] as const;
const SECTORS = ["front", "right", "rear", "left"] as const;

export const CATEGORY_FIELDS: Readonly<Record<ModuleCategory, Readonly<Record<string, FieldContract>>>> = {
  chassis: {
    hullHp: A("resolve → VehicleSpec.hullHp → Vehicle.hullHp", scale(0.5)),
    radiusM: A("resolve → VehicleSpec.radiusM → física y boca del arma (battle.ts)", scale(1.4)),
    maxLoadKg: V("validator: mass_exceeded", scale(0.1)),
    "slots[].id": V("validator: unknown_slot (el loadout nombra la ranura)", (v) => `${String(v)}_x`),
    "slots[].accepts": V("validator: slot_type_mismatch", set(["utility"])),
    "slots[].maxSize": V("validator: slot_size_exceeded", set("S")),
    "slots[].sector": V("validator: slot_type_mismatch (sector de blindaje de la ranura)", rotate(SECTORS)),
  },
  movement: {
    maxSpeedMs: A("vehicle.ts movementCaps → physics.driveVehicle", scale(0.3)),
    accelerationMs2: A("vehicle.ts movementCaps", scale(0.2)),
    turnRateRads: A("vehicle.ts movementCaps", scale(0.2)),
    ratedLoadKg: A("vehicle.ts movementCaps (massFactor, D7)", scale(0.1)),
  },
  power: {
    capacityEU: A("vehicle.ts energyCapacity", scale(0.05)),
    generationEUs: A("vehicle.ts energyGeneration", scale(0.1)),
  },
  sensor: {
    sensorType: A("sensors.ts buildObservation (primitiva por tipo)", rotate(SENSOR_TYPES)),
    rangeM: A("sensors.ts buildObservation (rangeM · rendimiento)", scale(0.3)),
    fovRad: A("sensors.ts lidar (sólo lidar: esquema condicional)", scale(0.3)),
    rays: A("sensors.ts lidar (sólo lidar: esquema condicional)", intScale(0.25)),
    errorM: A("sensors.ts radar (sólo radar: esquema condicional)", scale(5, 3)),
  },
  weapon: {
    damage: A("combat.ts fire (daño del proyectil)", scale(3)),
    cooldownTicks: A("combat.ts fire (cooldownUntilTick)", intScale(3)),
    projectileSpeedMs: A("combat.ts fire (velocidad) + resolve/projectile.ts (vida)", scale(0.5)),
    rangeM: A("resolve/projectile.ts → ModuleSpec.projectileLifetimeTicks → combat.ts fire (P-2)", scale(0.1)),
    spreadRad: A("combat.ts fire (dispersión con el RNG del motor)", scale(10, 0.05)),
    acceptsAmmo: A("combat.ts ammoFor (munición montada) + validator incompatible_ammo", set(["ammo.none_x"])),
    turretArcRad: A("combat.ts canFire (out_of_arc)", set(0.5)),
    turretRateRads: A("vehicle.ts turretRate → giro de torreta (battle.ts)", scale(0.2)),
  },
  ammo: {
    rounds: A("vehicle.ts ModuleRuntime.ammo → combat.ts canFire (no_ammo)", set(2)),
    damageMultiplier: A("combat.ts fire (daño)", scale(3)),
    explosionRadiusM: A("combat.ts fire → battle.ts explode", (v) => (n(v ?? 0) > 0 ? 0 : 6)),
  },
  mine: {
    charges: A("vehicle.ts ModuleRuntime.charges → canDeployMine (no_charges)", (v) => (n(v) > 1 ? 1 : 3)),
    damage: A("combat.ts deployMine → battle.ts resolveMines", scale(3)),
    triggerRadiusM: A("combat.ts deployMine → battle.ts resolveMines", scale(5)),
    explosionRadiusM: A("combat.ts deployMine → battle.ts explode", scale(3)),
    armDelayTicks: A("combat.ts deployMine (armedAtTick)", set(300)),
    cooldownTicks: A("combat.ts deployMine (cooldownUntilTick)", intScale(4)),
    lifetimeTicks: A("combat.ts deployMine (expiresAtTick)", set(45)),
  },
  armor: {
    sector: A("vehicle.ts armor[sector] → combat.ts applyDamage (+ validator)", rotate(SECTORS)),
    reduction: A("combat.ts applyDamage", scale(0.2)),
  },
  radio: {
    rangeM: A("sensors.ts radioRangeOf / radioDeliverableTo (P-2: alcance real)", scale(0.1)),
    maxMessageBytes: A("sensors.ts validateRadio (too_large)", set(4)),
    maxMessagesPerSecond: A("sensors.ts validateRadio (rate_limited)", set(0.5)),
  },
  // Sin campos propios (P-2). Declarará `actions` (contracts/engine-v2.ts) con su consumidor.
  utility: {},
};

/** Campos ELIMINADOS en la OLA 2 (P-2), con la categoría que los declaraba y el criterio. */
export const REMOVED_FIELDS: Readonly<Record<string, { category: ModuleCategory; reason: string }>> = {
  "movement.terrain": {
    category: "movement",
    reason: "Decisión fijada P-2: REMOVE. El mapa no tiene tipos de terreno; ningún código lo leía.",
  },
  "power.peakEUs": {
    category: "power",
    reason: "Sin modelo de potencia de pico en el motor ni en los contratos: implementarlo es diseño nuevo.",
  },
  "sensor.refreshEveryNDecisions": {
    category: "sensor",
    reason:
      "Exige observación en caché por sensor dentro del hash y semántica de decisiones sin refresco (MD/MA); no está en los contratos.",
  },
  "radio.encrypted": {
    category: "radio",
    reason: "Sólo tendría sentido con escucha enemiga, que el motor no modela (RADIO_SCOPE=TEAM).",
  },
  "mine.detectable": {
    category: "mine",
    reason:
      "Nunca se copiaba (Mine.detectable fijo a true). Lo sustituye DeployableVisibilityDef.signature del contrato, con su consumidor.",
  },
  "utility.effect": {
    category: "utility",
    reason: "Enum de nombres de producto sin consumidor; el contrato lo sustituye por `actions` (ActionDef).",
  },
  "utility.magnitude": { category: "utility", reason: "Absorbido por EffectDef.strength (contrato §8)." },
  "utility.durationTicks": { category: "utility", reason: "Absorbido por EffectDef.durationTicks (contrato §8)." },
  "utility.charges": {
    category: "utility",
    reason: "Sin consumidor (el comando utility se ignora); pasa a ActionDef.cost.charges.",
  },
  "utility.cooldownTicks": {
    category: "utility",
    reason: "Sin consumidor (el comando utility se ignora); pasa a ActionDef.cooldownTicks.",
  },
  "chassis.slots[].offsetM": {
    category: "chassis",
    reason: "Declarado sin datos ni consumidor (ni simulación ni visor): campo falso.",
  },
};

/** Contrato de un campo en una categoría (específico o común). `undefined` = sin clasificar. */
export function fieldContract(category: ModuleCategory, field: string): FieldContract | undefined {
  const own = CATEGORY_FIELDS[category];
  if (own && Object.prototype.hasOwnProperty.call(own, field)) return own[field];
  if (Object.prototype.hasOwnProperty.call(COMMON_FIELDS, field)) return COMMON_FIELDS[field];
  return undefined;
}
