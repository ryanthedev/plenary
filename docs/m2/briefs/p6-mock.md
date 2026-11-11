# Brief: p6-mock (phase-6 design mock)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md, docs/m2/PLAN.md (phases 6 and 7) and CLAUDE.md first.

- **Your tab:** `worker p6-mock: design mock`. Manager: `manager client` (reads docs/m2/reports/p6-mock.md).
- **You own:** docs/m2/design/ only, plus your report docs/m2/reports/p6-mock.md. Touch nothing else.
- **Read only:** packages/core/, packages/protocol/, PROTOCOL.md, ~/repos/herdr-draw (never edit it).

## Goal (CEO's words, PLAN.md phase 6)

"Full canvas UI over core's Editor ... Design mock first; CEO approves before building." The mock is what the
CEO approves, so it must show every surface below, honestly, before any web/ code exists.

Audience: an enterprise all-hands. A few **presenters** draw, thousands of **annotators** add notes and react,
100k **viewers** watch live. Show all three views and how they differ (what each can touch).

## What to build

A static HTML/CSS/JS mock in docs/m2/design/, opened with `open docs/m2/design/index.html`. No build step, no
network fetches except web fonts (and it must still look right if fonts fail). Fake data is fine; it should
look like a real board mid-meeting (a frame or two, shapes, arrows, a Mermaid diagram, some notes).
You may reuse herdr-draw's look (colors, icons). A role switcher (presenter / annotator / viewer), a theme
toggle (light / dark) and a connection-state switcher make the states reachable without separate files;
separate pages are fine too if index.html links them all.

### Canvas UI (phase 6) — name things as core's Editor does

- **Toolbar, every tool** from `TOOLS` in packages/core/editor.js: Select, Hand, Rectangle, Diamond, Ellipse,
  Arrow, Line, Pen (freedraw), Text, Eraser, Frame, Laser, with their keys. Plus the brief's extras:
  **image** (core: `addImage`/`addFiles`/paste, not a tool id), **notes** and **highlighter** (see "Honesty"),
  tool lock (Q).
- **Side panel** sections from `SECTIONS` in packages/core/panel.js: Properties (stroke/fill colors from
  `STROKES`/`FILLS`, widths, stroke style, roughness, opacity, font, roundness, elbowed arrows), Arrange,
  Frames, Animate (timeline: `animate`, `playToggle`, `duration`), Layers, Library. Stack and tabs modes.
- Frames on the canvas, Mermaid import (`importMermaid`), Library (`libraryItem`, `insertLibraryItem`),
  export (packages/core/export.js: PNG/SVG), zoom/fit, undo/redo, dark mode, and a **touch layout** at phone
  width (~390 px): how the toolbar, panel and collab surfaces collapse.

### Collaboration (phase 7)

Live cursors with names; avatar row (with a viewer count like "12,408 watching"); others' selections; laser
trail; emotes; reactions; comment threads anchored to an element and to a point (replies, resolve, resolved
state); annotations as a notes stream (PROTOCOL.md `notes`); the connection status pill in all four states:
connected, reconnecting, offline, read-only.

## Honesty (the verifier checks this)

Nothing in the mock may claim a feature core's Editor or the protocol plan can't support. Where the brief asks
for something core lacks as such (highlighter is not a tool id; notes are a protocol stream, not a tool; image
is a command), show it and mark it in the mock's legend/notes page as "new in web/ client" or "needs protocol
v1 (phase 1)" — comments, reactions and presence are phase-1 protocol work not yet specified. Don't invent
features beyond the list (no video, chat, AI, polls).

## Done when

- docs/m2/design/index.html opens offline in a browser and reaches every surface above, in light and dark,
  desktop and phone width, for presenter, annotator and viewer.
- docs/m2/design/README.md: a checklist mapping each surface above to where it is in the mock, and each to its
  source (core API name, PROTOCOL.md section, or "new / needs protocol v1").
- You took screenshots yourself (any headless browser or the Mac screenshot tools) at 1440 px and 390 px, light
  and dark, and looked at them. Save them under docs/m2/design/shots/.
- `bun test` still passes (you shouldn't have touched anything it covers).
- Report docs/m2/reports/p6-mock.md: files, how you checked, what you did NOT verify, risks, open questions.
  Then stop and leave the session idle. Don't commit.
