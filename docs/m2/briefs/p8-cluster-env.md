# Brief: p8-cluster-env (phase-4 cluster shape in compose, CI services for Postgres and NATS)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t14q). Report: docs/m2/reports/p8-cluster-env.md.
Never pkill/killall; start any server on port 0 from a command that records its PID; kill only that PID.

## Goal (PLAN.md phase 4 + 8)

Phase 4's done-when is "docker-compose 3-node test: kill a board's host, another takes over, no acked op lost".
Get the environment ready before engine's cluster adapters exist: a compose stack in the phase-4 shape, and a CI
job with Postgres and NATS as services so engine's phase-4 tests have somewhere to run.

## Files you own

`deploy/` (add files as needed, e.g. `deploy/cluster.compose.yml`, an LB config) and `.github/workflows/`.
Nothing else. Don't change how the single-node `deploy/compose.yml` works today (it was just verified); a separate
cluster file, or Compose profiles that leave the default unchanged, are both fine: pick one and say why.

## Do

1. **Cluster compose:** Postgres, NATS (JetStream not needed: PROTOCOL.md says NATS core), MinIO for S3-compatible
   blobs (with a one-shot bucket-create service), 3 app nodes built from deploy/Dockerfile, and a small load
   balancer (nginx or Caddy) in front that passes WebSocket upgrades on `/ws` and `/health`. Every image pinned to
   an exact version tag. Only the LB publishes a port, on 127.0.0.1. Healthchecks and `depends_on` conditions.
2. **Env by name only, no secret values in any file.** Required secrets use `${VAR:?message}`. The app nodes'
   env names for cluster adapters don't exist in server/ yet: read server/main.js, reuse any name it already has,
   and for the rest propose names (e.g. `DATABASE_URL`, `NATS_URL`, `S3_ENDPOINT`, `S3_BUCKET`,
   `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, a node id). List the proposed names at the top of your report so
   the manager can send them to engine; mark them `# proposed, engine to confirm` in the file.
3. **CI:** a second job in the workflow (or a new workflow file) with `services:` Postgres and NATS (pinned,
   health-checked), exporting their URLs as env, that runs `bun test`. It must pass today: engine's adapters
   don't exist yet, so nothing reads those env vars; leave a `# TODO(engine phase 4)` where their tests will
   plug in. Same least-privilege rules as the existing job (`permissions: contents: read`, pinned action SHAs,
   no secrets, no push, no registry login). Postgres password in CI may be a throwaway literal in the workflow
   (it's a CI-only service container), but say so in a comment.
4. **deploy/README.md:** a short "Cluster (phase 4, not functional yet)" section: how to start it, what's missing.

## How to check (no Docker here)

- YAML parses (`ruby -ryaml`) for every file; actionlint if installed.
- The LB config: parse/validate it with the tool if installed locally (`nginx -t` / `caddy validate`), else say so.
- Each image tag exists (registry API, as an earlier verifier did for oven/bun); nothing pulled or pushed.
- `bun test` passes. The workflow was never run on GitHub: say so.

Done when the above holds and the report is written. Then stop. Do not commit.
