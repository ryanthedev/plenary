# Brief: p5-pgpriv3v (verify the client-side Registry bound, Round 3)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report only to t187; never
prompt, hc send or SendMessage to the proxy (t1bx) or engine. Never pkill/killall; containers you start are recorded
and only those removed (Podman: record the id). Never print .env values. If a full run fails, name the failing tests
(`bun test 2>&1 | grep -E '\(fail\)'`). Report: docs/m2/reports/p5-pgpriv3v.md with PASS or FAIL and findings graded
HIGH/MEDIUM/LOW. Do not edit code; do not commit. Scratch copies in your scratchpad. Stop at 60% context after writing
what you have.

## Job under check

p5-pgpriv2 plus its fix round p5-pgpriv3 (briefs docs/m2/briefs/p5-pgpriv2.md and p5-pgpriv3.md; report
docs/m2/reports/p5-pgpriv2.md, all rounds, "Round 3" last). The previous verifier failed it: docs/m2/reports/p5-pgpriv2v.md
(H1 queued calls stack timeouts, M1 one locked table stalls all reads, L1-L5). Files, uncommitted: server/registry/postgres.js,
server/registry/sqlite.js, test/server/pg-registry.test.js, test/server/sqlite-registry-open.test.js,
test/server/registry.test.js, deploy/README.md (Postgres section only; other hunks are other jobs). Diff against HEAD.
Read the builder's claims as claims.

## The bar

A Registry call on Postgres never stays pending past about one limit (plus margin), queued or not, and rejects with a
coded error (`lock-timeout`, `statement-timeout`, `queue-timeout`, `overloaded`); a call whose deadline passed before it
got a connection is never sent; the pool works after; no retries inside the adapter; fail-closed. Everything p5-pgpriv2v
checked still holds (start-up, privilege probe, SQLite hard cap, error pass-through, no half-done writes).

## Check

- **H1/M1 on real Postgres, adversarially, your own scripts:** warm (prepared) and cold; more calls than connections
  behind a row lock, a table lock, an advisory lock; an unrelated read on a saturated pool; gate full (`overloaded` at
  once); deadline expiry while queued (confirm via pg_stat_activity / logs that the query was never sent); a call that
  got a connection late but in time; recovery after the lock is released (pool and gate counters return to zero, no
  leaked slot on every error path, including a thrown error inside the gate).
- **Timing:** measure settle times; every call ≤ ~1.5 x the limit. Look for a stacking path left.
- **L1, L3 and the other LOWs:** each fixed or documented as claimed.
- **Mutations:** drop the deadline, drop the gate, release the gate slot late or never, send after deadline, drop the
  busy_timeout restore; confirm a test fails for each.
- **Docs:** header and deploy/README.md accurate (codes, statementTimeoutMs 3-5 s vs the gateway's 2 s recheckLookupMs).
- **Gates:** pg-registry and registry tests with DATABASE_URL; full `bun test` with and without DATABASE_URL. Known
  unrelated: test/core-source.test.js, test/server/tune.test.js "here: bounded…", test/web/collab/wire2.test.js "LOW-1:
  limited…" (other sessions' untracked work); check any other failure against HEAD's adapters in a scratch copy.
- **Design skill:** `distributed-systems-design` CHECKER on the gate size and deadline at 830 hellos/s cluster-wide.
- **sdd ensemble review** of the Round 3 hunks (codex + agy + any harness passing check_adapter). Two agreeing = HIGH
  candidate; confirm or refute each with a test or run.

## Done when

Report written (gates, commands and outputs minus secrets, each claim confirmed or refuted, findings). Then stop.
