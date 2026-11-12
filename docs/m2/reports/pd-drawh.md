# Report: pd-drawh (drawh proposal)

**The numbers below are round one's. Current state: the last section, "Option 2, fix".**

2026-11-11. Outcome: patch and one-page proposal written; patch applies cleanly to herdr-draw 5dfe352 and
herdr-draw's tests pass with it (269 pass, 258 before). Plenary `bun test`: 125 pass. Nothing committed, nothing
applied to herdr-draw, nothing published. **Waiting on the CEO: approve or reject.**

## What changed (plenary files, all new)

- `docs/m2/proposals/drawh-server.patch` (1,776 lines; header names base 5dfe352 and protocol source b78f6ec)
- `docs/m2/proposals/drawh-server.md` (the two-minute read)
- `docs/m2/reports/pd-drawh.md`

No plenary code touched. `~/repos/herdr-draw` untouched: status clean, HEAD 5dfe352, no stash, no worktree.

## Shape chosen (the brief left it open)

`drawh --server URL --board ID [--token T] [--once] FILE` is a bridge between a board **file** and a Plenary board.
drawh is Python with no WebSocket, so it starts node or bun (as it already does for core code) on `cli/plenary.js`;
the logic is `cli/bridge.js` (no I/O, driven by a protocol `Replica`). The pane gets the live board through the file
it already watches, so `adapters/herdr/` is unchanged and nothing depends on Herdr's untested WebSocket.

| Brief item | Done as |
|---|---|
| hello with token in the first message, never a header | `Replica.connectMessages` unmodified; tests assert no token in the request's headers or URL (the stand-in records both), output, or state file |
| `since` from local state | state file `~/.cache/herdr-draw/plenary/<hash>.json` (seq, settings seqs, element versions seen); never the token |
| live ops via a Replica | file diff → `replica.local` → socket; entries → file |
| without `--server`, as today | one early `if` in `main()`; existing 258 tests unchanged and passing |
| protocol byte-identical + SOURCE.json | `protocol/` beside `core/` (imports `../core/`), plenary b78f6ec, sha256 per file, test |
| token from flag or env, never logged or on disk | `--token` / `PLENARY_TOKEN`; passed to the runner by env, not argv; output redacts it |
| tests without a server; in-process Room if feasible | 11 tests: 9 with an in-process `Room`, 2 running real `drawh` over a local WebSocket around `Room` |

Beyond the brief (small, say if unwanted): `--once`; refusing `ws://` to non-loopback hosts unless `--insecure`;
refusing credentials in the URL.

## Tests added (herdr-draw `test/plenary.test.js`)

SOURCE.json matches; hello shape and token only in hello; both directions, no echo, deletes; settings (unset board
takes the file's, set board keeps its own); viewer sends nothing, pictures' bytes and far versions skipped; a refused
op isn't resent; `since` from saved state, offline edits sent, bad state or a room that is behind starts from 0; a write racing the bridge's is kept and sent; `unavailable`
asks for a delayed reconnect;
end to end `--once` twice; refused token and flag checks.

## How I checked it

- Baseline in a scratch clone before any change: 258 pass.
- Mutation check: removing the refused-op memory, the room-owned-settings rule, or the saved-state check each fails
  at least one test.
- Live session against a scratch stand-in (Bun WebSocket around the reference `Room`,
  scratchpad `standin.js` + `live.js`), once with only node on PATH (26.12) and once with only bun (1.4.4): all steps
  ok. Also ran `mods/herdr-draw/drawh --server … --once` from the built-mod layout.
- Fresh clone (`hd3`) of the final patch: `git apply --check`, apply, `bun test` 269 pass; tree identical to the
  working clone; `protocol/*.js` byte-identical to plenary's `packages/protocol` today.
- An advisor review after the first cut found two real faults, both fixed and re-verified: the runner shared drawh's
  temp file name (`.drawh.tmp`; now its own), and the stale-file check ran before the new text was written (now just
  before the rename, with a test). It also asked for a delay on `unavailable` reconnects (done).

## What I did NOT verify

- A real Plenary server (none yet); protocol v1 behaviour (copied code is v0: no `v: 1` in hello, no wait for
  `welcome` before resending, no `stale`/`horizon`, presence, records).
- Herdr's QuickJS runtime and a live Herdr WebSocket: neither is used by this patch.
- `herdr-app check` on the built mod with the new `cli/` and `protocol/` folders; a real pane beside a running bridge.
- The runner's back-off timer after `unavailable` (the bridge's flag is tested; the timer isn't).
- `wss://`, large boards, long runs, two bridges on one file, Node 22–25 (only 26 run).
- Engram was unreachable (`name resolver error`): no recall, nothing written.

## Risks

- The protocol copy goes stale when phase 2 rewrites `packages/protocol`; `cli/bridge.js` uses `connectMessages`,
  `local`, `receive`, `resync`, `pending`, `applied`, `appSeq`, `confirmed`, and a `snapshot` message to restore state.
  Expect a small follow-up after phase 2.
- An element more than 1,000 versions past the room's copy is refused by the room (`MAX_VERSION_JUMP`), so old,
  heavily edited boards can't be fully seeded. **For the engine track:** is a first write of an element exempt?
- A room behind the saved state (wiped dev server) is re-seeded from the file automatically.
- A non-empty file pointed at an existing board publishes its shapes to everyone; no confirmation.
- The file write is check-then-rename: a drawh or pane write in the last instant before the rename is lost.
- The other limits are listed in the proposal (board stream only, no picture bytes, non-atomic file write).

## Notes for the manager

- Plenary HEAD moved from 357c100 to b78f6ec while I worked; `packages/protocol` is identical in both (last changed
  in cc9366a). SOURCE.json names b78f6ec.
- One command of mine was declined for `pkill -f`; rerun with `kill $PID` as instructed. Per the new OFFICE.md rule:
  the shipped test binds port 0 and stops its own server object; the scratch stand-in now binds port 0, prints the
  port, and is stopped by its own PID. My earlier scratch runs used fixed ports 8791–8793 (before the rule).
- Scratch clones (`hd`, `hd2`, `hd3`) are in my session scratchpad only.

## Fix round (2026-11-11, after pd-drawhv FAIL: 2 HIGH, 5 MEDIUM, 6 LOW)

Outcome: every HIGH, MEDIUM and LOW finding fixed or answered, each fix with a test; engine's seeding rule added;
patch re-cut (2,679 lines, 23 files, +2481 −3, sha256 `a609a74c15733b68…`). `git apply --check` clean on a fresh
clone of 5dfe352; herdr-draw `bun test` there 282 pass, 0 fail (258 before the patch); plenary `bun test` 292 pass,
0 fail. One hazard of the seeding rule was open at this point; it is decided and applied in "Seeding decision
applied" at the end. herdr-draw itself untouched (status clean, HEAD 5dfe352, no stash, one worktree). Not committed.

### Findings

| # | Finding | Fix | Test (herdr-draw `test/plenary.test.js`) |
|---|---|---|---|
| H1 | a save landing while the bridge writes vanishes silently | The bridge no longer renames over the board blind. `cli/files.js`: (a) **swap**: exchange new file and board atomically (`renamex_np(RENAME_SWAP)` via one python call), read what came out, merge it if unexpected (union: winning version per element, pictures from both), send what was new. (b) **link** (the directed fix; used when a disk can't swap or `DRAWH_WRITE=link`): hard-link aside, rename, read the linked copy, merge if it differs; waits for a drawh save that is visibly on its way (`<board>.drawh.tmp`); warns once at start that a save in its window can be lost. Measured below. | "a save landing while the bridge writes…", "two saves landing during one write…" (also a storm of 30), "the board file on a real disk (swap)" and "(link)", `--once (swap)` and `(link)` end to end |
| H2 | `--server` anywhere in argv switched mode, so text `--server` after `--` broke | `server_mode()` in `cli/drawh`: the switch counts only before a command word and before `--` | "--server is the switch only where drawh's own options go…" (the verifier's three forms, its typo form, and `COMMANDS` checked against `drawh -h`). Also 16 commands compared on a pristine clone and the patched one: same stdout, stderr, exit code (random ids aside) |
| M1 | stale saved state against a room that moved on diverged silently | v0 rooms have no name, so the hello asks for one entry more than needed (the last one applied) and the answer must hold that entry (same op id, same author). Otherwise: one warning, start over from the board's copy, the file's shapes go to it. No such entry to look for (caught up from a snapshot) means `since: 0` | "a saved state pointed at another room: behind it or ahead of it…" (the verifier's `stale.test.js` case, ported), "since comes from saved state…" |
| M2 | one malformed frame killed the runner; a fake welcome hung it | `frameProblem()` checks every frame before the Replica sees it; a bad frame or a throw inside means: say so once, drop the replica, reconnect after a delay. One deadline per connection (welcome + catch-up, 20 s) covers the fake welcome | "frames that make no sense never throw…" (16 bad frames + a throw inside), "…unavailable or silent…" (deadline, live) |
| M3 | back-off after `unavailable` never grew | the delay resets only when a pass gets everything through (`settled`), not on `welcome`; first delay injectable (`DRAWH_RETRY_MS`) | "drawh --server keeps trying a server that is unavailable or silent, more slowly each time…" (0.04, 0.08, 0.16, 0.32 s seen live) |
| M4 | `--once` exited 0 when a change didn't land | exit 2 when the file holds changes that were not sent (refused, read-only role, unsendable), with a count on stderr; 0 only when in step; 1 otherwise | "drawh --server --once tells a script when something didn't land…" |
| M5 | a refusal took every element in the op with it; the warning named none | a refused op with several things is taken apart (settings alone, then halves) until the one at fault is alone; the warning names it. At most 24 splits per run, each costs a resync | "one bad element doesn't keep its neighbours from the board…" (1 bad of 8 + a bad settings patch: 7 arrive, 2 warnings, ≤ 6 refusals) |
| L1 | a token in the URL's query was accepted | refused before connecting: token-like query names, or the token's own text anywhere in the URL | "…flags, URL and path are checked before anything connects" (4 query forms) |
| L2 | `--once` on a directory waited 30 s | checked in drawh and in the runner: exits 1 at once; also a missing parent folder | same test |
| L3 | no hello timeout without `--once` | the M2 deadline | "…unavailable or silent…" |
| L4 | tests left `drawh-plenary-*` folders in the temp dir | every test removes the folder it made, by its own path | (counted before and after a run: 30 and 30; the 30 left by earlier runs stay, I don't delete by pattern) |
| L5 | the doc's `ps` sentence was wrong | corrected in `drawh-server.md` (token in the runner's environment for its lifetime; `--token` in argv only until the exec; shell history) | doc only |
| L6 | settings keys from a server went into the file unchecked | `pull()` takes only keys and values `appStateProblem` accepts, own keys only | "settings a server has no business sending never become keys in the file" |
| — | engine's seeding rule | an element the board has no copy of is sent as version 1 with a fresh nonce, same id; the file is renumbered to match; an element already at version 1 is left alone. Replaces the 1,000-version refusal for old boards. No new message, no server path | "seeding: a shape the board has never had…", "KNOWN HAZARD of seeding…", both `--once` end-to-end tests |

Mutation check: eleven of these rules were each broken on purpose; every one failed at least one test.

### Found on the way (mine, not the verifier's)

- **Restore bug, would have shipped with the seeding rule:** after a restart, a shape edited while the bridge was
  stopped was left out of the replica, so it looked like "never on the board", was renumbered to version 1 and could
  lose the tie against the board's own version 1. Now it is restored under the version the room had and goes out as
  an ordinary edit. Tests assert the version (2), not just the position.
- **A refused settings change was never retried alone** (the bridge had already counted it as agreed). Fixed; the M5
  test covers it.

### H1 measurement (the verifier's `race.py`, `standin.js`, `p5.sh`, `p6.sh`, copied unchanged)

Its scripts point at its own clone, so I ran copies in my scratchpad with my own `env.sh` (my patched clone, my state
dir). Its file names are one off from its titles: `p6.sh` is the rate table ("probe 7"), `p5.sh` the growing board
("probe 6"). "Lost" = the writer's element in neither the final file nor the room. "Peer entries missing from file"
was 0 in every row of every run. The control row is still a control: the writer's elements are version 1, so seeding
doesn't make the bridge rewrite the file.

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

- **Swap: 0 lost in 4,541 saves**, every row, three runs each.
- **Link exactly as directed: 5 lost in 4,519**: fewer than the first cut (15 of 1,560; worst row 2 of 1,368 against
  13 of 498), not none. Timed: `link` 0.17 ms + `rename`
  0.07 ms (median, APFS), and the other writer's rename queues on the folder between them, so the blind window is
  about a quarter of a millisecond, not "two system calls and nothing".
- **Link as shipped (waits up to 300 ms while `<board>.drawh.tmp` exists): 0 lost in 3,842.** This is honest for
  drawh and flattering for anything else: the probe's writer uses drawh's temp name. The pane's saves can't be seen
  coming, so in fallback mode they keep the "as directed" odds. The fallback warns once at start.
- Bridge stderr in these runs: the connect line, plus the fallback's one warning in link mode. No temp files left
  beside the boards. Stand-ins stopped by their recorded PIDs; no processes left.
- A python start per write did not make the file lag: 0 peer entries missing in every row.

### What I did NOT verify (this round)

- Same gaps as before: a real Plenary server, protocol v1, Herdr's runtime, `herdr-app check`, `wss://`.
- **A real pane as the other writer.** The measurement's writer copies drawh's save. The pane's `writeTextFile` is
  documented as replacing atomically (herdr's `gpui-kit.d.ts`); I did not watch it. The pane's behaviour after
  seeding (it keeps old version numbers) is read from `FileStore.absorb` / `Doc.apply` and simulated in a test.
- **The swap anywhere but this Mac's APFS disk**; the link fallback on a disk that really can't swap (it was forced
  with `DRAWH_WRITE=link` on APFS). No Linux branch: I can't run one here, so Linux gets the fallback.
- Node 22 to 25 (26.12 and bun 1.4.4 were run). Runs longer than about 90 s.
- Engram unreachable again (`name resolver error`): no recall, nothing written.

### Where I went past the directive, or stopped short of it

- **Past:** the atomic swap. The directed fix (link aside, rename, compare, re-merge) is in and is the fallback, but
  measured on its own it still loses saves, so it is not the default on a disk that can swap.
- **Short:** "every fix gets a test": L4 (temp folders) and L5 (a sentence in the doc) have none; checked by hand.
- **Short:** "detect and warn whenever a lost write is possible". In link mode a save inside the window cannot be
  detected per event by any means I found (there is no compare-and-swap for a rename); the bridge warns once at
  start instead, and dodges drawh's saves by watching for drawh's temp file. In swap mode there is nothing to detect.
- **Not done:** a lock in drawh's `save()` (it would change drawh without `--server`, and the pane wouldn't take it).
- **Cost of the swap:** one python start per file write, about 46 ms on this Mac for a 600 KB board (link: about 2 ms).

### Questions

- **Engine and manager: the seeding rule and an open pane** (found in the final review, pinned by the test "KNOWN
  HAZARD of seeding"). Seeding lowers versions in the file; a pane that has the file open keeps the old numbers
  (`Doc.apply` drops a lower version) and writes them back with its next save.
  - Old number up to 1,000 above the board's: the stale copy is sent and **overwrites anyone's later edit to that
    shape, silently** (nothing held, nothing warned).
  - More than 1,000 above: held back with a warning, `--once` exits 2, and the file keeps the high number for good.
  - It is not only first runs: `drawh add --label` makes a version 2 shape, which is renumbered while a pane watches.
  - I kept the rule exactly as directed and did not invent a second one. Decided since: see "Seeding decision
    applied" below.
- **Engine:** v1's `welcome` should carry a room identity. The "ask for the last entry again" check is a stand-in.
- **Manager:** the swap needs python at run time (drawh is python, so it is there) and costs about 46 ms a write.
  Acceptable, or should the fallback be the default?

### Housekeeping

- Port 0 and own-PID stops everywhere: the shipped tests (`Bun.serve` on port 0, stopped by its handle; bridges
  stopped by their own process handle), my stand-ins (PID in `srv.json`, `kill` of that PID only). No pkill/killall.
- `packages/protocol` is unchanged in plenary since the pin (b78f6ec); no drift.
- For the v1 re-copy: a room that answers the hello with a snapshot (it compacted past the saved seq) is treated as
  "not the board" (one warning, full resync). Harmless in v0; v1's checkpoints will make it routine, so the room
  identity question above should be settled first.
- The measurement stands for the final patch: the last re-cut changed two warning texts, a test and docs, not the
  write paths.
- Scratch clones in my scratchpad: `hd` (working), `hd0` (pristine, for parity), `hd2` to `hd5` (apply checks; the
  final patch was checked in `hd5`, and one `--once` was run from its built mod, `mods/herdr-draw/drawh`, in each
  write mode: exit 0, shape in the room, no temp files left).
  Measurement folders `mswap`, `mlink`, `mlink5`, `mlink6` and their logs are there too.

## Seeding decision applied (2026-11-11, third cut)

Outcome: seeding narrowed as the manager decided; patch re-cut (2,722 lines, 23 files, +2524 −3, sha256
`fdcd68944fdd9764…`). `git apply --check` clean on a fresh clone of 5dfe352 (`hd6`); herdr-draw `bun test` there
284 pass, 0 fail (258 before the patch); built mod current; plenary `bun test` 315 pass, 69 skipped, 0 fail (the
skips are other sessions' tests). herdr-draw untouched (clean, HEAD 5dfe352). `packages/protocol` still equals the
copy. Not committed. The fix-round numbers above (282 tests, sha `a609a74c…`) are the second cut's.

| Asked | Done | Test |
|---|---|---|
| renumber only shapes the room would refuse: not on the board yet and version above 1,000 (absent = version 0, cap = a jump of 1,000) | `push()` in `cli/bridge.js`: `!cur && el.version > MAX_VERSION_JUMP`. Everything else is sent with its version unchanged | "seeding: only a shape the room would refuse…": 5000 and 1001 become 1 (file and room, same new nonce, same id); 1, 2, 37 and 1000 keep version and nonce in both |
| a normal version-2 shape (drawh add --label) is NOT renumbered | same | that test (the "two" shape), and both `--once` end-to-end tests: the real `drawh add --label` shape is version 2 in the room and the file, 3 after `drawh move` |
| keep the KNOWN HAZARD test, retargeted to the >1,000 case | retargeted: a shape at 1001, renumbered, edited by a peer, then written back at 1001 by "the pane": the stale copy overwrites the peer's edit, nothing held, nothing warned | "KNOWN HAZARD of seeding an old board (version past 1,000) with a pane open…" |
| (mine) ordinary shapes are now safe from that | a version-37 shape, peer edit, pane writes 37 back: the peer's 38 stands and the file is put right | "an ordinary shape is never renumbered, so an open pane can't overwrite a later edit…" |

### Engine's change (renumber to 1,000, not 1): not taken, and why

The instruction was "use 1,000 unless one of your tests shows a reason for 1". One does, so the patch keeps 1.

- **The argument:** a shape is renumbered only if its version is past 1,000, so every stale copy a pane can still hold
  of it is past 1,000 too. Renumbering to 1,000 therefore outranks none of them. What the target number changes is
  how many stale copies fall within the room's jump limit (board's version + 1,000) and are sent unseen.
- **Target 1:** a stale copy at 1,001 or just above gets through silently; anything higher is held back with a warning.
- **Target 1,000:** every stale copy from 1,001 to 2,000 gets through silently.
- **The test:** "renumbering to 1 keeps a pane's remembered copy at 1,500 out, and says so". Shape at 1,500, renumbered,
  a peer moves it, the pane writes 1,500 back. With 1: the peer's move stands, 1 change held, 1 warning. I switched
  the code to 1,000 and ran it: that test fails (the stale copy is sent and the peer's move is gone, no warning).
  The other two failures in that run were only tests asserting the literal number. Code restored to 1.
- **What 1,000 would buy:** it would outrank stale copies at or below 1,000 of the same id, which can only come from
  somewhere other than the file being seeded (another, older copy of the board). I don't see that case in drawh's
  use; if engine has one in mind, it is a one-character change (`version: 1` in `push()`), and three tests name the
  number.

### Not verified (unchanged)

A real pane as the writer in any of this: its part is read from `FileStore.absorb` / `Doc.apply` and simulated by
writing the file as the pane would. The H1 measurement was not rerun for this cut: the write paths (`cli/files.js`,
the sync loop) did not change, only which elements `push()` renumbers.

**For the manager:** the seeding question is closed as you decided. One point came back the other way: engine's
"renumber to 1,000" is not in the patch, for the reason above; say if engine still wants it.

## Fix round 2 (2026-11-11, after the re-check: FAIL, 1 HIGH, 3 MEDIUM, 7 LOW)

Outcome: R1 fixed and measured at 0 undone with the verifier's script; RM1, RM3 and RL1 to RL4 fixed with tests;
RM2 and RL5 to RL7 answered in the doc. Patch re-cut: 3,019 lines, 23 files, +2821 −3, sha256 `d5364ec770aea491…`.
`git apply --check` clean on a fresh clone of 5dfe352 (`hd8`); herdr-draw `bun test` there 290 pass, 0 fail (258
before the patch; `test/plenary.test.js` has 32); built mod current; plenary `bun test` 322 pass, 70 skipped, 0 fail
(the skips are other sessions'). herdr-draw untouched (clean, HEAD 5dfe352, no stash). `packages/protocol` still
equals the copy (pin b78f6ec). Not committed.

### Findings

| # | Finding | Fix | Test (herdr-draw `test/plenary.test.js`) |
|---|---|---|---|
| R1 (HIGH) | a stale drawh save undoes a peer's settings change for the whole board | `cli/bridge.js`: when the room's value replaces the file's for a key, the bridge remembers what the file held and what was last agreed (`recent`, per key, 10 s). In `push()`, a file value equal to one of those is a stale save: not sent; `pull()` writes the room's value back. `union()` takes a settings key from the other save only if that save changed it (differs from what the file held before our write) | "a stale save doesn't undo someone else's settings change…" (the verifier's steps; then saves built on three earlier generations of the file; then a real change and a deliberate revert after the window), "the same through the merge…" |
| RM1 | on FAT the "swap" is a plain rename; exFAT can't be written; errors unclear | `cli/files.js` `probe()`: before the first write, swap two scratch files beside the board and trust the swap only if both come out exchanged; else link mode; if hard links fail too, mode `none`: `replace()` refuses with one clear line (`NO_SAFE_WRITE`), creating a new board still works, the file's changes still go to the board. Runner prints a write error once, not every pass | "a disk that doesn't really swap is found out on two scratch files…" (a python that renames stands in for FAT, a link that refuses for exFAT). Live on disk images, below |
| RM2 | link mode still loses saves it can't see coming | not fixable without a lock (round one's answer stands); warns once at start; doc says which disks get it | none new |
| RM3 | renumbering is silent; the band widens with the board's versions | one line when it renumbers, naming the shapes: "reopen any pane that has this file open…". Both facts in the doc | "seeding: only a shape the room would refuse…" (the line, once), "the band a remembered copy slips through moves up…" (600 peer edits, a copy at 1,500 gets through) |
| RL1 | a second welcome with a huge seq hangs the bridge mid-session | the deadline now runs whenever the bridge is behind, not only at connect | "…unavailable or silent…" (extended: a mid-session welcome naming seq 1e9; the bridge gives up, reconnects, the next edit arrives) |
| RL2 | token percent-encoded Python-style rides in the URL | the URL is compared raw and percent-decoded (up to three layers) | "…flags, URL and path are checked…" (three encodings of a token with `*()!`) |
| RL3 | a short token that occurs in the URL is refused | the "token text in the URL" check applies to tokens of 8 characters or more; query names are still checked for any token | same test (token `b1`, path `/boards/b1`: goes on to a plain `auth` refusal) |
| RL4 | wrong token or `unavailable` first, with saved state, printed "not the board" and dropped the state | a refusal or `unavailable` is not evidence about which room this is: the check stays pending, the saved position is kept | "a refusal as the first answer is reported as what it is…" |
| RL5 | a save taken off the disk waits in memory during a pile-up | not changed (a few ms, more than eight saves racing one pass); in the doc | none |
| RL6 | a hostile server can write a well-formed absurd element | not changed (the server owns the board); in the doc | none |
| RL7 | a symlinked board is replaced by a regular file | not changed (drawh's own save does the same); in the doc | none |

Mutation check: eight of the new rules broken on purpose; seven were caught. **The one not caught: the `union()`
settings rule on its own.** Every case I could build for it is also stopped by the `push()` guard (the room's value
has just replaced the file's in the same pass, so the stale value is in `recent`). It is in as a second line of
defence and is not independently pinned by a test.

### Found in the final review, fixed before this cut

- **A failed write still got the old settings sent.** `pull()` counted the room's settings as agreed before the write;
  when the write threw (which is every pass on FAT and exFAT now, and any full disk or read-only folder), the file
  kept its old value, and once the 10 s window lapsed it looked like a change made here and was sent, undoing the
  peer's. Now what was agreed is put back if the write fails. Test: "a file the bridge can't write keeps its old
  settings to itself…" (a write failing on every pass for 24 s of bridge time, and one failing once); it fails
  without the fix. This touches only the path where a write throws, so the measurements above it stand.
- **Left as it is:** on such a disk, a shape renumbered for seeding is sent as version 1 while the file keeps its old
  number (the write failed); the next pass holds it back with the warning. Old boards on FAT/exFAT only.
- **Live session rerun** after the runner changed (the deadline is an interval now): 10 of 10 steps ok under node
  26.12 and under bun 1.4.4.

### R1 measured (the verifier's `settings.sh` and stand-in, copied unchanged, my clone; real drawh, real bridge, default mode)

| drawh activity | Before (verifier) | Now |
|---|---|---|
| adding shapes back to back, 60 s | 28 of 35 undone (324 saves) | **0 of 36** (363 saves) |
| one shape every 2 s, 90 s | 3 of 54 undone (42 saves) | **0 of 55** (42 saves) |

Bridge warnings in both runs: 0. One `drawh add --label` took about 140 ms, as in the verifier's run.

### RM1 live (the verifier's `disks.sh`, copied unchanged: small disk images mounted in my scratchpad, detached after)

| Disk | Board exists, a peer's shape must be written in | No board yet | A local edit reaches the room |
|---|---|---|---|
| FAT (MS-DOS) | refused with the `NO_SAFE_WRITE` line, exit 1, file untouched | created, exit 0 | yes (exit 1: the room's shapes still can't be written) |
| exFAT | same | created, exit 0 | yes (exit 1) |
| HFS+ | written, with the link-mode warning, exit 0 | created, exit 0 | yes, exit 0 |

FAT lands in `none`, not link: it has no hard links either. Nothing left on the disks but the two board files; no
mounts left.

### H1 again (write path touched by the probe, so rerun)

The verifier's worst-case script three times, default mode, final write code: **0 lost of 2,275 saves** (177 + 685 +
1,413 across the three phases), 0 peer entries missing from the file, no temp files left.

### What I did NOT verify (this round)

- The settings fix with a real pane as the writer (a pane's save is the same shape of event as drawh's; not watched).
- A drawh command running longer than 10 s across a settings change: by design it is not recognised as stale.
- A real FAT/exFAT/HFS+ disk other than a disk image; Linux; a missing python this round (the verifier ran that:
  link mode, correct).
- Still: a real Plenary server, protocol v1, Herdr's runtime, `herdr-app check`, `wss://`. Engram unreachable.

### Choices of mine worth a look

- **The 10 s window is a judgement.** Longer catches slower commands and makes a deliberate revert bounce for longer;
  shorter the reverse. It is one constant (`STALE_MS` in `cli/bridge.js`).
- **A deliberate revert inside the window is treated as a stale save** and undone once, silently. I chose silence
  because the same event from a stale save happens hundreds of times a minute while an agent draws.
- **On FAT and exFAT the bridge refuses to write** rather than write unsafely with a warning. That makes those disks
  one-way (file to board). Say if a lossy-but-working mode is wanted there instead.
- The last edit after the measurements was one message's wording ("(exFAT?)" to "(FAT or exFAT?)"); the patch was
  re-cut and re-verified after it, the live disk run shows the earlier wording.

### Housekeeping

Stand-ins on port 0, stopped by the PIDs recorded in `srv.json`; bridges stopped by their own PIDs; disk images
detached by the device hdiutil printed; no pkill/killall; 0 processes and 0 mounts left from my scratchpad. Scratch
clones: `hd` (working), `hd0` (pristine), `hd2` to `hd8` (apply checks; the final patch was checked in `hd8`).
Round-2 measurement folder: `r2/probe` in my scratchpad (`run.sh`, `run.log` one level up).

**For the manager:** nothing blocked. Three choices above are yours to overrule: the 10 s window, the silent revert,
and refusing to write on FAT/exFAT. I can't read my own context share from in here; check this pane's footer before
sending another round (this session is long).


## Fix round 3 (2026-11-11, brief pd-drawh3: settings without a clock)

### Step 1: does an unknown key in `appState.herdr` survive? **Yes, both paths. Option 1 (base marker) chosen.**

Scratch clone of 5dfe352 with the round-2 patch applied; a board file carrying `appState.herdr.plenaryGen: "g-7"`.

- **(a) drawh commands** (real `cli/drawh`): after `add --label` (runs core through node), `add` (pure python),
  `layer L2 --hide`, `style --color`, `move --by`, `label`, `arrow`, `rm`, `clear`, the file still holds
  `plenaryGen: "g-7"` every time. Why (read): drawh edits the parsed JSON in place (`scene.setdefault("appState",
  {}).setdefault("herdr", {})`) and its node step goes through core's `Doc`, which spreads `appState.herdr`.
- **(b) the Herdr pane's save:** the real `FileStore` and `Editor` from the built mod (`mods/herdr-draw/store.js`),
  Herdr's file API stubbed with an in-memory disk whose `writeTextFile` is check-and-write as Herdr's is:
  - a plain save after a local element edit and a local settings change (`snap: false`): `g-7` kept, `snap` saved;
  - a save racing a bridge write (file moved to `g-8`, `grid: 40` behind the pane's back): the check-and-write fails,
    `FileStore.merge` takes the file's settings, the save writes `g-8` and `grid: 40`;
  - after the pane absorbs an outside change (`g-9`, what its folder watch does), its next save writes `g-9`.
- **Why it holds (read):** `Doc.load` and `Doc.apply` keep `appState.herdr` by shallow spread; the editor's
  `setAppState` and undo patch named keys only; `toScene()` writes `appState` back whole. `layersOf` returns the
  stored array untouched (a default layer only when there is none).
- Evidence script: scratchpad `step1/test-step1/pane-save.test.js` (outside the clone, not in the patch).

### Outcome

Option 1 built. Board settings now carry a generation marker instead of a clock: `STALE_MS` and `recent` are gone, and
`Bridge` no longer takes a `now`. R1, R2a and R2b each pass live with the verifier's own scripts. RL2 and the doubled
`--once` text are fixed. `union()`'s settings rule has its own test, and every rule is caught by a mutation.

- **Patch re-cut:** 3,412 lines, 23 files, +3214 −3, sha256 `8cd27cf8c3ef7dac…`. This is the cut after the final
  review below.
- **Gates:** `git apply --check` and apply are clean on a fresh clone of 5dfe352 (`hdv2`). herdr-draw `bun test` there:
  **301 pass, 0 fail** (290 last round, 258 before the patch; `test/plenary.test.js` has 43). `scripts/build.sh` then `diff -r build/herdr-draw
  mods/herdr-draw`: identical.
- **Plenary:** `bun test` 331 pass, 70 skipped, 0 fail. One earlier full run had 2 failures in another session's
  untracked `test/server/outbound.test.js` (R4-H2). That file passed 21 of 21 alone, twice, and the next full run was
  clean. I touched no plenary code. `packages/protocol` still equals the copy (pin b78f6ec).
- **herdr-draw untouched:** status empty, HEAD 5dfe352, no stash, one worktree.
- **Not committed.**

### What the bridge does now (`cli/bridge.js`)

| Piece | Rule |
|---|---|
| marker | `appState.herdr.plenaryGen = "<random id>.<n>"`, written on **every** bridge write; the marker is excluded from ops explicitly (the room would refuse an unknown key anyway). |
| table | the last 64 generations: `snap` (settings written), `seq` (each key's room `appSeq` at that write; `null` for a key the room hasn't ordered: the base a compare-and-set will name, per the manager), `sent` (values already sent from files carrying it). Recorded only after the write succeeded. Saved in the sync state; cleared when the room turns out to be another one. |
| known marker | per key: equal to `snap` (canonical compare, keys sorted) = not touched, the board's value is written back; different and not in `sent` = the writer's change, sent whatever the board holds now; then the file is re-stamped (a write whose only reason is the stamp is skipped quietly if the disk refuses it). |
| unknown or missing marker | keys the board has set: not taken; the board's value is written back; one line per such save ("board settings are set on the board, not from this file: …"). Keys the board never set: sent (seeding). |
| `union()` (racing save) | ours plus exactly the keys the racing save changed from its **own** marker's generation (same rule). The `was` parameter is gone. |
| refusal split | the retried settings are dropped from `sent` and from every `snap`, so they go out again alone (found by the existing M5 test: the re-stamp had made the refused value look like the base). |

### Findings

| # | Fix | Test (herdr-draw `test/plenary.test.js`) |
|---|---|---|
| R1 | stale save = unchanged from its generation, so the board's value stays | "a stale save doesn't undo…" (the clock lines removed; the deliberate revert now happens at once); "a value already sent from a generation…" (the advisor's sequence: hide sent, an agent's read of that file lands after a peer's show); restart: "generations survive a restart…" (closes re-check 2's restart gap) |
| R2a | a revert differs from its generation, so it is sent at once | "R2a: undoing someone else's settings change at once is sent" (twice in a row, no warning) |
| R2b | no stale list at all | "R2b: after a stale save bounces, the user's own hide and show are both sent" |
| same key, stale and changed | the user's change wins, is sent | "a stale save that also changes the same key…" (`layers` is one key: the peer's layer goes; documented) |
| evicted / missing marker | option 2 for settings, said once per save, seeding kept | "a generation too old to remember, or no marker at all…" (70 writes evict the first marker) |
| `union()` settings rule | own marker's generation | "union(): a racing save's settings are taken only where it changed them…" (also: a racing save with a foreign marker) |
| marker never sent | explicit exclusion | "generations: every write of the bridge carries a new marker…" |
| FAT / failed stamp | stamp-only write failure skipped | "a settings change on a disk the bridge can't write still goes out…" |
| RL2 (`+` in a token) | the URL is checked under every decoding a parser could give it: three layers, each with `+` kept and with `+` read as a space | "…flags, URL and path are checked…" (five forms of `dG9rZW4+with/plus==`: Python-quoted, double-encoded, raw, path, `+`-as-plus; none connect, none print the encoded token). Round 2's decoder run by hand on the same five: it misses four. |
| doubled `--once` refusal | the runner doesn't repeat `NO_SAFE_WRITE` (files.js already said it) | live on FAT, below |

**Mutation check:** nine of the new rules were each broken on purpose, and every one failed at least one test.

| Rule broken | Tests failing |
|---|---|
| union takes all of the racing save's keys | 2 (incl. the dedicated union test) |
| `sent` ignored | 1 |
| no re-stamp after a send | 6 |
| judge against the room instead of the generation | 10 |
| table not saved | 1 |
| unknown marker treated as the latest | 7 |
| split refusal keeps `snap` | 1 |
| stamp-only write failure throws | 1 |
| marker let into ops | 28 |

### Found in the final review (advisor), fixed before the last cut

| # | Problem | Fix | Evidence |
|---|---|---|---|
| 1 | **Your own change, then its undo, back to back, was bounced silently.** `--hide; --show`: the show often reads the file before the bridge re-stamps it, so it carried the old marker and equalled its snapshot. This is R2a with the user in the peer's place. | A value equal to its generation is the writer's undo when the board still holds exactly the last value **really sent** from that generation (`last`, per key). A peer change in between keeps the stale verdict. | Test "the user's own change, then its undo…": direct, with a peer change between (not sent), and through a racing save. Live `undo.sh` (real drawh, no sleep): **20 of 20** shown at the end; the same script with the guard removed: **8 of 10**, two bounced silently. `settings.sh` rerun after the guard: **0 of 35** and **0 of 55** undone. |
| 2 | **FAT over-claim.** A file on FAT never gets a marker, so a change to a key the board already has is not sent. | Doc and this report corrected. The unknown-marker line no longer promises a write ("…written back here when this file can be written"). | `fat.sh` case 3, live: exit 1, room unchanged, two lines. |
| 3 | A file joining already in step stayed unmarked, so its first settings change bounced. | An unmarked file is stamped once (not a viewer's; a stamp the disk refuses is skipped). | Test "a file that joins already in step…" |
| 4 | Sync state was saved only when `applied` moved, so a generation written with no entry after it was lost. | `cli/plenary.js` saves when `applied` or the generation counter moves. | read; restart test covers the table |
| 5 | `seq` for the bridge's own unacknowledged value named the previous value's appSeq. | `null` until the room's confirmed value equals it. | Same test as 3. |
| 6 | Engram recall | Searched once: reachable, nothing relevant. | — |

Mutation check of the four new rules: each failed its test (undo guard dropped; undo guard ignoring a peer change;
unmarked file not stamped; seq not null).

### Measured live (the verifier's scripts, copied unchanged except paths; real drawh, real bridge, swap mode)

- **`settings.sh` (R1):** adding shapes back to back for 60 s: **0 of 36** peer changes undone (364 saves). One shape
  every 2 s for 90 s: **0 of 55** (42 saves). Bridge warnings: 0. One `drawh add --label` takes about 142 ms.
- **`settings2.sh`** (my addition: case 5, no pauses):

  | Case | Result |
  |---|---|
  | slow drawer, save lands 1, 3, 8, **12** s after the peer's change | kept every time (12 s was round 2's documented loss) |
  | own hide, own show 1 s later | both sent |
  | **R2a:** peer hides, user shows 2 s later, again 4 s later | **sent the first time**, and again |
  | **R2b:** stale save bounced, then hide and show 1 s apart | **both sent** |
  | case 5: peer hides, user shows 0.3 s later, five times | sent all five times |

  Bridge lines besides connecting: 0.
- **FAT image (`fat.sh`, mine):**
  - `--once` with a peer's shape waiting: exit 1, the refusal printed **once** (was twice), no "can't write" line.
  - A settings change in the file with nothing to write back: sent (room grid 35), exit 0, one line (the refusal
    notice from the stamp attempt).
  - Image detached.
- **H1 again** (the write loop changed): the verifier's `measure.sh`, swap mode, all rows: **0 lost of 1,539 saves**
  (78, 172, 174, 165, 173, 59, 211, 507). Peer entries missing from the file: 0. Temp files left: 0.

### What I did NOT verify

- **A real Herdr pane as the writer.** Step 1 ran the pane's real `FileStore` and `Editor` with Herdr's file API
  stubbed, not inside Herdr.
- **The compare-and-set path.** The per-key `seq` is stored but not sent; the room of today has no compare-and-set.
- **Two bridges on one file**, Linux, `wss://`, a real Plenary server, protocol v1/v1.1, bun as the runner in the live
  runs (node ran them; the suite ran under bun 1.4.4).
- **Link mode** this round. `sync()`'s loop changed above the file layer only; the H1 rerun was swap mode.

### Limits that remain (in the proposal)

- `layers` is one key: a stale save that also changed it wins whole.
- Your own undo is told from a stale save by the board still holding what was last sent from that file. So an agent's
  save that read the file before your change, and lands after it, undoes your change on the board too (it already
  had in the file).
- On a disk the bridge can't write (FAT, exFAT), the file has no marker: only settings the board never set go out, and
  a later change is refused loudly (exit 1 with `--once`).
- A save older than the last 64 writes falls under option 2.

### Housekeeping

- **Probes:** stand-ins on port 0, each stopped by its recorded PID. Bridges stopped by their own PIDs. The FAT image
  detached by its device. No pkill/killall, and no processes or mounts left.
- **Scratch** (`/private/tmp/claude-501/-Users-r-repos-plenary/a269c857-9bc0-4b0f-b315-b7665985173c/scratchpad/`):
  - clones: `hd` (working), `hdv` (gate);
  - Step 1: `step1/`;
  - live runs: `live/` (`settings.log`, `settings2.log`, `fat.sh`) and `m-swap/result.txt`.
- **Live probes:** `live/undo.sh` (the guard rerun) and `live/settings-b.log` (R1 after the guard).
- **Engram:** searched (reachable, no relevant memory). One lesson ingested after this report (below).

## Fix round 3b (2026-11-11, after re-check 3: FAIL on R3 only)

R3 is fixed and pinned. The fix is one rule change inside `fileChanges()` in `cli/bridge.js`: no new state (only
`sent` and `last`), and no existing test changed. The MEDIUMs and LOWs are left alone, as directed. Not committed.

- **Patch re-cut:** 3,476 lines, 23 files, +3278 −3, sha256 `bdfab945677fea60…`.
- **Gates:** `git apply --check` and apply are clean on a fresh clone of 5dfe352 (`hdv3`), and the tree is identical to
  the working clone. herdr-draw `bun test` there: **303 pass, 0 fail** (`test/plenary.test.js` has 45). The built mod
  is current.
- **Plenary:** `bun test` 366 pass, 70 skipped, 0 fail.
- **herdr-draw untouched:** clean, HEAD 5dfe352, no stash, one worktree.

### The rule (a file carrying a known generation, per key, in this order)

1. **Is the board still holding exactly the last value sent from this generation** (no one else has touched the key
   since)? Then any value in the file that differs from the board is the writer's: **send it**, whether or not it
   was sent from this generation before. This replaces round 3's own-undo guard and covers case J and toggles.
2. **Someone else changed the key since, and the value was already sent from this generation:** keep the board's
   value and **say so once** (below). The file is written back and re-stamped, so setting it again is sent.
3. **Equal to the generation's snapshot:** untouched, a stale save, so keep the board's value (R1).
4. **Otherwise:** the writer's change. Send it.

### Codex's variant: the value set again after a peer's change. What I chose, and why

- **The bytes are identical to R1's stale save.** A save on generation G carrying a value already sent from G, after a
  peer changed the key, is exactly what an agent's old read of the file looks like. This is the advisor's sequence that
  round 3 pinned: hide sent, an agent reads that file, a peer shows, the agent's save lands.
- **Sending it would bring R1 back**, the HIGH this whole thread started from. So the board's value is kept.
- **Silent loss is the bar, so it is no longer silent.** One line, once per marker and value: "board settings: grid
  in this file holds a value already sent from it, and someone has changed it on the board since; kept the board's
  (an old copy of this file and setting it again look the same). If you meant to set it again, set it again now: it
  will be sent".
- **Setting it again works:** the bridge has re-stamped the file, so the retry is judged against the new generation
  and sent (tested).
- **When the line fires:** only when a value was really sent from that generation and someone else has changed the key
  since. In the R1 runs no drawh command touches settings, so it never fired there (0 warnings).

### Tests (herdr-draw `test/plenary.test.js`, 2 new)

- **"R3: changes to one setting, each built on the same file before the bridge re-stamped it…":**
  - case J: grid 20, 10, 20, each sent;
  - 3 and 5 hide/show toggles, all on one old marker: the board ends on the last one;
  - no lines printed.
- **"R3, codex's variant: …":** the peer's value is kept (the R1 side), the line is said once, and the same value set
  again on the re-stamped file is sent.

**Mutation check (each fails a test):**

| Rule broken | Tests failing |
|---|---|
| the fix removed (round 3's order: `sent` first) | 2 (both R3 tests) |
| the variant made silent (no line) | 1 |
| the variant sent anyway | 2, including round 3's "a value already sent from a generation…" (R1's guard) |

### Live (the verifier's probes `toggle.sh`, `toggle2.sh`, `toggle3.sh`, copied unchanged apart from paths, plus one row; real drawh)

| Probe | Result |
|---|---|
| `toggle3.sh`: hide, show, hide, 0.1 s apart (R3's own probe) | **0 wrong of 30** (re-check 3: 4 of 45); drawh exit 0; bridge lines: 0 |
| `toggle2.sh`: 3 toggles 0.1 / 0.15 / 0.2 s apart (15 runs each); 5 toggles 0.15 s (10) | 0 wrong in every row |
| `toggle2.sh`, my added row: **5 toggles 0.1 s apart**, 15 runs | 0 wrong |
| `toggle.sh`: 2, 3, 4, 5 toggles back to back; 3 toggles 0.3 s and 1 s apart | 0 wrong in every row |
| `toggle.sh`, agent's stale save after the user's hide | board back to shown, silent: re-check 3's own-undo MEDIUM, unchanged, as directed |
| `settings.sh` (R1) | **0 of 36** undone (305 saves), **0 of 55** (42 saves); bridge warnings 0 |
| `undo.sh` (hide;show back to back) | 20 of 20 right; hide then show 1.2 s apart: 10 of 10 |

### Doc

`drawh-server.md` is updated where the rule changed: the settings rule list (two new bullets), the "your own quick
changes" limit, and the counts.

### Not verified

- The variant's line with a real person reading it: wording only.
- The pane as the writer (as before: the stubbed-pane evidence only).
- Link mode, Linux, a real server: as in round 3.

## Option 2 (scope cut) (2026-11-11, after re-check 3b: FAIL on case V; manager's hard stop)

Board settings now flow room → file only while connected. The generation marker, its table and the settings merge
rules from rounds 3 and 3b are removed. Everything else from rounds 1 to 3 is kept: elements, the H1 swap/link write,
H2, the seeding rule, RM1, RM3, RL1 to RL4, RL2's decoding fix and the single `--once` refusal text. Not committed.

- **Patch re-cut:** 3,030 lines, 23 files, +2832 −3, sha256 `f9ddef4d9609ed7f…`.
- **Gates:** `git apply --check` and apply are clean on a fresh clone of 5dfe352 (`hdv4`), and the tree is identical to
  the working clone. herdr-draw `bun test` there: **289 pass, 0 fail**. `test/plenary.test.js` has 31: 16 marker-era
  settings tests removed, 2 added. The built mod is current.
- **Plenary:** `bun test` 507 pass, 78 skipped, 0 fail.
- **herdr-draw untouched:** clean, HEAD 5dfe352, no stash, one worktree.

### The rule (`cli/bridge.js`, `settingsFrom()`)

- **A key the board has set:** a different value in the file is not sent. `pull()` writes the board's value back, one
  line is printed each time, and it counts as held (`--once` exits 2).
- **A key the board has never set:** sent from the file once (seeding). A seed the room refuses is not sent again.
- **A racing save** (the merge after the H1 swap): its settings are merged in as any file's, then judged by the same
  rule. Round 3's separate merge rule is gone: a mutation showed it made no observable difference.
- **One piece of state, found by the new test:** `push()` runs before `pull()`. So when a peer changes a setting, the
  file still holds the old value for one pass, and that read as a file-side change: a spurious line, and held.
  - **Fix:** the bridge remembers the settings it last wrote (`written`, restored from the saved state's confirmed
    settings). A file value equal to `written` is just not updated yet: no line.
  - **Test:** "a peer's change arriving is not a change made here: no line, nothing held".

### Tests (2 new, replacing the marker-era settings tests)

- **"option 2: a setting changed in the file is not sent …":**
  - grid changed in the file: not sent, written back, line; the same change again: line again;
  - a layer hidden in the file: put back, line;
  - a peer's change: no line, nothing held;
  - R1 (a stale save after a peer's change): the peer's value stands, nothing sent;
  - a racing save changing the grid: not taken, line, its shape arrives.
- **"option 2, seeding …":**
  - an unset board takes the file's layers, once;
  - a newcomer's different layers: the board's, with a line;
  - an unset key (grid) is seeded; a seed arriving through a racing save is seeded;
  - unknown keys stay local.
- **Kept, still passing:** "a file the bridge can't write keeps its old settings to itself", and the refusal tests
  (a refused seed is not resent).

**Mutation check:**

| Rule broken | Tests failing |
|---|---|
| file-side change sent (the cut undone) | 3 |
| no line | 2 |
| `written` removed (a peer's change taken for a file change) | 1 |
| no seeding | 3 |

The fifth mutation, "the merge takes their settings", failed nothing. It was equivalent to the rule, so that code was
removed (above).

### Live (the verifier's `settings.sh`, copied unchanged apart from paths; real drawh, real bridge)

| drawh activity | Peer settings changes | Undone | Bridge lines |
|---|---|---|---|
| adding shapes back to back, 60 s (268 saves) | 36 | **0** | 80 |
| one shape every 2 s, 90 s (42 saves) | 54 | **0** | 4 |

**The lines are the cost of "one loud line each time".** Every drawh save built before the peer's change carries the
old grid. That is byte for byte a real file-side change, so each is put back and said. Nothing is lost: the board
always wins. The line's wording says so ("a change made here, or an older copy of the file saved over it").

**For the manager:** if this is too noisy, say once per key and value, until the board's value changes. That costs
silence for a repeated identical change. Your call. I did not build it.

### Doc

- **`drawh-server.md`:** the settings section is rewritten. Settings are set on the board (the web app), not in the
  file, until protocol v1.1's compare-and-set (round 4). The summary row and the limits are updated (including the
  noise), and so are the counts.
- **herdr-draw's `CLAUDE.md` (in the patch):** says the same.

### Not verified

- `undo.sh` and the toggle probes were not rerun: by design they now end on the board's value, not the file's.
- The pane as the writer; link mode; Linux; a real server: as before.
- H1 was not rerun this round. `cli/files.js` is unchanged, and `sync()`'s write loop is back to its round-2 shape
  (no stamp writes).

## Option 2, fix (2026-11-11, after re-check 4: one narrow HIGH and one MEDIUM)

Both are fixed with contained changes to `settingsFrom()` and `sync()` in `cli/bridge.js`. Nothing else changed.
Not committed.

- **Patch re-cut:** 3,066 lines, 23 files, +2868 −3, sha256 `779198853abb22b4…`.
- **Gates:** `git apply --check` and apply are clean on a fresh clone of 5dfe352 (`hdv5`), and the tree is identical to
  the working clone. herdr-draw `bun test` there: **291 pass, 0 fail** (`test/plenary.test.js` has 33). The built mod
  is current.
- **herdr-draw untouched:** clean, HEAD 5dfe352, no stash, one worktree.
- **Plenary:** `bun test --path-ignore-patterns 'test/web/adapters/transport-ws*'`: **573 pass, 78 skipped, 0 fail**.
  The ignore pattern is the manager's: that untracked file is client's p6-edge work in progress, with 8 failures.
  - **An earlier run without the pattern:** 2 failures in other sessions' tests (`M1 … /health keeps answering`,
    `takeSignIn …`), while those sessions were editing `server/` and the tests. That run hung past 10 minutes and I
    stopped it.
  - **Plenary code:** none touched.

### HIGH (narrow): an out-of-range value was put back with no line

- **Fix:** for a key the board has set, "differs from the board's" is now judged before validity. An invalid value
  gets the same line, with the key marked "(not a valid value)", is counted as held, and is put back.
- **Test:** "option 2: a value the room would refuse, in a key the board has, is put back with the same line". It
  covers the verifier's four values: grid 2000, grid "20", a layer with opacity 150, a layer missing `locked`. Each
  gives one line naming the key with "(not a valid value)", held 1, the file put back, and nothing sent.
- **Not changed:** an invalid value in a key the board has never set stays in the file, unsent and unsaid. It is not
  overwritten, so nothing is lost.

### MEDIUM: the first peer change after a start printed the "change made here" line

- **Fix (contained):** a pass that finds nothing to write has found the file in step with the board, key for key. It
  now records the file's settings as `written`. Before the bridge's first write, a peer's change then reads as "not
  given to the file yet", as it does after a write. The restore from saved state still sets `written` from the saved
  confirmed settings.
- **Test:** "option 2: the first peer change after a start, before the bridge has written the file, prints nothing".
  It covers a fresh start (seeded, no write) and a restart from saved state: the peer's value reaches the file, with
  no line and held 0.

**Mutation check:** judging validity first again fails the first test. Not recording `written` on an in-step pass
fails the second.

**Not rerun:** the live `settings.sh`. Only `settingsFrom()`'s order and the in-step bookkeeping changed, and both
are in-process tested.

**Doc:** `drawh-server.md` counts updated; one sentence each on invalid values and on the first change after a start.
