# Brief: p8-civ (verify p8-ci: CI + Docker skeleton)

docs/m2/BRIEF-BASE.md applies. You are the verifier, never the builder. Manager: `manager platform` (t14q).
Report: docs/m2/reports/p8-civ.md, starting with **PASS** or **FAIL**, then HIGH/MEDIUM/LOW findings.
Write nothing outside that report and a scratch dir (your session scratchpad). Do not commit.

## Goal and done-when (from docs/m2/briefs/p8-ci.md)

A GitHub Actions workflow that runs `bun test` on push and PR; a Dockerfile skeleton (Bun base image, non-root)
and a compose stub under deploy/ that later gains Postgres and NATS. Nothing published: no registry pushes, no
public images, no secrets in the repo. Done when the files exist, parse, `bun test` passes the way the workflow
runs it.

## What to check (the job is all new, untracked files)

`git status --short -- .github deploy` lists them: `.github/workflows/ci.yml`, `deploy/Dockerfile`,
`deploy/compose.yml`, `deploy/README.md`. Read them against p8-ci.md.

Try to break it: least privilege (permissions, `persist-credentials`), action pins (confirm the SHAs yourself with
`git ls-remote`; are they real commits for the claimed tags?), anything that could push, log in, leak a secret, or
publish; injection via `${{ }}` in `run:`; Dockerfile runs as non-root; what `COPY . .` would put in the image
(secrets? `.git`?); compose binds only 127.0.0.1 and holds no secret values; YAML parses (ruby -ryaml is
available); the install step's lockfile logic; `bun test` passes.

## The builder's not-verified list and risks (only these, not its claims)

- The workflow was never run on GitHub; actionlint not installed.
- Docker is not installed here: `docker build` and `docker compose config` were not run.
- `server/main.js` does not exist; the container exits at start until phase 3.
- No `.dockerignore` (the build context is the repo root); `.gitignore` lacks `.env*`.
- Env and port names (`PORT=8080`, `PLENARY_DATA_DIR`, `DATABASE_URL`, `NATS_URL`) are the builder's picks.
- Same-repo PRs run CI twice (push + pull_request).

Grade a finding HIGH only if it would publish, leak a secret, or make the workflow fail on GitHub.
Then stop and leave the session idle.
