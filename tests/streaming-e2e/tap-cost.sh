#!/usr/bin/env bash
# DIAG · coste del tap pasivo de ingesta: CPU y RAM del streamer REAL (Xvfb + Chromium +
# FFmpeg + relé) con el tap APAGADO y ENCENDIDO, emitiendo a una ingesta RTMP LOCAL de
# prueba (MediaMTX en un contenedor). Nunca producción, nunca YouTube, clave FALSA.
#
#   S9_TAP_STATE=<dir> STREAMER_IMAGE=<imagen> tests/streaming-e2e/tap-cost.sh <off|on> <segundos> [intervalo_tap_s]
#
# La página emitida es una animación local (nginx en contenedor) con movimiento continuo,
# para que x264 trabaje como con una batalla. Mide, durante <segundos> tras 20 s de
# calentamiento: CPU del contenedor (cgroup cpu.stat), CPU del proceso Node (relé + tap,
# /proc/<pid>/stat), RSS de Node, memoria del contenedor, fps/drops de ffmpeg y bytes
# recibidos por la ingesta. Con el tap encendido guarda además /diag/tap, la última
# captura (.flv, .json y su JPG decodificado a demanda) y audita que la clave no aparece
# en ficheros, nombres, logs ni respuestas. Lanzarlo bajo el cerrojo de carga del host;
# al salir no deja contenedores ni volúmenes.
set -uo pipefail
MODE="${1:?off|on}"
SECS="${2:?segundos}"
IVL="${3:-10}"
STATE="${S9_TAP_STATE:?define S9_TAP_STATE (directorio 0700)}"
IMG="${STREAMER_IMAGE:-s9tap-streamer:local}"
MTX_IMG="${MEDIAMTX_IMAGE:-bluenviron/mediamtx:1.9.3}"
WEB_IMG="${WEB_IMAGE:-nginx:1.27-alpine}"
TAG=s9tap
CTL=48290
RTMP=41947
MTXAPI=49988
WEB=39482
OUT="$STATE/out"
mkdir -p "$STATE" "$OUT" "$STATE/www/broadcast"
chmod 0700 "$STATE"
RUN="$MODE-ivl$IVL-$(date -u +%Y%m%dT%H%M%SZ)"

cleanup() {
  docker rm -f "$TAG-streamer" "$TAG-mtx" "$TAG-web" >/dev/null 2>&1
  docker volume rm "$TAG-secrets" >/dev/null 2>&1
}
trap cleanup EXIT
cleanup

umask 077
[ -s "$STATE/stream_key" ] || printf 's9tapfake-%s' "$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')" >"$STATE/stream_key"
[ -s "$STATE/control_secret" ] || head -c 32 /dev/urandom | base64 | tr -d '=+/\n' >"$STATE/control_secret"
printf 'x-streamer-auth: %s\n' "$(cat "$STATE/control_secret")" >"$STATE/auth_header"
umask 022

# Página con movimiento continuo (canvas): carga de codificación comparable a una batalla.
cat >"$STATE/www/broadcast/index.html" <<'EOF'
<!doctype html><html><body style="margin:0;background:#123;overflow:hidden;cursor:none">
<canvas id="c" width="1920" height="1080"></canvas><script>
const c=document.getElementById("c").getContext("2d");let t=0;
function f(){t++;c.fillStyle="#123";c.fillRect(0,0,1920,1080);
for(let i=0;i<60;i++){const x=(i*97+t*(3+i%7))%1920,y=(i*53+t*(2+i%5))%1080;
c.fillStyle=`hsl(${(i*37+t)%360},80%,55%)`;c.fillRect(x,y,80,80);}
c.fillStyle="#fff";c.font="64px sans-serif";c.fillText("S9 tap "+t,100,140);requestAnimationFrame(f);}f();
</script></body></html>
EOF
cat >"$STATE/nginx.conf" <<EOF
server { listen 127.0.0.1:$WEB; root /usr/share/nginx/html;
  location /broadcast { try_files /broadcast/index.html =404; } }
EOF
cat >"$STATE/mediamtx.yml" <<EOF
logLevel: warn
api: yes
apiAddress: 127.0.0.1:$MTXAPI
rtsp: no
hls: no
webrtc: no
srt: no
rtmp: yes
rtmpAddress: 127.0.0.1:$RTMP
paths:
  all_others:
EOF
chmod -R a+rX "$STATE/www" "$STATE/nginx.conf" "$STATE/mediamtx.yml"

docker run -d --name "$TAG-web" --network host -v "$STATE/www:/usr/share/nginx/html:ro" \
  -v "$STATE/nginx.conf:/etc/nginx/conf.d/default.conf:ro" "$WEB_IMG" >/dev/null || exit 2
docker run -d --name "$TAG-mtx" --network host -v "$STATE/mediamtx.yml:/mediamtx.yml:ro" "$MTX_IMG" >/dev/null || exit 2

# Secretos de prueba al volumen por stdin (0400, uid 1000): nunca en argv.
docker volume create "$TAG-secrets" >/dev/null
put() { docker run -i --rm -v "$TAG-secrets:/s" --entrypoint sh "$IMG" -c "cat > /s/$2 && chown 1000:1000 /s/$2 && chmod 0400 /s/$2" <"$1"; }
put "$STATE/stream_key" stream_key
put "$STATE/control_secret" streamer_control_secret

TAP_ON=false
[ "$MODE" = on ] && TAP_ON=true
docker run -d --name "$TAG-streamer" --network host --cpus 4 --memory 4g \
  --security-opt no-new-privileges:true --init --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID \
  --pids-limit 512 --shm-size 256m \
  -e BROADCAST_URL="http://127.0.0.1:$WEB/broadcast" \
  -e RTMPS_URL="rtmp://127.0.0.1:$RTMP/live2" -e STREAMER_ALLOW_PLAIN_RTMP=1 \
  -e STREAM_KEY_FILE=/run/s9/stream_key -e STREAMER_CONTROL_SECRET_FILE=/run/s9/streamer_control_secret \
  -e STREAM_MODE=rtmps -e STREAM_ENCODER=x264 -e STREAM_AUTOSTART=1 \
  -e STREAMER_CONTROL_PORT="$CTL" -e RECORD_DIR=/data/replays/video -e ARENA_DATA_DIRS=/data/replays \
  -e LOG_FORMAT=json -e DISPLAY=:95 \
  -e STREAM_TAP_ENABLED="$TAP_ON" -e STREAM_TAP_INTERVAL_SEC="$IVL" \
  -v "$TAG-secrets:/run/s9:ro" "$IMG" >/dev/null || exit 2

ctl() { curl -s -m 20 -H @"$STATE/auth_header" "http://127.0.0.1:$CTL$1"; }
jq_() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],j);console.log(v===undefined||v===null?"":typeof v==="object"?JSON.stringify(v):v)}catch{console.log("")}})' "$1"; }
ingest_bytes() { curl -s "http://127.0.0.1:$MTXAPI/v3/paths/list" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=(JSON.parse(s).items||[]).find(x=>x.ready);console.log(p?p.bytesReceived:0)}catch{console.log(0)}})'; }

ok=0
for _ in $(seq 1 120); do
  [ "$(ctl /status | jq_ relay.state)" = publishing ] && { ok=1; break; }
  sleep 1
done
if [ $ok != 1 ]; then
  echo "el relé no llegó a publicar"; ctl /status; docker logs "$TAG-streamer" 2>&1 | tail -20; exit 3
fi
sleep 20 # calentamiento

# Lecturas del contenedor (cgroup v2 propio) y de los procesos Node (relé + tap).
probe() {
  docker exec "$TAG-streamer" sh -c '
    u=$(awk "/^usage_usec/{print \$2}" /sys/fs/cgroup/cpu.stat); m=$(cat /sys/fs/cgroup/memory.current)
    nt=0; nr=0
    for d in /proc/[0-9]*; do
      a=$(tr "\0" " " <$d/cmdline 2>/dev/null)
      case "$a" in *streamer/src/main.ts*)
        t=$(awk "{print \$14+\$15}" $d/stat); r=$(awk "/^VmRSS/{print \$2}" $d/status)
        nt=$((nt+t)); nr=$((nr+r));;
      esac
    done
    echo "$u $m $nt $nr"'
}
read -r U0 M0 N0 R0 <<<"$(probe)"
B0=$(ingest_bytes)
T0=$(date +%s.%N)
MSUM=0
RSUM=0
RMAX=0
NS=0
end=$(($(date +%s) + SECS))
while [ "$(date +%s)" -lt "$end" ]; do
  sleep 5
  read -r _ M _ R <<<"$(probe)"
  MSUM=$((MSUM + M))
  RSUM=$((RSUM + R))
  [ "$R" -gt "$RMAX" ] && RMAX=$R
  NS=$((NS + 1))
done
read -r U1 _ N1 _ <<<"$(probe)"
B1=$(ingest_bytes)
T1=$(date +%s.%N)
ST=$(ctl /status)
TAPJ=$(ctl /diag/tap)

export ST TAPJ
node -e '
const [run, mode, ivl, u0, u1, n0, n1, t0, t1, msum, rsum, rmax, ns, b0, b1] = process.argv.slice(1);
const st = JSON.parse(process.env.ST || "{}"), tap = JSON.parse(process.env.TAPJ || "{}");
const dt = Number(t1) - Number(t0);
console.log(JSON.stringify({
  run, mode, tapIntervalSec: Number(ivl), seconds: Math.round(dt),
  containerCpuPct: +((Number(u1) - Number(u0)) / 1e6 / dt * 100).toFixed(1),
  nodeCpuPct: +((Number(n1) - Number(n0)) / 100 / dt * 100).toFixed(2),
  nodeRssMiBAvg: +(Number(rsum) / Number(ns) / 1024).toFixed(1),
  nodeRssMiBMax: +(Number(rmax) / 1024).toFixed(1),
  containerMemMiBAvg: +(Number(msum) / Number(ns) / 1048576).toFixed(1),
  ingestKbps: Math.round((Number(b1) - Number(b0)) * 8 / 1000 / dt),
  relayState: st.relay && st.relay.state, ffmpeg: st.stats || null, restarts: st.restarts,
  tap: tap.enabled ? { stats: tap.stats, latest: tap.latest } : { enabled: false, body: tap },
}));
' "$RUN" "$MODE" "$IVL" "$U0" "$U1" "$N0" "$N1" "$T0" "$T1" "$MSUM" "$RSUM" "$RMAX" "$NS" "$B0" "$B1" \
  >"$OUT/cost-$RUN.json"
cat "$OUT/cost-$RUN.json"

if [ "$MODE" = on ]; then
  E="$OUT/tap-$RUN"
  mkdir -p "$E"
  ctl /diag/tap/latest >"$E/latest.json"
  curl -s -m 20 -H @"$STATE/auth_header" -D "$E/latest.jpg.headers" -o "$E/latest.jpg" "http://127.0.0.1:$CTL/diag/tap/latest.jpg"
  curl -s -m 20 -H @"$STATE/auth_header" -o "$E/latest.flv" "http://127.0.0.1:$CTL/diag/tap/latest.flv"
  echo "sin secreto => $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CTL/diag/tap/latest")" >"$E/auth.txt"
  # Lectura SIN root: como el usuario del servicio (uid 1000).
  docker exec -u 1000 "$TAG-streamer" sh -c 'id -u; ls -la /tmp/s9-stream-tap; cat /tmp/s9-stream-tap/latest.json' >"$E/ls-as-uid1000.txt" 2>&1
  docker exec -u 1000 "$TAG-streamer" sh -c 'cd /tmp/s9-stream-tap && tar cf - .' >"$E/tapdir.tar" 2>/dev/null
  docker logs "$TAG-streamer" >"$E/streamer.log" 2>&1
  # Auditoría: ningún trozo de ≥8 de la clave FALSA (tal cual, hex, base64) en nada de lo anterior.
  node -e '
    const fs = require("fs"), path = require("path");
    const [keyFile, dir] = process.argv.slice(1);
    const k = fs.readFileSync(keyFile, "utf8").trim();
    const forms = [k, Buffer.from(k).toString("hex"), Buffer.from(k).toString("base64").replace(/=+$/, "")];
    const grams = new Set(); for (const f of forms) for (let i = 0; i + 8 <= f.length; i++) grams.add(f.slice(i, i + 8).toLowerCase());
    const hits = [];
    const scan = (name, buf) => { const t = buf.toString("latin1").toLowerCase(); for (const g of grams) if (t.includes(g)) { hits.push(name); break; } };
    for (const n of fs.readdirSync(dir)) { scan("nombre:" + n, Buffer.from(n)); scan(n, fs.readFileSync(path.join(dir, n))); }
    // Control positivo: el detector SÍ encuentra la clave en el propio fichero de la clave.
    const before = hits.length; scan("control", fs.readFileSync(keyFile)); const detectorOk = hits.length === before + 1; if (detectorOk) hits.pop();
    console.log(JSON.stringify({ secretAudit: hits.length ? "FUGA" : "LIMPIO", detectorOk, hits, scanned: fs.readdirSync(dir) }));
  ' "$STATE/stream_key" "$E" >"$OUT/secret-audit-$RUN.json"
  cp "$OUT/secret-audit-$RUN.json" "$E/secret-audit.json"; cat "$E/secret-audit.json"
  node -e 'const b=require("fs").readFileSync(process.argv[1]);console.log("jpg_bytes="+b.length+" soi="+(b[0]===0xff&&b[1]===0xd8))' "$E/latest.jpg"
fi
echo TAP_COST_DONE
