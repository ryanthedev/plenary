# PROJECT_NAME

> `PROJECT_NAME` is a placeholder: the project's name is not settled yet.

PROJECT_NAME is a live infinite canvas for enterprise all-hands meetings, meant to be open source (the license
is not chosen yet; see License). The goal: a few presenters draw, thousands annotate and react, and 100,000+
people watch live across several regions. It grew out of [herdr-draw](https://github.com/ryanthedev/herdr-draw)
and shares its drawing core.

**That is the goal, not today's state.** The project is early. Nothing is published (no packages, no images, no
hosted instance), and nothing has been tested at the 100k target. The server serves the canvas page, and the page
talks to it over a WebSocket. The Status section says exactly what exists.

## Try it

You need [Bun](https://bun.sh) 1.4.4 and `bun install --frozen-lockfile` once. Then one command (Postgres, NATS and a
Google account are not needed):

```sh
PORT=8099 PLENARY_DATA_DIR="$(mktemp -d)" \
PLENARY_DEV_TOKENS='{"dev-ada":{"name":"ada","role":"owner"},"dev-bo":{"name":"bo","role":"editor"}}' \
bun server/main.js
```

Open one URL per user, each in its own browser tab (a tab keeps its own identity):

- **ada (owner):** <http://localhost:8099/?as=ada>
- **bo (editor):** <http://localhost:8099/?as=bo>

With no `?board=` you land on **Home**: the dev board is under *Your boards* for ada (owner) and *Shared with me* for bo (dev
users have no Unit, so they are guests: Recent, Your boards and Shared with me, no Starred). Click the board, draw in one tab and
the shape appears in the other; the ⌂ in the top bar goes back to Home, where the board is now in Recent. With no `?as=` the
sign-in screen lists the dev users as buttons. `PORT=0` picks a free port instead (read it from the `server
listening` log line). Dev sign-in is a local-only convenience. It exists only while **all** of these hold: `PLENARY_DEV_TOKENS` names at
least one user (unset, empty and `{}` are off; a name with any `admin` or `domain` token, or that is a tenant admin in the registry (an earlier run, or
`scripts/admin-bootstrap.js --admin dev:<name>`), is never offered), the server
binds a loopback `HOST` (the default `127.0.0.1`) and any `PUBLIC_URL` is a loopback name, Google sign-in is not
configured, and the node is a gateway. Behind a reverse proxy (a public `PUBLIC_URL`) the menu stays off. Otherwise there is no `/auth/dev` route, no buttons, `?as=` is
ignored, and (if dev tokens are set) the log says why. When it is on, `GET /auth/dev` publishes the dev users' tokens
to any page on this machine's loopback names, and the log says so; tokens with `admin` or `domain` are never listed.

## Status

| Milestone | What | State |
|---|---|---|
| M1 | Shared core package and protocol v0 | Done |
| **M2** | Scale-ready product: server (single node and cluster), Google sign-in, multi-tenant, full canvas and collaboration, ~10k-client load test | **In progress** |
| M3 | Smoothing | Planned |
| M4 | Load test to 100k viewers and tuning | Planned |
| M5 | Mobile | Planned |
| M6 | Enterprise (SCIM, audit) | Planned |
| M7 | Multi-region | Planned |
| M8 | Hardening | Planned |

### What works today

| Piece | What is true now | Where |
|---|---|---|
| Drawing core | The editor, model, rendering and merge rules, copied from herdr-draw. | `packages/core/` |
| Protocol | The v1.1 spec in code: envelope and codec, a client `Replica`, a reference `Room` (one sequencer per board), recovery from checkpoints, presence (cursors, selections, laser, emotes), comment and reaction records, settings compare-and-set. Clients converge in tests. | `packages/protocol/`, `test/convergence.test.js`, `test/recovery.test.js`, `test/presence.test.js`, `test/records.test.js`, `test/v11.test.js` |
| Single-node server | One Bun process: WebSocket gateway plus room host, SQLite op log and SQLite registry (boards and their ops survive a restart or `kill -9`), in-memory bus, local-disk blob store, structured JSON logs, `GET /health`. | `server/main.js`, `test/server/main.test.js` |
| Sign-in | Google sign-in (OIDC) with a one-time code exchanged for a session token (`/auth/login`, `/auth/callback`, `/auth/exchange`, `/auth/logout`), mounted in the server. It is on only when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set; otherwise login, callback and exchange answer 503. A session token joins a board over the WebSocket and the socket closes when it expires. Dev tokens for local use (`PLENARY_DEV_TOKENS`): the served page offers them at `?as=<name>` and as buttons, and only while they are on (`GET /auth/dev`). | `server/auth/`, `test/auth/`, `test/server/revocation.test.js` |
| Boards, Spaces and Groups | `POST /boards` (a Unit member makes boards in their personal space, or in a Space where they hold `board.create`), `POST /spaces`, Space and Group pages, New board and New space pickers, rename, general access (PROTOCOL.md § Spaces and Groups). | `server/auth/spaces.js`, `web/adapters/dom/spaces.js`, `test/auth/spaces.test.js` |
| Admin API | invites, share links and grants over HTTP. Grant changes close live connections that lost their role. A first tenant admin comes from "Creating a tenant" below. | `server/auth/http.js`, `server/admin/boards.js`, `test/auth/http.test.js`, `test/server/main.test.js` |
| Cluster mode | `server/main.js` runs as a cluster node when both `DATABASE_URL` and `NATS_URL` are set: Postgres store and registry, NATS bus, one room host per board under a store lease with takeover, and `PLENARY_ROLES` to split gateway and host nodes. Blobs stay on local disk (nothing writes blobs yet); the S3 adapter is tested but not wired. Each adapter has its port's contract test, which CI's second job runs against real services. Exercised end to end only through the local rig and the tests. | `server/store/postgres.js`, `server/registry/postgres.js`, `server/bus/nats.js`, `server/blobs/s3.js`, `scripts/cluster-rig.js`, `test/server/` |
| Web canvas | The canvas UI from the design mock (tools, properties panel, layers, library, export, role gating, a connection pill), **served by the server at `/`** and synced over `/ws`. `web/dev-main.html` is a dev-only copy whose boards run inside the browser. | `web/index.html`, `web/main.js`, `web/adapters/`, `test/web/` |
| Collaboration UI | Avatars (people who can draw), a viewers count, others' cursors and selections, laser, emotes, reactions, comment threads, notes. In the served page over the board connection. | `web/adapters/dom/collab/`, `web/adapters/collab/sync.js`, `test/web/collab/` |
| Web edges | The WebSocket transport, the sign-in code exchange and the dev sign-in menu, each tested (the adapters against port contract tests). All used by the served page. | `web/adapters/`, `web/core/signin.js`, `test/web/adapters/`, `test/web/contracts/`, `test/web/core/signin.test.js` |
| Load client | `scripts/load/run.js` drives simulated editors, annotators and viewers against a board (or `--local` its own server) and writes a measured report. A local rig (`scripts/cluster-rig.js`) starts Postgres, NATS, several nodes and a load balancer. The 10k-client M2 gate has not been run. | `scripts/load/`, `scripts/cluster-rig.js`, `test/load/` |

### Not there yet (M2, planned)

- **The 10k-client load test** (the M2 gate) and **`/metrics`**: the load client exists, no measured run is recorded
  here and the server has no metrics endpoint.
- **S3 blobs in the server:** `server/main.js` composes local-disk blobs in both modes.
- **Multi-node deployment beyond the local rig:** the cluster Compose file in `deploy/` has not been built or run here.

## Repo layout

| Path | What |
|---|---|
| `packages/core/` | herdr-draw's core, copied byte-identical. Not edited here (see below). |
| `packages/protocol/` | The protocol as code: envelope, codec, `Replica` (client), `Room` (reference sequencer), presence, records, ports (interfaces for storage, bus, blobs and auth). |
| `server/` | The server: gateway, room host, stores (SQLite, Postgres), buses (memory, NATS), blobs (disk, S3), registries, sign-in and admin. |
| `web/` | The canvas page (served by `server/`), painter, editor-to-replica sync, collaboration UI, and the browser's ports and adapters. |
| `scripts/` | `admin-bootstrap.js` (first tenant admin), `load/` (load client), `cluster-rig.js` (local cluster), `dev-google.js` (a dev-only harness for checking Google sign-in by hand). None is the product server. |
| `test/` | All tests (`bun test`). |
| `deploy/` | Dockerfile and Compose files (see Docker). |
| `PROTOCOL.md` | The protocol v1.1 spec. |

## Dev loop

You need [Bun](https://bun.sh) 1.4.4 (the version CI pins in `.github/workflows/ci.yml`).

```sh
bun install --frozen-lockfile
bun test
```

- **One dependency:** the NATS client, pinned in `bun.lock`.
- **Skipped tests are expected.** The Postgres, NATS and S3 tests run only when `DATABASE_URL`, `NATS_URL` and
  the `S3_*` variables are set. CI has a second job that starts those services and runs them.
- **Disk cleanup.** Test, load and rig runs leave dirs behind. `bun run clean` lists what it would remove and the
  bytes (a dry run); `bun run clean --yes` removes it. It keeps anything young (`--min-age`, default 2h; under 10m needs `--force`) or in use,
  and never touches a live rig; see `deploy/cluster/RIG.md` ("Cleaning up").
- **CI** runs `bun test` on every push and pull request.
- **`bun run test:compose`** (#71): the three-node cluster test on a container runtime. Not part of `bun test` or
  `bun run test:cluster`. Builds the image, starts Postgres, NATS, MinIO and three nodes as Compose project
  `plenary-c3-<pid>`, checks sequencing, viewer fan-out (and a viewer's op refused), four SIGKILL cases (the board's host, the host restarted
  at once, a host with no client, a plain gateway; acked ops all survive, lease epoch rises) and a node rejoin, then removes everything and verifies nothing is left. About 100 s warm. Uses docker, else
  podman (`CONTAINER_CLI` overrides). Without a runtime it prints a loud SKIPPED banner and exits 0 (`--require`
  exits 1). Details: `deploy/README.md` "Cluster test on containers".
- **Plain JS + JSDoc, no build step.** `packages/protocol` must also load in runtimes without browser or Node
  globals, so it imports only two core files and its own. `test/purity.test.js` checks this statically.
- **Protocol changes** start in `PROTOCOL.md`, then code, then a convergence test.

### Run the server locally

```sh
PORT=0 PLENARY_DATA_DIR="$(mktemp -d)" \
PLENARY_DEV_TOKENS='{"dev-token":{"name":"ann","role":"editor"}}' \
bun server/main.js
```

- **The canvas** is served at `/`: Home with no `?board=`, a board with `?board=<id>` (see "Try it" for dev sign-in URLs).
- **`PORT=0`** picks a free port; the chosen port and the dev board's id are in the JSON log lines.
- **Check it:** `GET /health` answers 200 with a small JSON body. The WebSocket is at `/ws`; the token goes in the
  first message (`hello`), never in a header or the URL. With the command above, a `hello` carrying `dev-token`
  and the dev board's id is welcomed as `dev:ann`.
- **Dev tokens are for local use only.** Without `PLENARY_DEV_TOKENS` there is no dev board and no dev sign-in; boards
  then come from `POST /boards` by a member of a Unit (see "Creating a tenant").
- **Bun loads `.env`** from the current directory, so a `.env` with `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
  turns Google sign-in on even in the command above. Without them, `/auth/login`, `/auth/callback` and
  `/auth/exchange` answer 503. For a working sign-in, use the next command instead, not `PORT=0`.
- **Most variables** (`HOST`, `LOG_LEVEL`, `COOKIE_KEY`, `SESSION_KEY`, `PUBLIC_URL`, `OIDC_REDIRECT_URI`, and
  more) are listed with their defaults at the top of `server/main.js`. Two are read further down:
  `POST_LOGIN_URL` and `BOARD_URL` (where the browser goes after sign-in and after a share link), both
  defaulting to this server's origin. Names use the project's working prefix (`PLENARY_`), which may change
  when the name is settled.

### Google sign-in locally

Google sends the browser back to the redirect URI, so the port must be fixed and must match it:

```sh
PORT=8080 PLENARY_DATA_DIR="$(mktemp -d)" OIDC_REDIRECT_URI=http://localhost:8080/auth/callback PUBLIC_URL=http://localhost:8080 bun server/main.js        # GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from your shell or .env
```

- **Register that exact redirect URI** (`http://localhost:8080/auth/callback`) on your Google OAuth client. To use
  another port, change all three values and register the matching URI.
- **The two values above are the defaults**; they are written out so the dependency on the port is visible.
- **After sign-in the browser lands on the canvas** at `/`: the server serves the page, which exchanges the one-time
  code in the address bar for a session. Open a board as `/?board=<id>`.

### Creating a tenant

`POST /boards` needs a caller who belongs to a tenant (a Google Workspace domain): any member makes boards in their personal space, and in Spaces where they hold `board.create`. A tenant needs at least one admin to exist; two ways to make the first one:

- **Dev tokens:** a token with `"domain"` and `"admin": true` makes that domain's tenant at start and adds the user as
  its admin, for example `{"tok-ann":{"name":"ann","domain":"acme.test","admin":true}}`. Then
  start the "Try it" server (port 8099) with that token added to `PLENARY_DEV_TOKENS`, then
  `curl -X POST -H "Authorization: Bearer tok-ann" -H "Content-Type: application/json" -d '{"title":"All hands"}' http://localhost:8099/boards` answers 201 with the board. (An `admin` or `domain` token is never offered in the sign-in menu; use it only this way.)
- **Operator CLI:** `bun scripts/admin-bootstrap.js --domain acme.com --admin alice@acme.com` (run with the same
  environment as the server; idempotent, additive; `--admin` takes an email on the domain, `google:<sub>` or `dev:<name>`).

### Open the canvas without the server

A dev page runs boards **inside the browser** (a SharedWorker; no server). It needs any static file server (not `file://`).
From the repo root:

```sh
python3 -m http.server 0 --bind 127.0.0.1
```

- **Canvas:** open `/web/dev-main.html?board=demo&as=ada` on the printed port. `as` picks a dev user (`ada` owner,
  `bo` editor, `cy` and `di` annotators, `ed` viewer, `fi` commenter; `web/core/dev-users.js`). Open a second tab
  on the same board to see two users edit together.
- **Collaboration UI on a fake port:** `/web/collab/dev.html`.
- **The server never serves these pages** (`web/dev*.html`, the in-browser rooms and `web/core/dev-users.js` are
  denied by `server/static.js`).

## Protocol

[`PROTOCOL.md`](PROTOCOL.md) is the spec (v1.1): one room per board is the only sequencer, an acknowledged op is
never lost, and clients that apply the same log end in the same state. The server never runs layout; clients do.

## The `packages/core` rule

`packages/core/` is herdr-draw's `core/`, copied byte for byte. `packages/core/SOURCE.json` records the source
commit and a SHA-256 per file.

- **Do not edit it here.** Change it in herdr-draw, then re-copy and update `SOURCE.json`.
- **`test/core-source.test.js` fails on drift.** It always checks the files against `SOURCE.json`. It also
  compares them with a herdr-draw checkout at `../herdr-draw` when one exists (CI clones it; locally that check
  is skipped if the directory is missing).

## Docker

[`deploy/README.md`](deploy/README.md) has the Dockerfile, the single-node Compose file, the cluster Compose file
and their variables.

- **Never built here:** no image from `deploy/` has been built or run as part of this README's checks.
- **Cluster Compose** defines Postgres, NATS, an S3-compatible store, three app nodes and a load balancer. The server
  can run as a cluster node (see "Cluster mode" above), but this Compose file has not been built or run here; the
  local rig (`scripts/cluster-rig.js`, `deploy/cluster/RIG.md`) is what has been exercised.
- **Nothing is published:** no registry, no public image.

## Design

- [`PROTOCOL.md`](PROTOCOL.md): the wire protocol and the ports (store, bus, blobs, auth, registry).

## License

Apache-2.0, see [`LICENSE`](LICENSE).
