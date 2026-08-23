FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/data-domain/ ./apps/data-domain/

RUN pnpm install --frozen-lockfile || pnpm install
RUN pnpm --filter data-domain typecheck

FROM node:22-alpine AS runner

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/tsconfig.base.json ./
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/packages/ ./packages/
COPY --from=builder /app/apps/data-domain/ ./apps/data-domain/

ENV NODE_ENV=production
EXPOSE 3000

CMD ["pnpm", "--filter", "data-domain", "start"]
