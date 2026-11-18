# Report: p8-load5v3 (round-3 review of p8-load5 + Job C)

**Verdict: PASS.** The round-2 MEDIUM and all five LOWs are closed. My own probes and mutants show it, not only the
builder's tests. I found no new HIGH or MEDIUM. Two wording nits are listed under Notes. Neither blocks.

Reviewed: `plenary/load5` at `a1e714b`, diff `c2f2465..a1e714b`. Probes imported the worktree read-only, each with
its own `TMPDIR`. Mutants ran in rsync copies (`--exclude .git --exclude .env --exclude node_modules`, with
node_modules symlinked). All of this was in a fresh scratch dir, `scratchpad/l5v3-30904`. I edited nothing in the
worktree except this report.

## Executed results

| Run | Result |
|---|---|
| `bun test test/load test/architecture.test.js`, 3 times, fresh `TMPDIR` each | **89 pass, 0 fail** each, 44 s each; **0 entries** left each time |
| Full `bun test`, fresh `TMPDIR` | **1594 pass, 155 skip, 0 fail**, 1749 tests in 95 files, 254 s; 0 entries left; `git status` clean |
| Stray processes after everything | none (`ps` for the copies and `wt/load5/{server,scripts}`: 0) |

## Round-2 findings: closed?

| # | Round-2 finding | Status | Evidence |
|---|---|---|---|
| 1 | MEDIUM: the rejoin grace turned a long outage VALID | **Closed** | `client.js:88,165` sets `lastDropAt` only when a *welcomed* connection is lost. `worker.js:93-95` waits only for clients with `lastDropAt >= genEndAt - grace`. Probe `grace.js` runs `runWorker` in-process with an exact `genEndAt`, 4 viewers, and a whole-server outage (listener stopped) from `genEnd - X` to `genEnd + Y`. **X=3.1 s, Y=0.3 s: INCOMPLETE** (0/4, read 1 ms after the end, no grace wait). **X=2.9 s, Y=0.3 s: VALID** (4/4, read at +1.09 s). X=3.3 s, Y=0.5 s: INCOMPLETE. X=2.7 s, Y=0.5 s: VALID. Round-2 end-to-end probe `outage.js` (`run()`, a 6 s run, down 5.4 s before the end, back 0.8 s after it): viewers **INCOMPLETE (only 0 of 4 …)**, exit 1, twice (was VALID). Editors: INCOMPLETE. Down 2.4 s before the end and back 0.5 s after: VALID (a legitimate near-end drop). |
| 1a | Failed reconnect attempt after an earlier drop | **Correct** | Probe with sockets that open and are closed on `hello`, no welcome (`helloAt` set, so `connectionFailed` runs, but `welcomed` is false, so `lastDropAt` is not refreshed). Dropped 5.0 s or 3.1 s before the end: **INCOMPLETE** (0/4). Dropped 2.9 s or 2.0 s before the end: VALID (4/4 at +2.70 s / +2.39 s, inside the 3 s). |
| 1b | Flapping clients | **Correct** | 20 viewers, each closed 400 ms after every welcome: INCOMPLETE twice (0/20; the grace ran its full 3 s and stopped). With a 1500 ms life: VALID, read at +2 ms with no grace used. Everyone happened to be connected at the end, which is the existing "connected at the end" rule, not the grace. |
| 1c | Test kills the mutant | **Yes** | Mutant M1 (the old predicate, `lastDropAt` dropped): `(fail) live CLI: a long outage that ends inside the rejoin grace …`, 16/1. The test (`guards5.test.js:177-183`) has a wide margin: the rejoin welcome lands about 0.8-1.6 s after the end, which is inside the grace for the mutant and after the read for the fix. |
| 2 | LOW: a signal during `--local` startup left dirs | **Closed** | `server.js:68` calls `onCleanup(cleanup)` synchronously after the mkdtemps, so a signal handler can never run in between. `run.js:422` calls it. Probe `startrace.js`, **25 runs**: SIGTERM at 40-180 ms (8), SIGHUP at 50-225 ms (8), SIGINT at 30-230 ms (6), and `--max-wall 1` (3). Ten of them landed before the server was up, in the window that leaked in round 2. Every run: exit 2 and **0 entries left**. No processes left. Mutant M3 (no `onCleanup`): the hygiene test fails **3 of 3** times run alone, so it is reliably killed. |
| 3 | LOW: SIGKILL without `--out` left the run dir (dev tokens) | **Closed** | `run.js:439` passes `alsoClean: [tempDir]` into the orphan's `PLENARY_LOAD_CLEAN` (`server.js:66,77`). Probe `sigkill.js`, 3 runs each, 3 s after `kill -9`. Without `--out`: `alive: []`, `after: []`. With `--out`: `alive: []`, `after: ["out"]` (the user's output only). Mutant M2: the guards4 no-`--out` test fails. |
| 4 | LOW: `tmp.js` left TMPDIR on a deleted dir | **Closed** | `tmp.js:13-14,29`. The round-2 repro (`test/zz/zz.test.js` doing `mkdtemp(tmpdir())`, run after `guards.test.js`, in a copy) now passes, 12/0, and TMPDIR is restored to the original. Mutant M4: the hygiene TMPDIR test fails. |
| 5 | LOW: grace wording "of the drain" | **Closed** | `run.js:22`, `client.js:36-39`, `worker.js:89-92` and README:153 now say "after the drain". This matches the code (`graceEnd` is set after the drain loop). |
| 6 | LOW: loose headline assert | **Closed, not flaky** | `guards5.test.js:160`: `/\*\*INCOMPLETE \(.*skipped offline/`. Every branch `headline()` can take when `ops.present === false` contains "skipped offline", whatever the role mix: `run.js:305` "N ops were skipped offline against M made", or `run.js:306` "no <role> op was made though … (N ops skipped offline, …)". The test also asserts `present: false`. Without the `s` flag, `.*` stays on the one-line headline. The builder's note that `[^)]*` flaked on "editor(s)" is right. It passed in all 3 gate runs and in the full suite. |

## Other checks

- **New tests, flakiness.** The hygiene startup test polls every 2 ms for the `plenary-load-cwd-` dir and then
  signals. If the signal lands after `/health`, the run still exits 2 and cleans up, so a missed window cannot fail
  the test, only weaken it, and M3 was killed 3 of 3 times. The longOutage scenario cannot become "never joined":
  `midServer` refuses only tokens it has dropped. Both held across 3 gates and the full suite.
- **Lifecycle of the run dir.** `tempDir` is now in the server's clean list as well, so `server.stop()` removes it before `run.js`'s
  own `rmSync` (`run.js:496-497`). That is harmless: nothing is written to `tempDir` after the server stops (results
  go to `--out` only). With `--keep-data`, `scratch` is `[]`, so nothing is removed. Correct.

## Findings

No HIGH or MEDIUM findings.

| # | Grade | Finding | Where | Evidence |
|---|---|---|---|---|
| 1 | LOW (doc nit, non-blocking) | The round-1 table in the builder's report still says the grace is "up to 3 s **of** the drain". The fix text says "header, README, report" were all corrected. | `docs/m2/reports/p8-load5.md:93` | `grep "of the drain"` |
| 2 | LOW (doc nit, non-blocking) | The grace also covers a drop *during* the drain (`lastDropAt` after `genEndAt` passes the `>=` check). That is reasonable, but the README and header describe only a drop "within 3 s before the end of generation". `client.js:58` also has two `//` comments on one line. | `worker.js:94`; README:153; `client.js:58` | Code read |

## Mutants (each alone, fresh copy)

| Mutant | Target | Result |
|---|---|---|
| M1 grace for any dropped client (old predicate) | guards5 | killed: the longOutage test fails |
| M2 run dir not in the orphan clean list | guards4 | killed: SIGKILL no-`--out` test fails |
| M3 `onCleanup` not called | hygiene | killed 4 of 4 (1 in the file run, 3 alone) |
| M4 TMPDIR not restored | hygiene | killed: the TMPDIR test fails |

## Hygiene of this review

No processes are left. The worktree is untouched apart from this report. The scratch dir
`/private/tmp/claude-501/-Users-r-loops-plenary/202948b0-1a27-4f6f-a14b-b282a0b4a3ac/scratchpad/l5v3-30904` holds
the probe scripts, the mutant copies with their node_modules symlinks, and some empty `probe-*` dirs. The permission
system denied my `rm -rf` of it, so it still needs removing. It holds only fake test tokens.

**Verdict: PASS**
