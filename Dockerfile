# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: full Bun image with the toolchain needed for ttsc + typia.
# ---------------------------------------------------------------------------
FROM oven/bun:1.4-debian AS build

WORKDIR /app

# Install dependencies first for layer caching. The lockfile is mandatory.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json tsconfig.base.json ./
COPY src ./src
COPY scripts ./scripts

RUN bun run build

# Writable state directory template (owned by the runtime user).
RUN mkdir -p /app/data

# ---------------------------------------------------------------------------
# Runtime stage: distroless. Only the bundled dist/ output ships - no
# node_modules toolchain, no shell, no package manager. Runs as nonroot.
# ---------------------------------------------------------------------------
FROM oven/bun:1.4-distroless AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    INDEXNOW_RELAY_CONFIG=/app/relay.config.ts \
    INDEXNOW_RELAY_DB=/app/data/relay.db

# The server itself.
COPY --from=build --chown=65532:65532 /app/dist ./dist

# A minimal package view so mounted configs can use:
#   import { defineConfig, env } from 'indexnow-relay/config'
COPY --from=build --chown=65532:65532 /app/package.json ./package.json
COPY --from=build --chown=65532:65532 /app/package.json ./node_modules/indexnow-relay/package.json
COPY --from=build --chown=65532:65532 /app/dist ./node_modules/indexnow-relay/dist

# SQLite lives in /app/data - mount a volume on it.
COPY --from=build --chown=65532:65532 /app/data /app/data

USER 65532:65532

EXPOSE 3000
VOLUME ["/app/data"]

# Distroless has no shell; the check runs Bun directly. It assumes the
# default port 3000 (override alongside PORT in your orchestrator).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "await fetch('http://127.0.0.1:3000/healthz').then((r) => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]

ENTRYPOINT ["bun", "dist/server.js"]
