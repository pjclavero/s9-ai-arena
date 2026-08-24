/**
 * Contrato de `participants.cpu_ms` (migración 011_battle_cpu_ms): el CHECK debe
 * rechazar valores no finitos. Corre contra PostgreSQL REAL (ADR-E7-002), igual
 * que schema.test.ts y services/battle-run-cpu-ms.test.ts.
 *
 * En PostgreSQL, `NaN` y `+Infinity` ordenan por encima de cualquier número, así
 * que un CHECK ingenuo `cpu_ms >= 0` los ACEPTA (`'NaN'::float8 >= 0` es true).
 * Una sola fila con NaN convierte en NaN el avg/sum/max de toda la columna.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { migrateToLatest, rollbackLast } from "./migrations.js";
import { DEV_USERS, seedDev, DEFAULT_RULESET_ID } from "./seeds/dev.js";

let h: TestDbHandle;
let adminId: string;
let catalogVersion: string;
const REAL_HASH = "sha256:" + "ab".repeat(32);

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  adminId = (await h.db("users").where({ email: DEV_USERS.admin }).first()).id;
  catalogVersion = (await h.db("catalog_versions").first()).catalog_version;
}, 120000);

afterAll(async () => {
  await h.stop();
});

async function seedBot(name: string) {
  const id = randomUUID();
  await h.db("bots").insert({ id, name: `${name}-${id.slice(0, 8)}`, owner_id: adminId });
  await h.db("bot_loadouts").insert({
    bot_id: id,
    revision: 1,
    catalog_version: catalogVersion,
    chassis: "chassis.light@1",
    modules: JSON.stringify([]),
  });
  await h.db("bot_versions").insert({
    bot_id: id,
    version: 1,
    state: "published",
    runtime: "python",
    loadout_revision: 1,
    artifact_hash: REAL_HASH,
  });
  return { botId: id, version: 1 };
}

/** Batalla REAL en BD con un único participante, para probar el CHECK de cpu_ms aislado. */
async function seedBattleWithParticipant(): Promise<{ battleId: string; botId: string }> {
  const bot = await seedBot("cpu-ms-check");
  const [battle] = await h
    .db("battles")
    .insert({
      status: "running",
      official: true,
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      seed: `cpu-ms-check-${randomUUID()}`,
    })
    .returning("*");
  return { battleId: battle.id, botId: bot.botId };
}

async function insertParticipant(cpuMs: number | null): Promise<void> {
  const { battleId, botId } = await seedBattleWithParticipant();
  await h.db("participants").insert({ battle_id: battleId, bot_id: botId, version: 1, team: "red", cpu_ms: cpuMs });
}

describe("CHECK participants.cpu_ms (011) — INSERT", () => {
  it("NULL permitido", async () => {
    await expect(insertParticipant(null)).resolves.toBeUndefined();
  });

  it("0 permitido", async () => {
    await expect(insertParticipant(0)).resolves.toBeUndefined();
  });

  it("positivo permitido", async () => {
    await expect(insertParticipant(123.45)).resolves.toBeUndefined();
  });

  it("negativo RECHAZADO", async () => {
    await expect(insertParticipant(-1)).rejects.toThrow(/viola|check|constraint/i);
  });

  it("NaN RECHAZADO", async () => {
    await expect(insertParticipant(NaN)).rejects.toThrow(/viola|check|constraint/i);
  });

  it("+Infinity RECHAZADO", async () => {
    await expect(insertParticipant(Number.POSITIVE_INFINITY)).rejects.toThrow(/viola|check|constraint/i);
  });

  it("-Infinity RECHAZADO", async () => {
    await expect(insertParticipant(Number.NEGATIVE_INFINITY)).rejects.toThrow(/viola|check|constraint/i);
  });
});

describe("CHECK participants.cpu_ms (011) — UPDATE", () => {
  async function insertThenUpdate(cpuMs: number): Promise<void> {
    const { battleId, botId } = await seedBattleWithParticipant();
    await h.db("participants").insert({ battle_id: battleId, bot_id: botId, version: 1, team: "red", cpu_ms: null });
    await h.db("participants").where({ battle_id: battleId, bot_id: botId }).update({ cpu_ms: cpuMs });
  }

  it("actualizar a 0 permitido", async () => {
    await expect(insertThenUpdate(0)).resolves.toBeUndefined();
  });

  it("actualizar a positivo permitido", async () => {
    await expect(insertThenUpdate(99)).resolves.toBeUndefined();
  });

  it("actualizar a negativo RECHAZADO", async () => {
    await expect(insertThenUpdate(-1)).rejects.toThrow(/viola|check|constraint/i);
  });

  it("actualizar a NaN RECHAZADO", async () => {
    await expect(insertThenUpdate(NaN)).rejects.toThrow(/viola|check|constraint/i);
  });

  it("actualizar a +Infinity RECHAZADO", async () => {
    await expect(insertThenUpdate(Number.POSITIVE_INFINITY)).rejects.toThrow(/viola|check|constraint/i);
  });

  it("actualizar a -Infinity RECHAZADO", async () => {
    await expect(insertThenUpdate(Number.NEGATIVE_INFINITY)).rejects.toThrow(/viola|check|constraint/i);
  });
});

describe("rollback:1 (011 → 010)", () => {
  beforeEach(async () => {
    // Nos aseguramos de partir con las migraciones al día antes de cada caso.
    await migrateToLatest(h.db);
  });

  it("revierte solo la última migración: knex_migrations baja exactamente 1 fila y participants pierde cpu_ms", async () => {
    const before = await h.db("knex_migrations").select("name").orderBy("id");
    expect(before.at(-1)?.name).toBe("011_battle_cpu_ms");

    await rollbackLast(h.db);

    const after = await h.db("knex_migrations").select("name").orderBy("id");
    expect(after.length).toBe(before.length - 1);
    expect(after.at(-1)?.name).toBe("010_r25_shared_limits");

    const cols = await h.db.raw(`SELECT column_name FROM information_schema.columns WHERE table_name = 'participants'`);
    const colNames = cols.rows.map((r: { column_name: string }) => r.column_name);
    expect(colNames).not.toContain("cpu_ms");

    // Deja la base como estaba para los demás tests del fichero.
    await migrateToLatest(h.db);
  });
});
