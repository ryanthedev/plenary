# Brief: p8-deploy (make deploy/ match the real server entry)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t14q). Report: docs/m2/reports/p8-deploy.md.
Never pkill/killall; start servers on port 0 from a command that records the PID; kill only that PID.

## Goal

`server/main.js` now exists (engine's phase-3 scaffold, possibly still uncommitted; read it, don't edit it). The
deploy files still say it "comes in phase 3", and the container would not be reachable: main.js listens on
127.0.0.1 unless `HOST` is set. Make deploy/ correct for today's server.

## Files you own

`deploy/Dockerfile`, `deploy/compose.yml`, `deploy/README.md`, `.dockerignore`. Nothing else (README.md is in
verification by another session: don't touch it; note anything it should change in your report).

## Do

1. Read server/main.js's header and env handling: every env var it reads (names, defaults), its port, /health,
   data dir, dev-token config. Match them exactly; don't invent names.
2. Dockerfile: `ENV HOST=0.0.0.0` (a container must listen on all interfaces; compose still publishes only on
   127.0.0.1); CMD matches the real entry; HEALTHCHECK against the real /health (remove "pending phase 3"); data
   dir matches what main.js reads.
3. compose.yml: env by name only (dev tokens as `${PLENARY_DEV_TOKENS:-}` or whatever main.js reads: never a
   value in the file); `restart: unless-stopped` now that the entry exists; remove stale phase-3 comments.
4. deploy/README.md: how to run it today, what env vars mean, that dev tokens are for local use only; remove
   "not runnable until phase 3".
5. Check `.dockerignore` and the Dockerfile's COPY list still give the image everything main.js imports
   (resolve its import graph).

## How to check (no Docker on this machine)

- Simulate the container's start: run main.js with exactly the env the Dockerfile + compose would give it
  (`HOST=0.0.0.0`, `PORT=0` instead of the fixed port, a temp data dir), hit /health, stop it by PID.
- Run the HEALTHCHECK command string against it.
- YAML parses (`ruby -ryaml`); `bun test` passes.
- Say plainly: image never built, compose never run.

Done when the above holds and the report is written. Then stop. Do not commit.
