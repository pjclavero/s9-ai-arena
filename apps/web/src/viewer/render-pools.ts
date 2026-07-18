/**
 * R3.3 · ERR-VIS-09 — Políticas PURAS de los pools de render del visor.
 *
 * El pool de proyectiles del visor sólo CRECÍA: un snapshot con miles de
 * proyectiles (bug o snapshot hostil) creaba miles de sprites que jamás se
 * liberaban. Aquí vive el TECHO del pool y el conteo de sprites visibles por
 * frame — lógica pura, probada con vitest sin Phaser.
 */

/**
 * Techo de sprites de proyectil que el visor mantiene vivos. 256 cubre con
 * holgura la densidad real (8 bots disparando) sin permitir un crecimiento sin
 * límite: por encima, los proyectiles sobrantes simplemente no se dibujan.
 */
export const MAX_PROJECTILE_SPRITES = 256;

/**
 * Cuántos proyectiles se dibujan este frame: nunca menos de 0 ni por encima del
 * techo. El pool crece bajo demanda pero sólo hasta `cap`.
 */
export function visibleProjectileCount(requested: number, cap = MAX_PROJECTILE_SPRITES): number {
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  return Math.min(Math.floor(requested), cap);
}
