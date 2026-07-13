/**
 * Tipos compartidos por validator/, resolve/ y balance/.
 *
 * Reflejan la FORMA de packages/module-catalog/schema/module.schema.json y
 * loadout.schema.json. No son el esquema (eso sigue siendo de E1); son la
 * proyección TypeScript que usan las funciones puras de E3.
 */

export type ModuleCategory =
  | "chassis" | "movement" | "power" | "sensor" | "weapon"
  | "ammo" | "mine" | "armor" | "radio" | "utility";

export type Sector = "front" | "left" | "right" | "rear";
export type Size = "S" | "M" | "L" | "XL";

export interface ChassisSlot {
  id: string;
  accepts: ModuleCategory[];
  maxSize: Size;
  sector?: Sector;
  offsetM?: { x: number; y: number };
}

export interface ModuleDefinition {
  id: string;
  version: number;
  category: ModuleCategory;
  name: string;
  description?: string;
  massKg: number;
  costCredits: number;
  size?: Size;
  power?: { passiveEUs?: number; perActionEU?: number };
  maxPerVehicle?: number;
  requiresChassis?: string[];
  hp?: number;
  tags?: string[];

  // chassis
  hullHp?: number;
  radiusM?: number;
  maxLoadKg?: number;
  slots?: ChassisSlot[];

  // movement
  maxSpeedMs?: number;
  accelerationMs2?: number;
  turnRateRads?: number;
  ratedLoadKg?: number;
  terrain?: ("road" | "rough" | "sand" | "water")[];

  // power
  capacityEU?: number;
  generationEUs?: number;
  peakEUs?: number;

  // sensor
  sensorType?: "lidar" | "radar" | "proximity" | "acoustic";
  rangeM?: number;
  fovRad?: number;
  rays?: number;
  errorM?: number;
  refreshEveryNDecisions?: number;

  // weapon
  damage?: number;
  cooldownTicks?: number;
  projectileSpeedMs?: number;
  spreadRad?: number;
  acceptsAmmo?: string[];
  turretArcRad?: number;
  turretRateRads?: number;

  // ammo
  rounds?: number;
  damageMultiplier?: number;
  explosionRadiusM?: number;

  // mine (charges/damage/triggerRadiusM/armDelayTicks/cooldownTicks ya declarados arriba
  // salvo los que siguen)
  charges?: number;
  triggerRadiusM?: number;
  armDelayTicks?: number;
  lifetimeTicks?: number;
  detectable?: boolean;

  // armor
  sector?: Sector;
  reduction?: number;

  // radio
  maxMessageBytes?: number;
  maxMessagesPerSecond?: number;
  encrypted?: boolean;

  // utility
  effect?: "smoke" | "repair" | "jammer" | "drone";
  magnitude?: number;
  durationTicks?: number;
}

export interface LoadoutModuleEntry {
  slot: string;
  moduleId: string; // versionado: base@version
  ammo?: string; // versionado: ammo.xxx@version
}

export interface LoadoutInput {
  loadoutId: string;
  revision: number;
  name?: string;
  catalogVersion: string;
  chassis: string; // versionado: chassis.xxx@version
  modules: LoadoutModuleEntry[];
}

export function splitVersioned(id: string): { base: string; version: number } {
  const at = id.lastIndexOf("@");
  return { base: id.slice(0, at), version: Number(id.slice(at + 1)) };
}

export function findModule(catalog: ModuleDefinition[], versionedId: string): ModuleDefinition | undefined {
  const { base, version } = splitVersioned(versionedId);
  return catalog.find((m) => m.id === base && m.version === version);
}
