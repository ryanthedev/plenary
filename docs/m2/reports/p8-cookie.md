# Report: p8-cookie (COOKIE_KEY for the cluster compose and CI)

**Result: done.** The cluster compose now requires one shared `COOKIE_KEY`. With it set, all three app nodes start in
cluster mode (run on Podman). Full `bun test`: 884 pass, 80 skip, 0 fail. Not committed.

## What changed (only files I own)

| File | Change |
|---|---|
| `deploy/cluster.compose.yml` | `COOKIE_KEY: ${COOKIE_KEY:?set COOKIE_KEY (at least 32 bytes, the same on every node; …)}` in `x-app-env`, so all three nodes get the same value from one variable. Header lists it as required, with `openssl rand -hex 32`. |
| `deploy/compose.yml` | `COOKIE_KEY:` with no value (null pass-through): set from the shell or `deploy/.env` when present, otherwise left **unset**. Not `${COOKIE_KEY:-}`, because main.js refuses an empty string as too short. |
| `.github/workflows/ci.yml` | `test-cluster-services` job: new step "Generate a throwaway COOKIE_KEY" (`openssl rand -hex 32`, `::add-mask::`, written to `$GITHUB_ENV`) before Test. No literal in the YAML. |
| `deploy/cluster.compose.yml` (header) | Corrected the stale "ignores the cluster env": `DATABASE_URL`/`NATS_URL` now switch on cluster mode. |
| `deploy/README.md` | Env table rows for `COOKIE_KEY` and `SESSION_KEY`, a one-line generator, the "all nodes must share it" rule in the cluster section, a CI note, and a correction to the "never run" bullet. |

## Decisions

- **Other cluster-required vars:** none. main.js (env header and `start()`) requires only `COOKIE_KEY` in cluster
  mode. `PUBLIC_URL` and `OIDC_REDIRECT_URI` are optional; they default to `http://localhost:8080`, which is wrong
  behind the cluster LB (`:8090`), but only matters once Google sign-in is configured. The README says to set both
  before trying Google in the cluster. I did not add them to compose.
- **Single node:** optional, not required. Requiring it would break the zero-config `docker compose up`. Unset
  means a random key per start (every restart signs everyone out); the README says to set it in `deploy/.env` for
  anything kept running.
- **CI:** the key is not needed by today's tests. `start(env)` reads only its argument. The tests that spawn
  `main.js` (test/server/main.test.js `spawn()`) pass a clean env of PATH, HOME, PORT and their own values. The other
  spawns (registry, s3-blobs, nats-bus, outbound, google-live) never start `main.js`. Added as the brief asked, so anything in that job that later starts the server from the job
  env works.

## What ran

- **`docker-compose config` (Compose 5.1.3, no daemon needed), cluster file:**
  - COOKIE_KEY unset: exit 1, `required variable COOKIE_KEY is missing a value: set COOKIE_KEY (…)`.
  - COOKIE_KEY empty: same error.
  - COOKIE_KEY set: exit 0. app-1, app-2 and app-3 each got exactly the input value (compared in a script, not
    printed).
- **`docker-compose config`, single-node file:** unset gives `COOKIE_KEY: null` (not passed to the container).
  Set gives the 64-character value passed through. Separately confirmed that a null entry is also filled from a
  `.env` file.
- **YAML parse:** all three files parse with `Bun.YAML.parse`. The cluster job's step order is checkout, setup-bun,
  install, NATS, blobs, **COOKIE_KEY**, Test, stops.
- **Cluster up, on Podman 5.8.2** (Docker is not installed; Docker Compose talks to Podman's API socket):
  - Used throwaway random values from a scratchpad env file (mode 600, deleted afterwards) and a free LB port.
  - Built `plenary:cluster-dev`. Postgres, NATS and blobs came up healthy, and `blobs-init` exited 0.
  - All three app nodes logged `"cluster":true` and `server listening`, and `/health` answered 200 inside app-1.
  - **Healthcheck quirk:** Docker Compose 5.1.3 against Podman 5.8.2's API marked the apps unhealthy. The exec-form
    healthcheck arrived split at its first space (`error: Expected ")" but found end of file` at `.then(r`). I did
    not isolate whether Compose or Podman splits it. This happens before `COOKIE_KEY` matters.
  - Re-ran with a scratchpad override (`CMD-SHELL` healthcheck, not in the repo). All apps were then healthy, the
    LB started, and `GET /health` through the LB answered 200.
  - **What I started:** Compose project `plenary-cluster`: containers postgres, nats, blobs, blobs-init, app-1..3
    and lb, volumes `plenary-cluster_postgres-data` and `plenary-cluster_blobs-data`, plus its network.
  - **Teardown:** removed everything with `down -v`, confirmed 0 containers and 0 volumes left. Left behind in
    Podman: the built image `plenary:cluster-dev`, plus the pulled images postgres:17.11-alpine3.23,
    nats:2.15.3-alpine, pgsty/minio:RELEASE.2026-08-04T00-00-00Z, caddy:2.11.9-alpine and oven/bun:1.4.4-slim. Some
    of these may have been present before; I didn't check. Scratchpad leftovers are logs and the override file only.
    The env file was deleted. The unrelated Engram containers in the same Podman were confirmed still up.
- **`bun test`:** 884 pass, 80 skip, 0 fail.

## Not verified

- **Docker itself:** not run, because Docker is not installed here. Docker is not expected to split the exec-form
  healthcheck, but that is unverified.
- **The CI job on GitHub:** not run. The new step is plain bash plus `openssl`, which ubuntu-latest ships.
- **A short key in the cluster:** compose accepts a key under 32 bytes. main.js then refuses to start with
  `COOKIE_KEY must be at least 32 bytes` (covered by test/server/main.test.js, not run in a container).

## Risks and notes for the manager

- **Google in the cluster:** `x-app-env` passes none of `GOOGLE_CLIENT_*`, `OIDC_REDIRECT_URI` or `PUBLIC_URL`.
  They must be added there, with the LB origin, before Google sign-in can work in the cluster (README says so).
- **Healthcheck on Podman:** if the team uses Podman, `cluster.compose.yml`'s app healthcheck should become
  `CMD-SHELL`. That is outside this brief, so I left it unchanged.
- **Unrelated changes in the worktree:** `test/server/rig.js` and docs/m2/reports/manager-*.md changed in the
  worktree during this job. I did not make those changes.
- **Stale README text:** deploy/README.md's "What runs today" section still says the registry is in-memory and
  POST /boards is not wired. main.js now uses a durable SQLite registry and mounts the platform routes. Left for a
  README pass.
- **Skill:** `distributed-systems-design` was not applied. This is a config job, not a design-bearing one.
