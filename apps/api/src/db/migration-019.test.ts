/**
 * VISIBILIDAD · Migración 019_visibility_broadcast contra PostgreSQL REAL:
 *  1. UPGRADE con datos (torneo histórico, bot privado con una versión publicada y
 *     código público): ninguna fila cambia y ningún torneo existente queda retransmisible;
 *     tras ella el dueño puede volver a ocultar el código (enmienda a D9) y el resto del
 *     guardián sigue vigente (código de una publicada inmutable);
 *  2. ROLLBACK: la columna se va, el resto de datos queda idéntico y vuelve la
 *     irreversibilidad de D9 en el guardián;
 *  3. BACKUP / RESTORE lógico: copia en 019 con un torneo retransmisible, rollback +
 *     upgrade (pierde SÓLO la marca, documentado en docs/operations/upgrades.md
 *     § «Migración 019») y restauración: todo vuelve, marca incluida.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { MIGRATIONS, migrateToLatest, rollbackLast } from "./migrations.js";
import { DEV_USERS, DEFAULT_RULESET_ID, seedDev } from "./seeds/dev.js";
import { createPublishedBot } from "../../../tournament-worker/src/testing/fixtures.js";

let h: TestDbHandle;
const M019 = MIGRATIONS.find((m) => m.name.endsWith("_visibility_broadcast"))!.name;
const PREVIOUS = MIGRATIONS[MIGRATIONS.findIndex((m) => m.name === M019) - 1].name;
const LATEST = MIGRATIONS.at(-1)!.name;

const TABLES = ["tournaments", "bots", "bot_versions", "entries"] as const;
const ORDER: Record<(typeof TABLES)[number], string[]> = {
  tournaments: ["id"],
  bots: ["id"],
  bot_versions: ["bot_id", "version"],
  entries: ["id"],
};

async function columns(table: string): Promise<string[]> {
  const r = await h.db.raw(`SELECT column_name FROM information_schema.columns WHERE table_name = ?`, [table]);
  return r.rows.map((x: { column_name: string }) => x.column_name);
}
async function dump() {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) out[t] = JSON.parse(JSON.stringify(await h.db(t).orderBy(ORDER[t]).select()));
  return out;
}
const strip = (rows: unknown[], col: string) =>
  rows.map((r) => {
    const { [col]: _drop, ...rest } = r as Record<string, unknown>;
    return rest;
  });
async function lastMigration(): Promise<string> {
  return (await h.db("knex_migrations").orderBy("id", "desc").first()).name;
}
async function rollback019(): Promise<void> {
  while ((await lastMigration()) !== M019) await rollbackLast(h.db);
  await rollbackLast(h.db);
}
const hide = (botId: string) =>
  h.db("bot_versions").where({ bot_id: botId, version: 1 }).update({ code_public: false });

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
}, 120_000);

afterAll(async () => {
  await h.stop();
});

describe("migración 019_visibility_broadcast", () => {
  it("está aplicada y sólo añade tournaments.broadcast (boolean NOT NULL DEFAULT false)", async () => {
    expect(M019).toBe("019_visibility_broadcast");
    expect(await lastMigration()).toBe(LATEST);
    const r = await h.db.raw(
      `SELECT table_name, is_nullable, data_type, column_default FROM information_schema.columns WHERE column_name = 'broadcast' ORDER BY table_name`,
    );
    expect(r.rows).toEqual([
      { table_name: "tournaments", is_nullable: "NO", data_type: "boolean", column_default: "false" },
    ]);
  });

  it("upgrade con datos, rollback y backup/restore", async () => {
    // --- base en la migración anterior con datos históricos ----------------------
    await rollback019();
    expect(await lastMigration()).toBe(PREVIOUS);
    expect(await columns("tournaments")).not.toContain("broadcast");

    const admin = await h.db("users").where({ email: DEV_USERS.admin }).first();
    const bot = await createPublishedBot(h.db, `m019-${randomUUID().slice(0, 6)}`);
    await h.db("bots").where({ id: bot.botId }).update({ visibility: "private" });
    await h.db("bot_versions").where({ bot_id: bot.botId, version: 1 }).update({ code_public: true });
    // En 018 el guardián impone D9: el código público no se puede volver a ocultar.
    await expect(hide(bot.botId)).rejects.toThrow(/code_public es irreversible/);
    const [t] = await h
      .db("tournaments")
      .insert({
        name: "hist-019",
        format: "league",
        mode: "deathmatch",
        ruleset_id: DEFAULT_RULESET_ID,
        state: "open",
        created_by: admin.id,
      })
      .returning("*");
    await h.db("entries").insert({ tournament_id: t.id, bot_id: bot.botId, version: 1, loadout_revision: 1 });
    const before = await dump();

    // --- 1. UPGRADE -------------------------------------------------------------
    await migrateToLatest(h.db);
    expect(await lastMigration()).toBe(LATEST);
    const afterUp = await dump();
    expect(strip(afterUp.tournaments, "broadcast")).toEqual(before.tournaments);
    expect((afterUp.tournaments as { broadcast: boolean }[]).every((x) => x.broadcast === false)).toBe(true);
    for (const tn of TABLES.filter((x) => x !== "tournaments")) expect(afterUp[tn]).toEqual(before[tn]);
    // Enmienda a D9: ahora sí se puede ocultar; el resto del guardián sigue.
    await hide(bot.botId);
    expect((await h.db("bot_versions").where({ bot_id: bot.botId, version: 1 }).first()).code_public).toBe(false);
    await expect(
      h
        .db("bot_versions")
        .where({ bot_id: bot.botId, version: 1 })
        .update({ source: Buffer.from("x") }),
    ).rejects.toThrow(/bot_version_immutable/);
    await expect(h.db("bot_versions").where({ bot_id: bot.botId, version: 1 }).del()).rejects.toThrow(
      /bot_version_immutable/,
    );
    await h.db("bot_versions").where({ bot_id: bot.botId, version: 1 }).update({ code_public: true });

    // Datos nuevos en 019: el torneo es retransmisible.
    await h.db("tournaments").where({ id: t.id }).update({ broadcast: true });

    // --- 3a. BACKUP lógico en 019 -----------------------------------------------
    const backup = await dump();

    // --- 2. ROLLBACK ------------------------------------------------------------
    await rollback019();
    expect(await lastMigration()).toBe(PREVIOUS);
    expect(await columns("tournaments")).not.toContain("broadcast");
    const afterDown = await dump();
    expect(afterDown.tournaments).toEqual(strip(backup.tournaments, "broadcast"));
    for (const tn of TABLES.filter((x) => x !== "tournaments")) expect(afterDown[tn]).toEqual(backup[tn]);
    // Vuelve la irreversibilidad de D9.
    await expect(hide(bot.botId)).rejects.toThrow(/code_public es irreversible/);

    // --- re-upgrade: la marca se perdió con el rollback -------------------------
    await migrateToLatest(h.db);
    expect((await h.db("tournaments").where({ id: t.id }).first()).broadcast).toBe(false);

    // --- 3b. RESTORE de la copia lógica (torneos e inscripciones) --------------
    await h.db.transaction(async (trx) => {
      await trx.raw(`TRUNCATE entries, tournaments CASCADE`);
      for (const tname of ["tournaments", "entries"] as const) {
        const rows = (backup[tname] as Record<string, unknown>[]).map((r) =>
          Object.fromEntries(
            Object.entries(r).map(([k, v]) => [k, v !== null && typeof v === "object" ? JSON.stringify(v) : v]),
          ),
        );
        if (rows.length > 0) await trx(tname).insert(rows);
      }
    });
    const restored = await dump();
    for (const tn of TABLES) expect(restored[tn]).toEqual(backup[tn]);
    expect((await h.db("tournaments").where({ id: t.id }).first()).broadcast).toBe(true);
  }, 120_000);
});
