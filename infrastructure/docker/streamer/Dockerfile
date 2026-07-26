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
# uid explícito 1000: el streamer monta `arena_replays` en rw (modo grabación
# E11.M escribe en /data/replays/video) y debe compartir uid con el `node` de
# las imágenes node-service, que son las dueñas del volumen (B7). Antes era el
# uid que le tocara a `adduser -D`.
RUN chmod +x /entrypoint.sh && adduser -D -u 1000 streamer
# B7 · Siembra del directorio de datos con la propiedad correcta: si el
# streamer fuera el primer contenedor en montar `arena_replays`, sin esto el
# volumen nacería root:root y el replay-service no podría escribir (defecto
# real de VM108).
RUN mkdir -p /data/replays/video && chown -R streamer:streamer /data
USER streamer

ENV DISPLAY=:99 \
    CHROMIUM_BIN=/usr/bin/chromium-browser \
    FFMPEG_BIN=/usr/bin/ffmpeg \
    SERVICE_ENTRY=/app/apps/streamer/src/main.ts

ENTRYPOINT ["/entrypoint.sh"]
