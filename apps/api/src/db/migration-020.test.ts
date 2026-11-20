/**
 * STREAMING-UX · Migración 020_streaming_ingests contra PostgreSQL REAL:
 *  1. UPGRADE con datos de la 017 (configuración, clave sellada y sesiones): no
 *     cambia nada de lo que ya había; aparecen `streaming_ingests` (vacía, es
 *     decir, se usan las ingestas por defecto del catálogo) y
 *     `streaming_credentials.sealed_backup` (NULL);
 *  2. invariantes: sólo `rtmps://`, como mucho una fila por plataforma, y la
 *     URL de respaldo es opcional;
 *  3. ROLLBACK POR NOMBRE (`rollbackNamed`, NAMED_ROLLBACK_ALLOWED): se van la
 *     tabla y la columna, y la clave principal sellada sigue intacta;
 *  4. BACKUP / RESTORE lógico de lo nuevo: vuelve todo igual.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { MIGRATIONS, migrateToLatest, NAMED_ROLLBACK_ALLOWED, rollbackNamed } from "./migrations.js";
import { seedDev } from "./seeds/dev.js";

let h: TestDbHandle;
const NAME = "020_streaming_ingests";
const SEALED = {
  v: 2,
  alg: "RSA-OAEP-256+A256GCM",
  kid: "0123456789abcdef",
  bind: {},
  ek: "QQ==",
  iv: "QQ==",
  tag: "QQ==",
  ct: "QUJD",
};

async function applied(): Promise<string[]> {
  return (await h.db("knex_migrations").orderBy("id")).map((r: { name: string }) => r.name);
}
async function tables(): Promise<string[]> {
  const r = await h.db.raw(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  return r.rows.map((x: { tablename: string }) => x.tablename);
}
async function credentialColumns(): Promise<string[]> {
  const r = await h.db.raw(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'streaming_credentials' ORDER BY column_name`,
  );
  return r.rows.map((x: { column_name: string }) => x.column_name);
}
const plain = (rows: unknown[]) => JSON.parse(JSON.stringify(rows));
async function old017() {
  return {
    settings: plain(await h.db("streaming_settings").select()),
    credentials: plain(await h.db("streaming_credentials").select("platform", "sealed", "key_id", "last4")),
    sessions: plain(await h.db("streaming_sessions").orderBy("id")),
  };
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
}, 120_000);
afterAll(async () => {
  await h.stop();
});

describe("migración 020_streaming_ingests", () => {
  it("está registrada, aplicada y se puede revertir por nombre (independiente)", async () => {
    expect(MIGRATIONS.map((m) => m.name)).toContain(NAME);
    expect(await applied()).toContain(NAME);
    expect(NAMED_ROLLBACK_ALLOWED).toContain(NAME);
    expect(await tables()).toContain("streaming_ingests");
    expect(await credentialColumns()).toContain("sealed_backup");
  });

  it("invariantes: sólo rtmps://, una fila por plataforma, respaldo opcional", async () => {
    await h.db("streaming_ingests").insert({
      platform: "youtube",
      primary_ingest_url: "rtmps://a.rtmps.youtube.com/live2",
      backup_ingest_url: "rtmps://b.rtmps.youtube.com/live2?backup=1",
    });
    await expect(
      h.db("streaming_ingests").insert({ platform: "youtube", primary_ingest_url: "rtmps://x.example/live" }),
    ).rejects.toThrow();
    await expect(
      h.db("streaming_ingests").insert({ platform: "custom", primary_ingest_url: "rtmp://x.example/live" }),
    ).rejects.toThrow();
    await expect(
      h
        .db("streaming_ingests")
        .insert({ platform: "custom", primary_ingest_url: "rtmps://x.example/live", backup_ingest_url: "http://y" }),
    ).rejects.toThrow();
    await h.db("streaming_ingests").insert({ platform: "custom", primary_ingest_url: "rtmps://x.example/live" });
    expect((await h.db("streaming_ingests").where({ platform: "custom" }).first()).backup_ingest_url).toBeNull();
    // §21 · la URL se guarda tal cual (sin transformar).
    expect((await h.db("streaming_ingests").where({ platform: "youtube" }).first()).backup_ingest_url).toBe(
      "rtmps://b.rtmps.youtube.com/live2?backup=1",
    );
    await h.db("streaming_ingests").del();
  });

  it("upgrade con datos de la 017, rollback por nombre y backup/restore", async () => {
    // --- base sin la 020, con datos de la 017 ------------------------------------
    await rollbackNamed(h.db, NAME);
    expect(await applied()).not.toContain(NAME);
    expect(await tables()).not.toContain("streaming_ingests");
    expect(await credentialColumns()).not.toContain("sealed_backup");
    await h.db("streaming_settings").where({ id: 1 }).update({ enabled: true, mode: "rtmps", version: 7 });
    await h.db("streaming_credentials").insert({
      platform: "youtube",
      sealed: JSON.stringify(SEALED),
      key_id: "0123456789abcdef",
      last4: "ABCD",
    });
    await h.db("streaming_sessions").insert({ id: randomUUID(), state: "stopped", mode: "rtmps", config: "{}" });
    const before = await old017();

    // --- 1. UPGRADE --------------------------------------------------------------
    await migrateToLatest(h.db);
    expect(await applied()).toContain(NAME);
    expect(await old017()).toEqual(before);
    expect(await h.db("streaming_ingests").select()).toEqual([]);
    expect((await h.db("streaming_credentials").where({ platform: "youtube" }).first()).sealed_backup).toBeNull();

    // datos nuevos
    await h.db("streaming_ingests").insert({
      platform: "youtube",
      primary_ingest_url: "rtmps://a.rtmps.youtube.com/live2",
      backup_ingest_url: "rtmps://b.rtmps.youtube.com/live2?backup=1",
    });
    await h
      .db("streaming_credentials")
      .where({ platform: "youtube" })
      .update({ sealed_backup: JSON.stringify({ ...SEALED, ct: "UkVT" }) });
    const backup = {
      ingests: plain(await h.db("streaming_ingests").select()),
      sealedBackup: plain(await h.db("streaming_credentials").select("platform", "sealed_backup")),
    };

    // --- 2. ROLLBACK -------------------------------------------------------------
    await rollbackNamed(h.db, NAME);
    expect(await tables()).not.toContain("streaming_ingests");
    expect(await credentialColumns()).not.toContain("sealed_backup");
    expect(await old017()).toEqual(before); // la clave principal sellada sigue ahí

    // --- 3. RESTORE --------------------------------------------------------------
    await migrateToLatest(h.db);
    for (const r of backup.ingests as Record<string, unknown>[]) await h.db("streaming_ingests").insert(r);
    for (const r of backup.sealedBackup as { platform: string; sealed_backup: unknown }[]) {
      await h
        .db("streaming_credentials")
        .where({ platform: r.platform })
        .update({ sealed_backup: r.sealed_backup === null ? null : JSON.stringify(r.sealed_backup) });
    }
    expect(plain(await h.db("streaming_ingests").select())).toEqual(backup.ingests);
    expect(plain(await h.db("streaming_credentials").select("platform", "sealed_backup"))).toEqual(backup.sealedBackup);
    expect(await old017()).toEqual(before);
  }, 120_000);
});
