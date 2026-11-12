# Proposal: `drawh --server` (herdr-draw talks to Plenary)

2026-11-11, revised after three rounds of verification; settings scope cut (option 2) after re-check 3b. **Decision needed: apply `drawh-server.patch` to herdr-draw, or
not.** Nothing is applied; herdr-draw is untouched (still at 5dfe352, clean).

## What it does

`drawh --server URL --board ID [--token T] [--once] FILE` keeps one `.excalidraw` file and one Plenary board in step
until stopped. The pane and every other drawh command keep working on the file as today, so the pane shows the live
board with no network code of its own.

| | |
|---|---|
| **File → board** | Elements the file has newer (by `version`) go out as protocol ops, through a protocol `Replica`. Layers, grid, snap and timeline do **not** go out from the file once the board has them: they are changed on the board (below). A board that has none takes the file's. |
| **Board → file** | Entries from the room are merged into the file (newer version wins), other fields of the file kept. |
| **Sign-in** | The token is sent in the first message (`hello`) only. No header, never in the URL (a URL carrying one is refused), never printed, never on disk. From `--token` or `PLENARY_TOKEN`. |
| **Catching up** | `since` comes from a small state file (`~/.cache/herdr-draw/plenary/<hash>.json`): the next run asks only for what is new, and sends edits made while it was stopped. |
| **First send (seeding)** | The room refuses a version more than 1,000 past its own copy, and a shape it has never had counts as version 0. So a shape new to the board whose version is past 1,000 (an old board) goes out as version 1 with a new nonce and the same id, and the file is renumbered to match. Every other shape is sent with its version unchanged. |
| **`--once`** | Catch up, send, wait for the acks, exit. Exit 0: file and board agree. Exit 2: they agree except for changes that could not be sent (refused, or a read-only role). Exit 1: anything else. |
| **Without `--server`** | drawh runs the same code as today. `--server` is the switch only before a command word and before `--`; after either it is ordinary text. |

## What is in the patch (23 files, +2868 −3, against herdr-draw 5dfe352)

| Path | What |
|---|---|
| `protocol/` + `SOURCE.json` | plenary's `packages/protocol`, byte for byte, at plenary b78f6ec (unchanged in plenary since), sha256 per file. Beside `core/`, because its files import `../core/doc.js`. |
| `cli/bridge.js` | the deciding (no I/O): diff file against replica, send, merge back, saved state, checks on what the server sends |
| `cli/files.js` | replaces the board file without losing someone else's save (below) |
| `cli/plenary.js` | the runner: socket, reconnect with a growing delay, deadlines, exit codes. Node 22+ or bun |
| `cli/drawh` | `--server` mode: checks flags and path, starts the runner with the token in its environment (not argv) |
| `scripts/build.sh`, `mods/herdr-draw/` | the built mod carries the bridge and the protocol copy (herdr-draw's release test needs the refreshed build) |
| `test/plenary.test.js` | 33 tests |
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

## Board settings: set on the board, not from the file (option 2, the scope cut)

Layers, grid, snap and timeline have no version numbers in protocol v0, so the bridge can't tell a stale save (a drawh
command that read the file before someone else's change and saved after it) from a real change made in the file.
Three rounds of trying (a time window, then a generation marker) each failed verification on a case where one or the
other was lost silently. So, decided 2026-11-11 by the platform manager:

- **While connected, settings flow board → file only.** A value in the file that differs from the board's, for a key
  the board has, is never sent. The board's value is written back to the file, with one line each time: "board
  settings are set on the board, not from this file: grid in this file differs from the board's (a change made here,
  or an older copy of the file saved over it) and is put back to the board's value; to change it, use the board (the
  web app)". A value the room would refuse (grid 2000, a layer without `locked`) gets the same line, marked "not a
  valid value". `--once` exits 2 when that happened (a change in the file that did not reach the board).
- **Exception, seeding:** a key the board has never set is sent from the file (once), so a new board takes the
  file's layers, grid and so on.
- **A peer's change arriving is not a change made here:** the bridge remembers what it last wrote into the file (or
  found there in step with the board), so a file that simply hasn't been given the board's new value yet prints
  nothing, from the first change after a start on.
- **R1 holds by construction:** a stale save can't undo anyone's settings change, because nothing from the file is
  sent once the board has the key (live: 0 of 36 and 0 of 54 undone).
- **Comes back with protocol v1.1:** its settings compare-and-set (each op names the `appSeq` it was based on; the
  room refuses a stale key) lets the room tell the two apart. Then file-side settings can be sent again (round 4).

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
cp -R ~/repos/herdr-draw/node_modules . && bun test          # 291 pass (258 before)
```

There is no Plenary server to point it at yet (phase 3). The tests start a local WebSocket around the protocol's
reference `Room` and run the real `drawh --server` against it.

## What was checked

- **Patch:** `git apply --check` and apply in a fresh clone of 5dfe352; `bun test` there: 291 pass, 0 fail.
- **Plenary:** `bun test --path-ignore-patterns 'test/web/adapters/transport-ws*'`: 573 pass, 78 skipped, 0 fail (no plenary code touched; that file is another session's work in progress).
- **Every verifier finding that is code has a test** (table in `docs/m2/reports/pd-drawh.md`, "Fix round"); the two
  that aren't (temp folders left by tests, a wrong sentence in this page) were checked by hand.
- **drawh without the flag:** 16 commands run on a pristine clone and the patched one, same output and exit code
  (ids drawh makes at random aside), including text that is `--server` after `--`.
- **Live run** against a stand-in, under node 26 and under bun 1.4 separately: edits both ways while running, a new
  layer, no traffic when idle, reconnect after the server restarts, clean stop, a viewer token gets a read-only copy,
  token absent from all output.

## What is NOT tested

- **A real Plenary server.** None exists. Only the reference `Room`.
- **Protocol v1.** The copied code is v0 (as `packages/protocol` is today); PROTOCOL.md is already v1. The hello has no
  `v: 1`, and resends don't wait for `welcome`. After phase 2 lands: re-copy `protocol/`, update SOURCE.json, adjust
  `cli/bridge.js` where the Replica's API changed.
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
- **Recognising the room.** Protocol v0 gives a room no name. The bridge asks for the last entry it applied and
  compares op id and author; another server or a reset one is noticed, said, and the board is taken again from its
  copy (the file's own shapes are then sent to it). **For the engine track:** v1's `welcome` should carry a room
  identity; this check is a stand-in.
- **A wiped or different server behind the same URL gets the whole file sent again**, with one warning line.
- **A hand-edited invalid setting nobody has set yet is dropped quietly.** If the file holds a value the protocol
  would refuse (say `snap: "yes"`) for a setting the board has never set, it is not sent and nothing is printed; when a
  peer later sets that setting, the file takes the peer's value, again with no line. drawh and the pane never write
  such values; a hand edit or another tool can (re-check 4b, accepted by the manager).
- **Board stream only.** Notes, comments and presence are not shown or sent.
- **Pictures:** image elements travel, their bytes don't (the protocol refuses `files`; the blob port isn't built).
- **Joining a board that already has layers:** the board's settings win over the file's.
- **Board settings are changed on the board (the web app), not in the file**, until protocol v1.1's compare-and-set
  (round 4) brings file-side settings back. A change made in the file (`drawh layer --hide`, the pane's layer panel,
  grid, snap) is put back to the board's value with a line; only a key the board has never set is taken from the file.
- **The line is noisy while an agent draws and someone changes settings on the board:** each drawh save built before
  that change carries the old value, which is indistinguishable from a real change, so each one is put back and said
  (live: 80 lines in 60 s with a peer changing the grid every 1.5 s and drawh adding shapes back to back; 4 in 90 s at
  one shape every 2 s). Nothing is lost; the board's value always wins.
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
