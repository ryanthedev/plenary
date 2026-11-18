**FAIL** (1 MEDIUM blocks): every round-1 blocker is closed in the code, but one round-1 LOW was "fixed" by a test that is still weaker than the pre-E1 one. One more MEDIUM (a test gap on the new feed guard) and five LOWs are non-blocking.

# Review round 2: E1 (fast, deterministic tests + feed fix)

2026-11-18. Independent verifier. Reviewed `git diff e8880c4..8dff29d` (ba5348f, dab7574, 8dff29d) in
/Users/r/loops/plenary/wt/plenary. Nothing committed. Probes and mutants ran in a private scratch copy
(scratchpad/e1v2-57377, rsync without .git/.env/node_modules), now removed. Bun 1.4.4. Services: `cluster-rig.js up
--services-only --name e1v2-57377` (torn down with `--clean`).

## Executed Results

| Run | Result |
|---|---|
| Full `bun test`, run 1 (quiet) | 1575 pass, 165 skip, 0 fail, 173.1 s |
| Full `bun test`, run 2 (quiet) | 1575 pass, 165 skip, 0 fail, 186.5 s |
| The 8 gated test/server files (main-cluster, nats-bus, p4-wire2, pg-registry, pg-store, room-host-lease, room-host-proc, s3-blobs) on services | 191 pass, 0 fail, no skip, 41.2 s |
| Every env-gated file (13 files: admin/devadmin, admin/tenants, auth/google-live-server, deploy/cluster-rig, main-cluster, main, nats-bus, p4-wire2, pg-registry, pg-store, room-host-lease, room-host-proc, s3-blobs) on real Postgres/NATS/MinIO | 279 pass, 10 skip, 0 fail, 96.7 s (the 10 skips are in the admin, auth, deploy or main files; not attributed) |
| tune + feed-rebase + preload + nats-bus + role-cache + web/sync, 10x on services | 147 pass, 0 fail every run (8.0-8.7 s) |
| Scratch baseline of all mutant target files (before any mutant) | 257 pass, 0 fail |

No `plen-run-*` root was left in the system temp after either full run. No typecheck or lint is configured.
`package.json` has only `test`; there are no `test:fast` / `test:cluster` scripts. CI (.github/workflows/ci.yml:65, :219)
runs `bun test` from the repo root in both jobs, so it loads the bunfig preload.

## Round-1 findings: status

| Round 1 | Status | Evidence |
|---|---|---|
| HIGH-1 safety nets only in the first file | **CLOSED** | Own probe: 3 files in a new dir, each spawning `sleep 300` through `spawnTracked`, building a rig and throwing. Every child reaped, every rig down, run exits (3 pass / 3 fail as designed). Mutants on test/preload.js: no rig stop (`...[]` in place of the stops) → killed by preload.test.js, with rig1 and rig2 "is stopped" Received "up"; no child kill → killed (20 s backstop fires). |
| MEDIUM-1 unbounded feed retry | **CLOSED in code**; one guard untested (MEDIUM-2 below) | Production-default probe (1.42 MB checkpoint at 1, 1,000-entry tail, defaults): 60 heartbeats with stale `cp` gave **0** checkpoint reads. A new checkpoint gave exactly 1 read. With no `cp` (old host), 60 heartbeats gave 4 reads (1 due + 3 retries). |
| MEDIUM-2 four weakened bounds (C, J, Lk, L) | **CLOSED** | All 9 of my own variants were killed; table below. |
| LOW-1 sync can't see an extra resync | **NOT CLOSED** (now MEDIUM-1) | A delayed third resync survives the new test and is killed by the pre-E1 test. |
| LOW-2 envelope timing | CLOSED | A new test measures the engine's stack limit and walks 2x past it with no throw (test/envelope.test.js:64). |
| LOW-3 idle viewer one period | CLOSED | A second silent socket marks a second idle period; pings counted (v1.test.js:268-292). Passed in both full runs. |
| LOW-4 nats replay bound | CLOSED | Replays must be an in-order prefix and ≤ 10 (nats-bus.test.js:264-273). 10x on real NATS, 0 fail. |
| LOW-5 `here` timeout (TECH-DEBT 9) | CLOSED | Waits on last full list + last counts. PROTOCOL.md:261 and :587 specify count-only `here`, so this matches the spec and is not a weakening. 10x, 0 fail. |
| LOW-6 throwing getCheckpoint drops the retry (TECH-DEBT 10) | CLOSED | Look bookkeeping happens only after `validBase()` returns (feed.js:133-135). Mutant "set lookedAt before the await" was killed by feed-rebase "a Store error…". |
| Extra M3 / R2 retry-pass flake | CLOSED | Each retry pass is awaited to `idle(r)` before the timers are read. M3 still asserts the exact waits `[20, 40, 80]` twice (tune.test.js:296-297). 10x, 0 fail. |

## Mutants (all mine, planted in the scratch copy, restored after each)

| Mutant | Change | Result |
|---|---|---|
| C-role-x3 | gateway.js:572 (`auth.role` bound) × 3 | KILLED by tune H1 (`oneShots` [450] ≠ [150]) |
| C-rolesFor-max1000 | gateway.js:580 (`rolesFor` bound) `max(limit, 1000)` | KILLED by role-cache "finding 1" (tune alone does not cover this site; role-cache does) |
| C-role-default | :572 uses `LIMITS.recheckLookupMs` | KILLED |
| J-get-x2 / J-get-usesPut | s3 get deadline × 2 / put's deadline | both KILLED (1 fail in s3-blobs; test name not captured) |
| J-put-default | s3 put deadline hard-coded 30 s | KILLED (1 fail in s3-blobs) |
| Lk-cap-ttl / Lk-no-cap | postgres.js:167 cap = ttl / no cap | both KILLED (1 fail in pg-store; test name not captured, R2-L1 is the only test reading `lock_timeout`) |
| L-x2 | main.js:365 host lease ttl × 2 | KILLED: main.test.js:206 `remainingMs` 3886 > 2000, main-cluster.test.js:99 5960 > 3000 |
| L-floor5s | nodeConfig floors the ttl at 5 s | KILLED (main + main-cluster) |
| R-eager-saved | room.js: `savedSeq` set at fold time, before the ack | KILLED by v11 "cp names a checkpoint only once its write is acknowledged" |
| R-saved-on-fail | a rejected put also advances `cp` | KILLED (same test) |
| R-no-rebuild-saved | rebuild does not set `savedSeq = S` | KILLED by v11 "every welcome names the room…" |
| F-ignore-cp | feed never records `cp` (always legacy) | KILLED by 4 feed-rebase tests |
| F-legacy-inf | `LEGACY_RETRIES = Infinity` | KILLED (heartbeat and poll variants) |
| F-lookedAt-before | `lookedAt` set before the await | KILLED (Store-error test) |
| **F-no-lookedAt** | feed.js:134 removed (no record of a completed look) | **SURVIVED** the whole feed/room/gateway/v1/outbound set. See MEDIUM-2. |
| F-cp-not-max | `cpHeard = m.cp` instead of the max | Survived, and I judge it **equivalent**: `lookedAt` keeps the max anyway (my backwards-cp probe passes either way). |
| P-sweep-any-error / P-sweep-own | treat any kill error as dead / sweep own root | both KILLED by preload.test.js |
| S-immediate-extra-resync | sync.js reopen() queues one more reopen in a microtask | KILLED by sync "real timers" |
| **S-delayed-extra-resync** | sync.js reopen() schedules one more reopen 300 ms later | **SURVIVED** the new test (81/81 pass). **KILLED** by the pre-E1 test from 3f90e74 (1.2 s settle). See MEDIUM-1. |

**None of the spy assertions is vacuous.** Each one asserts a non-empty exact value: `oneShots()` `[150]` and `[100]`; `armed` `[300]` then `[300, 400]`; `lockTimeouts()` `[200]` and `[5000]`; `remainingMs` ≤ ttl, where reading a null lease would throw. Each fails under a mutant, as the table shows.

## Feed and protocol (distributed-systems-design, CHECKER mode)

| Criterion | Status | Evidence |
|---|---|---|
| Retry with limits (checklists.md: "Retry mechanism with limits") | PASS (code). Test gap: MEDIUM-2 | `cp` mode: one look per announced checkpoint (`lookedAt`). Legacy mode: 1 + 3. Probe for a bad announced checkpoint (entry mismatch): 20 heartbeats gave 2 getCheckpoint calls, i.e. one look plus its step-back. |
| Back-of-envelope cost | PASS | Idle 1.42 MB board: 0 bytes per heartbeat (was 1.42 MB per heartbeat per gateway). |
| Consistency / failure scenarios: `cp` truthfulness | PASS | `savedSeq` advances only in `put.then` or on a synchronous log return (room.js:222-226), and is monotonic. Rebuild sets it to the checkpoint actually loaded (room.js:172), including after stepping back past a bad one. A fenced or failed put is never announced. |
| `cp` across takeover / epoch change (synthetic beats + v11 rebuild test + R-no-rebuild-saved; no real host takeover run) | PASS | `cpHeard` is the max ever heard (feed.js:154), so a new host rebuilt from an older checkpoint, whose `cp` is lower, causes no read and no regress. Probe: base 2000, beats from epoch 1 with cp 2000, then epoch 2 with cp 1000: 0 reads, base kept. A later cp 3000 gives 1 read and rebases. |
| Mixed versions both ways | PASS | Old host (no `cp`): the bounded legacy rule, tested. Old gateway: ignores the extra field. A rolling flip in both directions is tested (feed-rebase "rolling upgrade"). |
| Store errors | PASS (note) | A failed look stays open and is retried once per heartbeat or poll, never faster. While a Store outage lasts this does not stop; see LOW-3. |
| Infrastructure rows (LB, sharding, …) | N/A | A change inside one component. |

## Preload (test/preload.js, test/temp-root.js)

- **Runs for every file.** Proven by the probe and the mutants above. bunfig is read only from the cwd: from `test/` my
  probe failed loudly with "test/preload.js is not loaded: run `bun test` from the repo root". Refusing to run is the right call. Running
  without the preload would quietly bring back HIGH-1. Only tests that spawn children or build rigs refuse; tests that touch neither
  still run, in the system temp.
- **Sweep safety.**
  - It deletes only when `process.kill(pid, 0)` throws ESRCH. EPERM and unknown errors count as alive (temp-root.js:10).
  - It never deletes its own root.
  - A reused pid makes a dead run's root look alive, so it is kept. That leaks a directory but never deletes one.
  - A live run's root cannot be removed, because its pid exists. Probe: a full run's root survived another run's sweep.
  - SIGKILL probe: I killed a run by its recorded pid. Its root stayed until the next run started, which removed exactly that root.
  - One exception: LOW-4 (separate pid namespaces).

## Findings

### MEDIUM-1 (blocking): the sync "real timers" test still misses a delayed extra resync. The pre-E1 test caught it.

- **File:** test/web/sync.test.js:803-805.
- **What happens:** `until(status live && pending 0 …)` returns at the first instant both bindings are live. It then asserts `[resets, reopens]` equals `[2, 1]` straight away.
- **Mutant:** S-delayed-extra-resync. `reopen()` also schedules one more reopen 300 ms later, a plausible "backoff armed twice" bug.
  - The new test passes it, and so do all 81 tests in the file.
  - The 3f90e74 version of the same file, run against the same mutant, fails at the old `sleep(1200)` + `resets === 2` check.
- **Why it matters:** the commit's claim that "a third one shows here" holds only for an immediate (microtask) resync. My S-immediate mutant is killed. This weakens the test compared with the pre-E1 version, against the "never weaken tests" rule.
- **Fix:** after the `until`, wait out more than the largest backoff window. A settle only lengthens the test and cannot make it flaky.
  - For example, wait 2x the backoff cap.
  - Or advance until no timer is pending on the binding's clock.
  - Then re-assert `[resets, reopens]` equals `[2, 1]`.

### MEDIUM-2 (non-blocking, test gap): no test pins the `cp`-mode miss bound (`lookedAt`)

- **File:** server/feed.js:134 (`if (heard !== null) self.lookedAt = …`).
- **The gap:** this line is what stops a look that found nothing usable from repeating on every heartbeat. That repeat was round 1's MEDIUM-1 in a new form.
  - Removing the line (F-no-lookedAt) survives all of feed-rebase, v11, gateway, v1 and outbound.
  - The existing tests always find the announced checkpoint, so `base.seq` alone stops the relook.
- **How to reach the case:** an announced checkpoint that fails `validBase` (an entry mismatch, so the look steps back to one at or below the base), or one that is above the feed's seq.
- **The current code is correct.** My probe "announced checkpoint is bad": 20 heartbeats gave 2 reads (one look) on the real code. The mutant read on every heartbeat, and the probe killed it.
- **Fix:** add that probe to feed-rebase.test.js. Write a mismatching checkpoint at seq N, beat `{ cp: N }` 20 times, and expect exactly one look.

### LOW-1: the room host's `released` message has no `cp`, so it switches the feed to the legacy rule

- **Files:** server/room-host.js:596 (`{ seq, epoch, released: true }`) and feed.js:154.
- **What happens:** the feed treats any non-`items` message as a heartbeat, so `cpHeard` becomes null.
- **The effect is bounded:** at most 1 + 3 looks until the next host's `opened` beat, which carries `cp`. No correctness issue.
- **Fix:** add `cp: slot.room.heartbeat().cp` to the released message, or ignore `released` in the `cp` bookkeeping. Also fix PROTOCOL.md § Bus, which says only "a host from before cp" sends no `cp`.

### LOW-2: there are no `test:fast` / `test:cluster` scripts

The brief mentions them, but package.json has only `test`. The preload works for `bun test <paths>` from the root, which is what `cluster-rig env` users and CI do. Nothing to fix unless those scripts are meant to exist.

### LOW-3: a persistent Store fault can cost a full checkpoint read per heartbeat

- **Where:** feed.js:103-105.
- **What happens:** while a look keeps failing, it is retried on every heartbeat with no limit. That is cheap when `getCheckpoint` itself fails.
- **The costly case:** `getCheckpoint` succeeds (the full read and parse) and then `store.read(cp.seq, 1)` fails. Every heartbeat then repeats the full read for as long as reads fail.
- **Why LOW:** a Store that is down for reads also stops the feed's repair, so this is minor. It is an edge for TECH-DEBT, not a blocker.

### LOW-4: the sweep assumes every run on this temp shares one pid namespace

- **What happens:** suppose two containers share a temp dir (a bind-mounted /tmp). A live run in the other namespace returns ESRCH, so its root would be deleted mid-run.
- **Where it can't happen:** not on macOS dev machines or GitHub runners (one VM per job).
- **Fix:** document it in temp-root.js, or put the hostname or boot id in the root name.

### LOW-5: the end-to-end `lies` check in feed-rebase cannot catch an early announcement

- **File:** test/server/feed-rebase.test.js:153-158.
- **Why:** it reads the Store asynchronously after the heartbeat, and sqlite acks long before the next 200 ms beat.
- **Covered elsewhere:** the unit test in test/v11.test.js:139 does kill an eager `cp` (R-eager-saved). So the property is pinned; the e2e assertion only adds little.

## Notes

- **The new feed tests are good.** They use a counting Store wrapper on a real sqlite Store, and every assertion is an exact read count.
- **`F-cp-not-max` is an equivalent mutant.** It needs no test.
- **Full-suite time is about the same as round 1** (173 / 187 s against 176 / 167 s).
- **TECH-DEBT rows 4, 7, 8, 9 and 10 are marked FIXED with the right commits.** Row 4 is now actually true.

Basis: the dispatch requires "never weaken tests" and that every round-1 finding be closed; LOW-1 was claimed fixed, yet a mutant the pre-E1 test kills survives the new one (the same basis round 1 used for MEDIUM-2).

**Verdict: FAIL.** Blocker: MEDIUM-1 (test/web/sync.test.js:803, a weakened check demonstrated by S-delayed-extra-resync). MEDIUM-2 and the LOWs should go in the same fix round, per "fix everything".
