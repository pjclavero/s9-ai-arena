# Imagen genérica para los servicios Node del monorepo (api, workers…).
# Contexto de build: raíz del repo. Cada servicio del Compose fija APP_PATH
# (build arg) y SERVICE_ENTRY (env) con su entrypoint.
#
# Se copia apps/ COMPLETO, no solo ${APP_PATH}: las apps del monorepo se
# importan entre sí por ruta relativa (el worker usa apps/api/src/db, la API usa
# apps/arena-engine/src/replay…). Copiar una sola app rompe con
# ERR_MODULE_NOT_FOUND en el primer import cruzado.
FROM node:22.15-alpine

WORKDIR /app

# B7 · su-exec: bajar de root a `node` en el entrypoint (ver entrypoint.sh).
# Es lo único que se añade a la imagen; no hay shell de login ni setuid nuevos.
RUN apk add --no-cache su-exec

# Dependencias del workspace (npm workspaces, ADR-010 D10.1).
COPY package.json package-lock.json tsconfig.json vitest.config.ts ./
COPY packages ./packages
COPY sdks/javascript ./sdks/javascript
RUN npm ci --ignore-scripts

COPY apps ./apps
COPY maps ./maps
# Bots de ejemplo: son el código fuente que `cli.ts demo-teams` carga para crear
# plantillas jugables en una instancia real. Sin ellos el comando falla con ENOENT.
COPY example-bots ./example-bots
# bots/s9-smoke-bot/main.py: uno de los tres bots de la plantilla de demo-teams
# (B3, el rol "Artillero" pasó de TypeScript a este Python real; ver
# apps/api/src/db/seeds/demo-teams.ts). Solo el código fuente, no su Dockerfile
# ni el resto de bots/bot-red|bot-blue (esos no los usa este servicio).
COPY bots/s9-smoke-bot/main.py ./bots/s9-smoke-bot/main.py

ARG APP_PATH
ENV APP_PATH=${APP_PATH}

# B7 · Directorio de datos SEMBRADO en la imagen con la propiedad correcta.
# Cuando Docker monta un volumen VACÍO sobre una ruta que SÍ existe en la
# imagen, copia su contenido y su propiedad al volumen; si la ruta no existe en
# la imagen, el volumen nace root:root (eso es lo que rompió `arena_replays` en
# VM108). Sembrarlo aquí hace que un despliegue desde cero nazca bien aunque el
# primer contenedor en montar el volumen sea otro servicio.
RUN mkdir -p /data/replays && chown node:node /data /data/replays

# B7 · Entrypoint que ajusta la propiedad de ARENA_DATA_DIRS (acotado a /data/)
# y BAJA A `node` con su-exec. Sustituye a la instrucción `USER node`: el
# proceso del servicio sigue corriendo sin privilegios (lo prueba el RUN de
# abajo, que se ejecuta en CADA build de la etapa 5 de la CI).
COPY infrastructure/docker/node-service/entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh

# Prueba viva DENTRO de la imagen, no en el monorepo (lección del proyecto:
# "funciona en el repo, falla en la imagen"). Comprueba de verdad que
# (1) su-exec existe y el entrypoint baja a `node`, y (2) tras el chown acotado
# el usuario `node` puede ESCRIBIR en el directorio de datos. Si algo de esto
# se rompiera, el build falla aquí en vez de fallar callado en producción.
RUN ARENA_DATA_DIRS=/data/replays /entrypoint.sh sh -euc '\
      test "$(id -un)" = node || { echo "el entrypoint no bajó a node: $(id -un)"; exit 1; }; \
      touch /data/replays/.build-probe && rm /data/replays/.build-probe' \
 && test "$(stat -c %u:%g /data/replays)" = "1000:1000"

ENTRYPOINT ["/entrypoint.sh"]

# SERVICE_ENTRY lo fija el Compose por servicio.
CMD if [ -f "$SERVICE_ENTRY" ]; then npx tsx "$SERVICE_ENTRY"; \
    else echo "{\"level\":\"error\",\"service\":\"$APP_PATH\",\"msg\":\"SERVICE_ENTRY $SERVICE_ENTRY no existe: revisa el entrypoint del servicio en el Compose\"}" && exit 1; fi
