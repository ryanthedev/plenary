**FAIL**: 1 HIGH, 2 MEDIUM, 6 LOW. The speed-up and the deflaking hold up. Three things block:

- The teardown safety nets (`spawnTracked` reaping, rigs stopped on failure) only work in the first test file of a run.
- Four removed upper bounds were the only checks of a configured limit.
- The feed fix retries with no limit.

# Review: E1 (fast, deterministic test suite + server/feed.js rebase fix)

2026-11-18. Independent verifier, not the builder. Reviewed `git diff 3f90e74..e8880c4` (dc2a301 through e8880c4)
in /Users/r/loops/plenary/wt/plenary. Nothing committed. Probes and mutants ran in a private scratch copy, which is
now removed. Bun 1.4.4.

## Executed Results (Step 0)

- **Full `bun test`, run 1:** 1564 pass, 155 skip, 0 fail, 176.4 s (wall time 2:56).
- **Full `bun test`, run 2:** 1564 pass, 155 skip, 0 fail, 167.1 s. The builder claimed 171-190 s, which matches.
- **`bun test test/server` (no services):**

  | Version | Result | Time |
  |---|---|---|
  | Now | 280 pass, 136 skip, 0 fail | **59.3 s** |
  | Baseline 3f90e74 (`git archive` into scratch, same machine, run right after) | 277 pass | **147.2 s** |

  Less than half the baseline. The claim was 153 → 67 s.
- **Cluster-gated files on real Postgres, NATS and MinIO** (`cluster-rig.js up --services-only --name e1v-<pid>`): tenants, main-cluster, nats-bus, pg-registry, pg-store, room-host-lease, room-host-proc, s3-blobs and p4-wire2 gave 217 pass, 0 fail, 0 skip.
- **nats-bus + room-host-lease, 10x on real services:** 52 pass, 0 fail every run (9.8-10.0 s each).
- **Other repeat runs:**
  - tune + sqlite-registry-open + feed-rebase, 5x quiet: 21 pass, 0 fail each.
  - tune + room-host-lease + nats-bus + sqlite-registry-open + outbound, 3x while a full `test/server` (with services) ran alongside: 94 pass, 0 fail each. The background run gave 413 pass, 0 fail.
- **Typecheck and lint:** none configured (package.json has only `test`).
- **alsp:** N/A (no Cargo.toml).

## Requirement Fulfillment

### DW-1

PREMISE: Codex audit findings fixed: wall-clock asserts at v1:164, envelope:62, gateway:473/487; teardown leaks in v1/rig.js (every rig stopped on failure); the pointless 10 s sleep in v1; real-timer waits in sync.test.js:790; the rig.whenClosed timer leak.

EVIDENCE:
- test/server/v1.test.js:159-181 and :274-283
- test/envelope.test.js:48-62
- test/server/gateway.test.js:462-497
- test/web/sync.test.js:13-16 and :795-799
- test/server/rig.js:24-27, :91-97 and :107-111

TRACE:
- **Wall-clock asserts, all gone:**
  - v1 pacing now runs on a frozen gateway clock: exactly 5 acks and lastSeq 5, then the clock is advanced.
  - gateway H1 counts `JSON.parse` calls on frames over 100 KB instead of timing them.
  - envelope keeps its "no crash, nothing logged" checks.
- **10 s sleep:** removed.
- **sync waits:** wait on the outcome instead of a guessed time.
- **whenClosed:** clears its timer in `finally`.
- **Rig teardown:** `afterEach(stopRigs)` sits at module level in rig.js. **It is registered only for the first test file in a `bun test` process that imports rig.js** (HIGH-1). A rig in any later file that fails before `r.stop()` keeps serving.

Mutants:
- **A** (pre-parse depth check off) is killed by gateway H1.
- **B** (bucket ignored) is killed by v1 pacing.

VERDICT: **PARTIAL.** Every item holds except "every rig stopped on failure", which fails in multi-file runs. See HIGH-1.

### DW-2

PREMISE: test/server at least halved (claimed 153 s → 67 s); full suite claimed 258-271 s → 171-190 s, 3 runs 0 fail.

EVIDENCE: Executed Results.

TRACE: 147.2 s → 59.3 s on this machine, run back to back. Full suite 176 s and 167 s.

VERDICT: **PASS.** I ran the full suite twice, as asked, not three times. Both were 0 fail.

### DW-3

PREMISE: Flakes fixed: tune.test.js:190 and R2 retries, room-host-lease MEDIUM-3, nats-bus stall (:268), sqlite-registry-open budget asserts.

EVIDENCE:
- tune.test.js retry and backoff tests run on `virtualTime`, and check exact `oneShots()` waits of [20, 40, 80].
- room-host-lease MEDIUM-3 runs on `vworld()`, and checks `took <= 600` and that the lease is still live.
- nats-bus.test.js:226-271
- sqlite-registry-open.test.js:43-75 checks budgets [1000, 100] and [1000, 700, 400, 100].

TRACE: All of these runs had 0 fails:
- nats-bus and room-host-lease 10x on real services.
- tune and sqlite-registry-open 5x quiet, and 3x under concurrent load.

Mutants:
- **E** (deadline = full ttl) is killed by host-deadline, MEDIUM-3 and L1.
- **F** (deadline counted from the receive time) is killed by L1.
- **H** (schema transaction gets a fresh budget) is killed by the budget test.

VERDICT: **PASS.** See LOW-4 for the loosened nats replay bound.

### DW-4

PREMISE: The production changes only add injectable clock and timer options with unchanged defaults: server.js (now, timers), room-host.js (timers), gateway.js (timers), registry/sqlite.js (busy.clock/onAttempt). Verify the defaults and that behaviour is unchanged.

EVIDENCE:
- gateway.js:135-137 (`timers = globalThis`, destructured and shadowing the globals)
- room-host.js:92 and :100
- server.js:32 and :40 (now/timers are spread only when given)
- registry/sqlite.js:38-49 and :61-72

TRACE:
- With no options, every timer resolves to the global one.
- `onBusyRetry` computes the same `deadline - Date.now()` budget, once per attempt, and the sleep is unchanged.
- No direct `Date.now()` or `performance.now()` remains inside the gateway factory. The room host uses `monotonic`, as before.
- `remoteRooms` already took `timers` before E1.
- The full suite passes.

VERDICT: **PASS.**

### DW-5

PREMISE: server/feed.js product fix: a rebase look that finds no newer checkpoint stays open and retries on later heartbeats and Store polls. Check correctness and cost, check that feed-rebase.test.js fails on the old feed.js, apply distributed-systems-design in CHECKER mode, and judge the checkpoint-after-publish race.

EVIDENCE: server/feed.js:110-146, test/server/feed-rebase.test.js.

TRACE:
- **Correctness holds.** `validBase()` (feed.js:99-108) checks the checkpoint against log entry S. The tail is cut only when `base.seq < cp.seq <= self.seq`, so a retry can never install a wrong or future base.
- **The test does its job.** With the old feed.js copied in, feed-rebase.test.js fails (`Expected: 3, Received: 0`). With the new one it passes.
- **Cost: the retry has no limit** (MEDIUM-1):
  - A miss stays open until the room writes a newer checkpoint. At defaults that may never happen on an idle board.
  - Each retry reads and parses the whole checkpoint, on every gateway, every heartbeat.
  - It cannot spin: it runs at most once per heartbeat or Store poll, inside the feed's serial queue.

VERDICT: **PARTIAL.** Correct, and the regression test is good, but it violates the loaded skill's "retry mechanism with limits" (MEDIUM-1).

### DW-6

PREMISE: helpers.spawnTracked reaps every spawned child after each test, pass or fail.

EVIDENCE: test/server/helpers.js:34-45.

TRACE:
- The probe: three test files each import helpers.js, spawn `sleep 300` through `spawnTracked`, fail, and then check that the child is gone.
- Only p1's child was reaped. p2's and p3's children survived as orphans (ppid 1), and the `bun test` process then hung for over 120 s.
- The cause: a module-level `afterEach` registers only in the first test file of the process that imports the module.

VERDICT: **FAIL** (HIGH-1).

**All requirements met: NO.**

## Test-DW Coverage

- [x] Every DW item has tests that ran in Step 0. Mutants and probes are recorded above and below.
- [x] Coverage matches the stated level: none stated (per-DW rule only). Gaps: none.

## Dead Code

None found.

## Correctness Dimensions

| Dimension | Status | Evidence |
|---|---|---|
| Concurrency | PASS | Feed retries run in the feed's serial `run` queue, so a heartbeat and a poll cannot interleave a look. No spin: at most one look per message or poll. |
| Error Handling | PASS (pre-existing note) | `rebase()` clears `missed` before awaiting `validBase()`, so a throwing `getCheckpoint` drops the retry until the next `rebaseEvery`. This predates E1: LOW-6 and TECH-DEBT. |
| Resources | **FAIL** | HIGH-1 (children and rigs leak in every file but the first). MEDIUM-1 (one full checkpoint read and parse per heartbeat per gateway, with no limit). |
| Boundaries | PASS | `virtualTime.advance` runs due timers in order, re-arms intervals, and checks `until` against maxMs. |
| Security | N/A | No untrusted input is touched by the diff. |

## Loaded-Skill Criteria (distributed-systems-design, CHECKER mode, against the feed.js fix)

| Skill | Criterion | Status | Evidence |
|---|---|---|---|
| distributed-systems-design | Retry mechanism with limits (checklists.md §1 Reliability; Reliability Anti-Patterns) | **FAIL** | MEDIUM-1: the retry repeats until a newer checkpoint exists, which can be never; probe below. |
| distributed-systems-design | Back-of-envelope cost (ch. 2; checklist "estimation performed") | **FAIL** (same finding) | 1.42 MB per look at 2 s per gateway per board. 20 gateways on one idle 1.4 MB board is about 14 MB/s of Store reads and JSON parsing, indefinitely. The code comment claims "one checkpoint read per heartbeat"; it is a full checkpoint read and parse plus one entry read. |
| distributed-systems-design | Polling waste ("most polls return empty", ch. 12) | FAIL (same finding) | 30 of 30 looks in the probe found nothing. |
| distributed-systems-design | Consistency model / failure scenarios for the component | PASS | Eventually consistent catch-up. A stale or missing checkpoint only lengthens the tail. A bad checkpoint is stepped past. |
| distributed-systems-design | Graceful degradation when a dependency is down | PASS | A Store error is logged and retried by the next message or poll. Live entries keep flowing. |
| distributed-systems-design | Infrastructure completeness rows (LB, replication, CDN, sharding, rate limiting, IDs) | N/A | A single-function change inside an existing component. No architecture change to audit. |

**The checkpoint-after-publish race is acceptable for correctness.** It can only make a look miss. The consequence is extra looks and a longer catch-up, never a wrong state. It is already TECH-DEBT row 7. The fix proposed under MEDIUM-1 also makes the race moot.

## Findings

### HIGH-1: `spawnTracked` reaping and "every rig stopped on failure" work only in the first test file of a run

- **File:** test/server/helpers.js:45 (`afterEach(...)` at module level) and test/server/rig.js:27 (`afterEach(stopRigs)`, with the comment "registered once per test file that imports this module", which is not true).
- **Cause:** In bun 1.4.4 the module is evaluated once per `bun test` process, so the hook attaches to the first importing file only. The full suite runs about 24 server files in one process.
- **Demonstrated by probe 1 (helpers.js):**
  - Three files each spawn `sleep 300` and fail. Only the first file's child was reaped.
  - The other two were left as orphans (ppid 1), and `bun test` hung over 120 s waiting on them. I killed them.
- **Demonstrated by probe 2 (rig.js):**
  - Two files each build a rig, fail before `stop()`, and then fetch its port.
  - File 1's rig was stopped. File 2's rig still answered, so it failed.
  - File 2 run alone passes.
- **Impact:** DW-6 and DW-1's teardown item are false in a full run. TECH-DEBT row 4 is marked FIXED e8880c4 but is not fixed.
- **Fix:**
  - Either register the hooks per file: export e.g. `reapAfterEach()` and `stopRigsAfterEach()`, and call them at the top of each test file.
  - Or put them in a `bunfig.toml` `[test] preload` file, where top-level hooks apply to every file.
  - Then re-run the two-file probe.

### MEDIUM-1: The feed's rebase retry has no limit; an idle large board costs one full checkpoint read and parse per heartbeat per gateway, forever

- **File:** server/feed.js:122 (`self.missed = true`) and :140 and :146.
- **Why the miss can stay open:** The room folds only at 1,000 entries AND when tail chars × 2 ≥ state chars (packages/protocol/room.js:430), or at 8 MB AND half the state. The feed looks at 1,000 entries or 4 MB. On a board whose state is large next to its recent ops, the feed's look at 1,000 entries misses, and the room may not fold for thousands more entries. On an idle board it never folds. Each retry is `getCheckpoint` (the whole state, JSON-parsed) plus one entry read.
- **The probe, at production defaults** (scratch `zz-probe-defaults`, sqlite store):
  - 1,000 entries were in the tail (233 KB) after a 1.42 MB checkpoint at seq 1. The room rule does not fire, since 466 KB < 1.42 MB.
  - **New feed.js:** 30 heartbeats gave 30 `getCheckpoint` calls and 42.6 MB parsed, and `missed` was still true.
  - **Old feed.js:** 30 heartbeats gave 2 calls and 2.8 MB.
  - The Store-poll path (no room heartbeating) retries the same way, every `pollMs`/2.
- **Fix:**
  - Preferred: put the latest checkpoint seq in the room's heartbeat (`{ seq, epoch, cp }`) and look only when `cp > base.seq`. That bounds the reads to one per real fold and also removes the publish-then-checkpoint race.
  - Or: a cheap checkpoint-seq read before the full read.
  - Or at least: a retry limit or backoff, for example stop after k misses until another `rebaseEvery` entries arrive.
  - Also fix the comment's cost claim.

### MEDIUM-2: Four removed upper bounds were the only checks that a configured limit is honoured (tests weakened)

Method: plant a mutant that swaps the configured limit for a longer one. Each mutant **survives the whole new `test/server`** (with services where gated) and is **killed by the pre-E1 version of the same test**.

| Mutant | New suite | Old test | Bound that was removed |
|---|---|---|---|
| **C**: gateway uses `LIMITS.recheckLookupMs` (2 s) instead of the configured limit (gateway.js:572, :580) | all test/server 413 pass, 0 fail | old tune "H1: a lookup that never settles…" fails (`toBeLessThan`, 2046 ms) | tune.test.js H1 `< 1500`. role-cache "finding 1" and "V1" do not catch it either. |
| **J**: s3 `get` ignores `getTimeoutMs`, uses 10 s (s3.js:96-97) | s3-blobs passes. The one failure in that run was the unrelated "here" timeout (LOW-5). | old s3 M1 fails (5 s test timeout) | s3-blobs.test.js:89-93 `< 2000`. Only the 30 s test limit remains, above the 10 s default. |
| **Lk**: pg-store lease lock cap `ttl/2` → `ttl*5` (postgres.js:167) | pg-store, room-host-lease and room-host-proc 64 pass, 0 fail | old R2-L1 fails (`toBeLessThan`, 2027 ms) | pg-store.test.js:266 `took < 400`. Only the 3 s race remains, so a cap of 2 s passes. |
| **L**: main.js ignores `PLENARY_LEASE_TTL_MS` (host gets 10 s) (main.js:365) | main + main-cluster 21 pass, 0 fail | old "kill -9 mid-stream" fails: "no welcome within the lease ttl + 3 s (6000 ms)" | main.test.js:155-160, ttl + 3 s widened to ttl + 30 s. This is the case the brief asked about: a real regression (a crashed holder's writers locked out 10 s, not 2 s) now passes silently. |

- **Is anything unbounded?** No. Every widened window still has a 30 s backstop or a test limit. But ttl + 3 s on real processes is no longer asserted anywhere. It is checked only in-process on virtual time (room-host-lease "dead-holder window"). main-cluster.test.js:4 and :45 still claim "within ttl + 3 s".
- **Fixes (each keeps the test free of wall-clock flakiness):**
  - **C:** run tune H1 on the rig's `virtualTime` and assert `V.oneShots()` contains the 150 ms lookup timer. Or bound it well under the default (for example `< 1000` with lookup 150).
  - **J:** a bound well under the 10 s default (for example `< 5000` for a 300 ms deadline).
  - **Lk:** assert the wait is under the 5 s configured limit by a margin (for example `< 1500`), or count the lock wait.
  - **L:** assert the node's logged `leaseTtlMs` equals the env value, or keep a bound under the 10 s default (ttl + 6 s).

These do not kill and are fine: **A, B, D, E, F, G, H** (killed), **Q** (pg-registry queue ×6: killed by the new pg-registry tests) and **K** (idle timeout 2 s: the old test passes it too, so it is no evidence). **N** (nats connect timeout ×4) did not touch the unreachable-server test, because the connection is refused at once.

### LOW findings (non-blocking)

1. **The sync test can no longer catch an extra resync** (test/web/sync.test.js:799-800). `until(() => sv.resets === 2 && …)` followed by `expect(sv.resets).toBe(2)` cannot fail. The old 1.2 s settle would have caught a third resync. Add a short settle and re-check, or wait on `status/pending` and then assert `resets === 2`.
2. **The envelope timing check has no replacement** (test/envelope.test.js:48). The `< 500 ms` check went with nothing in its place. The no-recursion property is kept, since 30,000 levels would overflow a recursive walk. Acceptable under DW-1.
3. **The idle-viewer test checks one timeout period, not two** (v1.test.js:274-283). The `after > 4` lower bound and the second idle period were dropped. The new argument (the viewer would go in the same sweep) covers the first period only. Mutant K could not tell old from new.
4. **The nats stall replay bound is much looser** (nats-bus.test.js:270): from `≤ 2` to `replayed * 2 ≤ accepted` (up to 12 of 24). A partial replay of the queue would pass. Justified by the variance in kernel buffers; still worth a tighter absolute cap (for example `≤ 6`).
5. **Unchanged test "here: relayed between clients…" (tune.test.js:162) timed out once** (20 s) in an unfiltered `test/server` run with services. That run's only change was mutant J, which touches s3 only, so the timeout is unrelated to it. The test passed 15/15 when run alone and 3/3 under load. Logged in TECH-DEBT.
6. **A throwing `getCheckpoint` drops the retry** (feed.js:120). `missed` is cleared before the await. This predates E1. Logged in TECH-DEBT.

## Notes

- The builder's virtual-time rewrites are, on the whole, stronger than what they replace:
  - Exact retry waits.
  - Exact budgets.
  - Logged stop reasons.
  - `lease.live` checked at the deadline.
  - Count-based "before parse".
- Mutants A, B, D, E, F, G, G2, H and Q are all killed by the new tests.
- `test/server/virtual.js` `advance()` re-scans the whole queue per timer (O(n²) per advance). That is fine at test sizes.

## Issues (FAIL)

1. **HIGH-1:** test/server/helpers.js:45 and rig.js:27. Demonstrated by the two-file probes above. Fix: per-file hook registration or a preload.
2. **MEDIUM-1:** server/feed.js:122, :140 and :146. Demonstrated by the defaults probe (30 reads per 30 heartbeats vs 2). Fix: checkpoint seq in the heartbeat, or a bounded retry.
3. **MEDIUM-2:** tune.test.js H1, s3-blobs.test.js:89, pg-store.test.js:266 and main.test.js:155. Demonstrated by mutants C, J, Lk and L, which survive the new suite and are killed by the old tests. Fix: restore discriminating checks without wall-clock flakiness, as listed.

**Verdict: FAIL.** Blockers: HIGH-1 (DW-6 and DW-1 teardown), MEDIUM-1 (DW-5 cost / skill "retry with limits"), MEDIUM-2 (tests weakened).
