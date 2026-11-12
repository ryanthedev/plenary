# Brief: p8-depsv (verify p8-deps: lockfile in the image, S3 store in CI)

docs/m2/BRIEF-BASE.md applies. You are the verifier, never the builder. Manager: `manager platform` (t14q).
Report: docs/m2/reports/p8-depsv.md, starting with **PASS** or **FAIL**, then HIGH/MEDIUM/LOW findings.
Write nothing outside that report and your session scratchpad. Do not commit. Never pkill/killall; port 0; kill
only PIDs you recorded. Pull or push no images.

## Goal and done-when (docs/m2/briefs/p8-deps.md: read it)

deploy/Dockerfile installs from engine's `bun.lock` (`--frozen-lockfile --production`, manifests copied first),
`.dockerignore` lets bun.lock in and keeps host node_modules out; the CI cluster job starts the same pinned blob-store
image as deploy/cluster.compose.yml, creates a bucket, waits for it, and exports S3_ENDPOINT, S3_BUCKET, S3_REGION,
S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY with throwaway CI-only values; existing CI steps still work. package.json and
bun.lock are engine's (uncommitted, theirs to commit): read, don't judge them.

## The diff

`git diff -- deploy .dockerignore .github`.

## Try to break it

- Image simulation: copy exactly what the Dockerfile COPYs (honouring .dockerignore) into a scratch dir, run the
  install as written, start server/main.js on port 0, hit /health, stop by PID. Does the NATS client resolve from the
  image's node_modules? Anything from the host leaking in?
- The CI MinIO step: run its shell against a stub `docker` (as p8-cluster-envv did): bucket appears, never appears,
  `mc stat` refused on a bare bucket (does the job fail loudly or hang?), pipefail traps, container cleanup by id.
- Secrets: CI S3 values are throwaway and commented; nothing real; nothing in `${{ }}` inside `run:`.
- Both CI jobs: install step now runs with a lockfile; the herdr-draw clone, NATS 2 MB check, and Postgres service
  still work as before. YAML parses.
- `bun test` passes.

## sdd ensemble review (required, OFFICE.md "sdd helpers")

Load `sdd:subagent-driven-development` first. Check `usage`, then review the diff with codex + grok + every other
harness passing `check_adapter`. Two agreeing = HIGH candidate: confirm or refute. List which harnesses ran.

## The builder's not-verified list and risks (only these)

- Nothing ran in Docker or on GitHub; `BUN_INSTALL_CACHE_DIR` behaviour inside the real image unverified.
- main.js doesn't wire NATS/Postgres/S3 yet; /health proves install and start only.
- The bucket wait runs inside the container; nothing tries 127.0.0.1:9000 before tests.
- `mc stat` on a bare bucket may be refused by this fork's mc; fixed port 9000; the fork stopped tagging; frozen
  install fails if package.json and bun.lock disagree (intended).

Grade HIGH: a secret, anything published, a broken existing CI step, an image that can't load its deps, or a CI step
that can hang or pass falsely. Then stop and leave the session idle.
