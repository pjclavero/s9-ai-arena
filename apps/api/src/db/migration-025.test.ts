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
      expect.arrayContaining(["created_at", "created_by", "reset_two_factor"]),
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

  it("MIG025_MISMO_ADMIN_CONFIRMA_EN_BD: la BD acepta que quien pidió una orden la confirme (sin regla de segundo admin) y la columna ya no existe", async () => {
    expect(await cols("admin_operations")).not.toContain("requires_second_admin");
    await h.db("admin_operations").delete();
    const a = await newUser("m025-same@test.local");
    const [op] = await h
      .db("admin_operations")
      .insert({ kind: "system.noop", status: "awaiting_confirmation", requested_by: a })
      .returning("id");
    // el MISMO admin la confirma (awaiting_confirmation -> pending con confirmed_by = requested_by)
    await h
      .db("admin_operations")
      .where({ id: op.id })
      .update({ status: "pending", confirmed_by: a, confirmed_at: h.db.fn.now() });
    expect((await h.db("admin_operations").where({ id: op.id }).first()).status).toBe("pending");
    // el resto de la máquina de estados de la 023 sigue vigente: no se puede nacer en un estado final
    await expect(
      h.db("admin_operations").insert({ kind: "system.noop", status: "cancelled", requested_by: a }),
    ).rejects.toMatchObject({ code: "23514" });
    // y confirmar exige confirmed_by/confirmed_at informados
    await h.db("admin_operations").delete();
    const [op2] = await h
      .db("admin_operations")
      .insert({ kind: "system.noop", status: "awaiting_confirmation", requested_by: a })
      .returning("id");
    await expect(h.db("admin_operations").where({ id: op2.id }).update({ status: "pending" })).rejects.toMatchObject({
      code: "23514",
    });
    await h.db("admin_operations").delete();
  });

  it("MIG025_SIN_TIPOS_USER: no hay tipos user.* ni tabla de linaje ni columna de operación en las contraseñas; la regla «una activa por tipo» de ADM-1 sigue intacta", async () => {
    await expect(
      h.db("admin_operations").insert({ kind: "user.recovery_admin", status: "awaiting_confirmation" }),
    ).rejects.toThrow(/admin_operations_kind_check/);
    expect((await h.db.raw(`SELECT to_regclass('public.admin_grant_edges') AS t`)).rows[0].t).toBeNull();
    expect(await cols("password_resets")).not.toContain("issued_via_operation");
    await h.db("admin_operations").delete();
    await h.db("admin_operations").insert({ kind: "system.noop", status: "awaiting_confirmation" });
    await expect(
      h.db("admin_operations").insert({ kind: "system.noop", status: "awaiting_confirmation" }),
    ).rejects.toMatchObject({ code: "23505" });
    await h.db("admin_operations").delete();
  });

  it("MIG025_VUELTA_ATRAS: el down restaura la columna y la guarda ORIGINAL de la 023, quita las columnas, AVISA en la auditoría de las cuentas que desbloquea, y se puede reaplicar", async () => {
    const blockedId = await newUser("m025-blk@test.local");
    await h.db("users").where({ id: blockedId }).update({ status: "blocked", blocked_at: new Date() });
    await m025().down(h.db);
    const warn = await h.db("audit_log").where({ action: "migration.025.down" }).orderBy("id", "desc").first();
    expect(warn.detail.blockedAccountsUnblocked).toBeGreaterThanOrEqual(1);
    expect(await cols("users")).not.toContain("status");
    expect(await cols("password_resets")).not.toContain("created_by");
    expect(await cols("password_resets")).not.toContain("reset_two_factor");
    // la vuelta atrás restaura la columna y la guarda original (segundo admin) de la 023
    expect(await cols("admin_operations")).toContain("requires_second_admin");
    const [irrev] = await h
      .db("admin_operations")
      .insert({
        kind: "system.noop",
        status: "awaiting_confirmation",
        requested_by: blockedId,
        requires_second_admin: true,
      })
      .returning("id");
    await expect(
      h
        .db("admin_operations")
        .where({ id: irrev.id })
        .update({ status: "pending", confirmed_by: blockedId, confirmed_at: h.db.fn.now() }),
    ).rejects.toThrow(/segundo admin/);
    await h.db("admin_operations").delete();
    await m025().up(h.db);
    expect(await cols("users")).toContain("status");
    expect(await cols("admin_operations")).not.toContain("requires_second_admin");
  });
});
