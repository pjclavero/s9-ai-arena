#!/usr/bin/env bash
# Mutantes de apps/api/src/testing/test-db.ts (carrera de freePort). Commitea antes de lanzarlo.
set -u
cd "$(dirname "$0")/.."
F=apps/api/src/testing/test-db.ts
T=apps/api/src/testing/test-db-port.test.ts
RUN() { nice -n 19 node node_modules/vitest/vitest.mjs run --maxWorkers=1 "$T" 2>&1; }
git diff --quiet -- "$F" "$T" || { echo "ABORTA: cambios sin commitear"; exit 2; }
out=$(RUN); rc=$?; echo "BASE rc=$rc"
[ "$rc" -eq 0 ] || { echo "$out" | tail -20; exit 1; }
fail=0
mutant() {
  local name=$1 expect=$2 old=$3 new=$4
  python3 - "$F" "$old" "$new" <<'PY'
import sys
f, old, new = sys.argv[1:4]
s = open(f).read()
assert s.count(old) == 1, f"patrón no único/ausente: {old}"
open(f, "w").write(s.replace(old, new))
PY
  [ $? -eq 0 ] || { echo "MUTANTE $name: no aplicable"; fail=1; git checkout -q -- "$F"; return; }
  out=$(RUN); rc=$?
  git checkout -q -- "$F"
  if [ "$rc" -ne 0 ] && echo "$out" | grep -q "FAIL .*$expect"; then echo "MUTANTE $name: MUERTO por «$expect»"
  else echo "MUTANTE $name: SUPERVIVIENTE (rc=$rc)"; fail=1; fi
}
mutant T1-sin-relanzar "PUERTO ocupado confirmado" \
  "if (!opts.isBusy(e) || attempt >= max) throw e;" "throw e;"
mutant T2-reintento-ciego "OTRO error se propaga" \
  "if (!opts.isBusy(e) || attempt >= max) throw e;" "if (attempt >= max) throw e;"
mutant T3-sin-tope "TOPE" \
  "if (!opts.isBusy(e) || attempt >= max) throw e;" "if (!opts.isBusy(e)) throw e;"
mutant T4-ipv4-parcial-no-detectado "señal real de puerto ocupado" \
  "could not bind IPv4 address[^\\n]*address already in use" "zzz-nunca"
git diff --quiet -- "$F" || { echo "ÁRBOL SUCIO"; fail=1; }
[ "$fail" -eq 0 ] && echo "TODOS LOS MUTANTES MUERTOS, árbol limpio" || echo "HAY FALLOS"
exit "$fail"
