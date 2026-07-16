# streamer (dosier 6.2, cap. 21): Chromium + FFmpeg, opcional (perfil streaming).
# Contexto de build: raíz del repo.
#
# PENDIENTE (E11): el script de captura real (vista /broadcast → RTMPS) es del
# equipo de streaming. Esta imagen deja las herramientas instaladas y el
# contrato de entorno (BROADCAST_URL, RTMPS_URL, STREAM_KEY_FILE).
FROM alpine:3.20

RUN apk add --no-cache chromium ffmpeg xvfb bash

COPY infrastructure/docker/streamer/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && adduser -D streamer
USER streamer

ENTRYPOINT ["/entrypoint.sh"]
