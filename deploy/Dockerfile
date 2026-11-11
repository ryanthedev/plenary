# Plenary single-node image (skeleton).
# Build from the repo root:  docker build -f deploy/Dockerfile -t plenary:dev .
# Nothing is pushed to any registry.

# Official Bun image, pinned to the version CI uses.
FROM oven/bun:1.4.4-slim

WORKDIR /app

# There are no dependencies today. Once a lockfile exists, copy package.json and
# the lockfile first and run `bun install --frozen-lockfile --production` here.
COPY --chown=bun:bun . .

# SQLite database and blobs live here; compose mounts a named volume on it.
RUN mkdir -p /data && chown bun:bun /data
ENV PLENARY_DATA_DIR=/data \
    PORT=8080

# The base image ships a non-root `bun` user.
USER bun

EXPOSE 8080

# PENDING phase 3: the server and its /health endpoint do not exist yet, so this
# check fails until then. bun-slim has no curl, so it uses Bun's fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# PLACEHOLDER: phase 3 adds the server entry (server/main.js). The path may change.
CMD ["bun", "run", "server/main.js"]
