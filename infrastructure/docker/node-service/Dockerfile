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

# B13 · HOME EXPLÍCITO. `su-exec` (a diferencia de `su -`) NO cambia el entorno:
# al bajar de root a `node` el proceso se quedaba con HOME=/root, que `node` no
# puede escribir. El CMD arranca con `npx tsx`, y npm/npx escriben en $HOME
# (~/.npm, ~/.npm/_npx): con HOME=/root eso son avisos EACCES en el mejor caso.
# Con `USER node` (antes de B7) HOME lo ponía Docker; al mover el drop al
# entrypoint hay que fijarlo aquí a mano. La prueba de abajo lo comprueba
# escribiendo de verdad en $HOME como `node`.
ENV HOME=/home/node

# Pruebas vivas DENTRO de la imagen, no en el monorepo (lección del proyecto:
# "funciona en el repo, falla en la imagen"). Se ejecutan en CADA build de la
# etapa 5 de la CI; si algo de esto se rompiera, el build falla aquí en vez de
# fallar callado en producción.
#
# (1) su-exec existe, el entrypoint baja a `node`, `chown -h` es compatible con
#     el chown de esta imagen y el usuario `node` puede ESCRIBIR en el
#     directorio de datos.
RUN ARENA_DATA_DIRS=/data/replays /entrypoint.sh sh -euc '\
      test "$(id -un)" = node || { echo "el entrypoint no bajó a node: $(id -un)"; exit 1; }; \
      test -w "$HOME" || { echo "HOME=$HOME no es escribible por node (npx escribe ahí)"; exit 1; }; \
      touch /data/replays/.build-probe && rm /data/replays/.build-probe' \
 && test "$(stat -c %u:%g /data/replays)" = "1000:1000"

# (2) Las cuatro evasiones que reportó el Supervisor (O1-O4), comprobadas SOBRE
#     ESTA IMAGEN, como root y contra un /data real. Es la verificación viva del
#     guard que SÍ corre en la CI: los espacios de nombres sin privilegios
#     (`unshare -rm`, que usa infrastructure/tests/fixtures/
#     entrypoint-ns-harness.sh) están restringidos por AppArmor en los runners
#     de Ubuntu 24.04, así que la suite de vitest no puede probar esto allí.
#     Cada bloque comprueba que el entrypoint ABORTA y que NADA cambió de dueño.
#     Sin comentarios `#` dentro del RUN: las continuaciones se unen en UNA
#     línea antes de llegar al shell, así que un comentario dentro se comería el
#     resto del comando. Los marcadores van por `echo`, y así el log del build
#     enseña qué se comprobó. `probe-uno`/`probe-dos` son de root (uid 0) a
#     propósito: si el guard fallara, pasarían a 1000 y el `test` lo cazaría.
RUN set -eu; \
    mkdir -p /data/probe-uno /data/probe-dos; \
    echo "probe O1a · enlace simbolico en el ultimo componente"; \
    ln -s /etc /data/probe-enlace; \
    if ARENA_DATA_DIRS=/data/probe-enlace /entrypoint.sh true; then \
      echo "FALLO O1a: aceptado un enlace simbolico dentro de /data"; exit 1; fi; \
    test "$(stat -c %u:%g /etc)" = "0:0"; \
    rm /data/probe-enlace; \
    echo "probe O1b · enlace simbolico en un componente intermedio"; \
    ln -s /etc /data/probe-sub; \
    if ARENA_DATA_DIRS=/data/probe-sub/x /entrypoint.sh true; then \
      echo "FALLO O1b: aceptado un enlace intermedio"; exit 1; fi; \
    test "$(stat -c %u:%g /etc)" = "0:0"; \
    test ! -e /etc/x; \
    rm /data/probe-sub; \
    echo "probe O2 · el patron no se expande contra el disco"; \
    if ARENA_DATA_DIRS='/data/*' /entrypoint.sh true; then \
      echo "FALLO O2: patron expandido"; exit 1; fi; \
    test "$(stat -c %u /data/probe-uno)" = "0"; \
    test "$(stat -c %u /data/probe-dos)" = "0"; \
    echo "probe O3 · formas no canonicas"; \
    if ARENA_DATA_DIRS=/data/probe-uno/. /entrypoint.sh true; then \
      echo "FALLO O3: aceptado /data/probe-uno/."; exit 1; fi; \
    if ARENA_DATA_DIRS=/data//probe-uno /entrypoint.sh true; then \
      echo "FALLO O3: aceptado /data//probe-uno"; exit 1; fi; \
    test "$(stat -c %u /data/probe-uno)" = "0"; \
    echo "probe O4 · sin efectos parciales al abortar"; \
    if ARENA_DATA_DIRS='/data/probe-uno /etc' /entrypoint.sh true; then \
      echo "FALLO O4: aceptado /etc"; exit 1; fi; \
    test "$(stat -c %u /data/probe-uno)" = "0"; \
    rmdir /data/probe-uno /data/probe-dos; \
    echo "probe OK · el guard del entrypoint resiste O1-O4 dentro de la imagen"

ENTRYPOINT ["/entrypoint.sh"]

# SERVICE_ENTRY lo fija el Compose por servicio.
CMD if [ -f "$SERVICE_ENTRY" ]; then npx tsx "$SERVICE_ENTRY"; \
    else echo "{\"level\":\"error\",\"service\":\"$APP_PATH\",\"msg\":\"SERVICE_ENTRY $SERVICE_ENTRY no existe: revisa el entrypoint del servicio en el Compose\"}" && exit 1; fi
