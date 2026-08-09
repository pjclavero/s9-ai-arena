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
set -uo pipefail
# Nota: NO usamos `set -e` a nivel de script. La clasificación de fuentes
# necesita distinguir "esta fuente falló" de "el script entero debe morir";
# un `set -e` global reintroduciría el mismo defecto que motivó este
# rediseño (un `false` en una comprobación matando el backup completo).

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# ── Configuración (sobreescribible por entorno; valores del contenedor backup) ─
MAPS_DIR="${MAPS_DIR:-/data/maps}"
BOT_SOURCES_DIR="${BOT_SOURCES_DIR:-/data/bot-sources}"
REPLAYS_DIR="${REPLAYS_DIR:-/data/replays}"
ASSETS_DIR="${ASSETS_DIR:-/data/assets}"
SECRETS_DIR="${SECRETS_DIR:-/secrets}"
METRICS_DIR="${METRICS_DIR:-/textfile}"
WORK_DIR="${WORK_DIR:-/tmp/backup-work}"
REPLAY_RETENTION_DAYS="${REPLAY_RETENTION_DAYS:-180}"
PGHOST="${PGHOST:-postgres}"
PGUSER="${PGUSER:-arena}"
PGDATABASE="${PGDATABASE:-arena}"
RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-}"
# RESTIC_PASSWORD_FILE y PGPASSWORD_FILE llegan como secretos montados.

log() { printf '{"ts":"%s","level":"%s","service":"backup","msg":"%s"}\n' "$(date -u +%FT%TZ)" "$1" "$2"; }

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
classify_source() {
  local name="$1" dir="$2" critical="$3" files
  if [ ! -d "$dir" ]; then
    SRC_STATUS[$name]=empty
    SRC_FILES[$name]=0
    return 0
  fi
  if ! files=$(find "$dir" -type f 2>"$WORK_DIR/.err-$name"); then
    log error "fuente '$name' ($dir) ilegible: $(tail -c 300 "$WORK_DIR/.err-$name")"
    SRC_STATUS[$name]=error
    SRC_FILES[$name]=0
    if [ "$critical" = 1 ]; then FULL_FAILURE=1; else PARTIAL=1; fi
    return 1
  fi
  local count=0
  [ -n "$files" ] && count=$(printf '%s\n' "$files" | grep -c . || true)
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

if [ "$DRY_RUN" = 1 ]; then
  log info "DRY-RUN: plan de backup (no se escribe nada)"
  echo "PLAN 1/5 · pg_dump -Fc -h $PGHOST -U $PGUSER $PGDATABASE -f staging/pgdump-\$(fecha).dump [fuente crítica]"
  echo "PLAN 2/5 · clasificar fuentes (ok/empty/error): maps, bot_sources, replays, assets, secrets"
  echo "PLAN 3/5 · construir staging/ (maps/, bot_sources/, assets/, replays/) + manifest.sha256 + manifest.json DENTRO del staging"
  echo "PLAN 4/5 · restic backup del staging completo <= $REPLAY_RETENTION_DAYS días de replays (official/ sin límite) + restic backup de $SECRETS_DIR [fuente crítica, snapshot separado]"
  echo "PLAN 5/5 · restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune && restic check"
  echo "MÉTRICAS · $METRICS_DIR/s9_backup.prom (alerta si falla o si no hay éxito en 26 h)"
  echo "EXIT · 0 SUCCESS / 1 FULL FAILURE (fuente crítica o restic) / 2 PARTIAL SUCCESS (fuente no crítica en error)"
  [ "$errors" = 0 ] && echo "CONFIG OK" || echo "CONFIG INCOMPLETA (ver errores arriba)"
  exit "$errors"
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
(cd "$STAGING" && find . -type f ! -name 'manifest.*' ! -name 'pgdump-*' -exec sha256sum {} + | sed 's| \./| |') > "$STAGING/manifest.sha256"

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
if restic backup --tag s9-arena-data "$STAGING"; then
  snapshot_created=1
else
  status=1
fi
if [ "$status" = 0 ]; then
  if ! restic backup --tag s9-arena-secrets "$SECRETS_DIR"; then
    status=1
  fi
fi
if [ "$status" = 0 ]; then
  restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune || status=1
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
