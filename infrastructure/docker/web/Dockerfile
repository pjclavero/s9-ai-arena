# Panel web (E7 · T7.4): SPA de React+Vite. No es un servicio Node — se compila
# a estáticos y los sirve nginx. Por eso no usa node-service/Dockerfile.
# Contexto de build: raíz del repo.
FROM node:22.15-alpine AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json vitest.config.ts ./
COPY packages ./packages
COPY sdks/javascript ./sdks/javascript
RUN npm ci --ignore-scripts

COPY apps/web ./apps/web
RUN npx vite build apps/web

FROM nginx:1.27-alpine
COPY infrastructure/docker/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 3000

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
ARG SERVICE_NAME=web
ENV BUILD_COMMIT=${BUILD_COMMIT} \
    BUILD_DATE=${BUILD_DATE} \
    SERVICE_NAME=${SERVICE_NAME}
LABEL org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.title="${SERVICE_NAME}" \
      org.opencontainers.image.source="https://github.com/pjclavero/s9-ai-arena"

# ADR-016 - imagen nginx: /version se sirve como fichero estatico generado
# en el build (no hay proceso Node que lo componga). Lo publica el
# `location = /version` de la conf correspondiente.
RUN printf '{"service":"%s","commit":"%s","builtAt":"%s"}' \
      "${SERVICE_NAME}" "${BUILD_COMMIT}" "${BUILD_DATE}" > /usr/share/nginx/html/version.json \
 && chmod 0644 /usr/share/nginx/html/version.json
