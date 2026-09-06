#!/bin/bash
# DEGRADACIÓN DEL WORKER · diferencial de CALIBRACIÓN (ejecutor).
#
# La lista de mutaciones y el saber aplicarlas viven en
# scripts/worker-degradation-mutants.mjs; AQUÍ se ejecuta la suite. La división
# no es estética: en este entorno un `npx vitest` lanzado desde un proceso Node
# padre se queda colgado sin ejecutar un test (90 s de reloj, cero salida),
# mientras el mismo comando desde el shell termina en 10 s. Un arnés que se
# cuelga no mide nada.
#
# Reglas del diferencial:
#   · CONTROL POSITIVO primero: sin mutar, la suite ENTERA tiene que salir
#     verde. Si no, el rojo de las mutaciones no probaría nada.
#   · Verde exige rc=0 EXPLÍCITO. Un vencimiento cuenta como ROJA (una mutación
#     que cuelga la suite tampoco es una mutación que sobreviva), pero se marca
#     como tal para que nadie confunda «murió» con «no terminó».
#   · El árbol se comprueba limpio ANTES y DESPUÉS: dos arneses a la vez dejaron
#     mutantes puestos en el árbol y todo lo medido después fue basura.
#   · Se restaura siempre, también si interrumpen el guion.
set -u

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ" || exit 2
MODULO=scripts/worker-degradation-mutants.mjs
SUITE=apps/tournament-worker/src/worker-degradation.test.ts
SALIDA=$(mktemp -d)/vitest.txt
TOPE_MUTANTE=${TOPE_MUTANTE:-180}

limpieza() { node "$MODULO" --restaurar >/dev/null 2>&1; }
trap 'limpieza; exit 130' INT TERM

# rc EXPLÍCITO: en una tubería, $? es del último comando.
correr() {
  local extra=("$@")
  timeout "${TOPE:-600}" npx vitest run "$SUITE" "${extra[@]}" > "$SALIDA" 2>&1
  local rc=$?
  RESUMEN=$(grep -E "^ +Tests +" "$SALIDA" | head -1 | sed 's/^ *//')
  [ -z "$RESUMEN" ] && RESUMEN="(sin resumen)"
  [ "$rc" = "124" ] && RESUMEN="$RESUMEN · VENCIDA (la suite se colgó)"
  return $rc
}

if ! node "$MODULO" --verificar >/dev/null; then
  echo "ABORTA: el árbol ya viene con mutantes puestos"
  exit 2
fi

TOPE=600 correr
if [ $? -ne 0 ]; then
  echo "BASE ROJA (¡el control positivo falla!) · $RESUMEN"
  exit 1
fi
echo "BASE VERDE · $RESUMEN"

supervivientes=0
total=0
while IFS=$'\t' read -r i nombre; do
  total=$((total + 1))
  if ! node "$MODULO" --aplicar "$i" >/dev/null; then
    echo "ANCLA PERDIDA · $nombre (actualiza el mutante)"
    supervivientes=$((supervivientes + 1))
    continue
  fi
  TOPE=$TOPE_MUTANTE correr --bail=1
  rc=$?
  limpieza
  if [ "$rc" = "0" ]; then
    echo "SOBREVIVE · $nombre · $RESUMEN"
    supervivientes=$((supervivientes + 1))
  else
    echo "ROJA      · $nombre · $RESUMEN"
  fi
done < <(node "$MODULO" --listar)

limpieza
if ! node "$MODULO" --verificar; then
  echo "AVISO: el árbol quedó contaminado"
  exit 2
fi

if [ "$supervivientes" = "0" ]; then
  echo "Todas las mutaciones se detectaron ($total/$total en ROJO)."
  exit 0
fi
echo "$supervivientes de $total sin detectar."
exit 1
