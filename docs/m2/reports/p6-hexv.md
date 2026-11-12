**FAIL**

# Verifier report: p6-hexv (verifies p6-hex, web/ into hexagonal shape)

Verdict: FAIL on one HIGH that the manager already decided (the production root imports the dev rooms, so the
served page can't boot). Everything else holds. Tests pass, the boundary rules bite under mutation, and all four
manager decisions are applied. The remaining findings are LOW.

Verified 2026-11-12 against main's working tree (p6-hex uncommitted). Read-only: mutants and probes ran only in
a scratch copy of the tree.

## Findings

| Sev | Where | Finding |
|---|---|---|
| **HIGH** (manager decision given) | web/main.js:16, :17, :19 | The production root statically imports dev-only pieces: `transport/shared-worker/client.js`, `transport/local.js` and `core/dev-users.js`. p-serve denies those paths, so the served index.html can't boot. **Fix decided by the manager:** main.js becomes the production root, and a new dev-only `web/dev-main.js` gets its own page. This is also the answer to check 4. |
| LOW | test/web/architecture.test.js:75 | `codeOnly` blanks whole template literals, `${...}` expressions included, so a browser global used inside one slips past the globals rule. Probe: `` `${Date.now()}${document.title}` `` in a core file gives `[]`. Raised by codex, confirmed by my probe. Core is clean today. |
| LOW | test/web/architecture.test.js:66 | `CORE_GLOBALS` misses `new Date()`, bare `Date()` and `self`. A core file could read the wall clock through `new Date()` unflagged. Core is clean today. |
| LOW | web/adapters/transport/ws.js:59 | The JSDoc type import in ws.js keeps the ws.js allowlist entry "in use". If the codec import (line 30) moved out, the stale-allowlist check would not fire while this type import remains. Shrink-only holds for every other entry (mutation-tested). |
| LOW | web/core/signin.js:135 | `try { replaceFragment(); } catch {}`: if clearing the fragment throws, the code is still exchanged and the `#code` stays in the URL. No test covers it. `history.replaceState` throwing is unlikely, so this stays LOW (codex rated it LOW/MEDIUM). |
| LOW | test/web/core/page-signin.test.js:132 | No assertion that the token never reaches a URL write (replaceFragment or history). I checked by reading the code: the token is a closure param only (`web/core/sync.js:48`, `token: firstToken`). |
| LOW | web/ports/transport.js:28 | The `congested()` doc says the pill shows it, but nothing reads `congested()` yet (p6-hex §6 says so too). The doc is ahead of the code. |
| LOW | web/adapters/transport/local.js:31–33 | With `clock: false` (the default), localRoom's virtual timers don't exist and it uses `Date.now`. That matches HEAD. Tests that want deadlines must pass `clock: true`, which is easy to miss. Documentation only. |

**Codex HIGH refuted.** Codex reported "ws.js has no jsonCodec import, 53 tests fail". It ran in my scratch tree
while one of my mutants (codec import removed) was in place. Main has the import at
web/adapters/transport/ws.js:30, and `bun test test/web` passes 543 with 0 failing.

**Not a finding.** The 6 s toast (`web/adapters/dom/app.js:468`, `toast(notice, 6000)`) is the new sign-in
notice from the carried sign-in work. Every existing toast keeps the old 1.8 s default (line 203).

## Checks

### 1. No behaviour change

- **Tests:**
  - `bun test test/web`: 543 pass, 0 fail.
  - Full `bun test`: 1044 pass, 101 skip, 0 fail.
  - The old test/web/ui-token.test.js is deleted, and its cases moved to test/web/core/page-signin.test.js (pageSignIn). I found no assertion weakened or deleted without reason.
- **Headless Chrome, index.html, three tabs on the in-browser room** (board hx2, `?net=shared`):
  - Each tab got its role from `?as=`: ada as presenter, cy as annotator, ed as viewer. All three were `live`.
  - The presenter's shapes (ellipse, line) converged with the viewer (`converged: true`).
  - The annotator's freedraw went to its notes stream.
  - The viewer's `setTool('rect')` was refused (the tool stayed `hand`).
  - No console errors or exceptions in any tab.
  - `globalThis.plenary` exposes `{ S, ui, net, setTheme, openDialog, setPanel }`, the same as HEAD.
- **`?net=local`:**
  - All three tabs boot live with no errors. Each tab has its own in-page room, so nothing converges across tabs.
  - That matches HEAD (HEAD app.js:46 also gives each tab its own localNet).
  - The new root also falls back to localNet when SharedWorker is missing (web/main.js:44).
- **localStorage:** it holds only `plenary.mine.<board>.<user>` keys. No token is stored, and no token appears in any URL.
- **web/dev.html and web/collab/dev.html:** both load with their titles and 2 canvases each, and no console errors.
- **Per-tool counts were erratic in the driver (unresolved, probably my driver):**
  - `setTool` sometimes read back the previous tool.
  - arrow, text, note and diamond added no element in the drive.
  - The count fell when the active editor switched.
  - I did not run the same drive against HEAD, so I can't tell a driver timing problem from a regression. Listed under NOT checked.

### 2. Boundaries

- **arch-scan is used for real:** test/web/architecture.test.js uses engine's `test/arch-scan.js` (`listFiles`, `importsOf`, `checkBoundaries`). It adds:
  - `webViolations`;
  - a globals rule (`globalsIn` over `codeOnly`);
  - `applyAllowlist`, which is explicit and shrink-only: a stale entry fails the test.
- **Every rule bites:** 14 mutants, all caught. They covered:
  - core importing an adapter;
  - core using `document`, `localStorage`, `setTimeout` and `Math.random`;
  - a runtime import in ports;
  - one adapter importing another across groups;
  - a stale allowlist entry;
  - packages/protocol imported from a new place;
  - removing the codec import (stale-entry check).
- **The gaps** are the three LOW items above (template literals, `new Date`/`self`, and the ws.js type import).
- **Grep of web/core:** no browser globals in code (comments only).

### 3. Manager decisions applied

- **Presence gate:** previews are sent only while `backlogBytes() ≤ PRESENCE_BACKLOG_BYTES` (16 KB), and `congested()` is not used for the gate.
  - ws.js implements `backlogBytes()` (ws.js:197).
  - local.js:94 and shared-worker/client.js:51 return 0 (bufferless, per the M2 decision).
  - Codex confirmed this independently.
- **localRoom and sharedNet:** they implement the full port and pass `transportContract`. The local, shared-worker (fake port) and reference transport suites pass (142 tests).
- **Sign-in:**
  - It goes through `web/core/signin.js` and the HTTP adapter.
  - `takeSignIn` clears the fragment synchronously (signin.js:135) before `auth.exchange` (signin.js:149). `pageSignIn` does the same at line 186.
  - The HTTP adapter uses `credentials: "same-origin"`, `cache: "no-store"` and `redirect: "error"` (http.js:49–53), and matches docs/m2/contracts/auth-exchange.md.
- **Token:** never in localStorage, a URL or a log (checked in the code and in the headless run).

### 4. Production vs dev root

The production root should not import dev pieces. Today it does, which is the HIGH above. The manager's fix is
right: a production `main.js` with only the sign-in, ws and DOM adapters, plus a dev-only `dev-main.js` and page
for the SharedWorker and local rooms and `DEV_USERS`.

A follow-up for the fix: add an architecture rule that `web/main.js` may not import `transport/local`,
`transport/shared-worker` or `core/dev-users`, so this can't come back.

## Design check (CHECKER)

The systems-design plugin is installed (v0.12.49), but I could not find its SKILL.md on disk, so I couldn't load
the skill text. I ran the CHECKER pass by hand with the skill's frame: scope, estimate, high-level design, deep
dives, wrap-up. It covers p6-hex.md §1.

| Area | Verdict | Notes |
|---|---|---|
| **Port completeness** | OK, one gap | transport, net, storage, clock and auth each have a contract test run against every adapter. **collab has no contract** (only the fake), and the design says so and defers it to p7-wire. The transport port also states its failure behaviour: it never throws for a network reason; a dead link is onDrop or silence; and there is a hard cap (> 4 MB with no drain progress for 10 s counts as a drop, ws.js:31, :68–70). |
| **Failure behaviour** | OK | Backoff and jitter live in the core (Replica.reconnectWait plus the clock port), not in adapters. Auth errors are values, with one jittered retry (signin.js:25–26, 500 ms plus up to 1500 ms). Presence is skipped rather than queued when the backlog is over 16 KB, and ops are never gated. The uplink-stall walk-through in the wrap-up checks out against ws.js. **Gap:** the Replica and presenceLimiter still use wall-clock `now` (engine's packages/protocol), so a wall-clock jump can shift client deadlines. The design records this as a risk. |
| **Estimate** | OK | Here is the reasoning for 16 KB. One drag preview is about 15 KB, and at 1 Mbit/s 16 KB is about 130 ms of wire time, which fits the 150 ms editor budget. 256 KB would be about 2.1 s. The exchange load is about 830/s at the 100k-joins-in-2-min peak, and the jittered retry spreads a 503 wave over 1.5 s. The numbers are consistent. |
| **Two transports per tab** | MEDIUM risk for M4, not this job | Two hellos per viewer means about 200k hellos and two sockets per viewer at 100k joins. That doubles gateway connections and join work against the 100k-in-2-min NFR. It is named as bottleneck 1, with the fix (one shared Replica per tab, owned by sync.js) out of scope. **Recommendation:** put it on the M4 load-test plan as a measured item before 100k is attempted, not as a vague follow-up. |
| **Blank page during the exchange (~22 s)** | MEDIUM UX risk, recorded | main.js waits for sign-in before mounting. The worst case is two 10 s timeouts plus up to 2 s of jitter, about 22 s of nothing on screen, and it is most likely during a join wave, when the endpoint is slowest. **Recommendation:** mount a "Signing in…" state before the exchange. That is a root-only change, and the core already returns the notice. Shorter timeouts on the retry alone would also help. |
| **SharedWorker dev room on one thread** | OK | Dev only. Once the HIGH fix moves it out of the production root, it doesn't matter for production. |
| **Monitoring** | Thin, acceptable for M2 | The status pill is the only client-side signal, and `congested()` isn't wired to it yet (LOW above). Nothing reports client-side join time or exchange latency. Worth adding before the M4 load test. |

## NOT checked

- **A refused op plus resync, in the browser.** I didn't trigger it. It is covered only by test/web (sync and contract tests).
- **A drop mid-typing that keeps the draft, in the browser.** I didn't trigger it. It is covered only by test/web.
- **Drawing with every tool in the browser.** The driver's per-tool counts were erratic (§1), and I didn't run a HEAD baseline to compare. Only freedraw, ellipse and line were confirmed end to end, plus viewer refusal.
- **A real Google sign-in end to end, and ws.js wired in a page.** Neither exists yet (phase 3).
- **Safari, Firefox and mobile.** Headless Chrome only.
- **The served page through p-serve's deny rules.** I didn't run it. The HIGH comes from reading the imports against the deny list plus the manager's report.
- **Ensemble review:** codex only. agy was out of quota and no other harness was run.
