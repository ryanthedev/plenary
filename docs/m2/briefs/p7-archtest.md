# Brief: p7-archtest (J4 of p7-audit: architecture tests that bite, and core over a real-ish socket)

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** (hexagonal) and the **systems design skill** in
**APPLIER** mode. Read docs/m2/OFFICE.md, CLAUDE.md, docs/m2/reports/p7-audit.md (all; yours are C-10, C-14, C-16 test
side), test/web/architecture.test.js, test/arch-scan.js, server/static.js (read only), web/ports/, web/core/.

- **Your tab:** `worker p7-archtest (client) · <your id>: architecture tests`. Name `plenary-p7-archtest`. Manager:
  `manager client`, terminal `t14k`. Report to t14k only; never message the proxy (t1bx).
- **You own:** test/web/architecture.test.js, new test/web/core-runtime-globals.test.js, a new ws-backed rig under
  test/web/adapters/ (new files only), docs/m2/reports/p7-archtest.md. **Tests only: no file under web/, server/,
  packages/ or test/arch-scan.js.** If a test you add fails on today's code, mark it with the finding id and leave it
  failing only if the bug is in a file another job is fixing right now (p7-perf: web/**/collab/**, p7-chrome: app.js,
  roles.js, main.js, dev-main.js); otherwise report it and skip it with a reason. Don't commit.

## Do

1. **C-14:** a runtime check: import every web/core module and drive a session (localRoom) with `Date.now`,
   `Math.random`, `setTimeout`/`setInterval`, `requestAnimationFrame`, `document`, `location`, `localStorage` and
   `crypto` replaced by throwing stubs; core must not touch them. Flag a non-literal `import(` in core. Use arch-scan's
   `{ urls: true }` for the production graph, so `new URL(...)` to a dev module from main.js's graph fails.
2. **C-16 test side:** one list of dev-only modules in the test, checked against static.js's DENY so they can't drift;
   web/adapters/storage/memory.js is on it. (static.js is engine's; if it needs a change, write it in the report.)
3. **C-10:** a sync rig with web/adapters/transport/ws.js over a fake WebSocket that delivers asynchronously (pre-open
   queue, `bufferedAmount`), bridged to a localRoom. Run the collab contract and the convergence tests on it as well.
4. **Prove they bite:** every audit mutant in p7-audit C-14 (Date alias, `Math["random"]`, computed `import()`,
   `Function("return this")`, `new URL` in core, dev module by `new URL` from app.js) now fails a test. Show each.

`bun test` all green apart from the allowed marked cases (state the count). Report docs/m2/reports/p7-archtest.md, hc
t14k one line, stop.

Processes: never pkill/killall; PIDs only; port 0.
