# arena-engine (dosier 6.2): motor determinista + servidor de protocolo arena/1.
# Contexto de build: raíz del repo.
#
# El motor (apps/arena-engine/src/sim) y el ProtocolServer (protocol-server.ts)
# existen y están probados; el entrypoint de SERVICIO de larga duración
# (orquestar una batalla por trabajo de la cola) es de E2/E9 y se fija con
# SERVICE_ENTRY cuando exista. Mientras tanto la imagen expone la CLI auditable.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json tsconfig.json vitest.config.ts ./
COPY packages ./packages
COPY sdks/javascript ./sdks/javascript
RUN npm ci --ignore-scripts

COPY apps/arena-engine ./apps/arena-engine
COPY maps ./maps

USER node

ENV SERVICE_ENTRY=apps/arena-engine/src/cli.ts
CMD npx tsx "$SERVICE_ENTRY"
