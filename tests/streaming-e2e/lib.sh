#!/usr/bin/env bash
# EQ5b · Utilidades del E2E LOCAL del streamer (nunca producción).
#
# Todo escucha en 127.0.0.1 (red host del Docker rootless de la máquina de
# pruebas). Los secretos de prueba se generan en ficheros 0600 de $S9_STREAM_E2E_STATE
# y se COPIAN por stdin a un volumen Docker (0400, uid 1000): nunca en argv ni
# impresos. Requiere: docker, openssl, curl, node (tsx del repo).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="${S9_STREAM_E2E_STATE:?define S9_STREAM_E2E_STATE (directorio de estado 0700)}"
TAG="${S9_STREAM_E2E_TAG:-eq5b}"
IMG="${STREAMER_IMAGE:-s9eq5b-streamer:local}"
MEDIAMTX_IMAGE="${MEDIAMTX_IMAGE:-bluenviron/mediamtx:1.9.3}"
CTL_PORT="${S9_STREAM_E2E_CTL_PORT:-48190}"
RTMPS_PORT="${S9_STREAM_E2E_RTMPS_PORT:-41946}"
MTX_API_PORT="${S9_STREAM_E2E_MTX_API_PORT:-49987}"
BROADCAST_BASE="${S9_STREAM_E2E_BROADCAST_BASE:-http://127.0.0.1:1/broadcast}"
# STREAMER §15-§16 · el MISMO aislamiento que declara el Compose (servicio
# `streamer`): init, cap_drop ALL + CHOWN/SETUID/SETGID, límite de pids y /dev/shm.
# S9_STREAM_E2E_HARDENING=0 lo quita (sólo para comparar).
if [ "${S9_STREAM_E2E_HARDENING:-1}" = 1 ]; then
  STREAMER_HARDENING="--init --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --pids-limit 512 --shm-size 256m"
else
  STREAMER_HARDENING=""
fi

mkdir -p "$STATE"
chmod 0700 "$STATE"

# Genera (si faltan) clave de emisión FALSA, secreto de control y par RSA.
gen_secrets() {
  umask 077
  [ -s "$STATE/stream_key" ] || printf 's9e2e-%s' "$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')" >"$STATE/stream_key"
  [ -s "$STATE/control_secret" ] || head -c 32 /dev/urandom | base64 | tr -d '=+/\n' >"$STATE/control_secret"
  [ -s "$STATE/private.pem" ] || openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$STATE/private.pem" 2>/dev/null
  [ -s "$STATE/public.pem" ] || openssl pkey -in "$STATE/private.pem" -pubout -out "$STATE/public.pem" 2>/dev/null
  printf 'x-streamer-auth: %s\n' "$(cat "$STATE/control_secret")" >"$STATE/auth_header"
  chmod 0600 "$STATE/stream_key" "$STATE/control_secret" "$STATE/private.pem" "$STATE/public.pem" "$STATE/auth_header"
}

# Copia un fichero al volumen de secretos por stdin (0400, uid 1000).
put_secret() { # $1 fichero local  $2 nombre en el volumen
  docker run -i --rm -v "$TAG-secrets:/s" --entrypoint sh "$IMG" -c "cat > /s/$2 && chown 1000:1000 /s/$2 && chmod 0400 /s/$2" <"$1"
}

tls_material() {
  if [ ! -s "$STATE/tls/server.crt" ]; then
    mkdir -p "$STATE/tls"
    openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=ingesta-local" \
      -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" \
      -keyout "$STATE/tls/server.key" -out "$STATE/tls/server.crt" 2>/dev/null
    chmod 0755 "$STATE/tls"
    chmod 0644 "$STATE/tls/server.key" "$STATE/tls/server.crt" # material de una CA de PRUEBA local
  fi
  cat >"$STATE/mediamtx.yml" <<EOF
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
  all_others:
EOF
  chmod 0644 "$STATE/mediamtx.yml"
}

ingest_up() {
  tls_material
  docker rm -f "$TAG-mediamtx" >/dev/null 2>&1
  docker run -d --name "$TAG-mediamtx" --network host \
    -v "$STATE/mediamtx.yml:/mediamtx.yml:ro" -v "$STATE/tls:/tls:ro" "$MEDIAMTX_IMAGE" >/dev/null
}
ingest_down() { docker rm -f "$TAG-mediamtx" >/dev/null 2>&1; }
ingest_pause() { docker pause "$TAG-mediamtx" >/dev/null; }
ingest_unpause() { docker unpause "$TAG-mediamtx" >/dev/null; }

streamer_up() { # $1 modo por defecto (rtmps|record)
  gen_secrets
  tls_material
  docker volume create "$TAG-secrets" >/dev/null
  docker volume create "$TAG-replays" >/dev/null
  put_secret "$STATE/private.pem" stream_secrets_private
  put_secret "$STATE/control_secret" streamer_control_secret
  docker rm -f "$TAG-streamer" >/dev/null 2>&1
  docker run -d --name "$TAG-streamer" --network host \
    --cpus 4 --memory 4g --security-opt no-new-privileges:true \
    $STREAMER_HARDENING \
    -e BROADCAST_URL="$BROADCAST_BASE" \
    -e RTMPS_URL="rtmps://127.0.0.1:$RTMPS_PORT/live2" \
    -e STREAM_SECRETS_PRIVATE_KEY_FILE=/run/s9/stream_secrets_private \
    -e STREAMER_CONTROL_SECRET_FILE=/run/s9/streamer_control_secret \
    -e NODE_EXTRA_CA_CERTS=/tls/server.crt \
    -e STREAM_MODE="${1:-rtmps}" -e STREAM_ENCODER=x264 -e STREAM_AUTOSTART=0 \
    -e STREAMER_CONTROL_PORT="$CTL_PORT" -e RECORD_DIR=/data/replays/video \
    -e ARENA_DATA_DIRS=/data/replays -e LOG_FORMAT=json \
    -e STREAM_RETRY_DELAY_MS="${STREAM_RETRY_DELAY_MS:-3000}" \
    -e STREAM_MAX_RETRIES="${STREAM_MAX_RETRIES:-20}" \
    -e DISPLAY=:96 \
    -v "$TAG-replays:/data/replays" \
    -v "$TAG-secrets:/run/s9:ro" \
    -v "$STATE/tls/server.crt:/tls/server.crt:ro" \
    "$IMG" >/dev/null
  for _ in $(seq 1 90); do
    docker logs "$TAG-streamer" 2>&1 | grep -q "API de control escuchando" && return 0
    sleep 1
  done
  echo "el streamer no arrancó" >&2
  docker logs "$TAG-streamer" 2>&1 | tail -5 >&2
  return 1
}

# Habla con la API de control: la cabecera de autenticación sale de fichero (-H @).
ctl() { # $1 método  $2 ruta  [$3 fichero JSON del cuerpo]
  if [ "$1" = POST ]; then
    curl -s -m 30 -H @"$STATE/auth_header" -H 'content-type: application/json' \
      --data-binary @"${3:-/dev/null}" "http://127.0.0.1:$CTL_PORT$2"
  else
    curl -s -m 30 -H @"$STATE/auth_header" "http://127.0.0.1:$CTL_PORT$2"
  fi
  echo
}

# Cuerpo de arranque con la credencial SELLADA (sobre leído de fichero).
start_body() { # $1 salida  $2 broadcastUrl  [$3 bitrate] [$4 preset] [$5 fps] [$6 sessionId]
  (cd "$REPO" && npx tsx tests/streaming-e2e/seal.ts "$STATE/public.pem" "$STATE/stream_key" custom "$INGEST") >"$STATE/sealed.json"
  node -e '
    const fs=require("fs");
    const [out, url, br, preset, fps, sid] = process.argv.slice(1);
    const body = { sessionId: sid || "e2e-" + Date.now(), broadcastUrl: url, mode: "rtmps",
      encoder: "x264", preset: preset || "1080p", fps: Number(fps || 30), videoBitrateKbps: Number(br || 4500),
      ingestUrl: process.env.INGEST, platform: "custom", credential: JSON.parse(fs.readFileSync(process.env.SEALED, "utf8")) };
    fs.writeFileSync(out, JSON.stringify(body), { mode: 0o600 });
  ' "$1" "$2" "${3:-4500}" "${4:-1080p}" "${5:-30}" "${6:-}"
}
export INGEST="rtmps://127.0.0.1:${RTMPS_PORT}/live2"
export SEALED="$STATE/sealed.json"

down_all() {
  docker rm -f "$TAG-streamer" "$TAG-mediamtx" >/dev/null 2>&1
  docker volume rm "$TAG-secrets" "$TAG-replays" >/dev/null 2>&1
  echo "entorno $TAG borrado"
}
