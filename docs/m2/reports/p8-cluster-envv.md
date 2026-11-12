**PASS** (pre-amendment snapshot; no HIGH). Report: p8-cluster-envv (verify p8-cluster-env).

- **Graded items hold:** no secret in a file (beyond the documented CI throwaway), nothing published, only `lb`
  publishes and only on 127.0.0.1, the existing CI job and `deploy/compose.yml` are unchanged.
- **The new CI job passes today:** on a clean `git archive HEAD` export with the snapshot files overlaid, no
  herdr-draw beside it, and the job's `DATABASE_URL`/`NATS_URL` set, `bun test` passed **5 of 5** (187 tests).
- **But `bun test` on the working tree is flaky:** it failed in **2 of 7** full runs, always the same test in
  **untracked** engine work (`test/server/gateway.test.js`), which CI does not see today. Not graded HIGH for that
  reason; it will turn both CI jobs intermittently red once committed. See M1.

**Scope: the pre-amendment snapshot.** The manager said (mid-pass) that the builder (t170) is amending these files
now (env names confirmed, `PLENARY_ROLES`, NATS 2 MB in CI). Everything below checks this version (sha256 prefix):

| File | sha256 |
|---|---|
| `.github/workflows/ci.yml` | `d8cc9351052a` |
| `deploy/cluster.compose.yml` | `9b8c3594720e` |
| `deploy/cluster/Caddyfile` | `56c470bc537f` |
| `deploy/cluster/nats.conf` | `9647494fa7b4` |
| `deploy/README.md` | `8c0eddad98e9` |
| `deploy/compose.yml` | `e1db5b71048b` (unchanged from HEAD) |

**Live files at report time:** `ci.yml` (`40e6bc33d3db`), `cluster.compose.yml` (`8fab55a43b7e`), `Caddyfile`
(`625dbc5bbcc3`) and `README.md` (`1695ed536f1b`) **no longer match** the snapshot (the builder's amendments);
`nats.conf` and `compose.yml` still match. The amended files need the re-check the manager mentioned.

## Findings

### HIGH

None.

### MEDIUM

- **M1. Flaky test, outside this diff:** `test/server/gateway.test.js:627` (untracked engine work), "clients converge
  through the Room over real sockets ... (seed 2)", failed in 2 of 7 full working-tree `bun test` runs here. A clean
  `HEAD` export (which lacks that file) passed 5 of 5, so the flake is confined to the untracked work. The failing assertion
  shows a client whose `state()` is nearly empty (3 lines received vs 1151 expected) after `settled()`. The file passed
  8 of 8 runs alone. Once that file is committed, **both** CI jobs will go red now and then. This is not the builder's
  fault and not in their files. Engine's convergence test needs a look: a `settled()` race or a real convergence bug.
  Not diagnosed further.

### LOW

- **L1. CI service ports bind to all interfaces on the runner:** `ci.yml` uses `5432:5432` and `4222:4222`. On a
  GitHub-hosted runner (a throwaway VM with no inbound access) this exposes nothing. A `127.0.0.1:5432:5432` form would match
  the Compose files' loopback-only habit, but I have **not verified** that GitHub's `services.*.ports` accepts a host
  IP. Optional.
- **L2. Blob-store fork is moving:** `pgsty/minio` on Docker Hub stops at `RELEASE.2026-08-04T00-00-00Z`; the fork
  now ships as `pgsty/silo`. The pinned tag exists and works today; the builder already flagged this.
- **L4. Postgres can report healthy during its first-boot init:** `pg_isready -U plenary -d plenary` (Compose and CI)
  uses the unix socket. On first boot the image's entrypoint runs a temporary server with `listen_addresses=''`
  (docker-library `17/alpine3.23/docker-entrypoint.sh:297`), still on the socket, then restarts it. So the check can
  pass just before that restart, and a client connecting over TCP right then gets refused. Fix: add `-h 127.0.0.1`.
  Harmless today (nothing connects); worth fixing before engine's tests rely on it. Read, not run.
- **L3. Caddy version skew:** validated with local Caddy 2.11.4; the image is 2.11.9. Same major/minor directives;
  low risk.

## How I checked it

| Check | Result |
|---|---|
| Existing CI job unchanged | `git diff -U0 ci.yml` has **no removed lines**: only the new job appended. Parsed: `test` job still has the same 5 steps (checkout, setup-bun, install, herdr-draw clone, test), same SHAs; workflow-level `permissions: {contents: read}` unchanged |
| New CI job | Same pinned SHAs (`actions/checkout@3d3c42e…`, `oven-sh/setup-bun@0c5077e…`), `persist-credentials: false`, no secrets, no login, no push. `${{ }}` appears only in the pre-existing `concurrency:` block, never in `run:` |
| New job fails on an unhealthy service | Both services have `--health-cmd`; GitHub's runner waits for a healthy state and fails the job if a service never gets there (documented behaviour, not run) |
| NATS default monitoring port (CI) | nats-docker `2.15.x/alpine3.22/nats-server.conf` sets `monitor_port: 8222`, and the image's CMD loads it, so the CI `wget …:8222/healthz` has a target. The alpine base has busybox `wget` |
| `deploy/compose.yml` unchanged | `git diff deploy/compose.yml` empty; hash identical to the snapshot |
| Secrets | Only literal: `POSTGRES_PASSWORD: plenary-ci-only` in CI, commented as throwaway (allowed by the brief). Every Compose secret uses `${VAR:?message}` (`POSTGRES_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, at each use). `blobs-init` uses `$$` so the shell reads them from env at run time. `deploy/.env` is git-ignored (`.gitignore:5`) |
| Ports | Parsed every service: only `lb` has `ports`, `127.0.0.1:${PLENARY_LB_PORT:-8090}:8080` |
| App nodes reachable by Caddy | `server/main.js:84` defaults to 127.0.0.1, but `deploy/Dockerfile:30` sets `HOST=0.0.0.0` and the cluster file does not override it |
| YAML | `ruby -ryaml` (aliases on): `cluster.compose.yml`, `compose.yml`, `ci.yml` parse. Merge keys resolve: each `app-N` has 12 env names and a healthcheck |
| Caddyfile | `caddy validate`: "Valid configuration". `caddy adapt` shows: admin disabled, path matcher `/ws` `/health`, round robin over 3 upstreams, active check `/health` every 2 s, passive 10 s, try duration 5 s, everything else a static 404. Caddy's `reverse_proxy` passes WebSocket upgrades with no extra config |
| `nats.conf` | Not run (see below). Read against nats-server v2.15.3 source: `conf/parse.go:330` maps the `mb` suffix to MiB, so `2MB` = 2,097,152; `server/opts.go:1312` accepts `http_port`; `max_payload` (`opts.go:1374`) only rejects values over 2^31−1 |
| Image tags (registry v2 manifest HEAD, anonymous token, nothing pulled) | 200: `postgres:17.11-alpine3.23`, `nats:2.15.3-alpine`, `caddy:2.11.9-alpine`, `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, `oven/bun:1.4.4-slim`. Control `nats:9.9.9-bogus`: 404 |
| MinIO claim | Hub API: `minio/minio` and `minio/mc` both 404. `pgsty/minio`: 200, 4.06M pulls, "Community-maintained fork of minio/minio". GitHub `pgsty/minio`: fork of `minio/minio`, **AGPL-3.0**, not archived, pushed 2026-11-11. Claim confirmed |
| pgsty/minio image contents | At the release tag, `docker-release.yml` builds from `Dockerfile.goreleaser`: ubi-micro base, `/usr/bin/curl`, `mcli` with an `mc` symlink, `#!/bin/sh` entrypoint that prepends `minio` unless the first argument is `minio`. So the `curl` healthcheck, `mc` in `blobs-init`, `/bin/sh -c` entrypoint override and `command: ["minio","server","/data"]` all fit (read, not run) |
| New CI job as GitHub would run it | `git archive HEAD` into the scratchpad, snapshot files overlaid, no `../herdr-draw`, job env set: 5 runs, 187 pass, 0 fail each. `test/core-source.test.js:15` returns early when `../../herdr-draw/core` is missing, so the second core check skips as the builder said |
| `bun test` (working tree) | 7 full runs: 5 × 263 pass; 2 × 262 pass / 1 fail (M1). With `DATABASE_URL`/`NATS_URL` set to dead addresses: 263 pass. No code reads the new env names (grep of `server test packages web`) |

## sdd ensemble review

- **Ran:** codex (effort high), grok. Both in a scratchpad copy of the repo, not the live tree.
- **Could not run:** agy (quota exhausted, 429, resets in ~68 h), kimi (not logged in), mistral (no API key), qwen
  (not installed).
- **codex:** PASS, no findings.
- **grok:** FAIL with three "HIGH"s. No finding was shared by two harnesses, so there are no HIGH candidates. I checked
  grok's three anyway and **refute all three**:
  - *Built image tag `plenary:cluster-dev` is mutable:* a locally built image cannot be pinned by tag; the brief's
    "images pinned" covers pulled images, and its base `oven/bun:1.4.4-slim` is pinned. Three services sharing one
    `build` + `image` is a normal Compose pattern (untested, as the builder said).
  - *CI service ports break "only the LB publishes":* that rule is for the Compose stack. CI services run on a
    throwaway runner with no inbound access. Kept as L1.
  - *`restart: "no"` on the one-shot is a bug:* it is the correct, documented value.
- grok's MEDIUMs only restate correct behaviour ("works but…"); none named a defect.

## Not verified

- **No container started, no workflow run on GitHub.** There's no Docker here. Healthchecks, Caddy `/ws` proxying end
  to end, three services building one tag, and the GHA health flags are checked by reading only.
- **`nats-server -t` and actionlint were not run.** I downloaded the official release binaries (nats-server v2.15.3,
  actionlint v1.7.12) into the scratchpad, but the auto-mode permission classifier blocked running downloaded code.
  `nats.conf` was checked against the source instead; the workflow by parse and reading.
- **The amended files** (builder t170, in progress) are not covered by this report.

## Housekeeping

No processes started or left running. Scratchpad only: a repo copy, a clean `HEAD` export, the two downloaded release
archives, and the `bun test` logs. Nothing committed.

## Re-check (engine amendments)

**PASS** (no HIGH). One MEDIUM worth a one-line fix before commit (R-M1).

**Files checked (sha256 prefix):** `ci.yml` `40e6bc33d3db`, `cluster.compose.yml` `8fab55a43b7e`, `Caddyfile`
`625dbc5bbcc3`, `README.md` `1695ed536f1b`. `nats.conf` and `compose.yml` are unchanged.

### The manager's three points

| Point | Result |
|---|---|
| 1. No `proposed` markers; env names match engine's list | **Pass.** `grep -rni proposed deploy .github`: no hits. Parsed: every app node has all 8 confirmed names plus `PLENARY_ROLES`, none missing. Its other keys are the pre-existing `PORT`, `PLENARY_DATA_DIR`, `LOG_LEVEL` and `PLENARY_DEV_TOKENS`. `PLENARY_NODE_ID` is `app-1`/`app-2`/`app-3`: unique, a fixed literal per service, so stable across restarts and recreates |
| 2. Roles; LB routes only to gateways | **Pass.** `app-1` is `gateway,host`, `app-2` `gateway` (gateway-only), `app-3` `host` (host-only). `caddy validate` gives "Valid configuration", and `caddy adapt` shows upstreams `['app-1:8080', 'app-2:8080']` only. `lb` depends on `app-1` and `app-2` only. Only `lb` publishes, on 127.0.0.1 |
| 3. NATS `max_payload` 2 MB in Compose and CI | **Pass, with R-M1.** Compose: `nats.conf` is unchanged (`2MB` is 2,097,152 per the source, as checked before). CI: the NATS service container is replaced by a `docker run` step that mounts the same `nats.conf`, then checks `/varz` for 2097152 |

### The builder's CI method

- **No `--max_payload` flag:** agreed. The builder lists the v2.15.3 flags, and my earlier source read found
  `max_payload` only in config parsing (`server/opts.go:1374`).
- **It should work:**
  - The job runs on the runner host, so the `$GITHUB_WORKSPACE` bind mount is a real path.
  - `docker run -d` pulls before it returns, so the 30 s wait starts after the pull.
  - The alpine image has busybox `wget`.
  - `nats.conf` sets `http_port: 8222` for `/healthz` and `/varz`.
  - nats-server's `HandleVarz` uses indented JSON, so `"max_payload": 2097152` matches the grep.
  - None of this was run (no Docker here, no GitHub run).
- **Least privilege holds:**
  - No secrets, no registry login, no push; it pulls a pinned public image anonymously.
  - Port `127.0.0.1:4222` only.
  - `$GITHUB_WORKSPACE` is read as a shell variable. `${{ }}` still appears only in the pre-existing `concurrency:`
    block.
  - `permissions: contents: read` is unchanged.
- **Nothing is left running:**
  - The id is written to `$GITHUB_ENV` before any check can fail.
  - "Stop NATS" runs `if: always()` on that id only, and `--rm` removes the container.
  - If `docker run` itself fails, `set -e` exits before an id exists and no container was created.
  - The runner VM is thrown away after the job in any case.

### Findings

- **R-M1 (MEDIUM): the `/varz` check can fail falsely.** At `.github/workflows/ci.yml:137`,
  `docker exec … wget -O - …/varz | grep -Eq …` runs under `set -o pipefail`.
  - **Why it breaks:** `grep -q` exits at the first match. If `docker exec` writes more after that, it gets SIGPIPE.
    `pipefail` then makes the pipeline fail, and the step reports "NATS max_payload is not 2097152" even though it is.
  - **Reproduced** with a stub `docker` script in the scratchpad running the exact pipeline:
    - correct value, output in several writes: failed 10 of 10 and 5 of 5;
    - wrong values (20971520, 1048576): correctly failed.
  - **Not proven for the real output.** Real `/varz` is a few KB, and `max_payload` is field 27 of the `Varz` struct
    (`server/monitor.go` at v2.15.3), so the match comes early. Whether `docker exec` delivers busybox wget's output in
    one write or several is not verified, so this could make the new job fail now and then.
  - **Fix:** capture first, then grep:
    `varz="$(docker exec "$cid" wget -q -O - http://127.0.0.1:8222/varz)"` and then
    `grep -Eq '"max_payload": *2097152\b' <<<"$varz"`.
- **R-L1 (LOW): "Stop NATS" can fail after green tests.** If NATS crashed mid-job, `--rm` already removed it, so
  `docker stop` (`ci.yml:153`) errors and fails the job after `bun test` passed. That is arguably right (the bus died),
  but the message will be "No such container". Optional: `docker stop … || docker logs …`.

### Earlier findings against the amended files

| Earlier | Now |
|---|---|
| M1 flaky `test/server/gateway.test.js` (untracked engine work) | Still outside this diff. 3 of 3 working-tree runs passed this time (263/263). Earlier it failed 2 of 7, so it is still intermittent |
| L1 CI service ports on all interfaces | NATS is fixed (now `127.0.0.1:4222`). Postgres is still `5432:5432` (`ci.yml:84`); harmless on a throwaway runner |
| L2 `pgsty/minio` → `pgsty/silo` rename | Unchanged |
| L3 Caddy version skew | Unchanged |
| L4 `pg_isready` over the unix socket can pass during first-boot init | Still present at `cluster.compose.yml:77` and `ci.yml:86`; add `-h 127.0.0.1` |

### Other checks

| Check | Result |
|---|---|
| YAML (`ruby -ryaml`) | `cluster.compose.yml`, `compose.yml`, `ci.yml` parse |
| Existing `test` job | No line removed from HEAD's `ci.yml`. Same 5 steps and SHAs |
| CI job shape | Services: `postgres` only. Steps: checkout, setup-bun, install, Start NATS, Test, Stop NATS (`if: always()`) |
| `deploy/compose.yml` | `git diff` empty |
| `bun test`, working tree | 3 runs, 263 pass, 0 fail |
| `bun test` as the new job runs it | Clean `git archive HEAD` with the amended files overlaid, no herdr-draw, job env set: 3 runs, 187 pass, 0 fail |
| codex (effort high) on the amended diff, in a scratchpad copy | PASS, no findings. It was asked about SIGPIPE explicitly and did not flag it; R-M1 rests on my reproduction |

### Not verified (re-check)

- The NATS step never ran: no Docker here, no GitHub run. R-M1's real-world likelihood is not measured.
- `PLENARY_ROLES` is read by nothing yet, so the split is enforced only by the LB, as the builder says.
