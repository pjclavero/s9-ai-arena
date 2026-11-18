#!/usr/bin/env bash
# Ensayo E2E del export/import portable con PROCESOS REALES: dos PostgreSQL en contenedores Docker
# (origen y destino NUEVO y vacío), dos APIs reales (apps/api/src/server.ts), y el CLI como procesos
# aparte con credenciales de fichero 0600. SÓLO en el laboratorio (VM de pruebas), nunca en el host de
# orquestación ni en producción. Requiere: docker, Node (tsx en node_modules), imagen postgres:16-alpine.
#
# Uso: flock -o /srv/s9-test/heavy.lock bash scripts/portable/e2e/run.sh
set -euo pipefail
case "$(hostname)" in ia-server) echo STOP; exit 1 ;; esac

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"
W=$(mktemp -d)
PIDS=()
SRC=s9portable-src
DST=s9portable-dst
PW=pg-efimera-e2e
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  docker rm -f "$SRC" "$DST" >/dev/null 2>&1 || true
  rm -rf "$W"
}
trap cleanup EXIT
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; exit 1; }

DEVPW='dev-password-s9-arena!'
NEWMAIL='operador.nuevo@example.test'
NEWPW='contrasena-nueva-del-operador!'
P_SRC=55441; P_DST=55442; A_SRC=18081; A_DST=18082
export ARENA_DEV_INSECURE_SECRETS=1

start_db() { # nombre puerto
  docker rm -f "$1" >/dev/null 2>&1 || true
  docker run -d --name "$1" -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=arena -p "127.0.0.1:$2:5432" postgres:16-alpine >/dev/null
  for _ in $(seq 1 60); do
    docker exec "$1" pg_isready -U postgres -d arena >/dev/null 2>&1 && return 0
    sleep 1
  done
  fail "postgres $1 no arrancó"
}
sql() { docker exec "$1" psql -U postgres -d arena -tA -c "$2"; }
db_url() { echo "postgres://postgres:$PW@127.0.0.1:$1/arena"; }
start_api() { # puerto-bd puerto-api log
  DATABASE_URL=$(db_url "$1") PORT="$2" npx tsx apps/api/src/server.ts >"$3" 2>&1 &
  PIDS+=("$!")
  for _ in $(seq 1 60); do
    curl -fs "http://127.0.0.1:$2/healthz" >/dev/null 2>&1 && return 0
    sleep 1
  done
  tail -20 "$3"; fail "API en :$2 no arrancó"
}

echo "== bases de datos (Docker) =="
start_db "$SRC" "$P_SRC"
start_db "$DST" "$P_DST"
DATABASE_URL=$(db_url "$P_SRC") npx tsx apps/api/src/db/cli.ts migrate >"$W/mig-src.log" 2>&1
DATABASE_URL=$(db_url "$P_SRC") npx tsx apps/api/src/db/cli.ts seed >>"$W/mig-src.log" 2>&1
DATABASE_URL=$(db_url "$P_DST") npx tsx apps/api/src/db/cli.ts migrate >"$W/mig-dst.log" 2>&1
DATABASE_URL=$(db_url "$P_DST") npx tsx apps/api/src/db/cli.ts bootstrap >>"$W/mig-dst.log" 2>&1
[ "$(sql "$DST" 'select count(*) from bots')" = 0 ] || fail "destino no vacío"
[ "$(sql "$DST" 'select count(*) from users')" = 0 ] || fail "destino con usuarios"
pass "origen (con usuarios de desarrollo) y destino NUEVO sin bots ni usuarios"

echo "== APIs =="
start_api "$P_SRC" "$A_SRC" "$W/api-src.log"
start_api "$P_DST" "$A_DST" "$W/api-dst.log"
U_SRC="http://127.0.0.1:$A_SRC"
U_DST="http://127.0.0.1:$A_DST"

# credenciales de fichero 0600 (nunca por argv)
umask 077
printf '{"email":"developer@dev.arena.local","password":"%s"}' "$DEVPW" >"$W/cred-src.json"
printf '{"email":"%s","password":"%s"}' "$NEWMAIL" "$NEWPW" >"$W/cred-dst.json"
curl -fs -X POST "$U_DST/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$NEWMAIL\",\"password\":\"$NEWPW\",\"displayName\":\"operador\"}" >/dev/null || fail "registro del usuario nuevo"
pass "usuario nuevo creado en el destino (la cuenta nueva ya es developer)"

echo "== datos de origen =="
S9_API_URL="$U_SRC" node scripts/portable/e2e/populate.mjs "$W/cred-src.json"
sql "$SRC" "UPDATE bot_versions bv SET state='published', code_public=(b.name='Gamma Retirado') FROM bots b WHERE bv.bot_id=b.id AND ((b.name='Alfa Tanque' AND bv.version IN (1,2)) OR b.name='Gamma Retirado' OR b.name LIKE 'Escuadra %')" >/dev/null
pass "origen poblado: $(sql "$SRC" 'select count(*) from bots') bots, $(sql "$SRC" 'select count(*) from bot_versions') versiones, $(sql "$SRC" 'select count(*) from teams') equipos"

echo "== export =="
S9_API_URL="$U_SRC" node scripts/portable/portable.mjs export --out "$W/export" --engine-version 0.5.0 --source-sha "$(git rev-parse HEAD)" --credentials-file "$W/cred-src.json" || fail "export"
node scripts/portable/portable.mjs verify "$W/export" || fail "verify"
(cd "$W/export" && sha256sum -c checksums.sha256 >/dev/null) || fail "sha256sum -c"
SRC_ID=$(sql "$SRC" "select id from users where email='developer@dev.arena.local'")
if grep -rIl -e 'developer@dev.arena.local' -e "$DEVPW" -e "$SRC_ID" "$W/export" >/dev/null; then fail "secreto o dato personal en el export"; fi
pass "export verificado (sha256sum -c) y sin correo, contraseña ni id de usuario"

echo "== import: dry-run, corrupción, real, repetido =="
S9_API_URL="$U_DST" node scripts/portable/portable.mjs import --from "$W/export" --dry-run --credentials-file "$W/cred-dst.json" --target-engine 0.5.0 >"$W/dry.out" || fail "dry-run"
[ "$(sql "$DST" 'select count(*) from bots')" = 0 ] || fail "el dry-run escribió"
pass "--dry-run no escribe nada ($(tail -1 "$W/dry.out" | cut -c1-80))"

cp -r "$W/export" "$W/bad"
printf '# alterado\n' >"$W/bad/bots/escuadra-1/versions/v1/source.bin"
if S9_API_URL="$U_DST" node scripts/portable/portable.mjs import --from "$W/bad" --credentials-file "$W/cred-dst.json" --target-engine 0.5.0 >"$W/bad.out" 2>&1; then fail "el import de un export corrupto no falló"; fi
grep -q checksum "$W/bad.out" || fail "el fallo no menciona el checksum"
[ "$(sql "$DST" 'select count(*) from bots')" = 0 ] || fail "el export corrupto escribió"
pass "export corrupto: falla antes de escribir (0 bots en el destino)"

S9_API_URL="$U_DST" node scripts/portable/portable.mjs import --from "$W/export" --credentials-file "$W/cred-dst.json" --target-engine 0.5.0 --report "$W/report.json" || fail "import"
N1="$(sql "$DST" 'select count(*) from bots')/$(sql "$DST" 'select count(*) from bot_versions')/$(sql "$DST" 'select count(*) from bot_loadouts')/$(sql "$DST" 'select count(*) from teams')"
[ "$N1" = "7/8/8/2" ] || fail "recuentos tras el import: $N1 (esperado 7/8/8/2)"
[ "$(sql "$DST" "select count(*) from bot_versions where state<>'draft'")" = 0 ] || fail "el import publicó algo"
pass "import real: bots/versiones/loadouts/equipos = $N1, todo en draft"

node scripts/portable/e2e/compare.mjs "$U_SRC" "$W/cred-src.json" "$U_DST" "$W/cred-dst.json" || fail "comparación semántica"
pass "comparación semántica origen/destino igual"

S9_API_URL="$U_DST" node scripts/portable/portable.mjs import --from "$W/export" --credentials-file "$W/cred-dst.json" --target-engine 0.5.0 >"$W/rep.out" || fail "import repetido"
N2="$(sql "$DST" 'select count(*) from bots')/$(sql "$DST" 'select count(*) from bot_versions')/$(sql "$DST" 'select count(*) from bot_loadouts')/$(sql "$DST" 'select count(*) from teams')"
[ "$N1" = "$N2" ] || fail "el import repetido duplicó: $N1 -> $N2"
pass "import repetido idempotente ($N2)"

if S9_API_URL="$U_DST" node scripts/portable/portable.mjs import --from "$W/export" --credentials-file "$W/cred-dst.json" --target-engine 0.4.0 >"$W/eng.out" 2>&1; then fail "motor incompatible aceptado"; fi
pass "motor del destino más antiguo que el del export: rechazado limpiamente"
echo "E2E_PORTABLE_OK"
