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
# de la BD o sin los secretos, un backup "parcial" sería engañoso.
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
#      restic; sus VALORES no aparecen jamás en logs, manifest ni git.
#      (crítica)
#   5. manifest.sha256 (checksums, para restaurar) y manifest.json (cobertura
#      por fuente: qué se guardó, qué estaba vacío, qué falló). El manifest
#      NUNCA contiene secretos ni variables de entorno.
# Destino: RESTIC_REPOSITORY (NAS/ZFS designado por el operador).
# Métricas: escribe s9_backup_* en METRICS_DIR (textfile collector de
#   node-exporter) → alertas BackupFailed / BackupTooOld (26 h).
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

# classify_dir NOMBRE DIRECTORIO
# Clasifica un directorio de datos genérico (no-crítico). Nunca aborta el
# script: registra el resultado en SRC_STATUS/SRC_FILES y, si hay error,
# marca PARTIAL=1 (el backup sigue con el resto de fuentes).
classify_dir() {
  local name="$1" dir="$2" files
  if [ ! -d "$dir" ]; then
    # Ausencia esperable (contenido aún no subido a ese volumen): empty, no error.
    SRC_STATUS[$name]=empty
    SRC_FILES[$name]=0
    return 0
  fi
  if ! files=$(find "$dir" -type f 2>"$WORK_DIR/.err-$name"); then
    log error "fuente '$name' ($dir) ilegible: $(tail -c 300 "$WORK_DIR/.err-$name")"
    SRC_STATUS[$name]=error
    SRC_FILES[$name]=0
    PARTIAL=1
    return 1
  fi
  local count=0
  [ -n "$files" ] && count=$(printf '%s\n' "$files" | grep -c .)
  if [ "$count" -eq 0 ]; then
    SRC_STATUS[$name]=empty
    SRC_FILES[$name]=0
  else
    SRC_STATUS[$name]=ok
    SRC_FILES[$name]=$count
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
  echo "PLAN 1/5 · pg_dump -Fc -h $PGHOST -U $PGUSER $PGDATABASE -f pgdump-\$(fecha).dump [fuente crítica]"
  echo "PLAN 2/5 · clasificar fuentes (ok/empty/error): maps, bot_sources, replays, assets, secrets"
  echo "PLAN 3/5 · manifest.sha256 + manifest.json (cobertura por fuente, sin secretos)"
  echo "PLAN 4/5 · restic backup: datos válidos (crítico + no críticos en estado ok/empty) + replays <= $REPLAY_RETENTION_DAYS días (official/ sin límite)"
  echo "PLAN 5/5 · restic backup de $SECRETS_DIR [fuente crítica] + restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune && restic check"
  echo "MÉTRICAS · $METRICS_DIR/s9_backup.prom (alerta si falla o si no hay éxito en 26 h)"
  echo "EXIT · 0 SUCCESS / 1 FULL FAILURE (fuente crítica o restic) / 2 PARTIAL SUCCESS (fuente no crítica en error)"
  [ "$errors" = 0 ] && echo "CONFIG OK" || echo "CONFIG INCOMPLETA (ver errores arriba)"
  exit "$errors"
fi

[ "$errors" = 0 ] || { write_metrics 1 0 0; exit 1; }

start=$(date +%s)
mkdir -p "$WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

# ── 1/5: PostgreSQL (fuente CRÍTICA) ───────────────────────────────────────
log info "1/5 pg_dump de $PGDATABASE (fuente crítica)"
PGDUMP_FILE="$WORK_DIR/pgdump-$(date -u +%Y%m%d%H%M%S).dump"
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
# backup real de su CONTENIDO lo hace restic más abajo, y jamás se vuelca a
# manifest/log (DoD T10.4: los valores no aparecen jamás fuera de restic). ──
if [ "$FULL_FAILURE" = 0 ]; then
  log info "2/5 comprobando legibilidad de $SECRETS_DIR (fuente crítica; contenido nunca se lista)"
  if secret_count=$(find "$SECRETS_DIR" -type f 2>"$WORK_DIR/.err-secrets" | grep -c .); then
    SRC_STATUS[secrets]=ok
    SRC_FILES[secrets]=$secret_count
  else
    log error "secrets ilegible: $(tail -c 300 "$WORK_DIR/.err-secrets")"
    SRC_STATUS[secrets]=error
    SRC_FILES[secrets]=0
    FULL_FAILURE=1
  fi
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

# ── 3/5: fuentes NO críticas — cada una se clasifica de forma independiente;
# un error aquí NUNCA impide que restic guarde el resto (ver cabecera). ─────
log info "3/5 clasificando fuentes no críticas: maps, bot_sources, assets, replays"
classify_dir maps "$MAPS_DIR"
classify_dir bot_sources "$BOT_SOURCES_DIR"
classify_dir assets "$ASSETS_DIR"

# Replays: alcance ampliado respecto a la versión anterior (ver cabecera).
# Se copia TODO $REPLAYS_DIR dentro de la retención; official/, si existe,
# se trata como preferente y se incluye siempre sin límite de retención.
RECENT_REPLAYS="$WORK_DIR/replays-recent"
mkdir -p "$RECENT_REPLAYS"
if [ ! -d "$REPLAYS_DIR" ]; then
  SRC_STATUS[replays]=empty
  SRC_FILES[replays]=0
elif ! replay_files=$(find "$REPLAYS_DIR" -type f \
    \( -path "$REPLAYS_DIR/official/*" -o -mtime "-$REPLAY_RETENTION_DAYS" \) \
    2>"$WORK_DIR/.err-replays"); then
  log error "fuente 'replays' ($REPLAYS_DIR) ilegible: $(tail -c 300 "$WORK_DIR/.err-replays")"
  SRC_STATUS[replays]=error
  SRC_FILES[replays]=0
  PARTIAL=1
else
  rcount=0
  [ -n "$replay_files" ] && rcount=$(printf '%s\n' "$replay_files" | grep -c .)
  if [ "$rcount" -eq 0 ]; then
    SRC_STATUS[replays]=empty
    SRC_FILES[replays]=0
  else
    if printf '%s\n' "$replay_files" | xargs -I{} cp --parents -t "$RECENT_REPLAYS" {} 2>"$WORK_DIR/.err-replays-cp"; then
      SRC_STATUS[replays]=ok
      SRC_FILES[replays]=$rcount
    else
      log error "fallo copiando replays dentro de retención: $(tail -c 300 "$WORK_DIR/.err-replays-cp")"
      SRC_STATUS[replays]=error
      SRC_FILES[replays]=0
      PARTIAL=1
    fi
  fi
fi

# ── 4/5: manifest.sha256 + manifest.json — sólo con fuentes ok (empty no
# aporta checksums; error se excluye para no ofrecer una integridad falsa). ──
log info "4/5 generando manifest (sha256 + cobertura json)"
: > "$WORK_DIR/manifest.sha256"
[ "${SRC_STATUS[maps]:-}" = ok ] && (cd "$MAPS_DIR" && find . -type f -exec sha256sum {} + | sed 's| \./| maps/|') >> "$WORK_DIR/manifest.sha256"
[ "${SRC_STATUS[bot_sources]:-}" = ok ] && (cd "$BOT_SOURCES_DIR" && find . -type f -exec sha256sum {} + | sed 's| \./| bot_sources/|') >> "$WORK_DIR/manifest.sha256"
[ "${SRC_STATUS[assets]:-}" = ok ] && (cd "$ASSETS_DIR" && find . -type f -exec sha256sum {} + | sed 's| \./| assets/|') >> "$WORK_DIR/manifest.sha256"
[ "${SRC_STATUS[replays]:-}" = ok ] && (cd "$RECENT_REPLAYS" && find . -type f -exec sha256sum {} + | sed 's| \./| replays/|') >> "$WORK_DIR/manifest.sha256"

{
  printf '{'
  first=1
  for src in postgres secrets maps bot_sources replays assets; do
    [ "$first" = 1 ] || printf ','
    first=0
    json_source "$src"
  done
  printf '}\n'
} > "$WORK_DIR/manifest.json"

# ── 5/5: restic — se ejecuta SIEMPRE que las fuentes críticas estén ok,
# guardando lo que sí se pudo capturar (SUCCESS o PARTIAL SUCCESS). ────────
log info "5/5 restic backup de datos (crítico + fuentes no críticas disponibles)"
RESTIC_ARGS=("$PGDUMP_FILE" "$WORK_DIR/manifest.sha256" "$WORK_DIR/manifest.json")
[ "${SRC_STATUS[maps]:-}" = ok ] && RESTIC_ARGS+=("$MAPS_DIR")
[ "${SRC_STATUS[bot_sources]:-}" = ok ] && RESTIC_ARGS+=("$BOT_SOURCES_DIR")
[ "${SRC_STATUS[assets]:-}" = ok ] && RESTIC_ARGS+=("$ASSETS_DIR")
[ "${SRC_STATUS[replays]:-}" = ok ] && RESTIC_ARGS+=("$RECENT_REPLAYS")

status=0
snapshot_created=0
if restic backup --tag s9-arena-data "${RESTIC_ARGS[@]}"; then
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
