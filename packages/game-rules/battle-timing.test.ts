/**
 * B9 · El guard del MOTOR también se acota (defecto 1 del re-supervisor).
 *
 * `battle-timing.ts` declara que "cualquier plazo que vaya a un `setTimeout`
 * debe acotarse aquí", pero el único consumidor del propio módulo que va
 * directo a un `setTimeout` —el guard global de `runContainerBattle`— era el
 * que NO se acotaba. Por encima de 2^31-1 ms Node trunca el retardo y el
 * temporizador dispara a los 1-2 ms: la batalla se aborta NADA MÁS LANZARLA,
 * que es el fallo opuesto al que el guard existe para evitar.
 *
 * El supervisor lo demostró contra el servicio real con un cuerpo que el
 * validador de `/run` acepta (`ticks: 1_000_000`, `tickIntervalMs: 3000`):
 * 502 en 318 ms con "timeout global tras 3000015000 ms".
 */
import { describe, expect, it } from "vitest";
import {
  CONTAINER_BATTLE_GRACE_MS,
  MAX_CONTAINER_BATTLE_TIMEOUT_MS,
  MAX_SET_TIMEOUT_MS,
  containerBattleOverallTimeoutMs,
  runHttpTimeoutMs,
  theoreticalBattleMs,
} from "./battle-timing.js";

/** Lo que Node hace de verdad con el retardo: entero de 32 bits con signo. */
function retardoRealDeSetTimeout(ms: number): number {
  return ms > MAX_SET_TIMEOUT_MS || ms < 1 ? 1 : ms;
}

describe("B9 · plazos de batalla acotados al máximo real de setTimeout", () => {
  it("el guard del motor nunca supera lo que setTimeout sabe esperar", () => {
    // Valores ACEPTADOS por el validador de /run, no inventados.
    for (const [ticks, intervalo] of [
      [1_000_000, 3000],
      [1_000_000, 34],
      [500_000, 5000],
    ] as const) {
      const plazo = containerBattleOverallTimeoutMs(ticks, intervalo);
      expect(plazo).toBeLessThanOrEqual(MAX_SET_TIMEOUT_MS);
      // Lo que de verdad importa: el temporizador NO dispara de inmediato.
      expect(retardoRealDeSetTimeout(plazo)).toBe(plazo);
    }
  });

  it("el caso exacto del supervisor ya no aborta al instante", () => {
    const plazo = containerBattleOverallTimeoutMs(1_000_000, 3000);
    expect(theoreticalBattleMs(1_000_000, 3000) + CONTAINER_BATTLE_GRACE_MS).toBeGreaterThan(MAX_SET_TIMEOUT_MS);
    expect(retardoRealDeSetTimeout(plazo)).not.toBe(1);
  });

  it("en el techo, el motor SIGUE rindiéndose antes que la API (el invariante del bloque)", () => {
    // Si los dos se acotaran al mismo valor, en el extremo empatarían y el
    // motor —el único que puede limpiar contenedores— dejaría de ir primero.
    const ticks = 1_000_000;
    const intervalo = 3000;
    const motor = containerBattleOverallTimeoutMs(ticks, intervalo);
    const api = Math.min(runHttpTimeoutMs(ticks, intervalo), MAX_SET_TIMEOUT_MS);
    expect(motor).toBeLessThan(api);
    expect(MAX_CONTAINER_BATTLE_TIMEOUT_MS).toBeLessThan(MAX_SET_TIMEOUT_MS);
  });

  it("por debajo del techo no se toca nada (la acotación no cambia el caso normal)", () => {
    // Literal a propósito (obs. 3 del supervisor): escribir el margen como
    // `+ CONTAINER_BATTLE_GRACE_MS` hacía el test TAUTOLÓGICO —poner la gracia a
    // 0 lo dejaba verde— y entonces no protegía el valor del margen, solo su
    // nombre. 9000 × 34 + 15 000 = 321 000.
    expect(containerBattleOverallTimeoutMs(9000, 34)).toBe(321_000);
    expect(CONTAINER_BATTLE_GRACE_MS).toBe(15_000);
  });

  it("recortar el guard NO es silencioso: 24,85 días sin rastro es no tener guard", () => {
    // obs. 2 del supervisor. Acotar arregla el "aborta al instante", pero deja un
    // guard que tarda casi un mes en saltar; si eso no se registra, unos
    // contenedores colgados no dejan ninguna pista de por qué.
    const avisos: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void avisos.push(String(a[0]));
    try {
      containerBattleOverallTimeoutMs(1_000_000, 3000);
      expect(containerBattleOverallTimeoutMs(9000, 34)).toBe(321_000); // caso normal: sin ruido
    } finally {
      console.error = original;
    }
    expect(avisos).toHaveLength(1);
    const log = JSON.parse(avisos[0]);
    expect(log.level).toBe("warn");
    expect(log.appliedTimeoutMs).toBe(MAX_CONTAINER_BATTLE_TIMEOUT_MS);
    expect(log.requestedTimeoutMs).toBe(3_000_015_000);
  });
});
