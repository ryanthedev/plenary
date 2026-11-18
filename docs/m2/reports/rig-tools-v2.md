# Review round 2: Job A, rig and test-harness tools (fix d712e1e; whole job against 3f90e74)

Independent post-gate review. Worktree `/Users/r/loops/plenary/wt/rig`, branch `plenary/rig`. Nothing committed.
Round 1: `docs/m2/reports/rig-tools-v.md` (c29dbc3, FAIL: H1, H2, L1–L7).

**Verdict: FAIL.** H1 is closed. **H2 is not closed:** a terminal Ctrl-C during `down` still leaks services, through a
path the fix did not cover (the `down` helper's own `/bin/ps` children). One MEDIUM: the MinIO bucket retry is a blind
retry over a wrong readiness probe, and I found the real cause.

## Executed results

- `bun run test:cluster`, 3 sequential runs: **205 pass / 0 fail / 0 skip each**, 8 files, 61.0 s in bun (62–63 s wall),
  exit 0. Rig dir removed each time, no rig processes left, `ipcs -m` empty. `main-cluster.test.js` is green.
- `bun run test:fast`: 412 pass / 0 fail, 3.98 s.
- `bun test test/deploy test/architecture.test.js`: 56 pass / 1 skip / 0 fail (61.3 s). The skip is explained below.
- `bun test` (full): 1567 pass / 155 skip / **1 fail**, 266 s. The fail is `test/server/tune.test.js:190`
  ("here: bounded with many viewers", expected `writerCount` 5, got 4). This job does not touch that file or the server.
  Run alone 6 times, it failed 1/6, so it is a pre-existing flaky test outside Job A (see N1).
- No typecheck or lint script is configured (package.json has only test scripts).

## Round-1 findings

| # | Status | Evidence |
|---|---|---|
| H1 services-only rig | **CLOSED** | `startRig` `servicesOnly` (cluster-rig.js:405-407, early return :532); test-cluster.js:33 `--services-only`; status prints `lb - not started`, procs = postgres, nats, minio; test:cluster 3/3 fully green including main-cluster |
| H2 SIGINT during teardown | **NOT CLOSED** | See **H2b** below. The forwarded-signal path is fixed, but a process-group Ctrl-C still leaks |
| L1 MinIO keys | CLOSED | Random per rig (cluster-rig.js:487); rig.json `-rw-------` (checked with `stat`); `up`/`status`/`status --json` omit the secret, `env` prints it; the secret appears in no rig log file (grep of `logs/`); the test:cluster log shows `S3 secret (not printed; run env)` |
| L4 did-you-mean | CLOSED | `status`, `env`, `kill gw-1` with `--name nope` all exit 1 with a hint. Round-1 case run: stopped rig `rv2-dead` (sorts first) plus live `rv2-live` → `did you mean --name rv2-live?`; with both stopped → `no rig named nope` and no suggestion (cluster-rig.js:677) |
| L5 install hints | CLOSED | `INSTALL_HINT` (cluster-rig.js:67) says PGDG for postgresql-17 and no apt package for minio; cluster-rig.test.js:19 lists minio |
| L6 gated-file guard | CLOSED, with LOW L6b | test-cluster.test.js:22. In a scratch copy, a fake `test/server/fake-gated.test.js` that reads `process.env.NATS_URL` **makes the guard fail** (it names the file). See L6b for the forms it misses |
| L7 double rm | CLOSED | the `rmSync` after `down --clean` is gone (test-cluster.js:88) |

## Whole job against 3f90e74 (done-when from round 1)

| # | Item | Verdict | This round's evidence |
|---|---|---|---|
| 1 | minio stand-in, bucket, blobs in rig.json, S3_* env, stops on down | PASS (M1) | s3-blobs ran with 0 skips in 3/3 test:cluster runs; `down` lists minio. The bucket wait is M1 |
| 2 | ls, down --all/--clean, did-you-mean, gc safety | PASS | `ls` and the did-you-mean probes above; gc unchanged since round 1 |
| 3 | postgresql@17 paths, install hint | PASS | INSTALL_HINT (cluster-rig.js:67) |
| 4 | test-cluster: unique name, all gated files, teardown on finally and signals, rm on green, keep on red, exit code, loud on skip | **FAIL** | H2b. Everything else holds: 3/3 green with the dir removed; red runs keep and print it; exit 130/137 passed through |
| 5 | package.json scripts | PASS | test:fast 412/0 in 3.98 s; test:cluster as above |
| 6 | RIG.md | PASS (note) | Documents `--services-only` and why. Its line "SIGINT, SIGTERM and SIGHUP stop the child test and services" is not true under H2b until that is fixed |

## Findings

### HIGH

**H2b. A Ctrl-C during `down` still leaks Postgres, NATS and MinIO, because the signal kills `down`'s `/bin/ps` child.**
- **Where:** scripts/test-cluster.js:94 spawns the helpers in test-cluster's process group (not detached).
  cluster-rig.js:721 makes `down` ignore SIGINT, SIGTERM and SIGHUP, but `down` calls `/bin/ps` through `spawnSync`
  (psInfo, cluster-rig.js:110-116), and that `ps` is in the same foreground group.
- **What happens:** a terminal Ctrl-C reaches the whole group, so it also kills `ps`. psInfo then throws
  `cannot check processes: /bin/ps was killed by SIGINT; refusing to guess…`, and `down` exits 1 partway through.
  test-cluster prints "rig kept" and exits.
- **Demonstrated:** a driver spawned `test-cluster.js` as its own process group, waited for the `bun test` child, and
  sent SIGINT to the group every N ms until it exited.
  - At held-key cadence (N = 5, 30–50 ms), **6 of 14 runs leaked** in `wt/rig`: 2 leaked all three services, 4 leaked
    postgres or postgres plus nats (counts 3, 1, 1, 1, 2, 3). Each leaked rig stayed in `state: up`, and `rig ls` listed
    them live afterwards.
  - In an instrumented scratch copy, **6 of 9 runs leaked**. The copy logged the helper's exit:
    `down exit=1 signal=null t=23–101ms err="[rig] cannot check processes: /bin/ps was killed by SIGINT; refusing to
    guess whether this rig's processes are alive"`. Every leaking run had `down exit=1`; every `exit=0` run was clean.
  - In the 2-Ctrl-C runs (one during the tests, one during `down`), **one Ctrl-C landing during `down` was enough** to
    leak. This is the round-1 H2 condition.
  - At human double-tap cadence (N = 150–300 ms, 6 runs), nothing leaked. The services-only `down` takes about
    100–200 ms, so it usually finishes before a second tap. So the window is the roughly 100–200 ms that `down` runs:
    narrow, but a Ctrl-C that lands in it still leaks, and a held or fast-repeated Ctrl-C hits it about half the time.
  - My earlier scenarios A and B (3 runs: a double Ctrl-C and a single Ctrl-C after a red run, each sent once `ps`
    showed the `down` helper) did not leak. Finding the helper through `ps` took longer than the `down` run's `ps`
    calls, so those signals arrived too late to hit them.
- **Why the guard test misses it:** test-cluster.test.js:57 signals only the `down` PID, never the group, so `ps`
  is never hit. Sent straight to `down`'s PID after its handlers are installed, SIGINT storms do nothing: 5/5 runs
  exited 0 with nothing left. So the handler itself works; the hole is its children.
- **The window the builder named also matters, as a second cause:** before `down` installs its handlers, a SIGINT kills
  it outright. That window was 10–12 ms on an idle machine (8/8 deaths at ≤10 ms, mixed at 12 ms, none at ≥14 ms), and
  it grows under load. On its own that would be LOW, but the fix below closes both causes.
- **Fix:** start the `down` helper (simplest: every rig helper) in its own process group or session, as `launch()` does
  for the services (`detached: true` there is node's `child_process.spawn`; test-cluster uses `Bun.spawn`, so use
  `node:child_process` or `setsid`), so that a terminal Ctrl-C reaches only test-cluster.js, which already declines to forward signals during
  teardown. Then extend the H2 guard to signal the **process group** of a running `test-cluster.js` (or of a `down`
  spawned the way test-cluster spawns it), not just the `down` PID.

### MEDIUM

**M1. The MinIO bucket retry is a blind retry over a wrong readiness probe (cluster-rig.js:496-501).** The cause is
known and fixable.
- **Root cause, demonstrated** with MinIO RELEASE.2025-09-06: `/minio/health/ready` returns 200 **before the object
  layer is initialized**, while `/minio/health/cluster` still returns 503 with `x-minio-server-status: offline` (or
  `bucket-metadata-offline`).
  - Polling `ready` every 2 ms, a signed `PUT /plenary` sent right after it turned 200 failed **8/8** with
    `503 XMinioServerNotInitialized`.
  - Polling `cluster` instead, the same PUT succeeded **8/8**.
  - The gap is about 6 ms on an idle machine. With the rig's 100 ms poll, the PUT only lands in the gap when load
    widens it, which explains "intermittent under load".
- **Why it is blind:** the loop (:498-501) retries every error the same way, including deterministic 403 or 400
  responses. It checks neither `deadline` nor whether minio died, and it stops after a fixed 5 × 300 ms. With the 5 s
  fetch timeout it can also run up to about 26 s past the rig's deadline. If initialization takes longer than about
  1.2 s under load, the flake comes back. Under the standing rule (a flaky test is a bug to fix, not to retry past),
  this does not qualify.
- **Fix:** wait for real readiness inside `waitFor`, under the rig deadline and the abort, with the proc check. Either:
  - poll `/minio/health/cluster` instead of `/minio/health/ready` (verified above, on this MinIO version); or
  - make the bucket PUT itself the probe, treating only a 503 or a connection error as "not ready yet" and failing at
    once on anything else.

  Fix the comment at :497 as well: the cause is the ready probe, not load.

### LOW

- **L6b. The gated-file guard has blind spots** (test-cluster.test.js:25-26). A scratch file that reads
  `const { DATABASE_URL } = process.env`, `process.env["DATABASE_URL"]` or only `process.env.S3_BUCKET` **passed** the
  guard, and so did a gated file under `test/deploy/`, because that directory is excluded. None of the 8 real files uses
  these forms (s3-blobs uses `const E = process.env` plus `E.S3_ENDPOINT`, and the bare `\bS3_ENDPOINT\b` alternative
  catches that), so the gap is latent. A sturdier guard matches the bare names `DATABASE_URL|NATS_URL|S3_ENDPOINT`
  anywhere in the file, minus a short allowlist of the known literal-URL files.
- **L8. The H2 guard test relies on a sleep for ordering** (test-cluster.test.js:61, `Bun.sleep(300)` "let the CLI start
  and install its handlers"). If startup ever takes more than 300 ms (a loaded CI box), a SIGINT lands before the
  handlers are installed and the test fails spuriously. Also, a services-only `down` often finishes in 140–200 ms (from
  the instrumented log), so the signals may arrive after it has exited and prove nothing. Once the helper is detached
  (H2b), drive this test with a readiness signal instead of a fixed sleep.
- **L9. Dead import:** `rmSync` is now unused in scripts/test-cluster.js:3.
- **L10. Cosmetic:** a services-only rig's `status` still prints `lease PLENARY_LEASE_TTL_MS=10000 on every node`
  although it has no nodes, and it has no minio pid row (postgres and nats have one).
- **L11.** In the first, uninstrumented storm runs, a few runs printed no `down` line yet showed no leak. In the
  instrumented runs, every run with no `down` line had `down exit=1`. So this is most likely H2b again: `ps` was killed
  after the last stop. Same fix.

### Not a defect: the 1 skip in `bun test test/deploy test/architecture.test.js`

It is `test/deploy/fixture-killed-run.test.js:10` (`test.skipIf(!A || !B)`). The file is a fixture that the
"killed midway" leak test (cluster-rig.test.js:343) spawns with `RIG_FIXTURE_DIR_A/B` set. It skips by design in every
direct run (documented in docs/m2/reports/p8-rig3.md:35). It should skip. Renaming it so that a directory run does not
pick it up (no `.test.js` suffix, spawned by explicit path) would remove the standing "1 skip" noise; optional.

### N1 (outside Job A, for the coordinator)

`test/server/tune.test.js:179-190` is flaky: it failed 1 of 7 runs (once in the full suite, 1/6 alone). The
`writerCount` was 4 where 5 was expected, right after a `here` with `writerCount === 5` was awaited. That suggests
`lastList` picks a different message than the awaited one. Not touched by this job; it needs its own owner under the
no-flaky-tests rule.

## Correctness dimensions

| Dimension | Status | Evidence |
|---|---|---|
| Concurrency | PASS | H1 closed: there are no rig nodes on the shared NATS; test:cluster 3/3 green |
| Error handling | FAIL | H2b: `down` aborts when its `ps` child is killed by the group SIGINT; M1: the retry treats every error the same |
| Resources | FAIL | H2b: postgres, nats and minio leak (6/11 storm runs) |
| Boundaries | PASS | Guard and arg parsing probed; nothing new found |
| Security | PASS | L1 closed: per-rig random keys, rig.json and logs 0600, secret only via `env` |

## Clean-up

Every rig I created was stopped and removed: all `test-*` rigs from my test:cluster and storm runs in `wt/rig/.rig`
(including the three kept from scenarios A and B), `rv2-92536`, `rv2-dead`, `rv2-live`, the `rv2s-*` rigs, and the
9 rigs in the scratch copy. `.rig/` is empty, no `wt/rig` or scratch postgres, nats or minio is running, `ipcs -m` has
no rows (the same as the baseline), and the MinIO probe processes exited. No orphaned `server/main.js` from the
SIGKILLed test runs exists under `wt/rig` or my copy. `git status` in `wt/rig` shows only this report.

One process I did **not** start was left alone: pid 6108, `bun …/scratchpad/mut/server/main.js` (ppid 1, started
11:59:27, before this review began). It lives in a `mut/` folder of the same session scratchpad, probably from an
earlier agent's mutation run. The coordinator may want to stop it.

**Verdict: FAIL.** Two blockers:
1. **H2b** (scripts/test-cluster.js:94: the helpers share the terminal's process group; cluster-rig.js:110-116 and
   :721): a Ctrl-C landing during `down` kills its `ps` child, so `down` exits halfway and the services leak.
2. **M1** (cluster-rig.js:496-501): a blind retry instead of a readiness-correct wait, which the dispatch rules out.
   Probe `/minio/health/cluster`, or make the bucket PUT the probe (503 or a connection error means "not ready", under
   the deadline), and drop the retry.

H1, L1, L4, L5, L6 and L7 are closed.
