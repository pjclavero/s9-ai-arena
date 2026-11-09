#!/usr/bin/env bash
# #256 · Diagnóstico y regresión de la EMISIÓN EN BLANCO con la IMAGEN real del streamer
# (nunca producción; ingesta RTMPS LOCAL con MediaMTX; clave = centinela de prueba).
#
# Matriz 2×2 {record, rtmps-local} × {batalla EN CURSO, batalla TERMINADA}. En cada
# sesión, la MISMA sesión, se observa cada etapa de la cadena por separado:
#   A. DOM de /broadcast           (sonda CDP del Chromium real del streamer)
#   B. canvas de Phaser / WebGL    (sonda CDP: tamaño, contexto, vendor/renderer, escena)
#      + captura del COMPOSITOR de Chromium (Page.captureScreenshot)
#   C. framebuffer del Xvfb        (x11grab de 1 frame, independiente de la emisión)
#   D. frames de FFmpeg            (MP4 en record; FLV antes del relé en rtmps)
#   E. FLV antes del relé          (copia byte a byte de lo que ffmpeg entrega por el fd 3)
#   F. salida RTMPS                (lo que RECIBE MediaMTX)
# Cada PNG/vídeo pasa por el detector automático (frame-detect.ts): media y desviación de
# luma ⇒ VISIBLE / WHITE_FAIL / UNIFORM_FAIL. Nada se compara a ojo.
#
#   S9_STREAM_E2E_STATE=<dir> STREAMER_IMAGE=<imagen> tests/streaming-e2e/issue-256.sh
#   [S9_256_CASES="record:live rtmps:live record:finished rtmps:finished"] [S9_256_SECONDS=30]
#
# Los envoltorios de diag256/ SÓLO añaden el puerto CDP a Chromium y una copia del FLV a
# ffmpeg; el argv que construye el streamer no cambia (se registra y se compara: A3).
# Lanzarlo bajo el cerrojo de carga del host. Al salir no deja nada vivo.
export S9_STREAM_E2E_TAG="${S9_STREAM_E2E_TAG:-s9fix256}"
export S9_STREAM_E2E_CTL_PORT="${S9_STREAM_E2E_CTL_PORT:-48256}"
export S9_STREAM_E2E_RTMPS_PORT="${S9_STREAM_E2E_RTMPS_PORT:-41256}"
export S9_STREAM_E2E_MTX_API_PORT="${S9_STREAM_E2E_MTX_API_PORT:-49256}"
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
PORT="${S9_256_PORT:-39256}"
CDP_PORT="${S9_256_CDP_PORT:-49257}"
BASE="http://127.0.0.1:$PORT"
OUT="${S9_256_OUT:-$STATE/out-256}"
SECONDS_PER_CASE="${S9_256_SECONDS:-30}"
CASES="${S9_256_CASES:-record:finished record:live rtmps:live rtmps:finished}"
DIAG="$REPO/tests/streaming-e2e/diag256"
TSX="$REPO/node_modules/.bin/tsx"
mkdir -p "$OUT"
: >"$OUT/summary.txt"
LIVE_PID=""
RECV_PID=""
cleanup() {
  [ -n "$RECV_PID" ] && kill "$RECV_PID" 2>/dev/null
  [ -n "$LIVE_PID" ] && kill "$LIVE_PID" 2>/dev/null
  down_all
}
trap cleanup EXIT
log() { echo "[$(date +%T)] $*" | tee -a "$OUT/summary.txt"; }
declare -A RC
detect() { # detect <etiqueta> <fichero> [fps] → línea resumen al summary, rc del detector
  "$TSX" "$REPO/tests/streaming-e2e/frame-detect.ts" "$1" "$2" "${3:-1}" >"$OUT/$1.detect.txt" 2>&1
  local rc=$?
  log "DETECT $(tail -1 "$OUT/$1.detect.txt") rc=$rc"
  return $rc
}

gen_secrets
tls_material
if [ -z "${S9_256_DIST:-}" ]; then
  log "vite build…"
  (cd "$REPO" && node_modules/.bin/vite build apps/web --outDir "$STATE/dist" --emptyOutDir) >"$OUT/vite.log" 2>&1 || { log "vite build falló"; exit 2; }
  S9_256_DIST="$STATE/dist"
fi
log "repo HEAD=$(cd "$REPO" && git rev-parse HEAD) imagen=$IMG ($(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMG" 2>/dev/null))"

(cd "$REPO" && PORT="$PORT" WEB_DIST="$S9_256_DIST" BATTLE_SECONDS=1800 \
  STREAMER_CONTROL_URL="http://127.0.0.1:$CTL_PORT" STREAMER_CONTROL_SECRET_FILE="$STATE/control_secret" \
  STREAM_SECRETS_PUBLIC_KEY_FILE="$STATE/public.pem" STREAMING_ALLOW_INTERNAL_INGEST=1 \
  exec node_modules/.bin/tsx tests/streaming-e2e/live-env.ts) >"$OUT/live-env.log" 2>&1 &
LIVE_PID=$!
for _ in $(seq 1 120); do grep -q "live-env listo" "$OUT/live-env.log" && break; sleep 1; done
grep -q "live-env listo" "$OUT/live-env.log" || { log "el entorno no arrancó"; tail -20 "$OUT/live-env.log"; exit 2; }
IDS=$(curl -s "$BASE/harness/ids")
idof() { echo "$IDS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]))' "$1"; }
LIVE_ID=$(idof S)
FIN_ID=$(idof B1)
curl -s -X POST "$BASE/harness/start/S" >/dev/null
curl -s -X POST "$BASE/harness/start/B1?seconds=5" >/dev/null
# La batalla «terminada» lo está DE VERDAD (estado de la API pública), no por tiempo.
for _ in $(seq 1 60); do curl -s "$BASE/api/v1/battles/$FIN_ID" | grep -q '"status":"finished"' && break; sleep 1; done
log "batalla EN CURSO=$LIVE_ID ($(curl -s "$BASE/api/v1/battles/$LIVE_ID" | grep -o '"status":"[a-z]*"')) · TERMINADA=$FIN_ID ($(curl -s "$BASE/api/v1/battles/$FIN_ID" | grep -o '"status":"[a-z]*"'))"

ingest_up
# S9_256_CDP=0 ⇒ Chromium SIN puerto de depuración y sin sonda CDP (sólo Xvfb y vídeo):
# así se descarta que la propia sonda provoque lo que se observa.
CDP_ON=${S9_256_CDP:-1}
[ "$CDP_ON" = 1 ] && CDP_ENV="-e DIAG_CDP_PORT=$CDP_PORT" || CDP_ENV=""
STREAMER_EXTRA_ARGS="-v $DIAG:/diag:ro -e CHROMIUM_BIN=/diag/chromium-diag.sh -e FFMPEG_BIN=/diag/ffmpeg-diag.sh $CDP_ENV ${S9_256_EXTRA_ARGS:-}"
export STREAMER_EXTRA_ARGS
BROADCAST_BASE="$BASE/broadcast"
streamer_up rtmps || exit 2
log "streamer e ingesta arriba"
docker exec "$TAG-streamer" sh -c 'cat /usr/bin/chromium-browser; echo "--- /etc/chromium"; cat /etc/chromium/*.conf 2>/dev/null; echo "--- versiones"; chromium-browser --version 2>/dev/null; ffmpeg -version | head -1; Xvfb -version 2>&1 | head -2' >"$OUT/image-chromium-launcher.txt" 2>&1
docker exec "$TAG-streamer" sh -c 'tr "\0" "\n" </proc/$(pgrep -o Xvfb)/cmdline' >"$OUT/xvfb-cmdline.txt" 2>&1

jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(eval("j."+process.argv[1]))})' "$1"; }
cdp_up() { curl -s -m 2 "http://127.0.0.1:$CDP_PORT/json/version" | grep -q Browser; }
xgrab() { # xgrab <etiqueta> → PNG del framebuffer del Xvfb (fuera de la emisión)
  docker exec -u 1000:1000 "$TAG-streamer" sh -c "/usr/bin/ffmpeg -nostdin -loglevel error -y -f x11grab -draw_mouse 0 -video_size 1920x1080 -i \$DISPLAY -frames:v 1 /tmp/diag/$1-xvfb.png" &&
    docker cp "$TAG-streamer:/tmp/diag/$1-xvfb.png" "$OUT/$1-xvfb.png" >/dev/null
}
recv_start() { # F · lo que RECIBE la ingesta. La URL (lleva la clave) va en un fichero 0600, no en argv.
  local ff="$STATE/recv-$1.ffconcat"
  (umask 077 && printf "ffconcat version 1.0\nfile 'rtmps://127.0.0.1:%s/live2/%s'\n" "$RTMPS_PORT" "$(cat "$STATE/stream_key")" >"$ff")
  ffmpeg -nostdin -loglevel error -y -safe 0 -protocol_whitelist file,rtmp,rtmps,tcp,tls -f concat -i "$ff" \
    -t 10 -c copy "$OUT/$1-rtmps-recv.flv" >"$OUT/$1-recv.log" 2>&1 &
  RECV_PID=$!
}

run_case() { # run_case <record|rtmps> <live|finished>
  local mode=$1 which=$2 label="$1-$2" id url
  [ "$which" = live ] && id=$LIVE_ID || id=$FIN_ID
  url="$BASE/broadcast?battle=$id"
  # Como uid 1000: con cap_drop ALL el root del contenedor no puede borrar en /tmp/diag (de streamer).
  docker exec -u 1000:1000 "$TAG-streamer" sh -c 'rm -f /tmp/diag/*.flv /tmp/diag/*-argv-*.txt /tmp/diag/chromium-stderr-*.log /data/replays/video/*.mp4' 2>/dev/null
  if [ "$mode" = rtmps ]; then
    start_body "$STATE/start-$label.json" "$url" 4500 1080p 30 "s256-$label"
  else
    printf '{"sessionId":"s256-%s","mode":"record","encoder":"x264","preset":"1080p","fps":30,"videoBitrateKbps":4500,"broadcastUrl":"%s"}' "$label" "$url" >"$STATE/start-$label.json"
  fi
  log "── CASO $label · /broadcast?battle=<$which> · $mode 1080p30 4500k"
  ctl POST /control/start "$STATE/start-$label.json" >"$OUT/$label-start.json"
  local t0=$SECONDS
  if [ "$CDP_ON" = 1 ]; then
    for _ in $(seq 1 60); do cdp_up && break; sleep 0.5; done
    cdp_up || log "CDP no responde en $label"
  fi
  [ "$mode" = rtmps ] && for _ in $(seq 1 60); do [ "$(ctl GET /status | jget 'relay?.state')" = publishing ] && break; sleep 0.5; done
  local recv_at=$((SECONDS_PER_CASE / 3)) next
  for at in 3 $((SECONDS_PER_CASE / 2)) $((SECONDS_PER_CASE - 3)); do
    while [ $((SECONDS - t0)) -lt "$at" ]; do
      if [ "$mode" = rtmps ] && [ -z "$RECV_PID" ] && [ $((SECONDS - t0)) -ge "$recv_at" ]; then recv_start "$label"; fi
      sleep 0.5
    done
    next="$label-t$at"
    if [ "$CDP_ON" = 1 ]; then
      timeout 60 "$TSX" "$REPO/tests/streaming-e2e/cdp-probe.ts" "$CDP_PORT" "$OUT" "$next" >"$OUT/$next.cdp.txt" 2>&1
      log "CDP $(tr '\n' ' ' <"$OUT/$next.cdp.txt")"
      [ -s "$OUT/$next-chromium.png" ] && detect "$next-chromium" "$OUT/$next-chromium.png"
    fi
    bash "$DIAG/procsnap.sh" "$TAG-streamer" "$OUT/$next-procs.txt"
    xgrab "$next" && detect "$next-xvfb" "$OUT/$next-xvfb.png"
    # S9_256_GDB=1 (contenedor con --cap-add SYS_PTRACE): si el Xvfb no es visible, pila
    # nativa de los renderers y del proceso GPU (dónde gira el hilo) — sólo diagnóstico.
    if [ "${S9_256_GDB:-0}" = 1 ] && ! grep -q "all_visible=1" "$OUT/$next-xvfb.detect.txt" 2>/dev/null; then
      bash "$DIAG/gdbtrace.sh" "$TAG-streamer" "$OUT/$next-gdb.txt"
      log "GDB $next: $(grep -c '^#' "$OUT/$next-gdb.txt") marcos en $next-gdb.txt"
    fi
  done
  ctl GET /status >"$OUT/$label-status.json"
  log "estado: $(jget state <"$OUT/$label-status.json") relé=$(jget 'relay?.state' <"$OUT/$label-status.json") fps=$(jget 'stats?.fps' <"$OUT/$label-status.json")"
  if [ -n "$RECV_PID" ]; then wait "$RECV_PID"; RECV_PID=""; fi
  ctl POST /control/stop >/dev/null
  # STOP espera la salida del ffmpeg (MP4 cerrado) — se comprueba, no se supone.
  for _ in $(seq 1 30); do docker top "$TAG-streamer" -eo args | grep -q -- '-f x11grab' || break; sleep 0.5; done
  docker exec "$TAG-streamer" sh -c 'cat /tmp/diag/ffmpeg-argv-*.txt' >"$OUT/$label-ffmpeg-argv.txt" 2>/dev/null
  docker exec "$TAG-streamer" sh -c 'cat /tmp/diag/chromium-argv-*.txt' >"$OUT/$label-chromium-argv.txt" 2>/dev/null
  docker exec "$TAG-streamer" sh -c 'cat /tmp/diag/chromium-stderr-*.log' >"$OUT/$label-chromium-stderr.log" 2>/dev/null
  if [ "$mode" = record ]; then
    local f
    f=$(docker exec "$TAG-streamer" sh -c 'ls -t /data/replays/video/broadcast-*.mp4 | head -1')
    docker cp "$TAG-streamer:$f" "$OUT/$label-ffmpeg.mp4" >/dev/null
    ffprobe -v error -show_entries stream=codec_name,width,height,pix_fmt,r_frame_rate,color_range,color_space -of compact "$OUT/$label-ffmpeg.mp4" >"$OUT/$label-ffprobe.txt" 2>&1
    detect "$label-ffmpeg" "$OUT/$label-ffmpeg.mp4" 1
    RC[$label]=$?
  else
    local f
    f=$(docker exec "$TAG-streamer" sh -c 'ls -t /tmp/diag/pre-relay-*.flv | head -1')
    docker cp "$TAG-streamer:$f" "$OUT/$label-prerelay.flv" >/dev/null
    ffprobe -v error -show_entries stream=codec_name,width,height,pix_fmt,r_frame_rate,color_range,color_space -of compact "$OUT/$label-prerelay.flv" >"$OUT/$label-ffprobe.txt" 2>&1
    detect "$label-prerelay-flv" "$OUT/$label-prerelay.flv" 1
    local r1=$?
    ffprobe -v error -show_entries stream=codec_name,width,height,pix_fmt -of compact "$OUT/$label-rtmps-recv.flv" >"$OUT/$label-recv-ffprobe.txt" 2>&1
    detect "$label-rtmps-recv" "$OUT/$label-rtmps-recv.flv" 1
    local r2=$?
    RC[$label]=$((r1 | r2))
  fi
  # Un fotograma representativo de cada vídeo, para el informe.
  ffmpeg -nostdin -loglevel error -y -sseof -2 -i "$OUT/$label-$([ "$mode" = record ] && echo ffmpeg.mp4 || echo prerelay.flv)" -frames:v 1 "$OUT/$label-video-last.png" 2>/dev/null
  [ -s "$OUT/$label-rtmps-recv.flv" ] && ffmpeg -nostdin -loglevel error -y -sseof -2 -i "$OUT/$label-rtmps-recv.flv" -frames:v 1 "$OUT/$label-rtmps-recv-last.png" 2>/dev/null
  log "CASO $label rc=${RC[$label]}"
}

for c in $CASES; do run_case "${c%%:*}" "${c##*:}"; done

# A3 · argv de Chromium y de FFmpeg entre record y rtmps (misma batalla).
for w in live finished; do
  if [ -s "$OUT/record-$w-ffmpeg-argv.txt" ] && [ -s "$OUT/rtmps-$w-ffmpeg-argv.txt" ]; then
    diff "$OUT/record-$w-ffmpeg-argv.txt" "$OUT/rtmps-$w-ffmpeg-argv.txt" >"$OUT/a3-ffmpeg-$w.diff"
    diff "$OUT/record-$w-chromium-argv.txt" "$OUT/rtmps-$w-chromium-argv.txt" >"$OUT/a3-chromium-$w.diff"
    log "A3 $w · diff ffmpeg: $(grep -c '^[<>]' "$OUT/a3-ffmpeg-$w.diff") líneas · diff chromium: $(grep -c '^[<>]' "$OUT/a3-chromium-$w.diff") líneas"
  fi
done
docker logs "$TAG-streamer" >"$OUT/streamer.log" 2>&1
leaks=$(cat "$OUT"/*.txt "$OUT"/*.json "$OUT/streamer.log" "$OUT/live-env.log" 2>/dev/null | grep -cF -f "$STATE/stream_key" || true)
log "clave de prueba en evidencias/logs: $leaks"
RC[key_not_in_evidence]=$([ "$leaks" = 0 ] && echo 0 || echo 1)

fail=0
for k in "${!RC[@]}"; do [ "${RC[$k]}" = 0 ] || fail=$((fail + 1)); done
log "RESUMEN: ${#RC[@]} comprobaciones, $fail fallidas"
for k in $(printf '%s\n' "${!RC[@]}" | sort); do echo "$k=${RC[$k]}"; done | tee -a "$OUT/summary.txt"
[ "$fail" = 0 ]
