**Round 2: PASS** — both HIGHs and both MEDIUMs from round 1 are fixed and each mutant is killed; 2 new MEDIUM, 4 LOW, no HIGH (see "Round 2" at the end).
Round 1 was **FAIL**: 2 HIGH (both in the C-14 runtime check, test/web/core-runtime-globals.test.js), 2 MEDIUM, 8 LOW. C-10 (ws rig) and C-16 passed.

# Verify: p7-archtestv (architecture tests that bite, and the core over a ws rig)

- **Who:** verifier plenary-p7-archtestv, manager t14k. Read only on the shared tree.
- **Where mutants ran:** scratch worktrees under my scratchpad (`wt`, `rev`, `w3`), built from HEAD plus the job's 4 files. The worktrees were removed at the end.
- **Versions judged:**
  - **Checks 1, 2 and 4–7:** the builder's version.
  - **Check 3 (C-16):** t1h4's follow-up on top of engine's 422526c, as t14k asked: no `DENY_GAPS_C16`, no skip.

## Findings

### HIGH

**H1. The runtime globals check goes silently vacuous, and nothing guards against it** (test/web/core-runtime-globals.test.js:55-77).
- **What:** a hit is recorded only when `callerFile()` parses a stack frame that starts with `CORE`. Nothing proves the stub-and-attribute pipeline can record a hit at all. The `drove` asserts only prove the drive ran.
- **Shown, with audit mutant M1 (`const D = Date; D.now()` in session.js) present:**

  | Break | Result |
  |---|---|
  | The stack regex no longer matches (stands in for a change in bun's stack format) | 1 pass, 0 fail |
  | `CORE` points at a renamed folder (`web/kore`) | 1 pass, 0 fail |
  | The `Date` and `Math.random` stubs are not installed | 1 pass, 0 fail |
  | The repo is reached through a symlinked path (`/tmp` → `/private/tmp`) | M1 is still caught (bun reports real paths), so this case is fine |

- **Fix (test only):** add a positive control.
  - The parent writes a probe module to a temp dir laid out as `<tmp>/web/core/probe.js` that calls `Date.now()`, `Math.random()` and `setTimeout`.
  - The child runs the same `check` logic against that root and must record exactly those hits.
  - Also fail when a stub sees a stack it cannot parse.

**H2. A global handed from core to a package escapes both checks** (core-runtime-globals.test.js:57-77; architecture.test.js `CORE_GLOBALS`).
- **What:** attribution looks only at the immediate caller. When core passes an aliased global into packages/core or packages/protocol, the call happens in a package frame, so nothing is recorded. The aliased read itself gets past the token scan.
- **Mutant that survives both C-14 files (17 pass, 0 fail):**
  ```js
  // web/core/session.js:38: the Editor's clock becomes the wall clock, not the clock port
  const D_ = Date; const edClock = D_.now;
  ```
  The Editor (packages/core/editor.js:220) calls it. This is the exact leak C-14 is about: core wiring real time instead of the port. The same works for `new Replica({ now: D_.now, random: M_.random })`.
- **Fix (tried in a worktree, works):** trap the read, not the call.
  - Make `globalThis.Date`, `Date.now` and `Math.random` accessor properties whose getters run the same caller-attributed `check`, as the test already does for `document` and `crypto`.
  - An alias is then caught where core takes it (`const D_ = Date` in session.js).
  - **Results:** clean tree passes (no hits, parent test 1 pass); the Editor-alias mutant is caught (`Date`, session.js); a Replica hand-off mutant (`random: M_.random` in sync.js) is caught (`Math.random`, sync.js).
  - **Also do it for the timers** (`setTimeout` and the rest), which are still plain properties.
- **A fix that does NOT work:** attributing a hit to any web/core frame anywhere on the stack.
  - **False hits:** it flags packages/core's own default reads, which this repo can't change (byte-identical herdr-draw core): model.js:26 and :48 (`newId`), and packages/protocol/replica.js:31.
  - **Misses the mutant anyway:** the Editor's clock call (editor.js:220) can run with no web/core frame on the stack.
- **Side observation (not this job's bug):** packages/protocol/replica.js:31 builds the Replica's session id with `Math.random()`, even when the caller injects `random`. Reached from web/core/sync.js:53. Worth a look by the protocol owner for determinism; Engram has nothing recorded on it.

### MEDIUM

**MED-1. A drive that fails partway still passes** (core-runtime-globals.test.js:45). Raised by codex; I confirmed it.
- **What:** the child catches any drive error into `drove.error`, but the parent never asserts on it.
- **Shown:** I added `throw new Error("late drive failure")` right after `drove.outboxSent` is set. Result: 1 pass, 0 fail. Everything after that point is silently undriven (recordProblem, recordsView, notesView, close).
- **Fix:** `expect(r.drove.error).toBeUndefined()`.

**MED-2. A regex literal containing `//` blinds the static scan for the rest of its line** (architecture.test.js `codeOnly`, used by `globalsIn` and the new `computedImports`). Raised by codex; I confirmed it.
- **Shown:** I added this line to session.js:
  ```js
  const r = /\//; import(board).catch(() => {}); const z = r && Date.now();
  ```
  Both the computed-import rule and the `Date.now` rule miss it: 17 pass, 0 fail.
- **Why MEDIUM, not HIGH:**
  - `codeOnly` predates this job and documents that it doesn't handle regex literals.
  - No core or port file has such a regex today (grep).
  - The runtime check catches the `Date.now` if that line runs. Only the computed import is fully blind.
- **Fix:** fail if core or ports contain a regex literal holding `//` or `/*`, or teach `codeOnly` regex literals.

### LOW

1. **Globals that are neither stubbed nor on the static list:**
   - `Intl.DateTimeFormat().format()` reads the wall clock. Mutant V7 survived.
   - `setImmediate` is a bun/node timer, not a browser one. Mutant V8 survived.
   - codex flagged `URLSearchParams` as MEDIUM. I refute that: it is pure, with no ambient state or time. LOW.
   - **Fix:** add `Intl` (wrap `DateTimeFormat` and `Date.prototype`'s locale methods) and `setImmediate` to the stubs.
2. **A global handed to a microtask** (`Promise.resolve().then(D_.now)`, mutant V11) has no core frame at all. Even any-frame attribution won't see it. It's contrived, so LOW.
3. **Cold paths:** a core global on a path the drive never runs survives (mutants V12, and V16 at module level in roles.js). The builder disclosed this. Out of scope for a runtime check.
4. **A computed `import()` in an adapter** (dom/app.js, mutant V15) is not flagged; `computedImports` covers only core and ports.
   - **Why production is still safe:** server/static.js only serves an allowlist built from main.js's import graph. It can't resolve a computed import, so the target is never served, and the miss is logged at start-up.
5. **`new URL("/abs/path.js", import.meta.url)` is not an edge.** arch-scan's grammar takes only `./` and `../`. Raised by codex; I confirmed it by reading test/arch-scan.js (the `REL` grammar), not by a mutant. arch-scan isn't this job's file.
6. **The DENY cross-check skips HTML below web/'s top level** (architecture.test.js `devFiles`/`all`). For example, web/collab/dev.html is never listed. It is denied today by the `/collab/` rule. Raised by codex; confirmed.
7. **`FakeWS.send` fidelity** (ws-rig.js:47-48): it throws on CLOSING/CLOSED. A browser throws only on CONNECTING and silently drops later sends. No effect today, because ws.js sends only when OPEN.
8. **A non-blocking quirk in t1h4's C-16 version:** a new dev-like file outside the `DEV_MODULES` patterns isn't flagged (`web/core/dev-extra.js` counts as core). That is by design: the list is the definition.

## Checks

### 1. Mutants

**The builder's mutants, re-run by me:**

| Mutant | Result |
|---|---|
| M1 `Date` alias, swallowed | Killed: runtime check |
| M2 `Math["random"]()` | Killed: runtime check |
| M3 computed `import()` | Killed: computed import() rule |
| M4 `Function("return this")().setTimeout` | Killed: static globals rule and runtime check |
| M5 `new URL` to an adapter in sync.js | Killed: checkBoundaries, web/ rules, static globals rule |
| M6 `new URL` to a dev module from dom/app.js | Killed: checkBoundaries, web/ rules, production graph |
| ws.js: `onclose` ignored | Killed: 2 fails |
| ws.js: the pre-open queue loses its first message | Killed: 42 fails |
| ws.js: `bufferedAmount` left out of the backlog | Killed: held-uplink test |

**My mutants:**

| Mutant | Result |
|---|---|
| `globalThis.setTimeout` | Killed: static and runtime |
| `self.crypto.randomUUID()` | Killed: static and runtime |
| `Reflect.get(globalThis, "Date").now()` | Killed: static and runtime |
| `const { now } = Date; now()` | Killed: runtime |
| `const { random } = Math; random()` | Killed: runtime |
| `new Function("return Date.now()")()` | Killed: static and runtime |
| `[].constructor.constructor("return this")().setTimeout` | Killed: runtime only (the static scan misses this route) |
| `[0].forEach(M.random)` (the call comes from a native frame) | Killed: runtime |
| A dev module by literal `import()` from app.js | Killed: 3 tests |
| A dev module by `new URL` in an adapter (storage/local.js → memory.js) | Killed: 3 tests |
| ws.js: something written to a CONNECTING socket | Killed: pre-open test |
| ws.js: the pre-open queue reversed | Survives ws-sync, but killed by the existing transport tests (3 fails). Not a gap. |
| Aliased `Date.now` handed to the Editor | **Survives: H2** |
| Late drive throw | **Survives: MED-1** |
| A regex literal hides a line | **Survives: MED-2** |
| `Intl`, `setImmediate`, a microtask hand-off, cold paths, a computed import in an adapter | Survive: LOW 1–4 |

### 2. Is the runtime check vacuous?

- **The child really runs:** the test spawns it with `PLENARY_CORE_GLOBALS_CHILD=1`, and a child failure throws in the parent.
- **The `drove` asserts work:** with the drive skipped right after the imports, the test fails (0 pass, 1 fail).
- **Attribution and stub installation are unguarded:** H1.
- **Stubbed globals reached through a package go unseen:** H2.

### 3. C-16 (t1h4's version on 422526c)

- **The four gaps were real, but unserved:** before 422526c, `denied()` returned null for all four. Fetched through test/server/rig.js on port 0, all four returned 404, as did `/dev.js`, `/collab/dev.html` and `/adapters/transport/local.js`. Controls `/main.js`, `/core/session.js` and `/adapters/storage/local.js` returned 200. They were unserved only because static.js serves main.js's graph, so DENY was defense in depth. That matches the builder's report.
- **Each DENY rule removed from static.js, one at a time:**

  | Rules removed | Result |
  |---|---|
  | Each of the 8 web dev-module rules (dev*, dev-users, memory, collab, shared-worker, local, fake.js, virtual.js) | The C-16 test fails every time |
  | Rule 9 (test/, docs/, server/, node_modules/) and rule 10 (dotfiles) | Not web/ dev modules, so they don't touch C-16. test/server/static.test.js catches each (4 fails) |

- **Other checks:**
  - **The reverse check still bites:** a DENY rule that refuses /core/session.js fails "every web/ file DENY refuses is on DEV_MODULES".
  - **A stale DEV_MODULES entry fails the C-16 test** (re-run on t1h4's version).
  - **A new web/dev-extra.js:** on t1h4's version DENY and DEV_MODULES both cover it, so C-16 passes, as it should. It still fails the existing "nothing unclassified" and checkBoundaries tests.
  - **No skip is left in test/web:** the remaining `skipIf`s are pre-existing contract opt-outs.
- **Builder's version, also checked earlier:** the shrink-only list failed both on a new gap and on a fixed gap. With engine's DENY lines applied, unskipping the test passed.

### 4. C-10 rig

- **Really asynchronous:**
  - The open, each uplink frame, each downlink frame and the close are each a separate seeded step.
  - The hello sits in ws.js's pre-open queue: a backlog above 0 with nothing on the wire. That is asserted.
  - `bufferedAmount` shrinks only on a step.
  - Delivery is FIFO per socket and direction (`shift`).
- **Drives the production `wsTransport` unmodified.** The wrapper only tags sockets and adds `fail()`. `fail()` is named and commented as rig-only (ws-rig.js:14-15, 142-149).
- **The collab contract and the ported convergence scenarios run on it.** The contract has 13 cases, not the 22 the builder reported (ws-sync.test.js runs 42 = 2 async proofs + 13 contract + 5 interleave + 16 GATE + 3 resync window + 3 server close). All 13 run on the rig.
- **More seeds, all green (96/96):** interleave seeds 6–30, GATE seeds 3–7, resync window and server close seeds 4–11.
- **`settle()` is bounded:** with the uplink held forever, it throws "ws network not settled after 600000 virtual ms" after 1 ms of real time.
  - **Two more dead-link probes** (the server swallows the hello, the socket never opens) recover to `live` through the core's watchdog and backoff. So they neither hang nor pass vacuously.
  - **Timers never fire mid-delivery:** `settle()` fires one only when no socket or room step is ready after two microtask yields and the frames are empty.

### 5. Tests only

- **The job's files are all under test/web/.** Shared-tree changes to web/, server/ and packages/ belong to other tracks (p7-perf, p7-chrome, engine's 422526c).
- **The architecture.test.js diff only strengthens rules:**
  - `importsOf` becomes `edgesOf` with URLs.
  - `runtime` becomes `loads(kind)`.
  - The one new exemption (a URL edge from non-core to a composition root) mirrors arch-scan's `checkBoundaries`.
  - No assertion was deleted.
- **No dependence on other tracks:** the job's tests pass on clean HEAD plus only its 4 files (59 pass).

### 6. `bun test`

- **Full suite on the shared tree (after 422526c and t1h4):** 1242 pass, 137 skip, 1 fail.
  - **The fail:** "packages/core is still herdr-draw's core". herdr-draw has uncommitted `core/editor.js` and `core/geometry.js` edits (`git -C herdr-draw status`). Not this job.
- **An earlier full run had 2 extra fails** in test/server/static.test.js. Engine was editing static.js mid-run; they were gone on the next run.
- **The job's 3 files:** 59 pass, 0 fail, run 8 times on the shared tree with identical results. The seeds are fixed, so the runs are deterministic.

### 7. sdd ensemble

- **Harnesses:**
  - **codex (effort high) and grok:** both passed check_adapter.
  - **agy:** failed check_adapter (quota exhausted: 429, resets in about 52 h).
  - Each reviewer ran in its own worktree.
- **codex** raised 5 findings:
  - **Confirmed:** regex literal (MED-2), `drove.error` (MED-1), nested HTML (LOW 6), absolute URL (LOW 5).
  - **Downgraded:** `URLSearchParams`, from MEDIUM to LOW.
- **grok** raised none, and it missed H1 and H2.
- **No finding had two harnesses agreeing.** Both HIGHs are my own, each shown by a mutant.

## Design check (CHECKER)

Applied the distributed-systems-design skill in CHECKER mode (its correctness and reliability checklists, with chapter 12's WebSocket and heartbeat criteria) to the rig's failure model and to the port boundary the tests guard.

- **Failure model of the rig:**
  - **Covered:** async connect, a slow uplink (backpressure and the presence gate), an unasked server close mid-op (reopen and resend), and interleaved delivery.
  - **Missing: a half-open link** (no close, silence). The core has no idle deadline yet (C-4/E-1), so a test would only restate the bug. Acceptable for M2 if E-1 adds both the deadline and a rig case (a `silence(ws)` that stops delivery without a close).
- **Real browser timing and bun's stack format:**
  - **Browser timing:** the rig is a model. Event-loop ordering in a real browser (task vs microtask between `onmessage` and rAF) is still covered only by the headless Chrome runs. Acceptable.
  - **Bun's stack format:** acceptable only with H1's positive control. Without it, a bun upgrade turns C-14's runtime half off silently.
- **Hexagonal angle:**
  - **What the static plus runtime pair proves:** core reads no ambient global itself.
  - **What it doesn't prove yet (H2):** that core never wires an ambient global into a package. That is the dependency rule's other half: the port must be the only source of time and randomness.
  - **packages/protocol/replica.js:30:** shows the packages themselves still default to globals. Defaults are fine, but a package that ignores an injected `random` is a determinism leak.

## What I did NOT check

- **Real browser runs:** I ran none (no headless Chrome).
- **Most static.js scan behaviour:** I didn't read static.js's scan code beyond DENY and `denied()`. I didn't test whether a computed import in an adapter is really logged at start-up (LOW 4 relies on static.js's own header comment).
- **Absolute-path `new URL`:** confirmed by reading arch-scan's `REL` grammar, not by running a mutant (LOW 5).
- **Other tracks' changes** to web/, server/ and packages/.
- **The collab contract's own cases:** I didn't review whether they're complete, only that all 13 run on the ws rig.
- **Other harnesses:** kimi, qwen and mistral were never probed with check_adapter. The ensemble was codex and grok only.
- **The getter fix in full:** tried in the child only, against the clean tree and two alias mutants. Not run with the timers trapped too, and not run through the whole suite.

## For the builder (smallest fix for FAIL → PASS)

1. **H1:** add the positive-control probe (a temp `web/core/probe.js` layout) and fail when a stub sees a stack it cannot parse.
2. **H2:** make `Date`, `Date.now`, `Math.random` and the timers caller-attributed getters (tried: it works, see H2). Keep the Editor-alias and Replica-alias mutants as regression cases.
3. **MED-1:** `expect(r.drove.error).toBeUndefined()`.
4. **Optional:** MED-2 guard, plus `Intl` and `setImmediate` stubs (LOW 1).

## Round 2

**PASS.** Every round-1 survivor is now killed: the H1 breaks, the H2 Editor-alias and Replica hand-off mutants, MED-1, MED-2, V7 and V8. No new mutant beats a rule the builder claims. There are 2 new MEDIUM (one is outside the claimed rule; the other is a partial MED-2 fix), plus 4 LOW. None is a HIGH.

- **What I judged:** builder t1h4's round-2 files: core-runtime-globals.test.js, architecture.test.js, ws-rig.js and ws-sync.test.js.
- **Where mutants ran:** a fresh scratch worktree on HEAD 426757d plus those 4 files. Each mutant ran on a clean copy, restored after. The worktree was removed at the end.
- **Control:** the 3 job files give 61 pass, 0 fail.

### Round-1 survivors, re-run

| Mutant | Round 2 |
|---|---|
| H1: the stack regex never matches (stands in for a bun stack-format change) | Killed: the main check and the probe control |
| H1: `CORE` points at `web/kore` | Killed: both probe controls |
| H1: `Math.random` not trapped | Killed: probe control |
| H1: `Date` not trapped | Killed: probe control |
| H1: no traps installed at all | Killed: both probe controls |
| H1: an unparsed stack treated as "not core" (mine, new) | Killed: the unparsed-stack control |
| H2: Editor alias (`const D_ = Date; const edClock = D_.now`) | Killed: runtime check |
| H2: Replica hand-off (`random: M_.random`) | Killed: runtime check |
| MED-1: the drive throws after `outboxSent` | Killed: `drove.error` |
| MED-2: `const r = /\//; import(board) … Date.now()` | Killed: static globals and computed import() |
| V7: `Intl.DateTimeFormat().format()` | Killed: runtime check |
| V8: `setImmediate` | Killed: runtime check |

### New mutants against the traps

| Mutant | Result |
|---|---|
| `Object.getOwnPropertyDescriptor(Date, "now").get.call(Date)()` | Killed: runtime (reading `Date` trips the trap) |
| `Reflect.get(Math, "random")()` | Killed: runtime |
| `const M_ = Math; Object.getOwnPropertyDescriptor(M_, "random").get()()` | Killed: runtime (the getter's caller is core) |
| A regex after `}` hides a computed import | Killed: computed import() |
| **Omission:** `new Replica({ client, now })` with no `random` passed | **Survives: R2-MED-1** |
| **Omission:** `new Editor({})` with no clock passed | **Survives: R2-MED-1** |
| A regex after `)`: `if (client) /\//.test(board); … import(board) … Date.now()` | **Survives: R2-MED-2** |
| A package exports a global's value (`export const __now = Date.now` in codec.js) and core calls it | Survives: R2-LOW-1 (purity.test.js doesn't catch it either) |
| `AbortSignal.timeout(5)`, `new MessageChannel().port1.postMessage(1)` | Survive: R2-LOW-2 |
| `Bun.nanoseconds()`, `process.hrtime()` | Survive: R2-LOW-3 (bun only; a browser has neither) |
| `k_++ / Date.now()` (a `/` after `++` read as a regex start) | Survives: R2-LOW-4 |

**False hits:** I added only legitimate builtin calls to core: `toLocaleString`, `localeCompare`, `sort`, `JSON`, `structuredClone`, `Promise.then`, `Map.forEach` and `Error`. None recorded a hit, so the trapped `Intl`, `Date` and timers aren't read by bun internals on core's behalf. The clean drive records no hits either, so packages/core's own reads (e.g. `newId`) are correctly left alone.

### Round-2 findings

- **R2-MED-1. A port left out by omission isn't caught** (core-runtime-globals.test.js; the C-14 intent, not its claimed rule).
  - **What:** if core simply doesn't pass the clock port's `random` to the Replica, or a clock to the Editor, the package falls back to `Math.random`/`Date.now`. That read happens in a package frame, so neither check sees it.
  - **Effect:** the core then runs on real time and randomness, the thing C-14 forbids. bindEditor's own guard only checks its arguments, not that they reach the Replica.
  - **Possible fix:** a second, narrower check. Record a hit when a package frame reads a trapped global while web/core is anywhere on the stack, with a shrink-only allowlist of the package lines that read globals by design. Round 1 found three: packages/core/model.js:26 and :48 (`newId`), and packages/protocol/replica.js:31.
- **R2-MED-2. The regex fix misses a regex after `)`** (architecture.test.js `codeOnly` → `regexMayStart`).
  - **What:** `)` counts as ending a value, so in `if (x) /\//.test(s)` the `/` is read as division and `//` then blanks the rest of the line as a comment. A computed `import()` and a `Date.now` later on that line both pass the static checks.
  - **Why MEDIUM:** MED-2's fix is partial. No core file has this shape today. The runtime check still catches the `Date.now` if the line runs, but never the computed import.
  - **Possible fix:** treat `)` as a regex start when the matching `(` follows `if`, `while`, `for` or `with`. Or simpler: fail when any core or port line holds `//` or `/*` after an unblanked `/` on the same line.
- **R2-LOW-1:** a package that exports a global's value. A package-side change would be needed, and packages are checked separately (purity.test.js, the protocol owner).
- **R2-LOW-2:** `AbortSignal.timeout` and `MessageChannel` are timer-like browser globals that are neither trapped nor on the static list. `postMessage` is on the static list, but only as a bare name, so `port1.postMessage` gets past it.
- **R2-LOW-3:** `Bun.nanoseconds` and `process.hrtime` are bun-only. Core code using them would fail in the browser anyway.
- **R2-LOW-4:** `x++ / y` is read as a regex start, which blanks `y`. Contrived.

### Other checks

- **Tests only:** the job's files are all under test/web/. The `-` lines of `git diff HEAD -- test/web/architecture.test.js` are only lines replaced with stronger versions (`importsOf` becomes `edgesOf`, `"runtime"` becomes `loads(kind)`, the old isDevModule becomes DEV_MODULES, plus the stale codeOnly comment). No assertion was dropped. The round-2 runtime test only adds asserts: `drove.error`, `finished`, and the two controls.
- **LOW 6:** HTML at any depth under web/ is listed now, and `web/collab/dev.html` is asserted on both lists. **LOW 7:** FakeWS throws only on CONNECTING and drops sends after close. Both confirmed by reading the code; ws-sync still has 42 pass.
- **Stability:** the 3 job files gave 61 pass, 0 fail over 5 runs. The probe's temp directories are cleaned up (none left in `$TMPDIR`).
- **`bun test` (full, shared tree):** 1274 pass, 137 skip, 1 fail. The fail is the same pre-existing "packages/core is still herdr-draw's core" (uncommitted edits in herdr-draw), not this job. The count matches the builder's.

### Round 2: what I did NOT check

- **No sdd ensemble this round.** Round 1 had codex and grok, and agy's quota is still exhausted.
- **No real browser runs.**
- **Only the variants listed above:** I didn't fuzz `codeOnly` beyond them.
