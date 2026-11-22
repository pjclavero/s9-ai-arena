#!/usr/bin/env bash
# D-OP-32 · mutantes del presupuesto de recursos y de las pruebas de liberación.
# Cada mutante debe morir por un test NOMBRADO (RB-n, RR-n, SR-n). Requisitos: árbol
# LIMPIO y commiteado (el harness hace `git checkout` de cada fichero mutado) y
# node_modules instalado. Una sola ejecución pesada a la vez: si lo lanza el laboratorio,
# con `nice -n 19 ionice -c3 flock -o <cerrojo>` y el guardián de producción en OK.
#
# Uso:  bash scripts/mutants-resource-budget.sh            (todos)
#       ONLY=MB-3 bash scripts/mutants-resource-budget.sh  (uno)
# Variables: PRODGUARD=<script> espera a PRODGUARD_OK antes de CADA ejecución;
#            SKIP_BASE=1 omite la línea base (si ya se comprobó en la misma sesión).
set -u
cd "$(dirname "$0")/.." || exit 2
export NO_COLOR=1 FORCE_COLOR=0
INFRA=infrastructure/tests/resource-budget.test.ts
WORKER=apps/tournament-worker/src/mf-battle-teardown.test.ts
STREAM=apps/streamer/src/xvfb-on-demand.test.ts
# Sólo los tests de este carril (describe «D-OP-32»): el resto de mf-battle-teardown depende del reloj bajo carga.
RUN=(npx vitest run --maxWorkers=1 --reporter=verbose -t "D-OP-32")
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "árbol sucio: commitea antes de lanzar los mutantes"; exit 2; }
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT
wait_guard() { # espera a que el guardián de producción dé OK (si se indicó)
  [ -n "${PRODGUARD:-}" ] || return 0
  until bash "$PRODGUARD" | grep -q PRODGUARD_OK; do sleep 20; done
}
if [ -z "${SKIP_BASE:-}" ]; then
  wait_guard
  "${RUN[@]}" "$INFRA" "$WORKER" "$STREAM" >"$LOG" 2>&1 || { echo "BASE ROJA"; tail -40 "$LOG"; exit 3; }
  echo "BASE verde: $(grep -E '^ +Tests ' "$LOG")"
fi

fail=0
mut() { # id fichero-a-mutar sed-expr fichero-de-test test-asesino
  local id=$1 f=$2 expr=$3 tf=$4 killer=$5
  if [ -n "${ONLY:-}" ] && [ "$ONLY" != "$id" ]; then return; fi
  sed -i -E "$expr" "$f"
  if git diff --quiet -- "$f"; then echo "$id: el sed no cambió nada"; fail=1; return; fi
  local out rc
  wait_guard
  out=$(nice -n 19 "${RUN[@]}" "$tf" 2>&1)
  rc=$?
  git checkout -q -- "$f"
  if echo "$out" | grep -q "Transform failed"; then
    echo "$id: INVÁLIDO (el mutante no compila)"
    fail=1
  elif [ $rc -ne 0 ] && echo "$out" | grep -E '^\s*(×|✗|FAIL)' | grep -qF "$killer"; then
    echo "$id: MUERTO por «$killer»"
  else
    echo "$id: SUPERVIVIENTE o muerto por otro test (rc=$rc, esperado «$killer»)"
    fail=1
  fi
}

C=infrastructure/docker-compose.yml
B=infrastructure/resource-budget.yaml
CA=apps/tournament-worker/src/container-agents.ts
BR=apps/tournament-worker/src/battle-resources.ts
SV=apps/streamer/src/supervisor.ts
CR=apps/bot-manager/src/container-runner.ts

# --- presupuesto vs compose (RB)
mut MB-1 $C '/^  gateway:/,/^  web:/ s/limits: \{ cpus: "0.50", memory: 128M \}/limits: {}/' $INFRA "RB-1:"
mut MB-2 $C 's/memory: 1536M, pids: 512/memory: 4G, pids: 512/' $INFRA "RB-2:"
mut MB-3 $CR 's/memoryBytes: 256 \* 1024 \* 1024,/memoryBytes: 512 * 1024 * 1024,/' $INFRA "RB-3:"
mut MB-4 $B 's/while_streaming: \{ 1v1: 2, 2v2: 1, 3v3: 1, 4v4: 1 \}/while_streaming: { 1v1: 2, 2v2: 1, 3v3: 1, 4v4: 2 }/' $INFRA "RB-7:"
mut MB-5 $B 's/^  ram_mib: 1024$/  ram_mib: 3072/' $INFRA "RB-7:"
mut MB-6 $B '/^  streamer:/,/^  # ---/ s/ram_expected_mib: 820/ram_expected_mib: 4000/' $INFRA "RB-5:"
mut MB-7 $B 's/max_ram_ratio: 1.35/max_ram_ratio: 1.0/' $INFRA "RB-10:"
mut MB-8 $B '/^  postgres:/,/^  backup:/ s/running: true/running: false/' $INFRA "RB-4:"
mut MB-9 $INFRA 's/ram \+= Math.max\(0, n - 1\) \* b.battle.worker_extra_ram_mib \+ bots \* b.bot.mem_mib;/ram += 0;/' $INFRA "RB-11:"

# --- liberación 4v4 en el worker (RR)
mut MW-1 $CA '/if \(guard\) clearTimeout\(guard\);/,/^      \}$/ s/await res\.cleanupBattleResources\(battleId, "FAILED", \{ scope: SCOPE \}\);/void 0;/' $WORKER "RR-1:"
mut MW-2 $CA 's/release: \(\) => Promise\.resolve\(host\.close\(\)\),/release: () => Promise.resolve(),/' $WORKER "RR-1:"
mut MW-3 $CA 's/limits: opts\.limits \?\? DEFAULT_LIMITS,/limits: opts.limits ?? { ...DEFAULT_LIMITS, memoryBytes: 512 * 1024 * 1024 },/' $WORKER "RR-1:"
mut MW-4 $CA 's/^(      const wire = vehicles\.map)/      (await import("node:fs")).writeFileSync((await import("node:os")).tmpdir() + "\/leak-" + battleId, "x");\n\1/' $WORKER "RR-1:"
mut MW-5 $BR 's/await withinDeadline\(h\.stop\(\{ timeoutSeconds: 0 \}\), killDeadline, "stop\(KILL\)"\);/void 0;/' $WORKER "RR-4:"

# --- streamer (SR)
mut MS-1 $SV 's/^    this\.terminate\(this\.chromium, "chromium"\);$/    void 0;/' $STREAM "SR-1:"
mut MS-2 $SV '/^    this\.stopProcesses\(\);$/{N;/generation\+\+/s/^    this\.stopProcesses\(\);\n//}' $STREAM "SR-1:"
mut MS-3 $SV '/this\.state_ = "retrying";/{n;s/this\.stopProcesses\(\);/void 0;/}' $STREAM "SR-3:"
mut MS-4 $SV '/^  stop\(\): void \{/,/^  \}/ s/^    this\.opts\.display\?\.release\(\);$/    void 0;/' $STREAM "SR-2:"

[ $fail -eq 0 ] && echo "TODOS LOS MUTANTES MUERTOS" || echo "HAY MUTANTES VIVOS O INVÁLIDOS"
git status --porcelain
exit $fail
