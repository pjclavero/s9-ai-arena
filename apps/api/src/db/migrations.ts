/**
 * T7.1 · Migraciones del esquema PostgreSQL del capítulo 23.
 *
 * Knex Migrate con una MigrationSource programática (ADR-E7-001): las migraciones
 * viven como módulos TypeScript en este archivo, se aplican con `migrateToLatest(db)`
 * y se revierten con `rollbackAll(db)`. SQL escrito para PostgreSQL real: en
 * producción se ejecuta contra el PostgreSQL del servidor vía DATABASE_URL.
 *
 * Política 23.1: los eventos masivos de batalla NO viven en la BD. `battles`
 * guarda `replay_ref` (ruta/URI del archivo comprimido de E8), hashes y metadatos.
 */
import type { Knex } from "knex";

export interface Migration {
  name: string;
  up(db: Knex): Promise<void>;
  down(db: Knex): Promise<void>;
}

export const ROLES = ["visitor", "user", "developer", "team_captain", "organizer", "moderator", "admin"] as const;
export type RoleName = (typeof ROLES)[number];

export const BOT_STATES = [
  "draft",
  "validating",
  "rejected",
  "validated",
  "published",
  "frozen",
  "suspended",
  "retired",
] as const;

const m001_identity: Migration = {
  name: "001_identity",
  async up(db) {
    await db.raw(`
      CREATE TABLE users (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email         text NOT NULL UNIQUE CHECK (email = lower(email)),
        password_hash text NOT NULL,
        display_name  text NOT NULL CHECK (char_length(display_name) <= 48),
        totp_secret   text,
        recovery_codes jsonb,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE roles (
        name text PRIMARY KEY,
        rank integer NOT NULL UNIQUE
      );

      CREATE TABLE user_roles (
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role    text NOT NULL REFERENCES roles(name) ON DELETE RESTRICT,
        PRIMARY KEY (user_id, role)
      );

      CREATE TABLE sessions (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        refresh_token_hash text NOT NULL,
        user_agent         text,
        ip                 text,
        created_at         timestamptz NOT NULL DEFAULT now(),
        last_seen_at       timestamptz NOT NULL DEFAULT now(),
        expires_at         timestamptz NOT NULL,
        revoked_at         timestamptz
      );
      CREATE INDEX sessions_user_idx ON sessions (user_id);

      CREATE TABLE password_resets (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash text NOT NULL,
        expires_at timestamptz NOT NULL,
        used_at    timestamptz
      );

      CREATE TABLE teams (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name       text NOT NULL UNIQUE CHECK (char_length(name) <= 48),
        captain_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE team_members (
        team_id  uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role     text NOT NULL DEFAULT 'member' CHECK (role IN ('captain', 'member')),
        added_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (team_id, user_id)
      );
    `);

    // La jerarquía de roles (cap. 16) es catálogo del sistema, no datos de
    // desarrollo: user_roles tiene FK contra roles, así que sin estas filas el
    // registro de CUALQUIER usuario falla ("Key (role)=(user) is not present in
    // table roles"). Antes solo las insertaba seedDev, y por eso una instalación
    // limpia se quedaba sin poder crear el primer usuario.
    await db("roles")
      .insert(ROLES.map((name, rank) => ({ name, rank })))
      .onConflict("name")
      .ignore();
  },
  async down(db) {
    await db.raw(`
      DROP TABLE IF EXISTS team_members, teams, password_resets, sessions, user_roles, roles, users CASCADE;
    `);
  },
};

const m002_content: Migration = {
  name: "002_content",
  async up(db) {
    await db.raw(`
      CREATE TABLE catalog_versions (
        catalog_version text PRIMARY KEY,
        module_count    integer NOT NULL,
        frozen          boolean NOT NULL DEFAULT false,
        imported_at     timestamptz NOT NULL DEFAULT now()
      );

      -- Definiciones inmutables del catálogo E3 (cap. 10.4). PK compuesta: una
      -- versión de módulo dentro de una versión de catálogo NUNCA se sobrescribe.
      CREATE TABLE module_definitions (
        catalog_version text NOT NULL REFERENCES catalog_versions(catalog_version) ON DELETE RESTRICT,
        module_id       text NOT NULL,
        module_version  integer NOT NULL,
        category        text NOT NULL,
        definition      jsonb NOT NULL,
        content_hash    text NOT NULL,
        imported_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (catalog_version, module_id, module_version)
      );

      CREATE TABLE rulesets (
        id                   text PRIMARY KEY,
        name                 text NOT NULL,
        -- ADR-000/D7: budgetCredits SIEMPRE configurable por ruleset.
        budget_credits       integer NOT NULL CHECK (budget_credits BETWEEN 200 AND 5000),
        forbidden_categories jsonb NOT NULL DEFAULT '[]',
        config               jsonb NOT NULL DEFAULT '{}',
        created_at           timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE maps (
        id         text PRIMARY KEY,
        name       text NOT NULL,
        created_by uuid REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE map_versions (
        map_id          text NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
        version         integer NOT NULL CHECK (version >= 1),
        state           text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'validated', 'published')),
        checksum        text,
        width_m         double precision,
        height_m        double precision,
        supported_modes jsonb NOT NULL DEFAULT '[]',
        thumbnail_url   text,
        generation      jsonb,
        content         jsonb NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        published_at    timestamptz,
        PRIMARY KEY (map_id, version)
      );
    `);
  },
  async down(db) {
    await db.raw(`
      DROP TABLE IF EXISTS map_versions, maps, rulesets, module_definitions, catalog_versions CASCADE;
    `);
  },
};

const m003_bots: Migration = {
  name: "003_bots",
  async up(db) {
    await db.raw(`
      CREATE TABLE bots (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name       text NOT NULL CHECK (char_length(name) <= 48),
        -- RESTRICT: no se puede borrar un usuario con bots (DoD T7.1).
        owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        team_id    uuid REFERENCES teams(id) ON DELETE SET NULL,
        visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'team', 'public')),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (owner_id, name)
      );

      -- Revisiones de loadout (cap. 17.2): versionadas por separado del código.
      CREATE TABLE bot_loadouts (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        bot_id          uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        revision        integer NOT NULL CHECK (revision >= 1),
        name            text,
        catalog_version text NOT NULL REFERENCES catalog_versions(catalog_version) ON DELETE RESTRICT,
        chassis         text NOT NULL,
        modules         jsonb NOT NULL,
        summary         jsonb,
        created_at      timestamptz NOT NULL DEFAULT now(),
        UNIQUE (bot_id, revision)
      );

      -- Referencias normalizadas loadout→módulo con ON DELETE RESTRICT: hace
      -- IMPOSIBLE borrar una definición de módulo referenciada por cualquier
      -- loadout (en particular por uno congelado en una inscripción, DoD T7.1).
      CREATE TABLE loadout_modules (
        loadout_id      uuid NOT NULL REFERENCES bot_loadouts(id) ON DELETE CASCADE,
        slot            text NOT NULL,
        catalog_version text NOT NULL,
        module_id       text NOT NULL,
        module_version  integer NOT NULL,
        PRIMARY KEY (loadout_id, slot),
        FOREIGN KEY (catalog_version, module_id, module_version)
          REFERENCES module_definitions(catalog_version, module_id, module_version) ON DELETE RESTRICT
      );

      CREATE TABLE bot_versions (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        bot_id           uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        version          integer NOT NULL CHECK (version >= 1),
        state            text NOT NULL DEFAULT 'draft'
                         CHECK (state IN (${BOT_STATES.map((s) => `'${s}'`).join(", ")})),
        runtime          text NOT NULL CHECK (runtime IN ('python', 'node')),
        loadout_revision integer NOT NULL,
        source           bytea,
        source_filename  text,
        artifact_hash    text,
        code_public      boolean NOT NULL DEFAULT false,
        rejection_reason text,
        suspend_reason   text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        published_at     timestamptz,
        UNIQUE (bot_id, version),
        FOREIGN KEY (bot_id, loadout_revision) REFERENCES bot_loadouts(bot_id, revision) ON DELETE RESTRICT
      );

      CREATE TABLE builds (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        bot_id        uuid NOT NULL,
        version       integer NOT NULL,
        status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'passed', 'failed')),
        stages        jsonb NOT NULL DEFAULT '[]',
        artifact_hash text,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (bot_id, version) REFERENCES bot_versions(bot_id, version) ON DELETE CASCADE
      );

      CREATE TABLE artifacts (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        build_id    uuid NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
        hash        text NOT NULL,
        signature   text,
        size_bytes  bigint,
        storage_ref text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
    `);
  },
  async down(db) {
    await db.raw(`
      DROP TABLE IF EXISTS artifacts, builds, bot_versions, loadout_modules, bot_loadouts, bots CASCADE;
    `);
  },
};

const m004_competition: Migration = {
  name: "004_competition",
  async up(db) {
    await db.raw(`
      CREATE TABLE tournaments (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name               text NOT NULL CHECK (char_length(name) <= 64),
        format             text NOT NULL CHECK (format IN ('league','round_robin','single_elimination','double_elimination','swiss','teams')),
        mode               text NOT NULL CHECK (mode IN ('deathmatch','team_deathmatch','capture_the_flag','zone_control')),
        ruleset_id         text NOT NULL REFERENCES rulesets(id) ON DELETE RESTRICT,
        -- NULL => se usa el budget_credits del ruleset (ADR-000/D7).
        budget_credits     integer CHECK (budget_credits BETWEEN 200 AND 5000),
        catalog_version    text REFERENCES catalog_versions(catalog_version) ON DELETE RESTRICT,
        map_pool           jsonb NOT NULL DEFAULT '[]',
        rounds_per_pairing integer CHECK (rounds_per_pairing >= 1),
        entries_close_at   timestamptz,
        seed_commitment    text,
        seeds_revealed     jsonb,
        state              text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','open','closed','running','finished','cancelled')),
        created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
        created_at         timestamptz NOT NULL DEFAULT now()
      );

      -- Inscripción congela código+loadout juntos (cap. 17.2).
      CREATE TABLE entries (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tournament_id    uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
        bot_id           uuid NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
        version          integer NOT NULL,
        loadout_revision integer NOT NULL,
        frozen           boolean NOT NULL DEFAULT false,
        created_at       timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tournament_id, bot_id),
        FOREIGN KEY (bot_id, version) REFERENCES bot_versions(bot_id, version) ON DELETE RESTRICT,
        FOREIGN KEY (bot_id, loadout_revision) REFERENCES bot_loadouts(bot_id, revision) ON DELETE RESTRICT
      );

      CREATE TABLE matches (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
        round         integer NOT NULL DEFAULT 1,
        state         text NOT NULL DEFAULT 'scheduled' CHECK (state IN ('scheduled','running','finished','failed')),
        created_at    timestamptz NOT NULL DEFAULT now()
      );

      -- Política 23.1: los eventos de batalla viven en archivos (replay_ref);
      -- aquí solo índice, hashes y referencias.
      CREATE TABLE battles (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tournament_id     uuid REFERENCES tournaments(id) ON DELETE SET NULL,
        match_id          uuid REFERENCES matches(id) ON DELETE SET NULL,
        status            text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','running','finished','failed')),
        official          boolean NOT NULL DEFAULT false,
        mode              text NOT NULL,
        ruleset_id        text REFERENCES rulesets(id) ON DELETE RESTRICT,
        map_id            text NOT NULL,
        map_version       integer NOT NULL,
        seed              text,
        seed_commitment   text,
        seed_reveal_proof text,
        engine_versions   jsonb,
        result            jsonb,
        failure_kind      text NOT NULL DEFAULT 'none' CHECK (failure_kind IN ('none','bot_timeout','bot_crash','infrastructure')),
        replay_ref        text,
        replay_hash       text,
        final_state_hash  text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        started_at        timestamptz,
        finished_at       timestamptz,
        FOREIGN KEY (map_id, map_version) REFERENCES map_versions(map_id, version) ON DELETE RESTRICT
      );
      CREATE INDEX battles_status_idx ON battles (status, created_at DESC);

      CREATE TABLE participants (
        battle_id uuid NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
        bot_id    uuid NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
        version   integer NOT NULL,
        team      text NOT NULL,
        outcome   text CHECK (outcome IN ('win','loss','draw','disqualified')),
        PRIMARY KEY (battle_id, bot_id),
        FOREIGN KEY (bot_id, version) REFERENCES bot_versions(bot_id, version) ON DELETE RESTRICT
      );
    `);
  },
  async down(db) {
    await db.raw(`
      DROP TABLE IF EXISTS participants, battles, matches, entries, tournaments CASCADE;
    `);
  },
};

const m005_results: Migration = {
  name: "005_results",
  async up(db) {
    await db.raw(`
      CREATE TABLE battle_stats (
        battle_id uuid NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
        bot_id    uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        stats     jsonb NOT NULL,
        PRIMARY KEY (battle_id, bot_id)
      );

      CREATE TABLE ratings (
        bot_id     uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        season_id  text NOT NULL,
        mode       text NOT NULL,
        rating     double precision NOT NULL,
        wins       integer NOT NULL DEFAULT 0,
        losses     integer NOT NULL DEFAULT 0,
        draws      integer NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (bot_id, season_id, mode)
      );

      CREATE TABLE standings (
        season_id  text NOT NULL,
        mode       text NOT NULL,
        bot_id     uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        rank       integer NOT NULL,
        rating     double precision NOT NULL,
        wins       integer NOT NULL DEFAULT 0,
        losses     integer NOT NULL DEFAULT 0,
        draws      integer NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (season_id, mode, bot_id)
      );

      CREATE TABLE achievements (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind       text NOT NULL,
        data       jsonb NOT NULL DEFAULT '{}',
        awarded_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  },
  async down(db) {
    await db.raw(`
      DROP TABLE IF EXISTS achievements, standings, ratings, battle_stats CASCADE;
    `);
  },
};

const m006_operations: Migration = {
  name: "006_operations",
  async up(db) {
    await db.raw(`
      CREATE TABLE jobs (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind       text NOT NULL,
        payload    jsonb NOT NULL DEFAULT '{}',
        status     text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
        attempts   integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE audit_log (
        id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        actor_id       uuid REFERENCES users(id) ON DELETE SET NULL,
        action         text NOT NULL,
        target         text NOT NULL,
        detail         jsonb NOT NULL DEFAULT '{}',
        correlation_id text,
        at             timestamptz NOT NULL DEFAULT now()
      );

      -- SOLO INSERCIÓN (openapi listAuditLog, E6/T6.4): ni UPDATE ni DELETE existen.
      CREATE FUNCTION audit_log_immutable() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'audit_log es de solo inserción';
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER audit_log_append_only
        BEFORE UPDATE OR DELETE ON audit_log
        FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

      CREATE TABLE security_findings (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind        text NOT NULL CHECK (kind IN ('sandbox_escape_attempt','forbidden_dependency','secret_in_source','resource_limit_exceeded','protocol_abuse')),
        bot_id      uuid REFERENCES bots(id) ON DELETE SET NULL,
        version     integer,
        severity    text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
        detail      text NOT NULL,
        detected_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE api_usage (
        id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        actor_key    text NOT NULL,
        route        text NOT NULL,
        window_start timestamptz NOT NULL,
        count        integer NOT NULL DEFAULT 0,
        UNIQUE (actor_key, route, window_start)
      );
    `);
  },
  async down(db) {
    await db.raw(`
      DROP TABLE IF EXISTS api_usage, security_findings, audit_log, jobs CASCADE;
      DROP FUNCTION IF EXISTS audit_log_immutable CASCADE;
    `);
  },
};

// ---------------------------------------------------------------------------
// E9 · T9.1 — Cola de trabajos durable sobre la tabla `jobs` de E7 (cap. 8).
// La tabla es la FUENTE DE VERDAD del trabajo (sobrevive a Redis); el bloqueo
// distribuido se materializa con locked_by/locked_at + FOR UPDATE SKIP LOCKED.
// `dedupe_key` da idempotencia por inserción (mismo trabajo lógico = una fila).
// `needs_review` es el estado terminal del 19.2 tras agotar reintentos de
// infraestructura: revisión manual, nunca reintento infinito.
const m007_e9_queue: Migration = {
  name: "007_e9_queue",
  async up(db) {
    await db.raw(`
      ALTER TABLE jobs
        ADD COLUMN dedupe_key   text UNIQUE,
        ADD COLUMN locked_by    text,
        ADD COLUMN locked_at    timestamptz,
        ADD COLUMN run_after    timestamptz NOT NULL DEFAULT now(),
        ADD COLUMN max_attempts integer NOT NULL DEFAULT 3,
        ADD COLUMN last_error   text,
        ADD COLUMN error_class  text CHECK (error_class IN ('sporting','infrastructure'));
      ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
      ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
        CHECK (status IN ('queued','running','done','failed','needs_review'));
      CREATE INDEX jobs_claim_idx ON jobs (status, run_after, created_at) WHERE status IN ('queued','running');
    `);
  },
  async down(db) {
    await db.raw(`
      DROP INDEX IF EXISTS jobs_claim_idx;
      UPDATE jobs SET status = 'failed' WHERE status = 'needs_review';
      ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
      ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
        CHECK (status IN ('queued','running','done','failed'));
      ALTER TABLE jobs
        DROP COLUMN dedupe_key,
        DROP COLUMN locked_by,
        DROP COLUMN locked_at,
        DROP COLUMN run_after,
        DROP COLUMN max_attempts,
        DROP COLUMN last_error,
        DROP COLUMN error_class;
    `);
  },
};

// E9 · T9.2/T9.3/T9.4 — calendario materializado, temporadas y auditoría.
//  - matches gana slot/pairing (estructura del bracket con fuentes winner/loser),
//    ganador y marca de final (modo visible, 19.1).
//  - tournaments gana temporada (ratings por temporada, T9.3), K de Elo
//    configurable por liga (ADR-E9-002) y campeón.
//  - battles gana game_index (nº de juego dentro de la serie, para el
//    intercambio de lados de T9.4) y spectator_mode ('delayed' por defecto,
//    E8.M anti-coaching; la final se marca 'visible').
//  - rating_events: libro mayor de rating (T9.3): idempotencia por batalla,
//    reversión de batallas anuladas y reconstrucción histórica.
const m008_e9_competition: Migration = {
  name: "008_e9_competition",
  async up(db) {
    await db.raw(`
      ALTER TABLE matches
        ADD COLUMN slot           text,
        ADD COLUMN pairing        jsonb NOT NULL DEFAULT '{}',
        ADD COLUMN winner_bot_id  uuid REFERENCES bots(id) ON DELETE SET NULL,
        ADD COLUMN winner_team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
        ADD COLUMN final          boolean NOT NULL DEFAULT false;
      CREATE UNIQUE INDEX matches_tournament_slot_idx ON matches (tournament_id, slot);

      ALTER TABLE tournaments
        ADD COLUMN season_id       text NOT NULL DEFAULT 'season-1',
        ADD COLUMN elo_k           double precision NOT NULL DEFAULT 24 CHECK (elo_k > 0),
        ADD COLUMN champion_bot_id uuid REFERENCES bots(id) ON DELETE SET NULL;

      ALTER TABLE battles
        ADD COLUMN game_index     integer NOT NULL DEFAULT 1 CHECK (game_index >= 1),
        ADD COLUMN spectator_mode text NOT NULL DEFAULT 'delayed' CHECK (spectator_mode IN ('delayed','visible'));

      CREATE TABLE rating_events (
        id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        battle_id     uuid NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
        bot_id        uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        bot_version   integer NOT NULL,
        season_id     text NOT NULL,
        mode          text NOT NULL,
        k             double precision NOT NULL,
        rating_before double precision NOT NULL,
        delta         double precision NOT NULL,
        rating_after  double precision NOT NULL,
        reverted      boolean NOT NULL DEFAULT false,
        created_at    timestamptz NOT NULL DEFAULT now(),
        -- Idempotencia (T9.3): una batalla solo puntúa UNA vez por bot.
        UNIQUE (battle_id, bot_id)
      );
      CREATE INDEX rating_events_history_idx ON rating_events (bot_id, season_id, mode, created_at);
    `);
  },
  async down(db) {
    await db.raw(`
      DROP TABLE IF EXISTS rating_events CASCADE;
      ALTER TABLE battles DROP COLUMN game_index, DROP COLUMN spectator_mode;
      ALTER TABLE tournaments DROP COLUMN season_id, DROP COLUMN elo_k, DROP COLUMN champion_bot_id;
      DROP INDEX IF EXISTS matches_tournament_slot_idx;
      ALTER TABLE matches DROP COLUMN slot, DROP COLUMN pairing, DROP COLUMN winner_bot_id, DROP COLUMN winner_team_id, DROP COLUMN final;
    `);
  },
};

// R2.4 (ERR-SEC-08/11) · Familias de refresh tokens y vida máxima absoluta.
//  - sessions.absolute_expires_at: tope ABSOLUTO de la sesión; la rotación del
//    refresh puede renovar expires_at pero NUNCA más allá de este límite.
//  - session_refresh_tokens: historial de TODOS los hashes emitidos para una
//    sesión (= familia). Presentar un hash ya rotado (rotated_at NOT NULL) es
//    señal inequívoca de robo → se revoca la familia entera y se audita.
//    token_hash es UNIQUE global: un hash pertenece a una única familia.
const m009_r24_refresh_families: Migration = {
  name: "009_r24_refresh_families",
  async up(db) {
    await db.raw(`
      ALTER TABLE sessions ADD COLUMN absolute_expires_at timestamptz;

      CREATE TABLE session_refresh_tokens (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        rotated_at timestamptz
      );
      CREATE INDEX session_refresh_tokens_session_idx ON session_refresh_tokens (session_id);
    `);
    // Sesiones vivas previas a la migración: se les materializa su token vigente
    // como cabeza de familia, con el tope absoluto contado desde su creación.
    await db.raw(`
      INSERT INTO session_refresh_tokens (session_id, token_hash, created_at)
        SELECT id, refresh_token_hash, created_at FROM sessions WHERE revoked_at IS NULL
        ON CONFLICT (token_hash) DO NOTHING;
      UPDATE sessions SET absolute_expires_at = created_at + interval '30 days'
        WHERE absolute_expires_at IS NULL;
    `);
  },
  async down(db) {
    await db.raw(`
      DROP TABLE IF EXISTS session_refresh_tokens CASCADE;
      ALTER TABLE sessions DROP COLUMN absolute_expires_at;
    `);
  },
};

// R2.5 (ERR-SEC-12/14/15) — estado de rate-limit/bloqueo en almacén COMPARTIDO
// (tabla api_usage, sobrevive a reinicios del proceso) y bytes del artefacto
// firmado para poder verificar la firma ANTES de cada lanzamiento.
const m010_r25_shared_limits: Migration = {
  name: "010_r25_shared_limits",
  async up(db) {
    await db.raw(`
      -- Expiración de ventanas (limpieza barata por índice) y estado de bloqueo
      -- (fuerza bruta de login) persistente entre reinicios (ERR-SEC-14).
      ALTER TABLE api_usage
        ADD COLUMN expires_at    timestamptz,
        ADD COLUMN blocked_until timestamptz;
      CREATE INDEX api_usage_expiry_idx ON api_usage (expires_at);

      -- Bytes canónicos del artefacto firmado (ERR-SEC-15): sin ellos no hay
      -- nada que verificar contra la firma antes de lanzar. MVP: bytea en BD
      -- (límite 200 MB por config del pipeline); un almacén de objetos externo
      -- puede sustituirlo más adelante vía storage_ref.
      ALTER TABLE artifacts ADD COLUMN bytes bytea;
    `);
  },
  async down(db) {
    await db.raw(`
      ALTER TABLE artifacts DROP COLUMN bytes;
      DROP INDEX IF EXISTS api_usage_expiry_idx;
      ALTER TABLE api_usage DROP COLUMN expires_at, DROP COLUMN blocked_until;
    `);
  },
};

export const MIGRATIONS: Migration[] = [
  m001_identity,
  m002_content,
  m003_bots,
  m004_competition,
  m005_results,
  m006_operations,
  m007_e9_queue,
  m008_e9_competition,
  m009_r24_refresh_families,
  m010_r25_shared_limits,
];

class ProgrammaticMigrationSource {
  getMigrations() {
    return Promise.resolve(MIGRATIONS);
  }
  getMigrationName(migration: Migration) {
    return migration.name;
  }
  getMigration(migration: Migration) {
    return Promise.resolve(migration);
  }
}

const config = { migrationSource: new ProgrammaticMigrationSource() };

export async function migrateToLatest(db: Knex): Promise<void> {
  await db.migrate.latest(config);
}

/** Revierte TODAS las migraciones (test up/down del DoD T7.1). */
export async function rollbackAll(db: Knex): Promise<void> {
  await db.migrate.rollback(config, true);
}
