#!/usr/bin/env bash
# #251 · E2E LOCAL con la IMAGEN real del streamer (nunca producción): tras `docker restart`
# del MISMO contenedor el streamer sigue pudiendo grabar.
#
# Antes del arreglo, el lock (/tmp/.X<N>-lock) y el socket (/tmp/.X11-unix/X<N>) del Xvfb
# anterior sobrevivían al reinicio: Xvfb no arrancaba y FFmpeg daba «Cannot open display».
#
#  0. BASE_RECORD_WORKS · contenedor limpio: START record → ~12 s → STOP → MP4 válido;
#  1. RESTART_N_XVFB_ALIVE · `docker restart` (×2): hay un Xvfb vivo en el contenedor;
#  2. RESTART_N_RECORD_WORKS · y START record produce un MP4 NUEVO y válido (ffprobe:
#     h264 + aac), sin «Cannot open display» en los logs de ese arranque;
#  3. LIVE_XVFB_NOT_TOUCHED · con el Xvfb VIVO, el entrypoint no borra su lock (lanzado a
#     mano en el mismo contenedor: sale con error y el lock sigue).
#
#   S9_STREAM_E2E_STATE=<dir> STREAMER_IMAGE=<imagen> tests/streaming-e2e/issue-251-restart.sh
export S9_STREAM_E2E_TAG="${S9_STREAM_E2E_TAG:-s9rst}-251"
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
OUT="$STATE/out-251"
CTL_PORT="${S9_251_CTL_PORT:-48293}"
XDISP=95
mkdir -p "$OUT"
: >"$OUT/summary.txt"
declare -A RC
log() { echo "[$(date +%T)] $*" | tee -a "$OUT/summary.txt"; }
cleanup() {
  docker rm -f "$TAG-streamer" >/dev/null 2>&1
  docker volume rm "$TAG-secrets" "$TAG-replays" >/dev/null 2>&1
}
trap cleanup EXIT
cleanup
gen_secrets
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(eval("j."+process.argv[1]))})' "$1"; }

wait_api() { # $1 instante desde el que mirar los logs (los de antes del reinicio no valen)
  for _ in $(seq 1 90); do
    docker logs --since "$1" "$TAG-streamer" 2>&1 | grep -q "API de control escuchando" && return 0
    sleep 1
  done
  return 1
}
up() {
  docker volume create "$TAG-secrets" >/dev/null
  docker volume create "$TAG-replays" >/dev/null
  put_secret "$STATE/control_secret" streamer_control_secret
  local since
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  docker run -d --name "$TAG-streamer" --network host \
    --cpus 4 --memory 4g --security-opt no-new-privileges:true $STREAMER_HARDENING \
    -e BROADCAST_URL="http://127.0.0.1:1/broadcast" -e RTMPS_URL="rtmps://127.0.0.1:1/live2" \
    -e STREAMER_CONTROL_SECRET_FILE=/run/s9/streamer_control_secret \
    -e STREAM_MODE=record -e STREAM_ENCODER=x264 -e STREAM_AUTOSTART=0 \
    -e STREAMER_CONTROL_PORT="$CTL_PORT" -e RECORD_DIR=/data/replays/video \
    -e ARENA_DATA_DIRS=/data/replays -e LOG_FORMAT=json -e DISPLAY=":$XDISP" \
    -v "$TAG-replays:/data/replays" -v "$TAG-secrets:/run/s9:ro" "$IMG" >/dev/null
  wait_api "$since"
}
mp4_count() { docker exec "$TAG-streamer" sh -c 'ls /data/replays/video/broadcast-*.mp4 2>/dev/null | wc -l'; }
record_round() { # $1 etiqueta  $2 instante del arranque
  local r=$1 before after
  before=$(mp4_count)
  printf '{"sessionId":"rec-%s","mode":"record","preset":"720p","fps":30,"videoBitrateKbps":2500,"broadcastUrl":"http://127.0.0.1:1/broadcast"}' "$r" >"$STATE/rec-$r.json"
  ctl POST /control/start "$STATE/rec-$r.json" >"$OUT/$r-start.json"
  sleep 12
  ctl GET /status >"$OUT/$r-status.json"
  ctl POST /control/stop >"$OUT/$r-stop.json"
  sleep 3
  after=$(mp4_count)
  docker exec "$TAG-streamer" sh -c 'f=$(ls -t /data/replays/video/broadcast-*.mp4 | head -1); ffprobe -v error -show_entries stream=codec_name:format=duration -of compact "$f"' >"$OUT/$r-ffprobe.txt" 2>&1
  docker logs --since "$2" "$TAG-streamer" >"$OUT/$r-streamer.log" 2>&1
  [ "$after" -gt "$before" ] && grep -q "codec_name=h264" "$OUT/$r-ffprobe.txt" && grep -q "codec_name=aac" "$OUT/$r-ffprobe.txt" &&
    ! grep -q "Cannot open display" "$OUT/$r-streamer.log"
  RC[${r}_record_works]=$?
  log "$r · mp4 $before→$after · estado a los 12 s: $(jget state <"$OUT/$r-status.json") · ffprobe: $(tr '\n' ' ' <"$OUT/$r-ffprobe.txt") · «Cannot open display»: $(grep -c "Cannot open display" "$OUT/$r-streamer.log")"
}
xvfb_alive() { docker top "$TAG-streamer" -eo pid,args | grep -q "[X]vfb :$XDISP"; }

# 0 · contenedor limpio
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
up || { log "el streamer no arrancó"; exit 2; }
record_round base "$since"
docker exec "$TAG-streamer" ls -la "/tmp/.X$XDISP-lock" "/tmp/.X11-unix/X$XDISP" >"$OUT/lock-antes-del-reinicio.txt" 2>&1
log "lock y socket antes del reinicio: $(tr '\n' ' ' <"$OUT/lock-antes-del-reinicio.txt")"

# 1-2 · `docker restart` del MISMO contenedor, dos veces
for n in 1 2; do
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  docker restart "$TAG-streamer" >/dev/null
  if ! wait_api "$since"; then
    log "restart$n · la API de control no volvió"
    RC[restart${n}_api]=1
    continue
  fi
  docker logs --since "$since" "$TAG-streamer" 2>&1 | grep "entrypoint:" >"$OUT/restart$n-entrypoint.txt"
  xvfb_alive
  RC[restart${n}_xvfb_alive]=$?
  log "restart$n · Xvfb vivo: $([ "${RC[restart${n}_xvfb_alive]}" = 0 ] && echo sí || echo NO) · entrypoint: $(tr '\n' ' ' <"$OUT/restart$n-entrypoint.txt")"
  record_round "restart$n" "$since"
done

# 3 · con el Xvfb VIVO, el entrypoint no le quita el lock: sale con error y el lock sigue
docker exec -u streamer -e DISPLAY=":$XDISP" -e SERVICE_ENTRY=/nonexistent "$TAG-streamer" \
  /entrypoint.sh >"$OUT/live-lock.txt" 2>&1
live_rc=$?
docker exec "$TAG-streamer" test -e "/tmp/.X$XDISP-lock"
lock_kept=$?
xvfb_alive
still_alive=$?
[ "$live_rc" != 0 ] && [ "$lock_kept" = 0 ] && [ "$still_alive" = 0 ] && grep -q "ya lo usa un Xvfb vivo" "$OUT/live-lock.txt"
RC[live_xvfb_not_touched]=$?
log "Xvfb vivo · entrypoint rc=$live_rc · lock conservado: $([ "$lock_kept" = 0 ] && echo sí || echo NO) · $(tr '\n' ' ' <"$OUT/live-lock.txt")"

fail=0
for k in "${!RC[@]}"; do [ "${RC[$k]}" = 0 ] || fail=$((fail + 1)); done
log "RESUMEN: ${#RC[@]} comprobaciones, $fail fallidas"
for k in $(printf '%s\n' "${!RC[@]}" | sort); do echo "$k=${RC[$k]}"; done | tee -a "$OUT/summary.txt"
[ "$fail" = 0 ]
