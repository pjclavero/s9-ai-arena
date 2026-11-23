#!/usr/bin/env bash
# Mutantes de calibración de apps/bot-manager/tests/support/spawn-main.ts.
# Cada mutante reintroduce una de las carreras del harness del docker-proxy y debe morir por UN test
# concreto y nombrado de apps/bot-manager/tests/spawn-main.test.ts. Línea base en verde y árbol limpio al final.
# IMPORTANTE: commitea antes de lanzarlo (el script revierte el fichero con `git checkout`).
set -u
cd "$(dirname "$0")/.."
F=apps/bot-manager/tests/support/spawn-main.ts
T=apps/bot-manager/tests/spawn-main.test.ts
RUN() { nice -n 19 node node_modules/vitest/vitest.mjs run --maxWorkers=1 "$T" 2>&1; }

if ! git diff --quiet -- "$F" "$T"; then echo "ABORTA: hay cambios sin commitear en $F/$T"; exit 2; fi

out=$(RUN); rc=$?
echo "BASE rc=$rc"
[ "$rc" -eq 0 ] || { echo "línea base NO verde"; echo "$out" | tail -20; exit 1; }

fail=0
mutant() { # nombre, test que debe morir, python-replace(old,new)
  local name=$1 expect=$2 old=$3 new=$4
  python3 - "$F" "$old" "$new" <<'EOF'
import sys
f, old, new = sys.argv[1:4]
s = open(f).read()
assert s.count(old) == 1, f"patrón no único/ausente: {old}"
open(f, "w").write(s.replace(old, new))
EOF
  [ $? -eq 0 ] || { echo "MUTANTE $name: no se pudo aplicar"; fail=1; git checkout -q -- "$F"; return; }
  out=$(RUN); rc=$?
  git checkout -q -- "$F"
  if [ "$rc" -ne 0 ] && echo "$out" | grep -q "FAIL .*$expect"; then
    echo "MUTANTE $name: MUERTO por «$expect» (rc=$rc)"
  else
    echo "MUTANTE $name: SUPERVIVIENTE (rc=$rc, esperaba que muriera «$expect»)"; fail=1
  fi
}

# M1 · waitFor deja de esperar al evento: resuelve en el acto (vuelve la carrera de lectura).
mutant M1-waitfor-sin-esperar "LECTURA" \
  "      listeners.add(check);" \
  "      listeners.add(check); done(resolve);"
# M2 · startMain no relanza ante EADDRINUSE (vuelve la carrera del puerto).
mutant M2-sin-relanzar-eaddrinuse "si el puerto elegido ya está ocupado" \
  "if (!/listen EADDRINUSE/.test(p.output()) || attempt >= max) throw e;" \
  "throw e;"
# M3 · relanza ante CUALQUIER salida (reintento ciego).
mutant M3-reintento-ciego "sólo EADDRINUSE se relanza" \
  "if (!/listen EADDRINUSE/.test(p.output()) || attempt >= max) throw e;" \
  "if (attempt >= max) throw e;"
# M4 · no mata ni espera al hijo en el camino de fallo (huérfano).
mutant M4-hijo-sin-matar "si el hijo no llega a anunciar" \
  "      await killTree(p.child, \"SIGTERM\");
      await p.exited;
      if (!/listen EADDRINUSE/" \
  "      if (!/listen EADDRINUSE/"

git diff --quiet -- "$F" || { echo "ÁRBOL SUCIO tras los mutantes"; fail=1; }
[ "$fail" -eq 0 ] && echo "TODOS LOS MUTANTES MUERTOS, árbol limpio" || echo "HAY FALLOS"
exit "$fail"
