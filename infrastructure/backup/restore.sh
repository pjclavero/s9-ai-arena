#!/usr/bin/env bash
# Restauración desde el último backup restic (runbook: docs/recuperacion.md).
#
#   restore.sh --list                  lista snapshots disponibles
#   restore.sh --restore <destino>     restaura el último snapshot de datos
#   restore.sh --restore-secrets <destino>
#   restore.sh --verify <dir>          verifica manifest.sha256 restaurado
#   restore.sh --dry-run               plan sin tocar nada (probado por vitest)
set -euo pipefail

log() { printf '{"ts":"%s","level":"%s","service":"restore","msg":"%s"}\n' "$(date -u +%FT%TZ)" "$1" "$2"; }

case "${1:---dry-run}" in
  --dry-run)
    log info "DRY-RUN: plan de restauración"
    echo "PLAN 1 · restic snapshots --tag s9-arena-data (elegir snapshot)"
    echo "PLAN 2 · restic restore latest --tag s9-arena-data --target <destino>"
    echo "PLAN 3 · pg_restore -c -h \$PGHOST -U \$PGUSER -d \$PGDATABASE <destino>/…/pgdump-*.dump"
    echo "PLAN 4 · copiar mapas/fuentes/replays a los volúmenes y restic restore --tag s9-arena-secrets"
    echo "PLAN 5 · restore.sh --verify <destino> (manifest.sha256) + migraciones al día"
    echo "CONFIG $( [ -n "${RESTIC_REPOSITORY:-}" ] && echo OK || echo "INCOMPLETA: falta RESTIC_REPOSITORY" )"
    ;;
  --list)
    restic snapshots
    ;;
  --restore)
    dest="${2:?uso: restore.sh --restore <destino>}"
    restic restore latest --tag s9-arena-data --target "$dest"
    log info "datos restaurados en $dest; siga el runbook docs/recuperacion.md"
    ;;
  --restore-secrets)
    dest="${2:?uso: restore.sh --restore-secrets <destino>}"
    umask 077
    restic restore latest --tag s9-arena-secrets --target "$dest"
    log info "secretos restaurados en $dest (permisos restrictivos; NO volcarlos a logs)"
    ;;
  --verify)
    dir="${2:?uso: restore.sh --verify <dir-restaurado>}"
    manifest="$(find "$dir" -name manifest.sha256 | head -1)"
    [ -n "$manifest" ] || { log error "manifest.sha256 no encontrado en $dir"; exit 1; }
    # El manifest usa rutas maps/… y official/…: verificar desde su directorio.
    (cd "$(dirname "$manifest")" && sha256sum -c "$manifest")
    log info "integridad verificada: checksums de mapas y replays correctos"
    ;;
  *)
    echo "uso: restore.sh --list | --restore <dest> | --restore-secrets <dest> | --verify <dir> | --dry-run" >&2
    exit 2
    ;;
esac
