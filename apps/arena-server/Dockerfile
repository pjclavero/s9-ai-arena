FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/arena-server/package.json apps/arena-server/package.json
RUN pnpm install --filter @s9/arena-server... --frozen-lockfile=false
COPY packages/protocol packages/protocol
COPY apps/arena-server apps/arena-server
RUN pnpm --filter @s9/protocol build && pnpm --filter @s9/arena-server build

FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/apps/arena-server/package.json ./apps/arena-server/package.json
COPY --from=build /app/apps/arena-server/dist ./apps/arena-server/dist
CMD ["node", "apps/arena-server/dist/index.js"]
