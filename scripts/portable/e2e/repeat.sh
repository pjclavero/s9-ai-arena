#!/usr/bin/env bash
# Repite N veces (por defecto 20) la suite vitest del round-trip portable Y el E2E con procesos reales,
# capturando la salida COMPLETA de cada ejecución en un directorio de evidencias, con su rc real, y
# comprobando tras cada E2E que no queda ningún proceso ni contenedor huérfano.
# SÓLO en el laboratorio (VM de pruebas). Uso:
#   S9_PORTABLE_E2E_LAB=1 flock -o <FICHERO_LOCK> bash scripts/portable/e2e/repeat.sh [N] [DIR_EVIDENCIAS]
set -uo pipefail
# Guarda de anfitrión (consentimiento + señales de producción): ver guard.sh.
source "$(dirname "$0")/guard.sh" || exit 1
s9_portable_guard || { echo STOP; exit 1; }
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"
N=${1:-20}
OUT=${2:-/tmp/s9-portable-repeat-$(date +%Y%m%dT%H%M%S)}
mkdir -p "$OUT"
export E2E_LOG_DIR="$OUT/e2e-logs"
T="apps/api/src/portable-format.test.ts apps/api/src/portable-roundtrip.test.ts"
SUMMARY="$OUT/SUMMARY"
: >"$SUMMARY"
orphans() {
  ps -eo pid,ppid,cmd | grep -E 'apps/api/src/server\.ts|s9portable-(src|dst)' | grep -v grep || true
  docker ps -a --format '{{.Names}}' | grep '^s9portable-' || true
}
bad=0
echo "== vitest x$N ==" | tee -a "$SUMMARY"
for i in $(seq 1 "$N"); do
  npx vitest run $T >"$OUT/vitest-$i.log" 2>&1
  rc=$?
  line=$(sed 's/\x1b\[[0-9;]*m//g' "$OUT/vitest-$i.log" | grep -E "^ +(Tests|Test Files) " | tr -s ' ' | paste -sd'|')
  echo "vitest $i rc=$rc $line" | tee -a "$SUMMARY"
  [ "$rc" = 0 ] || bad=$((bad + 1))
done
echo "== e2e x$N ==" | tee -a "$SUMMARY"
for i in $(seq 1 "$N"); do
  bash scripts/portable/e2e/run.sh >"$OUT/e2e-$i.log" 2>&1
  rc=$?
  ok=$(grep -c '^E2E_PORTABLE_OK' "$OUT/e2e-$i.log")
  left=$(orphans)
  echo "e2e $i rc=$rc ok=$ok huerfanos=$([ -z "$left" ] && echo 0 || echo "$left" | wc -l)" | tee -a "$SUMMARY"
  [ -z "$left" ] || { echo "$left" >>"$SUMMARY"; bad=$((bad + 1)); }
  { [ "$rc" = 0 ] && [ "$ok" = 1 ]; } || bad=$((bad + 1))
done
echo "REPEAT_FALLOS=$bad" | tee -a "$SUMMARY"
[ "$bad" = 0 ]
