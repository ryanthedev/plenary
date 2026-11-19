# deploy/

Packaging for the single-node Plenary server (`server/main.js`). Nothing here is published: no registry pushes, no
public images.

| File | What |
|---|---|
| `Dockerfile` | Single-node image on `oven/bun:1.4.4-slim`. Installs dependencies from `bun.lock` (`bun install --frozen-lockfile --production`) in their own layer, then copies the source. Runs `bun run server/main.js` as the non-root `bun` user, listens on 0.0.0.0:8080, data in `/data`, health check on `GET /health`. |
| `compose.yml` | One `plenary` service with a named volume for SQLite and blobs, published on `127.0.0.1:8080` only, `restart: unless-stopped`. |
| `cluster.compose.yml`, `cluster/` | Phase-4 cluster shape (never run on Docker): see [Cluster](#cluster-phase-4-not-run-on-docker-yet). |

```sh
docker build -f deploy/Dockerfile -t plenary:dev .      # context is the repo root
docker compose -f deploy/compose.yml up --build         # binds 127.0.0.1:8080 only
curl -s http://127.0.0.1:8080/health                    # 200 + JSON
```

## What runs today

- **Endpoints:** `GET /health`, the WebSocket at `/ws`, `POST /boards` (and the board invite and link routes), and
  Google sign-in at `/auth/*` (`server/auth/http.js`, mounted by `server/main.js`; the `/auth` routes answer 503
  unless both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set). The server serves the canvas page
  at `/` (the `web/` folder), over the same port.
- **Without dev tokens** every `hello` is refused, so no client can join. The log says so at start.
- **With dev tokens** the server creates one dev board on its first start and logs its id each start (`dev tokens are ON`). The
  registry is SQLite in `<data>/registry.db` and the board id is kept in `<data>/dev-board.json`, so restarts reuse it.

## Environment

These are the variables `server/main.js` reads; nothing else is read.

| Variable | Image default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port (`0` = any free port; don't use 0 in the container, the published port is fixed). |
| `HOST` | `0.0.0.0` | Listen address. main.js defaults to `127.0.0.1`, which a container cannot be reached on, so the image sets it. |
| `PLENARY_DATA_DIR` | `/data` | `plenary.db` (SQLite) and `blobs/` go here. Compose mounts the `plenary-data` volume on it. |
| `PLENARY_DEV_TOKENS` | unset | JSON: `{ "<token>": { "name": "ann", "role": "editor", "email"?, "domain"? } }`. Unset, empty or `{}` = off. Invalid JSON is logged and treated as off. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. Logs are structured, to stdout. |
| `COOKIE_KEY` | unset | At least 32 bytes; signs sign-in cookies and sessions. Unset on a single node = a random key per start (every restart signs everyone out). **Required in cluster mode** (`DATABASE_URL` or `NATS_URL` set): the server refuses to start without it, and every node must have the same value. |
| `SESSION_KEY` | unset | At least 32 bytes; signs sessions only, if you want it separate from `COOKIE_KEY` (default: `COOKIE_KEY`). Not set by either compose file. |

**Generate `COOKIE_KEY`** once and keep it in `deploy/.env` (never in the repo); `compose.yml` passes it through if
set and leaves it unset otherwise:

```sh
echo "COOKIE_KEY=$(openssl rand -hex 32)" >> deploy/.env
```

**Dev tokens are for local use only.** Anyone holding a token is that user; there is no expiry or sign-in. Never
set them on a server others can reach. The served page's dev sign-in menu (`GET /auth/dev`, which publishes the
tokens of users none of whose tokens has `admin` or `domain`) is on only when the server binds a loopback `HOST`, `PUBLIC_URL` (if set) is a loopback name, Google sign-in is not
configured and the node is a gateway: in the container (`HOST=0.0.0.0`) it is always off, and the log says why. The tokens
still work for a socket or `POST /boards`. To use them, put a value in `deploy/.env` with single quotes around the
JSON, and make up your own token strings:

```sh
# deploy/.env  (git-ignored)
PLENARY_DEV_TOKENS='{"<a-long-random-token>":{"name":"ann","role":"editor"}}'
```

`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are commented out in `compose.yml`; `server/main.js` reads them. Set
them from your shell or `deploy/.env`, never this repo.

## Secrets and files

- **Where `.env` goes:** `deploy/.env`. With `-f deploy/compose.yml`, Compose reads `.env` from the directory of
  the compose file (`deploy/`), not from the repo root or your current directory.
- **Git:** `.env` and `.env.*` are git-ignored everywhere in the repo; only `.env.example` (a template with no
  values) may be committed.
- **Image:** the Dockerfile copies five named paths (`package.json`, `bun.lock`, `packages/`, `server/`, `web/`), and
  the root `.dockerignore` also keeps `.env*`, databases, `.git`, `docs/` (kept as a guard: any docs added later stay out of the image), `test/`, all of `deploy/` and every host
  `node_modules` out of the image. `node_modules` in the image comes only from the frozen install.

The Compose project is named `plenary` (`name:` in `compose.yml`), so the data volume is `plenary_plenary-data`.

CI (`.github/workflows/ci.yml`) runs `bun test` on every push and pull request. Before the tests it clones
herdr-draw (public, read-only) at the commit in `packages/core/SOURCE.json`, so the core-copy check runs there too.
Both jobs install with `bun install --frozen-lockfile` and fail if `bun.lock` is missing or out of date.
The cluster job generates a throwaway `COOKIE_KEY` per run (`openssl rand -hex 32`, masked in the log).
A second job, `test-cluster-services`, runs the same `bun test` with Postgres (a service container), NATS and an
S3-compatible blob store, and `DATABASE_URL`, `NATS_URL` and `S3_*` set, so engine's cluster-adapter tests run there.
NATS is started in a step with `docker run` and `cluster/nats.conf`, because the 2 MB `max_payload` can only come from
a config file and service containers start before checkout; the step fails unless NATS reports `max_payload` 2097152.
The blob store is the same `pgsty/minio` image and tag as `cluster.compose.yml`, started with `docker run` on the
runner's loopback; the step creates the bucket and fails unless the store reports it. Its `S3_*` values are
throwaway CI-only literals written in the workflow.

## Sign-in failures (operator guide)

When a Google sign-in fails, the server logs one line, `{"level":"warn","msg":"sign-in failed","cause":"..."}`,
and the browser gets `{"error":"login-failed"}` at `/auth/callback`. The label is fixed text, never a code, state,
token or cookie value.

| `cause` | What it means | What to do |
|---|---|---|
| `no_login_cookie` | The browser didn't send the login cookie back (a different host name than the one that started sign-in, or cookies blocked) | Open the server by the same address on every step, then sign in again. |
| `bad_login_cookie` | The cookie was signed with another key or is older than 10 min (for example, the server restarted with no `COOKIE_KEY`) | Sign in again. |
| *(no line at all; Google shows its own error page, e.g. "Access blocked")* | Google refused before calling us back: usually the account isn't allowed on the OAuth client (a test user while the app is in testing), or the redirect URI doesn't match | Fix the OAuth client's audience or redirect URI in your Google Cloud project. |
| `idp_error:access_denied` | The user pressed Cancel on Google's consent screen | Sign in again. |
| `idp_error:<other name>` (e.g. `idp_error:server_error`, `idp_error:temporarily_unavailable`, `idp_error:login_required`) | Google sent the user back with a standard error instead of a sign-in | Wait a minute and sign in again. If it repeats, report the cause. |
| `idp_error` (no name) | Google sent the user back with an error whose name we don't recognise, so we don't print it | Sign in again. If it repeats, report it. |
| `state_mismatch`, `no_code`, `state_used` | The callback URL was altered, or reused (back button, double submit) | Sign in again. |
| `invalid_grant` | Google refused the code: too old or already used | Sign in again, without lingering. |
| `invalid_client` | The client id or secret in the server's environment is wrong | Check the environment (don't paste secrets anywhere). |
| `invalid_request`, `unauthorized_client`, `unsupported_grant_type`, `invalid_scope` | Google refused how our server asked for the token (a bug on our side or an OAuth client setting) | Shouldn't happen. Report the cause. |
| `idp_timeout`, `idp_unreachable`, `token_http_<n>` | Google couldn't be reached in time, the connection dropped before its whole answer arrived, or Google answered the token request with error status `<n>` and no standard error name | Check the network and retry. |
| `bad_token_response` | Google's token answer arrived whole but wasn't JSON, whatever its status, an empty answer included (a proxy or captive portal in the way, or a Google outage page) | Retry. If it repeats, check for a proxy, then report. |
| `bad_token`, `bad_alg`, `bad_aud`, `bad_iss`, `bad_nonce`, `bad_sig`, `bad_sub`, `expired`, `bad_time`, `stale` | Google's ID token was missing, malformed, or failed a check | Shouldn't happen. Report the cause. |
| `unknown_kid` | Google's ID token was signed with a key we don't have, or Google's key endpoint couldn't be reached to fetch its keys (the server reads a failed key fetch as an unknown key) | Wait a minute and retry. If it repeats, report the cause. |
| `bad_config`, `bad_expected` | The server's own sign-in setup, or the login state in the cookie, was incomplete | Shouldn't happen. Report the cause. |
| `idp_refused`, `idp_threw` | The sign-in adapter refused without giving a reason, or crashed | Shouldn't happen with Google. Report the cause. |
| `replay_guard_full` (503) | Over 100k sign-ins in 10 min on one process | Not expected in normal use. |
| `mint_failed` (503) | Google signed the user in, but the server couldn't make the one-time code that hands the sign-in to the page | Sign in again. If it repeats, report it. |

This table lists every label the server can log: every cause goes through one function, `failed` in
`server/auth/http.js`, and the labels it can receive are exactly `CAUSES` in `server/auth/oidc.js` plus
`SIGN_IN_CAUSES` in `server/auth/http.js`. `test/auth/signin-cause.test.js` checks that every label written in
either file's source is in those lists and the other way round, and that this table names exactly those labels.

The exchange step can fail separately: the page says "sign-in failed (invalid-code)". That is the 60 s exchange
window or a dropped exchange cookie. Sign in again.

If `POST /boards` gives **403 `forbidden`**, the admin match failed. Admin by email needs Google to vouch for the
email: the account's Workspace domain (`hd`) must equal the email's domain. A Workspace account whose address is on a
secondary domain gets no email from the server, so it can't match an email admin.

## Postgres roles (least privilege)

`server/main.js` uses the Postgres adapters when `DATABASE_URL` and `NATS_URL` are both set (see
[What is missing](#cluster-phase-4-not-run-on-docker-yet) below). This is how the adapters behave.

PROTOCOL.md § Store, "Least privilege": a Plenary node can run as a Postgres role that reads and writes the tables
but does not own the schema. The Registry (`server/registry/postgres.js`, tables `reg_*`) and the Store
(`server/store/postgres.js`, tables `pl_*`) start the same way: under an advisory lock they look each table and index
up (`to_regclass`) and create only what is missing. They never ALTER, DROP or GRANT anything. So use two roles:

| Role | Rights | Used by |
|---|---|---|
| owner (`plenary_owner`) | owns the database, so its `public` schema (Postgres 15+); creates the tables | the migrate step, once per schema and after an upgrade that adds a table |
| runtime (`plenary_app`) | `USAGE` on the schema; `SELECT, INSERT, UPDATE, DELETE` on its tables; no `CREATE` | every node's `DATABASE_URL` |

Dev, CI and `cluster.compose.yml` use one owner role for both, which also works: the first node to start creates
everything. Several nodes starting at once against an empty schema is safe: the advisory lock (one per schema) makes
them create the tables one after another, and each later one finds them and creates nothing.

**1. Create the roles and database, as an admin** (a superuser, or a role with `CREATEROLE` and `CREATEDB`):

```sql
CREATE ROLE plenary_owner LOGIN PASSWORD '<your own>';
CREATE ROLE plenary_app LOGIN PASSWORD '<your own>';
CREATE DATABASE plenary OWNER plenary_owner;
```

On Postgres 15 and later the new database's `public` schema belongs to its owner and nobody else may create in it.
On 14 and older, also run `REVOKE CREATE ON SCHEMA public FROM PUBLIC;` in the new database (not tested here).

**2. Migrate, as the owner.** There is no `plenary migrate` command yet (phase 4); starting both adapters once does
the same thing. `PLENARY_PG_SCHEMA` is only this one-liner's variable (default `public`):

```sh
DATABASE_URL='postgres://plenary_owner:…@db/plenary' bun -e '
import { postgresRegistry } from "./server/registry/postgres.js";
import { postgresStore } from "./server/store/postgres.js";
const url = process.env.DATABASE_URL, schema = process.env.PLENARY_PG_SCHEMA || "public";
await (await postgresRegistry({ url, schema })).close();
await (await postgresStore({ url, schema })).close();
console.log("migrated", schema);'
```

**3. Grant the runtime role, as the owner** (`psql` on database `plenary`). Identity columns need no sequence grant.
The `DEFAULT PRIVILEGES` line covers tables the owner creates later, so a migrate that adds a table needs no new grant:

```sql
GRANT USAGE ON SCHEMA public TO plenary_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plenary_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO plenary_app;
```

**Upgrading to a version with the cluster id** (PROTOCOL.md § Bus, Cluster id) adds the table `pl_cluster`: run step 2
as the owner before starting a runtime-role node (the default privileges already cover its grants). The id changes
every bus subject, so old and new nodes do not talk over NATS: replace a cluster's nodes together (hosts first), not
one by one. A database copied for staging or a restore test keeps the original's id; run `DELETE FROM pl_cluster;` on
the copy (all its nodes stopped) before it shares a NATS server with the original. The id prefix keeps honest clusters
apart; it is not access control: for real separation give each cluster its own NATS account or user limited to
`<id>.>`. The id is on the `cluster adapters open` log line and in `SELECT id FROM pl_cluster`.

**If start-up is refused**, a runtime-role node stops with `postgres registry: start-up in schema "…" was refused for
lack of a privilege (permission denied …)` (the Store's reads `postgres store: …` the same way), code `denied`.
Either a table is missing (run step 2) or the role lacks its grants (run step 3). Both adapters check every table
right they use at start-up, so a role with `USAGE` but missing grants is refused there, naming what it lacks (e.g.
`lacks DELETE on reg_link_uses`), not on its first request:

- **Registry:** `SELECT, INSERT, UPDATE, DELETE` on every `reg_*` table.
- **Store:** `SELECT, INSERT` on `pl_entries`; `SELECT, INSERT, DELETE` on `pl_checkpoints`; `SELECT, INSERT, UPDATE`
  on `pl_leases` (the epoch fence's `FOR SHARE` needs `UPDATE`).

Step 3's grants cover both.

**Upgrading a schema made before the lease (phase 4).** Nodes refuse to start with `needs-migration` if `pl_leases`
lacks `holder` and `expires_at`. Run once, as the owner role, on each Plenary schema:
`ALTER TABLE "<schema>".pl_leases ADD COLUMN IF NOT EXISTS holder TEXT, ADD COLUMN IF NOT EXISTS expires_at BIGINT;`
It is idempotent and keeps every board's epoch. (Start-up itself never runs it: nodes still never ALTER.)

### Registry time limits

Every Registry call on Postgres answers or rejects within a bound, and a rejection reaches the client as
`unavailable` (it reconnects). Options of `postgresRegistry` (`server/registry/postgres.js`, header "Timeouts" and
"The gate"):

| Option | Default | What it bounds | Rejects with code |
|---|---|---|---|
| `lockTimeoutMs` | 15 s | a statement waiting on a lock; start-up waiting on the schema's start-up lock | `lock-timeout` |
| `statementTimeoutMs` | 15 s | a statement running, lock waits included (fires first when the two are equal) | `statement-timeout` |
| `maxInFlight` | the pool's `max` (Bun: 10) | calls sent at once, so Bun never queues one behind a stuck connection | — |
| `maxQueued` | 10 × `maxInFlight` | calls waiting for a connection; past it a call is refused at once, nothing sent | `overloaded` |
| `queueTimeoutMs` | 0.2 × the smaller limit + 50 ms | a call's wait for a connection; it is then refused and never sent | `queue-timeout` |
| (fixed) | the larger limit + 1 s after sending | a sent call with no answer (dead peer); it may still have taken effect | `client-timeout` |

**For a cluster, set `statementTimeoutMs` and `lockTimeoutMs` to 3–5 s**, above the gateway's 2 s re-check bound
(`recheckLookupMs`). The main reason: `queueTimeoutMs` is then 0.65–1.05 s, below those 2 s, so a re-check lookup the
gateway has already given up on is never sent. With the 15 s defaults `queueTimeoutMs` is 3050 ms, and an abandoned
lookup can still take a connection. Each connection is also pinned for less time under a stuck lock. Measured:
behind a stuck lock every call settles by about 1 × the lock limit, sent or not.

- **Bursts:** more than `maxInFlight + maxQueued` calls at once (110 with the defaults) get `overloaded` straight
  away, even on a healthy pool. Raise `maxQueued` if a node sees bigger bursts; `queueTimeoutMs`, not the queue's
  length, bounds how long a queued call waits.
- **A shared pool:** the gate assumes the Registry is its pool's only user; pass `maxInFlight` below the pool's `max`
  if the pool is shared.

## Cluster (phase 4, not run on Docker yet)

`cluster.compose.yml` is the phase-4 shape: Postgres, NATS, an S3-compatible blob store, three app nodes and a Caddy
load balancer. It is a separate Compose project (`plenary-cluster`), so it never touches the single-node stack above,
whose `compose.yml` is unchanged.

| Service | Image | Role |
|---|---|---|
| `postgres` | `postgres:17.11-alpine3.23` | Store (the Postgres adapter). Volume `postgres-data`. |
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
Pictures: with `S3_ENDPOINT` set (all five `S3_*` required) their bytes go to the bucket. A cluster node without it
**refuses to start** (another node could not read what this one stored); `PLENARY_BLOBS=local-disk` opts a cluster with
a single gateway into the node's own disk (the start warns). Signed picture URLs are keyed from `COOKIE_KEY` (same on
every node) and name `PUBLIC_URL` when it is set. `PLENARY_BLOB_QUOTA_BYTES` sets the per-tenant limit (default 10 GiB;
enforced per node, see PROTOCOL.md Known limits).

Put the four required secrets in `deploy/.env` (git-ignored) or your shell, with your own values. Use letters and
digits for `POSTGRES_PASSWORD`, because it goes into `DATABASE_URL` unescaped. `COOKIE_KEY` is one value that Compose
gives to **all three app nodes**: each node must accept cookies and sessions another node signed, and `server/main.js`
refuses to start in cluster mode without it. Compose stops with `set COOKIE_KEY …` if it is missing.

```sh
# deploy/.env
POSTGRES_PASSWORD=<letters-and-digits>
MINIO_ROOT_USER=<user>
MINIO_ROOT_PASSWORD=<at-least-8-chars>
COOKIE_KEY=<openssl rand -hex 32>
```

```sh
echo "COOKIE_KEY=$(openssl rand -hex 32)" >> deploy/.env   # once; every node reads this one value
```

Google sign-in in the cluster is not wired in this file: `x-app-env` passes none of `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `OIDC_REDIRECT_URI` or `PUBLIC_URL`, so setting them in `deploy/.env` does nothing until they
are added there. The last two default to `http://localhost:8080`, not the load balancer's `:8090`.

```sh
docker compose -f deploy/cluster.compose.yml up --build
curl -s http://127.0.0.1:8090/health
docker compose -f deploy/cluster.compose.yml down          # add -v to delete the Postgres and blob volumes
```

**What is missing:**

- **Blobs.** Nothing in `server/` writes blobs yet, so the S3-compatible store is not exercised by the server.
- **Takeover on this stack.** Leases and takeover are built and tested (and run on the local rig,
  `deploy/cluster/RIG.md`); the "kill a board's host" check has not been run on this Compose file.
- **Run once, on Podman, not Docker (2026-11-12, p8-cookie).** With `COOKIE_KEY` set, all three app nodes start in
  cluster mode and the load balancer answers `/health` with 200. Docker Compose 5.1.3 against Podman 5.8.2's API split the
  exec-form app healthcheck at its first space and marked the nodes unhealthy (which of the two splits it is not
  isolated), so that run used a local override with a `CMD-SHELL` healthcheck.
  Not yet run on Docker itself.
