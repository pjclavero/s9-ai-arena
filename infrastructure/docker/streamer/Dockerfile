# streamer (dosier 6.2, cap. 21 · E11/T11.2): Chromium + FFmpeg + supervisor Node.
# Contexto de build: raíz del repo.
#
# Captura la vista /broadcast (T11.1) con Chromium en kiosco sobre un Xvfb y la
# codifica con FFmpeg hacia YouTube RTMPS (x264 por software como base; NVENC
# opcional si el host tiene GPU con passthrough — ver docs/streaming-runbook.md).
# La clave de emisión entra SOLO por /run/secrets/stream_key (init-secrets.sh).
FROM alpine:3.20

# tsx ejecuta el supervisor TypeScript sin paso de build (mismo criterio que
# node-service). El streamer solo usa builtins de Node: no necesita npm ci.
RUN apk add --no-cache chromium ffmpeg xvfb bash nodejs npm \
 && npm install -g tsx@4 \
 && npm cache clean --force

COPY tsconfig.json /app/tsconfig.json
COPY apps/streamer /app/apps/streamer
COPY infrastructure/docker/streamer/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && adduser -D streamer
USER streamer

ENV DISPLAY=:99 \
    CHROMIUM_BIN=/usr/bin/chromium-browser \
    FFMPEG_BIN=/usr/bin/ffmpeg \
    SERVICE_ENTRY=/app/apps/streamer/src/main.ts

ENTRYPOINT ["/entrypoint.sh"]
