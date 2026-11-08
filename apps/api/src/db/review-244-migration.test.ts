/**
 * REVIEW #244 (revisor independiente) · migración 019: la vuelta atrás devuelve el
 * guardián EXACTO de antes y la subida sólo quita la cláusula D9. Compara la
 * definición real de `s9_bot_version_guard()` en PostgreSQL (pg_get_functiondef),
 * no el texto del fichero de migraciones.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { MIGRATIONS, migrateToLatest, rollbackLast } from "./migrations.js";

let h: TestDbHandle;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const guardDef = async () =>
  norm((await h.db.raw(`SELECT pg_get_functiondef('s9_bot_version_guard'::regproc) AS d`)).rows[0].d as string);
const last = async () =>
  (await h.db("knex_migrations").orderBy("id", "desc").first("name"))?.name as string | undefined;
const D9 = norm(`IF OLD.code_public AND NOT NEW.code_public THEN
          RAISE EXCEPTION 'bot_version_immutable: code_public es irreversible (D9)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;`);

beforeAll(async () => {
  h = await startTestDb();
}, 180_000);
afterAll(async () => {
  await h.stop();
});

describe("RV-M · migración 019 frente al guardián de la 012", () => {
  it("RV-M1 · up(019) = guardián de 012 sin la cláusula D9; down(019) = guardián de 012 byte a byte (normalizado)", async () => {
    expect(await last()).toBe(MIGRATIONS[MIGRATIONS.length - 1].name);
    expect(await last()).toBe("019_visibility_broadcast");
    const at019 = await guardDef();
    // Hasta justo después de la 012 (la que crea el guardián).
    while ((await last()) !== "012_bot_versioning") await rollbackLast(h.db);
    const at012 = await guardDef();
    expect(at012).toContain(D9);
    expect(at019).not.toContain("irreversible");
    expect(at019).toBe(at012.replace(D9 + " ", ""));
    await migrateToLatest(h.db);
    expect(await last()).toBe("019_visibility_broadcast");
    expect(await guardDef()).toBe(at019);
    await rollbackLast(h.db);
    expect(await last()).toBe("018_battle_reverted");
    expect(await guardDef()).toBe(at012);
    await migrateToLatest(h.db);
    expect(await guardDef()).toBe(at019);
  }, 180_000);
});
