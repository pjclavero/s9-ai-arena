# ADR-E7-002 — Motor de base de datos en tests: PostgreSQL embebido

- **Estado:** Aceptado
- **Fecha:** 2026-07-16
- **Autor:** E7 · Plataforma Web y API
- **Contexto de tarea:** T7.1–T7.5 (todos los tests de la API tocan BD)

## Contexto

El entorno de desarrollo/CI de este hito no dispone de PostgreSQL local, `psql`, `sudo`
ni Docker, y está prohibido usar bases de datos de producción del homelab. Las
migraciones están escritas en SQL de PostgreSQL (ADR-E7-001) y deben probarse contra ese
motor, no contra una imitación.

## Decisión

Los tests usan el paquete npm **`embedded-postgres`** (`apps/api/src/testing/test-db.ts`):
descarga binarios oficiales de PostgreSQL (18.x, `@embedded-postgres/linux-x64`) y arranca
un clúster efímero a nivel de usuario, sin root, en un puerto libre y un directorio
temporal por archivo de test. **Verificado en este entorno**: initdb + start + query en
~2 s. Los tests ejercitan por tanto el MISMO SQL que correrá contra el PostgreSQL real
del servidor vía `DATABASE_URL`.

## Alternativas descartadas

- **pg-mem:** no soporta triggers plpgsql, FKs compuestas ni `ON CONFLICT` completo; habría
  obligado a rebajar el esquema.
- **SQLite tras la capa de acceso:** motor distinto al de producción; las restricciones y
  tipos (jsonb, timestamptz, identity) divergen justo donde el DoD exige probarlas.
- **Postgres del homelab:** prohibido (producción) y acoplaría los tests a la red.

## Impacto

- `embedded-postgres` es `devDependency`; producción no lo usa (solo `pg` + `DATABASE_URL`).
- Primera instalación descarga ~30 MB de binarios; CI necesita caché de npm para no
  repetir la descarga.
- Honestidad de entrega: los tests de E7 corren contra PostgreSQL 18.4 embebido, no
  contra la versión exacta del servidor; la diferencia de versión se reconciliará cuando
  E10 fije la imagen oficial.
