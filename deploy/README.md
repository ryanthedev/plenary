# deploy/

Skeleton packaging for Plenary (M2 phase 8). Nothing here is published: no registry pushes, no public images.

| File | What |
|---|---|
| `Dockerfile` | Single-node image on `oven/bun:1.4.4-slim`, runs as the non-root `bun` user, port 8080, data in `/data`. |
| `compose.yml` | One `plenary` service with a named volume for SQLite and blobs. Postgres and NATS arrive in phase 4. |

```sh
docker build -f deploy/Dockerfile -t plenary:dev .      # context is the repo root
docker compose -f deploy/compose.yml up --build         # binds 127.0.0.1:8080 only
```

**Not runnable yet:** the server entry (`server/main.js`) and `/health` come in phase 3. Until then the
container exits at start and the health check fails.

Secrets (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) come from your shell (`export ...` before `docker compose up`)
or from a `.env` file, never this repo.

- **Where `.env` goes:** `deploy/.env`. With `-f deploy/compose.yml`, Compose reads `.env` from the directory of
  the compose file (`deploy/`), not from the repo root or your current directory.
- **Git:** `.env` and `.env.*` are git-ignored everywhere in the repo; only `.env.example` (a template with no
  values) may be committed.
- **Image:** the root `.dockerignore` keeps `.env*`, databases, `.git`, `docs/`, `test/` and all of `deploy/` out
  of the image. The build context is the repo root, so that is the file Docker reads.

The Compose project is named `plenary` (`name:` in `compose.yml`), so the data volume is `plenary_plenary-data`.

CI (`.github/workflows/ci.yml`) runs `bun test` on every push and pull request. Before the tests it clones
herdr-draw (public, read-only) at the commit in `packages/core/SOURCE.json`, so the core-copy check runs there too.
