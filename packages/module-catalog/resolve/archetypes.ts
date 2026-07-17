/**
 * Los 4 arquetipos de referencia del MVP (T3.3 golden files, T3.4 banco de balance).
 * Cada uno es un LoadoutInput legal contra el catálogo real con BUDGET_CREDITS_MVP.
 * Verificado a mano en docs/balance/v1.md y por data.test.ts (constructivos por chasis).
 *
 * FORMA CANÓNICA (R1.1 / issue #15): la munición es una PROPIEDAD del arma (`ammo:`), NO
 * un módulo aparte. resolveVehicle materializa el módulo de munición en la bahía del
 * chasis (ammo_main). Antes, estos fixtures duplicaban la munición a mano (un módulo
 * `ammo_main` además de `ammo:`), lo que enmascaraba que el resolvedor la descartaba.
 */
import { CATALOG_VERSION } from "../loadCatalog.js";
import type { LoadoutInput } from "../types.js";

/** Ligero-explorador: rápido, lidar frontal, ametralladora. Cuesta 540/1000. */
export const scoutLoadout: LoadoutInput = {
  loadoutId: "ldt_scout01",
  revision: 1,
  name: "Explorador ligero",
  catalogVersion: CATALOG_VERSION,
  chassis: "chassis.light@1",
  modules: [
    { slot: "drive", moduleId: "movement.wheels@1" },
    { slot: "power", moduleId: "power.battery@1" },
    { slot: "sensor_a", moduleId: "sensor.lidar_front@1" },
    { slot: "turret_main", moduleId: "weapon.mg@1", ammo: "ammo.standard@1" },
    { slot: "radio_a", moduleId: "radio.short@1" },
  ],
};

/** Medio-polivalente/artillero: cañón + blindaje frontal. Cuesta 940/1000. */
export const gunnerLoadout: LoadoutInput = {
  loadoutId: "ldt_gunner01",
  revision: 1,
  name: "Artillero medio",
  catalogVersion: CATALOG_VERSION,
  chassis: "chassis.medium@1",
  modules: [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: "power.generator@1" },
    { slot: "sensor_a", moduleId: "sensor.radar@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
    { slot: "armor_front", moduleId: "armor.steel_front@1" },
    { slot: "radio_a", moduleId: "radio.short@1" },
  ],
};

/** Minador: siembra minas en pasillos, MG de apoyo, blindaje trasero. Cuesta 780/1000. */
export const minerLoadout: LoadoutInput = {
  loadoutId: "ldt_miner01",
  revision: 1,
  name: "Minador medio",
  catalogVersion: CATALOG_VERSION,
  chassis: "chassis.medium@1",
  modules: [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: "power.generator@1" },
    { slot: "sensor_a", moduleId: "sensor.lidar_front@1" },
    { slot: "mine_bay", moduleId: "mine.explosive@1" },
    { slot: "turret_main", moduleId: "weapon.mg@1", ammo: "ammo.standard@1" },
    { slot: "armor_rear", moduleId: "armor.steel_rear@1" },
  ],
};

/** Pesado-artillero: chasis de asedio, cañón, blindaje frontal. Cuesta 970/1000: casi todo el presupuesto en supervivencia y daño, sin margen para más. */
export const heavyLoadout: LoadoutInput = {
  loadoutId: "ldt_heavy01",
  revision: 1,
  name: "Pesado de asedio",
  catalogVersion: CATALOG_VERSION,
  chassis: "chassis.heavy@1",
  modules: [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: "power.generator@1" },
    { slot: "sensor_a", moduleId: "sensor.lidar360@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
    { slot: "armor_front", moduleId: "armor.steel_front@1" },
  ],
};

export const ARCHETYPES = {
  scout: scoutLoadout,
  gunner: gunnerLoadout,
  miner: minerLoadout,
  heavy: heavyLoadout,
} as const;
