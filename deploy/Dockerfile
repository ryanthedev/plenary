# Plenary single-node image: server/main.js (SQLite store, in-memory bus, local-disk blobs, dev-token auth).
# Build from the repo root:  docker build -f deploy/Dockerfile -t plenary:dev .   (release build: deploy/README.md "Release")
# Nothing is pushed to any registry.

# Official Bun image: the version CI uses (1.4.4), pinned by the digest of its multi-arch index (amd64 + arm64), so a
# rebuild never picks up a re-pushed tag. To bump: change the tag and the digest together, in one commit
# (deploy/README.md "Bumping the base image"). test/deploy-image.test.js fails if the digest is missing.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

# Provenance, passed by the release command (deploy/README.md "Release"). Defaults mark an unlabelled local build.
ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="plenary" \
      org.opencontainers.image.description="Plenary single-node server (server/main.js)" \
      org.opencontainers.image.source="https://github.com/ryanthedev/plenary" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"

WORKDIR /app

# Dependencies first, so this layer is rebuilt only when package.json or bun.lock changes (layer caching).
# --frozen-lockfile: fail if bun.lock does not match package.json, never rewrite it. --production: no devDependencies.
# node_modules comes only from this install: .dockerignore excludes every host node_modules from the context.
# The install runs as root, so node_modules is root-owned and read-only to the `bun` user the server runs as.
# The download cache goes to a temporary directory removed in the same layer, so it never ships in the image.
COPY package.json bun.lock ./
RUN BUN_INSTALL_CACHE_DIR=/tmp/bun-install-cache bun install --frozen-lockfile --production \
 && rm -rf /tmp/bun-install-cache

# Then the source. Copy only what the server runs, by name; never `COPY . .`. A stray file in the working tree
# (.env, a local database, .git, a host node_modules) cannot reach the image this way. The root .dockerignore is
# the second line of defence: it also filters inside these directories (for example server/.env or web/x.db).
# A new top-level runtime directory must be added here.
COPY --chown=bun:bun packages/ ./packages/
COPY --chown=bun:bun server/ ./server/
# web/ is the browser client; the server serves it at / (deploy/README.md "What runs today").
COPY --chown=bun:bun web/ ./web/

# SQLite database and blobs live here; compose mounts a named volume on it.
RUN mkdir -p /data && chown bun:bun /data
# HOST=0.0.0.0: main.js listens on 127.0.0.1 unless HOST is set, and a container must listen on all interfaces
# to be reachable through a published port. compose.yml still publishes only on the host's 127.0.0.1.
ENV PLENARY_DATA_DIR=/data \
    PORT=8080 \
    HOST=0.0.0.0

# Fixed numeric uid:gid (the base image's `bun` user is 1000:1000), so Kubernetes `runAsNonRoot` can verify it
# without resolving a name. /data is the only path this user can write.
USER 1000:1000

EXPOSE 8080

# GET /health returns 200 + JSON while the server is up. bun-slim has no curl, so this uses Bun's fetch.
# 127.0.0.1 works because HOST=0.0.0.0 includes loopback.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# main.js stops cleanly on SIGTERM (docker stop): server, bus, then store. Exec form, so bun is PID 1 and gets the
# signal itself (no shell in between); a shell-form CMD would swallow it and docker stop would wait 10 s, then SIGKILL.
STOPSIGNAL SIGTERM
CMD ["bun", "run", "server/main.js"]
