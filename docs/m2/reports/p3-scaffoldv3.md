# Report: p3-scaffoldv3 (re-verify the single-node server scaffold, round 3)

**Verdict: FAIL.** Two HIGH, five LOW, and one unresolved lead.

- **H1:** when one user's `since: 0` catch-up (snapshot plus kept tail) is over 64 MiB, it is refused, every time,
  before and after a restart. That includes the owner. A board inside the spec's stream caps gets there with 70
  legal ops, and codex found it too.
- **H2:** 1 of 30 full `bun test` runs failed: the kill -9 test, on a test boundary (`> 450` where exactly 450 is
  legal). The brief says any failure is HIGH. The durability assertions before it passed; the one after it didn't run.
- **Round 2's findings are closed, measured against `bun server/main.js` from a separate process:**
  - **Its H1 (note rewrites):** joins are back to 2 ms.
  - **Its non-reader pin:** 48 non-readers peak at a 282 MB footprint and are all cut or turned away within ~15 s.
  - **Its M1 (burst freeze):** `/health` peaks at 32 ms during a 6,400-op burst, down from 5.6 s.
  - **Its M2 (unmarked divergences):** marked, or fixed to match § Bus.
  - **Its L5 (flaky convergence):** the convergence test passed 100 of 100 runs alone.
- **Housekeeping:** I did not read docs/m2/reports/p3-scaffold.md. I changed nothing in the repo but this file, and
  committed nothing.

## What I checked, and how

| Check | Result |
|---|---|
| `bun test`, whole repo | 315 pass, 69 skip (Postgres/NATS/S3 not running), 0 fail. **30 full runs: 29 pass, 1 fail** (run 15: H2). Runs 1–20 overlapped my attack scripts; runs 21–30 ran on a quiet machine, 10/10 |
| Convergence test alone (`-t 'clients converge'`) | **100 / 100 runs, each "2 pass"** (both seeds), checked per run in the log |
| kill -9 test alone (`-t 'kill -9'`) | 30 / 30 exit 0 under load; one check run shows the filter selects it ("1 pass, 5 filtered out") |
| Read in full | server/{gateway,room-host,breather,server,main,log,ids}.js, bus/memory.js, store/sqlite.js; test/server/helpers.js |
| Read in part | rig.js (1–30, 90–176); outbound.test.js (1–135, the round-3 tests); main.test.js (the kill -9 and cap tests); gateway.test.js (test names) |
| Not read | ports.test.js; blobs/disk.js (unchanged in what round 2 checked) |
| Checked against | PROTOCOL.md § Limits, § Pacing, § Bus (read this session), § Known limits, rule 3; PLAN.md phase 3 |
| Attacks | Bun scripts plus two Python clients, in my session scratchpad (outside the repo). Each spawns `bun server/main.js` as **a separate process**: PORT=0, its own data dir, dev tokens, PID recorded and stopped by PID. `git status --short --ignored` shows nothing new from me, and there is no `data/` |
| sdd review | codex only, effort high, on a copy of the tree in my scratchpad: **single harness**, so its findings are leads. Outcome per lead below |

## Round 2's findings: what became of each

| # | Status | Evidence (main.js, separate process, unless noted) |
|---|---|---|
| H1 rewrite attack | **Closed** | 280 rewrites × 990 KB of one note. Three `since: 0` joins each got a 2 MB catch-up (snapshot at 279, then seq 280) in 2–37 ms. After a SIGTERM restart: 3/3, the first in 1.3 s (rebuild), the others in 2 ms. No closes. `/health` showed `owedTracked` 0 afterwards |
| H1 memory pinned by non-readers | **Closed** | 20 MB board; 48 raw-TCP viewer sockets on 8 accounts, a third silent, a third sending presence every 10 s, a third flooding `transient` ops. The server owed at most 252 MB (budget 256 MB). The footprint peaked at 282 MB and fell to 69 MB, with `owedBytes` back to 0. Every socket was cut (13 for stalling, 1 to make room for a joiner) or turned away (34), presence senders included. An honest `since: 0` joiner every 5 s got in each time, in 20–29 ms |
| M1 burst freeze | **Closed** | One editor, 6,400 small ops in one burst, `/health` polled throughout. Behind the hello: all acked in 2.4 s, `/health` p50 4.9 ms, max 32 ms. After the welcome: 1.8 s, max 7.7 ms. Round 2 measured 5.6 s |
| M2 unmarked spec divergences | **Closed** (reading, against § Bus text) | The close notice is `{n, conn, gateway, closed: true}` (gateway.js:119), and inbox messages are `{n, conn, gateway, user, name, role, client, msg}` (:294), both as § Bus says. Rule 11 is SEAM(p2) (:291). The per-gateway reply subject and the 5 s connection list are SEAM(p4) (memory.js:21, room-host.js:176). New, unmarked: see L5 |
| L1 pre-welcome bytes process-wide | **Closed** (reading; repo test "L1") | `maxTotalQueuedBytes` 64 MB at gateway.js:384. The chars-vs-bytes half is still open: L2 |
| L2 `opProblem` has no depth check | **Open, not this job** | packages/protocol/envelope.js is unchanged since round 2 |
| L3 a second dev board after a mid-start kill | Unchanged (dev only) | |
| L4 depth counted on the whole frame | Unchanged, documented | |
| L5 flaky convergence (rig.js `settled`) | **Closed** | `settled()` now waits on `busy` and `resync` (rig.js:131). 100/100 alone and 30/30 inside full runs |

## HIGH

**H1. When one user's `since: 0` catch-up is over 64 MiB, it is refused, every time, before and after a restart:
nobody can join that board from scratch.**

- **The budget:** what the gateway owes one user is capped by `maxUserBufferedBytes`, 64 MiB (67.1 M chars).
- **Where:** room-host.js:149 builds the snapshot as one frame. room-host.js:218 and :232-236 publish every catch-up
  frame at once, in one go. gateway.js:162-183 and :207-209 admit each frame against the user's budget as it
  arrives, before the socket has drained anything.
- **What happens:** the snapshot goes into Bun's buffer whole. The tail chunks behind it add up. Once the sum passes
  64 MiB, a later chunk is refused: the joiner is told `unavailable` and closed 1013 "over budget", after receiving
  the snapshot.
- **Why it never heals:** a retry gets the same. Pacing can't help, because admission happens before any drain.
- **It is racy at the edge:** how much the kernel takes before admission varies, so a catch-up just over the line
  sometimes gets through (one joiner did, with 69 MB).

**Measured on main.js, separate process:**

| Board | `since: 0` joins |
|---|---|
| 70 notes × 990 KB from **one annotator** (today's v0 Room has no stream caps): snapshot 62.4 MB + ~8 MB tail | Before restart **0/3**, after restart **0/3**. Each got the 62.4 MB snapshot, then `unavailable`, 1013 |
| **Inside the spec's caps:** one editor, 35 MB on `board` + 35 MB on `notes` (§ Limits allows 50 + 50 + 20 MB) | Before restart 1/3 (one got through with 69 MB), after restart **0/3**, **the owner too: 0/1** |
| 35 MB board, **one honest user opening two tabs at once** | First tab caught up; **second tab `unavailable`** after 26.7 MB. Two different users at once: both fine |

**What it breaks:**

- **New joiners can't get in at all.** Every since-0 join is refused, including the owner's.
- **Writers get locked out too (inferred, not measured).** Any refusal makes the client resync with `since: 0`
  (rule 5), so a writer who is refused once can't come back. Round 2 inferred the same for its H1.
- **Recovery needs a connection that is still open (inferred).** An owner already on the board could shrink the
  elements; nobody new can.
- **Every retry wastes bandwidth:** each one sends 62 MB before the close.
- **It is not exotic.** § Known limits already expects snapshots over 100 MB. A single user needs only a 35 MB board
  to be turned away from a second tab.
- **The repo tests miss it.** Every round-3 test sizes the board below the user budget (outbound.test.js:29, :81).
  room-host.js:101-104 mentions the one-frame snapshot, but neither the code nor the builder's list names this
  consequence.

**codex (single harness)** reported the same as HIGH, by reading. Confirmed by measurement.

**Fix (scaffold side):**

- Count only what is actually in the socket's buffer against the budget. Hand the next catch-up frame to the queue
  from `drain`, so frames waiting their turn don't count.
- Or, at minimum, let a catch-up larger than the budget through while its reader keeps draining.
- Add a test whose catch-up (snapshot plus tail) is bigger than `maxUserBufferedBytes`.

**Fix (spec side, engine):** rule 3 needs either a chunked snapshot or a stated maximum snapshot size that the
gateway budget is sized to.

**H2. One full `bun test` run of 30 failed: main.test.js:189, `expect(acked.size).toBeGreaterThan(450)`, received 450.**

- **The brief's rule:** any failure in the 20+ runs is HIGH, so it is filed HIGH.
- **The cause is a test boundary, not a durability bug.**
  - Each of the 3 rounds waits until it has "at least 150 more acks" (`until` at :163) and then kills the server.
  - If no further ack arrives between the 150th and the kill, the total is exactly 450. That is a legal outcome the
    test calls a failure.
  - In that run, every check before :189 passed: gapless log, no op logged twice, every resend landed once.
  - The check after it (every acked op at its acked seq, :190) **did not run** in that pass.
- **Conditions:** run 15 of 20, while my attack scripts were loading the machine. The same test passed 30/30 alone
  under load, and the full suite passed 10/10 on a quiet machine.
- **Fix:** `toBeGreaterThanOrEqual(450)` at :189. Optionally record acks that arrive during the final resend, too.

## LOW

| # | Where | What | Fix |
|---|---|---|---|
| L1 | gateway.js:318 (codex lead) | Replies to `transient` ops go straight to `ws.send`, bypassing the queue and the strike count. **Refuted as HIGH, measured.** 4 non-readers on a fresh board (nothing else owed) flooded `transient` ops with 256-char ids. They built up 193 MB owed, then were cut within 19 s ("over the total outbound budget" ×3, "stalled" ×1). The footprint peaked at 131 MB and returned to 16 MB. The budget and the stall sweep bound it | Count them as strikes after N, or route them through the queue |
| L2 | gateway.js:87, room-host.js:138 (codex lead; round 2's L1 half) | Budgets and chunk sizes count UTF-16 chars, while `getBufferedAmount` counts bytes. Non-ASCII text (3 UTF-8 bytes per BMP char) can make a chunk or a queue up to ~3× its stated "bytes". Reading only | Measure UTF-8 bytes, or call the limits chars |
| L3 | gateway.js:40 | The per-user cap of 64 connections is the builder's own choice, against § Known limits ("no cap"). It is marked and configurable. Noted so the spec catches up | Add it to § Limits / § Known limits |
| L4 | gateway.js:313 | § Pacing (20/s per user per board; a 500-op / 8 MB queue) is not enforced; marked SEAM(p2). By reading, a live writer's ops pile up in the room chain without bound | p2 |
| L5 | room-host.js, memory.js | Two § Bus items are neither implemented nor marked: the room's `{seq}` heartbeat on `.entries` every 2 s, and the `.here` subject. Harmless on one node (the in-memory bus can't lose a message). Reading only | Mark SEAM(p4) |
| L6 | gateway.js:162-183 (same cause as H1) | **Concurrent joins are turned away once the 256 MB process budget is spoken for.** 20 joiners at once on a 20 MB board: 13/20 got in from one client process; **13–18 of 20** over 4 client processes (Python raw TCP, 10 runs). The rest got `unavailable`, usually before any snapshot bytes. Clients retry, so this is capacity, not a lockout. M4 owns the 100k-join NFR | The H1 fix also helps |

## Unresolved lead (not rated): malformed frames seen by Bun's WebSocket client

- **What I saw:** in 1 of about 14 runs of "20 joiners on a 20 MB board", Bun `WebSocket` clients got 7 `snapshot`
  frames of the right length (17,004,727 chars) whose text wasn't valid JSON. The text ended inside a string.
- **Not reproduced over raw TCP:** a Python client that parses WebSocket frames itself saw **0 bad frames in 200
  joins over 10 runs**. Five more Bun-client runs saw none either.
- **So:** this points at Bun's client, not the server. I did not prove which.
- **Why it matters:** if it is the server, it is HIGH (silently corrupt frames). If it is Bun's client, the repo's
  own socket tests (rig.js uses it) may flake on large frames.
- **Next step:** a raw-TCP capture at the moment a Bun client sees a bad frame.

## Things I tried to break that held

| Attack | Measured |
|---|---|
| **Trickle readers** (a named hunt item: readers that never look stalled) | A Python client with `SO_RCVBUF` 4 KB reading 32 KB once a second. 18 sockets on 6 accounts held **248 MB of the 256 MB budget for over a minute**, 0 cut. **12 of 12 honest `since: 0` joiners still got in** (20 MB each, ~0.9 s): a fast reader's frames go straight to its socket, so they barely count against the budget. (My first try, a paused Node socket, read too fast to trickle; I discarded it) |
| **`since` far ahead** (`1e9`) | `welcome` with the room's seq, no catch-up, no error. Matches today's Room |
| **Accounting** | After each attack, `/health` showed `owedBytes` 0 once the sockets were gone (`owedTracked` printed in the catch-up runs: 0). By reading, `end()` releases `owed`, `connsByUser` and the queue on every path |
| **Pre-auth reach, cross-tenant, tokens in logs, store contract** | Re-read: unchanged from round 2, where they held. The main.js "no `S3CR3T` in stdout" test passed in all 30 full runs |

## codex (single harness) leads, and what became of each

| codex said | Outcome |
|---|---|
| HIGH: a legal snapshot over the 64 MB user budget can never be delivered | **Confirmed, measured: H1** (the trigger is snapshot + tail per user, not the snapshot alone) |
| HIGH: `transient` replies bypass bounded delivery | **Refuted as HIGH, measured: L1** (the budget and the stall cut bound it within 19 s) |
| MEDIUM: chars vs bytes in budgets and chunks | **True by reading: L2.** A constant factor of at most 3×, so LOW |

## The builder's round-3 not-verified list

| Item | What I found |
|---|---|
| Budget asserted by buffered counts, not RSS | Footprint (macOS `top` MEM) tracked the budget: 282 MB peak at 252 MB owed, 310 MB at 248 MB owed (trickle), back to 16–69 MB after |
| Attacks in-process only | All of mine ran against main.js in a separate process |
| No more than 6 non-readers | 48 (8 accounts) and 18 trickle readers (6 accounts) |
| No slow reader over a real network, Linux socket buffers | **Not done** (loopback, macOS only) |
| Drain under load with thousands of sockets; the O(connections) sweep | **Not done** (max ~50 sockets) |
| Power loss, p95, soak | **Not done** |

## Not verified

- Linux; a real network; thousands of sockets; power loss; p95; a soak.
- H1's writer lockout through the rule 5 resync (inferred, as in round 2).
- Whether H2's failure reproduces outside a loaded machine. It did not in 40 more runs (30 of the test alone, 10 full).
- The malformed-frame lead above.
- **Not cleaned:** the attack data dirs in my session scratchpad (over 1 GB, estimated from one 347 MB database per
  catch-up run; the delete was refused by the permission prompt), at
  /private/tmp/claude-501/-Users-r-repos-plenary/36dacc5b-4838-42f0-ac31-8af527db897a/scratchpad. Every server and
  client process I started was stopped (checked by PID).

---

# Round 4 (2026-11-11): **FAIL**

**The server fix works. The gate fails:** 8 of 20 full `bun test` runs failed, mostly on a new test that assumes a
fixed socket-buffer size. There is also one new HIGH: a snapshot over Bun's per-socket limit can't be sent at all.

- **Round 3's H1 is closed, measured** on `bun server/main.js` from a separate process. Every catch-up over the
  64 MiB per-user budget now joins, before and after a restart, owner included, and so do one user's two tabs.
- **Round 3's H2 is closed:** main.test.js:189 is now `>= 450`. The kill -9 gate passed **30 / 30** runs.
- **Round 4 HIGHs:**
  - **R4-H1:** the full suite failed 8 of 20 runs, against the PASS bar of 0 failures.
  - **R4-H2 (codex lead, confirmed):** a board whose snapshot is over Bun's `backpressureLimit` (~138 MB in UTF-8)
    can't be joined from `since: 0`. Joiners are dropped with 1006, and the server logs nothing.
- **Housekeeping:** I did not read the builder's report. The only repo file I changed is this report, and I
  committed nothing.

## How I checked

| Check | Result |
|---|---|
| What changed | Diffed against my round-3 snapshot of the tree. gateway.js (~260 diff lines: shared catch-up text pulled from the queue as the socket drains, waiters, `laggard()` pace rule, `maxCatchUpWaitMs`, the shared-text cap, errors through the queue), room-host.js (incremental tail chunks with shared keys; the heartbeat and `.here` marked SEAM(p4): round 3's L5 closed), main.test.js:189 (`>= 450`), rig.js (`trickle`), outbound.test.js (+7 tests), test/server/trickle.py (new). Nothing else in the job's files changed |
| kill -9 gate, `-t 'kill -9'`, quiet machine | **30 / 30**, each "1 pass, 0 fail" |
| Full `bun test`, 20 runs | **12 pass, 8 fail.** 328 tests. Failures are listed under R4-H1. codex was reading (not running) in my scratchpad during runs ~1–9 |
| Attacks | My round-3 scripts, against main.js in a separate process (PORT=0, PIDs recorded, stopped by PID). Every Bun client logs any frame that isn't valid JSON |
| sdd | codex only (single harness), effort high, on a copy of the tree, told not to run anything |

## Round 3's findings

| # | Status | Measured (main.js, separate process) |
|---|---|---|
| **H1** catch-up over 64 MiB refused | **Closed** | **70 notes × 990 KB from one annotator** (snapshot 62.4 MB + ~8 MB tail): 3 / 3 joined before the restart, 3 / 3 after (70.3 MB each, 42–964 ms). **35 MB board + 35 MB notes from one editor:** 3 / 3 before, 3 / 3 after, **owner 1 / 1**. **One user, two tabs at once on a 35 MB board:** 2 / 2. Rewrite attack: 2 ms joins. `since: 1e9`: `welcome`, no error |
| **H2** kill -9 test boundary | **Closed** | `>= 450` (:190); 30 / 30 runs |
| L1 `transient` replies bypass the queue | **Closed** | They now go through `push()` (gateway.js:413) |
| L2 chars vs bytes | **Open** (reading) | codex raised it again (gateway.js:176): shared frames are admitted by `string.length` against socket bytes. A **cause** of R4-H2 |
| L3 per-user cap vs spec | Unchanged | |
| L4 § Pacing not enforced | Unchanged, SEAM(p2) | |
| L5 heartbeat / `.here` unmarked | **Closed** | room-host.js:101-102 |
| L6 concurrent joins turned away | **Closed** | 20 joiners at once over 4 client processes on a 20 MB board: **20 / 20, in 12 of 12 rounds** (round 3: 13–18 of 20) |
| Malformed frames in Bun's client (unresolved lead) | **Not reproduced** | 240 Bun-client joins in 6 runs: 0 frames that aren't valid JSON. Still unexplained; I'd now call it a likely Bun client bug under load and stop chasing it |

**Round 2's findings stay closed:**

- **Non-reader pin, bounded but slower to clear.** 48 non-readers on 8 accounts, a third sending presence and a
  third flooding `transient`:
  - **Bound:** the server owed at most 256 MB, and the footprint peaked at 202 MB and fell to 75 MB.
  - **Cleared:** all 48 were cut (36 "making room… reads too slowly", 12 "stalled") **by t = 42 s.** Round 3 took
    ~15 s.
  - **Honest joiners:** got in every 5 s. The first one waited 7.7 s for room; after that, 20–26 ms.
- **Burst:** 6,400 ops; `/health` max 23.8 ms behind the hello and 8.9 ms after the welcome.

## HIGH

**R4-H1. The full suite fails: 8 of 20 runs.**

| Test | Full runs | Alone (quiet) | Cause |
|---|---|---|---|
| outbound.test.js:399 "joiners parked across folds…" (:423 `away.length >= 2`, :424 `indexOf(away[0]) === 0`) | **6 / 20** | **7 / 20 fail** | **Test assumption, not a server bug.** The test needs the "hog" socket to hold more than ~3 MB in the server's buffer, so the first joiner (a 6 MB snapshot, 9 MB budget) must wait. How much the kernel takes varies. An instrumented copy over 12 runs: hog 3.99–4.48 MB → parked `[waiting ×5]` → pass (7 / 7); hog 2.14–3.42 MB → the first 1–4 joiners **got their snapshot** (correct, there was room) → fail (5 / 5). The server did what its rule says every time |
| outbound.test.js:358 "trickle readers…" (:377 `owedBytes > 24 MB`, received 0) | 1 / 20 | 0 / 10 | Timing: by reading, the check ran before the Python trickle client had joined and been sent anything (under full-suite load). It needs python3 and skips silently without it |
| test/auth/http.test.js "replay guard: pruning visits O(1)…" | 1 / 20 | not run | **Not this job's file** (platform's). A 5 s timeout under load. Listed because the bar is the whole suite |

**Fix:**

- **Parked test:** size the budgets from what the hog actually holds (e.g. `maxUserBufferedBytes` = the hog's
  measured `owedBytes` + 1 MB), or assert on the waiters the server reports (`stats().waitingJoiners`) instead of
  assuming which joiner waits.
- **Trickle test:** wait until the tricklers are owed bytes before asserting.
- **Replay guard:** platform's to look at.

**R4-H2. A board whose snapshot is over Bun's `backpressureLimit` can never be joined from `since: 0`, and nothing is
logged.**

- **Where:** gateway.js `backpressureLimit` = 2 × 64 MiB + 4 MiB = 132 MiB (~138.4 MB). `noRoom()` (gateway.js:233)
  lets a frame of any size through when the budgets are empty, and measures it in chars (`string.length`), while the
  socket holds UTF-8 bytes. Bun then refuses the one frame bigger than its limit.
- **Measured** (main.js, separate process). One annotator; notes of 333,000 × U+4E2D (3 bytes each in UTF-8):

| Notes | Snapshot | `since: 0` joins |
|---|---|---|
| 145 | seq 130: 43.3 M chars, ~130 MB UTF-8 | 3 / 3 joined (owner included) |
| 175 | seq ~151: ~50.3 M chars, **~151 MB UTF-8** | **0 / 3, owner included.** Each got `welcome`, no snapshot, then **closed 1006**. No warn or error line on the server |

- **Why HIGH:** it is round 3's H1 consequence by another route. Legal ops make a board permanently unjoinable from
  scratch, and here even the server log is silent.
- **Reach:** today's Room has no stream caps. Whether it is reachable inside § Limits depends on the unit. "50 MB
  of JSON" counted in chars allows ~150 MB of UTF-8 per stream (board + notes split, each under the cap). Counted in
  bytes, the largest snapshot (~120 MB) stays under the limit, for ASCII and non-ASCII alike.
- **I did not prove** which Bun mechanism closes it (1006 with no `cut` log suggests Bun closes the socket itself,
  not `flush`'s `sent === 0` path, which would log "reader closed").
- **Fix (scaffold):** raise `backpressureLimit` above the largest frame the room can produce, or refuse with a
  logged `unavailable`.
- **Fix (spec, engine):** state § Limits' caps in UTF-8 bytes, or add a chunked snapshot (round 3's spec ask).

## LOW

| # | Where | What |
|---|---|---|
| R4-L1 | gateway.js:294 (codex lead) | One catch-up text bigger than `maxSharedQueuedBytes` is still held when nothing else is (`sharedBytes > 0` guard). True by reading; deliberate (otherwise a big board could never be sent) and bounded to one text. Say so in the comment |
| R4-L2 | gateway.js `laggard()` | By design, an honest reader that needs over 60 s to drain what its socket holds (e.g. a 62 MB snapshot at < 1 MB/s) is cut when another joiner needs room. It reconnects and catches up again, so on a slow link it may never finish. Reading only; not measured |
| R4-L3 | test/server/outbound.test.js:367 | The trickle test passes silently without python3 (`return`), so CI without python3 reports it as a pass. Use `test.skipIf` |
| R4-L4 | non-reader clearance | Round 3: all cut by ~15 s. Round 4: by ~42 s (the pace rule waits for a measured window). Bounded throughout; noted, not a defect |

## codex (single harness) leads

| codex said | Outcome |
|---|---|
| MEDIUM: shared frames measured in chars against byte budgets | True by reading (carried L2); a cause of R4-H2 |
| MEDIUM: a snapshot over `backpressureLimit` is never deliverable | **Confirmed, measured: R4-H2** (I rate it HIGH, as round 3's H1) |
| MEDIUM: one frame over the shared-text cap is held anyway | True by reading, deliberate: R4-L1 |

## Not verified (round 4)

- Linux, a real network, thousands of sockets, power loss, p95, a soak.
- Whether R4-H2 survives a restart (surely, since nothing changes, but not run). The exact Bun close path behind the
  1006.
- R4-L2 (a slow honest reader cut repeatedly) was not measured.
- **Not cleaned:** attack data dirs in my session scratchpad (the delete was refused earlier). Every server and client
  I started was stopped by PID.

---

# Round 5 (2026-11-11): **PASS**

**The manager's PASS bar is met on this machine (macOS), quiet and under load.** No HIGH. One MEDIUM: the M1 burst
test fails on Linux, because it assumes a slow disk, and CI will run on Linux. Three LOW.

| Gate | Quiet | Under load (4 CPU burners + a 150 MB-snapshot attack running) |
|---|---|---|
| kill -9 through main.js (`-t 'kill -9'`) | **30 / 30**, each "1 pass, 0 fail" | **10 / 10** |
| Full `bun test` | **20 / 20, 0 fail** (480 → 507 tests: platform added tests during the runs) | **6 / 6, 0 fail** (507–510 tests) |

- **No platform `test/auth` failure** occurred in any of the 26 runs, so there was nothing to attribute or rerun.
- **Housekeeping:** I did not read the builder's report; I diffed the code against my round-4 copy. The only repo
  file I changed is this report, and I committed nothing.

## What changed (diff against my round-4 copy)

- **gateway.js:**
  - Outbound sizes are UTF-8 bytes (`bytesOf`, plus a `bytes` field from the room host for shared text).
  - `backpressureLimit` = `maxSnapshotBytes` (450 MB) + the user budget.
  - `flush()` waits rather than hand a frame to a socket that would pass that limit.
  - Frames over 128 MiB or over the limit are logged once per text; a dropped frame is logged at error.
- **room-host.js:** measures each shared text's UTF-8 size once.
- **Tests:**
  - The parked-joiners and trickle tests now wait on the server's own counters (`waitingJoiners`, `turnedAway`)
    instead of kernel-buffer timing.
  - Three R4-H2 tests were added; rig.js changed.
- **Not this job:** server/auth, server/admin, the registries and test/auth changed too (platform's files).

## Round 4's findings

| # | Status | Evidence |
|---|---|---|
| **R4-H1** suite flakes | **Closed** | Full suite 26 / 26 (above). "joiners parked across folds" alone: **30 / 30** (round 4: 13 / 20). "trickle readers" alone: **20 / 20** |
| **R4-H2** snapshot over the socket limit | **Closed for the server.** The client limit is the accepted gap the manager named | **Correction to my round 4:** I measured R4-H2 with Bun's own WebSocket client, which (per the manager, and the builder's comment at gateway.js:46) closes 1006 on any message over 128 MiB. Part or all of the 1006 I recorded may have been that client limit. I did not separate the two. **This round, with a raw Python client** that parses frames itself: 175 notes × 333,000 CJK chars, a **155.9 MB snapshot frame**. `since: 0` joins, viewer and owner, **before and after a restart: 4 / 4 caught up** (welcome, snapshot, 7 entries), 0 bad frames, 0.3–2.5 s. The server logged it once per text: `warn "outbound frame over 128 MiB…" bytes=155863114` (the exact UTF-8 size). (My first capture missed the line: my harness blocked its own event loop with `spawnSync`. Fixed, then re-run) |
| R4-L1 one oversized text is held anyway | Documented | gateway.js:327-328 comment |
| R4-L2 a slow honest reader may be cut repeatedly | Unchanged by design; not measured | |
| R4-L3 trickle test passes silently without python3 | Unchanged | |
| R4-L4 non-readers clear slower | Unchanged | 48 non-readers on main.js this round: the server owed at most 258 MB, the footprint peaked at 317 MB and fell to 70 MB, and **all 48 were cut by t ≈ 43 s** (32 making room, 15 stalled, 1 over the total). An honest joiner got in on every 5 s probe (21–229 ms) |

## MEDIUM

**R5-M1. The M1 burst test fails on Linux: 9 of 10 runs of outbound.test.js, and 3 of 3 full runs.**

- **Where:** outbound.test.js:285, `expect(during.size).toBeGreaterThan(10)`, received 6.
- **How I ran it:** `oven/bun:1.4.4` in Podman (Linux 6.17, aarch64), against a read-only copy of this round's tree.
- **Cause:** the test, not the server. On Linux there is no `fullfsync`, so the 4,000-op burst is stored in about
  110–150 ms. The poller (one `/health` plus a 5 ms sleep per lap) only sees ~6 distinct points of progress. The loop
  isn't frozen (`/health` kept answering); the test assumes a burst that takes seconds, as it does on macOS.
- **Rest of the suite on Linux:** every other test in it passed. The other "failures" were dirs (web/, scripts/)
  my copy left out.
- **Why MEDIUM:** this machine's PASS bar is met. But PLAN phase 8 runs every gate in CI, which is Linux, and this test
  would fail there most of the time.
- **Fix:** make the burst long enough everywhere (e.g. run until a fixed time has passed rather than a fixed
  count), or assert that `/health` answered while acks were still arriving with a lower bound that scales with the
  burst's duration.

## LOW

| # | Where | What |
|---|---|---|
| R5-L1 | gateway.js:216 (codex lead) | When the next frame would pass `backpressureLimit`, `flush()` sets `blocked`, and the sweep clears it only when the buffer is empty. Only reachable behind a frame near 450 MB, past every spec cap; then frames wait for a full drain rather than a partial one. Reading only |
| R5-L2 | gateway.js `noRoom()` (codex lead; round 4's L1) | One shared frame of any size goes into an empty socket, so a legal ~150 MB snapshot sits on one socket above the 64 MiB user and 256 MB process budgets. It is deliberate (otherwise unjoinable), one at a time per process (the total check sees the first), and logged. Measured: a 233–281 MB footprint while two 155.9 MB catch-ups ran |
| R5-L3 | gateway.js `push()` → `bytesOf` | Every live frame is measured with `Buffer.byteLength` once per receiving connection. Measured on Bun 1.4.4: **0.026 ms per 1 MB frame**, so ~53 ms of CPU per maximum-size op fanned out to 2,000 sockets. Fine for the scaffold; for M4, measure it once per frame in the room host, as is already done for shared text |
| R5-L4 | under the non-reader attack | `/health` took up to **164 ms** at moments (t = 43–79 s, after all non-readers were cut), against ~1 ms in round 4. Measured once; it did not reproduce under the CPU-load runs' tests. Watch it in M4 |

## codex (single harness) leads

| codex said | Outcome |
|---|---|
| HIGH: snapshots over the client's 128 MiB single-message limit | **The accepted gap** (manager: "snapshot in parts" is a queued protocol item). Not a finding of this job |
| MEDIUM: a blocked frame waits for a full drain | True by reading, past the spec caps only: R5-L1 |
| MEDIUM: one oversized snapshot exceeds the budgets | True, deliberate and logged: R5-L2 |
| LOW: the revised tests still assume a kernel buffer / polling speed | **The polling half is confirmed on Linux: R5-M1.** The kernel-buffer half held on Linux too (parked and trickle passed 10 / 10 there) |

## Not verified (round 5)

- A real network; thousands of sockets; power loss; p95; a soak.
- Linux only in a Podman VM, against a copy of the tree taken at the start of this round. On Linux I ran
  outbound.test.js 10× plus the full suite 3×, not the kill -9 gate 30×.
- Browsers' single-message limits (the builder's comment says "untested").
- R4-L2 (a slow honest reader cut repeatedly).
- **Scratch data NOT deleted:** `rm -rf` of my scratch data was refused at the permission prompt (as in rounds 3–4).
  Over 1 GB remains under
  /private/tmp/claude-501/-Users-r-repos-plenary/36dacc5b-4838-42f0-ac31-8af527db897a/scratchpad (`*-data-*`,
  `codex-tree`, `r4-tree`, `r5-tree`, `r4`, `r5`). Someone with permission should delete that directory. The
  `oven/bun:1.4.4` image I pulled for the Linux runs is removed. Every server, client and CPU burner I started was
  stopped by PID.
