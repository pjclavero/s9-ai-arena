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

import { isIP } from "node:net";

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
  // v0.5.0 · una consulta a la BD fue cancelada (57014: statement_timeout/lock_timeout). Política
  // PROPIA y corta: una vez puede ser la carga del host; repetida, es una consulta lenta.
  "db_query_timeout",
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
 *    pool, sin reintentar eternamente: al octavo fallo va a revisión manual.
 *  - `db_query_timeout` (57014): tope corto de 2 fallos (un reintento tras 30 s). Decisión (P2-8):
 *    ir con `db_unavailable` hacía que una consulta crónicamente lenta se reintentara ~8,5 min
 *    antes de llegar a revisión; una cancelación puntual por carga del host sí merece un reintento.
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
  // 57014: UN reintento tras una pausa de 30 s y a revisión al segundo fallo (~30 s de coste, no 8,5 min).
  db_query_timeout: { maxFailures: 2, backoffMs: (n) => 30_000 * Math.max(1, n) },
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
 *   · apunta al endpoint de la BD (ver `pointsAtDb`), o
 *   · pasa por pg/pg-pool/knex/tarn (stack), o
 *   · lo envuelve (`cause`) o lo agrega (`AggregateError.errors[]`, el `localhost` dual-stack)
 *     un error que cumple lo anterior (se evalúa con los mismos criterios).
 * Sin esa evidencia NO es `db_unavailable` (conserva su tratamiento anterior).
 * Los SQLSTATE (57P01…, 08xxx, 53300…) y el mensaje literal de knex/tarn/pg sólo los
 * emite la capa de BD, así que valen por sí mismos.
 *
 * FORMAS REALES (medidas con pg/knex y Node 22, ver `scripts/capture-pg-errors.mjs` y
 * `testing/fixtures/real-db-errors.json`):
 *  · ECONNREFUSED/ECONNRESET al CONECTAR: `address` = IP YA RESUELTA (nunca el nombre del DSN),
 *    `port`, `syscall:"connect"`; la pila es sólo `node:net` (no pasa por pg/knex).
 *  · `localhost` dual-stack: `AggregateError` con `code` pero sin address/port; las direcciones
 *    (::1 y 127.0.0.1) están en `.errors[]`; sin pila de pg.
 *  · `read ECONNRESET` (RST sobre un socket abierto): `code`+`syscall:"read"`, SIN address ni port.
 *    Con una consulta de pg en vuelo la pila pasa por pg (se reconoce por pila); con knex el mensaje
 *    lleva el SQL delante (`select … - read ECONNRESET`) y la pila es sólo `node:internal`.
 *  · backend terminado: 57P01 (DatabaseError); servidor muerto: `Connection terminated unexpectedly`.
 *  · nombre que no resuelve: `ENOTFOUND` + `hostname`; en la red de Docker, pg da `timeout expired`.
 *  · `EHOSTUNREACH` (IP sin asignar en la subred) y `ENETUNREACH` (sin ruta, IPv4/IPv6): `syscall:"connect"`,
 *    `address` = IP literal, `port`, errno -113/-101, pila sólo `node:net`; `ENETUNREACH` añade ` - Local (…)` al mensaje.
 *    `ECONNABORTED` NO está capturado (no se puede provocar en conexión): su fixture es construido.
 * Un error 'error' de un cliente OCIOSO muerto no llega al manejador del trabajo (lo absorbe el pool).
 */
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EPIPE",
  // Host/red inalcanzables (BD apagada con el host caído, contenedor retirado de la red) y conexión
  // abortada. Mismo criterio de origen que el resto: puerto/IP de la BD, pila de pg/knex o SQL antepuesto.
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNABORTED",
]);
const TRANSIENT_DB_SQLSTATES = new Set([
  "53300", // too_many_connections: el servidor está saturado, se libera solo
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "08000",
  "08001",
  "08003",
  "08006", // connection_failure
]);
/**
 * 57014 query_canceled (statement_timeout/lock_timeout/cancelación). Se trata APARTE
 * (`db_query_timeout`, tope corto): bajo carga del host una consulta pequeña puede pasarse una
 * vez (merece otra oportunidad), pero una consulta crónicamente lenta NO se arregla esperando
 * ~8,5 min como una caída de la BD.
 */
const QUERY_TIMEOUT_SQLSTATE = "57014";
const TRANSIENT_DB_MESSAGE =
  /Timeout acquiring a connection|Acquire connection error|terminating connection|Connection terminated|the database system is (?:starting up|shutting down)|Client has encountered a connection error/i;
/**
 * knex ANTEPONE el SQL al mensaje de un error de red durante una consulta: `select … - read
 * ECONNRESET` (medido). Es la única señal de BD de un `read ECONNRESET` sin dirección ni puerto cuya
 * pila sólo pasa por `node:internal` (el socket de pg ya abierto). Un error de Redis, del docker-proxy
 * o de un WebSocket no empieza por una sentencia SQL.
 */
const KNEX_SQL_PREFIXED_NET_ERROR =
  /^\s*(?:select|insert|update|delete|with|begin|commit|rollback|savepoint|release|set|show|create|alter|drop|truncate|lock|copy|explain|call|do|values|merge)\b[\s\S]* - (?:read|write|connect) [A-Z_]+/i;
/** `connectionTimeoutMillis` de pg al conectar (nombre que no resuelve, host que no contesta): sólo con pila de pg. */
const PG_CONNECT_TIMEOUT_MESSAGE = /^timeout expired$/;
const DB_LIBRARY_STACK = /node_modules[\\/](?:pg|pg-pool|pg-protocol|knex|tarn)[\\/]/;
/** Tope de profundidad de `cause`/`errors[]` y de nodos visitados en total (evita ciclos y grafos enormes). */
const MAX_DEPTH = 3;
const MAX_NODES = 32;

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

/**
 * ¿Este error de red apunta al endpoint de la BD?
 *
 * CRITERIO (decidido con las formas reales de Node, no con las que uno imagina):
 *  · Con puerto en el error (ECONNREFUSED, ETIMEDOUT…): el PUERTO tiene que ser el de la BD
 *    (`DATABASE_URL`/`PGPORT`, 5432 por defecto). Y además:
 *      - si el error trae un nombre (`hostname`) o la dirección es un nombre, debe ser el del DSN;
 *      - si el host del DSN es un NOMBRE (producción: `postgres`), Node deja en `address` la IP
 *        resuelta, que no se puede comparar con el nombre: basta el puerto (con `address` IP o sin
 *        `address`);
 *      - si el host del DSN es una IP literal, `address` tiene que ser esa IP.
 *  · Sin puerto (EAI_AGAIN/ENOTFOUND del DNS): sólo vale si el `hostname` es el del DSN.
 *  Falsos positivos: el docker-proxy (2375), Redis (6379) y los WebSocket de los bots usan otros
 *  puertos y no se atribuyen a la BD. Lo que queda abierto: un servicio ajeno en el MISMO puerto
 *  que la BD (p. ej. 5432 en otro host) sería indistinguible por la sola forma del error.
 */
function pointsAtDb(e: { address?: unknown; port?: unknown; hostname?: unknown }, ep: DbEndpoint): boolean {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v.toLowerCase() : undefined);
  const address = str(e.address);
  const hostname = str(e.hostname);
  const host = str(ep.host)?.replace(/^\[|\]$/g, "");
  const port = typeof e.port === "number" ? e.port : typeof e.port === "string" && e.port ? Number(e.port) : undefined;
  if (port === undefined) {
    // Sin puerto (EAI_AGAIN de DNS): sólo vale si el nombre es el de la BD.
    return host !== undefined && (hostname === host || address === host);
  }
  if (ep.port === undefined || port !== ep.port) return false;
  if (host === undefined) return true;
  if (hostname !== undefined) return hostname === host;
  if (address === undefined || address === host) return true;
  // `address` es una IP resuelta (o un nombre ajeno). Con un DSN por nombre la IP no es comparable:
  // basta el puerto. Con un DSN por IP literal, tiene que coincidir. Un nombre ajeno no es la BD.
  if (isIP(host) !== 0) return false;
  return isIP(address) !== 0;
}

type DbFailureCode = "db_unavailable" | "db_query_timeout";

/**
 * LÍMITE CONOCIDO (P2-11, no corregible por la forma del error): con el DSN por NOMBRE (producción:
 * `postgres`), Node deja en `address` la IP ya resuelta, que no se puede comparar con el nombre; el
 * único criterio que queda es el PUERTO. Un error de red al puerto de la BD (5432) con la IP de OTRO
 * servicio que escuche también en ese puerto se atribuye, por tanto, a la BD (falso positivo). La forma
 * del error no distingue los dos casos y no se amplía el criterio a ciegas. Impacto acotado: sólo un
 * `db_unavailable` (backoff creciente, tope de 8 fallos, ~8,5 min y a revisión); ni bucle ni daño.
 * El test «P2-11 · límite conocido» FIJA este comportamiento: quien lo cambie debe hacerlo a propósito.
 *
 * Clasifica un error de BD/red como `db_unavailable`, `db_query_timeout` (57014) o ninguno.
 * Recorre `cause` y `AggregateError.errors[]` con tope de profundidad y de nodos.
 */
export function classifyDbError(err: unknown, endpoint: DbEndpoint = dbEndpointFromEnv()): DbFailureCode | undefined {
  const budget = { nodes: 0 };
  const seen = new Set<object>();
  let queryTimeout = false;
  const visit = (x: unknown, depth: number): boolean => {
    if (!x || typeof x !== "object" || depth > MAX_DEPTH || seen.has(x) || ++budget.nodes > MAX_NODES) return false;
    seen.add(x);
    const e = x as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
      stack?: unknown;
      address?: unknown;
      port?: unknown;
      hostname?: unknown;
    };
    if (e.name === "KnexTimeoutError") return true;
    if (typeof e.code === "string") {
      if (TRANSIENT_DB_SQLSTATES.has(e.code)) return true;
      if (e.code === QUERY_TIMEOUT_SQLSTATE) queryTimeout = true;
      if (NETWORK_CODES.has(e.code)) {
        if (pointsAtDb(e, endpoint)) return true;
        if (typeof e.stack === "string" && DB_LIBRARY_STACK.test(e.stack)) return true;
        if (typeof e.message === "string" && KNEX_SQL_PREFIXED_NET_ERROR.test(e.message)) return true;
      }
    }
    if (
      typeof e.message === "string" &&
      PG_CONNECT_TIMEOUT_MESSAGE.test(e.message) &&
      typeof e.stack === "string" &&
      DB_LIBRARY_STACK.test(e.stack)
    )
      return true;
    if (typeof e.message === "string" && TRANSIENT_DB_MESSAGE.test(e.message)) return true;
    if (visit(e.cause, depth + 1)) return true;
    if (Array.isArray(e.errors)) for (const sub of e.errors) if (visit(sub, depth + 1)) return true;
    return false;
  };
  if (visit(err, 0)) return "db_unavailable";
  return queryTimeout ? "db_query_timeout" : undefined;
}

export function isTransientDbError(err: unknown, endpoint: DbEndpoint = dbEndpointFromEnv()): boolean {
  return classifyDbError(err, endpoint) !== undefined;
}

/**
 * Convierte un error desconocido en fallo de infraestructura: lo ya clasificado se deja
 * tal cual; un error transitorio de BD pasa a `db_unavailable`; el resto, a `fallback`.
 */
export function toInfrastructureFailure(
  err: unknown,
  fallback: InfrastructureFailureCode,
  endpoint: DbEndpoint = dbEndpointFromEnv(),
): InfrastructureFailure {
  if (err instanceof InfrastructureFailure) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new InfrastructureFailure(classifyDbError(err, endpoint) ?? fallback, msg);
}
