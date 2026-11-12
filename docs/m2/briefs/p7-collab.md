# Brief: p7-collab (phase-7 collaboration UI, part 1: everything behind a collab port)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md, docs/m2/PLAN.md (phase 7), CLAUDE.md, PROTOCOL.md v1
(§ Streams, § Presence, § Records, the `here`/`emotes`/`presence` messages, rules 5 and 11) first.

- **Your tab:** `worker p7-collab (client): collaboration UI`. Manager: `manager client` (t14k).
- **Where:** the worktree **/Users/r/repos/plenary-p2** (branch p2-land). Don't commit; engine merges p2-land.
- **You own exactly:** `web/collab/**` and `test/web/collab/**` (new), plus your report docs/m2/reports/p7-collab.md
  in the worktree. **Nothing else.** web/sync.js, web/app.js, web/index.html, web/style.css, web/ui/** and the other
  test/web files belong to p6-land (being verified now); packages/protocol and server/ are engine's.
- **Read only:** packages/protocol/{replica,presence,records…}.js on p2-land (to match message shapes and limits),
  docs/m2/design/ (the verified mock: its phase-7 rows in README.md, mock.js, mock.css), web/ui/ (how p6-ui renders).

## Why the split

sync.js exposes no presence or records API yet, and it is under verification. So you build all of phase 7 behind an
interface, the **collab port**, and a later job (p7-wire, after p6-land passes) makes `bindEditor` provide it and
mounts your UI in app.js. You may not import packages/protocol from web/collab (the seam: only web/sync.js calls the
protocol); constants you need (rates, caps, the emote set), read them and mirror them in one file, web/collab/limits.js,
with a test that compares them to packages/protocol (tests may import it).

## The collab port (you write it down at the top of web/collab/port.js as JSDoc; p7-wire implements it)

- `role`, `me` ({ user, name, client }), `status` (sync status names).
- Presence out: `send(kind, fields)` for `cursor`, `selection`, `laser`, `emote` (§ Presence fields). Rate limits and
  the role table are enforced on your side too (never send what the role can't).
- Presence in: `onPresence(fn(batch))`, `onLeave(fn(user, client))`, `previews(stream)`.
- `onHere(fn({ writers, writerCount, viewers }))`, `onEmotes(fn({ counts }))`.
- Records: `records()` (current state incl. pending), `onRecords(fn)`, and ops `thread`, `reply`, `resolve`, `reopen`,
  `react`, `unreact`, `deleteComment` with the fields § Records defines; refusals come back as errors per rule 5.
- `noteAuthor(id)` (v1 snapshot), for the notes drawer.
Make a **fake port** (web/collab/fake-port.js) for tests and a dev page.

## Build (to the mock, over the port)

- **Presence model** (pure, tested): others' cursors with names and colors, selections, laser trails that fade,
  previews; drop a client on `leave` or 30 s of silence; send at the § Presence rates (cursor 20/s etc.); writers'
  emotes float, viewers' emotes only as counts.
- **Avatar row** from `here` (≤ 50 writers, "+N", "N watching"); **emote bar** (fixed set, viewers too, disabled when
  not live) and the crowd counts.
- **Records model** (pure, tested): threads anchored to an element (follows it; orphaned when deleted) or a point;
  replies; resolve/reopen; reactions on comments only; role rules (commenter and up write, viewers read, nobody edits
  others' comments unless § Records says so); pending overlay until acked.
- **Comment UI:** pins on the canvas, the thread popover, the comments list (open/resolved), compose box.
- **Notes drawer** with authors from `noteAuthor`.
- **Renderers** (DOM, textContent only, never innerHTML with data; canvas overlays as pure draw functions taking a
  2D context and the view) that p7-wire mounts: export a `mountCollab({ root, canvasOverlay, port, view, theme })`.
- A dev page web/collab/dev.html over the fake port (two fake peers, a crowd) to check it by eye, light and dark,
  1440 and 390 px.
- CEO questions still open (docs/m2/reports/p6-mock.md): viewers see presenters' cursors only (mock default),
  no follow-presenter view, reactions on comments only. Keep each behind one flag in web/collab/flags.js.

## Done when

- `bun test` passes in the worktree (all of it). Tests: presence expiry and rates, role gating of every send and
  record op, records ordering with pending overlay, anchors following and orphaning, viewers' emotes only as counts,
  hostile names and comment text never reach the DOM as HTML.
- The dev page checked in headless Chrome at both widths and themes; screenshots in your scratchpad.
- Report: the port as built (exactly what p7-wire must provide), files, tests, how you checked, NOT verified, risks.
- Processes: never pkill/killall, PIDs only, port 0. sdd helpers allowed; you own every line.
