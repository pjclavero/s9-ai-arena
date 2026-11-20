#!/usr/bin/env bash
# EQ5b · §3 · ¿Dónde aparece la clave (FALSA) de emisión con la imagen REAL emitiendo
# por RTMPS a una ingesta local? Cuenta apariciones SIN imprimirla. Uso:
#   S9_STREAM_E2E_STATE=<dir> tests/streaming-e2e/secret-audit.sh [segundos]
# Deja el entorno borrado al terminar. rc 0 sólo si la ingesta recibe vídeo y la
# clave no aparece en ninguna superficie del streamer.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
SECS="${1:-25}"
trap down_all EXIT

ingest_up
streamer_up rtmps || exit 2
start_body "$STATE/start.json" "$BROADCAST_BASE"
echo "start: $(ctl POST /control/start "$STATE/start.json" | head -c 300)"
sleep "$SECS"

KEYF="$STATE/stream_key"
c() { grep -cF -f "$KEYF" || true; }
fallos=0
fila() { # $1 superficie  $2 apariciones
  echo "$1 | $2"
  [ "$2" = 0 ] || fallos=$((fallos + 1))
}
echo "superficie | apariciones"
fila "docker logs del streamer" "$(docker logs "$TAG-streamer" 2>&1 | c)"
fila "docker inspect del streamer (Env, Args, Mounts, Config)" "$(docker inspect "$TAG-streamer" | c)"
fila "docker top del streamer (argv de TODOS sus procesos)" "$(docker top "$TAG-streamer" -eo pid,args | c)"
fila "ps -eo args del HOST (lo que ve cualquier usuario)" "$(ps -eo args | c)"
procs=0
for pid in $(docker exec "$TAG-streamer" sh -c 'ls /proc | grep -E "^[0-9]+$"'); do
  n=$(docker exec "$TAG-streamer" sh -c "cat /proc/$pid/cmdline /proc/$pid/environ 2>/dev/null" | tr '\0' '\n' | c)
  procs=$((procs + n))
done
fila "/proc/*/cmdline + /proc/*/environ dentro del contenedor" "$procs"
fila "env del contenedor (docker exec env)" "$(docker exec "$TAG-streamer" env | c)"
fila "GET /status" "$(ctl GET /status | c)"
fila "GET /metrics" "$(curl -s "http://127.0.0.1:$CTL_PORT/metrics" | c)"
fila "GET /healthz" "$(curl -s "http://127.0.0.1:$CTL_PORT/healthz" | c)"
fila "GET /version" "$(curl -s "http://127.0.0.1:$CTL_PORT/version" | c)"
fila "ficheros del contenedor (/tmp, /home, /data)" "$(docker exec "$TAG-streamer" sh -c 'grep -rlF -f /dev/stdin /tmp /home /data 2>/dev/null | wc -l' <"$KEYF")"
fila "sobre sellado (cuerpo de /control/start)" "$(c <"$STATE/sealed.json")"

echo "--- ffmpeg dentro del contenedor (argv redactado por construcción):"
docker exec "$TAG-streamer" sh -c 'for p in $(pgrep -x ffmpeg); do tr "\0" " " </proc/$p/cmdline; echo; done' | tail -c 400
echo
echo "--- la ingesta (destino legítimo de la clave) recibe la emisión:"
paths=$(curl -s "http://127.0.0.1:$MTX_API_PORT/v3/paths/list")
echo "paths con la clave como nombre de stream: $(printf '%s' "$paths" | c)"
echo "$paths" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);for(const p of j.items||[])console.log("ready="+p.ready+" tracks="+JSON.stringify(p.tracks)+" bytesReceived="+p.bytesReceived)})'
ok_ingest=$(echo "$paths" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((j.items||[]).some(p=>p.ready&&p.bytesReceived>100000)?1:0)})')
echo "--- /status (resumen):"
ctl GET /status | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify({state:j.state,target:j.target,relay:j.relay,lastError:j.lastError,stats:j.stats}))})'
echo "FALLOS_SUPERFICIE=$fallos INGESTA_OK=$ok_ingest"
[ "$fallos" = 0 ] && [ "$ok_ingest" = 1 ]
