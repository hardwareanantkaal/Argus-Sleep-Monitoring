# Build context is the repo root (it needs database/migrations).
FROM node:22.23.4-alpine AS base
WORKDIR /app/backend
COPY backend/package*.json ./

FROM base AS dev
RUN npm install
COPY backend/ ./
CMD ["sh", "-c", "node scripts/migrate.js && node --watch src/index.js"]

FROM base AS prod
ENV NODE_ENV=production
RUN npm install --omit=dev && npm cache clean --force
COPY backend/ ./
COPY database/migrations /app/database/migrations
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:${BACKEND_PORT:-3100}/health || exit 1
CMD ["sh", "scripts/docker-start.sh"]
