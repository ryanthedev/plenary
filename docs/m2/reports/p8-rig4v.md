# Report: p8-rig4v (verify p8-rig4, round 4 of the local cluster rig)

**Verdict: PASS (round 4).** A, C, B and D are fixed, and every attack on them held. What is left is 6 LOWs, all docs, wording or bounds, none of them a leak or a safety hole.
- **A (HIGH, round 3):** I re-ran round 3's own repros, then swept a `ps` that fails once, or twice, at every
  possible call position in `up`, and one that hangs. No failed `up` left anything running. A second `up` on the dir always ran exactly one postmaster, and
  the new guard refused live to wipe `pg/` under an unrecorded postmaster.
- **C (MEDIUM):** round 3's repro plus 6 ways to make `save` fail, at 4 different steps. Cleanup always ran and nothing
  was left. (Two more attempts, garbage in `rig.json`, made nothing fail.)
- **B (LOW):** races with 2, 3 and 5 `up`s, with and without a stale lock, with a left-over break lock, and with
  injected delays. I also killed the break holder at 3 points. There were never two holders, and every refusal names its cause or the file to remove.
- **D (LOW):** the retry can only remove the rig's own segment. The 5 s bound is a wait budget, not a wall-clock limit:
  it ran 6.1 to 10 s with a slow `ipcs` (L1).
- **Mutations:** 14 of 14 killed (the builder's 10 plus 4 of mine).
- **Gates:** 3 of 3 green.
- **Housekeeping:** nothing of mine is left. Shared-memory segments are the same 6 ids before and after.

I worked only in copies under my scratchpad (`pl/`, `plmut/`, `plslow/` instrumented, `rev/` for review). Each was made
with rsync `--exclude .env --exclude .rig --exclude .git`, with node_modules symlinked. Every run except the mutation
batch went through `atk/run.sh`, which refuses if any `.env*` exists in `pl/`, `plmut/` or `plslow/`, sets
`TMPDIR=<scratchpad>/tmp`, and logs to `atk/ledger.txt`. The mutation batch (`atk/mut.py`) runs its own `.env` check on
`plmut` before each mutant and sets the same TMPDIR. `rev/` holds no `.env` (checked with `find` at the end). In the real tree, the only file written is this report. I ran test/architecture.test.js there read-only.
Nothing was committed. The real tree's rig, deploy and server files have the same shasums before and after my work
(40 files).

Scratchpad: `/private/tmp/claude-501/-Users-r-repos-plenary/754f5965-3136-4803-8e51-031f0e9be9d4/scratchpad`

## Findings

| # | Grade | Finding | Where |
|---|---|---|---|
| L1 | LOW | `removeOrphanShm`'s "up to 5 s" is checked only after each `ipcs` call, and each `ipcs`/`ipcrm` has its own 10 s timeout. With NATTCH stuck at 1, I measured 6.1 s (`ipcs` taking 3 s per call), 9.0 s (9 s) and 10.0 s (hanging). Worst case is about 5 + 10 + 10 s. There is no safety effect: it still removes nothing it shouldn't. But RIG.md says "waited for (up to 5 s)". codex found this too (it graded it MEDIUM; I grade it LOW, because a real `ipcs` answers in milliseconds) | scripts/cluster-rig.js:143-151, 153; deploy/cluster/RIG.md (SIGKILL of Postgres) |
| L2 | LOW | Compose header lines 10-12 are stale against p4-wire2. They say an empty `DATABASE_URL`/`NATS_URL` "mean single node", but main.js:100-101 now refuses a URL that is set but empty, whatever the roles. They also say "NATS stays without auth for now: the bus drops user:pass … engine's fix pending", but server/bus/nats.js:82-111 now passes the credentials, and RIG.md already says so. The builder updated RIG.md's env rules but not this block. Lines 19-20 and 72-74 (round 3's E) are now true | deploy/cluster.compose.yml:10-12 |
| L3 | LOW | RIG.md's known limit says a left-over `up.lock.break` makes "every later `up` refuse". That is true only when the breaker died before removing the stale lock. Killed after removing it (live: SIGKILL in an injected sleep right after `rmSync(lock)`), the next `up` takes `up.lock` directly and succeeds, and the break file stays in the dir. The wipe keeps lock-named files, so the next stale lock, maybe much later, refuses and names the file then. That refusal is safe and clear; the doc is just imprecise | deploy/cluster/RIG.md (Known limits); scripts/cluster-rig.js:342, 391 |
| L4 | LOW (nit) | A SIGKILLed `up` leaves `up.lock.<pid>.tmp`. `isLockFile` keeps it through every wipe, so these files pile up (seen live in all 3 kill runs). Harmless | scripts/cluster-rig.js:302, 336, 342 |
| L6 | LOW | `livePostmaster` fails open: an unrecorded live postmaster whose `postmaster.pid` line 3 is more than 5 s off its `ps` start time does not block the wipe. Measured skew 0 s in 7 of 7 (4 under load). Disclosed by the builder; flagged by codex (HIGH) and grok (MEDIUM, on a misreading); regraded above | scripts/cluster-rig.js:169 |
| L5 | LOW (nit) | Failed-`up` messages. (a) "stopping by rig.json failed (…), so stopped this up's own children instead: X" lists only what `stopKids` stopped. In the C runs, `stopRig` had already stopped postgres before its final `save` threw, so the text reads as if only X was stopped, or "none running" when everything was. (b) A hanging `ps` is reported as "did not run (ETIMEDOUT)" | scripts/cluster-rig.js:523, 94 |

### Refuted or regraded from the ensemble

| Source | Claim | Ruling |
|---|---|---|
| codex HIGH | `livePostmaster` fails open if `postmaster.pid` line 3 is more than 5 s off the `ps` start time, so `up` would wipe `pg/` under a live postmaster | **True as code, regraded to L6 (LOW); the builder disclosed it.** Measured: line 3 minus the `ps` start time was **0 s in 7 of 7** real postmasters (`atk/skew.js`), 4 of them while a full `bun test test/deploy` ran beside them. So it fails open only if someone edits the file or exec stalls for over 5 s. It is also the second line of defence: always-`stopKids` is the A fix, and my sweep found no route to an unrecorded postmaster that the guard would have to catch |
| grok MEDIUM | The 5 s check compares against "now", so any postmaster started more than 5 s ago is treated as a reused PID | **Refuted.** It compares line 3 with the same process's `ps` start time, not with now. Live: a real postmaster that had been running for over 10 s blocked `up` (guard check below) |
| grok LOW | RIG.md is wrong that `down`/`status`/`kill` do not take the lock | **Refuted.** They don't (cluster-rig.js:535-578 never touches `up.lock`) |
| codex LOW | RIG.md:123 ("Only a SIGKILLed `up` leaves processes; they are in rig.json") overstates it | Nit. The same doc's Known limits names the spawn-to-save gap. Folded into no finding |

## Checks

### A: transient `ps` failure (round 3 HIGH)

**0. Round 3's own scripts, as written (marker paths rewritten; both markers `fired` and `fired-pg` appeared):**
- **`transient.js` (nats):** throws "cannot check processes … exited 2"; rig.json `[postgres]`; nothing naming the dir
  runs (round 3: nats-server left running).
- **`transient-pg.js`:** after the failed `up`, nothing runs and postmaster.pid is gone. `down` stopped nothing. The
  second `up` exit 0 with one postgres (round 3: two postmasters). The wipe of the sentinel here is correct, since no
  postmaster was alive. I took that rig down with `down`.
- **`savefail.js`:** EISDIR, running `[]` (round 3: postgres and nats left).

**1. Targeted variants.** The new The new
`nth-ps.sh` fails exit 2 on chosen probe numbers of a PID whose command matches, and logs each failure (`atk/nth.log`).
Every run asserted that the failure fired.

| Target | Probes failed | Result |
|---|---|---|
| nats-server | 1 | `up` throws "cannot check processes … exited 2"; rig.json `failed [postgres]`; **nothing left**; second `up` ok, 1 postmaster |
| postgres -D | 1 | throws; rig.json `failed []`; nothing left; `pg/postmaster.pid` gone; second `up` ok, 1 postmaster |
| stub node | 1 | throws; `[postgres, nats]` recorded; nothing left; second `up` ok |
| any of the three | 2, 3, {2,3}, {2,4}, {3,4,5} | never fired during a successful `up`: each server answered its first health poll, so `waitFor` never probed it again. In a failed `up` these probes are `stopRig`'s, which the sweep below covers |

**2. Exhaustive sweep (`atk/nth.js any`).** A successful 1-gateway `up` makes 7 `ps` calls in all. I failed call N
alone, N with N+1, and N with N+2, for N = 1..26 (78 runs).

| Result | Runs |
|---|---|
| Refused before the dir was touched (N = 1, 2: `psCheck`, the lock self-probe); nothing spawned. My script then crashed reading the missing rig.json, so these 6 had no leak check of their own, but nothing had started | 6 |
| `up` failed, **0 processes left**, no postmaster.pid, each in about 0.5 to 0.8 s (so `stopKids` does not wait out its 10 s grace) | 15 (N = 3..7, every pairing, including failures inside `stopRig`) |
| N past the last call: `up` ok, then downed | 57 |
| Second `up` on the same dir | **72 of 72 ok, exactly 1 postmaster, nothing left after `down`** |

**3. `ps` that hangs once (`exec sleep 30`, cut at the 10 s timeout) at calls 4, 5 and {5,6}.** `up` refused after 10.6,
10.7 and 20.6 s, nothing was left, and the second `up` was ok with 1 postmaster.

**4. The guard, live, with real main.js.** I started a full rig (2 gateways and 1 host), dropped `postgres` from
rig.json's procs, ran `down` (which stopped the other 5), and put a sentinel in `pg/`. Then `up` gave:

> exit 1: "a postmaster (pid 9121) not recorded in rig.json is still running on …/pg; stop it (kill -INT 9121) before up"

The sentinel was kept. I then stopped 9121 with SIGINT.

### C: failing save

`atk/c.js` acts at one step through `onStep`. In every run below, **nothing was left running**.

| Attack | At | Result |
|---|---|---|
| `rig.json.tmp` made a directory | postgres: initdb (the save inside `launch` fails, so postgres is unrecorded) | EISDIR; stopped postgres by handle |
| same | nats: starting (round 3's repro) | EISDIR; stopRig stopped postgres, stopKids stopped nats |
| same | node gw-1: starting | EISDIR; stopped |
| same | lb: starting | EISDIR; stopped |
| rig dir chmod 0500 | nats: starting | EACCES; stopped; `up.lock` left (it cannot be removed in a read-only dir; stale, so the next `up` clears it) |
| same | lb: starting | same |
| `rig.json` overwritten with garbage | nats or lb: starting | not a failure: the next `save` rewrites it, so `up` succeeds; then downed |

### B: lock

**Uninstrumented, CLI (`atk/race2.js`).** Every run had exactly 1 holder and 1 exit 0. `down` exited 0, nothing was
left, and no `up.lock*` file remained.

| Contenders | Stale lock | Runs |
|---|---|---|
| 2 | yes | 5 |
| 3 | yes | 8 |
| 3 | no | 4 |
| 5 | yes | 3 |

**Left-over break lock, uninstrumented.** I planted `up.lock.break` with a dead owner:

| Case | Result |
|---|---|
| Plus a stale lock, 2 and 3 concurrent `up`s (2 runs each), and 3 concurrent CLI `up`s once more by hand | **0 holders**. Every `up` refuses: "…/up.lock.break was left by an `up` that stopped while clearing a stale lock; if no `up` is running on …, remove that file". Both files are kept |
| No stale lock, 3 concurrent `up`s (2 runs) | exactly 1 holder (the break lock is never consulted); `up.lock.break` stays (see L3) |

**Instrumented (`plslow`: env-driven sleeps after the stale judgement J, after taking the break lock A, and after
removing the stale lock B).**

| Case | Result |
|---|---|
| Breaker SIGKILLed while holding break (after A) | stale `up.lock` and `up.lock.break` left. Next `up` refuses: "…/up.lock.break was left by an `up` that stopped while clearing a stale lock; if no `up` is running on …, remove that file". After removing it, `up` exit 0 |
| Breaker SIGKILLed after removing the stale lock (B) | next `up` takes the lock and succeeds; `up.lock.break` stays (L3) |
| `up` SIGKILLed after judging stale (J) | next `up` clears the stale lock and succeeds |
| Live breaker (A = 3 s) plus a contender | contender refuses "another `up` (pid N) is clearing a stale lock"; the breaker succeeds |
| Races with a stale lock, J delays {500,500,500}, {0,600,600}, {0,300,800}, {300,300,0}, {0,0,700}, 5 × 400 (2 runs each) | **always exactly 1 holder and 1 exit 0**; the others refuse ("starting the rig" or "clearing a stale lock"); no `up.lock*` left |

**Message race, by reading:**
- **The case:** a contender reads a live breaker's file, and the breaker then finishes and releases it before the
  contender's `isOurs`.
- **Outcome:** the contender says "left by an `up` that stopped … remove that file" when no such file is there.
- **Grade:** wording only. It is still a refusal, and running `up` again works.
- **Not forced live.**

**distributed-systems-design, CHECKER mode on the lock:**
- **Safety:** the takeover is now a mutual exclusion one level up, with a compare under it, which is CP. It is safe
  because a new `up.lock` can only be linked once the stale one is gone, and only a holder of the break lock removes
  it, so the re-read identity proves the lock is still the same stale one.
- **Liveness:** liveness is given up only after a crash inside the microseconds-long break critical section, and that
  surfaces as a refusal that names the file.
- **What I found:** no interleaving with two holders, in the instrumented races or by reading.

### D: segment retry

**By reading, the retry cannot remove a segment that is not the rig's:**
- **What it removes:** only `{key, id}` from the rig's own `pg/postmaster.pid`, whose line 1 must equal the recorded
  postmaster PID. Callers call it only once that postmaster is gone.
- **Every try:** id, key and NATTCH are all re-checked.
- **Reused id:** a reused id would need the same slot *and* sequence number (macOS shmids carry a sequence), plus the
  same key, within 5 s.
- **Another user's segment:** EPERM.
- **Another session's live Postgres:** NATTCH stays at least 1, so it is never 0.
- **NATTCH rising again:** the loop keeps waiting. Between the last `ipcs` and `ipcrm` there is the usual TOCTOU, but
  IPC_RMID on an attached segment only marks it for removal after the last detach, so no live user loses it.

**Stub timing (`atk/d.js`):** see L1. The stub `ipcrm` was never called with NATTCH stuck, which is correct.

**Not done:** a real backend detaching late against a real Postgres.

### E and RIG.md env lines

- **RIG.md's env rules:** they match main.js:98-119.
  - **Empty URL:** a URL that is set but empty refuses (main.js:101).
  - **One URL:** only one of the two URLs refuses (main.js:103-104).
  - **Roles:** roles other than both, with neither URL set, refuse (main.js:118).
  - **NODE_ID:** must start and end with a letter or digit (main.js:86).
  - **NATS credentials:** passed through to the client (server/bus/nats.js:82-111).
  - **"before it opens or listens on anything":** true. `start` calls `nodeConfig` before anything is created
    (main.js:262-263).
- **Compose:**
  - **Line 72-74 (dev board per gateway):** true per main.js:306-319. A node without the gateway role makes no dev
    board; the id is kept in `<data>/dev-board.json`. It applies when `PLENARY_DEV_TOKENS` is set, as the comment's
    "Local use only" implies.
  - **Lines 19-20:** true.
  - **Lines 10-12:** stale (L2).

### Regressions

Checked live, on a real-main.js CLI rig (2 gateways and 1 host):

| Check | Result |
|---|---|
| Processes | all 6 alive in `status --json` |
| Listeners | 7, all on 127.0.0.1: postgres, nats ×2, 3 nodes, caddy (`lsof`) |
| File modes | tokens.json, keys.json and all 6 logs are 0600 |
| Adapters | every node logs `"store":"postgres","registry":"postgres","bus":"nats"` |
| Roles | gw-1 and gw-2 `{gateway:true, host:false}`; host-1 `{gateway:false, host:true}` |

**Secrets, count only.** My first scan, which read tokens.json and keys.json to match their exact values, was denied
by this session's permission policy. I did not retry it. Instead, a count-only grep never opened the secret files:
- **What it looked for:** the token shape `rig-` plus 32 base64url characters, and any standalone 43-character base64url
  run (the key shape).
- **Where:** `up`'s output, `status --json`, rig.json and all 6 logs of the real-main rig.
- **Result:** **0 matches of either.** The builder's secret tests also pass in every gate.

**By the gate tests:**
- only-ours teardown;
- `ps` missing, failing or hanging refuses;
- the old-format refusal;
- TZ/locale identity;
- the env contract;
- signal tests.

**e2e:** alone (`-t e2e`) it gave 1 pass, 24 expects, 0 fail. It is not one of the skips. The only skip in the gates is
the killed-run fixture, as in rounds 3 and 4.

## sdd ensemble review

**Setup:** a review-only dir (`rev/`) holding cluster-rig.js, the test, rig-guard.js, RIG.md, p8-rig4.md and
p8-rig3v.md. It contained no `.env` and no json. Afterwards it held the same 6 files.

| Harness | Result |
|---|---|
| codex (effort high) | 3 findings: HIGH `livePostmaster` fail-open (regraded to L6), MEDIUM shm bound (confirmed live as L1), LOW RIG.md overstatement (nit) |
| grok | MEDIUM `livePostmaster` "compares with now" (refuted), LOW lock doc (refuted). It confirmed no double holder, no leak after a failed `up`, and no foreign segment |
| agy | not tried |

**Skipped:** I ran no `check_adapter` or `usage` call first. Both harnesses returned valid results.

**Agreement:** the two agreed only on the `livePostmaster` line, which BRIEF-BASE makes a HIGH candidate. I settled it
by measurement (L6).

## Mutations

Each mutation was applied alone in `plmut` (`atk/mut.py`, the builder's script plus mine), followed by a full
`bun test test/deploy`. Afterwards, no process was left under `plmut/`. Outputs are in `<scratchpad>/mut/`.

| Mutation | Fails |
|---|---|
| A revert: `stopKids` only when `stopRig` throws | both "A: ps failing once …" tests |
| A guard: `livePostmaster` never blocks | "A: up refuses to wipe pg/ …" |
| C revert: save in the catch not best effort | "C: a failing save …" |
| B revert: round 3's rename-aside takeover | "B: a stale lock is cleared only under up.lock.break …" |
| B: no re-check under the break lock | same |
| B: `releaseLock` removes any lock | "B: `up` releases only its own lock …" |
| B: left-over break lock cleared automatically | first B test |
| B: live breaker ignored | first B test |
| D revert: one-shot | "D: removeOrphanShm waits …" |
| D: key checked only on the first try | D test |
| **V1 (mine):** break lock not released after a clear (`finally {}`) | first B test and "M3: … a stale lock is cleared …" |
| **V2 (mine):** `livePostmaster`'s 5 s window dropped (a reused PID blocks) | "A: up refuses … a reused PID does not block" |
| **V3 (mine):** `ipcs` failing is retried instead of stopping | "removeOrphanShm removes exactly the segment named …" |
| **V4 (mine):** no deadline in the NATTCH wait | D test and the removeOrphanShm test |

**14 of 14 killed.** Every run was otherwise 31 or 32 pass, 1 skip.

## Gates

| Run | Where | Result |
|---|---|---|
| `bun test test/deploy` #1 | copy `pl` | 33 pass, 1 skip, 0 fail (38.3 s) |
| #2 | copy | 33 pass, 1 skip, 0 fail (38.8 s) |
| #3 | copy | 33 pass, 1 skip, 0 fail (38.9 s) |
| e2e alone | copy | 1 pass, 0 fail |
| `bun test test/architecture.test.js` | real tree, read-only | 16 pass, 0 fail |

**.env:** `find` over all four copies returned 0, before every run through `run.sh` and at the end.

## Housekeeping

- **Engram:** searched at the start. The hits (shm exhaustion, stub nodes not naming the rig dir, the TZ gotcha) shaped
  how I swept for leftovers. Nothing new is worth storing.
- **Processes before:** no rig processes at all (no nats-server, `postgres -D`, `caddy run` or main.js).
- **Processes after (final sweep, after the ensemble and the last runs):** the same. `ps` lists nothing naming my
  scratchpad, and there is no nats-server, `postgres -D`, `caddy run` or `sleep 30`.
  - **Rigs:** every rig I started was stopped by its own `down`, by `stopRig`, or by test teardown.
  - **Stopped by PID:** two, after checking each first, both confirmed gone:
    - **3118** (`sleep 30`, parent 1, started 18:44:16): orphaned by my own hanging-`ipcs` stub script (the 10 s
      timeout kills the shell, not its child). SIGTERM.
    - **9121**: the real postmaster I deliberately left unrecorded for the guard check. SIGINT.
  - **Never used:** pkill, killall, ipcrm.
- **Real tree:** the shasums of the 40 rig, deploy and server files were checked again at the very end, and they are
  unchanged. `git status` shows other workers' edits (web/*, test/web/*, scripts/load/*); none are mine.
- **Segments:** before, 6 (41877504, 75300865, 61931522, 88932355, 127598596, 10616838; all NATTCH 0, from rounds 3-4,
  still your call). After, **the same 6, nothing more.**
  - **Poller:** a 0.5 s poller logged 1040 transient segments during the gates and mutations (each named with its
    creator's command, `atk/shm-seen.txt`). All were gone at the end, so no mutant this round leaked one.
- **Scratchpad leftovers:**
  - **Copies:** `pl/`, `plmut/`, `plslow/`, `rev/`.
  - **Scripts and outputs:** `atk/` (scripts, ledger, gate and mutation outputs) and `mut/`.
  - **Rig dirs:** under `tmp/`, all down. Some hold 0600 keys.json and tokens.json.

**What you need to do (t187):**
- **Accept round 4.** It passes.
- **Optional LOW fixes for whoever touches these files next:**
  - **L2:** compose lines 10-12 (stale against p4-wire2).
  - **L1:** RIG.md's "up to 5 s" (say it is a wait budget, or cap the `ipcs`/`ipcrm` timeouts by the time left).
  - **L3:** RIG.md's left-over break wording.
  - **L6:** say in RIG.md that the unrecorded-postmaster guard fails open when the start times differ by more than
    5 s (measured skew: 0 s).
  - **L4 and L5:** nits.
- **The 6 old segments:** still yours to decide (`ipcs -m -o -p`; NATTCH 0, creators gone).
