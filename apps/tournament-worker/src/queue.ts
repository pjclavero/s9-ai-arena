/**
 * E9 · T9.1 — Cola de trabajos durable sobre la tabla `jobs` de E7 (cap. 8).
 *
 * Diseño (ADR-E9-001):
 *  - La tabla `jobs` de PostgreSQL es la FUENTE DE VERDAD: cada trabajo vive ahí
 *    desde que se encola hasta que termina. Redis (redis-signal.ts) es solo una
 *    capa de despacho/aviso opcional: si Redis se pierde, no se pierde NINGÚN
 *    trabajo (el dosier lo exige literalmente: "persistidos también en la tabla
 *    jobs, para sobrevivir a Redis").
 *  - Idempotencia: `dedupe_key` única. Encolar dos veces el mismo trabajo lógico
 *    (p. ej. `run_battle:<battleId>`) inserta UNA fila.
 *  - Bloqueo distribuido: el claim es un UPDATE sobre un SELECT … FOR UPDATE
 *    SKIP LOCKED. Dos workers concurrentes NUNCA obtienen el mismo trabajo: la
 *    fila queda bloqueada a nivel de fila por PostgreSQL durante el claim y
 *    marcada con locked_by/locked_at después.
 *  - Recuperación de workers muertos: un trabajo `running` cuyo `locked_at` es
 *    más viejo que `lockTimeoutMs` se considera huérfano (worker caído: fallo de
 *    infraestructura 19.2) y vuelve a ser reclamable, contando el reintento.
 *  - Reintentos: SOLO fallos clasificados como infraestructura, con límite
 *    `max_attempts`; al agotarlo el trabajo pasa a `needs_review` (revisión
 *    manual). Las derrotas deportivas terminan el trabajo en `done`.
 */
import type { Knex } from "knex";
import { classifyFailure, type FailureCode } from "./errors.js";

export type JobKind = "generate_schedule" | "run_battle" | "process_result" | "update_standings" | "tournament_dry_run";

export const JOB_KINDS: JobKind[] = [
  "generate_schedule",
  "run_battle",
  "process_result",
  "update_standings",
  "tournament_dry_run",
];

export interface JobRow {
  id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  status: "queued" | "running" | "done" | "failed" | "needs_review";
  attempts: number;
  max_attempts: number;
  dedupe_key: string | null;
  locked_by: string | null;
  locked_at: Date | null;
  run_after: Date;
  last_error: string | null;
  error_class: string | null;
  created_at: Date;
}

export interface EnqueueOptions {
  /** Clave de idempotencia: el mismo trabajo lógico solo se inserta una vez. */
  dedupeKey?: string;
  maxAttempts?: number;
  runAfter?: Date;
}

/** Encola un trabajo de forma idempotente. Devuelve el id, o null si ya existía. */
export async function enqueueJob(
  db: Knex,
  kind: JobKind,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
): Promise<string | null> {
  const insert = {
    kind,
    payload: JSON.stringify(payload),
    dedupe_key: opts.dedupeKey ?? null,
    max_attempts: opts.maxAttempts ?? 3,
    run_after: opts.runAfter ?? db.fn.now(),
  };
  const rows = await db("jobs").insert(insert).onConflict("dedupe_key").ignore().returning("id");
  return rows.length > 0 ? (rows[0].id as string) : null;
}

export interface ClaimOptions {
  workerId: string;
  kinds?: JobKind[];
  /** Un `running` más viejo que esto se considera huérfano (worker muerto). */
  lockTimeoutMs?: number;
  now?: Date;
}

/**
 * Reclama el siguiente trabajo elegible. Bloqueo distribuido real: la subconsulta
 * usa FOR UPDATE SKIP LOCKED, de modo que dos claims concurrentes sobre la misma
 * fila son imposibles (el segundo la salta o ve el nuevo estado `running`).
 */
export async function claimJob(db: Knex, opts: ClaimOptions): Promise<JobRow | null> {
  const lockTimeoutMs = opts.lockTimeoutMs ?? 60_000;
  const now = opts.now ?? new Date();
  const kinds = opts.kinds ?? JOB_KINDS;
  const staleBefore = new Date(now.getTime() - lockTimeoutMs);
  const rows = await db.raw(
    `
    UPDATE jobs SET
      status = 'running',
      locked_by = :workerId,
      locked_at = :now,
      attempts = attempts + 1,
      updated_at = :now
    WHERE id = (
      SELECT id FROM jobs
      WHERE kind = ANY(:kinds)
        -- GREATEST: run_after se escribe con la hora del SERVIDOR (db.fn.now())
        -- y el parametro de reloj llega del cliente; se acepta la mas avanzada
        -- de las dos para que ni un desfase de milisegundos ni los relojes
        -- simulados de los tests dejen trabajos elegibles sin reclamar.
        AND run_after <= GREATEST(CAST(:now AS timestamptz), now())
        AND (
          status = 'queued'
          OR (status = 'running' AND locked_at < :staleBefore)
        )
      ORDER BY created_at, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
    `,
    { workerId: opts.workerId, now, kinds, staleBefore },
  );
  return (rows.rows?.[0] as JobRow | undefined) ?? null;
}

/** El trabajo terminó bien (o con derrota deportiva ya registrada en la batalla). */
export async function completeJob(
  db: Knex,
  jobId: string,
  opts: { sportingFailure?: FailureCode } = {},
): Promise<void> {
  await db("jobs")
    .where({ id: jobId })
    .update({
      status: "done",
      locked_by: null,
      locked_at: null,
      error_class: opts.sportingFailure ? "sporting" : null,
      last_error: opts.sportingFailure ?? null,
      updated_at: db.fn.now(),
    });
}

export interface FailResult {
  /** true si el trabajo agotó los reintentos y quedó en revisión manual. */
  parked: boolean;
}

/**
 * Fallo de INFRAESTRUCTURA (19.2): reintenta con backoff hasta max_attempts;
 * agotados, el trabajo queda en `needs_review` para revisión manual.
 */
export async function failJobInfrastructure(
  db: Knex,
  job: JobRow,
  code: FailureCode,
  message: string,
  opts: { backoffMs?: number; now?: Date } = {},
): Promise<FailResult> {
  if (classifyFailure(code) === "sporting") {
    throw new Error(
      `failJobInfrastructure llamado con código deportivo '${code}': una derrota deportiva no se reintenta`,
    );
  }
  const now = opts.now ?? new Date();
  const parked = job.attempts >= job.max_attempts;
  const backoffMs = opts.backoffMs ?? Math.min(60_000, 1000 * 2 ** job.attempts);
  await db("jobs")
    .where({ id: job.id })
    .update({
      status: parked ? "needs_review" : "queued",
      locked_by: null,
      locked_at: null,
      run_after: parked ? now : new Date(now.getTime() + backoffMs),
      last_error: `[${code}] ${message}`,
      error_class: "infrastructure",
      updated_at: now,
    });
  return { parked };
}

/**
 * Fallo NO clasificado (bug del propio worker): ni deportivo ni de
 * infraestructura conocida. El 19.2 solo autoriza reintentos ante fallos de
 * infraestructura, así que va directo a revisión manual sin reintentos.
 */
export async function failJobUnclassified(db: Knex, job: JobRow, message: string): Promise<void> {
  await db("jobs")
    .where({ id: job.id })
    .update({
      status: "needs_review",
      locked_by: null,
      locked_at: null,
      last_error: `[unclassified] ${message}`,
      error_class: null,
      updated_at: db.fn.now(),
    });
}
