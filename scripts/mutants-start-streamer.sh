#!/usr/bin/env bash
# Mutantes de calibración de apps/streamer/tests/support/start-streamer.ts (flaky eq6c P2-3).
# Cada mutante reintroduce una parte del patrón antiguo y debe morir por UN test nombrado de
# apps/streamer/tests/start-streamer.test.ts. Línea base en verde y árbol limpio al final.
# IMPORTANTE: commitea antes de lanzarlo (el script revierte el fichero con `git checkout`).
set -u
cd "$(dirname "$0")/.."
F=apps/streamer/tests/support/start-streamer.ts
T=apps/streamer/tests/start-streamer.test.ts
RUN() { nice -n 19 npx vitest run --maxWorkers=1 "$T" 2>&1; }

if ! git diff --quiet -- "$F" "$T"; then echo "ABORTA: hay cambios sin commitear en $F/$T"; exit 2; fi

out=$(RUN); rc=$?
echo "BASE rc=$rc"
[ "$rc" -eq 0 ] || { echo "línea base NO verde"; echo "$out" | tail -20; exit 1; }

fail=0
mutant() { # nombre, test que debe morir, old, new
  local name=$1 expect=$2 old=$3 new=$4
  python3 - "$F" "$old" "$new" <<'PY'
import sys
f, old, new = sys.argv[1:4]
s = open(f).read()
assert s.count(old) == 1, f"patrón no único/ausente: {old}"
open(f, "w").write(s.replace(old, new))
PY
  [ $? -eq 0 ] || { echo "MUTANTE $name: no se pudo aplicar"; fail=1; git checkout -q -- "$F"; return; }
  out=$(RUN); rc=$?
  git checkout -q -- "$F"
  if [ "$rc" -ne 0 ] && echo "$out" | grep -q "FAIL .*$expect"; then
    echo "MUTANTE $name: MUERTO por «$expect» (rc=$rc)"
  else
    echo "MUTANTE $name: SUPERVIVIENTE (rc=$rc, esperaba que muriera «$expect»)"; fail=1
  fi
}

# S1 · sin relanzar ante EADDRINUSE (un solo intento): vuelve el flaky.
mutant S1-sin-relanzar "PUERTO: si el puerto elegido ya está ocupado" \
  "...(o.maxAttempts ? { maxAttempts: o.maxAttempts } : {})," \
  "maxAttempts: 1,"
# S2 · puerto sorteado 20000+random sin reservar (patrón antiguo): ignora pickPort.
mutant S2-puerto-aleatorio "IDENTIDAD" \
  "...(o.pickPort ? { pickPort: o.pickPort } : {})," \
  "pickPort: async () => 20000 + Math.floor(Math.random() * 20000),"
# S3 · «up» con cualquier salida del hijo en vez de su línea de escucha (identidad no verificada).
mutant S3-ready-laxo "IDENTIDAD" \
  "untilLog: STREAMER_READY," \
  "untilLog: /[\\s\\S]/,"

git diff --quiet -- "$F" || { echo "ÁRBOL SUCIO tras los mutantes"; fail=1; }
[ "$fail" -eq 0 ] && echo "TODOS LOS MUTANTES MUERTOS, árbol limpio" || echo "HAY FALLOS"
exit "$fail"
