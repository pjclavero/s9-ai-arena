#!/usr/bin/env bash
# #249 · E2E LOCAL con la IMAGEN real del streamer (nunca producción; nada se crea a
# mano en ningún host): «Sólo grabar» en un contenedor que arrancó con STREAM_MODE=rtmps.
#
#  1. CLEAN_START_RECORD_DIR_CREATED · contenedor limpio con el volumen VACÍO: GET
#     /recordings crea /data/replays/video (propiedad del usuario del servicio, uid 1000);
#  2. RECORD_DISK_MEASUREMENT_WORKS · el disco se mide (freeBytes > 0);
#  3. RECORD_START_WORKS · START record → ~12 s → STOP → MP4 VÁLIDO (ffprobe: h264 + aac);
#  4. RECREATE_CONTAINER_STILL_WORKS · se borra el contenedor y el volumen, se recrean
#     vacíos y se repite 1-3;
#  5. BAD_VOLUME_FAILS_CLOSED · volumen con `video` como FICHERO: /recordings sin
#     medida (con motivo) y START record ⇒ 409 record_dir_unavailable, sin ffmpeg.
#
#   S9_STREAM_E2E_STATE=<dir> STREAMER_IMAGE=<imagen> tests/streaming-e2e/issue-249.sh
export S9_STREAM_E2E_TAG="${S9_STREAM_E2E_TAG:-s9rec}-249"
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
OUT="$STATE/out-249"
CTL_PORT="${S9_249_CTL_PORT:-48292}"
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

# `volume-nocopy`: el volumen NO se siembra con el /data/replays de la imagen. Así nace
# como en producción, donde `arena_replays` lo creó antes otro servicio y llega vacío,
# sin `video/`.
up() { # contenedor limpio en modo rtmps sobre el volumen actual
  docker volume create "$TAG-secrets" >/dev/null
  docker volume create "$TAG-replays" >/dev/null
  put_secret "$STATE/control_secret" streamer_control_secret
  docker rm -f "$TAG-streamer" >/dev/null 2>&1
  docker run -d --name "$TAG-streamer" --network host \
    --cpus 4 --memory 4g --security-opt no-new-privileges:true $STREAMER_HARDENING \
    -e BROADCAST_URL="http://127.0.0.1:1/broadcast" -e RTMPS_URL="rtmps://127.0.0.1:1/live2" \
    -e STREAMER_CONTROL_SECRET_FILE=/run/s9/streamer_control_secret \
    -e STREAM_MODE=rtmps -e STREAM_ENCODER=x264 -e STREAM_AUTOSTART=0 \
    -e STREAMER_CONTROL_PORT="$CTL_PORT" -e RECORD_DIR=/data/replays/video \
    -e ARENA_DATA_DIRS=/data/replays -e LOG_FORMAT=json -e DISPLAY=:94 \
    --mount "type=volume,src=$TAG-replays,dst=/data/replays,volume-nocopy" -v "$TAG-secrets:/run/s9:ro" "$IMG" >/dev/null
  for _ in $(seq 1 90); do docker logs "$TAG-streamer" 2>&1 | grep -q "API de control escuchando" && return 0; sleep 1; done
  return 1
}
round() { # $1 etiqueta
  local r=$1
  # $OUT/$r-before.txt lo escribió vol_empty ANTES de arrancar: el directorio lo crea el producto.
  ctl GET /recordings >"$OUT/$r-recordings.json"
  docker exec "$TAG-streamer" stat -c '%U:%G %a %F' /data/replays/video >"$OUT/$r-dir.txt" 2>&1
  [ "$(cat "$OUT/$r-before.txt")" = VACIO ] && grep -q '^streamer:streamer .* directory$' "$OUT/$r-dir.txt"
  RC[${r}_dir_created]=$?
  [ "$(jget 'disk?.freeBytes > 0' <"$OUT/$r-recordings.json")" = true ]
  RC[${r}_disk_measured]=$?
  printf '{"sessionId":"rec-%s","mode":"record","preset":"720p","fps":30,"videoBitrateKbps":2500,"broadcastUrl":"http://127.0.0.1:1/broadcast"}' "$r" >"$STATE/rec-$r.json"
  ctl POST /control/start "$STATE/rec-$r.json" >"$OUT/$r-start.json"
  sleep 12
  ctl POST /control/stop >"$OUT/$r-stop.json"
  sleep 3
  docker exec "$TAG-streamer" sh -c 'f=$(ls -t /data/replays/video/broadcast-*.mp4 | head -1); ffprobe -v error -show_entries stream=codec_name:format=duration -of compact "$f"' >"$OUT/$r-ffprobe.txt" 2>&1
  grep -q "codec_name=h264" "$OUT/$r-ffprobe.txt" && grep -q "codec_name=aac" "$OUT/$r-ffprobe.txt"
  RC[${r}_mp4_valid]=$?
  log "$r · antes: $(cat "$OUT/$r-before.txt") · dir: $(cat "$OUT/$r-dir.txt") · libre: $(jget 'disk?.freeBytes' <"$OUT/$r-recordings.json") · start: $(jget state <"$OUT/$r-start.json") · ffprobe: $(tr '\n' ' ' <"$OUT/$r-ffprobe.txt")"
}

vol_empty() { # $1 etiqueta · ¿el volumen está VACÍO antes de arrancar? (sin sembrarlo con la imagen)
  docker volume create "$TAG-replays" >/dev/null
  local n
  n=$(docker run --rm --mount "type=volume,src=$TAG-replays,dst=/v,volume-nocopy" --entrypoint sh "$IMG" -c 'ls -A /v | wc -l')
  [ "$n" = 0 ] && echo VACIO >"$OUT/$1-before.txt" || echo "NO_VACIO($n)" >"$OUT/$1-before.txt"
}

# 1-3 · contenedor limpio, volumen vacío
vol_empty limpio
up || { log "el streamer no arrancó"; exit 2; }
round limpio
# 4 · recrear contenedor Y volumen, y repetir
docker rm -f "$TAG-streamer" >/dev/null
docker volume rm "$TAG-replays" >/dev/null
vol_empty recreado
up || { log "el streamer no arrancó (recreado)"; exit 2; }
round recreado
# 5 · volumen malo: `video` es un FICHERO
docker rm -f "$TAG-streamer" >/dev/null
docker volume rm "$TAG-replays" >/dev/null
docker volume create "$TAG-replays" >/dev/null
docker run --rm -v "$TAG-replays:/v" --entrypoint sh "$IMG" -c 'echo no-soy-un-directorio > /v/video'
up || { log "el streamer no arrancó (volumen malo)"; exit 2; }
ctl GET /recordings >"$OUT/malo-recordings.json"
printf '{"sessionId":"rec-malo","mode":"record","broadcastUrl":"http://127.0.0.1:1/broadcast"}' >"$STATE/rec-malo.json"
code=$(curl -s -o "$OUT/malo-start.json" -w '%{http_code}' -m 30 -H @"$STATE/auth_header" -H 'content-type: application/json' \
  --data-binary @"$STATE/rec-malo.json" "http://127.0.0.1:$CTL_PORT/control/start")
[ "$(jget 'disk' <"$OUT/malo-recordings.json")" = null ] && [ "$code" = 409 ] && grep -q record_dir_unavailable "$OUT/malo-start.json" &&
  ! docker top "$TAG-streamer" -eo pid,args | grep -q -- "-f x11grab"
RC[bad_volume_fails_closed]=$?
log "malo · /recordings disk=$(jget disk <"$OUT/malo-recordings.json") dirError=$(jget dirError <"$OUT/malo-recordings.json") · START record ⇒ HTTP $code $(cat "$OUT/malo-start.json")"

fail=0
for k in "${!RC[@]}"; do [ "${RC[$k]}" = 0 ] || fail=$((fail + 1)); done
log "RESUMEN: ${#RC[@]} comprobaciones, $fail fallidas"
for k in $(printf '%s\n' "${!RC[@]}" | sort); do echo "$k=${RC[$k]}"; done | tee -a "$OUT/summary.txt"
[ "$fail" = 0 ]
