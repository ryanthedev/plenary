# Brief: p5-pgpriv2v (verify Registry query timeouts + the five LOWs)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report only to t187; never
prompt, hc send or SendMessage to the proxy (t1bx) or engine. Never pkill/killall; servers/containers you start are
recorded and only those stopped (Podman: record the id, remove it after). Never print .env values. If a full run
fails, name the failing tests (`bun test 2>&1 | grep -E '\(fail\)'`). Report: docs/m2/reports/p5-pgpriv2v.md with
PASS or FAIL and findings graded HIGH/MEDIUM/LOW. Stop at 60% context after writing what you have. Do not edit code;
do not commit. Scratch copies go in your scratchpad, never in the tree.

## Job under check

p5-pgpriv2 (brief docs/m2/briefs/p5-pgpriv2.md, report docs/m2/reports/p5-pgpriv2.md). Its files, uncommitted in the
tree: server/registry/postgres.js, server/registry/sqlite.js, test/server/pg-registry.test.js,
test/server/sqlite-registry-open.test.js, test/server/registry.test.js, deploy/README.md lines 25-26 only (the file's
other hunks belong to other jobs). Diff them against HEAD. Read the builder's claims as claims, not facts.

## The bar

A Registry call on Postgres never stays pending past its limit and rejects with a coded error; the pool works after;
start-up never hangs on a stuck lock and fails fast for a role missing a right; the SQLite busy budget is a hard cap;
nothing else changes behaviour (contract tests on memory, SQLite and Postgres still pass).

## Check

- **Timeouts, adversarially, on real Postgres (Podman):** row lock, table lock, advisory lock at start-up, on both an
  owned pool (`url`) and a caller's `sql`; equal and unequal limits; many concurrent calls on a small pool; confirm the
  error codes (`lock-timeout`, `statement-timeout`), that other errors (e.g. an operator's `pg_cancel_backend`,
  unique violations) pass through unchanged, and that a timed-out write left nothing half-done.
- **The builder's open points:** reads on a caller-owned `sql` are unbounded unless it sets `connection` (grade it;
  does any production path pass `sql`?); a queued call rejecting with another call's timeout; equal defaults read as
  `statement-timeout`; the set_config(…, true) in write() really is transaction-local (a later read on the same
  connection is not bounded by a leftover).
- **Privilege probe:** none, SELECT-only, one right missing, all rights, rights via a group role; does the probe
  refuse a role a correct operator setup would use (deploy/README.md's snippet)? Run that snippet as written.
- **SQLite hard cap:** re-run the builder's 2x scenario old vs new; look for a path where busy_timeout is not restored
  after start-up (throw paths).
- **Mutations:** break each fix once (drop the error mapping, drop the start-up lock_timeout, drop one probe right,
  undo the hard cap) in a scratch copy and confirm a test fails.
- **Gates:** pg-registry and registry tests with DATABASE_URL; full `bun test` with and without DATABASE_URL; name every
  failure and decide whether it is this job's (the builder blames gateway.js/static.js/web/ edits by other sessions
  and tune's `here`; check by running with HEAD's two adapters in a scratch copy). Known unrelated:
  test/core-source.test.js, tune.test.js R2.
- **Design skill:** `distributed-systems-design` in CHECKER mode on how the 15 s limit composes with the gateway's
  recheckLookupMs (2 s) and helloTimeoutMs (10 s) under a stuck lock at 100k joins; report.
- **sdd ensemble review** of the job's hunks (codex + agy + any harness passing check_adapter). Two agreeing = HIGH
  candidate; confirm or refute each with a test or a run.

## Done when

Report written (gates, commands and outputs minus secrets, each claim confirmed or refuted, findings). Then stop.
