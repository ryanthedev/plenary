# Report: p6-hex (web/ into hexagonal shape)

## 1. Design (distributed-systems-design skill v0.1.0, APPLIER mode, written before moving code)

### Scope (skill phase 1; answers from the brief, CLAUDE.md NFRs and PROTOCOL.md — no user to confirm with, so recorded here)

- **Features:** the browser client of one board: two streams (board, notes) bound to core Editors, role gating,
  collaboration UI (presence, records), sign-in by code exchange. No behaviour change in this job except the carried
  items (sign-in code exchange wired, presence gate on transport backlog, L2/L4 fixes).
- **Scale per client:** one tab = 2 transports today (one per stream). Fleet: 100k viewers, ~2k annotators, a handful
  of editors per board; 100k joins in 2 min (~830 joins/s, so ~830 `POST /auth/exchange`/s at peak).
- **Latency:** editors < 150 ms in the home region; viewers < 1 s; 60–120 fps paint.
- **Infra:** our own gateway over WebSocket (ws.js, phase 3), a SharedWorker dev room, an in-page reference room.

### Estimate (phase 2)

- **Op traffic up:** paced 20/s, burst 100 (PROTOCOL.md). An op of ~1–2 KB JSON → ≤ 40 KB/s per active editor.
- **Presence up:** cursor 20/s × ~60 B ≈ 1.2 KB/s; a drag preview (≤ 50 elements × ~300 B ≈ 15 KB) at its rate.
- **Why the presence gate is 16 KB:** one preview frame is ~15 KB. Allowing presence only while the transport's
  backlog is ≤ 16 KB keeps at most about one presence frame queued ahead of an op. At 1 Mbit/s, 16 KB is ~130 ms
  of wire time, inside the 150 ms editor budget; 256 KB (the congested flag) would be ~2.1 s (p6-edge2v M1).
- **Sign-in retry:** 830 exchanges/s; a 503 wave retried once after 500 ms + U(0, 1500) ms spreads the retries
  over 1.5 s instead of one instant (≈ 550/s extra, not 830 in one tick).

### High-level design (phase 3)

```
 composition roots ── web/main.js (index.html) · web/dev.js (dev.html) · web/collab/dev.js · shared-worker/worker.js
        │ pick adapters, read the URL, wire
        ▼
 adapters (driving) ── adapters/dom/**: app chrome, canvas input + paint, panel, export, collab renderers
        │ call the core's API (createSession, bindEditor handle, collab models)
        ▼
 core ── core/sync.js (Editor ⇄ Replica) · core/session.js + core/roles.js (UI state, gating) ·
         core/signin.js · core/collab/* (presence, records, notes, gate, limits, flags) · core/dev-users.js (data)
        │ depends only on ports (+ packages/core, packages/protocol from sync.js only)
        ▼
 ports ── transport · net (join → Transport, put/onFile blobs) · storage · clock · auth · collab
        ▲ implemented by
 adapters (driven) ── transport/{local, shared-worker/, ws} · storage/{session, local, memory} ·
                      clock/{browser, virtual} · auth/{http, fake} · collab/fake
```

Use cases walked: (1) page load → main.js reads `#code`, core/signin.js exchanges it through the auth port, keeps
the session in the storage port → session binds two Editors over net.join() transports → live. (2) A drag → Editor
onOp transient → core/sync.js checks `transport.backlogBytes()` ≤ 16 KB → preview sent or skipped (the next move
sends a fresh one; the commit is an op and never skipped). (3) Socket drop → transport reports onDrop → core counts a
failed attempt, waits `replica.reconnectWait()` on the clock port (jitter from clock.random) → reopen → hello.

### Ports and contracts (deep dive 1: transport and presence — Ch12 chat/presence, Ch4 rate limiting)

| Port | Contract (summary; full text in the port file) | Failure behaviour | Contract test |
|---|---|---|---|
| **transport** `web/ports/transport.js` | send · onMessage (one handler, current connection, in order) · reopen REQUIRED (new generation; nothing of an older one ever delivered) · close final · onDrop (unasked drops of the current connection only, once) · congested() (> 256 KB, status pill) · **backlogBytes()** (new: bytes queued + unsent; 0 for bufferless) | Never throws for a network reason; a dead link is onDrop or silence (the Replica's watchdog). Backoff + jitter live in the core (Replica.reconnectWait), never in an adapter. Hard cap: > 4 MB with no drain progress for 10 s = a drop. | `transportContract`: reference, **local (new)**, **shared-worker via a fake port (new)**, ws |
| **net** `web/ports/net.js` (new, p6-portsv L7) | `join() → Transport` (one fresh transport per stream) · `put(file)` / `onFile(fn)` blobs stand-in | put/onFile never throw; a dev net with no blob path ignores put | `netContract`: local, shared-worker (host.js over a fake port) |
| **storage** | get/set/remove of strings | Throws `STORAGE_UNAVAILABLE`; callers that can live without it carry on in memory | `storageContract`: session, local, memory |
| **clock** | now (wall) · mono · set/clear · random | Cannot fail | `clockContract`: browser, virtual |
| **auth** | exchange(code) → session or `{ error }`, never rejects | Every failure is a value; one jittered retry on unavailable/network (core) | `authContract`: fake, http |
| **collab** `web/ports/collab.js` (moved) | what the collab UI needs from sync (role, me, status, presence in/out, records) | status `connecting` etc.; presence may drop | **none yet (open)**: only the fake exists; a `collabContract` belongs with p7-wire's real adapter |

**Presence rule in the core (manager decision, p6-edge2v M1):** presence — today the v0 `transient: true` op (drag
preview) — is sent only while `backlogBytes() ≤ PRESENCE_BACKLOG_BYTES` (16 KB). Above it, the preview is skipped,
not queued (latest-wins: the next pointer move or the commit supersedes it, so no flush tick is needed — this
answers p6-edge2v L2 for previews; the collab cursor gate is p7-wire's). Hello and every real op are never gated.
A transport without `backlogBytes` (none after this job) is treated as 0 (`?.()`), per the manager's M2 decision.

**Rate limiting (Ch4):** client-side limits are a courtesy, never the defence: the gateway enforces presence rates
(presenceLimiter) and the room the op pacer. The client's limiter only avoids sending what the gateway would drop.

### Deep dive 2: clocks and sign-in

- **Clock injection:** the core never reads Date.now/setTimeout/Math.random. bindEditor and createSession take the
  clock port (`clock`), or the older `timers/now/random` trio the tests use; with neither, bindEditor throws a
  TypeError (no silent global fallback). The roots pass `browserClock()`. The client's presenceLimiter now runs on
  `clock.mono` (R2-L4, the part that is web/'s); the Replica still takes one wall `now` for its deadlines (engine's
  packages/protocol: noted as a risk).
- **Sign-in:** the fragment is dropped first (a root-supplied `replaceFragment`), then core/signin.js. A new core
  function `pageSignIn` makes the page's choice testable: an explicit known `?as=` is the dev path and **stores and
  exchanges nothing** (fixes L2); else a `#code` exchange or the stored session; else dev `ada`. The identity is
  display-only (L5): it names the person in the chrome. The note lock now compares a note's author with
  `welcome.user` (the room's word), not the identity; only the per-browser note-list key still uses the identity's
  `user` (a local list of ids; the room enforces ownership).

### Core vs adapter

- **Core** (no DOM, Worker, WebSocket, storage, location/history, direct time/random): core/sync.js, core/session.js,
  core/roles.js, core/signin.js, core/collab/{presence-model, records-model, notes-model, gate, limits, flags}.js,
  core/dev-users.js (the dev token table: data the roots and the dev rooms share).
- **Adapters:** everything that touches a browser API or a far side. The in-page reference room (localRoom) is an
  adapter of the transport port that happens to contain packages/protocol's Room; it is the one allowed second
  importer of packages/protocol (plus ws.js for the codec).
- **Adapter groups (for "adapters don't import each other"):** `<port>/<name>` (e.g. `storage/session`,
  `transport/local`, `transport/shared-worker` = the folder with client, host, worker entry), except all of
  `dom/**` is one group (the page's UI: chrome, paint, panel, export, collab renderers).

### Wrap-up (phase 5)

- **Bottlenecks:** (1) two transports per tab (two hellos at 100k joins = 200k hellos; a shared-Replica binding is
  the fix, sync.js-owned, not this job). (2) The SharedWorker dev room runs every board in one worker thread (dev only).
  (3) The exchange endpoint at join waves (one jittered retry bounds it).
- **Failure scenario:** the uplink stalls mid-drag. Backlog grows past 16 KB → previews stop at once; ops queue; past
  4 MB with no drain for 10 s the transport reports a drop → the core backs off with jitter and resends unacked ops on
  the next connection (an acknowledged op is never lost; unacked ones are resent with the same ids).
- **Monitoring:** the status pill (status, pending, congested) is the client's monitor; server-side metrics are
  the gateway's.
- **At 10×:** the presence gate, jittered backoff and single retry are per-client and scale linearly; the per-tab
  transport count is the next thing to cut.

## 2. What changed

### File move map (old → new)

| Old | New | Layer |
|---|---|---|
| web/sync.js (bindEditor, streamState, fullState, docDiff, editorState, seeded) | web/core/sync.js | core |
| web/sync.js (localRoom) | web/adapters/transport/local.js (+ `localNet`, moved from net.js) | adapter |
| web/ui/session.js · roles.js · dev-users.js | web/core/session.js · roles.js · dev-users.js | core |
| web/ui/net.js (sharedNet) | web/adapters/transport/shared-worker/client.js | adapter |
| web/ui/room-host.js · room-worker.js | web/adapters/transport/shared-worker/host.js · worker.js | adapter · root |
| web/ui/dom.js · panel.js · export.js, web/paint.js | web/adapters/dom/dom.js · panel.js · export.js · paint.js | adapter (dom) |
| web/app.js | web/main.js (root: URL, sign-in, adapters) + web/adapters/dom/app.js (`mountApp`: the chrome) | root + adapter |
| web/ui/token.js | removed: web/core/signin.js (`pageSignIn`, `signInNotice` added) does its job over the `#code` exchange | core |
| web/collab/{presence-model, records-model, notes-model, gate, limits, flags}.js | web/core/collab/ | core |
| web/collab/{ui, draw, dom}.js, collab.css | web/adapters/dom/collab/ | adapter (dom) |
| web/collab/fake-port.js · port.js | web/adapters/collab/fake.js · web/ports/collab.js | adapter · port |
| (new) | web/ports/net.js (p6-portsv L7: `join() → Transport`, `put`/`onFile`) | port |
| web/dev.js, web/collab/dev.js(+html), web/index.html | stay; imports re-pointed; index.html loads main.js | roots |

Nothing outside web/ and test/web imported a web/ file (grep), so no other track's code changed.

### Behaviour changes (all asked for by the brief or its carried items)

- **Sign-in:** the page reads `#code`, exchanges it via `POST /auth/exchange` (auth port, `httpAuth` wired in
  main.js), keeps the session in session storage. `#token=` is no longer read (the server sends `#code` since
  p5-code 3f6b489). A failure shows a toast that doesn't blame the person and says "Still signed in as X" when a
  stored session survives (p6-edgev LOW-4, LOW-5).
- **Dev path (p6-landv L2):** a known `?as=` drops the fragment but exchanges and stores nothing.
- **Presence gate (p6-edge2v M1):** previews skipped while `backlogBytes() > 16 KB` (`PRESENCE_BACKLOG_BYTES`).
- **Offline banner (L4):** "Nothing is waiting to send…" when no edit is pending; "1 edit waits" singular.
- **Note lock (p6-landv L5):** compares authors with `welcome.user`, not the display identity.
- **Null names (p6-portsv R2-L4):** main.js gives the chrome `name ?? email ?? "You"`; the collab renderers show
  "Someone"/"someone" for a null thread or resolver name.
- **Exchange POST** sets `redirect: "error"` (p6-edgev LOW-3).
- **No global fallbacks in core:** bindEditor/createSession throw without a clock (roots pass `browserClock()`);
  `newRecordId` needs a random source.

### Ports

- **transport:** `backlogBytes()` added (REQUIRED to implement), `PRESENCE_BACKLOG_BYTES = 16 KB`; ws.js, reference,
  local and shared-worker implement it (local and shared-worker are bufferless: 0). sync.js's header now points to
  the port for the contract.
- **net (new)**, **collab (moved)**, storage/clock/auth unchanged.
- **sharedNet's buffer (manager M2):** decided bufferless (reasons in client.js's header): a MessagePort to a worker
  of the same browser has no network uplink; a stuck worker is silence, which the Replica's watchdog handles.

## 3. Tests

- **Before:** full `bun test` 894 pass / 80 skip / 0 fail; test/web 441 pass.
- **After:** full `bun test` — see section 8 (final run); test/web 543 pass / 0 fail.
- **Added:**
  - `transportContract` on **local** (echo far side via localRoom's new `makeRoom` seam; `hold()` calls the old
    connection's room-side send, so the `link.gen` check is what's tested — closes p6-landv L3) and on
    **shared-worker** (page side over a fake port pair, far side speaking host.js's protocol by hand).
  - Contract: `backlogBytes()` (fresh 0, counts unsent bytes, UTF-8 not characters, agrees with congested, 0 after
    drain/reopen/close; bufferless stays 0).
  - sync: the presence gate (at 16 KB previews go, over it none; the commit and a reconnect's hello still go);
    no-global-fallback (bindEditor throws without a clock).
  - test/web/core/page-signin.test.js (replaces ui-token.test.js, below); a fragment only the cap rejects (LOW-1).
  - ws: wrapped-globals test (p6-edge2v L1, the verifier's scratch test); http: `redirect: "error"`;
    browser clock follows `performance.now` when present (R2-L1); library on the storage port incl. an
    unavailable store; `newRecordId` never reads Math.random.
  - test/web/architecture.test.js (section 4); `netContract` (test/web/contracts/net-contract.js) on both nets;
    the note lock against `welcome.user` (ui-session).
- **Existing assertions:** none removed or weakened (`git diff -U0 test/web` shows only one removed `test(` line: the
  "real timers" test retitled, same assertions, now passing `browserClock()` as the page does). Setup-only edits:
  import paths, `clock: net.clock` for `timers/now`, `clock: virtualClock()` on `timeoutMs: 0` binds, `roomHost({
  makeNet })`, `newRecordId(Math.random)`, `memoryStore()` for the library.
- **ui-token.test.js → page-signin.test.js, guarantee by guarantee:**

  | ui-token test | Now |
  |---|---|
  | fragment read, kept in session storage, hash cleared | `#code` exchanged once, kept, fragment dropped; reload restores |
  | share-link outcome, two known values | `link` kept on both paths; `signInNotice` words it |
  | hostile fragments never a token | hostile list (incl. `%41%42`, `#token=`, over-cap) → dev ada; requests only for well-formed codes |
  | bad fragment keeps a good stored token | same, over the hostile list |
  | storage that throws | unavailable store: signs in, memory only, fragment dropped |
  | identity display-only | identity from the exchange (server-checked shape; core/signin.js `clean`) — signin.test.js |
  | page never puts the token in localStorage/URL/log/globalThis.plenary | main.js/app.js/signin.js source checks; `mountApp`'s return (globalThis.plenary) is exactly S, ui, net, setTheme, openDialog, setPanel |
  | who signs in (precedence) + the hello carries exactly that | `pageSignIn` precedence (incl. `__proto__`, `as` twice); hellos over the dev room |
  | a hostile fragment never reaches the hello | same test, `#code="><script>` → hello carries dev-ada |

### Mutation checks (in a scratch copy of the repo, never in the shared tree)

| Mutant | Result |
|---|---|
| local.js: `link.gen === gen` → `true` | 3 fail (killed) |
| shared-worker client: old link's handler kept on reopen | 11 fail (killed) |
| sync.js: presence gate removed / `>` → `>=` | 1 fail each (killed) |
| sync.js: global fallback for timers/now/random | 1 fail (killed) |
| signin: `?as=` path exchanges and stores / keeps the fragment | 1 fail each (killed) |
| signin: MAX_FRAGMENT check removed | 1 fail (killed) |
| http.js: `redirect: "follow"` | 1 fail (killed) |
| browser clock ignores performance.now | 1 fail (killed) |
| reference transport counts characters | 1 fail (killed, after the UTF-8 contract case) |
| boundary: core imports an adapter / protocol; adapter imports another; a stray unclassified file | 1–2 fail each (killed) |
| boundary: ws.js's runtime codec import removed | survives — equivalent: its JSDoc type import still names packages/protocol, which the seam rule counts |
| boundary: ws.js no longer touches the codec at all (runtime + type) | 2 fail (stale-allowlist, killed) |
| boundary: `document.title` in core/session.js; `Date.now()` in core/collab/gate.js | 3 fail each (killed) |
| boundary: a runtime import in web/ports/net.js | 2 fail (killed) |
| boundary: main.js dropped from the roots (its adapter imports become "wiring"/"unclassified") | 3 fail (killed) |
| session: note lock back on the display `user` | 1 fail (killed) |
| net contract: sharedNet close() clears every link / localNet join reuses one transport | 1 / 2 fail (killed) |

## 4. Boundary test (test/web/architecture.test.js)

- Runs for real against engine's test/arch-scan.js (on main at 44dd1aa; static import, no skip — manager, 2026-11-12).
  Uses `listFiles`, `importsOf`, `checkBoundaries`; no import scanner of its own; engine's files untouched.
- Rules: checkBoundaries' (core->adapter, adapter->adapter, wiring, unclassified; ports classed with core) plus web/'s
  own, computed from `importsOf`: core imports only packages/ports/core; the protocol seam (only core/sync.js, with an
  explicit, reasoned, shrink-only allowlist of 5 edges: local.js's Room/ports/presence/codec, ws.js's codec); ports
  import nothing at runtime; adapters stay in their group; every web/ file is classified.
- **Core reads no browser global** (added this round; the brief's core rule): a token check over web/core's source
  with comments and string literals blanked, for the brief's list (DOM, Worker, WebSocket, storage, location/history,
  fetch, Date.now, timers, Math.random, performance, rAF, console…). Not an import scanner: the same technique as the
  sign-in source checks. A synthetic-source test proves it ignores comments, strings and member names.
- Every rule is mutation-checked on the real tree (section 3) and on synthetic sources inside the test itself.

## 5. How I checked it

- `bun test` (full) before and after; test/web after every stage (move, split, clock, gate, sign-in, LOWs, boundary).
- **Headless Chrome** (raw CDP, my scratch driver; static server on port 0, Chrome on debug port 0, PIDs recorded,
  only those killed): 27/27 checks —
  - index.html, three tabs (ada, bo, cy) on one board: all live over the SharedWorker net (`kind: "shared"`), roles
    presenter/presenter/annotator, a rectangle from ada and one from bo reach all three tabs, topbar and pill render
    ("Live" once the tab is in front), no console errors;
  - `?net=local`: live on the local net, draws, no errors;
  - no `?as=` and a hostile `#code`: dev ada, live, fragment gone from the URL, nothing in sessionStorage, the
    notice toast shown;
  - web/dev.html: both panes live, a drawing converges to the other pane, no errors;
  - web/collab/dev.html: mounts, its three stylesheets load (collab.css's new path), no errors;
  - real input: the R key picks the rectangle tool and a CDP mouse drag on the canvas draws one the room acks;
  - prefs through the storage port: the side panel's state survives a reload; an annotator's own note ids
    (`plenary.mine.*`) survive a reload;
  - `#code` through main.js → httpAuth: the static server answers `POST /auth/exchange`; a good code is posted once
    as JSON, the fragment is gone, the token sits in sessionStorage (not localStorage), the dev room refuses it
    (as before ws.js), a null name renders; a 404 gives exactly one retry, then dev ada with "the server didn't answer".
  - 36/36 in three consecutive runs. One earlier run had "tab 1 (bo) live" time out at 8 s (not reproduced in 3
    reruns; it passed in the 2 runs before it): treat as a possible background-tab start-up flake.

## 6. NOT verified

- **A real Google sign-in end to end** (`#code` from the live server → exchange → hello). The HTTP adapter is tested
  against a fake fetch only; and a real session token is still refused by the in-browser rooms (no ws.js wiring:
  the brief says ws.js is "later", phase 3).
- **congested() in the status pill:** the port says the pill shows it; nothing reads it yet (not wired, to keep
  the pill's behaviour unchanged).
- **A collab contract:** none (only a fake exists; p7-wire).
- **ws.js wired in a page:** not wired; its backlog/gate interplay is tested only with a stub transport in sync.test.
- **The collab UI over a real port:** p7-wire's job; only the fake port and the dev page.
- **Safari/Firefox, mobile:** Chrome headless only. Background-tab chrome refresh (rAF paused) is as before.
- The boundary test against engine's final arch-scan.js (it may change before engine commits it).

## 7. Risks

- **Replica and presenceLimiter still take one wall `now`** (packages/protocol; R2-L4's "onto mono" is engine
  work): a wall-clock jump can still shift client deadlines. The clock port is passed whole, so switching is one line
  in core/sync.js once the Replica takes `mono`.
- **Two transports per tab** remain (bottleneck 1 in the design).
- **(Fixed in the fix round, §9 item 2.)** ~~A blank page while the exchange runs:~~ main.js awaits sign-in before mounting. Worst case (no answer twice):
  10 s timeout + up to 2 s jitter + 10 s ≈ 22 s of nothing on screen. A "signing in…" state is a follow-up.
- **Preview skipped, not kept:** with a congested link and a pointer that stops, the peer's last preview is the
  one before congestion until the commit lands (by design: previews expire after 5 s on the receiver; the commit
  is an op and always goes).
- docs that name old paths (web/app.js, web/ui/…, web/sync.js) outside web/: reports and briefs (history, left as
  is); README.md (untracked, p8-readme) names `web/app.js` (line 37) and `web/ui/dev-users.js` (line 115): now
  `web/main.js` + `web/adapters/dom/app.js` and `web/core/dev-users.js`. Not mine to edit; please pass on.

## 8. For the manager: commit set and review notes (updated after the fix round)

- **Full run after the fix round:** `bun test` 1083 pass / 112 skip / **1 fail** (1196 tests, 63 files). The one
  failure is NOT this job's: `test/core-source.test.js` "packages/core is still herdr-draw's core" — the sibling
  checkout ../herdr-draw's `core/editor.js` changed (sha cbebecb4… vs SOURCE.json's 281cf50d…), outside this repo.
  test/web: 552 pass / 0 fail. (First round: 1044 / 83 / 0; baseline at start 894 / 80 / 0.)
- **Add (new):** web/main.js · web/dev-main.js · web/dev-main.html · web/core/{sync,session,roles,dev-users}.js ·
  web/core/collab/ · web/ports/{net,collab}.js · web/adapters/dom/ (incl. gate.js) · web/adapters/collab/ ·
  web/adapters/transport/local.js · web/adapters/transport/shared-worker/ · test/web/architecture.test.js ·
  test/web/core/page-signin.test.js · test/web/adapters/{transport-local,transport-shared-worker,net}.test.js ·
  test/web/contracts/net-contract.js · docs/m2/reports/p6-hex.md
- **Modify:** web/index.html · web/style.css · web/dev.js · web/dev.html · web/collab/dev.{js,html} · web/core/signin.js ·
  web/ports/{transport,auth}.js · web/adapters/transport/ws.js · web/adapters/auth/http.js ·
  web/adapters/storage/local.js · test/web/{sync,ui-session,ui-land,ui-chrome,paint}.test.js · test/web/collab/*.test.js ·
  test/web/core/signin.test.js · test/web/adapters/{auth-http,clock,transport-ws}.test.js ·
  test/web/contracts/{transport-contract,reference-transport,reference-transport.test}.js
- **Delete:** web/app.js · web/sync.js · web/paint.js · web/ui/ (all) · web/collab/{collab.css, dom, draw, fake-port,
  flags, gate, limits, notes-model, port, presence-model, records-model, ui}.js · test/web/ui-token.test.js
- **Not mine:** test/arch-scan.js, test/architecture.test.js, server/** (engine's); packages/protocol/ports.js and
  everything else dirty in the tree (deploy/, .github/, other reports and briefs) belongs to other tracks.
- **Review hint:** web/adapters/dom/app.js is web/app.js re-indented inside `mountApp`: diff it with `-w`.
- **For engine (p-serve):** please re-run p-serve's crawl. The production page's graph now holds no dev module, and
  static.js's allowlist (index.html + main.js's graph) already leaves web/dev-main.{html,js} unserved (checked: 404),
  so no DENY entry is needed. The browser's automatic `/favicon.ico` is a 404 (no favicon in web/; harmless).

## 9. Fix round (manager, 2026-11-12, from docs/m2/reports/p6-hexv.md)

| # | Item | Fix | Test | Mutation (scratch copy) |
|---|---|---|---|---|
| 1 | **HIGH** production root imports dev rooms | `web/main.js` is production only: `takeSignIn` (no `?as=`, no dev users), `httpAuth`, session storage, `wsNet` to `sameOriginWsUrl(location)` (`ws(s)://<host>/ws`, token only in hello). New `web/dev-main.js` + `web/dev-main.html` hold the old wiring (SharedWorker/local rooms, DEV_USERS, `pageSignIn`); index.html loads only main.js. `wsNet` and `sameOriginWsUrl` added to ws.js (its own group). The topbar's "· dev room" label shows only on dev nets. | architecture.test.js: `runtimeGraph("web/main.js")` via arch-scan `importsOf` holds no dev module, every file exists under a served mount, index.html loads only main.js, and the dev root's graph does hold dev modules (not vacuous); synthetic transitive case. `netContract` on wsNet (fake WebSocket). | main.js imports dev-users: killed · dom/app.js imports local.js (transitive): killed · main.js imports shared-worker client: killed |
| 2 | MEDIUM blank page during the exchange | Both roots show a full-page "Signing in…" gate (`web/adapters/dom/gate.js`) before the exchange starts; no session → "Sign in to Plenary" + a link to `/auth/login`; no `?board=` → "No board in this link". | Production headless check: gate titles recorded by a MutationObserver: ["Signing in…", "Sign in to Plenary"]. | (browser-only) |
| 3 | `codeOnly` blanked `${…}` | `codeOnly` is now a small scanner: string text and comments blanked, template text blanked, `${…}` kept as code at any depth. | Synthetic: `` `${Date.now()}` ``, nested `` `${`${document.title}`}` ``, scan resumes after a template; strings inside `${}` still blanked. | old behaviour (`${` as text): killed · real core with `` `${Date.now()}` `` in roles.js: killed |
| 4 | `new Date(`, `Date(`, `self` missed | Added (`Date(` pattern covers both). `presence-model.js`'s local `self` renamed `model` (it was a true hit). A property key named like a global is flagged too (strict on purpose; pinned). | Synthetic cases incl. non-hits (`x.self`, `isDate(`, `a.Date(`). | real core `new Date()` in records-model.js: killed · `self` in gate.js: killed |
| 5 | ws allowlist kept alive by a JSDoc import | The protocol-seam rule counts runtime imports only (a type import loads nothing). | — | ws.js runtime codec import replaced, JSDoc kept: stale-allowlist fires (killed) |
| 6 | DECISION fail closed | `takeSignIn`: if `replaceFragment()` throws, the code is never exchanged; outcome `url-not-cleared` (notice: "Sign-in stopped: the sign-in link couldn't be removed from the address bar. Sign in again."); a stored session still restores. | page-signin (both cases); signin.test.js's old "a throwing replaceFragment is survived … signed-in" **changed by this decision** to assert `url-not-cleared`, no token, no request. | fail-open restored: killed (2 fail) |
| 7 | token never in a URL write | — | Unit: replaceFragment called once, no arguments, before the exchange. Browser (production): every history.replaceState/pushState URL recorded from page start; none holds the token or the code. | exchange before replace: killed (7) · fragment passed to replaceFragment: killed |
| 8 | `congested()` doc ahead of code | Port text: implemented and contract-tested but read by nothing today; it exists for the status pill (p7-wire). | — | — |
| 9 | localRoom `clock: true` easy to miss | Doc comment in local.js: time-based tests must pass `clock: true` and hand `net.clock` on. | — | — |

**Headless (fix round):**
- **Dev page** (`web/dev-main.html`, my scratch static server): the 36 checks of section 5 — 36/36.
- **Production page** (`index.html` → main.js) on the **real server** (`test/server/rig.js`: createServer with
  static.js's allowlist and `/ws`, dev auth tokens, port 0; Chrome debug port 0; PIDs recorded, only those
  killed): 20/20 in two runs —
  - signed out: the sign-in screen with the /auth/login link; the whole module graph loads with no 4xx/5xx or
    failed request (the browser's own /favicon.ico aside); no console errors;
  - dev-main.html, dev-main.js and transport/local.js are not served (404);
  - with a stored session (the dev tokens the server's dev auth accepts): live over the real `/ws`, net `ws`,
    role from the server (owner → presenter), a drawing acked by the server and seen by a second person (editor),
    no "dev room" label, no failed loads or console errors, the token in no URL write, the server log holds no token;
  - a `#code` the server can't exchange (no OIDC in the rig, so /auth/exchange is a 404): "Signing in…" first,
    then the sign-in screen with "the server didn't answer"; fragment dropped; no URL write carries the code.

**NOT verified (fix round):** a real Google `#code` end to end against a server with OIDC configured (the rig has
none); the production page through a TLS proxy (`wss:` is unit-tested via `sameOriginWsUrl` only); Safari/Firefox.
