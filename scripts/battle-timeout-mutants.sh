#!/bin/bash
# Release 0.5.0 · PR A · mutantes de timeouts y clasificación de errores de batalla.
#
# Cada mutante estropea el CÓDIGO DE PRODUCCIÓN y exige que muera por un test
# CONCRETO y NOMBRADO (columna EXPECT: fragmento del nombre del test que debe salir
# en FAIL). Un mutante que muere por otro motivo (p. ej. un error de compilación) o
# que sobrevive cuenta como fallo del arnés.
#
# Reglas:
#   · CONTROL POSITIVO: sin mutar, las 3 suites tienen que salir en verde (rc=0).
#   · Se COMMITEA antes de lanzar: el restaurado es `git checkout -- <fichero>`.
#   · El árbol se comprueba limpio ANTES y DESPUÉS (git status --porcelain).
#   · Ancla perdida = fallo (el mutante habría que actualizarlo), nunca «supervivencia».
#
# Uso (en VM111, con node en el PATH):  bash scripts/battle-timeout-mutants.sh
set -u
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ" || exit 2

SUITES=(
  apps/tournament-worker/src/battle-timeout-classification.test.ts
  apps/tournament-worker/src/battle-retry-classification.test.ts
  apps/tournament-worker/src/mf-battle-teardown.test.ts
)
SAL=$(mktemp -d)

limpio() { [ -z "$(git status --porcelain --untracked-files=no)" ]; }
correr() { # $1 = fichero de salida ; rc EXPLÍCITO
  timeout 900 npx vitest run "${SUITES[@]}" > "$1" 2>&1
  return $?
}

if ! limpio; then echo "ABORTA: el árbol no está limpio (commitea antes de lanzar los mutantes)"; exit 2; fi

correr "$SAL/base.txt"; rc=$?
echo "BASE rc=$rc · $(grep -E '^ +Tests +' "$SAL/base.txt" | head -1 | sed 's/^ *//')"
if [ "$rc" != "0" ]; then echo "BASE ROJA: el control positivo falla"; tail -30 "$SAL/base.txt"; exit 1; fi

# FICHERO | ANCLA | REEMPLAZO | NOMBRE | EXPECT (fragmento del test que debe morir)
MUTANTES=(
"packages/game-rules/battle-timing.ts|Math.ceil(theoreticalBattleMs(ticks, tickIntervalMs) * f) + graceMs|theoreticalBattleMs(ticks, tickIntervalMs) + graceMs|M1 margen fijo (sin factor proporcional)|cabe con holgura"
"apps/tournament-worker/src/container-agents.ts|opts.guardFactor ?? BATTLE_GUARD_FACTOR|1|M1b el guard del worker ignora el factor|el factor del guard se APLICA"
"apps/tournament-worker/src/container-agents.ts|return tick > 0|return false|M2 timeout clasificado como engine_start_failure|battle_timeout y nada queda"
"apps/tournament-worker/src/errors.ts|if (!err \|\| typeof err !== \"object\" \|\| depth > 2) return false;|return false;|M3 errores de Knex/pool sin clasificar|KnexTimeoutError por nombre"
"apps/tournament-worker/src/worker.ts|else if (isTransientDbError(err)) {|else if (false) {|M3b el worker no mapea BD transitoria|SIN pasar por el runner"
"apps/tournament-worker/src/battle-runner.ts|throw toInfrastructureFailure(err, \"engine_start_failure\");|throw err instanceof InfrastructureFailure ? err : new InfrastructureFailure(\"engine_start_failure\", String(err));|M3c el runner envuelve todo como engine_start_failure|vuelve a la cola con backoff"
"apps/tournament-worker/src/queue.ts|const parked = job.attempts >= maxAttempts;|const parked = false;|M4 reintento infinito|NO se reintenta sin fin"
"apps/tournament-worker/src/queue.ts|Math.min(job.max_attempts, policy.maxAttempts ?? job.max_attempts)|job.max_attempts|M4b battle_timeout reintenta max_attempts veces|UN solo reintento"
)

fallos=0
for m in "${MUTANTES[@]}"; do
  IFS='|' read -r f ancla nuevo nombre expect <<< "$(echo "$m" | sed 's/\\|/\x01/g')"
  # `\|` escapado dentro del ancla/reemplazo se restaura aquí
  ancla=${ancla//$'\x01'/|}; nuevo=${nuevo//$'\x01'/|}; nombre=${nombre//$'\x01'/|}
  if ! F="$f" A="$ancla" N="$nuevo" python3 - <<'PY'
import os,sys
f,a,n=os.environ["F"],os.environ["A"],os.environ["N"]
s=open(f).read()
if s.count(a)!=1: sys.exit(2)
open(f,"w").write(s.replace(a,n))
PY
  then echo "ANCLA PERDIDA · $nombre"; fallos=$((fallos+1)); git checkout -- "$f"; continue; fi
  correr "$SAL/m.txt"; rc=$?
  git checkout -- "$f"
  if [ "$rc" = "0" ]; then echo "SOBREVIVE · $nombre"; fallos=$((fallos+1)); continue; fi
  if grep -E "^ *(FAIL|×)" "$SAL/m.txt" | grep -qF "$expect"; then
    echo "MUERE     · $nombre · por «$expect»"
  else
    echo "MUERE POR OTRO MOTIVO · $nombre · se esperaba «$expect»"; grep -E "^ *(FAIL|×)" "$SAL/m.txt" | head -5
    fallos=$((fallos+1))
  fi
done

if limpio; then echo "ARBOL LIMPIO tras los mutantes"; else echo "AVISO: árbol contaminado"; git status --porcelain; fallos=$((fallos+1)); fi
echo "mutantes=${#MUTANTES[@]} fallos=$fallos"
[ "$fallos" = "0" ]
