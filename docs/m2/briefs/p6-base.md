# Brief: p6-base (phase-6 foundation, no UI chrome)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md, docs/m2/PLAN.md (phase 6), CLAUDE.md, PROTOCOL.md first.

- **Your tab:** `worker p6-base: canvas + sync core`. Manager: `manager client` (reads docs/m2/reports/p6-base.md).
- **You own exactly these paths** (the UI chrome job will own the rest of web/, incl. web/index.html and web/ui/):
  web/paint.js, web/sync.js, web/dev.html, web/dev.js, test/web/paint*.test.js, test/web/sync*.test.js, plus
  your report. Need another file? Ask your manager first.
- **Seam:** Replica and the codec are the engine track's (packages/protocol) and will change for v1. Use them
  read-only; every call into Replica/Room/codec lives in web/sync.js alone, so a v1 change touches one file.
- **Read only:** packages/core/, packages/protocol/, ~/repos/herdr-draw (its adapters/ show how core's display list
  is painted; never edit it). docs/m2/design/ is another worker's, being built now: don't touch it.

## Why this job, now

Phase 6 is "full canvas UI over core's Editor". The look (toolbar, panels, collab surfaces) waits for the design
mock to pass verification. The parts under the look don't depend on it, so build them now:

1. **Canvas2D painter** (web/paint.js): paints core's display list (`editor.displayList(theme)`, packages/core/
   render.js) to a `CanvasRenderingContext2D`, every item kind core emits (path, text, image, and whatever else
   render.js produces), light and dark theme, devicePixelRatio. Pure function of (ctx, items, view); testable
   with a recording fake ctx.
2. **Editor–Replica binding** (web/sync.js): Editor `onOp` goes to `replica.local(...)`; messages from the room go
   to `replica.receive(...)` and the result into the Editor; on a refused op (PROTOCOL.md rule 5) and on resync
   (snapshot), the Editor's scene is reset to the Replica's state. Transport is a port (send / onMessage) so the
   same code runs over the in-process reference `Room` today and a WebSocket once the phase-3 server exists.
3. **Minimal dev page** (web/dev.html + web/dev.js, not index.html): a full-window canvas with pointer, wheel and key events wired
   to the Editor (`pointerDown/Move/Up`, `wheel`, `key`), two Editors syncing through an in-process `Room` in two
   side-by-side canvases (or two tabs via BroadcastChannel) so it can be tried by hand. No toolbar or panel beyond
   a bare tool picker from `TOOLS`; the real chrome comes after the mock.

Plain JS + JSDoc, ES modules, no build step, imported straight from packages/ by relative path.

## Done when

- Headless test (PLAN.md phase-6 gate): **refused op + resync leaves Editor == Replica** (test/web/).
- Tests: painter emits the right ctx calls per item kind; two Editors through a `Room` converge after
  interleaved edits with every tool in `TOOLS` that makes elements; a refused op is undone in the Editor.
- `bun test` passes. You opened web/dev.html in a browser (any local static server) and drew with two canvases.
- Report docs/m2/reports/p6-base.md: files, tests, how you checked, what you did NOT verify, risks, and any
  protocol change you'd want (write it, don't make it). Then stop and leave the session idle. Don't commit.
