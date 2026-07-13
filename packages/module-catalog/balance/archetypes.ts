/**
 * Arquetipos usados por el banco de balance (T3.4), distintos de los goldens de T3.3
 * (resolve/archetypes.ts) por dos razones concretas, las dos encontradas CORRIENDO
 * el banco de verdad (no a priori) y documentadas con cifras en docs/balance/v1.md:
 *
 * 1. HunterBot (apps/arena-engine/src/stubs.ts) solo dispara a contactos de
 *    `obs.sensors.radar` — el lidar solo alimenta su evitación de obstáculos, no su
 *    puntería. Los goldens de T3.3 usan lidar en el explorador y el pesado; aquí se
 *    sustituye por sensor.radar para que los tres puedan detectar y disparar.
 * 2. La primera ejecución real del banco (200 batallas/emparejamiento) dio
 *    scout_vs_gunner=0,5%, scout_vs_heavy=0,0%, gunner_vs_heavy=39,2%: muy fuera de
 *    45-55%. Los módulos @1 (weapon.mg, power.generator, chassis.light,
 *    chassis.medium) NUNCA se tocan (cap. 10.4; son los que usan los goldens de
 *    T3.3) — el ajuste crea @2 de cada uno y estos arquetipos de balance son los
 *    que los usan. Ver docs/balance/v1.md para la justificación módulo a módulo de
 *    cada @2 y docs/balance/informe-v1.md para el resultado antes/después.
 */
import { CATALOG_VERSION } from "../loadCatalog.js";
import type { LoadoutInput } from "../types.js";

export const scoutRadarLoadout: LoadoutInput = {
  loadoutId: "ldt_scout_radar01",
  revision: 2,
  name: "Explorador ligero (variante radar + balance v2 para el banco)",
  catalogVersion: CATALOG_VERSION,
  chassis: "chassis.light@2",
  modules: [
    { slot: "drive", moduleId: "movement.wheels@1" },
    { slot: "power", moduleId: "power.generator@2" },
    { slot: "sensor_a", moduleId: "sensor.radar@1" },
    { slot: "turret_main", moduleId: "weapon.mg@2", ammo: "ammo.standard@1" },
    { slot: "ammo_main", moduleId: "ammo.standard@1" },
    { slot: "radio_a", moduleId: "radio.short@1" },
  ],
};

export const gunnerRadarLoadout: LoadoutInput = {
  loadoutId: "ldt_gunner_radar01",
  revision: 2,
  name: "Artillero medio (variante balance v2 para el banco)",
  catalogVersion: CATALOG_VERSION,
  chassis: "chassis.medium@2",
  modules: [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: "power.generator@1" },
    { slot: "sensor_a", moduleId: "sensor.radar@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
    { slot: "ammo_main", moduleId: "ammo.ap@1" },
    { slot: "armor_front", moduleId: "armor.steel_front@1" },
    { slot: "radio_a", moduleId: "radio.short@1" },
  ],
};

export const heavyRadarLoadout: LoadoutInput = {
  loadoutId: "ldt_heavy_radar01",
  revision: 1,
  name: "Pesado de asedio (variante radar para el banco de balance)",
  catalogVersion: CATALOG_VERSION,
  chassis: "chassis.heavy@1",
  modules: [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: "power.generator@1" },
    { slot: "sensor_a", moduleId: "sensor.radar@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
    { slot: "ammo_main", moduleId: "ammo.ap@1" },
    { slot: "armor_front", moduleId: "armor.steel_front@1" },
  ],
};

export const BALANCE_ARCHETYPES = {
  scout: scoutRadarLoadout,
  gunner: gunnerRadarLoadout,
  heavy: heavyRadarLoadout,
} as const;
