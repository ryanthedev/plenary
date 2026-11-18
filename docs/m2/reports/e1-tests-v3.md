**FAIL** (1 MEDIUM blocks). Both round-2 MEDIUMs are closed, and my own mutants confirm it. The new `released` cp, though, causes a demonstrated regression in `roomHost.close()`. Two new guards in the backoff and two in the sweep have no test. All runs are green and the sync wait is not flaky.

# Review round 3: E1 (fast, deterministic tests + feed fix)

2026-11-18. Independent verifier. Reviewed `git diff 8dff29d..813070e` in /Users/r/loops/plenary/wt/plenary. Nothing committed.

- **Where probes and mutants ran:** a private scratch copy (scratchpad/e1v3-85421, rsync without .git, .env and node_modules, then `bun install`). Removing it was refused by this session's permissions, so it is still there; delete it when convenient.
- **Restoring:** after each mutant, the file was put back from the worktree and checked with `diff -q`.
- **Services:** `cluster-rig.js up --services-only --name e1v3-85421`, torn down with `down --clean`.
- **Concurrent load:** another loop's `bun test` (wt/tryit) was running during part of the review.

## Executed Results

| Run | Result |
|---|---|
| Full `bun test`, run 1 | 1578 pass, 165 skip, 0 fail, 176.8 s |
| Full `bun test`, run 2 | 1578 pass, 165 skip, 0 fail, 178.4 s |
| All 13 env-gated files on real Postgres/NATS/MinIO, run from wt/plenary | 279 pass, 10 skip, 0 fail, 101.3 s (same as round 2) |
| `test/web/sync.test.js` 15x, with a looping `bun test test/server` running alongside the whole time | 81/81 pass every run |
| feed-rebase + sync + preload 10x, still under that load (junit timings) | 94/94 pass every run. "real timers" test: 2.27-2.48 s (max 2.48 s vs bun's 5 s default timeout: 2.5 s margin) |
| Scratch baseline (feed-rebase, preload, sync, v11) before any mutant | 134 pass, 0 fail |

- **No typecheck or lint:** none is configured.
- **Temp roots after the runs:**
  - No `plen-run-*` root was left behind.
  - My load loop's `bun test` was killed with SIGTERM by its recorded pid. It left `plen-run-12707-*`, and the next run's sweep removed it: a live check that the sweep reclaims a killed run's root.

## Round-2 findings: status

| Round 2 | Status | Evidence (my own mutants) |
|---|---|---|
| MEDIUM-1: sync misses a delayed extra resync | **CLOSED** | The extra `reopen()` at +300, +900 and +1500 ms is now KILLED (the round-2 mutant was +300). An immediate (microtask) extra reopen is KILLED. +2500 ms survives; that is beyond any first-refusal backoff window, which `reconnectWait` caps at 500 ms (fails=0, factor [0.5,1)). The new check is strictly stronger than the pre-E1 1.2 s settle. |
| MEDIUM-2: `lookedAt` untested | **CLOSED** | Removing feed.js:141 is KILLED. `lookedAt = cp.seq` in place of `heard` is KILLED. Both fall to "an announced checkpoint that doesn't match the log…". |
| LOW-1: `released` has no cp | **CLOSED** in the feed. **The fix regresses `close()`** (MEDIUM-1 below). | Drop cp from room-host's `released`: KILLED. The feed ignoring `released` for cp: KILLED. |
| LOW-2: no `test:fast` / `test:cluster` scripts | Unchanged (package.json has only `test`) | Nothing to fix unless the scripts are meant to exist. |
| LOW-3: a persistent Store fault costs a read per heartbeat | **CLOSED in code**. Two guards untested (MEDIUM-2 below). | No backoff: KILLED. `2^n - 1` in place of `2^(n-1) - 1`: KILLED. |
| LOW-4: the sweep assumes one pid namespace | **Mostly CLOSED** (LOW-2 below) | Drop the host check: KILLED. Treat a missing owner file as dead: KILLED. Sweep our own root: KILLED. Never write owner.json: KILLED. |
| LOW-5: the e2e `lies` check can't catch an early cp | **CLOSED** | R-eager-saved (room.js: `savedSeq = cp.seq` at fold time) is now KILLED by feed-rebase alone ("end to end on a room host…"), thanks to the 500 ms `putCheckpoint` delay. `rawStore` is unwrapped. |

## Mutants (all mine)

| Mutant | Change | Run against | Result |
|---|---|---|---|
| F-no-backoff | `self.skip = 0` on failure | feed-rebase | KILLED |
| F-skip-2n | `2 ** failures - 1` | feed-rebase | KILLED (2 tests) |
| **F-maxskip-1000 / -15 / -63** | `MAX_SKIP` = 1000, 15 or 63 | feed-rebase; 1000 also against feed-rebase, v11, gateway, v1, outbound, room-host-lease, tune (148 tests) | **SURVIVED** all |
| **F-no-failures-reset** | delete `self.failures = 0` | the same 148 tests | **SURVIVED** |
| F-skip-any-msg | the skip gate also counts entry messages (`if (self.skip > 0)`) | the same 148 tests | SURVIVED (Note 2) |
| F-no-lookedAt, F-lookedAt-cpseq | see the round-2 table | feed-rebase | KILLED |
| F-released-no-cp, R-released-no-cp | see above | feed-rebase | KILLED |
| R-eager-saved | see above | feed-rebase | KILLED |
| S-delayed-300 / 900 / 1500, S-immediate | one extra `reopen()` per binding | sync | KILLED |
| S-delayed-2500 | the same, at +2.5 s | sync | survived (outside the window, by design) |
| T-no-host, T-missing-owner-dead, T-sweep-own, T-no-owner-file-written | temp-root.js | preload.test | KILLED |
| **T-no-pid-le0, T-no-safeint** | drop `owner.pid <= 0` / `Number.isSafeInteger` | preload.test | **SURVIVED** (LOW-1) |

## Backoff (distributed-systems-design, CHECKER mode)

Production values:
- heartbeat: `heartbeatMs = 2_000` (room-host.js:91)
- poll check: every `pollMs/2 = 2.5 s` while quiet
- `MAX_SKIP = 31`

| Criterion | Status | Evidence |
|---|---|---|
| Retry mechanism with limits (checklists.md:46) | PASS (code) | Probe: a 100-heartbeat getCheckpoint outage cost **8 looks**: beats 1, 2, 4, 8, 16, 32, 64 and 96, so one per 32 beats once capped (was 100). The cap and the reset have no test: MEDIUM-2. |
| Bounded recovery after a Store outage | PASS: bounded at ≤ 31 skipped beats | Probe: after that outage the Store recovers *and* the room announces a newer cp (10). The feed rebased on the **28th** heartbeat after recovery, **about 56 s** at 2 s heartbeats. In the worst case 31 skipped beats is 62 s, or about 80 s on Store polls alone. |
| Prompt enough | Note: a matter of degree | See LOW-3. A newer `cp` proves the Store just acknowledged a checkpoint write, yet it does not cut the backoff short. The cost of the delay is a larger cached tail and larger join catch-ups for up to about a minute. No correctness effect: entries still flow, and repair is not gated. |
| Cap vs heartbeat rate | Note | 31 × 2 s = 62 s. Reads during an outage drop from 30 per minute to about 1 per minute per gateway per board, a reasonable ratio. The cap could be lower (15 gives about 30 s); it is a judgment call. |
| A single transient error | PASS | n=1 gives skip 2^0 - 1 = 0. Probe: the next heartbeat looks and rebases (1 beat). The same holds right after a 100-beat outage (1 beat), because a success resets `failures`. **That reset is untested:** without it the same probe takes **32 beats (64 s)** for one transient error (F-no-failures-reset). |
| Graceful degradation | PASS | A failed look throws to the message handler's catch. It does not block live entries or repair. |
| Failure scenarios / legacy path | Note 2 | On a host without cp, a due look on an entries message is not gated by `skip` (feed.js:127: `beat &&`). With a failing Store and steady writes, legacy mode looks once per `rebaseEvery` entries plus the backoffed beats. PROTOCOL's "at most one look per 32 heartbeats" is therefore not literally true there. This needs an old host, a Store whose reads fail while its appends succeed, and a busy board. |
| Jitter | Note | All gateways back off in lockstep on the same heartbeats (no jitter). The skill's checklist has no jitter row; noted only. |
| Infrastructure rows (LB, sharding, …) | N/A | A change inside one component. |

## Sync "real timers" wait

- **The wait is deterministic.** It waits for a condition first (`until`), and only then makes a fixed 2 s real wait. The test's outcome cannot depend on load, which only lengthens the first wait.
- **No other timer fires in that idle window.** The Replica's other deadlines are `OP_TIMEOUT_MS` and `CONNECT_TIMEOUT_MS`, both 10 s (envelope.js:45-46), well past 2 s.
- **The first refusal starts at fails=0.** `fails` starts at 0 (replica.js:36) and increments in `failed()` (:323). The observed totals of 2.27-2.48 s, i.e. 2 s plus 0.27-0.48 s, match the 250-500 ms first wait.
- **Under load:** 25 runs with `test/server` looping alongside, 0 failures, at most 2.48 s against the 5 s default per-test timeout.
- **The window claim is generous.** A first refusal waits `min(30 s, 500 × 2^0) × [0.5, 1)` = 250-500 ms. The comment's "≤ 1 s" is conservative and the 2 s wait doubles it.

## Temp-root sweep (never delete on doubt)

Probe on the real code. Ten roots under one base:
- owner files: `null`, string pid, pid 0, pid -99999, pid 1.5, pid 2^40, no host, empty, `[]`
- one root named after the live pid but whose owner file names a dead pid

**Only that last root was removed.** The sweep trusts owner.json, which `makeRunRoot` writes from the same pid, so this needs a forged file. Everything else was kept, and a root whose owner file isn't written yet is kept (read fails, `continue`).

## Dead code and correctness dimensions

- **Dead code:** none found in the diff. preload.js dropped its now-unused `mkdtempSync` and `join` imports.

| Dimension | Status | Evidence |
|---|---|---|
| Concurrency | PASS | The feed's look runs inside `run()` (serialized). A sweep that races a starting run keeps the root, since a missing owner.json means `continue`. |
| Error handling | **FAIL** | MEDIUM-1: a null `slot.room` in `close()`. |
| Resources | PASS | Temp roots are reclaimed after a SIGTERM (observed). No orphaned processes from my runs: I listed every ppid-1 process and found none from today's window. |
| Boundaries | PASS (with test gaps) | The backoff exponent is capped (`MAX_SKIP`). The sweep's pid guards are probed (LOW-1). |
| Security | N/A | No untrusted input in the diff (test infrastructure plus internal bus fields). |

## Findings

### MEDIUM-1 (blocking, regression): `close()` throws on a held slot whose build failed. It logs a false "lease release failed" and no longer publishes `released`.

- **File:** server/room-host.js:596 (`cp: slot.room.heartbeat().cp`).
- **Trace:**
  1. `start()` puts the slot in `held` (:293) before `build()`.
  2. A build that throws before `Room.rebuild` returns leaves `slot.room === null`. Causes: a Store error on getCheckpoint or read, or a non-`bad-checkpoint` rebuild error. Its catch releases the lease (:298).
  3. `held` is never pruned (only `held.set`, :293; `held.clear()` at close). So in `close()` the slot is still there.
  4. `store.release` succeeds, then `slot.room.heartbeat()` throws a TypeError inside the same `try`.
  5. The catch logs `"lease release failed; it lapses within its ttl"`. That is false: the lease is already released (probe: holder null afterwards).
  6. The `released` publish is skipped.
- **Probe** (roomHost on sqlite, getCheckpoint throwing, `open` → fails → `close()`):
  - **813070e:** released msgs `[]`, warns `["lease release failed; it lapses within its ttl"]`.
  - **8dff29d room-host.js, same probe:** released msgs `[{"seq":0,"epoch":1,"released":true}]`, warns `[]`.
- **Impact:**
  - A host watching that board takes it at once on `released` (:381, `attemptNow`). Without it, the watcher waits out 2 heartbeats of silence (about 4 s).
  - An operator sees a false lease warning.
  - PROTOCOL.md § Bus says a host that stops cleanly publishes `released`.
- **Fix (restores 8dff29d's behaviour):** guard the read, `cp: slot.room?.heartbeat().cp ?? 0`. 0 is truthful (no checkpoint known), and it keeps the feed on the cp rule, since `cpHeard` is a max.
- **Coordinator's call:** skipping held slots with no room in `close()` would also stop a `released` for a board this host never served. But it is a behaviour change: the watcher would always wait out the silence, and the build-failure release at :298 is fire-and-forget, so it may not have landed when `close()` returns.
- **Test:** turn the probe into a test. After a failed build, `close()` publishes exactly one `released` message and logs no warn.
- **What is right in this path:** `cp` reflects the stop checkpoint's ack. The put is tracked in `slot.writes` (:167-171), which `close()` awaits before release. The room's `.then(saved)` was attached first, so it runs before that await resolves. The new test asserts `cp: 1` with the checkpoint in the Store.

### MEDIUM-2 (test gap): the backoff's cap and its reset are unpinned

- **File:** server/feed.js:124 (`MAX_SKIP = 31`) and :140 (`self.failures = 0`).
- **What survives:**
  - `MAX_SKIP` at 15, 63 or 1000 survives feed-rebase. 1000 also survives the 148-test feed, room and gateway set.
  - The new test stops at 5 failures (skip 15), so the cap is never reached.
  - Deleting the reset survives the same set: nothing fails again after a recovery.
- **Why they matter:**
  - PROTOCOL.md § Bus states "at most 31".
  - These two lines are what bound recovery. Without the cap, a long outage grows the skip without limit: about 2^n heartbeats.
  - Without the reset, one transient error after an old outage costs 32 beats (64 s), not 1 (probe above).
- **Fix:** extend the test.
  - Fail the look for 100 or more heartbeats and expect exactly the looks at 1, 2, 4, 8, 16, 32, 64, 96 (8 looks).
  - Then recover and expect a rebase within 32 beats.
  - Then fail once more and expect the next heartbeat to look.
- **Severity:** round 2 rated its untested-guard finding MEDIUM and non-blocking. I rate this one the same way: non-blocking, but it belongs in the same fix round.

### LOW-1 (test gap): the sweep's pid guards are untested

- **File:** test/temp-root.js:36 (`!Number.isSafeInteger(owner?.pid) || owner.pid <= 0`).
- **Mutants:** T-no-pid-le0 and T-no-safeint survive preload.test.js.
- **The guards matter:** with both removed, my probe deleted the roots whose owner pid was the *string* of a dead pid, and pid -99999. `kill(-n, 0)` targets a process group, and a dead group gives ESRCH.
- **Fix:** add a string pid and a negative pid to the "anything doubtful is kept" test.

### LOW-2: the hostname proxy fails for `--network=host` containers

- **File:** test/temp-root.js:4-7.
- **What happens:**
  - A container run with `--network=host` (without `--pid=host`) takes the host's hostname but has its own pid namespace.
  - Suppose such a container and the host share a bind-mounted temp dir. Each would then see the other's live runs as ESRCH on the same hostname, and delete them.
  - The comment "a container gets its own" is not true in that setup.
- **Where it can't happen:** macOS or GitHub runners. This is a trace, not reproduced here.
- **Fix:**
  - On Linux, add the pid namespace (`readlinkSync("/proc/self/ns/pid")`) or the boot id to owner.json.
  - Or narrow the comment.

### LOW-3: a newer `cp` doesn't cut the backoff short (recovery promptness)

- **File:** server/feed.js:127.
- **What happens:**
  - After an outage, the feed may sit out up to 31 heartbeats, 62 s at production rates (probe: 28 beats).
  - This holds even though a newer `cp` shows the Store just acknowledged a checkpoint write.
- **Bounded:** yes, ≤ 31 skipped beats.
- **Cost:** a larger tail and larger catch-ups for about a minute. No correctness impact.
- **Option:** clear `skip` when `cpHeard` rises above the cp the failing look was for. The bound stays one look per announced checkpoint plus the backoff.

## Notes (non-blocking)

1. **Doc duplication:** PROTOCOL.md § Bus now says "A look that fails (a Store error) is tried again (on the backoff below)" and then restates the backoff two sentences later. It reads fine.
2. **Legacy gating:** F-skip-any-msg survives, and in legacy mode an entries-triggered due look ignores `skip` (see the CHECKER table). Making `skip` gate all looks, or rewording PROTOCOL's "at most one look per 32 heartbeats" to "per 32 heartbeats or `rebaseEvery` entries", would make the spec literal.
3. **Pre-owner-file roots:** roots left by runs from before owner.json existed are kept forever, which is the safe choice. None were present in the system temp.
4. **Name/owner disagreement:** a root named after the live pid but whose owner.json names a dead pid is removed. The owner file is authoritative, and only a forged file can produce this.
5. **TECH-DEBT:** no new row. Everything above is in this diff's scope.

**Verdict: FAIL.** Blocker: MEDIUM-1 (server/room-host.js:596, a regression demonstrated by probe against 8dff29d). MEDIUM-2, LOW-1, LOW-2 and LOW-3 should be fixed in the same round, per "fix everything".
