#!/usr/bin/env bash
# Mutantes de calibración de los arreglos de flaky web (carreras de render asíncrono).
# Cada mutante reintroduce una carrera y debe morir por UN test concreto y nombrado.
# IMPORTANTE: commitea antes de lanzarlo (el script revierte los ficheros con `git checkout`).
set -u
cd "$(dirname "$0")/.."
T1=apps/web/tests/team-enrollment-entry.test.tsx
T2=apps/web/tests/eq4-teams-select-race.test.tsx
S=apps/web/src/pages/TeamsPage.tsx
E=apps/web/src/pages/TournamentTeamEntry.tsx
RUN() { nice -n 19 node node_modules/vitest/vitest.mjs run --maxWorkers=1 "$T1" "$T2" apps/web/tests/eq4-bots-teams.test.tsx 2>&1; }

if ! git diff --quiet -- "$T1" "$T2" "$S" "$E"; then echo "ABORTA: hay cambios sin commitear"; exit 2; fi
out=$(RUN); rc=$?
echo "BASE rc=$rc"
[ "$rc" -eq 0 ] || { echo "línea base NO verde"; echo "$out" | tail -20; exit 1; }

fail=0
mutant() { # nombre, fichero, test que debe morir, viejo, nuevo
  local name=$1 f=$2 expect=$3 old=$4 new=$5 msg=${6:-}
  python3 - "$f" "$old" "$new" <<'EOF'
import sys
f, old, new = sys.argv[1:4]
s = open(f).read()
assert s.count(old) == 1, f"patrón no único/ausente: {old}"
open(f, "w").write(s.replace(old, new))
EOF
  [ $? -eq 0 ] || { echo "MUTANTE $name: no se pudo aplicar"; fail=1; git checkout -q -- "$f"; return; }
  out=$(RUN); rc=$?
  git checkout -q -- "$f"
  if [ "$rc" -ne 0 ] && echo "$out" | grep -q "FAIL .*$expect" && { [ -z "$msg" ] || echo "$out" | grep -q "$msg"; }; then
    echo "MUTANTE $name: MUERTO por «$expect» (rc=$rc)"
  else
    echo "MUTANTE $name: SUPERVIVIENTE (rc=$rc, esperaba que muriera «$expect»)"; fail=1
  fi
}

# W1 · pickTeam abre la puerta (openGate se conserva) pero no espera a la opción cargada (select antes del fetch).
mutant W1-pickteam-sin-esperar-opcion "$T1" "W287_SUBMIT" \
  '  openGate();
  // Espera a la CONDICIÓN: la opción del equipo ya cargada (no basta con que exista el select).
  await screen.findByRole("option", { name: "Bastión" });' \
  '  openGate();' \
  'not found in options'
# W2 · el efecto de selección inicial vuelve a pisar el clic del usuario.
mutant W2-efecto-pisa-seleccion "$S" "W_EQ4_SELECT_RACE" \
  'setSelectedId((prev) => (prev !== null && mine.some((t) => t.id === prev) ? prev : fallback));' \
  'setSelectedId(fallback);'
# W3 · se quita el filtro isMember de TournamentTeamEntry (la ausencia de «Ajeno» no puede ser vacua).
mutant W3-sin-filtro-ismember "$E" "W287_TEAM_FORM" \
  '(page?.items ?? []).filter((t) => t.isMember)' \
  '(page?.items ?? [])'
# W4 · la rama `named` vuelve a pisar el clic posterior del usuario.
mutant W4-named-pisa-seleccion "$S" "W_EQ4_NAMED_RACE" \
  'if (picks.current === picksAtRender) {' \
  'if (true) {'

git diff --quiet -- "$T1" "$T2" "$S" "$E" || { echo "ÁRBOL SUCIO tras los mutantes"; fail=1; }
[ "$fail" -eq 0 ] && echo "TODOS LOS MUTANTES MUERTOS, árbol limpio" || echo "HAY FALLOS"
exit "$fail"
