/**
 * EQ5b · Migración 017_streaming_admin contra PostgreSQL REAL:
 *  1. UPGRADE desde 016 con datos (batalla, auditoría): nada existente cambia y nace
 *     UNA fila de configuración con el streaming DESACTIVADO;
 *  2. invariantes de BD: una sola fila de settings, una sola sesión activa, nada de
 *     ingest en claro (rtmp://), plataforma/key_id con forma cerrada;
 *  3. ROLLBACK: las tablas de streaming se van y el resto queda idéntico; la
 *     auditoría `streaming.*` (audit_log) se conserva;
 *  4. BACKUP / RESTORE lógico de las tablas nuevas: todo vuelve igual.
 * El simulacro con pg_dump/pg_restore reales está en docs/operations/upgrades.md.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { MIGRATIONS, migrateToLatest, rollbackLast } from "./migrations.js";
import { DEFAULT_RULESET_ID, seedDev } from "./seeds/dev.js";

let h: TestDbHandle;
const NAME = MIGRATIONS.find((m) => m.name.endsWith("_streaming_admin"))!.name;
const PREVIOUS = MIGRATIONS[MIGRATIONS.findIndex((m) => m.name === NAME) - 1].name;
const NEW_TABLES = ["streaming_settings", "streaming_credentials", "streaming_sessions"] as const;

async function last(): Promise<string> {
  return (await h.db("knex_migrations").orderBy("id", "desc").first()).name;
}
async function tables(): Promise<string[]> {
  const r = await h.db.raw(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
  return r.rows.map((x: { tablename: string }) => x.tablename);
}
async function snapshotOld() {
  return {
    battles: JSON.parse(JSON.stringify(await h.db("battles").orderBy("id"))),
    audit: JSON.parse(JSON.stringify(await h.db("audit_log").orderBy("id"))),
  };
}
async function dumpNew() {
  const out: Record<string, unknown[]> = {};
  for (const t of NEW_TABLES) out[t] = JSON.parse(JSON.stringify(await h.db(t).select()));
  return out;
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
}, 120_000);
afterAll(async () => {
  await h.stop();
});

describe("migración 017_streaming_admin", () => {
  it("es la última y nace con el streaming DESACTIVADO", async () => {
    expect(NAME).toBe("017_streaming_admin");
    expect(MIGRATIONS.at(-1)!.name).toBe(NAME);
    expect(await last()).toBe(NAME);
    const s = await h.db("streaming_settings").select();
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ id: 1, enabled: false, mode: "record", encoder: "x264", preset: "1080p", fps: 30 });
  });

  it("invariantes de BD: una fila, una sesión activa, sin ingest en claro", async () => {
    await expect(h.db("streaming_settings").insert({ id: 2 })).rejects.toThrow();
    await expect(h.db("streaming_settings").where({ id: 1 }).update({ ingest_url: "rtmp://x/live" })).rejects.toThrow();
    await expect(h.db("streaming_settings").where({ id: 1 }).update({ fps: 45 })).rejects.toThrow();
    await expect(
      h.db("streaming_credentials").insert({ platform: "../etc", sealed: "{}", key_id: "0123456789abcdef", last4: "ABCD" }),
    ).rejects.toThrow();
    const s1 = { id: randomUUID(), state: "active", mode: "record", config: "{}" };
    await h.db("streaming_sessions").insert(s1);
    await expect(h.db("streaming_sessions").insert({ ...s1, id: randomUUID() })).rejects.toThrow(/streaming_sessions_one_active|duplicate/);
    await h.db("streaming_sessions").where({ id: s1.id }).update({ state: "stopped" });
    await h.db("streaming_sessions").insert({ ...s1, id: randomUUID() }); // ya se puede otra
    await h.db("streaming_sessions").del();
  });

  it("upgrade desde 016 con datos, rollback y backup/restore", async () => {
    // --- base en 016 con datos ------------------------------------------------
    await rollbackLast(h.db);
    expect(await last()).toBe(PREVIOUS);
    for (const t of NEW_TABLES) expect(await tables()).not.toContain(t);
    await h.db("battles").insert({
      id: randomUUID(),
      status: "finished",
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
    });
    await h.db("audit_log").insert({ action: "admin.algo", target: "x", detail: "{}" });
    const before = await snapshotOld();

    // --- 1. UPGRADE ---------------------------------------------------------------
    await migrateToLatest(h.db);
    expect(await last()).toBe(NAME);
    expect(await snapshotOld()).toEqual(before);

    // Datos en 017 (sobre sellado de PRUEBA: no es una clave) y auditoría de streaming.
    await h.db("streaming_settings").where({ id: 1 }).update({ enabled: true, mode: "rtmps", version: 2 });
    await h.db("streaming_credentials").insert({
      platform: "youtube",
      sealed: JSON.stringify({ v: 1, alg: "RSA-OAEP-256", kid: "0123456789abcdef", ct: "QUJD" }),
      key_id: "0123456789abcdef",
      last4: "ABCD",
    });
    await h.db("streaming_sessions").insert({ id: randomUUID(), state: "stopped", mode: "rtmps", config: "{}" });
    await h.db("audit_log").insert({ action: "streaming.settings.update", target: "streaming:settings", detail: "{}" });
    const backup = await dumpNew();
    const auditWithStreaming = await snapshotOld();

    // --- 2. ROLLBACK --------------------------------------------------------------
    await rollbackLast(h.db);
    expect(await last()).toBe(PREVIOUS);
    for (const t of NEW_TABLES) expect(await tables()).not.toContain(t);
    // La auditoría (incluida la de streaming) se conserva.
    expect(await snapshotOld()).toEqual(auditWithStreaming);

    // --- 3. RESTORE de la copia lógica sobre un 017 limpio ------------------------
    await migrateToLatest(h.db);
    await h.db.transaction(async (trx) => {
      await trx.raw(`TRUNCATE streaming_sessions, streaming_credentials, streaming_settings`);
      for (const t of NEW_TABLES) {
        const rows = (backup[t] as Record<string, unknown>[]).map((r) =>
          Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v !== null && typeof v === "object" ? JSON.stringify(v) : v])),
        );
        if (rows.length) await trx(t).insert(rows);
      }
    });
    expect(await dumpNew()).toEqual(backup);
  }, 120_000);
});
