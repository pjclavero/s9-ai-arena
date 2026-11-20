#!/usr/bin/env bash
# #256 · LABORATORIO de RELANZAMIENTO: el MISMO Chromium con el MISMO argv que construye
# buildChromiumArgs, lanzado N veces SEGUIDAS en el MISMO contenedor (mismo HOME y perfil,
# como hace el supervisor entre sesiones y reintentos), parando cada vez con SIGTERM.
#
#   lab-relaunch.sh <imagen> <url> <dir-salida> <etiqueta> <N> <modo>
#     modo=wait     espera a que el Chromium anterior haya salido del todo antes de relanzar
#     modo=nowait   relanza en cuanto manda el SIGTERM (lo que hace supervisor.start())
#     modo=fresh    como wait, pero borrando el perfil (~/.config/chromium) entre lanzamientos
# LAB_FFMPEG=1 arranca además un x11grab a 30 fps a la vez que Chromium (como la emisión).
# LAB_EXTRA="--flag …" añade flags a Chromium (sólo para experimentos A/B declarados).
# Para cada lanzamiento captura el Xvfb a los LAB_AT s (6 por defecto) y lo pasa por el
# detector. Sólo diagnóstico local.
set -uo pipefail
IMG=$1 URL=$2 OUT=$3 LABEL=$4 N=$5 MODE=$6
AT=${LAB_AT:-6}
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TSX="$REPO/node_modules/.bin/tsx"
NAME="s9fix256-lab"
mkdir -p "$OUT"
ARGV=$(cd "$REPO" && "$TSX" -e '
  import("./apps/streamer/src/ffmpeg.ts").then(({ buildChromiumArgs }) => {
    process.stdout.write(buildChromiumArgs({ width: 1920, height: 1080 } as any, process.argv[1]).join("\n"));
  });' "$URL")
[ -n "${LAB_EXTRA:-}" ] && ARGV="$(printf '%s\n' ${LAB_EXTRA})
$ARGV"
docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" --network host --init --shm-size 256m --cpus 4 --memory 4g \
  --security-opt no-new-privileges:true -u 1000:1000 -e HOME=/home/streamer --entrypoint sleep "$IMG" 3600 >/dev/null
docker exec -d "$NAME" sh -c 'Xvfb :97 -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb.log 2>&1'
for _ in $(seq 1 50); do docker exec "$NAME" test -S /tmp/.X11-unix/X97 && break; sleep 0.1; done
printf '%s\n' "$ARGV" | docker exec -i "$NAME" sh -c 'cat >/tmp/argv'
printf '%s\n' "$ARGV" >"$OUT/$LABEL-chromium-argv.txt"
# Lanzador desacoplado. El PID del navegador se busca por su argv ANCLADO al principio
# (`^/usr/lib/chromium/chromium --ozone`): ni los hijos (`--type=…` van después) ni el
# shell del propio pgrep casan.
printf '%s\n' '#!/bin/sh' 'export DISPLAY=:97' \
  'tr "\n" "\0" </tmp/argv | xargs -0 sh -c '"'"'exec /usr/bin/chromium-browser "$@" >>/tmp/chromium.log 2>&1'"'"' sh' |
  docker exec -i "$NAME" sh -c 'cat >/tmp/launch.sh'
browser_pid() { docker exec "$NAME" sh -c 'pgrep -f "^/usr/lib/chromium/chromium --ozone-platform-hint" | head -1'; }
: >"$OUT/$LABEL-series.txt"
for k in $(seq 1 "$N"); do
  [ "$MODE" = fresh ] && docker exec "$NAME" rm -rf /home/streamer/.config/chromium
  docker exec -d "$NAME" sh /tmp/launch.sh
  if [ "${LAB_FFMPEG:-0}" = 1 ]; then
    docker exec -d "$NAME" sh -c 'exec ffmpeg -nostdin -loglevel error -f x11grab -draw_mouse 0 -framerate 30 -video_size 1920x1080 -i :97 -c:v libx264 -preset veryfast -tune zerolatency -b:v 4500k -pix_fmt yuv420p -f null -'
  fi
  sleep "$AT"
  docker exec "$NAME" sh -c "ffmpeg -nostdin -loglevel error -y -f x11grab -draw_mouse 0 -video_size 1920x1080 -i :97 -frames:v 1 /tmp/x.png" &&
    docker cp "$NAME:/tmp/x.png" "$OUT/$LABEL-k$k.png" >/dev/null
  line=$("$TSX" "$REPO/tests/streaming-e2e/frame-detect.ts" "$LABEL-k$k" "$OUT/$LABEL-k$k.png" | head -1)
  spin=$(docker exec "$NAME" sh -c 'for p in $(pgrep -f "type=renderer"); do awk "{print \$14+\$15}" /proc/$p/task/$p/stat; done' | sort -n | tail -1)
  BPID=$(browser_pid)
  echo "k=$k modo=$MODE ffmpeg=${LAB_FFMPEG:-0} navegador=$BPID max_renderer_main_ticks=$spin $line" | tee -a "$OUT/$LABEL-series.txt"
  [ "${LAB_FFMPEG:-0}" = 1 ] && docker exec "$NAME" sh -c 'pkill -f "^ffmpeg -nostdin -loglevel error -f x11grab"'
  [ -n "$BPID" ] && docker exec "$NAME" kill -TERM "$BPID"
  if [ "$MODE" != nowait ]; then
    for _ in $(seq 1 100); do docker exec "$NAME" sh -c 'pgrep -f "^/usr/lib/chromium/chromium" >/dev/null' || break; sleep 0.2; done
  fi
done
docker exec "$NAME" sh -c 'pkill -KILL -f "^/usr/lib/chromium/chromium"' 2>/dev/null
docker cp "$NAME:/tmp/chromium.log" "$OUT/$LABEL-chromium.log" >/dev/null 2>&1
docker rm -f "$NAME" >/dev/null 2>&1
echo "lab-relaunch $LABEL: $(grep -c 'verdict=VISIBLE' "$OUT/$LABEL-series.txt")/$N VISIBLE"
