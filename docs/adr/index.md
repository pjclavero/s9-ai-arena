# Registro de decisiones de arquitectura (ADR)

## Resumen

Las decisiones de arquitectura del proyecto, con su número original. Hasta la consolidación de
2026-10 vivían en `docs/decisiones/` (y el ADR de WebRTC suelto en `docs/`). Un ADR registra **por
qué** se decidió algo en su fecha: **no es documentación de estado**. Para saber qué hace hoy el
sistema, ver [../technical/index.md](../technical/index.md) y
[../roadmap/current-status.md](../roadmap/current-status.md).

## Índice de ADR

| ADR | Título | Estado declarado | Notas de vigencia (2026-10) |
|---|---|---|---|
| [ADR-000](ADR-000-decisiones-fundacionales.md) | Decisiones fundacionales | aceptado | cita `packages/game-rules/engine-deps.json`; el fichero está en `apps/arena-engine/src/engine-deps.json`. `packages/game-rules/constants.ts` lo declara su fuente de verdad |
| [ADR-010](ADR-010-devops-ci-observabilidad-backup.md) | DevOps: workspace, versionado, observabilidad y copias | aceptado | la observabilidad descrita no está desplegada; copias en [../operations/backup.md](../operations/backup.md) |
| [ADR-016](ADR-016-identidad-de-build.md) | Identidad de build: procedencia de imagen observable | aceptado | 9 de 12 imágenes de la instalación de referencia no la cumplen ([TD-006](../roadmap/technical-debt.md#td-006)) |
| [ADR-017](ADR-017-contrato-de-release.md) | Contrato de release: BUILD y DEPLOY son fases distintas | aceptado | procedimiento en [../operations/upgrades.md](../operations/upgrades.md) |
| [ADR-018](ADR-018-semantica-del-scan.md) | Semántica del scan: cinco estados | aceptado | aplicado por `infrastructure/scripts/scan-gate.mjs` |
| [ADR-019](ADR-019-perimetro-y-version-del-motor.md) | Perímetro de la arena: el motor pasa a 0.2.0 | aceptado | sustituido en la versión por ADR-020; la regla de versión sigue vigente |
| [ADR-020](ADR-020-spawns-4v4-y-version-del-motor.md) | Spawns seguros para 4v4: el motor pasa a 0.3.0 | aceptado | vigente: `apps/arena-engine/src/engine-deps.json` |
| [ADR-E7-001](ADR-E7-001-migraciones-knex.md) | Migraciones con Knex (programático) | aceptado | vigente: `apps/api/src/db/migrations.ts` |
| [ADR-E7-002](ADR-E7-002-postgres-embebido-en-tests.md) | PostgreSQL embebido en tests | aceptado | vigente ([../development/testing.md](../development/testing.md)) |
| [ADR-E7-003](ADR-E7-003-panel-react-vite.md) | Panel web: React + Vite | aceptado | vigente |
| [ADR-E9-001](ADR-E9-001-cola-postgres-redis.md) | Cola: PostgreSQL como verdad, Redis como despacho | aceptado | vigente; ver [TD-026](../roadmap/technical-debt.md#td-026) (canal de aviso sin productor) |
| [ADR-E9-002](ADR-E9-002-rating-elo.md) | Rating Elo con K por liga | aceptado | vigente |
| [ADR-R14-webrtc](ADR-R14-webrtc.md) | WebRTC para espectadores: no implementar | decidido | el diseño previo está archivado en [../history/disenos/R14_WEBRTC_STREAMING.md](../history/disenos/R14_WEBRTC_STREAMING.md) |

La numeración tiene huecos (001-009, 011-015) heredados del dosier original: no faltan ficheros.

## Cómo añadir un ADR

Nuevo fichero `ADR-<número>-<tema>.md` con: contexto, decisión, alternativas, consecuencias,
estado y fecha. Un ADR aceptado no se reescribe: si la decisión cambia, se crea otro que lo
sustituye y se anota aquí. Ver [../development/workflow.md](../development/workflow.md#5-documentar).

## Documentación relacionada

[../technical/architecture.md](../technical/architecture.md) · [../development/index.md](../development/index.md) ·
[../DOC-MIGRATION-MAP.md](../DOC-MIGRATION-MAP.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Estado declarado de cada ADR | CODE_VERIFIED | cabecera `Estado` de cada fichero |
| `engine-deps.json` en `apps/arena-engine/src/` | CODE_VERIFIED | `git ls-files` en `27f70bb` |
| Movidos con `git mv` desde `docs/decisiones/` y `docs/R14_ADR_WEBRTC.md` | CODE_VERIFIED | historial de esta rama; [../DOC-MIGRATION-MAP.md](../DOC-MIGRATION-MAP.md) |
