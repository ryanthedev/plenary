**FAIL**: 2 HIGH, 5 MEDIUM, 6 LOW. Not fit to put in front of the CEO yet. H2 is a one-line fix; H1 can be
narrowed and made loud cheaply, but only a shared lock closes it.

**Latest verdict: see "Re-check 4b" at the end of this file: the four items asked pass; FAIL by the letter on one
remaining hand-edit-only gap (the manager's call).** (Re-check 4, before its fix: FAIL by the letter
of the bar on one narrow gap.) (Re-check 3b, before the scope cut:
FAIL on one narrow finding.) Before it: the round-one
report (below, unchanged), "Re-check", "Re-check 2" and "Re-check 3" (each FAIL at the time).

# Report: pd-drawhv (verify pd-drawh, the `drawh --server` proposal patch)

2026-11-11. Verifier, not the builder. Wrote only this report and my session scratchpad. Nothing committed.
The patch under test: `docs/m2/proposals/drawh-server.patch`, sha256 `0ac7ceb7974d493a…`, against herdr-draw 5dfe352.

## The gates (all pass)

| Done-when | Result |
|---|---|
| `git apply --check` on a fresh clone of herdr-draw HEAD | clean; `--stat`: 21 files, +1590 −3, as the doc says |
| herdr-draw's tests | **258 pass before, 269 pass after**, 0 fail (bun 1.4.4). The 269 was repeated in a clean clone where the only steps were clone, apply, copy `node_modules`, test |
| plenary `bun test` | 205 pass, 0 fail at the end (HEAD 55ce9c0 plus other sessions' uncommitted work); 142 pass, 0 fail earlier in the session. The count moves because other sessions are adding tests |
| proposal doc exists | yes |
| protocol byte-identical | all 5 files: sha256 equal across plenary b78f6ec, plenary's working tree now, the patch's `protocol/`, its `mods/herdr-draw/protocol/`, and SOURCE.json. File list complete. b78f6ec is an ancestor of HEAD |
| core the protocol imports | herdr-draw's `core/doc.js` and `core/model.js` equal plenary's `packages/core` copies |
| built mod | `scripts/build.sh` in the patched clone, then `diff -r build/herdr-draw mods/herdr-draw`: identical |
| herdr-draw untouched | status empty, HEAD 5dfe352, no stash, one worktree, `for-each-ref` identical to my snapshot at start |

## HIGH

### H1. A save made while the bridge is writing can vanish, with no warning (measured, not theoretical)

The builder listed this as a risk ("lost in the last instant before the rename"). I measured how often.
Setup: the real `drawh --server` bridge running against the stand-in; a writer saving the way drawh does
(read, add one element, write temp, rename); a peer sending new elements through the room.
"Lost" = the writer's element is in neither the final file nor the room. The bridge printed nothing in any run.

| Board | Others' entries | Saves | Lost |
|---|---|---|---|
| 300 elements | none (control: bridge never rewrites the file) | 79 | 0 |
| 300 elements | 1 a second | 175 | 0 |
| 300 elements | 5 a second (two runs) | 350 | 0 |
| **2,000 elements** | **5 a second** | **165** | **1** |
| growing to ~600 | **about 18 a second** (553 in 30 s) | **59** | **1** |
| ~600 growing to ~2,000 | about 39 a second (1,172 in 30 s) | 234 | 0 |
| ~2,000 growing to ~4,400 | about 65 a second, about 17 saves a second (worst case, both flat out) | 498 | 13 |

Each of the two realistic hits is a single event, so read the rate as "roughly one save in a hundred or two on a
big or busy board", not as a precise figure. The worst-case row shows it is not a fluke.

- **Where:** `cli/plenary.js:51-55`. The check re-reads the whole file and compares strings, then renames. The
  window is that read plus the compare, so it grows with the file: about 1 ms on a 2,000-element board by my numbers.
- **Why HIGH:** the brief's rule (silent loss of a user's edit). drawh has already printed the new id; the shape is
  gone; nothing says so. Small quiet boards did not show it; big or busy ones do.
- **The doc understates it:** "one file read wide" reads as negligible. On the boards Plenary is for, it is not.
- **Fix directions (the builder's call):** shrink the window to two system calls (hard-link the current file aside,
  rename, then compare the linked copy and re-merge if it differs), or at the least detect and warn. A real fix is a
  lock that drawh and the pane also take, as the doc says.

### H2. `drawh` without the flag changed for text that is `--server` (narrow; one-line fix)

- **Reproduced, three forms:** `drawh text FILE --at 0,0 -- --server`, `drawh text FILE --at 0,400 -- --server=prod`
  and `drawh label FILE r1 -- --server` each work on unpatched herdr-draw (exit 0) and on the patched one print
  `drawh --server: error: the following arguments are required: --server` (exit 2).
- **Where:** `cli/drawh` `main()`: `any(x == "--server" or x.startswith("--server=") for x in sys.argv[1:])` scans
  every argument, including text content after `--`.
- **Why HIGH:** the brief's rule (drawh without `--server` changed). It is narrow and loud (an error, nothing
  written), so the manager may reasonably call it MEDIUM. Fix: stop scanning at `--`, or only look at `argv[1]`.
- **Otherwise identical:** with `PLENARY_TOKEN` set, in both clones: `add` (x4), `arrow`, `ls`, `label`, `style`,
  `move` (x2), `layers`, `check`, `rotate`, `rm`, `clear`, `export --svg`, `text` all succeed with the same stdout,
  stderr and exit code, apart from ids drawh generates at random; the board files match once seeds, nonces and
  generated ids are ignored. Nine error cases (no arguments, unknown command, missing file, unknown id and the
  like) also match. `-h` differs only by the six new help lines. Labels that merely contain the words, or use
  `--label=--server`, are fine.

## MEDIUM

- **M1. A stale saved state against a room that has moved on diverges silently.** Scratch test with the real
  `Bridge` and `Room`: state saved at seq 1, then the same URL and board served by a different room already at seq 5.
  The file's shapes never reach that room, the room's first entries never reach the file, no warning. The bridge
  only notices a room that is *behind* its saved seq. The doc's line "a wiped or different server … gets the whole
  file sent again" is true only in that case. Protocol v0 has nothing to tell rooms apart; say so in the doc, or
  delete the state when the welcome looks wrong.
- **M2. One malformed frame kills the runner.** Sent live: `null`, `{"t":"entries"}` and
  `{"t":"snapshot","seq":999999}` each crash node with an uncaught `TypeError` and a stack trace
  (`cli/plenary.js:85` calls `bridge.receive` unguarded). A long-running bridge dies on one bad frame; state is not
  saved but nothing is corrupted, and a restart recovers. A fake `welcome` with a huge seq leaves it connected and
  sending nothing, forever, without a word.
- **M3. The back-off after `unavailable` never grows.** Live: seven reconnects in a row, each "trying again in
  1 s". The delay is reset to 1 s by every `welcome` (`cli/plenary.js:87`), and the stand-in welcomes before it
  refuses the op. This is the builder's untested timer. An overloaded server would get a hello a second from every
  bridge. It did recover once the server was available again, and the edit arrived.
- **M4. `--once` exits 0 when the server refused the change.** Live: exit 0 with a warning on stderr. A script
  can't tell the edit didn't land. Same for a viewer token with local changes, and for an element 5,000 versions
  ahead of the room (the builder's old-board risk): each prints its warning, naming the element in the last case,
  and exits 0 with the edit in the file only.
- **M5. A refusal takes every element in that op with it, and the warning names none.** Live: two elements in one
  save, op refused, both stay local behind one line ("the server refused a change … it stays in this file only").
  They are sent again after the bridge restarts (the refused list isn't saved), which is the kinder behaviour.

## LOW

- **L1. A token the user puts in the URL's query is accepted and sent** (`…/b1?token=…`). `user:pass@` is
  refused; a query is not. User error, but cheap to refuse. (codex rated this high; I don't: the patch never puts
  it there itself.)
- **L2. `--once` on a path that is a directory** prints `sync failed: EISDIR` and then waits the full 30 s.
- **L3. No hello timeout without `--once`:** a server that accepts the socket and never answers leaves the bridge
  silent forever (read from the code; with `--once` I measured the 30 s give-up, exit 1).
- **L4. The tests leave `drawh-plenary-*` folders in the temp dir**, two per run. 28 were there at the end, most
  from my own test runs (outside my scratchpad; I left them, the rules forbid deleting by pattern). No token in them.
- **L5. Token and environment:** the token is in the runner's environment for its lifetime; `ps eww` on the
  runner's PID showed it (same user only). That is what an env var means; the doc could say it. The doc's line
  that `--token` "shows in `ps`" is true only for the instant before drawh `exec`s the runner: with `--token` and
  no env var, the running bridge's argv did not contain it. Shell history still does.
- **L6. Settings keys from a hostile server:** `herdr[k] = …` in `Bridge.pull` takes keys from the server unchecked
  (`__proto__` would set one object's prototype, not global state). Not exploited; noted.

## What I tried that held up

- **Token (canary with quotes, a backslash, `.*+$(id)`):** absent from every stdout and stderr, both state files,
  the board files, the HTTP upgrade request (headers and URL, recorded server-side) and every non-hello frame.
  Absent from argv of every process (`ps -Ao command`), by the env-var route and by `--token`: drawh `exec`s the
  runner with the token in the environment.
  A wrong token and a `user:token@` URL are refused without echoing it.
- **State key:** sha1 of URL + board + file, so another board or server doesn't reuse a `since`. Tests use
  `DRAWH_STATE_DIR`; my real `~/.cache/herdr-draw` listing is unchanged.
- **Edits both ways while running**, deletes both ways, no traffic when idle, reconnect after the server drops
  every socket (an edit made while down arrived).
- **Killed between send and ack** (server swallowed the op, `kill -9`, restart): the edit reached the room. Saved
  state leaves unacknowledged elements out, as it should.
- **Applied then closed before the ack**, and **ack never sent, then SIGTERM, restart:** no loss. In the second
  case the restarted bridge sent the element again at the same version (the room logged one more entry); harmless,
  the board is unchanged.
- **`drawh clear` and `rm`** mark elements deleted with a new version (tombstones), so deletions travel; nothing
  drawh does drops an element from the file outright.
- **`--once`:** silent server and swallowed op give up at 30 s (exit 1); close after hello, close on the op and
  `unavailable` exit 1 at once; the edit went through on the next normal run. Bad URL, `ftp://`, port 1, plain
  `ws://` to another host: all refused or failed cleanly.
- **Wiped room (seq back to 0):** re-seeded from the file, as the doc says.

## sdd ensemble review

- **Harnesses that ran: codex only** (effort high, in its own patched clone with no remote; it edited nothing).
  `check_adapter`: codex ok; **agy failed** (quota reached, resets in ~69 h); grok not signed in; kimi has no model
  configured; mistral has no API key; qwen is not installed. So no finding has two harnesses agreeing.
- **codex's six findings, each checked by me:**

| codex finding | Mine |
|---|---|
| token accepted in a URL query (high) | confirmed, graded L1 |
| `--server` anywhere in argv switches mode (medium) | confirmed live with the `--` forms: H2. Its own example (`text F --server --at 0,0`) is an error on unpatched drawh too (run in both: exit 2, different message) |
| equal version, higher nonce: file edit overwritten (medium) | refuted as a defect: that is the protocol's tie-break, the same on every client |
| write between check and rename is lost (medium) | confirmed and measured: H1 |
| malformed frame crashes the runner (medium) | confirmed live: M2 |
| no bound on what a server can make the file grow to (medium) | true, not graded: the server is the board's owner; it can already send any board |

## What I did NOT verify

- A real Plenary server, protocol v1, Herdr's runtime, `herdr-app check`, a real pane beside the bridge: same gaps
  as the builder's, and the doc states all of them plainly (checked).
- `wss://`, bun as the runner (my live runs used node 26.12 because it is first on PATH; the test suite ran under
  bun), Node 22-25, two bridges on one file, runs longer than 90 s.
- The loss rate with the real pane as the writer. My writer copies drawh's save.
- Engram was unreachable (`name resolver error`): no recall, nothing written.

## How to rerun

Scratchpad `/private/tmp/claude-501/-Users-r-repos-plenary/7c151fa9-5670-49b0-b142-66f2d5ad1c5a/scratchpad/probe/`:
`standin.js` (the Room behind a Bun WebSocket on port 0, PID in `srv.json`), `p1.sh` to `p8.sh`, `race.py`,
`stale.test.js`. All processes were stopped by their own PIDs; none are left.

---

# Re-check (2026-11-11, after the fix round and the seeding decision)

**FAIL**: 1 HIGH (new to this report, present since the first cut, which I missed), 3 MEDIUM, 7 LOW.
Both round-one HIGHs are fixed. The patch checked: sha256 `fdcd68944fdd9764…`, 2,722 lines, against herdr-draw 5dfe352.
Judged by my own runs; each claim below says how it was checked (live = real `drawh` against my stand-in server,
in-process = the real `Bridge` on the reference `Room`, read = from the code).

## Gates (all pass)

| Check | Result |
|---|---|
| `git apply --check` on a fresh clone of 5dfe352 | clean; 23 files, +2524 −3 |
| herdr-draw's tests in that clone | **284 pass, 0 fail** (258 before the patch) |
| plenary `bun test` | 315 pass, 69 skipped, 0 fail, at the start and at the end (HEAD 61ea557 plus other sessions' work) |
| protocol copy | 5 files, sha256 equal to plenary b78f6ec, the working tree and SOURCE.json; core's `doc.js`/`model.js` equal |
| built mod | `scripts/build.sh`, then `diff -r build/herdr-draw mods/herdr-draw`: identical |
| herdr-draw untouched | status empty, HEAD 5dfe352, no stash, one worktree, refs identical to my snapshot; real `~/.cache/herdr-draw` unchanged |

## HIGH

### R1. A drawh save can undo another person's board-settings change, silently (layers, grid, snap, timeline)

- **What happens:** board settings have no versions. A drawh command reads the file, a peer's settings change
  arrives and the bridge writes it into the file, then drawh's save lands with the old settings. The bridge takes
  the old value for a change made in the file and sends it to the board, where it replaces the peer's for everyone.
- **Measured live** (real drawh, real bridge, default mode; "undone" = the room no longer holds the peer's value
  1.2 s after the peer set it). One `drawh add --label` takes about 140 ms here.

  | drawh activity | Peer settings changes | Undone | Bridge warnings |
  |---|---|---|---|
  | adding shapes back to back (an agent drawing), 60 s, 324 saves | 35 | **28** | 0 |
  | one shape every 2 s, 90 s, 42 saves | 54 | **3** | 0 |

- **Also shown step by step, live, on both cuts:** file `snap` off, peer turns it on (room and file: on), a save
  built on the earlier file lands: room `snap` off again, no warning. Same on the round-one patch, so this is
  **not a regression**; round one (mine) missed it. In-process it also happens through the new merge
  (`union()` in `cli/bridge.js` lets the other save's settings win).
- **Not in the proposal doc.** The doc says settings "go out when they change"; nothing about a stale save.
- **Why HIGH:** the brief's rule (silent loss of a user's edit); here it is a peer's edit, lost for the whole board,
  and frequent whenever an agent is drawing. With `layers`, a peer's new layer disappears for everyone.
  codex raised the same defect independently. **The grade is the manager's call**, as H2 was: it predates the fix round.
- **Fix direction (the builder's call):** treat a settings value as a change only if the file's value differs from
  what the file held before the bridge's last write of that key (keep the previous value per key; a file that goes
  back to exactly it right after a room change is a stale save: write the room's value again and don't send). In
  `union()`, a key the other save didn't change relative to the text it replaced should keep ours.

## MEDIUM

- **RM1. On a FAT disk the "swap" is a plain rename, and a save in the window is lost.** By hand on a FAT image:
  `renamex_np(RENAME_SWAP)` returns 0 and leaves one file (the other is gone). So `cli/files.js` thinks it swapped,
  then fails to read the old board: every write prints `sync failed: ENOENT … .plenary-PID.tmp`, `--once` exits 1,
  and with a save injected just before the call, that save was in neither file nor room (live). The message does
  not say a save may be gone. Fix direction: test the swap once on two scratch files in the board's folder.
  **exFAT:** no swap and no hard links, so the bridge cannot write the file at all (`sync failed: ENOTSUP … link`,
  exit 1); edits made in the file still reach the room. **HFS+:** works, by falling back to link mode with its
  warning (the comment in `files.js` says HFS+ swaps; on this macOS it did not).
- **RM2. The fallback (link mode) still loses saves it can't see coming, as the builder says.** My numbers below:
  6 of 2,219 with a writer whose temp file is not drawh's (the pane's case). It warns once at start, not per loss.
  Link mode is what HFS+, a missing python and Linux get.
- **RM3. Seeding with a pane open: confirmed as the builder's own test pins it, and accepted by the manager.**
  In-process: a shape seeded from version 1,001, a peer edits it, the old copy is written back: the peer's edit is
  overwritten, no warning; the same after a restart from saved state. From 1,500, 2,001 and 2,500 the old copy is
  held back with a warning and the peer's edit stands. Two facts to add to the doc: **the bridge prints nothing when
  it renumbers** (so nobody is told to reopen the pane), and the silent band is "within 1,000 of the board's copy",
  so it **widens as the board's copy gains versions**. Related, loud: if a drawh save lands during the seeding
  write, the shape goes back to its old number in the file and is held from then on (warning, exit 2).

## LOW

- **RL1. M2 is fixed except one path:** a second `welcome` with a huge seq in mid-session still leaves the bridge
  connected and sending nothing, with no message (live, 10 s, stall deadline set to 2 s). The deadline is only armed
  at connect. Hostile server only.
- **RL2. L1 is fixed except one encoding:** the token percent-encoded the way Python's `quote` does, under a
  harmless query name, still connects and rides in the URL (live; the check compares against
  `encodeURIComponent`, which leaves `*()` alone). Compare the decoded URL instead.
- **RL3. A short token that happens to occur in the URL is refused** ("no token in the URL…"): live with token `b1`
  and board path `/boards/b1`. Misleading for short dev tokens.
- **RL4. A wrong token or `unavailable` as the first answer, with saved state, prints "this is not the board this
  file was last in step with…"** before the real reason, and throws the saved position away (live for the wrong
  token; read for `unavailable`, which then resyncs from 0 against a busy server).
- **RL5. A save taken off the disk lives only in memory until the next write.** After nine saves in a row race one
  sync, it waits in `carry`; a stop in that moment loses it (read; codex raised it too).
- **RL6. A hostile server can put an element with version 1e300 in the file** (in-process: accepted by
  `frameProblem`, no throw). Nobody could change that shape again. The server owns the board; noted.
- **RL7. A symlinked board is replaced by a regular file** and the link's target is not updated (live). drawh's own
  save does the same, so not new; worth a line in the doc.

## H1 again: lost saves (my `race.py` and stand-in, the same rows as the first table)

"Lost" = the writer's element in neither the final file nor the room. All three configurations ran at the same
time on a machine other sessions were loading heavily (load average 17 to 100), so read small differences loosely.
The swap runs' bridge logs contain no fallback warning (0 of 6); the link runs' logs all do (6 of 6).

| Row | First cut | Swap (default) | Link, drawh-style writer | Link, a writer it can't see coming |
|---|---|---|---|---|
| control: 300 elements, no entries from others | 0 of 79 | 0 of 75 | 0 of 74 | 0 of 74 |
| 300 elements, 5 entries a second (two runs) | 0 of 350 | 0 of 345 | 0 of 346 | **2 of 345**, then 0 of 169 alone |
| 2,000 elements, 5 a second | 1 of 165 | **0 of 158** | 0 of 159 | 0 of 159 |
| 300 elements, 1 a second | 0 of 175 | 0 of 175 | 0 of 175 | 0 of 175 |
| growing board, about 18 a second | 1 of 59 | **0 of 59** | 0 of 59 | 0 of 118 |
| growing board, about 35 a second | 0 of 234 | 0 of 209 | 0 of 208 | 1 of 429 |
| growing to about 3,700, both flat out | 13 of 498 | **0 of 348** | 0 of 342 | 3 of 750 |
| **All rows** | **15 of 1,560** | **0 of 1,369** | **0 of 1,363** | **6 of 2,219** |

- **Default mode: no loss in 1,369 saves.** Stronger evidence than the count: with a save injected exactly between
  the bridge's last read and its swap (a wrapper in place of python, live), about 290 injected saves in a row were
  all merged into the file and sent to the room.
- **Link mode** loses nothing when the other writer uses drawh's temp-file name (the bridge waits for it), and
  still loses a few when it doesn't. That matches what the builder reported.
- Peer entries missing from the file: 0 in every row. No temp or aside files left behind.

## Round-one findings, one by one

| # | Now | How checked |
|---|---|---|
| H1 lost save | **fixed in default mode**; fallback residual is RM2; FAT is RM1 | live, table above |
| H2 `--server` as text | **fixed**: `text -- --server`, `text -- --server=prod`, `label -- --server`, `label -- "--server=x --board y"` all work as on unpatched drawh | live, both clones; 33 commands compared: every exit code equal; output equal apart from random ids, the help text, and the error wording of `frobnicate FILE --server x` (exit 2 both) |
| every `--server` form | all reach server mode and sync: `--server URL`, `--server=URL`, flags in any order, FILE first, with `--once --insecure --token` | live |
| M1 stale state | **fixed**: other room behind, level or ahead: one warning, full resync, the file's shapes arrive; same room again: no warning, nothing resent | in-process (three cases) and live (wiped room moved 12 entries on) |
| M2 malformed frames | **fixed** for 21 hostile frames (no throw, no crash, prototype not polluted) and six live; remainder is RL1 | in-process and live |
| M3 back-off | **fixed**: 0.2, 0.4, 0.8, 1.6, 3.2, 6 s, back to 0.2 after a healthy spell; the edit arrived | live |
| M4 `--once` exit code | **fixed**: 2 for refused, viewer and version-jump cases, with a count; 0 in step; 1 for unavailable, silent (at the deadline), closed mid-stream, folder, missing folder, wrong board, wrong token | live |
| M5 refusal takes neighbours | **fixed**: 1 bad of 8: 7 arrive, the bad one is named, 4 refusals. A server refusing all 40: 43 refusals, bounded | in-process; live for one element (named) |
| L1 token in URL | fixed for `?token=`, `?access_token=`, `user:pass@`; remainder RL2, side effect RL3 | live |
| L2 folder as FILE | **fixed**: exit 1 at once; also a missing parent folder | live |
| L3 no hello timeout | **fixed** at connect (silent server: gave up at the 3 s deadline I set) | live |
| L4 temp folders | **fixed**: 30 before my test run, 30 after | counted |
| L5 doc's `ps` line | **fixed** (doc lines on the environment and `--token`) | read |
| L6 server settings keys | **fixed**: `__proto__` and `constructor` keys from a server did not reach the file | in-process |

## Seeding rule (point 4)

- **The rule holds** (in-process, one file with versions 1, 2, 37, 1000, 1001, 5000): 1001 and 5000 become version 1
  with a fresh nonce, same id, same nonce in file and room, every other field unchanged, order kept; 1, 2, 37 and
  1000 keep version and nonce in both. One file write.
- **Also renumbered, harmlessly:** a deleted shape at 3000, a fractional version (1500.5) and a version held as a
  string ("2000"), all absent from the room. An id over 64 characters and a negative version are held with a warning.
- **Not renumbered when it shouldn't be:** the room already has the id (held with a warning); signed in as a viewer
  (file untouched, held).
- **Breaks only where the builder's test says:** RM3.

## New code paths (point 5)

- **Injection:** none. The python call is `spawnSync` with an argument list, no shell. A folder and file named with
  quotes, `$(touch …)`, backticks, `;` and a leading `-` synced correctly and created nothing (live).
- **Token and the child:** the python child's environment has no `PLENARY_TOKEN` and no canary (live, with a
  wrapper logging it); no process argv contains the token by the env route or by `--token` (live, `ps -Ao command`
  with a bridge running). Token sweep of outputs, state files, board files, request headers and URL, and non-hello
  frames: clean, apart from RL2 where I put it in the URL myself.
- **Python missing:** falls back to link mode with its warning; file and room correct, exit 0 (live).
- **Non-APFS:** RM1.

## sdd review of the new hunks

- **Ran: codex only** (effort high, own clone, edited nothing). **grok failed `check_adapter` again** (not signed in).
- codex's six findings: stale settings (my R1, found independently by both); the seeding hazard (RM3, accepted);
  `carry` lost on exit (RL5); a version of 1e300 from the server (RL6); the 24-split cap marking a whole op refused
  afterwards (true, by design, the doc says it); an unreadable (mode 000) save deleted unread (not reproduced,
  contrived: not graded).

## Not verified

- A real pane as the other writer; a real Plenary server; protocol v1; Linux; `wss://`; bun as the runner in my
  live runs (node 26.12 ran them; the test suite ran under bun 1.4.4).
- The H1 table on a quiet machine. R1's rate on a quiet machine (it depends on how long a drawh command takes).
- Engram unreachable again: no recall, nothing written.

## How to rerun

Scratchpad `/private/tmp/claude-501/-Users-r-repos-plenary/7c151fa9-5670-49b0-b142-66f2d5ad1c5a/scratchpad/r2/`:
`measure.sh` (the table; folders `m-swap`, `m-link`, `m-linkpane`, `m-linkpane2`), `probe/recheck.test.js`
(in-process), `probe/live.sh`, `live2.sh`, `live3.sh`, `disks.sh`, `settings.sh` (R1's table), `parity.sh`.
Stand-ins on port 0, stopped by their recorded PIDs; disk images detached; no processes or mounts left.

---

# Re-check 2 (2026-11-11, after "Fix round 2")

**FAIL**: R1 itself is fixed (0 peer changes undone), but the new rule fails the test set for it: a user's
deliberate settings revert is silently not sent in two cases (one the builder disclosed as a trade-off, one it did
not). 2 HIGH by the same rule as H1 and R1, 1 MEDIUM, 6 LOW. **Whether the disclosed trade-off is acceptable is the
manager's call**; if it is, only R2b blocks. Patch checked: sha256 `d5364ec770aea491…`, 3,019 lines, against
herdr-draw 5dfe352. Labels: live = real `drawh` against my stand-in; in-process = the real `Bridge` on the reference
`Room` with a clock I move; read = from the code.

## Gates (all pass)

| Check | Result |
|---|---|
| `git apply --check`, fresh clone of 5dfe352 | clean; 23 files, +2821 −3 |
| herdr-draw's tests there | **290 pass, 0 fail** (258 before the patch) |
| plenary `bun test` | 322 pass, 70 skipped, 0 fail at the start; 325 pass, 70 skipped, 0 fail at the end (HEAD 80d8622 plus other sessions' work) |
| protocol copy, built mod | 5 files equal to plenary b78f6ec, the working tree and SOURCE.json; `diff -r build/herdr-draw mods/herdr-draw` identical |
| herdr-draw untouched | status empty, HEAD 5dfe352, no stash, one worktree, refs identical to my snapshot; real `~/.cache/herdr-draw` unchanged; temp folders 30 before, 30 after |

## 1. R1: stale saves no longer undo a peer's settings change

Live, my `settings.sh` unchanged, default mode, while my lost-save run shared the machine:

| drawh activity | Round 2 (before the fix) | Now |
|---|---|---|
| adding shapes back to back, 60 s | 28 of 35 undone | **0 of 35** (366 saves) |
| one shape every 2 s, 90 s | 3 of 54 undone | **0 of 54** (42 saves) |

- **A slow drawer** (live: reads the file, a peer changes the grid, the save lands N seconds later): kept at 1, 3 and
  8 s. **Undone at 12 s**, which is the documented limit (the rule remembers for 10 s).
- **Stale saves that try to get round it** (in-process): built on three earlier generations of the file, the same
  one twice, two in a row with the second built on the first, and one landing inside the bridge's own write (the
  merge path): no peer change undone, the stale saves' shapes still reached the room. A peer's added layer survives
  a stale save with the old list. A write failing for 30 s does not send the old value.
- **A new value inside the window is sent at once** (in-process: peer 20, user 30 half a second later: room 30).
- **Not covered, small:** the bridge restarted between the peer's change and the stale save: undone (in-process;
  the memory is not saved). A restart inside a 140 ms window; LOW.

## HIGH

### R2a. Undoing a peer's settings change within 10 s is silently refused, and every retry restarts the 10 s (disclosed in part)

- **Live, real drawh:** a peer hides Layer 1. `drawh layer FILE "Layer 1" --show` 2 s later: exit 0, the room still
  has it hidden, the file is put back to hidden, the bridge prints nothing. Again 4 s after that: the same. After an
  11 s pause: sent.
- **The retry restarts the clock** (in-process): tries 2, 3, 4, 9 and 9.9 s after the previous try all bounce; a try
  10.1 s after the last one is sent. Someone who keeps trying every few seconds never gets through.
- **The doc** says it "doesn't take the first time … do it again after a moment". That sentence is wrong as written:
  a moment later bounces too.
- **Why HIGH:** the manager's test for this round ("a user really reverting a setting to an earlier value must still
  be sent") and the brief's rule: a user's edit is dropped and reversed in their own file with no message, and drawh
  has already reported success. The builder offered this as a trade-off to overrule; the grade is the manager's.

### R2b. After any bounce, the user's own change-and-change-back is swallowed (not disclosed)

- **Live, real drawh:** a peer adds a layer while a drawh save is in flight (the stale save bounces, as designed).
  Then the user hides Layer 1 (sent) and shows it again 1 s later: **the show is not sent**. The room keeps Layer 1
  hidden for everyone, the file is put back to hidden, the bridge prints nothing.
- **Pinned down in-process:** a peer change with no bounce: hide then show is sent (fine). After a stale-save bounce:
  swallowed. After the user's own bounced revert (R2a): swallowed. Showing it again 5 s later: still swallowed; 10.1 s
  after that try: sent.
- **Cause (read):** on a bounce, `pull()` in `cli/bridge.js` records two values as "stale for 10 s": the file's stale
  value and `this.base[k]`, which at that moment is the room's current value. So the current agreed value itself is
  on the stale list, and the user returning to it within 10 s looks stale.
- **Fix direction, untested:** don't put a value equal to the room's current one on the list; don't restart the
  10 s when a value on the list shows up again; consider a much shorter window (a drawh command takes about 140 ms
  here). Say something when a value is refused more than once.
- **The plain case works** (live and in-process): the user's own change and own revert 1 s apart, with no peer
  change near it, are both sent (`drawh layer --hide`, then `--show`: the room follows both).

## MEDIUM

- **RM2 stands (not fixable without a lock, as the builder says):** link mode still carries last round's odds for a
  writer it can't see coming. HFS+ gets link mode (live: it works and prints the two-step warning).

## 2. RM1: non-swapping disks (live, disk images mounted in my scratchpad)

| Disk | Board exists, a peer's shape waiting | No board yet | Running bridge | A local edit reaches the room |
|---|---|---|---|---|
| FAT | **refused, clearly**: "this disk can neither swap two files nor hard-link one (FAT or exFAT?) … what the board has is NOT written to this file; changes made in the file still go to the board". Exit 1, file bytes unchanged | created, exit 0 | 2 lines about writing over 4 peer entries (not one per pass) | yes |
| exFAT | the same | created, exit 0 | the same | yes |
| HFS+ | written, with the two-step (link) warning, exit 0 | created, exit 0 | 1 line | yes |

- **No silent loss on FAT or exFAT:** the bridge never replaces an existing board there, so there is nothing to
  overwrite. Nothing left on the disks but the board files; images detached.
- **My injected-save rows don't apply here:** the injector only runs when the bridge calls python on the board,
  which is swap mode only. It never fired on these three disks, so I draw nothing from those rows.
- **Cosmetic:** with `--once` the refusal text is printed twice (once on its own, once after "can't write FILE:").
- **As the builder says:** on FAT/exFAT an old board's shape is sent as version 1 while the file keeps its old
  number, and is then held with the warning. Not rerun by me.

## 3. RM3: fixed

- **The line is printed** (live): "1 shape was past version 1000 and new to the board, so it was renumbered to
  version 1 to be sent (o1): reopen any pane that has this file open, or its next save can bring the old numbers back
  and undo other people's edits to it". Once; a second run prints nothing.
- **The doc has both facts:** the band "widens as the board's copy gains versions", and "the bridge says so when it
  renumbers".
- The seeding rule and the known hazard are unchanged (round two's in-process tests rerun on this patch: same results).

## 4. RL1 to RL4

| # | Now | How checked |
|---|---|---|
| RL1 welcome with a huge seq in mid-session | **fixed**: the bridge gives up at the deadline, reconnects, the edit arrives; a healthy idle connection for 8 s more caused no reconnect | live |
| RL2 token percent-encoded in the URL | **not fixed for a token containing `+`** (base64 tokens do). The check turns `+` into a space on its second decoding pass, so the decoded text never matches. Live with my canary (it has a `+`): the Python-quoted, double-encoded and plus-encoded query forms and the path form all connected, and the path form printed the encoded token in the "connected to" line. With the patch's own function on other tokens: a token with `*()!`, a plain one and one with a space are refused in every form; `dG9rZW4+with/plus==` is accepted in all three encoded forms | live, and the function run by hand |
| RL3 short token in the URL | **fixed**: token `b1` on `/boards/b1` connects. Its output reads "boards/\*\*\*, board \*\*\*" because the redaction now hits the board name | live |
| RL4 wrong token or `unavailable` first, with saved state | **fixed**: plain "token refused"; `unavailable` without the "not the board" line; the next run's hello still asks from the saved position | live |

RL2 stays LOW: the patch never puts the token in a URL; the user has to. The server-side leak check was not repeated
on a clean stand-in after those URLs.

## LOW (new or still open)

- RL2 as above.
- R1's restart gap (first section).
- `can't write FILE: …` is printed for any error thrown in a sync pass, including ones that are not about writing (read).
- codex: a real file already named `<board>.plenary-<pid>.probe1` would be overwritten and deleted by the disk
  test (read; the name carries the bridge's PID, so unlikely).
- codex: a query name containing "key" (`?monkey=1`) is refused as a token (read).
- codex: with a viewer role on a disk that can't be written, the renumbering line can claim "to be sent" for a
  shape that was neither sent nor written (not run by me).

## H1 again (rerun because `sync()`'s merge and the disk test before the first write changed)

Default mode, same rows as before, on a machine my other probes and other sessions were loading: **0 lost of 1,415
saves** (78, 172, 174, 165, 174, 59, 229, 364), 0 peer entries missing, no temp files left, no fallback warning in
any of the 6 bridge logs.

## sdd review of the new hunks

- **Ran: codex only** (effort high, own clone, edited nothing). No other harness was tried this round; grok failed
  `check_adapter` in both earlier rounds.
- codex's four findings: stale `layers` with the object keys in another order would be sent (**refuted for drawh**:
  live, drawh writes layer objects back in the key order it read them, so a stale save matches what was recorded;
  in-process, reordered keys cause one harmless resend); the other three are in LOW above. It did not raise R2a or R2b.

## Not verified

- A real pane as the writer in any settings case; a drawh command longer than 10 s other than my simulated one.
- A real Plenary server, protocol v1, Linux, `wss://`; bun as the runner in my live runs (node 26.12 ran them).
- Engram unreachable again: no recall, nothing written.

## How to rerun

Scratchpad `/private/tmp/claude-501/-Users-r-repos-plenary/7c151fa9-5670-49b0-b142-66f2d5ad1c5a/scratchpad/r3/`:
`probe/settings.sh` (R1's table), `probe/settings2.sh` (slow drawer, R2a, R2b live), `probe/settings.test.js`
(in-process, cases A to I), `probe/rest.sh` (disks, RM3, RL1 to RL4), `probe/tokurl.mjs`, `probe/recheck.test.js`
(round two's cases), `measure.sh` with `m-swap`. Stand-ins on port 0, stopped by their recorded PIDs; disk images
detached; no processes or mounts left.

---

# Re-check 3 (2026-11-11, after "Fix round 3", the last round)

**FAIL**, on one narrow finding: 1 HIGH by the rule set for this round (silent loss of a user's edit), 2 MEDIUM,
5 LOW. **Two judgement calls the manager can overrule:** I graded the own-undo limit MEDIUM although by the letter
of the rule it is also a silent loss (reasons below); and the pane's save path was not judged by my own runs, only
drawh's. Everything else asked for passes: R1, R2a and R2b are fixed live, the marker is loud wherever it should be,
RL2 is fixed. Patch checked: sha256 `8cd27cf8c3ef7dac…`, 3,412 lines, against herdr-draw 5dfe352. Labels: live = real
`drawh` against my stand-in; in-process = the real `Bridge` on the reference `Room`; read = from the code.

## Gates (all pass)

| Check | Result |
|---|---|
| `git apply --check`, fresh clone of 5dfe352 | clean; 23 files, +3214 −3 |
| herdr-draw's tests there | **301 pass, 0 fail** (258 before the patch) |
| plenary `bun test` | 331 pass, 70 skipped, 0 fail, at the start and at the end (HEAD 331bf95 plus other sessions' work); no `(fail)` lines |
| protocol copy, built mod | 5 files equal to plenary b78f6ec, the working tree and SOURCE.json; `diff -r build/herdr-draw mods/herdr-draw` identical |
| herdr-draw untouched | status empty, HEAD 5dfe352, no stash, one worktree, refs identical; real `~/.cache/herdr-draw` unchanged this round; temp folders 30 before, 30 after |

## HIGH

### R3. The third of three quick changes to one setting can be dropped silently (hide, show, hide)

- **Live, real drawh:** `drawh layer FILE "Layer 1" --hide`, `--show`, `--hide`, 0.1 s apart. The board should end
  hidden. **It ended shown 4 times in 45** (2 of 15, then 2 of 30 in a second run that also read the file). In
  those two: all three drawh commands exited 0, the file was back to shown 1.8 s later, and board and file were
  both still shown 5 s after that, so it is a drop, not a delay. The bridge printed nothing in either run. At other
  pacings it did not happen: 0 wrong in 96 runs (2, 3, 4 and 5 toggles back to back; 3 toggles
  0.15, 0.2, 0.3 and 1 s apart; 5 toggles 0.15 s apart).
- **Certain in-process:** three saves built on the same generation (each read the file before the bridge re-stamped
  it): grid 20 is sent, back to 10 is sent (the own-undo guard), **20 again is dropped**, no warning, and the bridge
  writes 10 back over it.
- **Cause (read):** `fileChanges()` in `cli/bridge.js` skips any value already in that generation's `sent` list
  before it looks at anything else. The list exists so a stale copy of an already-sent value isn't sent twice after
  a peer's change; it can't tell that from the writer setting the value again.
- **How narrow:** it needs the same value twice from one generation, so three changes to one key inside roughly
  half a second, at a pacing that matches the bridge's reaction time. A script blinking a layer can do it; a person
  rarely will. codex raised the same line with a different sequence (the value set again after a peer's change in
  between); I did not run that one, and the fix direction below does not cover it.
- **Fix direction, untested:** apply the own-undo test to `sent` too: when the board still holds exactly the last
  value sent from that generation and the file's value differs from it, it is the writer's new change, so send it.
- **Grade:** HIGH by this round's rule; the manager may weigh how narrow it is.

## 1. R1, R2a, R2b: fixed (live, my scripts unchanged)

| Case | Round before | Now |
|---|---|---|
| R1: drawh adding shapes back to back, 60 s | 0 of 35 (28 of 35 two rounds ago) | **0 of 34** peer changes undone (278 saves) |
| R1: one shape every 2 s, 90 s | 0 of 54 | **0 of 51** (39 saves) |
| slow drawer, save lands 1, 3, 8, 12 s after the peer's change | 12 s undone | **kept at all four** |
| own hide, own show 1 s later | sent | sent |
| **R2a:** peer hides, user shows 2 s later, and again | bounced twice | **sent at once**, both times |
| **R2b:** a stale save bounced, then own hide and show 1 s apart | show swallowed | **both sent** |

In-process, the same and more: stale saves built on three earlier generations, the same one twice, two in a row,
and one inside the bridge's own write: no peer change undone. A deliberate revert, a change-and-change-back, and a
revert right after a bounce: all sent at once. Bridge lines besides connecting in the live runs: 0.

## 2. Trying to break the marker (in-process unless marked)

| Attempt | Result |
|---|---|
| drawh keeps the marker | yes, live: a file carrying a known marker still has it after each of `add`, `text`, `arrow`, `label`, `move`, `style`, `rotate`, `grid`, `frame`, `layer`, `animate`, `mermaid`, `rm`, `clear` (all exit 0) |
| the pane keeps the marker | **not run by me**: the builder's stubbed-pane test is the only evidence |
| a writer drops the marker and changes a setting | **loud**: one line ("board settings are set on the board, not from this file: grid differs…"), the board's value kept, the file re-stamped; the same change made again is sent |
| a marker from another bridge; a file copied in from another board | loud, the same way |
| a marker that is a number, 100,000 characters long, or `__proto__` | loud, no throw, the table stays at 3 entries |
| eviction: a save built on a generation 70 writes old | table stays at 64. Settings untouched: the board's values are kept, quietly, which is right. With a real change: loud, not sent; made again on the current file: sent |
| a backup restored (a marker still remembered) | a peer's later change is kept; a setting the user had last changed from that same file goes back to the backup's value (the own-undo guard reads it as an undo). No line printed |
| restart with the saved table | a stale save after the restart: the peer's change is kept (it was undone last round); a deliberate revert after the restart: sent. The saved state holds the table. Token sweep this round: 0 of 55 state, output, log and board files in my probe folders contain the canary (12 of them are state files carrying the table) |
| racing saves through `union()` | a stale save inside the bridge's write: the peer's value kept, its shape still arrives; a racing save that really changed another key: both kept |
| one save with one real change and one stale key | the change is sent, the peer's value on the other key is kept |
| the marker reaching the server | never: not in the room's log, not in its settings |
| last round's in-process cases (seeding, other rooms, refusals, hostile frames) | unchanged results |

## The own-undo guard (the manager's question)

- **Is it silent?** Yes. Live: the user hides a layer (the board follows); an agent's save that had read the file
  before that lands 1.5 s later; the board goes back to shown, the bridge prints nothing.
- **Is it acceptable?** In my judgement yes, as MEDIUM, for three reasons. The change is already gone from the file
  when the bridge looks: drawh's own save overwrote it, exactly as it does today without this patch. The bridge
  can't tell this from the user's own undo, and treating it as stale is what broke R2a and R2b. The doc states it.
  The cost is real though: while an agent is drawing, a setting the user changes in the pane can flip back for
  everyone. Not measured for frequency. One limit on it (in-process): a stale save built on an *older*
  generation than the user's change does not undo it; only one built on the same generation does.

## MEDIUM

- The own-undo limit above.
- RM2 from re-check 1 stands (link mode, used on HFS+ or without python, can lose a save it can't see coming; it
  warns at start). Not rerun.

## 3. RL2: fixed

- **The patch's check, run by hand on five tokens** (four with `+`, including my canary; a sixth row printed
  garbled and is not counted): refused raw,
  percent-encoded, Python-quoted, `quote_plus`, encoded twice, encoded three times, and in the path. Harmless URLs
  (`?room=7`, `?x=a+b`, a plain `wss://` path) are not refused.
- **Live with the canary:** Python-quoted, `quote_plus`, in the path, and double-encoded: each refused before
  connecting, exit 1, the token not printed in any form. A harmless query (`?room=7`) is not refused: it went on
  to try to connect.

## LOW

- codex: a token percent-encoded four or more times gets past the three-layer check (read; no server would decode it).
- codex: after a crash within a second of two bridge writes, the saved counter is behind and a marker can be
  reused (read, not run by me; a clean stop saves state).
- codex: distinct oversized markers from a hostile file each add a key to the "said once" set (read).
- The unknown-marker line is said once per marker and value; the same save repeated later prints nothing (read).
- **Not the patch, for the manager:** a sync-state file sits in the real `~/.cache/herdr-draw/plenary/`
  (`50c8e2249a3d8418f1cc.json`, dated 18:32, board `b1`, no token). It was absent from my round-one snapshot and
  present at the start of re-check 1, so it came from a run without `DRAWH_STATE_DIR` between those two, not from
  me. This round's test suite, run with a scratch home, left no herdr-draw file there, so the current tests don't
  do it. I left the file.

## H1 again (rerun because `sync()`'s loop changed; `cli/files.js` itself is unchanged since last round)

Default mode, same rows, on a machine my other probes were loading: **0 lost of 1,535 saves** (79, 168, 172, 163,
174, 59, 229, 491), 0 peer entries missing, no fallback warning in any bridge log.

## sdd review of the new hunks

- **Ran: codex only** (effort high, own clone, edited nothing).
- Its four findings: the `sent` suppression (**confirmed: my R3**, found independently by both); the three in LOW.

## Not verified

- A real Herdr pane as the writer (the builder ran the pane's `FileStore` and `Editor` with the file API stubbed;
  I did not repeat that). R3's rate with a pane instead of drawh.
- `cli/drawh` is byte-identical to last round's, so the process-list and argv token checks were not repeated.
- FAT, exFAT and HFS+ this round (`cli/files.js` unchanged; last round's results stand). Link mode this round.
- A real Plenary server, protocol v1, Linux, `wss://`; bun as the runner in my live runs. Engram not used this round.

## How to rerun

Scratchpad `/private/tmp/claude-501/-Users-r-repos-plenary/7c151fa9-5670-49b0-b142-66f2d5ad1c5a/scratchpad/r4/`:
`probe/settings.sh`, `probe/settings2.sh` (section 1), `probe/toggle.sh`, `probe/toggle2.sh` and `probe/toggle3.sh` (R3 live, and the
own-undo case), `probe/settings.test.js` (in-process, cases A to P; J is R3), `probe/recheck.test.js`,
`probe/tokurl.mjs`, `measure.sh` with `m-swap`. Stand-ins on port 0, stopped by their recorded PIDs; no processes
or mounts left.

---

# Re-check 3b (2026-11-11, after "Fix round 3b": one rule changed in `fileChanges()`)

**FAIL**, on one narrow finding that this round's rule makes HIGH: case V below, a silent drop of the user's undo
when a peer's change lands between the user's two changes. It is **not new in 3b** (the same on last round's patch;
I did not find it then, codex did now) and **the grade is the manager's call**. What this round was for passes:
**R3 is fixed** (no silent drop in 161 live toggle runs, or in-process), and R1, R2a and R2b stay fixed. Also:
1 MEDIUM carried over (the own-undo limit, as graded before; case S below is the same limit showing up as a peer's
value undone), 3 LOW. Patch checked: sha256 `bdfab945677fea60…`, against herdr-draw 5dfe352. Since last round only
`cli/bridge.js` (one function and its message) and `test/plenary.test.js` changed; `cli/files.js`, `cli/plenary.js`
and `cli/drawh` are byte-identical. Labels: live = real `drawh` against my stand-in (or a drawh-shaped save where
said); in-process = the real `Bridge` on the reference `Room`; read = from the code.

## HIGH

### V. The user's undo is dropped silently when a peer's change landed between the change and the undo

- **Live, staged with drawh-shaped saves:** file and board hold grid 10. The user sets 20 (sent). A peer sets 30.
  The user's save back to 10, built on the copy of the file from before the bridge's writes, lands: **the board
  keeps 30, the file is put back to 30, the bridge prints nothing.** The same 10 set on the current file is sent.
- **In-process:** the same, and the same on last round's patch, so 3b did not introduce it.
- **Why it happens (read):** rule 3 of `fileChanges()`: the file holds its generation's own value, which is what a
  stale save looks like, so it is not sent. That part is right: sending it would bring R1 back.
- **What is wrong is the silence.** The sibling case (a value already sent, set again after a peer's change) keeps
  the board's value and says so; this one keeps it and says nothing. The doc does not mention it.
- **How narrow:** the undo has to be built on a copy from before the bridge re-stamped the file, so the user's
  change, the peer's change to the same key and the user's undo all fall within about one drawh command's time
  (140 ms here). Not reproduced with real timing; the live run above is staged.
- **Fix direction, untested:** print the same kind of line when a value equal to the generation's snapshot is
  skipped **and that generation has already sent this key** (`last` has it) and the board has moved since. That
  would not be noisy: in the R1 runs no generation had sent a settings key (0 of 64 and 0 of 58 in the saved
  tables), so ordinary stale saves would stay quiet.
- **Grade:** HIGH by the rule ("silent loss of a user's edit", with only own-undo exempted). The outcome itself
  (the peer's value stands among three edits at once) is defensible; the missing line is the defect.

## Gates (all pass)

| Check | Result |
|---|---|
| `git apply --check`, fresh clone of 5dfe352 | clean; 23 files, +3278 −3 |
| herdr-draw's tests there | **303 pass, 0 fail** (258 before the patch) |
| plenary `bun test` | 367 pass, 78 skipped, 0 fail at the start; 478 pass, 78 skipped, 0 fail at the end (HEAD cc9d38c plus other sessions' work); no `(fail)` lines |
| protocol copy, built mod | equal to plenary's `packages/protocol` and to last round's copy; `diff -r build/herdr-draw mods/herdr-draw` identical |
| herdr-draw untouched | status empty, HEAD 5dfe352, no stash, one worktree, refs identical; real `~/.cache/herdr-draw` unchanged; temp folders 30 before, 30 after; the test run left nothing in a scratch home |

## 1. R3: fixed

| Run (live, real drawh) | Last round | Now |
|---|---|---|
| `toggle3.sh`: hide, show, hide 0.1 s apart, reading file and exit codes | 2 wrong of 30 | **0 of 50** |
| `toggle2.sh`: 3 toggles 0.1 s apart | 2 wrong of 15 | **0 of 15** |
| `toggle2.sh`: 3 toggles 0.15 and 0.2 s apart; 5 toggles 0.15 s apart | 0 of 40 | 0 of 40 |
| `toggle.sh`: 2, 3, 4, 5 toggles back to back; 3 toggles 0.3 and 1 s apart | 0 of 56 | 0 of 56 |

- Bridge lines besides connecting in all of these: 0.
- **In-process case J** (three saves built on one generation: 20, back to 10, 20 again): all three sent; it was
  dropped last round. Also sent: the third toggle after a restart in the middle (T), and the third toggle landing
  inside the bridge's own write (U). No ping-pong: 0 ops in 20 idle passes afterwards.

## 2. Nothing came back

- **R1, live:** drawh adding shapes back to back for 60 s: **0 of 36** peer changes undone (352 saves); one shape
  every 2 s for 90 s: **0 of 54** (42 saves). A slow save landing 1, 3, 8 and 12 s after the peer's change: kept.
- **R2a and R2b, live:** the user's show 2 s after a peer's hide is sent at once, and again; after a stale save
  bounced, the user's hide and show are both sent.
- **In-process cases A to P:** the same results as last round, except J (now sent). 22 cases run, including the new
  ones below; last rounds' other cases (seeding, other rooms, refusals, hostile frames): unchanged.
- **The earlier own-undo bounce did not return** (live): two toggles back to back, 0 wrong of 10; hide then show 1 s
  apart, both sent.
- **The own-undo limit is as it was** (live): the user hides a layer, an agent's save that read the file before
  that lands: the board goes back to shown, nothing printed. MEDIUM, as graded last round.
- **Cases K to P, read in full:** eviction (64 kept; an old copy untouched is quiet, with a real change it is loud),
  a missing marker (loud), one changed key beside one stale key (change sent, peer's kept), the marker never in the
  room, restart with the table (stale save kept out, deliberate revert sent), racing saves (both kept).

## 3. codex's variant: a value set again after a peer's change

- **Live:** the user sets grid 20 from one generation of the file (sent); a peer sets 30; a save built on that same
  old generation carries 20 again. The board keeps 30, the file is put back to 30, and **one line is printed**:
  "board settings: grid in this file holds a value already sent from it, and someone has changed it on the board
  since; kept the board's (an old copy of this file and setting it again look the same). If you meant to set it
  again, set it again now: it will be sent".
- **Once:** the identical save a second time prints nothing more (the board's value is kept again). Setting 20 on
  the current file is sent. A different value built on the old copy is sent.
- **Is the choice right? Yes.** That save is the same bytes as R1's stale save (an old copy carrying a value the
  board has since moved past). Sending it would bring R1 back; keeping the board's and saying so loses nothing
  silently, and the instruction in the line works (checked live). The doc carries the same sentence.

## 4. Trying to break the rule order (in-process)

| Sequence, all saves built on one old generation unless said | Result |
|---|---|
| R: user on, peer off, user off, user on again | "off" equals the board: nothing to do. "on again": the board's kept, **said so** (one line); set on the current file: sent |
| S: user 20, peer 30, peer back to 20, then a stale save carrying 10 | the board goes to 10, nothing printed. **Not new**: the same on last round's patch. It is the own-undo limit in another coat (the board holds what this file last sent, so a differing value reads as the writer's change) |
| T: restart between hide and show, then hide again | all sent |
| U: the third toggle as a racing save | sent |
| **V (codex's): user 20, peer 30, user back to 10** | built on the old copy: **the board keeps 30, the file is put back to 30, nothing printed** (also live, staged). Made on the current file: sent. See HIGH |

V is graded under HIGH above. S is the own-undo limit; by R1's wording it is also a peer's change undone, so it is
named in the top line for the manager.

## LOW

- The "already sent" line is said once per marker and value: an identical second save gets no second line (live).
- codex: with old-generation saves sending ever new values between a peer's changes, the line can repeat once per
  distinct value (read).
- Token sweep this round: 0 of 34 state, output, log and board files in my probe folders contain the canary.

## sdd review of the new hunk

- **Ran: codex only** (effort high, own clone). Three findings: V above (confirmed in-process and live, staged; codex
  rated it medium, the rule here makes it HIGH);
  S above (confirmed, not new); the repeating line (LOW, read).

## Not verified

- A real Herdr pane as the writer, still: every live run uses drawh or a drawh-shaped save.
- H1, disks, link mode, RL2 and the process-list token checks were not rerun: the files they depend on are
  byte-identical to last round's.
- A real Plenary server, protocol v1, Linux, `wss://`; bun as the runner in my live runs.

## How to rerun

Scratchpad `/private/tmp/claude-501/-Users-r-repos-plenary/7c151fa9-5670-49b0-b142-66f2d5ad1c5a/scratchpad/r5/probe/`:
`toggle.sh`, `toggle2.sh`, `toggle3.sh` (section 1), `settings.sh`, `settings2.sh` (section 2), `resent.sh`
(section 3), `vlive2.sh` (V live; `vlive.sh` is a mis-staged first try, ignore it), `settings.test.js` (in-process, cases A to V), `recheck.test.js`. Stand-ins on port 0, stopped by their
recorded PIDs; no processes or mounts left.

---

# Re-check 4 (scope cut) (2026-11-11, after "Option 2 (scope cut)")

**FAIL by the letter of this round's bar, on one narrow gap; the manager's call.** A settings value the protocol
would refuse (grid 2000, a layer opacity of 150), written into a key the board has set, is put back to the board's
value with **no line**. Neither drawh nor the pane writes such values as far as I can find; a hand edit or another
tool can. Everything else the round was for passes: no peer change undone, and every ordinary file-side settings
change (toggles, undos, case V) is refused with a printed line, never silently. Also 1 MEDIUM ("a peer's change
arriving prints no line" does not hold for the first one after a start: a misleading line, not a loss) and 5 LOW.
Patch checked: sha256 `f9ddef4d9609ed7f…`, against herdr-draw 5dfe352. Since last round `cli/bridge.js` changed
(the marker, its table and merge rules are gone) and one line of `cli/plenary.js`; `cli/files.js` and `cli/drawh`
are byte-identical, so H1, the disks and the token checks were not rerun. Labels: live = real `drawh` against my
stand-in (or a drawh-shaped save where said); in-process = the real `Bridge` on the reference `Room`; read = code.

## HIGH by the bar (narrow)

### An out-of-range settings value in the file is put back silently

- **In-process, four values** in a key the board has set: grid 2000, grid as the string "20", a layer with opacity
  150, a layer missing `locked`. Each time: the file is put back to the board's value, **0 lines**, held 0, nothing
  sent.
- **Cause (read):** `settingsFrom()` in `cli/bridge.js` skips any value `appStateProblem` rejects before it reaches
  the "differs from the board's" check that prints the line; `pull()` then writes the board's value over it.
- **Who can write such a value:** not drawh (live: `drawh layer --opacity 150` stores 100, `--opacity -5` stores 0)
  and not the pane as far as I read it (its grid is 0 or 20). A hand edit or another tool can. Not run live.
- **In a key the board never set**, an invalid value stays in the file, is not sent, and prints nothing either
  (not overwritten, so not a loss).
- **Fix direction, untested:** judge "differs from the board's" before the validity check, so the same line is
  printed.
- **Grade:** it is exactly what the bar names (a file-side change overwritten with no line). It could never have
  reached the board, and the ordinary tools can't produce it, so the manager may well accept it as is.

## Gates (all pass)

| Check | Result |
|---|---|
| `git apply --check`, fresh clone of 5dfe352 | clean; 23 files, +2832 −3 |
| herdr-draw's tests there | **289 pass, 0 fail** (258 before the patch) |
| plenary `bun test` | 510 pass, 78 skipped, 0 fail, at the start and at the end (HEAD 3cf2dcd plus other sessions' work); no `(fail)` lines |
| protocol copy, built mod | equal to plenary's `packages/protocol`; `diff -r build/herdr-draw mods/herdr-draw` identical |
| herdr-draw untouched | status empty, HEAD 5dfe352, no stash, one worktree, refs identical; real `~/.cache/herdr-draw` unchanged; temp folders 30 before, 30 after; nothing left in a scratch home by the tests |

## 1. No peer change undone (R1)

- **Live, `settings.sh`:** drawh adding shapes back to back for 60 s: **0 of 27** peer changes undone (131 saves, 37
  bridge lines); one shape every 2 s for 90 s: **0 of 48** (37 saves, 5 lines). The machine was busy, hence fewer
  saves than earlier rounds. The lines are the stale saves being put back, each said, as designed.
- **In-process:** stale saves built before the peer's first change, one change back, the first again, and one
  landing inside the bridge's own write: the peer's value stands every time; the stale save's shape still arrives.

## 2. A user's settings change: always refused out loud, never silently

| Probe | Result |
|---|---|
| live: `drawh layer --hide` on a key the board has set, 20 times | sent 0 times; **put back with no line 0 times** (a line each time) |
| live: hide, show, hide 0.1 s apart (R3's sequence), 20 times | sent 0 times; put back with no line 0 times |
| live, staged: case V (user's grid 20, peer's 30, user's undo to 10 built on the old copy) | 20: refused, 1 line. Peer's 30: no line. Undo: refused, 1 line; the board keeps 30 |
| in-process: the same change three times in a row | a line each time, also with a single pass between them |
| in-process: two keys in one save; J's sequence (20, back, 20 again, built on an old copy); V on the current file | each refused with a line; "back" equals the board, so nothing to do |
| in-process: a write failing, then the user's change | a line, held 1; the file is put right once writes work |
| in-process: restart; the user changed a key while the bridge was stopped, a peer changed another | the user's change: one line, put back. The peer's: written in, no line |

Across all of these I looked for "not sent, no line, overwritten": **none** (the out-of-range values above are the
only ones found, in a separate probe). `settings2.sh` and the own-undo probe of earlier rounds were not rerun: they
test whether a user's change is sent, and now it never is; the table above covers their sequences.

## 3. `--once` (live)

- A settings change made while the bridge was stopped: the line, then "1 change in this file did not reach the
  board", **exit 2**; the file is put back.
- Run again with nothing changed: exit 0. After a peer's change while stopped: no extra line, exit 0.

## 4. Seeding

- **Live:** a fresh board and a file with Layer 1 hidden: the board takes it, once (1 key set, 0 lines).
- **In-process:** an unset board takes the file's grid and layers with one settings op, and no more in 40 further
  passes. A newcomer file with other layers and grid: the board's stand, one line, its file is put to the board's;
  its `snap` (never set on the board) is seeded. A racing save carrying an unset key: seeded. A viewer: nothing
  sent, held, said. A seed the server refuses: 2 tries, one line, not looped. The board set the key a moment before
  the file joined: the board's value, one line.
- **Worth knowing, not a defect:** a key counts as "set" only once someone sent it. A file whose layers equal the
  board's defaults seeds nothing, so its first later change to `layers` is the seed and is sent (in-process).

## MEDIUM

### The first peer change after a start can print the "change made here" line though nothing was changed here

- **Live:** bridge started on a fresh board (the file's layers seeded, no file write needed). A peer shows the
  layer: the file is updated correctly, and the bridge prints "board settings are set on the board, not from this
  file: layers in this file differs from the board's (a change made here, or an older copy…)". Two more peer
  changes after that: no lines.
- **Cause (read):** `written` is only set when the bridge writes the file. Until its first write it is empty, so a
  file that simply hasn't been given the peer's value yet reads as a file-side change. In-process the same.
- **Effect:** one misleading line per key, at most once per start (the "at most once" is read from the code; live I
  saw one line, then none for two more changes); nothing is lost and nothing is sent. It is the
  one place where "a peer's change arriving must print no line" does not hold, and the doc's sentence ("prints
  nothing") is not true for it. With `--once` it did not show: a peer's change made while stopped gave no line and
  exit 0 (the saved state fills `written`). Fix direction, untested: also set `written` when a pass finds the file
  already in step, or after a seed is acknowledged.

## Can a real change be mistaken for "not updated yet"? (the manager's question)

- **Not in anything I could build with a working disk.** A file value is quiet only when it equals what the bridge
  itself last wrote; a user putting that exact value back has changed nothing.
- **Edge, LOW (codex, read; I ran the nearby cases):** while writes are failing (FAT, exFAT, a full disk), the
  bridge's memory stays at the old value. A user's change there is refused with a line; setting the old value
  again afterwards is quiet, and it is overwritten once writes work. The disk's own refusal line has been printed.
- **Deleting a key from the file** (in-process): put back from the board, no line. No tool I know deletes one.

## LOW

- The two edges above.
- While writes are failing, a value already said is not said again when it comes back (in-process: 20, 25, 20
  gives two lines); the file keeps it until writes work.
- codex: a file's seed for a never-set key can land just after a peer's first setting of that key that the bridge
  hasn't applied yet, and win (read; the same race two web clients would have).
- codex: a refused seed is not counted as held, so `--once` can exit 0 after printing the refusal (in-process: held
  0 after a refused seed; the reference room refuses no valid setting, so this needs another server).
- Noise: about one line per stale drawh save that meets a peer's settings change (37 lines for 27 peer changes
  while an agent drew). The builder offers once-per-value instead; the manager's call.

## The doc

`drawh-server.md` states the limit plainly: settings flow board to file only while connected, a differing value is
put back with the quoted line, "to change it, use the board (the web app)", `--once` exits 2, seeding is the
exception, and it comes back with protocol v1.1. One sentence to correct: "a file that simply hasn't been given the
board's new value yet prints nothing" (see MEDIUM).

## sdd review of the new hunks

- **Ran: codex only** (effort high, own clone, edited nothing). Three findings: the failing-write and deleted-key
  edges (it rated them high; I grade LOW: they need a disk the bridge can't write, or a key deleted by hand); the
  seed race (LOW); the refused seed and `--once` (LOW). None is a silent loss with a working disk.

## Not verified

- A real Herdr pane as the writer: every live run uses drawh or a drawh-shaped save.
- H1, the disk images, link mode, RL2 and the process-list token checks this round (files unchanged). Token sweep
  of this round's 16 state, output and board files: no canary.
- A real Plenary server, protocol v1, Linux, `wss://`; bun as the runner in my live runs.

## How to rerun

Scratchpad `/private/tmp/claude-501/-Users-r-repos-plenary/7c151fa9-5670-49b0-b142-66f2d5ad1c5a/scratchpad/r6/probe/`:
`settings.sh` (section 1), `loud.sh` (sections 2 to 4 live, and the MEDIUM), `opt2.test.js` (in-process),
`recheck.test.js` (earlier rounds' cases: unchanged results). Stand-ins on port 0, stopped by their recorded PIDs;
no processes or mounts left.

---

# Re-check 4b (2026-11-11, after "Option 2, fix")

**The four things asked all pass. One more gap of the same kind as re-check 4's turned up in a new probe, so by
the rule I used then this is FAIL by the letter, and the manager's call.** The gap: an invalid value hand-written
into a setting the board has *never* set is not sent and not said; when a peer later sets that setting, the file is
put to the peer's value with no line. It needs a hand edit (or another tool) and is not new in 4b. Passing: the
four out-of-range values now print a line, the first peer change after a start prints none, no peer change undone,
every ordinary settings change refused out loud. Patch checked: sha256 `779198853abb22b4…`, against herdr-draw
5dfe352. Since last round only `cli/bridge.js` changed (two places in the settings rule) plus tests;
`cli/files.js`, `cli/plenary.js` and `cli/drawh` are byte-identical. Labels: live = real `drawh` against my
stand-in (or a drawh-shaped save where said); in-process = the real `Bridge` on the reference `Room`.

## The remaining gap (HIGH by the letter, narrow)

- **In-process:** a board that never set `snap`; the file is given `snap: "yes"` (not a valid value). Nothing is
  sent and nothing is printed. A peer then sets `snap: true`: **the file becomes `true`, 0 lines.**
- **Not new:** the same result on last round's patch. The cause differs: last round the value was skipped as invalid
  before any check; now the "file is in step" branch records it as something the bridge gave the file, so its
  replacement reads as a peer's change arriving.
- **Who can write it:** a hand edit or another tool. drawh clamps what it writes and the pane's values are in range,
  as far as I read them (same as last round; not run live).
- **Fix direction, untested:** say a line when a never-set key holds a value that is not valid ("not sent"), and
  leave such a value out of what the bridge counts as its own.
- **Why the manager may accept it:** the value could never reach the board, the ordinary tools can't produce it,
  and what replaces it is a peer's legitimate first setting of that key.

## Gates (all pass)

| Check | Result |
|---|---|
| `git apply --check`, fresh clone of 5dfe352 | clean; 23 files, +2868 −3 |
| herdr-draw's tests there | **291 pass, 0 fail** (258 before the patch) |
| plenary `bun test --path-ignore-patterns 'test/web/adapters/transport-ws*'` | 573 pass, 78 skipped, 0 fail (run once, at the start; HEAD b75e110 plus other sessions' work); no `(fail)` lines |
| protocol copy, built mod | equal to plenary's `packages/protocol`; `diff -r build/herdr-draw mods/herdr-draw` identical |
| herdr-draw untouched | status empty, HEAD 5dfe352, no stash, one worktree, refs identical; real `~/.cache/herdr-draw` unchanged; temp folders 30 before, 30 after |

## 1. Out-of-range values in a key the board has set: now said (in-process)

| Value written into the file | Last round | Now |
|---|---|---|
| grid 2000 | put back, no line | put back, **1 line** |
| grid as the string "20" | put back, no line | put back, **1 line** |
| a layer with opacity 150 | put back, no line | put back, **1 line** |
| a layer missing `locked` | put back, no line | put back, **1 line** |

The line as printed: "board settings are set on the board, not from this file: grid (not a valid value) in this
file differs from the board's…". Nothing is sent. `held` is 1 after the pass that sees it (0 last round), which is
what makes `--once` exit 2; I did not run that exit code live for an out-of-range value. In a key the board never
set, an invalid value stays in the file, unsent and unsaid: see the remaining gap above for what happens next.

## 2. The first peer change after a start: no line

- **Live:** bridge started on a fresh board (the file's layers seeded, no file write yet). A peer shows the layer:
  the file is updated, **0 bridge lines** (1 misleading line last round). Two more peer changes: 0 lines.
- **In-process:** the same, 0 lines; the related case (file still at the old value when a peer's change is applied)
  also 0 lines.

## 3. Reruns

- **R1, live `settings.sh`:** drawh adding shapes back to back for 60 s: **0 of 35** peer changes undone (341 saves,
  50 bridge lines for the stale saves put back); one shape every 2 s for 90 s: **0 of 54** (42 saves, 1 line).
- **The user's changes, live `loud.sh`:** `drawh layer --hide` 20 times: sent 0 times, put back with no line 0
  times. Hide, show, hide 0.1 s apart 20 times: the same. Case V staged: the user's 20 refused with a line, the
  peer's 30 no line, the undo built on the old copy refused with a line; the board keeps 30.
- **`--once`, live:** a change made while stopped: the line, "1 change in this file did not reach the board", exit
  2. Nothing changed: exit 0. A peer's change while stopped: no line, exit 0.
- **Seeding, live and in-process:** a fresh board takes the file's layers once; a newcomer's differing settings get
  the board's with a line; a racing save's unset key is seeded.
- **In-process, 21 tests covering this and earlier rounds' cases:** no "not sent, no line, overwritten" anywhere; stale saves
  never undo a peer's change; the same change three times with one pass between gives a line each time.

## The doc

Re-read: the settings section now says a value the room would refuse "gets the same line, marked 'not a valid
value'", and that a peer's change prints nothing "from the first change after a start on". Both match what I ran.
It does not mention the remaining gap.

## Still open (unchanged, all graded before)

- LOW: while writes are failing, a value already said is not said again when it comes back; a key deleted from the
  file is put back without a line; a refused seed is not counted for `--once`'s exit code; a seed can race a peer's
  first setting of a never-set key.
- Noise: one line per stale drawh save that meets a peer's settings change (50 lines for 35 peer changes while an
  agent drew). The manager's call, as noted last round.
- From earlier rounds, accepted: link mode's odds on disks that can't swap; seeding an old board with a pane open.

## Not verified

- A real Herdr pane as the writer. A real Plenary server, protocol v1, Linux, `wss://`.
- H1, disk images, token-in-URL and process-list checks this round (their files are unchanged); this round's probe
  files contain no canary.
- No sdd pass this round: the brief did not ask for one, and the change is two small edits read in full above.

## How to rerun

Scratchpad `/private/tmp/claude-501/-Users-r-repos-plenary/7c151fa9-5670-49b0-b142-66f2d5ad1c5a/scratchpad/r7/probe/`:
`opt2.test.js` (in-process; case 7 is section 1, case 9 the remaining gap), `loud.sh` (sections 2 and 3 live), `settings.sh` (R1),
`recheck.test.js`. Stand-ins on port 0, stopped by their recorded PIDs; no processes or mounts left.
