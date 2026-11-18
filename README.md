# PROJECT_NAME

> `PROJECT_NAME` is a placeholder: the project's name is not settled yet.

PROJECT_NAME is a live infinite canvas for enterprise all-hands meetings, meant to be open source (the license
is not chosen yet; see License). The goal: a few presenters draw, thousands annotate and react, and 100,000+
people watch live across several regions. It grew out of [herdr-draw](https://github.com/ryanthedev/herdr-draw)
and shares its drawing core.

**That is the goal, not today's state.** The project is early. Nothing has been load-tested and nothing is
published (no packages, no images, no hosted instance). The server and the web page both run, but **the web page
does not talk to the server yet**. The next section says exactly what exists.

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
| Sign-in | Google sign-in (OIDC) with a one-time code exchanged for a session token (`/auth/login`, `/auth/callback`, `/auth/exchange`, `/auth/logout`), mounted in the server. It is on only when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set; otherwise login, callback and exchange answer 503. A session token joins a board over the WebSocket and the socket closes when it expires. Optional dev tokens for local use. | `server/auth/`, `test/auth/`, `test/server/revocation.test.js` |
| Admin API | `POST /boards`, invites, share links and grants over HTTP. Grant changes close live connections that lost their role. **See the tenant gap below.** | `server/auth/http.js`, `server/admin/boards.js`, `test/auth/http.test.js`, `test/server/main.test.js` |
| Cluster adapters | Postgres store and registry, NATS bus, S3-compatible blobs. Each has its port's contract test, which CI's second job runs against real services. **The server does not use them yet** (see below). | `server/store/postgres.js`, `server/registry/postgres.js`, `server/bus/nats.js`, `server/blobs/s3.js`, `test/server/` |
| Web canvas | The canvas UI from the design mock (tools, properties panel, layers, library, export, role gating, a connection pill). Boards run **inside the browser**: every tab of one browser on the same board edits together through a SharedWorker. | `web/index.html`, `web/app.js`, `test/web/` |
| Collaboration UI | Avatars, others' cursors and selections, laser, emotes, reactions, comment threads, notes. Runs on a dev page over a fake port. | `web/collab/`, `web/collab/dev.html`, `test/web/collab/` |
| Web edges | A WebSocket transport and the sign-in code exchange for the browser, each tested (the adapters against port contract tests). Not used by any page yet. | `web/adapters/`, `web/core/signin.js`, `test/web/adapters/`, `test/web/contracts/`, `test/web/core/signin.test.js` |

### Not there yet (M2, planned)

- **Web page to server:** the canvas page does not connect to the server, and the server does not serve `web/`
  (`GET /` answers 404). So after a Google sign-in there is no page to land on.
- **Collaboration in the main page:** the collaboration UI runs only on `web/collab/dev.html`, not in
  `web/index.html`.
- **Creating a tenant:** `POST /boards` needs a caller who is an admin of a tenant, and nothing in the running
  server creates such a tenant yet (no HTTP route, no command). On a fresh server it answers 403 to everyone,
  dev tokens included. The tests create the tenant directly in the registry. Planned: a first-admin bootstrap
  (decided, not built yet).
- **Cluster mode:** `server/main.js` composes only the SQLite, in-memory and local-disk adapters. Setting
  `DATABASE_URL` or `NATS_URL` today only makes `COOKIE_KEY` required (and every node must use the same
  value, because each node checks cookies and sessions signed by the others). Board leases, host takeover and the
  gateway/host role split are not built.
- **Load test and `/metrics`.**

## Repo layout

| Path | What |
|---|---|
| `packages/core/` | herdr-draw's core, copied byte-identical. Not edited here (see below). |
| `packages/protocol/` | The protocol as code: envelope, codec, `Replica` (client), `Room` (reference sequencer), presence, records, ports (interfaces for storage, bus, blobs and auth). |
| `server/` | The server: gateway, room host, stores (SQLite, Postgres), buses (memory, NATS), blobs (disk, S3), registries, sign-in and admin. |
| `web/` | The canvas page, painter, editor-to-replica sync, collaboration UI, and the browser's ports and adapters. |
| `scripts/` | `dev-google.js`, a dev-only harness for checking Google sign-in by hand. Not the product server. |
| `test/` | All tests (`bun test`). |
| `deploy/` | Dockerfile and Compose files (see Docker). |
| `docs/m2/` | The M2 plan, design mock, contracts and working reports. |
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
- **Plain JS + JSDoc, no build step.** `packages/protocol` must also load in runtimes without browser or Node
  globals, so it imports only two core files and its own. `test/purity.test.js` checks this statically.
- **Protocol changes** start in `PROTOCOL.md`, then code, then a convergence test.

### Run the server locally

```sh
PORT=0 PLENARY_DATA_DIR="$(mktemp -d)" \
PLENARY_DEV_TOKENS='{"dev-token":{"name":"ann","role":"editor"}}' \
bun server/main.js
```

- **`PORT=0`** picks a free port; the chosen port and the dev board's id are in the JSON log lines.
- **Check it:** `GET /health` answers 200 with a small JSON body. The WebSocket is at `/ws`; the token goes in the
  first message (`hello`), never in a header or the URL. With the command above, a `hello` carrying `dev-token`
  and the dev board's id is welcomed as `dev:ann`.
- **Dev tokens are for local use only.** Without `PLENARY_DEV_TOKENS` there is no dev board, and nothing else
  can create a board yet (see "Creating a tenant"), so no client can join.
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
- **Today the browser ends on a 404** after sign-in, because the server serves no page yet (see "Web page to
  server" above).

### Open the canvas

The page is plain ES modules, so it needs any static file server (not `file://`). From the repo root:

```sh
python3 -m http.server 0 --bind 127.0.0.1
```

- **Canvas:** open `/web/index.html?board=demo&as=ada` on the printed port. `as` picks a dev user (`ada` owner,
  `bo` editor, `cy` and `di` annotators, `ed` viewer, `fi` commenter; `web/ui/dev-users.js`). Open a second tab
  on the same board to see two users edit together.
- **Collaboration UI:** `/web/collab/dev.html`.
- **Remember:** both run entirely in the browser; neither talks to the server.

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
- **Cluster Compose** defines Postgres, NATS, an S3-compatible store, three app nodes and a load balancer, but each
  app node still runs single-node (see "Cluster mode" above).
- **Nothing is published:** no registry, no public image.

## Design

- [`PROTOCOL.md`](PROTOCOL.md): the wire protocol and the ports (store, bus, blobs, auth, registry).
- [`docs/m2/PLAN.md`](docs/m2/PLAN.md): the M2 phases and what "done" means for each.
- [`docs/m2/design/`](docs/m2/design/): the static UI mock the canvas was built from.
- [`docs/m2/contracts/auth-exchange.md`](docs/m2/contracts/auth-exchange.md): the sign-in code exchange.

## License

Not yet chosen. Until a LICENSE file is added, no license is granted.
