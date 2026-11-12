/**
 * OLA 2 · MC · P-2 · `weapon.rangeM` es la fuente REAL del alcance.
 *
 * Contrato G1 (docs/technical/engine-v2-contracts.md §11): la vida del proyectil la resuelve
 * resolveVehicle() a partir del catálogo; el motor ya no fija un TTL propio (antes, 90 ticks
 * fijos en combat.ts). Alcance efectivo = vida · velocidad · TICK_DT, y ese alcance es
 * EXACTAMENTE el `rangeM` declarado: si rangeM no es un múltiplo entero de lo que avanza el
 * proyectil en un tick, el dato no puede ser verdad y se rechaza (fail-closed), en vez de
 * redondear a un alcance distinto del declarado.
 */
import { TICK_HZ } from "../../game-rules/index.js";

/** Tolerancia de coma flotante al comprobar que la vida es entera. */
const INTEGER_EPS = 1e-9;

export class InvalidProjectileRangeError extends Error {}

/**
 * Vida en ticks de un proyectil de `speedMs` cuyo alcance declarado es `rangeM`.
 * rangeM · TICK_HZ / speedMs debe ser un entero ≥ 1.
 */
export function projectileLifetimeTicks(rangeM: number, speedMs: number): number {
  if (!(Number.isFinite(rangeM) && rangeM > 0) || !(Number.isFinite(speedMs) && speedMs > 0)) {
    throw new InvalidProjectileRangeError(`rangeM (${rangeM}) y projectileSpeedMs (${speedMs}) deben ser > 0`);
  }
  // Se multiplica antes de dividir: 600·30/200 = 90 exacto (600/(200/30) no lo es).
  const ticks = (rangeM * TICK_HZ) / speedMs;
  const rounded = Math.round(ticks);
  if (Math.abs(ticks - rounded) > INTEGER_EPS || rounded < 1) {
    throw new InvalidProjectileRangeError(
      `rangeM ${rangeM} no es un múltiplo entero del avance por tick (${speedMs}/${TICK_HZ} m): ` +
        `el alcance real no podría coincidir con el declarado`,
    );
  }
  return rounded;
}
