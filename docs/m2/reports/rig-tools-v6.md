# Review: Job A round 6 — rig tools fix commits 99e9a90 and 4e123d2 (close H1, M5, L22–L24 of round 5)

Diff reviewed: `git diff 8d0f5a1..4e123d2`. Worktree `wt/rig`, branch `plenary/rig`, bun 1.4.4, macOS 25.2.
Machine load during the runs: load average 4–15 from other loops, up to 25 with my own busy loops.
All experiments ran in a scratch copy, `scratchpad/rigv6-95523`. In that copy `PS_DEFAULT` could be overridden by env,
and a `RIGV6_STOP_AFTER_REAP` exit was added after the reap. Neither change is in the worktree.

## Executed results

| Run | Result |
|---|---|
| `bun run test:cluster` x3 | 3/3 exit 0 (63 s, 63 s, 64 s). Each run ends `down: stopped minio, nats, postgres` |
| `bun run test:fast` | 412 pass, 0 fail (4.1 s) |
| `bun test test/deploy test/architecture.test.js` x2 | 2/2: 76 pass, 0 fail. **Wall time 58 s, 57 s** (round 5: 57–59 s) |
| `bun test test/deploy/test-cluster.test.js -t 'M4:\|H1 (v5): a SIGINT storm\|M5: a 1 ms' --rerun-each 30`, 8 `yes` loops | 90 pass, 0 fail (60 s, load 9) |
| Same, 16 `yes` loops | 90 pass, 0 fail (69 s, **load 25**) |

So the M4, H1 and M5 storm tests passed 60/60 each under load. Round 5 had M4 at 19/20.

## H1, M5 and L22–L24: status, from my own experiments

| Item | Status | Evidence |
|---|---|---|
| H1 reaper reaps a live run on a failed ps | **CLOSED** | See "H1 probes" below |
| M5 down killed in the detached-spawn window | **CLOSED** (retry, not removal; the argument holds) | See "M5 probes" below |
| L22 reusable "dead" pid | **CLOSED** | `deadPid()` is above macOS PID_MAX (99 999) or above Linux `pid_max`, so `kill(0)` gives ESRCH and ps is never run. Planted rigs also get a 1970 owner record (`deadOwner`) |
| L23 "rig kept" for a dir never made | **CLOSED** | test-cluster.js:99 checks `existsSync(dir)`. M4 and M5 assert the line is absent; both passed 60/60 |
| L24 extensionless importer | **CLOSED** | The `orphans` regex matches a basename stem with an optional extension, as a whole path segment (test-cluster.test.js:55-61). The fixture covers `'./helper'`, a template literal, and lookalikes (`helper-ts.ts`, `my-helper.js`, a bare word) |

### H1 probes (can the reaper ever reap a live run's rig?)

`liveowner.mjs` driver: one live `sleep` acts as the owner pid. N rigs are owned by it, each with a correct owner
record and a `sleep` as its service. Some stale rigs have dead pids (>99 999). test-cluster.js runs on that root.

1. **A broken ps at the reaper's call sites** (the stub replaces /bin/ps for test-cluster itself; `down` uses the real
   ps). Each stub ran 2 runs with 5 live rigs and 1 stale rig:

   | Stub | Behaviour | Result |
   |---|---|---|
   | `killed` | SIGKILL | 0 live reaped; 10/10 "leaving … alone" |
   | `intr` | SIGINT every time | 0 live reaped; 10/10 left alone |
   | `garbage` | prints garbage | 0 live reaped; 10/10 left alone |
   | `absent` | exit 1, empty output | 0 live reaped; 10/10 left alone (psCheck refuses) |
   | `exit2` | exit 2 | 0 live reaped; 10/10 left alone |
   | `empty0` | exit 0, empty output | 0 live reaped; 10/10 left alone |
   | `flaky` | SIGINT on 2 of every 3 calls | 0 live reaped; 0 left alone (the psInfo retry answered) |
   | `hung` | 2 rigs | 0 live reaped. ETIMEDOUT after 10 s each (20 s total), no retry. I checked that bun's `spawnSync` sets `error` on a timeout, so the timeout breaks out of the retry loop |

   In every row the stale rig was still reaped: its pid is dead, so `kill(0)` decides it and no ps is run.

2. **The owner-record write with a broken ps** (`intr`, `absent`, `garbage`, without the stop after the reap). Each run
   gave `failed: cannot …` and exit 1. The root was left empty: no owner record and no rig dir.

3. **SIGINT storms during the ownership checks** (real ps):

   | Live rigs | Storm | Starts at | Runs | Live rigs reaped |
   |---|---|---|---|---|
   | 150 | 2 ms | "checking" | 8 | 0 |
   | 150 | 1 ms | "checking" | 8 + 9 | 0 (607 + 79 "left alone" decisions) |
   | 40 | 1 ms | "reaping stale" | 10 | 0 |

   In round 5, one SIGINT reaped a live rig in 5/6 runs, and a 2 ms storm reaped 100–115 of 150.

4. **Mutants**, in the scratch copy. Each was caught by the suite:
   - `ownerSurelyGone` returns true on error: the H1 storm test fails 5/5.
   - `ownerGone` returns "gone" on "absent" without `psCheck`: the in-process H1 test fails.
   - Without the `setTimeout(0)` yield: the H1 storm test fails 5/5.

### M5 probes

- **The builder's argument holds empirically.** `race.mjs` spawned 300 detached `/bin/sleep 0.03` under a 1 ms SIGINT
  storm sent to the parent's group. The deaths per 300:

  | Variant | Deaths |
  |---|---|
  | Plain spawn | 31 |
  | Parent blocks INT/TERM/HUP with `pthread_sigmask` through bun:ffi around the spawn | 60 |
  | Parent sets `SIG_IGN` through bun:ffi `signal()` around the spawn | 77 |
  | `/bin/sh -c "trap '' INT TERM HUP; exec sleep"` | 24 |

  Bun resets the signal mask and dispositions in the child, so inheriting SIG_IGN or a blocked mask does not work. A
  `sh`/`trap` prefix (or `nohup`, which covers only HUP) cannot help either: the shell itself is in the window until
  its `trap` runs. A race-free design would need a hand-rolled `posix_spawn` with `POSIX_SPAWN_SETSID` through FFI.
  That is not practical for a plain-JS script. Detect and retry is the right call.
- **The retry is sound.**
  - `down` ignores INT/TERM/HUP from its first statement, and it is not signalled by test-cluster once `tearingDown` is
    set (or when it is shielded, in the reaper).
  - So a death by a signal means it never ran, or it was killed by something outside (SIGKILL). Rerunning it is safe
    because `down` is idempotent.
  - The loop is bounded at 20 tries. On exhaustion it returns the killed result (code 128). The reaper then keeps the
    rig, and the teardown makes the exit code 1. It never reports success.
- **Amplified M5 shape** (8 sleep-backed stale rigs, 1 ms storm from the first "reaping" line), 20 runs: the retry ran
  19 times. **0 stale services were left.** Round 5 leaked in 8/10 runs.
- **The teardown `down` under a 1 ms storm from "tearing down"**, with a real rig, 6 runs: 6/6 exit 1 with the
  "arrived before the run finished" message. 0 leaked processes and an empty root. No retry happened in those 6 runs,
  so this path is covered by the code path shared with the reaper (`rigDown`, guarded by test-cluster.test.js:24).
- **Mutant `DOWN_TRIES = 1`:** the M5 storm test fails 7/10.

### psInfo retrying on SIGINT/TERM/HUP: can it mask a failure or loop forever?

No.
- The loop is bounded by `PS_TRIES = 5` (cluster-rig.js:99, :119).
- It breaks at once on `r.error`, which includes the ETIMEDOUT that a timeout sets (verified), and on any other
  signal, such as SIGKILL.
- After the fifth death by a terminal signal, it falls through to the `r.status === null` throw.
- The `intr` stub shows this end to end: the call refuses and the rig is left alone.
- Mutant `PS_TRIES = 1`: 5 tests in cluster-rig.test.js:58 ("psInfo: a ps killed by a terminal signal is run again")
  fail.

### The `await setTimeout(0)` yield; other synchronous spans

- **The yield works.** A SIGINT sent during 300 ms of synchronous `spawnSync` work reached its handler after one
  `setTimeout(0)` in 40/40 runs, and never before it.
- Every other point that reads `interrupted` in test-cluster.js comes after an `await` of a helper (:47–53, :71–78,
  :92), so the handler has run by then.
- Two synchronous spans are left. Neither is a defect:
  - The span after the teardown's `await rigDown` up to `process.exit` (:93–103). A signal in those microseconds is
    lost, so a green run exits 0. That is the same as a signal that arrives after the exit.
  - A signal during `writeOwnerRecord`/`mkdirSync` (:44–45) is handled right after the `up` helper is spawned. The
    handler then signals `up`, which aborts and stops what it started. An `up` killed in its own spawn window has
    started nothing, and the teardown finds no rig.json.

## Correctness dimensions

| Dimension | Status | Evidence |
|---|---|---|
| Concurrency | PASS | H1 storms: 0 live rigs reaped in 35 stormed runs. M5 amplified: 0 leaks in 20 runs. Storm tests passed 180/180 at load 9–25 |
| Error handling | PASS | Every broken-ps stub refuses (it is never read as "gone"). The owner-record write throws and writes nothing |
| Resources | PASS | No leaked services in any storm run. `down` retries are bounded |
| Boundaries | PASS | Dead pids above PID_MAX. An owner record removed mid-check: `readFileSync` throws, so the rig is left alone |
| Security | N/A | No untrusted input |

## Findings

### HIGH
None.

### MEDIUM
None.

### LOW (non-blocking notes)

- **N1. A hung ps combined with Ctrl-C.** Confidence: high (traced). Severity: low.
  - Code: cluster-rig.js:119-121.
  - A ps that hangs is timed out after 10 s and is not retried. But if the user presses Ctrl-C while it hangs, the
    Ctrl-C kills it with SIGINT, and that is retried.
  - So with a hanging /bin/ps, the reaper can take up to 5 Ctrl-Cs (or 50 s) per rig before it gives up on that rig.
    It still never reaps that rig.
  - A real /bin/ps that hangs is rare.
- **N2. A torn owner-record read can drop a live run's record.** Confidence: medium (traced, not reproduced; the window
  is microseconds). Severity: low.
  - Code: test-cluster.js:167, cluster-rig.js:150.
  - `writeFileSync` truncates the file before it writes. A concurrent reaper that reads the `.owner` in that window
    (before the run makes its dir) sees `""`. That differs from the live start time, so the reaper deletes the record.
  - The run's rig then has no record. "No record" means only a dead pid counts, so **no live rig is ever reaped**. The
    only loss is reused-pid detection for that run if it is later SIGKILLed.
  - Writing to a temp file and renaming it into place would close this.
- **N3. A ps that answers with a plausible lie is not detected.** A ps that prints a well-formed but wrong start time
  for the owner pid would make the reaper reap that rig. This is out of scope: /bin/ps does not do this, and psInfo
  only promises to refuse on a failed ps.
- **N4. Process note.**
  - One of my driver runs exited 144 (signal 16) for no reason I could find. It did not reproduce in 3 reruns, and it
    was outside the code under review.
  - That run left its own 40 live rigs and 41 `sleep 600` processes. I killed them by pid and removed the root.

## Cleanup

- **Not removed:** the scratch copy `scratchpad/rigv6-95523` (about 18 MB, no processes, no rigs) and the log dir
  `scratchpad/rigv6-95523-files`. The permission system denied `rm` of both. They need removing by hand.
- All my `yes` loops were killed by pid, and all my driver sleeps are gone.
- No `rigv6-td-*` or `root-*` dirs are left. `wt/rig/.rig` is empty.
- The worktree is unedited apart from this report.

**Verdict: PASS.** H1, M5 and L22–L24 are closed by independent experiments. Four notes are non-blocking.
