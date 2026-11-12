# Brief: p2-tune (revocation at scale, `here`, feed and test fixes)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md, CLAUDE.md, PROTOCOL.md (v1.1), then
docs/m2/reports/p2-swapv.md (Round 2: R1-R6 with repros) and server/gateway.js, server/feed.js.

- **Your tab:** `worker p2-tune (engine) · <your id>: revocation at scale + here`. Manager: `manager engine`,
  terminal `t18m`. Report to t18m only; never message the proxy (t1bx).
- **Where:** the shared tree /Users/r/repos/plenary (main; phase 2 merged at dcbdae6). Don't commit.
- **You own:** server/gateway.js, server/feed.js, test/server/** except test/server/architecture.test.js (p-arch
  folds that one into its own test, concurrently), and PROTOCOL.md § Presence / § Bus / § Auth text for what you
  change. Never touch server/auth/, server/registry/, server/store/, server/pg/ or web/.
- **Design first:** apply the `distributed-systems-design` skill (APPLIER mode; /Users/r/repos/systems-design.skill)
  to the re-check path and `here` against the NFRs (2k annotators + 100k viewers per board, editors < 150 ms, a
  gateway must never stall). Put its output briefly in your report.
- **Report:** docs/m2/reports/p2-tune.md (what changed, tests added, not verified, risks). Then stop, idle.

## Goal

1. **R1 (MEDIUM): re-check passes never stall the gateway.** Coalesce: at most one pass per board in flight, and a
   `grants` message arriving during a pass marks the board dirty for one more pass, not a new chain. Yield between
   connections (or in slices, like the breather), and answer per user, not per connection (a user's tabs share one
   `auth.role`). Measure with the verifier's 2,000-socket repro: event-loop stall per pass before and after.
2. **R2 (MEDIUM): a Registry blip never closes everyone.** A grants-triggered re-check keeps fail-closed for the
   connections it concerns (M1); the timed pass on error keeps the connection and retries soon with backoff
   (a bounded number of times, then closes), so one blip doesn't drop a whole gateway. Explain the choice against
   M1's threat (a revoked user writing during an outage) in the report.
3. **R3 (LOW):** make the revocation window measurable and small: with coalescing and per-user answers, report the
   time from a Registry change to the close for 2,000 connections.
4. **R4 (LOW):** a foreign-board entry at seq + 1 sets `gapAt` like a gap, so joins are refused, not welcomed short.
5. **R5 (LOW):** write the timed re-check (period) and the error rule into PROTOCOL.md (§ Auth or § Bus).
6. **R6 (LOW):** the flaky "clients converge through the Room ... (seed 1)" test (gateway.test.js:644): capture the
   cause and fix it (event-driven waits, not longer timeouts).
7. **`here` (round-1 L1; § Presence and § Bus `.here` in PROTOCOL.md):** build what the spec says, gateway-side,
   never logged, bounded per board for 100k viewers (counts, not lists, past a threshold if the spec allows; if the
   spec is silent, propose the smallest rule, write it into PROTOCOL.md, and say so in the report).

## Done when

- `bun test` green in the shared tree (also with DATABASE_URL and NATS_URL: start brew postgresql@17 and
  nats-server yourself, record PIDs, stop them after). Run test/server 10x in a row, 0 failures, including R6's test.
- New tests: coalescing (N grants messages during a pass give at most 2 passes); a timed-pass Registry error keeps
  connections then closes after the retry bound; grants-triggered error still fails closed; foreign entry at seq+1
  refuses joins; `here` relayed between two clients and never in the log, and bounded with many viewers.
- Each new test fails when its fix is undone (mutation check in a scratch copy; say which).

Process: never pkill/killall; port 0; record PIDs and kill only those; delete scratch data at the end.
