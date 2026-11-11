# deploy/

Packaging for the single-node Plenary server (`server/main.js`). Nothing here is published: no registry pushes, no
public images.

| File | What |
|---|---|
| `Dockerfile` | Single-node image on `oven/bun:1.4.4-slim`. Runs `bun run server/main.js` as the non-root `bun` user, listens on 0.0.0.0:8080, data in `/data`, health check on `GET /health`. |
| `compose.yml` | One `plenary` service with a named volume for SQLite and blobs, published on `127.0.0.1:8080` only, `restart: unless-stopped`. Postgres and NATS arrive in phase 4. |

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
