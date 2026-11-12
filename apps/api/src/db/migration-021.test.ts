/**
 * MG · Migración 021_runtime_settings contra PostgreSQL REAL:
 *  1. crea `app_runtime_settings` VACÍA (la fila la crea la API al arrancar, desde SU
 *     entorno: así desplegar no cambia el comportamiento);
 *  2. invariantes: como mucho UNA fila (id = 1) y booleanos NOT NULL; sin columnas de
 *     secretos;
 *  3. ROLLBACK POR NOMBRE: se va sólo su tabla.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { MIGRATIONS, migrateNamed, NAMED_ROLLBACK_ALLOWED, rollbackNamed } from "./migrations.js";

let h: TestDbHandle;
const NAME = "021_runtime_settings";

async function tables(): Promise<string[]> {
  const r = await h.db.raw(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  return r.rows.map((x: { tablename: string }) => x.tablename);
}

beforeAll(async () => {
  h = await startTestDb();
}, 120_000);
afterAll(async () => {
  await h.stop();
});

describe("migración 021_runtime_settings", () => {
  it("está aplicada, es la última y nace sin fila", async () => {
    expect(MIGRATIONS.at(-1)!.name).toBe(NAME);
    expect(await tables()).toContain("app_runtime_settings");
    expect(await h.db("app_runtime_settings").select()).toEqual([]);
  });

  it("invariantes: una sola fila, booleanos obligatorios, sin columnas de secretos", async () => {
    await h.db("app_runtime_settings").insert({ id: 1, public_spectate_enabled: true, public_replays_enabled: false });
    await expect(
      h.db("app_runtime_settings").insert({ id: 2, public_spectate_enabled: true, public_replays_enabled: false }),
    ).rejects.toThrow();
    await expect(
      h.db("app_runtime_settings").where({ id: 1 }).update({ public_spectate_enabled: null }),
    ).rejects.toThrow();
    const cols = (
      await h.db.raw(`SELECT column_name FROM information_schema.columns WHERE table_name = 'app_runtime_settings'`)
    ).rows.map((x: { column_name: string }) => x.column_name);
    expect(cols.sort()).toEqual(
      ["id", "public_replays_enabled", "public_spectate_enabled", "updated_at", "updated_by"].sort(),
    );
  });

  it("rollback por nombre quita sólo su tabla y se puede volver a aplicar", async () => {
    expect(NAMED_ROLLBACK_ALLOWED).toContain(NAME);
    const before = (await tables()).filter((t) => t !== "app_runtime_settings").sort();
    await rollbackNamed(h.db, NAME);
    expect((await tables()).sort()).toEqual(before);
    await migrateNamed(h.db, NAME);
    expect(await tables()).toContain("app_runtime_settings");
  });
});
