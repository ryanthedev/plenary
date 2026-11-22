# Report: p8-rig3 (fix round 3 for the local cluster rig after verifier p8-rig2v FAIL)

**Status: done. Every gate is green.** t187 cleared the shm block, and the final files are in the real tree
(uncommitted).

- **Fixes:** H2, M3, L6, L7, L8 and Leaks are fixed, including the SysV-segment addendum and the p4-wire addendum.
- **Gates:** `bun test test/deploy` passed 3 out of 3 times in the copy, with e2e in **real cluster mode** on HEAD.
  `test/architecture.test.js` passes in the real tree.
- **Mutations:** each guard's mutation fails a test, and so does the verifier's H2 repro.
- **One leftover:** 3 orphaned SysV segments from my last mutation run, plus one cause that is now fixed (below).
  `ipcrm` is not mine to run.

## Final round (after t187's go, 16:5x)

- **Copy:** `…/scratchpad/pl3` is HEAD (7bf171b, plus 9fca849, which only touches docs and test/web) with my files on
  top.
  - **Excluded:** `rsync --exclude .git --exclude .rig --exclude .env --exclude node_modules`.
  - **No .env anywhere:** `find pl3 -name .env` and `find …/scratchpad -name .env` both find 0. node_modules is a
    symlink to the real tree's.
- **Real tree:** before copying, each of my 4 files was `cmp`-identical to my starting snapshot. I then copied in
  `scripts/cluster-rig.js`, `test/deploy/{cluster-rig.test.js, rig-guard.js, fixture-killed-run.test.js}`,
  `deploy/cluster/RIG.md` and `deploy/cluster.compose.yml` (comments only). Nothing else in the real tree was
  touched, no rig ran there, and nothing was committed.

| Gate | Result | `ipcs -m` segments after |
|---|---|---|
| Before anything | — | **0** |
| `bun test test/deploy` run 1 (pl3, `TMPDIR=…/scratchpad/tmp`) | 26 pass, 1 skip, 0 fail (31 s) | 0 |
| run 2 | 26 pass, 1 skip, 0 fail | 0 |
| run 3 | 26 pass, 1 skip, 0 fail | 0 |
| Mutations (below) | each fails a test | **3** (see "Segments") |
| `bun test test/deploy` 3x again, after the segment fix to the tests | 26 pass, 1 skip, 0 fail, each time (30.5, 31.2 and 30.7 s) | 3, 3, 3 (no growth) |
| `bun test test/architecture.test.js`, real tree, read-only, with my files in | 16 pass, 0 fail | — |

- **The 1 skip:** `fixture-killed-run.test.js`, which runs only when the Leaks test starts it.
- **e2e ran each time:** it is the un-skipped real-main.js test, and if it were skipped the count would be 2.

**e2e in real cluster mode: yes.** On HEAD's `server/main.js` (7bf171b), the rig's 2 gateway-only and 1 host-only
nodes run on shared Postgres and NATS. A hello and an op go through Caddy to a gateway, which opens the room on the host
over `plen-hosts.open`, and the entry is read from a client on the other gateway. It was green in 6 out of 6 runs on
HEAD. L7's earlier caveat (2 failures inside mutation runs on the pre-commit main.js, under load and shm exhaustion)
did not recur.

**Mutations on the final files (pl3):**

| Mutation | Fails |
|---|---|
| Verifier's H2 repro (round-2 `psInfo`) | 3 tests: H2 CLI no-ps-on-PATH, H2 any-failure, H2 mid-`up` |
| Leaks: `up` ignores SIGHUP | "CLI: SIGHUP during `up`…" |
| Leaks: no abort check before a spawn | "Leaks: an abort between spawns…" |
| Leaks: test runner has no signal handlers (rig-guard) | "Leaks: a test run killed midway…" |

The other guards' mutations are in the tables below; the code they target has not changed since.

**Segments (0 before, 3 after):**
- **Origin:** the 3 orphans (shmid 41877504, 75300865 and 61931522; creators 62347, 62460 and 62527, all gone;
  NATTCH 0) appeared during my first final-round mutation run.
- **Cause:** the tests' own last-resort kills (`killRecorded` in the killed-run test and the H2 tests' `finally`, plus
  the round-2 TZ test's `finally`) SIGKILLed a postmaster without the rig dir, so the segment cleanup I had just added
  could not run there. The leaking mutants left their rigs running for those kills to hit.
- **Fixed:** every such call now passes the dir. Rerunning the repro, "no signal handlers" and "ignores SIGHUP"
  mutants left the count at 3 (no new segment), and so did the 3 gate runs.
- **Left in place:** I did not remove the 3, because `ipcrm` is not mine to run. They hold no process, but they count
  against macOS's 32.

**Processes:**
- **Before:** only `bun test test/load` (another worker) and 85354.
- **After:** nothing of mine (no process names my scratchpad, and its `tmp/` is empty). Still running and not mine:
  `bun test test/load` (6262), a `bun test` with parent 97173 (97174), and 85354.
  - **About 85354:** it is the nats-server from my first mutation run, under `/var/folders/.../T/plenary-rig-ng9jwi`.
    It cannot be tied to my copy by command line or cwd, so I left it, as before.

## Where things are

| What | Path |
|---|---|
| Final files (the deliverable) | `/private/tmp/claude-501/-Users-r-repos-plenary/fdbe4e04-d982-4783-8896-596dd3c56f21/scratchpad/final/` |
| Copy with final files in place | `…/scratchpad/pl/` (rsync of the tree, no `.git`/`.rig`) |
| Mutation driver and outputs | `…/scratchpad/mut.py`, `mut-out.txt`, `mut-out2.txt`, `mut-out3.txt` |

**Files to copy into the real tree** (the brief's 3 owned paths, plus 2 new files under `test/deploy/`):
- `final/cluster-rig.js` → `scripts/cluster-rig.js`
- `final/cluster-rig.test.js` → `test/deploy/cluster-rig.test.js`
- `final/rig-guard.js` → `test/deploy/rig-guard.js` (new)
- `final/fixture-killed-run.test.js` → `test/deploy/fixture-killed-run.test.js` (new). It skips unless the leak test
  runs it.
- `final/RIG.md` → `deploy/cluster/RIG.md`
- `final/cluster.compose.yml` → `deploy/cluster.compose.yml` (comments only; see the p4-wire addendum)

Before copying, `cmp` the real tree's three files against `…/scratchpad/orig/`, the snapshot taken at the start.

## Findings, changes, tests

| # | Change | Guarding test(s) |
|---|---|---|
| **H2** | `ps` is `/bin/ps`, with env `PATH=/usr/bin:/bin LC_ALL=C TZ=UTC`. `psInfo` throws `cannot check processes: …` on a spawn error, death by signal, any non-zero exit except "exit 1 with empty stdout and stderr", or unparseable output. Only that one case reads as "absent". `psCheck()` (the self-probe: `ps` must see this process) runs before every command, and in `loadRig` and `up` before the dir is touched, so a `ps` that answers "absent" for everything also refuses. The old-format refusal goes through the same path. A failed `up` whose `stopRig` refuses stops its own children through their ChildProcess handles, which needs no `ps`; the first error is kept and the message adds what was stopped. `launch` keeps the handle before its first `ps` call. A `started: null` record is now written only when `ps` worked and saw the process dead. | "H2 CLI: with no ps on PATH…" (the verifier's repro, through the CLI); "H2: a ps that fails in any way…, up front or only after the self-probe…" (7 broken stubs plus 4 "late" stubs that pass the self-probe and fail afterwards; status, kill, down and up all refuse; rig.json byte-identical, `pg/` kept, all 6 still alive, no lock left); "H2: ps failing in the middle of `up`…" (`ps` breaks right after nats spawns; nats was never recorded; both are stopped by handle and the nats port is free) |
| **M3** | `up` takes `<dir>/up.lock` before reading or wiping. It holds `{pid, started}` and is created atomically with `linkSync`. A live owner (the same identity check) means refuse. A stale lock is moved aside with `rename` and removed only if it is still the content judged stale; otherwise it is put back and `up` refuses. The wipe keeps `up.lock*`, and the "not a rig dir" check ignores it. The lock is released on every exit, including refusals. | "M3: a second `up` during the first one's initdb window (rig.json: starting, no procs)…" (the dir is pre-seeded with a stopped rig so A takes the wipe path; B is run when A's rig.json reads `starting` with `procs: []`; B refuses, the sentinel survives, and A ends up with 6 live procs); "M3: a lock held by a live process refuses; a stale lock … is cleared…" |
| **L6** | On disk, `tokensFile`, `keysFile`, `logsDir`, `nodes[].dataDir/log` and `procs[].log` are stored **relative to the rig dir**. In memory, `status --json` and `startRig` give them absolute. An older file with absolute paths under its recorded `dir` is rebased onto the dir given. | "L6: rig.json stores in-dir paths relative…" (a round-2 file, moved; then saved; then moved again); a raw-file assertion in the secrets test |
| **L7** | Un-skipped. It ran green 3 times out of 3 in the copy (`-t e2e`, 14:58), and the comment, file header and RIG.md "Status"/"Tests" are updated. **Caveat:** it also failed twice inside mutation runs whose mutants should not affect it ("killed ps reads as absent" in run 1, and "lock: live owner ignored" in run 3). The machine was loaded (load average 9, another worker's `bun test test/load`), and run 3's failure may already be the shm exhaustion. Its stability is not proven: rerun it 3 more times once Postgres can start, and if it fails, restore the skip. | — |
| **L8** | The message now reads "…so it cannot tell whether these processes belong to this rig: node:gw-1 (pid N). Check each one's start time and command with: LC_ALL=C TZ=UTC /bin/ps -o lstart=,command= -p <pid>. Stop the ones that are the rig's, then remove <dir>". The RIG.md Safety bullet matches. | The old-format test asserts the full sentence |
| **Leaks** (t187) | `up` checks the abort before every spawn and after initdb; the CLI also handles SIGHUP. New `test/deploy/rig-guard.js` is shared by the tests: on `afterAll` and on SIGINT/SIGTERM/SIGHUP to the test runner, it aborts in-flight `up`s and waits for them, SIGTERMs tracked CLI children (then SIGKILLs them), stops every rig dir with `stopRig`, then SIGKILLs any recorded PID still matching by the test's own `/bin/ps` check, and only then removes the dirs. The CLI helper's timeout sends SIGTERM first. | "CLI: SIGTERM / SIGINT / SIGHUP during `up`…; nothing tied to the rig dir remains" (3 tests); "Leaks: an abort between spawns starts nothing more"; "Leaks: a test run killed midway (SIGTERM, then SIGINT) leaves nothing…" (a child `bun test` of the fixture with one in-process rig and one CLI rig, killed after both had 5 procs: exit 143 or 130, every recorded PID gone, no process naming either dir) |

**Live evidence for Leaks:** I SIGTERMed the final mutation run's `bun test` (PID 21436) mid-run. It exited in 2 s and
left no process of mine and an empty scratchpad `tmp/`.

**Not covered:**
- **SIGKILL of the test runner or of `up`:** no handler can run. rig.json still lets `down` stop everything.
- **Orphaned SysV segments:** the blocker above. Every SIGKILLed postmaster leaves one. The tests SIGKILL Postgres only
  as a last resort (`stopRig` escalation; rig-guard's fallback), and the mutants that leak (two "handle" mutants) do
  it by design.
  - **Whether an unmutated run leaves segments:** not measured. It could not be, once the limit was hit.
  - **Recommendation:** a follow-up should make rig-guard (or `down`) remove the segment of a Postgres it had to
    SIGKILL, using `ipcs`/`ipcrm` on the segment whose creator PID was that postmaster.

## Mutations (copy only; each applied alone to the final file, full `bun test test/deploy`, then restored)

Run 1 (14:59–15:05) and run 2 (15:07–15:20) are against the final code minus the Leaks changes, which do not touch these
guards. Run 3 is against the final files; it was valid until about 15:17 and was stopped at 15:22.

| Mutation | Result | Test(s) that fail |
|---|---|---|
| **Verifier's H2 repro** (round-2 `psInfo`: `ps` via the caller's PATH, null on any failure) | fails (3), runs 1 and 3 | H2 CLI no-ps-on-PATH; H2 any-failure; H2 mid-`up` |
| `ps` via the caller's PATH only | fails (1), runs 1 and 3 | H2 CLI no-ps-on-PATH |
| spawn error reads as absent | fails (1), runs 2 and 3 (survived run 1, before the late stubs existed) | H2 any-failure |
| killed `ps` reads as absent | fails (1), runs 2 and 3 (run 1 likewise) | H2 any-failure |
| non-zero exit reads as absent | fails (1–2), runs 1 and 3 | H2 mid-`up` (+ H2 any-failure in run 3) |
| unexpected output reads as absent | fails (1), runs 2 and 3 (run 1 likewise) | H2 any-failure |
| no `psCheck` self-probe | fails (1), runs 1, 2 and 3 | H2 any-failure |
| failed `up`: no handle fallback | fails (1), runs 1 and 3 | H2 mid-`up` |
| `launch` does not keep the handle | fails (1), runs 1 and 3 | H2 mid-`up` |
| no up lock | fails (2), runs 2 and 3 | both M3 tests |
| lock: live owner ignored | fails (2), run 2 | both M3 tests |
| lock: stale never cleared | fails (1), run 2 | M3 lock test |
| wipe removes the lock too | fails (1), run 2 | M3 initdb-window test |
| L6: stored absolute | fails (2), run 2 | L6; secrets test |
| L6: absolute not rebased on load | fails (1), run 2 | L6 |
| L8: old message | fails (1), run 2 | old-format test |
| Leaks: `up` ignores SIGHUP; no abort check before a spawn; test runner has no signal handlers | **not run** (queued in run 3 after the shm exhaustion). By reading: the SIGHUP test, the "abort between spawns" test and the "test run killed midway" test should each fail. | — |

Run 3's results after about 15:17 (8–9 failures each for "stale never cleared", "wipe removes the lock", "L6 stored
absolute") are invalid: every `initdb` failed on the shm limit. The run 2 results for those mutations stand.

## Gates (blocked round, superseded by "Final round")

| Gate | Result |
|---|---|
| `bun test test/deploy` on the final code minus Leaks (copy) | 17 pass, 1 skip, 0 fail (14:57), once |
| New Leaks tests alone (`pl2`) | 4 pass, then 1 pass (abort test) |
| `bun test test/deploy` 3x on the final files | **not done: blocked by shm** |
| `bun test test/architecture.test.js` (real tree) | **not run**: my files are not in the real tree yet |

## Processes (blocked round, superseded by "Final round")

- **Before:** 19368 and 19379 (another session's scratchpad `2a10d82f…`), plus 53168 and 62656.
- **Stopped by me (2 PIDs):** 75685 and 81988. Both were nats-servers whose command line names my scratchpad's
  `tmp/plenary-rig-*`, leaked by the two "handle" mutants. I sent SIGTERM and confirmed both gone.
- **Not mine to stop, left running:** 85354.
  - **What it is:** a nats-server with config `/var/folders/…/T/plenary-rig-ng9jwi/nats.conf`, started 15:04:42.
  - **Why it is very likely mine:** it started during mutation run 1 (before I set `TMPDIR`), at the time of the
    "failed up: no handle fallback" / "launch: handle not kept" mutants, which leak exactly one nats-server, and its
    dir is gone.
  - **Why I did not stop it:** its command line and cwd do not name my copy, so t187's rule applies. t187 already
    stopped 79263, its twin from the same run.
- **Seen, not touched:** 64891 and 64909 (scratchpad `2a10d82f…`), and other workers' `bun test` runs.
- **After:** nothing of mine is running. My scratchpad `tmp/` is empty.
- **No pkill or killall.**

## Addendum (t187, after the shm block): remove a SIGKILLed postmaster's SysV segment

**Done in the copy; postgres-free tests and mutations pass.** No real `ipcrm` was run: the tests use stub
`ipcs`/`ipcrm`, and the rig and test code that would call the real ones never ran in a SIGKILL path after this
change.

- **Change (scripts/cluster-rig.js):**
  - **`pgShmOf(pgData, pid)`:** reads `pg/postmaster.pid` **before** the kill. Line 1 must equal the postmaster PID;
    line 7 gives `<key> <shmid>`.
  - **`removeOrphanShm({key, id})`:** runs `/usr/bin/ipcs -m -o`. It removes the segment with
    `/usr/bin/ipcrm -m <id>` only when that id is listed with that key (hex) and NATTCH 0, and does nothing on any
    ipcs failure.
  - **Callers, after a SIGKILL and only once the postmaster is gone:** `stopRig`'s SIGKILL escalation, and a failed
    `up`'s handle fallback (`stopKids`).
  - **Test seam:** `_setIpcPaths({ ipcs, ipcrm })`, in-process only.
- **Change (test/deploy/rig-guard.js):** `killRecorded(procs, dir)` does the same for a recorded postmaster that it
  SIGKILLs. It treats a zombie as gone, because a test's own child is not reaped inside a sync loop.
- **RIG.md:** the "SIGKILL of Postgres" known limit now explains the 32-segment limit, the symptom and the cleanup.

| Test (new describe, "SysV segment of a SIGKILLed postmaster (stub ipcs/ipcrm)") | Covers |
|---|---|
| removeOrphanShm removes exactly the segment named… | matching id, key and NATTCH 0 is removed (`-m 777` only, not its neighbour 776); NATTCH 1, a key mismatch (id reused), an absent id and an ipcs failure are all left alone |
| pgShmOf reads line 7…, only for the postmaster PID on line 1 | no file, wrong PID, garbage line 7 |
| down SIGKILLs a postmaster that ignores SIGINT and removes its segment; a clean exit removes nothing | `stopRig` escalation path and the graceful path |
| rig-guard's last-resort SIGKILL of a recorded postmaster removes its segment too | `killRecorded(procs, dir)` |

Result: 4 pass, 0 fail (`-t "SysV|removeOrphanShm|pgShmOf|segment"`, copy).

| Mutation (alone, `mut-shm.py`) | Result |
|---|---|
| NATTCH check dropped | fails: removeOrphanShm test |
| key check dropped | fails: removeOrphanShm test |
| `down`: no segment removal | fails: down SIGKILL test |
| `pgShmOf` ignores the postmaster PID | fails: pgShmOf test |
| rig-guard: no segment removal | fails: rig-guard test |

**Not covered:**
- **`stopKids` (failed-`up` fallback) segment removal:** it needs a real postmaster that ignores SIGINT, so it is
  untested and has no mutation.
- **The existing ~30 orphans:** not touched, per t187.
- **A real Postgres SIGKILL:** this path has not been run end to end; that waits for Postgres to start again.
- **Processes after:** none of mine; scratchpad `tmp/` is empty.

## Addendum: rebased on p4-wire (7bf171b); compose comments; RIG.md env rules

- **Rebase:** `…/scratchpad/pl3` is a new copy of HEAD 7bf171b (`rsync --exclude .git --exclude .rig --exclude .env
  --exclude node_modules`; `find pl3 -name .env` is empty) with my staged files on top. My 3 files were unchanged in
  the real tree against my starting snapshot (`cmp`), so the overlay has no merge.
- **New owned file, comments only:** `deploy/cluster.compose.yml` (staged at `…/scratchpad/final/cluster.compose.yml`;
  the starting version is in `…/scratchpad/orig/`). Changes:
  - **Header line 1:** "NOT FUNCTIONAL YET" becomes "not yet run as containers". The old phrase was about main.js
    ignoring the cluster env, which is no longer true. I have not run this compose.
  - **Lines 7-14:** now say what 7bf171b reads: DATABASE_URL, NATS_URL, PLENARY_NODE_ID (start and end it with a
    letter or digit), PLENARY_ROLES and PLENARY_LEASE_TTL_MS, plus COOKIE_KEY.
    - **Roles:** set PLENARY_ROLES on every node, because an empty DATABASE_URL/NATS_URL means a single node and the
      explicit roles make it refuse.
    - **NATS:** no auth, because the bus drops `user:pass` (p4-wirev M1).
    - **S3_*:** unused, as before.
  - **Lines 62-63:** "After p4-wire also: …" becomes "since p4-wire (7bf171b) the cluster env: …".
  - **No YAML changed:** no test reads the file, and the compose already sets PLENARY_ROLES and PLENARY_NODE_ID on
    every app node, with NATS without credentials.
- **RIG.md:** the Status line names 7bf171b. A new "Env rules the rig keeps" block says:
  - every node sets PLENARY_ROLES explicitly (the rig always passes `gateway` or `host`);
  - empty URLs mean a single node;
  - PLENARY_NODE_ID starts and ends alphanumeric (`gw-N`, `host-N`);
  - NATS has no auth (the rig's NATS has no credentials and listens on 127.0.0.1 only).
- **Checks in pl3 (no Postgres needed):**
  - the SysV, L6 and M1 rig tests: 6 pass, 0 fail;
  - `bun test test/architecture.test.js`: 16 pass, 0 fail (copy only; the real-tree run waits for the copy-in).
- **e2e in real cluster mode:** yes by reading, not yet run on HEAD.
  - **What it exercises:** the rig's default (2 gateway-only nodes and 1 host-only node on shared Postgres and NATS)
    is the case 7bf171b wires. A gateway-only node opens the room on the host over `plen-hosts.open`. The test sends
    a hello and an op through the LB to a gateway, and reads the entry from a client on the other gateway.
  - **Why my earlier runs do not count:** my 3 green runs (14:58) used the working tree's `server/main.js` and
    `server/room-host.js` from before the commit, and both differ from HEAD's.
  - **Next:** it must be rerun 3 times on HEAD once Postgres can start. If it is not green 3 out of 3, I restore the
    skip with the reason.

## .env in my copies (t187's new rule)

- **Cause:** my copies were made with `rsync -a --exclude .git --exclude .rig --exclude node_modules`, which copied the
  real tree's `.env` into them. Both copies held it: `…/scratchpad/pl/.env` and `…/scratchpad/pl2/.env`.
- **Deleted:** both, by path; their contents were never printed. `find …/scratchpad -name .env` now finds none.
- **Exposure:** neither folder was handed to codex, grok or any other harness, since this job used no sdd harness.
  Bun's `.env` auto-load would have read it for the `bun test` runs in those copies. The rig's nodes never see it,
  because they get an explicit env and a cwd outside the copy.
- **From now on:** copies use `rsync --exclude .env --exclude .rig` (or a git worktree), and `find <copy> -name .env`
  must be empty before any run.

## Distributed-systems-design

This is test tooling with no product design change. The one design-relevant change is M3: rig.json now has a single
writer per dir (a lease-like lock with an identity-checked stale takeover), the same discipline the product uses for
one sequencer per board.

**Answered by t187:** the segments went to the CEO and were cleared; the go came and the final round is above.
The original question was: may I remove orphaned SysV shared-memory segments, meaning those with NATTCH 0 whose
creator PID no longer exists (`ipcs -m -p`, then `ipcrm -m <id>`, only those), so that Postgres can start again? Some
were created by other sessions' rigs, but nothing is attached to any of them. Or will you clear them, after which I
run the 3 gate runs, the remaining 3 Leaks mutations, the L7 reruns and the architecture test, and copy the files in?
