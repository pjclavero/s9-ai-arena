#!/usr/bin/env bash
# OLA 2 · G1 · Envoltorio reproducible de las matrices de mutantes (mc, md, mb, g1).
#
#   S9_HEAVY_LOCK=<cerrojo> [S9_NODE_BIN=<dir>] scripts/hardening/run-mutants.sh <matriz> <worktree> <salida.json> [IDS]
#
#  · <matriz>: mc | md | mb | g1 (scripts/hardening/<matriz>-mutants.py).
#  · <worktree>: checkout detached y LIMPIO del SHA a calibrar, con node_modules instalados.
#  · Se niega a correr sin cerrojo (S9_HEAVY_LOCK): las tandas pesadas van en serie.
#  · Primero comprueba las anclas (--dry-run); si alguna no es única, no ejecuta nada.
#  · Usa SIEMPRE la matriz del propio worktree (la versionada en ese SHA).
set -euo pipefail
[ $# -ge 3 ] || { echo "uso: $0 <mc|md|mb|g1> <worktree> <salida.json> [IDS]" >&2; exit 2; }
matrix=$1 wt=$(cd "$2" && pwd) out=$3 ids=${4:-}
script="$wt/scripts/hardening/${matrix}-mutants.py"
[ -f "$script" ] || { echo "no existe $script" >&2; exit 2; }
: "${S9_HEAVY_LOCK:?S9_HEAVY_LOCK no definido: las tandas pesadas van bajo cerrojo}"
python3 -I -B "$script" "$wt" /dev/null --dry-run >/dev/null || { echo "anclas no únicas: abortar" >&2; exit 3; }
rc=0
flock -o "$S9_HEAVY_LOCK" python3 -I -B "$script" "$wt" "$out" ${ids:+"$ids"} || rc=$?
echo "MUTANTS_RC=$rc matriz=$matrix head=$(git -C "$wt" rev-parse HEAD)"
exit $rc
