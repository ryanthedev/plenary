# Report: p7-archtest (J4 of p7-audit: architecture tests that bite, and core over a real-ish socket)

**Done. C-10, C-14 and the test side of C-16 are covered, and every audit mutant now fails a test.** I added one
skipped test, marked C-16. It waits on engine's static.js, which is missing four dev modules from DENY (below).

- **Who:** worker plenary-p7-archtest, manager t14k. Nothing committed.
- **`bun test` (full):** 1242 pass, 138 skip, 1 fail.
  - **The one fail is not mine:** "packages/core is still herdr-draw's core". It also failed on my baseline run.
  - **A second baseline fail was flaky:** the Store contract fence test. It failed on one of two baseline runs and passed on the final run.
  - **Skips I added:** 1 (C-16, below). The rest are pre-existing.
- **My files:** `bun test test/web/architecture.test.js test/web/core-runtime-globals.test.js test/web/adapters/ws-sync.test.js` gives 59 pass, 1 skip, 0 fail.

## Files

| File | What |
|---|---|
| test/web/architecture.test.js (changed) | Static rules for C-14, the `{ urls: true }` scan everywhere, the single DEV_MODULES list checked against DENY (C-16) |
| test/web/core-runtime-globals.test.js (new) | C-14 runtime check: imports every web/core module and drives sessions in a child bun process with the globals stubbed |
| test/web/adapters/ws-rig.js (new) | C-10 rig: real `wsTransport` over a fake WebSocket that delivers asynchronously, bridged to a localRoom |
| test/web/adapters/ws-sync.test.js (new) | C-10 tests: proofs that the rig is async, the collab contract over ws, and ported convergence scenarios |

No file under web/, server/, packages/ or test/arch-scan.js was touched.

## 1. C-14: architecture tests that bite

**Static (architecture.test.js):**

- **`{ urls: true }` everywhere:**
  - `checkBoundaries` and `webViolations` see `new URL("…", import.meta.url)` edges (kind "url").
  - The production graph (`runtimeGraph`) follows URL edges as well as runtime imports.
  - A URL edge to a composition root (shared-worker client → worker.js) is allowed, as arch-scan already allows it, but never from core.
- **New core tokens:** `Function(`, `eval` and `import.meta`.
  - `Function("return this")()` reaches every global, and eval runs code no scan sees.
  - Core never needs a module URL; today's core has none of the three.
- **`computedImports`:** flags any `import(` in core or ports whose specifier is not a literal (a quoted string, or a template with no `${}`). It runs on the `codeOnly` text, so comments, JSDoc types and strings don't count.
- **Synthetic-source cases** keep each new rule's mutants in the repo, as the file already does.

**Runtime (core-runtime-globals.test.js):**

- **Stubbed globals:** `Date.now`, `Date()`/`new Date()`, `Math.random`, set/clear Timeout/Interval, `queueMicrotask`, rAF/cAF, `document`, `window`, `location`, `history`, `navigator`, `localStorage`, `sessionStorage`, `indexedDB`, `crypto`, `performance`, `fetch`, `WebSocket`, `Worker`, `SharedWorker`.
- **Attributed by caller:** a stub records and throws only when the calling stack frame is under web/core/. Every other caller (packages/core, packages/protocol, adapters, bun) gets the real global, since this rule is core's alone.
- **Hits are recorded before the throw,** so core code that swallows it with `try {} catch {}` is still caught (mutant M1 below swallows it).
- **Why a child process:** bun shares one module cache across test files, so a module another test already imported would never re-run under the stubs. Stubbing timers in the runner's own process would also break the runner.
- **What the drive covers** (the test asserts `live`, `converged`, `resynced`, `reconnected`, `signed-in` and `outboxSent`, so a vacuous pass would fail):
  - **Imports:** all 11 web/core modules, with the stubs already in place.
  - **Sessions:** three `createSession`s (owner, annotator, viewer) on a localRoom with the virtual clock. Covered: welcome, a shape, a note, a nudge, presence, a records thread, a refused op and resync, dropped connections with backoff (`clock.random`), and a compaction with snapshot catch-up.
  - **Sign-in:** `readStored`, `devSignIn`, `takeSignIn` (including the 503-then-jittered-retry path), `pageSignIn`, `signInNotice`, `signOut`.
  - **roles.js:** every export.
  - **collab/\*:** `createPresence` (ingest, here, emotes, float, prune past expiry, view, leave), `createOutbox` (cursor, select, laser, emote, the 10 s repeat, reset, resume), `recordProblem`, `recordsView`, `newRecordId`, `notesView`.

## 2. C-16 test side: one list of dev modules

- **One list:** `DEV_MODULES` in architecture.test.js, each entry with a reason; `isDevModule` is derived from it.
  - **Added:** web/adapters/storage/memory.js.
  - **Also covered:** the existing patterns now explicitly include web/dev-main.html and web/dev-main.js.
- **Checked against static.js's `denied()` in both directions:**
  - **Live, shrink-only:** the dev files DENY misses must equal `DENY_GAPS_C16`. A new gap fails, and so does a gap engine fixes, until it is removed from the list.
  - **Reverse:** every web/ file DENY refuses must be on DEV_MODULES.
  - **Skipped, marked C-16:** "DENY refuses every dev-only module". Unskip it once engine lands the change below.
- **Each list entry must match a real file,** so a stale rule shows.

**For engine (static.js DENY: four dev modules are not denied today):**

| File | Why it matters |
|---|---|
| /dev-main.js | Not denied. Unserved today only because main.js doesn't reach it. |
| /dev-main.html | Not denied. Unserved today only because main.js doesn't reach it. |
| /core/dev-users.js | The dev token table. |
| /adapters/storage/memory.js | Test-only. |

Proposed lines:

```js
{ why: "web/dev*.js|html (dev pages and roots)", test: p => /^\/dev[^/]*\.(js|html)$/.test(p) },   // replaces the two /dev.html, /dev.js rules
{ why: "web/core/dev-users.js (dev token table)", test: p => p === "/core/dev-users.js" },
{ why: "web/adapters/storage/memory.js (test store)", test: p => p === "/adapters/storage/memory.js" },
```

Better still: export the list from one place, as p7-audit proposed. Engine's call.

## 3. C-10: the core over ws.js

**The rig (test/web/adapters/ws-rig.js):** each connection is the production `wsTransport` over a `FakeWS`, whose far end is one `localRoom` link.

- **Every hop is a separate seeded step:** open event, uplink frame, room in, room out, downlink frame, close event.
- **Order:** FIFO per socket and direction (as on a WebSocket).
- **`bufferedAmount`:** grows on `ws.send` and shrinks only when a step hands the frame on. `hold(true)` stalls every uplink.
- **Drops come from the server side** (`serverClose`).
- **A `fail()` hook for `session.dropConnection`:** ws.js has none, a gap p7-wirev also found. The rig adds one, which server-closes that transport's own socket.
- **An async `settle()`:**
  - It owns the clock: it pumps the sockets and the room, yields microtasks (for ws.js's `failLater`), runs collab frames, and only then fires the next virtual timer.
  - It doesn't use localRoom's own `settle()`, which can't see frames in the sockets and would fire watchdogs mid-delivery.
  - It is bounded at 10 virtual minutes, so a link that never comes up fails the test instead of hanging it.

**Tests (ws-sync.test.js, 42):**

- **The rig is not secretly synchronous:**
  - The hello sits in ws.js's pre-open queue (the backlog is above 0, and nothing is on the fake wire) until the open event is pumped.
  - `bufferedAmount` is above 0 in flight.
  - ws.js never writes to a CONNECTING socket.
  - A held uplink pushes `bufferedAmount` past 16 KB, so the core's presence gate refuses (`sendPresence` returns false) and `congested()` tracks it. Releasing the uplink converges.
- **The collab port contract** (all 13 cases; round 1 said 22 by mistake, p7-archtestv) runs on the ws rig, as a third adapter run. Over ws, the contract's `drop()` delivers the close event before `during()`, because the client only knows of a drop once the close arrives.
- **Convergence ported from test/web/sync.test.js** (inline there, a file I don't own):
  - The seeded interleave with every tool (5 seeds).
  - The refusal + resync GATE matrix: 4 refusals × entries/snapshot catch-up × seeds 1–2.
  - An edit inside the resync window (3 seeds).
- **New:** a server-side socket close with ops pending. The core reopens over a new socket, resends and converges (3 seeds).

## 4. Proof the tests bite (mutants, in a scratch git worktree, since removed)

The shared tree was never mutated. Each mutant ran on a clean copy against the two C-14 files. The control (no mutant)
gave 17 pass, 0 fail.

| Audit mutant (p7-audit C-14) | Where | Fails |
|---|---|---|
| M1 Date alias, `try { const D = Date; D.now(); } catch {}` (swallowed) | session.js `createSession` | runtime globals |
| M2 `Math["random"]()` | session.js `createSession` | runtime globals |
| M3 computed `import("../adapters/storage/" + "local.js")` | session.js `createSession` | no computed import() |
| M4 `Function("return this")().setTimeout(…)` | session.js `createSession` | static globals (`Function(`), runtime globals |
| M5 `new URL("../adapters/storage/local.js", import.meta.url)` | sync.js, module level | checkBoundaries, web/ rules, static globals (`import.meta`) |
| M6 `new URL("../transport/local.js", import.meta.url)` | dom/app.js | production graph (dev module), checkBoundaries, web/ rules |

**Extra mutants on ws.js, run against ws-sync.test.js:**

| ws.js mutant | Result |
|---|---|
| `onclose` ignored | 2 fail: contract drop and role change |
| The pre-open queue loses its first message (the hello) | Fails fast across the file |
| `bufferedAmount` left out of the backlog | 1 fail: the held-uplink test |

## Systems design (APPLIER, light)

- **Scope:** a test job, so the skill was applied to the rig's failure model, not to production design.
- **Failure modes the rig models:**
  - async connect (pre-open queue);
  - a slow uplink (backpressure, the presence gate);
  - an unasked server close mid-op (resume and resend);
  - interleaved delivery across links.
- **Not modelled:** a half-open link that goes silent with no close (C-4/E-1). The Replica has no idle deadline yet, so a test would only restate the bug. Add one with E-1.

## Not verified / risks

- **The runtime check sees only what the drive executes.** A core global on a path the drive never runs (e.g. a rarely taken error branch) still passes it. The static rules are the backstop for literal names.
- **Caller attribution reads bun's stack format** (`(path:line:col)`). If bun changes it, attribution finds no core frame and the check passes silently. The `drove` asserts don't catch this. The mutants caught it on bun 1.x today.
- **The ws rig is a model, not a browser.** Real-browser timing still comes only from the headless Chrome runs.
- **`fail()` exists only in the rig.** On the production page, `S.dropConnection()` still does nothing over ws (p7-wirev). That is J3's or J2's to fix, if wanted.
- **Not run:** the C-16 skipped test (by design).

## C-16 follow-up (422526c)

**C-16 is closed: static.js's DENY now refuses every module on DEV_MODULES, and the test that checks it is live.**

- **Engine's fix:** 422526c makes DENY refuse `/dev*.html|js`, `/core/dev-users.js` and `/adapters/storage/memory.js`. My shrink-only test then failed as designed (four gaps listed, none found).
- **Changed in test/web/architecture.test.js:**
  - **Removed:** the `DENY_GAPS_C16` list.
  - **Merged:** the shrink-only test and the skipped test are now one live test, "C-16: static.js's DENY refuses every dev-only module on DEV_MODULES". It asserts DENY misses nothing. It also keeps the sanity checks: memory.js, dev-users.js and dev-main.js are on the list, and every rule matches a real file.
  - **Kept:** the reverse check (every web/ file DENY refuses is on DEV_MODULES).
- **The three job files:** 59 pass, 0 skip, 0 fail. The count stays at 59 because two tests became one.
- **`bun test` (full):** 1242 pass, 137 skip, 1 fail. The fail is the same one as before: "packages/core is still herdr-draw's core", which also failed on my baseline and is outside these files.

## Round 2 (verifier p7-archtestv FAIL: H1, H2, MED-1, MED-2, LOW 1/6/7)

**Every finding the brief named is fixed, and every surviving mutant from the verifier now fails a test.** I changed
test files only: core-runtime-globals.test.js, architecture.test.js and ws-rig.js.

| Finding | Fix |
|---|---|
| **H1** (the check could pass vacuously) | **Two positive controls.** (1) The parent writes `<tmp>/web/core/probe.js`, which reads `Date.now`, `Math.random`, `setTimeout`, `Intl` and `setImmediate`. The child runs the same traps and attribution rooted at that tree, and must record exactly those 5 hits at `web/core/probe.js`. (2) The same probe with a stack the stubs can't parse: every hit must be recorded as `<unparsed stack>`. An unparseable stack is now a recorded hit, never "not core". |
| **H2** (an aliased global handed to a package escaped) | **Traps the read, not the call.** `Date`, `Date.now`, `Math.random`, `Intl`, every timer (including `setImmediate`/`clearImmediate`), `queueMicrotask`, rAF/cAF and the DOM/browser globals are accessors with the caller-attributed getter. Attribution is still the accessing frame only, never any frame on the stack (the verifier showed that gives false hits in packages/core). |
| **MED-1** (a drive that died partway still passed) | `expect(r.drove.error).toBeUndefined()`, plus `drove.finished`, set as the drive's last line and asserted. |
| **MED-2** (a regex literal holding `//` hid the rest of its line) | **`codeOnly` now knows regex literals.** A `/` where an expression may start (after an operator, `(`, `,`, `=` …, or a keyword such as `return`) opens one. Its body is blanked like a string's, honouring escapes and `[...]` classes. A `/` after a value still divides. 7 synthetic cases cover it, including division and a regex body that mentions `Date.now`. |
| **LOW 1** (unstubbed globals) | `Intl` and `setImmediate`/`clearImmediate` are trapped. `Date.prototype`'s locale methods are not wrapped: core can't hold a Date without reading `Date` (trapped), short of a package handing it one. |
| **LOW 6** (DENY cross-check skipped nested HTML) | The DEV_MODULES/DENY cross-checks list HTML at any depth under web/. `web/collab/dev.html` is now asserted on both lists. |
| **LOW 7** (FakeWS fidelity) | `FakeWS.send` throws only on CONNECTING; on CLOSING or CLOSED it drops the frame silently, as a browser does (counted in `stats.sendsAfterClose`). |

**Not done (verifier LOW 2–5, 8; not in the brief):**
- **A microtask hand-off:** contrived, and no frame is in core.
- **Cold paths:** a runtime check can only see what the drive runs.
- **A computed import in an adapter:** static.js can't serve it anyway.
- **`new URL` with an absolute path:** that is arch-scan's grammar, not my file.
- **A dev-like file outside DEV_MODULES:** by design, the list is the definition.

**Side note for the protocol owner (from the verifier, not checked by me):** packages/protocol/replica.js:31 builds the
session id with `Math.random()` even when the caller injects `random`.

### Mutants, round 2

They ran in a scratch worktree (HEAD plus my 4 files; since removed), each on a clean copy, against
architecture.test.js and core-runtime-globals.test.js. My first runner let mutants pile up (a `git checkout` named a
file HEAD lacks), so I fixed it and re-ran everything from clean. These are the clean results.

| Mutant | Result |
|---|---|
| Control (no mutant) | 19 pass, 0 fail |
| H2 Editor alias: `const D_ = Date; const edClock = D_.now;` (session.js) | **killed:** runtime |
| H2 Replica hand-off: `random: M_.random` (sync.js) | **killed:** runtime |
| MED-2 `const r_ = /\//; … import(board) … Date.now()` (session.js) | **killed:** static globals, computed import(), runtime |
| V7 `new Intl.DateTimeFormat().format()` (session.js) | **killed:** runtime |
| V8 `setImmediate(() => {})` (session.js) | **killed:** runtime |
| M1 Date alias (swallowed) | **killed:** runtime |
| M2 `Math["random"]()` | **killed:** runtime |
| M3 computed `import()` of an adapter | **killed:** computed import() |
| M4 `Function("return this")().setTimeout` | **killed:** static globals, runtime |
| M5 `new URL` to an adapter in sync.js | **killed:** checkBoundaries, web/ rules, static globals |
| M6 dev module by `new URL` from dom/app.js | **killed:** checkBoundaries, web/ rules, production graph |
| H1 test-side: the stack regex no longer matches | **killed:** main check (drive hits), probe control |
| H1 test-side: CORE points at `web/kore` | **killed:** both probe controls |
| H1 test-side: `Math.random` not trapped | **killed:** probe control |
| MED-1 test-side: the drive throws after `outboxSent` | **killed:** main check (`drove.error`) |

### Counts, round 2

- **The three job files:** 61 pass, 0 skip, 0 fail. That is 59, plus the 2 positive controls.
- **`bun test` (full):** 1274 pass, 137 skip, 1 fail.
  - **The fail:** "packages/core is still herdr-draw's core", the same pre-existing drift as before. The verifier traced it to uncommitted edits in herdr-draw.
  - **The pass count rose** because other tracks landed tests too.
