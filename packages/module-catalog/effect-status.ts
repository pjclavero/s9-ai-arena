/**
 * FC-C (TD-016) · Efecto REAL de cada propiedad del catálogo en la simulación, medido
 * sobre el código en FUNCTIONAL_BASE_COMMIT 0b8c12b (auditoría DEV-C, ver
 * docs/technical/equipment.md).
 *
 * El hecho que lo condiciona todo: en el CAMINO REAL de batalla
 * (apps/api/src/services/battle-run-http-launcher.ts:141-146,638) del loadout del bot
 * SOLO viaja la familia del chasis, traducida a un arquetipo fijo (light→scout,
 * heavy→heavy, resto→gunner) que el motor simula con los módulos de
 * packages/module-catalog/resolve/archetypes.ts. Los módulos que elige el usuario
 * NO llegan a la simulación; solo cuentan en la VALIDACIÓN del loadout (coste,
 * masa, energía, ranuras).
 *
 *   ACTIVE  · lo que elige el usuario cambia la batalla en el camino real.
 *   PARTIAL · el motor sabe usarla, pero en el camino real el valor es el del
 *             arquetipo (no el del usuario), o solo cuenta en validación, o su
 *             efecto es incompleto.
 *   FUTURE  · ningún código de simulación la lee: no cambia la batalla.
 *
 * La UI (LoadoutEditor) y la documentación leen ESTA tabla: no se presenta como
 * funcional un campo que el motor ignora.
 */
import type { ModuleCategory } from "./types.js";

export type EffectStatus = "ACTIVE" | "PARTIAL" | "FUTURE";

export interface PropertyEffect {
  status: EffectStatus;
  /** También la usa el validador de loadout (coste/masa/energía/ranuras). */
  validation: boolean;
  note: string;
}

const ARQ = "El motor la usa, pero en batalla real se juega el valor del módulo del arquetipo, no el elegido.";
const VAL_ONLY = "Solo cuenta para validar el loadout; no cambia la batalla.";
const NONE = "Ningún código de simulación la lee: no cambia la batalla.";

const p = (status: EffectStatus, validation: boolean, note: string): PropertyEffect => ({ status, validation, note });

/** Elegir el CHASIS sí cambia la batalla: decide el arquetipo (light/heavy/otro). */
export const CHASSIS_CHOICE_EFFECT: PropertyEffect = p(
  "ACTIVE",
  true,
  "La familia del chasis decide el arquetipo jugado (light→scout, heavy→heavy, resto→gunner). La versión (@2) se descarta.",
);

/** Por categoría y propiedad. Las comunes (massKg, costCredits, hp, size) van en COMMON. */
export const COMMON_EFFECTS: Record<string, PropertyEffect> = {
  massKg: p("PARTIAL", true, "Masa del arquetipo en la física; la del usuario solo en validación."),
  costCredits: p("PARTIAL", true, VAL_ONLY),
  size: p("PARTIAL", true, VAL_ONLY),
  hp: p("PARTIAL", false, ARQ),
  maxPerVehicle: p("PARTIAL", true, VAL_ONLY),
  "power.passiveEUs": p("PARTIAL", true, ARQ),
};

export const PROPERTY_EFFECTS: Record<ModuleCategory, Record<string, PropertyEffect>> = {
  chassis: {
    hullHp: p("PARTIAL", false, ARQ),
    radiusM: p("PARTIAL", false, ARQ),
    maxLoadKg: p("PARTIAL", true, VAL_ONLY),
    slots: p("PARTIAL", true, "Ranuras: validación del loadout; en simulación solo nombran la munición."),
  },
  movement: {
    maxSpeedMs: p("PARTIAL", false, ARQ),
    accelerationMs2: p("PARTIAL", false, ARQ),
    turnRateRads: p("PARTIAL", false, ARQ),
    ratedLoadKg: p("PARTIAL", false, ARQ),
    terrain: p("FUTURE", false, NONE),
  },
  power: {
    capacityEU: p("PARTIAL", false, ARQ),
    generationEUs: p("PARTIAL", true, ARQ),
  },
  sensor: {
    sensorType: p("PARTIAL", false, "Lidar y radar (arquetipos); proximity y acoustic nunca llegan a batalla."),
    rangeM: p("PARTIAL", false, ARQ),
    fovRad: p("PARTIAL", false, ARQ),
    rays: p("PARTIAL", false, ARQ),
    errorM: p("PARTIAL", false, ARQ),
  },
  weapon: {
    damage: p("PARTIAL", false, ARQ),
    cooldownTicks: p("PARTIAL", false, ARQ),
    projectileSpeedMs: p("PARTIAL", false, ARQ),
    spreadRad: p("PARTIAL", false, ARQ),
    turretRateRads: p("PARTIAL", false, ARQ),
    acceptsAmmo: p("PARTIAL", true, ARQ),
    "power.perActionEU": p("PARTIAL", false, ARQ),
    rangeM: p("FUTURE", false, "El alcance real lo fija un TTL de proyectil de 90 ticks (combat.ts:198), no rangeM."),
    turretArcRad: p("FUTURE", false, "Todos los módulos declaran 2π: la comprobación de arco nunca se activa."),
  },
  ammo: {
    damageMultiplier: p("PARTIAL", false, ARQ),
    rounds: p("PARTIAL", false, ARQ),
    explosionRadiusM: p("PARTIAL", false, "Solo ammo.he tiene radio y no está en ningún arquetipo."),
  },
  mine: {
    armDelayTicks: p("PARTIAL", false, "El motor las sabe usar, pero ningún arquetipo alcanzable monta minas."),
    charges: p("PARTIAL", false, "Ningún arquetipo alcanzable monta minas."),
    cooldownTicks: p("PARTIAL", false, "Ningún arquetipo alcanzable monta minas."),
    damage: p("PARTIAL", false, "Ningún arquetipo alcanzable monta minas."),
    explosionRadiusM: p("PARTIAL", false, "Ningún arquetipo alcanzable monta minas."),
    lifetimeTicks: p("PARTIAL", false, "Ningún arquetipo alcanzable monta minas."),
    triggerRadiusM: p("PARTIAL", false, "Ningún arquetipo alcanzable monta minas."),
    "power.perActionEU": p("PARTIAL", false, "Ningún arquetipo alcanzable monta minas."),
  },
  armor: {
    reduction: p("PARTIAL", false, ARQ),
    sector: p("PARTIAL", true, "Solo el frontal (arquetipos gunner/heavy); izquierda/derecha/trasera nunca llegan."),
  },
  radio: {
    maxMessageBytes: p("PARTIAL", false, ARQ),
    maxMessagesPerSecond: p("PARTIAL", false, ARQ),
    rangeM: p("FUTURE", false, "radioReaches no se llama nunca (sensors.ts:227): la radio no tiene alcance ni filtro de equipo."),
  },
  utility: {
    effect: p("FUTURE", false, NONE),
    magnitude: p("FUTURE", false, NONE),
    durationTicks: p("FUTURE", false, NONE),
  },
};

/** Claves de identidad/descripción: no son propiedades de juego. */
export const NON_GAMEPLAY_KEYS = new Set(["id", "version", "category", "name", "description", "tags", "requiresChassis", "power"]);

/** Efecto de una propiedad (o undefined si es una clave sin efecto de juego). */
export function effectOf(category: ModuleCategory, prop: string): PropertyEffect | undefined {
  const byCat = PROPERTY_EFFECTS[category];
  if (byCat && Object.prototype.hasOwnProperty.call(byCat, prop)) return byCat[prop];
  if (Object.prototype.hasOwnProperty.call(COMMON_EFFECTS, prop)) return COMMON_EFFECTS[prop];
  return undefined;
}

/** Resumen de una categoría para la UI: el peor estado de sus propiedades de juego. */
export function categoryEffect(category: ModuleCategory): EffectStatus {
  if (category === "chassis") return "ACTIVE";
  const all = Object.values(PROPERTY_EFFECTS[category] ?? {});
  if (all.length > 0 && all.every((e) => e.status === "FUTURE")) return "FUTURE";
  return all.some((e) => e.status === "ACTIVE") ? "ACTIVE" : "PARTIAL";
}
