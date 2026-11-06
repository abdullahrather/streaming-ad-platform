# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Builder — compiles the API and the dashboard. Also used by
# docker-compose, because it keeps the tools needed to seed demo data and, with
# the PostgreSQL client, to take backups.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# The client matches the PostgreSQL 16 in docker-compose.yml, so backups restore into it.
RUN apk add --no-cache openssl postgresql16-client

COPY package*.json ./
COPY web/package*.json ./web/
COPY prisma ./prisma/

RUN npm ci && npm ci --prefix web && npx prisma generate

COPY . .

RUN npm run build && npm run build --prefix web

EXPOSE 3000

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Production — lean image without dev dependencies
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS production

WORKDIR /app

RUN apk add --no-cache openssl

ENV NODE_ENV=production

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci --omit=dev && npx prisma generate

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist

EXPOSE 3000

RUN mkdir -p .data/media && chown -R node:node .data

USER node

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
