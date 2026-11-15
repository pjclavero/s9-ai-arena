/**
 * FIX-DELAY · Rótulo de espera del directo con retardo anti-coaching.
 *
 * Con `spectator.delaySeconds > 0`, tras el init el primer snapshot diferido tarda
 * hasta ese retardo en llegar (el init lleva el estado de `ahora - retardo`, que
 * al empezar la batalla todavía no existe). En vez de un mapa vacío en el tick 0,
 * el visor dice qué pasa. Puro: sin React ni Phaser.
 */
/**
 * FIX-DELAY · retardo anunciado por el init, en ms: `delayMs` (gateways nuevos)
 * o `delaySeconds` (todos). Valores no finitos o negativos ⇒ 0.
 */
export function announcedDelayMs(spectator: { delayMs?: unknown; delaySeconds?: unknown } | null | undefined): number {
  const ms = spectator?.delayMs;
  if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) return ms;
  const s = spectator?.delaySeconds;
  if (typeof s === "number" && Number.isFinite(s) && s > 0) return s * 1000;
  return 0;
}

/** Texto de espera, o null si no hay que mostrar nada (sin retardo o ya hay imagen). */
export function delayedWaitText(
  spectator: { delayMs?: unknown; delaySeconds?: unknown } | null | undefined,
  hasSnapshot: boolean,
): string | null {
  if (hasSnapshot) return null;
  const ms = announcedDelayMs(spectator);
  if (ms <= 0) return null;
  const s = Math.round(ms / 1000);
  return `Directo con retardo de ${s} s… la imagen llegará en breve`;
}
