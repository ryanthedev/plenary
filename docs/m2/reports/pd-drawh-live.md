# Report: pd-drawh-live (one live run of `drawh --server` against the real Plenary server)

2026-11-12. Brief: docs/m2/briefs/pd-drawh-live.md. No code changed anywhere; this file is the only edit.

**Verdict: the bridge works against the real v1.1 server.** Shapes and settings go both ways, `--once` exit codes
hold, catch-up works, and the bridge reconnects after a server restart. No acknowledged op was lost: the board and
both files agreed element for element, at the same versions. **Two real mismatches with the proposal** matter for the
decision (M1 and M2 below). There are also two pieces of stale text, and one gap on the server side for this run.

## Gates

| Gate | Result |
|---|---|
| Patch sha256 | `f4f9b05a2d3ec81ed6189cf161e539972b81ed37747a5c1815b69831ef4d44e6`, the brief's |
| Applies cleanly to a fresh 5dfe352 | yes: `git clone --local ~/repos/herdr-draw` into the scratchpad, `git checkout 5dfe352`, `git apply --check`, then `git apply` |
| herdr-draw tests, patched clone | **316 pass, 0 fail** (pristine 5dfe352 clone: 258 pass) |
| Protocol copy in the patch vs plenary main | all 7 files byte-identical to `packages/protocol` at dcbdae6 (and at HEAD 601f8e9, where `server/` and `packages/` are unchanged since dcbdae6) |
| herdr-draw untouched | `git status --short` empty, HEAD 5dfe352, no stash; `~/.cache/herdr-draw/plenary` holds only one file from 2026-11-11 (the bridges here used `DRAWH_STATE_DIR` and `HOME` in the scratchpad) |
| Token never printed | 0 hits for any token value in every bridge log, server log, state file and board file; 0 in the bridges' argv; present in the runner's environment (`ps eww`), as the proposal says |

## Setup

- **Two runs.** Run 1 used `bun ~/repos/plenary/server/main.js`. Midway I found other sessions editing plenary's
  working tree (`server/gateway.js`, `server/feed.js`, … modified, uncommitted), so run 2 repeated everything on a
  clean `git clone --local` of plenary at **dcbdae6**. Both runs gave the same results; the numbers below are run 2's
  unless marked.
- **Server:** single node, `PORT=0` (restarts reuse the port it got), `HOST=127.0.0.1`, `PLENARY_DATA_DIR` in the
  scratchpad, and `PLENARY_DEV_TOKENS` with three users: ann and bob (editors, domain `acme.test`) and viv (viewer,
  domain `other.test`). Started from the scratchpad, so Bun loaded no `.env`. PIDs were recorded and only those were
  killed.
- **Board via `POST /boards` (gap S1 below):** I first created a tenant `acme.test` with admin `dev:ann` straight in
  `<data>/registry.db` (`sqliteRegistry(...).createTenant`, the same call test/server/main.test.js makes). Then:
  `curl -X POST /boards -H "authorization: Bearer $ANN" -d '{"title":"drawh live 2","memberRole":"editor"}'` gave
  **201** `{"board":{"id":"b-pnlifuoqjaa0f8mg",…,"memberRole":"editor"}}`. Bob, who is not an admin, got 403.
  `PUT /boards/:b/grants/dev%3Aviv {"role":"viewer"}` gave 204.
- **Clients:** two live bridges, ann on `a.excalidraw` and bob on `b.excalidraw`, each started as
  `PLENARY_TOKEN=… drawh --server ws://127.0.0.1:$P/ws --board $B FILE`. `--once` was run as ann and as viv. A
  third, read-only copy was taken with `viv --once board-copy.excalidraw` to read the board through the real Replica.
  A raw WebSocket probe printed what the server answers.

## What was run, and what happened

| Check | Command (in short) | Result |
|---|---|---|
| A to board to B | ann: `drawh add a.excalidraw …` ×2, then start both bridges | B's new file got both shapes (with labels) | 
| B to board to A, edits | bob: `add` diamond, `move a1 --by 50,50`; ann: `label a2 …` | both files the same, 6 elements at the same versions |
| Layers from the file | ann: `drawh layer a.excalidraw Notes` | B shows the Notes layer |
| Grid from the file | `appState.herdr.grid = 20` written into B (temp file + rename) | A: 20 |
| Untouched old copy | an older copy of A renamed back over A | grid written back to 20, **no line** (R1), as claimed |
| Changed old copy | the same old copy with `grid 40` | board keeps 20; one line: "grid in this file was changed on a copy older than the board's value …" |
| Set again on the current file | `grid 40` on the current A | sent; both files show 40 |
| Room `stale-setting` | both files changed to different grid values at the same moment | run 1: **6 of 6 rounds refused by the room**; bridge A wrote the board's value back with "someone else changed grid on the board just before this change reached it … (dropped from this file: grid 101)". Run 2 (16 rounds): the bridges' own file-side check caught all of them first (17 "older copy" lines); the room had nothing to refuse. Both runs ended with both files and the board on one value |
| `--once`, new file, nothing to settle | ann, file holding one new shape | see **M2**: exit **2** |
| `--once`, same file again | | exit 0 |
| `--once`, empty file with no herdr settings | | exit 0 |
| `--once`, missing file | | exit 0, file created |
| `--once`, viewer with a local shape | viv | "signed in as viewer: changes made in this file are not sent"; exit 2 |
| `--once`, bad token / unknown board | | "the server said no (auth: not allowed)"; exit 1 (the same answer for both, so it doesn't reveal whether a board exists) |
| `--once`, token in the URL | `ws://…/ws?token=abc` | "no token in the URL …"; exit 1 |
| `--once`, no server | `ws://127.0.0.1:1/ws` | "lost the connection"; exit 1 |
| Bridge restart and catch-up | stopped bridge A; meanwhile bob added a shape, and A got a new shape, a move and `snap: true`; restarted A | run 1: all four arrived where they should; 13 elements agree |
| `welcome.room` | probe | `{"board":"b-…","epoch":N}` in every writer welcome. The epoch went 1, 2, 3 across restarts, and the bridge saved it to its state file. A viewer's state kept epoch 0, matching "a writer's welcome" |
| Server stopped mid-run | burst: ann added 120 shapes 0.1 s apart (run 1: 120 to A plus 60 to B); server stopped while 71 were in (run 1: 107 of 120). Run 1 restarted it 4 s later on the same port. In run 2 a bug in my script first restarted it on a random port; I stopped that and restarted on the original port about a minute later | bridges retried with a growing delay and reconnected (run 1: 2, 4, 8 s; run 2: 1, 2, 4, 8, 16, then 30 s, the cap). **No acknowledged op lost**: board (read by viv `--once`), A and B each hold 128 elements, all at the same versions, all 120 burst shapes included (run 1: 253 of 253) |
| Settings change while the bridge was down, across a server restart | stopped bridge B; set `grid 30` and added shape `off1` in B; clean server restart; restarted B | the shape went to the board. **The grid change was discarded** (see M1) |

**The server was stopped with SIGTERM, not SIGKILL.** Auto mode's permission check refused `kill -9` three times. So
what was verified is a stop mid-run that lets the server shut down cleanly, with ops in flight; a crash was not
tested. SIGTERM is also what produces M1.

## Mismatches with the proposal (docs/m2/proposals/drawh-server.md)

**M1. Every clean server restart is taken as "another room". The proposal presents this as an edge case.**
- **Proposal:** "A restart that meets a checkpointed room (the server answers the bridge's tip check with a
  snapshot) is taken as another room …", listed among narrow accepted limits.
- **Live:** the real server checkpoints every room on a clean stop (`server/room-host.js:267-275`, "a checkpoint of
  each … on a clean stop"). After a restart it answers **every** `since` with a snapshot. My probe with
  `since` = 75, 74, 60, 10 and 0 got `{"t":"snapshot","seq":76}` each time. So after every SIGTERM restart, every
  bridge printed "this is not the board this file was last in step with (another server, or one that was reset):
  starting over from its copy". It happened in both runs, on both bridges.
- **Cost:** shapes are fine (they were sent again and agreed). **A settings change made in the file while the bridge
  was down is thrown away:** B's `grid 30` was replaced in the file by the board's 412, with the "older copy" line,
  even though nobody else had touched grid since.
- **Not tested live:** the Room also checkpoints every 1,000 entries (`room-host.js:55`). By the same mechanism, a
  bridge that rejoins after the room has checkpointed past it should get the same false verdict, without any
  restart.
- **What would fix it, per the proposal:** a room id a new store can't repeat (a protocol change). The other option:
  treat a snapshot answer whose `welcome.room` matches board and epoch ≥ the one seen as the same room.

**M2. A new file made by drawh joins a board that has layers with a warning and `--once` exit 2.**
- **Proposal:** "Joining a board that already has layers: the board's settings win over the file's." That reads as
  quiet. And `--once` exit 2 means "changes that could not be sent".
- **Live:** `drawh add c.excalidraw rect …` writes the default `layers` (`[Layer 1]`). Then `drawh --server … --once
  c.excalidraw` printed "layers in this file was changed on a copy older than the board's value …" and "1 change in
  this file did not reach the board", and exited **2**, although the user changed no setting and the shape did reach
  the board. Same in both runs; the viewer case did the same. A file with no herdr settings exits 0.
- **Why it matters:** this is the first thing anyone will do, and a script that checks for exit 0 sees a failure.

**M3. Test counts are stale.** The proposal says `bun test` gives "291 pass (258 before)" and that
`test/plenary.test.js` has "33 tests". Live: **316 pass** (258 before is right), and the file has 45 `test(` calls;
316 − 258 = 58 tests added.

**M4. Statements made untrue by phase 2.** "There is no Plenary server to point it at yet (phase 3)"; under NOT
tested, "A real Plenary server. None exists" and "A real v1.1 server …"; and "Real servers send `welcome.room` only
after engine's p2-swap". The real server at dcbdae6 exists and sends `welcome.room`.

Everything else the brief asked about matched the proposal: both directions, layers, grid, the R1 quiet write-back,
the old-copy line, room `stale-setting` handling, `--once` 0/2/1, catch-up through the state file, the epoch read
and stored, reconnect with a growing delay, token handling, and URL-token refusal.

## Server-side gap (not the patch's)

**S1. `POST /boards` cannot work on a stock single node with dev tokens.** `tenancy.tenantOf` needs a tenant whose
domain is the caller's, and `createBoard` needs the caller in that tenant's admins. `server/main.js` makes only a
domain-less dev tenant with no admins, and nothing else creates a tenant or an admin. So a dev token always gets 403.
I seeded one tenant in `registry.db` to get past it; the dev board (`dev-board.json`) would also have worked. If
`POST /boards` should work on a dev node, main.js (for example, the dev tenant takes each dev token's `domain` and
names it admin) or an admin command is needed. That is platform's call.

## Not verified

- A crash (SIGKILL): denied by the permission check; only clean stops were run.
- Two bridges on one file, a pane beside a bridge, Herdr's QuickJS, wss://, Linux, cluster mode (Postgres + NATS),
  and seeding an old board (versions > 1,000): none of these was in this run.
- The 1,000-entry checkpoint path of M1 (reasoned from the code, not run).
- Plenary `bun test` on the shared working tree (other sessions' uncommitted changes, test count changing between
  runs): one run gave 978 pass / 80 skip / **1 fail** (`test/server/v1.test.js` "a connection is closed with `auth`
  when its token's expiry passes …", a 5 s timeout), and an earlier run 5 fail / 4 errors at a different test count.
  **The clean dcbdae6 clone: 884 pass, 80 skip, 0 fail** (964 tests, 52 files). No plenary code was touched by
  this job.

## Files

- docs/m2/reports/pd-drawh-live.md (this report).
- Scratchpad only, not committed: `hd/` (herdr-draw clone with the patch), `pl/` (plenary at dcbdae6), `run/` and
  `run2/` (data dirs, logs, helper scripts `dh.sh`, `bridge.sh`, `start.sh`, `set.py`, `cmp.js`, `probe.js`, `snap.js`).
  The token files there are mode 600.

## Decision

For the CEO: apply `drawh-server.patch` as is, and accept M1 and M2 as known limits? Or ask for a fix round on M1
(same-room recognition across a checkpoint) and M2 (no warning and no exit 2 for a default `layers` that was never
changed) first?

## Fix round (live findings)

2026-11-12. Asked by t187: fix M1 and M2 in the patch, fix the stale text (M3, M4), test each, run a mutation check,
re-gate, and rerun the live restart and new-file steps. S1 stays with t187.

**Result: both fixed and checked live.** Patch re-cut: sha256 `930623ea2b7b8e207981b5a539e9363207ce9d9002258fce9de76924de7c7310`
(same 3-line header, then `git diff 5dfe352` of the fixed clone; 27 files, as before).

### What changed (in the patch; herdr-draw itself untouched)

| File | Change |
|---|---|
| `cli/bridge.js` (+ its built copy `mods/herdr-draw/cli/bridge.js`, refreshed by `scripts/release.sh`) | **M1:** a snapshot in answer to the tip check is judged by `agrees()` instead of being "another room": it must not be behind the tip, must hold every element this copy confirmed at the same or a later version, and every settings key at the same or a later `appSeq` (the same value at the same one). If it agrees, it is the same room: `skipped()` carries the settings history over (one entry per key the snapshot moved, someone else's unless one of this bridge's landed ops sits at that seq), and the tip becomes `{ seq, id: null, by: null }` so the next run is recognised the same way. Before, the tip was null after a snapshot and the next run started from 0. **M2:** in `settingsFrom`, `layers` equal to drawh's default (`DEFAULT_LAYERS`, what `cli/drawh` `layers()` writes) with no marker for it is skipped: the board's layers are written back quietly, nothing is held |
| `test/plenary.test.js` | 58 → 66 tests as bun counts them (8 new `test(` calls), 2 updated (below) |
| `CLAUDE.md` (herdr-draw's, in the patch) | test count 324; tested live against the real server; the room-recognition rule and the new-file rule |
| plenary `docs/m2/proposals/drawh-server.patch`, `drawh-server.md` | re-cut patch; doc: status, counts (M3), "no server exists" statements removed (M4), recognition rule, layers rule, limits, not-tested |

**About the manager's epoch rule.** The rule asked for was "same room when `welcome.room` names the same board and an
epoch strictly greater than the stored one". I decide by the snapshot's contents instead, with the epoch only ruling
out "lower" (already checked at the welcome). Why:
- **The 1,000-entry checkpoint keeps the epoch.** The brief requires that case to be the same room, so equal epochs
  have to pass.
- **A wiped store can raise the epoch too**, after its own restarts.
- **The contents check gives the right answer in all three cases.** When it accepts a server, that server holds
  everything this copy confirmed, so nothing can be lost by treating it as the same room. Its other settings changes
  count as someone else's: refused out loud, never silently.

**Not changed:** "M1 alternative 1", a room id a new store can't repeat. That would be a protocol change.

### Tests

New:
- **Clean restart** (checkpoint, then `Room.fromLog`: epoch 2, base at the tip): no "not the board" line, nothing
  re-sent, and the offline grid change and offline shape reach the board.
- **Peer changed the key during the gap**, both inside the checkpoint and as an entry after the restart: refused out
  loud, the peer's value stays, `held > 0` (so `--once` exits 2).
- **A running bridge rides a clean restart:** reconnects, no line, nothing re-sent, edits flow both ways afterwards.
- **The 1,000-entry checkpoint at the same epoch**, using the reference Room's own rule (1,100 peer ops):
  - recognised, nothing re-sent, the offline change sent;
  - a peer's change inside a later checkpoint is refused out loud.
- **A wiped or different server that checkpointed past the saved seq** (epoch 1 and epoch 2): still "another room",
  and both sides get everything. The same holds for a snapshot at the same seq with another value at the same
  `appSeq`.
- **The snapshot rules one by one** (the room's real answer, then tampered): behind the tip, a confirmed shape missing,
  a shape at an older version, a key behind, a key missing, another value at the same seq. Each is another room. The
  control, a newer version, and a new value at a later seq are each the same room.
- **An untouched old copy stays quiet across a snapshot** (R1 holds, because the history before the gap is kept).
- **M2:** a new drawh file with a shape takes the board's layers with no line, `held 0`, settled. A viewer has no
  layers line. A board nobody set layers on agrees quietly. Once the file is marked, the default value is a real
  change (sent).

Updated:
- **Seeding test:** a newcomer with the default layers is now quiet (count 0, was 1). A newcomer with other layers is
  still said (added).
- **"Caught up from a snapshot" test:** now expects a snapshot tip, a restart from that seq, no line and nothing sent
  (before: tip null, restart from 0).

**Mutation check** (`scratchpad/mut.js`: apply one change to `cli/bridge.js`, run `test/plenary.test.js`, restore):
13 of 13 caught.
- **`agrees()` rules:** always true; always false; no element check; version not compared; no behind-the-tip check;
  key appSeq may be behind; no same-seq value check.
- **`skipped()`:** does nothing; every jump counted as mine; history restarted instead of carried.
- **Snapshot tip:** none (the old behaviour).
- **M2 rule:** removed; marker ignored.

One more mutation, "M2 rule also when the board has no layers", was equivalent: core's document gives every board
drawh's default layer list. So I dropped that clause from the code. The first pass missed 7 mutations; the tests
were strengthened until each one was caught.

### Gates

| Gate | Result |
|---|---|
| Fresh `git clone --local` of herdr-draw at 5dfe352, `git apply --check` then `git apply` | clean |
| herdr-draw `bun test` there | **324 pass, 0 fail** (258 before; one earlier run in the working clone had a 5 s timeout in the unrelated `drawh frame` test, which passed on every run after) |
| Protocol copy vs plenary main `packages/protocol` | byte-identical, all 7 files (main unchanged there since dcbdae6) |
| herdr-draw untouched | `git status` empty, HEAD 5dfe352 |
| plenary `bun test` | not rerun: no plenary code changed (only docs/m2); the dcbdae6 clone was 884 pass, 0 fail earlier today |

### Live rerun (the freshly applied clone against a clean plenary dcbdae6 clone)

Setup as in run 2: new data dir, tenant seeded, `POST /boards` 201 (`b-x3ljrnu13ua9n84x`), two bridges (ann on A,
bob on B), viewer viv.

| Step | Before the fix | Now |
|---|---|---|
| ann `drawh add c.excalidraw …`, then `--once` (board has layers Layer 1 + Notes) | "layers … changed on a copy older …", exit **2** | no line, exit **0**; file takes the board's layers |
| viv `--once`, new drawh file, no shape | (layers line) | no line, exit 0 |
| viv `--once`, new drawh file with a shape | layers line, "3 changes … did not reach the board", exit 2 | "signed in as viewer …", "1 change …", exit 2 (only the shape) |
| bridge B stopped; B offline `grid 30` and shape `off1`; burst of 120 shapes into A; server stopped (SIGTERM) with 55 in; restarted on the same port 3 s later; B restarted | "not the board" on both bridges; grid 30 discarded | **no "not the board" anywhere**; A reconnected (1, 2, 4, 8 s); board grid **30**; board (viv's copy), A and B: **125 elements, all agree**, all 120 burst shapes, off1 |
| B stopped; B offline `grid 31`; ann (live) sets `grid 77`; server stopped (SIGTERM) and restarted; B restarted | (would have been "not the board", then the older-copy line) | B: one "grid in this file was changed on a copy older …" line; board, A, B: grid **77**; 125 agree; still no "not the board" |

Every process was started with a recorded PID and stopped by that PID. The token showed up in no log or file (same
check as before).

### Security review (automated, on the patch's existing code; not changed here, outside this round's scope)

A background security review flagged three medium findings in code the earlier rounds wrote. I'm passing them on
for you to decide:
1. **The swap helper's Python can load a planted module.** `cli/files.js` runs `python3 -c SWAP` with the caller's
   current directory first on its module search path, so a `ctypes.py` planted in the directory drawh runs from would
   be loaded. Fix: `-I`, plus a trusted `cwd`.
2. **Temp and probe file names are predictable.** `cli/files.js` uses `<board>.plenary-<pid>.tmp|probe1|probe2` and
   follows symlinks. Fix: exclusive create (`wx`) and random names.
3. **Server text reaches the terminal unfiltered.** `cli/plenary.js` `say()` prints server-supplied text (error
   `message`, `user`, `role`), so control characters could reach the terminal. Fix: strip control characters and cap
   lengths.

### Not verified

- **A crash** (SIGKILL is still denied here) and **cluster mode**.
- **The 1,000-entry checkpoint against the real server.** It was run in process only, with the reference Room's own rule.
- **A server stepping back to an older checkpoint.** Reasoned from the code (a bridge that last caught up from a
  snapshot then gets entries: another room, said); not tested.
- Unchanged from the proposal: inside Herdr, a pane beside a bridge, Linux, wss://.

### Risks

- **A server that holds everything this copy confirmed is taken as the same room**, even if it is a different one
  (see above). That is deliberate: nothing in this copy is lost, and that server's settings changes are refused out
  loud.
- **`skipped()` can mistake one of this bridge's own changes for someone else's.** That happens when the bridge's own
  settings op landed while it was cut off (it never saw the seq). The result is a loud refusal, never a silent
  overwrite.

## Security fixes

**Result: all three medium findings fixed, one test each, 16 of 16 mutations caught, gates pass.** Patch re-cut:
sha256 `680ec536efb94dc1090b6976b68722590da78a406254d9b64c43c41afeead2ca` (was `930623ea…`; interim cuts `06fb15e2…` and `cfe3cf29…` are superseded), 6,963 lines.
herdr-draw itself is untouched (still 5dfe352, clean). The "Security review" list above is now resolved by this section.

### What changed (in the patch)

| Finding | Fix | Where |
|---|---|---|
| 1. Python can load a planted module | The swap helper runs `python3 -I -c SWAP` (isolated mode: no current folder, no user site folder, no `PYTHON*` variables on the module path). | `cli/files.js` (`PY`) |
| 2. Predictable, symlink-following scratch names | Every scratch name (`tmp`, `old`, `probe1-3`) is `<board>.plenary-<16 random hex>.<what>`, new for every write, and created with `wx` (O_CREAT\|O_EXCL, which never follows a symlink), or, for the link-mode aside (`old`) and `probe3`, by hard link, which also refuses an existing name. The aside is removed afterwards only if this write made it. Anything already at the name is refused with "refusing to write …: something is already there", and left where it was. The kept-unmerged name also gets a random suffix (it was already a rename, which never follows a link). | `cli/files.js` (`scratchName`, `create`, `probe`, `replace`) |
| 3. Server text reaches the terminal raw | New `clean()`: strips OSC, DCS/PM/APC, CSI and other escape sequences, turns remaining C0/C1 control characters and bidi overrides (U+202A-202E, U+2066-2069, U+200E/F, U+061C) into `?`, caps the line at 600 characters plus "… (cut)". `say()`, the print path of `drawh --server` (plenary.js and bridge.js; drawh's other commands are unchanged), runs every line through it, with the token masked before and again after (so stripping an escape out of an echoed token can't put it back together). A server frame that is not JSON is caught and never printed. | `cli/bridge.js` (`clean`), `cli/plenary.js` (`say`) |

Not done, on purpose: mode 0600 on the scratch file (it becomes the board file, so it would change the board's
permissions). A trusted `cwd` for python is not needed with `-I`.

### Bugs the new tests found (fixed)

- **The probe deleted a symlink it had refused.** Its cleanup removed all three probe names, including a planted one.
  Now it removes only files it created itself.
- **Link mode silently replaced a planted link.** When falling back from swap, the probe deleted the name before
  creating it, so a planted link was removed and the write went through. Now it deletes only its own earlier file.
- **Link mode's aside and `probe3` were not covered** (found in review). The aside is made by hard link, not `wx`:
  a link at that name made the write fail, and the cleanup then deleted the planted link. A link at `probe3` was
  taken as "this disk has no hard links" and dropped the bridge to the no-write mode. Now both refuse (EEXIST), and
  the aside is removed only if this write created it.

### Tests (test/plenary.test.js, 69 pass; full herdr-draw suite 327 pass)

1. **Python isolation** (macOS): a `ctypes.py` that writes a marker is planted in the current folder and in
   `PYTHONPATH`; after a replace, no marker, the mode is still "swap", and the swap worked.
2. **Scratch names**, in swap and link mode: names match `.plenary-<16 hex>.<what>`, are all distinct and hold no pid;
   a symlink to a victim file planted at each name the mode uses (swap: tmp, probe1, probe2; link: tmp, old, probe1,
   probe3) is refused, the victim and the board
   are unchanged, the link is left in place; with fresh names the next write works.
3. **Clean output**: unit checks on `clean()` (OSC with BEL and with ST, OSC 8 links, CSI, DCS, controls, bidi, the cap,
   ordinary Unicode kept), and end to end against a hostile stand-in server whose hello error carries a title-setting
   OSC, a clear-screen CSI, an OSC 8 link, U+202E, `\r`, NUL and 5,000 characters: drawh exits 1 with "the server said
   no", and its stderr has no control or bidi characters, no escape payload, is under 1,000 characters and ends "… (cut)".
   The same server then answers hello with a frame that is not JSON (an OSC title and a clear-screen in it): drawh fails,
   and stderr has no control characters and no payload. Then it echoes the token back with `ESC[0m` inside it: stderr
   shows `***`, never the token.

### Mutation check (16 of 16 caught)

python without `-I`; pid-based names; plain write instead of `wx`; probe removes what it didn't make; link probe
deletes first; `clean()` returns its input; no length cap; no OSC stripping; no control-character pass; `say()` without
`clean()`; aside removed even when another left it there; aside link EEXIST not refused; probe3 EEXIST taken as
"no hard links"; token masked only before `clean()`; a non-JSON frame thrown with its text. Each was applied to the code, the tests run, and the code restored.

### Gates

- **Fresh clone:** `git clone --local ~/repos/herdr-draw` at 5dfe352, `git apply --check`, then apply: clean.
- **herdr-draw tests on the applied clone:** 327 pass, 0 fail.
- **Protocol copy == plenary main:** all 7 `packages/protocol/*.js` at plenary HEAD identical (`cmp`) to the patch's
  `protocol/`. (The working tree's `ports.js` has another session's uncommitted edit; it is not in the patch.)
- **herdr-draw checkout:** HEAD 5dfe352, but no longer clean: someone else's uncommitted edits (2026-11-12 ~07:45,
  `CLAUDE.md`, `core/editor.js`, `core/geometry.js`, their mods copies, `test/arrows.test.js`). Not ours (this job
  only reads it). The patch applies to 5dfe352 as committed; on top of that uncommitted `CLAUDE.md` it does not
  (`patch failed: CLAUDE.md:44`), so whoever applies it must commit or set aside that edit first, or re-cut.

### Not verified

- The isolation test runs on macOS only. Elsewhere python runs once, for the probe (with `-I`, and it exits at once
  because the platform is not macOS); that path is not tested here.
- Not rerun live against the real server this round; the changes touch only file writing and printing, and the
  hostile-server test covers the print path end to end.
