# Brief: p-serve (the server serves the web app at /)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md, CLAUDE.md, server/server.js, server/main.js (read only),
web/index.html and web/main.js (read only; client's p6-hex is restructuring web/ right now).

- **Your tab:** `worker p-serve (engine) · <your id>: serve web/ at /`. Manager: `manager engine`, terminal `t18m`.
  Report to t18m only; never message the proxy (t1bx).
- **Where:** the shared tree /Users/r/repos/plenary (main). Don't commit.
- **You own:** server/static.js (new), server/server.js (route mount only), test/server/static.test.js (new).
  Never touch server/main.js (platform is editing its dev path), server/gateway.js, server/feed.js, test/server/
  other files (p2-tune), web/** (client), server/auth/** (platform).
- **Report:** docs/m2/reports/p-serve.md. Then stop, idle.

## Why

After Google sign-in the browser lands on GET /, which is 404: the server serves no page. (platform p8-readme2.)

## What (client t14k's requirements, 2026-11-12)

- **Mounts:** web/ at `/`; packages/core at `/packages/core`; packages/protocol at `/packages/protocol` (the page
  imports them by relative path, e.g. "../../../packages/core/editor.js"). GET and HEAD only. Engine routes
  (/ws, /health) and platform's HTTP routes keep precedence; static is the last fallback.
- **Allowlist, never a directory:** at start-up, build the set of servable files from web/index.html, web/style.css
  and the import graph of web/main.js (static imports, re-exports, dynamic `import("literal")`, `new Worker(new
  URL("literal", import.meta.url))` if used). Everything else is 404, so a new dev file is never served by accident.
  Do not import from test/ (test/arch-scan.js is a test helper): write a small parser in server/static.js; it may
  reuse the same grammar. If an import can't be resolved statically, log it at start-up and leave it out.
- **Never served even if reached:** web/dev.html, web/dev.js, web/collab/**, web/adapters/transport/shared-worker/**,
  web/adapters/*/fake.js, any clock/virtual.js, test/**, docs/**, server/**, dotfiles. Make this a deny list checked
  after the allowlist, with a test that each is 404 even when imported (plant it in a temp web root).
- **Paths:** reject `..`, encoded traversal (`%2e%2e`, `%2f`), NUL, backslashes, absolute paths, symlinks leaving
  the root. `/` serves index.html.
- **Headers:** Content-Security-Policy `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none';
  frame-ancestors 'none'`; `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`; correct MIME
  (`text/javascript` for .js, `text/css`, `text/html; charset=utf-8`, svg/png/woff2 if present); `Cache-Control:
  no-cache` with a strong ETag and 304 on `If-None-Match`.
- **Config:** the web root defaults to the repo's web/ (resolved from server/static.js's own path, not cwd) and can
  be turned off (`createServer({ static: false })`) without touching main.js.
- **Hexagonal:** static.js is a driving adapter (HTTP); it must not import room-host, gateway or any driven adapter.
  test/architecture.test.js must stay green.

## Done when

- `bun test` green. New tests: index at /, a module and its relative imports from packages/ resolve with 200 and
  the right MIME; every deny-list path and every traversal form gives 404; a file not in the graph gives 404;
  headers exact; ETag/304; /ws and /health unchanged; static: false gives 404 at /.
- A manual check against `bun server/main.js` (dev tokens on, port 0 or a free port, PID recorded, stopped after):
  GET / and the page's module graph all 200 (fetch each with curl; no browser needed).
- Note in the report: client's p6-hex may still move files; the allowlist adapts, but list what the graph held when
  you ran.

Process: never pkill/killall; port 0; record PIDs and kill only those; delete scratch data at the end.
