# Brief: p7-perf (J1 of p7-audit: collab UI per-frame cost)

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** and the **systems design skill** in **APPLIER** mode.
Read docs/m2/OFFICE.md, CLAUDE.md (NFRs: 60–120 fps), PROTOCOL.md § Presence/§ Records, docs/m2/reports/p7-audit.md
(all; your findings are C-1, C-6 ui side, C-7 client side, C-15), docs/m2/reports/p7-wire.md, then the files you own.

- **Your tab:** `worker p7-perf (client) · <your id>: collab per-frame cost`. Name `plenary-p7-perf`. Manager: `manager
  client`, terminal `t14k`. Report to t14k only; never message the proxy (t1bx).
- **You own:** web/adapters/dom/collab/{ui,frame,draw}.js, web/core/collab/{records-model,notes-model,presence-model}.js,
  new test/web/collab/perf*.test.js, and docs/m2/reports/p7-perf.md. Other client jobs run at the same time on
  web/adapters/dom/app.js, roles.js, main.js, dev-main.js (p7-chrome) and test/web/architecture.test.js (p7-archtest):
  don't touch those. Don't touch web/core/{sync,session}.js or packages/. Don't commit.

## Do

1. **C-1 pins:** cache `recordsView` per records rev; on pan, move one pin-layer transform instead of every pin; re-place
   only pins in the viewport plus a margin when the view changes; cap pins in the DOM (cluster the rest, with a count).
2. **C-7 client side:** `notesView` only while the notes tab is visible, kept incremental; `nameOf` becomes a
   user → name map, not a scan of all records. (The Replica's 27 ms `recordsState` rebuild is engine's E-3: leave it.)
3. **C-15:** no `[...sel].join(",")` per frame; use a size + cheap hash, or a counter.
4. **C-6 ui side:** `mountCollab` takes `{ clock }`, the clock port (`{ now, mono, set, clear, random }`, see
   web/ports/), and a `frame` scheduler. Presence expiry and outbox pacing use `mono`; record ids use `random`; no
   `Date.now`, `setTimeout`, `Math.random` or `requestAnimationFrame` left in ui.js. Keep working when app.js doesn't
   pass them yet (p7-chrome adds that), by defaulting through the existing DOM clock adapter, not raw globals.
5. **Measure before and after** in bun (10k threads × 3 comments, 50 cursors, 100k selected): per-frame ms of the pure
   parts, and DOM writes per pan frame counted with a stub. Put the numbers in a table. Tests: per-frame work while
   panning is O(1) in pins (stub counter), the pin cap holds, and the presence expiry follows the virtual clock.

`bun test` all green (state the count). Report docs/m2/reports/p7-perf.md: what changed, the before/after table, the
mutants you ran to show the new tests bite, what you did NOT check. Then hc t14k one line. Stop.

Processes: never pkill/killall; PIDs only; port 0.
