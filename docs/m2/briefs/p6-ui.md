# Brief: p6-ui (phase-6 canvas UI, built from the verified mock)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md, docs/m2/PLAN.md (phases 6, 7), CLAUDE.md, PROTOCOL.md.

- **Your tab:** `worker p6-ui (client): canvas UI`. Manager: `manager client` (reads docs/m2/reports/p6-ui.md).
- **You own:** web/index.html, web/app.js, web/ui/** (any files under it), web/style.css, test/web/ui*.test.js,
  plus your report. Need another path? Ask your manager first.
- **Off limits (another worker's, p6-base):** web/paint.js, web/sync.js, web/dev.html, web/dev.js,
  test/web/paint*, test/web/sync*. Import paint.js and sync.js; never edit them. Need a change there? Write it in
  your report. Replica, Room and the codec (packages/protocol) are the engine track's: reach them only through
  web/sync.js.
- **Read only:** packages/core/, packages/protocol/, docs/m2/design/ (the verified mock: index.html, mock.css,
  mock.js, README.md, legend.html), ~/repos/herdr-draw.

## Goal (PLAN.md phase 6)

"Full canvas UI over core's Editor: every tool, style/layers panels, frames, timeline, Mermaid, library,
paste/drag pictures, export, dark mode, touch." Build it to look and behave like the verified mock
(docs/m2/design/). Where the mock says "new in web/", build it here. Where it says "needs protocol v1", leave a
stub behind an obvious seam (phase 7 fills it).

- Toolbar: every tool in core's `TOOLS`, plus tool lock (Q), with the mock's layout on desktop and phone.
- Side panel: core's `SECTIONS` via `applyPanel` (packages/core/panel.js), stack and tabs, the mock's styling.
- Frames navigation, Animate timeline (`animate`, `playToggle`), Mermaid import dialog (`importMermaid`), Library,
  paste and drag of pictures (`addFiles`/`addImage`), export (SVG and PNG writers, new in web/, from `exportScene`).
- Dark mode (theme passed to `displayList`/paint.js), touch layout at 390 px (sheets as in the mock).
- Role-aware chrome (presenter / annotator / viewer) from `welcome.role`; read-only greys the panel too, and
  every write path, including the phone "More" tools sheet (the mock left it live: p6-mockv round 2, MEDIUM).
  Viewers never show pending edits or reactions of their own (p6-mockv HIGH #1).
- Start from the mock's tokens (docs/m2/design/mock.css): its contrast was fixed to 4.5:1 for small text.

## Processes you start (OFFICE.md)

Never `pkill` or `killall`. Record the PID of every browser, static server or background process you start and
kill exactly that PID (or its child-process handle) when done. No hard-coded ports: ask the OS for a free one
(port 0) and read it back. Other sessions run headless Chrome and servers at the same time.

## sdd helpers (OFFICE.md "sdd helpers")

Load `sdd:subagent-driven-development` first. You may hand file-disjoint sub-tasks inside your paths (headless
tests, fixtures, the SVG/PNG export writers) to sdd harnesses in git worktrees; you review and own every line
before it lands. Check `usage`/quota before fanning out more than two jobs.

## Known design question

Annotations go to the `notes` stream; core's Editor edits one Doc. Decide (two Editors, board and notes, or one
Editor with op routing in sync.js's API), write the choice and why in your report, and if it needs a change in
sync.js, put that in your report instead of making it.

## Done when

- Two browsers edit together with every tool (through p6-base's in-process Room or BroadcastChannel transport
  until the phase-3 server exists).
- Tests in test/web/ui*.test.js for what can run headless (panel state, tool switching, export output, role gating).
- `bun test` passes. You drove it in a real browser at 1440 px and 390 px, light and dark, and saved screenshots
  in your scratchpad (not the repo).
- Report docs/m2/reports/p6-ui.md: files, tests, how you checked, what you did NOT verify, risks. Stop; don't commit.
