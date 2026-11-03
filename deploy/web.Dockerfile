# Next.js web app, production image. Build context is the repo root.
# Needs `output: 'standalone'` in web/next.config.ts.
FROM node:22.23.4-alpine AS build
WORKDIR /app
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN mkdir -p public
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22.23.4-alpine AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
USER node
EXPOSE 3101
CMD ["node", "server.js"]
