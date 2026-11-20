#!/usr/bin/env bash
# DIAG · Lee la ÚLTIMA captura del tap pasivo de ingesta del streamer, SIN root y SIN
# poner el secreto de control en argv ni en el entorno: el `node` que hace la petición
# corre DENTRO del contenedor como el usuario del servicio (uid 1000) y lee el secreto
# del fichero que ya usa el streamer (STREAMER_CONTROL_SECRET_FILE).
#
# Uso (en el host del despliegue, desde el directorio del compose):
#   scripts/ops/stream-tap-read.sh <dir_salida>                    # docker compose exec streamer
#   scripts/ops/stream-tap-read.sh <dir_salida> --container <nombre> # docker exec <nombre>
#
# Deja en <dir_salida>:
#   status.json  GET /diag/tap         (encendido, contadores, última captura)
#   latest.json  GET /diag/tap/latest  (capturedAt, flvTimestampMs, ptsMs, fichero)
#   latest.flv   GET /diag/tap/latest.flv (FLV mínimo: secuencia AVC + keyframe, tal cual se envió)
#   latest.jpg   GET /diag/tap/latest.jpg (ese keyframe decodificado A DEMANDA: un fotograma)
# Con el tap apagado, status.json dice `"enabled":false` y el resto no se genera.
set -euo pipefail
OUT="${1:?uso: stream-tap-read.sh <dir_salida> [--container <nombre>]}"
shift
if [ "${1:-}" = "--container" ]; then
  EXEC=(docker exec -i -u 1000 "${2:?falta el nombre del contenedor}")
else
  EXEC=(docker compose exec -T -u 1000 streamer)
fi
mkdir -p "$OUT"

# Petición autenticada desde dentro del contenedor. El secreto se lee del fichero y sólo
# viaja en la cabecera hacia 127.0.0.1; la ruta es el único argumento.
JS='const fs=require("fs");
const f=process.env.STREAMER_CONTROL_SECRET_FILE;
const s=f?fs.readFileSync(f,"utf8").trim():"";
const port=process.env.STREAMER_CONTROL_PORT||"8090";
fetch("http://127.0.0.1:"+port+process.argv[1],{headers:s?{"x-streamer-auth":s}:{}})
  .then(async r=>{const b=Buffer.from(await r.arrayBuffer());if(!r.ok){process.stderr.write("HTTP "+r.status+" "+b.toString().slice(0,200)+"\n");process.exit(1)}process.stdout.write(b)})
  .catch(e=>{process.stderr.write(String(e&&e.message)+"\n");process.exit(1)});'

get() { "${EXEC[@]}" node -e "$JS" "$1" >"$OUT/$2"; }

get /diag/tap status.json
if ! grep -q '"enabled":true' "$OUT/status.json"; then
  echo "tap APAGADO (STREAM_TAP_ENABLED no es true): nada que leer"
  exit 0
fi
get /diag/tap/latest latest.json
get /diag/tap/latest.flv latest.flv
get /diag/tap/latest.jpg latest.jpg
echo "última captura: $(cat "$OUT/latest.json")"
ls -l "$OUT"
