/**
 * V1 REPLAYS PR-3 · Migración 024_replay_artifacts contra PostgreSQL REAL:
 *  1. aplicada (la 023 la reserva ADM-1 #334, que se integra antes; el hueco no rompe knex);
 *  2. invariantes: estado y clase cerrados, sha256 hex de 64, bytes > 0, vista toda-o-nada,
 *     una fila por batalla y borrado en cascada con la batalla;
 *  3. ROLLBACK POR NOMBRE: se va sólo su tabla y se puede volver a aplicar.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { seedDev } from "./seeds/dev.js";
import { MIGRATIONS, migrateNamed, NAMED_ROLLBACK_ALLOWED, rollbackNamed } from "./migrations.js";

let h: TestDbHandle;
const NAME = "024_replay_artifacts";
const SHA = "a".repeat(64);

async function tables(): Promise<string[]> {
  const r = await h.db.raw(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  return r.rows.map((x: { tablename: string }) => x.tablename);
}

async function battle(): Promise<string> {
  const [b] = await h
    .db("battles")
    .insert({ status: "finished", official: false, mode: "deathmatch", map_id: "mvp-arena-01", map_version: 1 })
    .returning("id");
  return b.id as string;
}

const row = (battleId: string, extra: Record<string, unknown> = {}) => ({
  battle_id: battleId,
  class: "practice",
  attempt: 1,
  owner: "w:j:1",
  recipe_path: `/r/${battleId}.1.s9r`,
  recipe_sha256: SHA,
  recipe_bytes: 100,
  view_path: `/r/${battleId}.1.s9v`,
  view_sha256: SHA,
  view_bytes: 200,
  chain_hash: "c",
  ticks: 600,
  ...extra,
});

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
}, 120_000);
afterAll(async () => {
  await h.stop();
});

describe("migración 024_replay_artifacts", () => {
  it("está aplicada y es la última; la 023 queda reservada a ADM-1", async () => {
    expect(MIGRATIONS.at(-1)!.name).toBe(NAME);
    expect(await tables()).toContain("replay_artifacts");
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.filter((x) => x.startsWith("023_")).every((x) => x === "023_system_settings_operations")).toBe(true);
  });

  it("invariantes: estado/clase cerrados, sha hex, bytes > 0, vista toda-o-nada, PK por batalla y cascada", async () => {
    const id = await battle();
    await h.db("replay_artifacts").insert(row(id));
    const got = await h.db("replay_artifacts").where({ battle_id: id }).first();
    expect(got.state).toBe("published");
    expect(got.truncated).toBe(false);
    expect(got.stats_state).toBe("pending");
    expect(got.protected).toBe(false);
    await expect(h.db("replay_artifacts").insert(row(id))).rejects.toMatchObject({ code: "23505" });
    const bad: Record<string, unknown>[] = [
      { state: "deleted" },
      { class: "friendly" },
      { recipe_sha256: "XYZ" },
      { recipe_bytes: 0 },
      { view_sha256: "b".repeat(63) },
      { view_path: null }, // vista a medias
      { attempt: -1 },
      { stats_state: "done" },
    ];
    for (const extra of bad) {
      const other = await battle();
      await expect(h.db("replay_artifacts").insert(row(other, extra)), JSON.stringify(extra)).rejects.toMatchObject({
        code: "23514",
      });
    }
    // Nivel ligero (sin vista): válido si los tres campos de la vista son NULL.
    const light = await battle();
    await h.db("replay_artifacts").insert(row(light, { view_path: null, view_sha256: null, view_bytes: null }));
    await h.db("battles").where({ id }).delete();
    expect(await h.db("replay_artifacts").where({ battle_id: id })).toHaveLength(0);
  });

  it("rollback por nombre quita sólo su tabla y se puede volver a aplicar", async () => {
    expect(NAMED_ROLLBACK_ALLOWED).toContain(NAME);
    const before = (await tables()).filter((t) => t !== "replay_artifacts").sort();
    await rollbackNamed(h.db, NAME);
    expect((await tables()).sort()).toEqual(before);
    await migrateNamed(h.db, NAME);
    expect(await tables()).toContain("replay_artifacts");
  });
});
