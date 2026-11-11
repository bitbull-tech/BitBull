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

# ---------- voice: Piper text-to-speech (docs/VOICE.md) ----------
# The engine and the voices are GitHub release files, each checked against voice/piper.sha256
# before it is unpacked; a changed or truncated download fails the build.
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS voice
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY voice/piper.sha256 /tmp/piper.sha256
WORKDIR /opt
RUN set -eu; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in amd64) a=x86_64 ;; arm64) a=aarch64 ;; *) echo "no Piper build for $arch" >&2; exit 1 ;; esac; \
    get() { curl -fsSL --retry 3 -o "$2" "$1" && echo "$(grep " $3\$" /tmp/piper.sha256 | cut -d' ' -f1)  $2" | sha256sum -c -; }; \
    get "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_$a.tar.gz" piper.tgz "piper_linux_$a.tar.gz"; \
    tar -xzf piper.tgz && rm piper.tgz && mkdir piper/voices; \
    for v in en-us-libritts-high en-gb-southern_english_female-low; do \
      get "https://github.com/rhasspy/piper/releases/download/v0.0.2/voice-$v.tar.gz" v.tgz "voice-$v.tar.gz"; \
      tar -xzf v.tgz -C piper/voices "$v.onnx" "$v.onnx.json" MODEL_CARD && mv piper/voices/MODEL_CARD "piper/voices/$v.MODEL_CARD" && rm v.tgz; \
    done

# ---------- runtime (the agent's sandbox) ----------
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
# Tools the agent and its skills use inside the sandbox: git, search, media + document handling
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git gh ripgrep python3 \
      ffmpeg libimage-exiftool-perl poppler-utils tesseract-ocr \
      chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    BITBULL_SANDBOX=docker \
    # Headless Chromium for page checks (the 404 recipe's verifier and jam gate use puppeteer):
    # use the image's own, never download one through the egress proxy
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
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
# Piper and its voices, read-only like the rest of the app
COPY --from=voice /opt/piper /opt/piper
COPY agent agent
COPY skills skills
COPY subagents subagents
COPY tools tools
# Read by agents working inside BitBull (the system prompt points at it)
COPY agent-readme.md agent-readme.md
COPY help help
# The proxy's static allowlist, so Settings -> Network can show it (the proxy has its own copy)
COPY egress/allowlist.txt egress/allowlist.txt
# What this image was built from (written by deploy.ps1). The bracket makes it optional, so a
# plain `docker compose build` with no deploy still works — the server just reports "unknown".
COPY --from=build /app/build-info.jso[n] ./
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
