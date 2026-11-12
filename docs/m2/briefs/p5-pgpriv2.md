# Brief: p5-pgpriv2 (Registry query timeouts + p5-pgprivv's five LOWs)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report only to t187; never
prompt, hc send or SendMessage to the proxy (t1bx) or engine. Never pkill/killall; servers/containers you start are
recorded and only those stopped (Podman: record the id, remove it after). Never print .env values. If a full run
fails, name the failing tests (`bun test 2>&1 | grep -E '\(fail\)'`). Report: docs/m2/reports/p5-pgpriv2.md. Stop at
60% context after writing what you have.

## Goal

1. **Registry query timeout (engine's request, docs/m2/reports/p2-tunev.md HIGH 1):** server/registry/postgres.js
   builds `new SQL(url)` with no query timeout; a Postgres lock wait stayed pending past 15 s, while
   server/auth/registry-port.js:11-14 says a timeout rejects. Make the port's text true for Postgres: a per-session
   `lock_timeout` and `statement_timeout` (configurable, default 15 s like the Store's p4-store-lease; read how
   server/store/postgres.js does `lock_timeout` and its error code `lock-timeout`, and match it). A timed-out call
   rejects with a clear coded error. Test it for real: hold a row/table lock from a second connection and show the
   Registry call rejects near the limit, and that the pool is usable after.
2. **The five LOWs from docs/m2/reports/p5-pgprivv.md** (read each in full):
   - SQLite `onBusyRetry` budget overruns `busy_timeout` ~2x (server/registry/sqlite.js:34-42, 61-69): make it a hard cap.
   - PG15+ runtime role with no table grants starts, then every call fails 42501: probe at start-up and fail fast
     with a clear message (or justify only documenting it).
   - No `lock_timeout` on the start-up advisory lock (server/registry/postgres.js:86): bound it; a stuck holder must
     fail start-up loudly, not hang. (The Store has the same issue: report it, don't fix server/store/.)
   - test/server/pg-registry.test.js leaks pools/schemas/roles on failure paths: clean up in finally/afterEach.
   - deploy/README.md lines 25-26 still say "in-memory registry": fix those two lines only.

## Files you own

server/registry/postgres.js, server/registry/sqlite.js, test/server/pg-registry*.test.js, test/server/ registry
sqlite tests if any, deploy/README.md lines 25-26 only. **Not** server/auth/registry-port.js (it holds p5-load's
uncommitted hunk; if its timeout text needs a change, put the exact wording in your report), not deploy/README.md's
other uncommitted hunk, not server/store/, server/pg/schema.js, server/gateway.js (engine's). Other sessions edit the
tree; known unrelated failures: test/core-source.test.js (herdr-draw dirty tree), test/server/tune.test.js R2
(engine's work in progress).

## Systems design

`distributed-systems-design` APPLIER, short: what the timeout means for a gateway hello and the timed re-check pass
(fail closed? retry?) and how it composes with engine's gateway per-lookup timeout (recheckLookupMs, 2 s). Note it in
the report.

## Done when

The above; pg tests run for real against Podman Postgres; full `bun test` (with and without DATABASE_URL) passes
except the known unrelated failures; report (what changed, tests, the skill note, not-verified, risks). Then stop.
Do not commit.
