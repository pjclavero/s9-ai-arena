# Readiness (R17)

## Resumen

«Readiness» responde a «¿esta instalación está lista para producción?». Existe como motor de
comprobaciones en `packages/readiness/` y un CLI (`scripts/readiness.ts`) que se ejecuta **a mano
en el host**. **No está desplegado** como servicio ni como pantalla, y con el CLI actual el
veredicto **nunca puede ser `READY`** porque varias comprobaciones obligatorias no se ejercen.

## Índice

- [Qué es](#qué-es)
- [Cómo funciona](#cómo-funciona)
- [Uso](#uso)
- [Comprobaciones](#comprobaciones)
- [Qué NO mide](#qué-no-mide)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Qué es

| Pieza | Ruta |
|---|---|
| Catálogo de comprobaciones | `packages/readiness/checks.ts` |
| Motor y veredicto | `packages/readiness/engine.ts`, `report.ts` |
| Contrato de configuración | `packages/readiness/config.ts` |
| Sondas | `probes-local.ts` (las que usa el CLI), `probes-docker.ts`, `probes-backup.ts`, `probes-overrides.ts`, `backup-evidence.ts` |
| CLI | `scripts/readiness.ts` |
| Mutaciones (calibración) | `packages/readiness/mutations.ts` |
| Asistente de primer arranque (librería) | `packages/first-run/` (13 dominios) |

## Cómo funciona

Cada comprobación tiene un id, es `required` o no, y su sonda devuelve un resultado **observado**
o «no ejercida con motivo». Regla de diseño: **«no he mirado» nunca cuenta como verde**. El
veredicto es `READY` sólo si todas las obligatorias pasan; el CLI sale con código distinto de 0 en
cualquier otro caso.

## Uso

En el host, con Node ≥ 22.15 y `npm ci` hecho en el clon:

```bash
# Sólo la sonda local de escritura en disco; el resto queda NO EJERCIDA
npx tsx scripts/readiness.ts

# Con sondas de solo lectura contra los contenedores de la instalación
S9_READINESS_CONTAINER=infrastructure-api-1 \
S9_READINESS_BACKUP_CONTAINER=infrastructure-backup-1 \
S9_READINESS_REPO=/opt/s9-ai-arena \
  npx tsx scripts/readiness.ts

# Autodiagnóstico del motor con un escenario sintético (NO dice nada de tu instalación)
npx tsx scripts/readiness.ts --selftest
```

Las sondas Docker leen el daemon en solo lectura (`docker inspect`, métricas del backup,
`restic snapshots --no-lock`). No hacen cambios.

## Comprobaciones

| Id | Obligatoria | Qué mira | Con el CLI de hoy |
|---|---|---|---|
| `storage.writable` | sí | escribe y relee un fichero en el directorio de datos | se ejerce |
| `backup.process_alive` | no | el contenedor de backup corre | con `S9_READINESS_BACKUP_CONTAINER` |
| `backup.last_run_success` | sí | métricas de la última copia | con `S9_READINESS_BACKUP_CONTAINER` |
| `backup.last_snapshot_verified` | sí | último snapshot en el repositorio | con `S9_READINESS_BACKUP_CONTAINER` |
| `backup.pg_dump_checksum_verified` | sí | releer el dump almacenado y su hash | **nunca** (extraer datos no es una consulta) |
| `backup.restore_verified` | sí | simulacro de restauración | **nunca** (escribe en un destino) |
| `security.secret_mounted` | sí | secretos montados y legibles | **nunca** (sonda no implementada) |
| `security.deployed_version` | sí | versión del contenedor en marcha (ADR-016) | con `S9_READINESS_CONTAINER` |
| `security.version_overrides` | no | overrides `*_TAG` presentes | con `S9_READINESS_REPO` |
| `security.version_overrides_declared` | sí | overrides declarados en el contrato | con `S9_READINESS_REPO` |
| `diagnostics.db_canary` | sí | consulta canaria a la BD | **nunca** (sonda no implementada) |
| `diagnostics.bundle_redacted` | no | paquete de diagnóstico sin secretos | nunca |

Más la comprobación de la puerta de ejecución (`gateState`), también sin sonda real.

## Qué NO mide

- No comprueba la funcionalidad del producto (build de bots, batallas, replays): una instalación
  podría dar verde en todo lo anterior y seguir sin ejecutar código de usuario
  ([TD-001](../roadmap/technical-debt.md#td-001), [TD-002](../roadmap/technical-debt.md#td-002)).
- No mide producción por sí solo: hay que pasarle los contenedores.
- No mide la frontera de privilegio del proxy de Docker del host (proceso fuera de Compose): eso lo
  hace `sudo bash infrastructure/scripts/install-docker-proxy.sh preflight` (rc 0 obligatorio antes de
  activar la ejecución real; [docker-proxy.md](docker-proxy.md#validación), [TD-062](../roadmap/technical-debt.md#td-062)).
- Con 9 de 12 imágenes desplegadas sin identidad de build, `security.deployed_version` falla en la
  instalación de referencia ([TD-006](../roadmap/technical-debt.md#td-006)).

Las puertas de activación de ejecución real y de espectador público tienen su propio
procedimiento: [../technical/battles.md](../technical/battles.md) y
[../technical/replays.md](../technical/replays.md).

## Estado actual

- **FUNCIONA ACTUALMENTE:** motor, catálogo, CLI con sondas de solo lectura, autoprueba y mutantes.
- **PARCIAL:** cinco obligatorias no se pueden ejercer desde el CLI → veredicto siempre distinto de
  `READY`.
- **PENDIENTE:** readiness desplegado (servicio o pantalla) y sondas restantes
  ([TD-024](../roadmap/technical-debt.md#td-024)).

## Documentación relacionada

[first-run.md](first-run.md) · [backup.md](backup.md) · [diagnostics.md](diagnostics.md) ·
[upgrades.md](upgrades.md) · Diseño original (histórico, con ids y cifras ya superados):
[../history/operaciones/R17_INSTALACION_READINESS.md](../history/operaciones/R17_INSTALACION_READINESS.md),
[../history/operaciones/R17_ASISTENTE_PRIMER_ARRANQUE.md](../history/operaciones/R17_ASISTENTE_PRIMER_ARRANQUE.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Ids y `required` de las comprobaciones | CODE_VERIFIED | `packages/readiness/checks.ts:18-635` |
| El CLI usa `localProbes()`; sale 0 sólo con `READY` | CODE_VERIFIED | `scripts/readiness.ts:12-31` |
| Sondas no ejercidas: pg_dump checksum, restore drill, secret mounted, db canary, bundle, gate | CODE_VERIFIED | `packages/readiness/probes-local.ts:62-113` |
| Variables `S9_READINESS_*` activan las sondas de solo lectura | CODE_VERIFIED | `probes-local.ts:55-87`; `config.ts:270-281` |
| Ninguna app ni servicio ejecuta readiness | CODE_VERIFIED | sin referencias desde `apps/` ni el compose |
