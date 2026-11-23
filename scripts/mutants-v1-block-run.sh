#!/usr/bin/env bash
# V1 BLOCK-RUN · mutantes de calibración. Cada uno debe morir por un test nombrado.
# Commitea antes de lanzarlo: restaura con `git checkout`. Uso: bash scripts/mutants-v1-block-run.sh
set -u
cd "$(dirname "$0")/.."
SVC=apps/arena-engine/src/service.ts
COMPOSE=infrastructure/docker-compose.yml
T1=apps/arena-engine/tests/service.test.ts
T2=infrastructure/tests/engine-run-blocked.test.ts
OUT="${TMPDIR:-/tmp}/mut-v1-block-run.out"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "ARBOL SUCIO: commitea antes"; exit 2; fi
run() { nice -n 19 npx vitest run --maxWorkers=1 "$@" >"$OUT" 2>&1; echo $?; }
fail=0
check() { # nombre fichero-test nombre-de-test-esperado
  local rc; rc=$(run "$2")
  if [ "$rc" != 0 ] && grep -q "$3" "$OUT"; then echo "MUERTO  $1 (rc=$rc, por $3)"; else echo "SUPERVIVE $1 (rc=$rc)"; fail=1; fi
  git checkout -q -- "$SVC" "$COMPOSE"
}
base=$(run "$T1" "$T2"); echo "linea base: rc=$base"; [ "$base" = 0 ] || exit 1
# M1: el interruptor se ignora (/run siempre encendido)
sed -i 's/if (cfg.runEnabled !== true) {/if (false) {/' "$SVC"; check M1-interruptor-ignorado "$T1" "V1-RUN-OFF-404"
# M2: el interruptor se comprueba DESPUES de la credencial (el 401 revelaría la ruta)
python3 - <<'P'
p = "apps/arena-engine/src/service.ts"
s = open(p).read()
blk = '''    if (cfg.runEnabled !== true) {
      res.status(404).json({ error: "not_found" });
      return;
    }
'''
assert blk in s
s = s.replace(blk, "", 1)
s = s.replace("    if (!cfg.runner) {", blk + "    if (!cfg.runner) {", 1)
open(p, "w").write(s)
P
check M2-interruptor-tras-credencial "$T1" "V1-RUN-OFF-SIN-REVELAR"
# M3: cualquier valor no vacío enciende
sed -i 's/return v === "1" || v === "true";/return v !== "";/' "$SVC"; check M3-env-laxa "$T1" "V1-RUN-OFF-ENV"
# M4: encendido deja de funcionar (siempre 404)
sed -i 's/if (cfg.runEnabled !== true) {/if (true) {/' "$SVC"; check M4-encendido-roto "$T1" "V1-RUN-ON-COMPORTAMIENTO"
# M5: la API vuelve a montar el secreto
sed -i 's/secrets: \[postgres_password, jwt_secret, replay_ingest_secret,/secrets: [postgres_password, jwt_secret, arena_engine_internal_secret, replay_ingest_secret,/' "$COMPOSE"; check M5-api-con-secreto "$T2" "V1-API-SIN-SECRETO-ENGINE"
# M6: se quita el secreto también de arena-engine
sed -i 's/^    secrets: \[arena_engine_internal_secret\]/    secrets: []/' "$COMPOSE"; check M6-engine-sin-secreto "$T2" "V1-SECRETO-SOLO-ENGINE"
[ -z "$(git status --porcelain --untracked-files=no)" ] && echo "arbol limpio" || { echo "ARBOL SUCIO"; fail=1; }
exit $fail
