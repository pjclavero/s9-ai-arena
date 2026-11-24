/**
 * V1 ADM-3 · Migración 025_user_status_recovery contra PostgreSQL REAL:
 *  1. aplicada y justo detrás de la 024;
 *  2. invariantes: estado de cuenta cerrado y coherente con `blocked_at`, tokens con hash único, tipo de orden nuevo;
 *  3. VUELTA ATRÁS: quita sus columnas y las órdenes de su tipo, restaura el CHECK de `kind`, y se puede reaplicar.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { MIGRATIONS } from "./migrations.js";

let h: TestDbHandle;
const NAME = "025_user_status_recovery";

beforeAll(async () => {
  h = await startTestDb();
}, 120_000);
afterAll(async () => {
  await h.stop();
});

const cols = async (table: string): Promise<string[]> =>
  (
    await h.db.raw(
      `SELECT column_name FROM information_schema.columns WHERE table_name = ? AND table_schema = 'public'`,
      [table],
    )
  ).rows.map((r: { column_name: string }) => r.column_name);

/** Revierte o reaplica EXACTAMENTE la 025 (no está en la lista de rollback por nombre: se usa su `down`/`up`). */
const m025 = () => MIGRATIONS.find((m) => m.name === NAME)!;

async function newUser(email: string): Promise<string> {
  const [u] = await h.db("users").insert({ email, password_hash: "x", display_name: email }).returning("id");
  return u.id as string;
}

describe("migración 025_user_status_recovery", () => {
  it("MIG025_APLICADA: está aplicada y va justo detrás de la 024", async () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names[names.indexOf(NAME) - 1]).toBe("024_replay_artifacts");
    expect(await cols("users")).toEqual(expect.arrayContaining(["status", "blocked_at", "blocked_by"]));
    expect(await cols("password_resets")).toEqual(
      expect.arrayContaining(["created_at", "created_by", "issued_via_operation"]),
    );
  });

  it("MIG025_ESTADO_COHERENTE: la cuenta nace activa; el estado es cerrado y va de la mano de blocked_at", async () => {
    const id = await newUser("m025-a@test.local");
    expect((await h.db("users").where({ id }).first()).status).toBe("active");
    await expect(h.db("users").where({ id }).update({ status: "dormido" })).rejects.toThrow(/users_status_check|check/);
    await expect(h.db("users").where({ id }).update({ status: "blocked" })).rejects.toThrow(/users_blocked_consistent/);
    await expect(h.db("users").where({ id }).update({ blocked_at: new Date() })).rejects.toThrow(
      /users_blocked_consistent/,
    );
    await h.db("users").where({ id }).update({ status: "blocked", blocked_at: new Date() });
  });

  it("MIG025_TOKEN_HASH_UNICO: dos tokens no pueden compartir hash", async () => {
    const id = await newUser("m025-b@test.local");
    const row = { user_id: id, token_hash: "h".repeat(64), expires_at: new Date(Date.now() + 60_000) };
    await h.db("password_resets").insert(row);
    await expect(h.db("password_resets").insert(row)).rejects.toThrow(/password_resets_token_hash_uq/);
  });

  it("MIG025_KIND_NUEVO: la BD admite user.recovery_admin y sigue rechazando tipos desconocidos", async () => {
    await h.db("admin_operations").insert({ kind: "user.recovery_admin", status: "awaiting_confirmation" });
    await expect(h.db("admin_operations").insert({ kind: "x.otro", status: "awaiting_confirmation" })).rejects.toThrow(
      /admin_operations_kind_check/,
    );
  });

  it("MIG025_VUELTA_ATRAS: el down quita columnas y órdenes de su tipo, restaura el CHECK, y se puede reaplicar", async () => {
    await m025().down(h.db);
    expect(await cols("users")).not.toContain("status");
    expect(await cols("password_resets")).not.toContain("issued_via_operation");
    expect(
      await h.db("admin_operations").where({ kind: "user.recovery_admin" }).count({ n: "*" }).first(),
    ).toMatchObject({
      n: "0",
    });
    await expect(
      h.db("admin_operations").insert({ kind: "user.recovery_admin", status: "awaiting_confirmation" }),
    ).rejects.toThrow(/admin_operations_kind_check/);
    await m025().up(h.db);
    expect(await cols("users")).toContain("status");
    await h.db("admin_operations").insert({ kind: "user.recovery_admin", status: "awaiting_confirmation" });
  });
});
