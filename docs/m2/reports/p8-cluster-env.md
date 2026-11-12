# Report: p8-cluster-env

**Done, not committed.** A phase-4 cluster stack in Compose, a CI job with Postgres and NATS services, and a README
section. Nothing has run in Docker or on GitHub (no Docker here).

## Proposed env names (for engine; all marked `# proposed, engine to confirm` in deploy/cluster.compose.yml)

| Name | Value in Compose | Why this name |
|---|---|---|
| `DATABASE_URL` | `postgres://plenary:${POSTGRES_PASSWORD}@postgres:5432/plenary` | p8-ci's earlier pick (compose.yml comment); common convention |
| `NATS_URL` | `nats://nats:4222` | p8-ci's earlier pick |
| `S3_ENDPOINT` | `http://blobs:9000` | **Bun's built-in S3 client reads these five from env.** Checked locally: with only these set, `Bun.s3.file("k").presign()` gave `http://blobs:9000/plenary/k?...Credential=<key>/.../us-east-1/s3/...` (path style, right bucket, region, key) |
| `S3_BUCKET` | `${S3_BUCKET:-plenary}` | same |
| `S3_REGION` | `us-east-1` | same |
| `S3_ACCESS_KEY_ID` | `${MINIO_ROOT_USER}` | same |
| `S3_SECRET_ACCESS_KEY` | `${MINIO_ROOT_PASSWORD}` | same |
| `PLENARY_NODE_ID` | `app-1` / `app-2` / `app-3` | `PLENARY_` prefix like `PLENARY_DATA_DIR`; lease owner id |

Not proposed: a role switch (gateway / room host). Every node runs both roles; add one if engine wants it.

## Question for the manager (does not block)

**MinIO substitution.** The brief says MinIO, but `minio/minio` and `minio/mc` no longer exist on Docker Hub (Hub API
"object not found"; registry API refuses an anonymous pull token), and quay.io refuses anonymous reads too. I used
`pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, a community-maintained MinIO fork (AGPL-3.0, published by Pigsty, also
called Silo; 4M pulls). Its image ships `mc` and `curl`, so one image serves both the store and the bucket-create
one-shot. Alternatives if you'd rather not depend on a fork: `rustfs/rustfs:1.0.5` (Apache-2.0) or `dxflrs/garage:v2.5.0`.
The service is named `blobs`, not `minio`, so swapping the image changes only that service and `blobs-init`.
Note: `pgsty/minio` on Docker Hub stops at the August tag (`RELEASE.2026-11-09T00-00-00Z` returns 404), while the
fork's GitHub releases continue into November and its image now publishes as `pgsty/silo` with the binary renamed
`silo`. Moving to `pgsty/silo` later changes the `command` (and the image name), not the env or the bucket step.

## What changed

| File | What |
|---|---|
| `deploy/cluster.compose.yml` (new) | Project `plenary-cluster`: `postgres`, `nats`, `blobs`, `blobs-init` (one shot), `app-1`..`app-3` (built from `deploy/Dockerfile`), `lb` (Caddy). Only `lb` publishes, on `127.0.0.1:${PLENARY_LB_PORT:-8090}`. Healthchecks on every long-running service; `depends_on` with `service_healthy` / `service_completed_successfully`. Required secrets use `${VAR:?message}`: `POSTGRES_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`. |
| `deploy/cluster/Caddyfile` (new) | `/ws` and `/health` to the three nodes, round robin, active check on `/health` every 2 s, passive `fail_duration 10s`, `lb_try_duration 5s`; anything else 404. Admin API and auto-HTTPS off. |
| `deploy/cluster/nats.conf` (new) | Port 4222, monitoring 8222 (for the healthcheck), `max_payload: 2MB` (PROTOCOL.md line 511). No JetStream, no auth, no clustering. |
| `.github/workflows/ci.yml` | New job `test-cluster-services`: services Postgres and NATS (pinned, health-checked), `DATABASE_URL` and `NATS_URL` exported, runs `bun test`. Same pinned action SHAs; workflow-level `permissions: contents: read` applies; no secrets, push or login. `# TODO(engine phase 4)` before the test step. |
| `deploy/README.md` | Table row for the new files; a CI sentence for the new job; section "Cluster (phase 4, not functional yet)": services, `.env`, start/stop, what's missing. |

`deploy/compose.yml` is untouched.

## Tests added

None. I own no test files, and no code reads the new env names yet; engine's adapter tests will use them.

## Decisions

- **Separate file, not profiles.** Its own project name (`plenary-cluster`), port (8090) and volumes, so it never
  touches the single-node service and both can run side by side. Also expected but **not tested**: Compose
  interpolates a whole file before applying profiles, so required `${VAR:?}` secrets in `compose.yml` could break
  the plain single-node `up`.
- **Caddy, not nginx:** it proxies WebSocket upgrades with no extra config, does active health checks, and I could
  validate it locally (nginx isn't installed).
- **App nodes share no volume.** Today each node runs SQLite; three writers on one file would corrupt it. Each keeps
  `/data` inside its own container, lost on `down`.
- **App healthcheck overridden** with the Dockerfile's same `bun -e fetch(/health)` command, every 5 s instead of
  30 s, so the LB starts sooner and a killed node turns unhealthy sooner.
- **Postgres 17.11**, matching the existing commented block in `compose.yml`.
- **NATS `-alpine`**, because the plain tag is scratch (no wget for a healthcheck).
- **CI job does not clone herdr-draw**, so `test/core-source.test.js` skips there; the `test` job covers it.
- **CI Postgres password** is the literal `plenary-ci-only`, with a comment saying why it is safe (service
  container only, holds nothing).

## How I checked it

| Check | Result |
|---|---|
| YAML parses (`ruby -ryaml`, aliases on) | ok: `cluster.compose.yml`, `compose.yml`, `ci.yml` |
| YAML merge keys resolve | each `app-N` gets all 12 env names, the 5 s healthcheck and the 3 `depends_on`; only `lb` has `ports` |
| `caddy validate` (local Caddy 2.11.4; the image is 2.11.9) | "Valid configuration"; `caddy fmt` makes no changes |
| Image tags exist (Docker registry v2 API, manifest HEAD, anonymous token; nothing pulled) | 200 for `postgres:17.11-alpine3.23`, `nats:2.15.3-alpine`, `caddy:2.11.9-alpine`, `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, `oven/bun:1.4.4-slim`; a bogus tag gives 404 |
| Image contents assumed by healthchecks | read from source, not run: nats-docker `2.15.x/alpine3.22` Dockerfile (alpine, so busybox wget); pgsty/minio Dockerfile at the release tag (`/usr/bin/curl`, `mc`, entrypoint prepends `minio` unless overridden, hence `entrypoint: /bin/sh -c`) |
| New env names unused by code | grep of `server/ test/ packages/ web/`: no hits |
| `bun test` | 263 pass, 0 fail, with and without `DATABASE_URL`/`NATS_URL` set (the expect() count varies run to run: 49,669 / 83,263 / 25,374) |
| Caddy path matcher vs server routes | `server/server.js:30,32` match `url.pathname === "/health"` and `=== "/ws"` exactly, as `path /ws /health` does |
| Owned files only | `git status`: `ci.yml`, `deploy/README.md` modified; `deploy/cluster.compose.yml`, `deploy/cluster/`, this report new; `git diff deploy/compose.yml` empty |

## Not verified

- **No container started.** No `docker compose config`, no `up`, no healthcheck ever executed. In particular: that
  `pg_isready`/`wget`/`curl` behave as
  written, and that Caddy proxies `/ws` end to end. `/bin/sh` for `blobs-init` should exist: the image's own
  entrypoint at that tag is a `#!/bin/sh` script.
- **Three services building one tag** (`plenary:cluster-dev` on `app-1`..`app-3`) has not been through Compose.
- **Workflow never ran on GitHub.** actionlint isn't installed. The service `options` health flags and the default
  NATS config's monitoring port 8222 are from the image source, untested.
- **`nats.conf` not parsed** (no `nats-server` locally).

## Risks

- **CI NATS keeps the default 1 MB `max_payload`.** Service containers can't take a command or mount a repo file
  (they start before checkout). If engine's tests need 2 MB messages, that job must restart NATS in a step with a
  config (noted at the TODO).
- **Fork dependency** for blobs (see the question above).
- **`POSTGRES_PASSWORD` must be URL-safe** (letters and digits); it goes into `DATABASE_URL` unescaped. Documented in
  the file and README.
- **App nodes use the blob store's root credentials.** Fine for a local stack; a scoped key is later hardening.
- **Round robin without stickiness.** Fine for long-lived WebSockets; reconnects may land on another node, which is
  the takeover path phase 4 must handle anyway.

## Engine amendments (from manager platform, t14q)

**Done, not committed.** All three changes are in; one point differs from the suggested method (see 3).

### 1. Env names confirmed

- **Markers removed:** all 10 `# proposed, engine to confirm` markers are gone from `deploy/cluster.compose.yml`;
  the file header says the names are confirmed by engine.
- **`PLENARY_NODE_ID`:** a fixed literal per service (`app-1`, `app-2`, `app-3`), so it is unique per node and the
  same after a restart or a recreate of that node.

### 2. `PLENARY_ROLES`

| Node | `PLENARY_ROLES` | Behind the LB |
|---|---|---|
| `app-1` | `gateway,host` | yes |
| `app-2` | `gateway` | yes |
| `app-3` | `host` | no |

- **Why this split:** two gateways and two room hosts. One node of each kind is single-role, so "gateways separate
  from room hosts" is exercised, and killing a board's host still leaves another host to take it over.
- **LB:** `deploy/cluster/Caddyfile` upstreams are now `app-1:8080 app-2:8080` only; `lb` `depends_on` only those two.
- **Assumption for engine:** a host-only node still serves `GET /health` (the Compose healthcheck and the app nodes'
  `depends_on` rely on it). Commented at `app-3`.

### 3. NATS `max_payload` 2 MB in Compose and CI

- **Compose:** unchanged; `deploy/cluster/nats.conf` already sets `max_payload: 2MB`.
- **The suggested `docker run ... --max_payload 2MB` would fail.** nats-server 2.15.3 has no such flag. Its full
  flag list (`server/opts.go` at tag v2.15.3, the `fs.*Var` calls) is: `port p n name server_name addr a net
  client_advertise D debug V VV trace DV DVV T logtime logtime_utc user pass auth m http_port ms https_port c config t
  test_reload sl signal P pid ports_file_dir l log s syslog r remote_syslog version v profile routes cluster
  cluster_listen cluster_advertise no_advertise connect_retries cluster_name help_tls tls tlscert tlskey tlscacert
  max_traced_msg_len js jetstream sd store_dir`. `max_payload` is config-file only.
- **What I did instead:** the NATS service container is removed from `test-cluster-services`. A step after checkout
  runs `docker run -d --rm -p 127.0.0.1:4222:4222 -v $GITHUB_WORKSPACE/deploy/cluster/nats.conf:...:ro
  nats:2.15.3-alpine nats-server --config ...`, the same config file Compose uses.
  - **Container id:** written to `$GITHUB_ENV` as `NATS_CONTAINER_ID`. A "Stop NATS" step (`if: always()`) runs
    `docker stop` on that id only (`--rm` then removes it).
  - **Self-check:** the step waits up to 30 s for `/healthz`. It then fails unless `/varz` reports
    `"max_payload": 2097152`, so a wrong limit can't pass silently.
  - **Least privilege unchanged:** no secrets, no registry login, no push. It does an anonymous pull of a pinned
    public image (as the service did) and publishes on the runner's loopback only. `permissions: contents: read`
    still applies.

### How I checked the amendments

| Check | Result |
|---|---|
| YAML parses (`ruby -ryaml`) | ok: `cluster.compose.yml`, `compose.yml`, `ci.yml` |
| Parsed structure | CI job: services = `postgres` only; steps = checkout, setup-bun, install, Start NATS, Test, Stop NATS. Compose: node ids and roles as in the table; `lb` depends on `app-1` and `app-2` only |
| Step scripts | extracted from the parsed YAML; `bash -n` ok for all four `run:` blocks |
| `caddy validate` / `caddy fmt` | Valid configuration; no format changes |
| `2MB` means 2097152 | NATS `conf/parse.go` at v2.15.3: suffix `mb` multiplies by 1024*1024 |
| `/varz` output format | NATS `server/monitor.go` at v2.15.3: `HandleVarz` writes `json.MarshalIndent(..., "", "  ")`, so the line is `"max_payload": 2097152,`. The step's `grep -E '"max_payload": *2097152\b'` matches that and rejects `20971520` (tested on sample strings) |
| `deploy/compose.yml` | `git diff` empty |
| `bun test` | 263 pass, 0 fail |

### Not verified (amendments)

- **NATS never ran here.** I downloaded nats-server 2.15.3 for macOS (checksum ok) to run the config test and read
  `/varz` live, but running a downloaded binary was blocked by this session's permission rules. The flag list, the
  `2MB` parsing and the `/varz` format are read from source at the tag, not observed.
- **The CI step never ran on GitHub** (and no Docker here). In particular: that `$GITHUB_WORKSPACE` bind mounts work
  for `docker run` on `ubuntu-latest` (expected: the job runs on the host, not in a container), and the 30 s wait.
- **Roles are not read by `server/main.js` yet,** so today every node still runs both roles and `app-3` would accept
  clients if reached directly. Only the LB enforces the split.
- **R-M1 fixed (2026-11-11):** `ci.yml` now captures `/varz` into `varz=$(docker exec …) || varz=""` and greps the variable (no pipe into `grep -q` under pipefail; same failure message); the whole "Start NATS" step, extracted from the parsed YAML, run against the verifier's stub `docker`: 2097152 passed 20/20 (normal and 20,000-line output), 20971520 and 1048576 failed with "NATS max_payload is not 2097152." in both modes, while the old pipeline failed 10/10 on the correct value; YAML re-parsed ok.
