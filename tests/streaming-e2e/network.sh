#!/usr/bin/env bash
# STREAMING-UX · E2E LOCAL de la red del relé con la IMAGEN real del streamer (nunca
# producción, nada del host se toca: ni nftables, ni sysctl, ni rutas).
#
#  A · YOUTUBE_IPV4_FALLBACK · runtime equivalente al de producción: red Docker con IPv6
#      (el contenedor TIENE dirección y ruta IPv6) y la ingesta resuelve PRIMERO a una
#      IPv6 sin salida y después a la IPv4 de una ingesta RTMPS local (MediaMTX, TLS
#      verificado contra el NOMBRE). El relé tiene que pasar de `connecting` a
#      `publishing`, y MediaMTX tiene que ver la conexión desde la IPv4 del contenedor.
#  B · PRIMARY_FAILOVER_TO_BACKUP / BACKUP_STICKY / NEW_SESSION_STARTS_PRIMARY · dos
#      ingestas: la principal caída ⇒ se publica en la de respaldo; la principal vuelve
#      ⇒ la sesión SIGUE en el respaldo; una sesión nueva ⇒ empieza por la principal.
#
#   S9_STREAM_E2E_STATE=<dir> STREAMER_IMAGE=<imagen> tests/streaming-e2e/network.sh
# Bajo el cerrojo de carga del host. Al salir no deja nada vivo (trap).
export S9_STREAM_E2E_TAG="${S9_STREAM_E2E_TAG:-s9net}-net"
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
NET="$TAG-v6"
OUT="$STATE/out-network"
CTL="${S9_NET_CTL_PORT:-48291}"
P1="${S9_NET_PRIMARY_PORT:-41961}"
P2="${S9_NET_BACKUP_PORT:-41962}"
mkdir -p "$OUT"
declare -A RC
log() { echo "[$(date +%T)] $*" | tee -a "$OUT/summary.txt"; }
cleanup() {
  docker rm -f "$TAG-streamer" "$TAG-mtx1" "$TAG-mtx2" >/dev/null 2>&1
  docker volume rm "$TAG-secrets" "$TAG-replays" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
}
trap cleanup EXIT
cleanup
: >"$OUT/summary.txt"

gen_secrets
# Certificado de PRUEBA para el NOMBRE de la ingesta (el relé verifica contra él).
mkdir -p "$STATE/tls-net"
if [ ! -s "$STATE/tls-net/server.crt" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=ingest.test" \
    -addext "subjectAltName=DNS:ingest.test,DNS:backup.test" \
    -keyout "$STATE/tls-net/server.key" -out "$STATE/tls-net/server.crt" 2>/dev/null
fi
chmod 0755 "$STATE/tls-net"
chmod 0644 "$STATE/tls-net/server.key" "$STATE/tls-net/server.crt"
mtx_conf() { # $1 puerto rtmps  $2 puerto api
  cat >"$STATE/mtx-$1.yml" <<EOF
logLevel: debug
api: yes
apiAddress: :$2
rtsp: no
hls: no
webrtc: no
srt: no
rtmp: yes
rtmpEncryption: "strict"
rtmpsAddress: :$1
rtmpServerKey: /tls/server.key
rtmpServerCert: /tls/server.crt
paths:
  all_others:
EOF
  chmod 0644 "$STATE/mtx-$1.yml"
}
mtx_conf "$P1" 9971
mtx_conf "$P2" 9972

# Red con IPv6 (ULA de documentación, sin salida): el contenedor tiene dirección y ruta
# IPv6, pero una IPv6 fuera de la subred no lleva a ninguna parte — como en producción.
docker network create --ipv6 --subnet fd5e:9a1:0:1::/64 "$NET" >"$OUT/network.txt" 2>&1 || {
  log "no se pudo crear la red IPv6 de prueba: $(cat "$OUT/network.txt")"
  exit 2
}
mtx_up() { # $1 nombre  $2 puerto
  docker rm -f "$TAG-$1" >/dev/null 2>&1
  docker run -d --name "$TAG-$1" --network "$NET" \
    -v "$STATE/mtx-$2.yml:/mediamtx.yml:ro" -v "$STATE/tls-net:/tls:ro" "$MEDIAMTX_IMAGE" >/dev/null
  for _ in $(seq 1 30); do docker logs "$TAG-$1" 2>&1 | grep -q "listener opened on :$2" && break; sleep 1; done
}
mtx_ip() { docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$TAG-$1"; }
mtx_up mtx1 "$P1"
mtx_up mtx2 "$P2"
IP1=$(mtx_ip mtx1)
IP2=$(mtx_ip mtx2)
UNREACHABLE6="fd5e:9a1:0:2::200c" # ULA FUERA de la subred del contenedor: misma etiqueta RFC 6724 que su dirección (el runtime la ordena PRIMERO, como la AAAA de producción) y sin ruta que lleve a ninguna parte

docker volume create "$TAG-secrets" >/dev/null
docker volume create "$TAG-replays" >/dev/null
put_secret "$STATE/private.pem" stream_secrets_private
put_secret "$STATE/control_secret" streamer_control_secret
# La ingesta resuelve a la IPv6 MUERTA y a la IPv4 buena (como el DNS del contenedor de producción).
docker run -d --name "$TAG-streamer" --network "$NET" -p "127.0.0.1:$CTL:$CTL" \
  --cpus 4 --memory 4g --security-opt no-new-privileges:true $STREAMER_HARDENING \
  --add-host "ingest.test:[$UNREACHABLE6]" --add-host "ingest.test:$IP1" \
  --add-host "backup.test:[$UNREACHABLE6]" --add-host "backup.test:$IP2" \
  -e BROADCAST_URL="http://127.0.0.1:1/broadcast" \
  -e RTMPS_URL="rtmps://ingest.test:$P1/live2" \
  -e STREAM_SECRETS_PRIVATE_KEY_FILE=/run/s9/stream_secrets_private \
  -e STREAMER_CONTROL_SECRET_FILE=/run/s9/streamer_control_secret \
  -e NODE_EXTRA_CA_CERTS=/tls/server.crt \
  -e STREAM_MODE=rtmps -e STREAM_ENCODER=x264 -e STREAM_AUTOSTART=0 \
  -e STREAMER_CONTROL_PORT="$CTL" -e RECORD_DIR=/data/replays/video \
  -e ARENA_DATA_DIRS=/data/replays -e LOG_FORMAT=json \
  -e STREAM_RETRY_DELAY_MS=1000 -e STREAM_MAX_RETRIES=30 -e DISPLAY=:95 \
  -v "$TAG-replays:/data/replays" -v "$TAG-secrets:/run/s9:ro" \
  -v "$STATE/tls-net/server.crt:/tls/server.crt:ro" \
  "$IMG" >/dev/null
for _ in $(seq 1 90); do docker logs "$TAG-streamer" 2>&1 | grep -q "API de control escuchando" && break; sleep 1; done
CTL_PORT=$CTL

# Lo que ve el runtime del contenedor: dirección/ruta IPv6, orden de la resolución y que la IPv6 no responde.
docker exec "$TAG-streamer" sh -c 'ip -6 addr show scope global; ip -6 route' >"$OUT/container-ipv6.txt" 2>&1
docker exec "$TAG-streamer" node -e '
  require("dns").lookup("ingest.test",{all:true,verbatim:true},(e,a)=>console.log(JSON.stringify(a)));' >"$OUT/lookup-order.txt" 2>&1
docker exec "$TAG-streamer" node -e '
  const n=require("net");const t=Date.now();const s=n.connect({host:process.argv[1],port:Number(process.argv[2])});
  s.on("connect",()=>{console.log("V6_CONNECTED");process.exit(0)});s.on("error",e=>{console.log("V6_ERROR",e.code,Date.now()-t);process.exit(0)});
  setTimeout(()=>{console.log("V6_TIMEOUT",Date.now()-t);process.exit(0)},5000);' "$UNREACHABLE6" "$P1" >"$OUT/v6-probe.txt" 2>&1
log "IPv6 del contenedor: $(grep -c inet6 "$OUT/container-ipv6.txt") dirección(es) · ruta por defecto v6: $(grep -c '^default' "$OUT/container-ipv6.txt")"
log "resolución de ingest.test (orden del runtime): $(cat "$OUT/lookup-order.txt")"
log "sonda TCP a la IPv6 de la ingesta: $(cat "$OUT/v6-probe.txt")"

seal() { # $1 ingest  $2 salida
  (cd "$REPO" && npx tsx tests/streaming-e2e/seal.ts "$STATE/public.pem" "$STATE/stream_key" custom "$1") >"$2"
  chmod 0600 "$2"
}
body() { # $1 salida  $2 sessionId  $3 con respaldo (1/0)
  node -e '
    const fs=require("fs"); const [out,sid,withBackup,p,b,sp,sb]=process.argv.slice(1);
    const o={sessionId:sid,broadcastUrl:"http://127.0.0.1:1/broadcast",mode:"rtmps",encoder:"x264",preset:"720p",fps:30,
      videoBitrateKbps:2500,platform:"custom",ingestUrl:p,credential:JSON.parse(fs.readFileSync(sp,"utf8"))};
    if (withBackup==="1"){o.backupIngestUrl=b;o.backupCredential=JSON.parse(fs.readFileSync(sb,"utf8"));}
    fs.writeFileSync(out,JSON.stringify(o),{mode:0o600});' \
    "$1" "$2" "$3" "rtmps://ingest.test:$P1/live2" "rtmps://backup.test:$P2/live2" "$STATE/sealed-p.json" "$STATE/sealed-b.json"
}
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(eval("j."+process.argv[1]))})' "$1"; }
seal "rtmps://ingest.test:$P1/live2" "$STATE/sealed-p.json"
seal "rtmps://backup.test:$P2/live2" "$STATE/sealed-b.json"
wait_relay() { # $1 estado  $2 segundos
  for _ in $(seq 1 "$2"); do [ "$(ctl GET /status | jget relay.state)" = "$1" ] && return 0; sleep 1; done
  return 1
}

# ── A · fallback IPv4 con IPv6 sin salida ───────────────────────────────────
body "$STATE/start-a.json" net-a 0
ctl POST /control/start "$STATE/start-a.json" >"$OUT/start-a.json"
seen_connecting=1
for _ in $(seq 1 20); do
  st=$(ctl GET /status | jget relay.state)
  [ "$st" = connecting ] && seen_connecting=0
  [ "$st" = publishing ] && break
  sleep 0.25
done
wait_relay publishing 30
RC[A_relay_publishing]=$?
ctl GET /status >"$OUT/status-a.json"
# Sólo las líneas de conexión: el log de la ingesta incluye la ruta del stream, que
# es la clave de PRUEBA, y no debe acabar en las evidencias.
docker logs "$TAG-mtx1" 2>&1 | grep -E "\[conn [^]]+\] opened" | grep -vF -f "$STATE/stream_key" >"$OUT/mtx1-a.log"
STREAMER_V4=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$TAG-streamer")
grep -qE "conn $STREAMER_V4:[0-9]+\] opened" "$OUT/mtx1-a.log"
RC[A_ingest_saw_ipv4]=$?
log "A · relé=$(jget relay.state <"$OUT/status-a.json") (vio connecting: $([ $seen_connecting = 0 ] && echo sí || echo no)) · MediaMTX ve conexión desde la IPv4 del contenedor: $([ "${RC[A_ingest_saw_ipv4]}" = 0 ] && echo sí || echo no) · reintentos=$(jget restarts <"$OUT/status-a.json")"
ctl POST /control/stop >/dev/null

# ── A2 · la AAAA PRIMERO, en el runtime de la imagen y con sockets reales ────────
# El resolvedor de la imagen (musl, RFC 6724) puede ordenar aquí la IPv4 delante: en
# producción la AAAA salía primero. Para forzar ESE orden sin tocar el producto, se
# ejecuta el relé de la imagen con un `lookup` que devuelve [IPv6 muerta, IPv4 buena]. El
# transporte, el TLS (verificado contra el nombre) y la ingesta son los reales.
docker exec -i "$TAG-streamer" sh -c 'cat > /tmp/v6first.mts' <<'EOF'
import { connect } from "node:net";
import { parseIngestUrl, RtmpPublisher } from "/app/apps/streamer/src/rtmp/publisher.ts";
import { dialIngest } from "/app/apps/streamer/src/rtmp/dial.ts";
const [url, v6, v4] = process.argv.slice(2);
const tried: number[] = [];
const t0 = Date.now();
const pub = new RtmpPublisher({
  target: parseIngestUrl(url),
  streamKey: "sonda-sin-clave",
  connectTimeoutMs: 8000,
  dial: (t) =>
    dialIngest(t, {
      lookup: async () => [{ address: v6, family: 6 }, { address: v4, family: 4 }],
      tcpConnect: (a, p, f) => (tried.push(f), connect({ host: a, port: p, family: f })),
    }),
});
pub.probe().then(
  (r) => console.log(JSON.stringify({ ok: true, tried, ms: Date.now() - t0, tls: r.tlsVerified })),
  (e) => console.log(JSON.stringify({ ok: false, tried, ms: Date.now() - t0, error: String(e.message) })),
);
EOF
docker exec -e NODE_EXTRA_CA_CERTS=/tls/server.crt "$TAG-streamer" tsx /tmp/v6first.mts \
  "rtmps://ingest.test:$P1/live2" "$UNREACHABLE6" "$IP1" >"$OUT/v6first.json" 2>&1
[ "$(jget ok <"$OUT/v6first.json")" = true ] && [ "$(jget 'tried[0]' <"$OUT/v6first.json")" = 6 ] && [ "$(jget 'tried[1]' <"$OUT/v6first.json")" = 4 ]
RC[A2_v6_first_falls_back_to_v4]=$?
log "A2 · AAAA primero (runtime de la imagen, sockets reales): $(cat "$OUT/v6first.json")"

# ── B · failover principal → respaldo, respaldo fijo y sesión nueva ───────────
docker stop "$TAG-mtx1" >/dev/null # principal caída
body "$STATE/start-b.json" net-b 1
ctl POST /control/start "$STATE/start-b.json" >"$OUT/start-b.json"
ok=1
for _ in $(seq 1 60); do
  s=$(ctl GET /status)
  [ "$(echo "$s" | jget relay.state)" = publishing ] && [ "$(echo "$s" | jget relay.ingest)" = backup ] && { ok=0; break; }
  sleep 1
done
RC[B_failover_to_backup]=$ok
ctl GET /status >"$OUT/status-b1.json"
log "B1 · principal caída ⇒ ingesta=$(jget relay.ingest <"$OUT/status-b1.json") relé=$(jget relay.state <"$OUT/status-b1.json") failedOver=$(jget relay.failedOver <"$OUT/status-b1.json") error principal=$(jget relay.ingestErrors.primary <"$OUT/status-b1.json")"
docker start "$TAG-mtx1" >/dev/null # la principal VUELVE
sleep 3
docker restart "$TAG-mtx2" >/dev/null # corte del respaldo: el relé reconecta… al RESPALDO
ok=1
for _ in $(seq 1 60); do
  s=$(ctl GET /status)
  [ "$(echo "$s" | jget restarts)" -gt "$(jget restarts <"$OUT/status-b1.json")" ] && [ "$(echo "$s" | jget relay.state)" = publishing ] && { ok=0; break; }
  sleep 1
done
ctl GET /status >"$OUT/status-b2.json"
[ "$ok" = 0 ] && [ "$(jget relay.ingest <"$OUT/status-b2.json")" = backup ]
RC[B_backup_sticky]=$?
log "B2 · principal recuperada y corte del respaldo ⇒ ingesta=$(jget relay.ingest <"$OUT/status-b2.json") relé=$(jget relay.state <"$OUT/status-b2.json") reintentos=$(jget restarts <"$OUT/status-b2.json")"
ctl POST /control/stop >/dev/null
body "$STATE/start-c.json" net-c 1
ctl POST /control/start "$STATE/start-c.json" >/dev/null
wait_relay publishing 30
ctl GET /status >"$OUT/status-b3.json"
[ "$(jget relay.ingest <"$OUT/status-b3.json")" = primary ] && [ "$(jget relay.state <"$OUT/status-b3.json")" = publishing ]
RC[B_new_session_primary]=$?
log "B3 · sesión nueva ⇒ ingesta=$(jget relay.ingest <"$OUT/status-b3.json") relé=$(jget relay.state <"$OUT/status-b3.json")"
ctl POST /control/stop >/dev/null

# La clave de PRUEBA no aparece en ninguna superficie del contenedor (recuento, nunca impresa).
c() { grep -cF -f "$STATE/stream_key" || true; }
leaks=0
for n in "$(docker logs "$TAG-streamer" 2>&1 | c)" "$(docker inspect "$TAG-streamer" | c)" "$(c <"$OUT/status-a.json")" \
  "$(c <"$OUT/status-b1.json")" "$(c <"$OUT/status-b2.json")" "$(c <"$OUT/status-b3.json")"; do leaks=$((leaks + n)); done
[ "$leaks" = 0 ]
RC[key_not_exposed]=$?
log "clave en logs/inspect/status: $leaks"

fail=0
for k in "${!RC[@]}"; do [ "${RC[$k]}" = 0 ] || fail=$((fail + 1)); done
log "RESUMEN: ${#RC[@]} comprobaciones, $fail fallidas"
for k in $(printf '%s\n' "${!RC[@]}" | sort); do echo "$k=${RC[$k]}"; done | tee -a "$OUT/summary.txt"
[ "$fail" = 0 ]
