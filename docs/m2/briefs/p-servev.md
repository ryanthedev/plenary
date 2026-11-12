# Brief: p-servev (verify p-serve: the server serves the web app at /)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md ("Checking people's work"), CLAUDE.md, then the job's
brief docs/m2/briefs/p-serve.md (the goal and client's exact requirements).

- **Your tab:** `verifier p-servev (engine) · <your id>: static serving`. Manager: `manager engine`, terminal
  `t18m`. Report to t18m only; never message the proxy (t1bx).
- **Where:** the shared tree /Users/r/repos/plenary (main). The job is uncommitted: server/static.js (new),
  server/server.js (mount), test/server/static.test.js (new). Other sessions edit other files concurrently
  (p2-tune: gateway.js, feed.js, other test/server files; client: web/**): ignore their failures but name them.
  **Change nothing in the tree**: attack in a scratch copy or against a running server.
- **Report:** docs/m2/reports/p-servev.md: PASS or FAIL, HIGH/MEDIUM/LOW with repros. Then stop, idle.
- Known and not this job's: web/main.js statically imports two denied dev transports, so the page can't boot yet
  (client is fixing it). Don't report that; do check the server logs it.

## Builder's "Not verified" and "Risks" (verbatim, shortened)

- No browser load; CSP not seen in a real browser. main.js untouched (serves / by default).
- Systems-design skill not run formally (stateless read-only adapter).
- Allowlist fixed at start-up (new imports need a restart). Each request reads and hashes the file.
- A computed import() or new URL(variable) is left out and logged.

## Check (minimum)

1. **Security first:** path traversal in every form (`..`, `%2e%2e`, `%2f`, `%5c`, double encoding, NUL, `//`,
   backslashes, absolute paths, unicode tricks, very long paths), symlinks leaving a mount, case-variants on macOS's
   case-insensitive filesystem (e.g. `/DEV.html`, `/Adapters/...` reaching a denied file), HEAD vs GET, methods
   other than GET/HEAD, a denied file reached through a non-denied importer, dotfiles, `.env` in any form. Nothing
   outside the allowlist may come back 200; no request may crash or hang the server.
2. **Precedence:** /ws, /health and platform's /auth and /boards routes are unchanged; static is the fallback.
3. **Headers** exactly as the brief: CSP string, nosniff, no-referrer, MIME per type, no-cache + strong ETag, 304.
4. **Allowlist correctness** against the real web/ (start `bun server/main.js` on a free port, PID recorded):
   every file the page needs is listed; nothing denied is.
5. **Hexagonal:** test/architecture.test.js green; static.js imports no driven adapter or core logic.
6. **Cost:** a quick measure of requests/s and per-request CPU for a typical module; note it for M4.
7. sdd ensemble on the diff if quick; confirm or refute two-harness findings.

Process: never pkill/killall; port 0; record PIDs and kill only those; delete scratch data at the end.
