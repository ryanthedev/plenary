# Plenary design mock (M2 phases 6 and 7)

The static mock the CEO approves before any web/ code is written. Open it with `open docs/m2/design/index.html`.
No build step and no network requests: no web fonts, scripts or images are fetched. It uses system fonts only.

| File | What |
|---|---|
| `index.html`, `mock.css`, `mock.js` | The mock. Fake data: a board mid-meeting with two frames, shapes, arrows, an image, a Mermaid flowchart, notes and comments. |
| `legend.html` | What each source tag means, who can touch what (role matrix), connection pill states, what's left out on purpose. |
| `phone.html` | The mock in real 390 px iframes (desktop Chrome won't make a window that narrow). |
| `shoot.sh` | Retakes every screenshot in `shots/` with headless Chrome: `sh docs/m2/design/shoot.sh`. |
| `shots/` | 1440×900 and 390×844, light and dark, for each role, plus one shot per state below. |

## Reaching every state

Use the striped **MOCK** bar at the top (it is not part of the product), or URL parameters. Only known values are
accepted; anything else falls back to the default.

| Param | Values (default first) |
|---|---|
| `role` | presenter, annotator, viewer |
| `theme` | light, dark |
| `conn` | connected, reconnecting, offline, readonly |
| `panel` | stack, tabs, closed (`tab=` properties, arrange, frames, animate, layers, library) |
| `open` | (none), thread, point, resolved, emote, mermaid, export |
| `drawer` | (none; notes for annotators), notes, comments |
| `sheet` (phone) | (none), panel, tools, notes, comments |
| `src` | 1 = draw a source tag on every surface |

Source tags:

- **core:** API names from `packages/core`.
- **v0:** PROTOCOL.md as committed.
- **v1:** needs protocol v1 (phase 1). Names follow the v1 draft now in PROTOCOL.md, which the CEO has not reviewed yet.
- **new:** new in the web/ client.

## Checklist: every surface in the brief

### Canvas UI (phase 6)

| Surface | Where in the mock | Source |
|---|---|---|
| Toolbar: Select V, Hand H, Rectangle R, Diamond D, Ellipse O, Arrow A, Line L, Pen P, Text T, Eraser E, Frame F, Laser K | Top bar, presenter (`?role=presenter`). Icons, names and keys copied from `TOOLS` | core `TOOLS` (editor.js) |
| Tool lock (Q) | 🔓 Q after the tools | core `toolLock`, key `q` |
| Image | ⊡ after the tools (presenter, annotator) | core `addImage` / `addFiles` / paste. Bytes go up through v1 Blobs (signed URLs); v0 has no upload |
| Notes | ❏ tool; sticky notes under the frames | v0 `notes` stream. The note tool is new in web/ |
| Highlighter | ▰ tool (on for annotators); yellow stroke over "+18%" | new in web/: a wide, translucent `freedraw` in `notes` (v1 draft "How each tool travels") |
| Side panel: Properties (stroke/fill from `STROKES`/`FILLS`, width thin/bold/extra = `WIDTHS` 1/2/4, `STYLES`, sketch = roughness 0/1/2, opacity 100/75/50/25, fill style, edges = roundness, font hand/sans/mono, text 16/20/28/36, arrow sharp/curve/elbow, arrowheads) | Right panel, presenter | core `setStyle`, `STROKES`, `FILLS`, `WIDTHS`, `STYLES`, `FONT_FAMILY`, `elbowed` |
| Arrange | Panel, second section | core `align`, `distribute`, `reorder`, `group`/`ungroup`, `cloneSelection`, `toggleLock`, `rotateBy`, `resetRotation` |
| Frames (section and on canvas) | Panel section, and frames "1 · Q4 at a glance" and "2 · Launch flow" on the canvas. ‹ 1/2 › bottom left | core `frames`, `goToFrame`, `stepFrame` (PgUp/PgDn) |
| Animate: presets and play | Panel section (`PRESET_NAMES`: fade rise slide pop draw pulse out, plus none) and the timeline bar (▶ ■, track, "0.8s / 2.4s") | core `animate`, `clearAnimation`, `playToggle`, `stopPlay`, `time`, `duration` (read only) |
| Layers | Panel section | core `addLayer`, `moveLayer`, `updateLayer`, `moveToLayer`, `deleteLayer` |
| Library | Panel section: items, "+ save selection" | core `libraryItem`, `insertLibraryItem`; library.js `.excalidrawlib` |
| Stack and tabs modes | Panel header ▤ / ▭, `?panel=tabs&tab=animate` | core panel.js `MODES`, `applyPanel` |
| Mermaid import | ◇→ in the top bar, `?open=mermaid`; the "Launch flow" frame is an import | core `importMermaid`, `isMermaid` (flowcharts only) |
| Export PNG/SVG | ⤓ in the top bar, `?open=export` | core `exportScene` (what to paint, cropped). Writing SVG and PNG is new in web/: core has no SVG writer (`toSvg` lives in herdr-draw's adapters/svg) and export.js says rasterizing is the adapter's job |
| Zoom / fit | Bottom left: − % + ⤢ | core `zoomAt`, `fit` (⇧1) |
| Undo / redo | ↶ ↷ in the top bar (phone: bottom left) | core `undo`, `redo` |
| Dark mode | ☾/☀ in the top bar, `?theme=dark` | core export.js `DARK`/`LIGHT` page and ink colors |
| Touch layout (390 px) | `phone.html`: a bottom dock per role (presenter: 4 tools, More, Style, Notes, Comments; annotator: 4 tools, More, Style, Notes; viewer: Prev, Fit, Next, Notes, Comments), "More" tools sheet, "Style" panel sheet, notes/comments sheets, emote button, and avatars collapsed to two plus a count | new in web/ |

### Collaboration (phase 7)

| Surface | Where in the mock | Source |
|---|---|---|
| Live cursors with names | Maya, Dev K. (presenters); Priya, Tom, Sam (annotators; viewers don't see them) | v1 presence `cursor` |
| Avatar row and viewer count | Top bar: 5 avatars, "+37", "👁 12,408 watching" | v1 `here` (`writers`, `viewers` count) |
| Others' selections | Dashed teal box "Dev K. selected" on "Review?" | v1 presence `select` |
| Laser trail | Red fading trail around "3 new regions", "Maya · laser" | core `laser` tool; v1 presence `laser` to share it |
| Draw (others drawing live) | "Maya · drawing" red stroke in frame 2 | v0 `transient` op; v1 draft `preview` presence |
| Highlighter | See canvas UI above | new in web/ + notes |
| Emotes | Floating 👏🎉🔥, bottom emote bar (first six of one fixed set of eight), ✨ more (`?open=emote`). Viewers can send too. Disabled when not connected | v1 presence `emote` / `emotes` counts |
| Reactions | On comments: chips under each message in a thread (`?open=thread`) | v1 `records` `react` (v1 draft: reactions are on comments only) |
| Comment thread on an element | Pin "3" on "Ship", `?open=thread` (replies, Resolve, reply box) | v1 `records` `thread`/`reply`/`resolve`, element anchor |
| Comment thread on a point | Pin "1" below the notes, `?open=point` | v1 `records`, `{ point }` anchor |
| Resolved state | Grey ✓ pin on "NPS", `?open=resolved` (Reopen); listed with "✓ resolved" in the Comments drawer | v1 `records` `resolve`/`reopen` |
| Annotations as a notes stream | Left drawer "Notes 214" (`?drawer=notes`; open by default for annotators): author, time, jump to, edit/delete only on one's own (🔒 on others' for annotators) | v0 `notes` stream and its ownership rule. Showing authors and 🔒 on the client needs the v1 snapshot's `noteAuthor` (v0 keeps authors in the room only) |
| Connection status pill: connected, reconnecting, offline, read-only | Top bar, `?conn=...`; banners explain reconnecting, offline and a read-only downgrade. Read-only disables every write control (tools, panel, Mermaid, export, note edit/delete, compose, reply) | new in web/ over v0 `welcome.role`, rule 2, `Replica.pending` |

### The three roles

| Role | `?role=` | What differs |
|---|---|---|
| Presenter | presenter | Every tool, the full side panel, timeline, Mermaid, export, any note editable |
| Annotator | annotator | Note, highlighter and image on the notes stream, plus pen, arrow, text and eraser there too (**beyond the v1 draft**, which lists only sticky notes, highlighter strokes, pins and pictures in `notes`: open question). Properties applies to their own note only. Others' notes are locked. The notes drawer is open |
| Viewer | viewer | Hand, zoom, fit and frames only. Reads notes and comments. Sends emotes. Never has pending edits: losing the connection only pauses the live view. Sees presenters' cursors and laser. Pill shows "View only" |
