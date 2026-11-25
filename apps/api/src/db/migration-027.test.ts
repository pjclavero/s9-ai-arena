/**
 * V1 ADM-SETUP · Migración 027_web_setup_recovery_kit contra PostgreSQL REAL:
 *  1. BD con admin ⇒ la instalación nace completada (`via='migration'`): nunca abre el asistente;
 *  2. BD sin admin ⇒ abierta;
 *  3. el trigger impide reabrir (setup_completed_at y via inmutables una vez fijados), pero deja
 *     que `setup_completed_by` pase a NULL (ON DELETE SET NULL);
 *  4. down y up por nombre son reversibles; el kit sólo admite hashes Argon2id.
 * Los mutantes (`scripts/v1-web-setup-mutants.mjs`) llevan el nombre del caso entre [].
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { MIGRATIONS, migrateNamed, NAMED_ROLLBACK_ALLOWED, rollbackNamed } from "./migrations.js";

const NAME = "027_web_setup_recovery_kit";
let h: TestDbHandle;

async function tables(): Promise<string[]> {
  const r = await h.db.raw(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  return r.rows.map((x: { tablename: string }) => x.tablename);
}

async function newUser(tag: string, admin: boolean): Promise<string> {
  const [u] = await h
    .db("users")
    .insert({ email: `${tag}-${Date.now()}-${Math.random()}@m027.test`, password_hash: "x", display_name: tag })
    .returning("id");
  await h.db("user_roles").insert({ user_id: u.id, role: "user" });
  if (admin) await h.db("user_roles").insert({ user_id: u.id, role: "admin" });
  return u.id as string;
}

beforeAll(async () => {
  h = await startTestDb();
}, 120_000);
afterAll(async () => {
  await h?.stop();
});

describe("migración 027_web_setup_recovery_kit", () => {
  it("está aplicada, es la última y se puede revertir por nombre", async () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names[names.length - 1]).toBe(NAME);
    expect(NAMED_ROLLBACK_ALLOWED).toContain(NAME);
    expect(await tables()).toEqual(expect.arrayContaining(["install_state", "admin_recovery_kits"]));
  });

  it("[M027-bd-vacia-abierta] en una BD sin admins la fila nace ABIERTA", async () => {
    const st = await h.db("install_state").where({ id: true }).first();
    expect(st).toMatchObject({ setup_completed_at: null, via: null });
  });

  it("[M027-backfill-con-admin] con un admin previo, down+up deja la instalación COMPLETADA con via=migration", async () => {
    await newUser("previo", true);
    await rollbackNamed(h.db, NAME);
    expect(await tables()).not.toContain("install_state");
    await migrateNamed(h.db, NAME);
    const st = await h.db("install_state").where({ id: true }).first();
    expect(st.via).toBe("migration");
    expect(st.setup_completed_at).not.toBeNull();
  });

  it("[M027-trigger-no-reabre] una vez completada no se puede volver a NULL ni cambiar la vía", async () => {
    await expect(h.db("install_state").update({ setup_completed_at: null, via: null })).rejects.toThrow(/no se reabre/);
    await expect(h.db("install_state").update({ via: "web" })).rejects.toThrow(/no se reabre/);
    const st = await h.db("install_state").where({ id: true }).first();
    expect(st.via).toBe("migration");
  });

  it("[M027-no-delete-reabre] no se reabre con DELETE, TRUNCATE ni INSERT de una fila abierta habiendo admin", async () => {
    await expect(h.db("install_state").del()).rejects.toThrow(/no se borra/);
    await expect(h.db.raw("TRUNCATE install_state")).rejects.toThrow(/no se borra/);
    expect(await h.db("install_state").where({ id: true }).first()).toBeTruthy();
    // Aunque alguien vaciara la tabla saltándose los triggers, una fila ABIERTA no entra con un admin.
    await h.db.raw("ALTER TABLE install_state DISABLE TRIGGER install_state_no_delete");
    await h.db("install_state").del();
    await h.db.raw("ALTER TABLE install_state ENABLE TRIGGER install_state_no_delete");
    await expect(h.db("install_state").insert({ id: true })).rejects.toThrow(/no se reabre/);
    await h.db("install_state").insert({ id: true, setup_completed_at: h.db.fn.now(), via: "cli" });
  });

  it("singleton: no admite una segunda fila ni completar sin vía", async () => {
    await expect(h.db("install_state").insert({ id: false })).rejects.toThrow();
    await rollbackNamed(h.db, NAME);
    await h.db("user_roles").where({ role: "admin" }).del();
    await migrateNamed(h.db, NAME);
    await expect(h.db("install_state").update({ setup_completed_at: h.db.fn.now() })).rejects.toThrow();
  });

  it("setup_completed_by pasa a NULL al borrar la cuenta (ON DELETE SET NULL) sin reabrir", async () => {
    const id = await newUser("efimero", false);
    await h.db("install_state").update({ setup_completed_at: h.db.fn.now(), setup_completed_by: id, via: "web" });
    await h.db("user_roles").where({ user_id: id }).del();
    await h.db("users").where({ id }).del();
    const st = await h.db("install_state").where({ id: true }).first();
    expect(st.setup_completed_by).toBeNull();
    expect(st.via).toBe("web");
    expect(st.setup_completed_at).not.toBeNull();
  });

  it("admin_recovery_kits: un kit por cuenta, sólo hashes Argon2id y borrado en cascada", async () => {
    const id = await newUser("kit", true);
    await expect(h.db("admin_recovery_kits").insert({ user_id: id, kit_hash: "texto-en-claro" })).rejects.toThrow();
    await h.db("admin_recovery_kits").insert({ user_id: id, kit_hash: "$argon2id$v=19$m=1$x" });
    await expect(h.db("admin_recovery_kits").insert({ user_id: id, kit_hash: "$argon2id$otro" })).rejects.toThrow();
    await h.db("user_roles").where({ user_id: id }).del();
    await h.db("users").where({ id }).del();
    expect(await h.db("admin_recovery_kits").where({ user_id: id })).toEqual([]);
  });

  it("down es reversible: quita sólo sus tablas y su función, y up las recrea", async () => {
    await rollbackNamed(h.db, NAME);
    const t = await tables();
    expect(t).not.toContain("install_state");
    expect(t).not.toContain("admin_recovery_kits");
    expect(t).toContain("users");
    const fn = await h.db.raw(
      `SELECT 1 FROM pg_proc WHERE proname IN ('install_state_guard', 'install_state_no_reopen')`,
    );
    expect(fn.rows).toHaveLength(0);
    await migrateNamed(h.db, NAME);
    expect(await tables()).toEqual(expect.arrayContaining(["install_state", "admin_recovery_kits"]));
  });
});
