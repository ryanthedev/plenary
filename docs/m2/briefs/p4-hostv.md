# Brief: p4-hostv (verify p4-host: the room host holds a Store lease; every write fenced)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md ("Checking people's work", "Architecture", the sdd
helpers), CLAUDE.md (NFRs: one sequencer per board, an acknowledged op is never lost), PROTOCOL.md v1.1 (§ Recovery,
Room identity / epoch, § Bus), docs/m2/reports/p-audit.md (F5, F13, F14, F15), docs/m2/reports/p4-store-leasev.md
(L2, L5, R2-L1, R2-L2), then the job's brief docs/m2/briefs/p4-host.md (12 goals, "Done when").

- **Your tab:** `verifier p4-hostv (engine) · <your id>: room host on the lease`. Manager: `manager engine`,
  terminal `t18m`. Report to t18m only; **never message the proxy (t1bx)**.
- **Where:** the job is uncommitted in the shared tree /Users/r/repos/plenary (main). Its files: server/room-host.js,
  server/server.js, server/store/sqlite.js, server/store/postgres.js, server/bus/port.js (and server/bus/*),
  packages/protocol/ports.js, packages/protocol/room.js, test/server/store-contract.js, store.test.js, pg-store.test.js,
  test/server/room-host-lease.test.js (new), and the approved edits in test/server/gateway.test.js, outbound.test.js,
  revocation.test.js, main.test.js, rig.js. Other sessions edit other files (web/**, server/auth|admin|registry/**,
  server/gateway.js): ignore those. **Change nothing in /Users/r/repos/plenary** except your report. Run attacks,
  mutations and repeated runs in a copy in your scratchpad (`rsync -a --exclude .git --exclude node_modules --exclude
  .env`; never copy `.env`).
- **Report:** /Users/r/repos/plenary/docs/m2/reports/p4-hostv.md: PASS or FAIL, findings HIGH/MEDIUM/LOW, each with a
  repro. Then one short `hc send` to t18m and stop, idle.
- Read the builder's report docs/m2/reports/p4-host.md only for "Not verified", "Risks", the out-of-list test edits and
  the PROTOCOL.md proposal. Test the code, not the claims.

## How to check (minimum)

1. **systems-design skill, CHECKER mode** (/Users/r/repos/systems-design.skill) on room-host + lease against the NFRs:
   can two hosts both sequence one board (renew timer late, event-loop stall past the deadline, a slow `readFrom`
   during open, takeover racing a clean `close`)? Can an acked op be lost across takeover? Is the host deadline judged
   on `performance.now()` from the renew's **send** time? Does a host that is waiting for takeover ever answer a board
   whose holder is live (goal 6)?
2. **Spec conformance:** goals 1-12 vs the code, and the PROTOCOL.md proposal vs the code, both ways. Every deviation
   is a finding. Check that nothing in server/ still calls `openEpoch`; that the no-epoch write is refused in both
   adapters; that room-host reads Room only through the new status method (F14); that `flush` is on the Bus port with
   no `?.` (F15).
3. **Attack it, both adapters:** the F5 two-host probe (one welcome per hello, no duplicate acks, no "room stopped",
   one sequencer); kill the holder without release (renew stops) and check the dead-holder window: a writer hello gets
   welcome or `unavailable` within ttl + 3 s, never hangs; a stale holder's held append landing after takeover is
   `fenced`; clean close, release, then a new host opens with no wait; a renew that errors (PG down) until the
   deadline; two hosts with different `leaseTtlMs`. If you can, a real kill -9 of a child process holding a Postgres
   lease (the builder simulated it in-process only).
4. **Mutation checks:** confirm the builder's 14 (the brief's 6 at least: drop the epoch on append; on putCheckpoint;
   ignore a null renew; subscribe the inbox without the lease; release on `fail`; judge the renew deadline by the
   injected `now`), plus your own: renew from the deadline's receive time instead of send time; answer `unavailable`
   for a board whose holder is heartbeating; skip the renew before the rebuild.
5. **Approved test edits:** check each out-of-list test edit still tests what it tested (gateway.test.js:287-297, :335;
   outbound.test.js:360; main.test.js kill -9 restart: retry only on 1013 or timeout, bounded at leaseTtlMs + 3 s, acked
   ops asserted). A loosened assertion is a finding.
6. **Repeat:** `bun test test/server` 10x in the copy; lease-timer tests must not flake.
7. **Hexagonal:** room-host imports ports only; test/architecture.test.js green.
8. **sdd ensemble** of `git diff -- server/room-host.js server/store server/bus packages/protocol/ports.js
   packages/protocol/room.js test/server/room-host-lease.test.js`: codex + every harness that passes check_adapter;
   confirm or refute each two-harness finding.
9. `bun test` in the shared tree, and once with DATABASE_URL and NATS_URL (brew postgresql@17 + nats-server on free
   ports, PIDs recorded, stopped after). test/core-source.test.js fails from known herdr-draw drift; not this job's.

Process: never pkill/killall; port 0; record PIDs and kill only those; delete your scratch data at the end. Read big
files in ranges (≤ 200 lines) and filter test output; write the report as you finish each check.
