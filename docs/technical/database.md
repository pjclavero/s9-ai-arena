# Base de datos

## Resumen

PostgreSQL 16.14 es la base de datos de negocio **y** la cola de trabajos. El esquema se define en
código, con 13 migraciones en `apps/api/src/db/migrations.ts` aplicadas mediante Knex, y tiene 35
tablas (33 de negocio más las 2 de control de Knex). **No hay tabla de replays**: los replays viven
en disco. Verificado en `27f70bb`; las migraciones 012 y 013, en `35a4fb9`. Este documento no contiene secretos.

## Índice

- [Migraciones](#migraciones)
- [Cómo se aplican](#cómo-se-aplican)
- [Tablas por área](#tablas-por-área)
- [Quién escribe y quién lee](#quién-escribe-y-quién-lee)
- [Constraints relevantes](#constraints-relevantes)
- [Roles de PostgreSQL](#roles-de-postgresql)
- [Errores / limitaciones](#errores--limitaciones)
- [Verificación](#verificación)

## Migraciones

| Id | Contenido |
|---|---|
| `001_identity` | `users`, `roles`, `user_roles`, `sessions`, `password_resets`, `teams`, `team_members` |
| `002_content` | `catalog_versions`, `module_definitions`, `rulesets`, `maps`, `map_versions` |
| `003_bots` | `bots`, `bot_loadouts`, `loadout_modules`, `bot_versions`, `builds`, `artifacts` |
| `004_competition` | `tournaments`, `entries`, `matches`, `battles`, `participants` |
| `005_results` | `battle_stats`, `ratings`, `standings`, `achievements` |
| `006_operations` | `jobs`, `audit_log`, `security_findings`, `api_usage` |
| `007_e9_queue` | columnas de cola en `jobs` (`run_after`, `error_class`…), estado `needs_review`, índice parcial `jobs_claim_idx` |
| `008_e9_competition` | slot y emparejamiento en `matches`; temporada y K de Elo en `tournaments`; `battles.game_index` y `spectator_mode`; `rating_events` |
| `009_r24_refresh_families` | `sessions.absolute_expires_at`; `session_refresh_tokens` (familias de refresh) |
| `010_r25_shared_limits` | `api_usage.expires_at` y `blocked_until` (límites compartidos); `artifacts.bytes` |
| `011_battle_cpu_ms` | `participants.cpu_ms`, con un CHECK que exige un valor finito |
| `012_bot_versioning` | `bot_versions.source_sha256`, `parent_version` y `validated_build_id`; `artifacts` único por `build_id`; trigger `bot_versions_guard` (inmutabilidad de la versión) |
| `013_battle_claim` | `battles.claimed_by`, `lease_expires_at` y `run_attempts` (reserva atómica con lease); índice `battles_running_lease_idx` |

## Cómo se aplican

Con el CLI `apps/api/src/db/cli.ts`, contra `DATABASE_URL`:

| Comando | Efecto |
|---|---|
| `migrate` | aplica las migraciones pendientes |
| `bootstrap` | `migrate` + contenido base: ruleset `mvp-default`, catálogo y mapa `mvp-arena-01`. Es idempotente |
| `seed` | **sólo para desarrollo**: crea usuarios con contraseña conocida |
| `demo-teams <email>` | equipos y bots de demostración para un usuario que ya existe |
| `rollback:1` | revierte la última migración |
| `rollback:all` | **destructivo**: borra el esquema entero |

Los procedimientos de operación, con sus advertencias, están en
[docs/operations/first-run.md](../operations/first-run.md) y
[docs/operations/upgrades.md](../operations/upgrades.md).

## Tablas por área

| Área | Tablas |
|---|---|
| Identidad | `users`, `roles`, `user_roles`, `sessions`, `session_refresh_tokens`, `password_resets` |
| Equipos | `teams`, `team_members` |
| Contenido | `catalog_versions`, `module_definitions`, `rulesets`, `maps`, `map_versions` |
| Bots | `bots`, `bot_loadouts`, `loadout_modules`, `bot_versions`, `builds`, `artifacts` |
| Competición | `tournaments`, `entries`, `matches`, `battles`, `participants` |
| Resultados | `battle_stats`, `ratings`, `rating_events`, `standings`, `achievements` |
| Operación | `jobs`, `audit_log`, `security_findings`, `api_usage` |
| Control de Knex | `knex_migrations`, `knex_migrations_lock` |

## Quién escribe y quién lee

Se indica el **proceso** que ejecuta el código. Por ejemplo, `battle_stats` lo escribe código de
`apps/replay-service/src/stats.ts`, pero lo ejecuta el tournament-worker.

| Tabla | Escribe | Lee |
|---|---|---|
| `users`, `user_roles`, `sessions`, `session_refresh_tokens`, `password_resets` | api | api |
| `roles` | sólo la migración (valores fijos) | api |
| `teams`, `team_members` | api; CLI `demo-teams` | api |
| `catalog_versions`, `module_definitions` | api; `bootstrap` | api, tournament-worker |
| `rulesets` | **sólo `bootstrap`/`seed`**; ninguna ruta de la API crea rulesets | api, tournament-worker |
| `maps`, `map_versions` | **api** (import, borrador, generación, publicación); `bootstrap` | api, tournament-worker |
| `bots`, `bot_loadouts`, `loadout_modules` | api | api, tournament-worker |
| `bot_versions` | api (alta y transiciones); bot-build-worker (resultado del build) | api, tournament-worker |
| `builds`, `artifacts` | api (alta del build); bot-build-worker (pipeline) | api, bot-build-worker |
| `tournaments`, `entries` | api; tournament-worker (estado) | api, tournament-worker |
| `matches` | tournament-worker | api |
| `battles` | api (alta `scheduled`); tournament-worker (`running`/`finished`/`failed`, resultado, `replay_ref`, hashes) | api, tournament-worker |
| `participants` | api (alta); tournament-worker (`outcome`); api (`cpu_ms`, sólo en el camino real) | api, tournament-worker, cálculo de estadísticas |
| `battle_stats` | tournament-worker (código de `replay-service/src/stats.ts`) | api |
| `ratings`, `rating_events` | tournament-worker (sólo en batallas `official`) | api |
| `standings` | tournament-worker (handler `update_standings`, código de `api/src/services/standings.ts`) | api |
| `jobs` | api (encola `run_battle`, `generate_schedule`, `tournament_dry_run`, `bot_build`); tournament-worker (encola `process_result`, `update_standings`, `run_battle` de calendario); ambos workers (claim y cierre) | workers |
| `audit_log` | api y bot-build-worker (código de `apps/api/src/audit.ts`) | api (admin) |
| `security_findings` | **ningún escritor en el código de producción** | api (admin) |
| `api_usage` | api (limitadores y bloqueo de login) | api |
| `achievements` | ninguno | ninguno |

## Constraints relevantes

| Constraint | Dónde |
|---|---|
| `users.email` en minúsculas y único; `display_name` ≤ 48 | `migrations.ts:40-42` |
| `team_members.role` ∈ {`captain`, `member`} | `:91` |
| `rulesets.budget_credits` entre 200 y 5000 | `:142` |
| `map_versions.state` ∈ {`draft`, `validated`, `published`}; PK (`map_id`, `version`) | `:158` |
| `bots.visibility` ∈ {`private`, `team`, `public`}; único (`owner_id`, `name`) | `:189` |
| `bot_versions.state` ∈ los 8 estados de `BOT_STATES`; `runtime` ∈ {`python`, `node`} | `:23-32`, `:227-228` |
| `builds.status` ∈ {`queued`, `running`, `passed`, `failed`} | `:246` |
| `tournaments.format` (6 formatos), `mode` (4 modos), `state` (6 estados) | `:279-290` |
| `battles.status` ∈ {`scheduled`, `running`, `finished`, `failed`}; `failure_kind` ∈ {`none`, `bot_timeout`, `bot_crash`, `infrastructure`} | `:323`, `:334` |
| `participants.outcome` ∈ {`win`, `loss`, `draw`, `disqualified`} | `:350` |
| `jobs.status` ∈ {`queued`, `running`, `done`, `failed`, `needs_review`}; índice parcial de claim | `:497-498` |
| `matches` (`tournament_id`, `slot`) único | `:540` |
| `participants.cpu_ms` finito y ≥ 0 | `:664` |

La unicidad `bots (owner_id, name)` es la que produce un 500 cuando se crea dos veces seguidas
el mismo bot ([TD-013](../roadmap/technical-debt.md#td-013)).

## Roles de PostgreSQL

El compose crea un único rol, `arena`, propietario y superusuario de la BD `arena`. **No existe el
rol `postgres`**, así que cualquier comando que use `-U postgres` falla. Las copias usan `-U arena`
(`infrastructure/backup/backup.sh`).

## Errores / limitaciones

- No hay tabla de replays. Si se pierde el volumen `arena_replays`, quedan `replay_ref` que apuntan a ficheros inexistentes.
- `rulesets` sólo contiene lo que siembre `bootstrap`. La web los lee de `GET /rulesets` ([TD-003](../roadmap/technical-debt.md#td-003), cerrada).
- `achievements` y `security_findings` no tienen escritor.
- La API y el worker comparten el mismo rol de BD, sin separación de privilegios.

## Documentación relacionada

- [queue.md](queue.md) · [services.md](services.md) · [battles.md](battles.md) · [replays.md](replays.md)
- [docs/operations/backup.md](../operations/backup.md) · [docs/operations/restore.md](../operations/restore.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| 13 migraciones y sus tablas | CODE_VERIFIED | `apps/api/src/db/migrations.ts` (`name: "0xx_…"`, `CREATE TABLE`) |
| 11 migraciones aplicadas y 35 tablas en producción (antes de RC4; 012 y 013 no crean tablas) | RUNTIME_VERIFIED (en la auditoría) | `knex_migrations` y `\dt` (sólo lectura) |
| Comandos del CLI | CODE_VERIFIED | `apps/api/src/db/cli.ts:2-69` |
| Contenido de `bootstrap` | CODE_VERIFIED | `apps/api/src/db/seeds/dev.ts:75-95` |
| Escritores y lectores | CODE_VERIFIED | análisis de `db("<tabla>")…insert/update` y SQL crudo en `apps/*/src` (sin tests) |
| `security_findings` sin escritor | CODE_VERIFIED | mismo análisis; `apps/bot-manager/src/audit.ts` es un almacén en memoria |
| Rol único `arena` | CODE_VERIFIED + RUNTIME_VERIFIED (en la auditoría) | `infrastructure/docker-compose.yml` (`POSTGRES_USER`); `pg_roles` |
| Constraints | CODE_VERIFIED | líneas citadas en `migrations.ts` |
