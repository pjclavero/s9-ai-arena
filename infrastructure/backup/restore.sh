#!/usr/bin/env bash
# Restauración desde el último backup restic (runbook: docs/recuperacion.md).
#
#   restore.sh --list                  lista snapshots disponibles
#   restore.sh --restore <destino>     restaura el último snapshot de datos
#   restore.sh --restore-secrets <destino>
#   restore.sh --verify <dir>          verifica manifest.sha256 restaurado
#   restore.sh --dry-run               plan sin tocar nada (probado por vitest)
set -euo pipefail

# D2 (ronda 3 de #112, ver backup.sh): mismo escape antes de interpolar en
# el JSON del log — este script también interpola rutas (p.ej. $dir, que
# viene de un argumento de línea de comandos) en el mensaje.
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}
log() { printf '{"ts":"%s","level":"%s","service":"restore","msg":"%s"}\n' "$(date -u +%FT%TZ)" "$1" "$(json_escape "$2")"; }

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
    # #110b: `find | head -1` aceptaba en silencio 0 manifests (verificación
    # que no verifica nada, exit 0 falso) y elegía uno arbitrario si había
    # más de uno (snapshots mezclados). Fallar en cerrado en ambos casos.
    manifests="$(find "$dir" -name manifest.sha256)"
    manifest_count=0
    [ -n "$manifests" ] && manifest_count=$(printf '%s\n' "$manifests" | grep -c .)
    if [ "$manifest_count" -eq 0 ]; then
      log error "manifest.sha256 no encontrado en $dir"
      exit 1
    fi
    if [ "$manifest_count" -gt 1 ]; then
      log error "se encontraron $manifest_count manifest.sha256 en $dir (ambiguo; restaura un único snapshot por directorio)"
      exit 1
    fi
    manifest="$manifests"
    # D1 (ronda 3 de #112): un manifest.sha256 de 0 bytes es el resultado
    # LEGÍTIMO de un backup sano cuando las cuatro fuentes no críticas
    # (maps/bot_sources/assets/replays) están vacías — el estado actual de
    # producción (VM108) y el de cualquier instalación recién desplegada.
    # `sha256sum -c` sobre un fichero vacío sale con exit 1 y el mensaje "no
    # properly formatted checksum lines found": un operador siguiendo la
    # Fase 7 del runbook vería un FALLO DURO sobre un backup perfecto. Un
    # manifest vacío SÍ existe (a diferencia de "ausente", ya descartado
    # arriba) y no tiene líneas que puedan estar corruptas: no hay nada que
    # verificar, y eso es distinto de "algo falló". Se declara éxito
    # explícitamente, no se omite la comprobación en silencio.
    if [ ! -s "$manifest" ]; then
      log info "manifest.sha256 vacío: ninguna fuente no crítica tenía contenido en este backup (cobertura 'empty'); nada que verificar"
    else
      # El manifest usa rutas maps/… y replays/…: verificar desde su directorio.
      (cd "$(dirname "$manifest")" && sha256sum -c "$manifest")
    fi
    log info "integridad verificada: checksums de mapas y replays correctos"
    ;;
  *)
    echo "uso: restore.sh --list | --restore <dest> | --restore-secrets <dest> | --verify <dir> | --dry-run" >&2
    exit 2
    ;;
esac
