/**
 * REVIEW #244 (revisor independiente) · migración 019: la vuelta atrás devuelve el
 * guardián EXACTO de antes y la subida sólo quita la cláusula D9. Compara la
 * definición real de `s9_bot_version_guard()` en PostgreSQL (pg_get_functiondef),
 * no el texto del fichero de migraciones.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { MIGRATIONS, migrateNamed, migrateToLatest, rollbackLast, rollbackNamed } from "./migrations.js";

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

// STREAMING-UX · esta revisión trata a la 019 como la PUNTA de la historia (sus
// `rollbackLast` y `last()` lo suponen). Las migraciones posteriores (la 020, que no
// toca el guardián) se apartan mientras dura el fichero y se devuelven al final.
let later: typeof MIGRATIONS = [];
beforeAll(async () => {
  later = MIGRATIONS.splice(MIGRATIONS.findIndex((m) => m.name === "019_visibility_broadcast") + 1);
  h = await startTestDb();
}, 180_000);
afterAll(async () => {
  MIGRATIONS.push(...later);
  await h.stop();
});

describe("RV-M · migración 019 frente al guardián de la 012", () => {
  it("RV-M1 · up(019) = guardián de 012 sin la cláusula D9; down(019) = guardián de 012 byte a byte (normalizado)", async () => {
    expect(await last()).toBe(MIGRATIONS[MIGRATIONS.length - 1].name);
    expect(await last()).toBe("019_visibility_broadcast");
    const at019 = await guardDef();
    // El guardián GENUINO de la 012: se baja por debajo de ella y se aplica SÓLO la 012.
    // (Bajar sólo hasta la 012 dejaría el guardián que escribió el down de la 019: no
    // serviría de referencia; así lo vio el mutante M11 de la calibración.)
    while ((await last()) !== "011_battle_cpu_ms") await rollbackLast(h.db);
    await migrateNamed(h.db, "012_bot_versioning");
    expect(await last()).toBe("012_bot_versioning");
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

describe("RV-M2 · integración con #242: el runbook de la 019 usa `rollback:name`", () => {
  it("RV-M2 · `rollbackNamed('019_visibility_broadcast')` (lo que documenta upgrades.md) revierte y se puede volver a subir", async () => {
    // En a20c017 `rollbackNamed` no tiene lista cerrada y esto pasa. En main 124aee4 (#242)
    // sólo admite NAMED_ROLLBACK_ALLOWED = 016/017/018: tras el merge esta prueba se pone
    // ROJA con «no se puede revertir por nombre» y el runbook de la 019 deja de funcionar.
    // VISIBILIDAD-3 (P2-1): la 019 entra en NAMED_ROLLBACK_ALLOWED y vuelve a verde.
    expect(await last()).toBe("019_visibility_broadcast");
    await rollbackNamed(h.db, "019_visibility_broadcast");
    expect(await last()).toBe("018_battle_reverted");
    const cols = (
      await h.db.raw(`SELECT column_name FROM information_schema.columns WHERE table_name='tournaments'`)
    ).rows.map((r: { column_name: string }) => r.column_name);
    expect(cols).not.toContain("broadcast");
    await migrateToLatest(h.db);
    expect(await last()).toBe("019_visibility_broadcast");
  }, 180_000);
});
