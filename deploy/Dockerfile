# Plenary single-node image: server/main.js (SQLite store, in-memory bus, local-disk blobs, dev-token auth).
# Build from the repo root:  docker build -f deploy/Dockerfile -t plenary:dev .
# Nothing is pushed to any registry.

# Official Bun image, pinned to the version CI uses.
FROM oven/bun:1.4.4-slim

WORKDIR /app

# There are no dependencies today. Once a lockfile exists, copy package.json and
# the lockfile first and run `bun install --frozen-lockfile --production` here.
#
# Copy only what the server runs, by name; never `COPY . .`. A stray file in the working tree (.env, a local
# database, .git) cannot reach the image this way. The root .dockerignore is the second line of defence: it
# also filters inside these directories (for example server/.env or web/x.db).
# A new top-level runtime directory must be added here.
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun packages/ ./packages/
COPY --chown=bun:bun server/ ./server/
# web/ is the browser client. server/main.js does not import or serve it yet; it is copied so the image is
# ready when the server starts serving it.
COPY --chown=bun:bun web/ ./web/

# SQLite database and blobs live here; compose mounts a named volume on it.
RUN mkdir -p /data && chown bun:bun /data
# HOST=0.0.0.0: main.js listens on 127.0.0.1 unless HOST is set, and a container must listen on all interfaces
# to be reachable through a published port. compose.yml still publishes only on the host's 127.0.0.1.
ENV PLENARY_DATA_DIR=/data \
    PORT=8080 \
    HOST=0.0.0.0

# The base image ships a non-root `bun` user.
USER bun

EXPOSE 8080

# GET /health returns 200 + JSON while the server is up. bun-slim has no curl, so this uses Bun's fetch.
# 127.0.0.1 works because HOST=0.0.0.0 includes loopback.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# main.js stops cleanly on SIGTERM (docker stop): server, bus, then store.
CMD ["bun", "run", "server/main.js"]
