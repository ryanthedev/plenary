# Report: p-servev2 (re-verify p-serve after round 2: the import scanner fix)

Verifier t1gm, 2026-11-12. Tree: shared main, job uncommitted. I changed nothing in the tree except this report.
Attacks and mutations ran in a scratch copy (rsync, no .git, no node_modules, no .env) and against my own server.

Files verified (sha-256, first 16 hex; the copy matched the shared tree byte for byte at the end):
`server/static.js` e8651e06ec0fcd8a, `test/server/static.test.js` 307d05d994a993ff, `git diff -- server/server.js`
98970a8431009cb5.

## Verdict: PASS. 0 HIGH, 1 MEDIUM, 4 LOW.

H1 is gone. The scanner now uses Bun's parser, so comments, strings, template literals and regex literals can't hide an
import. The real-tree allowlist equals my own crawl with a different parser (acorn): 41 files, no differences.
`/ports/storage.js` is served. Round 1's guarantees still hold.

The MEDIUM is not new: round 1's code has it too. The deny list is checked on the URL path, not on where a symlink
resolves, so a symlink inside a mount that points at a denied file is served. A request alone can't trigger it.
Someone has to put a symlink into web/ or packages/ (today there are none) and import it, or swap one in while the
server runs. That is why I rate it MEDIUM and not HIGH. t18m may overrule.

## Gates

| Gate | Result |
|---|---|
| `bun test` (shared tree) | 1083 pass, 112 skip, **1 fail**, 63 files, 111.5 s |
| The 1 fail | `test/core-source.test.js` "packages/core is still herdr-draw's core": core has drifted from the herdr-draw checkout. **Not this job's.** It fails the same way in the copy with static.js removed and its mount taken out of server.js (1 pass, 1 fail). The test imports no server code. |
| `test/server/static.test.js` + `test/architecture.test.js` | 35 pass, 0 fail |
| Live server start-up | `static: serving {"files":41,"skipped":0}` |
| sdd ensemble | codex (effort high) + grok. No finding from both. See Ensemble. |

## MEDIUM

### M1. A symlink inside a mount that points at a denied file (or at an unimported file) is served

- **Where:** `server/static.js` `add()`: `denied(at.url)` tests the URL of the link, not the real path. In `handle()`,
  the per-request check (`roots.some(m => r.startsWith(m.real + sep))`) accepts a real path under **any** mount.
- **Not a regression:** round 1's static.js gives the same three results below.
- **Precondition:** write access to web/ or packages/. Today the tree has 0 symlinks (`find web packages -type l`).
  The brief says deny-list files are "never served even if reached". This breaks that, but no request can cause it.
- **Repro** (scratch root, run from the repo):
  ```js
  // bun repro.js /tmp/some-new-dir
  import { mkdirSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
  import { staticSite } from "./server/static.js";
  const R = process.argv[2]; const put = (p, t) => { mkdirSync(R + "/" + p.split("/").slice(0, -1).join("/"), { recursive: true }); writeFileSync(R + "/" + p, t); };
  put("web/index.html", "<p>"); put("web/main.js", `import "./a.js"; import "./b.js"; import "./lib/devlink.js";`);
  put("web/a.js", "A"); put("web/b.js", "B"); put("web/dev.js", "DEV"); put("web/collab/dom.js", "COLLAB"); put("packages/core/unused.js", "UNUSED");
  mkdirSync(R + "/web/lib"); symlinkSync("../dev.js", R + "/web/lib/devlink.js");
  const s = staticSite({ mounts: [{ url: "/", dir: R + "/web" }, { url: "/packages/core/", dir: R + "/packages/core" }] });
  const get = async p => (await s.handle(new Request("http://x" + p)))?.status ?? 404;
  console.log(await get("/lib/devlink.js"));                                            // 200 (serves web/dev.js)
  unlinkSync(R + "/web/a.js"); symlinkSync("../packages/core/unused.js", R + "/web/a.js");
  console.log(await get("/a.js"));                                                     // 200 (another mount, not in the graph)
  unlinkSync(R + "/web/b.js"); symlinkSync("collab/dom.js", R + "/web/b.js");
  console.log(await get("/b.js"));                                                     // 200 (denied collab/, after start-up)
  ```
- **Fix suggestion:** in `add()`, also run `denied()` on the URL of the real path (`urlOf(realpath)`) and skip if it
  is denied or falls under a different mount. In `handle()`, require `realpathSync(file) === file` (the path stored
  at start-up) instead of "under any mount". Add tests for all three shapes.
- **Ensemble:** codex reported the post-start-up swap into another mount. I confirmed it and found the start-up
  variant and the denied-file variant.

## LOW

- **L1. A string or regex literal that reads like `new URL("./x.js", import.meta.url)` adds x.js.** This is known and
  documented by the builder (`server/static.js`, comment above `transpiler`). I checked the brief's question: it
  **cannot** add a file outside the mounts or past the deny list. In a planted main.js, string, template and regex
  forms aimed at `../server/secret.js`, `/etc/passwd`, `../outside/x.js`, `./dev.js`, `./collab/x.js`,
  `./adapters/auth/fake.js`, `./adapters/clock/virtual.js`, `./.env.js` and a symlink leaving the root were all
  skipped and logged. Only `./overmatch.js` (inside web/, not denied) was served. Real tree: 2 test files contain such
  strings (`test/architecture.test.js`, `test/server/static.test.js`); neither is in the page graph. codex rated this
  MEDIUM; I rate it LOW because the bound holds.
- **L2. Two non-literal forms are silently dropped (not served, not logged).** The brief says an import that can't be
  resolved statically must be logged. `DYN_ANY` skips any `import(` that starts with a backtick, and `NEWURL` only
  matches a plain literal:
  ```sh
  bun -e 'import {scanModule} from "./server/static.js";
    for (const s of ["await import(`./${n}.js`)", "new URL(v, import.meta.url)", "new URL(`./${n}.js`, import.meta.url)"])
      console.log(JSON.stringify(scanModule(s)))'
  # {"specs":[],"computed":[]}   three times (expected: a computed entry each)
  ```
  This fails closed (no over-serving), and the real tree has none of these. The builder's round 1 risk text says
  `new URL(variable)` "is left out (and logged)"; it is left out but not logged.
- **L3. A test gap: nothing pins "regexes run on comment-free output".** Mutation: in `scanModule`, replace
  `const code = transpiler.transformSync(src);` with `const code = src;`, so a commented-out
  `// new URL("./x.js", import.meta.url)` or `// import(x)` would count. All 19 static tests still pass. Add a
  commented `new URL(...)` to the scanner test.
- **L4. `/sub/../main.js` gets 200.** Bun normalizes the path before the handler sees it, so this serves the
  allowlisted `/main.js`. It is the same class round 1 accepted (`/./main.js`, `/index.html/..`). It is not an escape.
  Reported by codex; confirmed with a raw socket.

## 1. H1 is gone

`scanModule` on every comment shape from the brief (one string per shape, each followed by
`import { X } from "./real.js"`):

| Shape | Specs found |
|---|---|
| line comment with "import" | `./real.js` |
| two-line comment (the real trigger in `web/adapters/storage/session.js`) | `./real.js` |
| block comment `/* import foo\n from */` | `./real.js` |
| JSDoc `@type {import("./typeonly.js").T}` | `./real.js` only |
| string, template literal, regex literal containing `import x from './fake.js'` | `./real.js` only |
| also found correctly | `export * from`, `export * as ns from`, `import ... with { type: "json" }`, `import(\`./dt.js\`)`, top-level `await import("./x.js")`, side-effect imports, unused named imports |

**Real tree, independent crawl.** I wrote my own crawler with **acorn 8.19** (a different parser from Bun's). It walks
ImportDeclaration, ExportAll/ExportNamed with a source, ImportExpression with a literal, and
`new URL(literal, import.meta.url)`. It starts from index.html's relative src/href, style.css and main.js, applies the
deny list (my own copy of the rules), and stops at denied files.

| | Count | Difference |
|---|---|---|
| My crawl (shared tree, at server start) | 41 | |
| `staticSite().files` (copy) | 41 | none |
| Live server start-up `files:` | 41 | none |

No deny-list file is reachable from main.js today (client removed the two denied imports).

Repo-wide: `scanModule` against acorn over all 187 .js files gave 2 differences. Both are L1 (a `new URL(...)` text
inside a string in a test file).

## 2. New code paths

| Case | Result |
|---|---|
| String, template or regex literal aiming outside the mounts or at the deny list | skipped and logged (L1) |
| Unparseable module (`import {` at EOF; TypeScript `let x: number`) | logged `unparseable (its imports are not served)`; its imports 404 (`/after-broken.js`, `/after-ts.js`); the server keeps starting; the file itself is served (it is in the graph) |
| Computed `import(n)` | logged |
| Computed template `import(\`./${n}.js\`)`, `new URL(v, ...)` | dropped, not logged (L2) |

## 3. Round 1's guarantees (live server, raw sockets)

| Check | Result |
|---|---|
| 51 traversal, encoding, case, dotfile, deny-list, outside-mount and long-path probes (round 1's list, plus `/packages/protocol/room.js`, `/packages/protocol/ports.js`, `/core/dev-users.js`, `/dev-main.js`) | all 404 (or 400) |
| POST, PUT, DELETE, OPTIONS, PATCH, TRACE, PROPFIND on `/main.js` | 404 |
| `/./main.js`, `/main.js?x=1`, `GET http://evil/main.js` | 200, as in round 1 (allowlisted file) |
| `GET *` | 400 |
| 70 KB path | connection reset by Bun; the server stayed up (`kill -0`) |
| Headers on `/`, `/main.js`, `/style.css`, `/packages/core/editor.js` | CSP string-equal to the brief; nosniff; no-referrer; MIME exact; `no-cache`; strong ETag equal to sha-256 base64url of the body |
| `If-None-Match`: same tag, `W/` tag in a list, other tag | 304 (empty body), 304, 200 |
| HEAD | 200, content-length equals the body size, empty body |
| Symlinks | a link inside the root to a sibling file: 200; a directory link leaving the root: logged and 404; a file swapped for a link to outside after start-up: 404. Gaps: M1 |
| `static: false` | covered by the test at `test/server/static.test.js:224` |

**Precedence:** `/health` 200, `/ws` 426, `POST /boards` 401. **Change since round 1:** `/auth/login` gave **503**
`{"error":"sign-in-unavailable"}` (round 1 saw 302). This is platform's route answering because Google was off in my
run (`google: false` at start-up), not static.js. Precedence is intact.

## 4. Mutation checks (in the copy)

Restoring round 1's regex scanner (`STAT`, `DYN`, `NEWURL`, `onComment` from round 1's static.js) in place of the
round-2 block: **4 tests fail**, 15 pass:

- `H1: a comment with the word import does not swallow the next real import (scanner)`
- `H1: through staticSite, the module behind such a comment is served (planted root)`
- `a module that doesn't parse is logged, and nothing it imports is served`
- `the real tree: the allowlist equals an independent crawl of web/main.js (Bun's bundler), minus the deny list`

Other mutations:

| Mutation | Tests that fail |
|---|---|
| drop the `NEWURL` loop | 2 (allowlist graph; scanners) |
| drop the computed-import log | 2 (logged-at-start-up; scanners) |
| run the regexes on raw source instead of `transformSync` output | **0** (L3) |

The copy's static.js was restored and `cmp` clean against the shared tree afterwards.

## 5. Manual run

`PORT=0 PLENARY_DATA_DIR=<scratch> PLENARY_DEV_TOKENS=<one editor> bun /Users/r/repos/plenary/server/main.js`, started
from a scratch cwd (so Bun doesn't load the repo's .env), with `DATABASE_URL` and `NATS_URL` unset. PID 88610,
port 57746.

- `GET /`: 200 `text/html; charset=utf-8`.
- Every file of my crawl (41 URLs) fetched with curl: all 200.
- `/ports/storage.js`: 200.
- Start-up `files: 41`, which equals my crawl.

## 6. Hexagonal

static.js imports only `node:fs`, `node:crypto` and `node:path`, plus the `Bun` global. There is no room host, gateway,
driven adapter or core import. `test/architecture.test.js` is green. Systems-design CHECKER: not run as a formal pass.
This is a stateless read-only adapter; the design checks that matter here (failure mode is fail-closed 404, no shared
state, cost per request) are covered above and in round 1's Cost section.

## 7. Ensemble

`check_adapter`: codex ok, grok ok. agy failed (quota exhausted, resets in ~55 h). kimi failed (no model configured,
not logged in). mistral failed (no `MISTRAL_API_KEY`). qwen is not installed. Each harness got its own copy of the
three files.

| Finding | codex | grok | Verdict |
|---|---|---|---|
| String literal `new URL(...)` adds an unimported file | MEDIUM | none | **confirmed, bounded** (L1) |
| Swap to a symlink into another mount after start-up is served | MEDIUM | none | **confirmed**, and wider (M1) |
| `/sub/../main.js` normalized to `/main.js`, 200 | LOW | none | **confirmed**, same class round 1 accepted (L4) |

grok reported no findings. No finding came from two harnesses, so there is no HIGH candidate from the ensemble.

## Not verified

- No browser load of the page (CSP in a real browser, module graph actually booting).
- Cost: not re-measured. Round 1's L3 (a hash on every request) is unchanged.

## Cleanup

Server PID 88610 had already stopped when I went to kill it (`kill -0`: no such process). Its log ends with a clean
`server stopped` at 13:57:25Z, after every live probe above had finished. I didn't send that signal and don't know
who did. I killed nothing else; another session's `server/main.js` (a different PID) is still running. Scratch copy,
plants, data dir and probe scripts deleted.
