#!/usr/bin/env bash
# STREAMER · §20 §21 §24-§26 §32 · medición LOCAL del streamer real (nunca producción).
#
#   batalla REAL del motor → /broadcast → imagen REAL del streamer (Xvfb + Chromium +
#   FFmpeg + relé RTMP, con el aislamiento del Compose) → ingesta RTMPS local (MediaMTX,
#   TLS verificado con CA local).
#
# Fases: IDLE (60 s) → STARTING (hasta que el relé publica) → LIVE (LIVE_SECONDS,
# 720 s por defecto) → STOP (60 s). Cada SAMPLE_S segundos registra CPU y memoria del
# contenedor (docker stats), procesos y zombis dentro del contenedor, /dev/shm, el
# estado del streamer y los bytes recibidos por la ingesta. Después: crash de ffmpeg
# (SIGKILL) con recuperación, 5 ciclos start/stop (huérfanos) y una grabación MP4 de
# la que se extraen fotogramas (§21).
#
#   S9_STREAM_E2E_STATE=<dir 0700> STREAMER_IMAGE=<imagen> tests/streaming-e2e/measure.sh
# Lanzarlo bajo el cerrojo de carga del host. Al salir no deja nada vivo. Los secretos
# de prueba (clave FALSA) viven en ficheros 0600 de $S9_STREAM_E2E_STATE: nunca en argv.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
PORT="${S9_STREAM_E2E_PORT:-39480}"
BASE="http://127.0.0.1:$PORT"
OUT="$STATE/out-measure"
LIVE_SECONDS="${LIVE_SECONDS:-720}"
SAMPLE_S="${SAMPLE_S:-5}"
BITRATE="${S9_STREAM_E2E_BITRATE:-4500}"
mkdir -p "$OUT"
LIVE_PID=""
cleanup() {
  [ -n "$LIVE_PID" ] && kill "$LIVE_PID" 2>/dev/null
  down_all
}
trap cleanup EXIT
log() { echo "[$(date +%T)] $*" | tee -a "$OUT/summary.txt"; }
declare -A RC
check() { if eval "$2"; then RC[$1]=0; else RC[$1]=1; fi; log "COMPROBACIÓN $1 rc=${RC[$1]}"; }
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const v=eval("j."+process.argv[1]);console.log(v===undefined?"":v)}catch{console.log("")}})' "$1"; }
status() { ctl GET /status; }
ingest_bytes() { curl -s "http://127.0.0.1:$MTX_API_PORT/v3/paths/list" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const p=(j.items||[]).find(x=>x.ready);console.log(p?p.bytesReceived:0)}catch{console.log(0)}})'; }
ingest_tracks() { curl -s "http://127.0.0.1:$MTX_API_PORT/v3/paths/list" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const p=(j.items||[]).find(x=>x.ready);console.log(p?p.tracks.join("+"):"ninguna")}catch{console.log("ninguna")}})'; }
# Procesos del contenedor: total, chromium, ffmpeg, Xvfb y zombis (estado Z).
procs() {
  docker exec "$TAG-streamer" sh -c 'n=0;c=0;f=0;x=0;z=0;for d in /proc/[0-9]*; do [ -r $d/stat ] || continue; [ "$d" = /proc/$$ ] && continue; n=$((n+1)); s=$(cut -d" " -f3 $d/stat 2>/dev/null); [ "$s" = Z ] && z=$((z+1)); a=$(tr "\0" " " <$d/cmdline 2>/dev/null); case "$a" in *chromium*) c=$((c+1));; *ffmpeg*) f=$((f+1));; *Xvfb*) x=$((x+1));; esac; done; echo "$n $c $f $x $z"' 2>/dev/null
}
shm_kb() { docker exec "$TAG-streamer" sh -c "df -k /dev/shm | tail -1 | awk '{print \$3}'" 2>/dev/null; }
# Muestra: fase t cpu% mem_MiB procs chromium ffmpeg xvfb zombis shm_KiB estado relé frames fps dropped bytes_ingesta
sample() {
  local phase=$1 t=$2
  local stats cpu mem st
  stats=$(docker stats --no-stream --format '{{.CPUPerc}} {{.MemUsage}}' "$TAG-streamer" 2>/dev/null)
  cpu=$(echo "$stats" | awk '{gsub("%","",$1); print $1}')
  mem=$(echo "$stats" | awk '{v=$2; if (v ~ /GiB/) {gsub("GiB","",v); v=v*1024} else if (v ~ /MiB/) {gsub("MiB","",v)} else if (v ~ /KiB/) {gsub("KiB","",v); v=v/1024}; print v}')
  st=$(status)
  echo "$phase $t $cpu $mem $(procs) $(shm_kb) $(echo "$st" | jget state) $(echo "$st" | jget relay.state) $(echo "$st" | jget stats.frames) $(echo "$st" | jget stats.fps) $(echo "$st" | jget stats.droppedFrames) $(ingest_bytes)" >>"$OUT/samples.txt"
}
run_phase() { # run_phase <fase> <segundos>
  local phase=$1 secs=$2 t0
  t0=$(date +%s)
  while [ $(($(date +%s) - t0)) -lt "$secs" ]; do
    sample "$phase" $(($(date +%s) - t0))
    sleep "$SAMPLE_S"
  done
}

# ── preparación ──────────────────────────────────────────────────────────────
gen_secrets
tls_material
echo "# fase t cpu_pct mem_mib procs chromium ffmpeg xvfb zombis shm_kib estado rele frames fps dropped bytes_ingesta" >"$OUT/samples.txt"
log "host: $(nproc) CPU, $(free -m | awk '/^Mem/{print $2}') MiB RAM; imagen $IMG"
if [ ! -s "$STATE/dist/index.html" ]; then
  (cd "$REPO" && node_modules/.bin/vite build apps/web --outDir "$STATE/dist" --emptyOutDir) >"$OUT/vite.log" 2>&1 || { log "vite build falló"; exit 2; }
fi
(cd "$REPO" && PORT="$PORT" WEB_DIST="$STATE/dist" BATTLE_SECONDS=$((LIVE_SECONDS + 600)) \
  STREAMER_CONTROL_URL="http://127.0.0.1:$CTL_PORT" STREAMER_CONTROL_SECRET_FILE="$STATE/control_secret" \
  STREAM_SECRETS_PUBLIC_KEY_FILE="$STATE/public.pem" STREAMING_ALLOW_INTERNAL_INGEST=1 \
  exec node_modules/.bin/tsx tests/streaming-e2e/live-env.ts) >"$OUT/live-env.log" 2>&1 &
LIVE_PID=$!
for _ in $(seq 1 120); do grep -q "live-env listo" "$OUT/live-env.log" && break; sleep 1; done
grep -q "live-env listo" "$OUT/live-env.log" || { log "el entorno no arrancó"; exit 2; }
BATTLE=$(curl -s "$BASE/harness/ids" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).S))')
curl -s -X POST "$BASE/harness/start/S" >/dev/null
log "batalla real en directo: $BATTLE"
BROADCAST_BASE="$BASE/broadcast"
ingest_up
streamer_up rtmps || exit 2
log "streamer (aislamiento del Compose: ${STREAMER_HARDENING:-ninguno}) e ingesta arriba"
docker inspect "$TAG-streamer" --format 'user={{.Config.User}} init={{.HostConfig.Init}} capdrop={{.HostConfig.CapDrop}} capadd={{.HostConfig.CapAdd}} pids={{.HostConfig.PidsLimit}} shm={{.HostConfig.ShmSize}} nnp={{.HostConfig.SecurityOpt}}' >"$OUT/hardening.txt"
docker exec "$TAG-streamer" sh -c 'for d in /proc/[0-9]*; do a=$(tr "\0" " " <$d/cmdline 2>/dev/null); case "$a" in *main.ts*) grep -E "^(Uid|CapEff)" $d/status; break;; esac; done' >>"$OUT/hardening.txt"
log "aislamiento efectivo: $(tr '\n' ' ' <"$OUT/hardening.txt")"
check runs_unprivileged 'grep -qE "^Uid:\s+1000" "$OUT/hardening.txt" && grep -qE "^CapEff:\s+0+$" "$OUT/hardening.txt"'

# ── IDLE ────────────────────────────────────────────────────────────────────
run_phase IDLE 60

# ── START → STARTING → LIVE ─────────────────────────────────────────────────
start_body "$STATE/start.json" "$BROADCAST_BASE?battle=$BATTLE" "$BITRATE" 1080p 30 "measure-1"
T_START=$(date +%s%N)
ctl POST /control/start "$STATE/start.json" >"$OUT/start-response.json"
log "start: estado=$(jget state <"$OUT/start-response.json")"
for _ in $(seq 1 120); do
  sample STARTING $(( ($(date +%s%N) - T_START) / 1000000000 ))
  [ "$(status | jget relay.state)" = publishing ] && [ "$(ingest_bytes)" -gt 0 ] && break
  sleep 1
done
T_LIVE=$(( ($(date +%s%N) - T_START) / 1000000 ))
log "STARTING → LIVE en ${T_LIVE} ms (relé publicando y la ingesta recibe)"
check live_reached '[ "$(status | jget relay.state)" = publishing ]'
b0=$(ingest_bytes); t0=$(date +%s)
run_phase LIVE "$LIVE_SECONDS"
b1=$(ingest_bytes); t1=$(date +%s)
TOTAL_KBPS=$(( (b1 - b0) * 8 / (t1 - t0) / 1000 ))
status >"$OUT/status-live-end.json"
curl -s "http://127.0.0.1:$CTL_PORT/metrics" >"$OUT/metrics-live.txt"
log "LIVE ${LIVE_SECONDS}s: TOTAL_BITRATE≈${TOTAL_KBPS} kbit/s medido en la ingesta (techos configurados: vídeo VBR ${BITRATE}k con -maxrate + audio 128k); pistas=$(ingest_tracks)"
log "frames=$(jget stats.frames <"$OUT/status-live-end.json") dropped=$(jget stats.droppedFrames <"$OUT/status-live-end.json") (drop_frames de ffmpeg; se registra, no es una comprobación) reintentos=$(jget restarts <"$OUT/status-live-end.json")"
check frames_positive '[ "$(jget stats.frames <"$OUT/status-live-end.json" | cut -d. -f1)" -gt 0 ]'
check ingest_tracks '[ "$(ingest_tracks)" = "H264+MPEG-4 Audio" ]'
check no_reconnects_live '[ "$(jget restarts <"$OUT/status-live-end.json")" = 0 ]'

# ── STOP ────────────────────────────────────────────────────────────────────
ctl POST /control/stop >"$OUT/stop-1.json"
ctl POST /control/stop >"$OUT/stop-2.json"
log "stop: $(tr -d '\n' <"$OUT/stop-1.json") · segundo stop (idempotente): $(tr -d '\n' <"$OUT/stop-2.json")"
check stop_idempotent '[ "$(jget wasActive <"$OUT/stop-1.json")" = true ] && [ "$(jget wasActive <"$OUT/stop-2.json")" = false ] && [ "$(jget state <"$OUT/stop-2.json")" = stopped ]'
run_phase STOP 60
read -r n c f x z <<<"$(procs)"
log "tras STOP: procesos=$n chromium=$c ffmpeg=$f xvfb=$x zombis=$z ingesta_bytes=$(ingest_bytes)"
check no_orphans_after_stop '[ "$c" = 0 ] && [ "$f" = 0 ] && [ "$z" = 0 ] && [ "$(ingest_bytes)" = 0 ]'

# ── crash de ffmpeg (SIGKILL) con emisión activa: se recupera sola ──────────
start_body "$STATE/start.json" "$BROADCAST_BASE?battle=$BATTLE" "$BITRATE" 1080p 30 "measure-crash"
ctl POST /control/start "$STATE/start.json" >/dev/null
for _ in $(seq 1 60); do [ "$(status | jget relay.state)" = publishing ] && break; sleep 1; done
r0=$(status | jget restarts)
docker exec -u 1000 "$TAG-streamer" sh -c 'for d in /proc/[0-9]*; do a=$(tr "\0" " " <$d/cmdline 2>/dev/null); case "$a" in *ffmpeg*x11grab*) kill -9 ${d#/proc/};; esac; done'
ok=1
for _ in $(seq 1 60); do sleep 1; [ "$(status | jget restarts)" -gt "$r0" ] && [ "$(status | jget relay.state)" = publishing ] && [ "$(ingest_bytes)" -gt 0 ] && { ok=0; break; }; done
log "ffmpeg SIGKILL: estado=$(status | jget state) relé=$(status | jget relay.state) reintentos=$(( $(status | jget restarts) - r0 )) último error=$(status | jget 'lastError?.message')"
RC[ffmpeg_crash_recovers]=$ok; log "COMPROBACIÓN ffmpeg_crash_recovers rc=$ok"
read -r n c f x z <<<"$(procs)"
log "durante la emisión recuperada: procesos=$n chromium=$c ffmpeg=$f zombis=$z"
check no_zombies_after_crash '[ "$z" = 0 ]'
ctl POST /control/stop >/dev/null
sleep 8

# ── 5 ciclos start/stop: no se acumulan procesos ────────────────────────────
for i in 1 2 3 4 5; do
  start_body "$STATE/start.json" "$BROADCAST_BASE?battle=$BATTLE" "$BITRATE" 1080p 30 "measure-cycle-$i"
  ctl POST /control/start "$STATE/start.json" >/dev/null
  for _ in $(seq 1 60); do [ "$(status | jget relay.state)" = publishing ] && break; sleep 1; done
  sleep 5
  ctl POST /control/stop >/dev/null
  sleep 8
  read -r n c f x z <<<"$(procs)"
  echo "ciclo $i: procesos=$n chromium=$c ffmpeg=$f xvfb=$x zombis=$z" >>"$OUT/cycles.txt"
done
log "ciclos: $(tr '\n' ';' <"$OUT/cycles.txt")"
check no_orphans_cycles '! grep -vqE "chromium=0 ffmpeg=0 xvfb=1 zombis=0" "$OUT/cycles.txt"'
docker logs "$TAG-streamer" >"$OUT/streamer.log" 2>&1
c() { grep -cF -f "$STATE/stream_key" || true; }
leaks=$(( $(c <"$OUT/streamer.log") + $(docker inspect "$TAG-streamer" | c) + $(status | c) + $(c <"$OUT/metrics-live.txt") + $(c <"$OUT/live-env.log") ))
log "clave en logs/inspect/status/metrics/entorno: $leaks"
check key_not_leaked '[ "$leaks" = 0 ]'
# STREAMER-2 (H3) · TODAS las líneas, no sólo las que empiezan por `{`: las del
# proceso Node tienen que ser JSON y la única excepción admitida es la que Xvfb
# escribe al arrancar sin root (`_XSERVTrans…: euid != 0`), que se cuenta aparte.
cat >"$STATE/log-lines.js" <<'JS'
const l = require("fs").readFileSync(process.argv[2], "utf8").split("\n").filter((x) => x.trim());
const r = { total: l.length, json: 0, xvfb: 0, other: [] };
for (const x of l) {
  try {
    if (typeof JSON.parse(x) === "object") { r.json++; continue; }
  } catch {}
  if (/^_XSERVTrans/.test(x)) r.xvfb++;
  else r.other.push(x.slice(0, 120));
}
console.log(`líneas=${r.total} JSON=${r.json} Xvfb(no JSON, admitidas)=${r.xvfb} otras_no_JSON=${r.other.length} ${JSON.stringify(r.other.slice(0, 3))}`);
process.exit(r.other.length ? 1 : 0);
JS
log "logs del contenedor: $(node "$STATE/log-lines.js" "$OUT/streamer.log")"
check log_lines_json 'node "$STATE/log-lines.js" "$OUT/streamer.log" >/dev/null'
check log_useful 'grep -q "emisión arrancada" "$OUT/streamer.log" && grep -q "emisión parada por control" "$OUT/streamer.log" && grep -q "ffmpeg terminó" "$OUT/streamer.log" && grep -q "reintento de emisión" "$OUT/streamer.log" && grep -q "relé RTMP publicando" "$OUT/streamer.log"'

# ── §21 · grabación MP4 y fotogramas ────────────────────────────────────────
docker rm -f "$TAG-streamer" >/dev/null 2>&1
streamer_up record || exit 2
printf '{"sessionId":"measure-rec","broadcastUrl":"%s","mode":"record","encoder":"x264","preset":"1080p","fps":30,"videoBitrateKbps":%s}' \
  "$BROADCAST_BASE?battle=$BATTLE" "$BITRATE" >"$STATE/rec.json"
ctl POST /control/start "$STATE/rec.json" >/dev/null
sleep 45
ctl POST /control/stop >/dev/null
sleep 6
docker exec "$TAG-streamer" sh -c 'f=$(ls -t /data/replays/video/broadcast-*.mp4 | head -1); ffprobe -v error -count_frames -show_entries stream=codec_name,width,height,r_frame_rate,nb_read_frames:format=duration -of compact "$f"' >"$OUT/ffprobe-rec.txt" 2>&1
log "MP4: $(tr '\n' ' ' <"$OUT/ffprobe-rec.txt")"
docker exec "$TAG-streamer" sh -c 'f=$(ls -t /data/replays/video/broadcast-*.mp4 | head -1); cat "$f"' >"$OUT/rec.mp4"
for s in 10 20 30 40; do ffmpeg -v error -y -ss "$s" -i "$OUT/rec.mp4" -frames:v 1 "$OUT/frame-${s}s.png"; done
# Fotogramas negros: blackdetect sobre toda la grabación (tras los 3 s de arranque de Chromium).
ffmpeg -v info -ss 3 -i "$OUT/rec.mp4" -vf "blackdetect=d=0.1:pix_th=0.05" -an -f null - 2>&1 | grep -c black_start >"$OUT/black-segments.txt" || true
# Congelados: freezedetect (pantalla quieta > 2 s).
ffmpeg -v info -ss 3 -i "$OUT/rec.mp4" -vf "freezedetect=n=0.001:d=2" -an -f null - 2>&1 | grep -c freeze_start >"$OUT/freeze-segments.txt" || true
log "§21 tramos negros=$(cat "$OUT/black-segments.txt") congelados(>2 s)=$(cat "$OUT/freeze-segments.txt")"
check video_no_black '[ "$(cat "$OUT/black-segments.txt")" = 0 ]'

# ── resumen ─────────────────────────────────────────────────────────────────
node -e '
const rows=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(l=>l&&!l.startsWith("#")).map(l=>l.split(" "));
const by={};for(const r of rows){(by[r[0]]??=[]).push(r)}
const out=[];
for(const [p,rs] of Object.entries(by)){
  const cpu=rs.map(r=>+r[2]).filter(Number.isFinite), mem=rs.map(r=>+r[3]).filter(Number.isFinite);
  const avg=a=>a.length?(a.reduce((x,y)=>x+y,0)/a.length):0, max=a=>a.length?Math.max(...a):0;
  const procs=rs.map(r=>+r[4]), shm=rs.map(r=>+r[9]);
  out.push(`${p}: n=${rs.length} CPU_AVG=${avg(cpu).toFixed(1)}% CPU_PEAK=${max(cpu).toFixed(1)}% RSS_AVG=${avg(mem).toFixed(0)}MiB RSS_PEAK=${max(mem).toFixed(0)}MiB procs_max=${max(procs)} shm_max=${max(shm)}KiB`);
}
const live=by.LIVE??[]; if(live.length>4){const q=Math.floor(live.length/4);const m=a=>a.reduce((x,y)=>x+ +y[3],0)/a.length;out.push(`LIVE memoria primer cuarto=${m(live.slice(0,q)).toFixed(0)}MiB último cuarto=${m(live.slice(-q)).toFixed(0)}MiB`)}
console.log(out.join("\n"));' "$OUT/samples.txt" | tee "$OUT/resources.txt" | while read -r l; do log "$l"; done
fail=0
for k in "${!RC[@]}"; do [ "${RC[$k]}" = 0 ] || fail=$((fail + 1)); done
log "RESUMEN: ${#RC[@]} comprobaciones, $fail fallidas"
for k in $(printf '%s\n' "${!RC[@]}" | sort); do echo "$k=${RC[$k]}"; done | tee -a "$OUT/summary.txt"
[ "$fail" = 0 ]
