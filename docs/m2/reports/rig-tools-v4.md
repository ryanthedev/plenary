# Review: Job A round 4 — rig tools fix commit ab93977 (closes L12–L16 of round 3)

Reviewed `git diff a1f60b5..ab93977` in wt/rig (branch plenary/rig). I ran everything myself. I did every
destructive experiment in a scratch copy (its own ROOT and `.rig/`) and killed only pids whose command line named
that copy. `.rig/e1-40434` (another builder's rig) was never touched. At the end, `.rig/` holds only `e1-40434`, and
`git status` shows only this report.

## Executed results

| Command | Result |
|---|---|
| `bun run test:cluster` x3 | 3/3 exit 0. 205 pass, 0 fail, 0 skip each time (62.2 s / 64.8 s / 63.9 s of tests; 63.8 / 66.3 / 65.3 s wall). No nats-bus.test.js:268 flake in these 3 runs |
| `bun run test:fast` | 412 pass, 0 fail, 26 files, 5.9 s |
| `bun test test/deploy test/architecture.test.js` | 63 pass, 0 fail, 69.0 s |
| `bun test test/architecture.test.js` | 16 pass |
| L15 tests, `--rerun-each 5` | 10/10 pass (33 s) |
| Storm tests, `--rerun-each 4` | 12/12 pass |

## Status of L12–L16

| Item | Status | Evidence |
|---|---|---|
| L12 guard: new suffixes | **CLOSED** | The fixture covers `.spec`, `_test`, `_spec`, ts/mjs/cjs/tsx. Checked against the real scan |
| L12 guard: a new line in an allowlisted file | **CLOSED** | Scratch: appending `const __z = process.env.DATABASE_URL;` to `test/server/main.test.js` fails L6 and L12 |
| L12 guard: helper reads | **PARTLY CLOSED** (L17, L18) | A new helper that reads the env is caught. A new importer of an existing allowlisted helper is not. A second read on an existing line, or a read swapped in for a deleted mention, is not |
| L13 storms at 5 ms | **CLOSED** | Scratch with `detached: false`: SIGINT/SIGTERM/SIGHUP x3 each = **9/9 fail** (at the `down: stopped` assertion). Real code: 12/12 pass |
| L14 exit-1 line | **CLOSED** | The storm tests assert the line for every signal. A mid-run SIGINT (`slow.test.js`, scratch) exits 130 with no "tests passed" line and keeps the rig dir (`rig kept at …`, state `down`). That is correct |
| L15 `--watch-parent` | **CLOSED** | Scratch: SIGKILL of test-cluster's group 100 ms into `up` → `[rig] failed: aborted while waiting for postgres; stopping what started`, 0 services alive |
| L15 reaper | **CLOSED, with L19 and L20** | Scratch: SIGKILL during tests leaves 3 services; the next run reaps them (`down: stopped minio, nats, postgres`), 0 left. Never reaped: the e1 rig, a live run's rig, or a stale rig whose owner pid is reused (L20). With a stale `rig.json` whose service pid is reused by a live `sleep 600`, the reaper's `down` reported "already gone" and the sleep survived |
| L16 live helper output | **CLOSED** | Timestamped run: `[rig]` steps arrive at 69, 1132, 1314, 1436, 1975 ms, live and in order. A pty run (`script -q /dev/null …`) whose pty was SIGKILLed mid-test (terminal closes: SIGHUP plus EIO on the inherited fd) still stopped all 3 services, state `down`, and test-cluster exited |

## Findings

### MEDIUM

**M4. A Ctrl-C while the reaper is running leaks the stale rig's services, then starts a full rig anyway.**
scripts/test-cluster.js:30, :35, :127-136.
- `reapStaleRigs()` runs `down` through `runRigCli`, which sets `helper`. `tearingDown` is still false, so `signal()`
  forwards the SIGINT to that `down` (line 30). The comment on that line says the opposite: "never signal the `down`
  helper".
- A SIGINT that arrives before `down` installs its ignore handlers kills it. The stale services keep running.
- Nothing checks `interrupted` after `await reapStaleRigs()`, so the run then does a full `up` (~1.7 s) and only
  then aborts (`failed: interrupted while starting cluster`).
- **Demonstrated** in scratch: a stale rig with live services and a dead owner, plus SIGINT to the group 5 ms after
  `reaping stale rig …`. **3/3 runs left all 3 services alive** (`ps` count 3 each time), and each run started and
  tore down a rig of its own first. The next uninterrupted run reaped them, so the leak heals itself. It is still
  the very leak this job exists to prevent, in new code.
- **Fix** (about 3 lines):
  - Never forward signals to a reaper `down`, for example `runRigCli(..., { live: true, cwd: ROOT, shielded: true })`
    with `signal()` skipping a shielded helper, or set `tearingDown`-like state around the reap.
  - Add `if (interrupted) throw new Error("interrupted while reaping")` right after `await reapStaleRigs()`.
- **Test:** plant a stale rig with live services and SIGINT the group on the `reaping stale rig` line. Assert that its
  pids are dead and that no `[rig] postgres: initdb` line follows.

### LOW

**L17. The guard counts lines, not occurrences, so a second read on an existing line passes.**
test/deploy/test-cluster.test.js:35 (`namingLines`). The comment at :26 says "the allowance is per occurrence".
- Scratch: appending `; const __x = process.env.DATABASE_URL;` to an existing `DATABASE_URL` line of
  `test/server/main.test.js` passes L6 and L12.
- So does deleting one naming line and appending a read elsewhere (count unchanged).
- **Fix:** count matches, not lines (`(src.match(/\b(DATABASE_URL|NATS_URL|S3_[A-Z0-9_]+)\b/g) ?? []).length`), and
  update the ALLOW numbers. That closes the same-line case. The swap case needs an allowlist of the exact allowed
  lines instead of counts. That is also cheap, and makes the allowance truly per occurrence.

**L18. A new importer of an existing allowlisted helper is not caught.**
test/deploy/test-cluster.test.js:27-31, :38-42.
- Scratch: a new `test/server/evade-a.test.js` that spawns `./room-host-child.js` and never names a gated variable
  passes L6 and L12. Re-exporting the helper through a second helper also passes.
- **Does it matter?** Little. Such an importer cannot skip without env, so under plain `bun test` / `test:fast` the
  helper crashes (`postgresStore({ url: undefined })`) and the test fails loudly. The gap is mostly self-revealing.
- **Fix:** cheap, and verified in scratch. The test below passes on the real tree and fails with evasion A
  (`+ "test/server/evade-a.test.js"`):
  ```js
  test("every file that names an allowlisted helper is itself listed or allowlisted", () => {
    const listed = [...SCRIPT.matchAll(/"(test\/[\w./-]+)"/g)].map(m => m[1]);
    const files = walk(join(ROOT, "test")).filter(f => CODE_FILE.test(f)).map(f => relative(ROOT, f));
    const helpers = Object.keys(ALLOW).filter(f => !TEST_FILE.test(f)).map(h => h.split("/").pop());
    const orphans = files.filter(f => !listed.includes(f) && !(f in ALLOW) && helpers.some(h => readFileSync(join(ROOT, f), "utf8").includes(h)));
    expect(orphans).toEqual([]);
  });
  ```
  It does not follow re-export chains. Recursing over helpers would add about 3 lines.

**L19. ALLOW comment is wrong.** test/deploy/test-cluster.test.js:29 says `room-host-child.js` is a "helper of
room-host-lease and room-host-proc". Only `room-host-proc.test.js:14` references it (grep over `test/`).

**L20. A stale rig whose owner pid now belongs to an unrelated live process is never reaped.**
scripts/test-cluster.js:132; RIG.md:92.
- Scratch: `test-<pid of a live sleep 600>-dddddd` with 3 running services. A test:cluster run skipped it, and all 3
  services kept running until the sleep died; the next run then reaped it.
- This is safe, since it never reaps a live rig. But the leak lasts as long as the pid is reused, and RIG.md says only
  "whose pid is dead".
- **Fix** (cheap): write the owner's `lstart` into the rig dir (or the name hash) at start, and reap when the pid's
  current `lstart` differs. Alternatively, document the limit.
- The reverse direction (a service pid reused by an unrelated live process) is safe: the start-time check held.

**L21. Small flake window in the L15 reaper test.** test/deploy/test-cluster.test.js:182. `dead` is the pid of an
exited `/usr/bin/true`. If the OS reuses that pid within the test's ~3 s, the reaper skips the rig and the test fails.
Another `bun run test:cluster` in the same worktree (other builders share it) would also reap the planted
`test-<dead>-aaaaaa` first. The `reaping stale rig` assertion then fails, even though the rig is gone.
- 10/10 passes here, so the risk is low.
- **Fix:** use a pid known to be free (pick one above `kern.maxproc`, or loop until `kill(pid,0)` throws ESRCH just
  before planting). Or plant the dirs in a temp ROOT by letting test-cluster take the `.rig` root from an env/arg
  used only by tests.

## Speed (test/deploy 58 s → 83 s claim)

I could not reproduce 83 s. Serially and unloaded, `bun test test/deploy test/architecture.test.js` takes **69.0 s**.
By file:

| File | Alone |
|---|---|
| cluster-rig.test.js | 50.5 s (not changed by ab93977) |
| test-cluster.test.js | 13.0 s (8.5 s at a1f60b5, same machine) |
| architecture.test.js | 0.03 s |

What ab93977 adds is +4.5 s, all in test-cluster.test.js:
- L15 reap: 3.64 s
- L15 watch-parent: 0.62 s
- 3 storms of 1.35 s each replace 3 storms of 1.36–1.54 s, so they are about even

The 83 s figure was likely measured under load, for example beside the live e1 rig or a concurrent test:cluster.

Slowest tests, and concrete cuts that keep every assertion:
1. **cluster-rig "up: a part that never becomes healthy …" (8.19 s)**, cluster-rig.test.js:231, `timeoutMs: 8000`.
   Services are up in ~2 s here, so `timeoutMs: 5000` keeps over 2x headroom and **saves ~3 s**. This test predates
   this commit.
2. **L15 reap (3.64 s)** starts 4 real service sets: stale, live and other in parallel, plus test-cluster's own.
   Only `stale` needs real services. `live` and `other` only need to prove the reaper left them alone. They can be dirs
   whose `rig.json` records a `sleep 300` started by the test, with its real `lstart`. Assert that the dir and
   `rig.json` are unchanged (byte-equal) and that the sleep is alive. This saves 2 of 4 Postgres initdb+start cycles
   (CPU, and ~0.5–1 s wall) without weakening the check.
3. Storms (1.35 s each) and H1 (2.4 s) are at the floor: one real test-cluster run or rig each.

## Correctness dimensions

| Dimension | Status | Evidence |
|---|---|---|
| Concurrency | FAIL (M4) | Signal during the reaper's `down` |
| Error handling | PASS | `up` abort path, `down` failure keeps the dir, missing rig.json → rm only |
| Resources | FAIL (M4) | Leaked services after Ctrl-C during the reap; otherwise 0 leaks across 9 storm, 3 SIGKILL and 1 pty runs |
| Boundaries | PASS (L20 noted) | Reaper regex `^test-(\d+)-[0-9a-f]+$` never matches `e1-40434` or other names |
| Security | N/A | Local dev tooling, no untrusted input |

## Notes (non-blocking)

- A rig the user names by hand to match `test-<digits>-<hex>` with a dead number would be reaped. This is unlikely,
  and RIG.md documents the name pattern.
- The reaper keeps reaping the remaining stale rigs after a signal. With M4 fixed, that is fine (shielded `down`s).
- `up --watch-parent` stops watching once `up` returns. A SIGKILL during the tests is recovered only by the next run.
  RIG.md documents this.

**Verdict: FAIL.** One MEDIUM blocker: M4, a demonstrated leak of the reaped rig's services on Ctrl-C during reaping
(3/3). It is self-healing, but it is new code that breaks its own "never signal the `down` helper" invariant. Five
LOWs (L17–L21) are cheap to fix. Everything else from round 3 (L12 suffix and new-line cases, L13, L14, L15, L16) is
closed and verified by execution.
