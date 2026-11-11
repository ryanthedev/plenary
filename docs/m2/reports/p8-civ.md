**PASS.** Verifier report: p8-civ (verify p8-ci: CI + Docker skeleton).

No HIGH findings. Nothing in the four files can publish, log in, push, or leak a secret, and the
workflow's test step passes locally on a clean copy of the tree. Two MEDIUM and five LOW findings below.

Verifier wrote only this file and a scratch copy (session scratchpad). Nothing committed or pushed.

## What I checked, and how

| Check | Result | How |
|---|---|---|
| Files present | `.github/workflows/ci.yml`, `deploy/Dockerfile`, `deploy/compose.yml`, `deploy/README.md`; nothing else under `.github/` or `deploy/` | `find .github deploy -type f` |
| YAML parses | ci.yml keys `name, on, permissions, concurrency, jobs`; `on` = `push`, `pull_request`. compose.yml keys `services, volumes` | `ruby -ryaml` |
| `actions/checkout` pin | `3d3c42e5…90b1` = `refs/tags/v7.0.1` (and `v7`). Lightweight tag (no `^{}` peel), so it is the commit SHA | `git ls-remote https://github.com/actions/checkout` |
| `oven-sh/setup-bun` pin | `0c5077e5…57d6` = `refs/tags/v2.2.0` (and `v2`). Lightweight tag, commit SHA | `git ls-remote https://github.com/oven-sh/setup-bun` |
| Action inputs exist at those SHAs | `bun-version` (setup-bun), `persist-credentials` (checkout); both actions run on `node24` | raw `action.yml` at each SHA |
| Bun version | local `bun --version` = 1.4.4; release `bun-v1.4.4` exists (2026-10-22); workflow and Dockerfile both pin 1.4.4 | GitHub releases API |
| Least privilege | `permissions: contents: read` at top level; `persist-credentials: false`; trigger is `pull_request` (not `pull_request_target`), so fork PRs get a read-only token and no secrets | read |
| Push / login / publish / secrets | none: no `secrets.*`, no `docker login`, no `docker push`, no deploy step, no `GITHUB_TOKEN` use | read |
| `${{ }}` injection | only in `concurrency.group` (`github.workflow`, PR number, `github.ref`); none in any `run:` | read |
| Lockfile logic | `if [ -f bun.lock ] \|\| [ -f bun.lockb ]` covers both Bun lockfile formats; no lockfile exists, so it echoes and skips | ran the snippet in the scratch copy: `No lockfile; skipping install.` |
| Import case (macOS is case-insensitive, the runner is not) | all 84 relative imports in `packages/`, `server/`, `test/` match the on-disk filename case exactly | `ls` exact-name match per import |
| `bun test` as CI runs it | 29 pass, 0 fail, 5 files, on a clean copy of `git ls-files -co --exclude-standard` (what a commit of today's tree would hold, no node_modules) and in the repo | `bun test` |
| Base image | `oven/bun:1.4.4-slim` exists on Docker Hub (amd64 + arm64). Its config has no `User` (root by default) and its history creates user `bun` uid/gid 1000, so `USER bun` resolves and the container runs non-root | Docker Hub registry API, image config blob |
| compose ports / secrets | only `127.0.0.1:8080:8080` (and commented `127.0.0.1` binds for postgres/nats); secrets by name only (`${GOOGLE_CLIENT_ID:-}`, `${GOOGLE_CLIENT_SECRET:-}`, `${POSTGRES_PASSWORD:?…}`); no values | read |
| Secrets in the tree / history | no `.env*`, `*.pem`, `*.key`, `id_*`, `*.db`, `*.sqlite*` files; no client-secret / private-key / AWS-key patterns in `git log --all -p` | `find`, `git log -p \| grep` |

## Findings

### HIGH

None.

### MEDIUM

1. **`COPY . .` with no `.dockerignore` bakes the whole working tree into the image** (`deploy/Dockerfile:12`).
   The context is the repo root, so the image gets `.git/` (900 KB today, full history), `docs/`, any `.DS_Store`,
   untracked scratch files, and any future `.env` or local SQLite file. Not HIGH because nothing pushes the image,
   but the first registry push (phase 8 proper) would ship them. The builder disclosed this; p8-ci.md says to note
   it rather than create one. **Wanted (outside this job's files):** a root `.dockerignore` with at least
   `.git`, `.github`, `docs`, `node_modules`, `.env*`, `*.db`, `*.sqlite*`, `.DS_Store`; and `.env*` in `.gitignore`.
   `deploy/.dockerignore` would not apply with context `..`. A BuildKit `deploy/Dockerfile.dockerignore` beside
   the Dockerfile is another option (from memory, unverified: no Docker here).
2. **CI skips the live comparison against herdr-draw** (`test/core-source.test.js:15`). The first test (every
   `packages/core` file matches its sha256 in SOURCE.json) does run in CI, so local edits to core are still
   caught. The second test returns early when `../herdr-draw/core/` is absent, which it always is on a GitHub
   runner, so drift *in herdr-draw* (core changed there, not re-copied here) is only caught on a dev machine.
   That accounts exactly for the gap: 274 `expect()` calls locally vs 256 on a clean copy = 18 = the file count
   in SOURCE.json. Fix (not this job's files): either
   check out herdr-draw at the commit named in SOURCE.json as a second `actions/checkout` step, or accept and say
   so in CLAUDE.md. A manager decision.

### LOW

LOW 5–7 describe Compose behavior from memory; not run (no Docker here).

3. **`cancel-in-progress: true` also cancels runs on `main`** (`ci.yml:14`). Two quick pushes to `main` cancel
   the first run, so that commit never gets a green or red result. Common fix:
   `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` (or `github.ref != 'refs/heads/main'`).
4. **Same-repo PRs run twice** (push + pull_request), as the builder said. They are in different concurrency
   groups (`refs/heads/x` vs PR number), so neither cancels the other. Harmless; costs minutes. Could restrict
   `push` to `branches: [main]` once the team works from PRs.
5. **compose `.env` lookup is `deploy/`, not the repo root.** With `-f deploy/compose.yml`, Compose's project
   directory is `deploy/`, so a `.env` there (not the root) is what gets read. README already says not to use
   `.env` yet; worth stating where it would go when `.gitignore` gains `.env*`.
6. **`image: plenary:dev` plus `build:`** means `docker compose push` would try `docker.io/library/plenary:dev`.
   It needs an explicit command and a login, so it cannot happen by accident; noted only because the brief
   says nothing may publish.
7. **No top-level `name:` in compose.yml**, so the project (and its volume) is named after the directory:
   `deploy_plenary-data`. Cosmetic; `name: plenary` would make volume names stable.

## Builder's not-verified list, re-checked

| Builder item | Status after this pass |
|---|---|
| Workflow never run on GitHub; no actionlint | Still true. **The workflow was never run on GitHub.** I confirmed pins, inputs and runtimes against the actions' sources instead; actionlint is not installed here either |
| No Docker here; `docker build` / `compose config` not run | Still true (no `docker`, no `hadolint`). Base tag and `bun` user confirmed from the registry instead |
| `server/main.js` missing; container exits at start | Confirmed: `server/` has `admin/`, `auth/` only. README and compose (`restart` commented out) say so |
| No `.dockerignore`; `.gitignore` lacks `.env*` | Confirmed; see MEDIUM 1 |
| Env/port names are builder picks | Not checked against anything (no server code reads them yet). Phase 3 must match `PORT`, `PLENARY_DATA_DIR` |
| Same-repo PRs run CI twice | Confirmed; LOW 4 |

## Not verified

- Any GitHub-side behavior (the run itself, runner image, cache).
- `docker build`, the HEALTHCHECK command, and `docker compose config` (no Docker on this machine).
- That the image's `/app` layout works with the real server entry (does not exist yet).
