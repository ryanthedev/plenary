# Brief: p5-devadminv (verify p5-devadmin)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report only to t187; never message the proxy or engine. Change nothing in the tree. Never pkill/killall; servers on port 0 from a command that records the PID; kill only those. Never print .env values. If a full run fails, name the failing tests (`bun test 2>&1 | grep -E '\(fail\)'`). Report: docs/m2/reports/p5-devadminv.md, PASS or FAIL with HIGH/MEDIUM/LOW.

## Job under check

Goal: nobody could create a board (POST /boards 403 for everyone: no tenant has an admin). Agreed with engine: an
idempotent `bootstrapTenant({ registry, domain, admins })` (core, server/admin/tenants.js, ports only), an operator
CLI (scripts/admin-bootstrap.js, composition root), and main.js's dev path bootstrapping dev domains whose tokens
are flagged admin; plus main.js's stale sign-in log line. Brief: docs/m2/briefs/p5-devadmin.md. Files:
server/admin/tenants.js, scripts/admin-bootstrap.js, test/admin/*.test.js (new); diff of server/admin/boards.js,
server/main.js, test/auth/architecture.test.js (other sessions also edit main.js: judge only this job's hunks;
report anything else you see as noise).

**Security-relevant, look hardest:** tenant admins may now be named `email:<addr>` before their first sign-in,
matched in boards.js `isTenantAdmin` (the builder says: vouched email + same Workspace domain). Try to become an
admin you shouldn't be: an unvouched email (consumer account, Workspace secondary domain), the same address on another
domain, case/Unicode/plus-addressing tricks, a dev token claiming that email, a Google account whose `hd` differs.
Compare with oidc.js's authoritative-email rule.

Builder's not-verified list and risks (not its claims): read docs/m2/reports/p5-devadmin.md's sections yourself;
it reports SQLite 'database is locked' when several processes open a new registry.db at once (engine's adapter).

## Check

- Idempotent and never demotes/removes; two concurrent bootstraps (two processes on one SQLite file; Postgres if
  DATABASE_URL is set) end consistent.
- CLI: validates before opening anything; exit codes; prints nothing secret.
- A stock single node with an admin dev token can POST /boards (201), a non-admin of that domain 403, and nothing
  changes for production (dev tokens off: no bootstrap).
- Both architecture tests; full `bun test`.
- distributed-systems-design CHECKER on the concurrent bootstrap (skill or read SKILL.md directly).
- sdd ensemble review of this job's hunks (codex + agy + any harness passing check_adapter; never give them .env).
  Then stop.
