# Report: p8-ci (CI + Docker skeleton)

**Status: done; the workflow was never run on GitHub, and the image was never built (no Docker on this machine).**
YAML parses, `bun test` passes the way the workflow runs it (29 pass, 0 fail). Nothing committed, nothing pushed.

## What changed (all new files)

| File | What |
|---|---|
| `.github/workflows/ci.yml` | `push` + `pull_request`; `permissions: contents: read`; concurrency group cancels superseded runs; checkout and setup-bun pinned by full SHA; Bun 1.4.4; `bun install --frozen-lockfile` only if `bun.lock`/`bun.lockb` exists; `bun test`. No secrets, no login, no deploy. `persist-credentials: false`, 15 min timeout. |
| `deploy/Dockerfile` | `oven/bun:1.4.4-slim`, non-root `bun` user, copies the repo (context = repo root), `/data` for SQLite + blobs, `EXPOSE 8080`, `HEALTHCHECK` on `/health` via Bun's fetch (pending phase 3), placeholder `CMD ["bun","run","server/main.js"]` (phase 3). |
| `deploy/compose.yml` | One `plenary` service built from `../` with `deploy/Dockerfile`, named volume `plenary-data:/data`, port `127.0.0.1:8080:8080`, env by name only (`GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID:-}` etc.), commented `postgres` and `nats` marked "phase 4" (their ports also bound to 127.0.0.1). |
| `deploy/README.md` | Short: what each file is, build/run commands, "not runnable until phase 3". |

**Tests added:** none (config only).

## Pins (how confirmed)

- **actions/checkout:** `3d3c42e5aac5ba805825da76410c181273ba90b1` = `v7.0.1` = `v7`, read with `git ls-remote` on 2026-11-11.
- **oven-sh/setup-bun:** `0c5077e51419868618aeaa5fe8019c62421857d6` = `v2.2.0` = `v2`, same method. Both are lightweight tags, so the SHA is the commit.
- **Bun:** 1.4.4, from `bun --version` here.
- **oven/bun:1.4.4-slim:** exists on Docker Hub (queried the tags API); not pulled.

## How I checked

- **YAML:** `ruby -ryaml` loads both files. PyYAML isn't installed; actionlint (a GitHub Actions linter) isn't installed.
- **Image facts:** read oven-sh/bun's `dockerhub/debian-slim/Dockerfile` (main): the final stage runs `groupadd bun` / `useradd bun` and installs only `ca-certificates` (curl is in the build stage only). So the `bun` user exists and the health check can't use curl. Read from main, not the 1.4.4 tag.
- **Health check command:** ran the exact `bun -e` string locally: exit 1 against a dead port, exit 0 against a throwaway `Bun.serve` answering 200 on `/health`.
- **Tests:** ran the workflow's install step (prints "No lockfile; skipping install.") then `bun test`: 29 pass, 0 fail.

## Not verified

- **The workflow was never run on GitHub.** Not linted with actionlint.
- **No Docker here:** `docker build` and `docker compose config` were not run; the image was never built.
- **Container does nothing useful yet:** `server/main.js` does not exist, so the container exits at start until phase 3.

## Risks and requests

- **.dockerignore:** the build context is the repo root, so `deploy/.dockerignore` would not apply and I did not create it. **A root `.dockerignore` is wanted** (at least `.git`, `node_modules`, `docs/m2/design/shots`, `.env*`), since today `COPY . .` sends everything, including `.git`. Alternative: BuildKit also reads `deploy/Dockerfile.dockerignore`; that file isn't in my brief either.
- **`.env` not ignored:** root `.gitignore` lacks `.env*`; **please add it** (I don't own `.gitignore`). Until then the README says to export secrets in the shell, not to use `.env`.
- **Restart policy:** commented out in compose; enable `restart: unless-stopped` in phase 3, otherwise the missing `server/main.js` crash-loops.
- **Double runs:** same-repo PRs run CI twice (`push` and `pull_request`, both required by the brief). Fine for now; narrow `push` to `main` later if it costs too much.
- **Port and env names are my picks:** `PORT=8080`, `PLENARY_DATA_DIR=/data`, `LOG_LEVEL`, `DATABASE_URL`, `NATS_URL`. Phase 3/4 should adopt or rename them; the compose file and Dockerfile follow.
- **Image:** `COPY . .` before any `bun install` is fine with zero deps; once a lockfile appears, copy manifests first for layer caching (comment in the Dockerfile says so).
