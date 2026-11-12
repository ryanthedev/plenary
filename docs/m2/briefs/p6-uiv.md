# Brief: p6-uiv (verify the phase-6 canvas UI)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md ("Checking people's work", "sdd helpers", "Cleaning up
sessions"), docs/m2/PLAN.md (phase 6), CLAUDE.md, PROTOCOL.md. You are the verifier: try to break it. You were not
the builder.

- **Your tab:** `verifier p6-uiv (client): canvas UI`. Manager: `manager client` (t14k).
- **You own:** docs/m2/reports/p6-uiv.md and your session scratchpad. Read only everywhere else.

## The job you check

Builder brief: docs/m2/briefs/p6-ui.md (goal, owned paths, done-when). The work: the untracked files
`web/index.html`, `web/app.js`, `web/style.css`, `web/ui/**`, `test/web/ui-*.test.js`. The verified mock it follows:
docs/m2/design/ (committed 7536d50). It builds on web/sync.js and web/paint.js (another job's, being verified
separately; treat them as given, but report any misuse of their public API).

Done when (PLAN.md phase 6): every tool, style/layers panels, frames, timeline, Mermaid, library, paste/drag
pictures, export, dark mode, touch; two browsers edit together with every tool; role-aware chrome; read-only greys
every write path including the phone "More" sheet; viewers never show pending edits or reactions of their own.

## What to check

1. `bun test` passes. Read test/web/ui-*.test.js: could they pass with the role gating broken?
2. **Role gating is the security line on the client** (the room is the real one, but a client that writes what its
   role can't is a bug and a flood of refusals). For viewer, commenter, annotator and a presenter downgraded to
   read-only: try every write path (every tool, keys incl. Delete, Ctrl+D, Ctrl+V/paste, drop, undo/redo, panel,
   layers, Mermaid insert, library insert, timeline, the phone More sheet and docks). Count ops that reach the room.
3. **Annotator ownership:** can an annotator change, erase, move or bind to someone else's note or a board element?
4. **Untrusted data to the DOM:** board text, layer names, library item names, frame names, user names, `.excalidrawlib`
   and SVG export from hostile element data (`<script>`, `javascript:` hrefs, quote breakouts, huge strings). Any
   innerHTML fed by board or URL data is HIGH.
5. **The mock:** compare with docs/m2/design at 1440 and 390 px, light and dark, each role: anything in the brief's
   list missing or claiming a feature that isn't wired?
6. **Two tabs converge** with every tool (open two or three tabs via the SharedWorker room), ending Editor == Replica.

Things the builder said it did NOT verify: two separate browser processes; hand input, a real phone, pinch, pen,
wheel/trackpad feel, space-drag; the downloaded SVG/PNG files, PNG with pictures, `.excalidrawlib` drop, panel
resize, layer rename, timeline playback with presets, system-clipboard image paste; read-only downgrade and Retry
live; accessibility and frame rate on a big board.

Risks it named: two Editors (board, notes) means two hellos per person; role read off its own transport wrapper;
pictures reach peers only via its SharedWorker relay; note ownership is client-side ("ids I created" in localStorage,
capped at 5,000); annotator arrows never bind; phase-7 surfaces are stubs.

## sdd ensemble, processes

Single harness today: codex only (load `sdd:subagent-driven-development`, check `usage`, run it in a scratch git copy),
write "single harness" and confirm or refute each finding yourself. Never pkill/killall; kill only PIDs you start;
`--remote-debugging-port=0` and serve on port 0.

## Report

docs/m2/reports/p6-uiv.md: **PASS or FAIL** first line, then HIGH / MEDIUM / LOW with file:line and how you saw it.
HIGH = a role writes what it can't, an annotator changes others' notes, untrusted data reaches the DOM as HTML, two
tabs diverge, or a listed surface is missing. Say what you did NOT check. Then stop; don't commit.
