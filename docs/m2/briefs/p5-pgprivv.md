# Brief: p5-pgprivv (verify p5-pgpriv)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report only to t187; never message the proxy or engine. Change nothing in the tree. Never pkill/killall; servers/containers you start are recorded and only those stopped (Podman: record the container id, remove it after). Never print .env values. If a full run fails, name the failing tests (`bun test 2>&1 | grep -E '\(fail\)'`). Report: docs/m2/reports/p5-pgprivv.md, PASS or FAIL with HIGH/MEDIUM/LOW.

## Job under check

Brief: docs/m2/briefs/p5-pgpriv.md. Builder's report: docs/m2/reports/p5-pgpriv.md (read its not-verified and risks
yourself; don't trust its claims). Files: diff of server/registry/postgres.js, server/registry/sqlite.js,
test/server/pg-registry.test.js, deploy/README.md; new test/server/sqlite-registry-open.test.js. Other sessions edit
nearby files: judge only these; report anything else as noise.

## Check

- **Postgres, for real:** start Postgres in Podman on a free port (as CI does), set DATABASE_URL for your runs only.
  The Registry contract passes as a runtime role with only SELECT/INSERT/UPDATE/DELETE on owner-created tables; a
  missing table without CREATE right fails loudly with the 42501 message the builder describes. Runtime start-up
  never ALTERs, DROPs or owns anything (read the code and watch the statements, e.g. log_statement=all).
- **Concurrent start-up:** N processes against an empty database at once (advisory lock): all start, one schema.
- **The builder's PG15+ finding:** a runtime role with no table grants starts and fails on first query. Judge it:
  should start-up probe a grant and fail fast? Rate it; don't fix it.
- **SQLite open fix** (sqlite.js: skip the WAL switch if already WAL, bounded retry with backoff within
  busy_timeout): the new test fails on the old code (check with a scratch copy, never the tree), passes on new; no
  unbounded wait, no swallowed non-BUSY errors; the 12-process race.
- **deploy/README.md:** the owner/runtime SQL actually works when pasted (run it); line 21 no longer stale.
- Hexagonal: adapters import only ports; both architecture tests. Full `bun test` with and without DATABASE_URL.
- distributed-systems-design CHECKER on concurrent start-up (skill or read SKILL.md directly).
- sdd ensemble review of this job's diff (codex + agy + any harness passing check_adapter; never give them .env).
  Then stop.
