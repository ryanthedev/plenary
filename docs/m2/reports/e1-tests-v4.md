# Review round 4: E1 (fast, deterministic tests + feed fix)

Range reviewed: `git diff 813070e..1ed2585` (ffe5fc8, 1ed2585). Reviewer: an independent post-gate agent. Nothing was committed.

## Executed Results

- Full suite, without `test/load/counting.test.js` and `test/deploy/cluster-rig.test.js` (98 files):
  - Run 1: **1537 pass, 165 skip, 1 fail** (122 s, load average ~15). The failure was `test/load/guards.test.js:165` "a load phase shorter than one CPU sample, burned…": it expected > 85 and got 61.3.
  - Run 2: **1538 pass, 165 skip, 0 fail** (128 s).
- Cluster-gated files on a services-only rig (`e1v4-84847`; Postgres + NATS + MinIO): admin/devadmin, admin/tenants, room-host-lease, nats-bus, pg-store, s3-blobs, main, pg-registry, main-cluster, p4-wire2, room-host-proc and feed-rebase. **258 pass, 0 fail** (59 s).
- The builder's claim that the only failures were in two files. Each file was run alone at load average 41:

  | file | 1ed2585 | 813070e |
  |---|---|---|
  | test/load/counting.test.js | 11 pass / 1 fail | 11 pass / 1 fail |
  | test/deploy/cluster-rig.test.js | 33 / 0 | 33 / 1 |
  | test/load/guards.test.js | 9 / 2 | 9 / 2 |

  The claim holds for the two files it names: both fail the same way before and after this range, and this range does not touch them. **It is incomplete.** `test/load/guards.test.js` has the same CPU-under-load fault. It failed full run 1 and fails alone on both revisions at load 41, then passed 11/0 alone at load 31. It is not in this diff, and plenary/load5 already replaces the burn with an injected `cpuUsage`. Logged as TECH-DEBT row 17.
- No typecheck or lint is configured (plain JS; package.json has only `test`).

## Round-3 findings: status (each confirmed by my own mutant)

| Round-3 finding | Status | Mutant → result |
|---|---|---|
| MEDIUM-1: `close()` throws after a failed build | **CLOSED** | Revert `slot.room?.…?? 0` → KILLED. `cp` without `?? 0` → KILLED. Constant `cp: 0` → KILLED (feed-rebase "released carries cp"). The new test checks the release, `released` with cp 0, no false warn, and the lease no longer live. |
| MEDIUM-2: `MAX_SKIP` and the failure reset are untested | **CLOSED** | `MAX_SKIP` 63 → KILLED. 15 → KILLED. No `failures = 0` → KILLED. `2^n - 1` → KILLED. |
| LOW-1: the sweep's pid guards | **CLOSED** | Drop `pid <= 0` → KILLED. Drop `isSafeInteger` → KILLED. Drop the host check → KILLED. |
| LOW-2: `--network=host` (hostname proxy) | **CLOSED** | Drop the ns check → KILLED. `makeRunRoot` without ns → KILLED. |
| LOW-3: a newer cp doesn't cut the backoff short | **CLOSED** | No cut-short → KILLED. `>=` for `>` → KILLED. `failedFor = 0` → KILLED. `failedFor = Infinity` → KILLED. |
| Note: legacy due look not gated | **CLOSED** | Gate only on beats (the old code) → KILLED. Decrement on any message → KILLED. |
| Note: no jitter | **CLOSED** | `skip = b` → KILLED. Range [0, b] → KILLED. Range [b - ⌊b/2⌋ + 1 … b] → KILLED. |
| Note: PROTOCOL "one look per 32 heartbeats" | Reworded. A residual imprecision remains (LOW-1 below). | n/a |

23 mutants in all, run before the coordinator's "ease off mutation testing" note arrived. No more were run after it. Two survived, both equivalent: dropping `!("ns" in owner)` and `!=` for `!==` in temp-root.js. The strict `owner.ns !== ns` already rejects a missing ns, since JSON has no `undefined`.

## The backoff (PROTOCOL.md § Bus, server/feed.js:121-152)

- **Formula.** `skip = b - floor(random() * (floor(b/2) + 1))`. With random() in [0, 1) this gives exactly [b - ⌊b/2⌋, b] = [⌈b/2⌉, b]. PROTOCOL, the code comment and the code agree. At the cap, b = 31 gives k in [16, 31], so at most 1 look per 17 heartbeats. The jitter test pins this with `random: () => 0.999`.
- **Every look is gated while skipping** (feed.js:131). The skip counts down only on heartbeats and polls, so an entries burst cannot spend it.
  - *Can it starve a joiner?* No, it is bounded. Heartbeats are unconditional every 2 s (room-host.js:524-530), and polls run while quiet. After the Store recovers, the longest wait is the remaining skip: ≤ 31 beats (≤ 62 s; ~80 s on polls alone).
  - Probe, legacy host (no cp), 2 entries per beat, 100 beats of outage, then recovery: the outage made 8 failed looks, and the rebase came **21 beats** after recovery with a tail of 42 entries.
  - Meanwhile the cached tail grows past `rebaseEvery`/`rebaseBytes` by up to about a minute of entries, so joiners get a larger catch-up. This costs bytes, not correctness: delivery and repair are never gated. In cp mode a newer cp ends the wait at once.
- **Cut-short on a newer cp** (feed.js:130). `failedFor` is the cp the failing look was for, and the code is serialized by `run`, so `cpHeard` cannot change during a look. `cpHeard` only grows, or becomes null on a heartbeat without cp, so no spurious cut-short can repeat. A cut-short while `cpHeard > seq` sets skip to 0 but makes no look until the entries arrive. That is correct.
- **The released-cp guard.** `slot.room?.heartbeat().cp ?? 0` gives cp 0 for a slot that never built a Room. The feed treats cp 0 as "nothing newer" (`cpHeard` max(…, 0)). This is harmless.
- **The owner.json ns check.** It is safe for non-object JSON: `owner?.host` short-circuits before `in` can throw on a number or string. macOS gives null === null. Linux gives the namespace link string.

### distributed-systems-design, CHECKER mode (checklists.md § Reliability, applied to the look backoff)

| Criterion | Status | Evidence |
|---|---|---|
| Retry mechanism with limits | PASS | 110-beat outage: looks at beats 1, 2, 4, 8, 16, 32, 64, 96 with k = b, and at most 1 per 17 with k = ⌈b/2⌉ (both pinned by tests). |
| Graceful degradation | PASS | A failed look throws to the message handler's catch. Entries and repair are not gated. |
| Failure scenarios discussed | PASS with LOW-1 | A transient error retries on the next beat, and a success resets n (test). Recovery is bounded (probe: 21 beats). With a persistently failing Store plus fresh checkpoints, see LOW-1. |
| Jitter / thundering herd | PASS (note) | Equal jitter over [⌈b/2⌉, b]. The first two retries (b = 0, 1) are still in lockstep across gateways, which is fine for 2 beats. At the cap the spread is 16 distinct beats. |
| Infrastructure rows (LB, sharding, replication…) | N/A | A change inside one component. |

## main.test.js: 15 s → 60 s (1ed2585)

This is a **backstop, which is fine.** `until(() => acked.size >= before + 100, …)` polls an event condition and returns the moment it holds. The timeout only decides how long a broken run takes to report. The test's subject is durability across kill -9 (every acked op present, at its seq, once), not throughput. The nominal time is ~5 s: 100 acks under the 20/s pace with a burst of 100.

A deterministic alternative changes nothing material. One could drop the inner deadline and let the test-level timeout bound it, but the inner deadline gives a clearer message ("100 more acks"). Ack latency and throughput belong in the load tests (test/load, M4), not here.

The one cost: the test-level timeout went from 150 s to 300 s, so a genuine hang now costs up to 5 minutes before it reports (see Notes).

## Correctness dimensions

| Dimension | Status | Evidence |
|---|---|---|
| Concurrency | PASS | `maybeRebase` and `rebase` run inside the feed's serial `run` queue. `failedFor` and `skip` are read and written only there. |
| Error handling | PASS | The round-3 null `slot.room` is closed (test plus mutant). A look failure still propagates to the logged catch. |
| Resources | PASS | No new handles. The sweep never deletes on doubt (the new test covers the ns, missing-field and pid cases). |
| Boundaries | PASS | b = 0 gives skip 0. random() → 1⁻ gives ⌈b/2⌉. The exponent is capped. A cp of 0 on `released` is handled. |
| Security | N/A | No untrusted input reaches the changed code beyond what round 3 covered (bus messages are already validated with `Number.isSafeInteger`). |

Dead code: none found. One redundant clause, under Notes.

## Findings

### HIGH
None.

### MEDIUM
None.

### LOW-1: "at most one look per 17 heartbeats" is not literal when checkpoints keep coming
- PROTOCOL.md § Bus (the backoff sentence), server/feed.js:124-126 (comment), feed.js:130 (cut-short).
- Probe: entry reads fail persistently, and each of 40 heartbeats names a cp one above the last (each written to the Store). The feed looked on **all 40 beats**. Every newer cp ends the skip, as specified in the very next sentence.
- The cost is bounded by the checkpoint announcement rate: at most one look per heartbeat, which is the healthy cost of one read per new checkpoint. So this is a wording issue, not a defect. The spec says "costs at most one look per 17", then carves the exception out in the next sentence.
- Suggested rewording: "…at most one look per 17 heartbeats or polls once capped, plus one per newly announced checkpoint."

### LOW-2: the builder's full-suite failure inventory missed test/load/guards.test.js
- test/load/guards.test.js:165. A real-CPU burn under load reads 61% against a limit of 85. It failed full run 1 here, and fails alone on both 1ed2585 and 813070e at load 41.
- This range does not touch it, and plenary/load5 already fixes it (an injected `cpuUsage`). It does not block this range. TECH-DEBT row 17 added (status: fixed on plenary/load5).

## Notes (non-blocking)

1. **The legacy gating's recovery delay.** It is bounded at ≤ 31 beats after recovery (probe: 21 beats, about 42 s, with a 42-entry tail). It matters only with an old host, a failing Store, then recovery. In cp mode the delay ends at the next newer cp.
2. **A redundant clause.** In temp-root.js:43, `!("ns" in owner)` is implied by `owner.ns !== ns` (an equivalent mutant). Keeping it as documentation is fine.
3. **Old roots are never swept.** Owner files written before this change have no `ns`, so the sweep keeps their roots forever ("never delete on doubt"). These are a few stale `plen-run-*` dirs left from earlier runs on dev machines. Harmless, and the cleanup is manual.
4. **No test pins the jitter default.** Nothing checks that `random` defaults to `Math.random`. A default of `() => 0` would disable the jitter in production without failing a test. It is low risk, since the default sits in plain sight on the signature.
5. **The kill -9 test's timeout.** It is now 300 s (main.test.js:237), so a real hang costs 5 minutes. Acceptable as a backstop.
6. **Leftovers.** My scratch copies remain, because the sandbox denied `rm -rf`:
   - /private/tmp/claude-501/-Users-r-loops-plenary/202948b0-1a27-4f6f-a14b-b282a0b4a3ac/scratchpad/e1v4-84847 (the mutant copy; all mutants restored, probe file removed)
   - /private/tmp/claude-501/-Users-r-loops-plenary/202948b0-1a27-4f6f-a14b-b282a0b4a3ac/scratchpad/e1v4-base-84847 (an export of 813070e)
   - /private/tmp/claude-501/-Users-r-loops-plenary/202948b0-1a27-4f6f-a14b-b282a0b4a3ac/scratchpad/e1v4 (logs, env with rig secrets for a now-stopped rig)

   The rig `e1v4-84847` was stopped with `down --clean`: minio, nats and postgres stopped, and there is no `.rig/e1v4*` entry left. The worktree is unchanged apart from this report.

**Verdict: PASS.** Every round-3 finding is closed and each is confirmed by a killed mutant. The full suite (without the two named files) gave 1537/1 and 1538/0; the one failure is the out-of-range, load-dependent guards.test.js (LOW-2). The cluster-gated files gave 258/0. LOW-1 is spec wording only.
