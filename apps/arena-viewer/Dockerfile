FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
ARG VITE_ARENA_WS_URL
ENV VITE_ARENA_WS_URL=$VITE_ARENA_WS_URL
COPY package.json pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/arena-viewer/package.json apps/arena-viewer/package.json
RUN pnpm install --filter @s9/arena-viewer... --frozen-lockfile=false
COPY packages/protocol packages/protocol
COPY apps/arena-viewer apps/arena-viewer
RUN pnpm --filter @s9/protocol build && pnpm --filter @s9/arena-viewer build

FROM nginx:1.27-alpine
COPY apps/arena-viewer/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/arena-viewer/dist /usr/share/nginx/html
