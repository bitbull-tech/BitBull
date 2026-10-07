# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY server/package*.json server/
COPY web/package*.json web/
RUN npm --prefix server ci && npm --prefix web ci
COPY . .
RUN npm --prefix web run build && npm --prefix server run build && npm --prefix server prune --omit=dev

# ---------- runtime ----------
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates ripgrep curl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8787 \
    HOME=/home/node
WORKDIR /app
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY agent agent
COPY skills skills
RUN mkdir -p /data && chown -R node:node /data /app
# Non-root: the Claude Agent SDK refuses bypassPermissions as root
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://localhost:8787/api/health || exit 1
CMD ["node", "server/dist/index.js"]
