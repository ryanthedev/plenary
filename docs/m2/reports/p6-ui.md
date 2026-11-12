# Report: p6-ui (phase-6 canvas UI)

**Done.** `web/index.html` is the canvas client, built to the verified mock. Three browser tabs on one board edit
together with every tool: a presenter, an annotator and a viewer. Their copies are identical, and Editor == Replica
in each tab. `bun test`: 263 pass, 0 fail (16 new, in test/web/ui-session.test.js and test/web/ui-chrome.test.js). Nothing is committed.

Open it: serve the repo, then open `web/index.html?board=demo&as=ada` (ada/bo = presenter, cy/di = annotator,
ed = viewer, fi = commenter). Add `&theme=dark` for dark mode. Every tab of one browser on the same `board` shares a room.

## Design question: two Editors, one per stream

- **Choice:** one core Editor for `board` and one for `notes`, each bound by `bindEditor(..., { stream })`. They
  share one view, and their display lists are painted together, notes on top.
- **Why:** core's Editor edits one Doc, and each stream has its own settings (layers live in appState per stream).
  - One Editor would need sync.js to split ops by element and keep two appStates apart.
  - `bindEditor` already takes a stream, so two Editors need **no sync.js change**.
- **Cost today:** two links (two hellos) per person, because each `bindEditor` makes its own Replica.
- **Wanted in sync.js (not made):** a `bindEditors({ board, notes }, …)` that shares one Replica and one connection.
  The session's `join(stream)` is the only place that would change.
- **Routing:**
  - Presenters' board tools go to the board Editor; note and highlighter go to notes.
  - Presenters' Select hits notes first, because notes are drawn on top.
  - Annotators' tools all go to notes.
  - Viewers can only pan.

## Files (all new, all in my paths)

| File | What |
|---|---|
| `web/index.html`, `web/style.css` | Page shell. Styles are the mock's CSS and tokens (4.5:1 contrast fixes kept), minus the mock bar and source badges, plus the canvas, text box, toast and drop styles. |
| `web/app.js` | Glue: pointer, wheel, pinch and keys; the text box; clipboard events; drop and paste of pictures and `.excalidrawlib`; top bar, HUD, timeline (play, stop, scrub), notes drawer, Mermaid and export dialogs, phone dock and sheets, banners, pill, light/dark. Board text is set with `textContent` only. |
| `web/ui/session.js` | Headless core: two Editors, shared view, input routing, **the write chokepoint** (`act`, `setTool`, `key`), the onOp backstop, note ownership, sticky notes, highlighter, pictures. |
| `web/ui/roles.js` | Pure tables: role to chrome, tools per role, stream per tool, view-only keys, pill text. |
| `web/ui/panel.js` | Side panel over core `SECTIONS`, `panelSections` and `applyPanel` (stack and tabs, fold, reset, resize; state kept in localStorage). Sections: Properties (setStyle rows, arrow type, heads, bends), Arrange, Frames, Animate, Layers (inline rename), Library (localStorage, `.excalidrawlib`). Pure `propsModel` and `availableFor`. |
| `web/ui/export.js` | SVG writer ported from herdr-draw `adapters/svg/svg.js` with its sanitising, and PNG painted through paint.js. Both read `exportScene` of the **board doc only**. Page: board color or white. Scale 1× or 2×. |
| `web/ui/room-worker.js`, `web/ui/net.js`, `web/ui/dev-users.js` | Cross-tab transport: a SharedWorker hosts sync.js's `localRoom` per board, plus a stand-in Blobs relay for picture bytes. `?net=local` falls back to an in-page room. Dev tokens only. |
| `web/ui/dom.js` | A tiny element builder (textContent only). |
| `test/web/ui-session.test.js`, `test/web/ui-chrome.test.js` | 16 tests (below). |

## Role gating (brief items, p6-mockv HIGH #1, round-2 MEDIUM)

- **Role source:** the chrome follows `welcome.role`, read off the session's own transports. bindEditor's handle
  exposes no role, and per the manager I don't touch `.replica`.
  - Commenter maps to viewer on the canvas, following the v1 draft ("records only"), although v0's envelope still
    lets it write notes.
  - A lower role on a later welcome keeps the chrome but greys it (`readOnly`): tools, panel, More sheet,
    Mermaid, compose and note edit/delete.
- **Layer 1, input:**
  - `setTool`, `act`, `key` and paste all check role and connection.
  - Viewers get an allow-list of view keys, and Escape is swallowed (core's Escape switches to Select).
  - Clipboard keys are never forwarded, so paste runs once.
  - Grid and layer actions are presenter-only (`settings: true`).
  - The phone **More** sheet goes through `setTool` too, closing the round-2 MEDIUM.
- **Layer 2, backstop:**
  - A write that still reaches an Editor's `onOp` is dropped and counted (`blocked`), and the stream reloads.
  - A test proves this path; the browser run shows `blocked` stays 0.
- **Annotators' notes:**
  - v0 sends no `noteAuthor` to clients, so ownership is "ids I created", kept in localStorage per board and user.
  - SEAM: the v1 snapshot's `noteAuthor` is read off the transport when it arrives.
  - Others' notes can't be selected, erased or edited, and their arrows never bind, because binding would write the
    target's `boundElements`.
- **Viewers:** nothing is ever pending. The pill reads "View only" and never "edits waiting".

## Tests added (test/web/ui-*.test.js, all headless through the in-process Room)

- **Every tool converges:** a presenter uses every core tool plus note and highlighter, and a second presenter
  converges. The highlighter's style doesn't leak into the pen.
- **Viewer:** every tool, ~40 keys and modifier combos, paste (Mermaid and text), note, picture and layer actions.
  - Counted at the transport: 0 ops on either stream, 0 errors, 0 pending, resets unchanged, 0 blocked, tool
    still Hand. The view still pans, and the shared view stays in step.
- **Annotator:** no board tools. Drag, Delete, nudge, select-all + Delete, eraser and double-click on another
  person's note; grid; notes layer; board layer.
  - Result: 0 board ops, 0 errors, no resets, 0 blocked. The other note survives and its own note is deleted.
    All copies are equal.
- **Backstop:** a write slipped past the chrome is not sent, is counted, and the Editor is reloaded to match the room.
- **Annotator highlighter:** its style survives switching to the pen (caught a real bug: the pen style was
  re-applied to the still-selected highlighter stroke; the test fails with the fix removed).
- **Read-only downgrade:** a presenter whose reconnect welcome says viewer keeps the presenter chrome, greyed
  (`readOnly`). `setTool`, `act`, keys, drag, paste and note all refuse; 0 ops, 0 blocked, 0 pending.
- **Presenter Select on notes:** a presenter's Select moves an annotator's note; fit keeps both views equal.
- **Pure parts:** role tables, view-key allow-list, pill text, panel model and sections, library storage, SVG
  export (crop, scale, escaping, hostile colors and URLs, white vs dark page), and PNG size and paint calls.

## How I checked

- **`bun test`:** 254 pass.
- **Real browser:** headless Chrome over CDP with real mouse and key events. The driver is in the scratchpad,
  not the repo: `/private/tmp/claude-501/-Users-r-repos-plenary/b725d0e6-582b-4926-a188-1a5ffa7e5901/scratchpad/drive.js`.
  - Three tabs on one board via the SharedWorker: presenter ada, annotator cy, viewer ed.
  - Presenter: every tool, a label by double-click, a note, the highlighter, a dropped PNG, and Mermaid via the
    dialog. The laser was drawn by real input; I didn't check its trail visually.
  - Annotator: note, highlighter, pen and arrow, then attacks on the presenter's note.
  - Viewer: drew with keys r, p, t, n, m and Delete, plus cmd-A, Delete and cmd-Z.
  - Result in all three tabs: live, 0 pending, 0 blocked, Editor == Replica, identical board and notes across
    tabs. Board element types are all eight core types plus image, and the picture bytes reached every tab.
  - No console errors.
- **More checks in the same run:**
  - The Mermaid dialog's code box holds the sample (it was empty before a fix: `value` was set as an attribute).
  - Pause clicked with a real mouse mid-playback works; the chrome no longer rebuilds under a press.
  - At 390 px with touch events: tapping Pen in the dock picks it, a one-finger stroke draws, and More opens the sheet.
  - Offline (`may()` false), the More sheet leaves only Hand, Export and Dark enabled.
- **Screenshots (scratchpad `shots/`):** 1440×900 and 390×844 (CDP device metrics, because headless won't go
  under 500 px), light and dark, for each role.
  - Plus the Mermaid dialog, export dialog, tabs mode, and the phone tools, style and notes sheets.
- **Process cleanup:** the static server ran in-process on port 0. Chrome was started with `--remote-debugging-port=0`
  and its PID recorded.
  - It was killed by that PID in `finally`. Two runs ended early (a `timeout`, then my own watchdog), which skip
    `finally`; I stopped those Chromes by their recorded PIDs (91327; the later ones had already exited). No pattern
    kills; ps shows no Chrome on my scratch profiles.

## What I did NOT verify

- **Two separate browsers:** two different browser processes or machines were not tested. Cross-tab sharing is
  one browser profile's SharedWorker; the phase-3 server's WebSocket is not wired (see wanted changes).
- **Hand input:** no hand drawing in a visible window. All input was synthetic CDP mouse, key and touch events.
  - Untested: a real phone, pinch zoom (code path only), pen pressure, wheel/trackpad zoom feel and space-drag pan.
- **Unclicked flows:** the downloaded SVG/PNG file itself (writer covered by tests, Download button not clicked in
  the browser), PNG with pictures, `.excalidrawlib` drop, panel resize drag, layer rename, timeline playback with
  presets, image paste from the system clipboard.
- **Connection states:** the read-only downgrade and Retry were never reached live in a browser (headless test
  only). The in-browser room doesn't drop; offline was forced by setting `online = false`.
- **Accessibility and performance:** no screen reader or keyboard-only pass on the chrome, and no frame-rate test
  on a big board.

## Fixed after self-review

- Annotator highlighter lost its style on a tool switch (above).
- Mermaid code box was empty (`value` as an attribute).
- Chrome rebuilt every frame during playback, so a button could vanish under a click: now it waits for the press and
  refreshes a few times a second.
- Notes drawer swatch took raw element colors into CSS: now through paint.js's hex check.
- Annotators couldn't start a pen, highlighter or arrow over someone else's note: only Select and Text are blocked
  there now.
- Layers "⇢" with a note selected wrote a board layer id into notes: it is a board-only action now.

## Risks and wanted changes (for the manager; I changed none of these files)

- **sync.js:**
  - (a) `bindEditors` sharing one Replica and one connection for both streams.
  - (b) A `role` getter on the bindEditor handle; I read `welcome` off my own transport wrapper today.
  - (c) A WebSocket transport (the codec lives behind sync.js), so `web/ui/net.js` can talk to the phase-3 server.
- **Pictures:** sync.js strips `files`, so a picture's bytes reach other tabs only through the SharedWorker relay
  (a Blobs stand-in, 14 MB cap). With any other transport, peers see a dashed "picture (bytes not here yet)" box.
  v1 Blobs fills `net.put`.
- **Note ownership is client-side in v0:** clearing site data makes an annotator's own notes look locked to them.
  The room still enforces ownership. The v1 `noteAuthor` read is in place.
- **Phase 7 seams, stubs only:** emote bar (disabled), avatar row (only you), Comments tab (placeholder). The
  mock's cursors, selections, laser sharing and threads are not built.
- **Annotator arrows never bind to shapes,** their own notes included, to avoid writing others' `boundElements`.
- **Ownership list cap:** the per-board "mine" list is capped at 5,000 ids.
