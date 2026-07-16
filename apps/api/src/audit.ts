/** T7.2 · Auditoría de acciones administrativas y de publicación → audit_log (cap. 16.1). */
import type { Db } from "./db/connection.js";

export interface AuditEvent {
  actorId?: string | null;
  action: string;
  target: string;
  detail?: Record<string, unknown>;
  correlationId?: string;
}

export async function audit(db: Db, e: AuditEvent): Promise<void> {
  await db("audit_log").insert({
    actor_id: e.actorId ?? null,
    action: e.action,
    target: e.target,
    detail: JSON.stringify(e.detail ?? {}),
    correlation_id: e.correlationId ?? null,
  });
}
