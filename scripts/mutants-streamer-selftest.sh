#!/usr/bin/env bash
# Mutantes de calibración de apps/streamer/src/selftest-display.ts (+ render-selftest.ts).
# Cada mutante reintroduce una carrera del display de la autoprueba de render (flaky AUD2-13) y debe morir por UN
# test concreto y nombrado de apps/streamer/src/selftest-display.test.ts. Línea base en verde y árbol limpio al final.
# IMPORTANTE: commitea antes de lanzarlo (el script revierte los ficheros con `git checkout`).
set -u
cd "$(dirname "$0")/.."
D=apps/streamer/src/selftest-display.ts
S=apps/streamer/src/render-selftest.ts
T=apps/streamer/src/selftest-display.test.ts
RUN() { nice -n 19 node node_modules/vitest/vitest.mjs run --maxWorkers=1 "$T" 2>&1; }

if ! git diff --quiet -- "$D" "$S" "$T"; then echo "ABORTA: hay cambios sin commitear"; exit 2; fi

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

# M1 · vuelve el Xvfb que se reinicia al irse el último cliente (sin -noreset).
mutant M1-sin-noreset "NORESET" "$D" \
  '"-nolisten", "tcp", "-noreset"]' '"-nolisten", "tcp"]'
# M2 · «listo» = el fichero del socket existe (no que acepte conexiones).
mutant M2-listo-por-fichero "LISTO_ES_ACEPTAR" "$D" \
  'const probe = o.probe ?? canConnect;' 'const probe = o.probe ?? (async (p: string) => (await import("node:fs")).existsSync(p));'
# M3 · stop() no espera la salida del Xvfb (el siguiente caso arranca con el anterior aún muriendo).
mutant M3-stop-sin-esperar "STOP_ESPERA_SALIDA" "$D" \
  '    await exitP;
    clearTimeout(t);' '    clearTimeout(t);'
# M4 · un único display para todos los casos.
mutant M4-display-compartido "UN_DISPLAY_POR_CASO" "$D" \
  'const h = await start(c.display);' 'const h = await start(cases[0].display);'
# M5 · el display del caso no se para si el caso falla.
mutant M5-sin-parar-si-falla "PARA_AUNQUE_FALLE" "$D" \
  '    } finally {
      await h.stop();
    }' '    } catch (e) {
      throw e;
    }
    await h.stop();'
# M6 · la autoprueba vuelve a levantar su propio Xvfb a mano (sin pasar por startDisplay/readiness).
mutant M6-selftest-xvfb-a-mano "SELFTEST_CABLEADO" "$S" \
  '(display) => startDisplay(display),' '(display) => startDisplay(display, { spawnXvfb: () => spawn("Xvfb", [display]) }),'

git diff --quiet -- "$D" "$S" || { echo "ÁRBOL SUCIO tras los mutantes"; fail=1; }
[ "$fail" -eq 0 ] && echo "TODOS LOS MUTANTES MUERTOS, árbol limpio" || echo "HAY FALLOS"
exit "$fail"
