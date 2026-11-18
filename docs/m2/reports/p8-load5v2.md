# Report: p8-load5v2 (round-2 review of p8-load5 + Job C)

**Verdict: FAIL, on 1 MEDIUM and 5 LOWs. The MEDIUM and LOWs 2-4 were demonstrated by probes; LOWs 5-6 come from reading the code.** The round-1 MEDIUM is fixed: test/load leaves
nothing, and a leak fails the file. LOW 1, LOW 2, the CPU tests, the late-join rule and almost all of Job C hold, and
the mutants I ran are killed. But the new rejoin grace lets a long outage read VALID. Two cleanup paths still leave
dirs: a stop signal during the `--local` server's startup, and SIGKILL of `run.js --local` without `--out`.

Reviewed: `plenary/load5` at `c2f2465`, diff `383f593..c2f2465` (whole job vs `3f90e74`). Probes and mutants ran in
rsync copies in my scratchpad (`--exclude .git --exclude .env --exclude node_modules`; no `.env` in the worktree).
Each had its own `TMPDIR`. Nothing in the worktree was edited except this report.

## Executed results

| Run | Result |
|---|---|
| `bun test test/load test/architecture.test.js`, 3 times, fresh `TMPDIR` each | **85 pass, 0 fail** each, 41.1 / 41.3 / 41.3 s; **0 entries** left in the `TMPDIR` each time |
| Full `bun test`, fresh `TMPDIR` | **1590 pass, 155 skip, 0 fail**, 1745 tests in 95 files, 252 s; 0 entries left |
| Under 24 busy loops (2 x 12 cores): the 5 CPU/lag tests (`-t "CPU\|pinned\|stalls\|quiet"` on counting + guards) | 5/5 pass, **5 of 5 runs** |
| Under the same load: guards5 + hygiene + guards4 (the concurrent live scenarios) | 38/0, **3 of 3 runs**, 24 s each, 0 left |
| Under the same load: all of `test/load` | 69/0, **2 of 2 runs**, 41 / 42 s, 0 left |
| Busy loops | PIDs recorded, killed by PID, `kill -0` confirms none left |

## Findings

| # | Grade | Finding | Where | Evidence |
|---|---|---|---|---|
| 1 | **MEDIUM** | **The rejoin grace turns a long outage into VALID.** The grace waits for every client with `welcomedOnce && !welcomed && !gone`, however long ago it dropped. So a server that is down for nearly the whole run and comes back during the 3 s after the drain gets every client back, and `stayed` is true. With no role due (viewers only, or `--op-rate 0`) nothing else catches it. Base `383f593` reads INCOMPLETE on the same run. README and the `run.js` header say the grace is for "a drop just before the end". | `scripts/load/worker.js:90-92` | Probe `probes/outage.js`: 4 viewers, `--duration 6`. The server stops listening 1 s after the first hello (5.4 s before generation ends) and listens again 0.8 s after it ends, a **6.2 s outage**. Copy: `VALID`, exit 0, `connectedAtEnd: 4`. Base (re-run in a private, clean extract of `383f593`): `INCOMPLETE (only 0 of 4 clients were connected at the end)`, exit 1. (Editors in the same shape still read INCOMPLETE, because ops made offline go unacked.) **Fix:** give the grace only to clients whose last drop came within `REJOIN_GRACE_MS` of `genEndAt`. Record `lastDropAt` in `onclose` and count any other not-welcomed client as not connected. Add a live test: a long outage that ends inside the grace must read INCOMPLETE. |
| 2 | LOW | **A stop signal during the `--local` server's startup leaves its data dir and working dir.** The signal handler runs `stopChildren`, then `cleanupDirs()` and `process.exit(2)`. `server` is still null, so `server?.cleanup` does nothing, and `startServer`'s own catch-path `cleanup()` never runs before the exit. The run's own dir is removed. The README says the dirs are removed "also when the run is signalled". The window is about 100 ms on an idle machine, and up to the 20 s startup timeout on a slow start. `--max-wall` firing during startup takes the same path (not reproduced: the server always came up inside 1 s). | `scripts/load/run.js:422,427-431`; `scripts/load/server.js:63-64,109-113` | Probe `probes/startrace.js`, a run with `--editors 1` signalled at 60-200 ms. SIGTERM at 60/80/100 ms and SIGHUP at 60/80/100/200 ms each left `plenary-load-data-*` + `plenary-load-cwd-*` (7 of 16 runs). Every run where the server was up left nothing. No process left. **Fix:** hand `startServer`'s `cleanup` to the caller before the server is ready (e.g. `onChild(child, cleanup)`), and call it from `cleanupDirs`. Or have the handler wait for the in-flight `startServer` to settle. Add a test that signals in that window. |
| 3 | LOW | **SIGKILL of `run.js --local` without `--out` leaves the run's own dir.** This was in scope: "SIGKILL of run.js --local leaves no process or dir after 3 s". The orphaned server removes its own two dirs (`PLENARY_LOAD_CLEAN`). The run's `plenary-load-*` dir stays, and it holds the generated dev-tokens file (0600) and `server.log`. The builder's process check and the guards4 SIGKILL test both pass `--out`, so neither covers this. | `scripts/load/run.js:436,439` (tempDir is not in the server's clean list), `server.js:73,150`; test `guards4.test.js:161-165` passes `--out` only | Probe `probes/sigkill.js`, run 3 s after `kill -9`. With `--out`: `alive: []`, dir holds only `out` (claim holds). Without `--out`: `alive: []`, but **`plenary-load-MO3fLn` is left**. **Fix:** pass `tempDir` into the server's `PLENARY_LOAD_CLEAN` list (e.g. a `startServer({ alsoClean })` option), and add the no-`--out` case to the guards4 SIGKILL test. |
| 4 | LOW | **`test/load/tmp.js` leaves `process.env.TMPDIR` pointing at a deleted dir** for every test file that runs after it in the same `bun test` process. `cleanTmp` removes `SCRATCH` and does not restore TMPDIR. Any later file that calls `os.tmpdir()` inside a test gets ENOENT. | `test/load/tmp.js:11-15,25` | Scratch file `test/zz/zz.test.js` (a `mkdtempSync(join(tmpdir(), …))` in a test), run as `bun test test/load/guards.test.js test/zz/zz.test.js`: `TMPDIR …/plenary-load-test-b7lzMa false`, then `ENOENT … mkdtemp`, **1 fail**. Real files (`registry.test.js`, `tenants.test.js`) passed alongside load files in my runs, and the full suite is green, so I did not establish why they escape it (file order, or module-level `mkdtemp`). Only the `zz` repro is shown. **Fix:** save the original TMPDIR at import. `cleanTmp` restores it, and `useScratch` (beforeAll) sets it again. |
| 5 | LOW | **The grace is documented as "of the drain", but it comes after the drain.** `graceEnd` is set after the drain loop, so a run spends up to `--drain` + 3 s there. With `--drain 0` it still waits 3 s. This happens in the `run.js:22` header, the README's "Rejoin grace" bullet and the builder's report. | `scripts/load/worker.js:91`; `run.js:22` (header); README | Code read. **Fix:** say "up to 3 s after the drain", or bound the grace by the drain. |
| 6 | LOW | **The late-rejoin test's headline assertion does not pin the reason.** `toContain("**INCOMPLETE (")` matches any INCOMPLETE. The JSON assertions (`due: ["editor"]`, `skippedOffline > made`, `present: false`) do pin it, and the unit test pins the present wording, so X4 is still killed (confirmed below). Both possible headlines contain "skipped offline", so the assertion can be tightened. | `test/load/guards5.test.js:160` | Code read + mutant X4 killed. **Fix:** `expect(r.stdout).toMatch(/\*\*INCOMPLETE \([^)]*skipped offline/)`. |

## Scope items

| Item | Verdict | Evidence |
|---|---|---|
| Round-1 MEDIUM: 0 temp entries after `bun test test/load`, 3 runs | PASS | 3 gates + 2 under load + full suite: 0 entries each |
| `cleanTmp` leftover check really fires | PASS | Scratch file that `mkdtemp`s in `tmpdir()` outside `tmp()`: `error: temp dirs left behind by the code under test: plenary-load-leak-…`, the file fails (exit 1), also when run after `load.test.js`. Mutant "server stop leaves dirs": the check names 9 strays and 3 hygiene tests fail. |
| LOW1 `Object.hasOwn`, duplicate flags | PASS | `run.js:69,78`; guards5 unit + CLI (`--toString`, `--editors` twice, `--local` twice) pass |
| LOW2 X4 killed | PASS | Mutant X4 (due clock = every welcome): `(fail) live CLI: clients dropped at once and welcomed back late …`, 25/1 |
| REJOIN_GRACE: transient near end → VALID, refused → INCOMPLETE | PASS as tested; **finding 1** | Mutant "grace 0": the transient test fails. Flapping probe (20 viewers, each closed 400 ms after every welcome, 3 runs): INCOMPLETE every time (2-4 of 20 connected), so cycling does not slip through: backoff keeps them apart. Probe `silent.js` (a client dropped 0.3 s before the end, its rejoin welcomed, then never acked or echoed), 2 runs: `INCOMPLETE (… never acked …)`, exit 1. Same probe with `--max-wall 6` timed so the wall lands inside the grace: exit 2, `the run took longer than --max-wall (6 s)`. |
| JOIN_CEILING: welcome >10 s after connect → INCOMPLETE | PASS | `worker.js:94`, `run.js:249-250,300`; guards5 unit + live `run()` with `joinCeilingMs: 1000` pass |
| CPU tests deterministic under 2 x ncpu, still kill a broken sampler | PASS | 5/5 runs under 24 loops. Mutant "cpuLoad kept to one sample" run under the same load: `(fail) a worker pinned during the load phase only …` |
| Job C: spawnSync timeouts | PASS (source only) | `run.js:185`, `server.js:122`; hygiene source scan |
| `--max-wall` stops everything, exit 2 | PASS | hygiene wall test; probe `--max-wall 1` x8: exit 2, nothing left |
| Bounded stopChildren | PASS | hygiene "stopping" test (ignores SIGTERM → killed; unkillable → given up within bound) |
| /health readiness, 256 KB cap | PASS | hygiene stub tests (700 ms late listen; 2 MB of output); mutant "server cleanup removed" also fails the /health test's dir check |
| createBoard / dev-google `safeFetch` timeouts | PASS | hygiene + dev-google tests. Note: `safeFetch(url, { signal: undefined })` would override the default timeout (spread order); no caller does this today. |
| dev-google SIGHUP + `DEV_GOOGLE_PORT` | PASS | `PORT = 8080`, `ORIGIN`/`REDIRECT_URI` unchanged (`dev-google.js:30-32`); the override is read only in `import.meta.main` (`:164`) and only moves `listenPort`. The live test sends SIGHUP/SIGINT/SIGTERM: exit 0 and the port is released. |
| admin-bootstrap deadline | PASS | devadmin hang test (exit 1, "timed out", no password) |
| SIGKILL of run.js --local: no process/dir after 3 s | PASS with `--out`; **finding 3** without |
| Late-rejoin headline assertion strength | Adequate, could be tighter (finding 6) | |
| Speed claim 41.5 s | PASS | measured 41.1-41.3 s (test/load + architecture), 41-42 s under 24 busy loops |
| Concurrency interference from the concurrent scenarios | None seen | `scenarioGroup` awaits every scenario before the first assertion, so the event-loop tests (stall, quiet) run alone; 5 loaded runs green |

## Mutants I ran (each alone, fresh copy)

| Mutant | Result |
|---|---|
| X4: due clock moves to each welcome | KILLED (guards5 lateRejoin) |
| Rejoin grace = 0 | KILLED (guards5 transient) |
| `startServer.stop()` without `cleanup()` | KILLED (3 hygiene tests + the afterAll strays check) |
| `cpuLoad` kept to one sample (under 24 busy loops) | KILLED (counting pinned) |

## Not verified

- `--max-wall` firing while the `--local` server is still starting. It always came up inside 1 s here. The code shares finding 2's path.
- The spawnSync timeouts actually firing: I only read the source and the hygiene scan. No hung `ps`/`sysctl` was simulated.
- `--rig`, Linux, Postgres for admin-bootstrap: the hang test stands in for Postgres.
- Flapping with fewer clients and longer lifetimes: tried 20 clients at 400 ms only.

## Out of scope

Nothing found outside this job's scope, so there is no TECH-DEBT.md row.

## Housekeeping

- **Processes:** every probe stopped its children. The 24 busy loops were killed by recorded PID and checked gone. I
  killed one hung probe of my own (PID 31669, `outage.js` against base: its server-restart timer kept it alive). A
  final `pgrep` shows nothing of mine. Other sessions' processes were left alone: another full `bun test`, the
  `wt/rig` tests, and a cluster rig under `scratchpad/base`.
- **Errors of mine, undone or disclosed:**
  - `ln -s` into existing symlinked `node_modules` dirs made two stray links, `wt/load5/node_modules/node_modules` and
    `wt/plenary/node_modules/node_modules` (13:07, gitignored). I removed both within minutes. Nothing else in
    `wt/plenary` was touched.
  - At 13:07 I ran `git archive 383f593 | tar -x` into `scratchpad/base`. That turned out to be another session's
    working copy: it was re-extracted at 13:08 and runs a cluster rig. My extract may have overwritten its files for
    about a minute. Because of that, finding 1's base result was re-run in a private extract (same result), which is
    now removed.
- **Scratch:** I removed `r2/` (gate logs, mutant copies, probe TMPDIRs), `lt/` and my six `ptmp/probe-*` dirs
  (13:00 or later). Round 1's 11:4x entries were left. Left behind: `l5v2-tmp/` (2 small probe dirs; `rm` was denied by
  the permission system), and my probe scripts `probes/outage.js`, `startrace.js`, `sigkill.js`, `flap.js`,
  `silent.js`, kept as evidence. `copy/` was refreshed by rsync and is identical to the worktree. No `.env` anywhere.
  Nothing committed; the only worktree change is this report.
