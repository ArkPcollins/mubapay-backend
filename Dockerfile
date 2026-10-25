# MubaPay API / worker image. The same image runs the API (default) or the
# worker (`node src/worker.js`). No secrets are baked in: configuration comes
# from the environment at runtime.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends tini curl && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data/private-storage && chown -R node:node /data
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .
USER node
ENV PRIVATE_STORAGE_DIR=/data/private-storage PORT=4000
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD curl -fsS http://127.0.0.1:4000/health/live || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
