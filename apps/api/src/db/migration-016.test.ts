/**
 * EQ2 · Migración 016_battle_rules (la 015 es 015_bot_retired, PR #209) (ADR-021/022) contra PostgreSQL REAL:
 *  1. UPGRADE con datos de una base en 014 (batalla terminada 0.3.0 con replay, torneo y
 *     participantes): ninguna fila cambia y NO se rellenan copias (una batalla histórica
 *     no se reescribe como si hubiera usado reglas nuevas);
 *  2. ROLLBACK: las columnas se van, el resto de datos queda idéntico;
 *  3. BACKUP / RESTORE de datos de prueba: copia lógica de las tablas afectadas en 016
 *     (con copias de reglas), rollback + upgrade (que pierde las copias: la vuelta atrás es
 *     destructiva SÓLO para ellas, documentado) y restauración: todo vuelve, copias incluidas.
 * El simulacro con `pg_dump`/`pg_restore` reales (imagen postgres) está en
 * docs/operations/upgrades.md § «Migración 016» (no hay pg_dump en el PG embebido de CI).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { MIGRATIONS, migrateToLatest, rollbackLast } from "./migrations.js";
import { DEV_USERS, DEFAULT_RULESET_ID, seedDev } from "./seeds/dev.js";
import { createPublishedBot } from "../../../tournament-worker/src/testing/fixtures.js";

let h: TestDbHandle;
// Por TEMA, no por número: si otra migración entra antes (p. ej. 015_bot_retired del EQ4),
// ésta se renumera a la siguiente al final de MIGRATIONS y el test sigue valiendo.
const RULES = MIGRATIONS.find((m) => m.name.endsWith("_battle_rules"))!.name;
const PREVIOUS = MIGRATIONS[MIGRATIONS.findIndex((m) => m.name === RULES) - 1].name;

const TABLES = ["tournaments", "matches", "battles", "participants"] as const;

async function columns(table: string): Promise<string[]> {
  const r = await h.db.raw(
    `SELECT column_name FROM information_schema.columns WHERE table_name = ? ORDER BY column_name`,
    [table],
  );
  return r.rows.map((x: { column_name: string }) => x.column_name);
}
async function dump() {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) {
    const order = t === "participants" ? ["battle_id", "bot_id"] : ["id"];
    out[t] = JSON.parse(JSON.stringify(await h.db(t).orderBy(order).select()));
  }
  return out;
}
// EQ2c · `battles.reverted_at` es de una migración POSTERIOR (018_battle_reverted), que
// rollbackRules revierte antes y migrateToLatest vuelve a aplicar: no es objeto de este test.
// VISIBILIDAD · lo mismo con `tournaments.broadcast` (019_visibility_broadcast).
const LATER_COLUMNS = ["reverted_at", "broadcast"];
const strip = (rows: unknown[], col: string) =>
  rows.map((r) => {
    const { [col]: _drop, ...rest } = r as Record<string, unknown>;
    for (const c of LATER_COLUMNS) delete rest[c];
    return rest;
  });
async function lastMigration(): Promise<string> {
  const r = await h.db("knex_migrations").orderBy("id", "desc").first();
  return r.name;
}
// EQ5b · cambio mínimo: con 017_streaming_admin detrás, 016 ya no es la última. Se
// revierten primero las posteriores (no tocan estas tablas) y después la 016.
const LATEST = MIGRATIONS.at(-1)!.name;
async function rollbackRules(): Promise<void> {
  while ((await lastMigration()) !== RULES) await rollbackLast(h.db);
  await rollbackLast(h.db);
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
}, 120_000);

afterAll(async () => {
  await h.stop();
});

describe("migración 016_battle_rules", () => {
  it("está aplicada y sólo añade battles.rules y tournaments.rules (nullable)", async () => {
    expect(RULES).toMatch(/^\d{3}_battle_rules$/);
    expect(await lastMigration()).toBe(LATEST);
    const r = await h.db.raw(
      `SELECT table_name, is_nullable, data_type FROM information_schema.columns WHERE column_name = 'rules' AND table_name IN ('battles','tournaments') ORDER BY table_name`,
    );
    expect(r.rows).toEqual([
      { table_name: "battles", is_nullable: "YES", data_type: "jsonb" },
      { table_name: "tournaments", is_nullable: "YES", data_type: "jsonb" },
    ]);
  });

  it("upgrade (base en la migración anterior) → 016 con datos, rollback y backup/restore", async () => {
    // --- base en 014 con datos históricos ------------------------------------
    await rollbackRules();
    expect(await lastMigration()).toBe(PREVIOUS);
    expect(await columns("battles")).not.toContain("rules");
    expect(await columns("tournaments")).not.toContain("rules");

    const admin = await h.db("users").where({ email: DEV_USERS.admin }).first();
    const [t] = await h
      .db("tournaments")
      .insert({
        name: "hist-014",
        format: "league",
        mode: "deathmatch",
        ruleset_id: DEFAULT_RULESET_ID,
        state: "finished",
        created_by: admin.id,
      })
      .returning("*");
    const [m] = await h.db("matches").insert({ tournament_id: t.id, round: 1, state: "finished" }).returning("*");
    const battleId = randomUUID();
    await h.db("battles").insert({
      id: battleId,
      tournament_id: t.id,
      match_id: m.id,
      status: "finished",
      official: true,
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      seed: "hist-seed",
      replay_ref: `/data/replays/${battleId}.replay`,
      replay_hash: "sha256:" + "cd".repeat(32),
      final_state_hash: "ab".repeat(32),
      engine_versions: JSON.stringify({ engine: "0.3.0", rules: "dm_practice@1" }),
      result: JSON.stringify({ winner: "red", score: { red: 1, blue: 0 } }),
    });
    const bot = await createPublishedBot(h.db, "hist-014-bot");
    await h
      .db("participants")
      .insert({ battle_id: battleId, bot_id: bot.botId, version: 1, team: "red", outcome: "win" });
    const before = await dump();
    expect(before.participants).toHaveLength(1);

    // --- 1. UPGRADE ------------------------------------------------------------
    await migrateToLatest(h.db);
    expect(await lastMigration()).toBe(LATEST);
    const afterUp = await dump();
    expect(strip(afterUp.battles, "rules")).toEqual(before.battles);
    expect(strip(afterUp.tournaments, "rules")).toEqual(before.tournaments);
    expect(afterUp.participants).toEqual(before.participants);
    expect(afterUp.matches).toEqual(before.matches);
    // Ninguna copia inventada para lo histórico.
    expect((afterUp.battles as { rules: unknown }[]).every((b) => b.rules === null)).toBe(true);
    expect((afterUp.tournaments as { rules: unknown }[]).every((b) => b.rules === null)).toBe(true);
    const hist = (await h.db("battles").where({ id: battleId }).first()) as Record<string, any>;
    expect(hist.engine_versions.engine).toBe("0.3.0");

    // Datos nuevos en 016: una batalla con copia de reglas.
    const newId = randomUUID();
    const copy = { schema: 2, source: "preset", presetId: "duel", presetVersion: 1, engineVersion: "0.4.0" };
    await h.db("battles").insert({
      id: newId,
      status: "scheduled",
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      rules: JSON.stringify(copy),
    });
    await h
      .db("tournaments")
      .where({ id: t.id })
      .update({ rules: JSON.stringify({ schema: 2, source: "classic" }) });

    // --- 3a. BACKUP lógico en 016 ---------------------------------------------
    const backup = await dump();

    // --- 2. ROLLBACK -----------------------------------------------------------
    await rollbackRules();
    expect(await lastMigration()).toBe(PREVIOUS);
    expect(await columns("battles")).not.toContain("rules");
    expect(await columns("tournaments")).not.toContain("rules");
    const afterDown = await dump();
    expect(afterDown.battles).toEqual(strip(backup.battles, "rules"));
    expect(afterDown.tournaments).toEqual(strip(backup.tournaments, "rules"));
    expect(afterDown.participants).toEqual(backup.participants);

    // --- re-upgrade: las copias se perdieron con el rollback (destructivo SÓLO para ellas)
    await migrateToLatest(h.db);
    expect((await h.db("battles").where({ id: newId }).first()).rules).toBeNull();

    // --- 3b. RESTORE de la copia lógica ---------------------------------------
    await h.db.transaction(async (trx) => {
      await trx.raw(`TRUNCATE participants, battles, matches, tournaments CASCADE`);
      for (const tname of TABLES) {
        const rows = (backup[tname] as Record<string, unknown>[]).map((r) =>
          Object.fromEntries(
            Object.entries(r).map(([k, v]) => [k, v !== null && typeof v === "object" ? JSON.stringify(v) : v]),
          ),
        );
        if (rows.length > 0) await trx(tname).insert(rows);
      }
    });
    const restored = await dump();
    expect(restored).toEqual(backup);
    expect((await h.db("battles").where({ id: newId }).first()).rules).toEqual(copy);
    expect((await h.db("battles").where({ id: battleId }).first()).rules).toBeNull();
  }, 120_000);
});
