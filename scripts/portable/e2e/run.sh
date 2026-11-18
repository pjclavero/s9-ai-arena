#!/usr/bin/env bash
# Ensayo E2E del export/import portable con PROCESOS REALES: dos PostgreSQL en contenedores Docker
# (origen y destino NUEVO y vacío), dos APIs reales (apps/api/src/server.ts), y el CLI como procesos
# aparte con credenciales de fichero 0600. SÓLO en el laboratorio de pruebas, nunca en el host de
# orquestación ni en producción. Requiere: docker, Node (tsx en node_modules), imagen postgres:16-alpine.
#
# Uso: flock -o <FICHERO_LOCK> bash scripts/portable/e2e/run.sh
set -euo pipefail
# Anfitriones en los que NO debe correr (lista separada por espacios, p. ej. el de orquestación):
# S9_PORTABLE_FORBIDDEN_HOSTS="host1 host2". Vacío por defecto.
for h in ${S9_PORTABLE_FORBIDDEN_HOSTS:-}; do [ "$(hostname)" = "$h" ] && { echo STOP; exit 1; }; done

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"
set -m # cada trabajo en segundo plano es su propio grupo de procesos: se limpia por PGID, sin pkill
W=$(mktemp -d)
# Salida COMPLETA de cada ejecución (script + logs de las APIs y de las migraciones), siempre capturada.
LOGDIR=${E2E_LOG_DIR:-${TMPDIR:-/tmp}/s9-portable-e2e-logs}
mkdir -p "$LOGDIR"
RUN_ID="$(date +%Y%m%dT%H%M%S)-$$"
exec > >(tee "$LOGDIR/e2e-$RUN_ID.log") 2>&1
PIDS=()       # PID de cada API (= PGID de su grupo)
CONTAINERS=() # contenedores propios de ESTA ejecución
SRC=s9portable-src-$$
DST=s9portable-dst-$$
PW=pg-efimera-e2e
cleanup() {
  rc=$?
  trap - EXIT
  for p in "${PIDS[@]:-}"; do
    [ -n "$p" ] || continue
    kill -TERM -- "-$p" 2>/dev/null || true
  done
  for _ in $(seq 1 20); do
    left=0
    for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -0 -- "-$p" 2>/dev/null && left=1; done
    [ "$left" = 0 ] && break
    sleep 0.25
  done
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -KILL -- "-$p" 2>/dev/null || true; done
  [ "${#CONTAINERS[@]}" -gt 0 ] && docker rm -f "${CONTAINERS[@]}" >/dev/null 2>&1 || true
  for f in "$W"/*.log; do [ -f "$f" ] && cp "$f" "$LOGDIR/e2e-$RUN_ID-$(basename "$f")" || true; done
  rm -rf "$W"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; exit 1; }

DEVPW='dev-password-s9-arena!'
NEWMAIL='operador.nuevo@example.test'
NEWPW='contrasena-nueva-del-operador!'
export ARENA_DEV_INSECURE_SECRETS=1

# Puertos EFÍMEROS: se piden al sistema (nunca fijos). La API se arranca con reintento y se comprueba
# que el proceso que escucha en el puerto es el PROPIO (mismo grupo), no uno ajeno ni un huérfano.
free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }

start_db() { # nombre -> deja el puerto asignado en $DB_PORT
  docker rm -f "$1" >/dev/null 2>&1 || true
  CONTAINERS+=("$1")
  docker run -d --name "$1" -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=arena -p "127.0.0.1::5432" postgres:16-alpine >/dev/null
  DB_PORT=$(docker port "$1" 5432/tcp | head -1 | sed 's/.*://')
  for _ in $(seq 1 60); do
    docker exec "$1" pg_isready -U postgres -d arena >/dev/null 2>&1 && return 0
    sleep 1
  done
  fail "postgres $1 no arrancó"
}
sql() { docker exec "$1" psql -U postgres -d arena -tA -c "$2"; }
db_url() { echo "postgres://postgres:$PW@127.0.0.1:$1/arena"; }
owns_port() { # puerto pgid -> ¿el que escucha en el puerto pertenece a nuestro grupo?
  local lp
  for lp in $(ss -Htlnp "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2); do
    [ "$(ps -o pgid= -p "$lp" 2>/dev/null | tr -d ' ')" = "$2" ] && return 0
  done
  return 1
}
start_api() { # puerto-bd log -> deja el puerto de la API en $API_PORT
  local port pid try
  for try in 1 2 3; do
    port=$(free_port)
    DATABASE_URL=$(db_url "$1") PORT="$port" npx tsx apps/api/src/server.ts >"$2" 2>&1 &
    pid=$!
    PIDS+=("$pid")
    for _ in $(seq 1 60); do
      kill -0 "$pid" 2>/dev/null || break
      if curl -fs "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && owns_port "$port" "$pid"; then
        API_PORT=$port
        return 0
      fi
      sleep 1
    done
    kill -TERM -- "-$pid" 2>/dev/null || true # no arrancó o el puerto no es nuestro: se reintenta con otro
    sleep 1
  done
  tail -20 "$2"; fail "API no arrancó con puerto propio tras 3 intentos"
}

echo "== bases de datos (Docker) =="
start_db "$SRC"; P_SRC=$DB_PORT
start_db "$DST"; P_DST=$DB_PORT
DATABASE_URL=$(db_url "$P_SRC") npx tsx apps/api/src/db/cli.ts migrate >"$W/mig-src.log" 2>&1
DATABASE_URL=$(db_url "$P_SRC") npx tsx apps/api/src/db/cli.ts seed >>"$W/mig-src.log" 2>&1
DATABASE_URL=$(db_url "$P_DST") npx tsx apps/api/src/db/cli.ts migrate >"$W/mig-dst.log" 2>&1
DATABASE_URL=$(db_url "$P_DST") npx tsx apps/api/src/db/cli.ts bootstrap >>"$W/mig-dst.log" 2>&1
[ "$(sql "$DST" 'select count(*) from bots')" = 0 ] || fail "destino no vacío"
[ "$(sql "$DST" 'select count(*) from users')" = 0 ] || fail "destino con usuarios"
pass "origen (con usuarios de desarrollo) y destino NUEVO sin bots ni usuarios"

echo "== APIs =="
start_api "$P_SRC" "$W/api-src.log"; A_SRC=$API_PORT
start_api "$P_DST" "$W/api-dst.log"; A_DST=$API_PORT
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
[ "$N1" = "7/9/8/2" ] || fail "recuentos tras el import: $N1 (esperado 7/9/8/2)"
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
