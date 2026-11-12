# Brief: p7-chrome (J2 of p7-audit: page chrome, link liveness, token expiry)

Base: docs/m2/BRIEF-BASE.md applies, including **Architecture** and the **systems design skill** in **APPLIER** mode.
Read docs/m2/OFFICE.md, CLAUDE.md, PROTOCOL.md § Pacing/§ Auth, docs/m2/reports/p7-audit.md (all; yours are C-2,
C-4 online/visibility part, C-6 app.js side, C-8, C-9, C-17), then the files you own.

- **Your tab:** `worker p7-chrome (client) · <your id>: chrome and liveness`. Name `plenary-p7-chrome`. Manager:
  `manager client`, terminal `t14k`. Report to t14k only; never message the proxy (t1bx).
- **You own:** web/adapters/dom/app.js, web/core/roles.js, web/main.js, web/dev-main.js, test/web/ui-*.test.js (new
  ones too), docs/m2/reports/p7-chrome.md. Running at the same time: p7-perf owns web/adapters/dom/collab/** and
  web/core/collab/**; p7-archtest owns test/web/architecture.test.js. Don't touch web/core/{sync,session}.js (p7-tab and
  J3) or packages/. Don't commit.

## Do

1. **C-2 and C-8:** wheel/zoom and incoming ops never rebuild the whole chrome. Zoom % is a node updated in place;
   counts (notes, board elements) are kept incrementally or keyed on what each part shows; `S.version()` leaves the
   chrome key. Test with a stub DOM: a wheel pan of 60 frames and 100 incoming ops rebuild topbar/panel/drawer/timeline
   0 times; a real change still updates them.
2. **C-4 (page side only):** on `online`, and on `visibilitychange` to visible after being hidden > N s, ask the session
   to probe or reconnect through whatever the session handle already offers (read web/core/session.js and sync.js; don't
   edit them). If the handle offers nothing usable, say so in the report and leave it for J3; don't reach into core.
3. **C-6 app.js side:** pass the root's clock port to `mountCollab({ clock, ... })` (p7-perf is adding that parameter
   now; if it isn't in yet, pass it anyway: an extra option is ignored).
4. **C-9 token expiry:** a refused (`auth`) banner links to `/auth/login` with a return to this board; warn a few
   minutes before the token's `exp` if the page knows it. Retry with the same dead token is not the only way out. The
   token stays out of URLs, localStorage and logs (p6-hexv's rule).
5. **C-17:** the cap countdown uses the clock port, not `Date.now()`.

`bun test` all green (state the count). Headless Chrome on the production rig (test/server/rig.js, port 0): wheel-pan a
busy board and show the chrome no longer rebuilds (a performance trace or counters), and the expiry banner path.
Report docs/m2/reports/p7-chrome.md (changes, tests, mutants that show they bite, what you did NOT check), hc t14k one
line, stop.

Processes: never pkill/killall; PIDs only; port 0.
