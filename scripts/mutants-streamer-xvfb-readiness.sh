#!/usr/bin/env bash
# Mutantes de calibración de apps/streamer/src/xvfb.ts y del entrypoint (readiness y -noreset del Xvfb, AUD2-13).
# Cada mutante debe morir por UN test nombrado de apps/streamer/src/xvfb-readiness.test.ts.
# IMPORTANTE: commitea antes de lanzarlo (el script revierte los ficheros con `git checkout`).
set -u
cd "$(dirname "$0")/.."
X=apps/streamer/src/xvfb.ts
E=infrastructure/docker/streamer/entrypoint.sh
T=apps/streamer/src/xvfb-readiness.test.ts
RUN() { nice -n 19 node node_modules/vitest/vitest.mjs run --maxWorkers=1 "$T" 2>&1; }

if ! git diff --quiet -- "$X" "$E" "$T"; then echo "ABORTA: hay cambios sin commitear"; exit 2; fi
out=$(RUN); rc=$?
echo "BASE rc=$rc"
[ "$rc" -eq 0 ] || { echo "línea base NO verde"; echo "$out" | tail -20; exit 1; }

fail=0
mutant() { # nombre, test que debe morir, fichero, old, new
  local name=$1 expect=$2 f=$3 old=$4 new=$5
  python3 - "$f" "$old" "$new" <<'PY'
import sys
f, old, new = sys.argv[1:4]
s = open(f).read()
assert s.count(old) == 1, f"patrón no único/ausente: {old}"
open(f, "w").write(s.replace(old, new))
PY
  [ $? -eq 0 ] || { echo "MUTANTE $name: no se pudo aplicar"; fail=1; git checkout -q -- "$f"; return; }
  out=$(RUN); rc=$?
  git checkout -q -- "$f"
  if [ "$rc" -ne 0 ] && echo "$out" | grep -q "FAIL .*$expect"; then
    echo "MUTANTE $name: MUERTO por «$expect» (rc=$rc)"
  else
    echo "MUTANTE $name: SUPERVIVIENTE (rc=$rc, esperaba que muriera «$expect»)"; fail=1
  fi
}

mutant M1-xvfb-sin-noreset "XVFB_NORESET" "$X" '"-nolisten", "tcp", "-noreset"]' '"-nolisten", "tcp"]'
mutant M2-listo-por-fichero "XVFB_LISTO_ES_ACEPTAR" "$X" 'if (exists(this.sockPath) && (await accepts(this.sockPath))) return;' 'if (exists(this.sockPath)) return;'
mutant M3-entrypoint-sin-noreset "ENTRYPOINT_NORESET" "$E" '-nolisten tcp -noreset &' '-nolisten tcp &'
mutant M4-entrypoint-listo-por-fichero "ENTRYPOINT_ESPERA_LISTEN" "$E" '&& node -e "$PROBE_JS" "$X_SOCK" 2>/dev/null; then' '; then'
mutant M5-exists-cambia-el-defecto "XVFB_EXISTS_NO_CAMBIA_EL_DEFECTO" "$X" 'this.o.accepts ?? canConnectX' 'this.o.accepts ?? (this.o.exists ? async () => true : canConnectX)'
mutant M6-entrypoint-bucle-sin-plazo "ENTRYPOINT_PLAZO_ACOTADO" "$E" 'while [ "$SECONDS" -lt "$deadline" ]; do' 'while true; do'
mutant M7-entrypoint-sin-comprobar-node "ENTRYPOINT_SIN_NODE" "$E" "command -v node >/dev/null 2>&1 || {" "true || {"
mutant M8-entrypoint-sondeo-sin-timeout "ENTRYPOINT_SONDEO_CON_TIMEOUT" "$E" 'const t=setTimeout(()=>process.exit(1),1000);' 'const t=null;'
mutant M9-entrypoint-plazo-sin-validar "ENTRYPOINT_PLAZO_INVALIDO" "$E" "    '' | *[!0-9]*)" "    NUNCA)"

git diff --quiet -- "$X" "$E" || { echo "ÁRBOL SUCIO tras los mutantes"; fail=1; }
[ "$fail" -eq 0 ] && echo "TODOS LOS MUTANTES MUERTOS, árbol limpio" || echo "HAY FALLOS"
exit "$fail"
