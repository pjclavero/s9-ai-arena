/**
 * PRE_0_5_COMPETITIVE_RESET · Reset de los datos COMPETITIVOS antes del motor 0.5.0.
 *
 * Los replays y el historial competitivo anteriores a 0.5.0 no son compatibles con el
 * motor nuevo. Este script borra SÓLO lo competitivo (batallas, participantes, stats,
 * rating, clasificaciones, partidas, torneos, inscripciones, autorizaciones de equipo y
 * los trabajos de cola de todo ello) y conserva el resto (usuarios, bots, código,
 * versiones con su estado —las `frozen` siguen `frozen`—, loadouts, equipos, mapas,
 * rulesets, configuración, credenciales selladas, auditoría…).
 *
 * El inventario RESET / PARTIAL / PRESERVE / REVIEW está en `INVENTORY` y se CONTRASTA con
 * el catálogo real de PostgreSQL en cada ejecución: una tabla que no esté clasificada, o una
 * FK que haga que un borrado alcance una tabla conservada, abortan antes de tocar nada.
 *
 * Uso (DATABASE_URL, o PGHOST + PGPASSWORD_FILE como el resto de servicios):
 *   npx tsx scripts/ops/pre-0.5-competitive-reset.ts [--dry-run]                  (por defecto)
 *   S9_RESET_CONFIRM=<huella> npx tsx scripts/ops/pre-0.5-competitive-reset.ts --apply \
 *       --replay-manifest /ruta/manifiesto.json [--report /ruta/informe.json]
 *   npx tsx scripts/ops/pre-0.5-competitive-reset.ts replay-files \
 *       --manifest /ruta/manifiesto.json --replays-dir /data/replays [--apply]
 *
 *  · `--dry-run` ejecuta TODO (guardas, borrados, verificación) dentro de una transacción
 *    y hace ROLLBACK: enseña los conteos antes/después reales, la huella del esquema y la LISTA
 *    de torneos que se borrarían. Sin efectos: no inserta la marca (no consume identidad de
 *    audit_log) y no escribe el manifiesto salvo con `--write-dry-run-manifest`.
 *    ATENCIÓN: igual que el apply, toma bloqueos EXCLUSIVE sobre battles, tournaments, entries,
 *    jobs, streaming_sessions… mientras dura (las escrituras de la API y de los workers esperan).
 *    En producción SÓLO se ejecuta en la ventana de mantenimiento, con tournament-worker,
 *    bot-manager y bot-build-worker PARADOS.
 *  · `--apply` exige `S9_RESET_CONFIRM` = huella del esquema que imprime el dry-run (nunca
 *    por argv) y hace COMMIT sólo si la verificación dentro de la transacción pasa.
 *  · Una sola ejecución: deja una marca en `audit_log` (sólo inserción, la propia BD impide
 *    borrarla); con la marca presente, cualquier ejecución posterior se rechaza (exit 3).
 *  · Los ARCHIVOS de replay no se borran aquí: el apply escribe un manifiesto con los ids
 *    de las batallas borradas y `replay-files` borra, por id y de uno en uno, sólo
 *    `<dir>/<id>.replay` y `<dir>/<id>.replay.json` (paso separado y revisable).
 *
 * Códigos de salida: 0 OK · 1 verificación fallida o error ANTES del COMMIT (ROLLBACK: no se
 * tocó nada) · 2 guarda fallida, falta de confirmación o rutas de salida no válidas · 3 ya
 * aplicado · 4 fallo DESPUÉS del COMMIT o COMMIT de resultado desconocido (incluida la escritura
 * del --report): STOP, comprobar la marca en audit_log y restaurar. Siempre se imprime RESULT.
 */
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Knex } from "knex";
import { createDb } from "../../apps/api/src/db/connection.js";

export const RESET_NAME = "pre-0.5.0-competitive-reset";
export const AUDIT_ACTION = "ops.competitive_reset";
export const AUDIT_TARGET = `reset:${RESET_NAME}`;
export const SCRIPT_VERSION = "1";
export const MANIFEST_FORMAT = "s9-pre05-replay-manifest/v1";

/** Esquema esperado: producción en 021 + 022_entries_team (#290). Ni una más ni una menos. */
export const EXPECTED_MIGRATIONS: readonly string[] = Object.freeze([
  "001_identity",
  "002_content",
  "003_bots",
  "004_competition",
  "005_results",
  "006_operations",
  "007_e9_queue",
  "008_e9_competition",
  "009_r24_refresh_families",
  "010_r25_shared_limits",
  "011_battle_cpu_ms",
  "012_bot_versioning",
  "013_battle_claim",
  "014_battle_diagnostics",
  "015_bot_retired",
  "016_battle_rules",
  "017_streaming_admin",
  "018_battle_reverted",
  "019_visibility_broadcast",
  "020_streaming_ingests",
  "021_runtime_settings",
  "022_entries_team",
]);

/** Trabajos de la cola competitiva (apps/tournament-worker/src/queue.ts, JobKind). */
export const COMPETITIVE_JOB_KINDS: readonly string[] = Object.freeze([
  "generate_schedule",
  "run_battle",
  "process_result",
  "update_standings",
  "tournament_dry_run",
]);
/** Trabajos NO competitivos que se conservan (compilación de bots, apps/bot-manager). */
export const PRESERVED_JOB_KINDS: readonly string[] = Object.freeze(["bot_build"]);

export type TableClass = "RESET" | "PARTIAL" | "PRESERVE" | "REVIEW_EMPTY";

export interface TableSpec {
  klass: TableClass;
  reason: string;
  /** PARTIAL: filas que se borran (SQL booleano sobre la tabla). */
  resetWhere?: string;
  /** PARTIAL / PRESERVE parcial: filas que se conservan y se hashean. */
  preserveWhere?: string;
  /** Tabla que cambia con el tráfico normal (sesiones, cuotas…): tras el COMMIT sólo avisa. */
  volatile?: boolean;
}

const jobKindsSql = (kinds: readonly string[]) => kinds.map((k) => `'${k}'`).join(", ");

/**
 * Inventario sobre la UNIÓN de esquemas de main b585f1f + OLA 2 + #292 + #289 + #290
 * (sólo #290 añade migración: 022_entries_team).
 */
export const INVENTORY: Readonly<Record<string, TableSpec>> = Object.freeze({
  // ---------------------------------------------------------------- RESET
  battles: { klass: "RESET", reason: "batallas pre-0.5 (replays incompatibles con el motor 0.5.0)" },
  participants: { klass: "RESET", reason: "participantes/resultado por bot de batallas borradas (FK CASCADE)" },
  battle_stats: { klass: "RESET", reason: "estadísticas derivadas por batalla (FK CASCADE)" },
  rating_events: { klass: "RESET", reason: "libro mayor de Elo por batalla (FK CASCADE)" },
  ratings: { klass: "RESET", reason: "Elo/victorias/derrotas/empates materializados (derivado de rating_events)" },
  standings: { klass: "RESET", reason: "clasificación materializada (derivada)" },
  matches: { klass: "RESET", reason: "partidas/cuadros de torneos anteriores" },
  tournaments: {
    klass: "RESET",
    reason:
      "torneos anteriores: todos llevan copia de reglas con engineVersion pre-0.5 (ADR-021/022); ninguno en ejecución (guarda)",
  },
  entries: { klass: "RESET", reason: "inscripciones de torneos borrados (FK CASCADE); NO descongela versiones" },
  team_entry_consents: {
    klass: "RESET",
    reason: "autorización por (torneo, bot, versión): sin su torneo no autoriza nada (FK CASCADE)",
  },
  // ---------------------------------------------------------------- PARTIAL
  jobs: {
    klass: "PARTIAL",
    reason: "cola durable: se borran los trabajos competitivos (todos sus estados); se conservan los de bot_build",
    resetWhere: `kind IN (${jobKindsSql(COMPETITIVE_JOB_KINDS)})`,
    preserveWhere: `kind NOT IN (${jobKindsSql(COMPETITIVE_JOB_KINDS)})`,
  },
  streaming_sessions: {
    klass: "PARTIAL",
    reason:
      "historial de emisiones: las que apuntan a una batalla/torneo borrado se borran (quedan en audit_log streaming.*); las sin objetivo se conservan",
    resetWhere: "target_kind IS NOT NULL",
    preserveWhere: "target_kind IS NULL",
  },
  // ---------------------------------------------------------------- REVIEW
  achievements: {
    klass: "REVIEW_EMPTY",
    reason: "logros: sin escritores en el código; si hubiera filas no se sabe si derivan del historial → abortar",
  },
  // ---------------------------------------------------------------- PRESERVE
  users: { klass: "PRESERVE", reason: "usuarios" },
  roles: { klass: "PRESERVE", reason: "catálogo de roles" },
  user_roles: { klass: "PRESERVE", reason: "roles de usuario" },
  sessions: { klass: "PRESERVE", reason: "sesiones de login", volatile: true },
  session_refresh_tokens: { klass: "PRESERVE", reason: "familias de refresh", volatile: true },
  password_resets: { klass: "PRESERVE", reason: "restablecimientos pendientes", volatile: true },
  teams: { klass: "PRESERVE", reason: "equipos" },
  team_members: { klass: "PRESERVE", reason: "membresías" },
  catalog_versions: { klass: "PRESERVE", reason: "catálogo de módulos" },
  module_definitions: { klass: "PRESERVE", reason: "catálogo de módulos" },
  rulesets: { klass: "PRESERVE", reason: "rulesets" },
  maps: { klass: "PRESERVE", reason: "mapas" },
  map_versions: { klass: "PRESERVE", reason: "versiones de mapa" },
  bots: { klass: "PRESERVE", reason: "bots (incl. retired_at)" },
  bot_loadouts: { klass: "PRESERVE", reason: "loadouts" },
  loadout_modules: { klass: "PRESERVE", reason: "módulos de loadout" },
  bot_versions: { klass: "PRESERVE", reason: "versiones y código; el estado (frozen incluido) NO cambia" },
  builds: { klass: "PRESERVE", reason: "builds de versiones" },
  artifacts: { klass: "PRESERVE", reason: "artefactos firmados" },
  audit_log: {
    klass: "PRESERVE",
    reason: "auditoría sólo-inserción (trigger audit_log_append_only): se conserva entera; gana 1 fila, la marca",
  },
  security_findings: { klass: "PRESERVE", reason: "hallazgos de seguridad (auditoría)" },
  api_usage: { klass: "PRESERVE", reason: "cuotas y bloqueos de login", volatile: true },
  streaming_settings: { klass: "PRESERVE", reason: "configuración de streaming" },
  streaming_credentials: { klass: "PRESERVE", reason: "sobres sellados de la clave de emisión" },
  streaming_ingests: { klass: "PRESERVE", reason: "ingestas configuradas" },
  app_runtime_settings: { klass: "PRESERVE", reason: "ajustes de runtime" },
  knex_migrations: { klass: "PRESERVE", reason: "historial de migraciones" },
  knex_migrations_lock: { klass: "PRESERVE", reason: "candado de migraciones" },
});

export interface Step {
  table: string;
  sql: string;
}

/** Orden por FK: hijos antes que padres. Sin TRUNCATE ni CASCADE implícito hacia tablas conservadas. */
export const RESET_STEPS: readonly Step[] = Object.freeze([
  { table: "jobs", sql: `DELETE FROM jobs WHERE ${INVENTORY.jobs.resetWhere}` },
  {
    table: "streaming_sessions",
    sql: `DELETE FROM streaming_sessions WHERE ${INVENTORY.streaming_sessions.resetWhere}`,
  },
  { table: "rating_events", sql: "DELETE FROM rating_events" },
  { table: "battle_stats", sql: "DELETE FROM battle_stats" },
  { table: "participants", sql: "DELETE FROM participants" },
  { table: "battles", sql: "DELETE FROM battles" },
  { table: "matches", sql: "DELETE FROM matches" },
  { table: "team_entry_consents", sql: "DELETE FROM team_entry_consents" },
  { table: "entries", sql: "DELETE FROM entries" },
  { table: "tournaments", sql: "DELETE FROM tournaments" },
  { table: "ratings", sql: "DELETE FROM ratings" },
  { table: "standings", sql: "DELETE FROM standings" },
]);

/** FK lógicas (NO declaradas) que se comprueban explícitamente. `mustBeZero`: tras el reset no puede quedar ninguna. */
export const LOGICAL_REFERENCES: readonly { name: string; sql: string; mustBeZero: boolean }[] = Object.freeze([
  {
    name: "streaming_sessions.target_id(battle) → battles",
    sql: `SELECT count(*)::int AS n FROM streaming_sessions s WHERE s.target_kind = 'battle' AND NOT EXISTS (SELECT 1 FROM battles b WHERE b.id = s.target_id)`,
    mustBeZero: true,
  },
  {
    name: "streaming_sessions.target_id(tournament) → tournaments",
    sql: `SELECT count(*)::int AS n FROM streaming_sessions s WHERE s.target_kind = 'tournament' AND NOT EXISTS (SELECT 1 FROM tournaments t WHERE t.id = s.target_id)`,
    mustBeZero: true,
  },
  {
    name: "jobs.payload.battleId → battles",
    sql: `SELECT count(*)::int AS n FROM jobs j WHERE j.payload->>'battleId' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM battles b WHERE b.id::text = j.payload->>'battleId')`,
    mustBeZero: true,
  },
  {
    name: "jobs.payload.tournamentId → tournaments",
    sql: `SELECT count(*)::int AS n FROM jobs j WHERE j.payload->>'tournamentId' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tournaments t WHERE t.id::text = j.payload->>'tournamentId')`,
    mustBeZero: true,
  },
  {
    name: "jobs.payload.matchId → matches",
    sql: `SELECT count(*)::int AS n FROM jobs j WHERE j.payload->>'matchId' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.id::text = j.payload->>'matchId')`,
    mustBeZero: true,
  },
  {
    name: "jobs competitivos restantes",
    sql: `SELECT count(*)::int AS n FROM jobs WHERE ${INVENTORY.jobs.resetWhere}`,
    mustBeZero: true,
  },
  {
    name: "battles.replay_ref restantes",
    sql: `SELECT count(*)::int AS n FROM battles WHERE replay_ref IS NOT NULL`,
    mustBeZero: true,
  },
  {
    name: "builds(bot_id,version) → bot_versions",
    sql: `SELECT count(*)::int AS n FROM builds x WHERE NOT EXISTS (SELECT 1 FROM bot_versions v WHERE v.bot_id = x.bot_id AND v.version = x.version)`,
    mustBeZero: true,
  },
  // Conservadas: lo que hubiera antes no lo crea el reset, pero no puede aumentar.
  {
    name: "security_findings(bot_id,version) → bot_versions (histórico, no debe aumentar)",
    sql: `SELECT count(*)::int AS n FROM security_findings f WHERE f.bot_id IS NOT NULL AND f.version IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bot_versions v WHERE v.bot_id = f.bot_id AND v.version = f.version)`,
    mustBeZero: false,
  },
]);

/** Referencias HISTÓRICAS que se conservan a propósito (audit_log es sólo inserción): se informan, no fallan. */
export const HISTORICAL_REFERENCES: readonly { name: string; sql: string }[] = Object.freeze([
  {
    name: "audit_log.target battle:<id> sin batalla",
    sql: `SELECT count(*)::int AS n FROM audit_log a WHERE a.target LIKE 'battle:%' AND NOT EXISTS (SELECT 1 FROM battles b WHERE 'battle:' || b.id::text = a.target)`,
  },
  {
    name: "audit_log.target tournament:<id> sin torneo",
    sql: `SELECT count(*)::int AS n FROM audit_log a WHERE a.target LIKE 'tournament:%' AND NOT EXISTS (SELECT 1 FROM tournaments t WHERE 'tournament:' || t.id::text = a.target)`,
  },
]);

// =============================================================================================

export interface TableState {
  count: number;
  hash?: string;
  /** PARTIAL: filas del subconjunto que se borra. */
  resetCount?: number;
}
export type DbState = Record<string, TableState>;

export interface ResetReport {
  mode: "dry-run" | "apply";
  status:
    | "DRY_RUN_OK"
    | "APPLIED"
    | "GUARD_FAILED"
    | "CONFIRM_MISSING"
    | "ALREADY_APPLIED"
    | "VERIFY_FAILED"
    | "POST_COMMIT_FAILED"
    | "COMMIT_UNKNOWN"
    | "ERROR";
  exitCode: number;
  fingerprint?: string;
  guardFailures: string[];
  verifyFailures: string[];
  warnings: string[];
  before?: DbState;
  after?: DbState;
  deleted?: Record<string, number>;
  orphans?: Record<string, number>;
  historical?: Record<string, number>;
  frozenVersions?: { before: number; after: number };
  /** Torneos que se borran (P2-1): se listan SIEMPRE antes de borrar, también en dry-run. */
  tournaments?: TournamentListing[];
  replayManifest?: { path: string | null; sha256: string; battles: number; withReplayRef: number };
  postCommit?: { failures: string[]; changedVolatile: string[] };
  error?: string;
}

export interface ResetOptions {
  mode: "dry-run" | "apply";
  /** Valor de S9_RESET_CONFIRM (sólo apply). */
  confirm?: string;
  /** Ruta del manifiesto de replays (obligatoria en apply; en dry-run sólo con writeDryRunManifest). */
  manifestPath?: string | null;
  /** Dry-run: escribir el manifiesto (marcado dryRun:true) en manifestPath. Por defecto NO. */
  writeDryRunManifest?: boolean;
  /** SÓLO TESTS (mutantes): sustituye el plan de borrado. */
  steps?: readonly Step[];
  /** SÓLO TESTS (mutantes): sentencias extra tras el plan, antes de verificar. */
  extraSql?: readonly string[];
  /** SÓLO TESTS: esquema esperado (por defecto EXPECTED_MIGRATIONS). */
  expectedMigrations?: readonly string[];
  log?: (line: string) => void;
  /** SÓLO TESTS: puntos de inyección (bloqueos, COMMIT, actividad tras el COMMIT). */
  testHooks?: {
    /** Dentro de la transacción, tras los bloqueos y las guardas, antes de borrar. */
    afterLock?: () => Promise<void>;
    /** Sustituye trx.commit() (p. ej. COMMIT que lanza tras confirmarse). */
    commit?: (trx: Knex.Transaction) => Promise<void>;
    /** Tras el COMMIT y antes de la verificación posterior (p. ej. un worker vivo). */
    afterCommit?: () => Promise<void>;
  };
}

export interface TournamentListing {
  id: string;
  name: string;
  state: string;
  entries: number;
  battles: number;
  liveBattles: number;
  activeJobs: number;
  terminal: boolean;
  /** `running` nominal sin nada vivo: torneo atascado, se borra. */
  stuck: boolean;
}

const TERMINAL_TOURNAMENT_STATES = ["finished", "cancelled"];

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

async function rows<T = any>(db: Knex | Knex.Transaction, sql: string, bindings: any[] = []): Promise<T[]> {
  const r = await db.raw(sql, bindings);
  return r.rows as T[];
}

/** Huella del esquema: migraciones + columnas + restricciones + índices + triggers + funciones. */
export async function schemaFingerprint(db: Knex | Knex.Transaction): Promise<string> {
  const parts = {
    migrations: await rows(db, `SELECT name FROM knex_migrations ORDER BY id`),
    columns: await rows(
      db,
      `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`,
    ),
    constraints: await rows(
      db,
      `SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`,
    ),
    indexes: await rows(
      db,
      `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2`,
    ),
    triggers: await rows(
      db,
      `SELECT tgrelid::regclass::text AS rel, tgname, pg_get_triggerdef(t.oid) AS def
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace ORDER BY 1, 2`,
    ),
    functions: await rows(
      db,
      `SELECT proname, md5(prosrc) AS src FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY 1, 2`,
    ),
  };
  return "s9fp-" + createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

async function publicTables(db: Knex | Knex.Transaction): Promise<string[]> {
  return (
    await rows<{ t: string }>(
      db,
      `SELECT c.relname AS t FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p','m','v','f') ORDER BY 1`,
    )
  ).map((r) => r.t);
}

interface FkInfo {
  conname: string;
  child: string;
  parent: string;
  childCols: string[];
  parentCols: string[];
  onDelete: string;
}

async function foreignKeys(db: Knex | Knex.Transaction): Promise<FkInfo[]> {
  const r = await rows<any>(
    db,
    `SELECT c.conname, cl.relname AS child, pl.relname AS parent, c.confdeltype AS on_delete,
            array_agg(ca.attname::text ORDER BY k.ord) AS child_cols,
            array_agg(pa.attname::text ORDER BY k.ord) AS parent_cols
       FROM pg_constraint c
       JOIN pg_class cl ON cl.oid = c.conrelid
       JOIN pg_class pl ON pl.oid = c.confrelid
       CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(ck, pk, ord)
       JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = k.ck
       JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = k.pk
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
      GROUP BY c.conname, cl.relname, pl.relname, c.confdeltype
      ORDER BY 2, 1`,
  );
  return r.map((x) => ({
    conname: x.conname,
    child: x.child,
    parent: x.parent,
    childCols: x.child_cols,
    parentCols: x.parent_cols,
    onDelete: x.on_delete,
  }));
}

/** Huérfanos por cada FK DECLARADA (semántica MATCH SIMPLE: sólo filas con todas las columnas no nulas). */
async function declaredOrphans(db: Knex | Knex.Transaction): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const fk of await foreignKeys(db)) {
    const notNull = fk.childCols.map((c) => `c.${q(c)} IS NOT NULL`).join(" AND ");
    const match = fk.childCols.map((c, i) => `p.${q(fk.parentCols[i])} = c.${q(c)}`).join(" AND ");
    const [{ n }] = await rows<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM ${q(fk.child)} c WHERE ${notNull} AND NOT EXISTS (SELECT 1 FROM ${q(fk.parent)} p WHERE ${match})`,
    );
    out[`${fk.child}.${fk.conname} → ${fk.parent}`] = n;
  }
  return out;
}

async function rowHash(db: Knex | Knex.Transaction, table: string, where: string): Promise<TableState> {
  // pg_attribute (no information_schema, que oculta columnas sin privilegio): TODAS las columnas.
  const cols = await rows<{ column_name: string; data_type: string }>(
    db,
    `SELECT a.attname::text AS column_name, format_type(a.atttypid, NULL) AS data_type
       FROM pg_attribute a
      WHERE a.attrelid = to_regclass(format('public.%I', ?::text)) AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attname`,
    [table],
  );
  if (cols.length === 0) throw new Error(`rowHash: ${table} sin columnas legibles`);
  // bytea (código, artefactos) se resume con sha256: misma garantía sin materializar MB en texto.
  const exprs = cols.map((c) =>
    c.data_type === "bytea"
      ? `CASE WHEN t.${q(c.column_name)} IS NULL THEN NULL ELSE encode(sha256(t.${q(c.column_name)}), 'hex') END`
      : `t.${q(c.column_name)}`,
  );
  const [r] = await rows<{ n: number; h: string }>(
    db,
    `SELECT count(*)::int AS n, md5(coalesce(string_agg(x.h, ',' ORDER BY x.h), '')) AS h
       FROM (SELECT md5(ROW(${exprs.join(", ")})::text) AS h FROM ${q(table)} t WHERE ${where}) x`,
  );
  return { count: r.n, hash: r.h };
}

async function snapshot(db: Knex | Knex.Transaction, auditMaxId: number): Promise<DbState> {
  const state: DbState = {};
  for (const [table, spec] of Object.entries(INVENTORY)) {
    const [{ n }] = await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM ${q(table)}`);
    state[table] = { count: n };
    if (spec.klass === "PRESERVE" || spec.klass === "PARTIAL") {
      // audit_log: se hashean las filas existentes antes del reset (id <= máximo previo).
      const where = table === "audit_log" ? `t.id <= ${Number(auditMaxId)}` : (spec.preserveWhere ?? "true");
      const h = await rowHash(db, table, where);
      state[table].hash = `${h.count}:${h.hash}`;
    }
    if (spec.klass === "PARTIAL") {
      const [{ r }] = await rows<{ r: number }>(
        db,
        `SELECT count(*)::int AS r FROM ${q(table)} t WHERE ${spec.resetWhere}`,
      );
      state[table].resetCount = r;
    }
  }
  return state;
}

async function logicalRefs(db: Knex | Knex.Transaction): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const ref of LOGICAL_REFERENCES) out[ref.name] = (await rows<{ n: number }>(db, ref.sql))[0].n;
  return out;
}

async function historicalRefs(db: Knex | Knex.Transaction): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const ref of HISTORICAL_REFERENCES) out[ref.name] = (await rows<{ n: number }>(db, ref.sql))[0].n;
  return out;
}

async function unvalidatedConstraints(db: Knex | Knex.Transaction): Promise<string[]> {
  return (
    await rows<{ c: string }>(
      db,
      `SELECT conrelid::regclass::text || '.' || conname AS c FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace AND NOT convalidated ORDER BY 1`,
    )
  ).map((r) => r.c);
}

async function alreadyApplied(db: Knex | Knex.Transaction): Promise<boolean> {
  const [{ n }] = await rows<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM audit_log WHERE action = ? AND target = ?`,
    [AUDIT_ACTION, AUDIT_TARGET],
  );
  return n > 0;
}

async function frozenCount(db: Knex | Knex.Transaction): Promise<number> {
  return (await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM bot_versions WHERE state = 'frozen'`))[0].n;
}

/** Torneos que se borrarán, con su actividad viva (batallas running y jobs activos que los referencian). */
export async function listTournaments(db: Knex | Knex.Transaction): Promise<TournamentListing[]> {
  const r = await rows<any>(
    db,
    `SELECT t.id::text AS id, t.name, t.state,
            (SELECT count(*) FROM entries e WHERE e.tournament_id = t.id)::int AS entries,
            (SELECT count(*) FROM battles b WHERE b.tournament_id = t.id)::int AS battles,
            (SELECT count(*) FROM battles b WHERE b.tournament_id = t.id AND b.status = 'running')::int AS live_battles,
            (SELECT count(*) FROM jobs j WHERE j.status IN ('queued','running') AND (
                 j.payload->>'tournamentId' = t.id::text
              OR j.payload->>'battleId' IN (SELECT b.id::text FROM battles b WHERE b.tournament_id = t.id)
              OR j.payload->>'matchId' IN (SELECT m.id::text FROM matches m WHERE m.tournament_id = t.id)))::int AS active_jobs
       FROM tournaments t ORDER BY t.created_at, t.id`,
  );
  return r.map((x) => {
    const terminal = TERMINAL_TOURNAMENT_STATES.includes(x.state);
    return {
      id: x.id,
      name: x.name,
      state: x.state,
      entries: x.entries,
      battles: x.battles,
      liveBattles: x.live_battles,
      activeJobs: x.active_jobs,
      terminal,
      stuck: x.state === "running" && x.live_battles === 0 && x.active_jobs === 0,
    };
  });
}

/** Guardas de esquema y de actividad. Devuelve la lista de fallos (vacía = OK). */
async function guards(trx: Knex.Transaction, expected: readonly string[]): Promise<string[]> {
  const fails: string[] = [];
  const applied = (await rows<{ name: string }>(trx, `SELECT name FROM knex_migrations ORDER BY id`)).map(
    (r) => r.name,
  );
  if (JSON.stringify(applied) !== JSON.stringify(expected)) {
    const missing = expected.filter((m) => !applied.includes(m));
    const extra = applied.filter((m) => !expected.includes(m));
    fails.push(
      `esquema inesperado: faltan [${missing.join(", ")}], sobran [${extra.join(", ")}] (se espera hasta ${expected.at(-1)})`,
    );
  }
  const lock = await rows<{ is_locked: number }>(trx, `SELECT is_locked FROM knex_migrations_lock`);
  if (lock.some((l) => Number(l.is_locked) !== 0))
    fails.push("knex_migrations_lock está tomado: hay una migración en curso");

  const tables = await publicTables(trx);
  const unknown = tables.filter((t) => !(t in INVENTORY));
  const missingT = Object.keys(INVENTORY).filter((t) => !tables.includes(t));
  if (unknown.length) fails.push(`tablas/vistas SIN clasificar (fail-closed): ${unknown.join(", ")}`);
  if (missingT.length) fails.push(`tablas del inventario que no existen: ${missingT.join(", ")}`);

  // Un borrado nunca puede alcanzar (CASCADE / SET NULL / bloqueo) una tabla que se conserva.
  const resetSet = new Set(
    Object.entries(INVENTORY)
      .filter(([, s]) => s.klass === "RESET")
      .map(([t]) => t),
  );
  for (const fk of await foreignKeys(trx)) {
    if (resetSet.has(fk.parent) && !resetSet.has(fk.child)) {
      fails.push(`FK ${fk.child}.${fk.conname} → ${fk.parent} (on delete '${fk.onDelete}') sale de una tabla NO-RESET`);
    }
  }

  const unvalidated = await unvalidatedConstraints(trx);
  if (unvalidated.length) fails.push(`restricciones NOT VALID antes del reset: ${unvalidated.join(", ")}`);

  const one = async (sql: string) => (await rows<{ n: number }>(trx, sql))[0].n;
  if (missingT.length === 0) {
    const running = await one(`SELECT count(*)::int AS n FROM battles WHERE status = 'running'`);
    if (running) fails.push(`${running} batalla(s) en 'running'`);
    const activeJobs = await one(`SELECT count(*)::int AS n FROM jobs WHERE status IN ('queued','running')`);
    if (activeJobs) fails.push(`${activeJobs} job(s) activos (queued/running)`);
    // P2-1 · El estado NOMINAL `running` de torneos/partidas no es criterio: un torneo `running`
    // sin batallas en curso ni jobs activos está ATASCADO y se borra (se lista como tal). Sólo
    // aborta un torneo con actividad viva. (Las guardas globales de arriba ya abortan ante
    // cualquier batalla running o job activo; esta repite el motivo con el nombre del torneo.)
    for (const t of await listTournaments(trx)) {
      if (t.liveBattles || t.activeJobs) {
        fails.push(
          `torneo «${t.name}» (${t.id}, ${t.state}) con actividad viva: ${t.liveBattles} batalla(s) running, ${t.activeJobs} job(s) activos`,
        );
      }
    }
    const activeStream = await one(`SELECT count(*)::int AS n FROM streaming_sessions WHERE state = 'active'`);
    if (activeStream) fails.push(`${activeStream} emisión(es) activa(s)`);
    const ach = await one(`SELECT count(*)::int AS n FROM achievements`);
    if (ach)
      fails.push(`achievements tiene ${ach} fila(s): REVIEW obligatorio antes de decidir (no se borra a ciegas)`);
    const known = [...COMPETITIVE_JOB_KINDS, ...PRESERVED_JOB_KINDS];
    const kinds = (await rows<{ kind: string }>(trx, `SELECT DISTINCT kind FROM jobs ORDER BY 1`)).map((r) => r.kind);
    const unknownKinds = kinds.filter((k) => !known.includes(k));
    if (unknownKinds.length) fails.push(`jobs de tipo desconocido (fail-closed): ${unknownKinds.join(", ")}`);
  }
  return fails;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Escritura ATÓMICA y sin sobrescribir (P1-1): temporal en el mismo directorio (0600, fsync) y
 * `link` al nombre final, que falla con EEXIST si ya existe; nunca deja un fichero a medias.
 */
function writeDurable(path: string, content: string): void {
  const tmp = join(dirname(path), `.${path.split("/").pop()}.tmp-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path);
  } finally {
    unlinkSync(tmp);
  }
  try {
    const dfd = openSync(dirname(path), "r");
    fsyncSync(dfd);
    closeSync(dfd);
  } catch {
    /* fsync del directorio no disponible: el fichero ya está sincronizado */
  }
}

/** Ruta de salida válida: no existe y su directorio existe y es escribible. null = OK. */
export function outputPathProblem(path: string): string | null {
  let exists = true;
  try {
    lstatSync(path); // también detecta enlaces simbólicos rotos
  } catch {
    exists = false;
  }
  if (exists) return `${path} ya existe (no se sobrescribe)`;
  const dir = dirname(path);
  try {
    if (!statSync(dir).isDirectory()) return `${dir} no es un directorio`;
    accessSync(dir, fsConstants.W_OK | fsConstants.X_OK);
  } catch {
    return `${dir} no existe o no es escribible`;
  }
  return null;
}

function diffStates(before: DbState, after: DbState, auditDelta: number): string[] {
  const fails: string[] = [];
  for (const [table, spec] of Object.entries(INVENTORY)) {
    const b = before[table];
    const a = after[table];
    if (spec.klass === "RESET" || spec.klass === "REVIEW_EMPTY") {
      if (a.count !== 0) fails.push(`${table}: quedan ${a.count} fila(s) (esperado 0)`);
    } else if (spec.klass === "PARTIAL") {
      if (a.resetCount !== 0) fails.push(`${table}: quedan ${a.resetCount} fila(s) del subconjunto RESET`);
      if (a.hash !== b.hash) fails.push(`${table}: el subconjunto conservado cambió (${b.hash} → ${a.hash})`);
    } else if (table === "audit_log") {
      if (a.hash !== b.hash) fails.push(`audit_log: las filas previas cambiaron`);
      if (a.count !== b.count + auditDelta) {
        fails.push(`audit_log: ${a.count - b.count} filas nuevas (esperada(s) ${auditDelta}: la marca sólo en apply)`);
      }
    } else {
      if (a.count !== b.count) fails.push(`${table}: ${b.count} → ${a.count} filas (PRESERVE)`);
      if (a.hash !== b.hash) fails.push(`${table}: hash de filas cambió (PRESERVE)`);
    }
  }
  return fails;
}

/** Ejecuta el reset (dry-run = todo dentro de la transacción y ROLLBACK). */
export async function runReset(db: Knex, opts: ResetOptions): Promise<ResetReport> {
  const log = opts.log ?? (() => {});
  const expected = opts.expectedMigrations ?? EXPECTED_MIGRATIONS;
  const steps = opts.steps ?? RESET_STEPS;
  const report: ResetReport = {
    mode: opts.mode,
    status: "ERROR",
    exitCode: 1,
    guardFailures: [],
    verifyFailures: [],
    warnings: [],
  };

  // Qué tablas existen se mira FUERA de la transacción: dentro, la primera consulta fijaría el
  // snapshot antes de tomar los bloqueos.
  const existing = (
    await db.raw(
      `SELECT c.relname AS t FROM pg_catalog.pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'`,
    )
  ).rows.map((r: { t: string }) => r.t);
  const lockable = Object.entries(INVENTORY)
    .filter(([t, s]) => s.klass !== "PRESERVE" && existing.includes(t))
    .map(([t]) => t);

  const trx = await db.transaction();
  let committing = false;
  let committed = false;
  try {
    // Snapshot fijo: los hashes "antes" y "después" ven la MISMA foto salvo lo que hace este script.
    await trx.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await trx.raw("SET LOCAL lock_timeout = '15s'");
    // Bloqueo ANTES del snapshot (SET y LOCK no lo fijan): nadie escribe en lo que se borra mientras
    // dura el reset; las lecturas concurrentes siguen funcionando (EXCLUSIVE, no ACCESS EXCLUSIVE).
    if (lockable.length) await trx.raw(`LOCK TABLE ${lockable.map(q).join(", ")} IN EXCLUSIVE MODE`);

    if (existing.includes("audit_log") && (await alreadyApplied(trx))) {
      report.status = "ALREADY_APPLIED";
      report.exitCode = 3;
      report.guardFailures.push(`ya aplicado: audit_log tiene la marca ${AUDIT_ACTION} ${AUDIT_TARGET}`);
      await trx.rollback();
      return report;
    }

    report.fingerprint = await schemaFingerprint(trx);
    report.guardFailures = await guards(trx, expected);
    if (report.guardFailures.length) {
      report.status = "GUARD_FAILED";
      report.exitCode = 2;
      await trx.rollback();
      return report;
    }
    if (opts.mode === "apply") {
      if (!opts.confirm || opts.confirm !== report.fingerprint) {
        report.status = "CONFIRM_MISSING";
        report.exitCode = 2;
        report.guardFailures.push(
          "--apply exige S9_RESET_CONFIRM igual a la huella del esquema que imprime el --dry-run sobre ESTA BD",
        );
        await trx.rollback();
        return report;
      }
      if (!opts.manifestPath) {
        report.status = "GUARD_FAILED";
        report.exitCode = 2;
        report.guardFailures.push("--apply exige --replay-manifest <ruta> (lista de replays a borrar después)");
        await trx.rollback();
        return report;
      }
    }

    // P2-1 · lista de torneos que se borrarán (el CLI la imprime ANTES de la tabla de conteos).
    report.tournaments = await listTournaments(trx);
    for (const t of report.tournaments) {
      log(
        `  TORNEO ${t.id} «${t.name}» estado=${t.state} entries=${t.entries} batallas=${t.battles}` +
          (t.stuck ? "  ⚠ ATASCADO (running sin batallas en curso ni jobs activos): se borra" : "") +
          (!t.terminal && !t.stuck ? "  ⚠ NO TERMINAL: se borra" : ""),
      );
    }

    const [{ m }] = (await trx.raw(`SELECT coalesce(max(id), 0)::bigint AS m FROM audit_log`)).rows;
    const auditMax = Number(m);
    report.before = await snapshot(trx, auditMax);
    const orphansBefore = await logicalRefs(trx);
    const frozenBefore = await frozenCount(trx);

    // Manifiesto de replays: ids de TODAS las batallas que se borran (con o sin replay_ref).
    const battles = await rows<{ id: string; replay_ref: string | null; replay_hash: string | null }>(
      trx,
      `SELECT id::text AS id, replay_ref, replay_hash FROM battles ORDER BY id`,
    );
    const manifest = {
      format: MANIFEST_FORMAT,
      reset: RESET_NAME,
      dryRun: opts.mode !== "apply",
      fingerprint: report.fingerprint,
      createdAt: new Date().toISOString(),
      battles: battles.map((b) => ({ id: b.id, replayRef: b.replay_ref, replayHash: b.replay_hash })),
    };
    const manifestText = JSON.stringify(manifest, null, 2) + "\n";
    const manifestSha = createHash("sha256").update(manifestText).digest("hex");

    await opts.testHooks?.afterLock?.();

    report.deleted = {};
    for (const step of steps) {
      const r = await trx.raw(step.sql);
      report.deleted[step.table] = (report.deleted[step.table] ?? 0) + (r.rowCount ?? 0);
      log(`  DELETE ${step.table}: ${r.rowCount ?? 0}`);
    }
    for (const sql of opts.extraSql ?? []) await trx.raw(sql);

    // Marca de una sola ejecución. SÓLO en apply (P2-3): en dry-run ni siquiera se inserta, para
    // no consumir identidad de audit_log (un INSERT deshecho deja hueco en la secuencia).
    if (opts.mode === "apply")
      await trx("audit_log").insert({
        actor_id: null,
        action: AUDIT_ACTION,
        target: AUDIT_TARGET,
        detail: JSON.stringify({
          scriptVersion: SCRIPT_VERSION,
          fingerprint: report.fingerprint,
          deleted: report.deleted,
          before: Object.fromEntries(Object.entries(report.before).map(([t, s]) => [t, s.count])),
          replayManifestSha256: manifestSha,
          battles: battles.length,
        }),
      });

    // ---------------------------------------------------------- verificación EN la transacción
    report.after = await snapshot(trx, auditMax);
    const verify = diffStates(report.before, report.after, opts.mode === "apply" ? 1 : 0);
    const declared = await declaredOrphans(trx);
    const logical = await logicalRefs(trx);
    report.orphans = { ...declared, ...logical };
    for (const [k, n] of Object.entries(declared)) if (n !== 0) verify.push(`huérfanos FK ${k}: ${n}`);
    for (const ref of LOGICAL_REFERENCES) {
      const n = logical[ref.name];
      if (ref.mustBeZero && n !== 0) verify.push(`huérfanos lógicos ${ref.name}: ${n}`);
      if (!ref.mustBeZero && n > orphansBefore[ref.name]) {
        verify.push(`huérfanos lógicos ${ref.name}: ${orphansBefore[ref.name]} → ${n} (aumentan)`);
      }
    }
    const unvalidated = await unvalidatedConstraints(trx);
    if (unvalidated.length) verify.push(`restricciones NOT VALID: ${unvalidated.join(", ")}`);
    const frozenAfter = await frozenCount(trx);
    report.frozenVersions = { before: frozenBefore, after: frozenAfter };
    if (frozenAfter !== frozenBefore) verify.push(`versiones frozen ${frozenBefore} → ${frozenAfter}`);
    if ((await schemaFingerprint(trx)) !== report.fingerprint) verify.push("el esquema cambió durante el reset");
    report.historical = await historicalRefs(trx);
    report.verifyFailures = verify;
    const writeManifest = opts.mode === "apply" || opts.writeDryRunManifest === true;
    report.replayManifest = {
      path: writeManifest ? (opts.manifestPath ?? null) : null,
      sha256: manifestSha,
      battles: battles.length,
      withReplayRef: battles.filter((b) => b.replay_ref).length,
    };

    if (verify.length) {
      report.status = "VERIFY_FAILED";
      report.exitCode = 1;
      await trx.rollback();
      return report;
    }

    if (writeManifest && opts.manifestPath) writeDurable(opts.manifestPath, manifestText);

    if (opts.mode !== "apply") {
      await trx.rollback();
      report.status = "DRY_RUN_OK";
      report.exitCode = 0;
      return report;
    }

    // A partir de aquí el estado puede haber cambiado: cualquier fallo es 4, nunca 1.
    committing = true;
    await (opts.testHooks?.commit ? opts.testHooks.commit(trx) : trx.commit());
    committed = true;
  } catch (err) {
    if (committing && !committed) {
      // COMMIT que lanza: pudo confirmarse en el servidor y perderse la respuesta (conexión
      // cortada). Estado DESCONOCIDO: exit 4, comprobar la marca en audit_log.
      if (!trx.isCompleted()) await trx.rollback().catch(() => {});
      report.status = "COMMIT_UNKNOWN";
      report.exitCode = 4;
      report.error = `COMMIT con resultado desconocido: ${(err as Error).message}. Comprobar la marca ${AUDIT_ACTION} en audit_log; STOP`;
      return report;
    }
    if (!trx.isCompleted()) await trx.rollback().catch(() => {});
    report.status = "ERROR";
    report.exitCode = 1;
    report.error = (err as Error).message;
    return report;
  }

  try {
    await opts.testHooks?.afterCommit?.();
  } catch (err) {
    report.warnings.push(`afterCommit: ${(err as Error).message}`);
  }

  // ---------------------------------------------------------- verificación DESPUÉS del COMMIT
  const post: string[] = [];
  const changedVolatile: string[] = [];
  try {
    await db.transaction(async (t2) => {
      await t2.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      if (!(await alreadyApplied(t2))) post.push("la marca de audit_log no está tras el COMMIT");
      const [{ m }] = (await t2.raw(`SELECT coalesce(max(id), 0)::bigint AS m FROM audit_log`)).rows;
      const now = await snapshot(t2, Number(m));
      for (const [table, spec] of Object.entries(INVENTORY)) {
        if ((spec.klass === "RESET" || spec.klass === "REVIEW_EMPTY") && now[table].count !== 0) {
          post.push(`${table}: ${now[table].count} filas tras el COMMIT`);
        }
        if (spec.klass === "PARTIAL" && now[table].resetCount !== 0) post.push(`${table}: subconjunto RESET no vacío`);
        if (spec.klass === "PRESERVE" && table !== "audit_log" && now[table].hash !== report.after![table].hash) {
          (spec.volatile ? changedVolatile : post).push(`${table}: cambió tras el COMMIT (actividad concurrente)`);
        }
      }
      for (const [k, n] of Object.entries(await declaredOrphans(t2))) if (n) post.push(`huérfanos FK ${k}: ${n}`);
      const logical = await logicalRefs(t2);
      for (const ref of LOGICAL_REFERENCES) if (ref.mustBeZero && logical[ref.name]) post.push(`huérfanos ${ref.name}`);
      const unv = await unvalidatedConstraints(t2);
      if (unv.length) post.push(`restricciones NOT VALID: ${unv.join(", ")}`);
      if ((await frozenCount(t2)) !== report.frozenVersions!.before) post.push("versiones frozen cambiaron");
    });
  } catch (err) {
    post.push(`verificación post-COMMIT no pudo completarse: ${(err as Error).message}`);
  }
  report.postCommit = { failures: post, changedVolatile };
  if (post.length) {
    report.status = "POST_COMMIT_FAILED";
    report.exitCode = 4;
  } else {
    report.status = "APPLIED";
    report.exitCode = 0;
  }
  return report;
}

// ============================================================================================= archivos

export interface ReplayFilesReport {
  status: "LISTED" | "DELETED" | "REFUSED" | "PARTIAL";
  exitCode: number;
  candidates: { battleId: string; path: string; bytes: number }[];
  missing: string[];
  review: string[];
  deleted: string[];
  refusals: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Paso SEPARADO: borra los archivos de replay de las batallas del manifiesto, por id, de uno
 * en uno y sólo `<dir>/<id>.replay` y `<dir>/<id>.replay.json`. Nunca recursivo, nunca glob,
 * nunca enlaces simbólicos. Exige que el reset esté aplicado con ESTE manifiesto (sha256 en la
 * marca de audit_log) y que ninguna de esas batallas exista ya en la BD.
 */
export async function replayFiles(
  db: Knex,
  opts: { manifestPath: string; replaysDir: string; apply: boolean },
): Promise<ReplayFilesReport> {
  const rep: ReplayFilesReport = {
    status: "REFUSED",
    exitCode: 2,
    candidates: [],
    missing: [],
    review: [],
    deleted: [],
    refusals: [],
  };
  const sha = sha256File(opts.manifestPath);
  const manifest = JSON.parse(readFileSync(opts.manifestPath, "utf8"));
  if (manifest.format !== MANIFEST_FORMAT || manifest.reset !== RESET_NAME) rep.refusals.push("formato de manifiesto");
  if (manifest.dryRun !== false) rep.refusals.push("el manifiesto es de un dry-run");
  const marks = (
    await db.raw(`SELECT detail FROM audit_log WHERE action = ? AND target = ?`, [AUDIT_ACTION, AUDIT_TARGET])
  ).rows as { detail: any }[];
  if (marks.length !== 1) rep.refusals.push(`marca de reset en audit_log: ${marks.length} (esperada 1)`);
  else if (marks[0].detail?.replayManifestSha256 !== sha)
    rep.refusals.push("el sha256 del manifiesto no es el del reset");
  const ids: string[] = (manifest.battles ?? []).map((b: { id: string }) => b.id);
  // Un id que no es UUID (p. ej. «../x») se rechaza ANTES de usarlo en ninguna consulta ni ruta.
  const badIds = ids.some((id) => !UUID.test(id));
  if (badIds) rep.refusals.push("ids de batalla no UUID en el manifiesto");
  if (ids.length && !badIds) {
    const [{ n }] = (await db("battles").whereIn("id", ids).count({ n: "*" })) as { n: string | number }[];
    if (Number(n) !== 0) rep.refusals.push(`${n} batalla(s) del manifiesto siguen en la BD`);
  }
  let dirReal: string;
  try {
    dirReal = realpathSync(opts.replaysDir);
    if (!lstatSync(dirReal).isDirectory()) rep.refusals.push("--replays-dir no es un directorio");
  } catch {
    rep.refusals.push("--replays-dir no existe");
    dirReal = "";
  }
  if (rep.refusals.length) return rep;

  for (const b of manifest.battles as { id: string; replayRef: string | null }[]) {
    const main = join(dirReal, `${b.id}.replay`);
    if (b.replayRef && b.replayRef !== join(opts.replaysDir, `${b.id}.replay`) && b.replayRef !== main) {
      rep.review.push(`${b.id}: replay_ref ${b.replayRef} no es <dir>/<id>.replay; no se toca`);
      continue;
    }
    for (const p of [main, `${main}.json`]) {
      let st;
      try {
        st = lstatSync(p);
      } catch {
        rep.missing.push(p);
        continue;
      }
      if (!st.isFile() || st.isSymbolicLink() || dirname(p) !== dirReal) {
        rep.review.push(`${p}: no es un archivo regular dentro de ${dirReal}; no se toca`);
        continue;
      }
      rep.candidates.push({ battleId: b.id, path: p, bytes: st.size });
    }
  }
  if (!opts.apply) {
    rep.status = "LISTED";
    rep.exitCode = 0;
    return rep;
  }
  for (const c of rep.candidates) {
    unlinkSync(c.path);
    rep.deleted.push(c.path);
  }
  rep.status = rep.review.length ? "PARTIAL" : "DELETED";
  rep.exitCode = 0;
  return rep;
}

// ============================================================================================= CLI

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function printTable(rep: ResetReport, out: (s: string) => void): void {
  if (!rep.before || !rep.after) return;
  out("TABLA                      CLASE        ANTES   DESPUÉS  HASH");
  for (const [t, spec] of Object.entries(INVENTORY)) {
    const b = rep.before[t];
    const a = rep.after[t];
    const hash = spec.klass === "PRESERVE" || spec.klass === "PARTIAL" ? (a.hash === b.hash ? "igual" : "CAMBIA") : "-";
    const extra = spec.klass === "PARTIAL" ? ` (reset ${b.resetCount}→${a.resetCount})` : "";
    out(
      `${t.padEnd(26)} ${spec.klass.padEnd(12)} ${String(b.count).padStart(7)} ${String(a.count).padStart(8)}  ${hash}${extra}`,
    );
  }
}

export interface MainHooks {
  /** SÓLO TESTS: justo antes de escribir el --report (p. ej. hacer que falle). */
  beforeReportWrite?: () => void;
  reset?: ResetOptions["testHooks"];
}

export async function main(argv: string[], hooks?: MainHooks): Promise<number> {
  const out = (s: string) => process.stdout.write(s + "\n");
  const db = createDb();
  try {
    if (argv[0] === "replay-files") {
      const manifestPath = arg(argv, "--manifest");
      const replaysDir = arg(argv, "--replays-dir");
      if (!manifestPath || !replaysDir) {
        out("Uso: replay-files --manifest <ruta> --replays-dir <dir> [--apply]");
        return 2;
      }
      const rep = await replayFiles(db, { manifestPath, replaysDir, apply: argv.includes("--apply") });
      for (const r of rep.refusals) out(`RECHAZADO: ${r}`);
      for (const r of rep.review) out(`REVIEW: ${r}`);
      out(
        `candidatos=${rep.candidates.length} bytes=${rep.candidates.reduce((s, c) => s + c.bytes, 0)} ausentes=${rep.missing.length} review=${rep.review.length} borrados=${rep.deleted.length}`,
      );
      out(`RESULT ${JSON.stringify({ status: rep.status, exitCode: rep.exitCode })}`);
      return rep.exitCode;
    }

    const apply = argv.includes("--apply");
    const result = (st: string, code: number, fp?: string) =>
      out(`RESULT ${JSON.stringify({ status: st, exitCode: code, fingerprint: fp })}`);
    if (apply && argv.includes("--dry-run")) {
      out("--apply y --dry-run son incompatibles");
      result("USAGE", 2);
      return 2;
    }
    const manifestPath = arg(argv, "--replay-manifest") ?? null;
    const reportPath = arg(argv, "--report") ?? null;
    const writeDryRunManifest = argv.includes("--write-dry-run-manifest");
    // P1-1 · Las rutas de salida se validan ANTES de abrir la transacción: un --report que ya
    // existe o no se puede escribir aborta con 2 sin tocar nada (nunca después del COMMIT).
    const outputs: string[] = [];
    if (reportPath) outputs.push(reportPath);
    if (manifestPath && (apply || writeDryRunManifest)) outputs.push(manifestPath);
    if (reportPath && manifestPath && reportPath === manifestPath) {
      out("GUARDA: --report y --replay-manifest no pueden ser la misma ruta");
      result("GUARD_FAILED", 2);
      return 2;
    }
    for (const o of outputs) {
      const problem = outputPathProblem(o);
      if (problem) {
        out(`GUARDA: ruta de salida no válida: ${problem}`);
        result("GUARD_FAILED", 2);
        return 2;
      }
    }
    if (manifestPath && !apply && !writeDryRunManifest) {
      out("AVISO: en dry-run el manifiesto NO se escribe (usa --write-dry-run-manifest para escribirlo)");
    }
    const rep = await runReset(db, {
      mode: apply ? "apply" : "dry-run",
      confirm: process.env.S9_RESET_CONFIRM,
      manifestPath,
      writeDryRunManifest,
      log: out,
      testHooks: hooks?.reset,
    });
    out(`MODO ${rep.mode} · huella del esquema: ${rep.fingerprint ?? "(no calculada)"}`);
    const pending = (rep.tournaments ?? []).filter((t) => !t.terminal);
    if (rep.tournaments) {
      out(
        `torneos que se borran: ${rep.tournaments.length} (no terminales: ${pending.length}, atascados: ${pending.filter((t) => t.stuck).length})`,
      );
    }
    if (pending.length) {
      out("################################################################################");
      out(`### ATENCIÓN: ${pending.length} torneo(s) NO terminal(es) se borran (ver líneas TORNEO ⚠ arriba)`);
      out("################################################################################");
    }
    printTable(rep, out);
    if (rep.frozenVersions) out(`versiones frozen: ${rep.frozenVersions.before} → ${rep.frozenVersions.after}`);
    if (rep.orphans) {
      const bad = Object.entries(rep.orphans).filter(([, n]) => n !== 0);
      out(`huérfanos comprobados: ${Object.keys(rep.orphans).length} relaciones, con huérfanos: ${bad.length}`);
      for (const [k, n] of bad) out(`  ${k}: ${n}`);
    }
    for (const [k, n] of Object.entries(rep.historical ?? {})) out(`histórico conservado (audit_log): ${k}: ${n}`);
    if (rep.replayManifest) {
      out(
        `manifiesto de replays: ${rep.replayManifest.path ?? "(no escrito)"} sha256=${rep.replayManifest.sha256} batallas=${rep.replayManifest.battles} con replay_ref=${rep.replayManifest.withReplayRef}`,
      );
    }
    for (const g of rep.guardFailures) out(`GUARDA: ${g}`);
    for (const v of rep.verifyFailures) out(`VERIFICACIÓN: ${v}`);
    for (const p of rep.postCommit?.failures ?? []) out(`POST-COMMIT: ${p}`);
    for (const p of rep.postCommit?.changedVolatile ?? []) out(`AVISO (volátil): ${p}`);
    if (rep.error) out(`ERROR: ${rep.error}`);
    if (reportPath) {
      // Tras un COMMIT (o un COMMIT de resultado desconocido) cualquier fallo aquí es 4: el reset
      // está (o puede estar) aplicado y no se debe confundir con «ROLLBACK, no se tocó nada».
      const afterCommit =
        rep.mode === "apply" && ["APPLIED", "POST_COMMIT_FAILED", "COMMIT_UNKNOWN"].includes(rep.status);
      try {
        hooks?.beforeReportWrite?.();
        writeDurable(reportPath, JSON.stringify(rep, null, 2) + "\n");
      } catch (err) {
        out(`ERROR escribiendo --report: ${(err as Error).message}`);
        if (afterCommit) {
          rep.status = rep.status === "COMMIT_UNKNOWN" ? "COMMIT_UNKNOWN" : "POST_COMMIT_FAILED";
          rep.exitCode = 4;
          out("POST-COMMIT: el reset está aplicado pero el informe no se pudo escribir: STOP");
        } else if (rep.exitCode === 0) {
          rep.status = "ERROR";
          rep.exitCode = 1;
        }
      }
    }
    result(rep.status, rep.exitCode, rep.fingerprint);
    return rep.exitCode;
  } finally {
    await db.destroy();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`ERROR: ${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}
