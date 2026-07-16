#!/bin/bash
# Entrypoint del streamer (E11/T11.2): Xvfb + supervisor de emisión.
#
# 1. Levanta un framebuffer X (Xvfb) al tamaño EXACTO de emisión: ahí pinta
#    Chromium la vista /broadcast y de ahí captura FFmpeg (x11grab).
# 2. Ejecuta el supervisor (apps/streamer/src/main.ts): API interna de control
#    (start/stop/status/metrics) y reintentos ante corte de RTMPS.
#
# La clave RTMPS se lee del archivo de secreto (STREAM_KEY_FILE) DENTRO del
# proceso Node; este script no la toca ni la exporta: no puede acabar en logs
# ni en `docker inspect`.
set -euo pipefail

: "${DISPLAY:=:99}"
: "${STREAM_WIDTH:=1920}"
: "${STREAM_HEIGHT:=1080}"

Xvfb "$DISPLAY" -screen 0 "${STREAM_WIDTH}x${STREAM_HEIGHT}x24" -nolisten tcp &
XVFB_PID=$!
trap 'kill "$XVFB_PID" 2>/dev/null || true' EXIT

# Espera corta a que el display exista antes de arrancar nada encima.
for _ in $(seq 1 50); do
  if [ -e "/tmp/.X11-unix/X${DISPLAY#:}" ]; then break; fi
  sleep 0.1
done

exec tsx "${SERVICE_ENTRY:-/app/apps/streamer/src/main.ts}"
