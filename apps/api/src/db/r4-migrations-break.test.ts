/**
 * Revisión independiente · ronda 4 del PR #227 (sobre 25bc372) · migraciones.
 * NO es una suite del autor y NO se mergea. PostgreSQL REAL (embebido).
 *
 *  - upgrade completo desde la 014 con datos;
 *  - `rollbackNamed`/`migrateNamed` y `cli.ts rollback:name`: nombres inexistentes,
 *    parciales, con otra caja, la 001; revertir la 017 deja intactas la 016 y la 018;
 *  - `DEFECTO`: en ROJO a propósito sobre 25bc372.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { MIGRATIONS, migrateNamed, migrateToLatest, rollbackNamed } from "./migrations.js";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const names = MIGRATIONS.map((m) => m.name);
const applied = async (h: TestDbHandle) =>
  (await h.db("knex_migrations").orderBy("id")).map((r: { name: string }) => r.name);
const tables = async (h: TestDbHandle) =>
  (await h.db.raw(`SELECT tablename FROM pg_tables WHERE schemaname='public'`)).rows.map(
    (r: { tablename: string }) => r.tablename,
  ) as string[];
const columns = async (h: TestDbHandle, t: string) =>
  (await h.db.raw(`SELECT column_name FROM information_schema.columns WHERE table_name = ? ORDER BY 1`, [t])).rows.map(
    (r: { column_name: string }) => r.column_name,
  ) as string[];
function cli(h: TestDbHandle, ...args: string[]) {
  const r = spawnSync("npx", ["tsx", CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: h.url },
    encoding: "utf8",
    timeout: 120_000,
  });
  return { rc: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("R4 · upgrade 014 → última y vuelta atrás por nombre (BD real)", () => {
  let h: TestDbHandle;
  beforeAll(async () => {
    h = await startTestDb({ migrate: false });
  }, 180_000);
  afterAll(async () => {
    await h.stop();
  });

  it("CONTROL · la lista es 001..018 consecutiva, con 016 → 017 → 018", () => {
    expect(names.map((n) => Number(n.slice(0, 3)))).toEqual(Array.from({ length: names.length }, (_, i) => i + 1));
    expect(names.slice(15, 18)).toEqual(["016_battle_rules", "017_streaming_admin", "018_battle_reverted"]);
  });

  it("CONTROL · BD en la 014 con datos ⇒ migrate aplica 015..018 y no toca los datos", async () => {
    for (const n of names.slice(0, 14)) await migrateNamed(h.db, n);
    expect(await applied(h)).toEqual(names.slice(0, 14));
    const uid = randomUUID();
    await h
      .db("users")
      .insert({ id: uid, email: `r4-${uid.slice(0, 8)}@x.test`, display_name: "r4", password_hash: "x" });
    const before = JSON.parse(JSON.stringify(await h.db("users").where({ id: uid })));
    await migrateToLatest(h.db);
    expect(await applied(h)).toEqual(names);
    expect(JSON.parse(JSON.stringify(await h.db("users").where({ id: uid })))).toEqual(before);
    expect(await columns(h, "battles")).toEqual(expect.arrayContaining(["rules", "reverted_at"]));
    const [s] = await h.db("streaming_settings");
    expect(s.enabled).toBe(false);
  });

  it("CONTROL · nombres inexistentes, parciales o con otra caja ⇒ rechazados sin tocar nada", async () => {
    const before = await applied(h);
    for (const bad of [
      "017",
      "017_streaming",
      "streaming_admin",
      "017_STREAMING_ADMIN",
      " 017_streaming_admin",
      "999_x",
      "",
    ]) {
      await expect(rollbackNamed(h.db, bad), bad).rejects.toThrow(/desconocida/);
      await expect(migrateNamed(h.db, bad), bad).rejects.toThrow(/desconocida/);
    }
    expect(await applied(h)).toEqual(before);
  });

  it("CONTROL · revertir la 017 por nombre deja intactas la 016 y la 018 (columnas y knex_migrations); re-up la devuelve", async () => {
    const bCols = await columns(h, "battles");
    await rollbackNamed(h.db, "017_streaming_admin");
    expect(await applied(h)).toEqual(names.filter((n) => n !== "017_streaming_admin"));
    expect((await tables(h)).filter((t) => t.startsWith("streaming_"))).toEqual([]);
    expect(await columns(h, "battles")).toEqual(bCols); // rules (016) y reverted_at (018)
    // Revertirla otra vez (ya no aplicada) no debe hacer nada destructivo.
    let second: string;
    try {
      await rollbackNamed(h.db, "017_streaming_admin");
      second = "ok";
    } catch (e) {
      second = `error: ${(e as Error).message}`;
    }
    expect(await applied(h)).toEqual(names.filter((n) => n !== "017_streaming_admin"));
    expect(await columns(h, "battles")).toEqual(bCols);
    expect(second).toMatch(/error|ok/);
    // Re-up por nombre (queda DETRÁS de la 018 en knex_migrations).
    await migrateNamed(h.db, "017_streaming_admin");
    expect((await applied(h)).slice(-2)).toEqual(["018_battle_reverted", "017_streaming_admin"]);
    expect((await tables(h)).filter((t) => t.startsWith("streaming_")).sort()).toEqual([
      "streaming_credentials",
      "streaming_sessions",
      "streaming_settings",
    ]);
    // Re-up de algo ya aplicado: no duplica.
    await migrateNamed(h.db, "017_streaming_admin").catch(() => undefined);
    expect((await applied(h)).filter((n) => n === "017_streaming_admin")).toHaveLength(1);
  });

  it("CONTROL · CLI: `rollback:name` sin argumento ⇒ rc=2; nombre parcial ⇒ rc≠0 sin tocar nada; 017 ⇒ rc=0 y sólo la 017", async () => {
    const before = await applied(h);
    const none = cli(h, "rollback:name");
    expect(none.rc, none.out).toBe(2);
    const partial = cli(h, "rollback:name", "017");
    expect(partial.rc, partial.out).not.toBe(0);
    expect(partial.out).toMatch(/desconocida/);
    expect(await applied(h)).toEqual(before);
    const ok = cli(h, "rollback:name", "017_streaming_admin");
    expect(ok.rc, ok.out).toBe(0);
    expect(await applied(h)).toEqual(before.filter((n) => n !== "017_streaming_admin"));
    const up = cli(h, "migrate");
    expect(up.rc, up.out).toBe(0);
    expect((await applied(h)).sort()).toEqual([...names].sort());
  }, 300_000);
});

describe("R4 · `rollback:name` acepta CUALQUIER migración aplicada, también la 001", () => {
  let h: TestDbHandle;
  beforeAll(async () => {
    h = await startTestDb();
  }, 180_000);
  afterAll(async () => {
    await h.stop();
  });

  it('DEFECTO P3 · `rollbackNamed("001_identity")` se ejecuta sin salvaguarda: DROP … users CASCADE con 17 migraciones posteriores encima (sólo la 016/017/018 están documentadas como reversibles por nombre)', async () => {
    const uid = randomUUID();
    await h
      .db("users")
      .insert({ id: uid, email: `r4b-${uid.slice(0, 8)}@x.test`, display_name: "r4", password_hash: "x" });
    let outcome: string;
    try {
      await rollbackNamed(h.db, "001_identity");
      outcome = "revertida";
    } catch (e) {
      outcome = `rechazada: ${(e as Error).message}`;
    }
    const usersTable = (await tables(h)).includes("users");
    // Exigible: rechazar (lista cerrada de migraciones reversibles por nombre, o un
    // `--force` explícito como mínimo). Lo medido: se revierte y la tabla de usuarios desaparece.
    expect({ outcome: outcome.startsWith("rechazada"), usersTable }).toEqual({ outcome: true, usersTable: true });
  });
});
