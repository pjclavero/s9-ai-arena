/**
 * FC-C (TD-016) · Efecto REAL de cada propiedad del catálogo en la simulación.
 *
 * UX-01 (G-16) · RECALIBRADO. La versión anterior de esta tabla se midió sobre el
 * camino API → arena-engine `/run` (battle-run-http-launcher.ts), que sólo enviaba
 * la familia del chasis traducida a un arquetipo fijo. Ese camino YA NO EJECUTA
 * batallas: `POST /battles/{id}/run` delega en el tournament-worker (DEV-B,
 * TD-002), y su engine-executor resuelve el loadout PERSISTIDO de la versión
 * (bot_loadouts de su loadout_revision) con resolveVehicle y lo simula tal cual.
 * Demostrado de extremo a extremo (loadout persistido ↔ WELCOME del bot ↔
 * vehículo simulado) en apps/tournament-worker/src/ux01-loadout-welcome.test.ts.
 * La partida de humo del build juega también ese loadout (smoke-vehicle.ts).
 *
 *   ACTIVE  · lo que elige el usuario cambia la batalla.
 *   PARTIAL · sólo cuenta para VALIDAR el loadout (coste, tamaño, límites).
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

const USED = "El motor usa el valor del módulo que eliges.";
const VAL_ONLY = "Solo cuenta para validar el loadout; no cambia la batalla.";
const NONE = "Ningún código de simulación la lee: no cambia la batalla.";

const p = (status: EffectStatus, validation: boolean, note: string): PropertyEffect => ({ status, validation, note });

/** Elegir el CHASIS cambia la batalla: casco, radio, ranuras disponibles. */
export const CHASSIS_CHOICE_EFFECT: PropertyEffect = p(
  "ACTIVE",
  true,
  "El chasis elegido (con su versión) es el que se simula: casco, tamaño y ranuras disponibles.",
);

/** Por categoría y propiedad. Las comunes (massKg, costCredits, hp, size) van en COMMON. */
export const COMMON_EFFECTS: Record<string, PropertyEffect> = {
  massKg: p("ACTIVE", true, "Masa total (chasis + módulos elegidos): la usa la física y la valida el loadout."),
  costCredits: p("PARTIAL", true, VAL_ONLY),
  size: p("PARTIAL", true, VAL_ONLY),
  hp: p("ACTIVE", false, USED),
  maxPerVehicle: p("PARTIAL", true, VAL_ONLY),
  "power.passiveEUs": p("ACTIVE", true, USED),
};

export const PROPERTY_EFFECTS: Record<ModuleCategory, Record<string, PropertyEffect>> = {
  chassis: {
    hullHp: p("ACTIVE", false, USED),
    radiusM: p("ACTIVE", false, USED),
    maxLoadKg: p("PARTIAL", true, VAL_ONLY),
    slots: p(
      "ACTIVE",
      true,
      "Deciden qué puedes montar y el nombre de ranura que usas en los comandos (fire, deployMine).",
    ),
  },
  movement: {
    maxSpeedMs: p("ACTIVE", false, USED),
    accelerationMs2: p("ACTIVE", false, USED),
    turnRateRads: p("ACTIVE", false, USED),
    ratedLoadKg: p("ACTIVE", false, USED),
    terrain: p("FUTURE", false, NONE),
  },
  power: {
    capacityEU: p("ACTIVE", false, USED),
    generationEUs: p("ACTIVE", true, USED),
  },
  sensor: {
    sensorType: p("ACTIVE", false, "El motor simula el tipo que montas: lidar, radar, proximidad o acústico."),
    rangeM: p("ACTIVE", false, USED),
    fovRad: p("ACTIVE", false, USED),
    rays: p("ACTIVE", false, USED),
    errorM: p("ACTIVE", false, USED),
  },
  weapon: {
    damage: p("ACTIVE", false, USED),
    cooldownTicks: p("ACTIVE", false, USED),
    projectileSpeedMs: p("ACTIVE", false, USED),
    spreadRad: p("ACTIVE", false, USED),
    turretRateRads: p("ACTIVE", false, USED),
    acceptsAmmo: p("ACTIVE", true, USED),
    "power.perActionEU": p("ACTIVE", false, USED),
    rangeM: p("FUTURE", false, "El alcance real lo fija un TTL de proyectil de 90 ticks (combat.ts:198), no rangeM."),
    turretArcRad: p("FUTURE", false, "Todos los módulos declaran 2π: la comprobación de arco nunca se activa."),
  },
  ammo: {
    damageMultiplier: p("ACTIVE", false, USED),
    rounds: p("ACTIVE", false, USED),
    explosionRadiusM: p("ACTIVE", false, "Radio de explosión del impacto (sólo ammo.he lo declara)."),
  },
  mine: {
    armDelayTicks: p("ACTIVE", false, "El motor la usa si montas una mina en la bahía (comando deployMine)."),
    charges: p("ACTIVE", false, "El motor la usa si montas una mina en la bahía (comando deployMine)."),
    cooldownTicks: p("ACTIVE", false, "El motor la usa si montas una mina en la bahía (comando deployMine)."),
    damage: p("ACTIVE", false, "El motor la usa si montas una mina en la bahía (comando deployMine)."),
    explosionRadiusM: p("ACTIVE", false, "El motor la usa si montas una mina en la bahía (comando deployMine)."),
    lifetimeTicks: p("ACTIVE", false, "El motor la usa si montas una mina en la bahía (comando deployMine)."),
    triggerRadiusM: p("ACTIVE", false, "El motor la usa si montas una mina en la bahía (comando deployMine)."),
    "power.perActionEU": p("ACTIVE", false, "El motor la usa si montas una mina en la bahía (comando deployMine)."),
  },
  armor: {
    reduction: p("ACTIVE", false, USED),
    sector: p("ACTIVE", true, "El blindaje protege el sector que cubre (frontal, laterales o trasero)."),
  },
  radio: {
    maxMessageBytes: p("ACTIVE", false, USED),
    maxMessagesPerSecond: p("ACTIVE", false, USED),
    rangeM: p(
      "FUTURE",
      false,
      "radioReaches no se llama nunca (sensors.ts:227): la radio no tiene alcance ni filtro de equipo.",
    ),
  },
  utility: {
    effect: p("FUTURE", false, NONE),
    magnitude: p("FUTURE", false, NONE),
    durationTicks: p("FUTURE", false, NONE),
  },
};

/** Claves de identidad/descripción: no son propiedades de juego. */
export const NON_GAMEPLAY_KEYS = new Set([
  "id",
  "version",
  "category",
  "name",
  "description",
  "tags",
  "requiresChassis",
  "power",
]);

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
