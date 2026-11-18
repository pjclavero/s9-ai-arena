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
  NO_COLOR=1 FORCE_COLOR=0 timeout 900 npx vitest run --reporter=verbose "${SUITES[@]}" > "$1" 2>&1
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
"apps/tournament-worker/src/errors.ts|if (!x \|\| typeof x !== \"object\" \|\| depth > MAX_DEPTH \|\| seen.has(x) \|\| ++budget.nodes > MAX_NODES) return false;|return false;|M3 errores de Knex/pool sin clasificar|KnexTimeoutError por nombre"
"apps/tournament-worker/src/worker.ts|else if (classifyDbError(err)) {|else if (false) {|M3b el worker no mapea BD transitoria|SIN pasar por el runner"
"apps/tournament-worker/src/battle-runner.ts|throw toInfrastructureFailure(err, \"engine_start_failure\");|throw err instanceof InfrastructureFailure ? err : new InfrastructureFailure(\"engine_start_failure\", String(err));|M3c el runner envuelve todo como engine_start_failure|vuelve a la cola con backoff"
"apps/tournament-worker/src/queue.ts|parked = classFailures >= policy.maxFailures;|parked = false;|M4 db_unavailable sin tope: reintento infinito|tope PROPIO de db_unavailable"
"apps/tournament-worker/src/errors.ts|battle_timeout: { maxFailures: 2,|battle_timeout: { maxFailures: 3,|M4b battle_timeout reintenta más de UNA vez|el primer timeout se reintenta"
"apps/tournament-worker/src/battle-resources.ts|    if (err.code === \"engine_start_failure\") return \"ENGINE_ERROR\";|    if (/timeout global/.test(String(err.message))) return \"TIMEOUT\"; if (err.code === \"engine_start_failure\") return \"ENGINE_ERROR\";|M5 classifyEnd decide otra vez por el texto del mensaje|aunque el mensaje diga"
"apps/tournament-worker/src/battle-resources.ts|    if (err.code === \"battle_timeout\") return \"TIMEOUT\";|    /* sin rama por codigo */|M6 classifyEnd sin rama por código battle_timeout (R9)|rama por código"
"apps/tournament-worker/src/errors.ts|if (pointsAtDb(e, endpoint)) return true;|return true;|M7 todo código de red se atribuye a la BD|docker-proxy ECONNREFUSED"
"apps/tournament-worker/src/errors.ts|if (typeof e.stack === \"string\" && DB_LIBRARY_STACK.test(e.stack)) return true;|/* sin pila */|M7b sin evidencia por pila de pg/knex|ECONNRESET sin dirección pero con pila de pg"
"apps/tournament-worker/src/errors.ts|if (ep.port === undefined \|\| port !== ep.port) return false;|if (false) return false;|M7c el puerto no se compara|el MISMO error real hacia OTRO puerto"
"apps/tournament-worker/src/queue.ts|const classFailures = (counts[code] ?? 0) + 1;|const classFailures = job.attempts;|M8 el contador es el total de intentos, no por clase|sigue dando UN reintento"
"apps/tournament-worker/src/errors.ts|maxFailures: 8,|maxFailures: 3,|M9 ventana de db_unavailable de ~30 s|tolerancia total de 5 a 10 minutos"
"apps/tournament-worker/src/errors.ts|  \"53300\", // too_many_connections: el servidor está saturado, se libera solo|  /* sin 53300 */|M10 sin 53300|53300 too_many_connections"
"apps/tournament-worker/src/errors.ts|const QUERY_TIMEOUT_SQLSTATE = \"57014\";|const QUERY_TIMEOUT_SQLSTATE = \"57015\";|M10b sin 57014|57014 REAL (statement_timeout)"
"packages/game-rules/battle-timing.ts|const derivado = Math.ceil(theoreticalBattleMs(ticks, tickIntervalMs) * f) + graceMs;|const derivado = Math.min(Math.ceil(theoreticalBattleMs(ticks, tickIntervalMs) * f) + graceMs, MAX_CONTAINER_BATTLE_TIMEOUT_MS);|M11 recorte del guard silencioso|avisa por consola"
"apps/tournament-worker/src/errors.ts| \|\| depth > MAX_DEPTH||M12 sin tope de profundidad en cause|cíclica o muy profunda"
"apps/tournament-worker/src/errors.ts|if (Array.isArray(e.errors)) for (const sub of e.errors) if (visit(sub, depth + 1)) return true;|/* no recorre AggregateError */|M13 no recorrer AggregateError.errors[] (P1-1)|localhost\` dual-stack"
"apps/tournament-worker/src/errors.ts|  return isIP(address) !== 0;|  return false;|M14 no aceptar el PUERTO con DSN por nombre (address = IP resuelta) (P1-1)|DSN por NOMBRE → IP"
"apps/tournament-worker/src/errors.ts|  if (isIP(host) !== 0) return false;|  /* sin comprobar IP literal */|M15 con DSN por IP literal se acepta cualquier IP (P1-1)|DSN por IP literal"
"apps/tournament-worker/src/errors.ts|  \"ENOTFOUND\",|  /* sin ENOTFOUND */|M16 sin ENOTFOUND|ENOTFOUND real"
"apps/tournament-worker/src/errors.ts|if (typeof e.message === \"string\" && KNEX_SQL_PREFIXED_NET_ERROR.test(e.message)) return true;|/* sin SQL antepuesto */|M17 el read ECONNRESET de knex no se reconoce|vía knex"
"apps/tournament-worker/src/errors.ts|PG_CONNECT_TIMEOUT_MESSAGE.test(e.message) &&|false &&|M18 pg timeout expired no se reconoce|pg \`timeout expired\`"
"apps/tournament-worker/src/errors.ts|  \"53300\", // too_many_connections: el servidor está saturado, se libera solo|  \"53300\", \"57014\",|M19 57014 vuelve a ser db_unavailable (P2-8)|57014 REAL (statement_timeout)"
"apps/tournament-worker/src/errors.ts|db_query_timeout: { maxFailures: 2,|db_query_timeout: { maxFailures: 8,|M20 db_query_timeout sin tope corto (P2-8)|db_query_timeout (57014): tope CORTO"
"apps/tournament-worker/src/worker.ts|classifyDbError(err) as \"db_unavailable\" \| \"db_query_timeout\",|\"db_unavailable\",|M21 el worker etiqueta todo como db_unavailable (P2-8)|SIN pasar por el runner también va por db_query_timeout"
"apps/tournament-worker/src/errors.ts| \|\| ++budget.nodes > MAX_NODES||M22 sin tope de nodos visitados|AggregateError enorme"
"apps/tournament-worker/src/errors.ts|  \"EHOSTUNREACH\",|  /* sin EHOSTUNREACH */|M23 sin EHOSTUNREACH (P2-12)|P2-12 · EHOSTUNREACH hacia el puerto de la BD"
"apps/tournament-worker/src/errors.ts|  \"ENETUNREACH\",|  /* sin ENETUNREACH */|M24 sin ENETUNREACH (P2-12)|P2-12 · ENETUNREACH hacia el puerto de la BD"
"apps/tournament-worker/src/errors.ts|  \"ECONNABORTED\",|  /* sin ECONNABORTED */|M25 sin ECONNABORTED (P2-12)|P2-12 · ECONNABORTED hacia el puerto de la BD"
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
  if grep -E "(FAIL|×)" "$SAL/m.txt" | grep -qF "$expect"; then
    echo "MUERE     · $nombre · por «$expect»"
  else
    echo "MUERE POR OTRO MOTIVO · $nombre · se esperaba «$expect»"; grep -E "(FAIL|×)" "$SAL/m.txt" | head -5
    fallos=$((fallos+1))
  fi
done

if limpio; then echo "ARBOL LIMPIO tras los mutantes"; else echo "AVISO: árbol contaminado"; git status --porcelain; fallos=$((fallos+1)); fi
echo "mutantes=${#MUTANTES[@]} fallos=$fallos"
[ "$fallos" = "0" ]
