/**
 * [REVIEW] #229 ronda 2 · migración 018_battle_reverted con pg_dump -Fc / pg_restore REALES.
 * NO MERGEAR. Necesita `PG_BIN` (directorio con pg_dump/pg_restore ≥ servidor, PostgreSQL 18);
 * sin él el test se SALTA (y un salto no es un verde: el informe da el rc de la ejecución local).
 *  - aditiva: sólo battles.reverted_at, nullable, sin DEFAULT, y SIN reescribir la tabla
 *    (relfilenode de battles idéntico antes y después: ALTER sólo de catálogo);
 *  - backup -Fc en 016+datos → upgrade → rollback → restore del backup en BD nueva → upgrade;
 *  - backup -Fc en 018 con una batalla revertida → restore en BD nueva: la marca vuelve
 *    idéntica y migrateToLatest es no-op.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { createDb } from "./connection.js";
import { MIGRATIONS, migrateToLatest, rollbackLast } from "./migrations.js";
import { DEV_USERS, DEFAULT_RULESET_ID, seedDev } from "./seeds/dev.js";
import { createBots } from "../../../tournament-worker/src/testing/fixtures.js";

const PG_BIN = process.env.PG_BIN ?? "";
const REVERTED = "018_battle_reverted";
let h: TestDbHandle;
let dir: string;

const bin = (n: string) => join(PG_BIN, n);
const env = { ...process.env, LD_LIBRARY_PATH: process.env.PG_LD_LIBRARY_PATH ?? process.env.LD_LIBRARY_PATH ?? "" };
const urlFor = (db: string) => {
  const u = new URL(h.url);
  u.pathname = `/${db}`;
  return u.toString();
};
async function last(db = h.db): Promise<string> {
  return (await db("knex_migrations").orderBy("id", "desc").first()).name;
}
async function snapshot(db: typeof h.db) {
  const out: Record<string, unknown> = {};
  for (const [t, o] of [
    ["battles", ["id"]],
    ["participants", ["battle_id", "bot_id"]],
    ["rating_events", ["id"]],
    ["ratings", ["bot_id", "season_id", "mode"]],
    ["tournaments", ["id"]],
    ["matches", ["id"]],
  ] as const)
    out[t] = JSON.parse(
      JSON.stringify(
        await db(t)
          .orderBy(o as unknown as string[])
          .select(),
      ),
    );
  return out;
}
const strip = (rows: unknown, col: string) => (rows as Record<string, unknown>[]).map(({ [col]: _d, ...rest }) => rest);
function dump(db: string, file: string) {
  execFileSync(bin("pg_dump"), ["-Fc", "-f", file, "-d", urlFor(db)], { env, stdio: "pipe" });
}
function restore(file: string, db: string) {
  execFileSync(bin("pg_restore"), ["--no-owner", "--exit-on-error", "-d", urlFor(db), file], { env, stdio: "pipe" });
}

beforeAll(async () => {
  if (!PG_BIN) return;
  h = await startTestDb();
  await seedDev(h.db);
  dir = mkdtempSync(join(tmpdir(), "r229-dump-"));
}, 120_000);

afterAll(async () => {
  if (!PG_BIN) return;
  await h.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!PG_BIN)("[R2 #229] migración 018 con pg_dump/pg_restore reales", () => {
  it("M1 · es la última, aditiva, nullable, sin DEFAULT y sin reescribir battles", async () => {
    expect(MIGRATIONS.at(-1)!.name).toBe(REVERTED);
    expect(await last()).toBe(REVERTED);
    const col = await h.db.raw(
      `SELECT is_nullable, column_default, data_type FROM information_schema.columns WHERE table_name='battles' AND column_name='reverted_at'`,
    );
    expect(col.rows).toEqual([{ is_nullable: "YES", column_default: null, data_type: "timestamp with time zone" }]);
    await rollbackLast(h.db);
    expect(await last()).not.toBe(REVERTED);
    const node = async () =>
      (await h.db.raw(`SELECT relfilenode FROM pg_class WHERE relname='battles'`)).rows[0].relfilenode;
    const before = await node();
    await migrateToLatest(h.db);
    expect(await node()).toBe(before); // sin reescritura de la tabla
  });

  it("M2 · backup -Fc en 016 con datos → upgrade → rollback → restore en BD nueva → upgrade", async () => {
    await rollbackLast(h.db);
    const prev = await last();
    expect(prev).toBe("016_battle_rules");
    const admin = await h.db("users").where({ email: DEV_USERS.admin }).first();
    const [a, b] = await createBots(h.db, 2, "r2m");
    const [t] = await h
      .db("tournaments")
      .insert({
        name: "r2m",
        format: "league",
        mode: "deathmatch",
        ruleset_id: DEFAULT_RULESET_ID,
        state: "finished",
        created_by: admin.id,
        season_id: "R2M",
      })
      .returning("*");
    const [m] = await h.db("matches").insert({ tournament_id: t.id, round: 1, state: "finished" }).returning("*");
    const bid = randomUUID();
    await h.db("battles").insert({
      id: bid,
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
      { battle_id: bid, bot_id: a.botId, version: 1, team: "A", outcome: "win" },
      { battle_id: bid, bot_id: b.botId, version: 1, team: "B", outcome: "loss" },
    ]);
    const base = await snapshot(h.db);
    const f016 = join(dir, "pre-018.dump");
    dump("arena_test", f016);

    await migrateToLatest(h.db);
    const up = await snapshot(h.db);
    expect(strip(up.battles, "reverted_at")).toEqual(base.battles);
    expect((up.battles as { reverted_at: unknown }[]).every((x) => x.reverted_at === null)).toBe(true);
    await rollbackLast(h.db);
    expect(await snapshot(h.db)).toEqual(base);

    await h.db.raw(`CREATE DATABASE r229_a`);
    restore(f016, "r229_a");
    const a2 = createDb(urlFor("r229_a"));
    try {
      expect(await last(a2)).toBe(prev);
      expect(await snapshot(a2)).toEqual(base);
      await migrateToLatest(a2);
      expect(await last(a2)).toBe(REVERTED);
      expect(strip((await snapshot(a2)).battles, "reverted_at")).toEqual(base.battles);
    } finally {
      await a2.destroy();
    }
    await migrateToLatest(h.db);
  });

  it("M3 · backup -Fc en 018 con una batalla revertida → restore en BD nueva: marca idéntica, latest no-op", async () => {
    const bid = (await h.db("battles").where({ status: "finished" }).first("id")).id as string;
    await h.db("battles").where({ id: bid }).update({ reverted_at: h.db.fn.now() });
    const src = await snapshot(h.db);
    const f018 = join(dir, "at-018.dump");
    dump("arena_test", f018);
    await h.db.raw(`CREATE DATABASE r229_b`);
    restore(f018, "r229_b");
    const b2 = createDb(urlFor("r229_b"));
    try {
      expect(await last(b2)).toBe(REVERTED);
      expect(await snapshot(b2)).toEqual(src);
      const nMig = (await b2("knex_migrations").count("* as n"))[0].n;
      await migrateToLatest(b2);
      expect((await b2("knex_migrations").count("* as n"))[0].n).toBe(nMig);
      expect((await b2("battles").where({ id: bid }).first("reverted_at")).reverted_at).not.toBeNull();
    } finally {
      await b2.destroy();
    }
  });
});
