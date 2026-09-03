# Evidencia de la copia de seguridad (CARRIL E)

> `cron alive != backup working`

El healthcheck del servicio `backup` era `pgrep crond`. Ese comando pasa —y deja
el contenedor `healthy`— con la copia fallando todas las noches, que es
literalmente el incidente que este servicio existe para evitar y que este
proyecto ya pagó una vez.

Este documento fija **qué se observa, de dónde sale, qué demuestra, qué no
demuestra y qué puede decidir**.

## Las nueve señales

| Señal | Familia | Fuente / método (solo lectura) | Alimenta readiness |
|---|---|---|---|
| `backup.process_alive` | scheduler | `pgrep crond` dentro del contenedor | **NO, nunca** |
| `backup.last_run_started` | productor | textfile `s9_backup.prom`: `s9_backup_duration_seconds` | No (discriminador) |
| `backup.last_run_success` | productor | `s9_backup_run_success`, `_last_exit_code`, `_postgres_success`, `_restic_snapshot_created`, antigüedad de `_last_success_timestamp_seconds` | Sí, bloqueante |
| `backup.repository_accessible` | repositorio | `restic snapshots --no-lock --json` | Sí, bloqueante y **precondición** |
| `backup.last_snapshot_id` | repositorio | mismo listado, tag `s9-arena-data`, elemento de fecha **máxima** | Sí, bloqueante |
| `backup.last_snapshot_timestamp` | repositorio | campo `time` del snapshot, contra 26 h | Sí, bloqueante |
| `backup.pg_dump_present` | repositorio | `restic ls --no-lock --json <id>`, `pgdump-*.dump` en la raíz del staging | Sí, bloqueante |
| `backup.manifest_verified` | repositorio | `restic dump` de `manifest.json` + `manifest.sha256`, contrastados con el listado real | Sí, bloqueante |
| `backup.pg_dump_sha256` | repositorio | `restic dump` del volcado, sha256 **recalculado** vs. el declarado | Sí, bloqueante **bajo `schema2`**; `not_exercised` con motivo bajo `legacy` |

El detalle de *qué demuestra / qué NO demuestra* de cada una vive en el código,
en `BACKUP_SIGNALS` (`packages/readiness/backup-evidence.ts`), y un test exige
que ninguna se quede sin declararlo.

## Las dos reglas que impiden repetir el incidente

1. **`process_alive` no es elegible para readiness**, ni sola ni sumada. Se
   informa siempre —distingue "el planificador está muerto" de "el planificador
   corre y el trabajo revienta"— pero no puede aprobar nada. La prohibición es
   por FAMILIA (`scheduler`), no por señal, para que añadir mañana otra sonda de
   planificador no reabra el agujero.
2. **Hacen falta dos familias independientes.** El productor (`backup.sh`
   hablando de sí mismo) y el repositorio (lo que hay en el destino) deben
   corroborarse. Sólo con métricas no se puede afirmar que exista un snapshot;
   sólo con el repositorio no se puede afirmar que la última ejecución fuera bien.

## Los dos contratos del manifest

- **`legacy`** — `manifest.json` sin `schema`. El `backup.sh` que escribió esos
  snapshots excluía el `pg_dump` de `manifest.sha256` (`! -path './pgdump-*'`).
  **No hay checksum del volcado que contrastar**: la señal queda `not_exercised`
  CON MOTIVO. Ni se aprueba por omisión, ni se acusa al manifest de corrupto —
  está perfecto para su contrato.
- **`schema2`** — el `backup.sh` de `main`. El volcado entra en el manifest y su
  checksum es exigible; su ausencia es `failed`.

Los 35 snapshots que hay hoy en el repositorio de producción son `legacy`.

## Herramientas

- `infrastructure/backup/evidence.sh` — recolector, **solo lectura**. Toda
  consulta a restic lleva `--no-lock`; nunca ejecuta `backup`, `forget`,
  `prune`, `unlock` ni `check` (`check` toma lock exclusivo y escribe: no es una
  lectura). Emite un documento JSON; no interpreta.
- `packages/readiness/backup-evidence.ts` — interpreta ese documento y emite el
  veredicto con `proves` / `doesNotProve` por señal.
- `infrastructure/backup/healthcheck.sh` — el healthcheck del contenedor. Mira
  la última ejecución registrada (exit 0, postgres ok, snapshot declarado,
  frescura 26 h) y exige crond vivo como condición **necesaria y no suficiente**.
  NO abre el repositorio remoto: hacerlo cada 60 s por sftp metería la red del
  NAS en el estado de salud de un contenedor que sí está sano.

Uso (dentro del contenedor de backup):

```
/usr/local/bin/evidence.sh            # documento JSON de evidencia
/usr/local/bin/evidence.sh --snapshot <id>
```

## Lo que NADA de esto demuestra

Que la copia se pueda **restaurar**. `BACKED_UP != RECOVERY_VERIFIED`: para eso
está el simulacro de `docs/recuperacion.md`, y mientras no se ejecute, la
comprobación `backup.restore_drill` del motor de readiness sigue sin ejercerse.
