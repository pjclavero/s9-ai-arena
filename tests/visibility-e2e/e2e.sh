#!/usr/bin/env bash
# VISIBILIDAD (2026-11) · §35 · E2E LOCAL REAL de la retransmisión pública con un bot
# PRIVADO (nunca producción):
#
#   API real (PG embebido) + gateway de espectador + batalla REAL del motor en un torneo
#   con `broadcast` (A-DEF privado/código privado vs B-PUB público/código privado)
#   → Administración → Streaming por la API (admin) → imagen REAL del streamer
#   (Xvfb + Chromium capturando /broadcast + FFmpeg) en modo «Sólo grabar»
#   + navegador REAL anónimo (Playwright, imagen oficial fijada) sobre /broadcast.
#
# Comprueba: nombres y equipos en /broadcast y en el vídeo grabado, combate correcto
# (terminado con resultado y replay que se re-verifica), ningún código ni dato privado
# en lo que recibe el visitante ni en la entrada del streamer, la batalla suelta sigue
# bloqueada (battle_not_public) y A sigue private y B public, con su código privado.
#
#   S9_STREAM_E2E_STATE=<dir> STREAMER_IMAGE=<imagen> tests/visibility-e2e/e2e.sh
# Lanzarlo bajo el cerrojo de carga del host. Al salir no deja nada vivo.
export S9_STREAM_E2E_TAG="${S9_STREAM_E2E_TAG:-vis}"
export S9_STREAM_E2E_CTL_PORT="${S9_STREAM_E2E_CTL_PORT:-48290}"
source "$(dirname "${BASH_SOURCE[0]}")/../streaming-e2e/lib.sh"
PW_IMAGE="mcr.microsoft.com/playwright:v1.48.2-jammy@sha256:96dc479be9a603227fafc7126bd7d5e8152ae3e63749f377b2c49a4314b28ae1"
CACHE="${HOME}/.cache/s9-browser-e2e/$(sha256sum "$REPO/tests/browser/package-lock.json" | cut -c1-16)"
PORT="${S9_VIS_E2E_PORT:-39580}"
BASE="http://127.0.0.1:$PORT"
OUT="$STATE/out"
mkdir -p "$OUT"
LIVE_PID=""
cleanup() {
  [ -n "$LIVE_PID" ] && kill "$LIVE_PID" 2>/dev/null && wait "$LIVE_PID" 2>/dev/null
  docker rm -f "$TAG-pw" >/dev/null 2>&1
  down_all
}
trap cleanup EXIT
log() { echo "[$(date +%T)] $*" | tee -a "$OUT/summary.txt"; }
declare -A RC
check() { # check <nombre> <condición-bash>
  if eval "$2"; then RC[$1]=0; else RC[$1]=1; fi
  log "COMPROBACIÓN $1 rc=${RC[$1]}"
}
j() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(eval("j."+process.argv[1]))})' "$1"; }
FORBIDDEN_RE='SECRETO_CODIGO_A_DEF_7f3a|estrategia-secreta-a-def|duena-secreta-a-def|Dueña Secreta ADEF|loadout-secreto-a-def'

# ── preparación ──────────────────────────────────────────────────────────────
gen_secrets
log "vite build…"
(cd "$REPO" && node_modules/.bin/vite build apps/web --outDir "$STATE/dist" --emptyOutDir) >"$OUT/vite.log" 2>&1 || { log "vite build falló"; exit 2; }
log "entorno vivo…"
(cd "$REPO" && PORT="$PORT" WEB_DIST="$STATE/dist" BATTLE_SECONDS="${S9_VIS_BATTLE_SECONDS:-90}" \
  STREAMER_CONTROL_URL="http://127.0.0.1:$CTL_PORT" STREAMER_CONTROL_SECRET_FILE="$STATE/control_secret" \
  STREAM_SECRETS_PUBLIC_KEY_FILE="$STATE/public.pem" \
  exec node_modules/.bin/tsx tests/visibility-e2e/vis-live-env.ts) >"$OUT/live-env.log" 2>&1 &
LIVE_PID=$!
for _ in $(seq 1 120); do grep -q "vis live-env listo" "$OUT/live-env.log" && break; sleep 1; done
grep -q "vis live-env listo" "$OUT/live-env.log" || { log "el entorno no arrancó"; tail -20 "$OUT/live-env.log"; exit 2; }
IDS=$(curl -s "$BASE/harness/ids")
echo "$IDS" >"$OUT/ids.json"
TB=$(echo "$IDS" | j TB); S=$(echo "$IDS" | j S); BOT_A=$(echo "$IDS" | j BOT_A); BOT_B=$(echo "$IDS" | j BOT_B)
curl -s "$BASE/harness/state" >"$OUT/state-before.json"
log "batalla de torneo $TB · suelta $S · A=$BOT_A · B=$BOT_B"

export S9_STREAM_E2E_BROADCAST_BASE="$BASE/broadcast"
BROADCAST_BASE="$BASE/broadcast"
streamer_up record || exit 2
log "streamer arriba ($IMG)"

# ── sesión de administración (la contraseña de la BD efímera, por fichero) ────
# La contraseña (de la BD efímera de desarrollo) se lee y se escribe DENTRO de node: nunca en argv.
node -e '
  const fs=require("fs"); const src=fs.readFileSync(process.argv[2],"utf8");
  const password=/DEV_PASSWORD = "([^"]+)"/.exec(src)[1];
  fs.writeFileSync(process.argv[1], JSON.stringify({email:"admin@dev.arena.local",password}),{mode:0o600});' \
  "$STATE/login.json" "$REPO/apps/api/src/db/seeds/dev.ts"
TOKEN=$(curl -s -H 'content-type: application/json' --data-binary @"$STATE/login.json" "$BASE/api/v1/auth/login" | j accessToken)
printf 'Authorization: Bearer %s\n' "$TOKEN" >"$STATE/admin_header"; chmod 0600 "$STATE/admin_header"
adm() { # adm <método> <ruta> [json]
  if [ -n "${3:-}" ]; then
    curl -s -X "$1" -H @"$STATE/admin_header" -H 'content-type: application/json' -d "$3" "$BASE/api/v1$2"
  else curl -s -X "$1" -H @"$STATE/admin_header" "$BASE/api/v1$2"; fi
}
V=$(adm GET /admin/streaming | j settings.version)
adm PUT /admin/streaming/settings "{\"version\":$V,\"enabled\":true,\"mode\":\"record\",\"branding\":{\"eventName\":\"Copa Visibilidad\"}}" >"$OUT/settings.json"

# ── control: batalla suelta con bot privado ⇒ battle_not_public ──────────────
adm GET "/admin/streaming/target?kind=battle&id=$S" >"$OUT/target-loose.json"
adm POST /admin/streaming/start "{\"target\":{\"kind\":\"battle\",\"id\":\"$S\"}}" >"$OUT/start-loose.json"
check loose_blocked 'grep -q "\"error\":\"battle_not_public\"" "$OUT/start-loose.json" && grep -q "\"broadcastBlockedReason\":\"battle_not_public\"" "$OUT/target-loose.json"'

# ── batalla real en directo + emisión ────────────────────────────────────────
curl -s -X POST "$BASE/harness/start" >/dev/null
adm GET "/admin/streaming/target?kind=battle&id=$TB" >"$OUT/target-tb.json"
check target_broadcastable 'grep -q "\"broadcastable\":true" "$OUT/target-tb.json" && grep -q "\"tournamentBroadcast\":true" "$OUT/target-tb.json"'
adm POST /admin/streaming/start "{\"target\":{\"kind\":\"battle\",\"id\":\"$TB\"}}" >"$OUT/start-tb.json"
check start_tb '! grep -q "\"error\"" "$OUT/start-tb.json"'
sleep 8

# ── navegador anónimo sobre /broadcast ───────────────────────────────────────
mkdir -p "$OUT/pw" && chmod 777 "$OUT/pw"
docker run --rm --network host --ipc host --init --name "$TAG-pw" \
  -v "$REPO/tests/browser:/src:ro" -v "$OUT:/out" -v "$CACHE:/cache" \
  -e S9_E2E_BASE="$BASE" -e S9_E2E_OUT=/out/pw -e S9_VIS_IDS="$IDS" "$PW_IMAGE" bash -c '
    set -e
    mkdir -p /work && cp -r /src/. /work/ && cd /work
    if [ ! -d /cache/node_modules/@playwright/test ]; then
      npm ci --no-audit --no-fund >/out/pw/npm-ci.log 2>&1 && cp -r node_modules /cache/
    else ln -s /cache/node_modules node_modules; fi
    npx playwright test -c playwright.config.ts --grep "@vis-e2e" --output /out/pw/test-results
  ' >"$OUT/pw/playwright.log" 2>&1
RC[browser]=$?
log "PASO browser rc=${RC[browser]} ($(grep -Eo '[0-9]+ (passed|failed|skipped)' "$OUT/pw/playwright.log" | tr '\n' ' '))"

# ── entrada del streamer: sólo la URL de /broadcast ──────────────────────────
docker top "$TAG-streamer" -eo pid,args >"$OUT/streamer-argv.txt"
docker logs "$TAG-streamer" >"$OUT/streamer.log" 2>&1
docker inspect "$TAG-streamer" >"$OUT/streamer-inspect.json"
check streamer_input_clean '! grep -Eq "$FORBIDDEN_RE" "$OUT/streamer-argv.txt" "$OUT/streamer.log" "$OUT/streamer-inspect.json" "$OUT/start-tb.json" && grep -q "battle=$TB" "$OUT/streamer.log" "$OUT/streamer-argv.txt"'

# ── fin del combate, parada y vídeo ──────────────────────────────────────────
for _ in $(seq 1 90); do [ "$(curl -s "$BASE/harness/state" | j battle.status)" = finished ] && break; sleep 2; done
sleep 4
adm POST /admin/streaming/stop '{}' >"$OUT/stop.json"
sleep 4
curl -s "$BASE/harness/state" >"$OUT/state-after.json"
log "batalla: $(j battle.status <"$OUT/state-after.json") · resultado $(j 'battle.result && JSON.stringify(j.battle.result)' <"$OUT/state-after.json")"
# Combate correcto: terminado, con replay, con ticks y con un resultado que nombra a un bando.
check battle_finished '[ "$(j battle.status <"$OUT/state-after.json")" = finished ] && [ -n "$(j battle.replay_hash <"$OUT/state-after.json")" ] && [ "$(j "battle.result.ticks > 0" <"$OUT/state-after.json")" = true ] && [ "$(j "battle.result.winner !== undefined && typeof j.battle.result.score === \"object\"" <"$OUT/state-after.json")" = true ]'
curl -s -X POST "$BASE/api/v1/replays/$TB/verify" >"$OUT/verify-anon.json"
log "verify (anónimo): $(cat "$OUT/verify-anon.json" | head -c 300)"
check replay_verifies 'grep -q "\"matches\":true" "$OUT/verify-anon.json" && grep -q "\"valid\":true" "$OUT/verify-anon.json"'
curl -s "$BASE/api/v1/battles/$TB" >"$OUT/battle-anon.json"
curl -s "$BASE/api/v1/replays/$TB" -o "$OUT/replay-anon.bin"
check public_views_clean '! grep -Eq "$FORBIDDEN_RE" "$OUT/battle-anon.json" "$OUT/replay-anon.bin" "$OUT/verify-anon.json" && grep -q "A-DEF" "$OUT/battle-anon.json" && grep -q "B-PUB" "$OUT/battle-anon.json"'

# Ningún código accesible y la ficha privada sigue sin existir, tras emitir (anónimo).
st() { curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1$1"; }
CODES="botA=$(st "/bots/$BOT_A") srcA=$(st "/bots/$BOT_A/versions/1/source") filesA=$(st "/bots/$BOT_A/versions/1/files") botB=$(st "/bots/$BOT_B") srcB=$(st "/bots/$BOT_B/versions/1/source") filesB=$(st "/bots/$BOT_B/versions/1/files")"
log "accesos anónimos tras emitir: $CODES"
check code_not_accessible '[[ "$CODES" =~ botA=404 ]] && [[ "$CODES" =~ srcA=(401|404) ]] && [[ "$CODES" =~ filesA=(401|404) ]] && [[ "$CODES" =~ botB=200 ]] && [[ "$CODES" =~ srcB=(401|403) ]] && [[ "$CODES" =~ filesB=(401|403) ]]'

docker exec "$TAG-streamer" sh -c 'f=$(ls -t /data/replays/video/broadcast-*.mp4 | head -1); ffprobe -v error -show_entries stream=codec_name,width,height:format=duration -of compact "$f"; ffmpeg -v error -y -ss 20 -i "$f" -frames:v 1 /tmp/frame.png' >"$OUT/ffprobe.txt" 2>&1
# Por exec y no por `docker cp`: con Docker rootless, cp falla al remontar los bind mounts (tls).
docker exec "$TAG-streamer" cat /tmp/frame.png >"$OUT/frame-stream.png" 2>"$OUT/frame-cp.log"
log "MP4: $(tr '\n' ' ' <"$OUT/ffprobe.txt")"
check recording 'grep -q "codec_name=h264" "$OUT/ffprobe.txt" && [ -s "$OUT/frame-stream.png" ]'

# ── nada cambió de visibilidad ───────────────────────────────────────────────
node -e '
  const fs=require("fs"); const [b,a,A,B]=process.argv.slice(1);
  const before=JSON.parse(fs.readFileSync(b)), after=JSON.parse(fs.readFileSync(a));
  const v=(s,id)=>s.bots.find(x=>x.id===id).visibility, c=(s,id)=>s.versions.find(x=>x.bot_id===id).code_public;
  const ok = v(before,A)==="private" && v(after,A)==="private" && v(before,B)==="public" && v(after,B)==="public"
    && c(before,A)===false && c(after,A)===false && c(before,B)===false && c(after,B)===false;
  console.log(JSON.stringify({A:{before:v(before,A),after:v(after,A),code:c(after,A)},B:{before:v(before,B),after:v(after,B),code:c(after,B)}}));
  process.exit(ok?0:1);' "$OUT/state-before.json" "$OUT/state-after.json" "$BOT_A" "$BOT_B" >"$OUT/visibility-diff.json"
RC[no_mutation]=$?; log "COMPROBACIÓN no_mutation rc=${RC[no_mutation]} $(cat "$OUT/visibility-diff.json")"

# ── resumen ──────────────────────────────────────────────────────────────────
fail=0
for k in "${!RC[@]}"; do [ "${RC[$k]}" = 0 ] || fail=$((fail + 1)); done
log "RESUMEN: ${#RC[@]} comprobaciones, $fail fallidas"
for k in $(printf '%s\n' "${!RC[@]}" | sort); do echo "$k=${RC[$k]}"; done | tee -a "$OUT/summary.txt"
[ "$fail" = 0 ]
