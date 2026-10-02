FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache git
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/integrity-domain/ ./apps/integrity-domain/

RUN pnpm install --frozen-lockfile || pnpm install
RUN pnpm --filter integrity-domain exec hardhat build

EXPOSE 8545

CMD ["/bin/sh", "apps/integrity-domain/scripts/start-node.sh"]
