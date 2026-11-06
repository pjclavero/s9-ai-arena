#!/usr/bin/env bash
# Revisión #242 · ataques §36 contra la IMAGEN REAL del streamer (588c842), local.
# Claves de PRUEBA en ficheros 0600 de $S9_STREAM_E2E_STATE; nunca en argv ni impresas.
#   S9_STREAM_E2E_STATE=<dir> STREAMER_IMAGE=<img> WEB_DIST_REUSE=<dist> bash tests/review-242/attack.sh
export S9_STREAM_E2E_TAG=rev242a S9_STREAM_E2E_CTL_PORT=48290 S9_STREAM_E2E_RTMPS_PORT=41966 S9_STREAM_E2E_MTX_API_PORT=49997
REPO_W="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$REPO_W/tests/streaming-e2e/lib.sh"
PORT=39580
BASE="http://127.0.0.1:$PORT"
OUT="$STATE/out-attack"
mkdir -p "$OUT"
LIVE_PID=""
cleanup() {
  [ -n "$LIVE_PID" ] && kill "$LIVE_PID" 2>/dev/null
  down_all
}
trap cleanup EXIT
log() { echo "[$(date +%T)] $*" | tee -a "$OUT/summary.txt"; }
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const v=eval("j."+process.argv[1]);console.log(v===undefined?"":typeof v==="object"?JSON.stringify(v):v)}catch{console.log("")}})' "$1"; }
status() { ctl GET /status; }
paths_ready() { curl -s "http://127.0.0.1:$MTX_API_PORT/v3/paths/list"; }
procs() {
  docker exec "$TAG-streamer" sh -c 'c=0;m=0;f=0;z=0;for d in /proc/[0-9]*; do [ -r $d/stat ] || continue; [ "$d" = /proc/$$ ] && continue; s=$(cut -d" " -f3 $d/stat 2>/dev/null); [ "$s" = Z ] && z=$((z+1)); a=$(tr "\0" " " <$d/cmdline 2>/dev/null); case "$a" in *chromium*--type=*) c=$((c+1));; *chromium*) m=$((m+1)); c=$((c+1));; *ffmpeg*x11grab*) f=$((f+1));; esac; done; echo "chromium=$c chromium_main=$m ffmpeg=$f zombis=$z"' 2>/dev/null
}
wait_state() { # $1 estado  $2 segundos
  for _ in $(seq 1 "$2"); do [ "$(status | jget state)" = "$1" ] && return 0; sleep 1; done; return 1
}
wait_pub() { for _ in $(seq 1 "${1:-60}"); do [ "$(status | jget relay.state)" = publishing ] && return 0; sleep 1; done; return 1; }
# Cuerpo de arranque sellando la clave del fichero $2 con la pública $3 (sin imprimir nada).
body_with() { # $1 salida  $2 fichero clave  $3 pública  $4 sessionId
  (cd "$REPO" && npx tsx tests/streaming-e2e/seal.ts "$3" "$2" custom "$INGEST") >"$STATE/sealed-x.json"
  SEALED="$STATE/sealed-x.json" node -e '
    const fs=require("fs"); const [out, url, sid] = process.argv.slice(1);
    const body = { sessionId: sid, broadcastUrl: url, mode: "rtmps", encoder: "x264", preset: "1080p", fps: 30, videoBitrateKbps: 4500,
      ingestUrl: process.env.INGEST, platform: "custom", credential: JSON.parse(fs.readFileSync(process.env.SEALED, "utf8")) };
    fs.writeFileSync(out, JSON.stringify(body), { mode: 0o600 });' "$1" "$BROADCAST_BASE?battle=$BATTLE" "$4"
}
# ¿Aparece la clave (o un 8-grama de ella, sin distinguir mayúsculas) en el fichero $2? Imprime el recuento.
leak_count() { # $1 fichero clave  $2 fichero a revisar
  node -e '
    const fs=require("fs"); const k=fs.readFileSync(process.argv[1],"utf8").trim(); const t=fs.readFileSync(process.argv[2],"utf8").toLowerCase();
    const forms=[k, Buffer.from(k).toString("base64"), Buffer.from(k).toString("hex"), encodeURIComponent(k)].map(x=>x.toLowerCase());
    let n=0; for (const f of forms) for (let i=0;i+8<=f.length;i++) if (t.includes(f.slice(i,i+8))) n++;
    console.log(n);' "$1" "$2"
}

# ── entorno ──────────────────────────────────────────────────────────────────
gen_secrets
tls_material
umask 077
printf 's9rev-%s' "$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')" >"$STATE/stream_key_b"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$STATE/other_private.pem" 2>/dev/null
openssl pkey -in "$STATE/other_private.pem" -pubout -out "$STATE/other_public.pem" 2>/dev/null
chmod 0600 "$STATE/stream_key_b" "$STATE/other_private.pem" "$STATE/other_public.pem"
(cd "$REPO" && PORT="$PORT" WEB_DIST="$WEB_DIST_REUSE" BATTLE_SECONDS=1800 \
  STREAMER_CONTROL_URL="http://127.0.0.1:$CTL_PORT" STREAMER_CONTROL_SECRET_FILE="$STATE/control_secret" \
  STREAM_SECRETS_PUBLIC_KEY_FILE="$STATE/public.pem" STREAMING_ALLOW_INTERNAL_INGEST=1 \
  exec node_modules/.bin/tsx tests/streaming-e2e/live-env.ts) >"$OUT/live-env.log" 2>&1 &
LIVE_PID=$!
for _ in $(seq 1 120); do grep -q "live-env listo" "$OUT/live-env.log" && break; sleep 1; done
grep -q "live-env listo" "$OUT/live-env.log" || { log "el entorno no arrancó"; exit 2; }
BATTLE=$(curl -s "$BASE/harness/ids" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).S))')
curl -s -X POST "$BASE/harness/start/S" >/dev/null
BROADCAST_BASE="$BASE/broadcast"
ingest_up
export STREAM_MAX_RETRIES=3 STREAM_RETRY_DELAY_MS=1000
streamer_up rtmps || exit 2
log "entorno arriba; batalla $BATTLE; imagen $IMG ($(docker image inspect "$IMG" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'))"
declare -A N=([start_ok]=0 [stop_called]=0)

if [ "${SKIP_AF:-0}" != 1 ]; then
# ── A · aislamiento ─────────────────────────────────────────────────────────
docker inspect "$TAG-streamer" --format 'init={{.HostConfig.Init}} capdrop={{.HostConfig.CapDrop}} capadd={{.HostConfig.CapAdd}} pids={{.HostConfig.PidsLimit}} privileged={{.HostConfig.Privileged}} mounts={{range .Mounts}}{{.Source}}->{{.Destination}}({{.Mode}}) {{end}}' >"$OUT/A-inspect.txt"
docker exec -u 1000 "$TAG-streamer" su-exec root id >"$OUT/A-suexec.txt" 2>&1; echo "rc=$?" >>"$OUT/A-suexec.txt"
docker exec -u 1000 "$TAG-streamer" sh -c 'chown 1000 /etc/hostname' >"$OUT/A-chown.txt" 2>&1; echo "rc=$?" >>"$OUT/A-chown.txt"
docker exec "$TAG-streamer" sh -c 'find /bin /sbin /usr /lib -xdev \( -perm -4000 -o -perm -2000 \) -type f 2>/dev/null; echo ---getcap; command -v getcap >/dev/null && getcap -r /usr /bin 2>/dev/null; echo ---sock; ls -l /var/run/docker.sock /run/docker.sock 2>&1; echo ---secrets; ls -ln /run/s9' >"$OUT/A-files.txt" 2>&1
docker exec "$TAG-streamer" sh -c 'cat /run/s9/stream_secrets_private >/dev/null 2>&1; echo "root sin DAC_OVERRIDE lee la privada: rc=$?"' >>"$OUT/A-files.txt"
log "A · su-exec como 1000: $(tail -2 "$OUT/A-suexec.txt" | tr '\n' ' ') · chown como 1000: $(tail -1 "$OUT/A-chown.txt") · $(tr '\n' ' ' <"$OUT/A-files.txt")"

# ── B · imagen y metadatos ──────────────────────────────────────────────────
docker history --no-trunc "$IMG" >"$OUT/B-history.txt"
docker inspect "$TAG-streamer" >"$OUT/B-inspect.json"
docker run --rm --entrypoint sh "$IMG" -c 'grep -rlI "PRIVATE KEY" /app /home /etc 2>/dev/null; ls -la /run/s9 /run/secrets 2>&1' >"$OUT/B-image-scan.txt" 2>&1
for k in stream_key stream_key_b control_secret; do
  log "B · clave $k: history=$(leak_count "$STATE/$k" "$OUT/B-history.txt") inspect=$(leak_count "$STATE/$k" "$OUT/B-inspect.json")"
done
log "B · ficheros con PRIVATE KEY en la imagen / dirs de secretos: $(tr '\n' ' ' <"$OUT/B-image-scan.txt")"

# ── C · sin secreto y con secreto incorrecto ────────────────────────────────
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({sessionId:"nokey",broadcastUrl:process.argv[2],mode:"rtmps",encoder:"x264",preset:"1080p",fps:30,videoBitrateKbps:4500,ingestUrl:process.env.INGEST,platform:"custom"}),{mode:0o600})' "$STATE/c-nokey.json" "$BROADCAST_BASE?battle=$BATTLE"
ctl POST /control/start "$STATE/c-nokey.json" >"$OUT/C-nokey.json"
body_with "$STATE/c-wrong.json" "$STATE/stream_key" "$STATE/other_public.pem" wrongkey
ctl POST /control/start "$STATE/c-wrong.json" >"$OUT/C-wrong.json"
log "C · sin credencial: $(tr -d '\n' <"$OUT/C-nokey.json") · estado=$(status | jget state)"
log "C · sobre de OTRA clave pública: $(tr -d '\n' <"$OUT/C-wrong.json") · estado=$(status | jget state)"

# ── D · la ingesta RECHAZA la clave ⇒ FAILED redactado ⇒ re-START ───────────
cat >"$STATE/mediamtx-reject.yml" <<EOF
logLevel: info
api: yes
apiAddress: 127.0.0.1:$MTX_API_PORT
rtsp: no
hls: no
webrtc: no
srt: no
rtmp: yes
rtmpEncryption: "strict"
rtmpsAddress: 127.0.0.1:$RTMPS_PORT
rtmpServerKey: /tls/server.key
rtmpServerCert: /tls/server.crt
paths:
  live2/solo-esta-clave:
EOF
chmod 0644 "$STATE/mediamtx-reject.yml"
docker rm -f "$TAG-mediamtx" >/dev/null 2>&1
docker run -d --name "$TAG-mediamtx" --network host -v "$STATE/mediamtx-reject.yml:/mediamtx.yml:ro" -v "$STATE/tls:/tls:ro" "$MEDIAMTX_IMAGE" >/dev/null
sleep 2
body_with "$STATE/d.json" "$STATE/stream_key" "$STATE/public.pem" reject1
ctl POST /control/start "$STATE/d.json" >"$OUT/D-start.json"; N[start_ok]=$((N[start_ok] + 1))
wait_state failed 60; st=$(status); echo "$st" >"$OUT/D-status-failed.json"
log "D · clave rechazada: estado=$(echo "$st" | jget state) reintentos=$(echo "$st" | jget restarts) error=$(echo "$st" | jget 'lastError?.message') fugas_status=$(leak_count "$STATE/stream_key" "$OUT/D-status-failed.json")"
read -r _ <<<"$(procs)"; log "D · procesos en FAILED: $(procs)"
ingest_down; ingest_up; sleep 2
body_with "$STATE/d2.json" "$STATE/stream_key" "$STATE/public.pem" reject2
ctl POST /control/start "$STATE/d2.json" >"$OUT/D-restart.json"; N[start_ok]=$((N[start_ok] + 1))
wait_pub 60; log "D · re-START tras FAILED: estado=$(status | jget state) relé=$(status | jget relay.state)"

# ── E · rotación de la clave sin rebuild ni reinicio ────────────────────────
paths_ready >"$OUT/E-paths-a.json"
ctl POST /control/stop >/dev/null; N[stop_called]=$((N[stop_called] + 1)); sleep 3
body_with "$STATE/e.json" "$STATE/stream_key_b" "$STATE/public.pem" rotated
ctl POST /control/start "$STATE/e.json" >/dev/null; N[start_ok]=$((N[start_ok] + 1))
wait_pub 60; sleep 3
paths_ready >"$OUT/E-paths-b.json"
rot=$(node -e '
  const fs=require("fs"); const a=fs.readFileSync(process.argv[1],"utf8").trim(), b=fs.readFileSync(process.argv[2],"utf8").trim();
  const ready=f=>(JSON.parse(fs.readFileSync(f,"utf8")).items||[]).filter(x=>x.ready).map(x=>x.name);
  const before=ready(process.argv[3]), after=ready(process.argv[4]);
  console.log(`antes: usa A=${before.some(n=>n.endsWith(a))} · después: usa B=${after.some(n=>n.endsWith(b))} usa A=${after.some(n=>n.endsWith(a))}`);' \
  "$STATE/stream_key" "$STATE/stream_key_b" "$OUT/E-paths-a.json" "$OUT/E-paths-b.json")
log "E · rotación (misma imagen, mismo contenedor): $rot · contenedor reiniciado=$(docker inspect "$TAG-streamer" --format '{{.RestartCount}}')"

# ── F · crash de Chromium (padre) y de ffmpeg; huérfanos ────────────────────
log "F · antes: $(procs)"
for i in 1 2 3; do
  docker exec -u 1000 "$TAG-streamer" sh -c 'for d in /proc/[0-9]*; do a=$(tr "\0" " " <$d/cmdline 2>/dev/null); case "$a" in *chromium/chromium*--type=*) ;; *chromium/chromium*) kill -9 ${d#/proc/};; esac; done'
  sleep 2; log "F · $i s tras SIGKILL al Chromium principal: $(procs)"
  wait_pub 60; sleep 10
  log "F · ciclo $i recuperado: estado=$(status | jget state) relé=$(status | jget relay.state) $(procs)"
done
docker exec -u 1000 "$TAG-streamer" sh -c 'for d in /proc/[0-9]*; do a=$(tr "\0" " " <$d/cmdline 2>/dev/null); case "$a" in *ffmpeg*x11grab*) kill -9 ${d#/proc/};; esac; done'
wait_pub 60; sleep 5; log "F · tras SIGKILL a ffmpeg: estado=$(status | jget state) $(procs)"
ctl POST /control/stop >"$OUT/F-stop1.json"; N[stop_called]=$((N[stop_called] + 1))
ctl POST /control/stop >"$OUT/F-stop2.json"
sleep 8
log "F · STOP×2: $(tr -d '\n' <"$OUT/F-stop1.json") / $(tr -d '\n' <"$OUT/F-stop2.json") · tras 8 s: $(procs) pendingChildren=$(status | jget pendingChildren)"
docker exec "$TAG-streamer" sh -c 'for d in /proc/[0-9]*; do a=$(tr "\0" " " <$d/cmdline 2>/dev/null | cut -c1-90); p=$(awk "{print \$4}" $d/stat 2>/dev/null); echo "${d#/proc/} ppid=$p $a"; done' >"$OUT/F-ps-after-stop.txt"

fi
# ── G · concurrencia contra el control real ─────────────────────────────────
for i in $(seq 1 10); do body_with "$STATE/g$i.json" "$STATE/stream_key" "$STATE/public.pem" "conc$i"; done
PIDS=(); for i in $(seq 1 10); do (ctl POST /control/start "$STATE/g$i.json" >"$OUT/G-$i.json") & PIDS+=($!); done; wait "${PIDS[@]}"
ok=$(cat "$OUT"/G-*.json | grep -c '"state":"streaming"'); busy=$(cat "$OUT"/G-*.json | grep -c already_active)
N[start_ok]=$((N[start_ok] + ok))
sleep 6; log "G · 10 START simultáneos: aceptados=$ok 409=$busy · $(procs)"
for r in $(seq 1 8); do
  (ctl POST /control/start "$STATE/g$(( (r % 10) + 1 )).json" >"$OUT/GG-s$r.json") & p1=$!
  (ctl POST /control/stop >"$OUT/GG-t$r.json") & p2=$!
  wait "$p1" "$p2"
done
sleep 8
gs=$(cat "$OUT"/GG-s*.json | grep -c '"state":"streaming"'); N[start_ok]=$((N[start_ok] + gs)); N[stop_called]=$((N[stop_called] + 8))
log "G · 8 rondas START‖STOP: arranques aceptados=$gs · final estado=$(status | jget state) $(procs)"
ctl POST /control/stop >/dev/null; N[stop_called]=$((N[stop_called] + 1)); sleep 8
log "G · tras STOP final: $(procs)"

# ── H · SIGKILL al contenedor y arranque de nuevo ───────────────────────────
body_with "$STATE/h.json" "$STATE/stream_key" "$STATE/public.pem" killme
ctl POST /control/start "$STATE/h.json" >/dev/null; wait_pub 60
curl -s "http://127.0.0.1:$CTL_PORT/metrics" >"$OUT/H-metrics-before-kill.txt"
status >"$OUT/H-status-before-kill.json"
docker logs "$TAG-streamer" >"$OUT/streamer-run1.log" 2>&1
docker kill -s KILL "$TAG-streamer" >/dev/null
sleep 2
log "H · contenedor tras SIGKILL: $(docker inspect "$TAG-streamer" --format '{{.State.Status}} exit={{.State.ExitCode}}') · procesos chromium/ffmpeg del usuario en el host: $(ps -eo args= | grep -cE '^/usr/lib/chromium/chromium|^/usr/bin/ffmpeg -nostats' || true)"
docker start "$TAG-streamer" >/dev/null
for _ in $(seq 1 60); do curl -s -m 2 "http://127.0.0.1:$CTL_PORT/healthz" | grep -q '"ok":true' && break; sleep 1; done
log "H · tras arrancar de nuevo: estado=$(status | jget state) desired=$(status | jget desired) $(procs)"

# ── I · métricas y logs ─────────────────────────────────────────────────────
log "I · operaciones de esta vida del contenedor: arranques aceptados=${N[start_ok]} stops pedidos=${N[stop_called]}"
log "I · /metrics antes del SIGKILL: $(grep -E '^stream_(start|stop|failures|reconnects|killed)_total|^stream_active' "$OUT/H-metrics-before-kill.txt" | tr '\n' ' ')"
log "I · reintentos=$(jget restarts <"$OUT/H-status-before-kill.json") chromium_terminó=$(grep -c "chromium terminó" "$OUT/streamer-run1.log") ffmpeg_terminó=$(grep -c "ffmpeg terminó" "$OUT/streamer-run1.log") relé_rechazo=$(grep -c "rechaz" "$OUT/streamer-run1.log")"
log "I · counters de /status: $(jget counters <"$OUT/H-status-before-kill.json")"
node -e '
  const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);
  let json=0,bad=[]; for (const x of l){ try{ JSON.parse(x); json++ } catch { bad.push(x.slice(0,100)) } }
  console.log(`líneas=${l.length} JSON=${json} no-JSON=${bad.length} ejemplos: ${JSON.stringify(bad.slice(0,4))}`);' "$OUT/streamer-run1.log" >"$OUT/I-logs.txt"
log "I · logs: $(cat "$OUT/I-logs.txt")"
for k in stream_key stream_key_b control_secret; do
  log "I · fugas de $k: logs=$(leak_count "$STATE/$k" "$OUT/streamer-run1.log") status=$(leak_count "$STATE/$k" "$OUT/H-status-before-kill.json") metrics=$(leak_count "$STATE/$k" "$OUT/H-metrics-before-kill.txt") live-env=$(leak_count "$STATE/$k" "$OUT/live-env.log")"
done
ctl POST /control/stop >/dev/null

# ── J · cuánto escribe Chromium por stdout/stderr (lo que nadie lee) ────────
URL="$BROADCAST_BASE?battle=$BATTLE"
docker exec -u 1000 -e URL="$URL" "$TAG-streamer" sh -c '
  Xvfb :93 -screen 0 1920x1080x24 -nolisten tcp >/dev/null 2>&1 & X=$!; sleep 1
  DISPLAY=:93 chromium-browser --window-size=1920,1080 --window-position=0,0 --kiosk --no-first-run --disable-infobars \
    --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --hide-scrollbars --autoplay-policy=no-user-gesture-required \
    --lang=es --disable-features=Translate --hide-crash-restore-bubble --noerrdialogs --no-sandbox --user-data-dir=/tmp/prof-rev \
    --app="$URL" >/tmp/c.out 2>/tmp/c.err & C=$!
  sleep 30; a=$(cat /tmp/c.out /tmp/c.err | wc -c); sleep 90; b=$(cat /tmp/c.out /tmp/c.err | wc -c)
  echo "bytes_0_30s=$a bytes_30_120s=$((b-a)) total=$b"; kill $C; sleep 2; kill -9 $C 2>/dev/null; kill $X
  sleep 1; echo "--- muestra"; tail -c 600 /tmp/c.err' >"$OUT/J-chromium-output.txt" 2>&1
log "J · salida de Chromium real (misma línea de órdenes, /broadcast de la batalla): $(head -1 "$OUT/J-chromium-output.txt")"
log "FIN"
