#!/bin/bash
# V1-A · #306 · mutantes de calibración de apps/api/src/v1-organizer-scope.test.ts.
#
# Cada mutante estropea el CÓDIGO DE PRODUCCIÓN de la política de acceso y exige que
# muera por un test CONCRETO y NOMBRADO (EXPECT: fragmento del nombre del test que debe
# aparecer en una línea de FALLO). Muere por otro motivo o sobrevive ⇒ fallo del arnés.
#
# Reglas: control positivo en verde (rc=0) antes de mutar; se COMMITEA antes de lanzar
# (el restaurado es `git checkout -- <fichero>`); árbol limpio antes y después; ancla
# perdida = fallo, nunca «supervivencia».
#
# Uso (en VM111, con node en el PATH):  bash scripts/v1-organizer-scope-mutants.sh
set -u
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ" || exit 2
SUITE=apps/api/src/v1-organizer-scope.test.ts
SAL=$(mktemp -d)

limpio() { [ -z "$(git status --porcelain --untracked-files=no)" ]; }
correr() { NO_COLOR=1 FORCE_COLOR=0 timeout 900 npx vitest run --maxWorkers=1 --reporter=verbose "$SUITE" > "$1" 2>&1; return $?; }

limpio || { echo "ABORTA: el árbol no está limpio (commitea antes de lanzar los mutantes)"; exit 2; }
correr "$SAL/base.txt"; rc=$?
echo "BASE rc=$rc · $(grep -E '^ +Tests +' "$SAL/base.txt" | head -1 | sed 's/^ *//')"
[ "$rc" = "0" ] || { echo "BASE ROJA"; tail -30 "$SAL/base.txt"; exit 1; }

# FICHERO ~ ANCLA ~ REEMPLAZO ~ NOMBRE ~ EXPECT  (separador «~»; «\n» = salto de línea)
MUTANTES=(
"apps/api/src/replay-access.ts~return (auth?.rank ?? 0) >= ROLE_RANK.moderator;\n}\n\n/** Rol organizer~return (auth?.rank ?? 0) >= ROLE_RANK.organizer;\n}\n\n/** Rol organizer~M1 el organizer vuelve a ser staff global (el defecto #306)~practice · orgA ⇒ 404"
"apps/api/src/replay-access.ts~return (auth?.rank ?? 0) >= ROLE_RANK.moderator;\n}\n\n/** Rol organizer~return (auth?.rank ?? 0) >= ROLE_RANK.admin;\n}\n\n/** Rol organizer~M2 moderator deja de ser staff (no se cambia lo de moderator)~practice · moderator ⇒ 200"
"apps/api/src/replay-access.ts~    if (orgId) {~    if (false as boolean) {~M3 el organizer pierde la lectura de SU torneo~ta · orgA ⇒ 200"
"apps/api/src/replay-access.ts~.where(\"tournaments.created_by\", orgId)~.whereNotNull(\"tournaments.created_by\")~M4 la lectura del organizer no se acota a lo que él creó~tb · orgA ⇒ 404"
"apps/api/src/replay-access.ts~    .where({ id: tournamentId, created_by: uid })~    .where({ id: tournamentId })~M5 el cuadro identifica a los inscritos de torneos ajenos~T.B}/matches · orgA"
"apps/api/src/battle-access.ts~await organizerCreatedTournament(db, auth, ctx.tournamentId)~(await organizerCreatedTournament(db, auth, ctx.tournamentId)) && false~M6 el organizer no ve el nombre en el cuadro de SU torneo~T.A}/matches · orgA"
"apps/api/src/battle-access.ts~  if (isReplayStaff(auth)) return true;\n  return Boolean(auth?.userId)~  if (isReplayStaff(auth) || (auth?.rank ?? 0) >= ROLE_RANK.organizer) return true;\n  return Boolean(auth?.userId)~M7 el organizer ve diagnóstico y CPU ajenos~orgA: diagnosticsVisible/cpuMs"
"apps/api/src/battle-access.ts~          .where(\"tournaments.created_by\", userId),~          .whereNotNull(\"tournaments.created_by\"),~M8 whereBotIdentifiable sin acotar al creador~whereBotIdentifiable: el organizer identifica"
"apps/api/src/battle-access.ts~    if (userId && (auth?.rank ?? 0) >= ROLE_RANK.organizer) {~    if (false as boolean) {~M9 el organizer no identifica los bots de su torneo en los filtros~whereBotIdentifiable: el organizer identifica"
)

fallos=0
for m in "${MUTANTES[@]}"; do
  IFS='~' read -r F ANCLA REEMP NOMBRE EXPECT <<< "$m"
  if ! python3 - "$F" "$ANCLA" "$REEMP" <<'PY'
import sys
f, a, r = sys.argv[1], sys.argv[2].replace("\\n", "\n"), sys.argv[3].replace("\\n", "\n")
s = open(f).read()
if s.count(a) != 1:
    sys.exit(3)
open(f, "w").write(s.replace(a, r))
PY
  then echo "ANCLA PERDIDA: $NOMBRE"; fallos=$((fallos+1)); git checkout -- "$F"; continue; fi
  correr "$SAL/m.txt"; rc=$?
  git checkout -- "$F"
  if [ "$rc" = "0" ]; then echo "SOBREVIVE (rc=0): $NOMBRE"; fallos=$((fallos+1)); continue; fi
  if grep -E '(×|✗|FAIL)' "$SAL/m.txt" | grep -qF "$EXPECT"; then
    echo "MUERE (rc=$rc) por «$EXPECT»: $NOMBRE"
  else
    echo "MUERE POR OTRO MOTIVO (rc=$rc), esperado «$EXPECT»: $NOMBRE"; grep -E '(×|✗)' "$SAL/m.txt" | head -5; fallos=$((fallos+1))
  fi
done

limpio || { echo "ÁRBOL SUCIO tras los mutantes"; fallos=$((fallos+1)); }
echo "RESULTADO: fallos=$fallos de ${#MUTANTES[@]} mutantes"
[ "$fallos" = "0" ]
