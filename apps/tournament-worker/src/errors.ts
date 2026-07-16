/**
 * E9 · T9.1 — Clasificación de fallos del 19.2, formalizada como enumeración
 * (E9.M: el dosier la enuncia pero no la define).
 *
 * La distinción es la piedra angular de la justicia competitiva:
 *  - DERROTA DEPORTIVA (sporting): el bot es responsable (su código se cuelga,
 *    revienta o envía comandos inválidos). La batalla TERMINA con su derrota /
 *    descalificación y NO se reintenta jamás: reintentar daría segundas
 *    oportunidades a código defectuoso.
 *  - FALLO TÉCNICO (infrastructure): la plataforma es responsable (worker caído,
 *    motor que no arranca, mapa no descargable…). El bot no tiene culpa: la
 *    batalla SÍ se reintenta, con límite, y al agotarlo pasa a revisión manual.
 */

export const SPORTING_FAILURE_CODES = [
  "bot_timeout", // el código del bot no responde dentro del presupuesto de tiempo
  "bot_crash", // el proceso del bot murió por su propio código
] as const;

export const INFRASTRUCTURE_FAILURE_CODES = [
  "worker_died", // el worker que ejecutaba la batalla desapareció (lock caducado)
  "engine_start_failure", // el motor no llegó a arrancar
  "map_unavailable", // el mapa no se pudo cargar/descargar
  "artifact_unavailable", // el artefacto firmado del bot no está disponible
  "container_unavailable", // el bot-manager no pudo proporcionar el contenedor
  "storage_unavailable", // no se pudo persistir replay/resultado
] as const;

export type SportingFailureCode = (typeof SPORTING_FAILURE_CODES)[number];
export type InfrastructureFailureCode = (typeof INFRASTRUCTURE_FAILURE_CODES)[number];
export type FailureCode = SportingFailureCode | InfrastructureFailureCode;

export type FailureClass = "sporting" | "infrastructure";

export function classifyFailure(code: FailureCode): FailureClass {
  return (SPORTING_FAILURE_CODES as readonly string[]).includes(code) ? "sporting" : "infrastructure";
}

/** Fallo técnico: la cola lo reintenta hasta `max_attempts` y luego `needs_review`. */
export class InfrastructureFailure extends Error {
  constructor(
    readonly code: InfrastructureFailureCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "InfrastructureFailure";
  }
}

/**
 * Fallo deportivo detectado durante la ejecución (p. ej. el contenedor del bot
 * se cuelga y hay que abortar la batalla). NO es un error de la cola: el handler
 * lo convierte en derrota del bot culpable y el trabajo termina en `done`.
 */
export class SportingFailure extends Error {
  constructor(
    readonly code: SportingFailureCode,
    /** bot responsable: pierde la batalla */
    readonly botId: string,
    message: string,
  ) {
    super(`[${code}] bot ${botId}: ${message}`);
    this.name = "SportingFailure";
  }
}
