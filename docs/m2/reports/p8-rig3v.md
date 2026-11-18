# Report: p8-rig3v (verify p8-rig3, round 3 of the local cluster rig)

**Verdict: FAIL (round 3), on one HIGH (A).** Round 2's H2 outcome comes back by a new route: one transient `ps`
failure while `up` probes a server it just spawned leaves that server running and unrecorded.
- **Live result with Postgres:** an unrecorded postmaster keeps running. `down` stops nothing, and a second `up`
  wipes `pg/` under it and runs initdb again. Two postmasters were left running.
- **Cause:** `up`'s cleanup stops children by handle (`stopKids`) only when `stopRig` throws. If `ps` works again by
  then, `stopRig` succeeds and never sees the unrecorded child.
- **Fix:** about one line (below).
- **Grade:** the trigger is narrower than round 2's H2. It needs a `ps` that fails once and then recovers, for
  example EAGAIN or EMFILE under a process or file limit during a load test (not reproduced live). The damage is the
  same as H2, so I grade it HIGH; the manager may regrade on likelihood.

Everything else the brief asked for holds, apart from the LOWs below:
- **H2:** every broken-`ps` kind refuses, including a hanging `ps` (refusal after 10 s) and the old-format path.
- **M3:** 2- and 3-way concurrent `up`s, with and without a stale lock: exactly one proceeded in all 15 runs.
- **L6:** a moved live rig is driven entirely from the new dir.
- **Leaks:** SIGTERM and SIGINT of a test run leave nothing (at 8 s and 16 s). For a CLI `up`, my runs hit only one mid-`up` point per signal (300 ms, the Postgres wait). The later points are covered by the builder's SIGTERM, SIGINT and SIGHUP tests, which pass.
- **Segments:** every real SIGKILL of a postmaster had its segment removed (13 of 13: 10 through rig-guard and 3 through `down`'s own escalation).
- **e2e:** real cluster mode, 3 of 3 alone and in 3 full gate runs.
- **Mutations:** every builder mutation fails a test.
- **Gates:** green.

Worked in copies under my scratchpad (`pl/`, `plmut/`, `plslow/`; rsync with `--exclude .env --exclude .rig
--exclude .git`, node_modules symlinked). There were no edits, mutations or rig runs in /Users/r/repos/plenary. The
only file written there is this report. Nothing was committed.

## Findings

| # | Grade | Finding | Where |
|---|---|---|---|
| A | HIGH | A transient `ps` failure in `launch` leaves the just-spawned server running and unrecorded: `stopKids` runs only if `stopRig` throws | scripts/cluster-rig.js:239, 474-478 |
| C | MEDIUM | If `save` fails inside `up` (rig.json unwritable), the catch's own `save(rig)` throws before any cleanup runs, so everything started stays running | scripts/cluster-rig.js:470-471 |
| B | LOW | Stale-lock takeover with three `up`s: the put-back can fail silently, so two `up`s hold the lock and one wipes the dir under the other's initdb. Already listed in RIG.md "Known limits" ("not seen, not tested"); now seen, with injected delays only | scripts/cluster-rig.js:285-291; deploy/cluster/RIG.md:128-129 |
| D | LOW | `removeOrphanShm` is one-shot: if a backend is still attached when the postmaster dies, NATTCH > 0 and the segment is kept for good. Never seen (13 of 13 removed, up to 46 attached) | scripts/cluster-rig.js:505, 256 |
| E | LOW (nit) | Compose comments (`diff` against the builder's `orig/` shows comment-only changes in this round; the YAML role changes predate it): line 72 ("Each node mints its own dev board") is true only per gateway node; lines 19-20 cite deploy/README.md's "not functional yet" heading, and README (not the builder's file) still says main.js does not use the Postgres adapters (README:10, 87) | deploy/cluster.compose.yml:19-20, 72; deploy/README.md |

### A: a transient `ps` failure leaks the unrecorded child (HIGH)

`launch` keeps the child's handle in `kids`, then calls `psInfo(child.pid)`. If that throws, the proc is never
recorded and `startRig`'s catch runs `stopRig(dir)`. `stopRig` reads rig.json, and `psCheck` passes because `ps`
works again. It stops only what is recorded and returns normally, so the `catch (stopErr)` branch with `stopKids`
never runs.

**Repro (in-process, copy):** `_setPsPath(flaky-ps.sh)`, a stub that fails once (exit 2) on the first probe of a PID
whose command matches a pattern and otherwise execs /bin/ps. Scripts: `atk/transient.js`, `atk/transient-pg.js`.

| Pattern | `up` result | Left running | `down` | Second `up` on the dir |
|---|---|---|---|---|
| `nats-server` | throws "cannot check processes … exited 2"; rig.json `failed [postgres]` | nats-server 26907 (unrecorded) | cannot know it | not tried |
| `postgres -D` | throws the same; rig.json `failed []` | postmaster 52392 (unrecorded) | "stopped nothing" | **exit 0: `pg/` wiped under 52392** (a sentinel in `pg/` gone), initdb re-run; 52392 and the new 52451 both running |

**Fix:** in the catch, always run `await stopKids(kids, …)` after `stopRig`, whether or not it threw. `stopKids`
already skips children that have exited. **Test:** the existing "ps failing in the middle of `up`" test, but with a
`ps` that fails once and then recovers.

The builder's mid-`up` test uses a `ps` that stays broken, so `stopRig` refuses and the fallback runs. Neither the
test nor the mutation set covers a `ps` that recovers. codex and grok both missed this; it was found by reading and
confirmed live.

### C: an unwritable rig.json skips all cleanup (MEDIUM)

`startRig`'s catch starts with `rig.state = "failed"; save(rig);`, outside any try. If the failure was itself a
`save` error (disk full, EACCES, a directory at `rig.json.tmp`), that `save` throws again. Then neither `stopRig` nor
`stopKids` runs.

**Repro (`atk/savefail.js`):** `onStep` creates the directory `rig.json.tmp` at "nats: starting".
- **Result:** `up` throws EISDIR, and postgres 91149 and nats-server 91179 are left running.
- **Recovery:** `down` (after removing the directory) stopped postgres, which was recorded. NATS was not recorded, so
  I stopped it by PID.

**Fix:** wrap that `save` in try/catch.

### B: three `up`s and a stale lock (LOW)

Sequence: B reads the stale lock. A clears it and links its own lock. B renames A's lock aside, sees different
content, and tries to link it back. C linked a new lock in between, so B's `linkSync` fails silently
(`catch {}`, :288) and B deletes A's lock (:289). A and C both hold the lock.

**Repro:** in the instrumented copy `plslow`, env-driven sleeps go before and after B's rename (`atk/race3t.js`).
- **Result at SB=600, TA=100, TC=700:** A and C both printed "postgres: initdb". C's initdb failed. That C's wipe ran under A's initdb is inferred from this output and the code path, not seen directly. A came up (exit 0), and `down` then stopped everything.
- **Other timings:** C either refused on A's live rig or refused at the lock.

**Uninstrumented:** 0 of 15 bad (`atk/race.js`: 3-way ×4, 3-way with a stale lock ×8, 2-way ×3).
**Grade:** LOW. It needs a stale lock plus 3 `up`s inside a sub-millisecond window, and it is documented. codex
found it independently (it graded it MEDIUM).
**Fix:** RIG.md should name the effect (a wipe under a starting rig), not only "lock replaced". In code, never delete
the aside file when the put-back fails, and refuse instead.

## Checks run (all in copies)

### H2

| Check | Result |
|---|---|
| Builder's matrix (7 broken + 4 late stubs × status/kill/down/up), run as part of the gates | passes |
| **Hanging `ps`** (`exec sleep 30`), live rig (`atk/hang.js`) | status, kill, down and up each refuse after 10.0 s with "cannot check processes"; rig.json byte-identical; `pg/` kept; no lock left; all 4 procs alive; no stray `sleep` |
| **Old-format rig.json** (no startedClock, a live `sleep` decoy) with real, hanging, late-exit-2 and "absent for all" `ps` (`atk/oldfmt.js`) | real ps: the L8 refusal; every broken kind: "cannot check processes"; rig.json identical, `pg/` kept, decoy alive |
| CLI with PATH lacking ps (builder's test) | passes in all gate runs |
| Started but unrecorded child, failed `up` | **A** (transient) and **C** (save failure) leak; ps that stays broken: stopped by handle (builder's test) |
| Started but unrecorded child, `up` SIGKILLed in the spawn-to-save gap | documented limit (RIG.md:125). 12 targeted SIGKILLs (polling `pgrep -P <up>` for nats-server, stub-node and caddy) never landed in the gap: `recorded-at-kill true` every time, and `down` left nothing |

**Residual, by reading:** the self-probe proves only that `ps` sees this process. A `ps` that sees only the
caller's own processes (for example under a restrictive sandbox) would read the rig as gone. Not tested.

### M3 and lock

See B. Also covered by the builder's tests: a live lock owner refuses, a stale lock (dead owner or reused PID) is
cleared, and the initdb-window refusal.

### L6

I moved a live real-main rig (`mv rig-real-HnX6 rig-moved-HnX6`).
- **`status --json`:** `dir` and every path (tokensFile, keysFile, logsDir, node dataDir and log, proc logs) resolve
  under the new dir, and all 6 are alive.
- **Commands:** `kill gw-2` and `down` worked from there.
- **Old dir:** not recreated. I did not check every write elsewhere.

### Leaks and segments

Baseline before my work: 3 segments, not mine (41877504, 75300865, 61931522; creators gone; listed in p8-rig3's
report).

| Run | Result | Segments |
|---|---|---|
| CLI `up` SIGTERM / SIGINT at 300 ms (mid-`up`) | exit 1 "aborted while waiting for postgres"; nothing left | 3→3; 6→6 |
| CLI `up` SIGKILL at 300 ms, then `down` | nothing left | 9→10, back to 3 later (below) |
| Delays of 1.2, 2.2 and 3.5 s | `up` had already finished (exit 0); not a mid-`up` point. I took those rigs down | rose with live rigs, back to 3 |
| `bun test test/deploy` SIGTERM at 8 s and 16 s | exit 143, 0 left, 0 rig dirs left | 3→3 |
| `bun test test/deploy` SIGINT at 8 s and 16 s | exit 130, 0 left, 0 rig dirs left | 3→3 |
| `bun test test/deploy` SIGKILL at 8 s and 16 s | leaks, as documented: 1 and 1 rig left running. `down` on each leftover rig dir stopped them all | 3→4→5, back to 3 after `down` |
| Real postmaster SIGKILLed through rig-guard `killRecorded`: 7 with stub nodes (6 attached) and 3 with real main.js (46 attached) | segment removed 10 of 10 | 3→3 |
| Real postmaster (real main.js attached) SIGSTOPped, then `stopRig(dir, { graceMs: 500 })` escalates to SIGKILL (the product path; `atk/stopkill.js`) | `forced [postgres]`; segment removed, 3 of 3 | 6→6 |

**The 9→10 step:**
- **What it was:** segment 9895944, creator 81163, NATTCH 6.
- **Gone by itself:** it disappeared 2 s later, before I touched anything.
- **Whose:** not shown to be mine. `ps` no longer showed 81163, and no process naming my scratchpad was running.
  It was most likely another session's Postgres, but that is unverified.

**Can removeOrphanShm remove a segment that is not the rig's?** By reading and by the stub tests, no, within one user.
- **What it removes:** only the `{key, id}` from the rig's own `pg/postmaster.pid`, whose line 1 must equal the
  recorded postmaster PID.
- **When:** only after that postmaster is gone, and only if `ipcs` lists that exact id with that key and NATTCH 0.
- **id reuse:** macOS ids carry a sequence number, so a reused id would also need the same key, inside milliseconds.
- **Another user's segment:** `ipcrm` fails with EPERM.
- **Another session's live Postgres:** its NATTCH is at least 1.
- **Residual:** a same-user process able to write `pg/postmaster.pid` could point it at another zero-attach segment.
  That is a trust boundary the rig does not claim.
- **codex's MEDIUM** ("matches ids but does not prove ownership") is this same point. I refute it as a defect, since
  the pair comes only from the rig's own postmaster.pid, checked against the recorded PID.

### e2e

**Real cluster mode, confirmed live** (CLI `up` on HEAD's main.js, logs read):
- **Adapters:** every node logs `{"store":"postgres","registry":"postgres","bus":"nats"} cluster adapters open`.
- **Roles:** gw-1 and gw-2 log `roles {gateway:true, host:false}`; host-1 logs `{gateway:false, host:true}`.
- **Topology:** one shared Postgres and NATS. Caddy routes to the gateways only (the generated Caddyfile).

**Test results:**
- **Alone:** `bun test … -t e2e` gave 1 pass, 0 fail in each of 3 runs.
- **Full gate runs:** it ran in each of the 3.

**Hidden skips:**
- **The whole describe:** `describe.skipIf(SKIP)` at test/deploy/cluster-rig.test.js:53. It skips when a binary is
  missing, with a console warning, and exits 0. That is a silent pass on a machine without the binaries.
- **The 1 skip:** cluster-rig.test.js has 22 + 4 = 26 tests, so 26 pass and 1 skip pin that skip to the fixture.
- **e2e:** no other skip.

### p4-wire constraints

| Constraint | Result |
|---|---|
| NATS has no auth, in compose and in the rig | compose `NATS_URL: nats://nats:4222`, and cluster/nats.conf has no authorization block. The rig's nats.conf is listen, http, max_payload only |
| Every app node sets PLENARY_ROLES | compose app-1 gateway, app-2 gateway, app-3 host; the rig passes `gateway` or `host` to every node |
| Node ids start and end alphanumeric | compose app-1..3; rig gw-N and host-N |
| Stale compose comments | header and env block updated; see **E** for the leftovers |

### Regressions (rounds 1 and 2)

- **Live, on a real-main rig:**
  - **Binding:** every listener is on 127.0.0.1 (postgres, nats and its monitor, 3 nodes, caddy).
  - **File modes:** keys.json, tokens.json and every log are 0600.
  - **Secrets:** 107 secrets (2 keys and 105 tokens), 0 found in logs/* and rig.json.
  - **rig.json paths:** relative.
- **By tests in the gates:** TZ/locale identity, only-ours teardown, and secrets in stdout and `status --json`.
- **By the regression mutations:** see the second table below.

## Mutations

Each mutation was applied alone in `plmut`, followed by a full `bun test test/deploy` and a restore, using
`atk/mut.py` and `atk/mut2.py`. After the batch, `cmp` showed both files identical to the real tree.

**The builder's mutations:** all 24 fail a test, each in the guard's own test.

| Mutation | Fails (tests) |
|---|---|
| H2 repro (round-2 `psInfo`: PATH `ps`, null on any failure, no self-probe) | 3: H2 CLI no-ps-on-PATH; H2 any-failure; H2 mid-`up` |
| `ps` via the caller's PATH only | H2 CLI no-ps-on-PATH |
| spawn error, killed `ps`, unexpected output, or no self-probe reads as absent (4 mutants) | H2 any-failure (each) |
| non-zero exit reads as absent | H2 any-failure; H2 mid-`up` |
| failed `up`: no handle fallback | H2 mid-`up` (+ M3 stale-lock test) |
| `launch` does not keep the handle | H2 mid-`up` |
| no up lock / lock: live owner ignored | both M3 tests (each) |
| lock: stale never cleared | M3 lock test |
| wipe removes the lock too | M3 initdb-window test |
| L6 stored absolute | L6; secrets test |
| L6 absolute not rebased | L6 |
| L8 old message | old-format test. In batch 1 it also failed "Leaks: abort between spawns"; a rerun alone on a quiet machine failed only the old-format test |
| `up` ignores SIGHUP | CLI SIGHUP during `up` |
| no abort check before a spawn | Leaks: abort between spawns (the same result when rerun alone, on a quiet machine) |
| test runner has no signal handlers (rig-guard) | Leaks: a test run killed midway |
| shm: NATTCH check dropped / key check dropped | removeOrphanShm test (each) |
| shm: `down` removes no segment | down SIGKILL segment test |
| shm: pgShmOf ignores the postmaster PID | pgShmOf test |
| shm: rig-guard removes no segment | rig-guard segment test |

**Round 1 and 2 regression mutations:** all 7 fail a test.

| Mutation | Fails |
|---|---|
| `PS_ENV` without TZ (TZ from the caller) | CLI identity ignores TZ and locale |
| `isOurs` ignores the start time | down and kill only signal a matching PID; M3 lock test |
| `status` prints the tokens | CLI keys and dev tokens never reach stdout |
| `baseEnv` spreads `process.env` | up: env contract |
| Postgres `listen_addresses=*` | up: env contract |
| keys and tokens 0644 | CLI keys and dev tokens |
| `loadRig` keeps the file's `dir` (M1) | copied rig.json test; L6 |

**My own mutations:** 1 of 6 is killed, and only by an unrelated, flaky test. 5 survive, and 2 of those 5 are test
gaps.

| Mutation | Result | Reading |
|---|---|---|
| stale takeover without the content re-check (no put-back) | **survives** | test gap; the code path behind **B** |
| `releaseLock` removes any lock, even one that is not ours | **survives** | test gap (low impact) |
| a zombie reads as alive | survives | probably equivalent: `launch` children are reaped by Bun, and `stopKids` uses handles |
| segment removed while the postmaster is still ours | survives | equivalent in practice: NATTCH ≥ 1 while it lives |
| no `psCheck` before the dir is touched in `startRig` | fails only "Leaks: abort between spawns" (collateral) | equivalent: `acquireLock` probes this process with `ps` before touching anything |
| no abort check after initdb | survives | equivalent: `launch` checks the abort before the postgres spawn |

**Flaky test:** "Leaks: an abort between spawns…" failed under two unrelated mutants ("L8 old message" and "no
psCheck"). It passed in every gate run and in both reruns. The cause was not found by reading (test/deploy/cluster-rig.test.js:305-316). The test is possibly timing-sensitive; not proven.

## sdd ensemble review

The harnesses got a review-only dir (`scratchpad/rev`) holding the 4 code and test files, RIG.md, compose, and
p8-rig3.md and p8-rig2v.md. It contained no .env and no json.

| Harness | Result |
|---|---|
| codex (effort high) | FAIL. MEDIUM: the 3-way stale-lock race (= B, confirmed with instrumentation). MEDIUM: `removeOrphanShm` does not prove ownership (refuted above) |
| grok | PASS, no findings. It asserts that a process started but not recorded is always stopped; **A** refutes that live |
| agy | not tried (quota exhausted in round 1) |

## Distributed-systems-design (CHECKER)

This is test tooling. The design-bearing part is M3's lock, a lease with an identity-checked stale takeover.
- **Normal case:** it works.
- **Weak point:** the takeover is "rename aside, compare, put back". That is not a compare-and-swap, so with 3
  contenders the put-back can fail and a lock is lost (B).
- **The product does the same thing correctly:** one sequencer per board, with takeover by a conditional write on a
  fenced lease. The rig would need the equivalent, for example an exclusive `up.lock.break` that is taken before
  breaking a stale lock.
- **Recovery:** A is the same lesson as round 2's H2. The cleanup must not depend on the observer (`ps`) agreeing
  with the actor (the handles it holds).

## Gates

| Run | Where | Result |
|---|---|---|
| `bun test test/deploy` #1 | copy `pl` | 26 pass, 1 skip, 0 fail (31.49 s) |
| #2 | copy | 26 pass, 1 skip, 0 fail (31.11 s) |
| #3 | copy | 26 pass, 1 skip, 0 fail (31.50 s) |
| e2e alone ×3 | copy | 1 pass, 0 fail each |
| `bun test test/architecture.test.js` | real tree, read-only | 16 pass, 0 fail |

**.env check:** `find <copy> -name .env` returned 0 before the gates, the attack runs, the mutation copy and the
review copy. It was not rerun before every single run, but nothing in my runs creates a .env.

## Housekeeping

**Engram:** I did not search it for this job; everything above comes from the repo and live runs.


**Before my work:**
- **Segments:** 3 (41877504, 75300865, 61931522; created 16:52, from p8-rig3's run).
- **Not mine:** nats-server 85354 (`/var/folders/.../plenary-rig-ng9jwi`), two `bun …/457170b9…/base/server/main.js`
  (86534, 87057), and other workers' `bun test` runs.

**Stopped by me, by PID:** each named my scratchpad in its command line, and I checked each with `ps` first. All were
confirmed gone.

| PIDs | What | Signal |
|---|---|---|
| 26907 | nats-server leaked by repro **A** | SIGTERM |
| 52392 | postmaster leaked by repro **A** (pg variant), after `down` of the second rig | SIGINT; its segment 86310915 was removed by Postgres itself |
| 91179 | nats-server leaked by repro **C** | SIGTERM |
| 9944, 49686, 54663 | nats-servers leaked by mutants in batch 1 | SIGTERM |
| 61020, 61023, 61025, 61029, 61033 | nats, 3 stub nodes and caddy leaked by the "`PS_ENV` without TZ" mutant | SIGTERM |

Every other rig I started was stopped with its own `down`.

**After:**
- **My processes:** none.
  - **Name sweep:** no process names my scratchpad.
  - **Pattern sweep:** `ps -axo … | grep -E "sleep (30|60|120|300)$|postgres:"` finds nothing (no stub `sleep`, decoy or orphaned backend).
- **Never touched:** 85354, 86534, 87057, and other sessions' processes. I used no pkill and no killall.

**Segments: 3 before, 6 after.**
- **The 3 new ones:** 88932355, 127598596 and 10616838. All have NATTCH 0, and their creators (62398, 67766, 76193)
  are gone.
- **When:** created at 17:15:59, 17:16:29 and 17:17:30, inside my first mutation batch (17:10–17:26).
- **Likely cause:** the leak-guard mutants ("no handle fallback", "launch handle", lock mutants), whose rigs the test
  teardown then SIGKILLed.
- **Not removed:** I could not prove they were mine, because the creating processes and their rig dirs are gone, so
  I ran no `ipcrm`.
- **Unmutated runs added none:** 3 gate runs, the e2e runs, all attack probes, and 13 real SIGKILLs.

**Files I wrote:**
- **Real tree:** only this report. Nothing was committed.
- **Scratchpad:** copies `pl/`, `plmut/` (restored, `cmp`-identical to the real tree), `plslow/` (instrumented,
  B only) and `rev/`; scripts in `atk/`; gate outputs `gate1-3.txt`; mutation outputs `atk/mut-out.txt`.
  - **Rig dirs:** under `tmp/` and `tmpk-*/`, all down. Some hold 0600 keys.json and tokens.json from rig runs.

**What you need to do (t187):**
- **A:** send it to a fix round. The fix is "always `stopKids` after `stopRig`", plus a recovering-`ps` test.
- **C:** a one-line try/catch.
- **The 3 segments:** decide what to do with them (`ipcs -m -o -p`; NATTCH 0, creators gone).
