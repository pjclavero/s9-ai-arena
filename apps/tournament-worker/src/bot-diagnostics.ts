/**
 * UX-06 · Diagnóstico por bot de UNA batalla (forma `bot-diagnostics/v1`).
 *
 * Lo que el replay NO cuenta y sólo sabe quien ejecutó la batalla: si el bot
 * arrancó, si completó el HELLO, qué COMMAND se descartaron antes de llegar al
 * motor y cómo terminó su contenedor. Se persiste en `participants.diagnostics`
 * (migración 014) en la MISMA transacción que el resultado, como `cpu_ms`; la API
 * lo combina con `battle_stats` (decisiones, timeouts, rechazos por motivo) y lo
 * entrega SÓLO al dueño del bot y al staff (TD-047).
 *
 * Nunca lleva detalles del sandbox (perfil seccomp, red, proxy, tokens, rutas ni
 * mensajes internos): sólo códigos y contadores.
 */
import type { BotProtocolDiagnostics } from "../../arena-engine/src/protocol-server.js";
import type { ContainerRunState } from "../../bot-manager/src/container-runner.js";

export interface BotContainerDiagnostics {
  /** Código de salida si el contenedor terminó durante la batalla; null si no se sabe. */
  exitCode: number | null;
  /** El kernel lo mató por memoria. */
  oomKilled: boolean;
  /** El proceso del bot terminó (o desapareció) ANTES de que acabara la batalla. */
  exitedDuringBattle: boolean;
}

export interface BotRunDiagnostics {
  schema: "bot-diagnostics/v1";
  /**
   * Arranque del bot. `ok: false` sólo cuando la culpa es del bot (19.2):
   * `bot_execution_timeout` (no llegó al HELLO a tiempo) o `bot_crash`.
   */
  startup: {
    ok: boolean;
    /** UX-F (DEF-R4) · `hook_missing`: el bootstrap rechazó la clase por no implementar el hook. */
    reason?: "bot_execution_timeout" | "bot_crash" | "hook_missing";
    /**
     * UX-F (DEF-R4) · arrancó y jugó, PERO la versión no implementa el hook: su
     * código no decide nada (versiones publicadas antes de exigirlo).
     */
    warning?: "hook_missing";
  };
  /** Transporte (ProtocolServer). Ausente si la batalla no llegó a correr. */
  protocol?: BotProtocolDiagnostics;
  /** Contenedor del bot. Ausente si el runner no sabe medirlo. */
  container?: BotContainerDiagnostics;
}

/** Proyección SIN detalles del sandbox del estado de un contenedor. */
export function containerDiagnostics(state: ContainerRunState | null, duringBattle: boolean): BotContainerDiagnostics {
  const exited = state !== null && (!state.running || state.gone);
  return {
    exitCode: state && !state.running && !state.gone ? state.exitCode : null,
    oomKilled: Boolean(state?.oomKilled),
    exitedDuringBattle: duringBattle && exited,
  };
}
