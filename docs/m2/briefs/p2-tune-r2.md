# Brief: p2-tune round 2 (fix p2-tunev FAIL: H1, H2, M1, M2 + LOWs)

You are the p2-tune builder, resumed. Same base, ownership and rules as docs/m2/briefs/p2-tune.md (server/gateway.js,
server/feed.js, PROTOCOL.md § Auth / § Bus / § Presence, test/server/rig.js, v1.test.js, tune.test.js,
harness.test.js). Don't commit.

- **Your tab:** `worker p2-tune r2 (engine) · t1fw: re-check fix round`. Manager: `manager engine`, terminal `t18m`.
  Report to t18m only; never message the proxy (t1bx).
- **Read:** docs/m2/reports/p2-tunev.md in full (each finding has a repro; turn each repro into a test).
- **Report:** append a "Round 2" section to docs/m2/reports/p2-tune.md (per finding: fix, test, mutation that the test
  catches). Then stop, idle.

## Fix (decisions are mine; follow them)

1. **H1, a lookup that never settles:** bound every `auth.role` call in a pass with a gateway-side timeout
   (option `recheckLookupMs`, default 2 s); a timeout counts as an error for that user. And a `grants` request
   while a weaker pass (timed or retry) runs **cuts that pass short**: it stops at its next batch boundary and the
   grants pass starts right away (writers first). A grants pass never waits behind a weaker pass. Test: the
   verifier's never-settling repro closes the revoked victim within ~recheckLookupMs.
2. **H2, partial failure closes everyone:** errors are per user. Drop the board-wide "3 errors in a row, mark the
   unreached as failed" rule. Unreached users are left unchanged. A timed/retry error keeps that user (their
   own retry budget 2/4/8 s, then close **that user** only); a grants-pass error closes that user only. If you still
   want a stop for a fully-down Registry, stop when **every** lookup in the first batch failed, and leave the
   unreached unchanged (retry later). Test: the 8-bad / 300-healthy repro closes 8, not 308.
3. **M1, backoff not reset:** the retry counter resets once the failing set is resolved (all closed or all
   recovered). Test: the dev:a then dev:b repro, both closed in ~the spec bound.
4. **M2, `here` cost:** send the writer list only on a writer change (and to a joiner); a viewer-count change sends
   a count-only `here` without the list (the client keeps its last list). Spec it in § Presence; I tell client t14k.
5. **LOW 1:** rank as the spec says (owners and editors first, then most recently active). **LOW 2:** fix
   `v1.test.js:217` to assert a rebase onto wherever the room's base settles (not seq 10), and run the verifier's
   deterministic sequence. **LOW 3:** add the test for grants-arrives-while-retry-queued (fails without the
   strictness upgrade). **LOW 4:** group per user by (id, email, domain), so differing claims are checked apart.
   **LOW 5:** a joiner gets `here` right after catch-up (compute it if `hText` is null). **LOW 6 and 7:** make
   § Auth match the code (timer during a pass skipped; which passes stop), say `.grants` is at-most-once with the
   timed pass as repair. PROTOCOL.md:260 (`here` 1/s) may be edited to "1/s, 5 s on big boards".

## Done when

`bun test` green in the shared tree (except test/core-source, the known herdr-draw drift); `bun test test/server`
10x in a row with 0 failures; also once with DATABASE_URL and NATS_URL (brew postgresql@17 + nats-server, free ports,
PIDs recorded, stopped after); each new test fails with its fix undone (mutation in a scratch copy); R1's stall
measurement (2,000 sockets, 20 grants) still ≤ ~10 ms.

Process: never pkill/killall; port 0; record PIDs and kill only those; delete scratch data at the end.
