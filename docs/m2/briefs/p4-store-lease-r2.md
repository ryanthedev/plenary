# Brief: p4-store-lease round 2 (fix p4-store-leasev's MEDIUMs + L2, L3)

You are the p4-store-lease builder, resumed. Same base, ownership and rules as docs/m2/briefs/p4-store-lease.md
(server/store/sqlite.js, server/store/postgres.js, packages/protocol/ports.js Store typedef, test/server/store-contract.js,
store.test.js, pg-store.test.js). Don't commit. Manager `t18m`; never message the proxy (t1bx).

- **Read:** docs/m2/reports/p4-store-leasev.md (verdict PASS; each finding has a repro and a proposed test).
- **Fix:**
  1. **M1:** every Postgres write transaction sets `SET LOCAL idle_in_transaction_session_timeout` (a few s); lease calls
     set `SET LOCAL lock_timeout` well under the ttl, and a timeout maps to a PortError the caller can retry
     (`unavailable`). Test: the verifier's repro, `acquire` settles within the bound.
  2. **M2:** add the verifier's three Postgres tests (window for append and checkpoint, host clock, `now()` after a
     lock wait). Each must fail against its mutant (run the mutants in a scratch copy).
  3. **L2:** `acquire` by the current live holder renews without bumping the epoch (the brief: "a new holder bumps"),
     unless you find a reason it must bump; say which in the report. **L3:** check UPDATE on `pl_leases` at start-up
     (as you check the other grants), so a missing grant fails at open, not at the first write.
  4. L1, L4, L5: report only (L5's SEAM path is p4-host's to close; L4 goes in your spec proposal).
- **Report:** append "## Round 2" to docs/m2/reports/p4-store-lease.md (per finding: fix, test, mutant caught).
- **Done when:** `bun test` green in the shared tree (except test/core-source, known herdr-draw drift), once with
  DATABASE_URL (brew postgresql@17, free port, PID recorded, stopped after), `bun test test/server` 10x with 0 failures.
  Then one short `hc send t18m` and stop, idle.
- **Shared tree:** t1fw is editing server/gateway.js, feed.js, rig.js, v1.test.js, tune.test.js, PROTOCOL.md; don't
  touch those. Process: never pkill/killall; port 0; kill only PIDs you recorded; delete scratch data at the end.
