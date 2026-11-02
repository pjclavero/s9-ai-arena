/**
 * EQ3 · Nombres HUMANOS de los identificadores que la web y el SDK usan tal cual
 * (ranuras, categorías, propiedades del catálogo, modos…). El identificador real se
 * sigue mostrando junto al nombre (es lo que se escribe en el código del bot: p. ej.
 * `"fire": ["turret_main"]`), pero nunca SOLO el identificador.
 *
 * Un identificador sin traducción se muestra tal cual (`humanize`), nunca se oculta:
 * el test eq3-help-sources exige traducción para TODAS las ranuras y propiedades del
 * catálogo actual, así que un módulo nuevo sin nombre pone la suite en rojo.
 */
import { safeLookup } from "../../../../packages/game-rules/safe-lookup.js";

export const CATEGORY_NAME: Record<string, string> = {
  chassis: "Chasis",
  movement: "Movimiento",
  power: "Energía",
  sensor: "Sensores",
  weapon: "Armas",
  ammo: "Munición",
  mine: "Minas",
  armor: "Blindaje",
  radio: "Radio",
  utility: "Utilidades",
};

/** Ranuras de chasis (ids de `slots[].id`). */
export const SLOT_NAME: Record<string, string> = {
  drive: "Propulsión",
  power: "Energía",
  sensor_a: "Sensor A",
  sensor_b: "Sensor B",
  turret_main: "Torreta principal",
  turret_secondary: "Torreta secundaria",
  ammo_main: "Munición principal",
  ammo_secondary: "Munición secundaria",
  mine_bay: "Compartimento de minas",
  radio_a: "Radio",
  utility_a: "Utilidad",
  armor_front: "Blindaje frontal",
  armor_left: "Blindaje izquierdo",
  armor_right: "Blindaje derecho",
  armor_rear: "Blindaje trasero",
};

export const SECTOR_NAME: Record<string, string> = {
  front: "frontal",
  left: "izquierdo",
  right: "derecho",
  rear: "trasero",
};

export const SIZE_NAME: Record<string, string> = {
  S: "pequeño (S)",
  M: "mediano (M)",
  L: "grande (L)",
  XL: "muy grande (XL)",
};

/** Propiedades del catálogo: nombre y unidad. */
export const PROP_NAME: Record<string, { label: string; unit?: string }> = {
  massKg: { label: "Masa", unit: "kg" },
  costCredits: { label: "Coste", unit: "créditos" },
  size: { label: "Tamaño" },
  hp: { label: "Vida del módulo", unit: "PV" },
  maxPerVehicle: { label: "Máximo por vehículo" },
  "power.passiveEUs": { label: "Consumo pasivo", unit: "EU/s" },
  "power.perActionEU": { label: "Consumo por acción", unit: "EU" },
  hullHp: { label: "Casco", unit: "PV" },
  radiusM: { label: "Radio", unit: "m" },
  maxLoadKg: { label: "Carga máxima", unit: "kg" },
  slots: { label: "Ranuras" },
  maxSpeedMs: { label: "Velocidad máxima", unit: "m/s" },
  accelerationMs2: { label: "Aceleración", unit: "m/s²" },
  turnRateRads: { label: "Giro", unit: "rad/s" },
  ratedLoadKg: { label: "Carga nominal", unit: "kg" },
  terrain: { label: "Terreno" },
  capacityEU: { label: "Capacidad", unit: "EU" },
  generationEUs: { label: "Generación", unit: "EU/s" },
  peakEUs: { label: "Pico", unit: "EU/s" },
  sensorType: { label: "Tipo de sensor" },
  rangeM: { label: "Alcance", unit: "m" },
  fovRad: { label: "Campo de visión", unit: "rad" },
  rays: { label: "Rayos" },
  errorM: { label: "Error de posición", unit: "m" },
  refreshEveryNDecisions: { label: "Refresco", unit: "decisiones" },
  damage: { label: "Daño" },
  cooldownTicks: { label: "Recarga", unit: "ticks" },
  projectileSpeedMs: { label: "Velocidad del proyectil", unit: "m/s" },
  spreadRad: { label: "Dispersión", unit: "rad" },
  acceptsAmmo: { label: "Munición compatible" },
  turretArcRad: { label: "Arco de torreta", unit: "rad" },
  turretRateRads: { label: "Giro de torreta", unit: "rad/s" },
  rounds: { label: "Disparos", unit: "proyectiles" },
  damageMultiplier: { label: "Multiplicador de daño", unit: "×" },
  explosionRadiusM: { label: "Radio de explosión", unit: "m" },
  charges: { label: "Cargas" },
  triggerRadiusM: { label: "Radio de activación", unit: "m" },
  armDelayTicks: { label: "Retardo de armado", unit: "ticks" },
  lifetimeTicks: { label: "Duración", unit: "ticks" },
  detectable: { label: "Detectable" },
  sector: { label: "Sector" },
  reduction: { label: "Reducción de daño", unit: "fracción" },
  maxMessageBytes: { label: "Tamaño máximo de mensaje", unit: "bytes" },
  maxMessagesPerSecond: { label: "Mensajes por segundo" },
  encrypted: { label: "Cifrada" },
  effect: { label: "Efecto" },
  magnitude: { label: "Magnitud" },
  durationTicks: { label: "Duración", unit: "ticks" },
};

export const SENSOR_TYPE_NAME: Record<string, string> = {
  lidar: "Lidar (rayos)",
  radar: "Radar (contactos con error)",
  proximity: "Proximidad",
  acoustic: "Acústico",
};

/** Nombres de modo: los MISMOS que los selectores de la web (battle-result.ts MODE_NAME) más los del motor. */
export const ENGINE_ONLY_MODE_NAME: Record<string, string> = {
  last_man_standing: "Último en pie (eliminación por rondas)",
  domination: "Dominación",
  juggernaut: "Juggernaut",
};

export const TIEBREAK_NAME: Record<string, string> = {
  draw: "empate",
  most_score: "gana quien tenga más puntos; con igualdad, empate",
  most_alive_then_kills: "gana quien tenga más vehículos vivos; si empatan, más derribos; si siguen igual, empate",
};

export const EFFECT_STATUS_NAME: Record<string, string> = {
  ACTIVE: "Cambia la batalla",
  PARTIAL: "Sólo valida el loadout",
  FUTURE: "Aún sin efecto en la batalla",
};

/** `turret_main` → «Torreta principal»; desconocido → el propio id (nunca se oculta). */
export function humanize(table: Record<string, string>, id: string): string {
  return safeLookup(table, id) ?? id;
}

export function slotName(id: string): string {
  return humanize(SLOT_NAME, id);
}

export function propLabel(key: string): string {
  return safeLookup(PROP_NAME, key)?.label ?? key;
}

export function propUnit(key: string): string | undefined {
  return safeLookup(PROP_NAME, key)?.unit;
}
