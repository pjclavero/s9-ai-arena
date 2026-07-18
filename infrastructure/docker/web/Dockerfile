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
