# Copias de seguridad

## Resumen

El servicio `backup` del perfil `production` hace cada día un `pg_dump` de PostgreSQL, copia los
volúmenes de contenido y sube todo a un repositorio **restic** (con los secretos en un snapshot
aparte). Este documento explica qué se copia, cómo saber si la copia de anoche está bien, qué
significa cada estado del healthcheck y qué falta. Restauración: [restore.md](restore.md).

## Índice

- [Qué es](#qué-es)
- [Cómo funciona](#cómo-funciona)
- [Puesta en marcha](#puesta-en-marcha)
- [Comprobación diaria](#comprobación-diaria)
- [Estados del healthcheck](#estados-del-healthcheck)
- [Retención](#retención)
- [Copia manual](#copia-manual)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Qué es

| Elemento | Dónde |
|---|---|
| Servicio | `backup` (imagen `…/backup:${BACKUP_TAG}`, Alpine + restic + `pg_dump`), perfiles `production` y `external-db` |
| Scripts | `infrastructure/backup/{entrypoint,backup,restore,healthcheck,evidence}.sh` (copiados a `/usr/local/bin/` en la imagen) |
| Programación | `crond` dentro del contenedor, `BACKUP_CRON` (por defecto `15 4 * * *`, hora del contenedor = UTC) |
| Destino | `RESTIC_REPOSITORY` (SFTP con cuenta confinada por `ChrootDirectory`, o ruta montada) |
| Métricas | `s9_backup_*` en el volumen `infrastructure_backup_metrics` (`/textfile/s9_backup.prom`) |
| Decisión | [ADR-010](../adr/ADR-010-devops-ci-observabilidad-backup.md) |

## Cómo funciona

Cada ejecución de `backup.sh`:

1. `pg_dump -Fc` de la base `arena` con el usuario `arena` (**fuente crítica**).
2. Copia al staging de `arena_maps`, `arena_bot_sources`, `arena_assets` y `arena_replays`
   (replays de menos de `REPLAY_RETENTION_DAYS` días; los de `official/` siempre).
3. `manifest.sha256` (incluye el dump) y `manifest.json` (cobertura por fuente).
4. `restic backup --tag s9-arena-data --host $RESTIC_HOSTNAME <staging>` y, aparte,
   `restic backup --tag s9-arena-secrets` de `infrastructure/secrets` (**fuente crítica**).
5. `restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune --host … --group-by host,tags`
   y `restic check`.

Una fuente no crítica vacía o con error se registra en el manifest y en métricas, pero no impide
la copia de las demás; un fallo de PostgreSQL o de los secretos es `FULL FAILURE`.

El `entrypoint.sh` escribe el crontab, hace un `--dry-run` de validación (si el backend SFTP está
mal configurado **aborta el arranque**) y deja `crond` en primer plano.

## Puesta en marcha

Una vez por instalación ([first-run.md](first-run.md#4-repositorio-de-copias)):

```bash
DC="docker compose -f infrastructure/docker-compose.yml --env-file infrastructure/.env --profile production"
$DC exec backup /usr/local/bin/backup.sh --init-repo
$DC exec backup /usr/local/bin/backup.sh --dry-run    # plan, sin escribir nada
```

`RESTIC_HOSTNAME` debe ser un nombre lógico fijo: con el hostname del contenedor (que cambia en
cada recreación) la retención nunca podaría nada.

## Comprobación diaria

Tres lecturas, de menos a más profundas (ninguna modifica nada):

```bash
# 1. Estado del contenedor y motivo
docker inspect --format '{{.State.Health.Status}}' infrastructure-backup-1
$DC exec backup /usr/local/bin/healthcheck.sh          # imprime BACKUP OK / STARTING / UNHEALTHY: <motivo>

# 2. Últimos snapshots (sin lock)
$DC exec backup sh -c 'restic snapshots --no-lock --latest 3'

# 3. Evidencia completa de un snapshot: dump real, checksum recalculado, manifest (JSON)
$DC exec backup /usr/local/bin/evidence.sh            # o --snapshot <id>
```

Con backend SFTP, `restic` dentro del contenedor necesita el `~/.ssh` que prepara `backup.sh` en
su primera ejecución (ni `evidence.sh` ni una orden `restic` suelta lo preparan): en un contenedor
recién recreado que aún no ha hecho ninguna copia, las lecturas 2 y 3 fallan con
`Host key verification failed` hasta la primera copia.

`evidence.sh` usa siempre `--no-lock`, nunca ejecuta `check`, `forget`, `prune` ni `unlock` y no
imprime secretos ni el destino. Demuestra que la copia **existe y es íntegra**, no que se pueda
**restaurar**: eso sólo lo demuestra un ensayo ([restore.md](restore.md#ensayo)).

Logs de la última ejecución:

```bash
$DC logs --since 26h backup | grep -E 'SUCCESS|FAILURE|ERROR'
```

## Estados del healthcheck

`healthcheck.sh` exige, en este orden: `crond` vivo; fichero de métricas; última ejecución con
código 0, `run_success=1`, `postgres_success=1`, `snapshot_created=1`; y último éxito con
**≤ 26 h** (`BACKUP_MAX_AGE_HOURS`).

| Salida | Estado Docker | Significa |
|---|---|---|
| `BACKUP OK: último éxito hace Nh` | healthy | copia reciente y completa |
| `BACKUP STARTING: sin copia todavía` | healthy | contenedor recién creado, dentro de la ventana de gracia (26 h) |
| `BACKUP UNHEALTHY: el último éxito tiene Nh (> 26h): copia rancia` | unhealthy | típico tras tener la máquina apagada más de un día; vuelve a `healthy` tras la siguiente copia correcta |
| `BACKUP UNHEALTHY: la última ejecución terminó con código …` / `fuente crítica falló` | unhealthy | revisar logs; ver tabla de errores |
| `BACKUP UNHEALTHY: crond no está vivo` | unhealthy | nada disparará la copia |

**Nadie recibe aviso** de un `unhealthy`: no hay alertas desplegadas (el perfil `observability`
no corre). La comprobación diaria es manual ([TD-007](../roadmap/technical-debt.md#td-007)).

## Retención

`--keep-daily 14 --keep-weekly 8 --keep-monthly 12`, agrupada por `host,tags`, aplicada al final de
cada copia correcta. Cambiar `RESTIC_HOSTNAME` deja los snapshots anteriores en un grupo que la
política ya no toca.

> **DANGER** — `restic forget … --prune` a mano
>
> **PRECONDITION:** decisión explícita del operador sobre qué snapshots eliminar, con `--dry-run`
> revisado y una copia del repositorio fuera de este host.
>
> **EFFECT:** borra snapshots y sus datos del repositorio de forma irreversible.
>
> **ROLLBACK:** ninguno. No forma parte de la operación normal: la retención ya la aplica `backup.sh`.

## Copia manual

```bash
$DC exec backup /usr/local/bin/backup.sh
```

Útil tras un apagado largo o antes de una actualización. Escribe en el repositorio (crea un
snapshot y aplica la retención). Duración típica observada: decenas de segundos con el volumen de
datos actual.

**Copia previa a una Release Candidate.** `backup.sh` termina **siempre** en `restic forget … --prune`
([TD-054](../roadmap/technical-debt.md#td-054), `backup.sh:771`), así que una copia manual aplica la
retención del nocturno. Mientras no exista un modo sin retención, la copia previa a la RC (RC1, RC3)
se hace con este rodeo:
- un envoltorio de `restic` en el `PATH` que intercepta **sólo** `forget` y `prune`, devuelve 0 y pasa
  todo lo demás al `restic` real;
- un `RESTIC_HOSTNAME` propio de la RC, para que la copia quede en su grupo de retención y no desplace
  a los nocturnos;
- retirar el envoltorio al acabar;
- comparar la lista de IDs de snapshots antes y después: no debe desaparecer ninguno.

La copia sí actualiza las métricas del contenedor (`last_success` y compañía) como si fuera el
nocturno. Hay que tenerlo en cuenta al leer el healthcheck hasta la siguiente copia programada.

## Errores / limitaciones

| Síntoma | Causa | Remedio |
|---|---|---|
| `Is there a repository at the following location?` → `FULL FAILURE` | repositorio no inicializado o `RESTIC_REPOSITORY` con errata | `--init-repo` (revisa antes la ruta) |
| «CONFIG INCOMPLETA» y el contenedor reinicia | `RESTIC_HOSTNAME` vacío | definirlo en `.env` |
| «ARRANQUE ABORTADO: backend sftp mal configurado» | falta `ssh`, la clave o `known_hosts` (o está vacío) | rellenar los secretos `restic_ssh_*` |
| `SSH_BOOTSTRAP_RESULT=HOST_KEY_MISMATCH` | la huella del host no coincide con `known_hosts` | verificar el host; nunca desactivar la comprobación |
| `pg_dump FALLÓ` | BD caída o contraseña distinta de `postgres_password` | `$DC ps postgres`, logs |
| Disco del host lleno durante la copia | el staging duplica los volúmenes en `backup_work` | más espacio o menos retención de replays |

## Estado actual

- **FUNCIONA ACTUALMENTE:** copia diaria con `pg_dump`, volúmenes, secretos en snapshot aparte,
  manifest con checksum del dump, retención y `restic check`; última copia observada correcta el
  2026-10-22 a las 04:15 UTC (contenedor `healthy`).
- **PARCIAL:** sin alertas; el destino de las copias y la máquina que las produce pueden compartir
  dominio de fallo físico. Hay un snapshot de disco de la VM previo a la RC (2026-10-20,
  *crash-consistent*), pero no un snapshot base mantenido ([TD-007](../roadmap/technical-debt.md#td-007)).
- **DEFERRED (decisión del operador, 2026-10-22):** copia del paquete break-glass fuera del dominio de
  fallo del repositorio y doble custodia de su frase de paso. Es *future hardening*: no bloquea RC3,
  el despliegue ni la activación en el entorno actual. Se mantiene como recomendación
  ([TD-007](../roadmap/technical-debt.md#td-007)).
- **PENDIENTE:** ensayo de restauración reciente ([TD-025](../roadmap/technical-debt.md#td-025)).

## Documentación relacionada

[restore.md](restore.md) · [first-run.md](first-run.md) · [readiness.md](readiness.md) ·
[shutdown.md](shutdown.md) · [docker.md](docker.md#volúmenes) ·
[ADR-010](../adr/ADR-010-devops-ci-observabilidad-backup.md) ·
Históricos: [../history/operaciones/BACKUP_RUNTIME_ALIGNMENT.md](../history/operaciones/BACKUP_RUNTIME_ALIGNMENT.md),
[../testing/drills/backup-evidencia.md](../testing/drills/backup-evidencia.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Qué copia y en qué orden | CODE_VERIFIED | `infrastructure/backup/backup.sh:55-80,531-772` |
| Tags `s9-arena-data` / `s9-arena-secrets`, retención 14/8/12 | CODE_VERIFIED | `backup.sh:747,753,771` |
| `--init-repo` idempotente; nunca automático | CODE_VERIFIED | `backup.sh:505-517` |
| El entrypoint aborta si el SFTP está mal configurado | CODE_VERIFIED | `infrastructure/backup/entrypoint.sh` (dry-run rc=3 → exit 1) |
| Criterios y umbral de 26 h del healthcheck | CODE_VERIFIED | `infrastructure/backup/healthcheck.sh:36-107` |
| `evidence.sh` sólo lectura (`--no-lock`) y sin preparación SSH propia | CODE_VERIFIED | `infrastructure/backup/evidence.sh:1-30,99`; `grep setup_ssh evidence.sh` → 0 |
| Última copia 2026-10-15 04:15 UTC correcta, `restic check` sin errores | RUNTIME_VERIFIED (sólo lectura) | verificación de la consolidación, 2026-10-15 (logs y health del contenedor `backup`) |
| Sin alertas desplegadas | RUNTIME_VERIFIED (auditoría) | perfil `observability` no en ejecución |
| Copia nocturna del 2026-10-22 correcta, contenedor `healthy` | RUNTIME_VERIFIED (sólo lectura, 2026-10-22) | lectura de producción del coordinador de RC3 (sin topología en el repo) |
| Toda ejecución de `backup.sh` aplica `forget --prune` | CODE_VERIFIED | `backup.sh:771` en `4cc7651` |
| Rodeo de la copia previa a la RC (envoltorio de `restic`, `RESTIC_HOSTNAME` propio) | RUNTIME_VERIFIED (RC1, 2026-10-20) | informe privado de RC1; se repite en RC3 |
| Snapshot de disco de la VM previo a la RC | RUNTIME_VERIFIED (RC1, 2026-10-20) | listado de snapshots del hipervisor en RC1 (sin topología en el repo) |
