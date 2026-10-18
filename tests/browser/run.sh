#!/usr/bin/env bash
# FC-D · E2E de NAVEGADOR REAL de S9 AI Arena — comando canónico: `npm run test:browser`.
#
# Levanta un entorno AISLADO y efímero (nunca producción), sin mocks de la API:
#   API real + PostgreSQL embebido (tests/browser/env/api-env.ts)
#   tournament-worker real: EJECUTA las batallas (contenedores reales vía el
#     s9-docker-proxy local del repo) y aloja el gateway WebSocket de espectador
#   bot-build-worker real: builds en el sandbox (contenedor real) y firma
#   s9-docker-proxy LOCAL (apps/bot-manager/src/docker-proxy-main.ts) → Docker rootless
#   replay-service real
#   SPA construida con `vite build` servida con la conf REAL del contenedor web
#   gateway nginx con la conf REAL infrastructure/gateway/nginx-behind-proxy.conf
#   proxy TLS delante (papel del proxy inverso externo: https → gateway http)
# y ejecuta Playwright con el Chromium de la imagen oficial, fijada por digest,
# en el Docker local (rootless de la máquina de pruebas). Todo escucha en 127.0.0.1.
#
# Fases (cada una con su rc):
#   G · @golden golden path (REVIEW, R6): registro → bots → build real → equipo → mapa
#               → batalla REAL → visor en directo → stats → replay. Su batalla es la
#               que usan después la fase 1 (replay) y la sonda TD-028 (sustituye al
#               atajo seed-replay de DEV-D).
#   1 · @fase1  todo vivo: UX, navegación, 404, replay, visor
#   2 · @fase2  replay-service PARADO de verdad ⇒ 502 real del gateway
#   3 · @fase3  API PARADA de verdad ⇒ arranque con la API caída
# Además, sonda TD-028 (ticket → TLS → gateway → worker): 4404 con el secreto
# compartido y 4401 con un secreto ajeno (control negativo).
#
# Variables opcionales:
#   S9_E2E_STATE      directorio de estado (por defecto mktemp en /tmp); logs, capturas, informe
#   S9_E2E_PORT_BASE  primer puerto (por defecto 38080; usa base..base+8 y base+363)
#   S9_E2E_GREP       filtro extra de Playwright para la fase 1
#   S9_E2E_SKIP_GOLDEN=1  no ejecutar la fase golden (sin Docker para bots); la fase 1
#                     de replay fallará por falta de batalla (no hay atajo)
#   S9_SANDBOX_ADVERTISE_HOST  IP de este host alcanzable desde los contenedores
#   S9_E2E_KEEP=1     no parar el entorno al terminar (depuración)
#   S9_E2E_TAG        prefijo de los contenedores propios (def. s9e2e-<pid>); la CI usa s9ci-<run>
#   S9_E2E_PG_URL     servidor PostgreSQL EXTERNO (p. ej. el service de la CI) en vez del
#                     embebido; la API crea en él una BD efímera de nombre único (CREATEDB)
#   S9_E2E_REDIS_URL  Redis del tournament-worker (aviso de trabajos); sin ella, polling de BD
#   DOCKER_SOCKET     socket de Docker (def. el rootless del usuario; la CI: /var/run/docker.sock)
# Las imágenes de runtime de bots (runtimes/DIGESTS.lock) se descargan ANTES de arrancar
# nada si faltan: el reloj de arranque del sandbox nunca incluye un `docker pull`.
# Salida: rc 0 sólo si TODAS las fases (golden incluida) y la sonda pasan. Resumen en $STATE/out/summary.txt.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PW_IMAGE="mcr.microsoft.com/playwright:v1.48.2-jammy@sha256:96dc479be9a603227fafc7126bd7d5e8152ae3e63749f377b2c49a4314b28ae1"
NGINX_IMAGE="${S9_E2E_NGINX_IMAGE:-nginxinc/nginx-unprivileged:1.27-alpine@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0}"
STATE="${S9_E2E_STATE:-$(mktemp -d /tmp/s9-browser-e2e.XXXXXX)}"
OUT="$STATE/out"
B="${S9_E2E_PORT_BASE:-38080}"
P_API=$B P_WS=$((B + 1)) P_REPLAY=$((B + 2)) P_WEB=$((B + 3)) P_PROXY=$((B + 4)) P_GW=$((B + 8)) P_TLS=$((B + 363))
TAG="${S9_E2E_TAG:-s9e2e-$$}"
CACHE="${HOME}/.cache/s9-browser-e2e/$(sha256sum "$REPO/tests/browser/package-lock.json" | cut -c1-16)"
TSX="$REPO/node_modules/.bin/tsx"

umask 077
mkdir -p "$OUT/shots" "$STATE/logs" "$STATE/replays" "$STATE/secrets" "$STATE/certs" "$STATE/confs" "$CACHE"
chmod 755 "$STATE" "$STATE/confs" "$STATE/certs" "$OUT" "$OUT/shots"
log() { echo "[run.sh $(date +%H:%M:%S)] $*" | tee -a "$OUT/summary.txt"; }

node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=15)?0:1)' || {
  echo "Node >= 22.15 requerido (actual $(node -v))" >&2
  exit 2
}

PIDS=()
# Evidencia de contenedores (PRC DEV-CI, TD-045): estado y logs de los contenedores
# propios y de bots ANTES de borrarlos, siempre (también en verde).
docker_evidence() {
  mkdir -p "$STATE/logs/containers"
  docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' >"$STATE/logs/containers/docker-ps.txt" 2>&1
  for c in $(docker ps -a --format '{{.Names}}' | grep -E "^($TAG-|bot-)" || true); do
    docker logs "$c" >"$STATE/logs/containers/$c.log" 2>&1
  done
}
cleanup() {
  docker_evidence
  [ "${S9_E2E_KEEP:-0}" = "1" ] && { log "S9_E2E_KEEP=1: entorno vivo en $STATE"; return; }
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -TERM -- "-$p" 2>/dev/null; done
  sleep 2
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -KILL -- "-$p" 2>/dev/null; done
  docker rm -f "$TAG-web" "$TAG-gw" "$TAG-tls" >/dev/null 2>&1
  log "entorno parado (estado conservado en $STATE)"
}
trap cleanup EXIT

start() { # start <nombre> <cmd...>  (nuevo grupo de procesos para poder pararlo entero)
  local name=$1
  shift
  setsid "$@" >"$STATE/logs/$name.log" 2>&1 &
  echo $!
}
wait_http() { # wait_http <url> <segundos>
  for _ in $(seq 1 "$2"); do curl -ks -o /dev/null -m 2 "$1" && return 0; sleep 1; done
  return 1
}

log "estado: $STATE · puertos api=$P_API ws=$P_WS replay=$P_REPLAY web=$P_WEB gw=$P_GW tls=$P_TLS"
log "HEAD $(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo '?') · imagen $PW_IMAGE"

# ── secretos efímeros (ficheros 0600, nunca en argv) ─────────────────────────
head -c 32 /dev/urandom | base64 >"$STATE/secrets/jwt_secret"
head -c 32 /dev/urandom | base64 >"$STATE/secrets/jwt_secret_ajeno"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=127.0.0.1" \
  -keyout "$STATE/certs/tls.key" -out "$STATE/certs/tls.crt" >"$STATE/logs/openssl.log" 2>&1 || { log "openssl falló"; exit 2; }
chmod 644 "$STATE/certs/tls.key" "$STATE/certs/tls.crt"
# Firma de artefactos (ed25519): la privada SÓLO para el bot-build-worker; el
# tournament-worker recibe la PÚBLICA (ARTIFACT_VERIFY_KEY_FILE), igual que en Compose.
openssl genpkey -algorithm ed25519 -out "$STATE/secrets/artifact_signing_key.pem" >>"$STATE/logs/openssl.log" 2>&1 &&
  openssl pkey -in "$STATE/secrets/artifact_signing_key.pem" -pubout -out "$STATE/secrets/artifact_verify_key.pem" \
    >>"$STATE/logs/openssl.log" 2>&1 || { log "openssl (ed25519) falló"; exit 2; }

# ── Docker para los bots: red `arena` (COMPARTIDA: se crea si falta, NUNCA se borra)
docker network inspect arena >/dev/null 2>&1 || docker network create arena >/dev/null
DOCKER_SOCK="${DOCKER_SOCKET:-/run/user/$(id -u)/docker.sock}"
ADVERTISE="${S9_SANDBOX_ADVERTISE_HOST:-$(node -e '
  const os = require("os");
  for (const [n, a] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|br-|veth|tailscale|lo)/.test(n)) continue;
    const v = (a || []).find((x) => x.family === "IPv4" && !x.internal);
    if (v) { console.log(v.address); process.exit(0); }
  }
  process.exit(1);')}"
[ -n "$ADVERTISE" ] || { log "sin IPv4 alcanzable desde los contenedores (S9_SANDBOX_ADVERTISE_HOST)"; exit 2; }
# Runtimes fijados por digest presentes ANTES del primer build (fuera del reloj de arranque).
for img in $(grep -v '^#' "$REPO/runtimes/DIGESTS.lock" | awk 'NF==3 {print $3}'); do
  docker image inspect "$img" >/dev/null 2>&1 && continue
  log "descargando runtime $img"
  docker pull -q "$img" >>"$STATE/logs/docker-pull.log" 2>&1 || { log "no se pudo descargar $img"; exit 2; }
done

# ── SPA (igual que el Dockerfile del web: vite build) ────────────────────────
log "vite build…"
(cd "$REPO" && node_modules/.bin/vite build apps/web --outDir "$STATE/dist" --emptyOutDir) >"$STATE/logs/vite.log" 2>&1
VITE_RC=$?
log "VITE_BUILD_RC=$VITE_RC"
[ $VITE_RC -eq 0 ] || exit 1
chmod -R a+rX "$STATE/dist"

# ── servicios reales ─────────────────────────────────────────────────────────
cd "$REPO"
# API: PostgreSQL embebido por defecto; con S9_E2E_PG_URL, BD efímera en ese servidor.
API_DB=(-u DATABASE_URL)
PG_MODE=embebido
if [ -n "${S9_E2E_PG_URL:-}" ]; then
  API_DB=(DATABASE_URL="$S9_E2E_PG_URL")
  PG_MODE="externo (BD efímera)"
  # Healthcheck: el servidor acepta consultas de verdad (no basta con el puerto abierto:
  # la imagen oficial reinicia tras su init). La URL va por entorno, nunca por argv.
  PG_OK=0
  for _ in $(seq 1 60); do
    if PGURL="$S9_E2E_PG_URL" node -e '
      const { Client } = require("pg");
      const c = new Client({ connectionString: process.env.PGURL });
      c.connect().then(() => c.query("select 1")).then(() => c.end()).then(() => process.exit(0), () => process.exit(1));
    ' >/dev/null 2>&1; then PG_OK=1; break; fi
    sleep 1
  done
  [ $PG_OK -eq 1 ] || { log "PostgreSQL externo no responde (S9_E2E_PG_URL)"; exit 1; }
fi
log "postgres: $PG_MODE · redis: $([ -n "${S9_E2E_REDIS_URL:-}" ] && echo 'sí (aviso de trabajos)' || echo 'no (polling de BD)')"
PIDS+=("$(start api env "${API_DB[@]}" PORT=$P_API DBURL_FILE="$STATE/db.url" \
  JWT_SECRET_FILE="$STATE/secrets/jwt_secret" SPECTATE_WS_URL=/ws/spectate \
  "$TSX" tests/browser/env/api-env.ts)")
for _ in $(seq 1 120); do [ -s "$STATE/db.url" ] && break; sleep 1; done
[ -s "$STATE/db.url" ] || { log "la API no arrancó (ver logs/api.log)"; exit 1; }
DATABASE_URL="$(cat "$STATE/db.url")"
export DATABASE_URL
WORKER_REDIS=()
[ -n "${S9_E2E_REDIS_URL:-}" ] && WORKER_REDIS=(REDIS_URL="$S9_E2E_REDIS_URL")
PIDS+=("$(start worker env "${WORKER_REDIS[@]}" JWT_SECRET_FILE="$STATE/secrets/jwt_secret" REPLAYS_DIR="$STATE/replays" \
  SPECTATE_PORT=$P_WS VERSION_PATH="$STATE/worker-version.json" HEARTBEAT_PATH="$STATE/worker-heartbeat" \
  DOCKER_PROXY_URL="http://127.0.0.1:$P_PROXY" ARENA_ENGINE_HOST="$ADVERTISE" ARENA_NETWORK=arena \
  ARTIFACT_VERIFY_KEY_FILE="$STATE/secrets/artifact_verify_key.pem" \
  "$TSX" apps/tournament-worker/src/main.ts)")
PIDS+=("$(start build-worker env DOCKER_PROXY_URL="http://127.0.0.1:$P_PROXY" BUILD_SANDBOX_HOST="$ADVERTISE" \
  ARENA_NETWORK=arena ARTIFACT_SIGNING_KEY_FILE="$STATE/secrets/artifact_signing_key.pem" \
  HEARTBEAT_PATH="$STATE/build-heartbeat" "$TSX" apps/bot-manager/src/build-worker-main.ts)")
unset DATABASE_URL
PIDS+=("$(start replay env REPLAYS_DIR="$STATE/replays" PORT=$P_REPLAY "$TSX" apps/replay-service/src/main.ts)")
REPLAY_PID=${PIDS[3]}
API_PID=${PIDS[0]}
# s9-docker-proxy LOCAL (el del repo, no el del host de producción): único proceso que toca el socket.
PIDS+=("$(start docker-proxy env DOCKER_PROXY_BIND=127.0.0.1 DOCKER_PROXY_PORT=$P_PROXY DOCKER_SOCKET="$DOCKER_SOCK" \
  ARENA_NETWORK=arena "$TSX" apps/bot-manager/src/docker-proxy-main.ts)")

# ── nginx: web, gateway y TLS con las confs REALES transformadas ─────────────
node tests/browser/env/gen-nginx-confs.mjs "$REPO" "$STATE/confs" $P_API $P_WS $P_REPLAY $P_WEB $P_GW $P_TLS >>"$STATE/logs/confs.log" 2>&1 || {
  log "gen-nginx-confs falló (ver logs/confs.log)"
  exit 1
}
chmod 644 "$STATE"/confs/*.conf # nginx corre sin privilegios en el contenedor; no contienen secretos
docker run -d --name "$TAG-web" --network host -v "$STATE/confs/web.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$STATE/dist:/usr/share/nginx/html:ro" "$NGINX_IMAGE" >/dev/null
docker run -d --name "$TAG-gw" --network host -v "$STATE/confs/gateway.conf:/etc/nginx/nginx.conf:ro" "$NGINX_IMAGE" >/dev/null
docker run -d --name "$TAG-tls" --network host -v "$STATE/confs/tls.conf:/etc/nginx/nginx.conf:ro" \
  -v "$STATE/certs:/certs:ro" "$NGINX_IMAGE" >/dev/null
BASE="https://127.0.0.1:$P_TLS"
wait_http "http://127.0.0.1:$P_API/healthz" 60 || { log "API sin /healthz"; exit 1; }
wait_http "http://127.0.0.1:$P_REPLAY/replays/" 60 || { log "replay-service no responde"; exit 1; }
wait_http "$BASE/healthz" 30 || {
  log "cadena TLS→gateway no responde"
  docker logs "$TAG-gw" >"$STATE/logs/gw.log" 2>&1
  exit 1
}
for _ in $(seq 1 30); do [ -s "$STATE/worker-heartbeat" ] && break; sleep 1; done
for _ in $(seq 1 30); do grep -q '"battleExecution"' "$STATE/logs/worker.log" && break; sleep 1; done
grep -q '"battleExecution":"container"' "$STATE/logs/worker.log" || {
  log "el tournament-worker NO ejecuta batallas (ver logs/worker.log)"
  exit 1
}
# Orden por healthchecks: el proxy de Docker escucha y el worker de builds tiene sandbox.
for _ in $(seq 1 30); do grep -q 'proxy de Docker escuchando' "$STATE/logs/docker-proxy.log" && break; sleep 1; done
grep -q 'proxy de Docker escuchando' "$STATE/logs/docker-proxy.log" || {
  log "s9-docker-proxy local no escucha (ver logs/docker-proxy.log)"
  exit 1
}
for _ in $(seq 1 30); do grep -q '"sandbox"' "$STATE/logs/build-worker.log" && break; sleep 1; done
grep -q '"sandbox":"container"' "$STATE/logs/build-worker.log" || {
  log "el bot-build-worker NO tiene sandbox real (ver logs/build-worker.log)"
  exit 1
}
log "entorno listo en $BASE · bots anunciados en $ADVERTISE"

# ── Playwright en la imagen oficial ──────────────────────────────────────────
{
  echo "S9_E2E_BASE=$BASE"
  echo "S9_E2E_OUT=/out"
  echo "S9_E2E_DEV_EMAIL=organizer@dev.arena.local"
  # contraseña de la semilla de desarrollo (BD efímera); por fichero, no en argv
  echo "S9_E2E_DEV_PASSWORD=$(grep -oP 'DEV_PASSWORD = "\K[^"]+' apps/api/src/db/seeds/dev.ts)"
} >"$STATE/pw.env"

pw() { # pw <fase> <grep>
  local phase=$1 grep=$2
  mkdir -p "$OUT/$phase"
  chmod 777 "$OUT/$phase"
  docker run --rm --network host --ipc host --init --name "$TAG-pw-$phase" \
    -v "$REPO/tests/browser:/src:ro" -v "$OUT:/out" -v "$CACHE:/cache" --env-file "$STATE/pw.env" \
    -e S9_E2E_OUT=/out -e PW_PHASE="$phase" -e PW_GREP="$grep" "$PW_IMAGE" bash -c '
      set -e
      mkdir -p /work && cp -r /src/. /work/ && cd /work
      if [ ! -d /cache/node_modules/@playwright/test ]; then
        npm ci --no-audit --no-fund >/out/$PW_PHASE/npm-ci.log 2>&1
        cp -r node_modules /cache/
      else
        ln -s /cache/node_modules node_modules
      fi
      npx playwright --version
      npx playwright test -c playwright.config.ts --grep "$PW_GREP" --output "/out/$PW_PHASE/test-results"
    ' >"$OUT/$phase/playwright.log" 2>&1
  local rc=$?
  [ -f "$OUT/report.json" ] && mv "$OUT/report.json" "$OUT/$phase/report.json"
  echo $rc
}

# ── fase GOLDEN: batalla REAL creada desde la UI (REVIEW, R6) ────────────────
RCG=1
REPLAY_ID=""
if [ "${S9_E2E_SKIP_GOLDEN:-0}" != "1" ]; then
  RCG=$(pw golden "@golden")
  log "PLAYWRIGHT_GOLDEN_RC=$RCG ($(grep -Eo '[0-9]+ (passed|failed|skipped|flaky)' "$OUT/golden/playwright.log" | tr '\n' ' '))"
  [ -s "$OUT/golden/battle.json" ] &&
    REPLAY_ID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).battleId)' "$OUT/golden/battle.json")
else
  log "PLAYWRIGHT_GOLDEN_RC=SKIPPED (S9_E2E_SKIP_GOLDEN=1): no cuenta como verde"
fi
log "batalla del golden path (replay de la fase 1 y sonda): ${REPLAY_ID:-ninguna}"
# Evidencia de BD (builds con sus etapas, versiones, batallas, jobs; sin secretos) mientras
# la API (y con ella el PostgreSQL embebido) sigue viva.
DATABASE_URL="$(cat "$STATE/db.url")" "$TSX" tests/browser/env/dump-evidence.ts "$OUT/db-evidence.json" \
  >>"$STATE/logs/dump-evidence.log" 2>&1 || log "aviso: no se pudo volcar la evidencia de BD (logs/dump-evidence.log)"
echo "S9_E2E_REPLAY_ID=$REPLAY_ID" >>"$STATE/pw.env"

# ── sonda TD-028 (ticket → TLS → gateway → worker) ───────────────────────────
PROBE_OK=$(JWT_SECRET_FILE="$STATE/secrets/jwt_secret" "$TSX" tests/browser/env/ticket-probe.ts "wss://127.0.0.1:$P_TLS/ws/spectate" "$REPLAY_ID" 2>>"$STATE/logs/probe.log")
PROBE_BAD=$(JWT_SECRET_FILE="$STATE/secrets/jwt_secret_ajeno" "$TSX" tests/browser/env/ticket-probe.ts "wss://127.0.0.1:$P_TLS/ws/spectate" "$REPLAY_ID" 2>>"$STATE/logs/probe.log")
echo "{\"sharedSecret\":$PROBE_OK,\"foreignSecret\":$PROBE_BAD}" >"$OUT/ticket-probe.json"
PROBE_RC=1
if echo "$PROBE_OK" | grep -q '"code":4404' && echo "$PROBE_BAD" | grep -q '"code":4401'; then PROBE_RC=0; fi
log "TD028_PROBE_RC=$PROBE_RC compartido=$PROBE_OK ajeno=$PROBE_BAD"

GREP1="@fase1${S9_E2E_GREP:+.*$S9_E2E_GREP}"
RC1=$(pw fase1 "$GREP1")
log "PLAYWRIGHT_FASE1_RC=$RC1 ($(grep -Eo '[0-9]+ (passed|failed|skipped|flaky)' "$OUT/fase1/playwright.log" | tr '\n' ' '))"

kill -TERM -- "-$REPLAY_PID" 2>/dev/null
for _ in $(seq 1 20); do curl -s -o /dev/null -m 1 "http://127.0.0.1:$P_REPLAY/replays/" || break; sleep 0.5; done
RC2=$(pw fase2 "@fase2")
log "PLAYWRIGHT_FASE2_RC=$RC2 ($(grep -Eo '[0-9]+ (passed|failed|skipped|flaky)' "$OUT/fase2/playwright.log" | tr '\n' ' '))"

kill -TERM -- "-$API_PID" 2>/dev/null
for _ in $(seq 1 30); do curl -s -o /dev/null -m 1 "http://127.0.0.1:$P_API/healthz" || break; sleep 0.5; done
RC3=$(pw fase3 "@fase3")
log "PLAYWRIGHT_FASE3_RC=$RC3 ($(grep -Eo '[0-9]+ (passed|failed|skipped|flaky)' "$OUT/fase3/playwright.log" | tr '\n' ' '))"

docker logs "$TAG-gw" >"$STATE/logs/gw.log" 2>&1
docker logs "$TAG-tls" >"$STATE/logs/tls.log" 2>&1
TOTAL=$((RCG | RC1 | RC2 | RC3 | PROBE_RC))
log "BROWSER_E2E_RC=$TOTAL (golden=$RCG fase1=$RC1 fase2=$RC2 fase3=$RC3 sonda=$PROBE_RC) · capturas en $OUT/shots"
exit $TOTAL
