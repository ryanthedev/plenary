# Brief: p8-ci (CI + Docker skeleton)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (terminal t14q). Report: docs/m2/reports/p8-ci.md.

## Goal (PLAN.md phase 8, packaging half)

"Docker image, compose file, GitHub Actions CI running every gate." This job is the skeleton: CI runs `bun test` on
push and PR; a Dockerfile and a compose stub that later gain Postgres and NATS. **Nothing published:** no registry
pushes, no public images, no secrets in the repo, never `git push`.

## Files you own (touch nothing else)

- `.github/workflows/ci.yml`
- `deploy/Dockerfile`, `deploy/compose.yml`, `deploy/README.md` (short), `deploy/.dockerignore` if the build
  context is set so it applies; otherwise note in the report that a root `.dockerignore` is wanted (don't create it).

## Requirements

- **Workflow:** triggers `push` and `pull_request`; `permissions: contents: read`; `actions/checkout` and
  `oven-sh/setup-bun` pinned to a version (major tag at least; full SHA preferred if you can confirm it locally,
  otherwise say so); Bun version pinned to the one installed here (`bun --version`); runs `bun install
  --frozen-lockfile` only if a lockfile exists (there is none today; there are no deps), then `bun test`. No
  secrets, no registry login, no deploy step. Concurrency group to cancel superseded runs.
- **Dockerfile:** official `oven/bun` base pinned to a version tag; non-root user; copies the repo (context = repo
  root, `docker build -f deploy/Dockerfile .`); `CMD` a placeholder for the server entry that phase 3 will add
  (e.g. `bun run server/main.js`), with a comment saying so; `EXPOSE` a port; a `HEALTHCHECK` stub against
  `/health` commented as pending phase 3.
- **compose.yml:** one `plenary` service built from the Dockerfile, a named volume for SQLite + blobs, env vars
  by name only (no values for secrets; e.g. `GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID:-}`); commented-out `postgres`
  and `nats` services marked "phase 4". Bind ports to 127.0.0.1.

## How to check (nothing is pushed)

- Parse the YAML (e.g. `bun -e` with a YAML parser if available, or `ruby -ryaml`/`python3 -c 'import yaml'`),
  and `actionlint` if installed. `docker compose -f deploy/compose.yml config` and `docker build` if Docker is
  present (don't push; remove the image after). Run `bun test` locally the same way the workflow does.
- Report must say plainly: **the workflow was never run on GitHub**.

## Done when

Workflow, Dockerfile and compose stub exist, parse, and (where Docker is present) build; `bun test` passes; report
written to docs/m2/reports/p8-ci.md per BRIEF-BASE.md. Then stop. Do not commit.
