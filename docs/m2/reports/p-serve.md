# Report: p-serve (the server serves the web app at /)

**Status: built and tested. `bun test` green. One blocker sits in client's files (below).**

## BLOCKER for the browser (client's files, not mine)

`web/main.js` statically imports `./adapters/transport/shared-worker/client.js` and `./adapters/transport/local.js`.
Both are on the deny list (shared-worker/** from the brief; local.js from t18m's list, 2026-11-12), so the server
answers 404 for both. A failed static import fails the
whole module graph, so **the page does not boot in a browser yet**, even though every allowlisted file returns 200.

- I kept the deny list as the brief says ("never served even if reached"). I did not soften it and did not touch web/.
- The server logs it at every start-up: `static: not served`, why `denied: web/adapters/transport/shared-worker/**`,
  from `/main.js`, spec `./adapters/transport/shared-worker/client.js`.
- **Fix (client):** stop importing shared-worker/client.js and local.js from main.js on the served page (phase 3 wires
  web/adapters/transport/ws.js), or load it with a dynamic `import()` behind a dev flag so a 404 only drops the dev path.
  The alternative is for the manager or t14k to take shared-worker/** off the deny list.

## What changed

| File | Change |
|---|---|
| `server/static.js` (new) | `staticSite({ mounts, log })` returns `{ handle, files, skipped }`. Also exports `safePath`, `denied`, `DENY`, `CSP`, `MIME`, `scanModule`, `scanHtml`, `DEFAULT_MOUNTS`. Imports only `node:fs`, `node:crypto` and `node:path`. |
| `server/server.js` | Imports staticSite; adds the option `static: web = {}` (`false` turns it off, an object passes `mounts`); calls `site.handle` after `http` and before the 404; exposes `site` on the returned server. |
| `test/server/static.test.js` (new) | 15 tests (below). |

## How it works

- **Mounts:** `/` serves web/, `/packages/core/` serves packages/core/, `/packages/protocol/` serves packages/protocol/.
  Defaults come from static.js's own path (`import.meta.dir`), not the working directory.
- **Allowlist:** built once at start-up. The entries are index.html, style.css and main.js, plus the relative
  `src`/`href` of `<script>`/`<link>` in index.html (HTML comments are stripped first). From there it follows the
  import graph:
  - It follows static imports, `export … from`, side-effect imports, `import("literal")` and
    `new URL("literal", import.meta.url)`, which covers `new Worker(new URL(...))`.
  - The grammar is the same as test/arch-scan.js. It is reimplemented, not imported, so nothing comes from test/.
  - An import on a comment line, such as a JSDoc `import("…")` type, adds nothing.
- **Left out and logged (warn):** a computed `import(x)`, a bare specifier, a path outside every mount, a missing
  file, an unknown extension, and a symlink whose realpath leaves its mount.
- **Deny list (after the allowlist):** web/dev.html, web/dev.js, web/collab/**, web/adapters/collab/**,
  web/adapters/transport/shared-worker/**, web/adapters/transport/local.js (adapters/collab/** and local.js added from
  t18m's message of 2026-11-12),
  web/adapters/*/fake.js, any `clock/virtual.js`, any `test/`, `docs/`, `server/` or `node_modules/` segment, and any
  dotfile segment. A denied file is logged with its importer, and the walk does not go past it.
- **Requests:**
  - GET and HEAD only. A request is an exact lookup in the URL-to-file map; request text is never joined onto a
    folder. `/` serves index.html.
  - `safePath` refuses encoded `.`, `/`, `\` and NUL, a literal `\` or NUL, a `.` or `..` segment, an empty segment,
    a path not starting with `/`, and a path over 1024 characters.
  - The realpath is checked again on each request, which catches a file swapped for a symlink after start-up.
  - Anything not served returns `null`, and server.js gives its usual JSON 404.
- **Headers:** CSP exactly as in the brief; `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`;
  `Cache-Control: no-cache`.
  - **MIME types:** .js and .mjs are `text/javascript`, .css is `text/css`, .html is `text/html; charset=utf-8`,
    and .json, .svg, .png and .woff2 have their usual types.
  - **ETag:** strong, the sha-256 of the bytes in base64url. The file is read on every request, so an edit shows on
    reload.
  - **304:** answered when `If-None-Match` matches, using weak comparison as RFC 9110 requires (`W/` is ignored,
    lists and `*` match). HEAD returns the same headers with `content-length` and no body.

## Tests added (test/server/static.test.js, 15)

| Area | What the tests check |
|---|---|
| Allowlist | It equals the planted graph exactly: entries, static, re-export, side-effect, `import()`, `new URL()`, and packages/ reached through relative imports. |
| Start-up log | Each left-out case is logged with its reason, and a denied file names its importer. |
| Deny list | Every deny-list path is 404 even though the planted main.js imports it, and nothing beyond a denied file is reached. The rules are also tested by path. |
| Not in the graph | 404 for an orphan file, an unused package file, a JSDoc type import, a commented-out import, a computed import, a symlink pointing out, and an unknown type. |
| MIME types | 200 and the exact content type for /, index.html, style.css, main.js and packages/ modules. |
| Headers | Exact values and the exact header set. |
| ETag | 304 for the tag, for `W/`+tag, for a list and for `*`; 200 for another tag; an edit changes the tag. |
| Methods | HEAD has headers and no body; POST, PUT, DELETE, OPTIONS and PATCH are not served. |
| `safePath` | 22 raw traversal strings are refused. |
| Raw sockets | 21 traversal request targets give 404 over a raw TCP socket, because `fetch` would normalise them. |
| Real server | /health is 200 JSON, /ws is 426, /nope and POST / are 404. With `static: false`, `/` is 404 and /health is 200. |
| Precedence | Platform's `http` routes win over static. |
| Scanners | The JS and HTML scanners on synthetic sources. |
| Real tree | A smoke test on the real web/: /, main.js, style.css and packages files are served; dev and fake files are 404. |

- **Mutation-checked:** I broke each of these in turn and a test failed every time: the deny list, the symlink
  check, the encoded-path check, comment skipping, the cache header, and `*` in If-None-Match.

## How I checked it

- **Full suite:** `bun test` gave 1044 pass, 0 fail, 101 skip on the final run, with the tree as it stood after
  t18m's deny-list update. The 3 static.test.js failures client saw came from one control run in which I briefly
  put back HEAD's server.js to rule out my mount (likely, not proven: same count, same window). The new tests fail
  without the mount, as they should. I won't swap a shared-tree file again.
  - **One intermittent failure:** in two earlier full runs, `test/server/v1.test.js` "a board feed picks up the
    host's checkpoint…" failed (base.seq 9, not 10). It passed 3 of 3 runs alone with my server.js and 3 of 3 alone
    with HEAD's server.js. That test is a heartbeat timing test in files p2-tune is editing (feed.js, gateway.js).
    I judge it a flake under full-suite load; this is not proven.
  - **Another session's edit:** the first full run also failed test/auth/architecture.test.js. It passed on the
    next runs, and platform was editing server/auth at the time.
- **architecture.test.js:** green. server/static.js is classified as core (a server/ root file) and imports only
  node: built-ins.
- **Manual check:** `PORT=0 PLENARY_DATA_DIR=<scratch> PLENARY_DEV_TOKENS=… bun server/main.js`, PID 64748, port
  51664, killed by that PID afterwards.
  - curl of `/` and all 42 graph files: every one 200 with the right MIME type. Headers exact; 304 on the ETag.
  - 404 for /adapters/transport/shared-worker/client.js, /dev.html, /dev.js, /collab/dev.js,
    /adapters/clock/virtual.js, /adapters/auth/fake.js, and `--path-as-is /../server/main.js`.
  - /health 200, /ws 426. Scratch data deleted.
- **Bun normalises paths:** Bun 1.4.4 collapses literal `..`, `%2e%2e` and `\` in the request target before
  `req.url`, as a browser would. So `/sub/../main.js` reaches the handler as `/main.js` and is served, because it
  is in the allowlist. Nothing outside the map can be reached. The encoded `%2f` and `%00` forms survive into
  `req.url` and are refused by `safePath`.

- **Final manual check (after the deny-list update):** `bun server/main.js`, PORT=0 (port 58047), PID 9198, killed by
  that PID, scratch data removed. I crawled it as a browser would: fetch `/`, resolve every `src`, `href` and import
  with `new URL(spec, pageUrl)`, and fetch on. Result: 38 of 40 URLs returned 200. The two 404s are exactly the
  denied imports from /main.js (shared-worker/client.js and transport/local.js). The crawler reuses static.js's
  parser, so it checks URL mapping and serving independently, but not parsing.
- **No assets hidden from the scanner:** I grepped the served files for stylesheets, images, fonts and relative
  `fetch`. The only `fetch` goes to `/auth/exchange`, a server route. web/adapters/dom/collab/collab.css is linked
  only from web/collab/dev.html, which is denied.

## What the graph held when I ran (2026-11-12; client's p6-hex may still move files, and the allowlist adapts)

**Final run (after the deny-list update): 38 files, two denied.** Compared with the list below,
adapters/transport/local.js and packages/protocol/{codec,ports,room}.js are gone: they were reached only through
local.js. The manual curl check below ran before this update, on 42 files.

Earlier run, 42 files, one denied:

- **web/:** index.html, style.css, main.js, adapters/auth/http.js, adapters/clock/browser.js, adapters/dom/{app,dom,
  export,paint,panel}.js, adapters/storage/{local,session}.js, adapters/transport/local.js, core/{dev-users,roles,
  session,signin,sync}.js, ports/{auth,transport}.js
- **packages/core:** anim, color, doc, editor, elbow, export, geometry, library, lint, mermaid, model, panel, render,
  style, text (.js)
- **packages/protocol:** codec, envelope, ports, presence, records, replica, room (.js)
- **Denied but imported:** adapters/transport/shared-worker/client.js (from main.js; see BLOCKER). On the final run
  adapters/transport/local.js too.
- **core/dev-users.js** is served (main.js imports it). Per t18m it is not special-cased; if client moves it to a
  dev-only root, the allowlist follows.

## Not verified

- **No browser load.** By the blocker above it would fail today. CSP has not been seen in a real browser (for
  example inline `style=` attributes are allowed by `'unsafe-inline'`; any inline `<script>` would be blocked).
- **Not under main.js's own tests.** main.js is untouched. Its tests passed in the full run, and its server now
  serves `/` by default.
- **Systems-design skill:** I did not run it in APPLIER mode. This is a stateless read-only adapter with no
  scaling or failure behaviour beyond "file missing gives 404", so I applied its checks informally (no shared
  state; per-request read cost is one small file plus a sha-256). Say if you want a formal pass.

## Risks

- **Restart to pick up new imports.** The allowlist is fixed at start-up, so a new import added while the server
  runs is 404 until a restart. A dev loop could add a watch later.
- **Per-request cost.** Each request reads and hashes the file, which is fine at dev scale. For 100k joins a
  CDN or an in-memory cache keyed by mtime is the M4 answer.
- **Scanner gaps.** A computed `import()` or `new URL(variable)` is left out (and logged), so the page breaks
  visibly rather than silently over-serving.

**Question for t18m:** shared-worker/client.js and transport/local.js are both on the deny list, but `web/main.js`
imports them statically, so the served page can't boot. Should client drop or gate those imports on the served
page (my recommendation, for example main.js wiring ws.js), or should the deny list change?

## Round 2 (2026-11-12): import scanner fix (p-servev FAIL H1)

**Status: H1 fixed. `/ports/storage.js` is now served (200), and the allowlist matches an independent crawl of the
page's graph: 39 files on both sides.** The main.js blocker above (two denied imports) still stands; that is client's.

### What changed

| File | Change |
|---|---|
| `server/static.js` | `scanModule` now uses Bun's parser instead of regexes (details below). A module that doesn't parse is logged as `unparseable (its imports are not served)` instead of throwing. The header comment documents L2. |
| `test/server/static.test.js` | 4 new tests; the scanner test rewritten (below). |
| `server/server.js` | No change this round. |

### How the scanner works now, and why

- **Imports come from Bun's parser.** `scanModule` calls `new Bun.Transpiler({ loader: "js" }).scanImports()`, which
  parses the module, so a comment or a string that mentions `import` can't add an import or hide one.
- **Two shapes Bun's scanner doesn't report.** `new URL("literal", import.meta.url)` (the Worker pattern the brief
  requires) and a computed `import(x)` (logged, never served) are still matched by regex, but on `transformSync`'s
  output, which has every comment removed.
- **One remaining over-match.** A string literal whose text looks like `new URL("./x.js", import.meta.url)` would
  still match. It could only add a file that exists in a mount and passes the deny list, so the worst case is
  serving one extra file, never escaping the allowlist.
- **Why Bun's parser and not a hand-written comment and string stripper:**
  - It is exact. A hand-written stripper has to tell regex literals from division, which is the classic trap.
  - Bun-specific code is fine here: static.js is the server's HTTP adapter and never runs in Herdr.
  - It costs about 14 ms of start-up per server.
- **L2 (documented, not changed):** in index.html, only relative `src`/`href` are followed. An absolute one is
  skipped and logged as `not a relative path`. main.js and style.css are served anyway because they are fixed
  entries, but any other file referenced absolutely would be 404.
- **L1 and L3:** no change, per the brief (L1 is Bun's HTTP parser; L3 is an M4 lever).

### Tests added (19 in the file now; static.test.js + architecture.test.js: 35 pass)

- **H1, scanner:** the two-line comment shape from the verifier's report (`// … adapters never import each other.`,
  a second comment line, then the real import), plus a block-comment variant.
- **H1, through `staticSite`:** a planted root where `session.js` has that comment. `/ports/storage.js` must be on
  the allowlist and return 200.
- **Unparseable module:** it is logged, and nothing it imports is served.
- **Real tree vs an independent crawl:**
  - The crawl uses `Bun.build({ metafile: true })` from web/main.js, so it is Bun's bundler resolver, not
    static.js's code.
  - It walks the bundler's import graph from main.js, stops at denied files and maps paths to URLs by mount.
  - The test requires the allowlist to equal the crawl plus index.html and style.css, and checks that
    `/ports/storage.js` is in it.
- **Scanner test rewritten:** round 1's version fed invalid JavaScript (a bare ` * @returns` line), which a real
  parser rejects. It now uses valid source with a JSDoc type, a line comment, a block comment and a string that
  each mention import.

**Mutation check:** in a scratch copy of the tree (since deleted), I restored round 1's regex scanner (`STAT` + `DYN`
+ `onComment`). 3 tests failed:

- H1 scanner
- H1 through staticSite
- the real-tree-vs-bundler test

All three pass with the fix. The rewritten scanner test passes under both scanners; it guards the comment and string
cases, not H1.

### Checks

- **Owned gates:** `bun test test/server/static.test.js test/architecture.test.js`: 35 pass, 0 fail.
  `bun test test/server`: 200 pass, 0 fail.
- **Full suite, three runs.** The shared tree was changing under me during all three; each run had exactly 1
  failure, never in a file I own:

  | Run | Result | The one failure |
  |---|---|---|
  | 1 | 1062 pass, 1 fail | `test/server/v1.test.js` "a board feed picks up the host's checkpoint…" timed out at 15 s |
  | 2 | 1062 pass, 1 fail | the same v1 test |
  | 3 | 1067 pass, 1 fail | v1 passed; `test/web/core/signin.test.js` "a throwing replaceFragment is survived" failed (got `url-not-cleared`) |

  - **The v1 test:** it passes alone and in `bun test test/server`. `test/server/v1.test.js` and `server/feed.js`
    are modified in the tree right now by another session (the test's new comment cites t18m). Static's start-up
    cost (~14 ms per server, before the test's waits begin) can't plausibly cause a 15 s timeout. Not proven.
  - **The signin test:** client's sign-in code, which I don't own; static.js has no part in it.
  - **So** I can't show a fully green `bun test` in the shared tree right now. Every failure is in a file under
    another session's active edit.
- **Manual check:**
  - `PORT=0 bun server/main.js` with dev tokens and a scratch data dir: port 50323, PID 42575, killed by that PID.
    Scratch data, the scratch copy and the scripts are deleted.
  - Start-up log: `static: serving files: 39, skipped: 2`. The two skipped are the known denied imports from
    main.js.
  - `/ports/storage.js` returned 200 `text/javascript`.
  - A crawl with Bun's bundler, run separately from the test, found the same 39 files, and every one returned 200
    from the live server.

### Not verified, and risks

- **No browser load:** the main.js blocker remains.
- **One over-match path:** the `new URL` string literal case above.
- **Not touched, per the brief:** `test/arch-scan.js` keeps the same regex bug.

**Question for t18m (still open from round 1):** web/main.js imports two denied files, so the page can't boot.
Should client drop or gate them (my recommendation), or should the deny list change?
