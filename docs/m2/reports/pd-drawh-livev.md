# Report: pd-drawh-livev (verify the drawh live fixes and security fixes, re-run live)

2026-11-12. Brief: docs/m2/briefs/pd-drawh-livev.md. Job under check: pd-drawh-live (fix round M1-M4 and the three
security fixes). Patch: docs/m2/proposals/drawh-server.patch, sha256 `680ec536…ca`, matches the brief. This file is
the only edit; no code, patch or commit was touched.

**Verdict: PASS.** Every gate passes, M1-M4 hold live against the real server from plenary HEAD (22c28cc), and the bar
held in every run: no silent loss of a user's edit, no peer change undone, no acknowledged op lost. Each security fix
works as claimed and each one's mutation fails a test. Findings are LOW only (L1-L7 below): no HIGH, no MEDIUM.
The one that matters most for M1 is **L4**: a pre-existing tip-check bug that still gives a false "another room"
verdict (loud, nothing lost) when a bridge's op landed but its ack was lost.

## Gates

| Gate | Result |
|---|---|
| Patch sha256 | `680ec536efb94dc1090b6976b68722590da78a406254d9b64c43c41afeead2ca`, the brief's |
| Fresh `git clone --local` of herdr-draw at 5dfe352: `git apply --check`, then `git apply` | clean |
| herdr-draw `bun test` on the applied clone | **327 pass, 0 fail** (after `bun install --frozen-lockfile`: a fresh clone has no `node_modules`, so without it 14 snapshot tests fail on `playwright-core`; not the patch's) |
| The 7 protocol files vs plenary HEAD (`git show HEAD:packages/protocol/*.js`) | all 7 byte-identical |
| Working tree's uncommitted `packages/protocol/ports.js` | differs from HEAD, **only in JSDoc comment lines** (the server-side `Store` typedef: epoch fencing, lease, `lastSeq`, `close`). drawh uses only the Replica, codec and envelope, never `Store`. **Does not matter to drawh**; when it is committed, the patch's copy will need a re-copy for byte-identity only |
| plenary `bun test`, main tree | 1083 pass, 112 skip, **1 fail**: `(fail) packages/core is still herdr-draw's core (re-copy when herdr-draw's core changes)`. That test reads the sibling `~/repos/herdr-draw/core/`, which holds someone else's uncommitted edits (`core/editor.js`, `core/geometry.js`). Not related to drawh |
| herdr-draw committed state | HEAD 5dfe352, no stash. Its working tree still has the same 6 uncommitted files from someone else (`CLAUDE.md`, `core/editor.js`, `core/geometry.js`, their `mods/` copies, `test/arrows.test.js`); untouched by this job |

## Live re-run (real server, plenary HEAD 22c28cc, single node)

**Setup.** A clean `git clone --local` of plenary HEAD in the scratchpad (the main tree has other sessions'
uncommitted `server/` edits). Server: `PORT=0` (it got 62039; every restart reused that port), `HOST=127.0.0.1`,
`PLENARY_DATA_DIR` in the scratchpad, started from the scratchpad (no `.env` loaded), PID recorded, only that PID
stopped. `PLENARY_DEV_TOKENS`: ann (editor, `acme.test`, `"admin": true`), bob (editor, `acme.test`), viv (viewer,
`other.test`); tokens random, in mode-600 files, passed only as `PLENARY_TOKEN`.

**S1 from the earlier run is closed on HEAD.** The start logged `dev tenant … created: true, added: ["dev:ann"]`.
`POST /boards` with ann's Bearer: **201** (`b-zt4utxc2qfwcpur4`, ann is `owner`); bob: **403**;
`PUT /boards/:b/grants/dev%3Aviv {"role":"viewer"}`: **204**. No registry seeding was needed.

| Check | What I ran | Result |
|---|---|---|
| A to board to B | `drawh add a.excalidraw rect/ellipse`, `--once` as ann, then `--once` as bob on a new `b.excalidraw` | B got all 4 elements at the same versions |
| Both ways, live | two bridges (ann on A, bob on B); `add` in B, `move` and `label` in A, `layer a.excalidraw Notes` | 6 elements agree; B shows the Notes layer. Only the per-file `plenaryBase` markers differ, as designed |
| Grid from the file | `appState.herdr.grid` written by temp file + rename | B 20 reached A; A 25 reached B |
| Old copy, **peer** change since | copy of A taken; bob sets grid 50; the untouched copy renamed back over A | board and both files keep **50**, no line (R1) |
| Same old copy, changed (grid 60) | | board keeps **50**; one line: "grid in this file was changed on a copy older than the board's value (someone else set it since) …" |
| Old copy, **own** change since | copy of A; ann sets 25; untouched copy back | board went back to 20. This is the brief's known, accepted MEDIUM (an old save of the same file undoes its own settings change); not re-graded |
| Room `stale-setting` | 10 rounds: A and B set different grids at the same instant | 10 of 10 refused by the room, out loud on A ("someone else changed grid on the board just before … (dropped from this file: grid 10N)"); every round ended with board, A and B on one value |
| `--once` | new drawh file with a shape (board has Layer 1 + Notes) | no line, **exit 0** (M2 fixed) |
| | same file again / missing file (created) | exit 0 / exit 0 |
| | viewer, new drawh file, no shape | no line, exit 0 |
| | viewer, file with one shape | "signed in as viewer …", "2 changes in this file did not reach the board" (rect + label), **exit 2** |
| | bad token / unknown board | "the server said no (auth: not allowed)", exit 1 (same answer for both) |
| | token in the URL / no server / no token | "no token in the URL …" / "lost the connection …" / "--server needs a token …", each exit 1 |
| Bridge restart and catch-up | stopped bridge A; bob added a shape; A got a shape, a move and `snap: true`; restarted A | all four arrived; 12 elements agree, `snap` on B |
| `welcome.room` | raw WebSocket probe (`probe.js`), and the bridges' state files | `{"board":"b-zt4utxc2qfwcpur4","epoch":4}` after three restarts, for writers (with `high`) and the viewer; writers' state files stored the epoch (1, then 2, then 4); viewer-only files kept 0 |
| Server stopped mid-run | a deleted shape first (a tombstone in the checkpoint); bridge B stopped, B offline: `grid 30` and shape `off1`; burst of 120 shapes into A 0.1 s apart; server stopped with 62 elements in A; restarted on the same port 3 s later; B restarted | ann reconnected with 1, 2, 4, 8 s backoff. **No acknowledged op lost**: A, B and the board (read by viv `--once`) each hold **254 elements, same versions**, all 120 burst shapes and `off1`. **B's offline grid 30 reached the board** and **no "not the board" line anywhere** (M1 fixed live, with a tombstone in the snapshot) |
| Snapshot-based rejoin, room not restarted | B behind a checkpoint, caught up by snapshot, stopped; ann adds a shape; B offline `grid 33`; B restarted | no "not the board"; grid 33 on the board and both files; 258 agree. The real catch-up rule (`catchUp`, `packages/protocol/room.js:33`) always leads with a snapshot when `since` is below the checkpoint, so a snapshot-tip bridge is judged by `agrees()` again |

**The server was stopped with SIGTERM, not SIGKILL.** The permission check refused `kill -9` (as in the earlier run).
I did not work around it with another signal. So a crash (no clean checkpoint) is still untested.

### M1-M4 re-checked

| Claim | Verdict |
|---|---|
| M1: a clean restart is the same room; an offline settings change survives | **Confirmed live** (grid 30 and grid 33 runs above; zero "not the board" lines across four restarts), with **one in-process counter-case (L4)**: an op that landed while its ack was lost still gets the old "another room" verdict |
| M2: a new drawh file joins quietly, `--once` exit 0 | **Confirmed live** (ann exit 0, viewer exit 0, viewer with a shape exit 2 for the shape only) |
| M3: test counts | **Confirmed in the proposal doc** (327 pass, `test/plenary.test.js` 69 tests, both measured here). **Not in the patch:** its `CLAUDE.md` still says "`bun test` (324 tests)" (L7) |
| M4: "no server exists" text removed | **Confirmed in the proposal doc and the patch's `CLAUDE.md`.** **Not in the patch's test file:** `test/plenary.test.js` line 2 still says "there is no Plenary server yet" (L7) |

## Security fixes, adversarially

| Fix | Attack | Result |
|---|---|---|
| `python3 -I` | `ctypes.py` that writes a marker, planted in the cwd (`evil/`) and on `PYTHONPATH` (`pp/`); a stale board copy so the bridge must write | patched: **no marker**, the swap ran, the new shape was written. **Control:** a clone with `-I` removed imported the planted module (marker `PWNED-evil`) and fell back to link mode. So the live path really runs the helper and `-I` is what stops it |
| Random O_EXCL scratch names | names are 16 random hex per write, so nothing can be pre-planted by name; the suite's own planted-link tests cover pre-creation. I raced instead: a loop that, for 20 s while bob's edits made A's bridge write, swapped a symlink to `victim.txt` in at every `a.excalidraw.plenary-*` name it saw | `victim.txt` **never written**. The racer hit `.tmp` twice, **after** the bridge had created it: see **L3** |
| `say()` cleaning and masking | hostile stand-in server (`hostile.js`, 9 modes): OSC 52 clipboard, CSI clear and colour, DCS, 8-bit C1 CSI `\x9b`, U+202E, U+2028, U+200B, an unterminated OSC title, 5,000 characters; the same in `welcome.user`; a non-JSON frame with escapes and the token; a 5 MB error message; the token echoed split by `ESC[0m`, by an OSC, by `\x01`, by U+200B, and split by an escape across the 600-character cap | no ESC, C0/C1 or bidi override reached stderr in any mode; no OSC/DCS payload; non-JSON frame never printed; 5 MB cut to 615 characters; token split by an escape or OSC shown as `***`. **Gaps: L1, L2** |

**Mutation check, one per fix** (each in its own copy, `bun test test/plenary.test.js`; baseline 69 pass):

| Mutation | Result |
|---|---|
| python without `-I` | 1 fail |
| `create()` with `w` instead of `wx` | 1 fail |
| `say()` without `clean()` | 1 fail |
| token masked only before `clean()` | 1 fail |
| `agrees()` always false (M1) | 7 fail |
| M2 default-layers rule removed | 2 fail |

## Ensemble review (sdd)

Reviewers: **codex** (effort high) and **grok**, each on its own copy of the tree with the code delta since 6961449
(`cli/bridge.js`, `cli/files.js`, `cli/plenary.js`, `test/plenary.test.js`). **agy** was out of quota (resets in about
54 h); **kimi** (not logged in) and **mistral** (no API key) failed `check_adapter`; qwen is not installed.

- **grok:** no findings.
- **codex:** two findings, no agreement from grok, so neither is a HIGH candidate. I tested both in process with the
  suite's own helpers (`rig`, `peer`, `restart`; scratch file `hdx/test/x.test.js`):
  - *"HIGH: `agrees()` accepts a fork with the same ids at higher versions; an unsent file edit is silently replaced."*
    **Not confirmed; my probe did not exercise it.** Instrumented, `agrees()` was never called in my fork case (the
    fork room renumbered the new-to-it shape to version 1). Refuted by reasoning only: when a peer's higher version
    meets an unsent file edit, the same thing happens inside the real room (probe: the peer's x = 99 wins). That is the
    element model's ordinary last-writer-wins, unchanged by this patch. And accepting a server that holds everything
    this copy confirmed is the builder's documented, deliberate risk. Graded LOW at most, not a finding here.
  - *"MEDIUM: `skipped()` records only the final appSeq, so an old copy with my earlier value is quietly overwritten."*
    **Refuted as silent.** My grid 20 landed while cut off, bob then set 30, the room restarted: board and file kept
    bob's 30, and both old copies were refused out loud. **But, instrumented, `skipped()` never ran:** the rejoin
    always took the L4 path first (`otherRoom` on an `ack`), and the loud lines came from the dropped markers. So this
    finding is **not exercised**. Reasoning: its precondition (my op landed while its ack was lost) is exactly what
    triggers L4, so today it is shadowed by L4, and it becomes reachable once L4 is fixed. Whoever fixes L4 should
    add codex's case as a test (own settings op landed in the gap, a peer's after, then an old copy carrying my
    value: it must be refused, not overwritten quietly).

## Design skill (distributed-systems-design, CHECKER, on the reconnect and catch-up path)

Skill `systems-design` v0.1.0, CHECKER mode, applied from SKILL.md's checklist (the client-sync questions of its
chat-system and file-sync chapters: message sync on reconnect, conflict resolution, failure of every component). The
infrastructure items (load balancer, CDN, sharding, cache) belong to the server, not this client path: not applicable.

| Check | Finding |
|---|---|
| Consistency model named | Yes: one sequencer per board, the client converges to it; settings use appSeq with loud refusal; elements use last-writer-wins by version. Matches CLAUDE.md ("eventually consistent; an acknowledged op is never lost") |
| Message sync on reconnect | `since` = the tip, checked by op id and author, or by `agrees()` when the answer is a snapshot. Matches the real `catchUp` rule (snapshot first when `since` is below the checkpoint). Verified live across four restarts |
| Identity of the other side | `welcome.room` (board, epoch) rules out a lower epoch; contents decide the rest. **Gap (documented):** no room id a new store can't repeat, so a different server that holds everything this copy confirmed passes. Loss-free by construction (it holds all of this copy); a protocol change would close it |
| Idempotent resend | Pending ops keep their ids across reconnects; an "another room" verdict resends shapes and the room's version rule decides. No duplicates seen live (254 = 254 = 254) |
| Retry and backoff | Exponential, 1 s doubling to a 30 s cap (`RETRY_MAX`), no jitter. **LOW:** after a server restart every bridge retries on the same schedule (a small thundering herd). Harmless at drawh's scale (a few agents per board); add jitter before many bridges share a server |
| Failure of each component | Server clean stop: verified. Server crash: **not verified** (SIGKILL refused). Network loss with an op landed and its ack lost: **L4** (loud, no loss). Disk: the swap/link/none modes, and L3 for a hostile folder writer. State file lost: start over from the board (loud) |
| Durability of the client's own state | The state file holds tip, epoch, confirmed versions and landed ops; it is written after each change. A crash between a write of the board file and of the state file was not tested |
| Single point of failure | The board's room host, by design (one sequencer per board, with lease and takeover on the server side). Cluster takeover against the bridge: not tested |

**Verdict:** the reconnect and catch-up design is sound for the bar. Open items: the documented room-identity gap,
L4, no jitter, and the crash path.

## Findings

No HIGH. No MEDIUM.

**L1 (LOW). Token masking can be dodged by a hostile server, so parts of the token can reach the terminal.** `say()`
masks the exact token before and after `clean()`. Live, against `hostile.js`:
- token echoed with `\x01` inside: printed with a `?` in the middle, both halves visible;
- with U+200B (zero-width space) inside: printed as-is, so it **looks like the whole token**;
- split by an escape that straddles the 600-character cap: the first half printed, the rest cut.

Only a server that already holds the token (it arrives in `hello`) can do this, so the harm is exposure on screen or in
logs, not theft. Fix idea: mask after normalising (strip every character outside printable ASCII before comparing),
or refuse to print any line containing a long run of the token. The builder's claim ("masks the token before and after
cleaning") is literally true; the gap is that only an escape split is covered.

**L2 (LOW). `clean()` passes U+2028/U+2029 and zero-width characters.** U+2028 (line separator) and U+200B came
through in `the server said no (…)` and in `as <user>`. They don't steer the terminal (no escape), but U+2028 can
break a line in some terminals and log viewers, and zero-width characters make spoofed text (L1, a fake user name)
look exact. Fix: add `  ​-‍﻿` to the replaced set.

**L3 (LOW, outside the fix's claim). A writer in the board's folder can swap a symlink in at the `.tmp` name after the
bridge creates it.** The race above: the swap then put the symlink at `a.excalidraw`, and the next swap moved the
old board out to the `.tmp` name, where the racer replaced it (that local copy's content was gone; every op was
already on the board, so nothing acknowledged was lost). `victim.txt` was never written through, and every later
write by the bridge or drawh renames over the link rather than following it. Anyone who can write the folder can
delete the board file anyway, so this is no new power. The fix only claims exclusive creation, which holds.

**L4 (LOW). A residual false "another room" verdict: own op landed while cut off, then a restart.** In process
only: the bridge sends an op (a shape or a setting), its ack is lost, the room checkpoints and restarts, the bridge
rejoins. Result: "this is not the board this file was last in step with", the file's shapes are sent again, and its
settings markers are dropped, so an untouched old copy then gets a loud line instead of a quiet write-back.
Nothing is lost and the board is right (shape on the board; peer's grid kept). With no op in flight the same rejoin is
recognised. **Cause (instrumented):** after the hello the bridge re-sends the pending op. The room has it already, so
it answers with an `ack` before the catch-up. `take()` treats the first message after the welcome that isn't an
id-less error as the answer to the tip check (`this.check`). An `ack` is not `entries`, so the tip check fails and
`otherRoom()` runs (log: `otherRoom<-ack`). This holds whether or not the old connection's ack was delivered. The
logic is the same in the 6961449 patch (pre-existing, not introduced by this round). Fix idea: let only `entries` or
`snapshot` answer the tip check. Live, the SIGTERM burst with ops in flight did not hit it, so the window looks narrow.
It also shadows codex's MEDIUM (above).

**L5 (LOW, gate hygiene, already documented).** A fresh herdr-draw clone needs its dependencies before `bun test`;
without them 14 tests fail on `playwright-core`. The proposal doc already says so (`cp -R ~/repos/herdr-draw/node_modules .`).

**L7 (LOW, stale text in the patch).** The patch's `CLAUDE.md` says "`bun test` (324 tests)" (327 measured), and
`test/plenary.test.js` line 2 says "there is no Plenary server yet". The proposal doc itself is current.

**L6 (LOW, design check).** Reconnect backoff has no jitter (`cli/plenary.js:120`: doubling to a 30 s cap). All
bridges on a restarted server retry in step. Harmless at today's scale.

## Not verified

- A crash (SIGKILL): refused by the permission check; only clean stops were run.
- Cluster mode (Postgres + NATS), wss://, Linux, inside Herdr (QuickJS), the pane beside a bridge.
- The 1,000-entry checkpoint against the real server (in-process only, as before).
- L4's cause.
- Pre-planted files or links at scratch names, independently: I only raced (names are random). Pre-creation is covered
  by the builder's tests and by my `wx` mutation (1 fail).
- `PYTHONPATH` alone without a cwd plant (both were planted together live; the suite tests each).

## Process notes

- **A scratch dev token was printed in my own session output** (two `repr` lines of the hostile-server results showed
  the raw stderr for the `\x01` and U+200B modes, which is finding L1). It never left this machine, it is not in this
  report, it was valid only for my scratch server (now stopped), and the token files are deleted.
- Every process I started was stopped by its recorded PID. A grep for the full, unbroken token over every log,
  state file, board file and stderr capture in the scratchpad found none. The three stderr captures that held split
  halves (the L1 modes) are deleted.
- Scratchpad (not committed): `hd/` (applied clone), `hd-old/` (6961449 patch), `delta.diff`, `pl/` (plenary HEAD),
  `live/` (start, bridge, probe, hostile and racer scripts, logs), `mut.sh`, `hdx/test/x.test.js` (probes).
