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
   (**todos** los replays, sin límite de edad; ver [Replays: qué se copia y qué no](#replays-qué-se-copia-y-qué-no)).
3. `manifest.sha256` (incluye el dump) y `manifest.json` (cobertura por fuente).
4. `restic backup --tag s9-arena-data --host $RESTIC_HOSTNAME <staging>` y, aparte,
   `restic backup --tag s9-arena-secrets` de `infrastructure/secrets` (**fuente crítica**).
5. `restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune --host … --group-by host,tags`
   y `restic check --read-data-subset=n/7` (lectura de datos rotativa; ver
   [Verificación de integridad](#verificación-de-integridad-del-repositorio)). Si el check falla, la
   ejecución es `FULL FAILURE`.

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

## Errores / limitaciones

| Síntoma | Causa | Remedio |
|---|---|---|
| `Is there a repository at the following location?` → `FULL FAILURE` | repositorio no inicializado o `RESTIC_REPOSITORY` con errata | `--init-repo` (revisa antes la ruta) |
| «CONFIG INCOMPLETA» y el contenedor reinicia | `RESTIC_HOSTNAME` vacío | definirlo en `.env` |
| «ARRANQUE ABORTADO: backend sftp mal configurado» | falta `ssh`, la clave o `known_hosts` (o está vacío) | rellenar los secretos `restic_ssh_*` |
| `SSH_BOOTSTRAP_RESULT=HOST_KEY_MISMATCH` | la huella del host no coincide con `known_hosts` | verificar el host; nunca desactivar la comprobación |
| `pg_dump FALLÓ` | BD caída o contraseña distinta de `postgres_password` | `$DC ps postgres`, logs |
| Disco del host lleno durante la copia | el staging duplica los volúmenes en `backup_work` | más espacio, mover `WORK_DIR` o, sabiendo lo que se pierde, `REPLAY_BACKUP_MAX_AGE_DAYS` ([estimación](#estimación-de-almacenamiento)) |
| `restic check … FALLÓ` → `FULL FAILURE` | corrupción en el repositorio (p. ej. `Pack ID does not match`) | no borrar nada; inspeccionar el destino, `restic check --read-data` completo y, si se confirma, nuevo repositorio + copia completa |

## Replays: qué se copia y qué no

Cinco conceptos distintos que no se deben mezclar:

| Concepto | Quién lo decide | Regla |
|---|---|---|
| Retención / borrado | `replay-service` (`sweepRetention`) | borra sólo los replays **temporales** caducados; un replay oficial/permanente no se borra nunca |
| Inclusión en el backup | `backup.sh` | **todo** lo que hay en el volumen entra, tenga la edad que tenga (`REPLAY_BACKUP_MAX_AGE_DAYS=0`, valor por defecto). Antes de V1 sólo entraban los de menos de 180 días (AUD2-03): un replay permanente más viejo seguía referenciado en la BD pero salía de la copia |
| Retención de snapshots | restic (`forget` 14 diarios / 8 semanales / 12 mensuales) | un replay vive en la copia mientras algún snapshot lo contenga; al estar siempre en el staging, está en todos |
| Restauración | `restore.sh` | devuelve los bytes tal cual y `--verify` comprueba su checksum del manifest |
| Compatibilidad v1 / 0.5 | motor (ADR-022) | la copia no interpreta el formato. Que un replay restaurado se pueda **verificar** (re-simular) depende de que el motor actual reproduzca su versión; si no, se puede ver pero devuelve `engine_version_mismatch`, lo que no significa que esté manipulado |

`REPLAY_BACKUP_MAX_AGE_DAYS=N` (N > 0) es una política **opcional** de ahorro de staging: excluye los replays de más
de N días fuera de `official/`. Con ella se acepta que ese histórico no está protegido. `REPLAY_RETENTION_DAYS` queda
obsoleta: se ignora y el backup avisa si sigue definida.

### Estimación de almacenamiento

Sea `S` el tamaño medio de un replay (bytes, completo y comprimido en disco tal como lo guarda el replay-service),
`B` batallas por día y `D` días de operación. Los replays permanentes se acumulan; los temporales los barre el replay-service.

- Volumen de replays y **staging** (copia sin comprimir en `backup_work`): `V = S · B · D · p + T`, con `p` la fracción de
  replays permanentes y `T` los temporales vivos (`S · B · ventana_temporales`). El staging necesita `V` más el resto
  de volúmenes (maps, bot_sources, assets) y el dump, **además** del volumen original.
- Repositorio restic: restic deduplica por contenido y comprime (repos v2); un replay que no cambia cuesta una sola vez,
  así que el crecimiento diario del repo es sólo el de los replays **nuevos** (`≈ S · B · p`), no `V` por snapshot.
  Medido en laboratorio con datos sintéticos: 16 MiB de repo para 15,4 MiB de replays (AUD2).
- Coste del cambio respecto a `-mtime -180`: `S · B · p · (D − 180)` de staging para `D > 180`.

Ejemplos (50 kB de replay sintético; 0,5 MB y 5 MB como cotas de replays reales largos; `p = 1`):

| `S` | `B` por día | `D` = 180 | `D` = 365 | `D` = 730 | Coste añadido a 365 d |
|---|---|---|---|---|---|
| 50 kB | 200 | 1,7 GiB | 3,4 GiB | 6,8 GiB | +1,7 GiB |
| 0,5 MB | 200 | 17 GiB | 34 GiB | 68 GiB | +17 GiB |
| 5 MB | 100 | 84 GiB | 170 GiB | 340 GiB | +86 GiB |

Antes de aceptar el valor por defecto, mide `S` y `B` reales en producción con `find <volumen replays> -type f -printf '%s\n'`
(sólo lectura) y comprueba el hueco libre del disco donde vive `backup_work`. Si no hay hueco, la opción no es perder
el histórico en silencio sino fijar `REPLAY_BACKUP_MAX_AGE_DAYS` con conocimiento de causa, o mover `WORK_DIR` a un
disco mayor. Pendiente conocido (AUD2-07): la grabación `video/` del streamer también entra en el staging sin tope.

## Verificación de integridad del repositorio

`restic check` a secas sólo comprueba la **estructura** del repositorio: un pack con bytes corruptos pasa con rc=0
(AUD2-02, probado). `backup.sh` ejecuta ahora `restic check --read-data-subset=n/7`, donde `n` rota cada día
(día-época mod 7 + 1): **todo el repositorio se lee cada 7 días**. Una corrupción en el subconjunto del día da rc≠0 y la
ejecución termina en `FULL FAILURE` (métrica `s9_backup_run_success 0`, healthcheck `UNHEALTHY`).

| Variable | Defecto | Efecto |
|---|---|---|
| `RESTIC_CHECK_MODE` | `subset` | `subset` lee 1/`PARTS` por día; `all` = `--read-data` completo (más lento); `none` = sólo estructura (**no** detecta corrupción de datos) |
| `RESTIC_CHECK_SUBSET_PARTS` | `7` | partes del repositorio; todo se lee cada `PARTS` días |
| `RESTIC_CHECK_SLOT` | vacío | fija la franja (1..`PARTS`) en vez de la rotativa; para pruebas |

Métricas nuevas: `s9_backup_check_ok` (1 bien, 0 fallo, -1 no ejecutado) y `s9_backup_check_read_data_fraction`
(0 = sólo estructura, 1/7 ≈ 0,1429 = subconjunto diario, 1 = todo), para distinguir «estructura» de «datos leídos».

## Estado actual

- **FUNCIONA ACTUALMENTE:** copia diaria con `pg_dump`, volúmenes, secretos en snapshot aparte,
  manifest con checksum del dump, retención y `restic check`; última copia observada correcta el
  2026-10-15 a las 04:15 UTC con `restic check` sin errores.
- **PARCIAL:** sin alertas; el destino de las copias y la máquina que las produce pueden compartir
  dominio de fallo físico; sin snapshots de VM ([TD-007](../roadmap/technical-debt.md#td-007)).
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
