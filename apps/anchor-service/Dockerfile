FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-workspace.yaml ./
COPY packages/ ./packages/
COPY apps/anchor-service/ ./apps/anchor-service/

RUN pnpm install --frozen-lockfile || pnpm install
RUN pnpm --filter anchor-service build

FROM node:22-alpine AS runner

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/packages/ ./packages/
COPY --from=builder /app/apps/anchor-service/ ./apps/anchor-service/

ENV NODE_ENV=production

CMD ["pnpm", "--filter", "anchor-service", "start"]
