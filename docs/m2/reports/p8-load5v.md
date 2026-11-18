# Report: p8-load5v (verify p8-load5, fix round 5 for the load client)

**Verdict: FAIL, on 1 MEDIUM: the coordinator's temp-dir requirement is half done. Every `bun test test/load` run
still leaves 16 temp dirs (about 1.2 MB). The builder disclosed this, but the requirement says test/load must
remove them. All three p8-load4v findings are fixed and guarded. The CPU tests are now deterministic and still
catch a broken sampler. 3 LOWs and some notes, none blocking.**

Build reviewed: `plenary/load5` at `383f593`, diff `3f90e74..383f593`. Probes and mutants ran in rsync copies in my
scratchpad (`--exclude .git --exclude .env --exclude node_modules`, `node_modules` symlinked; `find -name .env`
found nothing). Each run had its own `TMPDIR`. Nothing in the worktree was edited except this report.

## Executed results

- **Gates:** `bun test test/load test/architecture.test.js` in the worktree, 3 times: 70 pass, 0 fail each time
  (89 s, 89 s, 88 s).
- **The new tests on load4's code:** guards5 against `3f90e74`'s `run.js`, `client.js` and `worker.js`, plus the
  `MAX_RAMP_S` export: **0 pass, 11 fail.** The builder's claim holds.
- **The two CPU tests under load:** run 6 times with 2 × ncpu (24) busy loops: **6/6 pass.** I stopped the loops by
  recorded PID and confirmed none was left.
- **`guards5.test.js` under the same load:** 10/10 runs, 11 pass each. The slow-welcome test has about 200 ms of
  margin and held every time.

## Findings

| # | Grade | Finding | Where | Evidence |
|---|---|---|---|---|
| 1 | **MEDIUM (blocking: a stated requirement is unmet)** | **test/load still leaves its temp dirs.** `tmp()`/`cleanTmp()` covers only the dirs the test files make themselves. Each run leaves 2 `plenary-load-*` output dirs (from `run()`/CLI calls without `--out`), plus 7 `plenary-load-cwd-*` and 7 `plenary-load-data-*` dirs (one pair per `--local` server, with SQLite files): 16 dirs, about 1.2 MB, piling up. The builder's report says these are "not covered". | `scripts/load/server.js:28-29`, `scripts/load/run.js:415`. The tests that cause them: `guards.test.js:86,96`, `guards4.test.js:158`, `load.test.js:113,148`, `counting.test.js:222-229` | 3 gate runs, each into a fresh TMPDIR (`tmp1`-`tmp3`): `2 plenary-load, 7 plenary-load-cwd, 7 plenary-load-data` every time. **Fix:** point the children's `TMPDIR` at a `tmp()` dir (the `env()` helpers already set it), and set `process.env.TMPDIR` to a `tmp()` dir for in-process `run()`/`startServer()` calls (or pass `dataDir`/`out`), so `cleanTmp` removes everything. |
| 2 | LOW | **Unknown flags named after Object prototype properties are still accepted.** `knownFlag` uses `k in MAX`, which walks the prototype chain. `--toString 5`, `--constructor 5`, `--hasOwnProperty x` and `--__proto__ 5` all pass `parseArgs` and `parseOptions`. The CLI runs and exits 0. The header and README say unknown flags are refused. Nobody would type these by accident, so this is an edge case the brief did not list. | `scripts/load/run.js:64` | `bun scripts/load/run.js --local --toString 5 --editors 1 --duration 1` → exit 0. **Fix:** `Object.hasOwn(MAX, k)`. |
| 3 | LOW | **Test gap: nothing pins "the due clock is the *first* welcome".** Mutant X4 moves `firstWelcomeAt` to each later welcome. It survives the full `bun test test/load` (54/0), yet it changes a verdict. A server drops every client at 0.8 s and welcomes their rejoins only 8 s later (`--op-rate 0.5 --duration 10`): the real code reads `INCOMPLETE (16 ops were skipped offline against 3 made)`, exit 1. Mutant X4 reads **VALID, exit 0**, `due: []`, 0 ops made. The code is right; the test is missing. | `scripts/load/client.js:102` | probe `rejoinLate` in `probes/late.test.js`, run on `copy` and on `mut-X4` |
| 4 | LOW | **One drop near the end makes a healthy run INCOMPLETE.** The server closes one client 200 ms before generation ends and would accept its rejoin. An empty drain ends at once, so `connectedAtEnd` is 3 of 4 and the run reads `INCOMPLETE (only 3 of 4 clients were connected at the end)`. That is the brief's literal rule, it fails safe, and the builder disclosed it ("mid-reconnect at that instant"). | `scripts/load/worker.js:85,92` | probe `lateClose`: 2/2 INCOMPLETE, exit 1 |

## Requirements

| Item | Verdict | Evidence |
|---|---|---|
| MEDIUM: drop everyone mid-run → INCOMPLETE, exit 1, reason names numbers | PASS | Repro: my own fake server drops every client at 1.5 s and refuses every rejoin. Result, 2/2 runs: `INCOMPLETE (only 0 of 4 clients were connected at the end; 58 ops were skipped offline against 21 made)`, exit 1. The guards5 drop-all (close and error forms) and drop-half tests pass. Viewers only, all dropped: INCOMPLETE (`stayed` does not depend on a role being due). |
| Both rules (`connectedAtEnd < planned`, `skippedOffline > made` for a due role) | PASS | `run.js:248-249`. Unit tests cover 40 vs 40 (passes) and 41 vs 40 (INCOMPLETE). Mutants R1 (`present` always true), X5 (`connectedAtEnd` counted by `welcomedOnce`) and X6 (headline without `stayed`) are all killed. |
| Calibration: 15 `result.json` files do not flip | PASS | Recomputed: `connectedAtEnd` equals `planned` in all 15. `skippedOffline` is at most 66 (`k200`) against at least 433 made. |
| Healthy runs still VALID | PASS | `--local`, 3 editors + 2 annotators + 20 viewers, 5 s: VALID, exit 0. `--local`, 5 editors + 5 annotators + 200 viewers, `--procs 2`, 8 s: VALID, exit 0, 210/210 connected. Healthy fake server, editors: VALID. Healthy fake server, viewers only: VALID. |
| LOW 2: due clock from the welcome; `slowWelcome` → VALID | PASS | `client.js:102,171,173`, `worker.js:66,79`. The guards5 slow-welcome test passes (and 10/10 under load). R2 (generate from connect) is killed by it. |
| LOW 3: unknown flag / flag-as-value → exit 2 naming it; `--rig " "` → empty-flag message; ramp cap | PASS, except finding 2 | CLI: `--op_rate 5`, `--tokens --local`, `--rig " "`, `--help --bogus` and `--board --x` all exit 2 with the right message. `--tokens=x` is refused as unknown. 3,603 clients at 1/s is refused; 3,600 is accepted. R3, R4 and R5 are killed. |
| README "Not judged" and `run.js` header true | PASS | README diff read against the code: it matches the rules, the due clock and the flags. `--help` shows "1.5/rate s", "stayed", "Unknown flags" and "≤ 3600 s" (asserted in a test). |
| CPU tests deterministic under load | PASS | 6/6 pass under 24 busy loops (see Executed results). |
| CPU tests not vacuous | PASS | **X1** (load mark at worker start, so the idle ramp counts): killed by "pinned during the load phase only". **X2** (end mark after the drain): killed by "CPU burned in the drain". **X3** (the 1 s sample halved): killed by "CPU burned in the drain". |
| Temp dirs removed | **FAIL** | Finding 1 |

## Mutations (each alone, fresh copy)

| Mutant | Suite | Result |
|---|---|---|
| R1 `present = true` | test/load | KILLED (present unit) |
| R2 `arm()` generates at connect | test/load | KILLED (slow welcome) |
| R3 unknown-flag check removed | test/load | KILLED (parseArgs, CLI) |
| R4 flag-as-value check removed | test/load | KILLED (parseArgs, CLI) |
| R5 `rigConfig` before `parseOptions` | test/load | KILLED (CLI `--rig " "`) |
| X1 / X2 / X3 CPU sampler broken | counting + guards | KILLED (see above) |
| X4 `firstWelcomeAt` = latest welcome | guards4+5, then full test/load (alone) | **SURVIVED** (finding 3). It "failed" once with three mutants running in parallel, but only "a load phase shorter than one CPU sample, burned", a real-burn test unrelated to X4. |
| X5 `connectedAtEnd` by `welcomedOnce` | guards4+5 | KILLED (4 live tests) |
| X6 headline ignores `stayed` | guards4+5 | KILLED |
| R6 `cpuLoad` truncated to 1 sample | counting | **SURVIVED** here. Killed by base's version of the pinned test (`>= 3`: received 1). See Notes. |

## Notes (non-blocking)

- **Loosened assertions in the two CPU tests.** In the "pinned" test, `cpuLoad.length` went from ≥ 3 to ≥ 1 and the
  lag assertion is gone (lag is overridden to empty). In the drain test, `cpuLoadMs` went from < 1400 to < 1700.
  Mutant R6 shows the first change is a real loss of coverage, but `cpuLoad` is a record field: verdicts come from
  `cpuLoadMean`, which X1-X3 show is still guarded. The lag assertion's job, that only CPU is flagged, still holds:
  the test asserts `invalidReasons` equals exactly the CPU reason.
- **Other real-burn tests can still flake under load.** "a load phase shorter than one CPU sample, burned, is still
  measured and flagged" (`guards.test.js`, already at the base) failed in 3 of 3 mutant runs while three suites ran
  at once. It passed on its own and in all 3 gates. It is not one of the two the coordinator named, but the
  user's no-flake rule applies to it too.
- **The due clock's other side:** if every welcome lands within the last 1.5/rate s, no role is due and the run is
  not judged on ops. My probe welcomed all clients 9 s into a 10 s run at `--op-rate 0.5`: VALID, exit 0, 1 op made,
  join p50 9,002 ms. Brief item 2 asks for exactly this. Join latency is reported but has no ceiling.
- **The present rule is coarse:** a server that refuses one of 4 clients for most of the run can still read VALID
  if it lets that client back in before the end. That is the brief's rule as written.
- **Duplicate flags** (`--op-rate 4 ... --op-rate 0.5`): the last one wins, silently.
- **Speed:** test/load + architecture now takes about 89 s (p8-load4v measured about 60 s for test/load alone,
  before the 11 new tests).

## Not verified

- A real-server drop (SIGKILL the `--local` server mid-run); the fake servers stand in for it.
- `--rig` against a live rig; Linux.
- p8-load3v's stall/crash probe files were not re-run as files. Their shapes are the guards4 live tests, which pass.

## Housekeeping

- **Processes:** every probe and mutant run stopped its own children. I recorded the busy loops' PIDs, killed them
  and checked they were gone. A final `ps` shows two processes that are not mine (`scratchpad/mut/server/main.js`
  and a `bun test test/server`, both from another session sharing the scratchpad path). I left them alone. The
  worktree's other `server/main.js` (PID 99552, in `wt/plenary`) is not mine either.
- **Scratch I left (all in my scratchpad):** `copy`, `load4`, `mut-*`, `probes`, `ptmp`, `tmp1`-`tmp3`, `mut.py`,
  `busy*.sh`. No `.env` anywhere in it.
- **Worktree:** only this report was added; I committed nothing.
