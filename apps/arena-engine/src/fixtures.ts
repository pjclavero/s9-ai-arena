/**
 * Fixtures del MVP: mapa y loadouts de referencia.
 *
 * PROVISIONAL POR DISEÑO. El mapa real lo entrega E4 (importado de Tiled y validado)
 * y los loadouts reales los entrega E3 (catálogo versionado). Esto existe para que E2
 * pueda construir y probar el motor SIN esperar a nadie: es exactamente lo que permite
 * el paralelismo entre equipos. Cuando E3 y E4 publiquen, se sustituyen las fuentes y
 * las pruebas del motor no deberían cambiar.
 */
import type { ArenaMap } from "./sim/modes.js";
import type { ModuleSpec, VehicleSpec } from "./sim/vehicle.js";
import { loadCatalog } from "../../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import type { LoadoutInput } from "../../../packages/module-catalog/types.js";

/**
 * Catálogo real de E3 (T3.1-T3.3), sustituyendo el andamio de MODULES de abajo para
 * las 4 fábricas de VehicleSpec. MODULES se mantiene tal cual porque combat.test.ts y
 * sensors-fog.test.ts siguen leyéndolo directamente (ver docs/entrega-E3.md).
 */
const CATALOG = loadCatalog();

/** Arena MVP: 120×80 m, muro central, zona de daño, destructibles, dos bases y banderas. */
export function mvpArena(): ArenaMap {
  return {
    mapId: "mvp-arena-01",
    version: 1,
    checksum: "sha256:" + "0".repeat(64), // E4 lo calcula de verdad
    widthM: 120,
    heightM: 80,
    walls: [
      // Perímetro
      { id: "wall_n", position: { x: 60, y: 80.5 }, halfW: 61, halfH: 0.5 },
      { id: "wall_s", position: { x: 60, y: -0.5 }, halfW: 61, halfH: 0.5 },
      { id: "wall_w", position: { x: -0.5, y: 40 }, halfW: 0.5, halfH: 41 },
      { id: "wall_e", position: { x: 120.5, y: 40 }, halfW: 0.5, halfH: 41 },
      // Muro central con dos pasillos (arriba y abajo)
      { id: "wall_c1", position: { x: 60, y: 62 }, halfW: 2, halfH: 12 },
      { id: "wall_c2", position: { x: 60, y: 18 }, halfW: 2, halfH: 12 },
      // Coberturas
      { id: "wall_l", position: { x: 35, y: 40 }, halfW: 1.5, halfH: 6 },
      { id: "wall_r", position: { x: 85, y: 40 }, halfW: 1.5, halfH: 6 },
    ],
    destructibles: [
      { id: "crate_1", position: { x: 45, y: 55 }, halfW: 1.5, halfH: 1.5, hp: 120 },
      { id: "crate_2", position: { x: 75, y: 25 }, halfW: 1.5, halfH: 1.5, hp: 120 },
      { id: "crate_3", position: { x: 45, y: 25 }, halfW: 1.5, halfH: 1.5, hp: 120 },
      { id: "crate_4", position: { x: 75, y: 55 }, halfW: 1.5, halfH: 1.5, hp: 120 },
    ],
    spawns: [
      { team: "red", position: { x: 10, y: 34 }, heading: 0 },
      { team: "red", position: { x: 10, y: 46 }, heading: 0 },
      { team: "blue", position: { x: 110, y: 34 }, heading: Math.PI },
      { team: "blue", position: { x: 110, y: 46 }, heading: Math.PI },
    ],
    bases: [
      { team: "red", position: { x: 8, y: 40 }, radiusM: 5 },
      { team: "blue", position: { x: 112, y: 40 }, radiusM: 5 },
    ],
    flags: [
      { team: "red", position: { x: 8, y: 40 } },
      { team: "blue", position: { x: 112, y: 40 } },
    ],
    zones: [
      { id: "acid", position: { x: 60, y: 40 }, radiusM: 5, kind: "damage", damagePerSecond: 12 },
    ],
  };
}

/**
 * Arena CTF ABIERTA: bases y banderas, sin obstáculos entre medias.
 *
 * Sirve para probar la MÁQUINA DE ESTADOS de la bandera aislada de la navegación.
 * Si el test de la FSM corriera sobre mvpArena, un fallo de pathfinding del bot
 * guionizado se confundiría con un fallo de la FSM, y estaríamos depurando lo que
 * no es. La navegación en mapas complejos se prueba aparte (y es asunto de E4).
 */
export function ctfArena(): ArenaMap {
  const m = emptyArena(120, 80);
  m.mapId = "ctf-open";
  m.bases = [
    { team: "red", position: { x: 10, y: 40 }, radiusM: 6 },
    { team: "blue", position: { x: 110, y: 40 }, radiusM: 6 },
  ];
  m.flags = [
    { team: "red", position: { x: 10, y: 40 } },
    { team: "blue", position: { x: 110, y: 40 } },
  ];
  m.spawns = [
    { team: "red", position: { x: 16, y: 40 }, heading: 0 },
    { team: "blue", position: { x: 104, y: 40 }, heading: Math.PI },
  ];
  return m;
}

/** Mapa vacío, sin obstáculos. Para pruebas de física puras. */
export function emptyArena(w = 120, h = 80): ArenaMap {
  return {
    mapId: "empty",
    version: 1,
    checksum: "sha256:" + "0".repeat(64),
    widthM: w,
    heightM: h,
    walls: [
      { id: "wall_n", position: { x: w / 2, y: h + 0.5 }, halfW: w / 2 + 1, halfH: 0.5 },
      { id: "wall_s", position: { x: w / 2, y: -0.5 }, halfW: w / 2 + 1, halfH: 0.5 },
      { id: "wall_w", position: { x: -0.5, y: h / 2 }, halfW: 0.5, halfH: h / 2 + 1 },
      { id: "wall_e", position: { x: w + 0.5, y: h / 2 }, halfW: 0.5, halfH: h / 2 + 1 },
    ],
    destructibles: [],
    spawns: [
      { team: "red", position: { x: 20, y: 40 }, heading: 0 },
      { team: "blue", position: { x: 100, y: 40 }, heading: Math.PI },
    ],
    bases: [],
    flags: [],
    zones: [],
  };
}

// ---------------------------------------------------------------- módulos
const mod = (m: ModuleSpec): ModuleSpec => m;

export const MODULES = {
  tracks: mod({
    slot: "drive", moduleId: "movement.tracks@1", category: "movement",
    hp: 100, massKg: 400, costCredits: 120, passiveEUs: 2,
    maxSpeedMs: 9, accelerationMs2: 6, turnRateRads: 1.2, ratedLoadKg: 2600,
  }),
  wheels: mod({
    slot: "drive", moduleId: "movement.wheels@1", category: "movement",
    hp: 60, massKg: 200, costCredits: 90, passiveEUs: 1.5,
    maxSpeedMs: 13, accelerationMs2: 9, turnRateRads: 1.8, ratedLoadKg: 1600,
  }),
  battery: mod({
    slot: "power", moduleId: "power.battery@1", category: "power",
    hp: 50, massKg: 150, costCredits: 60, capacityEU: 400, generationEUs: 18,
  }),
  lidar360: mod({
    slot: "sensor_a", moduleId: "sensor.lidar360@1", category: "sensor",
    hp: 40, massKg: 60, costCredits: 140, passiveEUs: 4,
    sensorType: "lidar", rangeM: 40, fovRad: Math.PI * 2, rays: 32,
  }),
  lidarFront: mod({
    slot: "sensor_a", moduleId: "sensor.lidar_front@1", category: "sensor",
    hp: 40, massKg: 35, costCredits: 80, passiveEUs: 2,
    sensorType: "lidar", rangeM: 45, fovRad: Math.PI / 2, rays: 16,
  }),
  radar: mod({
    slot: "sensor_b", moduleId: "sensor.radar@1", category: "sensor",
    hp: 35, massKg: 50, costCredits: 130, passiveEUs: 5,
    sensorType: "radar", rangeM: 50, errorM: 2,
  }),
  acoustic: mod({
    slot: "sensor_c", moduleId: "sensor.acoustic@1", category: "sensor",
    hp: 20, massKg: 15, costCredits: 40, passiveEUs: 1,
    sensorType: "acoustic", rangeM: 60,
  }),
  cannon: mod({
    slot: "turret_main", moduleId: "weapon.cannon@1", category: "weapon",
    hp: 90, massKg: 380, costCredits: 190, passiveEUs: 1.5, perActionEU: 12,
    damage: 45, cooldownTicks: 30, projectileSpeedMs: 120, spreadRad: 0.01,
    turretArcRad: Math.PI * 2, turretRateRads: 1.0, acceptsAmmo: ["ammo.ap", "ammo.he"],
  }),
  mg: mod({
    slot: "turret_main", moduleId: "weapon.mg@1", category: "weapon",
    hp: 50, massKg: 120, costCredits: 90, passiveEUs: 1, perActionEU: 3,
    damage: 12, cooldownTicks: 6, projectileSpeedMs: 200, spreadRad: 0.05,
    turretArcRad: Math.PI * 2, turretRateRads: 2.2, acceptsAmmo: ["ammo.standard"],
  }),
  ammoAp: mod({
    slot: "ammo_main", moduleId: "ammo.ap@1", category: "ammo",
    hp: 30, massKg: 80, costCredits: 50, rounds: 40, damageMultiplier: 1.2, explosionRadiusM: 0,
  }),
  ammoHe: mod({
    slot: "ammo_main", moduleId: "ammo.he@1", category: "ammo",
    hp: 30, massKg: 90, costCredits: 60, rounds: 30, damageMultiplier: 0.9, explosionRadiusM: 5,
  }),
  ammoStd: mod({
    slot: "ammo_main", moduleId: "ammo.standard@1", category: "ammo",
    hp: 25, massKg: 50, costCredits: 30, rounds: 300, damageMultiplier: 1, explosionRadiusM: 0,
  }),
  mine: mod({
    slot: "mine_bay", moduleId: "mine.explosive@1", category: "mine",
    hp: 40, massKg: 120, costCredits: 100, perActionEU: 8,
    charges: 3, damage: 90, triggerRadiusM: 2.5, explosionRadiusM: 6,
    armDelayTicks: 30, cooldownTicks: 90, lifetimeTicks: 5400,
  }),
  armorFront: mod({
    slot: "armor_front", moduleId: "armor.steel_front@1", category: "armor",
    hp: 200, massKg: 420, costCredits: 120, sector: "front", reduction: 0.35,
  }),
  armorRear: mod({
    slot: "armor_rear", moduleId: "armor.steel_rear@1", category: "armor",
    hp: 120, massKg: 260, costCredits: 70, sector: "rear", reduction: 0.2,
  }),
  radio: mod({
    slot: "radio_a", moduleId: "radio.short@1", category: "radio",
    hp: 25, massKg: 20, costCredits: 40, passiveEUs: 1,
    rangeM: 80, maxMessageBytes: 32, maxMessagesPerSecond: 2,
  }),
};

/** Artillero medio: lento, pega fuerte, blindaje frontal. Catálogo real de E3 (T3.3). */
export function gunnerLoadout(): VehicleSpec {
  return resolveVehicle(ARCHETYPES.gunner, CATALOG);
}

/** Explorador ligero: rápido, lidar frontal, ametralladora. Catálogo real de E3 (T3.3). */
export function scoutLoadout(): VehicleSpec {
  return resolveVehicle(ARCHETYPES.scout, CATALOG);
}

/** Minador: siembra minas en pasillos. Catálogo real de E3 (T3.3). */
export function minerLoadout(): VehicleSpec {
  return resolveVehicle(ARCHETYPES.miner, CATALOG);
}

const SANDBAG_LOADOUT: LoadoutInput = {
  loadoutId: "ldt_sandbag01",
  revision: 1,
  catalogVersion: "mvp@1",
  chassis: "chassis.light@1",
  modules: [
    { slot: "drive", moduleId: "movement.wheels@1" },
    { slot: "power", moduleId: "power.battery@1" },
  ],
};

/** Sin armas ni sensores: el saco de arena. Prueba de degradación y de "bot ciego". */
export function sandbagLoadout(): VehicleSpec {
  return resolveVehicle(SANDBAG_LOADOUT, CATALOG);
}
