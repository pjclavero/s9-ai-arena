#!/usr/bin/env bash
# Backup diario de S9 AI Arena (T10.4, cap. 24; ADR-010 D10.4).
# Rediseño #110b: clasificación de fuentes ok/empty/error/disabled.
#
# INCIDENTE que motiva este rediseño: el script original ejecutaba TODO el
# backup dentro de una única subshell con `set -e`. El pg_dump (paso 1/5)
# escribía dentro de $WORK_DIR, que un `trap EXIT` borraba al salir. Si
# `[ -d "$MAPS_DIR" ] && ...` fallaba porque el volumen aún no tenía datos
# (legítimo: "arena_maps" vacío es el estado normal en producción antes del
# primer despliegue de contenido), la subshell abortaba ANTES de invocar
# `restic backup`: el dump de PostgreSQL —el activo más crítico— se perdía
# sin que nadie lo guardara, y "no hay mapas todavía" era indistinguible de
# "el backup se rompió". Este script separa ambos casos.
#
# Revisión de un supervisor independiente sobre la primera versión de este
# rediseño (#112) encontró que `restore.sh --verify` seguía roto en el mundo
# real: el manifest usaba rutas relativas "maps/…", "replays/…" pero cada
# fuente se pasaba a restic con su ruta ABSOLUTA de origen (/data/maps,
# /data/replays…), así que al restaurar, el manifest y los datos NUNCA
# coincidían en el mismo árbol y `sha256sum -c` fallaba con
# "FAILED open or read" para todo. Fix aquí: SIEMPRE construir un directorio
# de "staging" ($WORK_DIR/staging) con la MISMA jerarquía relativa que
# describe el manifest (maps/, bot_sources/, assets/, replays/, más el dump y
# los dos manifests), y pasarle a restic ese único directorio. Lo que se
# restaura es exactamente lo que describe el manifest, en el mismo sitio.
#
# Contrato de clasificación (por fuente):
#   ok       el directorio existe y tiene contenido válido.
#   empty    el directorio existe y está vacío, O no existe pero su ausencia
#            es esperable (p.ej. aún no se ha subido contenido). NUNCA aborta
#            el backup ni cuenta como fallo.
#   error    fallo real: permiso denegado, error de lectura, fallo de
#            pg_dump, fallo al copiar/tar. Esto SÍ es un fallo.
#   disabled la fuente no aplica en este despliegue (reservado; no usado hoy).
#
# Fuentes CRÍTICAS (postgres, secrets): un `error` en ellas es FULL FAILURE:
# se aborta antes de tocar restic y el backup se marca fallido. Sin el dump
# de la BD o sin los secretos, un backup "parcial" sería engañoso. OJO: un
# directorio de secretos VACÍO (0 ficheros, legible) es `empty`, no `error`
# — un fallo real de lectura es lo único que cuenta como `error` aquí. La
# primera versión de este script confundía ambos casos por un efecto de
# `pipefail` sobre `grep -c .` (ver classify_source más abajo).
#
# Fuentes NO críticas (maps, bot_sources, replays, assets): un `error` en
# una de ellas se registra y se emite en métricas, pero `restic backup` SE
# EJECUTA IGUAL con el material válido ya capturado (PARTIAL SUCCESS). Jamás
# se destruye un dump válido de PostgreSQL por culpa de una fuente
# secundaria rota.
#
# Códigos de salida:
#   0 = SUCCESS          todas las fuentes ok/empty, restic corrió y verificó.
#   1 = FULL FAILURE      una fuente crítica (postgres o secrets) dio error,
#                         o falló restic/la configuración. No hay backup útil.
#   2 = PARTIAL SUCCESS   restic corrió y guardó lo válido, pero al menos una
#                         fuente NO crítica dio error. Requiere revisión.
#
# Qué copia:
#   1. PostgreSQL: pg_dump lógico en formato custom comprimido. (crítica)
#   2. Volúmenes arena_maps, arena_bot_sources y arena_assets completos.
#   3. arena_replays: TODO el volumen dentro de la retención
#      REPLAY_RETENTION_DAYS; los replays bajo official/ (si existe) se
#      tratan como preferentes y se incluyen SIEMPRE, sin límite de
#      retención. Cambio de alcance respecto a la versión anterior, que
#      sólo copiaba official/ — un subdirectorio que en producción no
#      existe, por lo que NUNCA se había copiado ni un solo replay.
#   4. Secretos (infrastructure/secrets): cifrados por el propio repositorio
#      restic, en su PROPIO snapshot (tag s9-arena-secrets), NUNCA dentro
#      del staging de datos; sus VALORES no aparecen jamás en logs,
#      manifest ni git. (crítica)
#   5. manifest.sha256 (checksums, para restaurar) y manifest.json (cobertura
#      por fuente: qué se guardó, qué estaba vacío, qué falló). Ambos viven
#      DENTRO del staging, junto a los datos que describen. El manifest
#      NUNCA contiene secretos ni variables de entorno.
# Destino: RESTIC_REPOSITORY (NAS/ZFS designado por el operador).
# Métricas: escribe s9_backup_* en METRICS_DIR (textfile collector de
#   node-exporter) → alertas BackupFailed / BackupTooOld (26 h).
#
# RIESGO CONOCIDO (no bloqueante, documentado a petición del supervisor):
# el staging duplica en $WORK_DIR el contenido de maps/bot_sources/assets/
# replays antes de subirlo a restic — puede llegar a ser tan grande como la
# suma de esos cuatro volúmenes. El servicio `backup` del compose NO monta
# hoy un volumen dedicado para $WORK_DIR (por defecto /tmp/backup-work), así
# que ese crecimiento cae en la capa de escritura del contenedor, compartida
# con el resto de /tmp y con límite implícito en el disco del host. Mitigación
# propuesta (aplicada en infrastructure/docker-compose.yml de este mismo
# cambio): volumen nombrado `backup_work` montado en /tmp/backup-work, para
# que el crecimiento se vea y se limite por separado del resto del
# contenedor, y quede visible con `docker system df -v`. Si el volumen de
# datos crece mucho, subir REPLAY_RETENTION_DAYS con cuidado o mover
# $WORK_DIR a un disco con más margen.
#
# Modos:
#   backup.sh            backup real (requiere restic, pg_dump y el repo).
#   backup.sh --dry-run  imprime el plan y valida configuración SIN escribir
#                        nada ni requerir docker (probado por vitest).
#   backup.sh --init-repo  crea el repositorio restic si no existe (paso
#                        explícito de puesta en marcha, idempotente, NUNCA
#                        automático: ver la nota junto a INIT_REPO).
set -uo pipefail
# Nota: NO usamos `set -e` a nivel de script. La clasificación de fuentes
# necesita distinguir "esta fuente falló" de "el script entero debe morir";
# un `set -e` global reintroduciría el mismo defecto que motivó este
# rediseño (un `false` en una comprobación matando el backup completo).

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1
# --init-repo: crea el repositorio restic si no existe. Paso EXPLÍCITO y de
# una sola vez, nunca automático dentro del backup: si `restic backup`
# inicializase el repo al no encontrarlo, una errata en RESTIC_REPOSITORY
# crearía en silencio un repositorio nuevo y vacío, y el backup "tendría
# éxito" mientras el histórico real queda huérfano en la ruta correcta. Ese
# fallo es peor que no hacer backup, porque además apaga la alerta.
#
# Este modo existe porque en la primera puesta en marcha el repositorio se
# creó A MANO y ese paso no quedó ni en el código ni en las pruebas: el E2E
# le pedía a backup.sh que escribiera en un repositorio que nadie había
# creado. Tenerlo aquí evita además duplicar setup_ssh dentro del test,
# donde se desviaría de la configuración SSH real con el tiempo.
INIT_REPO=0
[ "${1:-}" = "--init-repo" ] && INIT_REPO=1

# ── Configuración (sobreescribible por entorno; valores del contenedor backup) ─
MAPS_DIR="${MAPS_DIR:-/data/maps}"
BOT_SOURCES_DIR="${BOT_SOURCES_DIR:-/data/bot-sources}"
REPLAYS_DIR="${REPLAYS_DIR:-/data/replays}"
ASSETS_DIR="${ASSETS_DIR:-/data/assets}"
SECRETS_DIR="${SECRETS_DIR:-/secrets}"
METRICS_DIR="${METRICS_DIR:-/textfile}"
WORK_DIR="${WORK_DIR:-/tmp/backup-work}"
REPLAY_RETENTION_DAYS="${REPLAY_RETENTION_DAYS:-180}"
# RESTIC_HOSTNAME (fix/restic-stable-hostname): `restic forget` agrupa la
# retención por host+paths, y ese "host" es, por defecto, el hostname del
# SISTEMA (`--host`, o el propio `hostname` si no se pasa). Dentro de un
# contenedor Docker sin `hostname:` fijado en el compose, ese valor es el ID
# corto del contenedor — que cambia CADA VEZ que el servicio `backup` se
# recrea (despliegue, reinicio, `docker compose up` tras cambiar la imagen).
# Cada recreación creaba así un grupo de retención nuevo con un único
# snapshot, que por tanto era simultáneamente el diario/semanal/mensual y se
# conservaba SIEMPRE: `forget` no borraba nunca nada y el repositorio crecía
# sin límite, mientras cada ejecución individual reportaba SUCCESS y
# `restic check` pasaba (correcto en lo pequeño, roto en lo agregado; visto
# en producción el 2026-08-14, log real con un grupo de retención por cada
# ID de contenedor distinto). Aquí se fija un hostname ESTABLE de la
# instalación, pasado explícitamente a restic con `--host` en `backup` y en
# `forget` (nunca se depende del hostname ambiental de `uname`/`hostname`,
# que seguiría siendo el ID del contenedor si algo se lo pasara por alto).
# Configurable por entorno (ver infrastructure/docker-compose.yml, servicio
# `backup`) para permitir migraciones deliberadas de host sin perder el
# historial; con un valor por defecto sensato para que un despliegue nuevo
# ya nazca con retención correcta sin configuración adicional.
RESTIC_HOSTNAME="${RESTIC_HOSTNAME:-arena-backup-host}"
PGHOST="${PGHOST:-postgres}"
PGUSER="${PGUSER:-arena}"
PGDATABASE="${PGDATABASE:-arena}"
RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-}"
# RESTIC_PASSWORD_FILE y PGPASSWORD_FILE llegan como secretos montados.
# RESTIC_SSH_KEY_FILE / RESTIC_SSH_KNOWN_HOSTS_FILE: sólo aplican al backend
# `sftp:` (ver setup_ssh más abajo, fix/backup-sftp-scheduled-runtime).
RESTIC_SSH_KEY_FILE="${RESTIC_SSH_KEY_FILE:-}"
RESTIC_SSH_KNOWN_HOSTS_FILE="${RESTIC_SSH_KNOWN_HOSTS_FILE:-}"
: "${HOME:=/root}"
export HOME

# D2 (ronda 3 de #112): el mensaje de `log()` a menudo interpola nombres de
# fichero (stderr de `find`/`cp`), y `bot_sources` es contenido subido por
# usuarios. Sin escapar, un directorio llamado
# `pwn", "level":"info", "forged":"si` produce un JSON "válido" cuyo
# `level` efectivo deja de ser `error` — un usuario podría ocultar un fallo
# de backup a la alertería de Loki/Promtail e inyectar campos arbitrarios.
#
# D2-R3a (ronda 4, hallazgo del supervisor): la primera versión sólo
# escapaba `\n \r \t` además de `"` y `\`. Los demás caracteres de control
# (0x01, 0x08, 0x0b, 0x0c, 0x1b…) se interpolaban crudos — `json.loads` en
# modo estricto (y cualquier pipeline serio de logs) RECHAZA esa línea
# entera como JSON inválido, así que un nombre de fichero con uno de esos
# bytes tiene el mismo efecto práctico que D2 (el fallo desaparece de
# Loki/Promtail), sólo que por malformación en vez de por forja. Y un
# nombre de fichero puede además no ser UTF-8 válido, lo que rompe JSON por
# sí solo (JSON exige texto Unicode válido). Aquí se saca la basura en dos
# pasadas: (1) `iconv -c` descarta cualquier secuencia de bytes que no sea
# UTF-8 válido (mejor perder esos bytes que producir un documento inválido
# o reventar el propio log() intentando procesarlos); (2) TODO carácter de
# control 0x00–0x1F que quede se escapa como \u00XX (con los atajos con
# nombre — \b \f \n \r \t — donde JSON los define), no sólo los tres de
# antes.
json_escape() {
  local s="$1"
  if command -v iconv >/dev/null 2>&1; then
    s="$(printf '%s' "$s" | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null)"
  fi
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\b'/\\b}"
  s="${s//$'\f'/\\f}"
  local LC_ALL=C out="" i len c code
  len=${#s}
  for ((i = 0; i < len; i++)); do
    c="${s:i:1}"
    printf -v code '%d' "'$c"
    if [ "$code" -lt 32 ]; then
      printf -v c '\\u%04x' "$code"
    fi
    out+="$c"
  done
  printf '%s' "$out"
}
log() { printf '{"ts":"%s","level":"%s","service":"backup","msg":"%s"}\n' "$(date -u +%FT%TZ)" "$1" "$(json_escape "$2")"; }

# ── Estado de clasificación por fuente ─────────────────────────────────────
# Bash asociativos: SRC_STATUS[nombre]=ok|empty|error, SRC_FILES[nombre]=N.
declare -A SRC_STATUS=()
declare -A SRC_FILES=()
FULL_FAILURE=0
PARTIAL=0

# classify_source NOMBRE DIRECTORIO CRÍTICA(0/1)
# Comprueba SOLO legibilidad/tamaño (no copia nada). Nunca aborta el script
# aquí mismo: registra el resultado y marca FULL_FAILURE o PARTIAL según la
# criticidad de la fuente, dejando que el llamador decida qué hacer.
#
# `grep -c .` devuelve exit 1 cuando cuenta 0 líneas (no es un error de
# `grep`, es su forma de decir "cero coincidencias"). Antes esta función
# usaba `if secret_count=$(find … | grep -c .); then …`, y con `pipefail`
# ese exit 1 de `grep -c .` se propagaba al `if`: un directorio de secretos
# VACÍO (pero perfectamente legible) se clasificaba como `error` y disparaba
# FULL FAILURE, contradiciendo la cabecera de este mismo fichero. Aquí el
# conteo se separa del chequeo de legibilidad para que "cero ficheros" y
# "no se pudo leer" nunca se confundan.
#
# D1-R5 (ronda 6, HALLAZGO DEL SUPERVISOR): el conteo usaba
# `find … | grep -c .` (líneas de SALIDA de find, una por fichero listado
# CON SU NOMBRE), pero `sha256sum` —lo que realmente genera manifest.sha256
# más abajo— emite una línea por fichero ESCAPANDO cualquier `\n` interno
# del nombre (formato "portable" de sha256sum). Un fichero legítimo llamado
# literalmente "salto\nlinea.json" contaba como 2 "líneas" aquí pero sigue
# siendo 1 entrada en el manifest: el contraste de backup.sh (más abajo)
# veía "6 líneas, se esperaban 7" sobre un backup PERFECTO y abortaba en
# FULL FAILURE — perdiendo el dump de PostgreSQL ya generado, el mismo
# incidente que motiva la cabecera de este fichero, reintroducido por otra
# puerta. La ronda 4 ya había arreglado exactamente este bug para
# `replays` (ver más abajo, `-print0`/`read -d ''`) pero dejó `maps`,
# `bot_sources` y `assets` —los tres que pasan por esta función— contando
# por líneas. `bot_sources` es contenido que suben los usuarios: un
# usuario podía tumbar el backup de toda la plataforma con un solo nombre
# de fichero. Se cuenta con NUL como separador (`-print0` + contar bytes
# NUL), inmune a saltos de línea en el propio nombre.
classify_source() {
  local name="$1" dir="$2" critical="$3"
  if [ ! -d "$dir" ]; then
    SRC_STATUS[$name]=empty
    SRC_FILES[$name]=0
    return 0
  fi
  if ! find "$dir" -type f -print0 > "$WORK_DIR/.files-$name" 2>"$WORK_DIR/.err-$name"; then
    log error "fuente '$name' ($dir) ilegible: $(tail -c 300 "$WORK_DIR/.err-$name")"
    SRC_STATUS[$name]=error
    SRC_FILES[$name]=0
    if [ "$critical" = 1 ]; then FULL_FAILURE=1; else PARTIAL=1; fi
    return 1
  fi
  local count
  count=$(tr -cd '\0' < "$WORK_DIR/.files-$name" | wc -c)
  if [ "$count" -eq 0 ]; then
    SRC_STATUS[$name]=empty
    SRC_FILES[$name]=0
  else
    SRC_STATUS[$name]=ok
    SRC_FILES[$name]=$count
  fi
  return 0
}

# stage_source NOMBRE DIRECTORIO_ORIGEN DIRECTORIO_STAGING
# Copia una fuente ya clasificada como `ok` a su hueco dentro del staging,
# preservando la jerarquía relativa que describirá el manifest. Si la copia
# en sí falla (disco lleno, error transitorio), degrada la fuente a `error`
# a posteriori: mejor un PARTIAL SUCCESS honesto que un manifest que promete
# datos que no llegaron a subirse.
stage_source() {
  local name="$1" src="$2" dst="$3"
  mkdir -p "$dst"
  if ! cp -a "$src"/. "$dst"/ 2>"$WORK_DIR/.err-stage-$name"; then
    log error "fallo copiando '$name' al staging: $(tail -c 300 "$WORK_DIR/.err-stage-$name")"
    rm -rf "$dst"
    SRC_STATUS[$name]=error
    SRC_FILES[$name]=0
    PARTIAL=1
    return 1
  fi
  return 0
}

# json_source NOMBRE → fragmento de manifest.json para esa fuente.
json_source() {
  local name="$1" status="${SRC_STATUS[$1]:-disabled}" files="${SRC_FILES[$1]:-0}"
  if [ "$status" = "ok" ] || [ "$status" = "empty" ]; then
    printf '"%s":{"status":"%s","files":%s}' "$name" "$status" "$files"
  else
    printf '"%s":{"status":"%s"}' "$name" "$status"
  fi
}

# setup_ssh — prepara ~/.ssh para el backend `sftp:` de restic.
#
# fix/restore-sftp-bootstrap: factorizada a lib/setup-ssh.sh para que
# restore.sh use EXACTAMENTE el mismo bootstrap SSH que backup.sh (antes
# restore.sh no tenía ninguno: un contenedor de recuperación nuevo, que
# nunca había ejecutado backup.sh, no tenía forma de alcanzar un
# repositorio sftp:). Ver ese fichero para el incidente que motivó esta
# función, el contrato de entrada y por qué NUNCA se sustituye
# StrictHostKeyChecking por "no".
# shellcheck source=lib/setup-ssh.sh
# Expansión de parámetros pura de bash (${VAR%/*}), NO `dirname`/`cd`/`pwd`
# externos: esta línea se ejecuta ANTES de saber si el PATH de la imagen
# está completo, y algún test de este mismo repo restringe el PATH a
# propósito para probar "falta una herramienta" — no debe arrastrar a este
# `source` a un fallo distinto del que esa prueba quiere ejercitar.
_s9_backup_dir="${BASH_SOURCE[0]%/*}"
[ "$_s9_backup_dir" = "${BASH_SOURCE[0]}" ] && _s9_backup_dir="."
source "$_s9_backup_dir/lib/setup-ssh.sh"
unset _s9_backup_dir

write_metrics() { # $1 exit_code $2 duration_s $3 restic_snapshot_created(0/1)
  [ "$DRY_RUN" = 1 ] && return 0
  mkdir -p "$METRICS_DIR"
  local run_success=0
  [ "$1" = 0 ] && run_success=1
  local pg_success=0
  [ "${SRC_STATUS[postgres]:-error}" = "ok" ] && pg_success=1
  {
    echo "# HELP s9_backup_last_exit_code Código de salida del último backup."
    echo "# TYPE s9_backup_last_exit_code gauge"
    echo "s9_backup_last_exit_code $1"
    echo "# HELP s9_backup_duration_seconds Duración del último backup."
    echo "# TYPE s9_backup_duration_seconds gauge"
    echo "s9_backup_duration_seconds $2"
    # OJO (revisión del supervisor, punto 6/M7): esta marca de tiempo SOLO se
    # escribe con exit==0 (SUCCESS). Un PARTIAL SUCCESS (2) o un FULL FAILURE
    # (1) NUNCA la actualizan — se preserva la del último éxito real más
    # abajo. Así, un PARTIAL sostenido durante 26h+ SÍ dispara BackupTooOld:
    # no hay hueco entre "backup roto" y "backup silenciosamente caducado".
    # Cubierto por test (ver backup.test.ts, sección de métricas).
    if [ "$1" = 0 ]; then
      echo "# HELP s9_backup_last_success_timestamp_seconds Época del último backup correcto."
      echo "# TYPE s9_backup_last_success_timestamp_seconds gauge"
      echo "s9_backup_last_success_timestamp_seconds $(date +%s)"
    fi
    echo "# HELP s9_backup_run_success 1 si el backup terminó en SUCCESS (exit 0)."
    echo "# TYPE s9_backup_run_success gauge"
    echo "s9_backup_run_success $run_success"
    echo "# HELP s9_backup_postgres_success 1 si el pg_dump de la fuente crítica postgres tuvo éxito."
    echo "# TYPE s9_backup_postgres_success gauge"
    echo "s9_backup_postgres_success $pg_success"
    echo "# HELP s9_backup_restic_snapshot_created 1 si restic backup creó un snapshot en esta ejecución."
    echo "# TYPE s9_backup_restic_snapshot_created gauge"
    echo "s9_backup_restic_snapshot_created ${3:-0}"
    echo "# HELP s9_backup_source_files Ficheros detectados por fuente en la última ejecución."
    echo "# TYPE s9_backup_source_files gauge"
    echo "# HELP s9_backup_source_empty 1 si la fuente estaba vacía (o ausente de forma esperable) en la última ejecución."
    echo "# TYPE s9_backup_source_empty gauge"
    echo "# HELP s9_backup_source_error 1 si la fuente falló (permiso, lectura, dump) en la última ejecución."
    echo "# TYPE s9_backup_source_error gauge"
    for src in "${!SRC_STATUS[@]}"; do
      local st="${SRC_STATUS[$src]}" fl="${SRC_FILES[$src]:-0}"
      echo "s9_backup_source_files{source=\"$src\"} $fl"
      echo "s9_backup_source_empty{source=\"$src\"} $([ "$st" = empty ] && echo 1 || echo 0)"
      echo "s9_backup_source_error{source=\"$src\"} $([ "$st" = error ] && echo 1 || echo 0)"
    done
  } > "$METRICS_DIR/s9_backup.prom.tmp"
  # Preservar el último éxito si este backup falló.
  if [ "$1" != 0 ] && [ -f "$METRICS_DIR/s9_backup.prom" ]; then
    grep "^s9_backup_last_success_timestamp_seconds" "$METRICS_DIR/s9_backup.prom" >> "$METRICS_DIR/s9_backup.prom.tmp" || true
  fi
  mv "$METRICS_DIR/s9_backup.prom.tmp" "$METRICS_DIR/s9_backup.prom"
}

# ── Validación de configuración (también en dry-run) ──────────────────────────
errors=0
if [ -z "$RESTIC_REPOSITORY" ]; then
  log error "RESTIC_REPOSITORY sin definir (infrastructure/.env): el operador debe designar el destino (NAS/ZFS)"
  errors=1
fi
if [ -z "${RESTIC_PASSWORD_FILE:-}" ] && [ -z "${RESTIC_PASSWORD:-}" ]; then
  log error "RESTIC_PASSWORD_FILE sin definir (secreto restic_password)"
  errors=1
fi
# fix/restic-stable-hostname (revisión del supervisor, hallazgo M8/M10, y
# ronda 2 H1): un RESTIC_HOSTNAME vacío o compuesto sólo de espacio en
# blanco pasaba la validación en silencio porque
# `${RESTIC_HOSTNAME:-arena-backup-host}` sólo aplica el valor por defecto
# cuando la variable está SIN DEFINIR, no cuando está definida pero vacía
# (`RESTIC_HOSTNAME=` en .env deja pasar la cadena vacía tal cual). Con
# `--host ""` restic trataría el argumento como ausente/una cadena vacía
# real, lo que reabre justo el defecto que motiva este fix (agrupación
# inestable), sólo que ahora por config explícita en vez de por hostname
# ambiental. Igual de inválido: un hostname compuesto sólo de espacio en
# blanco no es un identificador de host utilizable.
#
# H1 (ronda 2 del supervisor, demostrado con `--dry-run` real): la primera
# versión de esta comprobación usaba `${RESTIC_HOSTNAME// /}`, que sólo
# sustituye el carácter ESPACIO ASCII (0x20). Un RESTIC_HOSTNAME compuesto
# de tabuladores ($'\t\t') o saltos de línea ($'\n') no contiene ningún
# 0x20, así que sobrevivía intacto a esa sustitución y la validación decía
# "CONFIG OK" con `--host <TAB><TAB>` — exactamente la clase de fallo que
# esta comprobación decía cerrar. La expresión regular de bash
# `^[[:space:]]*$` cubre TODO carácter de espacio en blanco POSIX (espacio,
# tab, salto de línea, retorno de carro, form feed, vertical tab), no sólo
# el espacio simple — y es un builtin de bash (`[[ =~ ]]`), sin invocar un
# binario externo (`tr`) que podría no estar en el PATH de una imagen
# mínima. Se valida en el mismo bloque, con el mismo estilo y el mismo
# contrato de exit code, que RESTIC_REPOSITORY.
if [[ "$RESTIC_HOSTNAME" =~ ^[[:space:]]*$ ]]; then
  log error "RESTIC_HOSTNAME vacío o en blanco (infrastructure/.env): debe ser un hostname estable no vacío (ver docker-compose.yml, servicio backup)"
  errors=1
fi

# fix/backup-sftp-scheduled-runtime: el backend `sftp:` fallaba en EJECUCIÓN
# (ssh ausente de la imagen) de un modo que un `restic -r … snapshots` a mano
# desde el host jamás reproducía, porque el host SÍ tiene ssh. Estas
# comprobaciones mueven ese fallo de "silencioso a las 4:15 de la madrugada"
# a "visible en el dry-run de arranque del entrypoint" (ver entrypoint.sh) y
# en la validación de cada ejecución programada. NUNCA se acepta
# StrictHostKeyChecking=no como sustituto de RESTIC_SSH_KNOWN_HOSTS_FILE: sin
# huella verificada, cualquiera en la red del backup podría suplantar el
# destino sftp y recibir el dump completo de PostgreSQL.
#
# sftp_errors se lleva SEPARADO de errors (revisión del operador tras el
# primer intento de este fix): "RESTIC_REPOSITORY sin definir" es un estado
# de arranque ESPERABLE el día 1, antes de que el operador termine de
# configurar `.env` — por eso el entrypoint no aborta el contenedor por eso
# (comentario histórico "no falla el arranque: la alerta BackupTooOld
# avisará"). Pero "RESTIC_REPOSITORY=sftp:… configurado y aun así falta ssh,
# la clave o un known_hosts con contenido" NO es un estado transitorio de
# bootstrap: es un defecto de imagen/despliegue —el mismo que motivó este
# fix— y dejarlo correr 24 h hasta que el cron lo descubra es exactamente el
# fallo silencioso que el operador quiere cerrado. El entrypoint usa
# sftp_errors para decidir si el CONTENEDOR debe negarse a arrancar (ver
# entrypoint.sh).
sftp_errors=0
if [[ "$RESTIC_REPOSITORY" == sftp:* ]]; then
  if ! command -v ssh >/dev/null 2>&1; then
    log error "RESTIC_REPOSITORY usa el backend sftp pero 'ssh' (openssh-client) no está instalado en esta imagen"
    errors=1
    sftp_errors=1
  fi
  if [ -z "$RESTIC_SSH_KEY_FILE" ]; then
    log error "backend sftp: falta RESTIC_SSH_KEY_FILE (secreto con la clave privada SSH)"
    errors=1
    sftp_errors=1
  elif [ ! -r "$RESTIC_SSH_KEY_FILE" ]; then
    log error "backend sftp: RESTIC_SSH_KEY_FILE=$RESTIC_SSH_KEY_FILE no es legible"
    errors=1
    sftp_errors=1
  fi
  if [ -z "$RESTIC_SSH_KNOWN_HOSTS_FILE" ]; then
    log error "backend sftp: falta RESTIC_SSH_KNOWN_HOSTS_FILE (huella verificada; NUNCA StrictHostKeyChecking=no)"
    errors=1
    sftp_errors=1
  elif [ ! -s "$RESTIC_SSH_KNOWN_HOSTS_FILE" ]; then
    log error "backend sftp: RESTIC_SSH_KNOWN_HOSTS_FILE=$RESTIC_SSH_KNOWN_HOSTS_FILE está vacío o no es legible"
    errors=1
    sftp_errors=1
  fi
fi

if [ "$DRY_RUN" = 1 ]; then
  log info "DRY-RUN: plan de backup (no se escribe nada)"
  echo "PLAN 1/5 · pg_dump -Fc -h $PGHOST -U $PGUSER $PGDATABASE -f staging/pgdump-\$(fecha).dump [fuente crítica]"
  echo "PLAN 2/5 · clasificar fuentes (ok/empty/error): maps, bot_sources, replays, assets, secrets"
  echo "PLAN 3/5 · construir staging/ (maps/, bot_sources/, assets/, replays/) + manifest.sha256 + manifest.json DENTRO del staging"
  echo "PLAN 4/5 · restic backup --host $RESTIC_HOSTNAME del staging completo <= $REPLAY_RETENTION_DAYS días de replays (official/ sin límite) + restic backup de $SECRETS_DIR [fuente crítica, snapshot separado]"
  echo "PLAN 5/5 · restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune --host $RESTIC_HOSTNAME --group-by host,tags && restic check"
  if [[ "$RESTIC_REPOSITORY" == sftp:* ]]; then
    echo "SFTP · ssh $(command -v ssh >/dev/null 2>&1 && echo presente || echo AUSENTE), known_hosts verificado (StrictHostKeyChecking yes, nunca 'no')"
  fi
  echo "MÉTRICAS · $METRICS_DIR/s9_backup.prom (alerta si falla o si no hay éxito en 26 h)"
  echo "EXIT · 0 SUCCESS / 1 FULL FAILURE (fuente crítica o restic) / 2 PARTIAL SUCCESS (fuente no crítica en error)"
  [ "$errors" = 0 ] && echo "CONFIG OK" || echo "CONFIG INCOMPLETA (ver errores arriba)"
  # Código de salida del --dry-run (distinto del de una ejecución real):
  #   0 config completa · 1 config incompleta "de bootstrap" (esperable el
  #   día 1, p.ej. RESTIC_REPOSITORY todavía sin definir) · 3 backend sftp
  #   mal configurado (defecto de imagen/despliegue, NO transitorio) — el
  #   entrypoint distingue 3 para negarse a arrancar el contenedor en vez de
  #   dejar que el cron lo descubra 24 h después.
  if [ "$sftp_errors" = 1 ]; then
    exit 3
  fi
  exit "$errors"
fi

# ── --init-repo: creación explícita del repositorio (no escribe métricas: no
# es una ejecución de backup y no debe tocar s9_backup_last_success_*). ──────
if [ "$INIT_REPO" = 1 ]; then
  if [ "$errors" != 0 ]; then
    log error "--init-repo: configuración incompleta (ver errores arriba); no se inicializa nada"
    exit 1
  fi
  if ! setup_ssh; then
    log error "--init-repo: no se pudo preparar ~/.ssh para el backend sftp"
    exit 1
  fi
  # Idempotente: si ya hay repositorio, NO se toca. `restic cat config` es la
  # comprobación barata de existencia; su fallo distingue "no hay repo" de
  # "hay repo" sin escribir nada.
  if restic cat config >/dev/null 2>&1; then
    log info "--init-repo: el repositorio ya existe; no se hace nada"
    exit 0
  fi
  if restic init; then
    log info "--init-repo: repositorio creado"
    exit 0
  fi
  log error "--init-repo: restic init falló"
  exit 1
fi

[ "$errors" = 0 ] || { write_metrics 1 0 0; exit 1; }

start=$(date +%s)
mkdir -p "$WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT
STAGING="$WORK_DIR/staging"
mkdir -p "$STAGING"

# ── 1/5: PostgreSQL (fuente CRÍTICA) — el dump se escribe YA dentro del
# staging, para que quede en el mismo árbol que se sube a restic y que luego
# se restaura entero de una vez. ────────────────────────────────────────────
log info "1/5 pg_dump de $PGDATABASE (fuente crítica)"
PGDUMP_FILE="$STAGING/pgdump-$(date -u +%Y%m%d%H%M%S).dump"
export PGPASSWORD="$(cat "${PGPASSWORD_FILE:?PGPASSWORD_FILE requerido}")"
if pg_dump -Fc -h "$PGHOST" -U "$PGUSER" "$PGDATABASE" -f "$PGDUMP_FILE" 2>"$WORK_DIR/.err-postgres"; then
  SRC_STATUS[postgres]=ok
  SRC_FILES[postgres]=1
else
  log error "pg_dump FALLÓ: $(tail -c 300 "$WORK_DIR/.err-postgres")"
  SRC_STATUS[postgres]=error
  SRC_FILES[postgres]=0
  FULL_FAILURE=1
fi
unset PGPASSWORD

# ── 2/5: secretos (fuente CRÍTICA) — sólo se comprueba legibilidad aquí; el
# backup real de su CONTENIDO lo hace restic más abajo, en su propio
# snapshot (nunca dentro del staging de datos), y jamás se vuelca a
# manifest/log (DoD T10.4: los valores no aparecen jamás fuera de restic). ──
if [ "$FULL_FAILURE" = 0 ]; then
  log info "2/5 comprobando legibilidad de $SECRETS_DIR (fuente crítica; contenido nunca se lista)"
  classify_source secrets "$SECRETS_DIR" 1
fi

if [ "$FULL_FAILURE" = 1 ]; then
  # Sin dump válido o sin secretos legibles no hay nada fiable que ofrecer:
  # abortamos ANTES de tocar restic. Esto es intencional (ver cabecera): un
  # "backup parcial" sin la fuente crítica sería peor que no tener backup,
  # porque generaría una falsa sensación de seguridad al restaurar.
  dur=$(( $(date +%s) - start ))
  write_metrics 1 "$dur" 0
  log error "backup FULL FAILURE (fuente crítica en error) tras ${dur}s"
  exit 1
fi

# ── 3/5: fuentes NO críticas — cada una se clasifica y se copia al staging
# de forma independiente; un error aquí NUNCA impide que restic guarde el
# resto (ver cabecera). ─────────────────────────────────────────────────────
log info "3/5 clasificando y copiando al staging: maps, bot_sources, assets, replays"
classify_source maps "$MAPS_DIR" 0
[ "${SRC_STATUS[maps]}" = ok ] && stage_source maps "$MAPS_DIR" "$STAGING/maps"

classify_source bot_sources "$BOT_SOURCES_DIR" 0
[ "${SRC_STATUS[bot_sources]}" = ok ] && stage_source bot_sources "$BOT_SOURCES_DIR" "$STAGING/bot_sources"

classify_source assets "$ASSETS_DIR" 0
[ "${SRC_STATUS[assets]}" = ok ] && stage_source assets "$ASSETS_DIR" "$STAGING/assets"

# Replays: alcance ampliado respecto a la versión anterior (ver cabecera).
# Se copia TODO $REPLAYS_DIR dentro de la retención; official/, si existe,
# se trata como preferente y se incluye siempre sin límite de retención.
#
# La copia usa `find -print0` + `read -d ''` (NUL como separador) en vez de
# `find | xargs -I{}` (separador de línea): el supervisor detectó que un
# solo nombre de fichero con un salto de línea real rompía TODO el listado
# de `xargs -I{}` — no había inyección de comandos, pero sí denegación de
# respaldo (la fuente entera se excluía de restic sin ningún error visible).
STAGING_REPLAYS="$STAGING/replays"
mkdir -p "$STAGING_REPLAYS"
if [ ! -d "$REPLAYS_DIR" ]; then
  SRC_STATUS[replays]=empty
  SRC_FILES[replays]=0
elif ! find "$REPLAYS_DIR" -type f \
    \( -path "$REPLAYS_DIR/official/*" -o -mtime "-$REPLAY_RETENTION_DAYS" \) \
    -print0 > "$WORK_DIR/.replays.list" 2>"$WORK_DIR/.err-replays"; then
  log error "fuente 'replays' ($REPLAYS_DIR) ilegible: $(tail -c 300 "$WORK_DIR/.err-replays")"
  SRC_STATUS[replays]=error
  SRC_FILES[replays]=0
  PARTIAL=1
else
  rcount=0
  copy_ok=1
  while IFS= read -r -d '' f; do
    rcount=$((rcount + 1))
    rel="${f#"$REPLAYS_DIR"/}"
    destf="$STAGING_REPLAYS/$rel"
    if ! mkdir -p "$(dirname "$destf")" || ! cp -a "$f" "$destf" 2>>"$WORK_DIR/.err-replays-cp"; then
      copy_ok=0
      break
    fi
  done < "$WORK_DIR/.replays.list"
  if [ "$rcount" -eq 0 ]; then
    SRC_STATUS[replays]=empty
    SRC_FILES[replays]=0
  elif [ "$copy_ok" = 1 ]; then
    SRC_STATUS[replays]=ok
    SRC_FILES[replays]=$rcount
  else
    log error "fallo copiando replays dentro de retención: $(tail -c 300 "$WORK_DIR/.err-replays-cp")"
    rm -rf "$STAGING_REPLAYS"
    mkdir -p "$STAGING_REPLAYS"
    SRC_STATUS[replays]=error
    SRC_FILES[replays]=0
    PARTIAL=1
  fi
fi
[ "${SRC_STATUS[replays]}" != ok ] && rmdir "$STAGING_REPLAYS" 2>/dev/null || true

# ── 4/5: manifest.sha256 + manifest.json — generados DESDE el staging, así
# que las rutas del manifest son exactamente las rutas que se van a
# restaurar (fix del defecto real de #112: antes el manifest usaba rutas
# relativas "maps/…" mientras los datos se subían a restic con su ruta
# ABSOLUTA de origen, y `restore.sh --verify` nunca encontraba nada). Sólo
# con fuentes `ok` (empty no aporta checksums; error se excluye para no
# ofrecer una integridad falsa). Se escriben DENTRO del staging para que
# viajen con los datos en el mismo snapshot. ────────────────────────────────
log info "4/5 generando manifest (sha256 + cobertura json) dentro del staging"
# D1-R3 (ronda 4 de #112): la generación del manifest NO comprobaba su
# propio estado de salida. `pipefail` está activo a nivel de script, así
# que un fallo de `find` o de `sha256sum` SÍ se propaga al exit code de la
# subshell — pero nadie miraba ese exit code: `(...) > fichero` descarta el
# resultado. Un disco lleno al escribir el manifest, un `find` fallido o
# `sha256sum` ausente producían un manifest.sha256 truncado (o vacío) con
# el staging poblado, y el backup seguía reportando SUCCESS. Comprobado
# aquí explícitamente: si falla, es FULL FAILURE (el manifest es la única
# garantía de integridad que tiene el operador; uno posiblemente truncado
# es peor que no tenerlo, porque `--verify` lo daría por bueno).
# D6-R5 (ronda 6): `! -name 'pgdump-*'`/`! -name 'manifest.*'` excluían por
# NOMBRE BASE en todo el árbol, no sólo en la raíz del staging donde
# realmente viven el dump y los manifests. Un fichero de usuario dentro de
# `maps/` literalmente llamado `pgdump-x` (o `manifest.algo`) escapaba por
# completo al manifest Y al chequeo de residuales de restore.sh —ni se
# respaldaba ni se detectaba su ausencia—. `-path './pgdump-*'` sólo
# coincide con la raíz (una ruta como `./maps/pgdump-x` no empieza por
# "./pgdump-", así que no la excluye).
if ! (cd "$STAGING" && find . -type f ! -path './manifest.*' ! -path './pgdump-*' -exec sha256sum {} + | sed 's| \./| |') \
    > "$STAGING/manifest.sha256" 2>"$WORK_DIR/.err-manifest"; then
  log error "fallo generando manifest.sha256: $(tail -c 300 "$WORK_DIR/.err-manifest")"
  dur=$(( $(date +%s) - start ))
  write_metrics 1 "$dur" 0
  log error "backup FULL FAILURE (manifest de integridad no fiable) tras ${dur}s"
  exit 1
fi

# D1-R3 (ronda 4): además de que el comando no falle, el NÚMERO de líneas
# del manifest debe coincidir con la suma de ficheros que las fuentes no
# críticas declararon `ok`. Sin este contraste, un manifest silenciosamente
# incompleto (p.ej. `sha256sum` interrumpido a mitad de fuente, sin que eso
# tumbe el exit code por algún motivo no previsto) pasaría por bueno igual.
expected_manifest_lines=0
for src in maps bot_sources assets replays; do
  [ "${SRC_STATUS[$src]:-}" = ok ] && expected_manifest_lines=$((expected_manifest_lines + ${SRC_FILES[$src]:-0}))
done
if ! actual_manifest_lines=$(wc -l < "$STAGING/manifest.sha256" 2>"$WORK_DIR/.err-manifest-count"); then
  # No debería poder pasar (el manifest se acaba de escribir ahí mismo),
  # pero si pasa, fallar en cerrado explícitamente en vez de dejar que una
  # variable vacía rompa la comparación aritmética de abajo con un error
  # de bash poco claro.
  log error "no se pudo contar manifest.sha256: $(tail -c 300 "$WORK_DIR/.err-manifest-count")"
  dur=$(( $(date +%s) - start ))
  write_metrics 1 "$dur" 0
  log error "backup FULL FAILURE (manifest de integridad no fiable) tras ${dur}s"
  exit 1
fi
if [ "$actual_manifest_lines" -ne "$expected_manifest_lines" ]; then
  log error "manifest.sha256 inconsistente: $actual_manifest_lines líneas, se esperaban $expected_manifest_lines (suma de ficheros de fuentes 'ok')"
  dur=$(( $(date +%s) - start ))
  write_metrics 1 "$dur" 0
  log error "backup FULL FAILURE (manifest de integridad no fiable) tras ${dur}s"
  exit 1
fi

{
  printf '{'
  first=1
  for src in postgres secrets maps bot_sources replays assets; do
    [ "$first" = 1 ] || printf ','
    first=0
    json_source "$src"
  done
  printf '}\n'
} > "$STAGING/manifest.json"

# ── 5/5: restic — se ejecuta SIEMPRE que las fuentes críticas estén ok,
# guardando lo que sí se pudo capturar (SUCCESS o PARTIAL SUCCESS). Un único
# argumento ($STAGING) porque todo lo que hay que restaurar junto vive ya
# en el mismo árbol relativo que describe el manifest. ─────────────────────
log info "5/5 restic backup del staging (crítico + fuentes no críticas disponibles)"
status=0
snapshot_created=0
if ! setup_ssh; then
  # La clave/known_hosts se validaron legibles arriba, pero copiarlos a
  # ~/.ssh puede fallar igualmente (disco lleno, formato inesperado). Sin
  # ~/.ssh listo, restic fallaría de todas formas al invocar ssh: se corta
  # aquí con el mismo tratamiento que un fallo de restic (FULL FAILURE),
  # en vez de dejar que el error salga confuso desde dentro de restic.
  status=1
fi
if [ "$status" = 0 ] && restic backup --tag s9-arena-data --host "$RESTIC_HOSTNAME" "$STAGING"; then
  snapshot_created=1
else
  status=1
fi
if [ "$status" = 0 ]; then
  if ! restic backup --tag s9-arena-secrets --host "$RESTIC_HOSTNAME" "$SECRETS_DIR"; then
    status=1
  fi
fi
if [ "$status" = 0 ]; then
  # --group-by host,tags (revisión del supervisor, mutación M12): sin
  # fijarlo, restic decide la agrupación con el DEFAULT del binario
  # (host,paths). Eso ata la retención a la RUTA absoluta del staging
  # ($WORK_DIR/staging), que hoy es estable sólo porque docker-compose.yml
  # fija WORK_DIR — una coincidencia de configuración, no una garantía. Si
  # WORK_DIR cambiase o el staging se generase con un componente variable
  # en la ruta (p.ej. "$WORK_DIR/staging-$RANDOM"), cada ejecución volvería
  # a abrir un grupo de retención nuevo aunque el HOST fuera estable —
  # exactamente la misma patología de crecimiento sin límite que motiva
  # este fix, reabierta por otra puerta. Agrupar explícitamente por
  # host,tags (los --tag s9-arena-data/s9-arena-secrets son estables por
  # construcción, a diferencia de la ruta) hace que la retención dependa
  # SÓLO de RESTIC_HOSTNAME + el tag, nunca de rutas del contenedor.
  restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune --host "$RESTIC_HOSTNAME" --group-by host,tags || status=1
  restic check || status=1
fi

# Si restic falló pese a tener fuentes críticas ok, es FULL FAILURE (no hay
# snapshot fiable). Si restic fue bien pero alguna fuente no crítica dio
# error, es PARTIAL SUCCESS (2). Si todo fue ok/empty, SUCCESS (0).
if [ "$status" != 0 ]; then
  status=1
elif [ "$PARTIAL" = 1 ]; then
  status=2
fi

dur=$(( $(date +%s) - start ))
write_metrics "$status" "$dur" "$snapshot_created"
case "$status" in
  0) log info "backup SUCCESS en ${dur}s" ;;
  2) log error "backup PARTIAL SUCCESS (fuente no crítica en error) tras ${dur}s" ;;
  *) log error "backup FULL FAILURE (exit $status) tras ${dur}s" ;;
esac
exit "$status"
