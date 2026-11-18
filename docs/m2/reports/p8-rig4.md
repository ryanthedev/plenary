# Report: p8-rig4 (fix round 4 for the local cluster rig: A, C, B, D, E from p8-rig3v)

**Result: all five findings fixed, each with a test; every revert mutation fails `bun test test/deploy`; gates green.**
- **A (HIGH):** a failed `up` now always stops its own children by handle after `stopRig`, plus a second line of
  defence: `up` refuses to wipe `pg/` while an unrecorded postmaster still runs on it.
- **C (MEDIUM):** the catch's `save` is best effort; cleanup always runs.
- **B (LOW):** **closed in code**, not just documented: a stale lock is cleared only under an exclusive
  `up.lock.break`, with a re-check. RIG.md's "Known limits" entry is replaced by the one new limit (a left-over
  break lock refuses until removed).
- **D (LOW):** `removeOrphanShm` retries (bounded, 5 s) while NATTCH > 0, re-checking id and key each time.
- **E (LOW):** both compose comments rewritten to be true on their own (checked against server/main.js:302-317).

Worked only in a copy (`<scratchpad>/pl`, rsync with `--exclude .env --exclude .rig --exclude .git`, node_modules
symlinked); mutations in `<scratchpad>/plmut`. Scratchpad: `/private/tmp/claude-501/-Users-r-repos-plenary/a8b1d3b7-f6d0-4b93-9208-165ae43ff757/scratchpad`.
Nothing committed.

## Files changed (synced back after checking the real-tree versions still equalled what I copied)

| File | Change |
|---|---|
| scripts/cluster-rig.js | A, C, B, D (below); new `_setLockHook` test seam (in-process only, like `_setPsPath`) |
| test/deploy/cluster-rig.test.js | 7 new tests; `expectAllDown` waits up to 2 s for a zombie to be reaped (below) |
| deploy/cluster/RIG.md | `up` refusal for a live unrecorded postmaster; `up.lock.break` in the files table; failed-`up` cleanup; lock takeover; Known limits (B entry replaced); NATTCH retry |
| deploy/cluster.compose.yml | comments at old lines 19-20 and 72 (E) |

test/deploy/rig-guard.js, stub-node.js and fixture-killed-run.test.js are unchanged.

## Per finding

### A (HIGH): transient `ps` failure leaked the unrecorded child

- **Fix:** `startRig`'s catch runs `stopRig` (errors caught), then **always** `stopKids(kids, …)`. `stopKids` skips
  children that already exited. The old message ("stopping by rig.json failed (…), so stopped this up's own
  children instead: …") is kept, and is only added when `stopRig` threw.
- **Second line of defence:** before the reuse wipe, `livePostmaster(<dir>/pg)` checks `pg/postmaster.pid`. If its
  line-1 PID is alive and started within 5 s of line 3 (the postmaster's own start time, epoch s), `up` refuses:
  "a postmaster (pid N) not recorded in rig.json is still running on …/pg; stop it (kill -INT N) before up". A
  PID that started at another time is a reused PID and does not block.
- **Tests:**
  - "A: ps failing once on the just-spawned nats / postgres and then recovering" (2 tests). The stub `ps` is
    generated per test in a fresh dir, fails exactly once on the first probe of a PID whose command matches, and
    writes that PID to a marker. The tests assert:
    - the marker exists, and that PID is not in rig.json and is gone;
    - nothing names the rig dir, `pg/postmaster.pid` is absent, and every recorded process is down;
    - a second `up` on the dir runs exactly one postmaster, the recorded one.
  - "A: up refuses to wipe pg/ while postmaster.pid names a live process started at the recorded time; a reused PID
    does not block" (a `sleep` decoy as the PID).
- **Live re-run of p8-rig3v's repros** (copied from session 20b2cad7's `atk/`, marker paths rewritten to my
  scratchpad, old markers deleted; both markers appeared, so the stub fired):

| Repro | Round 3 (p8-rig3v) | Now |
|---|---|---|
| `transient.js` (nats) | nats-server left running, unrecorded | throws "cannot check processes … exited 2"; rig.json `[postgres]`; **nothing naming the dir runs** |
| `transient-pg.js` (postgres) | postmaster left running; second `up` wiped `pg/` under it; **two** postmasters | nothing runs after the failed `up`; postmaster.pid gone; second `up` exit 0 with **one** postgres, nats and caddy; I took it down with `down` |

### C (MEDIUM): a failing save skipped all cleanup

- **Fix:** `try { save(rig); } catch {}` in the catch. `err.rig = readRig(dir)` is wrapped too, so a read failure
  can't replace the original error. In this repro `stopRig` also throws (its final `save` hits EISDIR after it has
  stopped postgres); `stopKids` then stops nats, so A's always-`stopKids` matters here as well.
- **Test:** "C: a failing save inside up (rig.json.tmp is a directory) still stops everything it started". It
  asserts on processes (rig.json stays at `starting` on disk, procs `[postgres]`), the nats port is free, nothing
  names the dir, and no lock is left.
- **Live re-run of `savefail.js`:** throws EISDIR, **running: []** (round 3: postgres and nats-server left).

### B (LOW): three `up`s and a stale lock — closed

- **Fix:** the takeover is now a guarded delete instead of rename-aside/put-back.
  - **Exclusive break lock:** an `up` that judges `up.lock` stale first links its own lock body to
    `<dir>/up.lock.break`, which is exclusive.
  - **Re-check, then delete:** under the break lock it re-reads `up.lock`, and removes it only if it still holds
    exactly the text judged stale. Then it releases the break lock (in `finally`) and loops, judging afresh.
  - **Why the re-check proves it is still stale:** only a break-lock holder ever removes `up.lock`, and no `up` can
    link a new `up.lock` while the stale one exists. So identical text means the same stale lock.
  - **No path ends with two holders:** the old put-back could fail silently and leave two. Now every unexpected
    state either loops or refuses.
- **The break lock itself is never auto-cleared:**
  - **Live owner:** refuses with "another `up` (pid N) is clearing a stale lock".
  - **Dead owner:** refuses with "…/up.lock.break was left by an `up` that stopped while clearing a stale lock; …
    remove that file".
  - **Why not auto-clear it:** breaking it safely would need the same race-free takeover one level up. It is held
    for microseconds, so a left-over one needs an `up` killed in that instant. RIG.md lists this as a known limit.
- **releaseLock:** unchanged; it removes `up.lock` only while it holds the caller's own body. That is now pinned by
  a test (the verifier's surviving mutant).
- **Tests:**
  - "B: a stale lock is cleared only under up.lock.break …" covers 3 cases:
    1. A live break lock refuses; nothing is touched.
    2. A left-over break lock refuses and names the file.
    3. Through `_setLockHook("stale")`, the lock is replaced by a live decoy's lock after it was judged stale. `up`
       refuses with the decoy's PID, the decoy's lock is intact, no other `up.lock*` file is left, and `pg/` is kept.
  - "B: `up` releases only its own lock: a lock replaced while it ran is left in place".
- **Live, uninstrumented race:** p8-rig3v's `race.js` (paths rewritten; it now also lists every `up.lock*` file) ran
  against the final copy. **Exactly one `up` got past the lock and exited 0 in 15 of 15 runs**: 3-way ×4, 3-way with a
  planted stale lock ×8, 2-way with a stale lock ×3. Every `down` exited 0, no process was left, and no `up.lock*`
  file remained. (A first attempt launched 0 `up`s because zsh did not split my argument string. I discarded it.)
- **Not done:** I did not re-run p8-rig3v's instrumented 3-way race (`plslow`, injected sleeps). Its sleep points sit
  in code that no longer exists, so that exact interleaving is covered by the hook test and by reasoning only.
- **Design check (distributed-systems-design v0.1.0, CHECKER, done after the code, not APPLIER before it):**
  - **Consistency choice:** CP. It never allows two holders and may refuse; an unavailable lock is a refusal, never a
    guess.
  - **Failure of each part:**
    - **Owner dies:** the lock is judged stale by ps identity (PID plus start time). The existing 1-second limit
      still applies.
    - **`ps` fails:** refuse.
    - **Breaker dies holding `up.lock.break`:** refuse until a person removes the file.
    - **Filesystem:** `link(2)` is atomic on local APFS. Rig dirs are local (`.rig/` or TMPDIR). Network filesystems
      were not considered.
  - **Single point of failure:** the break lock is one, for liveness only (manual recovery), never for safety.
  - **Not applicable:** the checklist's scale items (LB, replication, sharding) do not apply to a one-machine test
    rig.

### D (LOW): one-shot segment removal

- **Fix:** `removeOrphanShm(shm, { waitMs = 5000 })` stays synchronous. rig-guard's `killRecorded` reads the result
  on the next line, so it uses `Bun.sleepSync(100)` between tries.
  - **Retries:** only while `ipcs` lists that exact id with that exact key and a numeric NATTCH > 0.
  - **Stops at once:** if `ipcs` fails, the id is gone, or the key differs.
  - **Each try:** id, key and NATTCH are all re-checked.
  - **Unchanged safety:** the callers' "postmaster gone" check, the exact `{key, id}` from the rig's own
    postmaster.pid, and EPERM for another user's segment.
- **Test:** "D: removeOrphanShm waits (bounded) …". A stub `ipcs` returns a sequence of tables:
  - NATTCH 2, then 1, then 0: removed on the 3rd call.
  - NATTCH stuck at 1 with `waitMs: 400`: not removed, and it returns between 350 ms and 2 s after more than 1 call.
  - Key changes on the 2nd call: not removed, stops at call 2.
  - Row disappears on the 2nd call: not removed, stops at call 2.
  - The existing NATTCH-1 row passes `waitMs: 0` to stay fast.

### E (LOW): compose comments

- **Lines 19-20:** the README heading citation is dropped. Now: "This file has not been run as containers yet
  (header); the native rig has run this split with the same env (deploy/cluster/RIG.md)". The second half rests on
  p8-rig3v's live e2e (its "e2e" section).
- **Line 72:** "Each gateway node (app-1, app-2; not the host-only app-3) creates its own dev board on its first start
  and keeps that id in its own /data. The registry is the shared Postgres, so every node knows every board, but the
  two gateways' dev boards are two different boards." Checked against server/main.js:302-317: a node without the
  gateway role makes no dev board, and the id is kept in `<data>/dev-board.json`. The old claim "unknown to the
  others" is false in cluster mode.
- **Change needed elsewhere (not my file):** deploy/README.md lines 10, 87 and 181 still say the cluster is "not
  functional yet" and that main.js does not use the Postgres adapters. p4-wire (7bf171b) made both untrue.

## Mutations (each alone in `plmut`, full `bun test test/deploy`; script `<scratchpad>/mut/mut.py`, outputs `<scratchpad>/mut/*.txt`)

| Mutation | Fails |
|---|---|
| A revert: `stopKids` only when `stopRig` throws | both "A: ps failing once …" tests |
| A guard: `livePostmaster` never blocks | "A: up refuses to wipe pg/ …" |
| C revert: `save` in the catch not best effort | "C: a failing save …" |
| B revert: round 3's rename-aside/put-back takeover | "B: a stale lock is cleared only under up.lock.break …" |
| B: no re-check under the break lock | same B test |
| B: `releaseLock` removes any lock (p8-rig3v survivor) | "B: `up` releases only its own lock …" |
| B: left-over break lock cleared automatically | first B test |
| B: live breaker ignored | first B test |
| D revert: one-shot | "D: removeOrphanShm waits …" |
| D: key checked only on the first try (try counter) | D test |

**10 of 10 killed, on the delivered files.**
- **Batch 2 (the table):** run after the sync, on test and script files byte-identical to the real tree.
- **Leftovers:** after each mutant, no process naming the scratchpad was left.
- **Segments:** 7 before batch 2 and 7 after. The 7th is another session's live Postgres (see Housekeeping).
- **Batch 1:** ran on the test file before the `expectAllDown` change below and also killed all 10. Its D-key mutant
  (`Date.now() + waitMs === until`) dropped the key check almost entirely, so batch 2 uses a try counter instead.
- **Collateral flake:** in batch 1 the A-revert mutant also failed "up: env contract". That is the zombie flake below,
  and it is gone in batch 2.

p8-rig3v's other survivor, "stale takeover without the content re-check", is the "B: no re-check" row in its new
form; it is killed now.

**Test fix found by the batch:**
- **The flake:** under the A-revert mutant, the first test's `expectAllDown` saw a stopped in-process child still
  listed by `ps` right after `down`. `isOurs` had already said "not ours", so this was a zombie not yet reaped by
  Bun.
- **The fix:** `expectAllDown` is now async and waits up to 2 s (by `await Bun.sleep`, so Bun can reap) before
  asserting the PID is gone. Every call site awaits it.
- **Unconfirmed:** this is probably the timing-sensitive "Leaks: abort between spawns" flake p8-rig3v saw. That
  link is not proven.

## Gates

| Run | Where | Result |
|---|---|---|
| `bun test test/deploy` #1 | copy | 33 pass, 1 skip, 0 fail (40.4 s) |
| #2 | copy | 33 pass, 1 skip, 0 fail (39.5 s) |
| #3 | copy | 33 pass, 1 skip, 0 fail (40.0 s) |
| e2e alone (`-t e2e`) | copy | 1 pass, 0 fail |
| `bun test test/architecture.test.js` | real tree, read-only | 16 pass, 0 fail (before and after the sync) |

- **The 1 skip:** the killed-run fixture, as in round 3.
- **Test count:** 26 → 33 rig tests (7 new).
- **.env and TMPDIR:** the `.env` check came back empty before the gates, the mutation batches and the race runs.
  TMPDIR was `<scratchpad>/tmp` for those runs. **Exceptions:**
  - **No `.env` check:** the savefail re-run and the e2e-alone run had none, though TMPDIR was set for both.
  - **One stray suite run:** while running e2e alone, I also typed `bun test test/deploy 2>&1 | head -0` in the copy.
    That started a full run with no TMPDIR set, so the default `/var/folders/…/T` was used, and its output was
    discarded.
  - **What it left:** I checked afterwards. There is no `plenary-rig-*` dir in the default temp dir newer than 17:30
    (the newest are from 14:49, other sessions'), and no rig process. It left nothing, whether it finished or died on
    the closed pipe; which of the two is unknown.
  - **No `.env` exposure:** nothing in the copy creates a `.env`, and every later check was empty.
- **Full suite:** I did not run the full `bun test` in the real tree. The brief asks only for the two gates, and
  p8-load4 is working in scripts/load and test/load.

## Housekeeping

- **Processes before:** none of mine; I did not touch anyone else's.
- **Processes after:** `ps -axo pid,command | grep <scratchpad>` finds none.
  - **Rigs:** every rig I started was stopped by its own `down`, or by the tests' teardown. The repro's second rig
    (`tmp/rig-transpg-lI2saZ`) was stopped with `down` ("stopped caddy, node:gw-1, nats, postgres").
  - **Manual kills:** I killed no PID by hand. No pkill, killall or ipcrm.
- **Shm segments: 6 of mine before and after, the same ids** (41877504, 75300865, 61931522, 88932355, 127598596, 10616838).
  All have NATTCH 0 and creators that are gone; they predate this round (p8-rig3 and p8-rig3v).
  - **Counts:** each gate run and batch 1 went 6 → 6.
  - **The extra segment now listed:** it belongs to another session's live Postgres, not mine. During the race runs
    it was 157286407 (creator 18526, `-D` in session a4b2682f's scratchpad). At the end of batch 2 it was 261881861
    (creator 85454, started 18:18:20, `-D` in session 3c7d87b2's scratchpad), NATTCH 6. I left it alone. The 6 old segments are still yours to decide on (p8-rig3v's ask).
- **Scratchpad leftovers:** `pl/`, `plmut/`, `orig/`, `atk/`, `atk3v/` and `mut/`. Rig dirs under `tmp/` are all
  down; some hold 0600 keys.json and tokens.json.

## Not verified

- **3-way race, live:** the 3-way stale-lock race is not re-run with injected delays (see B). The new takeover's
  safety rests on the argument above plus the hook test.
- **Left-over break lock:** not produced live (it would need an `up` SIGKILLed in the microseconds it holds it). The
  refusal is tested with a planted file.
- **D against a real Postgres:** a backend detaching late was not reproduced. The retry is tested with stub `ipcs`
  only, and p8-rig3v saw 13 of 13 real segments removed on the first try.
- **`livePostmaster`'s 5 s window:** this assumes Postgres writes line 3 within 5 s of exec. I checked that from
  what Postgres records (its start time), not by measurement. **It fails open:** if a real, unrecorded postmaster's
  line 3 were more than 5 s off its `ps` start time, `livePostmaster` would return null and `up` would wipe `pg/`
  under it. It is only the second line of defence: A's always-`stopKids` is the actual fix, and the test shows a
  correct line 3 blocks.
- **No sdd ensemble:** builders may use one but are not required to, and I did not run one.
- **Engram:** recalled at the start; the hits only restated what the code and RIG.md already say.

## Follow-up (t187): RIG.md env rules against p4-wire2

**What changed:** I updated deploy/cluster/RIG.md's "Env rules" (old lines 11-15) and checked them against
server/main.js:29-40, 99-118 and server/bus/nats.js:82-111. Nothing else changed.

- **Roles and URLs:** main.js now refuses to start before it opens or listens on anything when:
  - a URL is set but empty;
  - only one of the two URLs is set;
  - `PLENARY_ROLES` is not both roles while neither URL is set.

  So a rig node never falls back to running alone as a single node.
- **NATS auth:** M1 is fixed, and the bus now passes `user:pass@` or `token@` from `NATS_URL` to the client. The
  rig's NATS stays without credentials on 127.0.0.1, and RIG.md now says that is a choice, not a workaround.

**Sync:** before copying RIG.md back, I checked that the real-tree file still equalled my last synced version.

**Test:** `bun test test/deploy` in the copy gave 33 pass, 1 skip, 0 fail, with no `.env` in the copy, TMPDIR set to
my scratchpad, and no leftovers.
