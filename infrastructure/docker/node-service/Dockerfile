# Imagen genérica para los servicios Node del monorepo (api, web, workers…).
# Contexto de build: raíz del repo. Cada servicio del Compose fija APP_PATH
# (build arg) y SERVICE_ENTRY (env) con su entrypoint.
#
# PENDIENTE de los equipos propietarios: los entrypoints de web, api,
# tournament-worker, bot-manager y replay-service aún no existen (E7/E9/E6);
# la imagen construye igualmente y falla al arrancar con un mensaje claro.
FROM node:22-alpine

WORKDIR /app

# Dependencias del workspace (npm workspaces, ADR-010 D10.1).
COPY package.json package-lock.json tsconfig.json vitest.config.ts ./
COPY packages ./packages
COPY sdks/javascript ./sdks/javascript
RUN npm ci --ignore-scripts

ARG APP_PATH
COPY ${APP_PATH} ./${APP_PATH}
ENV APP_PATH=${APP_PATH}

# Usuario sin privilegios.
USER node

# SERVICE_ENTRY lo fija el Compose por servicio.
CMD if [ -f "$SERVICE_ENTRY" ]; then npx tsx "$SERVICE_ENTRY"; \
    else echo "{\"level\":\"error\",\"service\":\"$APP_PATH\",\"msg\":\"SERVICE_ENTRY $SERVICE_ENTRY no existe todavía: el equipo propietario debe aportar el entrypoint (ver infrastructure/docker/node-service/Dockerfile)\"}" && exit 1; fi
