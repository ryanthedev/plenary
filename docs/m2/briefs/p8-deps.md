# Brief: p8-deps (image installs the lockfile; CI gets an S3 store)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t14q). Report: docs/m2/reports/p8-deps.md.
Never pkill/killall; port 0; kill only PIDs you recorded. Pull or push no images except as a CI step definition.

## Goal (from engine's p4-natss3, via the proxy)

Engine's NATS Bus and S3 Blobs add the first dependency: `bun.lock` with `@nats-io/transport-node@3.4.0` (package.json
and bun.lock land with engine's commit; they may be untracked in the working tree now, read them, don't edit them).

1. **deploy/Dockerfile:** copy `package.json` and `bun.lock` first, run `bun install --frozen-lockfile --production`,
   then copy the source (layer caching). Check `.dockerignore` doesn't exclude `bun.lock`, and does exclude
   `node_modules`. The image must contain everything the server needs at runtime, including node_modules from the
   install, nothing from the host's node_modules.
2. **CI S3 for engine's blob tests:** in the cluster-services job (.github/workflows/ci.yml), start the same pinned
   blob-store image as `deploy/cluster.compose.yml` (`pgsty/minio`, same tag) as a step or service, create a bucket,
   and export `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` with **throwaway
   CI-only values** written in the workflow, each with a comment saying so. Published on the runner's loopback only;
   record the container id and stop only that. Wait until the bucket exists before tests run.
3. Check the existing install step in both CI jobs actually runs now that a lockfile exists (`bun install
   --frozen-lockfile`), and that the herdr-draw clone and NATS steps still work.

## Files you own

`deploy/Dockerfile`, `deploy/README.md`, `.dockerignore`, `.github/workflows/ci.yml`. Nothing else.

## Order (coordinated with engine)

Build now; the manager commits only **after** engine's commit containing package.json and bun.lock. Until then the
Dockerfile would fail on a clean checkout, which is fine because nothing is committed.

## How to check (no Docker here)

- YAML parses; the MinIO step's shell logic runs against a stub `docker` the way p8-cluster-envv did (bucket-create
  wait loop, failure when the bucket never appears).
- Simulate the image: in a scratch copy holding only what the Dockerfile COPYs, run `bun install
  --frozen-lockfile --production`, then start `server/main.js` on port 0 and hit /health; stop by PID.
- `bun test` passes.

Done when the above holds and the report is written. Then stop. Do not commit.
