/**
 * ÚNICA fuente sancionada de reloj de pared del motor (R2.7 / ERR-ENG-02).
 *
 * El lint de determinismo vigila TODO src/ y prohíbe Date/performance/timers en
 * cualquier fichero no excluido. Pero hay metadatos legítimos que necesitan la hora
 * real y NO tocan la simulación: `recordedAt` en la cabecera de un replay, ids de
 * batalla locales. Ese uso se concentra aquí, en un fichero minúsculo que está en la
 * lista de exclusión del lint CON NOMBRE Y MOTIVO.
 *
 * Regla: nada de lo que devuelva este módulo puede entrar en la lógica de tick, en
 * una observación ni en el hash de estado. Si necesitas tiempo DE JUEGO, es un tick.
 */

/** Instante actual en ISO-8601. Solo para metadatos (cabeceras, logs), jamás simulación. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Milisegundos de época. Solo para ids/nombres locales, jamás simulación. */
export function nowMs(): number {
  return Date.now();
}
