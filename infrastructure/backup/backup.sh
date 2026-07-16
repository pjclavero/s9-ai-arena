#!/usr/bin/env bash
# Backup diario de S9 AI Arena (T10.4, cap. 24; ADR-010 D10.4).
#
# Qué copia:
#   1. PostgreSQL: pg_dump lógico en formato custom comprimido.
#   2. Volúmenes arena_maps y arena_bot_sources completos.
#   3. arena_replays: SOLO los oficiales (subdirectorio official/) dentro de la
#      retención REPLAY_RETENTION_DAYS.
#   4. Secretos (infrastructure/secrets): cifrados por el propio repositorio
#      restic; sus VALORES no aparecen jamás en logs ni en el repo git.
#   5. manifest.sha256: checksums de mapas y replays para verificar la
#      integridad al restaurar (docs/recuperacion.md).
# Destino: RESTIC_REPOSITORY (NAS/ZFS designado por el operador).
# Métricas: escribe s9_backup_* en METRICS_DIR (textfile collector de
#   node-exporter) → alertas BackupFailed / BackupTooOld (26 h).
#
# Modos:
#   backup.sh            backup real (requiere restic, pg_dump y el repo).
#   backup.sh --dry-run  imprime el plan y valida configuración SIN escribir
#                        nada ni requerir docker (probado por vitest).
set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# ── Configuración (sobreescribible por entorno; valores del contenedor backup) ─
MAPS_DIR="${MAPS_DIR:-/data/maps}"
BOT_SOURCES_DIR="${BOT_SOURCES_DIR:-/data/bot-sources}"
REPLAYS_DIR="${REPLAYS_DIR:-/data/replays}"
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

write_metrics() { # $1 exit_code $2 duration_s
  [ "$DRY_RUN" = 1 ] && return 0
  mkdir -p "$METRICS_DIR"
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
  echo "PLAN 1/5 · pg_dump -Fc -h $PGHOST -U $PGUSER $PGDATABASE -f pgdump-\$(fecha).dump"
  echo "PLAN 2/5 · manifest.sha256 de $MAPS_DIR y $REPLAYS_DIR/official (integridad para la restauración)"
  echo "PLAN 3/5 · restic backup: $MAPS_DIR $BOT_SOURCES_DIR + replays oficiales <= $REPLAY_RETENTION_DAYS días"
  echo "PLAN 4/5 · restic backup de $SECRETS_DIR (cifrado por restic; valores nunca en logs)"
  echo "PLAN 5/5 · restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune && restic check"
  echo "MÉTRICAS · $METRICS_DIR/s9_backup.prom (alerta si falla o si no hay éxito en 26 h)"
  [ "$errors" = 0 ] && echo "CONFIG OK" || echo "CONFIG INCOMPLETA (ver errores arriba)"
  exit "$errors"
fi

[ "$errors" = 0 ] || { write_metrics 1 0; exit 1; }

start=$(date +%s)
status=0
(
  set -e
  mkdir -p "$WORK_DIR"
  trap 'rm -rf "$WORK_DIR"' EXIT

  log info "1/5 pg_dump de $PGDATABASE"
  export PGPASSWORD="$(cat "${PGPASSWORD_FILE:?PGPASSWORD_FILE requerido}")"
  pg_dump -Fc -h "$PGHOST" -U "$PGUSER" "$PGDATABASE" -f "$WORK_DIR/pgdump-$(date -u +%Y%m%d%H%M%S).dump"
  unset PGPASSWORD

  log info "2/5 manifest de integridad (sha256 de mapas y replays oficiales)"
  : > "$WORK_DIR/manifest.sha256"
  [ -d "$MAPS_DIR" ] && (cd "$MAPS_DIR" && find . -type f -exec sha256sum {} + | sed 's| \./| maps/|') >> "$WORK_DIR/manifest.sha256"
  [ -d "$REPLAYS_DIR/official" ] && (cd "$REPLAYS_DIR" && find official -type f -exec sha256sum {} +) >> "$WORK_DIR/manifest.sha256"

  log info "3/5 restic backup de datos (mapas, fuentes de bots, replays oficiales, dump)"
  # Replays: solo official/ dentro de la retención.
  RECENT_OFFICIAL="$WORK_DIR/replays-official"
  mkdir -p "$RECENT_OFFICIAL"
  if [ -d "$REPLAYS_DIR/official" ]; then
    find "$REPLAYS_DIR/official" -type f -mtime "-$REPLAY_RETENTION_DAYS" \
      -exec cp --parents -t "$RECENT_OFFICIAL" {} + 2>/dev/null || true
  fi
  restic backup --tag s9-arena-data "$MAPS_DIR" "$BOT_SOURCES_DIR" "$RECENT_OFFICIAL" "$WORK_DIR"/pgdump-*.dump "$WORK_DIR/manifest.sha256"

  log info "4/5 restic backup de secretos (cifrados por restic)"
  restic backup --tag s9-arena-secrets "$SECRETS_DIR"

  log info "5/5 retención y verificación del repositorio"
  restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
  restic check
) || status=$?

dur=$(( $(date +%s) - start ))
write_metrics "$status" "$dur"
if [ "$status" = 0 ]; then
  log info "backup completado en ${dur}s"
else
  log error "backup FALLIDO (exit $status) tras ${dur}s"
fi
exit "$status"
