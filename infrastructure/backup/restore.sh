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

# ── Verificación de integridad (fail-closed) ─────────────────────────────────
# El manifest lista rutas LÓGICAS (maps/…, official/…), pero `restic restore`
# reconstruye bajo el destino la jerarquía ABSOLUTA de origen: el manifest
# acaba junto al pgdump y NO junto a maps/ ni official/. Por eso NO se puede
# verificar con `cd $(dirname manifest) && sha256sum -c` (fallaría el 100 % de
# las entradas aunque el backup fuese perfecto). Cada entrada se resuelve
# buscando, en todo el árbol restaurado, el fichero cuya ruta termina
# exactamente en esa ruta lógica.
#
# FALLA (exit != 0), nunca «verificado», si:
#   · no hay manifest, o hay más de uno (destino con varios snapshots);
#   · el manifest está vacío o no tiene ninguna entrada válida;
#   · alguna línea está malformada (fail-closed: no se ignora);
#   · alguna entrada no se resuelve o es ambigua (varios candidatos);
#   · algún checksum no coincide;
#   · el número de entradas verificadas no coincide con el total, o es cero.
# Sólo se registran nombres lógicos y recuentos: jamás secretos ni rutas de
# credenciales.
verify_restored_tree() {
  dir="$1"
  [ -d "$dir" ] || { log error "destino inexistente o no es un directorio"; return 1; }

  manifests="$(find "$dir" -type f -name manifest.sha256 | sort)"
  [ -n "$manifests" ] || { log error "manifest.sha256 no encontrado en el árbol restaurado"; return 1; }
  n_manifests="$(printf '%s\n' "$manifests" | wc -l)"
  if [ "$n_manifests" -ne 1 ]; then
    log error "se han encontrado $n_manifests manifest.sha256 en el destino: restaure un único snapshot"
    return 1
  fi
  manifest="$manifests"

  work="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$work'" RETURN
  entries="$work/entries.tsv"
  index="$work/index.txt"
  checks="$work/checks.sha256"

  # 1. Parseo estricto del manifest → hash<TAB>ruta lógica.
  : > "$entries"
  total=0
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "${line//[[:space:]]/}" ] || continue
    hash="${line:0:64}"
    sep="${line:64:2}"
    logical="${line:66}"
    case "$hash" in
      *[!0-9a-fA-F]* | "") log error "manifest con línea malformada (hash no hexadecimal de 64): verificación abortada"; return 1 ;;
    esac
    if [ "${#hash}" -ne 64 ] || { [ "$sep" != "  " ] && [ "$sep" != " *" ]; } || [ -z "$logical" ]; then
      log error "manifest con línea malformada (separador o ruta ausentes): verificación abortada"
      return 1
    fi
    case "$logical" in
      *\\*) log error "manifest con ruta escapada (contiene '\\'): verificación abortada"; return 1 ;;
    esac
    printf '%s\t%s\n' "$hash" "$logical" >> "$entries"
    total=$((total + 1))
  done < "$manifest"

  if [ "$total" -eq 0 ]; then
    log error "manifest sin entradas: no se ha verificado NADA (fail-closed)"
    return 1
  fi

  # 2. Índice de ficheros restaurados (una sola pasada por el árbol).
  find "$dir" -type f ! -name manifest.sha256 -print > "$index"

  # 3. Resolución por sufijo: cada ruta lógica debe corresponder a EXACTAMENTE
  #    un fichero del árbol restaurado.
  if ! awk -F'\t' -v OFS='' '
    NR == FNR {
      n = split($0, c, "/"); b = c[n]
      cnt[b]++; paths[b, cnt[b]] = $0
      next
    }
    {
      hash = $1; logical = $2
      m = split(logical, lc, "/"); lb = lc[m]
      found = 0; hit = ""
      for (i = 1; i <= cnt[lb]; i++) {
        p = paths[lb, i]
        suffix = "/" logical
        if (length(p) > length(suffix) && substr(p, length(p) - length(suffix) + 1) == suffix) {
          found++; hit = p
        }
      }
      if (found == 0) { print "MISSING\t" logical > "/dev/stderr"; bad = 1; next }
      if (found > 1) { print "AMBIGUOUS\t" logical > "/dev/stderr"; bad = 1; next }
      print hash "  " hit
    }
    END { if (bad) exit 1 }
  ' "$index" "$entries" > "$checks" 2> "$work/unresolved"; then
    log error "entradas del manifest no resueltas en el árbol restaurado ($(wc -l < "$work/unresolved") de $total); primeras:"
    head -5 "$work/unresolved" >&2
    return 1
  fi

  resolved="$(wc -l < "$checks")"
  if [ "$resolved" -ne "$total" ]; then
    log error "entradas resueltas ($resolved) != entradas del manifest ($total): verificación abortada"
    return 1
  fi

  # 4. Comparación real de checksums.
  if ! sha256sum -c --strict --quiet "$checks"; then
    log error "checksums no coincidentes: los datos restaurados NO son íntegros"
    return 1
  fi

  log info "integridad verificada: $resolved/$total entradas del manifest correctas (mapas y replays oficiales)"
  return 0
}

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
    verify_restored_tree "$dir"
    ;;
  *)
    echo "uso: restore.sh --list | --restore <dest> | --restore-secrets <dest> | --verify <dir> | --dry-run" >&2
    exit 2
    ;;
esac
