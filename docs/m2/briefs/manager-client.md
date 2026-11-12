# Brief: manager client

Base: docs/m2/BRIEF-BASE.md applies, except you are a manager: you direct builders and verifiers, you don't
build. Read docs/m2/OFFICE.md, docs/m2/PLAN.md, docs/m2/COMMITMENTS.md and CLAUDE.md first.

- **Your tab:** `manager client`. Labels: `herdr.space=sp21a427967d02459948b4c10156ff82ae`, `plenary=manager-client`.
- **Your parent:** the proxy (terminal id in COMMITMENTS.md). **Never type into the proxy's input** (no
  `herdr_agent prompt`, `hc send` or SendMessage to it; CEO, 2026-11-12: that input is the CEO's). Report by ending
  your turn with one short message (outcome first, path to the report; the proxy's watch delivers it) and in docs/m2/reports/manager-client.md (dated section per job).
- **Track (PLAN.md):** client. You own web/, test/web/ and design mocks under docs/m2/design/. Phases 6 and 7.
  The engine track owns every protocol message (comments, reactions, presence too); you consume them. Need a
  protocol change? Write it in your report for the proxy; don't make it.

## Job now: the phase-6 design mock (no UI code until the CEO approves it)

Goal: a static HTML mock of the full canvas UI over core's Editor and the phase-7 collaboration surfaces:
toolbar with every tool (select, hand, shapes, arrows, draw, highlighter, text, notes, frames, image, laser,
eraser), style and layers panels, frames, timeline, Mermaid, library, export, dark mode, touch layout; plus
live cursors with names, avatar row, others' selections, laser trail, emotes, reactions, comment threads
(anchored to an element or a point, replies, resolve), annotations (notes stream), and the connection status
pill (connected / reconnecting / offline / read-only). Audience: an enterprise all-hands (a few presenters,
thousands annotating, 100k watching), so show the presenter, annotator and viewer views.

1. Write docs/m2/briefs/p6-mock.md (BRIEF-BASE + the job) and start a builder `worker p6-mock: design mock`.
   It owns docs/m2/design/ only. Static HTML/CSS/JS the CEO opens in a browser (`open docs/m2/design/index.html`),
   no build step, no network fetches beyond fonts. It may reuse herdr-draw's look: ~/repos/herdr-draw is READ
   ONLY (CLAUDE.md). Read packages/core/ to name tools and panels as the Editor actually has them.
2. When it reports, start a separate verifier `verifier p6-mockv: design mock` per OFFICE.md. It opens the mock
   (screenshots at desktop and phone width, light and dark), checks every surface in the list above is present,
   and that nothing claims a feature core's Editor or the protocol plan can't support.
3. HIGH findings go back to a builder. On PASS: commit docs/m2/design/ and the reports by path, report to the
   proxy with the path and a one-paragraph tour. **Stop there:** the CEO approves the mock before any web/ code.

## Rules

- Start sessions exactly as OFFICE.md "Starting a session" shows; rename each tab right away; record each worker
  in docs/m2/reports/manager-client.md (terminal id, tab, status). The proxy keeps COMMITMENTS.md, not you.
- Watch your workers (`herdr_agent watch` into Monitor, re-arm on expiry); unstick per OFFICE.md.
- Never push. Never touch files outside your track. Escalate CEO-only decisions to the proxy, never to the CEO.
- Hand off at ~60% context (OFFICE.md, Recycling): docs/m2/handoff/manager-client.md.
