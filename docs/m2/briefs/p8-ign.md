# Brief: p8-ign (root ignore files + p8-civ follow-ups)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t14q). Report: docs/m2/reports/p8-ign.md.

## Goal

Keep secrets, databases and repo history out of git and out of the Docker image. The proxy gave platform the root
`.dockerignore` and `.gitignore` (whole files) on 2026-11-11. Also fix three LOW findings from the p8-ci verifier
(docs/m2/reports/p8-civ.md).

## Files you own (touch nothing else)

`.dockerignore` (new, repo root), `.gitignore`, `.github/workflows/ci.yml`, `deploy/compose.yml`,
`deploy/README.md`, `deploy/Dockerfile`.

## Do

1. **`.gitignore`** (keep the existing `node_modules`, `.DS_Store`): add `.env` and `.env.*` (but allow a future
   `.env.example` with `!.env.example`), `*.db`, `*.sqlite`, `*.sqlite3` and their `-wal`, `-shm`, `-journal`
   files, local data/blob dirs (`/data/`, `/blobs/`, `deploy/data/` or whatever the Dockerfile/compose use; read
   them), editor/OS noise only if obvious.
2. **`.dockerignore`** (root; the build context is the repo root): `.git`, `.github`, `docs`, `node_modules`,
   the same secrets/db/blob patterns, `deploy/` except what the image needs (it needs nothing from deploy/ at
   runtime; the Dockerfile is read by docker, not COPY). Do NOT exclude anything the server or tests need at
   runtime: `packages/`, `server/`, `web/`, `package.json`, `PROTOCOL.md` if referenced. Decide whether `test/`
   belongs in the image (say why).
3. **ci.yml:** cancel superseded runs on PRs only, never on `main`:
   `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`.
4. **compose.yml:** top-level `name: plenary` so the volume name is stable.
5. **deploy/README.md:** say that with `-f deploy/compose.yml`, Compose reads `.env` from `deploy/`, and that
   `.env*` is git-ignored.

## How to check

- `git check-ignore -v` on sample paths (`.env`, `.env.local`, `.env.example` must NOT be ignored, `x.db`,
  `x.sqlite-wal`, `data/blob`), and `git status` shows no tracked file newly ignored (`git ls-files -ci
  --exclude-standard` must be empty).
- For `.dockerignore`: no Docker here. Simulate: list `git ls-files -co --exclude-standard` and show which files
  the patterns keep (a short script is fine; say it is a simulation, not Docker's matcher).
- YAML parses (`ruby -ryaml`). `bun test` passes.

Done when the above holds and the report is written. Then stop. Do not commit.
