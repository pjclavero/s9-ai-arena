# Imagen del bot-manager (API/control) y del bot-build-worker (pipeline de
# build/análisis/firma, E6/R2.5). Comparten imagen (mismo APP_PATH=apps/bot-manager,
# ver infrastructure/docker-compose.yml) y por eso comparten Dockerfile.
#
# B3 (diagnóstico real de producción): esta imagen es IDÉNTICA a la genérica
# infrastructure/docker/node-service/Dockerfile MÁS `python3`. No se añade
# python3 a la genérica porque la usan api, web, map-service, replay-service y
# tournament-worker, que NO lo necesitan — meterlo ahí sería ampliar la
# superficie de ataque de servicios que nunca ejecutan ni analizan Python.
#
# Por qué SÍ lo necesita esta imagen: apps/bot-manager/src/ast-analysis.ts
# analiza el AST real de los bots Python con el módulo `ast` de la librería
# estándar de CPython (spawnSync("python3", ...)), el mismo intérprete que
# ejecutará el bot en su runtime (runtimes/python). Es la vía FAIL-CLOSED de
# R2.4 (ERR-SEC-06/07): sin python3 en el PATH, todo bot Python se rechaza en
# la etapa static_analysis con "spawnSync python3 ENOENT" — nunca se aprueba
# lo que no se pudo analizar, pero el resultado real es que NINGÚN bot Python
# podía validarse jamás. Solo se instala el intérprete: sin pip, sin
# paquetes de terceros — el analizador embebido (PY_ANALYZER en
# ast-analysis.ts) solo usa `ast` y `json`, de la librería estándar.
FROM node:22.15-alpine

WORKDIR /app

# python3 de Alpine (paquete del sistema, sin pip): únicamente el intérprete
# para el análisis AST fail-closed descrito arriba. `--no-cache` evita dejar
# el índice de apk en la imagen final.
RUN apk add --no-cache python3

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
# (B3; ver apps/api/src/db/seeds/demo-teams.ts).
COPY bots/s9-smoke-bot/main.py ./bots/s9-smoke-bot/main.py

ARG APP_PATH
ENV APP_PATH=${APP_PATH}

# Usuario sin privilegios.
USER node

# SERVICE_ENTRY lo fija el Compose por servicio.
CMD if [ -f "$SERVICE_ENTRY" ]; then npx tsx "$SERVICE_ENTRY"; \
    else echo "{\"level\":\"error\",\"service\":\"$APP_PATH\",\"msg\":\"SERVICE_ENTRY $SERVICE_ENTRY no existe: revisa el entrypoint del servicio en el Compose\"}" && exit 1; fi

# -- ADR-016 - IDENTIDAD DE BUILD (procedencia de imagen) ---------------------
# Va AL FINAL a proposito: un ARG invalida la cache de todas las capas que le
# siguen, y estos tres valores cambian en CADA build. Puestos aqui, cambiar de
# commit no obliga a repetir `npm ci` ni los COPY.
#
# Por que existe: dos incidentes reales (docs/decisiones/ADR-016-identidad-de-build.md).
# Uno construyo el arbol VIEJO y lo etiqueto con el commit NUEVO; el gate de
# entonces solo comparaba "imagen declarada == imagen desplegada", una
# tautologia cuando la etiqueta miente. Con esto el commit VIAJA DENTRO de la
# imagen: como ENV (lo lee el proceso y lo sirve en /version) y como LABEL OCI
# (lo lee `docker image inspect` sin arrancar nada).
ARG BUILD_COMMIT=unknown
ARG BUILD_DATE=unknown
ARG SERVICE_NAME=bot-manager
ENV BUILD_COMMIT=${BUILD_COMMIT} \
    BUILD_DATE=${BUILD_DATE} \
    SERVICE_NAME=${SERVICE_NAME}
LABEL org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.title="${SERVICE_NAME}" \
      org.opencontainers.image.source="https://github.com/pjclavero/s9-ai-arena"
