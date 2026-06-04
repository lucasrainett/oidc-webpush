# notify-app — multi-stage build
# Build:  docker build -t notify-app .
# Run:    docker run --env-file .env -p 3000:3000 -p 2525:2525 -v $PWD/data:/app/data notify-app

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential && rm -rf /var/lib/apt/lists/*
COPY package*.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN useradd --system --uid 1001 --home /app notify \
    && mkdir -p /app/data \
    && chown -R notify:notify /app
COPY --from=build --chown=notify:notify /app/node_modules ./node_modules
COPY --from=build --chown=notify:notify /app/dist ./dist
COPY --chown=notify:notify public ./public
COPY --chown=notify:notify package.json ./
USER notify
EXPOSE 3000 2525
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/app.js"]
