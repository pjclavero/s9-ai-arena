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

USER node

ENV SERVICE_ENTRY=apps/arena-engine/src/cli.ts
CMD npx tsx "$SERVICE_ENTRY"
