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

Secrets (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) come from your shell (`export ...` before `docker compose up`),
never this repo. Don't use a `.env` file yet: `.gitignore` doesn't exclude it and there is no `.dockerignore`.

CI (`.github/workflows/ci.yml`) runs `bun test` on every push and pull request.
