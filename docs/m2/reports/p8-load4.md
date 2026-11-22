# Report: p8-load4 (fix round 4 for the load client: the MEDIUM and LOWs from p8-load3v)

**Status: done. All 7 items are fixed and each has a test. All 23 mutations are CAUGHT (21 of 23 in the first batch; the 2 survivors were guarded and re-run CAUGHT), including p8-load3v's O2 and O4 and the G3 series. Gates are green. Synced to the real tree; nothing committed.**

- **Synced:** `scripts/load/{run,server,worker,client}.js`, `test/load/guards.test.js`, new `test/load/guards4.test.js`, `docs/m2/load/2026-11-12-calibration/README.md`. Before the sync, every real-tree file of this job still equalled what I had copied (`cmp`); afterwards, `diff -r` of the copy against the real tree is clean. `tokens.js` is unchanged.
- **Probes after the fix:** `stall.js`: `exit 1 | **INCOMPLETE (37 of 37 ops made were never acked (37 never sent); …)**`. `crash.js`: `exit 1 | **INCOMPLETE (no editor op was made though 3 editor(s) were due to (36 ops skipped offline, 0 for backlog))**`. `sig.js SIGKILL startup` and `ramp`: exit 137, 0 descendants alive afterwards (before: the server survived). The "startup" run fired after the server had logged "listening" (`serverLogged true`), so it does not cover the pre-listening window.

**For t187:** nothing outside my files needs changing.

- **Copy:** `git archive HEAD` (`2703540`) plus this job's files from the real tree (`scripts/load/{run,server,
  tokens,worker,client}.js`, `test/load/*`, the calibration README), with `node_modules` symlinked from the real
  tree. Path: `/private/tmp/claude-501/-Users-r-repos-plenary/7a13dcd4-0436-4724-9869-5d56212a1429/scratchpad/copy`.
  - **No `.env`:** `find <copy> -name .env` was empty before every run.
  - **Every run:** `TMPDIR` = that scratchpad.
- **Baseline before any change:** `bun test test/load` 31 pass, 0 fail. Both verifier probes reproduced red:
  `stall.js` and `crash.js` gave `exit 0 | **VALID**`.
- **Distributed-systems-design:** not applied. This is the load tool's exit rule, argument checks and process
  hygiene, not system design (the same call as p8-load2/3 and their verifiers).

## Findings, changes and guards

| # | Change | Guarding test(s) | Mutation reverting it alone |
|---|---|---|---|
| 1 MEDIUM | **Ops counted when made:** `client.js` counts `opsMade` (and `opsMade_<role>`) at `local()`; `opsSent` and the latency start stay at first write. **Rule** (`run.js` `buildResult`): answered = every op *made* acked by the drain's end, ≥ 99% of ops made echoed, **and** every writer role *due* to make ops made at least one. A role is due when it has clients and rate × `--duration` ≥ 1.5 (`DUE_TICKS`; each client's first op comes within 1.5/rate s, so a due role that is online makes one for sure). Editors are due on `--op-rate`, annotators on max(`--note-rate`, `--comment-rate`). New fields `ops.made`, `ops.due`, `ops.missing`; the headline names the cause (`no editor op was made though 3 editor(s) were due to (35 ops skipped offline, …)`, `36 of 36 ops made were never acked (36 never sent)`). `unanswered === 0` was **not** adopted: an acked op whose echo a resync cut off stays pending, which would contradict the documented 99% echo tolerance (`k125b` has `unanswered` 0, but the tolerance exists for that case) | `guards4`: "due roles…", "answered: no op made by a due role…" (8 cases, incl. editors fine but all annotators gone), and **both probes as live CLI tests**: "…welcomes and then never sends catch-up…" (stall), "…welcomes once, drops everyone and refuses rejoins…" (crash), plus "a healthy run with `--op-rate 0`… VALID, exit 0" | F1a–F1f |
| 2 LOW | **The `--local` server exits when its parent dies.** `server.js` starts it as `exec bun --preload scripts/load/server.js server/main.js` (still `exec`: the PID sampled and stopped is the server's own) with `PLENARY_LOAD_PARENT` = run.js's PID. In the server, the preloaded file's bottom block checks every 500 ms that `process.ppid` is still that PID; if not it sends itself SIGTERM (main.js's own clean stop) and exits after 5 s if that did not end it. `server/main.js` is unchanged. The workers now get the parent PID the same way (`PLENARY_LOAD_PARENT`, falling back to `process.ppid`), so a parent that died before they started is caught too | `guards4`: "SIGKILL to a --local run mid-load: its server and both workers exit on their own…" (killed after a progress line; server + 2 worker PIDs, polled 4 s), and "a worker whose parent is not the PID run.js named… exits mid-job" (the parent-died-before-start race) | O2, S2a–S2d |
| 3 LOW | `serverStats(pid, samples, loadFrom, genEndAt)` exported from `run.js` (the code that was inline) | `guards4`: "serverStats: loadMean is the load window's CPU…" (idle ramp / 90% load / idle drain: loadMean 90, mean 30) | O4, S3 |
| 4 LOW | `parseOptions` refuses an empty or blank `--url`, `--board`, `--tokens`, `--out`, `--rig` (`--tokens is empty`, exit 2) | `guards4`: "arguments: plain decimals only…" (all 5 flags, `""` and `"  "`), "exit code 2 from the CLI…" (`--tokens ""`) | S4 |
| 5 LOW | Plain decimals only (`/^(\d+(\.\d*)?|\.\d+)$/` for numbers, `/^\d+$/` for counts: `0x1`, `1e3`, `Infinity`, `-1`, a leading blank refused). Upper bounds (`MAX`): counts ≤ 1,000,000; `--procs` ≤ 256; `--pool`, `--viewers-per-user` ≤ 10,000; `--ramp` ≤ 100,000/s; `--duration` ≤ 3,600 s; `--drain` ≤ 600 s; rates ≤ 1,000/s. All stated in the `--help` header | `guards4`: "arguments…" (every bound, refused just past it and accepted at it), "exit code 2 from the CLI…" (`--duration 1e12`, `--editors 0x1`, `--duration 99999`), "--help states the bounds and the due rule" | S5a–S5c |
| 6 LOW docs | README "Server CPU": "same window as below" replaced by each run's own load phase (ramp 4 s for `2000/`, 7 s for `3500/`, 10 s for the 5,000-client runs) | – (docs) | – |
| 7 (R2) | (test only) | `guards4`: "an op acked twice counts one ack; a later op never acked keeps the run INCOMPLETE" (fake server: op 1 ack, ack, entry; later ops entry only; asserts `acks` 1 and not answered) | R2 |

- **Docs also updated:** the README "What the headline means" table and bullets (counted when made, due roles,
  what a no-role-due run reads, what is not ruled on, the argument bounds, the orphan watch); the `run.js` header
  (the `--help` text) and the comment over `ECHO_FLOOR_PCT`.
- **Existing tests changed:** 3 expected strings in `guards.test.js` ("ops sent were never acked" is now "ops made
  were never acked"). `report.md` shows a `made` column, and its headline line counts echoes over ops made.

### What `--op-rate 0` reads, and why

- **No role due** (`--op-rate 0` with no annotators, a viewers-only run, or a rate too low for the duration):
  the run needs no ops: it is judged on its joins (and on any ops that were made) and reads VALID with 0 ops if
  every client joined.
- **Why:** such a run plans no ops, so there is nothing for the server to answer. Ruling "no ops" a failure would
  make every joins-only or fan-out-only run INCOMPLETE. What it cannot see: a stall after the welcome, since
  only ops expose one. The README says so.
- **Tested live:** "a healthy run with --op-rate 0 (no ops due) is judged on its joins: VALID, exit 0".

### Remaining gap (not graded, stated in the README "Not judged")

- **Partial outages:** a run where every due role made some ops and all were answered, but clients were offline
  for much of the run (`ops.skippedOffline` high, `clients.connectedAtEnd` < planned), still reads VALID. Those
  fields are reported, not ruled on.

## Mutations

- **Script:** `…/scratchpad/mutate.js` (scratchpad above), output `mutations.txt`. O2 is p8-load3v's text byte-identical; O4, G3a, G3b and O3 are **[retargeted]** (same intent; the rule now uses `made` and the server CPU moved into `serverStats`); G3c, G3d and R2 are unchanged. A `--dry` pre-flight found every pattern exactly once (0 SKIPs). The tree was diffed clean against the snapshot after each batch.

| Mutation | Result | Failing test(s) |
|---|---|---|
| O2 worker orphan watch disabled | CAUGHT (after the fix below) | SIGKILL mid-load; worker parent-gone |
| O4 [retargeted] server load CPU over all samples | CAUGHT | serverStats |
| G3a [retargeted] answered ignores acks | CAUGHT | answered (guards); R2 test |
| G3b [retargeted] answered ignores the echo floor | CAUGHT | answered (guards) |
| G3c complete ignores answered | CAUGHT | 6 tests, incl. both new live probes |
| G3d headline ignores ops | CAUGHT | 5 tests, incl. both new live probes |
| O3 [retargeted] echo floor `>` | CAUGHT | 3 tests |
| R2 ack counted twice | CAUGHT | an op acked twice… |
| F1a judged on sent, not made | CAUGHT | answered (guards4); live stall |
| F1b a due role with no op passes | CAUGHT | answered (guards4); live crash |
| F1c client never counts made | CAUGHT | 3 live tests |
| F1d due ignores duration | CAUGHT | due roles; answered |
| F1e annotators due on notes only | CAUGHT | due roles |
| F1f headline omits the missing roles | CAUGHT | answered; live crash |
| S2a server orphan watch disabled | CAUGHT | SIGKILL mid-load |
| S2b server not preloaded | CAUGHT | SIGKILL mid-load |
| S2c server gets no parent PID | CAUGHT | SIGKILL mid-load |
| S2d worker parent from ppid only | CAUGHT (after the fix below) | worker parent-gone |
| S3 loadMean = whole-run mean | CAUGHT | serverStats |
| S4 string flags unchecked | CAUGHT | arguments; CLI exit 2 |
| S5a decimal check off | CAUGHT | arguments; CLI exit 2 |
| S5b whole-number check off | CAUGHT | 3 tests |
| S5c no upper bounds | CAUGHT | arguments; CLI exit 2 |

- **O2 and S2d first survived.** My SIGKILL test killed `run.js` as soon as both worker PIDs were logged, before the workers had their job. A worker with no job has only an unref'd timer, so it exits when the IPC channel closes, watch or not.
  - **Checked by hand:** with the watch disabled (O2), a worker given a 60 s job survives its parent's SIGKILL for 5 s or more. With the watch it was gone in about 20 ms in one run; the guarantee is the 1 s check interval.
  - **The fix:** the test now kills after a progress line, and a new test covers the parent-gone-before-start race (S2d). Re-run of O2 and S2a–d: all CAUGHT.

## Gates

- **`bun test test/load` 3 times in my copy, after the last change:** 43 pass, 0 fail each time (59.9 s, 59.8 s, 60.0 s). The baseline was 31; this round adds 12. After that I made one comment-only edit to the `run.js` header (the `--help` text) and re-ran the suite once: 43 pass, 0 fail.
- **`bun test test/architecture.test.js` in the real tree (read-only), after the sync:** 16 pass, 0 fail.
- **`.env`:** `find <copy> -name .env` was empty before every run.

## Housekeeping

- **Before:** postgres 48326 and nats-server 48406 (another session's scratchpad), and two `server/main.js` from the real tree (54990, 55039). None were mine.
- **After:** postgres 85454 and nats-server 85493 (another session's). The two earlier `main.js` were no longer listed; I never stopped or signalled them, or any of these.
- **Callers of `startServer`:** grepped the real tree, untracked files included. Only `scripts/load/run.js` and `test/load/*` use it, so the always-on orphan watch stops no rig or other launcher's servers.
- **README fix 6 numbers:** checked against `2000/` and `3500/` `result.json`: `rampMs` 4000 and 7000, `duration` 20.
- **Mine:** after every batch and gate, and again after the final probes, `ps` for anything under my scratchpad found nothing. Every test and probe stops its own children; the SIGKILL test also kills any survivor by PID in `finally`.
- **Scratch left in my scratchpad:** `copy`, `snap`, `orig`, `o2` (the O2 check), `probes`. None hold a `.env`.

## Not verified

- **Copy vs real tree:** the copy used HEAD's `packages/` and `server/`. The real tree has other sessions' uncommitted edits in `packages/protocol/{envelope,replica}.js` and `server/*`, and I did not run `test/load` against them (the brief puts the gates in the copy).
- **Partial outages:** these still read VALID (see "Remaining gap" above).
- **Server orphan watch on Linux:** tested on macOS only. It relies on `process.ppid` changing when the parent dies, which is also true on Linux, but that is unverified here. It also assumes that `server/main.js` stops on SIGTERM; it does in every test, and a 5 s `process.exit` fallback is there if not.
- **Server watch timing:** in the gap between run.js spawning `sh` and the preload running, a parent death is caught only through the explicit PID (`process.ppid` ≠ `PLENARY_LOAD_PARENT`). For the server that gap is checked only by reading. S2c (no parent PID) is caught, but through the mid-load SIGKILL test, not this race.
- **Live rig:** `--rig` not run, as before.
