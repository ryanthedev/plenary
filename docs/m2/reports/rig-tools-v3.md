# Review round 3: Job A, rig and test-harness tools (fix a1f60b5; whole job against 3f90e74)

Independent post-gate review. Worktree `/Users/r/loops/plenary/wt/rig`, branch `plenary/rig`, HEAD a1f60b5. Nothing
committed. Earlier rounds: `rig-tools-v.md` (FAIL: H1, H2, L1-L7) and `rig-tools-v2.md` (FAIL: H2b, M1, L6b, L8-L11).

**Verdict: PASS. No HIGH or MEDIUM finding is left in Job A's code.** H2b, M1, L6b and L8-L11 are closed, and each was
checked by running it. There are 5 new LOWs (L12-L16), which the fix-everything rule still requires fixing. There is also
one MEDIUM outside Job A (N1): a pre-existing flaky test that made 1 of my 5 `test:cluster` runs red.

## Executed results

- `bun run test:fast`: 412 pass / 0 fail, 3.9 s.
- `bun test test/deploy test/architecture.test.js`: **60 pass / 0 fail / 0 skip, 58.3 s wall**. Round 2 had 61.3 s with
  1 skip, so the renamed fixture removed the skip without adding time.
- Timings from `test/deploy/test-cluster.test.js` (junit): the three H2b storm tests take 1.34, 1.24 and 1.31 s; H2
  takes 1.20 s; H1 services-only takes 2.15 s; the whole file takes 7.8 s. The storms add about 4 s to the 58 s
  test/deploy run. That is reasonable.
- `bun run test:cluster`, 5 sequential runs: **4 green (205/0/0, about 62 s wall each, rig dir removed) and 1 red**
  (run 1: 204/1, `test/server/nats-bus.test.js:268`, see N1). The red run kept its rig and printed the path; `down` had
  stopped all three services.
- No typecheck or lint is configured.

## Round-2 findings

| # | Status | Evidence |
|---|---|---|
| H2b group Ctrl-C during `down` | **CLOSED** | test-cluster.js:101-111 spawns every helper with `detached: true` (its own session and process group). See the storm matrix below: 32 signal runs through `bun run test:cluster`, 0 leaks, a down line in every run that reached teardown |
| M1 MinIO readiness | **CLOSED** | cluster-rig.js:496-499 waits on `/minio/health/cluster` inside `waitFor` (deadline, abort, proc check); the retry loop is gone; the PUT runs once, with its timeout clamped to the deadline (1-5 s). Stress: **48/48** `up --services-only` succeeded, run as 12 rounds of 4 at once, plus about 60 more ups in this review, with no bucket failure. The bucket is per rig, on that rig's own MinIO, and created once; 409 is accepted, so nothing can race |
| L6b guard blind spots | **CLOSED** (new LOW L12) | All four round-2 forms are caught, plus more; see the evasion table |
| L8 sleep-ordered H2 test | CLOSED | The test now reads `down`'s stderr until `[rig] down: stopping`, which is printed after the handlers are installed (cluster-rig.js:720-721); the handlers are also installed at import.meta.main (:764) |
| L9 dead `rmSync` import | CLOSED | test-cluster.js:4 imports only `existsSync, mkdirSync` |
| L10 status cosmetics | CLOSED | `minio <url> pid N alive` row (cluster-rig.js:659); the lease line is printed only when there are nodes (:665). Seen in the up output |
| L11 missing down line | CLOSED | 32/32 storm runs that reached teardown printed `down: stopped ...` |
| Fixture skip noise | CLOSED | `fixture-killed-run.js` (no `.test.js`), spawned by path at cluster-rig.test.js:343. The Leaks test still asserts that both rigs reached `node:host-1` before it kills them (:349-352), so it cannot pass without running. Passed in the deploy run |

## (1) Signal matrix (my driver: `bun run test:cluster <file>` as a detached group leader, signals sent to the group)

The driver polled the run's rig.json every 2 ms to learn each service's PID and start time. After the run exited, it
checked each one with `ps -o lstart=` (a leak means the same PID with the same start time is still alive), and listed
anything left in the old process group.

| Scenario | Runs | Exit | Leaks | Down line |
|---|---|---|---|---|
| SIGINT storm from `tearing down`, every 2, 5, 10, 15, 20, 30, 50 ms (5-50 ms twice each) | 12 | 1 | 0 | 12/12 |
| SIGTERM storm at teardown, 5 and 30 ms | 2 | 1 | 0 | 2/2 |
| SIGHUP storm at teardown, 5 and 30 ms | 2 | 1 | 0 | 2/2 |
| One SIGINT during `up` (once rig.json existed, or listed 1, 2 or 3 procs) | 8 | 1 | 0 | 8/8 ("already gone": `up` stopped its own children) |
| One SIGTERM or SIGHUP during `up` | 2 | 1 | 0 | 2/2 |
| One SIGINT during the tests (500, 2000 and 3500 ms in) | 3 | 130 | 0 | 3/3 |
| SIGINT storm every 20 ms from test start through teardown | 1 | 130 | 0 | 1/1 |
| One SIGTERM or SIGHUP during the tests | 2 | 143 / 129 | 0 | 2/2 |

`bun run` itself survived 82 SIGINTs and waited for the script, so a real terminal Ctrl-C behaves the same. Nothing was
left in any old process group. Every interrupted run kept its dir in state `down`.

**Is the storm test a real guard?** In a scratch copy I set `detached: false` in runRigCli and ran the three storm tests
three times. The **5 ms test failed 3/3**, the **20 ms test failed 2/3**, and the **50 ms test passed 3/3**. So the
guard catches a regression, but only through the 5 ms variant (L13).

## (2) MinIO

Covered in the M1 row. There is no retry anywhere on the readiness path. `createMinioBucket` makes one signed PUT; a
non-2xx status other than 409 throws, and the error names the status.

## (3) L6b guard: evasion forms against the real L6 test in a scratch copy

| Form | Result |
|---|---|
| `process.env.DATABASE_URL`, `const { NATS_URL } = process.env`, `process.env["S3_ENDPOINT"]`, `` process.env[`NATS_URL`] `` | caught |
| `Bun.env.NATS_URL`, `const {env:{DATABASE_URL:d}} = process`, `import.meta.env.DATABASE_URL` | caught |
| A gated read under `test/deploy/` or in a deeper dir (`test/e7/deep/x.test.js`) | caught |
| s3-blobs dropped from test-cluster's list | caught |
| `process.env["DATABASE" + "_URL"]` (computed key) | not caught (not checkable statically; acceptable) |
| A gated read in `*.spec.js`, `*_test.js`, `*.test.ts`, `*.test.mjs` | **not caught**, and `bun test` does run all of these suffixes (checked in an empty dir: 6 of 6 suffixes discovered). L12 |
| A `.test.js` that imports a helper which reads `DATABASE_URL` | not caught. L12 |
| `process.env.DATABASE_URL` appended to the allowlisted `test/server/main.test.js` | **not caught**: the allowlist exempts whole files. L12 |

**Is the 6-file allowlist justified?** Each file was checked:
- `test/admin/devadmin.test.js`: names `DATABASE_URL` only in comments and as an explicit argument (`{ DATABASE_URL: secret }`, :171), to prove the tool ignores process.env. It needs no services. Justified.
- `test/auth/google-live-server.test.js`: one comment (:54). Its process.env reads are only GOOGLE_* and COOKIE_KEY. Justified.
- `test/server/main.test.js`: literal unreachable URLs (`PG`, `NATS` at :321, port 1) used to assert refusals. It needs no services. Justified.
- `test/server/p4-wire2.test.js`: the same, with literal `PG` (:22) and port-1 NATS URLs. Justified.
- `test/deploy/cluster-rig.test.js`: starts its own rigs and asserts env contents. It must not run on test:cluster's rig. Justified.
- `test/deploy/test-cluster.test.js`: the guard itself. Justified.

Helpers that read the env (`test/server/room-host-child.js`, `test/deploy/stub-node.js`) are fine today: their callers
are listed or rig-owned.

## (4) Runs

See Executed results. test:fast and the deploy+architecture run have 0 skips. test:cluster was 4/5 green; the red run
is N1.

## (5) Storm tests

They are deterministic in ordering: the storm starts on the `[test:cluster] tearing down` line, not on a timer. They are
fast: about 1.3 s each, with a one-line pass file instead of the 8 gated files. A small theoretical risk: in the 50 ms
variant, if `down` and exit finished in under 50 ms, no signal would land, and `expect(code).not.toBe(0)` would fail
spuriously. On this machine, teardown took 100-200 ms and 3-4 signals landed every time, so that did not happen.
See L13 for the variants' value.

## (6) Behaviour change: a signal after the tests passed means exit 1

In my runs, a signal that arrived during teardown of a green run gave exit 1 (test-cluster.js:68, :93). That is the
right call, because an interrupted run should not report green. But `down --clean` was already chosen (code was 0 when
it started), so the dir is removed, no `rig kept` line prints, and nothing says why the exit is 1. The run's last lines
are `rig ... down: stopped minio, nats, postgres` and then bun's `script "test:cluster" exited with code 1`. RIG.md does
not mention this either. L14.

## (7) SIGKILL of test-cluster itself

- **SIGKILL to the group during `up`:** the detached `up` helper **outlived the kill and finished**. The rig ended in
  state `up` with postgres, nats and minio alive, and no parent. This is new with a1f60b5: before it, the helper shared
  the group and died with it partway through. Either way, services were orphaned.
- **SIGKILL to the group during the tests:** all three services were orphaned. That is unavoidable: SIGKILL cannot be
  caught, and the services were detached by design before this job.
- **Recovery works:** `bun run rig ls` listed both orphaned rigs (`test-<pid>-<hash> 3 process(es) <dir>`), and
  `rig down --name <it> --clean` stopped and removed each one.
- **Severity: LOW** (L15). The leak needs an uncatchable kill, and the documented tools recover it. Gaps:
  - RIG.md's test:cluster paragraph does not say what to do after a killed run.
  - Nothing reaps a dead run's rig automatically. The rig name carries the owner's PID (`test-<pid>-…`), so test:cluster
    could reap stale `test-*` rigs whose owner is gone at startup.
  - The `up` helper could abort when its parent dies, through a stdin pipe that closes on parent death.

## Findings

### LOW (Job A; to fix under the fix-everything rule)

- **L12. The gated-file guard misses three cases.** test/deploy/test-cluster.test.js:25-28.
  - It filters on `.endsWith(".test.js")`, but bun also runs `*.spec.*`, `*_test.*`, `*_spec.*` and `.ts/.mjs/.jsx`
    tests. A gated read in any of them passes the guard (demonstrated).
  - It exempts whole allowlisted files, so a real `process.env.DATABASE_URL` added to `main.test.js` passes
    (demonstrated).
  - A test that reaches the env through an imported helper passes (demonstrated).
  - None of these exists today, so this is latent. Fixes:
    - Match bun's discovery patterns.
    - Still reject `process.env`/`Bun.env` reads of the gated names inside allowlisted files.
    - Optionally, scan non-test helpers under `test/` and require an importer to be listed.
  - The commit message's claim "catches every env form" overstates what the guard does.
- **L13. Of the three storm variants, only the 5 ms one reliably catches the regression** it guards.
  - Evidence: with `detached: false`, 5 ms failed 3/3, 20 ms failed 2/3 and 50 ms failed 0/3
    (test-cluster.test.js:84).
  - The 50 ms test spends 1.3 s and proves nothing that the 5 ms test does not.
  - Fix: drop 20 and 50, or replace them with a SIGTERM and a SIGHUP storm at 5 ms. Those signals are not covered at
    group level by any test today; my matrix shows they work.
- **L14. An interrupted green run exits 1 with no reason printed** (test-cluster.js:93; dir already removed by
  `--clean`). Print something like `[test:cluster] interrupted (SIGINT): exit 1`, and document it in RIG.md next to
  "Green runs remove the rig directory".
- **L15. SIGKILL recovery is not documented, and the detached `up` now finishes a rig nobody owns** (test-cluster.js:103;
  RIG.md:82-86). Add a RIG.md line: after a killed `test:cluster`, run `rig ls`, then `rig down --name <it> --clean`.
  Consider reaping `test-<deadpid>-*` rigs at startup, or a parent-death abort in `up` (see (7)).
- **L16. Helper output is buffered, then replayed stdout first and stderr second** (test-cluster.js:83-84, :36-37).
  - The log reads `rig X down: stopped ...` *before* `[rig] down: stopping (...)`.
  - During `up`, nothing is shown until it finishes, which can take up to the 90 s timeout. With `detached: true` the
    helper's stdio is still piped, so inheriting is possible:
    - give the helper `stdio: ["ignore", "inherit", "inherit"]` for `up` and `down`;
    - keep `pipe` only for `env`, whose stdout is parsed;
    - the storm test reads test-cluster's own output, so it would still see the lines.

### N1. MEDIUM, outside Job A (for the coordinator): `test/server/nats-bus.test.js:268` is flaky

- **Failure:** "nats stall: a frozen server (SIGSTOP) …" failed in test:cluster run 1 (`expect(replayed)
  .toBeLessThanOrEqual(2)`, received 3).
- **Cause:** the test bounds how many 1 MB messages were already in the frozen server's kernel receive buffer. That
  number depends on socket buffer sizes and timing, not on our code.
- **Rate:** 1 of 5 full test:cluster runs. It did not fail in 15 runs alone (`-t "nats stall"`), 8 runs through
  `test:cluster test/server/nats-bus.test.js`, or 9 more under 4-rig parallel load. So it is rare, and it shows up in
  the full 8-file run.
- **Ownership:** the file is untouched since bbdae0e and not part of Job A. The test starts its own nats-server and does
  not use the rig.
- **Impact:** it makes `bun run test:cluster` non-deterministic, which breaks the no-flaky-tests rule.
- **Fix it in its own job:** the "nothing replays" property needs a bound that does not depend on the kernel buffer.
  One option is to assert that nothing beyond what the server had already read arrives, measured through the server's
  `in_msgs` monitoring counter.

### Concurrent load from a neighbour during the red run

- **The rig:** `wt/rig/.rig/e1-40434`, created 18:48:19Z, during my run 1. Its postgres, nats and minio are still live,
  and it owns the one SysV segment now in `ipcs -m` (NATTCH 6, creator pid 40452 = its postmaster).
- **Not from the code under review:** test-cluster names rigs `test-<pid>-<hash>`, the deploy tests use mkdtemp
  `plenary-rig-*` dirs, and nothing in `scripts/` or `test/` uses an `e1-` prefix. Someone else ran `rig up --name e1-…`
  in this worktree.
- **Action:** I left it alone. Its owner should stop it.

## Correctness dimensions

| Dimension | Status | Evidence |
|---|---|---|
| Concurrency | PASS | Unique rig names per run; the helpers' process groups are isolated; 48 parallel ups were clean |
| Error handling | PASS | `down` ignores signals from its first statement; helper exit by signal gives code 128 and is treated as failure; the bucket PUT fails loudly on any non-409 error |
| Resources | PASS | 0 leaks in 32 signal runs; SIGKILL orphans are recoverable (L15) |
| Boundaries | PASS | `deadline - now` is clamped to 1-5 s for the PUT; explicit file arguments resolve against ROOT |
| Security | PASS | Unchanged since round 2: per-rig MinIO keys, rig.json 0600, secret only through `env` |

## Clean-up

- **Rigs:** every rig I created was stopped and removed: all `test-*` rigs from the matrix, the SIGKILL runs and the
  test:cluster runs, plus `rv3p-1-1` … `rv3p-12-4`. The early batch of kept, already-down `test-3*` dirs was removed
  with `rig down --all --clean`, at a moment when `.rig` held only my dirs. After that I used `--name` only.
- **Processes and temp dirs:** no `wt/rig` process of mine is running, and no `plenary-storm-*` or `plenary-guard-*`
  temp dir is left.
- **What remains in `wt/rig`:** `.rig/` holds only the neighbour's `e1-40434`, and `git status` shows only this report.
- **Not removed:** my scratch copies `mut/` and `g6/` and the probe dir `disc/` under the session scratchpad. The
  permission system denied a recursive delete. They hold no running processes.
- **Not mine, left alone:** other agents' files and processes in the same scratchpad (`mut2.py`, `full3.sh`,
  `three.sh` …).

**Verdict: PASS.** H2b, M1 and the round-2 LOWs are closed and were verified by execution. Fix L12-L16 before landing,
under the fix-everything rule. Give N1 (the nats-bus stall flake) its own owner, since it makes `test:cluster`
non-deterministic.
