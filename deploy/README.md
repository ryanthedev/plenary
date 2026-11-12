# deploy/

Packaging for the single-node Plenary server (`server/main.js`). Nothing here is published: no registry pushes, no
public images.

| File | What |
|---|---|
| `Dockerfile` | Single-node image on `oven/bun:1.4.4-slim`. Runs `bun run server/main.js` as the non-root `bun` user, listens on 0.0.0.0:8080, data in `/data`, health check on `GET /health`. |
| `compose.yml` | One `plenary` service with a named volume for SQLite and blobs, published on `127.0.0.1:8080` only, `restart: unless-stopped`. |
| `cluster.compose.yml`, `cluster/` | Phase-4 cluster shape (not functional yet): see [Cluster](#cluster-phase-4-not-functional-yet). |

```sh
docker build -f deploy/Dockerfile -t plenary:dev .      # context is the repo root
docker compose -f deploy/compose.yml up --build         # binds 127.0.0.1:8080 only
curl -s http://127.0.0.1:8080/health                    # 200 + JSON
```

## What runs today

- **Endpoints:** `GET /health` and the WebSocket at `/ws`. There is no web page on port 8080 yet: the server does
  not serve `web/`, and `POST /boards` and Google sign-in are not wired into `server/main.js`.
- **Without dev tokens** every `hello` is refused, so no client can join. The log says so at start.
- **With dev tokens** the server creates one dev board at start and logs its id (`dev tokens are ON`). Boards live
  in an in-memory registry, so the board id changes on every restart, although the op log in SQLite survives.

## Environment

These are the variables `server/main.js` reads; nothing else is read.

| Variable | Image default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port (`0` = any free port; don't use 0 in the container, the published port is fixed). |
| `HOST` | `0.0.0.0` | Listen address. main.js defaults to `127.0.0.1`, which a container cannot be reached on, so the image sets it. |
| `PLENARY_DATA_DIR` | `/data` | `plenary.db` (SQLite) and `blobs/` go here. Compose mounts the `plenary-data` volume on it. |
| `PLENARY_DEV_TOKENS` | unset | JSON: `{ "<token>": { "name": "ann", "role": "editor", "email"?, "domain"? } }`. Unset or empty = off. Invalid JSON is logged and treated as off. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. Logs are structured, to stdout. |

**Dev tokens are for local use only.** Anyone holding a token is that user; there is no expiry or sign-in. Never
set them on a server others can reach. To use them, put a value in `deploy/.env` with single quotes around the
JSON, and make up your own token strings:

```sh
# deploy/.env  (git-ignored)
PLENARY_DEV_TOKENS='{"<a-long-random-token>":{"name":"ann","role":"editor"}}'
```

`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are commented out in `compose.yml`: main.js does not read them yet.
When sign-in is wired they come from your shell or `deploy/.env`, never this repo.

## Secrets and files

- **Where `.env` goes:** `deploy/.env`. With `-f deploy/compose.yml`, Compose reads `.env` from the directory of
  the compose file (`deploy/`), not from the repo root or your current directory.
- **Git:** `.env` and `.env.*` are git-ignored everywhere in the repo; only `.env.example` (a template with no
  values) may be committed.
- **Image:** the Dockerfile copies four named paths (`package.json`, `packages/`, `server/`, `web/`), and the root
  `.dockerignore` also keeps `.env*`, databases, `.git`, `docs/`, `test/` and all of `deploy/` out of the image.

The Compose project is named `plenary` (`name:` in `compose.yml`), so the data volume is `plenary_plenary-data`.

CI (`.github/workflows/ci.yml`) runs `bun test` on every push and pull request. Before the tests it clones
herdr-draw (public, read-only) at the commit in `packages/core/SOURCE.json`, so the core-copy check runs there too.
A second job, `test-cluster-services`, runs the same `bun test` with Postgres (a service container) and NATS and
`DATABASE_URL`/`NATS_URL` set, ready for engine's phase-4 adapter tests (nothing reads them yet). NATS is started in a
step with `docker run` and `cluster/nats.conf`, because the 2 MB `max_payload` can only come from a config file and
service containers start before checkout; the step fails unless NATS reports `max_payload` 2097152.

## Cluster (phase 4, not functional yet)

`cluster.compose.yml` is the phase-4 shape: Postgres, NATS, an S3-compatible blob store, three app nodes and a Caddy
load balancer. It is a separate Compose project (`plenary-cluster`), so it never touches the single-node stack above,
whose `compose.yml` is unchanged.

| Service | Image | Role |
|---|---|---|
| `postgres` | `postgres:17.11-alpine3.23` | Store (cluster adapter, not written yet). Volume `postgres-data`. |
| `nats` | `nats:2.15.3-alpine` | Bus, NATS core (no JetStream). Config `cluster/nats.conf` raises `max_payload` to 2 MB, as PROTOCOL.md asks. |
| `blobs` | `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` | S3-compatible blobs. MinIO stopped publishing `minio/minio` on Docker Hub; this is a community-maintained MinIO fork. |
| `blobs-init` | same | One shot: creates the bucket (`S3_BUCKET`, default `plenary`), then exits. |
| `app-1` | built from `Dockerfile` | `server/main.js`, roles `gateway,host`. No published ports. |
| `app-2` | same | Roles `gateway` only. |
| `app-3` | same | Roles `host` only: never behind the load balancer. |
| `lb` | `caddy:2.11.9-alpine` | Routes `/ws` (WebSocket) and `/health` to the **gateway** nodes only (`app-1`, `app-2`), round robin with health checks; everything else is 404. The only published port: `127.0.0.1:8090` (`PLENARY_LB_PORT`). |

**Roles.** `PLENARY_ROLES` is a comma list of `gateway` (holds client sockets, fans out) and `host` (sequences
boards), default `gateway,host`. The stack runs two gateways and two room hosts, so "gateways separate from room
hosts" is exercised and a killed host's boards have another host to move to. `PLENARY_NODE_ID` is unique per node
and stable across that node's restarts (a fixed value per service).

**Cluster env** (names confirmed by engine; Compose sets them): `DATABASE_URL`, `NATS_URL`, `S3_ENDPOINT`, `S3_BUCKET`,
`S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `PLENARY_NODE_ID`, `PLENARY_ROLES`.

Put the three required secrets in `deploy/.env` (git-ignored) or your shell, with your own values. Use letters and
digits for `POSTGRES_PASSWORD`, because it goes into `DATABASE_URL` unescaped:

```sh
# deploy/.env
POSTGRES_PASSWORD=<letters-and-digits>
MINIO_ROOT_USER=<user>
MINIO_ROOT_PASSWORD=<at-least-8-chars>
```

```sh
docker compose -f deploy/cluster.compose.yml up --build
curl -s http://127.0.0.1:8090/health
docker compose -f deploy/cluster.compose.yml down          # add -v to delete the Postgres and blob volumes
```

**What is missing:**

- **Cluster adapters and roles.** `server/main.js` reads none of `DATABASE_URL`, `NATS_URL`, `S3_*`,
  `PLENARY_NODE_ID` or `PLENARY_ROLES` yet, so every node still runs both roles regardless of its setting. Each node runs single-node: its own SQLite in its container (lost on `down`),
  its own in-memory bus, its own dev board. Two clients that land on different nodes do not see each other.
- **Leases and takeover.** The phase-4 test ("kill a board's host, another takes over, no acked op lost") cannot run
  until engine's leases exist.
- **Never run here.** This file was checked for YAML syntax, the Caddyfile with `caddy validate`, and every image tag
  against the registry; no container has been started from it.
