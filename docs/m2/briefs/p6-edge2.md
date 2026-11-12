# Brief: p6-edge2 (ws backpressure + sign-in test gaps) — p6-edgev's two MEDIUMs, on main now

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** and the **systems design skill** (APPLIER before
coding; if it isn't in your skill list, read /Users/r/repos/systems-design.skill/skills/distributed-systems-design/
SKILL.md and its references/). Read docs/m2/reports/p6-edgev.md (M1, M2, LOWs) and docs/m2/reports/p6-edge.md.

- **Your tab:** `worker p6-edge2 (client) · <id>: ws backpressure`. Name `plenary-p6-edge2`. Manager: `manager client`
  (t14k). Report to your manager only (never message the proxy).
- **Where:** main. Don't commit.
- **You own:** web/ports/transport.js, web/adapters/transport/ws.js, test/web/contracts/transport-contract.js,
  test/web/contracts/reference-transport.js (if the contract needs it), test/web/adapters/transport-ws.test.js,
  test/web/core/signin.test.js, web/core/signin.js (only if a test exposes a bug), your report docs/m2/reports/p6-edge2.md.
- **Never touch:** web/sync.js, web/app.js, web/index.html, web/ui/**, web/collab/** (p2-land changes them), packages/**,
  server/**.

## Do

1. **M1 backpressure:** add to the transport port an optional-to-call, required-to-implement `congested()` (true when
   the current connection's outbound buffer is over a watermark, about 256 KB) and say in the port what the core must do:
   drop presence (never ops) while congested; a buffer that stays over a hard cap (e.g. 4 MB for 10 s, clock port)
   counts as a drop (onDrop). Implement it in ws.js (bufferedAmount; the pre-open queue capped by bytes as well as
   count) and in the reference transport; contract tests for both rules. The core side (sync dropping presence) is
   p6-hex's: write exactly what it must do in your report.
2. **M2:** in test/web/core/signin.test.js: a console trap (no logging of code or token), `#code=%41%42` in the hostile
   list, and a spy on clock.random (or Math.random stubbed to throw) for the retry jitter.
3. LOWs from p6-edgev where cheap.

## Done when

`bun test` passes (all of it). Mutation check: remove the watermark, the byte cap, the hard-cap drop, the console trap,
the jitter source: each fails a test. Report: design (APPLIER), files, tests, mutation check, NOT verified, risks, what
p6-hex must do in the core. Processes: never pkill/killall; PIDs only; port 0.
