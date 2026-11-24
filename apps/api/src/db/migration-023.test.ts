/**
 * ADM-1 · Migración 023_system_settings_operations contra PostgreSQL REAL:
 *  1. crea `system_settings` y `admin_operations` (y NO siembra filas);
 *  2. el CHECK de `kind` es una lista cerrada, el de `status` también, y un `running` exige lease;
 *  3. el índice único parcial impone UNA orden activa por tipo;
 *  4. ROLLBACK POR NOMBRE: se van las dos tablas y no se toca nada más; vuelve a aplicarse.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { insertOperationInState } from "../testing/admin-ops.js";
import { MIGRATIONS, NAMED_ROLLBACK_ALLOWED, rollbackNamed } from "./migrations.js";

let h: TestDbHandle;
const NAME = "023_system_settings_operations";

async function hasTable(t: string): Promise<boolean> {
  const r = await h.db.raw(`SELECT to_regclass('public.${t}') AS t`);
  return r.rows[0].t !== null;
}

beforeAll(async () => {
  h = await startTestDb();
}, 120_000);
afterAll(async () => {
  await h.stop();
});

describe("migración 023_system_settings_operations", () => {
  it("está aplicada tras la 022, sin filas sembradas", async () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.indexOf(NAME)).toBe(names.indexOf("022_entries_team") + 1);
    expect(await hasTable("system_settings")).toBe(true);
    expect(await hasTable("admin_operations")).toBe(true);
    expect(await h.db("system_settings").count({ n: "*" }).first()).toMatchObject({ n: "0" });
    expect(await h.db("admin_operations").count({ n: "*" }).first()).toMatchObject({ n: "0" });
  });

  it("claves con forma `dominio.nombre`; tipos y estados CERRADOS; running exige lease", async () => {
    await expect(h.db("system_settings").insert({ key: "Mala Clave", value: "1" })).rejects.toMatchObject({
      code: "23514",
    });
    await expect(h.db("system_settings").insert({ key: "sinpunto", value: "1" })).rejects.toMatchObject({
      code: "23514",
    });
    await h.db("system_settings").insert({ key: "ok.clave", value: "1" });
    await expect(h.db("admin_operations").insert({ kind: "shell.exec", status: "pending" })).rejects.toMatchObject({
      code: "23514",
    });
    await expect(h.db("admin_operations").insert({ kind: "system.noop", status: "raro" })).rejects.toMatchObject({
      code: "23514",
    });
    await expect(h.db("admin_operations").insert({ kind: "system.noop", status: "running" })).rejects.toMatchObject({
      code: "23514",
    });
    await h.db("system_settings").delete();
  });

  it("UNA activa por tipo (índice único parcial); las terminadas no cuentan", async () => {
    await insertOperationInState(h.db, "done");
    await insertOperationInState(h.db, "cancelled");
    await insertOperationInState(h.db, "pending");
    await expect(
      h.db("admin_operations").insert({ kind: "system.noop", status: "awaiting_confirmation" }),
    ).rejects.toMatchObject({ code: "23505" });
    await h.db("admin_operations").delete();
  });

  it("rollback: ya NO es por nombre (la 025 depende de ella) y, en orden 025 → 023, quita sus tablas y se reaplica", async () => {
    // ADM-3: `password_resets.issued_via_operation` apunta a `admin_operations`; revertir la 023 sola es imposible.
    expect(NAMED_ROLLBACK_ALLOWED).not.toContain(NAME);
    await expect(rollbackNamed(h.db, NAME)).rejects.toThrow(/no se puede revertir por nombre/);
    const m023 = MIGRATIONS.find((m) => m.name === NAME)!;
    const m025 = MIGRATIONS.find((m) => m.name === "025_user_status_recovery")!;
    await m025.down(h.db);
    await m023.down(h.db);
    expect(await hasTable("system_settings")).toBe(false);
    expect(await hasTable("admin_operations")).toBe(false);
    expect(await hasTable("audit_log")).toBe(true);
    await m023.up(h.db);
    await m025.up(h.db);
    expect(await hasTable("system_settings")).toBe(true);
    expect(await hasTable("admin_operations")).toBe(true);
  });
});
