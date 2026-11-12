# Brief: p6-basev (verify phase-6 canvas + sync core)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md ("Checking people's work", "sdd helpers"),
docs/m2/PLAN.md (phase 6), CLAUDE.md, PROTOCOL.md first. You are the verifier: try to break it. You were not the builder.

- **Your tab:** `verifier p6-basev (client): canvas + sync core`. Manager: `manager client` (t14k).
- **You own:** docs/m2/reports/p6-basev.md and your session scratchpad. Read only everywhere else; findings go
  in your report, never into web/.

## The job you check

Builder brief: docs/m2/briefs/p6-base.md (goal, owned paths, the seam rule, done-when). The work: the untracked
files `web/paint.js`, `web/sync.js`, `web/dev.html`, `web/dev.js`, `test/web/paint.test.js`,
`test/web/sync.test.js` (`git status --short web test/web`).

Done when (PLAN.md phase 6 gate, this job's share): headless test "refused op + resync leaves Editor == Replica";
painter covers every display-list item kind core emits; two Editors through a Room converge with every
element-making tool; a refused op is undone in the Editor; every call into Replica/Room/codec lives in web/sync.js.

## What to check

1. `bun test` passes. Read the gate test and ask whether it can pass while Editor != Replica (is the equality check
   strong enough: versions, deleted elements, appState, pictures?). Write extra tests in your scratchpad that
   import web/sync.js: refusals mid-gesture, a refusal during catch-up, snapshot catch-up after compact, two
   refusals in a row, a peer deleting what you are dragging, notes stream instead of board.
2. **Seam:** grep web/ for imports of packages/protocol outside sync.js. Read what sync.js reaches into (Replica
   internals, the Editor's stored version) and judge whether that is safe against PROTOCOL.md rules 1–6.
3. **Painter:** compare paint.js against every item kind packages/core/render.js can emit (and the herdr-draw
   adapters for reference, read only). Untrusted colors, fonts and image data must not reach the canvas raw.
4. **Browser:** open web/dev.html in headless Chrome and draw in both panes; check they converge.

Things the builder said it did NOT verify: wheel/pinch zoom, space-drag pan, eraser and laser in the browser,
touch and pen, real hi-dpi, pictures in the browser, WebSocket transport (none exists), peers' live previews, the
notes stream (only `board` tested).

Risks the builder named: core's `livePut` raises version per pointer move, so long drags exceed the room's
MAX_VERSION_JUMP; sync.js works around it by rewriting the Editor's stored version. Resync flickers and edits during
a resync are visually lost. sync.js reads Replica internals.

## sdd ensemble (single harness today)

Load `sdd:subagent-driven-development` first and check `usage`. Only codex is available today (agy out of quota,
others not signed in). Run codex on the files above in a scratch git copy so it cannot write the real tree, and
write "single harness" in your report. Confirm or refute each codex finding with your own evidence.

## Processes you start

Never `pkill` or `killall`. Record the PID of every Chrome or server you start and kill exactly that PID (or its
child handle). No hard-coded ports: `--remote-debugging-port=0` (read DevToolsActivePort) and serve on port 0.
Other sessions run headless Chrome at the same time.

## Report

docs/m2/reports/p6-basev.md: **PASS or FAIL** on the first line, then HIGH / MEDIUM / LOW findings with file:line and
how you saw them. HIGH = the gate can pass while broken, an acked op lost, a protocol call outside sync.js, or
untrusted data reaching the canvas raw. Say what you checked and what you did not. Then stop; don't commit.
