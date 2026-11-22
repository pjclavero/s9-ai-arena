/**
 * V1-P0 · Recuperación segura de batallas HUÉRFANAS (`running` con el lease vencido).
 *
 * Un worker que muere sin pasar por su `finally` (OOM, kill -9, reinicio) deja la batalla
 * `running` y el trabajo `running`. Hasta ahora sólo se recuperaba si OTRO claim de la cola
 * volvía a tocar ese trabajo; nada barría las batallas, y la cola no miraba `max_attempts`
 * (ver `claimJob`). Este barrido, periódico y al arrancar, cierra el hueco:
 *
 *  - Lease vencido, trabajo con lock FRESCO ⇒ hay un titular vivo: no se toca (saltada).
 *  - Lease vencido y quedan intentos ⇒ se REENCOLA UNA vez: batalla → `scheduled`, trabajo → `queued`.
 *  - Lease vencido y intentos agotados (o el trabajo ya es terminal/inexistente tras agotarse) ⇒
 *    TERMINAL: batalla → `failed` (`failure_kind=infrastructure`), trabajo → `needs_review`,
 *    con motivo explícito en `audit_log`. Nunca se inventa un resultado deportivo.
 *
 * Nunca dos ejecuciones de la misma batalla: la reserva se libera con un UPDATE guardado por
 * `claimed_by` (el token del titular que se vio caducado); el titular antiguo, si siguiera vivo,
 * pierde el lease en su siguiente renovación y aborta (`renewBattleLease` devuelve false). Cada
 * batalla se procesa en una transacción con `FOR UPDATE SKIP LOCKED`: dos barridos concurrentes
 * no pisan la misma fila. Idempotente: una segunda pasada no encuentra nada.
 */
import type { Knex } from "knex";
import { failBattleInfrastructure, type JobRow } from "./queue.js";
import { workerMetrics } from "./worker-metrics.js";

export interface SweepReport {
  requeued: string[];
  failed: string[];
  /** Lease vencido pero con un trabajo de lock fresco: titular posiblemente vivo, no se toca. */
  skipped: string[];
}

export interface SweepOptions {
  /** Un trabajo `running` con `locked_at` más viejo que esto no tiene titular vivo. Def. 60 s. */
  lockTimeoutMs?: number;
  /** Intentos por defecto si la batalla no tiene trabajo. */
  defaultMaxAttempts?: number;
  now?: Date;
}

export const ORPHAN_EXHAUSTED_REASON =
  "lease vencido con los intentos agotados: batalla huerfana cerrada por el barrido";
export const ORPHAN_REQUEUED_REASON = "lease vencido: batalla huerfana reencolada una vez por el barrido";

interface ExpiredBattle {
  id: string;
  claimed_by: string | null;
  run_attempts: number;
}

export async function sweepExpiredBattles(db: Knex, opts: SweepOptions = {}): Promise<SweepReport> {
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - (opts.lockTimeoutMs ?? 60_000));
  const report: SweepReport = { requeued: [], failed: [], skipped: [] };

  const candidates = (
    await db.raw(
      `SELECT id FROM battles
        WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < now())
        ORDER BY id`,
    )
  ).rows as { id: string }[];
  workerMetrics.set("battles_lease_expired", candidates.length);

  for (const { id } of candidates) {
    await db.transaction(async (trx) => {
      // Se vuelve a leer BAJO BLOQUEO: otro barrido/claim pudo cambiarla entre la lista y aquí.
      const row = (
        await trx.raw(
          `SELECT id, claimed_by, run_attempts FROM battles
            WHERE id = :id AND status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < now())
            FOR UPDATE SKIP LOCKED`,
          { id },
        )
      ).rows[0] as ExpiredBattle | undefined;
      if (!row) return;

      const job = (await trx("jobs")
        .where({ dedupe_key: `run_battle:${id}` })
        .forUpdate()
        .first()) as JobRow | undefined;
      if (job && job.status === "running" && job.locked_at && new Date(job.locked_at) >= staleBefore) {
        report.skipped.push(id);
        return;
      }
      const maxAttempts = job?.max_attempts ?? opts.defaultMaxAttempts ?? 3;
      const attempts = Math.max(job?.attempts ?? 0, row.run_attempts);
      const jobTerminal = job !== undefined && ["done", "needs_review", "failed"].includes(job.status);
      const exhausted = attempts >= maxAttempts || jobTerminal;

      if (exhausted) {
        await failBattleInfrastructure(trx, id, ORPHAN_EXHAUSTED_REASON, "worker.battle_orphan_failed");
        if (job && (job.status === "running" || job.status === "queued")) {
          await trx("jobs")
            .where({ id: job.id })
            .update({
              status: "needs_review",
              locked_by: null,
              locked_at: null,
              last_error: `[worker_died] ${ORPHAN_EXHAUSTED_REASON}`,
              error_class: "infrastructure",
              updated_at: now,
            });
        }
        report.failed.push(id);
        return;
      }

      // Quedan intentos: UNA reentrega. UPDATE guardado por el token del titular caducado.
      const released = await trx("battles")
        .where({ id, status: "running" })
        .andWhere((q) =>
          row.claimed_by === null ? q.whereNull("claimed_by") : q.where({ claimed_by: row.claimed_by }),
        )
        .update({ status: "scheduled", started_at: null, claimed_by: null, lease_expires_at: null });
      if (released !== 1) return;
      if (job) {
        await trx("jobs")
          .where({ id: job.id })
          .whereIn("status", ["running", "queued"])
          .update({
            status: "queued",
            locked_by: null,
            locked_at: null,
            run_after: now,
            last_error: `[worker_died] ${ORPHAN_REQUEUED_REASON}`,
            error_class: "infrastructure",
            updated_at: now,
          });
      } else {
        await trx("jobs")
          .insert({
            kind: "run_battle",
            payload: JSON.stringify({ battleId: id }),
            dedupe_key: `run_battle:${id}`,
            max_attempts: maxAttempts,
            run_after: now,
          })
          .onConflict("dedupe_key")
          .ignore();
      }
      await trx("audit_log").insert({
        action: "worker.battle_orphan_requeued",
        target: `battle:${id}`,
        detail: JSON.stringify({ reason: ORPHAN_REQUEUED_REASON, runAttempts: row.run_attempts, maxAttempts }),
      });
      report.requeued.push(id);
    });
  }
  if (report.requeued.length) workerMetrics.inc("orphans_requeued_total", report.requeued.length);
  if (report.failed.length) workerMetrics.inc("orphans_failed_total", report.failed.length);
  const nr = await db("jobs").where({ status: "needs_review" }).count({ n: "*" }).first();
  workerMetrics.set("jobs_needs_review", Number(nr?.n ?? 0));
  return report;
}

/**
 * Bucle del barrido: una pasada ahora y otra cada `everyMs`, sin solaparse. `onBattleFailed`
 * recibe cada batalla cerrada como terminal (para avanzar su match/torneo). Devuelve `stop()`.
 */
export function startOrphanSweeper(deps: {
  db: Knex;
  everyMs?: number;
  lockTimeoutMs?: number;
  onReport?: (r: SweepReport, err?: unknown) => void;
  onBattleFailed?: (battleId: string) => Promise<void>;
}): () => void {
  let busy = false;
  let stopped = false;
  const tick = () => {
    if (busy || stopped) return;
    busy = true;
    sweepExpiredBattles(deps.db, { lockTimeoutMs: deps.lockTimeoutMs })
      .then(async (r) => {
        for (const id of r.failed) await deps.onBattleFailed?.(id).catch(() => undefined);
        deps.onReport?.(r);
      })
      .catch((err) => deps.onReport?.({ requeued: [], failed: [], skipped: [] }, err))
      .finally(() => {
        busy = false;
      });
  };
  tick();
  const t = setInterval(tick, deps.everyMs ?? 60_000);
  t.unref?.();
  return () => {
    stopped = true;
    clearInterval(t);
  };
}
