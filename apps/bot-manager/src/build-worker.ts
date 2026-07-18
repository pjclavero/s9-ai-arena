/**
 * R2.5 (ERR-SEC-12) — worker de builds del bot-manager.
 *
 * El pipeline de validación de bots SALE del proceso de la API: submitBotVersion
 * solo persiste el trabajo en la tabla `jobs` (kind `bot_build`, mismo patrón
 * durable que las batallas de E9: la tabla es la fuente de verdad, claim con
 * FOR UPDATE SKIP LOCKED, reintentos limitados) y responde 202. Este worker
 * reclama los trabajos y ejecuta el pipeline mediante un BuildExecutor
 * inyectado (en producción, el adaptador E6PipelineBotManager de la API).
 *
 * Fallar cerrado (regla de oro Ronda 2): si el executor revienta y el trabajo
 * agota reintentos, el build queda `failed` y la versión `rejected` con motivo
 * "no verificable" — NUNCA `validated` sin pipeline completado.
 */
import type { Knex } from "knex";

export const BOT_BUILD_JOB_KIND = "bot_build";

export interface BuildJobPayload {
  buildId: string;
  botId: string;
  version: number;
  runtime: "python" | "node";
}

/** Ejecuta el pipeline completo de un build (incluida su persistencia final). */
export interface BuildExecutor {
  enqueueBuild(req: BuildJobPayload): Promise<void>;
}

export interface BuildJobRow {
  id: string;
  kind: string;
  payload: BuildJobPayload;
  status: string;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  last_error: string | null;
}

export interface ClaimBuildOptions {
  workerId: string;
  /** Un `running` más viejo que esto se considera huérfano (worker muerto). */
  lockTimeoutMs?: number;
  now?: Date;
}

/** Reclama el siguiente `bot_build` elegible (bloqueo distribuido, como E9/T9.1). */
export async function claimBuildJob(db: Knex, opts: ClaimBuildOptions): Promise<BuildJobRow | null> {
  const lockTimeoutMs = opts.lockTimeoutMs ?? 10 * 60_000;
  const now = opts.now ?? new Date();
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
      WHERE kind = :kind
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
    { workerId: opts.workerId, now, staleBefore, kind: BOT_BUILD_JOB_KIND },
  );
  const row = rows.rows?.[0];
  if (!row) return null;
  return { ...row, payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload } as BuildJobRow;
}

/**
 * Cierre FAIL-CLOSED de un build cuyo trabajo agotó reintentos: el build queda
 * `failed` y la versión (si sigue en `validating`) pasa a `rejected` como "no
 * verificable". Nunca se deja un build eternamente `queued` ni una versión
 * validada sin pipeline.
 */
async function rejectUnverifiable(db: Knex, payload: BuildJobPayload, reason: string): Promise<void> {
  await db.transaction(async (trx) => {
    await trx("builds").where({ id: payload.buildId }).update({ status: "failed", updated_at: trx.fn.now() });
    await trx("bot_versions")
      .where({ bot_id: payload.botId, version: payload.version, state: "validating" })
      .update({ state: "rejected", rejection_reason: `build no verificable: ${reason}`.slice(0, 512) });
  });
}

export type WorkerTick =
  | { outcome: "idle" }
  | { outcome: "done"; jobId: string }
  | { outcome: "retry"; jobId: string; error: string }
  | { outcome: "needs_review"; jobId: string; error: string };

/**
 * Procesa COMO MUCHO un trabajo `bot_build`. Un fallo del executor se trata como
 * fallo de infraestructura: reintento con backoff hasta max_attempts; agotados,
 * el trabajo queda `needs_review` y el build se cierra fail-closed.
 */
export async function runBuildWorkerOnce(
  db: Knex,
  executor: BuildExecutor,
  opts: ClaimBuildOptions,
): Promise<WorkerTick> {
  const job = await claimBuildJob(db, opts);
  if (!job) return { outcome: "idle" };
  const now = opts.now ?? new Date();
  try {
    await executor.enqueueBuild(job.payload);
    await db("jobs").where({ id: job.id }).update({
      status: "done",
      locked_by: null,
      locked_at: null,
      updated_at: db.fn.now(),
    });
    return { outcome: "done", jobId: job.id };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const exhausted = job.attempts >= job.max_attempts;
    const backoffMs = Math.min(60_000, 1000 * 2 ** job.attempts);
    await db("jobs")
      .where({ id: job.id })
      .update({
        status: exhausted ? "needs_review" : "queued",
        locked_by: null,
        locked_at: null,
        run_after: exhausted ? now : new Date(now.getTime() + backoffMs),
        last_error: `[build_executor] ${message}`.slice(0, 1024),
        error_class: "infrastructure",
        updated_at: db.fn.now(),
      });
    if (exhausted) {
      await rejectUnverifiable(db, job.payload, message);
      return { outcome: "needs_review", jobId: job.id, error: message };
    }
    return { outcome: "retry", jobId: job.id, error: message };
  }
}

/** Bucle del worker: sondea la cola hasta que se aborta la señal. */
export async function startBuildWorker(
  db: Knex,
  executor: BuildExecutor,
  opts: { workerId: string; intervalMs?: number; signal?: AbortSignal; lockTimeoutMs?: number },
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 1000;
  while (!opts.signal?.aborted) {
    const tick = await runBuildWorkerOnce(db, executor, {
      workerId: opts.workerId,
      lockTimeoutMs: opts.lockTimeoutMs,
    });
    if (tick.outcome === "idle") {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
