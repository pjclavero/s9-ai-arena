/**
 * #287 · Migración 022_entries_team contra PostgreSQL REAL:
 *  1. añade `entries.team_id` NULLABLE y NO rellena las inscripciones existentes;
 *  2. FK (NO ACTION, 23503): un equipo con inscripciones no se borra (y la API lo dice: team_in_use);
 *  3. ROLLBACK POR NOMBRE: se van sólo la columna (y su índice) y la tabla
 *     `team_entry_consents` (ronda 2, H5); las inscripciones se conservan.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "./seeds/dev.js";
import { MIGRATIONS, migrateNamed, NAMED_ROLLBACK_ALLOWED, rollbackNamed } from "./migrations.js";
import { createLoadoutRevision } from "../services/bots.js";

let h: TestDbHandle;
const NAME = "022_entries_team";

async function hasConsentsTable(): Promise<boolean> {
  const r = await h.db.raw(`SELECT to_regclass('public.team_entry_consents') AS t`);
  return r.rows[0].t !== null;
}

async function entryColumns(): Promise<string[]> {
  const r = await h.db.raw(`SELECT column_name FROM information_schema.columns WHERE table_name = 'entries'`);
  return r.rows.map((x: { column_name: string }) => x.column_name).sort();
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
}, 120_000);
afterAll(async () => {
  await h.stop();
});

describe("migración 022_entries_team", () => {
  it("está aplicada, es la última y la columna es nullable", async () => {
    expect(MIGRATIONS.at(-1)!.name).toBe(NAME);
    expect(await entryColumns()).toContain("team_id");
    const r = await h.db.raw(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'entries' AND column_name = 'team_id'`,
    );
    expect(r.rows[0].is_nullable).toBe("YES");
    expect(await hasConsentsTable()).toBe(true);
  });

  it("no rellena filas, el equipo inscrito no se borra (23503), y el rollback por nombre conserva las inscripciones", async () => {
    const owner = await h.db("users").where({ email: DEV_USERS.developer }).first();
    const [team] = await h.db("teams").insert({ name: "m022-team", captain_id: owner.id }).returning("*");
    const [bot] = await h.db("bots").insert({ name: "m022-bot", owner_id: owner.id, team_id: team.id }).returning("*");
    await createLoadoutRevision(
      h.db,
      bot.id,
      { catalogVersion: "mvp@1", chassis: "chassis.medium@2", modules: [] } as never,
      { massKg: 0, costCredits: 0, energyBalanceEUs: 0 },
    );
    await h.db("bot_versions").insert({
      bot_id: bot.id,
      version: 1,
      state: "published",
      runtime: "python",
      loadout_revision: 1,
      source: Buffer.from("print(1)\n"),
      source_filename: "bot.py",
      artifact_hash: "sha256:m022",
    });
    const [t] = await h
      .db("tournaments")
      .insert({ name: "m022", format: "teams", mode: "team_deathmatch", ruleset_id: DEFAULT_RULESET_ID, state: "open" })
      .returning("*");
    // Inscripción «antigua» (sin team_id): la columna NO se rellena sola.
    const [legacy] = await h
      .db("entries")
      .insert({ tournament_id: t.id, bot_id: bot.id, version: 1, loadout_revision: 1 })
      .returning("*");
    expect(legacy.team_id).toBeNull();
    await h.db("entries").where({ id: legacy.id }).update({ team_id: team.id });
    await expect(h.db("teams").where({ id: team.id }).delete()).rejects.toMatchObject({ code: "23503" });

    expect(NAMED_ROLLBACK_ALLOWED).toContain(NAME);
    const before = (await entryColumns()).filter((c) => c !== "team_id");
    await rollbackNamed(h.db, NAME);
    expect(await entryColumns()).toEqual(before);
    expect(await hasConsentsTable()).toBe(false);
    expect(await h.db("entries").where({ id: legacy.id }).first()).toBeTruthy();
    await migrateNamed(h.db, NAME);
    expect(await entryColumns()).toContain("team_id");
    expect(await hasConsentsTable()).toBe(true);
    expect((await h.db("entries").where({ id: legacy.id }).first()).team_id).toBeNull();
  });
});
