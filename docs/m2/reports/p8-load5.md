# Report: p8-load5 (fix round 5 for the load client: the MEDIUM and 2 LOWs from p8-load4v)

**Status: done, committed on `plenary/load5`. Each finding has a test that fails on load4's code and passes on
this one. The verifier's drop-everyone scenario now reads INCOMPLETE, exit 1. Mutation results: see below.**

## Findings, changes and guards

| # | Change | Guarding test(s) (`test/load/guards5.test.js`) |
|---|---|---|
| MEDIUM drop-everyone reads VALID | `buildResult` also rules on staying connected. **`clients.stayed`** = `connectedAtEnd >= planned`; **`ops.present`** = no role due, or `skippedOffline <= made`. `complete` needs both. Headline names the numbers: `only 0 of 4 clients were connected at the end`, `41 ops were skipped offline against 40 made` (the second is left out when a due role made no op, whose reason already gives the skipped count). | unit: "stayed" (3 of 4, 0 of 4), "present" (40 vs 40 passes, 41 INCOMPLETE, nothing due not judged). Live CLI against a fake server: drops every client at 1.5 s and closes later hellos 1013; same with `error unavailable`; drops half the clients for good (2 of 4 left). All three: INCOMPLETE, exit 1. A healthy fake server still reads VALID, exit 0. |
| LOW 2 due rule ignores join time | A client now starts generating at its **first welcome** (`LoadClient.arm()`, fired from `onFrame`), not at connect, so no tick is skipped offline before the welcome. The worker counts `dueClients_<role>`: clients welcomed at least 1.5/rate s before generation ended. A role is due when one exists (`dueRoles(counts, config, dueClients)`; with no `dueClients`, the plan rule as before). The worker always reports `dueClients`, even 0. | unit "due clock"; live "slow welcome" (welcome delayed 900 ms, 1 editor, `--op-rate 1.5 --duration 1`): VALID, exit 0, `skippedOffline` 0. |
| LOW 3 flags | `parseArgs` refuses an unknown flag (`unknown flag --op_rate (see --help)`) and a value that is itself a flag (`--tokens needs a value, not the flag --local`), both exit 2. `run()` calls `parseOptions` before `rigConfig`, so `--rig " "` reads `--rig is empty`. Ramp capped: clients / `--ramp` at most 3,600 s (`MAX_RAMP_S`; in `--help`). | "parseArgs refuses...", "CLI: unknown flags... exit 2", "the ramp may take at most 3600 s". |

- **Docs:** the calibration README ("What the headline means" table, new "Staying connected" and "due clock"
  bullets, "Not judged" now only backlog skips and brief outages, the argument list) and the `run.js` header.
- **Existing tests changed:** `guards.test.js` and `guards4.test.js` worker fixtures now carry `connectedAtEnd`
  (a run that reports none now reads as everyone gone); one headline assertion in guards4's crash test now expects
  the new leading clause plus the old one; the `--help` test checks the new text.
- **Calibration check:** all 15 `result.json` files: `connectedAtEnd` = `planned` in all, `skippedOffline` at most
  66 (`k200`) against 931-1,482 ops made. Neither rule flips one.
- **Healthy `--local`** (3 editors, 2 annotators, 20 viewers, 5 s): VALID, exit 0, 34/34 ops echoed.
- **Design note:** `connectedAtEnd` is counted after the drain (as before), so it is the stricter reading of "at
  the end". A client that is mid-reconnect at that instant would count against a run; none did in the 15 runs.

## Failing on load4's code

`test/load/guards5.test.js` run against `scripts/load/{run,client,worker}.js` from HEAD (plus one export line so
the file loads): 11 of 11 fail, 0 pass (all three drop scenarios, slow welcome, flags, ramp cap, units).

## Mutations (scratch copies, rsync --exclude .git --exclude .env --exclude node_modules, `bun test test/load` each)

**11 of 11 CAUGHT** (script `mut5.sh` in the scratchpad; each mutant alone, fresh copy, pattern found exactly once).

| Mutant | Failing tests |
|---|---|
| M1 `stayed` always true | stayed (unit); the 3 live drop tests; the load4 crash test (headline). A 6th failure, "a worker pinned during the load phase only...", is CPU-timing noise from the batch running beside other load, not caused by M1 |
| M2 `present` always true | present (unit) |
| M3 `skippedOffline < made` (not `<=`) | present (unit, the equal case) |
| M4 `stayed` = any client connected | stayed (unit) and the half-dropped live test |
| M5 clients generate from connect (`startGenerating`) | slow welcome (live) |
| M6 `wasDue` ignores the window | slow welcome (live) |
| M7 worker no longer always reports `dueClients` | slow welcome (live) |
| M8 unknown flags accepted | parseArgs, CLI exit 2 |
| M9 flag-as-value accepted | parseArgs, CLI exit 2 |
| M10 `rigConfig` before `parseOptions` | CLI `--rig " "` message |
| M11 no ramp cap | ramp cap |

## Deterministic CPU tests and temp dirs (coordinator's follow-up)

- `runWorker(job, { cpuUsage })` takes an injectable CPU source (default `process.cpuUsage`). The two flaky tests
  ("CPU burned in the drain is not the load phase's..." and "a worker pinned during the load phase only...") now feed
  a modelled `busyFrom(wallMs)` (in `fake-server.js`) instead of burning real CPU, and the pinned test no longer
  asserts the event-loop lag (the lag is overridden to empty; the lag test keeps its own burn).
- **Evidence** (10 consecutive runs of those two tests, with 2 x ncpu busy-loop processes running, killed by PID after):
  load4's tests **0 of 10 pass**; these **10 of 10 pass**. Unloaded, load4's pass (2/2), so the setup is sound.
- Temp dirs: `test/load/tmp.js` (`tmp()` records each dir, `cleanTmp()` removes them) replaces the five local
  `mkdtempSync` helpers; every test file calls `afterAll(cleanTmp)`. Dirs the CLI and `--local` server make
  themselves (outside `tmp()`) are not covered. About 700 dirs from my earlier runs remain in the scratchpad.

## Gates

- `bun test test/load test/architecture.test.js` in the worktree, 3 runs after the last change: 70 pass, 0 fail each (test/load 54: 43 + 11 new; the
  architecture file 16). `bun test test/load` was run once as part of that and once per mutant. No new
  `scripts/*.js`, so `COMPOSITION_ROOTS` is unchanged.
- The full `bun test` was not run (known unrelated hang).

## Housekeeping

- Only `/Users/r/loops/plenary/wt/load5` was edited. `bun install` was run in it. Scratch copies live in the session
  scratchpad (no `.env`; `find -name .env` was 0 for the first copy and the copies are made from the same rsync).
- Processes: every run stopped its own server and workers; a `ps` after the `--local` run showed only two
  `server/main.js` processes from `/Users/r/loops/plenary/wt/plenary` (another builder), untouched.

## Not verified

- A real-server form of the drop scenario (SIGKILL the `--local` server mid-run); the fake server stands in.
- `--rig` against a live rig; Linux.
- p8-load3v's stall/crash probe scripts were not re-run as files; their two shapes are the live tests in
  `guards4.test.js` (stall, crash), which pass.

## Round 2 (p8-load5v: FAIL on 1 MEDIUM; plus the load/dev-script hardening, "Job C")

Worktree `wt/load5`, branch `plenary/load5`, from `383f593`. The reviewer's report `p8-load5v.md` is committed with it.

### Fixes

| Item | What changed | Guard |
|---|---|---|
| MEDIUM: temp dirs | `startServer` removes its working dir, and its data dir when it made it, on stop and on every failure path; `keep: true` / `--keep-data` keeps them (paths are logged). `--local` without `--out` removes the run's own dir at the end, and on SIGTERM/SIGINT/SIGHUP. An orphaned server (run.js SIGKILLed) removes its dirs on its way out (`PLENARY_LOAD_CLEAN`). Tests: `test/load/tmp.js` points `TMPDIR` at one scratch dir for the process (spawned CLIs get it from `childEnv()`), and `cleanTmp()` **fails the file** if anything is left in it that `tmp()` did not make, then removes the dir itself. | `hygiene.test.js` (stop / keep / given dir / bad tokens path leaves nothing; `--local` clean and `--keep-data` in a private TMPDIR), the SIGKILL test in `guards4` (`strays()` is empty), the afterAll check in all 6 files. A fresh `TMPDIR` after `bun test test/load test/architecture.test.js` holds 0 entries (each of the 3 gate runs, and 3 more under load). |
| LOW 1 | `Object.hasOwn(MAX, k)`; a flag given twice is refused (booleans too). | `guards5`: `--toString/--constructor/--hasOwnProperty/--__proto__/--valueOf`, `--op-rate` twice, `--local` twice, plus the CLI. |
| LOW 2 (X4) | Test: every client dropped at 0.8 s and welcomed back 3.5 s later (`--op-rate 1`, 5 s) must read INCOMPLETE. The mutant that moves the due clock to the latest welcome reads VALID. | `guards5` "clients dropped at once and welcomed back late". |
| Flaky CPU test | "a load phase shorter than one CPU sample" now uses the injected `busyFrom` CPU source (no real burning) and overrides the lag like the other two. | 8 runs of the four CPU tests under 24 busy loops (2 x ncpu): 8/8 pass; the full suite under the same loops: 3/3 pass. |
| L3 (coordinator, round 2) | A client that dropped and is reconnecting when generation ends gets up to 3 s of the drain (`REJOIN_GRACE_MS`) to come back before "connected at the end" is read. | `guards5`: one client dropped 200 ms before the end and let back in reads VALID (4 of 4); the same drop refused reads INCOMPLETE (3 of 4). |
| Late welcome (coordinator) | A client welcomed more than 10 s (`JOIN_CEILING_MS`) after its first connect is joined late: `clients.lateJoined`, run INCOMPLETE, headline names it. | `guards5`: unit verdict, and a live `run()` with `joinCeilingMs: 1000` against a server that welcomes after 1.5 s. |
| CPU asserts (coordinator) | The pinned test asserts `cpuLoad.length >= 3` again (the modelled CPU makes it deterministic). | Mutant "cpuLoad kept to one sample" is killed. |
| Job C | `Bun.spawnSync` calls (ps, ulimit, sysctl) have a 5 s timeout (a failed `ulimit` reads as "no limit known"); `--max-wall s` (1-86400, default plan + 120 s) stops the whole run and exits 2; `stopChild`/`stopChildren` are bounded (SIGTERM, SIGKILL after 5 s, give up 2 s later); `--create-board` requests time out (15 s); server readiness is `GET /health` on a port picked up front (the log is read only for the dev board id and the tokens refusal), its kept output is capped at 256 KB (the log file gets all); `dev-google.js` stops on SIGHUP and its `safeFetch` has a 15 s timeout; `admin-bootstrap.js` had no network call except the Postgres open: that open plus the bootstrap now have a 30 s deadline (`timeoutMs`), closing is bounded too. | `hygiene.test.js`, `devadmin.test.js`, `dev-google.test.js` (see mutants). |

Documented only: nothing now. (L3 and the late-welcome note are fixed above, per the coordinator's note.) `README.md` of the calibration run has the new rules.

### Timings (this machine was busy with other builders: load average 6-50 during my runs)

| File | Before (s) | After (s) | How |
|---|---|---|---|
| counting | 18.9 | 7.6 | independent slow tests run at once (`scenarioGroup`); the two that measure this process's event loop run alone after; shorter modelled CPU runs |
| guards | 12.5 | 5.4 | same; the real-burn CPU test is modelled |
| guards4 | 19.8 | 10.3 | same; shorter runs |
| guards5 | 28.5 | 8.1 | 8 live CLI scenarios at once, 3 s runs instead of 5 s |
| load | 8.8 | 5.2 | the two live runs at once |
| hygiene (new, 9 tests) | – | 5.0 | |
| **test/load total** | **88.5** (reviewer: 89) | **41.5** with 84 tests (was 70) | |

Nothing was weakened: every live scenario still runs a real CLI against a real or scripted server; only independent ones overlap, and each still asserts the same numbers. Gate: `bun test test/load test/architecture.test.js`, 3 consecutive runs green, 0 entries left in a fresh `TMPDIR` each time.

### Mutants (fresh rsync copy, `--exclude .git --exclude .env --exclude node_modules`, no `.env` found): 22 of 22 killed

`hasOwn` to `in`, duplicate-flag check removed, `lateJoined` never counted, `lateJoined` not part of `complete`, no rejoin grace, unbounded rejoin grace, X4 (due clock = latest welcome), server stop leaves dirs, orphaned server leaves dirs, `--max-wall` never fires, `stopChild` without SIGKILL, `stopChild` waiting without a bound, `psSample` without timeout, `safeFetch` without timeout, no SIGHUP in dev-google, admin-bootstrap without its deadline, run dir kept, `--keep-data` ignored, signal path skips the dir cleanup, `cpuLoad` kept to one sample, `/health` not polled, `createBoard` without timeout. Two survived the first pass (`/health` not polled, `createBoard` timeout); tests for both were added (a stub server that logs at once and listens 700 ms later; a server that never answers) and both are now killed.

### Process check

`run.js --local --procs 2 --duration 60`, then `kill -9` of that run.js (PID known): 3 s later the server and both workers were gone (`kill -0`), and the TMPDIR held only the `--out` dir (the server's data and working dirs were removed by the orphaned server). Also in `guards4` (3 s window).

### Not done / notes

- The bounded output buffer has no test of its own (it would need a server that logs more than 256 KB).
- `dev-google.js` SIGHUP: the signal list is asserted (`STOP_SIGNALS`), not a live SIGHUP to the real script (it needs Google credentials and a fixed port).
- The full `bun test` was not run (known unrelated hang).
