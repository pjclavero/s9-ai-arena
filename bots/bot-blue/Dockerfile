FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY bots/bot-blue/package.json bots/bot-blue/package.json
RUN pnpm install --filter @s9/bot-blue... --frozen-lockfile=false
COPY packages/protocol packages/protocol
COPY bots/bot-blue bots/bot-blue
RUN pnpm --filter @s9/protocol build && pnpm --filter @s9/bot-blue build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/bots/bot-blue/package.json ./bots/bot-blue/package.json
COPY --from=build /app/bots/bot-blue/dist ./bots/bot-blue/dist
CMD ["node", "bots/bot-blue/dist/index.js"]
