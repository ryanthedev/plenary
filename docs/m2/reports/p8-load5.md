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
