/**
 * R3.5 · ERR-VIS-05 — Daño VISIBLE que coincide EXACTAMENTE con el estado público.
 *
 * El motor sólo publica, por vehículo, `hullHp/hullHpMax` y `modules: [{slot,state}]`
 * (el HP por sector de blindaje NO es público: vive sólo en el hash). Por tanto el
 * daño que el visor pinta debe DERIVARSE de esos dos datos y de nada más — así el
 * estado visible siempre corresponde con lo que el espectador tiene derecho a ver
 * (DoD: "el estado visible de daño coincide con el estado público del motor").
 *
 * Categoría del módulo por CONVENCIÓN DE NOMBRE del slot (el snapshot público no
 * trae la categoría): turret_main→arma, drive→movimiento, armor_*→blindaje, etc.
 * Es la misma nomenclatura del catálogo de módulos (packages/module-catalog).
 *
 * Puro y sin Phaser: se prueba con vitest en Node.
 */
import type { VehicleOverlay } from "./overlay.js";

export type SlotKind = "weapon" | "movement" | "armor" | "sensor" | "power" | "ammo" | "mine" | "radio" | "other";

/** Estados de módulo del motor (ModuleState de E2), de sano a inútil. */
export type ModuleState = "operational" | "damaged" | "critical" | "destroyed" | "offline";

/** Un módulo fuera de combate: destruido o apagado (no puede actuar). */
export function moduleDisabled(state: string): boolean {
  return state === "destroyed" || state === "offline";
}

/**
 * Categoría de un slot por su nombre. Coincide con la convención del catálogo:
 * `turret_main`/`weapon*`/`gun*`/`cannon*`→arma, `drive`/`track*`/`movement*`→
 * movimiento, `armor_*`→blindaje, `sensor_*`→sensor, `power`→energía,
 * `ammo_*`→munición, `mine_*`→minas, `radio_*`→radio. Tolera mayúsculas/versiones.
 */
export function slotKind(slot: string): SlotKind {
  const s = (slot ?? "").toLowerCase();
  if (/(turret|weapon|gun|cannon)/.test(s)) return "weapon";
  if (/(drive|track|movement|mobility|wheel)/.test(s)) return "movement";
  if (/armor/.test(s)) return "armor";
  if (/sensor/.test(s)) return "sensor";
  if (/power/.test(s)) return "power";
  if (/ammo/.test(s)) return "ammo";
  if (/mine/.test(s)) return "mine";
  if (/radio/.test(s)) return "radio";
  return "other";
}

/** Estado visible de daño de un vehículo, derivado SÓLO de datos públicos. */
export interface DamageVisual {
  alive: boolean;
  /** Fracción de casco 0..1 (clamp; hullHpMax≤0 ⇒ 0). */
  hullRatio: number;
  /** Slots con estado `destroyed` (orden estable por nombre). */
  destroyedModules: string[];
  /** Torreta bloqueada: algún módulo de ARMA destruido u offline. */
  turretLocked: boolean;
  /** Blindaje roto: algún módulo de BLINDAJE destruido u offline. */
  armorBroken: boolean;
  /** Movilidad tocada: algún módulo de MOVIMIENTO destruido u offline. */
  mobilityCrippled: boolean;
  /** Nivel de humo del casco 0..1 (crece al bajar el casco). Ver `smokeLevel`. */
  smoke: number;
}

/**
 * Nivel de humo por fracción de casco: 0 por encima de `START` (~60%), sube
 * linealmente hasta 1 al llegar a 0. Monótono NO creciente en `hullRatio`: menos
 * casco ⇒ más humo, nunca al revés. Un vehículo destruido humea al máximo.
 */
const SMOKE_START = 0.6;
export function smokeLevel(hullRatio: number, alive = true): number {
  if (!alive) return 1;
  const r = hullRatio <= 0 ? 0 : hullRatio >= 1 ? 1 : hullRatio;
  if (r >= SMOKE_START) return 0;
  return (SMOKE_START - r) / SMOKE_START;
}

/**
 * Traduce el estado PÚBLICO de un vehículo a su daño visible. La correspondencia
 * es exacta y comprobable: `destroyedModules` son justo los slots en `destroyed`,
 * `turretLocked` ⇔ hay un arma inutilizada, etc. No inventa nada que el motor no
 * exponga.
 */
export function damageVisualFor(v: VehicleOverlay): DamageVisual {
  const destroyed: string[] = [];
  let turretLocked = false;
  let armorBroken = false;
  let mobilityCrippled = false;
  for (const [slot, state] of Object.entries(v.modules ?? {})) {
    if (state === "destroyed") destroyed.push(slot);
    if (moduleDisabled(state)) {
      const kind = slotKind(slot);
      if (kind === "weapon") turretLocked = true;
      else if (kind === "armor") armorBroken = true;
      else if (kind === "movement") mobilityCrippled = true;
    }
  }
  destroyed.sort();
  const hullRatio = v.hullHpMax > 0 ? Math.max(0, Math.min(1, v.hullHp / v.hullHpMax)) : 0;
  return {
    alive: v.alive,
    hullRatio,
    destroyedModules: destroyed,
    turretLocked,
    armorBroken,
    mobilityCrippled,
    smoke: smokeLevel(hullRatio, v.alive),
  };
}
