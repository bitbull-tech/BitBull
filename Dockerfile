# Base images are pinned by digest so two builds of the same source produce the same image.
# To move to a newer base: docker buildx imagetools inspect <image> and take the top "Digest:",
# then update the tag in the FROM line to match (the tag is for humans, the digest is what builds).
# ---------- build ----------
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
WORKDIR /app
COPY server/package*.json server/
COPY web/package*.json web/
RUN npm --prefix server ci && npm --prefix web ci
COPY . .
RUN npm --prefix web run build && npm --prefix server run build && npm --prefix server prune --omit=dev

# ---------- runtime (the agent's sandbox) ----------
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
# Tools the agent and its skills use inside the sandbox: git, search, media + document handling
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git gh ripgrep python3 \
      ffmpeg libimage-exiftool-perl poppler-utils tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    BITBOB_SANDBOX=docker \
    DATA_DIR=/data \
    PORT=8787 \
    HOST=0.0.0.0 \
    # Everything writable lives under /data so the root filesystem can be read-only
    HOME=/data/home \
    XDG_CACHE_HOME=/data/cache \
    XDG_CONFIG_HOME=/data/config \
    OPENCODE_DATA_DIR=/data/opencode-sandbox \
    CLAUDE_DATA_DIR=/data/claude-sandbox
WORKDIR /app
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY agent agent
COPY skills skills
COPY subagents subagents
COPY tools tools
# Read by agents working inside BitBob (the system prompt points at it)
COPY agent-readme.md agent-readme.md
# The proxy's static allowlist, so Settings -> Network can show it (the proxy has its own copy)
COPY egress/allowlist.txt egress/allowlist.txt
# Ditto's CLI, for the server-side ditto_review tool (runs with the server's key, never in the agent's shell)
RUN npm install -g @heyditto/cli@3.6.4 && npm cache clean --force
RUN mkdir -p /data && chown node:node /data
# Non-root. The app and its code are root-owned and read-only to the agent.
USER node
VOLUME ["/data"]
EXPOSE 8787
# A first start does real work (migrations, mirroring skills into every workspace), and now
# that the gateway waits for this to be healthy, too strict a check fails the whole `up`.
HEALTHCHECK --interval=10s --timeout=5s --start-period=90s --retries=6 CMD curl -fsS http://localhost:8787/api/health || exit 1
CMD ["node", "server/dist/index.js"]
