# Runbook de recuperación total — S9 AI Arena

Objetivo (DoD T10.4): desde una **VM vacía + el último backup** hasta la
plataforma funcional con datos en **menos de 2 horas**, con verificación de
integridad. Estrategia de copias: ADR-010 D10.4 (pg_dump + restic, cron diario
del servicio `backup` del stack, alerta si falla o si no hay backup en 26 h).

> **Estado del simulacro:** PENDIENTE de entorno con Docker (el entorno de
> desarrollo actual no tiene acceso al daemon). Este runbook está listo para
> ejecutarse; al hacerlo, registrar los tiempos en la tabla del final y
> archivar el resultado en este documento.

## Requisitos previos

- Acceso al repositorio restic (`RESTIC_REPOSITORY`, NAS/ZFS del operador) y a
  su contraseña (`restic_password`, custodiada FUERA del servidor: gestor de
  contraseñas del operador; sin ella no hay recuperación posible).
- **Si el destino es SFTP (fix/backup-sftp-scheduled-runtime,
  fix/restore-sftp-bootstrap):** además hace falta, TAMBIÉN custodiado fuera
  del servidor, el material para alcanzar el host de respaldo por SSH: la
  clave privada `restic_ssh_key` y el `restic_ssh_known_hosts` con la huella
  ya verificada del host. Es el mismo problema del huevo y la gallina que
  `restic_password`: ambos viajan DENTRO del snapshot de secretos
  (`s9-arena-secrets`) por comodidad del día a día, pero ese snapshot vive
  precisamente en el repositorio SFTP al que sólo se llega usando esa misma
  clave — sin una copia fuera del servidor, Fase 2 no puede arrancar. Ver
  `infrastructure/.env.example` para el formato de `RESTIC_REPOSITORY` con
  un host de respaldo confinado (`ChrootDirectory`).
  - `restore.sh` (desde fix/restore-sftp-bootstrap) prepara ~/.ssh por sí
    mismo a partir de `RESTIC_SSH_KEY_FILE`/`RESTIC_SSH_KNOWN_HOSTS_FILE` —
    ya NO hace falta colocar la clave a mano en un contenedor de
    recuperación nuevo (antes de esta rama, `restore.sh` no sabía nada del
    backend sftp y "funcionaba" sólo por rebote, en el MISMO contenedor
    donde ya había corrido `backup.sh`; un contenedor de recuperación
    recién creado fallaba con "Host key verification failed"). Sigue
    haciendo falta que esos dos ficheros existan y sean legibles ANTES de
    invocar `restore.sh` — eso es exactamente lo que dice el riesgo de
    custodia justo abajo.
- Imágenes versionadas en `ghcr.io/pjclavero/s9-ai-arena/*` (las publica la CI
  en cada merge a main, etiquetadas `v<versión>` y `sha-<commit>`).

## Puesta en marcha del repositorio (una sola vez, ANTES del primer backup)

Un repositorio restic no existe hasta que se crea. Mientras no exista, cada
ejecución de `backup.sh` termina en `FULL FAILURE` con este mensaje, que es
el síntoma exacto de que falta este paso y no otra cosa:

```
Fatal: unable to open config file: Lstat: file does not exist
Is there a repository at the following location?
```

Creación, desde el propio contenedor de backup (mismo binario, misma clave y
misma ruta que usará el backup programado):

```bash
docker compose -f infrastructure/docker-compose.yml exec backup \
  /usr/local/bin/backup.sh --init-repo
```

Es **idempotente**: si el repositorio ya existe lo dice y no toca nada.

Este paso es explícito a propósito, y `backup.sh` NO lo hace por su cuenta
durante un backup. Si `restic backup` inicializase el repositorio al no
encontrarlo, una errata en `RESTIC_REPOSITORY` crearía en silencio un
repositorio nuevo y vacío: el backup reportaría éxito, la alerta
`BackupTooOld` se apagaría y el histórico real quedaría huérfano en la ruta
correcta. Ese fallo es peor que no tener backup, porque además oculta que no
lo hay.

## Procedimiento

Cronometrar cada fase (`date` antes y después).

> **fix/restore-snapshot-selection — usa siempre `--snapshot <id>`, nunca la
> ausencia de argumento, para una recuperación de desastre real.** En el
> simulacro del 2026-08-18 se decidió restaurar el snapshot `76a13494`;
> pasaron dos días hasta ejecutar la recuperación, el cron nocturno subió
> snapshots nuevos, y `restore.sh` (que entonces sólo sabía pedir `latest`)
> restauró `4fac59f8` — un snapshot DISTINTO al decidido, sin que nada lo
> avisara salvo revisar el ID a mano después. `--restore`/`--restore-secrets`
> ahora aceptan `--snapshot <id>` para fijar exactamente el snapshot
> conocido-bueno que se decidió restaurar, y siguen aceptando `--latest`
> (o ningún selector, que se comporta igual, por compatibilidad con scripts
> existentes) para el caso de "el más reciente sirve". En una recuperación
> real:
>   1. `bash infrastructure/backup/restore.sh --list` — anota el ID EXACTO
>      del snapshot que decides restaurar, en el momento en que lo decides.
>   2. Usa `--snapshot <ese-id>` en `--restore`/`--restore-secrets`, no
>      `--latest` ni la ausencia de selector — entre la decisión y la
>      ejecución puede pasar tiempo suficiente para que el cron nocturno
>      cambie cuál es el "más reciente", exactamente como pasó en el
>      simulacro. `--latest` sólo es aceptable cuando la decisión y la
>      ejecución son el mismo instante (p.ej. un smoke test rutinario, no
>      una recuperación de desastre).
>   3. El ID resuelto queda siempre en el log JSON de `restore.sh`
>      (`"snapshot solicitado"` antes de tocar el repositorio,
>      `"snapshot resuelto"` justo después) — archívalo junto con el resto
>      de la evidencia del simulacro/incidente.
> Un `--snapshot` con un ID que no existe, o que existe pero pertenece al
> otro tag (p.ej. pedir un snapshot de secretos para `--restore`), falla
> cerrado con un mensaje claro y no restaura nada — nunca cae en silencio a
> `latest`.

### Fase 1 · VM limpia (≈15 min)

```bash
# Debian/Ubuntu con Docker Engine + Compose v2
curl -fsSL https://get.docker.com | sh
git clone https://github.com/pjclavero/s9-ai-arena.git && cd s9-ai-arena
```

### Fase 2 · Restaurar secretos (≈10 min)

```bash
export RESTIC_REPOSITORY=<repositorio>   # y RESTIC_PASSWORD por el operador
# Si RESTIC_REPOSITORY es sftp:..., restore.sh prepara ~/.ssh POR SU CUENTA
# (fix/restore-sftp-bootstrap, mismo bootstrap que usa backup.sh) a partir
# de estas dos variables — deben apuntar a ficheros ya presentes y legibles
# ANTES de este comando (custodiados fuera del servidor, ver Requisitos
# previos): restic no puede alcanzar el repositorio sin ellos, así que no
# hay forma de "restaurarlos desde el propio backup" en este primer paso.
export RESTIC_SSH_KEY_FILE=<ruta a la clave privada custodiada>
export RESTIC_SSH_KNOWN_HOSTS_FILE=<ruta al known_hosts con la huella verificada>
# ID EXACTO decidido al revisar --list (nunca --latest en una recuperación
# real: ver el aviso al principio de "## Procedimiento").
bash infrastructure/backup/restore.sh --restore-secrets /tmp/restore-secrets \
  --snapshot <id-de-secrets-decidido-con---list>
# Colocarlos (rutas con permisos 0600; NUNCA volcarlos a pantalla/logs):
mkdir -p infrastructure/secrets
cp -a /tmp/restore-secrets/secrets/. infrastructure/secrets/
rm -rf /tmp/restore-secrets
cp infrastructure/.env.example infrastructure/.env   # reponer configuración
```

### Fase 3 · Restaurar datos (≈20–40 min según volumen)

```bash
bash infrastructure/backup/restore.sh --list
# ID EXACTO del snapshot de DATOS decidido en el paso anterior — no
# --latest: es el mismo motivo que en Fase 2, y el mismo defecto real
# que el simulacro del 2026-08-18 reprodujo.
bash infrastructure/backup/restore.sh --restore /tmp/restore-data \
  --snapshot <id-de-datos-decidido-con---list>
```

> **#110b:** `backup.sh` sube UN ÚNICO directorio de "staging" a restic (tag
> `s9-arena-data`) con la jerarquía `maps/`, `bot_sources/`, `assets/`,
> `replays/`, el dump de PostgreSQL y los dos manifests, todo junto y en las
> mismas rutas relativas que describe `manifest.sha256` — así el manifest y
> los datos que verifica quedan SIEMPRE en el mismo árbol (antes no era así:
> el manifest usaba rutas relativas y los datos se restauraban con su ruta
> absoluta de origen, y `restore.sh --verify` no encontraba nada). `restic
> restore` conserva la ruta absoluta original del staging dentro de
> `--target`, así que localízalo así antes de seguir:
> ```bash
> STAGE="$(dirname "$(find /tmp/restore-data -name manifest.sha256)")"
> echo "STAGE=$STAGE"   # debe apuntar a .../staging
> ```

### Fase 4 · Recrear contenedores desde imágenes versionadas (≈10 min)

```bash
# TAG=v<versión> del último despliegue conocido (no build local: imágenes de la CI)
sed -i 's/^TAG=.*/TAG=v0.0.0/' infrastructure/.env
docker compose -f infrastructure/docker-compose.yml --env-file infrastructure/.env \
  --profile production pull
# Levantar SOLO la base de datos primero:
docker compose -f infrastructure/docker-compose.yml --env-file infrastructure/.env \
  --profile production up -d postgres
```

### Fase 5 · Restaurar la base de datos (≈10–20 min)

```bash
# El dump vive directamente en la raíz del staging (ver Fase 3).
DUMP=$(find "$STAGE" -maxdepth 1 -name 'pgdump-*.dump' | sort | tail -1)
docker compose -f infrastructure/docker-compose.yml cp "$DUMP" postgres:/tmp/restore.dump
docker compose -f infrastructure/docker-compose.yml exec postgres \
  sh -c 'pg_restore -c --if-exists -U arena -d arena /tmp/restore.dump && rm /tmp/restore.dump'
```

### Fase 6 · Restaurar volúmenes (≈10 min)

```bash
# #110b: nombres de staging (guion bajo, como en manifest.json/métricas) →
# volúmenes reales del compose (arena_<nombre>). "assets" se incluye porque
# backup.sh lo captura desde #110b — antes de este cambio se perdía en la
# restauración aunque SÍ estuviera en el backup. Si una fuente estaba
# `empty` o `error` en el backup, su carpeta no existe en el staging: se
# salta sin copiar nada. El directorio especial que antes limitaba los
# replays copiados a un único subárbol ya no existe como tal: el alcance de
# replays se amplió a todo el volumen (ver Fase 3).
declare -A VOLUME_FOR=( [maps]=arena_maps [bot_sources]=arena_bot_sources [replays]=arena_replays [assets]=arena_assets )
for name in maps bot_sources replays assets; do
  src="$STAGE/$name"
  [ -d "$src" ] || { echo "skip $name (vacío o en error en este backup)"; continue; }
  docker run --rm -v "s9-ai-arena_${VOLUME_FOR[$name]}:/dst" -v "$src:/src:ro" alpine \
    sh -c 'cp -a /src/. /dst/'
done
```

### Fase 7 · Arrancar todo y verificar (≈15 min)

```bash
docker compose -f infrastructure/docker-compose.yml --env-file infrastructure/.env \
  --profile production up -d
docker compose -f infrastructure/docker-compose.yml ps          # todo healthy

# Integridad (criterio del cap. 28): checksums de postgres (pg_dump), mapas,
# bot-sources, assets y replays (manifest.sha256 vive junto a los datos en
# $STAGE, por eso `--verify` puede apuntar a todo /tmp/restore-data: localiza
# el único manifest.sha256 igual que en Fase 3 y falla si hay cero o más de
# uno). D3 (#112) CERRADO: el dump de PostgreSQL (pgdump-*.dump) SÍ está
# incluido en manifest.sha256 desde este cambio — ya no es el único activo
# del backup sin checksum verificado por --verify; su corrupción se detecta
# igual que la de cualquier otra fuente.
# NOTA OPERATIVA (snapshots antiguos): esto sólo aplica a backups generados
# DESPUÉS de este cambio. manifest.json lleva un marcador de contrato
# ("schema") que restore.sh usa para distinguirlos automáticamente — no
# hace falta que el operador haga nada distinto al restaurar uno u otro.
# Un snapshot tomado ANTES de este cambio (sin "schema", o con datos, o con
# las cuatro fuentes no críticas vacías) seguirá teniendo el dump fuera del
# manifest: su restore.sh --verify verificará mapas/bot-sources/assets/
# replays pero NO el dump, y lo dirá explícitamente ("snapshot legacy
# anterior a D3: el dump de PostgreSQL NO tiene checksum en este
# manifest"); la integridad del dump en ese caso depende de que pg_dump/
# restic no fallaran en silencio en su momento, no de un hash. Un snapshot
# NUEVO (con "schema") exige siempre la entrada del dump — si falta o el
# manifest aparece vacío, --verify falla en vez de darlo por bueno.
bash infrastructure/backup/restore.sh --verify /tmp/restore-data

# Migraciones al día (contrato con E7: el api las reporta en /healthz)
curl -s http://localhost:${HTTP_PORT:-80}/api/healthz

# Humo E2E
bash infrastructure/scripts/smoke.sh https://<S9_DOMAIN>

rm -rf /tmp/restore-data   # limpiar restos en claro
```

## Verificaciones finales

| Verificación | Cómo | Criterio |
|---|---|---|
| Healthchecks | `docker compose ps` | todos `healthy` |
| Integridad de mapas/bot-sources/assets/replays | `restore.sh --verify` (sha256, probado en `infrastructure/tests/backup.test.ts` con un snapshot generado por `backup.sh` real, no montado a mano) | 0 discrepancias |
| Migraciones | `/api/healthz` | al día |
| Humo E2E | `smoke.sh` | 4/4 OK |
| Secretos | revisar salida de consola y `docker compose logs` | ningún valor de secreto impreso |

## Registro del simulacro (rellenar al ejecutarlo)

| Fecha | Fase 1 | F2 | F3 | F4 | F5 | F6 | F7 | TOTAL | ¿< 2 h? |
|---|---|---|---|---|---|---|---|---|---|
| _pendiente de entorno con Docker_ | | | | | | | | | |

## Riesgos conocidos

- La contraseña de restic es el único secreto no recuperable desde el propio
  backup: debe custodiarse fuera del servidor (doble custodia recomendada).
- **Custodia de la clave SSH del backend sftp (fix/restore-sftp-bootstrap,
  NO resuelto por este cambio — es un problema OPERATIVO, no de código):**
  `restore.sh` recibe `RESTIC_SSH_KEY_FILE`/`RESTIC_SSH_KNOWN_HOSTS_FILE`,
  nunca los genera ni los custodia. Si esa clave viviera ÚNICAMENTE dentro
  de VM108 (o de la máquina que sea, en cada despliegue) — por ejemplo,
  guardada sólo en un fichero local del host o en un volumen que también
  desaparece con él — un desastre que se lleve por delante esa máquina se
  lleva también el ÚNICO medio de alcanzar el backup: "el backup existe" y
  "el backup es alcanzable" dejarían de ser la misma afirmación. Es
  exactamente el mismo problema del huevo y la gallina que ya tiene
  `restic_password` (arriba), aplicado a la clave SSH. Mitigación: la misma
  doble custodia fuera del servidor que ya exige `restic_password` — un
  gestor de secretos del operador, NUNCA sólo el propio servidor que se
  quiere poder recuperar. Pendiente de decisión/verificación explícita del
  operador; no se resuelve con código.
- `arena_build_cache` NO se copia (decisión de retención del dosier 23.1): se
  regenera. Los replays SÍ se copian en su totalidad desde #110b (antes sólo
  se copiaba `official/`, un subdirectorio que en producción no existe, así
  que nunca se había copiado ni un solo replay); quedan sujetos a
  `REPLAY_RETENTION_DAYS`, salvo `official/` que se conserva sin límite.
- El staging temporal de `backup.sh` ($WORK_DIR, por defecto
  `/tmp/backup-work`) puede llegar a pesar como la suma de
  maps+bot_sources+assets+replays retenidos: está en el volumen dedicado
  `backup_work` del compose (ver `infrastructure/docker-compose.yml`) para
  que ese crecimiento no comparta cupo con el resto del contenedor y se
  pueda vigilar con `docker system df -v`.
- Si se usa PostgreSQL externo (perfil `external-db`), la Fase 5 se ejecuta
  contra esa instancia (`pg_restore -h <host externo>`) y la Fase 4 no levanta
  postgres.
