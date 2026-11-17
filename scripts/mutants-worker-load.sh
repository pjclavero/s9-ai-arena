#!/usr/bin/env bash
# PR C · mutantes de la carga del worker. Cada uno debe morir por un test nombrado.
# Requisitos: árbol LIMPIO y commiteado (el harness hace git checkout al final);
# ejecutar SÓLO en VM111 (npm ci hecho). Uso: bash scripts/mutants-worker-load.sh
set -u
case "$(hostname)" in ia-server) echo "STOP: sólo en VM111"; exit 1;; esac
cd "$(dirname "$0")/.."
T=apps/tournament-worker/src/worker-load.test.ts
RUN="npx vitest run $T --reporter=dot"
[ -z "$(git status --porcelain)" ] || { echo "árbol sucio"; exit 2; }
$RUN >/tmp/mut-base.log 2>&1 || { echo "BASE ROJA"; tail -20 /tmp/mut-base.log; exit 3; }
echo "BASE verde"
fail=0
mut() { # id fichero sed-expr test-asesino
  local id=$1 f=$2 expr=$3 killer=$4
  sed -i -E "$expr" "$f"
  if git diff --quiet -- "$f"; then echo "$id: el sed no cambió nada"; fail=1; return; fi
  out=$($RUN 2>&1); rc=$?
  git checkout -q -- "$f"
  if [ $rc -ne 0 ] && echo "$out" | grep -qF "$killer"; then echo "$id: MUERTO por «$killer»"
  else echo "$id: SUPERVIVIENTE o muerto por otro test (rc=$rc, esperado «$killer»)"; fail=1; fi
}
W=apps/tournament-worker/src/worker.ts
C=apps/tournament-worker/src/cpu-sampler.ts
mut M-C1 $W 's/return n;\n//;/function concurrencyFromEnv/,/^}/ s/  return n;/  return 3;/' "entero válido"
mut M-C2 $W 's/n < 1 \|\| n > MAX_CONFIGURED_CONCURRENCY/n < 1/' "0, negativo, sobre el tope"
mut M-C3 $W 's/n < 1 \|\| n > MAX/n < 0 || n > MAX/' "0, negativo, sobre el tope"
mut M-C4 $W 's/this\.config\.concurrency \?\? computeConcurrency\(\)/computeConcurrency()/' "respeta la concurrencia configurada"
mut M-C5 $C 's/DEFAULT_CPU_SAMPLE_MS = 2_000/DEFAULT_CPU_SAMPLE_MS = 500/' "intervalo de muestreo acotado"
mut M-C6 $C 's/Math.max\(MIN_CPU_SAMPLE_MS, Math.round\(ms\)\)/Math.round(ms)/' "intervalo de muestreo acotado"
mut M-C7 $C 's/if \(this\.inFlight\[i\]\) \{/if (false) {/' "no se apilan"
mut M-C8 $C 's/this\.last\[i\] === null \|\| v > this\.last\[i\]!/true/' "conserva la cota inferior"
mut M-C9 $C 's/if \(this\.isDead\(i\)\) continue;//' "sólo contenedores vivos"
git diff --quiet && echo "árbol limpio" || { echo "ÁRBOL SUCIO"; fail=1; }
exit $fail
