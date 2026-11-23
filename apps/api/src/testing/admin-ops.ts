/** ADM-1 · Helper de tests: deja una orden en un estado dado siguiendo SÓLO transiciones legales (los triggers de INSERT/UPDATE de la BD no admiten atajos). */
import type { Db } from "../db/connection.js";

export type OpState = "awaiting_confirmation" | "pending" | "running" | "done" | "failed" | "cancelled";

export async function insertOperationInState(
  db: Db,
  state: OpState,
  extra: { kind?: string; requested_by?: string | null; confirmed_by?: string | null } = {},
): Promise<string> {
  const kind = extra.kind ?? "system.noop";
  const startAwaiting = state === "awaiting_confirmation" || Boolean(extra.confirmed_by);
  const [row] = await db("admin_operations")
    .insert({
      kind,
      status: startAwaiting ? "awaiting_confirmation" : "pending",
      requested_by: extra.requested_by ?? null,
    })
    .returning("id");
  const id = row.id as string;
  if (state === "awaiting_confirmation") return id;
  if (startAwaiting) {
    await db("admin_operations")
      .where({ id })
      .update({ status: "pending", confirmed_by: extra.confirmed_by ?? null, confirmed_at: db.fn.now() });
  }
  if (state === "pending") return id;
  if (state === "cancelled") {
    await db("admin_operations").where({ id }).update({ status: "cancelled", finished_at: db.fn.now() });
    return id;
  }
  await db("admin_operations")
    .where({ id })
    .update({
      status: "running",
      lease_owner: "test",
      lease_expires_at: new Date(Date.now() + 60_000),
      attempts: 1,
      started_at: db.fn.now(),
    });
  if (state === "running") return id;
  await db("admin_operations")
    .where({ id })
    .update({ status: state, finished_at: db.fn.now(), lease_owner: null, lease_expires_at: null });
  return id;
}
