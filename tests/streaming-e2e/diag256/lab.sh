#!/usr/bin/env bash
# #256 · LABORATORIO de render: la MISMA imagen del streamer, el MISMO Chromium con el
# MISMO argv que construye buildChromiumArgs (copiado de apps/streamer/src/ffmpeg.ts por
# el propio script, no a mano), pero lanzado a mano sobre un Xvfb propio, SIN supervisor,
# SIN ffmpeg de emisión y SIN puerto de depuración: así se observa el framebuffer sin que
# ninguna sonda pueda ser la causa. Sólo para diagnóstico local (nunca producción).
#
#   lab.sh <imagen> <url> <dir-salida> <etiqueta> [segundos] [flags extra de Chromium…]
#
# LAB_DROP=<regex> QUITA del argv las líneas que casen (experimento A/B declarado).
# Captura el Xvfb cada 2 s y la pasa por el detector; vuelca la CPU de los hilos de
# Chromium al final. Los flags extra sólo existen para EXPERIMENTOS A/B declarados.
set -uo pipefail
IMG=$1 URL=$2 OUT=$3 LABEL=$4 SECS=${5:-30}
shift 5 2>/dev/null || shift $#
EXTRA=("$@")
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TSX="$REPO/node_modules/.bin/tsx"
NAME="s9fix256-lab"
mkdir -p "$OUT"
# argv real del streamer para esta URL (config por defecto: 1920×1080).
ARGV=$(cd "$REPO" && "$TSX" -e '
  import("./apps/streamer/src/ffmpeg.ts").then(({ buildChromiumArgs }) => {
    const a = buildChromiumArgs({ width: 1920, height: 1080 } as any, process.argv[1]);
    process.stdout.write(a.join("\n"));
  });' "$URL" | grep -vE "${LAB_DROP:-^\$}")
argv_lines() { printf '%s\n' "$ARGV"; [ ${#EXTRA[@]} -eq 0 ] || printf '%s\n' "${EXTRA[@]}"; }
argv_lines >"$OUT/$LABEL-chromium-argv.txt"
docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" --network host --init --shm-size 256m --cpus 4 --memory 4g \
  --security-opt no-new-privileges:true -u 1000:1000 -e HOME=/home/streamer --entrypoint sleep "$IMG" 3600 >/dev/null
docker exec -d "$NAME" sh -c 'Xvfb :97 -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb.log 2>&1'
for _ in $(seq 1 50); do docker exec "$NAME" test -S /tmp/.X11-unix/X97 && break; sleep 0.1; done
# argv por fichero (no por shell): ni comillas ni expansión.
argv_lines | docker exec -i "$NAME" sh -c 'cat >/tmp/argv'
docker exec -d -e DISPLAY=:97 "$NAME" sh -c 'tr "\n" "\0" </tmp/argv | xargs -0 /usr/bin/chromium-browser >/tmp/chromium.log 2>&1'
t0=$SECONDS
i=0
while [ $((SECONDS - t0)) -lt "$SECS" ]; do
  sleep 2
  i=$((i + 2))
  docker exec "$NAME" sh -c "ffmpeg -nostdin -loglevel error -y -f x11grab -draw_mouse 0 -video_size 1920x1080 -i :97 -frames:v 1 /tmp/x-$i.png" &&
    docker cp "$NAME:/tmp/x-$i.png" "$OUT/$LABEL-xvfb-t$i.png" >/dev/null &&
    echo "t=$i $("$TSX" "$REPO/tests/streaming-e2e/frame-detect.ts" "$LABEL-xvfb-t$i" "$OUT/$LABEL-xvfb-t$i.png" | head -1)" | tee -a "$OUT/$LABEL-series.txt"
done
docker exec "$NAME" sh -c '
  for p in $(pgrep -f "type=renderer") $(pgrep -f "type=gpu-process"); do
    echo "--- $p $(tr "\0" " " </proc/$p/cmdline | grep -oE "type=[a-z-]+" | head -1)"
    for t in /proc/$p/task/*; do echo "$(cat $t/comm) $(cut -d" " -f3 $t/stat) $(awk "{print \$14+\$15}" $t/stat)"; done | sort -k3 -n -r | head -4
    grep voluntary_ctxt /proc/$p/task/$p/status | head -1
  done' >"$OUT/$LABEL-threads.txt" 2>&1
docker exec "$NAME" sh -c 'cat /tmp/chromium.log' | tail -40 >"$OUT/$LABEL-chromium.log" 2>&1
[ -n "${LAB_KEEP:-}" ] || docker rm -f "$NAME" >/dev/null 2>&1
echo "lab $LABEL terminado"
