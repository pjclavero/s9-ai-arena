# s9-smoke-bot — imagen para pruebas E2E de arena/1.
#
# Usa el runtime de Node ya construido (ghcr.io/pjclavero/s9-ai-arena/bot-runtime-node)
# como base: incluye node, ws y @arena/sdk ya instalados, usuario 10001 no-root,
# sistema de archivos de solo lectura, sin gestores de paquetes.
#
# El smoke bot está escrito en JS puro (CJS, main.js) sin TypeScript ni dependencias
# propias: se copia directamente al punto de entrada /bot/main.js.
#
# Contexto de build: directorio bots/s9-smoke-bot/
#   docker build -t s9-smoke-bot:local -f bots/s9-smoke-bot/Dockerfile bots/s9-smoke-bot/
#
# Digest de la imagen base fijado en runtimes/DIGESTS.lock (R6.1).
# Actualizar cuando se republique el runtime.
FROM ghcr.io/pjclavero/s9-ai-arena/bot-runtime-node@sha256:b5f0be3b155e8a3f9e63b5684a3ec006ef9392afbd8176307487ddc3c9553a1f

# El runtime ya declara USER 10001:10001 y WORKDIR /bot.
# Solo copiamos el código del bot.
COPY main.js /bot/main.js

# Variables de entorno requeridas en ejecución (sin valores por defecto: el
# orchestrador de batalla DEBE inyectarlas explícitamente):
#   ARENA_WS_URL    ws://<host>:<port>  (ProtocolServer del motor)
#   BOT_ID          ID del bot en la batalla
#   BATTLE_TOKEN    Token para el handshake arena/1

# Imagen de solo lectura: el tmpfs /tmp lo gestiona el compose/proxy de Docker.
# ENTRYPOINT y CMD heredados del runtime: ["node", "/bot/main.js"]
