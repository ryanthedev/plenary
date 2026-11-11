# Brief: p8-deployv (verify p8-deploy: deploy/ matches server/main.js)

docs/m2/BRIEF-BASE.md applies. You are the verifier, never the builder. Manager: `manager platform` (t14q).
Report: docs/m2/reports/p8-deployv.md, starting with **PASS** or **FAIL**, then HIGH/MEDIUM/LOW findings.
Write nothing outside that report and your session scratchpad. Do not commit. Never pkill/killall; port 0; kill
only PIDs you recorded.

## Goal and done-when (docs/m2/briefs/p8-deploy.md: read it)

deploy/Dockerfile, deploy/compose.yml, deploy/README.md and .dockerignore match today's server/main.js: `HOST=0.0.0.0`
in the container, CMD and HEALTHCHECK on the real entry and /health, env vars by name only and exactly the ones
main.js reads, `restart: unless-stopped`, no stale "phase 3" notes, the image gets every file main.js imports.
Nothing published, no secrets in files.

## The diff

`git diff -- deploy .dockerignore`.

## Try to break it

- Every env var in deploy/ vs what server/main.js actually reads (names, defaults). Any invented or missing name.
- Resolve main.js's full import graph; is every file inside the Dockerfile's COPY set and not excluded by
  .dockerignore? (Simulate; no Docker here.)
- Simulate the container: run main.js with exactly the env the image + compose give (`PORT=0` instead of the fixed
  port, temp data dir), hit /health, run the HEALTHCHECK command string against it, stop by PID.
- Any secret value, real name in prose (env var names are fine: manager ruling), or publish/push path.
- compose still publishes only on 127.0.0.1; YAML parses (`ruby -ryaml`).
- `bun test`: engine's untracked test/server has 4 failing tests today (not this job). Confirm none involve
  deploy/ or .dockerignore.

## sdd ensemble review (required, OFFICE.md "sdd helpers")

Load `sdd:subagent-driven-development` first. Check `usage`, then review the diff with codex + agy + every other
harness passing `check_adapter`. Two agreeing = HIGH candidate: confirm or refute. List which harnesses ran.

## The builder's not-verified list and risks (only these)

- Image never built, compose never run; `/data` writability for the `bun` user, HEALTHCHECK inside the image and
  the volume keeping the `chown` unchecked; the 0.0.0.0 bind seen on macOS only.
- With dev tokens off, a container runs and refuses every hello (expected today).
- The dev board id changes on every restart (in-memory registry).
- `web/` is in the image but unused.

Grade HIGH: a secret in a file, a wrong env name that breaks start, a missing runtime file, or anything that
publishes. Then stop and leave the session idle.
