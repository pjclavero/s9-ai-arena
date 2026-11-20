#!/usr/bin/env bash
# EQ5b · §23 · E2E LOCAL REAL de Administración → Streaming (nunca producción):
#
#   navegador (Playwright, imagen oficial fijada) → web (SPA construida) → API real
#   (PG embebido) → API interna de control del streamer → imagen REAL del streamer
#   (Xvfb + Chromium capturando /broadcast de una batalla REAL del motor + FFmpeg
#   + relé RTMP) → ingesta RTMPS local (MediaMTX, TLS verificado con CA local).
#
# Pasos (cada uno con su rc): configuración y clave desde la web · prueba sin
# emitir · inicio desde la web (1080p30, bitrate desde la web) · auditoría de la
# clave en vivo · reconexión (ingesta congelada y caída) · cambio de bitrate con
# «Reiniciar» · parada · grabación MP4 · retención desde la web (y lo que NO borra).
#
#   S9_STREAM_E2E_STATE=<dir> STREAMER_IMAGE=<imagen> tests/streaming-e2e/e2e.sh
# Lanzarlo bajo el cerrojo de carga del host. Al salir no deja nada vivo.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
PW_IMAGE="mcr.microsoft.com/playwright:v1.48.2-jammy@sha256:96dc479be9a603227fafc7126bd7d5e8152ae3e63749f377b2c49a4314b28ae1"
CACHE="${HOME}/.cache/s9-browser-e2e/$(sha256sum "$REPO/tests/browser/package-lock.json" | cut -c1-16)"
PORT="${S9_STREAM_E2E_PORT:-39480}"
BASE="http://127.0.0.1:$PORT"
OUT="$STATE/out"
BITRATE=3000
mkdir -p "$OUT"
LIVE_PID=""
cleanup() {
  [ -n "$LIVE_PID" ] && kill "$LIVE_PID" 2>/dev/null
  docker rm -f "$TAG-pw" >/dev/null 2>&1
  down_all
}
trap cleanup EXIT
log() { echo "[$(date +%T)] $*" | tee -a "$OUT/summary.txt"; }
declare -A RC

# ── preparación ──────────────────────────────────────────────────────────────
gen_secrets
tls_material
log "vite build…"
(cd "$REPO" && node_modules/.bin/vite build apps/web --outDir "$STATE/dist" --emptyOutDir) >"$OUT/vite.log" 2>&1 || { log "vite build falló"; exit 2; }

log "entorno vivo (API + gateway + SPA + batallas reales)…"
(cd "$REPO" && PORT="$PORT" WEB_DIST="$STATE/dist" BATTLE_SECONDS=900 \
  STREAMER_CONTROL_URL="http://127.0.0.1:$CTL_PORT" STREAMER_CONTROL_SECRET_FILE="$STATE/control_secret" \
  STREAM_SECRETS_PUBLIC_KEY_FILE="$STATE/public.pem" STREAMING_ALLOW_INTERNAL_INGEST=1 \
  exec node_modules/.bin/tsx tests/streaming-e2e/live-env.ts) >"$OUT/live-env.log" 2>&1 &
LIVE_PID=$!
for _ in $(seq 1 120); do grep -q "live-env listo" "$OUT/live-env.log" && break; sleep 1; done
grep -q "live-env listo" "$OUT/live-env.log" || { log "el entorno no arrancó"; tail -20 "$OUT/live-env.log"; exit 2; }
BATTLE=$(curl -s "$BASE/harness/ids" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).S))')
curl -s -X POST "$BASE/harness/start/S" >/dev/null
log "batalla en directo: $BATTLE"

export S9_STREAM_E2E_BROADCAST_BASE="$BASE/broadcast"
BROADCAST_BASE="$BASE/broadcast"
ingest_up
streamer_up rtmps || exit 2
log "streamer e ingesta arriba"

{
  echo "S9_E2E_BASE=$BASE"
  echo "S9_E2E_OUT=/out"
  echo "S9_E2E_DEV_PASSWORD=$(grep -oP 'DEV_PASSWORD = "\K[^"]+' "$REPO/apps/api/src/db/seeds/dev.ts")"
  echo "S9_STREAM_E2E_KEY_FILE=/secrets/stream_key"
  echo "S9_STREAM_E2E_BATTLE=$BATTLE"
  echo "S9_STREAM_E2E_INGEST=rtmps://127.0.0.1:$RTMPS_PORT/live2"
  echo "S9_STREAM_E2E_BITRATE=$BITRATE"
} >"$STATE/pw.env"
chmod 0600 "$STATE/pw.env"

pw() { # pw <paso> <grep>
  local step=$1 grep=$2
  mkdir -p "$OUT/$step" && chmod 777 "$OUT/$step"
  docker run --rm --network host --ipc host --init --name "$TAG-pw" \
    -v "$REPO/tests/browser:/src:ro" -v "$OUT:/out" -v "$CACHE:/cache" \
    -v "$STATE/stream_key:/secrets/stream_key:ro" --env-file "$STATE/pw.env" \
    -e PW_STEP="$step" -e PW_GREP="$grep" "$PW_IMAGE" bash -c '
      set -e
      mkdir -p /work && cp -r /src/. /work/ && cd /work
      if [ ! -d /cache/node_modules/@playwright/test ]; then
        npm ci --no-audit --no-fund >/out/$PW_STEP/npm-ci.log 2>&1 && cp -r node_modules /cache/
      else
        ln -s /cache/node_modules node_modules
      fi
      npx playwright test -c playwright.config.ts --grep "$PW_GREP" --output "/out/$PW_STEP/test-results"
    ' >"$OUT/$step/playwright.log" 2>&1
  RC[$step]=$?
  [ -f "$OUT/report.json" ] && mv "$OUT/report.json" "$OUT/$step/report.json"
  log "PASO $step rc=${RC[$step]} ($(grep -Eo '[0-9]+ (passed|failed|skipped|flaky)' "$OUT/$step/playwright.log" | tr '\n' ' '))"
}
check() { # check <nombre> <condición-bash>
  if eval "$2"; then RC[$1]=0; else RC[$1]=1; fi
  log "COMPROBACIÓN $1 rc=${RC[$1]}"
}
# `docker top` exige la columna pid; la línea de ffmpeg es la que captura el Xvfb.
ffargs() { docker top "$TAG-streamer" -eo pid,args | grep -- '-f x11grab' | head -1; }
status() { ctl GET /status; }
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(eval("j."+process.argv[1]))})' "$1"; }
ingest_bytes() { curl -s "http://127.0.0.1:$MTX_API_PORT/v3/paths/list" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const p=(j.items||[]).find(x=>x.ready);console.log(p?p.bytesReceived:0)})'; }
ingest_tracks() { curl -s "http://127.0.0.1:$MTX_API_PORT/v3/paths/list" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const p=(j.items||[]).find(x=>x.ready);console.log(p?p.tracks.join("+"):"ninguna")})'; }

# ── 1-2 · configuración, clave y prueba sin emitir ──────────────────────────
pw config "@streaming-e2e-config"
pw test "@streaming-e2e-test"

# ── 3 · inicio desde la web: 1080p30 y bitrate desde la web ──────────────────
pw start "@streaming-e2e-start"
sleep 12
b0=$(ingest_bytes); sleep 20; b1=$(ingest_bytes)
KBPS=$(( (b1 - b0) * 8 / 20 / 1000 ))
ARGS="$(ffargs)"
echo "$ARGS" >"$OUT/ffmpeg-argv-start.txt"
log "ingesta: pistas=$(ingest_tracks) caudal≈${KBPS} kbit/s · argv ffmpeg: $(echo "$ARGS" | grep -oE -- '-video_size [^ ]+|-framerate [^ ]+|-b:v [^ ]+|-f flv [^ ]+' | tr '\n' ' ')"
status >"$OUT/status-live.json"
check live_1080p30 '[[ "$ARGS" == *"-video_size 1920x1080"* && "$ARGS" == *"-framerate 30"* && "$ARGS" != *"scale="* ]]'
check live_bitrate_web '[[ "$ARGS" == *"-b:v ${BITRATE}k"* ]] && [ "$KBPS" -gt 200 ]'
check live_ingest '[ "$(ingest_tracks)" = "H264+MPEG-4 Audio" ]'
check live_fps '[ "$(jget stats.fps <"$OUT/status-live.json" | cut -d. -f1)" -ge 25 ]'
curl -s "http://127.0.0.1:$CTL_PORT/metrics" >"$OUT/metrics-live.txt"
curl -s "$BASE/api/v1/metrics" | grep -E '^s9_streaming' >"$OUT/api-metrics-live.txt"
check metrics_live 'grep -q "^streamer_up 1" "$OUT/metrics-live.txt" && grep -q "^streamer_desired 1" "$OUT/metrics-live.txt" && grep -q "^s9_streaming_session_active 1" "$OUT/api-metrics-live.txt" && grep -q "^s9_streaming_enabled 1" "$OUT/api-metrics-live.txt"'

# Auditoría de la clave CON la emisión en vivo (mismo recuento que secret-audit.sh).
c() { grep -cF -f "$STATE/stream_key" || true; }
leaks=0
for n in "$(docker logs "$TAG-streamer" 2>&1 | c)" "$(docker inspect "$TAG-streamer" | c)" "$(docker top "$TAG-streamer" -eo pid,args | c)" \
  "$(ps -eo args | c)" "$(status | c)" "$(c <"$OUT/metrics-live.txt")" "$(c <"$OUT/live-env.log")" \
  "$(curl -s "$BASE/api/v1/metrics" | c)"; do leaks=$((leaks + n)); done
for pid in $(docker exec "$TAG-streamer" sh -c 'ls /proc | grep -E "^[0-9]+$"'); do
  n=$(docker exec "$TAG-streamer" sh -c "cat /proc/$pid/cmdline /proc/$pid/environ 2>/dev/null" | tr '\0' '\n' | c)
  leaks=$((leaks + n))
done
log "clave en superficies con emisión en vivo: $leaks"
check key_live '[ "$leaks" = 0 ]'

# ── 3b · STREAMING-UX · vista en directo: DETENER dentro de la ventana (1366 y 390) ──
pw liveux "@streaming-e2e-liveux"
check stop_visible_shots '[ -s "$OUT/liveux/live-1366.png" ] && [ -s "$OUT/liveux/live-390.png" ]'

# ── 4 · reconexión: ingesta congelada 30 s y caída 20 s ─────────────────────
r0=$(status | jget restarts)
ingest_pause; sleep 30; ingest_unpause
ok=1; for _ in $(seq 1 60); do st=$(status); [ "$(echo "$st" | jget relay.state)" = publishing ] && [ "$(ingest_bytes)" -gt 0 ] && { ok=0; break; }; sleep 2; done
log "tras congelar 30 s: estado=$(status | jget state) relé=$(status | jget relay.state) reintentos=$(( $(status | jget restarts) - r0 ))"
RC[reconnect_pause]=$ok; log "COMPROBACIÓN reconnect_pause rc=$ok"
r1=$(status | jget restarts)
docker stop "$TAG-mediamtx" >/dev/null; sleep 20; docker start "$TAG-mediamtx" >/dev/null
ok=1; for _ in $(seq 1 60); do [ "$(status | jget relay.state)" = publishing ] && [ "$(ingest_bytes)" -gt 0 ] && { ok=0; break; }; sleep 2; done
log "tras caer 20 s: estado=$(status | jget state) relé=$(status | jget relay.state) reintentos=$(( $(status | jget restarts) - r1 )) último error=$(status | jget 'lastError?.message')"
RC[reconnect_down]=$ok; log "COMPROBACIÓN reconnect_down rc=$ok"

# ── 5 · cambio de bitrate con emisión activa ⇒ aviso + «Reiniciar» ──────────
pw restart "@streaming-e2e-restart"
sleep 5
ARGS2="$(ffargs)"; echo "$ARGS2" >"$OUT/ffmpeg-argv-restart.txt"
check restart_bitrate '[[ "$ARGS2" == *"-b:v $((BITRATE - 500))k"* ]]'

# ── 6 · parada desde la web ─────────────────────────────────────────────────
pw stop "@streaming-e2e-stop"
sleep 3
check stopped '[ "$(status | jget state)" = stopped ] && [ -z "$(ffargs)" ] && [ "$(ingest_bytes)" = 0 ]'
curl -s "http://127.0.0.1:$CTL_PORT/metrics" >"$OUT/metrics-stopped.txt"
check metrics_stopped 'grep -q "^streamer_desired 0" "$OUT/metrics-stopped.txt"'

# ── 7 · grabación MP4 desde la web ──────────────────────────────────────────
pw record "@streaming-e2e-record"
docker exec "$TAG-streamer" sh -c 'f=$(ls -t /data/replays/video/broadcast-*.mp4 | head -1); ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate:format=duration -of compact "$f"' >"$OUT/ffprobe-mp4.txt" 2>&1
log "MP4: $(tr '\n' ' ' <"$OUT/ffprobe-mp4.txt")"
check record_mp4 'grep -q "codec_name=h264|width=1920|height=1080|r_frame_rate=30/1" "$OUT/ffprobe-mp4.txt" && grep -q "codec_name=aac" "$OUT/ffprobe-mp4.txt"'

# ── 8 · retención desde la web: borra SÓLO MP4 viejos ───────────────────────
# STREAMER · como uid 1000 (el dueño del volumen): con `cap_drop: ALL` el root del
# contenedor ya no tiene CAP_DAC_OVERRIDE y no puede escribir en un directorio ajeno.
docker exec -u 1000:1000 "$TAG-streamer" sh -c '
  cd /data/replays/video
  for n in broadcast-2026-09-01T00-00-00-000Z.mp4 broadcast-2026-09-02T00-00-00-000Z.mp4; do head -c 2048 /dev/urandom > $n; touch -d "2026-09-03 00:00:00" $n; done
  echo nota > notas.txt; touch -d "2026-09-03 00:00:00" notas.txt
  head -c 1024 /dev/urandom > /data/replays/viejo.replay; touch -d "2026-09-03 00:00:00" /data/replays/viejo.replay
  ln -sf /data/replays/viejo.replay broadcast-2026-09-04T00-00-00-000Z.mp4
  ls -la /data/replays/video /data/replays' >"$OUT/retention-before.txt" 2>&1
pw retention "@streaming-e2e-retention"
docker exec "$TAG-streamer" sh -c 'ls -la /data/replays/video /data/replays' >"$OUT/retention-after.txt" 2>&1
check retention 'ex() { docker exec "$TAG-streamer" test -e "$1"; }; ! ex /data/replays/video/broadcast-2026-09-01T00-00-00-000Z.mp4 && ! ex /data/replays/video/broadcast-2026-09-02T00-00-00-000Z.mp4 && ex /data/replays/video/notas.txt && ex /data/replays/viejo.replay && docker exec "$TAG-streamer" test -L /data/replays/video/broadcast-2026-09-04T00-00-00-000Z.mp4 && [ "$(docker exec "$TAG-streamer" sh -c "ls /data/replays/video/broadcast-2026-11-*.mp4 /data/replays/video/broadcast-2026-1[0-2]-*.mp4 2>/dev/null | wc -l")" -ge 1 ]'

# ── resumen ──────────────────────────────────────────────────────────────────
fail=0
for k in "${!RC[@]}"; do [ "${RC[$k]}" = 0 ] || fail=$((fail + 1)); done
log "RESUMEN: ${#RC[@]} pasos/comprobaciones, $fail fallidos"
for k in $(printf '%s\n' "${!RC[@]}" | sort); do echo "$k=${RC[$k]}"; done | tee -a "$OUT/summary.txt"
[ "$fail" = 0 ]
