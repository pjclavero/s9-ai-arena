# Imagen genérica para los servicios Node del monorepo (api, workers…).
# Contexto de build: raíz del repo. Cada servicio del Compose fija APP_PATH
# (build arg) y SERVICE_ENTRY (env) con su entrypoint.
#
# Se copia apps/ COMPLETO, no solo ${APP_PATH}: las apps del monorepo se
# importan entre sí por ruta relativa (el worker usa apps/api/src/db, la API usa
# apps/arena-engine/src/replay…). Copiar una sola app rompe con
# ERR_MODULE_NOT_FOUND en el primer import cruzado.
FROM node:22-alpine

WORKDIR /app

# Dependencias del workspace (npm workspaces, ADR-010 D10.1).
COPY package.json package-lock.json tsconfig.json vitest.config.ts ./
COPY packages ./packages
COPY sdks/javascript ./sdks/javascript
RUN npm ci --ignore-scripts

COPY apps ./apps
COPY maps ./maps

ARG APP_PATH
ENV APP_PATH=${APP_PATH}

# Usuario sin privilegios.
USER node

# SERVICE_ENTRY lo fija el Compose por servicio.
CMD if [ -f "$SERVICE_ENTRY" ]; then npx tsx "$SERVICE_ENTRY"; \
    else echo "{\"level\":\"error\",\"service\":\"$APP_PATH\",\"msg\":\"SERVICE_ENTRY $SERVICE_ENTRY no existe: revisa el entrypoint del servicio en el Compose\"}" && exit 1; fi
