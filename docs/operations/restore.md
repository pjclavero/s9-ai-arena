# Restauración

## Resumen

Cómo recuperar la plataforma en un **host nuevo** (o un entorno aislado de ensayo) a partir del
repositorio restic: secretos, datos, base de datos y volúmenes, con verificación de integridad.
Corrige los errores de los runbooks anteriores: los volúmenes reales se llaman
`infrastructure_*`, el usuario de base de datos es `arena`, la versión a desplegar es un
`sha-<commit>` conocido (no `v0.0.0`) y la verificación usa rutas que existen.

## Índice

- [Qué es](#qué-es)
- [Custodia](#custodia)
- [Elegir el snapshot](#elegir-el-snapshot)
- [Fase 1 · Host limpio](#fase-1--host-limpio)
- [Fase 2 · Secretos](#fase-2--secretos)
- [Fase 3 · Datos](#fase-3--datos)
- [Fase 4 · Configuración, imágenes y contenedores](#fase-4--configuración-imágenes-y-contenedores)
- [Fase 5 · Base de datos](#fase-5--base-de-datos)
- [Fase 6 · Volúmenes](#fase-6--volúmenes)
- [Fase 7 · Arranque y verificación](#fase-7--arranque-y-verificación)
- [Restaurar el estado de RC1](#restaurar-el-estado-de-rc1)
- [Ensayo](#ensayo)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Qué es

`infrastructure/backup/restore.sh` es la herramienta de restauración:

| Orden | Hace |
|---|---|
| `restore.sh --list` | lista snapshots |
| `restore.sh --restore <destino> [--snapshot <id> \| --latest]` | restaura el snapshot de **datos** (`s9-arena-data`) en `<destino>`; sin selector = `latest` |
| `restore.sh --restore-secrets <destino> [--snapshot <id> \| --latest]` | restaura el snapshot de **secretos** (`s9-arena-secrets`) |
| `restore.sh --verify <dir>` | verifica `manifest.sha256` (falla si hay 0 o más de 1 manifest) |
| `restore.sh --dry-run` | imprime el plan sin tocar nada |

Un `--snapshot` inexistente, o de la etiqueta equivocada, **falla cerrado**; nunca cae a `latest`.
El ID pedido y el resuelto quedan en el log JSON. Con backend SFTP el script prepara `~/.ssh` a
partir de `RESTIC_SSH_KEY_FILE` y `RESTIC_SSH_KNOWN_HOSTS_FILE` e imprime
`SSH_BOOTSTRAP_RESULT=<OK|HOST_KEY_MISMATCH|AUTH_FAILURE|NETWORK_FAILURE|UNKNOWN_ENDPOINT>` antes
de llamar a restic.

`restore.sh` **no** escribe en volúmenes ni en la base de datos: deja los datos en un directorio;
las fases 5 y 6 los colocan.

## Custodia

Sin estos tres elementos, **guardados fuera del servidor**, no hay restauración posible: la
contraseña del repositorio (`restic_password`), la clave SSH (`restic_ssh_key`) y el
`restic_ssh_known_hosts` verificado. Viajan también dentro del snapshot de secretos, pero ese
snapshot está en el repositorio al que sólo se llega con ellos. Además conviene custodiar el
contenido de `infrastructure/.env` (no está en el backup) y el **commit/etiqueta desplegados**.

## Elegir el snapshot

```bash
bash infrastructure/backup/restore.sh --list
```

Anota el ID exacto del snapshot de datos y del de secretos **en el momento de decidir** y úsalos con
`--snapshot <id>`. `--latest` sólo es aceptable si decisión y ejecución son el mismo instante: entre
ambas el cron puede haber subido otro snapshot (ocurrió en el simulacro de agosto de 2026).

## Fase 1 · Host limpio

Requisitos de [installation.md](installation.md#1-prerrequisitos) más `restic` en el host.

```bash
git clone https://github.com/pjclavero/s9-ai-arena.git /opt/s9-ai-arena
cd /opt/s9-ai-arena
git checkout <commit-desplegado>
```

## Fase 2 · Secretos

```bash
export RESTIC_REPOSITORY='<repositorio>'
export RESTIC_PASSWORD_FILE=<ruta al fichero custodiado, 0600>
export RESTIC_SSH_KEY_FILE=<ruta a la clave custodiada, 0600>
export RESTIC_SSH_KNOWN_HOSTS_FILE=<ruta al known_hosts verificado>
bash infrastructure/backup/restore.sh --restore-secrets /tmp/restore-secrets --snapshot <id-secretos>
mkdir -p infrastructure/secrets
cp -a /tmp/restore-secrets/secrets/. infrastructure/secrets/      # comprobar antes la ruta interna con ls (sin cat)
rm -rf /tmp/restore-secrets
```

No imprimas ni copies los secretos a pantalla o logs. Comprueba dueño y permisos (uid 1000, `0400`).

## Fase 3 · Datos

```bash
bash infrastructure/backup/restore.sh --restore /tmp/restore-data --snapshot <id-datos>
STAGE="$(dirname "$(find /tmp/restore-data -name manifest.sha256)")"
echo "STAGE=$STAGE"     # debe ser un único directorio .../staging
bash infrastructure/backup/restore.sh --verify /tmp/restore-data   # integridad ANTES de colocar nada
```

## Fase 4 · Configuración, imágenes y contenedores

1. Repón `infrastructure/.env` desde la copia custodiada. Si no la hay, parte de
   `infrastructure/.env.example` y fija **como mínimo** `TAG` y `BACKUP_TAG` a la etiqueta
   `sha-<commit>` del último despliegue conocido (no `v0.0.0`, que es móvil, ni `latest`, que no
   existe), `RESTIC_REPOSITORY`, `RESTIC_HOSTNAME` (el **mismo** que antes) y los parámetros de red
   ([configuration.md](configuration.md)).
2. Descarga, crea contenedores y volúmenes sin arrancar nada, y arranca sólo PostgreSQL:

```bash
DC="docker compose -f infrastructure/docker-compose.yml --env-file infrastructure/.env --profile production"
$DC pull
$DC create --no-build          # crea contenedores y volúmenes infrastructure_* con las etiquetas de Compose
$DC start postgres
```

## Fase 5 · Base de datos

> **DANGER** — `pg_restore -c`
>
> **PRECONDITION:** PostgreSQL **recién creado** de este host de recuperación, sin datos que
> conservar; ningún otro servicio arrancado; `STAGE` verificado en la fase 3.
>
> **EFFECT:** borra (`-c --if-exists`) y recrea todos los objetos de la base `arena` desde el dump.
> Ejecutado contra una base viva, **sustituye los datos actuales** por los del snapshot.
>
> **ROLLBACK:** ninguno sobre la misma base; sólo otra restauración.

```bash
DUMP=$(find "$STAGE" -maxdepth 1 -name 'pgdump-*.dump' | sort | tail -1)
$DC cp "$DUMP" postgres:/tmp/restore.dump
$DC exec postgres sh -c 'pg_restore -c --if-exists -U arena -d arena /tmp/restore.dump && rm /tmp/restore.dump'
```

Usuario **`arena`**: el rol `postgres` no existe en esta instalación.

## Fase 6 · Volúmenes

Nombres de staging → volúmenes reales del proyecto `infrastructure`:

```bash
declare -A VOLUME_FOR=( [maps]=infrastructure_arena_maps [bot_sources]=infrastructure_arena_bot_sources \
                        [replays]=infrastructure_arena_replays [assets]=infrastructure_arena_assets )
for name in maps bot_sources replays assets; do
  src="$STAGE/$name"
  [ -d "$src" ] || { echo "skip $name (vacío o con error en este backup)"; continue; }
  docker volume inspect "${VOLUME_FOR[$name]}" >/dev/null || { echo "FALTA ${VOLUME_FOR[$name]}: ¿se hizo la fase 4?"; break; }
  docker run --rm -v "${VOLUME_FOR[$name]}:/dst" -v "$src:/src:ro" alpine:3.20 sh -c 'cp -a /src/. /dst/'
done
```

La comprobación `docker volume inspect` evita el fallo de los runbooks anteriores: un nombre de
volumen erróneo en `docker run -v` **crea un volumen nuevo vacío** y la restauración «sale bien» sin
restaurar nada.

## Fase 7 · Arranque y verificación

```bash
$DC up -d --no-build
$DC ps --format '{{.Service}} {{.Status}}'
curl -s http://127.0.0.1:${HTTP_PORT:-80}/healthz
curl -s http://127.0.0.1:${HTTP_PORT:-80}/api/v1/healthz
$DC exec postgres psql -U arena -d arena -tAc "SELECT count(*) FROM users;"   # comparar con lo esperado
$DC exec -w /app api npx tsx apps/api/src/db/cli.ts migrate                   # aplica migraciones si el código es más nuevo que el dump
rm -rf /tmp/restore-data                                                       # no dejar datos en claro
```

`/api/v1/healthz` **no** informa de migraciones; no uses `/api/healthz` ni `smoke.sh` como
criterio ([TD-020](../roadmap/technical-debt.md#td-020)). Lanza después una copia manual
([backup.md](backup.md#copia-manual)) para comprobar que el nuevo host también copia.

## Restaurar el estado de RC1

Aplica cuando se vuelve al estado anterior a la RC3 restaurando la VM entera (el snapshot de disco
previo a la RC, del 2026-10-20) o reconstruyendo el host con la configuración de RC1. En ese estado la
unidad instalada del proxy de Docker es la de RC1 (`npx tsx` desde el árbol de despliegue) y, en el
snapshot, está **`enabled` y en marcha**: con ella vuelve TD-062
([technical-debt.md](../roadmap/technical-debt.md#td-062)).

**Política del operador:** el proxy antiguo queda **parado y deshabilitado**, nunca `enabled`. La
restauración **no está completa** mientras el proxy antiguo pueda arrancar solo. Tras restaurar y
**antes de exponer la VM** (antes de devolverle la red pública o el reenvío del gateway):

```bash
systemctl stop s9-docker-proxy
systemctl disable s9-docker-proxy
systemctl is-enabled s9-docker-proxy        # debe decir disabled
systemctl is-active s9-docker-proxy         # debe decir inactive
ss -ltnH 'sport = :2375' | wc -l            # debe ser 0
```

Si cualquiera de las tres comprobaciones falla, **no expongas la VM**. El fichero de la unidad se
conserva; no lo borres ni hagas el chown de TD-057. Pararlo no degradó los servicios cuando se hizo en producción el
2026-10-22 (12 `healthy`, gateway 200); los builds de bots se quedan sin sandbox y fallan cerrados. Después, la
vuelta a la versión nueva sigue [upgrades.md](upgrades.md#rc3-orden-del-despliegue-de-4cc7651).

## Ensayo

El ensayo se hace en un **host aislado**, nunca sobre la instalación productiva, y se registra con
fecha, snapshot restaurado, tiempos por fase y resultado de `--verify`. El último ensayo completo
documentado es de agosto de 2026 (citado en [../recuperacion.md](../recuperacion.md) y en la cabecera de `restore.sh`);
no hay uno posterior ([TD-025](../roadmap/technical-debt.md#td-025)).

## Errores / limitaciones

| Síntoma | Causa | Remedio |
|---|---|---|
| `SSH_BOOTSTRAP_RESULT=HOST_KEY_MISMATCH` (y luego `unexpected EOF`) | huella del host distinta de la custodiada | verificar el host de respaldo; no desactivar la comprobación |
| `--snapshot` falla «no existe / no tiene el tag» | ID equivocado o de la otra etiqueta | `--list` y usar el ID de `s9-arena-data` o `s9-arena-secrets` según el caso |
| `--verify` «no encontrado» o «ambiguo» | 0 o varios `manifest.sha256` bajo el directorio | restaurar en un directorio vacío |
| Snapshot antiguo: «el dump de PostgreSQL NO tiene checksum» | snapshot anterior al manifest con dump | aceptable, pero la integridad del dump no queda probada |
| Volumen vacío tras restaurar | nombre de volumen equivocado | usar los `infrastructure_*` y la comprobación de la fase 6 |
| `role "postgres" does not exist` | comando antiguo con `-U postgres` | `-U arena` |
| Rollback a nivel de VM | la instalación de referencia sólo tiene el snapshot de disco previo a la RC (2026-10-20, *crash-consistent*) | restauración desde restic; el snapshot es último recurso para volver a antes de la RC ([TD-007](../roadmap/technical-debt.md#td-007)); tras restaurarlo, proxy antiguo parado y deshabilitado antes de exponer la VM ([Restaurar el estado de RC1](#restaurar-el-estado-de-rc1)) |

## Estado actual

- **FUNCIONA ACTUALMENTE:** `restore.sh` con selección de snapshot, preparación SSH y verificación
  de manifest (cubierto por E2E en CI: `e2e-restore-sftp-bootstrap`).
- **PARCIAL:** la colocación en BD y volúmenes es manual; el último ensayo completo es de agosto.
- **PENDIENTE:** ensayo periódico registrado ([TD-025](../roadmap/technical-debt.md#td-025)).

## Documentación relacionada

[backup.md](backup.md) · [installation.md](installation.md) · [docker.md](docker.md#volúmenes) ·
[../technical/database.md](../technical/database.md) · [ADR-010](../adr/ADR-010-devops-ci-observabilidad-backup.md) ·
Runbook anterior (histórico, con errores conocidos): [../recuperacion.md](../recuperacion.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Opciones de `restore.sh`, incluido `--snapshot <id>`; sin selector = `latest`; fallo cerrado | CODE_VERIFIED | `infrastructure/backup/restore.sh:1-34,456-506`; también presente en la imagen de backup `ad0a42b` desplegada (`git show ad0a42b:infrastructure/backup/restore.sh`) |
| `SSH_BOOTSTRAP_RESULT` y preparación de `~/.ssh` | CODE_VERIFIED | `restore.sh:123-196`; `infrastructure/backup/lib/setup-ssh.sh` |
| Tags `s9-arena-data`/`s9-arena-secrets` | CODE_VERIFIED | `infrastructure/backup/backup.sh:747,753`; `restore.sh:514-517` |
| Volúmenes reales `infrastructure_arena_*` | RUNTIME_VERIFIED | `docker compose … config`; auditoría (`docker volume ls` en producción) |
| `docker run -v <nombre-inexistente>` crea un volumen vacío | CODE_VERIFIED (comportamiento de Docker) | documentado en la auditoría 2026-10-15 |
| Rol `arena`; `postgres` no existe | CODE_VERIFIED + RUNTIME_VERIFIED | compose `POSTGRES_USER: arena`; `pg_roles` en el entorno aislado y en la auditoría |
| `/api/v1/healthz` no informa de migraciones | CODE_VERIFIED | `apps/api/src/server.ts:46` |
| `.env` no está en el backup | CODE_VERIFIED | `backup.sh` copia `SECRETS_DIR` (`infrastructure/secrets`), no `infrastructure/.env` |
| `$DC create --no-build` crea los volúmenes del proyecto (y `up` de un subconjunto sólo los de ese subconjunto) | RUNTIME_VERIFIED | entorno aislado: tras `up` de 5 servicios había 3 volúmenes; tras `create --no-build`, los 9 del perfil |
| Bucle de la fase 6 (copia a volumen, `skip` de fuentes ausentes, detección de volumen inexistente) | RUNTIME_VERIFIED | entorno aislado con un staging sintético |
| `restore.sh --dry-run` imprime el plan sin tocar nada | RUNTIME_VERIFIED | ejecutado en la máquina de desarrollo (rc=0) |
| `pg_dump -Fc -U arena arena` funciona con el rol `arena` | RUNTIME_VERIFIED | entorno aislado |
| El snapshot previo a la RC tiene el proxy antiguo `enabled` y en marcha; la política exige `stop` + `disable` antes de exponer | inferido: el proxy antiguo estaba `active`/`enabled` en todas las lecturas de producción anteriores al 2026-10-22 (RC1 y baseline de RC3) + DESIGN_ONLY (política del operador) | lecturas de la RC3 (sin topología en el repo) |

Nota: el resumen de la auditoría 2026-10-15 indica «`restore.sh` solo `latest`»; el código de
`27f70bb` (y el de la imagen desplegada) **sí** admite `--snapshot <id>`. Lo que es cierto es que,
sin selector, restaura `latest`.
