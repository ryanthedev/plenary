# Brief: p4-host round 2 (fix p4-hostv FAIL: HIGH-1, MEDIUM-1..3 + LOWs)

You are the p4-host builder, resumed. Same base, ownership and rules as docs/m2/briefs/p4-host.md (server/room-host.js,
server/server.js pass-through, server/store/*, server/bus/*, packages/protocol/ports.js, room.js status method,
test/server/store-contract.js, store.test.js, pg-store.test.js, room-host-lease.test.js, and the approved openEpoch
lines in gateway.test.js / revocation.test.js / rig.js / main.test.js). Don't commit.

- **Your tab:** `worker p4-host r2 (engine) · t1h5: lease fix round`. Manager: `manager engine`, terminal `t18m`.
  Report to t18m only; never message the proxy (t1bx).
- **Read:** docs/m2/reports/p4-hostv.md in full. Each finding has a repro, and the appendix (from ~line 249) has the
  verifier's attack tests (hostv-proc.test.js, hostv-child.js, hostv-attack.test.js, hostv-pgdown.test.js) and
  mutate.py. Turn each repro into a test in test/server/room-host-lease.test.js (or a new test/server/room-host-proc.test.js
  for the real SIGSTOP/SIGCONT child-process one; it may skip without DATABASE_URL/NATS_URL if it needs them, but give
  an in-process equivalent with a queuing bus and a fake perf clock that always runs).
- **Report:** append a "Round 2" section to docs/m2/reports/p4-host.md (per finding: fix, test, the mutation the test
  catches). Then one short `hc send` to t18m and stop, idle.

## Fix (decisions are mine; follow them)

1. **HIGH-1, a stalled holder serves after its deadline.** One guard, `expired(slot)` = `perf() >= slot.okAt +
   leaseTtlMs - renewEvery`. Check it in `onInbox` before handling any message, and before every reply that a slot
   sends (welcome, ack, catch-up, broadcast). If expired: `lost(slot)` and drop the message (do not answer it: the new
   holder or a watcher answers it). `fail()` of a lost lease sends `unavailable` (1013) **only to connections this
   slot welcomed**, never to ones whose hello it never answered. Test: the verifier's SIGSTOP repro (stall past ttl,
   new holder welcomes its clients, resume the old one): zero welcomes or 1013s from the stale host to the new
   holder's connections; every acked op present.
2. **MEDIUM-1 and L2, takeover takes up to ~2 ttl.** Make `lease()` (both adapters + contract) return the remaining
   ms judged by the Store's own clock (`remainingMs`, server-side `expires_at - now()` in PG). A watcher attempts
   `acquire` at `remainingMs + small margin`, then every ttl/3 while it still loses, and also at once when the holder
   goes silent (2 missed heartbeats) or a release is seen. Never compare `expiresAt` with this host's clock. Test:
   repro "C" takes over within ttl + ttl/3 + 500 ms (not 2 ttl); a clean release is taken within one ttl/3.
3. **MEDIUM-2, a hello forwarded while the new holder builds is never answered.** On a heartbeat carrying a new epoch
   (or the first heartbeat from a new holder), the watcher answers every hello it is holding with `unavailable`
   (1013); the client retries and reaches the built room. Test: repro "A", every hello is answered (welcome or 1013)
   within ttl + 3 s.
4. **MEDIUM-3, a hung renew is never retried.** Bound each renew by `renewEvery` (timeout = error); clear `renewing`
   on the timeout; a late result of a timed-out renew is ignored (it never moves `okAt`). Test: repro "F", a renew
   that never settles, then a working Store: the next tick renews; with a Store that stays hung, `lost` at the deadline.
5. **LOWs.**
   - **L1:** adopt the verifier's test "G" (okAt from send time; kills the "receive time" mutant).
   - **L3:** a renew that succeeds after `lost` does not revive the room (stay lost; the room reopens only via a new
     `acquire`). Test it.
   - **L4:** track in-flight appends in `slot.writes` too, so `close()` settles them before `release`.
   - **L5:** a build that fails for a non-lease reason stops renewing and `release`s the lease.
   - **L6:** no code change; write the shared `heartbeatMs` (every host in a cluster uses the same value) into the
     PROTOCOL.md proposal.
   - **L7:** past 1,000 held hellos per watched board, answer the extra ones `unavailable` at once.
   - **L8:** main.test.js: round 0 uses a plain welcome; only the post-kill rounds retry.
   - **L9:** complete the PROTOCOL.md proposal in the report: `fenced` (not `conflict`) for a stale host; no
     `openEpoch` anywhere (:20, :31, :428-431, :443-445, :707, :714); the takeover timing (item 2); the deadline rule;
     the shared heartbeatMs; what a watcher answers and when.

## Done when

- The verifier's repros for HIGH-1, MEDIUM-1, -2, -3 and L1 are tests that pass, and each fails with its fix undone
  (mutation in a scratch copy; list the mutants in the report).
- `bun test` green in the shared tree (except test/core-source, the known herdr-draw drift); `bun test test/server`
  10x with 0 failures; once with DATABASE_URL and NATS_URL including the SIGSTOP test (brew postgresql@17 +
  nats-server, free ports, PIDs recorded, stopped after). test/architecture.test.js green.

Process: never pkill/killall; port 0; record PIDs and kill only those; delete scratch data at the end. Read big files
in ranges (≤ 200 lines) and filter test output.
