# ADR-E7-001 — Herramienta de migraciones: Knex Migrate (programático)

- **Estado:** Aceptado
- **Fecha:** 2026-07-16
- **Autor:** E7 · Plataforma Web y API
- **Contexto de tarea:** T7.1 (el dosier exige elegir herramienta por ADR; E7.M lo refuerza para que backups y staging de E10 trabajen contra algo concreto)

## Decisión

Las migraciones del esquema del capítulo 23 se gestionan con **Knex Migrate**, usando una
`MigrationSource` programática (`apps/api/src/db/migrations.ts`): seis migraciones ordenadas
(identidad, contenido, bots, competición, resultados, operación) escritas en **SQL de
PostgreSQL** vía `knex.raw`, aplicadas con `migrateToLatest(db)` y revertidas con
`rollbackAll(db)`. La conexión llega siempre por `DATABASE_URL` (cap. 6.2). CLI:
`npx tsx apps/api/src/db/cli.ts <migrate|rollback|seed>`.

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

## Impacto

- Política 23.1 aplicada en el esquema: `battles` guarda `replay_ref`, hashes y metadatos;
  los eventos masivos viven en archivos de replay (E8), nunca en la BD.
- `audit_log` es de solo inserción a nivel de motor (trigger que rechaza UPDATE/DELETE).
- La inmutabilidad del catálogo y la protección de loadouts congelados se apoyan en FKs
  `ON DELETE RESTRICT` (`loadout_modules` → `module_definitions`, `bots.owner_id` → `users`).
