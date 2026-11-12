# Brief: p4-wire round 2 (remote open grace; redaction coverage)

Same builder, same ownership list as docs/m2/briefs/p4-wire.md. Don't commit. Append a "Round 2" section to
docs/m2/reports/p4-wire.md, then one short `hc send` to t18m and stop.

## Decisions on your report

- **Accepted as written:** decisions 2-6 (requester id `r-<node>-<hex>`, `subjects.open` a constant, no dev board on a
  host-only node, `/health` roles, schema `public` with a fresh database per test run), and remote open living in
  room-host.js.
- **Decision 1, changed:** a `held` reply resolves the open at once. A `watching` reply does **not** resolve it
  immediately; it starts a grace of `min(1000, leaseTtlMs / 4)` ms. A `held` reply during the grace resolves at once.
  At the end of the grace, resolve (some host is watching, so the hello's inbox path still works, as today). No reply
  at all still rejects after `leaseTtlMs`. Why: editors must get under 150 ms in the home region, and a 1013 plus a
  client backoff on every cold board costs far more than a grace that only applies when no host answers `held`.
  Keep the one-in-flight-per-board dedup and never cache success.

## Do

1. Implement the grace above. Tests (roles.test.js): with two hosts, a `held` reply resolves before the grace ends
   (assert the elapsed time is well under the grace); with a watcher-only reply (holder stalled or absent), the open
   resolves at about the grace, not before; no reply rejects at about the ttl. Mutation: grace skipped (first reply
   wins) is caught.
2. Measure the cold bounce on PG + NATS with two hosts and one gateway: 20 cold boards, count first-writer 1013s,
   before and after the change if cheap. Put the counts in the report. If any bounce remains after the change, say why.
3. Close the redaction gaps you listed: a NATS open failure and the "close what already opened" path (Postgres up,
   NATS down). Use fakes or an injected adapter factory so the error message the adapter throws **contains the full
   URL with a fake password**; assert the password is absent from the error and every captured log line, and that
   the opened Postgres side is closed. A mutation that drops `redact()` must now fail a test outside the redact unit
   test.
4. Gates as in round 1: `bun test` (name any failure outside core-source), `bun test test/server` 10x, once with
   PG + NATS (record PIDs, stop them by PID), architecture test green.

Scratch: leave your session scratchpad as it is; I'll clean it up.
