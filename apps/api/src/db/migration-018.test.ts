/**
 * EQ2c · Migración 018_battle_reverted (STANDINGS_POLICY, #229) contra PostgreSQL REAL:
 *  1. UPGRADE con datos de una base en la migración anterior (torneo, enfrentamiento, batalla
 *     oficial terminada con participantes y su evento de rating): ninguna fila cambia y
 *     ninguna batalla histórica queda marcada como revertida;
 *  2. ROLLBACK: la columna se va y el resto de datos queda idéntico;
 *  3. BACKUP / RESTORE lógico: copia en 018 con una batalla revertida, rollback + upgrade (que
 *     pierde la marca: la vuelta atrás es destructiva SÓLO para ella, documentado en
 *     docs/operations/upgrades.md § «Migración 018») y restauración: todo vuelve, marca incluida.
 * La 017 está reservada para `017_streaming_admin` (PR #227): el test busca por TEMA y por
 * posición, no por número.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { MIGRATIONS, migrateToLatest, rollbackLast } from "./migrations.js";
import { DEV_USERS, DEFAULT_RULESET_ID, seedDev } from "./seeds/dev.js";
import { createBots } from "../../../tournament-worker/src/testing/fixtures.js";

let h: TestDbHandle;
const REVERTED = MIGRATIONS.find((m) => m.name.endsWith("_battle_reverted"))!.name;
const PREVIOUS = MIGRATIONS[MIGRATIONS.findIndex((m) => m.name === REVERTED) - 1].name;
const LATEST = MIGRATIONS.at(-1)!.name;

const TABLES = ["tournaments", "matches", "battles", "participants", "rating_events", "ratings"] as const;
const ORDER: Record<(typeof TABLES)[number], string[]> = {
  tournaments: ["id"],
  matches: ["id"],
  battles: ["id"],
  participants: ["battle_id", "bot_id"],
  rating_events: ["id"],
  ratings: ["bot_id", "season_id", "mode"],
};

async function columns(table: string): Promise<string[]> {
  const r = await h.db.raw(
    `SELECT column_name FROM information_schema.columns WHERE table_name = ? ORDER BY column_name`,
    [table],
  );
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
  const r = await h.db("knex_migrations").orderBy("id", "desc").first();
  return r.name;
}
/** Revierte las posteriores (si las hay) y después la 018. */
async function rollbackReverted(): Promise<void> {
  while ((await lastMigration()) !== REVERTED) await rollbackLast(h.db);
  await rollbackLast(h.db);
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
}, 120_000);

afterAll(async () => {
  await h.stop();
});

describe("migración 018_battle_reverted", () => {
  it("está aplicada y sólo añade battles.reverted_at (timestamptz, nullable)", async () => {
    expect(REVERTED).toBe("018_battle_reverted");
    expect(await lastMigration()).toBe(LATEST);
    const r = await h.db.raw(
      `SELECT table_name, is_nullable, data_type FROM information_schema.columns WHERE column_name = 'reverted_at' ORDER BY table_name`,
    );
    expect(r.rows).toEqual([{ table_name: "battles", is_nullable: "YES", data_type: "timestamp with time zone" }]);
  });

  it("upgrade con datos, rollback y backup/restore", async () => {
    // --- base en la migración anterior con datos históricos ---------------------
    await rollbackReverted();
    expect(await lastMigration()).toBe(PREVIOUS);
    expect(await columns("battles")).not.toContain("reverted_at");

    const admin = await h.db("users").where({ email: DEV_USERS.admin }).first();
    const [a, b] = await createBots(h.db, 2, "m018");
    const [t] = await h
      .db("tournaments")
      .insert({
        name: "hist-018",
        format: "league",
        mode: "deathmatch",
        ruleset_id: DEFAULT_RULESET_ID,
        state: "finished",
        created_by: admin.id,
        season_id: "M018",
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
      game_index: 1,
      result: JSON.stringify({ winner: "A", score: { A: 1, B: 0 }, endReason: "completed" }),
    });
    await h.db("participants").insert([
      { battle_id: battleId, bot_id: a.botId, version: 1, team: "A", outcome: "win" },
      { battle_id: battleId, bot_id: b.botId, version: 1, team: "B", outcome: "loss" },
    ]);
    await h.db("rating_events").insert({
      battle_id: battleId,
      bot_id: a.botId,
      bot_version: 1,
      season_id: "M018",
      mode: "deathmatch",
      k: 24,
      rating_before: 1000,
      delta: 12,
      rating_after: 1012,
    });
    await h.db("ratings").insert({ bot_id: a.botId, season_id: "M018", mode: "deathmatch", rating: 1012, wins: 1 });
    const before = await dump();
    expect(before.participants).toHaveLength(2);

    // --- 1. UPGRADE ------------------------------------------------------------
    await migrateToLatest(h.db);
    expect(await lastMigration()).toBe(LATEST);
    const afterUp = await dump();
    expect(strip(afterUp.battles, "reverted_at")).toEqual(before.battles);
    for (const tn of TABLES.filter((x) => x !== "battles")) expect(afterUp[tn]).toEqual(before[tn]);
    // Ninguna batalla histórica queda revertida.
    expect((afterUp.battles as { reverted_at: unknown }[]).every((x) => x.reverted_at === null)).toBe(true);

    // Datos nuevos en 018: la batalla se revierte.
    await h.db("battles").where({ id: battleId }).update({ reverted_at: h.db.fn.now() });

    // --- 3a. BACKUP lógico en 018 ----------------------------------------------
    const backup = await dump();
    expect(
      (backup.battles as { id: string; reverted_at: unknown }[]).find((x) => x.id === battleId)!.reverted_at,
    ).not.toBeNull();

    // --- 2. ROLLBACK -----------------------------------------------------------
    await rollbackReverted();
    expect(await lastMigration()).toBe(PREVIOUS);
    expect(await columns("battles")).not.toContain("reverted_at");
    const afterDown = await dump();
    expect(afterDown.battles).toEqual(strip(backup.battles, "reverted_at"));
    for (const tn of TABLES.filter((x) => x !== "battles")) expect(afterDown[tn]).toEqual(backup[tn]);

    // --- re-upgrade: la marca se perdió con el rollback (destructivo SÓLO para ella)
    await migrateToLatest(h.db);
    expect((await h.db("battles").where({ id: battleId }).first()).reverted_at).toBeNull();

    // --- 3b. RESTORE de la copia lógica ----------------------------------------
    await h.db.transaction(async (trx) => {
      await trx.raw(`TRUNCATE ratings, rating_events, participants, battles, matches, tournaments CASCADE`);
      for (const tname of TABLES) {
        const rows = (backup[tname] as Record<string, unknown>[]).map((r) =>
          Object.fromEntries(
            Object.entries(r)
              .filter(([k]) => !(tname === "rating_events" && k === "id"))
              .map(([k, v]) => [k, v !== null && typeof v === "object" ? JSON.stringify(v) : v]),
          ),
        );
        if (rows.length > 0) await trx(tname).insert(rows);
      }
    });
    const restored = await dump();
    expect(strip(restored.rating_events, "id")).toEqual(strip(backup.rating_events, "id"));
    for (const tn of TABLES.filter((x) => x !== "rating_events")) expect(restored[tn]).toEqual(backup[tn]);
    expect((await h.db("battles").where({ id: battleId }).first()).reverted_at).not.toBeNull();
  }, 120_000);
});
