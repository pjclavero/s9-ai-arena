/**
 * B9 (revisión del supervisor) · Duración REAL de una batalla, en un solo sitio.
 *
 * POR QUÉ EXISTE ESTE MÓDULO: había DOS presupuestos de tiempo para la misma
 * batalla, calculados en ficheros distintos y sin relación entre sí:
 *
 *   - `container-battle.ts` (motor): guard global = `ticks × tickIntervalMs + 15 s`.
 *   - `battle-run-http-launcher.ts` (API): `AbortController` a 30 s FIJOS.
 *
 * Mientras el launcher enviaba un `rulesetId` inválido, la batalla moría antes de
 * empezar y nadie notaba el desajuste. Al resolver el ruleset de verdad (`ticks` =
 * `timeLimitTicks` = 9000 en los rulesets MVP), la batalla pasa a durar
 * 9000 × 34 ms ≈ **306 s** — diez veces el timeout HTTP del launcher. Una práctica
 * de 2 bots en deathmatch SIEMPRE agota el límite de tiempo (`scoreToWin: 5`, sin
 * respawn, dos vehículos: nadie llega a 5 bajas), así que el caso normal habría
 * sido: la API aborta a los 30 s con "arena-engine no respondió", los contenedores
 * siguen vivos 4-5 minutos más y el replay se tira. Un timeout no es mejor que el
 * 502 anterior: es el mismo fallo con otro mensaje.
 *
 * Las dos capas derivan ahora sus plazos de las MISMAS funciones. Si alguien cambia
 * la cadencia o el margen, cambia para las dos a la vez.
 */

/**
 * ms reales por tick cuando nadie fija `tickIntervalMs`. Es el valor histórico de
 * `container-battle.ts` (34 ms ≈ 30 Hz redondeado hacia arriba); se conserva tal
 * cual para no alterar el ritmo de las batallas ya grabadas, y redondear hacia
 * ARRIBA es lo prudente para un presupuesto de tiempo.
 */
export const DEFAULT_TICK_INTERVAL_MS = 34;

/** Margen del guard global del motor sobre la duración teórica (arranque de
 *  contenedores, handshake, cierre). Valor histórico de `container-battle.ts`. */
export const CONTAINER_BATTLE_GRACE_MS = 15_000;

/**
 * Margen ADICIONAL del cliente HTTP (la API) sobre el guard del motor: la petición
 * `POST /run` no puede abortar ANTES que el propio motor se rinda, o la API daría
 * por perdida una batalla que sigue corriendo (contenedores vivos, replay que nadie
 * recoge). Cubre serialización del replay (cientos de KB), latencia de red interna
 * y el tiempo de limpieza de los contenedores.
 */
export const RUN_HTTP_OVERHEAD_MS = 30_000;

/**
 * Margen TOTAL del cliente HTTP sobre la duración teórica: el del guard del motor
 * más el suyo propio. Así el plazo de la API es SIEMPRE mayor que el del motor
 * (`containerBattleOverallTimeoutMs`), que es quien puede limpiar los contenedores.
 */
export const RUN_HTTP_MARGIN_MS = CONTAINER_BATTLE_GRACE_MS + RUN_HTTP_OVERHEAD_MS;

/**
 * Techo REAL de `setTimeout` en Node: el retardo se guarda en un entero de 32 bits
 * con signo. Un valor mayor NO espera más — se trunca a 1 ms y el temporizador
 * dispara de inmediato (Node solo avisa con `TimeoutOverflowWarning`, que no es un
 * log de la aplicación y pasa desapercibido). Cualquier plazo que vaya a un
 * `setTimeout` debe acotarse aquí: pasarse de largo invierte el efecto que se
 * buscaba (hallazgo del supervisor sobre `ARENA_ENGINE_RUN_TIMEOUT_MS`).
 */
export const MAX_SET_TIMEOUT_MS = 2_147_483_647;

/** Duración teórica de la batalla: todos los ticks jugados al ritmo real. */
export function theoreticalBattleMs(ticks: number, tickIntervalMs: number = DEFAULT_TICK_INTERVAL_MS): number {
  return ticks * tickIntervalMs;
}

/**
 * Techo del guard del MOTOR. Deliberadamente por debajo de `MAX_SET_TIMEOUT_MS`:
 * si los dos plazos se acotaran al mismo valor, en el techo dejarían de estar
 * ordenados y el motor ya no se rendiría ANTES que la API — que es justo el
 * invariante por el que existe este módulo (el motor es quien puede limpiar los
 * contenedores). Restando el margen propio de la API, el orden se mantiene
 * incluso en el caso extremo.
 */
export const MAX_CONTAINER_BATTLE_TIMEOUT_MS = MAX_SET_TIMEOUT_MS - RUN_HTTP_OVERHEAD_MS;

/**
 * Plazo del guard global del motor (`runContainerBattle`) para esa batalla.
 *
 * ACOTADO: este valor va a un `setTimeout` de verdad (container-battle.ts). Sin
 * acotar, un `ticks` grande con un `tickIntervalMs` grande —ambos aceptados por
 * el validador de `/run`— produce un plazo por encima de 2^31-1 ms y el
 * temporizador dispara A LOS 1-2 ms: la batalla se aborta nada más lanzarla, que
 * es el fallo OPUESTO al que el guard pretende evitar. Lo encontró el supervisor
 * de B9 ejecutando el servicio real con `ticks: 1_000_000, tickIntervalMs: 3000`:
 * 502 en 318 ms con "timeout global tras 3000015000 ms".
 */
export function containerBattleOverallTimeoutMs(
  ticks: number,
  tickIntervalMs: number = DEFAULT_TICK_INTERVAL_MS,
): number {
  const derivado = theoreticalBattleMs(ticks, tickIntervalMs) + CONTAINER_BATTLE_GRACE_MS;
  return Math.min(derivado, MAX_CONTAINER_BATTLE_TIMEOUT_MS);
}

/**
 * Plazo del cliente HTTP de la API para `POST /run`: duración teórica + margen.
 * Con el margen por defecto es SIEMPRE mayor que el guard del motor (quien debe
 * rendirse primero es el motor, que es quien puede limpiar los contenedores).
 * `marginMs` se puede bajar para probar el cálculo en segundos en vez de minutos;
 * bajarlo por debajo de `CONTAINER_BATTLE_GRACE_MS` en producción invertiría ese
 * orden y es lo único que no se debe hacer con este parámetro.
 */
export function runHttpTimeoutMs(
  ticks: number,
  tickIntervalMs: number = DEFAULT_TICK_INTERVAL_MS,
  marginMs: number = RUN_HTTP_MARGIN_MS,
): number {
  return theoreticalBattleMs(ticks, tickIntervalMs) + marginMs;
}
