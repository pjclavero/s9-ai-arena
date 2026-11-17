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
  "engine_start_failure", // el motor no llegó a arrancar (no hubo primer tick)
  // v0.5.0 · la batalla ARRANCÓ y jugó, pero agotó el guard de reloj de pared. No es un
  // fallo de arranque: se reintenta como mucho una vez más (ver RETRY_POLICY).
  "battle_timeout",
  // v0.5.0 · la BD no respondió (pool sin conexión, ECONNREFUSED, EAI_AGAIN, backend
  // terminado…). Transitorio: se reintenta con backoff; no es un bug del worker.
  "db_unavailable",
  "map_unavailable", // el mapa no se pudo cargar/descargar
  "artifact_unavailable", // el artefacto firmado del bot no está disponible
  "container_unavailable", // el bot-manager no pudo proporcionar el contenedor
  "storage_unavailable", // no se pudo persistir replay/resultado
  // DEV-B · la batalla la tiene reservada OTRO titular con el lease vivo (trabajo
  // duplicado) o este worker perdió la reserva a mitad: no se ejecuta ni se
  // finaliza dos veces; el reintento la verá `finished` si el titular la cierra.
  "battle_busy",
  // OLA2-MF · aborto pedido de una batalla propia (MANUAL_ABORT o parada del
  // worker): la reserva se devuelve a `scheduled` tras el teardown.
  "battle_aborted",
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
    /** Quién conducía los vehículos (queda en battles.result.agents). */
    readonly agents?: "container" | "in_process_stub" | "scripted",
    /**
     * UX-F (DEF-R4) · motivo de arranque para el diagnóstico del dueño cuando es más
     * preciso que el código (p. ej. `hook_missing` en vez de `bot_crash`).
     */
    readonly startupReason?: "hook_missing",
  ) {
    super(`[${code}] bot ${botId}: ${message}`);
    this.name = "SportingFailure";
  }
}

/**
 * Política de reintento por código de infraestructura (v0.5.0).
 *
 *  - Por defecto: hasta `max_attempts` del trabajo, backoff 1 s·2^n con tope 60 s.
 *  - `battle_timeout`: UN reintento como máximo (tope 2 intentos). Cada intento cuesta
 *    ~6,6 min de reloj y mantiene 3 motores y los contenedores; repetir 3 veces una
 *    batalla que se pasa de tiempo alimentaba justo la cascada que la provoca. Un
 *    primer timeout puede ser un lockup puntual del host (merece otra oportunidad,
 *    tras una pausa de 60 s para que se recupere); dos seguidos indican un problema
 *    real y pasa a revisión manual.
 *  - `db_unavailable`: backoff más largo (5 s·2^n, tope 120 s): hay que dar tiempo a
 *    que la BD o el DNS vuelvan; reintentar en 2 s contra una BD ahogada la empeora.
 */
export interface RetryPolicy {
  /** Tope de intentos para este código (se aplica min con `max_attempts` del trabajo). */
  readonly maxAttempts?: number;
  /** Espera antes del siguiente intento, dado el nº de intentos ya consumidos. */
  readonly backoffMs: (attempts: number) => number;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = { backoffMs: (n) => Math.min(60_000, 1000 * 2 ** n) };

export const RETRY_POLICY: Partial<Record<FailureCode, RetryPolicy>> = {
  battle_timeout: { maxAttempts: 2, backoffMs: (n) => 60_000 * Math.max(1, n) },
  db_unavailable: { backoffMs: (n) => Math.min(120_000, 5000 * 2 ** n) },
};

export function retryPolicyFor(code: FailureCode): RetryPolicy {
  return RETRY_POLICY[code] ?? DEFAULT_RETRY_POLICY;
}

/**
 * ¿`err` es un fallo TRANSITORIO de la BD o de la red hacia ella? (F3 del diagnóstico)
 * Sólo señales estructurales (nombre de clase, `code` de Node/pg) y, para los que
 * knex/tarn/pg lanzan sin código, su mensaje literal. Se mira también `cause`.
 */
const TRANSIENT_DB_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "08000",
  "08001",
  "08003",
  "08006", // connection_failure
]);
const TRANSIENT_DB_MESSAGE =
  /Timeout acquiring a connection|Acquire connection error|terminating connection|Connection terminated|the database system is (?:starting up|shutting down)|Client has encountered a connection error/i;

export function isTransientDbError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > 2) return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  if (e.name === "KnexTimeoutError") return true;
  if (typeof e.code === "string" && TRANSIENT_DB_CODES.has(e.code)) return true;
  if (typeof e.message === "string" && TRANSIENT_DB_MESSAGE.test(e.message)) return true;
  return isTransientDbError(e.cause, depth + 1);
}

/**
 * Convierte un error desconocido en fallo de infraestructura: lo ya clasificado se deja
 * tal cual; un error transitorio de BD pasa a `db_unavailable`; el resto, a `fallback`.
 */
export function toInfrastructureFailure(err: unknown, fallback: InfrastructureFailureCode): InfrastructureFailure {
  if (err instanceof InfrastructureFailure) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new InfrastructureFailure(isTransientDbError(err) ? "db_unavailable" : fallback, msg);
}
