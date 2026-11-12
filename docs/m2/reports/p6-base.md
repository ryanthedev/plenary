# Report: p6-base (canvas + sync core)

## Fix round 1 (2026-11-11): all 3 HIGH, 5 MEDIUM and 8 LOW from p6-basev fixed

`bun test`: **261 pass, 0 fail** on the last full run (test/web/: 57 sync, 13 paint, plus p6-ui's tests, which still pass).
One earlier full run had 1 failure outside my paths: test/server/main.test.js "kill -9 mid-stream…" timed out after 25 s.
It doesn't import web/, passed 5 of 5 run alone, and passed on the next full run, so it looks timing-sensitive under load.
Flagged for the engine track.
Nothing is committed. The original report follows this section.

### API changes to `web/sync.js` (for p6-ui, t160)

`bindEditor`'s signature, its options and the status names (`connecting`, `catching-up`, `live`, `refused`)
are unchanged. `status`, `resets`, `state()`, `reconnect()`, `editorState` and `streamState` are unchanged.

| Change | Before | Now |
|---|---|---|
| **Removed** | `handle.replica` | gone (M5). Use `handle.role` (the welcome role or null) and `handle.peek(id)` (a clone of the room-ordered copy, or null). web/ui/ does not use `.replica` today (grep). |
| Changed meaning | `handle.pending` | unacked ops **plus** ops held until caught up |
| New, handle | | `cancelGesture()` (for pointercancel), `close()`, `full()` (every byId entry), `diff()` (strict Editor vs Replica; `[]` when equal) |
| New, options | | `timeoutMs` (default 10 000; 0 = off), `timers` ({ set, clear }, for tests) |
| New, exports | | `fullState(doc)`, `docDiff(docA, docB)`, `seeded(seed)` |
| New, localRoom | | `seed` option (default 1: delivery order is repeatable), `full(stream)`, transport `lose()` |
| Behaviour | | sync.js wraps the Editor instance's `pointerDown`, `pointerUp`, `key` and `setTool` to reconcile after a gesture ends. Callers keep calling them as before. Core is untouched. |

### What changed, per finding

| # | Fix | Proof (test in test/web/sync.test.js unless noted) |
|---|---|---|
| **H1** | Ops made while not live are **held unstepped** and stay out of the Replica. Once caught up, each is stepped against the caught-up Replica, given to `replica.local`, the Editor is loaded, and then they are sent. Version stepping happens only while live, in one function, `stepVersions`, which is easy to drop when Phase 2's `Replica.local` sets versions. | "GATE (verifier H1)…", 4 seeds: the logged version is above the room's, and the edit survives in the room, both Editors and the Replica. The verifier's T1 now gives logged v6 and x 564 everywhere (was v1, dead). |
| **H2** | The ids a gesture changed only by preview are tracked. When `editor.g` goes null without committing them, they return to the Replica's copy; an id the Replica never had leaves the Editor, tombstone included. While a gesture is still open, the Editor may run ahead (it is the user's live drag). | "every gesture × every ending (7 × 8)": 56 seeded combinations, all strictly equal once ended, and a peer's later nudge lands. It has 6 of the verifier's 7 endings plus pointercancel and a second pointer. The 7th, "no up at all", is its own test: for all 7 gesture kinds the gesture is still open with the Editor ahead, and a release or a next press gives an empty `diff()` and the peer's nudge lands. **So the verifier's b.test.js still prints those 6 rows as not ok: they are measured with the gesture still open.** Also "while a gesture is open…" (their T6b, ended by the release). |
| **H3** | The gate is strict: `handle.diff()` compares every byId entry (tombstones, version, versionNonce, content) plus appState, and `full()` is also compared with the room. | 24 gate tests: {entries, snapshot} × {unknown setting, bad setting value, viewer's create (element op), viewer's move of an existing shape (element op)} × 3 seeds, on a board with edited (v > 4) and deleted elements. Plus refusal with an open gesture **and** an open text edit, the H1 resync-window edit, and a notes-stream element refusal. |
| M1 | The hello goes alone; unacked ops are resent after `welcome`; never-sent ops wait for catch-up. | "rule 2: the hello goes alone…" (a scripted transport checks the send order) |
| M2 | A reload keeps the open gesture, the text edit and undo history. It prunes only history steps that would recreate an element the room never had. | GATE "…gesture and a text edit are open keeps both". Also "a refusal lands mid-gesture, for every gesture kind, ended at once or after more moves" (14 cases, strict), and "a viewer drags its own refused shape while the refusal lands" (no throw, strict). |
| M3 | Watchdog: anything outstanding (no welcome, catch-up unfinished, an op unacked) with no message for `timeoutMs` restarts on a fresh connection. No timer runs when nothing is outstanding. | "a lost welcome…" and "a lost ack and entry…" (fake timers; logged once) |
| M4 | dev.js wires `pointercancel` to `sync.cancelGesture()`, never to `pointerUp`. | "pointercancel mid-create sends nothing and leaves no element or tombstone" |
| M5 | `.replica` removed; `role` and `peek` added (read-only clones). | "the handle never exposes the Replica…" |
| Found this round | Two more bugs, from the extra checks: (1) a late `ack` could leave the Editor showing an own settings patch over a peer's later one (grid 10 instead of 20). Settings are now copied from the Replica whenever they differ, by replacing rather than merging. (2) `cancelGesture()` mid-erase left the pending erase set. | "settings: own patch unacked across a reconnect…" and "cancelGesture mid-erase…". Each fails when its fix is removed (34 and 1 tests). |
| L1 | Fixed by H2 (abandoned creates leave no Editor-only tombstone). | "bare clicks with every shape tool…" (strict) |
| L2 | dev.js calls `editor.tick()` while `needsTick()`. | Browser: 16 laser points to 0 after 1.3 s; the room logged nothing |
| L3 | Font faces are looked up by own key only. | paint.test.js "own key only" |
| L4 | SVG data URLs are no longer decoded for the canvas (taint risk for PNG export). | paint.test.js |
| L5 | dev.js converts wheel lines/pages to pixels and clamps ctrl/cmd+wheel zoom steps to ±50 per event. | Not measured in the browser |
| L6 | A stroke with width ≤ 0 is skipped. | paint.test.js |
| L7 | This report's count fixed (143 was right then; 245 now). | n/a |
| L8 | `localRoom` delivers from a seeded random by default (`seed`); every test seeds its network, and the gate loops over seeds. | n/a |

### How I checked

- **Mutation run:** I broke each fix in a scratch copy of sync.js and ran test/web/; every mutation fails at least one test.

  | Mutation | Failing tests |
  |---|---|
  | H1 (step while not live) | 5 |
  | H2 (no reconcile) | 4 |
  | m8 (reload drops tombstones) | 21 |
  | m7 (reload drops tombstones and resets versions) | 21 |
  | M2 (reload clears gesture and text) | 1 |
  | M1 (ops sent with the hello) | 1 |
  | M3 (no watchdog) | 2 |
  | Dedupe removed | 1 |
  | Undo history not pruned | 1 (it survived at first; I tightened that test to assert no extra resync) |
  | feed skips appState (now: settings copy skipped) | 33 (34) |
  | cancelGesture keeps the erase set | 1 |

- **The verifier's repros**, run from a copy in my scratchpad (its `strictDiff` swapped for `handle.diff()`, and `.replica.getAny` for `peek`):
  - **Fixed:** T1, T2, T5, T7 (text survives), C2 and C4 are now strictly equal.
  - **Hold:** T6 and T8–T11; C3 is 0/300 failing for both T8 and T10; the normal-endings fuzz has 0 mismatches.
  - **Still differ while open:** T3, T4, T6b and the six "no up at all" rows differ only **while the gesture is still open**. My tests above show they reconcile on release.
- **Real browser:** headless Chrome over CDP; `drive.js` serves the repo on port 0 and starts Chrome with `--remote-debugging-port=0`, then kills its own child PID and checks that it is gone.
  - All tools drawn in both panes, and the double-click label works.
  - **Escape mid-drag, then release:** both panes have empty `diff()`, and a peer's nudge reaches both (y 60 in each). `full()` equals the room's.
  - **Laser:** fades to 0 points; room seq unchanged by it.

### Still not done or not verified

- **An open gesture shows the user's own drag:** a peer's edit to the dragged element shows only after the release. This is by design: H2 is about gestures that *ended* without a commit.
- **Escape mid-drag does not cancel the drag in core:** core keeps `editor.g` until the release. Cancelling on Escape is a core change (herdr-draw, CEO's OK).
- **sync.js now writes into the Editor's Doc** in two places: `stepVersions` (version) and `reconcile` (it replaces or deletes entries). It also wraps four Editor methods on the instance. The clean fix is in core: `livePut` shouldn't bump stored versions, and a gesture needs a cancel. Proposed for herdr-draw with the CEO's OK.
- **Not tried in any browser:** touch, pen, pointercancel and the L5 wheel change.
- **Phase 2:** when `Replica.local` sets versions, drop `stepVersions` and its two call sites (`onOp`, `catchUp`).

## Original report

**Done.** The painter, the Editor–Replica binding and a two-pane dev page are built. The phase-6 gate passes:
a refused op followed by a resync leaves Editor == Replica, whether catch-up comes as entries or as a snapshot.
`bun test`: 143 pass, 0 fail (26 of them new, in test/web/). Nothing is committed.

**Seam bug found and worked around:** core's Editor raises an element's version on every pointer move, so
any drag longer than about 1000 moves is refused by the room, and the whole board resyncs. Details under Risks.

## Files (all new, all inside the narrowed ownership list)

| File | What it is |
|---|---|
| `web/paint.js` | `paint(ctx, items, view)`: display list to Canvas2D. Handles stroked paths (M/L/Q, width, dash, opacity), filled paths, text (font class, multi-line, label centred in its box, rotation about cx/cy, `reveal` typewriter) and images (through `view.image(fileId)`). Also handles dpr and the theme background. Colors pass a hex check. Also exports `THEMES` (equal to core's LIGHT/DARK) and `imageCache` (decodes only safe data URLs, once). |
| `web/sync.js` | `bindEditor(editor, { transport, token, board, client, stream })`. **The only file that calls Replica, Room, ports or the codec.** Also exports `localRoom()` (an in-process reference Room with queued, codec round-tripped links; manual `step`/`settle`, or `auto` on a microtask), plus `streamState` and `editorState` (one definition of "Editor == Replica"). |
| `web/dev.html`, `web/dev.js` | Two side-by-side canvases, users ada (owner) and bo (editor), one in-process Room. Pointer, wheel and key events go to the Editor (GPUI key names; `cmd` = meta). A textarea for the text tool is placed from `editor.textBox()`. Bare tool picker from `TOOLS`, light/dark toggle, status per pane (`live`, pending count), room seq. |
| `test/web/paint.test.js` | 10 tests |
| `test/web/sync.test.js` | 16 tests |

## How sync.js works

- **Outgoing ops:**
  - `files` are stripped, and a files-only op is dropped, because the room refuses `no-files`.
  - Each element goes out at the Replica's version + 1, and the Editor's own copy is set to the same version (see Risks).
  - **One copy per element id, the last.** Core's `Editor.commit` can list a bound arrow twice in one op (its edit, then `settleArrows`' re-route one version up). Once versions are stepped, both copies would share a version and a random nonce would pick the winner, so the room could keep a different copy from the Editor. Found by a new test; sync.js now keeps the last copy, which is the one the Editor holds.
  - Transient ops (live drags) are relayed only while `live`.
- **Incoming messages:** after each `replica.receive`, the Replica's copies of the ids in applied entries are pushed into the Editor through `editor.receive`. These are copied from the Replica, never from the message, so seq order and gap buffering stay the Replica's job. Shown appState is copied when an entry carried appState.
- **Refused op (rule 5):**
  - The Replica resets, and the transport reopens with a since-0 hello.
  - Once `applied >= welcome.seq`, the Editor is loaded from a clone of the Replica. Pictures are kept, and the gesture, text edit and undo/redo history are cleared.
  - The first connect takes the same path.
- **Rule 2 (v1 draft):** ops made before `welcome` or during catch-up are held, then sent once caught up.
- **Transport port:** `{ send, onMessage, reopen? }`. A WebSocket version only has to wrap the codec, which is a few lines once the phase-3 server exists.

## Tests added

- **The gate**, twice: catch-up by entries and catch-up by snapshot (after `compact()`).
  - Setup: an editor's valid create is still unacked when `editor.setAppState({ bogus: 1 })` is refused as `bad-op`.
  - Checks: the bogus key is gone, the valid op survives, and Editor == Replica == room for both peers.
- **A refused op is undone in the Editor:** a viewer draws, the shape disappears, history is cleared, and undo sends nothing.
- **Convergence** of two Editors through the Room, 5 seeds × 60 rounds:
  - Every element-making tool in `TOOLS`: rectangle, diamond, ellipse, arrow, line, freedraw, text, frame.
  - Also nudge, delete, undo, eraser and grid changes.
  - Deliveries interleave at random with the edits, and no peer ever resyncs.
- **Multi-element pointer gestures:** a labelled rectangle with an arrow bound to it gets a pointer move of 1200 moves, a resize handle and a rotate handle of 1100 moves each, then a bare click with each shape tool.
  - Checks: core did list an element twice (asserted), no logged entry carries a duplicate id, no resync, the binding survives on the peer, and Editor == Replica == room including versions.
- **Long drag:** a 1500-move freedraw and a 1500-move drag are acked, and the version stays under 10.
- **Pictures:** never in a logged op, still in the Editor after a resync, and the peer sees the image element.
- **Ordering and connection cases:** ops made before welcome are sent after catch-up; a dropped link resends and the room dedupes; a refused token gives status `refused` and sends nothing.
- **Painter:** the ctx calls per item kind, including Q as `quadraticCurveTo(cx, cy, x, y)`, dash reset, closePath+fill, text baselines, rotation save/restore, reveal, image on/off, dpr, untrusted colors, and a full Editor display list in both themes.

## How I checked

- **`bun test`:** the full suite, 143 pass.
- **Mutation checks (do the tests bite?):** I removed each guard in sync.js one at a time and confirmed the matching test fails:
  - the version step
  - the reload on catch-up
  - the files strip
  - the undo-history clear
  - the duplicate-id dedupe
- **Real browser:** Chrome headless 157, driven over CDP with real mouse and key events (the Chrome extension wasn't connected).
  - Driver script (not in the repo; outside my paths): `/private/tmp/claude-501/-Users-r-repos-plenary/75dda93a-19b7-40eb-8aa6-c498b02dde8f/scratchpad/drive.js`.
  - It serves the repo on port 0 inside its own process, starts Chrome with `--remote-debugging-port=0` in a fresh scratch profile, and kills only that child.
  - Pane ada drew a rectangle, an ellipse and a 1200-move freehand stroke. Pane bo drew an arrow and a diamond, and typed "hello from bo".
  - **Double-click (second run):** `pointerdown` reports `detail` 0 in Chrome, so double-click never reached the Editor. dev.js now counts clicks itself: a press at the same spot (under 6 px) within 400 ms. After the fix, a double-click on the rectangle opened the label editor, and the typed label reached both panes.
  - Result: both panes `live`, 0 pending, no resyncs, Editor == Replica == room, room seq 6. Screenshots in light and dark look right: the same board in both panes, hand-drawn strokes, arrowhead, text, selection handles.
- **Process cleanup (after the owner's instruction):** I stopped my leftover Chrome (PID 58635 and its 6 helpers) by PID, after checking that each one ran under my scratch profile. PID 44281 on the same port belonged to another session, and I left it alone. The static server was stopped too.

## What I did NOT verify

- **Hand drawing:** I did not draw by hand in a visible browser window. All browser input was synthetic CDP events in headless Chrome.
- **Untested paths:**
  - resize and rotate handles by real browser input (covered headless only, in sync.test.js)
  - wheel and pinch zoom
  - space-drag pan
  - the eraser and laser in the browser
  - touch and pen input
  - hi-dpi on a real display (dpr 2 emulated only)
  - pictures in the browser (no paste or drop path on the dev page)
- **WebSocket transport:** not tested, because no server exists yet. Only the in-process Room was used.
- **Peers' live previews:** not shown. The Replica keeps `previews`, but the painter never draws them (phase 7, presence).
- **The notes stream:** `stream` is a parameter, but only `board` is tested.

## Risks

1. **Version jump (core and protocol):**
   - **Cause:** `Editor.livePut` sets `version = current + 1` on every move, so a 1500-move drag ends at version 1502 (measured), and `Room.op` refuses a jump over `MAX_VERSION_JUMP` (1000).
   - **Effect without the workaround:** every long stroke, about 8 s at 120 Hz, is refused and resyncs the board.
   - **The workaround (sync.js):** it writes the Editor's stored version in place, which is a reach into core's state.
   - **Proper fix:** in core, `livePut` should count from the version at gesture start. Alternatively, the protocol should not count transient bumps.
2. **Pictures don't reach peers.** The blob port isn't built, so the other Editor shows the dashed placeholder box.
3. **A resync flickers.** `Replica.reset()` drops the pending ops' optimistic copies until the room echoes them, so for one round trip the Editor shows the room's state without them.
4. **Edits during a resync are lost visually:** until catch-up ends, the Editor keeps showing its old state, then snaps to the Replica.
5. **The dev page puts both Editors in one JS realm** and polls with rAF. That is fine for a dev page and not a performance measure.
6. **sync.js reads Replica internals:** `streams`, `applied`, `pending`, `resync`, and the shape of entries messages. A v1 change to the Replica touches only this file, as the seam requires.

## Housekeeping

- **Engram:** down for this whole session (name resolver error, retried twice). The lesson worth storing once it is back: core's `livePut` raises the version per pointer move, so drags over 1000 moves are refused by the room (measured 1502 and 3001). Workaround: step versions in web/sync.js.
- **Tab:** I could not rename my own tab to `done p6-base`; please do it from your side.
- **Ownership:** I re-read "You own" after the brief was narrowed. Every file I wrote is on that list, plus this report. The driver script lives in my scratchpad.

## Protocol changes I'd want (written down, not made)

- **Replica:** `receive()` should return what it applied (ids per stream, and whether appState changed), so bindings don't re-derive it from entries.
- **Replica:** `reset()` should keep showing pending ops (re-apply their elements) so a refusal doesn't flicker (Risk 3).
- **Version-jump rule:** either the room measures the jump against the sender's last logged version (not counting transients), or PROTOCOL.md says clients must send at most +1 per committed op. Core's `livePut` needs the matching fix in herdr-draw, which needs the CEO's OK.
- **Rule 5:** state whether a since-0 resync may reuse the connection (send hello again) or must open a new one. sync.js uses `transport.reopen()` when the transport offers it.
