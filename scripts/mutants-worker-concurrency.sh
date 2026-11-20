#!/usr/bin/env bash
# V1 · B1 (AUD2-10) · mutantes de la concurrencia segura del worker.
# Cada mutante debe morir por un test NOMBRADO (el id [M-B1-n] va en el título del test).
# Requisitos: árbol LIMPIO y commiteado (el harness hace git checkout); ejecutar sólo en VM111.
# Uso: bash scripts/mutants-worker-concurrency.sh
set -u
cd "$(dirname "$0")/.."
D=apps/tournament-worker/src
FILES="$D/concurrency.test.ts $D/load-config.test.ts $D/worker-load.test.ts"
export NO_COLOR=1 FORCE_COLOR=0
RUN="npx vitest run $FILES --reporter=verbose --maxWorkers=1"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "árbol sucio"; exit 2; }
$RUN >/tmp/mut-b1-base.log 2>&1; rc=$?
[ $rc -eq 0 ] || { echo "BASE ROJA rc=$rc"; tail -30 /tmp/mut-b1-base.log; exit 3; }
echo "BASE verde rc=$rc: $(grep -E '^ +Tests ' /tmp/mut-b1-base.log)"
fail=0
mut() { # id fichero sed-expr test-asesino
  local id=$1 f=$2 expr=$3 killer=$4
  sed -i -E "$expr" "$f"
  if git diff --quiet -- "$f"; then echo "$id: el sed no cambió nada"; fail=1; return; fi
  out=$($RUN 2>&1); rc=$?
  git checkout -q -- "$f"
  if echo "$out" | grep -q "Transform failed"; then echo "$id: INVÁLIDO (no compila)"; fail=1
  elif [ $rc -ne 0 ] && echo "$out" | grep -E '^\s*(×|FAIL)' | grep -qF "$killer"; then echo "$id: MUERTO por «$killer» (rc=$rc)"
  else echo "$id: SUPERVIVIENTE o muerto por otro test (rc=$rc, esperado «$killer»)"; fail=1; fi
}
K=$D/concurrency.ts
L=$D/load-config.ts
W=$D/worker.ts
mut M-B1-1 $K 's/DEFAULT_CONCURRENCY = 1;/DEFAULT_CONCURRENCY = 2;/' "M-B1-1:"
mut M-B1-2 $W 's/this\.config\.concurrency \?\? DEFAULT_CONCURRENCY/this.config.concurrency ?? 3/' "M-B1-2:"
mut M-B1-3 $L 's/\(concurrency \?\? DEFAULT_CONCURRENCY\)/DEFAULT_CONCURRENCY/' "M-B1-3:"
mut M-B1-4 infrastructure/docker-compose.yml 's/TOURNAMENT_WORKER_CONCURRENCY:-1\}/TOURNAMENT_WORKER_CONCURRENCY:-}/' "M-B1-4:"
mut M-B1-5 infrastructure/.env.example 's/^TOURNAMENT_WORKER_CONCURRENCY=1/TOURNAMENT_WORKER_CONCURRENCY=2/' "M-B1-5:"
mut M-B1-6 $K 's/      cpus: c,/      cpus: undefined,/' "M-B1-6:"
mut M-B1-7 $K 's/if \(quota1 !== undefined \|\| mem1 !== undefined\) \{/if (false) {/' "M-B1-7:"
mut M-B1-8 $K 's/Math\.min\(cg\.cpus, host\.cpuCount\)/host.cpuCount/' "M-B1-8:"
mut M-B1-9 $K 's/Math\.floor\(Math\.max\(0, res\.cpus - RESERVED_CPU\) \/ \(BOT_CPU \* bots\)\)/Math.floor(res.cpus - 1)/' "M-B1-9:"
mut M-B1-10 $K 's/const bots = Math\.max\(1, Math\.floor\(botsPerBattle\)\);/const bots = 8;/' "M-B1-10:"
mut M-B1-11 $K 's/Math\.floor\(res\.memGiB \/ \(BOT_MEM_GIB \* bots \+ ENGINE_MEM_GIB\)\)/Infinity/' "M-B1-11:"
mut M-B1-12 $L 's/\(concurrency \?\? DEFAULT_CONCURRENCY\)/(concurrency ?? 5)/' "M-B1-12:"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "ÁRBOL SUCIO tras los mutantes"; fail=1; }
exit $fail
