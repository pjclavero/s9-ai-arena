/**
 * EQ4 · Nombres HUMANOS de los slots del chasis y de las categorías de módulo.
 *
 * El identificador interno (`drive`, `turret_main`…) es la clave del contrato
 * (loadouts, motor, replays) y NO cambia; la interfaz muestra el nombre humano
 * como principal y el id sólo como dato técnico secundario. Un slot nuevo que
 * aún no tenga nombre aquí se rotula por su patrón (`sensor_c` → «Sensor C»)
 * en vez de enseñar el id crudo; el test `eq4-slot-names.test.ts` exige que
 * todos los slots del catálogo real tengan nombre explícito.
 */
import type { ModuleCategory } from "../../../packages/module-catalog/types.js";

export interface SlotInfo {
  name: string;
  /** Para qué sirve el slot (texto del ⓘ). */
  purpose: string;
}

export const SLOT_INFO: Record<string, SlotInfo> = {
  drive: { name: "Propulsión", purpose: "Mueve el vehículo: orugas o ruedas. Fija la velocidad punta y la aceleración." },
  power: { name: "Energía", purpose: "Generador o batería que alimenta sensores, armas y radio." },
  sensor_a: { name: "Sensor principal", purpose: "Lo que el bot ve de su entorno (radar, lidar, acústico…)." },
  sensor_b: { name: "Sensor secundario", purpose: "Un segundo sensor que complementa al principal." },
  turret_main: { name: "Torreta principal", purpose: "El arma del vehículo (cañón, ametralladora…)." },
  ammo_main: { name: "Munición principal", purpose: "Cargador de munición para el arma de la torreta." },
  mine_bay: { name: "Compartimento de minas", purpose: "Minas u otro equipo auxiliar que el bot puede soltar." },
  radio_a: { name: "Radio", purpose: "Envía y recibe mensajes del resto del equipo (también los oye el rival)." },
  armor_front: { name: "Blindaje frontal", purpose: "Reduce el daño de los impactos que llegan por delante." },
  armor_left: { name: "Blindaje izquierdo", purpose: "Reduce el daño de los impactos que llegan por la izquierda." },
  armor_right: { name: "Blindaje derecho", purpose: "Reduce el daño de los impactos que llegan por la derecha." },
  armor_rear: { name: "Blindaje trasero", purpose: "Reduce el daño de los impactos que llegan por detrás." },
};

export const CATEGORY_NAME: Record<ModuleCategory, string> = {
  chassis: "chasis",
  movement: "propulsión",
  power: "energía",
  sensor: "sensor",
  weapon: "arma",
  ammo: "munición",
  mine: "minas",
  armor: "blindaje",
  radio: "radio",
  utility: "utilidad",
};

const PREFIX_NAME: Record<string, string> = {
  sensor: "Sensor",
  turret: "Torreta",
  ammo: "Munición",
  armor: "Blindaje",
  radio: "Radio",
  mine: "Minas",
  power: "Energía",
  drive: "Propulsión",
};

/** Nombre humano del slot; nunca devuelve el id crudo con guiones bajos. */
export function slotName(id: string): string {
  const known = SLOT_INFO[id];
  if (known) return known.name;
  const [head, ...rest] = id.split("_");
  const base = PREFIX_NAME[head] ?? head.charAt(0).toUpperCase() + head.slice(1);
  return [base, ...rest.map((r) => r.toUpperCase())].join(" ");
}

export function slotPurpose(id: string): string | undefined {
  return SLOT_INFO[id]?.purpose;
}

export function categoryName(c: string): string {
  return (CATEGORY_NAME as Record<string, string>)[c] ?? c;
}
