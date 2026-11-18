#!/bin/bash
# Mutantes del REVISOR (PR A #298, R1-R14) adaptados a la ronda 2 (anclas renombradas por el
# refactor: R5 y R6). R7 es EQUIVALENTE y está documentado (KnexTimeoutError también lo cubre el
# regex del mensaje «Timeout acquiring a connection»): se espera que SOBREVIVA. La profundidad de
# `cause` (antes R12, con un ancla que contenía `|`) pasa a M12 de battle-timeout-mutants.sh.
# El mutante de salto del `else if` del worker no se usa (lo cubre M3b).
# Uso: bash scripts/battle-timeout-reviewer-mutants.sh   (en VM111, árbol limpio y commiteado)
set -u
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 2
SUITES=(apps/tournament-worker/src/battle-timeout-classification.test.ts apps/tournament-worker/src/battle-retry-classification.test.ts apps/tournament-worker/src/mf-battle-teardown.test.ts)
SAL=$(mktemp -d)
correr(){ NO_COLOR=1 FORCE_COLOR=0 timeout 900 npx vitest run --reporter=verbose "${SUITES[@]}" > "$1" 2>&1; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "ARBOL SUCIO"; exit 2; }
correr $SAL/b.txt; rc=$?; echo "BASE rc=$rc"; [ $rc = 0 ] || exit 1
# FICHERO|ANCLA|NUEVO|NOMBRE
M=(
"apps/tournament-worker/src/errors.ts|  \"08006\", // connection_failure|  \"08006\", \"23505\",|R1 23505 transitorio"
"packages/game-rules/battle-timing.ts|export const BATTLE_GUARD_FACTOR = 1.25;|export const BATTLE_GUARD_FACTOR = 1.0;|R2 factor 1.0"
"apps/tournament-worker/src/container-agents.ts|return tick > 0|return tick >= 0|R3 tick=0 tratado como timeout"
"apps/tournament-worker/src/errors.ts|Math.min(120_000, 5000 * 2 ** n)|5000 * 2 ** n|R4 backoff db sin tope"
"apps/tournament-worker/src/errors.ts|return transientDb(e.cause, depth + 1, endpoint);|return false;|R5 cause no inspeccionado"
"apps/tournament-worker/src/errors.ts|battle_timeout: { maxFailures: 2, backoffMs: (n) => 60_000 * Math.max(1, n) }|battle_timeout: { maxFailures: 2, backoffMs: (n) => 1000 }|R6 battle_timeout sin pausa de 60 s"
"apps/tournament-worker/src/errors.ts|if (e.name === \"KnexTimeoutError\") return true;|if (false) return true;|R7 EQUIV KnexTimeoutError por nombre"
"apps/tournament-worker/src/errors.ts|\"57P03\", // cannot_connect_now|\"57P03\", \"42601\",|R8 42601 sintaxis transitorio"
"apps/tournament-worker/src/battle-resources.ts|if (err.code === \"battle_timeout\") return \"TIMEOUT\";|/* sin linea */|R9 classifyEnd sin rama por codigo battle_timeout"
"packages/game-rules/battle-timing.ts|return Math.min(derivado, MAX_CONTAINER_BATTLE_TIMEOUT_MS);|return derivado;|R10 guard sin techo setTimeout"
"packages/game-rules/battle-timing.ts|const f = Number.isFinite(factor) && factor >= 1 ? factor : 1;|const f = factor;|R11 factor sin validar"
"apps/tournament-worker/src/errors.ts|const DEFAULT_RETRY_POLICY: RetryPolicy = { backoffMs: (n) => Math.min(60_000, 1000 * 2 ** n) };|const DEFAULT_RETRY_POLICY: RetryPolicy = { backoffMs: (n) => 1000 * 2 ** n };|R13 backoff por defecto sin tope"
)
f=0
for m in "${M[@]}"; do
  IFS='|' read -r fi an nu nm <<< "$m"
  if ! F="$fi" A="$an" N="$nu" python3 - <<'PY'
import os,sys
f,a,n=os.environ["F"],os.environ["A"],os.environ["N"]
s=open(f).read()
if s.count(a)!=1: sys.exit(2)
open(f,"w").write(s.replace(a,n))
PY
  then echo "ANCLA PERDIDA · $nm"; f=$((f+1)); git checkout -- "$fi"; continue; fi
  correr $SAL/m.txt; rc=$?; git checkout -- "$fi"
  if [ $rc = 0 ]; then case "$nm" in *EQUIV*) echo "SOBREVIVE (equivalente documentado) · $nm";; *) echo "SOBREVIVE · $nm"; f=$((f+1));; esac; else echo "MUERE · $nm · por: $(grep -E '(FAIL|×)' $SAL/m.txt | sed 's/^ *//' | head -3 | tr '\n' ';')"; fi
done
[ -z "$(git status --porcelain --untracked-files=no)" ] && echo ARBOL_LIMPIO || echo ARBOL_SUCIO
echo "propios=${#M[@]} sobreviven_o_fallos=$f"
