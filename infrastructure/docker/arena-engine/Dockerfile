# arena-engine (dosier 6.2): motor determinista + servidor de protocolo arena/1.
# Contexto de build: raíz del repo.
#
# El motor (apps/arena-engine/src/sim) y el ProtocolServer (protocol-server.ts)
# existen y están probados. El entrypoint de SERVICIO de larga duración
# (apps/arena-engine/src/service.ts, B1) es el que fija el Compose por
# defecto (SERVICE_ENTRY); la CLI (cli.ts, una batalla y termina) sigue
# disponible como valor por defecto de esta imagen para uso auditable manual.
FROM node:22.15-alpine

WORKDIR /app

COPY package.json package-lock.json tsconfig.json vitest.config.ts ./
COPY packages ./packages
COPY sdks/javascript ./sdks/javascript
RUN npm ci --ignore-scripts

COPY apps/arena-engine ./apps/arena-engine
# service.ts (B1) importa por ruta relativa
# apps/bot-manager/src/container-battle.js y .../container-runner.js: el
# entrypoint de servicio delega la orquestación de la batalla en el
# bot-manager (R6.2). Es el mismo import cruzado entre apps del monorepo
# que documenta infrastructure/docker/node-service/Dockerfile — aquí se
# copia solo apps/bot-manager (no apps/ completo) porque arena-engine no
# necesita el resto (api, web, gateway...). Sin este COPY la imagen arranca
# y muere con ERR_MODULE_NOT_FOUND en el primer import cruzado.
COPY apps/bot-manager ./apps/bot-manager
COPY maps ./maps

# B13 · Aquí NO se siembra ningún directorio de datos, y es deliberado.
# B7 añadió `mkdir -p /data/replays /data/logs` porque este servicio montaba
# esos volúmenes y podía ser el primero en crearlos (root:root) para quien sí
# escribe en ellos. B13 comprobó que arena-engine no toca /data en NINGÚN
# archivo y le retiró los tres montajes en el Compose: sin montajes, sembrar
# directorios en la imagen sería código muerto que solo confunde sobre quién es
# el dueño del volumen.

USER node

ENV SERVICE_ENTRY=apps/arena-engine/src/cli.ts
CMD npx tsx "$SERVICE_ENTRY"

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
ARG SERVICE_NAME=arena-engine
ENV BUILD_COMMIT=${BUILD_COMMIT} \
    BUILD_DATE=${BUILD_DATE} \
    SERVICE_NAME=${SERVICE_NAME}
LABEL org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.title="${SERVICE_NAME}" \
      org.opencontainers.image.source="https://github.com/pjclavero/s9-ai-arena"
