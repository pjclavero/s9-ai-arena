FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY bots/bot-red/package.json bots/bot-red/package.json
RUN pnpm install --filter @s9/bot-red... --frozen-lockfile=false
COPY packages/protocol packages/protocol
COPY bots/bot-red bots/bot-red
RUN pnpm --filter @s9/protocol build && pnpm --filter @s9/bot-red build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/bots/bot-red/package.json ./bots/bot-red/package.json
COPY --from=build /app/bots/bot-red/dist ./bots/bot-red/dist
CMD ["node", "bots/bot-red/dist/index.js"]
