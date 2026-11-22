/**
 * ADM-1 · Lado EJECUTOR del marco de órdenes: lo importa el servicio que posee el privilegio
 * (backup, replay-service, worker…), NO la API. Usa su PROPIO rol de BD, que sólo necesita:
 *
 *   GRANT SELECT ON admin_operations TO <rol>;
 *   GRANT UPDATE (status, result, lease_owner, lease_expires_at, attempts, started_at, finished_at)
 *         ON admin_operations TO <rol>;
 *   GRANT INSERT ON audit_log TO <rol>;      -- sólo inserción (el log ya no admite UPDATE/DELETE)
 *
 * (comprobado con un rol real en `admin-operations.test.ts`). No puede tocar `params`,
 * `kind` ni a quién se solicitó, ni ninguna tabla de dominio.
 *
 * Ciclo: `claimOperation` (pending → running con LEASE) → trabajo (renovando con
 * `extendLease`) → `completeOperation` | `failOperation`. Si el ejecutor muere, el lease caduca
 * y `reapExpiredLeases` devuelve la orden a `pending` (o la da por fallida tras `maxAttempts`).
 * El ejecutor VUELVE A VALIDAR los parámetros con su propio esquema: la fila no es de fiar.
 */
import type { Db } from "../db/connection.js";
import { audit } from "../audit.js";
import { OPERATION_KINDS } from "./admin-operations.js";

/** Tamaño máximo del resultado guardado (sin secretos ni volcados). */
export const MAX_RESULT_BYTES = 16 * 1024;

export interface ClaimedOperation {
  id: string;
  kind: string;
  params: Record<string, unknown>;
  attempts: number;
  leaseExpiresAt: Date;
}

const leaseSql = (db: Db, ms: number) => db.raw("now() + (? * interval '1 millisecond')", [Math.trunc(ms)]);

function assertKinds(kinds: readonly string[]): void {
  if (kinds.length === 0) throw new Error("el ejecutor debe declarar los tipos que consume");
  for (const k of kinds) {
    if (!Object.prototype.hasOwnProperty.call(OPERATION_KINDS, k))
      throw new Error(`tipo de operación desconocido: ${k}`);
  }
}

/** Toma la orden `pending` más antigua de sus tipos (SKIP LOCKED: varios ejecutores no se pisan). */
export async function claimOperation(
  db: Db,
  opts: { kinds: readonly string[]; owner: string; leaseMs: number },
): Promise<ClaimedOperation | null> {
  assertKinds(opts.kinds);
  const res = await db.raw(
    `UPDATE admin_operations
        SET status = 'running', lease_owner = ?, lease_expires_at = now() + (? * interval '1 millisecond'),
            attempts = attempts + 1, started_at = COALESCE(started_at, now())
      WHERE id = (SELECT id FROM admin_operations
                   WHERE status = 'pending' AND kind = ANY(?)
                   ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, kind, params, attempts, lease_expires_at`,
    [opts.owner, Math.trunc(opts.leaseMs), [...opts.kinds]],
  );
  const r = res.rows[0];
  if (!r) return null;
  await audit(db, {
    actorId: null,
    action: "admin.op.started",
    target: `operation:${r.id}`,
    detail: { kind: r.kind, executor: opts.owner, attempt: r.attempts },
  });
  return { id: r.id, kind: r.kind, params: r.params, attempts: r.attempts, leaseExpiresAt: r.lease_expires_at };
}

/** Renueva el lease SÓLO si sigue siendo suyo y vigente. */
export async function extendLease(db: Db, id: string, owner: string, leaseMs: number): Promise<boolean> {
  const n = await db("admin_operations")
    .where({ id, status: "running", lease_owner: owner })
    .where("lease_expires_at", ">", db.fn.now())
    .update({ lease_expires_at: leaseSql(db, leaseMs) });
  return n === 1;
}

function boundedResult(result: unknown): unknown {
  const text = JSON.stringify(result ?? {});
  return text.length > MAX_RESULT_BYTES ? { truncated: true, bytes: text.length } : (result ?? {});
}

/** `running` → `done`. Sólo el dueño del lease; devuelve false si ya no lo es. */
export async function completeOperation(db: Db, id: string, owner: string, result: unknown): Promise<boolean> {
  const rows = await db("admin_operations")
    .where({ id, status: "running", lease_owner: owner })
    .update({
      status: "done",
      result: JSON.stringify(boundedResult(result)),
      finished_at: db.fn.now(),
      lease_expires_at: null,
    })
    .returning(["kind"]);
  if (rows.length !== 1) return false;
  await audit(db, {
    actorId: null,
    action: "admin.op.succeeded",
    target: `operation:${id}`,
    detail: { kind: rows[0].kind, executor: owner },
  });
  return true;
}

/** `running` → `failed` con un motivo corto (sin secretos ni rutas internas). */
export async function failOperation(db: Db, id: string, owner: string, reason: string): Promise<boolean> {
  const rows = await db("admin_operations")
    .where({ id, status: "running", lease_owner: owner })
    .update({
      status: "failed",
      result: JSON.stringify({ error: String(reason).slice(0, 500) }),
      finished_at: db.fn.now(),
      lease_expires_at: null,
    })
    .returning(["kind"]);
  if (rows.length !== 1) return false;
  await audit(db, {
    actorId: null,
    action: "admin.op.failed",
    target: `operation:${id}`,
    detail: { kind: rows[0].kind, executor: owner },
  });
  return true;
}

/** Lease caducado: de vuelta a `pending` si quedan intentos; si no, `failed` (lease_expired). */
export async function reapExpiredLeases(
  db: Db,
  opts: { kinds: readonly string[]; maxAttempts: number },
): Promise<{ requeued: number; failed: number }> {
  assertKinds(opts.kinds);
  const requeued = await db("admin_operations")
    .where({ status: "running" })
    .whereIn("kind", [...opts.kinds])
    .where("lease_expires_at", "<=", db.fn.now())
    .where("attempts", "<", opts.maxAttempts)
    .update({ status: "pending", lease_owner: null, lease_expires_at: null });
  const failed = await db("admin_operations")
    .where({ status: "running" })
    .whereIn("kind", [...opts.kinds])
    .where("lease_expires_at", "<=", db.fn.now())
    .where("attempts", ">=", opts.maxAttempts)
    .update({
      status: "failed",
      result: JSON.stringify({ error: "lease_expired" }),
      finished_at: db.fn.now(),
      lease_owner: null,
      lease_expires_at: null,
    });
  return { requeued, failed };
}
