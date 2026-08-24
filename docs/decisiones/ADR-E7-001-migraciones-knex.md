# ADR-E7-001 — Herramienta de migraciones: Knex Migrate (programático)

- **Estado:** Aceptado
- **Fecha:** 2026-07-16
- **Autor:** E7 · Plataforma Web y API
- **Contexto de tarea:** T7.1 (el dosier exige elegir herramienta por ADR; E7.M lo refuerza para que backups y staging de E10 trabajen contra algo concreto)

## Decisión

Las migraciones del esquema del capítulo 23 se gestionan con **Knex Migrate**, usando una
`MigrationSource` programática (`apps/api/src/db/migrations.ts`): migraciones ordenadas
(identidad, contenido, bots, competición, resultados, operación, colas, refresh de familias,
límites compartidos, `cpu_ms` de batalla) escritas en **SQL de PostgreSQL** vía `knex.raw`,
aplicadas con `migrateToLatest(db)`. CLI:
`npx tsx apps/api/src/db/cli.ts <migrate|rollback:1|rollback:all|seed>`.

**Rollback: dos comandos inequívocos, no uno ambiguo.** `rollbackLast(db)` (CLI
`rollback:1`) llama a `db.migrate.down(config)` y revierte **solo la última migración
aplicada** (exactamente una migración, no un lote). `rollbackAll(db)` (CLI `rollback:all`) llama a
`db.migrate.rollback(config, true)` y revierte **TODAS** las migraciones: deja el esquema
reducido a las tablas internas de Knex, destruyendo todos los datos. No hay `rollback` a
secas: el CLI lo rechaza explícitamente pidiendo elegir uno de los dos, para que un
operador que quiera deshacer el último cambio no destruya el esquema entero por error de
nombre. `schema.test.ts` usa `rollbackAll` (revertir todo, DoD up/down completo); el
contrato de `rollbackLast`/`rollback:1` se prueba en `db/cpu-ms.test.ts` (011 → 010).

## Justificación

- Knex es a la vez query builder y migrador: una sola dependencia para la capa de acceso
  de la API y para el versionado de esquema; su tabla `knex_migrations` es trivialmente
  inspeccionable por E10 (backups/staging).
- La `MigrationSource` programática evita el CLI de Knex y sus problemas de loaders con
  TypeScript/ESM en este monorepo (tsx + vitest): las migraciones son módulos importables
  y por tanto testables (el DoD up/down completo corre en `schema.test.ts`).
- SQL crudo, no schema-builder: el esquema usa piezas específicas de PostgreSQL (CHECKs,
  FKs compuestas, `GENERATED ALWAYS AS IDENTITY`, trigger de solo-inserción en
  `audit_log`) que el builder abstrae mal. El SQL es el contrato real con el Postgres
  del servidor.

## Alternativas descartadas

- **Prisma Migrate:** genera cliente y esquema propios; peor encaje con FKs compuestas y
  triggers, y añade un motor de query pesado que la API no necesita.
- **node-pg-migrate:** válido, pero obligaría a mantener dos capas (migrador + builder de
  consultas) donde Knex resuelve ambas.

**`cpu_ms` finito, no solo `>= 0`.** El CHECK de `participants.cpu_ms` (migración
`011_battle_cpu_ms`) es `cpu_ms IS NULL OR (cpu_ms >= 0 AND cpu_ms < 'Infinity'::float8)`.
En PostgreSQL `NaN` y `+Infinity` ordenan por encima de cualquier número finito, así que un
CHECK con solo `>= 0` los deja pasar (`'NaN'::float8 >= 0` es `true`); una sola fila con
`NaN` convierte en `NaN` el `avg`/`sum`/`max` de toda la columna. El `down` de `011` es
**destructivo para los datos**: `DROP COLUMN cpu_ms` borra las medidas ya guardadas, y un
down→up posterior deja la columna presente pero vacía.

## Impacto

- Política 23.1 aplicada en el esquema: `battles` guarda `replay_ref`, hashes y metadatos;
  los eventos masivos viven en archivos de replay (E8), nunca en la BD.
- `audit_log` es de solo inserción a nivel de motor (trigger que rechaza UPDATE/DELETE).
- La inmutabilidad del catálogo y la protección de loadouts congelados se apoyan en FKs
  `ON DELETE RESTRICT` (`loadout_modules` → `module_definitions`, `bots.owner_id` → `users`).
