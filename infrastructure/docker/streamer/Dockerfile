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
RUN apk add --no-cache chromium ffmpeg xvfb bash nodejs npm su-exec \
 && npm install -g tsx@4 \
 && npm cache clean --force

COPY tsconfig.json /app/tsconfig.json
COPY apps/streamer /app/apps/streamer
# B13 · El preflight del directorio de datos vive en packages/data-dir porque lo
# comparten imágenes distintas. Sin este COPY, main.ts revienta DENTRO de la
# imagen con ERR_MODULE_NOT_FOUND aunque funcione en el monorepo.
COPY packages/data-dir /app/packages/data-dir
# B13 · Mismo motivo, distinto paquete: metrics.ts importa `emptyDict` de
# packages/game-rules/safe-lookup.js (B8, cierre del patrón `__proto__` en el
# acumulador que se rellena con claves parseadas de la salida de ffmpeg). Sin
# este COPY la imagen arranca y revienta con
# `Cannot find module '../../../packages/game-rules/safe-lookup.js'`.
# Se copia SOLO ese fichero, no el paquete entero: es autocontenido (cero
# imports) y el streamer no usa nada más de game-rules.
COPY packages/game-rules/safe-lookup.ts /app/packages/game-rules/safe-lookup.ts
COPY infrastructure/docker/streamer/entrypoint.sh /entrypoint.sh
# B13 · MISMO entrypoint de datos que la imagen genérica (no un mecanismo
# paralelo): ajusta la propiedad de ARENA_DATA_DIRS como root y baja a
# `streamer` con su-exec antes de ejecutar nada del servicio.
COPY infrastructure/docker/node-service/entrypoint.sh /data-dir-entrypoint.sh
RUN chmod 0755 /data-dir-entrypoint.sh
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

# B13 · El drop de privilegios ya no lo hace `USER streamer` sino
# /data-dir-entrypoint.sh (su-exec), igual que en la imagen genérica: hace falta
# arrancar como root un instante para poder ajustar la propiedad del directorio
# de grabación cuando el volumen se recrea.
# HOME EXPLÍCITO: `su-exec` no cambia el entorno, así que sin esto el proceso se
# quedaría con HOME=/root —que `streamer` no puede escribir— en vez del que
# ponía `USER streamer`.
ENV DISPLAY=:99 \
    CHROMIUM_BIN=/usr/bin/chromium-browser \
    FFMPEG_BIN=/usr/bin/ffmpeg \
    SERVICE_ENTRY=/app/apps/streamer/src/main.ts \
    ARENA_SERVICE_USER=streamer \
    HOME=/home/streamer

# Prueba VIVA dentro de la imagen (lección del proyecto: "funciona en el
# monorepo, falla en la imagen"). Comprueba de verdad, en cada build de la CI,
# que (1) el entrypoint de datos baja a `streamer` con el HOME correcto, (2) tras
# el chown acotado del volumen el usuario puede CREARSE `video/` y escribir
# dentro —que es justo lo que sustituye a declarar la ruta profunda—, y (3) el
# preflight de Node RESUELVE su import desde la ruta real de la imagen y aborta
# de verdad. Si algo se rompe, el build falla aquí en vez de fallar callado en
# producción. `ARENA_DATA_DIRS` es el MISMO valor que declara el Compose.
RUN ARENA_DATA_DIRS=/data/replays /data-dir-entrypoint.sh sh -euc '\
      test "$(id -un)" = streamer || { echo "el entrypoint no bajo a streamer: $(id -un)"; exit 1; }; \
      test -w "$HOME" || { echo "HOME=$HOME no es escribible por streamer"; exit 1; }; \
      rm -rf /data/replays/video; \
      mkdir -p /data/replays/video || { echo "streamer no puede crearse su subdirectorio en el volumen"; exit 1; }; \
      touch /data/replays/video/.build-probe && rm /data/replays/video/.build-probe; \
      test "$(stat -c %u:%g /data/replays/video)" = "1000:1000" || { echo "video/ no nace con uid:gid 1000"; exit 1; }; \
      mkdir -p /tmp/probe-ro && chmod 555 /tmp/probe-ro; \
      if salida=$(STREAM_MODE=record RECORD_DIR=/tmp/probe-ro tsx /app/apps/streamer/src/main.ts 2>&1); then \
        echo "el preflight NO abortó con un directorio no escribible: $salida"; exit 1; \
      fi; \
      case "$salida" in \
        *ERR_MODULE_NOT_FOUND*) echo "el import del preflight no resuelve DENTRO de la imagen: $salida"; exit 1 ;; \
        *\"service\":\"streamer\"*) ;; \
        *) echo "sin diagnóstico accionable del preflight: $salida"; exit 1 ;; \
      esac; \
      rmdir /tmp/probe-ro' \
 && test "$(stat -c %u:%g /data/replays)" = "1000:1000"

ENTRYPOINT ["/data-dir-entrypoint.sh", "/entrypoint.sh"]
