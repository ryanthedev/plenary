# Proposal: `drawh --server` (herdr-draw talks to Plenary)

2026-11-12, round 4: moved onto protocol v1.1 (settings compare-and-set); file-side settings are back. Final check by pd-drawh4v (patch f4f9b05a…): FAIL by the letter on one ~20 ms same-batch window (F5, listed under
limits), accepted under the manager's hard stop; everything else holds, no peer change undone.

2026-11-12, security fixes (pd-drawh-live; patch **680ec536…**): the three medium findings of the security review are
fixed in the patch: the swap helper runs `python3 -I` (no planted module is loaded), scratch files beside the board get
random names and are created exclusively (a file or symlink already at the name is refused, never followed), and
every line the bridge (`drawh --server`) prints has control characters and terminal escapes stripped, the token masked
before and after, and is capped at 600 characters. One test each, 16 of 16 mutations caught. Report: docs/m2/reports/pd-drawh-live.md, "Security fixes".

2026-11-12, live run and fix round (pd-drawh-live; patch 930623ea…, superseded by 680ec536…): run against the real Plenary server (dcbdae6,
single node). It worked, and found two faults, both fixed in this patch: every clean server restart was taken as
"another room" and threw away a settings change made while the bridge was stopped (M1); a new drawh file joining a board
exited `--once` with 2 and a false warning (M2). Report: docs/m2/reports/pd-drawh-live.md. **Decision needed: apply
`drawh-server.patch` to herdr-draw, or not.** Nothing is applied; herdr-draw is untouched (still at 5dfe352, clean).

## What it does

`drawh --server URL --board ID [--token T] [--once] FILE` keeps one `.excalidraw` file and one Plenary board in step
until stopped. The pane and every other drawh command keep working on the file as today, so the pane shows the live
board with no network code of its own.

| | |
|---|---|
| **File → board** | Elements the file has newer (by `version`) go out as protocol ops, through a protocol `Replica`, with the file's own versions (`keepVersions`). Layers, grid, snap and timeline changed in the file go out too, judged by the base the file was built on, and the room's compare-and-set settles the rest (below). |
| **Board → file** | Entries from the room are merged into the file (newer version wins), other fields of the file kept. |
| **Sign-in** | The token is sent in the first message (`hello`) only. No header, never in the URL (a URL carrying one is refused), never printed, never on disk. From `--token` or `PLENARY_TOKEN`. |
| **Catching up** | `since` comes from a small state file (`~/.cache/herdr-draw/plenary/<hash>.json`): the next run asks only for what is new, and sends edits made while it was stopped. |
| **First send (seeding)** | The room refuses a version more than 1,000 past its own copy, and a shape it has never had counts as version 0. So a shape new to the board whose version is past 1,000 (an old board) goes out as version 1 with a new nonce and the same id, and the file is renumbered to match. Every other shape is sent with its version unchanged. |
| **`--once`** | Catch up, send, wait for the acks, exit. Exit 0: file and board agree. Exit 2: they agree except for changes that could not be sent (refused, or a read-only role). Exit 1: anything else. |
| **Without `--server`** | drawh runs the same code as today. `--server` is the switch only before a command word and before `--`; after either it is ordinary text. |

## What is in the patch (against herdr-draw 5dfe352)

| Path | What |
|---|---|
| `protocol/` + `SOURCE.json` | plenary's `packages/protocol`, byte for byte, at plenary 5d55112 (p2-land, protocol v1.1), sha256 per file. Beside `core/`, because its files import `../core/doc.js`. |
| `cli/bridge.js` | the deciding (no I/O): diff file against replica, send, merge back, saved state, checks on what the server sends |
| `cli/files.js` | replaces the board file without losing someone else's save (below) |
| `cli/plenary.js` | the runner: socket, reconnect with a growing delay, deadlines, exit codes. Node 22+ or bun |
| `cli/drawh` | `--server` mode: checks flags and path, starts the runner with the token in its environment (not argv) |
| `scripts/build.sh`, `mods/herdr-draw/` | the built mod carries the bridge and the protocol copy (herdr-draw's release test needs the refreshed build) |
| `test/plenary.test.js` | 69 tests |
| `CLAUDE.md` | shape and gotchas |

## A save by someone else while the bridge is writing (the verifier's HIGH finding)

drawh and the pane save by read, change, write a temp file, rename. Nobody locks. The first cut of this patch did the
same with a late check, and the verifier measured saves vanishing without a word (1 in 165 on a 2,000-element board,
13 in 498 with both sides flat out).

- **Now:** the bridge never renames over the board blind. It exchanges its new file and the board in one atomic step
  (macOS `renamex_np(RENAME_SWAP)`, called through a one-line python because node and bun have no call for it), reads
  what it took out, and if that isn't what it expected, merges it: every element at its winning version, pictures
  from both, then sends what was new. There is no window.
- **Which disks swap.** Before its first write the bridge tries the swap on two scratch files beside the board,
  because not every disk that accepts the call does it (FAT says yes and just renames). Checked on disk images:
  APFS swaps; HFS+ can't and gets the fallback below; FAT and exFAT can neither swap nor hard-link, so there the
  bridge refuses to replace the board file at all and says so (what is in the file still goes to the board; a new
  board file can still be created).
- **Fallback** (a disk that can't swap, or `DRAWH_WRITE=link`): hard-link the board aside, rename over it, read the
  linked copy, merge if it differs. A save landing while those two calls run can't be seen by anything and is
  lost. drawh's saves can be seen coming (its temp file), so the bridge waits for one to land first; the pane's
  can't. The bridge says so once at start when it has to work this way. This is the fix the manager asked for; the
  swap goes one step past it.
- **Measured** with the verifier's own scripts, unchanged, against this patch:

| Row (the verifier's) | Before (verifier) | Swap (default) | Link, as directed | Link + waits for drawh (shipped fallback) |
|---|---|---|---|---|
| control: 300 elements, no entries from others | 0 of 79 | 0 of 235 | 0 of 235 | 0 of 156 |
| 300 elements, 5 entries a second (two rows) | 0 of 350 | 0 of 1,044 | 0 of 1,045 | 0 of 696 |
| **2,000 elements, 5 entries a second** | **1 of 165** | **0 of 492** | **1 of 492** | 0 of 328 |
| 300 elements, 1 entry a second | 0 of 175 | 0 of 524 | 0 of 523 | 0 of 348 |
| growing board, about 18 entries a second | 1 of 59 | 0 of 176 | 1 of 176 | 0 of 177 |
| growing board, about 35 entries a second | 0 of 234 | 0 of 685 | 1 of 680 | 0 of 691 |
| **growing to about 4,400, both flat out** | **13 of 498** | **0 of 1,385** | **2 of 1,368** | 0 of 1,446 |
| **All rows** | **15 of 1,560** | **0 of 4,541** | **5 of 4,519** | **0 of 3,842** |

Lost saves of saves made. Swap and "link, as directed" ran every row three times; the shipped fallback ran the first
four rows twice and the last three three times.

- **Read it as:** the swap loses nothing. The directed fix alone loses fewer saves than the first cut (5 of 4,519
  against 15 of 1,560), not none: its two calls take about a quarter of a millisecond together (they queue on the
  folder with the other writer's rename). The shipped fallback's zeros are real for drawh, whose saves it can see coming by their
  temp file, and the measurement's writer saves the way drawh does. **A pane save is not visible that way**: in
  fallback mode it has the "as directed" column's odds. On a Mac's own disk the fallback is not used.

- **Still true:** this protects against the bridge. drawh can still overwrite a pane save and the reverse, as they
  could before this patch. Only a lock all three take closes that; this patch adds none.
- **Assumes** every writer replaces the file by rename. drawh, the pane's `writeTextFile` ("replaced atomically") and
  its big-file path (`mv`) do. A tool that writes the board in place could still lose a save.

## Board settings: changed from the file again, on protocol v1.1 (round 4)

v1.1 makes settings compare-and-set: each settings op names, per key, the `appSeq` it was based on, and the room
refuses a stale one (`stale-setting`, soft). The Replica stamps that base from **its** copy, so the bridge must still
know which copy of the file a save was built on: otherwise a stale save would go out on the current base and be
accepted (a test shows it). So the file carries a small marker, and there are two checks, one per hop.

- **The marker.** Every bridge write puts `appState.herdr.plenaryBase` in the file: per key, the base the file's value
  stands on (and, while the bridge's own op for it is in flight, that op's id). It is never sent. A file the bridge
  never wrote is judged by the bases it had when the bridge first found it in step.
- **File → bridge, per key whose value differs from the board's:**
  - nobody else changed the key since the file's base: **sent** (a deliberate revert, a quick toggle, your own undo);
  - someone else did, and the file still holds the value it was written with, and the bridge sent nothing on the key
    since: an old copy of the file, untouched (an agent's save that read it before). **The board's value is written
    back, quietly** (R1);
  - anything else (a change made on an old copy, or one whose op was lost): **the board's value is written back, with
    one line** ("… was changed on a copy older than the board's value …; to change it, set it again"). Setting it
    again on the current file is sent.
- **Bridge → room:** the room's check covers what the bridge hasn't applied yet. `stale-setting` is soft: the board's
  value is written back with one line naming the key and the value(s) dropped, and that key waits for the Replica's
  `retryReady` before a new change to it is judged. A change made meanwhile (even before the write-back has landed:
  any value other than the dropped ones) stays in the file, unsent and not overwritten, and is judged when the gate
  opens, out loud if it was made without the peer's value.
- **After sending a settings change** the bridge writes the file once (a fresh marker), so the next copy can be told
  from the old one. A disk that refuses the write costs the marker, not the change.
- **`--once`** exits 2 when a settings change did not reach the board (refused, or kept back with a line).
- **Seeding** falls out of the same rule: a key the board has never set has no one else's change since base 0, so the
  file's value is sent.

## Decided: which shapes are renumbered, and to what

- **Which (platform manager, engine agreeing, 2026-11-11):** only shapes the room would refuse: new to the board and
  past version 1,000. The first fix round renumbered every new shape above version 1; that let an open pane's
  remembered copy silently overwrite later edits to ordinary shapes (`drawh add --label` alone makes a version 2
  shape). Narrowing it confines the hazard to old boards.
- **To what: 1.** The engine track suggested 1,000, "unless a test shows a reason for 1". One does. Every copy a pane
  can still remember of a renumbered shape is past 1,000, so 1,000 outranks none of them; the number only decides
  how many remembered copies slip under the room's jump limit. Renumbered to 1, a remembered copy at 1,500 is held
  back with a warning. Renumbered to 1,000 it is sent and wipes out the other person's edit without a word (tried:
  the test "renumbering to 1 keeps a pane's remembered copy at 1,500 out…" fails with 1,000). With 1 the silent band
  is a shape that was at 1,001 or just above; with 1,000 it is everything from 1,001 to 2,000.

## How to try it (two minutes, in a scratch clone, not your checkout)

```sh
git clone --local ~/repos/herdr-draw /tmp/hd && cd /tmp/hd
git apply ~/repos/plenary/docs/m2/proposals/drawh-server.patch
cp -R ~/repos/herdr-draw/node_modules . && bun test          # 327 pass (258 before)
```

The tests start a local WebSocket around the protocol's reference `Room` and run the real `drawh --server` against it.
Against the real server: `bun server/main.js` in plenary with `PLENARY_DEV_TOKENS` set (main.js's header), a board id
(the dev board in `<data>/dev-board.json`, or `POST /boards`), then
`PLENARY_TOKEN=… drawh --server ws://127.0.0.1:PORT/ws --board ID FILE` (the commands of the live run are in
docs/m2/reports/pd-drawh-live.md).

## What was checked

- **Patch:** `git apply --check` and apply in a fresh clone of 5dfe352; `bun test` there: 327 pass, 0 fail. The
  protocol copy is byte-identical to plenary main's `packages/protocol` (unchanged since dcbdae6).
- **Live, against the real server** (plenary dcbdae6, single node, dev tokens; pd-drawh-live): shapes and settings both
  ways between two bridges, stale copies, the room's `stale-setting`, `--once` exit codes, catch-up after a bridge
  restart, `welcome.room` epochs, a clean server stop in the middle of a 120-shape burst: no acknowledged op lost
  (board, both files and a viewer's copy agree element for element). After the fix round: no false "not the board"
  line on a restart, a settings change made while the bridge was stopped reaches the board, one a peer changed meanwhile
  is refused out loud, and a new drawh file joins quietly with exit 0.
- **Fix round mutation check:** 13 mutations of the new code (each rule of the snapshot check, the history carry-over,
  the snapshot tip, the new-file rule), each caught by a test; one more was equivalent and its code was dropped.
- **Plenary:** `bun test --path-ignore-patterns 'test/web/adapters/transport-ws*'`: 573 pass, 78 skipped, 0 fail (no plenary code touched; that file is another session's work in progress).
- **Every verifier finding that is code has a test** (table in `docs/m2/reports/pd-drawh.md`, "Fix round"); the two
  that aren't (temp folders left by tests, a wrong sentence in this page) were checked by hand.
- **drawh without the flag:** 16 commands run on a pristine clone and the patched one, same output and exit code
  (ids drawh makes at random aside), including text that is `--server` after `--`.
- **Live run** against a stand-in, under node 26 and under bun 1.4 separately: edits both ways while running, a new
  layer, no traffic when idle, reconnect after the server restarts, clean stop, a viewer token gets a read-only copy,
  token absent from all output.

## What is NOT tested

- **A crash of the real server** (`kill -9`): only clean stops were run live. Cluster mode (Postgres + NATS), a
  takeover between nodes, and the Room's own 1,000-entry checkpoint against the real server (in process only).
- **Inside Herdr.** Nothing here runs in Herdr's QuickJS runtime, and Herdr's own WebSocket is not used: the socket
  lives in node or bun, started by drawh. A pane that connects by itself is a later, separate change.
- **A real pane beside a running bridge**, and `herdr-app check` on the built mod with its new folders (`cli/`,
  `protocol/`). The pane's behaviour in the seeding risk below is read from its code and simulated, not watched.
- **Linux.** It has an equivalent of the swap; this patch does not use it and falls back to the two-step way there.
  Disks were checked as images on this Mac only (APFS, HFS+, FAT, exFAT).
- **wss://** (only `ws://127.0.0.1` was run), sessions longer than a few minutes, two bridges on one file.

## Risks and limits

- **Pointing a non-empty file at an existing board publishes the file's shapes to everyone on it**, `--once` included.
  There is no dry run and no confirmation.
- **Seeding an old board with a pane open on the file.** Only shapes past version 1,000 are renumbered (decided
  2026-11-11, below), so this concerns old, heavily edited boards only. Renumbering lowers a version in the file;
  a pane that has the file open never takes a lower version, keeps the old number in memory, and writes it back with
  its next save. Then:
  - **Remembered number more than 1,000 above the board's copy** (the usual case): the room would refuse it, so the
    bridge holds that shape back and warns; `--once` exits 2. The file carries the high number from then on and
    nothing in this patch brings that shape back in step.
  - **Within 1,000 of the board's copy** (a shape that was only just past 1,000): the stale copy is sent and
    overwrites what anyone did to that shape in the meantime, with nothing held and nothing said. A test pins this
    ("KNOWN HAZARD of seeding an old board").
  - **That band widens as the board's copy gains versions**: after 600 edits by others, a remembered copy at 1,500
    is within reach again (tested).
  - **The bridge says so when it renumbers**: one line naming the shapes, "reopen any pane that has this file open".
    Related and loud: if a drawh save lands during that first write, the shape can go back to its old number in the
    file and is held back from then on (warning, exit 2).
  - **So:** send an old board for the first time with no pane open on the file. Ordinary shapes are not affected:
    their versions are never lowered, and a pane's remembered copy loses to a later edit as it should (tested).
- **Recognising the room.** v1.1's `welcome.room` is read first: another board, or a writer's welcome with an epoch
  lower than one seen (kept across restarts), is another room: said once, a fresh copy, nothing from a wrong board
  is applied. The old check (the last entry applied, by op id and author) still runs on every reconnect, and is
  the only one when a welcome has no `room` (servers before p2-swap). A snapshot in answer to that check (the room
  checkpointed at or past it: every clean server stop, and the Room every 1,000 entries) is judged by what it holds:
  not behind the tip, every element this copy confirmed at the same or a later version, every settings key at the same
  or a later `appSeq` with the same value at the same one. Then it is the same room, with the history of who changed
  what carried over (a key the snapshot moved counts as someone else's change). Otherwise another room: the file's
  shapes are sent again and its settings markers are dropped.
  - **Not by epoch alone** (the manager's rule was: same room when the epoch is strictly higher). A clean restart does
    raise the epoch, but the 1,000-entry checkpoint keeps it, and a wiped server raises it too after its own restarts.
    The contents check covers all three. It does not tell a different server apart if that server holds everything
    this copy confirmed (the same shapes at the same or later versions, the same keys no older): then nothing is lost
    by treating it as this room, and its settings changes count as someone else's (refused out loud, never silently).
  - **A server that steps back to an older checkpoint** (a bad one on disk) answers a bridge that last caught up from
    a snapshot with entries instead: no entry to compare, so another room (said, the file's shapes sent again).
- **A wiped or different server behind the same URL gets the whole file sent again**, with one warning line.
- **A hand-edited invalid setting nobody has set yet is dropped quietly.** If the file holds a value the protocol
  would refuse (say `snap: "yes"`) for a setting the board has never set, it is not sent and nothing is printed; when a
  peer later sets that setting, the file takes the peer's value, again with no line. drawh and the pane never write
  such values; a hand edit or another tool can (re-check 4b, accepted by the manager).
- **Board stream only.** Notes, comments and presence are not shown or sent.
- **Pictures:** image elements travel, their bytes don't (the protocol refuses `files`; the blob port isn't built).
- **Joining a board that already has layers:** the board's settings win over the file's. A new drawh file carries drawh's
  default layer list (one "Layer 1"); with no marker for it, that is nobody's change: the board's layers are taken
  quietly and `--once` exits 0. Any other layers in a new file are the board's too, said once.
- **Settings, what can still go wrong (round 4, final check by pd-drawh4v; the cases below are accepted limits):**
  - **An agent's save that read the file before your settings change and lands after it undoes your change** on the
    board too (it already had in the file): your change and that save both stand on the same base. (Round 3's limit.)
  - **`layers` is one key:** a change to one layer made on an old copy loses to anyone's change to any layer since.
  - **On a disk that refuses writes,** an old copy set to exactly the value now in the file is that file byte for
    byte and is taken as it (quietly); any other change made on an old copy is said.
  - **After a `stale-setting`,** a value the refusal's line named is written back only while the file is the very save
    the refusal came to (same inode, mtime and size) and nothing else was seen in it for that key since. Any other
    value, or the dropped one saved again (20, then 40, then back to 20), is held and judged when the key's gate opens,
    and said. Narrow cases stay: a writer that rewrites the file in place
    (no rename) with the same size inside one mtime tick, and a runner that can't stat the file at all (then only "a
    newer value was seen" counts, so 20 → 40 → 20 between two of its 250 ms looks is taken as the refused file). A save that doesn't touch
    the key (an agent's shape) also counts as a new save: its dropped value is said again (loud, not lost).
  - **A same-batch refusal (the usual case on one node), about 20 ms wide:** a new value saved and then the dropped
    one saved again, both between the refusal's line and the bridge's next pass, is written back with no further line
    (only the refusal's line, which named that value). Only an automated writer or a save already on its way can land
    in that window (pd-drawh4v F5, accepted under the manager's hard stop).
  - **Lines:** an untouched old copy is quiet now (round 4 vs 80 lines a minute under option 2), but a change made on
    an old copy is said each time.
- **A change the room refuses stays in the local file**, with a warning that names the element, and is tried again
  only by a new run. An op holding several shapes is taken apart first, so one bad shape doesn't hold back the rest.
- **The token and the process list.** The running bridge has the token in its environment for as long as it runs
  (`ps eww` by the same user shows it; that is what an environment variable is). With `--token`, it is on drawh's
  command line only for the instant before drawh hands over to the runner, but it stays in shell history.
  `PLENARY_TOKEN` avoids the history.
- **Plain `ws://` to another machine is refused** unless `--insecure`, so a token doesn't cross a network in the clear.
- **A python process per file write** (the swap). About 46 ms each on this Mac; the bridge writes at most once
  per 20 ms pass, and only when the board changed.
- **A board file that is a symlink is replaced by a regular file**; the link's target is not updated. drawh's own
  save does the same today.
- **A save taken off the disk during a pile-up** (more than eight saves racing one pass) waits in memory for the next
  pass, a few milliseconds; stopping the bridge in exactly that moment loses it.
- **A hostile server** can still put nonsense that is well-formed into the file (a shape with an absurd version, for
  one). The server owns the board; the bridge checks shape, not sense.
- **Two copies of the protocol** now exist (plenary and herdr-draw). The test catches local edits, not staleness.

## If approved

Apply to herdr-draw, commit there (its release build is already in the patch). Re-copy the protocol after phase 2.
