# Brief: p2-tune round 2, continued (after a context reset)

Your previous context filled up and auto-compaction thrashed (2026-11-12), so it was cleared. The work is not lost:
round 2 is half done, uncommitted, in the shared tree. Same ownership and rules as docs/m2/briefs/p2-tune.md.
**The task and decisions are docs/m2/briefs/p2-tune-r2.md: read it first and follow it.** Don't commit.

- **Your tab:** `worker p2-tune r2 (engine) · t1fw: re-check fix round`. Manager `t18m`; never message the proxy (t1bx).
- **Where things stand (t18m, 2026-11-12):** `git diff` shows server/gateway.js +298/-?, feed.js, PROTOCOL.md, rig.js,
  v1.test.js changed; test/server/tune.test.js and harness.test.js are new. `bun test` has 8 failures in
  test/server/gateway.test.js (5) and test/server/tune.test.js (3), e.g. "slow auth: ops after welcome are acked in
  order", "rule 1: nothing is acked or broadcast before the append resolves", "R2: a timed pass whose Registry calls
  fail keeps the connections...", "here: bounded with many viewers". Find out which of these are your fix still in
  progress and which are tests that the brief's new rules (per-user errors, count-only `here`) make outdated; fix
  code or update the test, and say which in the report.
- **Protect your context (this is what went wrong):**
  - Read server/gateway.js (1,089 lines) and docs/m2/reports/p2-tunev.md in ranges (`offset`/`limit`, ≤ 200 lines),
    never whole. Use `git diff -- server/gateway.js | sed -n 'a,bp'` in chunks too.
  - Run tests with output filtered: `bun test <file> 2>&1 | grep -E "^\(fail\)|pass$|fail$"`, then one failing test
    at a time with `-t`. Never paste a full test run or the 10x loop's output; log it to your scratchpad and tail it.
  - Write the "Round 2" section of docs/m2/reports/p2-tune.md as you finish each finding (H1, H2, M1, M2, LOWs), not
    at the end, so a second reset loses nothing.
- **Done when:** as in p2-tune-r2.md (§ Done when). Then report to t18m with one short `hc send` and stop, idle.
