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
 *  - `battle_timeout`: UN reintento como máximo, contado POR CLASE (dos timeouts y a
 *    revisión). Cada intento cuesta ~6,6 min de reloj y mantiene 3 motores y los
 *    contenedores; repetir 3 veces una batalla que se pasa de tiempo alimentaba justo la
 *    cascada que la provoca. Un primer timeout puede ser un lockup puntual del host
 *    (merece otra oportunidad, tras una pausa de 60 s); dos seguidos indican un problema
 *    real. Se cuenta por clase y no sobre el total de intentos: un fallo de OTRA clase en
 *    el intento 1 no puede quitarle al primer timeout su reintento.
 *  - `db_unavailable`: tope PROPIO (no el `max_attempts` del trabajo, que es de 3 y
 *    sólo daba ~30 s de tolerancia) y backoff 5 s·2^n con tope 120 s. 8 fallos dan
 *    esperas de 10+20+40+80+120+120+120 s = 510 s (~8,5 min): cubre el reinicio de un
 *    Postgres en contenedor (o su recuperación tras un OOM/failover) y la reconexión del
 *    pool, sin reintentar eternamente: al noveno intento va a revisión manual.
 */
export interface RetryPolicy {
  /**
   * Tope de fallos de ESTA clase tras el que el trabajo pasa a revisión. Sin él se
   * aplica `max_attempts` del trabajo.
   */
  readonly maxFailures?: number;
  /** El tope propio SUSTITUYE al `max_attempts` del trabajo (si no, se aplica el menor). */
  readonly overridesJobMax?: boolean;
  /** Espera antes del siguiente intento, dado el nº de fallos de la clase ya sufridos. */
  readonly backoffMs: (failures: number) => number;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = { backoffMs: (n) => Math.min(60_000, 1000 * 2 ** n) };

export const RETRY_POLICY: Partial<Record<FailureCode, RetryPolicy>> = {
  battle_timeout: { maxFailures: 2, backoffMs: (n) => 60_000 * Math.max(1, n) },
  db_unavailable: {
    maxFailures: 8,
    overridesJobMax: true,
    backoffMs: (n) => Math.min(120_000, 5000 * 2 ** n),
  },
};

export function retryPolicyFor(code: FailureCode): RetryPolicy {
  return RETRY_POLICY[code] ?? DEFAULT_RETRY_POLICY;
}

/** ¿Esta clase lleva política propia (y por tanto cuenta sus fallos por clase)? */
export function hasOwnRetryPolicy(code: FailureCode): boolean {
  return RETRY_POLICY[code] !== undefined;
}

/**
 * ¿`err` es un fallo TRANSITORIO de la BD o de la red hacia ella? (F3 del diagnóstico)
 *
 * Se decide por el ORIGEN, no por el código: ECONNREFUSED/ECONNRESET/ETIMEDOUT/EPIPE/
 * EAI_AGAIN los lanzan igual el docker-proxy, los WebSocket de los bots y Redis, y no
 * son un problema de la BD. Un código de red cuenta como de BD sólo si el error:
 *   · apunta al endpoint de la BD (`address`/`port`/`hostname` = DATABASE_URL/PGHOST), o
 *   · pasa por pg/pg-pool/knex/tarn (stack), o
 *   · lo envuelve (`cause`) un error que cumple lo anterior (se evalúa con los mismos criterios).
 * Sin esa evidencia NO es `db_unavailable` (conserva su tratamiento anterior).
 * Los SQLSTATE (57P01…, 08xxx, 53300…) y el mensaje literal de knex/tarn/pg sólo los
 * emite la capa de BD, así que valen por sí mismos. Se mira también `cause`.
 */
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EAI_AGAIN", "ETIMEDOUT", "EPIPE"]);
const TRANSIENT_DB_SQLSTATES = new Set([
  "53300", // too_many_connections: el servidor está saturado, se libera solo
  // query_canceled: en este sistema la causa es statement_timeout/lock_timeout bajo carga
  // del host (las consultas del worker son pequeñas e indexadas); un caso permanente
  // queda acotado por el tope de db_unavailable y acaba en revisión, no en bucle.
  "57014",
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
const DB_LIBRARY_STACK = /node_modules[\\/](?:pg|pg-pool|pg-protocol|knex|tarn)[\\/]/;

/** Endpoint de la BD contra el que se comparan los errores de red. */
export interface DbEndpoint {
  host?: string;
  port?: number;
}

/** Endpoint de la BD según el entorno del proceso (DATABASE_URL, o PGHOST/PGPORT). */
export function dbEndpointFromEnv(env: NodeJS.ProcessEnv = process.env): DbEndpoint {
  const url = env.DATABASE_URL;
  if (url) {
    try {
      const u = new URL(url);
      return { host: u.hostname || undefined, port: u.port ? Number(u.port) : 5432 };
    } catch {
      return {};
    }
  }
  if (env.PGHOST) return { host: env.PGHOST, port: env.PGPORT ? Number(env.PGPORT) : 5432 };
  return {};
}

function pointsAtDb(e: { address?: unknown; port?: unknown; hostname?: unknown }, ep: DbEndpoint): boolean {
  const hosts = [e.address, e.hostname].filter((h): h is string => typeof h === "string").map((h) => h.toLowerCase());
  const host = ep.host?.toLowerCase();
  const port = typeof e.port === "number" ? e.port : typeof e.port === "string" ? Number(e.port) : undefined;
  if (port !== undefined) {
    if (ep.port === undefined || port !== ep.port) return false;
    return host === undefined || hosts.length === 0 || hosts.includes(host);
  }
  // Sin puerto (EAI_AGAIN de DNS): sólo vale si el nombre es el de la BD.
  return host !== undefined && hosts.includes(host);
}

export function isTransientDbError(err: unknown, endpoint: DbEndpoint = dbEndpointFromEnv()): boolean {
  return transientDb(err, 0, endpoint);
}

function transientDb(err: unknown, depth: number, endpoint: DbEndpoint): boolean {
  if (!err || typeof err !== "object" || depth > 2) return false;
  const e = err as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    cause?: unknown;
    stack?: unknown;
    address?: unknown;
    port?: unknown;
    hostname?: unknown;
  };
  if (e.name === "KnexTimeoutError") return true;
  if (typeof e.code === "string") {
    if (TRANSIENT_DB_SQLSTATES.has(e.code)) return true;
    if (NETWORK_CODES.has(e.code)) {
      if (pointsAtDb(e, endpoint)) return true;
      if (typeof e.stack === "string" && DB_LIBRARY_STACK.test(e.stack)) return true;
    }
  }
  if (typeof e.message === "string" && TRANSIENT_DB_MESSAGE.test(e.message)) return true;
  return transientDb(e.cause, depth + 1, endpoint);
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
