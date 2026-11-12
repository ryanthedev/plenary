# Report: p-servev (verify p-serve: the server serves the web app at /)

Verifier t1g8, 2026-11-12. Tree: shared main, job uncommitted (server/static.js, server/server.js mount,
test/server/static.test.js). I changed nothing in the tree except this report. Attacks ran against my own server
(`bun server/main.js`, port 52310, PID 70914, scratch data dir) and against `staticSite()` over scratch roots.

## Verdict: FAIL (1 HIGH). 0 MEDIUM, 3 LOW.

The security side holds: no traversal, encoding, symlink, case, dotfile, method or deny-list probe reached a file
outside the allowlist, nothing crashed or hung, and headers, ETag/304 and route precedence match the brief.
The HIGH is a **correctness** bug in the import scanner: a comment containing the word "import" swallows the real
import that follows it, so a file the page needs is left off the allowlist and gets 404. It fails closed (no leak),
but the page can't boot even after client fixes main.js.

## Gates

| Gate | Result |
|---|---|
| `bun test` (whole tree, 2026-11-12) | 1045 pass, 101 skip, 0 fail, 62 files, 103.6 s |
| `test/server/static.test.js` + `test/architecture.test.js` | 31 pass |
| Server logs the known main.js blocker | yes: two `static: not served` warnings (shared-worker/client.js, local.js), then `files: 38, skipped: 2` |
| sdd ensemble | not run: the HIGH alone decides the verdict and the fix needs a re-verify anyway |

No failures from other sessions (p2-tune, client, platform) in this run.

## HIGH

### H1. A comment with the word "import" swallows the next real import; `/ports/storage.js` is not served

- **Where:** `server/static.js:98` (`scanModule`), with the `STAT` regex and `onComment` at `server/static.js:90`.
- **Mechanism:** `STAT` starts a match at the word `import` inside a comment, then its lazy
  `[^"'\x60;]*?\bfrom\s*` spans the following comment lines (no quote or `;` in them) up to the real
  `from "../../ports/storage.js"`. `onComment` rejects the whole match because it began in a comment, and the real
  import was consumed, so `matchAll` never sees it.
- **Trigger in the real tree:** `web/adapters/storage/session.js:2` and `web/adapters/storage/local.js:2` say
  "adapters never import each other."; line 8 is `import { STORAGE_UNAVAILABLE } from "../../ports/storage.js";`.
- **Effect:** `web/ports/storage.js` is reached only through those two files, so it is off the allowlist. main.js
  imports session.js at `web/main.js:13`, so the browser's module graph fails on a 404 once client removes the
  denied imports. The builder's real-tree smoke test didn't catch it.
- **Repro:**
  ```sh
  bun -e 'import {scanModule} from "./server/static.js"; import {readFileSync} from "node:fs";
    console.log(JSON.stringify(scanModule(readFileSync("web/adapters/storage/session.js","utf8"))))'
  # {"specs":[],"computed":[]}   (expected: ../../ports/storage.js)
  bun server/main.js   # then:
  curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:$PORT/adapters/storage/session.js   # 200
  curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:$PORT/ports/storage.js              # 404
  ```
- **Other misses (same bug, not in today's served graph):** `packages/core/shortcuts.js` loses `./editor.js`;
  `server/bus/nats.js` loses `../ids.js`. Found by comparing `scanModule` with Bun's own
  `new Bun.Transpiler().scanImports()` over every .js file in the repo.
- **Fix suggestion:** strip comments before matching (a small scanner that skips `//…`, `/*…*/` and string/template
  literals), or use `Bun.Transpiler.scanImports` server-side, which is exact. Add a test with this two-line comment
  shape, and a test that the real-tree allowlist equals an independent crawl of main.js.
- **Same grammar elsewhere (other owners, not this job):** `test/arch-scan.js` `importsOf` has the same pattern and
  classifies these runtime imports as type-only, so `test/architecture.test.js` under-reports runtime imports.
  Worth a note to its owner.

## LOW

- **L1. Lowercase method gets an empty reply.** `get /main.js HTTP/1.1` on a raw socket gets no status line. Bun's
  parser, not static.js; no hang, the socket closes.
- **L2. Absolute `src`/`href` in index.html is skipped, not followed.** A scratch root with
  `<script src="/main.js">` logs `not a relative path`; main.js is still served only because it is a fixed entry
  (`server/static.js:162`: index.html, style.css, main.js). Any other file referenced by an absolute path from
  index.html would be 404. Safe and logged; the real index.html uses relative `style.css` and `main.js`
  (`web/index.html:7,34`). Document it so nobody adds an absolute reference and gets a silent 404.
- **L3. ETag costs a full read and sha-256 on every request, 304s included.** See Cost. Fine for M2; a cache keyed
  on (mtime, size) is the M4 lever.

## 1. Security (live server, raw sockets; every probe below gave 404 unless noted)

| Probe family (each listed probe ran) | Result |
|---|---|
| `/../server/main.js`, `/..%2fserver/main.js`, `/%2e%2e/...`, `/%2E%2E/%2E%2E/etc/passwd`, `/%252e%252e/...`, `/packages/core/../../server/main.js` and its encoded form | 404 |
| Backslash (`/..\server\main.js`, `/%5c..%5c...`), NUL (`/main.js%00`, `/main.js%00.html`), `//etc/passwd`, `///main.js`, `/main.js/`, `/main.js;x`, absolute filesystem paths (`/Users/.../server/main.js`, `/etc/passwd`) | 404 |
| Unicode: fullwidth `/．．/server/main.js` raw and percent-encoded | 404 |
| Encoded ordinary letters (`/ma%69n.js`, `/%6dain.js`, `/main%2ejs`) | 404 (safe; also never needed by a browser) |
| Case variants on macOS: `/MAIN.JS`, `/Main.js`, `/INDEX.HTML`, `/DEV.html`, `/Dev.js`, `/COLLAB/dom.js`, `/Adapters/transport/local.js`, `/adapters/Transport/Local.js`, `/adapters/auth/FAKE.js` | 404 |
| Dotfiles and secrets: `/.env`, `/%2eenv`, `/.git/config`, `/.gitignore`, `/../.env` | 404 |
| Deny list and dev files: `/dev.html`, `/dev.js`, `/adapters/transport/shared-worker/client.js`, `/adapters/storage/memory.js`, `/adapters/auth/fake.js`, `/adapters/clock/virtual.js` | 404 |
| Outside the mounts: `/server/static.js`, `/test/arch-scan.js`, `/docs/m2/PLAN.md`, `/package.json`, `/packages/core/SOURCE.json`, `/packages/protocol/PROTOCOL.md`, `/web/main.js` | 404 |
| Long paths: a deep `/a/` x 5000 path; a ~70 KB name (`/main.js` + 70,000 `x`) | 404; connection reset by Bun (header limit), server stays up |
| `*` request target; `http://127.0.0.1/../server/main.js` | 400; 404 |
| POST, PUT, DELETE, OPTIONS, PATCH, TRACE, CONNECT, PROPFIND on `/main.js` | 404 |
| HEAD `/` | 200, headers only |
| HEAD on `/dev.html`, `/adapters/transport/local.js`, `/%2e%2e/server/main.js`, `/..%2fserver/main.js`, `/.env` (in-process `handle`) | no static response, so the server's JSON 404 |

These returned 200, and each serves an allowlisted file, so none is a leak: `/./main.js` and `/index.html/..`
(Bun normalizes the path), `/main.js?x=1` and `/main.js#x` (query and fragment ignored), and
`GET http://evil/main.js` (absolute-form target).

**Symlinks** (scratch root, `staticSite({mounts})`):

| Case | Result |
|---|---|
| `web/leak.js` -> `../outside/secret.js`, imported by main.js | not served; logged `symlink leaves its root` |
| `web/out` -> `../outside` (directory), `/out/secret.js` imported by main.js | not served; logged `symlink leaves its root` |
| `web/lib/inner.js` -> `a.js` (inside the root) | 200, serves a.js |
| `lib/a.js` swapped for a link to outside **after** start-up | not served (the per-request realpath re-check works) |

**A denied file through a non-denied importer:** the live server's start-up log shows both denied imports from main.js
skipped, and `staticSite().handle` returns nothing (so the server's JSON 404) for `/adapters/transport/local.js` and
`/adapters/transport/shared-worker/client.js`, though main.js imports both. The builder's tests cover nested cases.

## 2. Precedence

| Route | Result |
|---|---|
| `GET /health` | 200 JSON, unchanged |
| `GET /ws` without upgrade | 426 |
| `POST /boards` without a token | 401 `{"error":"auth"}` |
| `GET /auth/login` | 302 |
| `GET /` | 200 index.html (static is the fallback, after the http routes and before the JSON 404) |

## 3. Headers (GET `/`, `/main.js`, `/style.css` through `staticSite().handle`; HEAD `/` on the live server)

All six headers below were dumped for each of the three files.

| Header | Result |
|---|---|
| Content-Security-Policy | identical to p-serve.md lines 33-35 joined with single spaces (string compare) |
| X-Content-Type-Options | `nosniff` |
| Referrer-Policy | `no-referrer` |
| Content-Type | `text/html; charset=utf-8`, `text/javascript`, `text/css` |
| Cache-Control | `no-cache` |
| ETag | strong (no `W/`), sha-256 base64url |
| `If-None-Match` with the current ETag | 304 |

## 4. Allowlist against the real web/

38 files served. An independent crawl of main.js and index.html with `Bun.Transpiler.scanImports` differs only in:

| File | Why it is missing | Verdict |
|---|---|---|
| `web/adapters/transport/local.js`, `web/adapters/transport/shared-worker/*` | denied | correct |
| `packages/protocol/room.js`, `ports.js` | reached only through adapters/transport/local.js | correct |
| `web/ports/storage.js` | H1 | **bug** |

`packages/protocol/codec.js` is not served today only because `web/adapters/transport/ws.js` is not imported by
main.js yet; `scanModule(ws.js)` finds codec.js correctly, so it will be served once client wires ws.js.

## 5. Hexagonal

`server/static.js` imports only `node:fs`, `node:crypto` and `node:path` (`server/static.js:28-30`) (no room host, gateway, driven adapter or
core logic). `test/architecture.test.js` is green (see Gates; mind H1's note that its scanner shares the bug).

## 6. Cost (for M4)

`ab -k -c 50 -n 20000` on the same laptop (so the client shares the CPU); server CPU from `ps -o time`.

| Request | req/s | Server CPU per request |
|---|---|---|
| `/health` (baseline) | 30.8 k | ~17 µs |
| `/main.js` (2.9 KB) | 28.6 k | ~37 µs |
| `/style.css` (21 KB) | 21.0 k | ~50 µs |
| `/main.js` with a matching `If-None-Match` (304) | 27.0 k | ~34 µs |

The 304 costs almost as much as a 200 because the file is read and hashed every time (L3). For a 100k-viewer join in
2 minutes (~40 modules each, mostly 304s once cached) that is ~4 M requests, about 2–3 CPU-minutes per node: fine
behind a CDN or with a (mtime, size) ETag cache, worth measuring in M4.

## Cleanup

Server PID 70914 killed by PID (`kill -0 70914`: no such process); scratch data, scratch roots and scripts deleted.
