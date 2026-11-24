#!/usr/bin/env bash
# Mutantes de calibración del arreglo de flaky ADM-1 (borrador de SettingRow pisado por un efecto).
# Cada mutante reintroduce la carrera y debe morir por UN test concreto y nombrado.
# IMPORTANTE: commitea antes de lanzarlo (el script revierte los ficheros con `git checkout`).
set -u
cd "$(dirname "$0")/.."
T1=apps/web/tests/adm1-settings-race.test.tsx
T2=apps/web/tests/adm1-settings-page.test.tsx
S=apps/web/src/pages/admin/SettingsPage.tsx
RUN() { nice -n 19 node node_modules/vitest/vitest.mjs run --maxWorkers=1 "$T1" "$T2" 2>&1; }

if ! git diff --quiet -- "$T1" "$T2" "$S"; then echo "ABORTA: hay cambios sin commitear"; exit 2; fi
out=$(RUN); rc=$?
echo "BASE rc=$rc"
[ "$rc" -eq 0 ] || { echo "línea base NO verde"; echo "$out" | tail -20; exit 1; }

fail=0
mutant() { # nombre, fichero, test que debe morir, viejo, nuevo
  local name=$1 f=$2 expect=$3 old=$4 new=$5
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
  if [ "$rc" -ne 0 ] && echo "$out" | grep -q "FAIL .*$expect"; then
    echo "MUTANTE $name: MUERTO por «$expect» (rc=$rc)"
  else
    echo "MUTANTE $name: SUPERVIVIENTE (rc=$rc, esperaba que muriera «$expect»)"; fail=1
  fi
}

# A1 · el borrador vuelve a resincronizarse con un efecto pasivo que corre también al montar.
mutant A1-borrador-con-efecto-de-montaje "$S" "W_ADM1_DRAFT_RACE" \
  '  if (seenKey !== serverKey) {
    setSeenKey(serverKey);
    setDraft(typeof s.value === "boolean" ? s.value : String(s.value));
  }' \
  '  void seenKey;
  void setSeenKey;
  useEffect(() => setDraft(typeof s.value === "boolean" ? s.value : String(s.value)), [s.value, s.version]);'
# A2 · se elimina la resincronización del borrador cuando el servidor cambia valor/versión.
mutant A2-sin-resincronizar-con-el-servidor "$S" "RESINCRONIZA_VIGENTE" \
  '    setSeenKey(serverKey);
    setDraft(typeof s.value === "boolean" ? s.value : String(s.value));' \
  '    setSeenKey(serverKey);'

git diff --quiet -- "$T1" "$T2" "$S" || { echo "ÁRBOL SUCIO tras los mutantes"; fail=1; }
[ "$fail" -eq 0 ] && echo "TODOS LOS MUTANTES MUERTOS, árbol limpio" || echo "HAY FALLOS"
exit "$fail"
