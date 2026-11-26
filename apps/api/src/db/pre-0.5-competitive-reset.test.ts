/**
 * PRE_0_5_COMPETITIVE_RESET · scripts/ops/pre-0.5-competitive-reset.ts contra PostgreSQL REAL.
 *
 * Fixture con filas en TODAS las tablas del esquema 022 (unión main + OLA 2 + #289/#290/#292):
 *  1. el dry-run no cambia nada (hash de TODA la BD calculado aquí, no por el script);
 *  2. guardas: batalla running, job activo, torneo running, emisión activa, achievements con
 *     filas, tabla sin clasificar, esquema inesperado, tipo de job desconocido, sin confirmación;
 *  3. MUTANTES del plan (olvidar una tabla derivada, borrar versiones, descongelar, tocar
 *     credenciales, retirar bots…): todos acaban en VERIFY_FAILED con ROLLBACK (BD intacta);
 *  4. --apply deja RESET a 0 y PRESERVE intacto (hash independiente), versiones frozen frozen;
 *  5. una segunda ejecución se rechaza (exit 3) sin tocar nada;
 *  6. archivos de replay: sólo por id del manifiesto aplicado, nunca enlaces ni ficheros ajenos.
 *
 * Mientras #290 no esté en main, MIGRATIONS acaba en 021: el test aplica aquí la DDL de
 * 022_entries_team copiada literalmente de #290 (y su fila en knex_migrations). Cuando la 022
 * esté en MIGRATIONS, se usa la real y este parche no se ejecuta.
 */
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { createDb, type Db } from "./connection.js";
import { MIGRATIONS, migrateToLatest } from "./migrations.js";
import {
  AUDIT_ACTION,
  AUDIT_TARGET,
  EXPECTED_MIGRATIONS,
  MANIFEST_FORMAT,
  RESET_NAME,
  INVENTORY,
  RESET_STEPS,
  main,
  replayFiles,
  runReset,
  type ResetReport,
} from "../../../../scripts/ops/pre-0.5-competitive-reset.js";

let h: TestDbHandle;
let work: string;
let replaysDir: string;

const id = () => randomUUID();
const U1 = id();
const U2 = id();
const TEAM = id();
const B1 = id();
const B2 = id();
const B3 = id();
const T1 = id();
const T2 = id();
const T3 = id();
const M1 = id();
const BA1 = id();
const BA2 = id();
const BA3 = id();
const BA4 = id();

const RESET_TABLES = Object.entries(INVENTORY)
  .filter(([, s]) => s.klass === "RESET")
  .map(([t]) => t);
const PRESERVE_TABLES = Object.entries(INVENTORY)
  .filter(([, s]) => s.klass === "PRESERVE")
  .map(([t]) => t);

async function ensure022(db: Db): Promise<void> {
  if (MIGRATIONS.some((m) => m.name === "022_entries_team")) return;
  // DDL literal de 022_entries_team (#290, feat/tournament-team-enrollment).
  await db.raw(`
    ALTER TABLE entries ADD COLUMN team_id uuid REFERENCES teams(id);
    CREATE INDEX entries_tournament_team_idx ON entries (tournament_id, team_id) WHERE team_id IS NOT NULL;
    CREATE TABLE team_entry_consents (
      tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      bot_id        uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      team_id       uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      version       integer NOT NULL,
      owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tournament_id, bot_id),
      FOREIGN KEY (bot_id, version) REFERENCES bot_versions(bot_id, version) ON DELETE CASCADE
    );
  `);
  await db("knex_migrations").insert({ name: "022_entries_team", batch: 2, migration_time: new Date() });
}

async function seed(db: Db): Promise<void> {
  await db("users").insert([
    { id: U1, email: "u1@example.test", password_hash: "x", display_name: "U1" },
    { id: U2, email: "u2@example.test", password_hash: "x", display_name: "U2" },
  ]);
  await db("user_roles").insert([
    { user_id: U1, role: "admin" },
    { user_id: U2, role: "user" },
  ]);
  const S1 = id();
  await db("sessions").insert({
    id: S1,
    user_id: U1,
    refresh_token_hash: "h1",
    expires_at: new Date(Date.now() + 86400e3),
  });
  await db("session_refresh_tokens").insert({ session_id: S1, token_hash: "h1" });
  await db("password_resets").insert({ user_id: U2, token_hash: "p", expires_at: new Date(Date.now() + 3600e3) });
  await db("api_usage").insert({ actor_key: "ip:1", route: "login", window_start: new Date(0), count: 2 });
  await db("teams").insert({ id: TEAM, name: "Equipo", captain_id: U1 });
  await db("team_members").insert([
    { team_id: TEAM, user_id: U1, role: "captain" },
    { team_id: TEAM, user_id: U2, role: "member" },
  ]);
  await db("catalog_versions").insert({ catalog_version: "c1", module_count: 1 });
  await db("module_definitions").insert({
    catalog_version: "c1",
    module_id: "gun",
    module_version: 1,
    category: "weapon",
    definition: JSON.stringify({}),
    content_hash: "ch",
  });
  await db("rulesets").insert({ id: "r1", name: "R1", budget_credits: 1000 });
  await db("maps").insert({ id: "m1", name: "Mapa", created_by: U1 });
  await db("map_versions").insert({ map_id: "m1", version: 1, state: "published", content: JSON.stringify({}) });
  await db("bots").insert([
    { id: B1, name: "b1", owner_id: U1, team_id: TEAM },
    { id: B2, name: "b2", owner_id: U2, team_id: TEAM },
    { id: B3, name: "b3", owner_id: U1, retired_at: new Date() },
  ]);
  const L1 = id();
  for (const [lid, bot] of [
    [L1, B1],
    [id(), B2],
    [id(), B3],
  ]) {
    await db("bot_loadouts").insert({
      id: lid,
      bot_id: bot,
      revision: 1,
      catalog_version: "c1",
      chassis: "light",
      modules: JSON.stringify([]),
    });
  }
  await db("loadout_modules").insert({
    loadout_id: L1,
    slot: "s1",
    catalog_version: "c1",
    module_id: "gun",
    module_version: 1,
  });
  const ver = (bot: string, version: number, state: string) => ({
    bot_id: bot,
    version,
    state,
    runtime: "python",
    loadout_revision: 1,
    source: Buffer.from(`print(${version})`),
    source_filename: "main.py",
  });
  await db("bot_versions").insert([
    ver(B1, 1, "frozen"),
    ver(B1, 2, "draft"),
    ver(B2, 1, "frozen"),
    ver(B2, 2, "published"),
    ver(B3, 1, "validated"),
  ]);
  const BUILD = id();
  await db("builds").insert({ id: BUILD, bot_id: B1, version: 1, status: "passed", artifact_hash: "ah" });
  await db("artifacts").insert({ build_id: BUILD, hash: "ah", storage_ref: "db", bytes: Buffer.from("artefacto") });
  await db("security_findings").insert({
    kind: "protocol_abuse",
    bot_id: B1,
    version: 1,
    severity: "low",
    detail: "d",
  });

  await db("tournaments").insert([
    {
      id: T1,
      name: "T1",
      format: "teams",
      mode: "team_deathmatch",
      ruleset_id: "r1",
      state: "finished",
      created_by: U1,
    },
    { id: T2, name: "T2", format: "league", mode: "deathmatch", ruleset_id: "r1", state: "open", created_by: U1 },
    { id: T3, name: "T3", format: "league", mode: "deathmatch", ruleset_id: "r1", state: "cancelled", created_by: U2 },
  ]);
  await db("tournaments").where({ id: T1 }).update({ champion_bot_id: B1 });
  await db("entries").insert([
    { tournament_id: T1, bot_id: B1, version: 1, loadout_revision: 1, frozen: true, team_id: TEAM },
    { tournament_id: T1, bot_id: B2, version: 1, loadout_revision: 1, frozen: true, team_id: TEAM },
    { tournament_id: T2, bot_id: B1, version: 1, loadout_revision: 1, frozen: true },
  ]);
  await db("team_entry_consents").insert({ tournament_id: T1, bot_id: B2, team_id: TEAM, version: 1, owner_id: U2 });
  await db("matches").insert({ id: M1, tournament_id: T1, state: "finished", slot: "F", winner_bot_id: B1 });
  const battle = (bid: string, extra: Record<string, unknown>) => ({
    id: bid,
    mode: "deathmatch",
    ruleset_id: "r1",
    map_id: "m1",
    map_version: 1,
    ...extra,
  });
  await db("battles").insert([
    battle(BA1, {
      tournament_id: T1,
      match_id: M1,
      status: "finished",
      official: true,
      replay_ref: join(replaysDir, `${BA1}.replay`),
      replay_hash: "rh",
    }),
    battle(BA2, { status: "finished", replay_ref: join(replaysDir, `${BA2}.replay`) }),
    battle(BA3, { status: "scheduled" }),
    battle(BA4, { status: "failed", failure_kind: "infrastructure" }),
  ]);
  await db("participants").insert([
    { battle_id: BA1, bot_id: B1, version: 1, team: "A", outcome: "win", cpu_ms: 10 },
    { battle_id: BA1, bot_id: B2, version: 1, team: "B", outcome: "loss" },
    { battle_id: BA2, bot_id: B1, version: 1, team: "A", outcome: "draw" },
    { battle_id: BA2, bot_id: B3, version: 1, team: "B", outcome: "draw" },
  ]);
  await db("battle_stats").insert({ battle_id: BA1, bot_id: B1, stats: JSON.stringify({ kills: 1 }) });
  await db("rating_events").insert({
    battle_id: BA1,
    bot_id: B1,
    bot_version: 1,
    season_id: "season-1",
    mode: "deathmatch",
    k: 24,
    rating_before: 1500,
    delta: 12,
    rating_after: 1512,
  });
  await db("ratings").insert({ bot_id: B1, season_id: "season-1", mode: "deathmatch", rating: 1512, wins: 1 });
  await db("standings").insert({ season_id: "season-1", mode: "deathmatch", bot_id: B1, rank: 1, rating: 1512 });
  await db("jobs").insert([
    { kind: "run_battle", status: "done", payload: JSON.stringify({ battleId: BA1 }), dedupe_key: `run_battle:${BA1}` },
    { kind: "update_standings", status: "done", payload: JSON.stringify({ battleId: BA1 }) },
    { kind: "generate_schedule", status: "failed", payload: JSON.stringify({ tournamentId: T1 }) },
    { kind: "process_result", status: "needs_review", payload: JSON.stringify({ battleId: BA4 }) },
    { kind: "tournament_dry_run", status: "done", payload: JSON.stringify({ tournamentId: T2 }) },
    { kind: "bot_build", status: "done", payload: JSON.stringify({ botId: B1, version: 1 }) },
    { kind: "bot_build", status: "needs_review", payload: JSON.stringify({ botId: B3, version: 1 }) },
  ]);
  await db("audit_log").insert([
    { actor_id: U1, action: "battle.create", target: `battle:${BA1}` },
    { actor_id: U1, action: "tournament.create", target: `tournament:${T1}` },
    { actor_id: U1, action: "bot.publish", target: `bot:${B1}` },
  ]);
  await db("streaming_credentials").insert({
    platform: "youtube",
    sealed: JSON.stringify({ v: 1, ct: "sobre" }),
    key_id: "0123456789abcdef",
    last4: "ABCD",
    sealed_backup: JSON.stringify({ v: 1, ct: "sobre2" }),
  });
  await db("streaming_ingests").insert({ platform: "youtube", primary_ingest_url: "rtmps://a.example.test/live2" });
  await db("streaming_settings").where({ id: 1 }).update({ enabled: true, version: 3 });
  await db("app_runtime_settings").insert({ id: 1, public_spectate_enabled: true, public_replays_enabled: true });
  await db("streaming_sessions").insert([
    {
      state: "stopped",
      mode: "record",
      target_kind: "battle",
      target_id: BA1,
      config: JSON.stringify({}),
      stopped_at: new Date(),
    },
    {
      state: "failed",
      mode: "rtmps",
      target_kind: "tournament",
      target_id: T1,
      config: JSON.stringify({}),
      stopped_at: new Date(),
    },
    { state: "stopped", mode: "record", config: JSON.stringify({ director: true }), stopped_at: new Date() },
  ]);
}

/** Hash de TODA la BD calculado por el test (independiente del script): tabla → "n:md5". */
async function dbHash(): Promise<Record<string, string>> {
  const tables = (
    await h.db.raw(`SELECT relname AS t FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`)
  ).rows.map((r: { t: string }) => r.t);
  const out: Record<string, string> = {};
  for (const t of tables.sort()) {
    const [r] = (
      await h.db.raw(
        `SELECT count(*)::int AS n, md5(coalesce(string_agg(md5(x::text), ',' ORDER BY md5(x::text)), '')) AS m FROM "${t}" x`,
      )
    ).rows;
    out[t] = `${r.n}:${r.m}`;
  }
  return out;
}

/** BD NUEVA en el mismo servidor, migrada y sembrada igual: para escenarios que aplican el reset. */
async function freshDb(): Promise<{ db: Db; url: string; drop: () => Promise<void> }> {
  const name = `reset_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await h.db.raw(`CREATE DATABASE "${name}"`);
  const u = new URL(h.url);
  u.pathname = `/${name}`;
  const db = createDb(u.toString());
  await migrateToLatest(db);
  await ensure022(db);
  await seed(db);
  return {
    db,
    url: u.toString(),
    drop: async () => {
      await db.destroy();
      await h.db.raw(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    },
  };
}

async function marks(db: Db): Promise<number> {
  return (await db.raw(`SELECT count(*)::int AS n FROM audit_log WHERE action = ?`, [AUDIT_ACTION])).rows[0].n;
}

/** Ejecuta main() capturando stdout (para comprobar que SIEMPRE se imprime RESULT). */
async function runMain(url: string, argv: string[], env: Record<string, string>, hooks?: Parameters<typeof main>[1]) {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    lines.push(String(chunk));
    return true;
  });
  const prev = { DATABASE_URL: process.env.DATABASE_URL, S9_RESET_CONFIRM: process.env.S9_RESET_CONFIRM };
  process.env.DATABASE_URL = url;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    const code = await main(argv, hooks);
    return { code, out: lines.join("") };
  } finally {
    spy.mockRestore();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function fingerprint(): Promise<string> {
  const r = await runReset(h.db, { mode: "dry-run" });
  expect(r.status).toBe("DRY_RUN_OK");
  return r.fingerprint!;
}

beforeAll(async () => {
  h = await startTestDb();
  work = mkdtempSync(join(tmpdir(), "s9-reset-"));
  replaysDir = join(work, "replays");
  mkdirSync(replaysDir);
  await ensure022(h.db);
  await seed(h.db);
}, 180_000);
afterAll(async () => {
  await h?.stop();
});

describe("pre-0.5 competitive reset · inventario", () => {
  it("el inventario cubre exactamente las tablas del esquema 022 y el plan sólo toca RESET/PARTIAL", async () => {
    const tables = (
      await h.db.raw(`SELECT relname AS t FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`)
    ).rows
      .map((r: { t: string }) => r.t)
      .sort();
    expect(Object.keys(INVENTORY).sort()).toEqual(tables);
    expect(EXPECTED_MIGRATIONS).toEqual((await h.db("knex_migrations").orderBy("id")).map((r) => r.name));
    for (const step of RESET_STEPS) expect(["RESET", "PARTIAL"]).toContain(INVENTORY[step.table].klass);
    // Las tablas derivadas del historial competitivo están TODAS en RESET.
    for (const t of ["battles", "participants", "battle_stats", "rating_events", "ratings", "standings", "matches"]) {
      expect(INVENTORY[t].klass).toBe("RESET");
    }
    for (const t of ["users", "bots", "bot_versions", "bot_loadouts", "teams", "team_members", "maps", "audit_log"]) {
      expect(INVENTORY[t].klass).toBe("PRESERVE");
    }
  });

  it("la fixture tiene filas en todas las tablas salvo achievements (REVIEW)", async () => {
    for (const t of Object.keys(INVENTORY)) {
      const [{ n }] = (await h.db.raw(`SELECT count(*)::int AS n FROM "${t}"`)).rows;
      if (t === "achievements") expect(n).toBe(0);
      else expect(n, t).toBeGreaterThan(0);
    }
  });
});

describe("pre-0.5 competitive reset · dry-run y guardas", () => {
  it("el dry-run informa antes/después y no cambia NADA", async () => {
    const before = await dbHash();
    const r = await runReset(h.db, { mode: "dry-run" });
    expect(r.status).toBe("DRY_RUN_OK");
    expect(r.exitCode).toBe(0);
    expect(r.fingerprint).toMatch(/^s9fp-[0-9a-f]{32}$/);
    for (const t of RESET_TABLES) {
      expect(r.after![t].count, t).toBe(0);
      expect(r.before![t].count, t).toBeGreaterThan(0);
    }
    expect(r.after!.jobs.count).toBe(2);
    expect(r.after!.streaming_sessions.count).toBe(1);
    expect(r.frozenVersions).toEqual({ before: 2, after: 2 });
    expect(r.replayManifest!.battles).toBe(4);
    expect(r.historical!["audit_log.target battle:<id> sin batalla"]).toBe(1);
    // P2-1 · lista de torneos que se borran, con entries y batallas.
    const listed = [...r.tournaments!].sort((a, b) => a.name.localeCompare(b.name));
    expect(listed.map((t) => [t.name, t.state, t.entries, t.battles, t.terminal, t.stuck])).toEqual([
      ["T1", "finished", 2, 1, true, false],
      ["T2", "open", 1, 0, false, false],
      ["T3", "cancelled", 0, 0, true, false],
    ]);
    expect(await dbHash()).toEqual(before);
  });

  it("P2-3 · el dry-run no consume identidad de audit_log ni escribe el manifiesto sin opción explícita", async () => {
    const before = await dbHash();
    const seqBefore = (await h.db.raw(`SELECT last_value, is_called FROM audit_log_id_seq`)).rows[0];
    const p = join(work, "dry-sin-opcion.json");
    const r = await runReset(h.db, { mode: "dry-run", manifestPath: p });
    expect(r.status).toBe("DRY_RUN_OK");
    expect(r.replayManifest!.path).toBeNull();
    expect(existsSync(p)).toBe(false);
    expect((await h.db.raw(`SELECT last_value, is_called FROM audit_log_id_seq`)).rows[0]).toEqual(seqBefore);
    expect(await dbHash()).toEqual(before);
    // Con la opción explícita sí lo escribe, marcado como de dry-run (replay-files lo rechaza).
    const p2 = join(work, "dry-con-opcion.json");
    const r2 = await runReset(h.db, { mode: "dry-run", manifestPath: p2, writeDryRunManifest: true });
    expect(r2.replayManifest!.path).toBe(p2);
    expect(JSON.parse(readFileSync(p2, "utf8")).dryRun).toBe(true);
  });

  it("P2-1 · un torneo `running` SIN nada vivo (atascado) no aborta: se lista como atascado y se borra", async () => {
    await h.db.raw(`UPDATE tournaments SET state = 'running' WHERE id = '${T2}'`);
    await h.db.raw(`UPDATE matches SET state = 'running' WHERE id = '${M1}'`);
    try {
      const before = await dbHash();
      const logs: string[] = [];
      const r = await runReset(h.db, { mode: "dry-run", log: (l) => logs.push(l) });
      expect(r.status, r.guardFailures.join()).toBe("DRY_RUN_OK");
      const t2 = r.tournaments!.find((t) => t.id === T2)!;
      expect(t2).toMatchObject({ state: "running", stuck: true, terminal: false, liveBattles: 0, activeJobs: 0 });
      expect(logs.join("\n")).toMatch(new RegExp(`TORNEO ${T2} «T2» estado=running entries=1 batallas=0 .*ATASCADO`));
      expect(r.deleted!.tournaments).toBe(3);
      expect(r.after!.matches.count).toBe(0);
      expect(await dbHash()).toEqual(before);
    } finally {
      await h.db.raw(`UPDATE matches SET state = 'finished' WHERE id = '${M1}'`);
      await h.db.raw(`UPDATE tournaments SET state = 'open' WHERE id = '${T2}'`);
    }
  });

  it("M7 · durante el reset las tablas a borrar están bloqueadas (EXCLUSIVE) para otras conexiones", async () => {
    const seen: { locks: string[]; insertError: string | null } = { locks: [], insertError: null };
    const r = await runReset(h.db, {
      mode: "dry-run",
      testHooks: {
        afterLock: async () => {
          // Otra conexión del pool ve los bloqueos de la transacción del reset…
          seen.locks = (
            await h.db.raw(
              `SELECT c.relname AS t FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
                WHERE l.mode = 'ExclusiveLock' AND l.granted AND l.pid <> pg_backend_pid() ORDER BY 1`,
            )
          ).rows.map((x: { t: string }) => x.t);
          // …y una escritura en una tabla bloqueada tiene que esperar (aquí, agotar su lock_timeout).
          try {
            await h.db.transaction(async (t) => {
              await t.raw(`SET LOCAL lock_timeout = '300ms'`);
              await t.raw(`INSERT INTO jobs (kind, status) VALUES ('bot_build', 'done')`);
            });
          } catch (err) {
            seen.insertError = (err as Error).message;
          }
        },
      },
    });
    expect(r.status).toBe("DRY_RUN_OK");
    for (const t of ["battles", "tournaments", "entries", "jobs", "streaming_sessions", "ratings", "standings"]) {
      expect(seen.locks, t).toContain(t);
    }
    expect(seen.insertError).toMatch(/lock timeout/i);
    expect(await h.db("jobs").where({ kind: "bot_build" }).count({ n: "*" })).toEqual([{ n: "2" }]);
  });

  it("--apply sin confirmación, o con una huella equivocada, se rechaza sin tocar nada", async () => {
    const before = await dbHash();
    const manifestPath = join(work, "nunca.json");
    for (const confirm of [undefined, "", "s9fp-00000000000000000000000000000000"]) {
      const r = await runReset(h.db, { mode: "apply", confirm, manifestPath });
      expect(r.status).toBe("CONFIRM_MISSING");
      expect(r.exitCode).toBe(2);
    }
    const r = await runReset(h.db, { mode: "apply", confirm: await fingerprint(), manifestPath: null });
    expect(r.status).toBe("GUARD_FAILED");
    expect(existsSync(manifestPath)).toBe(false);
    expect(await dbHash()).toEqual(before);
  });

  const guardCases: { name: string; on: string; off: string; expect: RegExp }[] = [
    {
      name: "batalla running",
      on: `UPDATE battles SET status = 'running' WHERE id = '${BA3}'`,
      off: `UPDATE battles SET status = 'scheduled' WHERE id = '${BA3}'`,
      expect: /batalla\(s\) en 'running'/,
    },
    {
      name: "job activo",
      on: `UPDATE jobs SET status = 'queued' WHERE kind = 'update_standings'`,
      off: `UPDATE jobs SET status = 'done' WHERE kind = 'update_standings'`,
      expect: /job\(s\) activos/,
    },
    {
      name: "torneo running con una batalla en curso",
      on: `UPDATE tournaments SET state = 'running' WHERE id = '${T2}'; UPDATE battles SET tournament_id = '${T2}', status = 'running' WHERE id = '${BA3}'`,
      off: `UPDATE battles SET tournament_id = NULL, status = 'scheduled' WHERE id = '${BA3}'; UPDATE tournaments SET state = 'open' WHERE id = '${T2}'`,
      expect: /torneo «T2».*1 batalla\(s\) running/,
    },
    {
      name: "torneo con un job activo",
      on: `UPDATE jobs SET status = 'queued' WHERE kind = 'tournament_dry_run'`,
      off: `UPDATE jobs SET status = 'done' WHERE kind = 'tournament_dry_run'`,
      expect: /torneo «T2».*1 job\(s\) activos/,
    },
    {
      name: "partida running con su batalla en curso",
      on: `UPDATE matches SET state = 'running' WHERE id = '${M1}'; UPDATE battles SET status = 'running' WHERE id = '${BA1}'`,
      off: `UPDATE battles SET status = 'finished' WHERE id = '${BA1}'; UPDATE matches SET state = 'finished' WHERE id = '${M1}'`,
      expect: /batalla\(s\) en 'running'[\s\S]*torneo «T1»/,
    },
    {
      name: "emisión activa",
      on: `UPDATE streaming_sessions SET state = 'active', stopped_at = NULL WHERE target_kind IS NULL`,
      off: `UPDATE streaming_sessions SET state = 'stopped', stopped_at = now() WHERE target_kind IS NULL`,
      expect: /emisión\(es\) activa/,
    },
    {
      name: "achievements con filas",
      on: `INSERT INTO achievements (user_id, kind) VALUES ('${U1}', 'first_win')`,
      off: `DELETE FROM achievements`,
      expect: /achievements tiene 1/,
    },
    {
      name: "tabla sin clasificar",
      on: `CREATE TABLE battle_cache (battle_id uuid REFERENCES battles(id) ON DELETE CASCADE)`,
      off: `DROP TABLE battle_cache`,
      expect: /SIN clasificar.*battle_cache/,
    },
    {
      name: "FK desde tabla conservada hacia una RESET",
      on: `ALTER TABLE security_findings ADD COLUMN battle_id uuid REFERENCES battles(id) ON DELETE CASCADE`,
      off: `ALTER TABLE security_findings DROP COLUMN battle_id`,
      expect: /security_findings.*→ battles/,
    },
    {
      name: "tipo de job desconocido",
      on: `INSERT INTO jobs (kind, status) VALUES ('replay_reindex', 'done')`,
      off: `DELETE FROM jobs WHERE kind = 'replay_reindex'`,
      expect: /tipo desconocido.*replay_reindex/,
    },
    {
      name: "migración extra (esquema inesperado)",
      on: `INSERT INTO knex_migrations (name, batch, migration_time) VALUES ('023_algo', 3, now())`,
      off: `DELETE FROM knex_migrations WHERE name = '023_algo'`,
      expect: /esquema inesperado.*sobran \[023_algo\]/,
    },
  ];
  for (const c of guardCases) {
    it(`guarda: ${c.name} → aborta (exit 2) sin tocar nada`, async () => {
      await h.db.raw(c.on);
      try {
        const before = await dbHash();
        for (const mode of ["dry-run", "apply"] as const) {
          const r = await runReset(h.db, { mode, confirm: "x", manifestPath: join(work, "g.json") });
          expect(r.status, mode).toBe("GUARD_FAILED");
          expect(r.exitCode).toBe(2);
          expect(r.guardFailures.join("\n")).toMatch(c.expect);
        }
        expect(await dbHash()).toEqual(before);
      } finally {
        await h.db.raw(c.off);
      }
    });
  }

  it("guarda: esquema sin 022 (producción aún en 021) → aborta", async () => {
    const r = await runReset(h.db, { mode: "dry-run", expectedMigrations: EXPECTED_MIGRATIONS.slice(0, 21) });
    expect(r.status).toBe("GUARD_FAILED");
    expect(r.guardFailures.join()).toMatch(/sobran \[022_entries_team\]/);
  });
});

describe("pre-0.5 competitive reset · mutantes del plan (deben morir con ROLLBACK)", () => {
  const without = (table: string) => RESET_STEPS.filter((s) => s.table !== table);
  const mutants: { name: string; steps?: ReturnType<typeof without>; extraSql?: string[]; expect: RegExp }[] = [
    { name: "olvida standings (derivada)", steps: without("standings"), expect: /standings: quedan 1/ },
    { name: "olvida ratings (derivada)", steps: without("ratings"), expect: /ratings: quedan 1/ },
    { name: "olvida los jobs competitivos", steps: without("jobs"), expect: /jobs: quedan 5|huérfanos lógicos jobs/ },
    {
      name: "olvida las emisiones con objetivo",
      steps: without("streaming_sessions"),
      expect: /streaming_sessions.*(quedan|huérfanos)/,
    },
    {
      name: "borra versiones draft (bot_versions)",
      extraSql: [`DELETE FROM bot_versions WHERE state = 'draft'`],
      expect: /bot_versions: .*PRESERVE/,
    },
    {
      name: "descongela versiones",
      extraSql: [`UPDATE bot_versions SET state = 'published' WHERE state = 'frozen'`],
      expect: /bot_versions: hash de filas cambió|versiones frozen 2 → 0/,
    },
    {
      name: "borra las credenciales selladas",
      extraSql: [`DELETE FROM streaming_credentials`],
      expect: /streaming_credentials/,
    },
    { name: "des-retira bots", extraSql: [`UPDATE bots SET retired_at = NULL`], expect: /bots: hash/ },
    { name: "borra loadouts no usados", extraSql: [`DELETE FROM loadout_modules`], expect: /loadout_modules/ },
    {
      name: "borra un job de build",
      extraSql: [`DELETE FROM jobs WHERE kind = 'bot_build'`],
      expect: /jobs: el subconjunto conservado/,
    },
    {
      name: "borra la emisión sin objetivo",
      extraSql: [`DELETE FROM streaming_sessions WHERE target_kind IS NULL`],
      expect: /streaming_sessions: el subconjunto conservado/,
    },
    {
      name: "añade una fila de auditoría extra",
      extraSql: [`INSERT INTO audit_log (action, target) VALUES ('x', 'y')`],
      expect: /audit_log: 2 filas nuevas/,
    },
    {
      name: "M1 · cambia los bytes de un artefacto (bytea)",
      extraSql: [`UPDATE artifacts SET bytes = convert_to('otro artefacto', 'UTF8')`],
      expect: /artifacts: hash de filas cambió/,
    },
    {
      name: "M8 · cambia la 1ª columna (alfabética) de users: created_at",
      extraSql: [`UPDATE users SET created_at = created_at - interval '1 day'`],
      expect: /users: hash de filas cambió/,
    },
    {
      name: "M8 · cambia la 1ª columna (alfabética) de teams: captain_id",
      extraSql: [`UPDATE teams SET captain_id = '${U2}'`],
      expect: /teams: hash de filas cambió/,
    },
    {
      name: "toca la configuración",
      extraSql: [`UPDATE app_runtime_settings SET public_replays_enabled = false`],
      expect: /app_runtime_settings/,
    },
  ];
  for (const m of mutants) {
    it(`mutante: ${m.name}`, async () => {
      const before = await dbHash();
      const r: ResetReport = await runReset(h.db, {
        mode: "apply",
        confirm: await fingerprint(),
        manifestPath: join(work, `mut-${randomUUID()}.json`),
        steps: m.steps,
        extraSql: m.extraSql,
      });
      expect(r.status, JSON.stringify(r.verifyFailures)).toBe("VERIFY_FAILED");
      expect(r.exitCode).toBe(1);
      expect(r.verifyFailures.join("\n")).toMatch(m.expect);
      expect(await dbHash()).toEqual(before);
    });
  }
});

describe("pre-0.5 competitive reset · apply, repetición y archivos", () => {
  let preserved: Record<string, string>;
  let manifestPath: string;
  let applied: ResetReport;

  it("--apply deja RESET a 0, PRESERVE intacto (hash del test) y frozen sigue frozen", async () => {
    const before = await dbHash();
    preserved = Object.fromEntries(PRESERVE_TABLES.filter((t) => t !== "audit_log").map((t) => [t, before[t]]));
    const frozen = await h
      .db("bot_versions")
      .where({ state: "frozen" })
      .orderBy(["bot_id", "version"])
      .select("bot_id", "version");
    manifestPath = join(work, "manifest.json");
    applied = await runReset(h.db, { mode: "apply", confirm: await fingerprint(), manifestPath });
    expect(applied.status, JSON.stringify(applied.verifyFailures.concat(applied.postCommit?.failures ?? []))).toBe(
      "APPLIED",
    );
    expect(applied.exitCode).toBe(0);
    const after = await dbHash();
    for (const t of RESET_TABLES) expect(after[t], t).toMatch(/^0:/);
    for (const [t, v] of Object.entries(preserved)) expect(after[t], t).toBe(v);
    expect(after.achievements).toMatch(/^0:/);
    expect(
      await h.db("bot_versions").where({ state: "frozen" }).orderBy(["bot_id", "version"]).select("bot_id", "version"),
    ).toEqual(frozen);
    // PARTIAL: sólo quedan los builds y la emisión sin objetivo.
    expect((await h.db("jobs").select("kind")).map((r) => r.kind)).toEqual(["bot_build", "bot_build"]);
    expect(await h.db("streaming_sessions").whereNotNull("target_kind").count({ n: "*" })).toEqual([{ n: "0" }]);
    expect(await h.db("streaming_sessions").count({ n: "*" })).toEqual([{ n: "1" }]);
    // audit_log: las 3 filas previas intactas + la marca.
    const audit = await h.db("audit_log").orderBy("id");
    expect(audit.map((a) => a.action)).toEqual(["battle.create", "tournament.create", "bot.publish", AUDIT_ACTION]);
    expect(audit[3].detail.replayManifestSha256).toBe(applied.replayManifest!.sha256);
    // 0 huérfanos en cada FK declarada y lógica.
    expect(Object.values(applied.orphans!).filter((n) => n !== 0)).toEqual([]);
    expect(Object.keys(applied.orphans!).length).toBeGreaterThan(30);
    const nv = await h.db.raw(`SELECT count(*)::int AS n FROM pg_constraint WHERE NOT convalidated`);
    expect(nv.rows[0].n).toBe(0);
    // Manifiesto: las 4 batallas, 0600.
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(m.dryRun).toBe(false);
    expect(m.battles.map((b: { id: string }) => b.id).sort()).toEqual([BA1, BA2, BA3, BA4].sort());
  });

  it("la segunda ejecución se rechaza (exit 3) y no toca nada, ni en dry-run ni en apply", async () => {
    const before = await dbHash();
    for (const mode of ["dry-run", "apply"] as const) {
      const r = await runReset(h.db, { mode, confirm: applied.fingerprint, manifestPath: join(work, "otra.json") });
      expect(r.status).toBe("ALREADY_APPLIED");
      expect(r.exitCode).toBe(3);
    }
    expect(existsSync(join(work, "otra.json"))).toBe(false);
    expect(await dbHash()).toEqual(before);
  });

  it("la API de la BD sigue usable: se puede crear un torneo nuevo e inscribir una versión frozen", async () => {
    const T = randomUUID();
    await h
      .db("tournaments")
      .insert({ id: T, name: "Nuevo 0.5", format: "league", mode: "deathmatch", ruleset_id: "r1" });
    await h.db("entries").insert({ tournament_id: T, bot_id: B1, version: 1, loadout_revision: 1, frozen: true });
    await h.db("entries").where({ tournament_id: T }).del();
    await h.db("tournaments").where({ id: T }).del();
  });

  it("archivos de replay: sólo por id del manifiesto aplicado; nada de enlaces ni ficheros ajenos", async () => {
    writeFileSync(join(replaysDir, `${BA1}.replay`), "zstd");
    writeFileSync(join(replaysDir, `${BA1}.replay.json`), "{}");
    writeFileSync(join(replaysDir, `${BA2}.replay`), "zstd");
    const ajeno = randomUUID();
    writeFileSync(join(replaysDir, `${ajeno}.replay`), "no está en el manifiesto");
    mkdirSync(join(replaysDir, "video"));
    writeFileSync(join(replaysDir, "video", "clip.mp4"), "v");
    const fuera = join(work, "fuera.txt");
    writeFileSync(fuera, "objetivo de un enlace");
    symlinkSync(fuera, join(replaysDir, `${BA3}.replay`));

    // Un manifiesto alterado no vale (el sha256 está en la marca de audit_log).
    const tampered = join(work, "tampered.json");
    writeFileSync(tampered, readFileSync(manifestPath, "utf8").replace(BA4, randomUUID()));
    const bad = await replayFiles(h.db, { manifestPath: tampered, replaysDir, apply: true });
    expect(bad.status).toBe("REFUSED");
    expect(existsSync(join(replaysDir, `${BA1}.replay`))).toBe(true);

    const listed = await replayFiles(h.db, { manifestPath, replaysDir, apply: false });
    expect(listed.status).toBe("LISTED");
    expect(listed.candidates.map((c) => c.path).sort()).toEqual(
      [`${BA1}.replay`, `${BA1}.replay.json`, `${BA2}.replay`].map((f) => join(replaysDir, f)).sort(),
    );
    expect(listed.review.join()).toMatch(new RegExp(BA3));
    expect(existsSync(join(replaysDir, `${BA1}.replay`))).toBe(true);

    const done = await replayFiles(h.db, { manifestPath, replaysDir, apply: true });
    expect(done.deleted.length).toBe(3);
    expect(existsSync(join(replaysDir, `${BA1}.replay`))).toBe(false);
    expect(existsSync(join(replaysDir, `${BA1}.replay.json`))).toBe(false);
    expect(existsSync(join(replaysDir, `${BA2}.replay`))).toBe(false);
    expect(existsSync(join(replaysDir, `${ajeno}.replay`))).toBe(true);
    expect(existsSync(join(replaysDir, "video", "clip.mp4"))).toBe(true);
    expect(existsSync(fuera)).toBe(true);
  });

  it("CLI: dry-run → 3 (ya aplicado); replay-files sin argumentos → 2", async () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = h.url;
    try {
      expect(await main([])).toBe(3);
      expect(await main(["replay-files"])).toBe(2);
      expect(await main(["--apply", "--dry-run"])).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });
});

describe("pre-0.5 competitive reset · ronda 2: fallos tras el COMMIT y replay-files", () => {
  const RESULT = (out: string) => {
    const line = out.split("\n").find((l) => l.startsWith("RESULT "));
    return line ? JSON.parse(line.slice("RESULT ".length)) : null;
  };

  it("P1-1 · --report inválido (existe o directorio inexistente) aborta con 2 ANTES de tocar nada; si falla tras el COMMIT, 4 con RESULT", async () => {
    const f = await freshDb();
    try {
      const fp = (await runReset(f.db, { mode: "dry-run" })).fingerprint!;
      const dir = mkdtempSync(join(work, "p11-"));
      const existing = join(dir, "report.json");
      writeFileSync(existing, "ya existe");
      const env = { S9_RESET_CONFIRM: fp };

      const a = await runMain(
        f.url,
        ["--apply", "--replay-manifest", join(dir, "m-a.json"), "--report", existing],
        env,
      );
      expect(a.code).toBe(2);
      expect(RESULT(a.out)).toMatchObject({ status: "GUARD_FAILED", exitCode: 2 });
      expect(a.out).toMatch(/ya existe/);
      expect(await marks(f.db)).toBe(0);

      const b = await runMain(
        f.url,
        ["--apply", "--replay-manifest", join(dir, "m-b.json"), "--report", join(dir, "no-existe", "r.json")],
        env,
      );
      expect(b.code).toBe(2);
      expect(RESULT(b.out)).toMatchObject({ status: "GUARD_FAILED", exitCode: 2 });
      expect(await marks(f.db)).toBe(0);

      // El directorio del informe desaparece entre la validación y la escritura (tras el COMMIT).
      const repDir = mkdtempSync(join(work, "p11-rep-"));
      const c = await runMain(
        f.url,
        ["--apply", "--replay-manifest", join(dir, "m-c.json"), "--report", join(repDir, "r.json")],
        env,
        { beforeReportWrite: () => rmSync(repDir, { recursive: true, force: true }) },
      );
      expect(c.code).toBe(4);
      expect(RESULT(c.out)).toMatchObject({ status: "POST_COMMIT_FAILED", exitCode: 4 });
      expect(c.out).toMatch(/ERROR escribiendo --report/);
      expect(await marks(f.db)).toBe(1); // aplicado de verdad: por eso 4 y no 1
    } finally {
      await f.drop();
    }
  });

  it("P1-1 · COMMIT que lanza tras confirmarse → COMMIT_UNKNOWN (4) con RESULT; la marca está", async () => {
    const f = await freshDb();
    try {
      const fp = (await runReset(f.db, { mode: "dry-run" })).fingerprint!;
      const dir = mkdtempSync(join(work, "p11b-"));
      const r = await runMain(
        f.url,
        ["--apply", "--replay-manifest", join(dir, "m.json")],
        { S9_RESET_CONFIRM: fp },
        {
          reset: {
            commit: async (trx) => {
              await trx.commit();
              throw new Error("conexión cortada tras enviar COMMIT");
            },
          },
        },
      );
      expect(r.code).toBe(4);
      expect(RESULT(r.out)).toMatchObject({ status: "COMMIT_UNKNOWN", exitCode: 4 });
      expect(await marks(f.db)).toBe(1);
    } finally {
      await f.drop();
    }
  });

  it("P1-1/M5 · COMMIT que lanza sin confirmarse también es 4 (estado desconocido); y un fallo de la verificación posterior es 4", async () => {
    const f = await freshDb();
    try {
      const fp = (await runReset(f.db, { mode: "dry-run" })).fingerprint!;
      const r1 = await runReset(f.db, {
        mode: "apply",
        confirm: fp,
        manifestPath: join(mkdtempSync(join(work, "m5a-")), "m.json"),
        testHooks: {
          commit: async () => {
            throw new Error("socket cerrado");
          },
        },
      });
      expect(r1).toMatchObject({ status: "COMMIT_UNKNOWN", exitCode: 4 });
      expect(await marks(f.db)).toBe(0); // en realidad no se confirmó: el 4 es conservador

      // Un worker vivo crea una batalla justo tras el COMMIT: la verificación posterior falla → 4.
      const r2 = await runReset(f.db, {
        mode: "apply",
        confirm: fp,
        manifestPath: join(mkdtempSync(join(work, "m5b-")), "m.json"),
        testHooks: {
          afterCommit: async () => {
            const mv = await f.db("map_versions").first();
            await f.db("battles").insert({
              mode: "deathmatch",
              ruleset_id: "r1",
              map_id: mv.map_id,
              map_version: mv.version,
              status: "scheduled",
            });
          },
        },
      });
      expect(r2.status).toBe("POST_COMMIT_FAILED");
      expect(r2.exitCode).toBe(4);
      expect(r2.postCommit!.failures.join()).toMatch(/battles: 1 filas tras el COMMIT/);
      expect(await marks(f.db)).toBe(1);
    } finally {
      await f.drop();
    }
  });

  it("M4 · replay-files rechaza ids que no son UUID aunque el sha256 del manifiesto coincida con la marca", async () => {
    const f = await freshDb();
    try {
      const dir = mkdtempSync(join(work, "m4-"));
      const rdir = join(dir, "replays");
      mkdirSync(rdir);
      const victim = join(dir, "victima.replay");
      writeFileSync(victim, "fuera del directorio de replays");
      const manifestPath = join(dir, "manifest.json");
      const text =
        JSON.stringify({
          format: MANIFEST_FORMAT,
          reset: RESET_NAME,
          dryRun: false,
          battles: [{ id: "../victima", replayRef: null, replayHash: null }],
        }) + "\n";
      writeFileSync(manifestPath, text);
      const sha = createHash("sha256").update(text).digest("hex");
      await f.db("audit_log").insert({
        action: AUDIT_ACTION,
        target: AUDIT_TARGET,
        detail: JSON.stringify({ replayManifestSha256: sha }),
      });
      const r = await replayFiles(f.db, { manifestPath, replaysDir: rdir, apply: true });
      expect(r.status).toBe("REFUSED");
      expect(r.refusals.join()).toMatch(/no UUID/);
      expect(r.deleted).toEqual([]);
      expect(existsSync(victim)).toBe(true);
    } finally {
      await f.drop();
    }
  });
});
