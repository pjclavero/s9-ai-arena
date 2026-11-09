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
#
# B13 · Este script ya NO es el ENTRYPOINT de la imagen: lo invoca
# /data-dir-entrypoint.sh (el mismo de la imagen genérica) DESPUÉS de ajustar la
# propiedad de ARENA_DATA_DIRS y de bajar a `streamer` con su-exec. O sea: todo
# lo de aquí abajo —Xvfb incluido— corre sin privilegios, igual que antes.
set -euo pipefail

: "${DISPLAY:=:99}"
: "${STREAM_WIDTH:=1920}"
: "${STREAM_HEIGHT:=1080}"

DISPLAY_NUM="${DISPLAY#:}"
DISPLAY_NUM="${DISPLAY_NUM%%.*}"
X_LOCK="/tmp/.X${DISPLAY_NUM}-lock"
X_SOCK="/tmp/.X11-unix/X${DISPLAY_NUM}"

# #251 · Tras un `docker restart` el sistema de ficheros del contenedor se conserva, y con él
# el lock y el socket del Xvfb anterior: Xvfb se negaba a arrancar («Server is already active
# for display») y FFmpeg daba «Cannot open display». Se borran SÓLO si el PID del lock no es un
# Xvfb vivo. No basta `kill -0`: tras el reinicio los PID se reutilizan (el del lock puede ser
# ahora este mismo shell).
if [ -e "$X_LOCK" ]; then
  LOCK_PID="$(tr -dc '0-9' <"$X_LOCK" 2>/dev/null || true)"
  if [ -n "$LOCK_PID" ] && [ "$(cat "/proc/$LOCK_PID/comm" 2>/dev/null || true)" = "Xvfb" ]; then
    echo "entrypoint: el display :$DISPLAY_NUM ya lo usa un Xvfb vivo (pid $LOCK_PID)" >&2
    exit 1
  fi
  echo "entrypoint: lock de X rancio en $X_LOCK (pid ${LOCK_PID:-?} sin Xvfb): se limpia" >&2
  rm -f "$X_LOCK" "$X_SOCK"
elif [ -e "$X_SOCK" ]; then
  rm -f "$X_SOCK" # socket sin lock: de un Xvfb que ya no existe
fi

Xvfb "$DISPLAY" -screen 0 "${STREAM_WIDTH}x${STREAM_HEIGHT}x24" -nolisten tcp &
XVFB_PID=$!
trap 'kill "$XVFB_PID" 2>/dev/null || true' EXIT

# Espera a que ESTE Xvfb esté vivo y su socket exista. Si muere, se falla cerrado: un
# supervisor sin display aceptaría órdenes que nunca podría cumplir.
ready=0
for _ in $(seq 1 50); do
  if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    echo "entrypoint: Xvfb terminó al arrancar en :$DISPLAY_NUM" >&2
    exit 1
  fi
  if [ -S "$X_SOCK" ]; then
    ready=1
    break
  fi
  sleep 0.1
done
if [ "$ready" != 1 ]; then
  echo "entrypoint: Xvfb no creó $X_SOCK a tiempo" >&2
  exit 1
fi

exec tsx "${SERVICE_ENTRY:-/app/apps/streamer/src/main.ts}"
