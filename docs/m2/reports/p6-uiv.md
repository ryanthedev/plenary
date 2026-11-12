**PASS** (no HIGH; one MEDIUM, M1: a draft typed when the connection drops is lost; four LOW)

# Report: p6-uiv (verify the phase-6 canvas UI)

Verifier: `verifier p6-uiv (client): canvas UI`. Read only outside this file. Nothing committed.

The phase-6 client holds up under attack:

- **No forbidden writes:** no role wrote what it can't, by headless probe or in a real browser.
- **Ownership:** no annotator changed another person's note or the board.
- **No HTML injection:** no board, library or URL data reached the DOM as HTML.
- **Convergence:** five tabs converged with Editor == Replica in each one.

## How I checked

| Check | How | Result |
|---|---|---|
| `bun test` | Repo root | 263 pass, 0 fail |
| Viewer, commenter, and presenter and annotator downgraded to viewer (headless) | Scratch probe (`scratchpad/probes/attack.test.js`). Each pressed 58 keys × 8 modifier sets, used every tool (drag plus double-click), clicked every panel button (a fake `h` collecting every `onclick` from `renderPanel`), and tried Mermaid paste, text paste, cut, `placeNote`, `addPicture` and tool lock. | 0 ops on either stream, 0 errors, 0 `blocked` |
| Annotator di against annotator cy's note and the board (headless) | Op counter counts every op message, transient previews included. Same keys, with and without select-all. All 31 panel buttons, plus alt-drag, eraser, text, arrow, pen and highlighter across cy's note, marquee + Delete, and 30 undos and 30 redos. | 172 notes ops sent (21 transient): 0 touch cy's ids, 0 board ops, 0 appState, 0 errors, 0 `blocked`. cy's note is unchanged, the board is unchanged, and Editor == room for all three people. |
| Downgrade with a text box open | Presenter mid-typing; reconnect welcome says viewer; then types, Cmd+Enter and commit | 0 sent, 0 errors. The backstop caught it (`blocked` 1). Editor == room. |
| Offline with a text box open | `online = false` mid-typing, then commit, then back online | The draft is dropped: `blocked` 1, 0 pending, no text in the Editor or the room (M1) |
| Hostile peer op (browser) | A second sync.js binding in ada's tab sent crafted elements one op each, skipping all UI normalising: frame `name`, text, `fontFamily`, `fontSize` and `strokeColor` with `<script>` and quote breakouts, `backgroundColor: url(javascript:…)`, `link: javascript:…`, object-typed `text`, a 3 MB text | Every element but the 3 MB one landed, and the room refused that one (envelope `MAX_OP_CHARS` 1 MB, `packages/protocol/envelope.js:11`). In presenter, annotator and viewer tabs: the frame name shows as plain text in the presenter's Frames panel, and note text in every drawer (`textContent` contains them), 0 `<img>`/injected `<script>`, no `style` attribute with script, `__pwn` unset, no console errors. The SVG parses clean with no script or `javascript:` attribute. |
| Read-only chrome (browser) | Forced the downgrade (`S.roleSeen = "viewer"`) on a presenter and an annotator, 1440 and 390 px | Enabled controls: Hand only among the tools. Panel: only layout buttons (stack, tabs, fold, reset) and play. Drawer: tabs, close, jump to; no compose or edit. Phone More sheet: Hand, Export, Dark (presenter) or Hand, Dark (annotator). Banner: Read-only. |
| Mock checklist (docs/m2/design/README.md, "Canvas UI (phase 6)") | Walked each row against web/ and the shots | Every phase-6 surface is present and wired (each tool, lock, image, note, highlighter, the six panel sections, stack/tabs, Mermaid, export, zoom/fit, undo/redo, dark, the phone dock per role, More, Style and Notes sheets). Avatars collapsed to two plus a count is phase 7 (stub). |
| Real browser, 5 tabs (headless Chrome via CDP, SharedWorker room) | ada and bo (presenters), cy (annotator), ed (viewer), fi (commenter). Real mouse and key events. | Below |
| SVG export from hostile data | `exportSvg` on the board above, parsed with DOMParser | Well-formed. No script, foreignObject or on* attributes; no `javascript:` in any attribute. |
| Screens against the mock | Took 1440×900 and 390×844 shots, light and dark, for presenter, annotator and viewer, plus the offline and read-only sheets. Viewed side by side with docs/m2/design/shots: desk presenter light, phone annotator light, phone viewer dark. The rest were taken, not viewed. | Layout matches. The differences are phase-7 stubs and one LOW (below). |
| Ensemble review | **Single harness** (codex only, per the brief), read only, in a scratch git copy | 1 LOW, confirmed (L1). It found no HTML sink, no playback write and no divergence. |

**Browser run in detail:**

- **ada (presenter):**
  - Drew by key with frame, rectangle, diamond, ellipse, arrow, line, pen, text and laser. The eraser was not
    driven in the browser (headless only), and I asserted no element types.
  - Added a note and a highlighter stroke.
  - Dropped a PNG and an `.excalidrawlib` in one drop.
  - Inserted the library item and inserted Mermaid through the dialog.
- **Hostile data:** board text, note text, a layer name and a library item name each held
  `<img src=x onerror=…>"'><script>…</script>javascript:alert(1)`, and the library element had `link: "javascript:…"`.
- **bo (presenter):** drew and dragged at the same time as ada.
- **cy (annotator):** made its own note, then attacked ada's note with drag, double-click + type, Cmd+A + Delete,
  Cmd+D, Cmd+Z, Cmd+Shift+Z, eraser and Text, and pressed R.
- **ed (viewer) and fi (commenter):**
  - Keys: R, P, T, N, M, Delete, Backspace, Enter, Escape and Q.
  - Shortcuts: Cmd+A, Cmd+D, Cmd+Z, Cmd+Shift+Z, Ctrl+Y, Cmd+G, Cmd+', Cmd+] and Cmd+Shift+L.
  - Also a drag, a double-click + type, a paste event (Mermaid text), a PNG drop, and a click on every enabled
    button in the top bar, panel, HUD and drawer.
- **Results:**
  - ed and fi sent 0 ops, with 0 `blocked`.
  - ada's note version and position were unchanged after cy's attacks. cy sent 5 ops, all its own.
  - All 5 tabs: same element ids, versions, positions and text on both streams, plus the same board appState.
  - Editor == Replica (`peek`) for every element in every tab. 0 pending, 0 console errors.
  - `window.__pwn` was undefined everywhere. The page holds 1 `<script>` and 0 `<img>`.
  - That the hostile layer and library names reached the panel as text is shown by `dom.js` (text nodes only),
    not asserted in this run. The hostile-peer run did assert it for frame names and text.
- **Phone, offline (`S.online = false`):**
  - Presenter More sheet: only Hand, Export and Dark are enabled.
  - Annotator More sheet: only Hand and Dark are enabled. Its panel sheet has no enabled control.

**Do the tests catch broken gating?**

- **Yes, mostly.** ui-session counts ops at the transport *and* asserts `blocked == 0`. A break in input
  gating that only the backstop catches would still fail the test.
- **Gap:** the tests never call `renderPanel`'s buttons. Panel gating rests on `S.act`, which the tests do cover
  (see L4).

**Processes:**

- Chrome was started with `--remote-debugging-port=0`, PID recorded in `scratchpad/pids` and killed in `finally`
  (confirmed gone).
- The static server ran in-process on port 0. No pattern kills.

## HIGH

None.

## MEDIUM

- **M1. A draft typed when the connection drops is lost** (`web/ui/session.js:88` `may()` checks `s.online`;
  backstop at `web/ui/session.js:61`).
  - Repro (`probes/offline.test.js`): a presenter has a text box open with "draft" when the browser fires
    `offline`. Committing the text (Esc, blur or Cmd+Enter) runs into the backstop: `blocked` 1, the Editor
    reloads, and the text is gone from the Editor, the pending queue and the room after reconnecting.
  - The same happens to a drag in progress.
  - Meanwhile the offline banner says unacknowledged edits "wait in this tab and send when you reconnect", and
    sync.js already holds ops made while not live.
  - Fix: let the open text box or gesture finish while offline (sync.js holds it), or gate only new gestures on
    `online`. The role check must stay in the backstop.
  - Not HIGH: no acknowledged op is lost, and no role writes what it can't.

## LOW

- **L1. Note ownership trusts localStorage** (`web/ui/session.js:93`, `web/app.js:39`).
  - An annotator who writes another person's note id into `plenary.mine.<board>.<user>` and reloads gets the
    note unlocked in the UI, and the client gate sends the edit.
  - The room refuses it (`packages/protocol/room.js:68`), so nothing persists. It is only self-tampering, and the
    builder already named it as a risk.
  - Fix: read v1 `noteAuthor` (the seam is in place) and stop trusting `mine` once that table exists.
  - Found by codex; I confirmed it by reading the code.
- **L2. A downgrade mid-typing drops the draft silently** (`web/ui/session.js:61`, the backstop). This is correct
  for a role change, because the room would refuse the write, but it gives no toast.
  - Probe: open a text box, get a viewer welcome, commit. The backstop drops the write correctly (`blocked` 1,
    nothing sent), but the typed text is gone with no toast.
  - The read-only banner does show.
- **L3. Gaps against the mock:**
  - In read-only, Export stays enabled (phone More sheet; the desktop ⤓ too). The mock's legend says read-only
    disables export. Export writes nothing, so this is cosmetic.
  - The Stroke and Fill rows have no custom-color "+" (the mock has one: desk-presenter-light).
  - Notes carry no author tag or 🔒 on the canvas (the mock: "Priya 🔒"). This is the v1 `noteAuthor` seam.
  - Avatars, viewer count, cursors, emote counts and comment threads are stubs, as phase 7 plans.
  - None of these claims a feature that isn't wired: the stubs are disabled and titled "phase 7".
- **L4. Test gap:**
  - `test/web/ui-*.test.js` never runs `renderPanel` controls under a viewer, annotator or read-only role.
  - My probe did, with 0 forbidden ops. A copy of that loop in ui-session would guard the panel against
    regressions.

**Notes, not findings:**

- **The role getter exists now:** `web/sync.js:200` exposes `role` on the bindEditor handle, so the builder's
  "wanted (b)" is there. Reading the role off its own transport wrapper still works, because Replica.reset clears
  the role, and session.js keeps the last one.
- **Frame names:** core has no frame-rename API, so the UI can't set one. A hostile peer can, and the
  hostile-peer run above covered that case.

## What I did NOT check

- **Two separate browser processes:** not possible today. The transport is one profile's SharedWorker, and no
  WebSocket transport is wired. The done-when allows the in-process room.
- **Real hardware input:** no phone, pinch, pen pressure, wheel or trackpad feel, or space-drag. All input was
  synthetic CDP mouse and keys. The 390 px runs used emulated metrics and touch emulation but dispatched no
  touch events.
- **Annotator paste and `addPicture`:** not probed. The viewer and read-only probes covered them.
- **Downloaded files:** I didn't open the downloaded SVG or PNG files, test PNG export with pictures, or paste an
  image from the system clipboard. I tested the SVG string, not the Download button.
- **Unclicked flows:** panel resize drag, layer rename through the double-click input (I renamed via
  `updateLayer`), and timeline playback with presets.
- **Read-only and Retry in a live browser:** headless only. The in-browser room has no downgrade.
- **Accessibility and frame rate:** no screen-reader or keyboard-only pass, and no frame-rate test on a big board.
- **Dark mode against the mock:** I took the dark shots and looked at the phone viewer only.

## Scratch (not the repo)

`/private/tmp/claude-501/-Users-r-repos-plenary/140e4ecd-fc42-490d-8993-321f960946db/scratchpad/`:

- `probes/attack.test.js`, `probes/midtext.test.js` and `probes/offline.test.js`: run with `bun test <path>` from the repo root.
- `drive.js` and `drive2.js`: the browser drivers (`drive2.js` is the hostile-peer and read-only run).
- `shots/`: the screenshots.
- `repo/`: codex's read-only copy.
