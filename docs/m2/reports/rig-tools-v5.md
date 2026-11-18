# Review: Job A round 5 — rig tools fix commit 8d0f5a1 (closes M4, L17–L21 of round 4)

Diff reviewed: `git diff ab93977..8d0f5a1`. Worktree `wt/rig`, branch `plenary/rig`, bun 1.4.4, macOS 25.2.
Load during the runs: load average 9–20 on 12 cores (other builders' runs), plus 8 `yes` loops of mine for the
M4 reruns.

## Executed results

| Run | Result |
|---|---|
| `bun run test:cluster` x3 | 3/3 exit 0: 205 pass, 0 fail, 0 skip each (67.0 s, 62.4 s, 67.9 s wall). Each run ends `down: stopped minio, nats, postgres` |
| `bun run test:fast` | 412 pass, 0 fail (4.05 s) |
| `bun test test/deploy test/architecture.test.js` x3 | 3/3: 66 pass, 0 fail. **Wall time 59 s, 58 s, 57 s** |
| `bun test test/deploy/test-cluster.test.js -t M4 --rerun-each 20`, with load | **19 pass, 1 fail** at test-cluster.test.js:275 (the builder's failure, reproduced) |

## Status of M4 and L17–L21

| Item | Status | Evidence |
|---|---|---|
| M4 reaper Ctrl-C leak | **MOSTLY CLOSED; one window left (M5)** | The reaper's `down` is shielded (test-cluster.js:118) and `interrupted` is checked after the reap (:39). The M4 test passes 19/20. The 20th failure is a different, narrower race: see M5 |
| L17 occurrences, not lines | **CLOSED** | Exact-line allowlist (gated-allow.json). Mutation in a scratch copy: appending `const __x = process.env.NATS_URL;` to an allowed `DATABASE_URL` line of test/server/main.test.js fails L6 and L12/L17. The fixture covers the appended and swapped cases |
| L18 new importer of a helper | **CLOSED** (LOW note below) | Mutation: a new `test/server/zz.test.js` with `import "./room-host-child.js"` fails L18 |
| L19 comment | **CLOSED** | Only `test/server/room-host-proc.test.js` imports room-host-child.js, and the comment at :26 now says so |
| L20 reused owner pid | **CLOSED, but the new check has a HIGH flaw (H1)** | The L20 test passes. Its `ps` call reads a failure as "owner gone" |
| L21 free pid | **NARROWED, not closed (L22)** | `freePid()` checks ESRCH, but picks from 90 000–99 899, which the pid counter passes through |

## Findings

### HIGH

**H1. A Ctrl-C during the reaper's ownership check reaps a live run's rig.**
scripts/test-cluster.js:130-139 (`startedOf`, `ownerGone`), and :42 (the owner record write).

- `startedOf` runs `/bin/ps` with `Bun.spawnSync` and returns its stdout trimmed. It never checks the exit status or the
  signal.
- That `ps` is not detached, so it is in test-cluster's process group. A terminal Ctrl-C reaches the whole foreground
  group, so it kills the `ps`.
- The killed `ps` prints nothing, so `startedOf` returns `""`. Then `ownerGone` sees `"" !== recorded` and reports a
  live owner as gone. The reaper runs `down --clean` on that live run's rig.
- RIG.md promises the opposite: "never a live run's rig". cluster-rig.js's own `psInfo` follows the rule that "a failed
  `ps` must never read as process gone" (p8-rig2v H2). The new code does not follow it.
- **Demonstrated** in scratch copy `rigv5-69498`. The test file was `liveowner.test.js`. It made 150 rigs owned by the
  live test process, each with a correct `.owner` record, and each with a `sleep` as its service. Then it ran
  test-cluster.js on that rig root:
  - No signal (control): 2/2 runs reaped 0 live rigs.
  - **One SIGINT** to the group 150 ms in: **5/6 runs reaped a live rig** and killed its service.
  - A 2 ms SIGINT storm: 3/3 runs reaped 100–115 of the 150 live rigs.
- The same flaw hits the owner record. `writeFileSync(ownerFile, startedOf(process.pid))` (:42) writes an empty record
  when its `ps` fails. A failed `ps` can be a signal, or EAGAIN when the process table is full. Any concurrent run's
  reaper then judges this live run gone, because `startedOf(pid) !== ""`.
- In practice a single Ctrl-C must land in the reap phase (a few ms per live rig) while another `test:cluster` is
  live. The damage is large: another run's services are stopped and its directory is deleted.
- **Fix:**
  - Use psInfo's rules: export `psInfo` from cluster-rig.js, or copy its checks. Exit 1 with empty stdout and stderr
    means absent. Any other failure means unknown.
  - `ownerGone` returns false on unknown: never reap on doubt.
  - The owner record write throws if `ps` fails. Do not write an empty record.
- **Test:** the liveowner shape above, cut down to about 20 sleep-backed live rigs and one SIGINT. Assert that no
  `reaping stale rig test-<livepid>-` line appears and that the sleep is alive. Each run takes under a second.

### MEDIUM

**M5. A signal that lands while a `down` helper is being spawned kills it. This is the root cause of the M4 test's
flake at :275.**
scripts/test-cluster.js:114-124 (`runRigCli`), :103 (the reaper's `down`), :88 (the teardown `down`).

- **Cause:** with bun 1.4.4 on macOS, a `detached: true` spawn is not atomic. For a short time the child is still in
  the parent's process group, before setsid. A group signal in that window kills the child before it can run any code.
  Both `node:child_process.spawn` and `Bun.spawn` do this.
  - Scratch `race.mjs`: a parent with a SIGINT handler spawns 400 detached `/bin/sleep 0.05` while a driver sends SIGINT
    to its group every 1 ms. **57/400 children died by SIGINT** with `node:child_process`, and **76/400** with
    `Bun.spawn`. The control run without signals: 0/400.
- **The chain at :275:**
  1. The test sends SIGINT when it sees `reaping stale rig`. test-cluster prints that line just before it spawns
     `down`.
  2. Under load, the signal sometimes lands in the spawn window. The `down` dies (code null, so 128). It never prints
     `[rig] down: stopping`.
  3. The reaper's `if (down.code !== 0) continue;` keeps the rig, so its services stay alive.
  4. test-cluster then exits 1 with `interrupted while reaping`, and the assertion at :275 fails.
- The failing run's output has exactly this shape. It has the reaping line and then `failed: interrupted while
  reaping`, with **no `[rig] down: stopping` line**:
  ```
  [test:cluster] reaping stale rig test-96121-aaaaaa (its test:cluster, pid 96121, is gone)
  [test:cluster] failed: interrupted while reaping
  [test:cluster] tearing down
  [test:cluster] rig kept at …/plenary-reap-Eu6vvZ/test-76333-48a658
  ```
  Reproduced 1/20 with the real M4 test under load.
- **Amplified** (scratch `m4multi.test.js`): 8 sleep-backed stale rigs and a 1 ms SIGINT storm from the first reaping
  line. **8/10 runs leaked 1–2 services.** In each leaking run, `downsStarted` was lower than `reaps` by exactly the
  number of services left alive.
- Not a race in isOurs/psInfo, in stopRig, in postgres children, or in down returning early:
  - `close` waits for `down`, because `down` inherits test-cluster's stdio.
  - `stopRig` waits on the postmaster, and a zombie reads as gone.
  - The leaked processes are the recorded services with their recorded start times.
- The same window applies to the teardown `down` (:88). A Ctrl-C storm that lands on its spawn leaks the rig's
  services until the next run reaps them. This is the M4 leak again, in a narrower window.
- **Fix:**
  - `runRigCli` also reports the exit signal.
  - Both `down` calls rerun `down` while the previous one died by a signal, up to about 5 tries. `down` ignores
    SIGINT/TERM/HUP from its first statement, so death by a signal means it never ran. `down` is idempotent: `stopRig`
    skips processes that are already gone.
  - No JS API can spawn with the signals blocked, so retrying is the cheap fix.
- **Test:** keep M4. Add the m4multi shape: 8 sleep-backed stale rigs and a 1 ms storm from the first `reaping` line.
  Assert that every sleep is dead and the root is empty. It runs in about 200 ms and fails 8/10 today. M4 could also
  use a sleep-backed stale rig instead of real services, which saves about 1 s.

### LOW

**L22. The L15/M4 "dead" pid can still be reused during the test.** test/deploy/test-cluster.test.js:211 (`freePid`).
- It picks from 90 000–99 899 and checks ESRCH once. The macOS pid counter runs up to 99 999 and wraps. The failing run
  above used pid 96121, and the counter was in that range during these runs.
- The stale rig `test-<dead>-aaaaaa` has no `.owner` record. If the pid is taken before the reaper looks, `ownerGone`
  returns false ("no record: only a dead pid counts"). The rig is not reaped, and L15 or M4 fails.
- **Fix:** write a `.owner` record with a bogus start time for each planted stale rig. Then a reused pid is still
  "gone", which is portable and needs no pid range. Or use a pid of at least 100 000 on macOS, which is never
  allocated (Linux: above `/proc/sys/kernel/pid_max`).

**L23. "rig kept at <dir>" is printed when no rig was ever made.** scripts/test-cluster.js:96. On the M4 path
(interrupted while reaping), test-cluster reports `rig kept at …/test-76333-48a658`, but that directory was never
created. Print it only when `existsSync(dir)`.

**L24. The L18 importer check matches the helper's file name as a substring** (`includes("room-host-child.js")`).
An importer that writes `./room-host-child` without the `.js` extension is not caught. A plain `bun test` still runs it
without env, so the effect is small. Match the basename without its extension.

## Correctness dimensions

| Dimension | Status | Evidence |
|---|---|---|
| Concurrency | FAIL | H1 (reaps a live run's rig on one SIGINT, 5/6) and M5 (the spawn window, 1/20 real, 8/10 amplified) |
| Error handling | FAIL | H1: `startedOf` reads a failed `ps` as a start time of `""` |
| Resources | FAIL | M5: services leak when the reaper's or the teardown's `down` dies in the spawn window |
| Boundaries | PASS | The owner-record regex, and owner files without a dir, are handled. The L20 test covers a reused pid |
| Security | N/A | No untrusted input. Rig roots come from env and from the test |

## Notes (non-blocking)

- Two runs reaping the same stale rig at once each run a `down`. The second `down` can fail on a directory the first
  one removed, so that reaper `continue`s with nothing left. Harmless.
- The suite speed is unchanged: test/deploy plus architecture takes 57–59 s. That is no slower than round 4's 58 s,
  even with three new reaper tests.
- Process note: the session scratchpad is shared with earlier review agents. My first `test:cluster` logs were written
  to `scratchpad/tc1.log`–`tc3.log` and overwrote files of those names from an earlier agent. Everything later went to
  `scratchpad/rigv5-69498-files/`, and that directory was removed at the end.

## Cleanup

Removed: the scratch copy `scratchpad/rigv5-69498` and `scratchpad/rigv5-69498-files`. My 8 `yes` loops were killed by
pid. No `plenary-reap-*` or `plenary-pass-*` dirs of mine are left. `wt/rig/.rig` is empty. No sleep or service
processes of mine are left. The worktree is unedited apart from this report.

**Verdict: FAIL.** Blockers:
- **H1:** a Ctrl-C (or EAGAIN) during the reaper's `ps` reaps a live run's rig.
- **M5:** a signal in the detached-spawn window kills a `down`. This is the root cause of the M4 flake at :275,
  reproduced 1/20 for real and 8/10 amplified.
