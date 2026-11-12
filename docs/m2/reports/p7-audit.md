# Report: p7-audit (web/ architecture audit: hexagonal + systems design vs the NFRs)

**The ports are clean, but the client misses three NFRs.** Every port has a written contract, and every adapter
passes a shared contract test. The boundary test catches every ordinary bad import. Against the NFRs, the client
falls short in three places:

- **A silent idle link is never noticed.** A viewer stays "live" on a frozen board (ran it: 10 virtual minutes, 0
  hellos).
- **Each tab downloads the whole board twice** (ran it: 218 KB on each link).
- **Comment pins and the chrome do O(everything) work on every frame** while panning (measured in part).

Three more HIGHs are owned by engine: the reconnect herd after a gateway restart, presence sent in full to every
viewer connection, and the first two items' protocol halves.

- **Who and where:** worker plenary-p7-audit (t1h1), manager t14k. Read only.
- **Snapshot:** main at 001813a, in a detached worktree in my scratchpad (since removed).
- **Changed in the repo:** nothing but this report.
- **Baseline in the worktree:** `bun test test/web` 615 pass, 0 fail.
- **Evidence tags on every finding:**
  - **ran:** a test, probe or mutant run in the worktree.
  - **measured:** a bun benchmark of the real modules on an M-series Mac. A browser, and a phone even more so, is slower.
  - **read:** code reading only.

## 1. Findings

Severity follows the brief: HIGH = violates an NFR or the hexagonal rule in a way that bites in M2; MEDIUM = bites by
M4 or makes a port unswappable; LOW. "New" = not in p6-hex's or p7-wire's own risk lists. Items p7-tab will change
(viewer double count, the cap at the 5th tab) are left out.

### Client-owned

| id | sev | file:line | what | proposed fix | job |
|---|---|---|---|---|---|
| C-1 | **HIGH** | web/adapters/dom/collab/frame.js:18-19 → ui.js:330 → ui.js:119-133 | **Pins re-laid on every frame while panning, and on every incoming board op.** `layout()` runs `recordsView` over all threads (**measured 5.4 ms** at 10k threads × 3 comments) and then writes about 8 style/class/attr values per pin, for every pin. That is ~80k DOM writes a frame at the protocol's 10k-thread cap (estimate). There is no viewport culling, and all pins exist as DOM nodes. Breaks 60 fps on a busy board. New (p7-wire listed it as "fine for tens"). | Cache `recordsView` per records rev. On pan, move one pin-layer transform, not every pin. Re-place only pins in the viewport (plus a margin) when the view changes. Cap the pins in the DOM (cluster the rest). | J1 collab-perf |
| C-2 | **HIGH** | web/adapters/dom/app.js:178, :463 | **Trackpad or wheel panning rebuilds the whole chrome every frame.** The wheel handler sets `chromeDirty`. `chrome()` throttles to 250 ms only when `S.gesture \|\| !chromeDirty`, so wheel panning rebuilds topbar, panel, drawer, timeline, hud and dock every frame. Inside that rebuild: `notesList` sorts every note (:318), the topbar counts every note (:262), and the timeline scans every board element (:308). read (not run in a browser). New. | Keep the zoom % in a node updated in place. Wheel and zoom should not set `chromeDirty`. Key the chrome on what it shows. | J2 chrome |
| C-3 | **HIGH** | web/core/session.js:81-86; replica.js:92 (hello has no stream filter) | **Two connections per tab, and each gets everything:** the full snapshot of all three streams, every entry and every presence batch. **Ran:** a viewer joining a 300-element, 100-thread board got **218,405 B on the board link and 218,365 B on the notes link**. **Measured** for one Replica: a 14 MB snapshot (20k elements + 30k comments) takes 18 ms to decode and 26 ms to load, and holds ~23 MB of heap. Per tab that is 2× bytes, decode, memory and per-entry CPU, plus 200k hellos at 100k joins. Known since p6-hex ("bottleneck 1"); the doubled bytes and memory are newly measured. | One connection per tab: one Replica feeding both Editors (sync.js binds a stream of a shared Replica). | J3 one-link (after p7-tab) |
| C-4 | **HIGH** (client half; protocol half E-1) | packages/protocol/replica.js:310-315, web/core/sync.js:89-91, web/adapters/dom/app.js:492 | **An idle, caught-up link that goes silent is never noticed.** Once nothing is pending, `timeLeft` is null, so sync.js arms no timer, and no downstream heartbeat exists. The browser doesn't see a half-open socket (Wi-Fi switch, laptop sleep, a NAT timeout) for minutes or more. **Ran** on the virtual clock: a live viewer whose link went silent, with no close, stayed `live` for 10 minutes with 0 new hellos. The `online` event only sets `S.online`. Viewers sit on a frozen board labelled "Live". New. | Client: no message for N s while live, then resync. On `online` and `visibilitychange` → visible, probe or reconnect. Needs E-1's heartbeat to have a signal. | J3 (watchdog in sync.js), J2 (online/visibility in app.js) |
| C-5 | MEDIUM | web/core/session.js:69 | **The transport wrapper `{ ...t, … }` keeps only own enumerable members.** A class-based or getter-based adapter would silently lose `backlogBytes` (presence gate off), `congested`, `onDrop` (drops never reported, see C-4) and `close`. The port contract doesn't require own properties. Today every adapter returns an object literal, so nothing breaks yet. read + 1-line check of spread semantics. New. | Wrap each member explicitly (`backlogBytes: () => t.backlogBytes?.() ?? 0`, `onDrop: fn => t.onDrop?.(fn)`, …). Add a contract case with a class-based reference transport. | J3 |
| C-6 | MEDIUM | web/adapters/dom/app.js:63; web/adapters/dom/collab/ui.js:33-37 | **The collab UI never gets the clock port.** `mountCollab` falls back to `Date.now`, `setTimeout`, `Math.random` (record ids) and `requestAnimationFrame`. Its injectable clock has a second, undocumented shape `{ now, setTimer, clearTimer, raf }`, not the port's `{ now, mono, set, clear, random }`. Presence expiry (30 s) and outbox pacing run on wall time, so a laptop wake or NTP jump expires peers or keeps them too long. The page's UI can't be driven by the virtual clock. New. | `mountCollab({ clock })` takes the clock port (`mono` for expiry and pacing, `random` for ids) plus a `frame` scheduler. app.js passes the root's clock. | J1 (ui.js side), J2 (app.js passes it) |
| C-7 | MEDIUM | web/adapters/dom/collab/ui.js:236, :302; core/collab/notes-model.js:18-20 | **A records frame redoes everything.** Engine's `Replica.recordsState` rebuild takes **27 ms (measured)**, plus `recordsView` 5.4 ms, the drawer signature 1.5 ms and `notesView` over 50k notes 2.6 ms. `notesView` runs even when the comments tab is open, and again on every `here` (1/s). That is ~36 ms a frame while reactions stream, so under 30 fps. p7-wire listed the Replica part. The client parts are new. | Compute `notesView` only while the notes tab is visible, and keep it incremental. Make `nameOf` a user → name map, not a scan of all records (ui.js:44-49, called per preview per frame and per notes row). | J1 (+ E-3 engine) |
| C-8 | MEDIUM | web/adapters/dom/app.js:460-463 | **Incoming ops change `S.version()`, so the chrome rebuilds 4×/s on any busy board**, with the same O(notes) and O(board) scans as C-2. read. New. | Same as C-2: counters kept up to date incrementally, not `version()` in the chrome key. | J2 |
| C-9 | MEDIUM | web/core/roles.js:89; web/adapters/dom/app.js:443; web/core/signin.js:46 | **A token that expires mid-session strands the page.** The next reconnect is refused (`auth`). The banner offers Retry, which reconnects with the same token and is refused again. There is no sign-in link and no warning before `exp`. read. New. | A refused banner links to `/auth/login` (return to the board). Warn N minutes before `exp`. | J2 |
| C-10 | MEDIUM | test/web (no core test over ws.js) | **Core runs only over in-page delivery in unit tests.** `bindEditor` and `createSession` are tested over localRoom, stepped by `settle()`. ws.js's async delivery, its pre-open queue and `bufferedAmount` meet the core only in headless Chrome runs. The backlog gate is tested with a stub. ran (grep: `transport-ws.test.js` has 0 `bindEditor`/`createSession`). New. | A `syncRig` variant: wsTransport over a fake WebSocket bridged asynchronously to a localRoom. Run the collab contract and the convergence tests on it. | J4 tests |
| C-11 | MEDIUM | (none: missing port) | **No client telemetry port.** Nothing measures frame time, socket→paint latency, join time or reconnect counts, so M4 can't check the client-side NFRs (60 fps, viewers < 1 s) except by hand. Skill checklist "Operations: monitoring". New. | A `metrics` port (counters, histograms; a no-op adapter plus a beacon adapter), fed from sync.js and the frame loop. | J5 (M3) |
| C-12 | LOW | web/core/session.js:46-63 | **`sniff` is a second protocol reader outside the sync.js seam.** It parses welcome, entries and snapshot itself, and the import-only seam rule can't see it. The handle now exposes `role`, `user` and `noteAuthor`, so most of it is duplication. read. New. | Read from the handle; delete `sniff`. | J3 |
| C-13 | LOW | web/adapters/collab/sync.js:32-37 | **The sync collab adapter reaches into `session.binds.board/notes`.** It also holds core policy: which link carries presence, and the echo filter. That makes it an application service living in adapters/. read. | Move it to web/core/collab/port.js (the fake stays a test double). Do it in J3, which reshapes the binds anyway. | J3 |
| C-14 | LOW | test/web/architecture.test.js:66-75, :130-133 | **Boundary-test blind spots (ran).** These mutants survive: a Date alias (`const D = Date; D.now()`), `Math["random"]()`, a computed `import()` of an adapter, `Function("return this")()`, and `new URL(adapter, import.meta.url)` in core. A dev module reached by `new URL(...)` from dom/app.js also survives the production-graph check (static.js's DENY still refuses that path, so production is safe). All are deliberate evasions, not drift. | A runtime check: import every core module and drive a session with `Date.now`, `Math.random`, timers, `document` and `localStorage` swapped for throwing stubs. Use arch-scan's `{ urls: true }` for the production graph. Flag non-literal `import(` in core. | J4 |
| C-15 | LOW | web/adapters/dom/collab/frame.js:16 | **The selection key is rebuilt every frame:** `[...sel].join(",")`, **1.0 ms measured** at 100k selected, plus ~1 MB of garbage a frame. | An Editor selection counter, or compare size + a cheap hash. | J1 |
| C-16 | LOW | test/web/architecture.test.js:125-128; server/static.js:57 | **Two lists of dev modules can drift apart:** `isDevModule` and static.js's DENY. `web/adapters/storage/memory.js` (test-only) is in neither. It is unserved only because nothing imports it. | One list exported from one place (engine owns static.js; propose it). Add memory.js. | J4 |
| C-17 | LOW | web/adapters/dom/app.js:440, :460 | **The cap countdown mixes clocks:** `nextTryAt` comes from the clock port's `now()`, and the banner subtracts `Date.now()`. | Use `S.clock.now()`. | J2 |

### Engine-owned (for engine's manager: protocol, Replica, gateway, static.js)

| id | sev | file:line | what | proposed fix |
|---|---|---|---|---|
| E-1 | **HIGH** | PROTOCOL.md rule 12; packages/protocol/replica.js:310-315 | **No downstream heartbeat, so a client can't tell a quiet board from a dead link** (C-4). | The gateway sends a tiny frame every ≤ 10 s on an idle connection (for example, it relays the room's 2 s `{ seq, epoch }` heartbeat as `{ t: "hb", seq }`). The Replica's `timeLeft` gets an idle deadline (e.g. 25 s) while live. |
| E-2 | **HIGH** | packages/protocol/replica.js:318, :323, :339; envelope.js:47 | **Thundering herd after a gateway restart.** After a proven connection, `failed()` resets k and then counts 1, so the first wait is 1000 ms × [0.5, 1): every client of the dead gateway (×2 links today) reconnects inside one 0.5 s window. Estimate: a gateway with 10k tabs means 20k hellos plus catch-ups in 0.5 s, about 40k/s, against the 830/s join budget. read. New. | Full jitter on the first reconnect after a proven link, e.g. U(0, 5 s) (or scaled by a `retryAfter` the gateway puts in its close/shutdown frame). Keep exponential with full jitter after that. |
| E-3 | MEDIUM | packages/protocol/replica.js:591-597 | **`recordsState()` rebuilds from `confirmedRecords.toJSON()` on every rev: 27 ms measured** at 10k × 3 (C-7). Listed by p7-wire. | Apply confirmed changes incrementally; keep a pending overlay per touched thread. |
| E-4 | **HIGH** | server/gateway.js:527-540 | **Every connection gets every presence batch, viewers included.** The "viewers see presenters only" rule (web/core/collab/flags.js) is applied after download. **Measured** with jsonCodec: a cursor entry is 103 B, a 50-cursor batch 5,226 B, so at 20 batches/s that is ~105 KB/s per connection and ~210 KB/s per tab (two links). At M2's ~10k-client load test that is ~2 GB/s of gateway egress; at 100k, ~20 GB/s (estimate; I didn't check the gateway's thinning under load). Skill ch12: "presence fan-out for large groups". New. | Role-scoped fan-out: viewers get presenters' kinds only, at a lower rate (e.g. 10/s), and never a second copy per tab (C-3). |
| E-5 | MEDIUM | server/static.js:27, :206-208 | **Static serving won't hold a join wave.** About 50 unbundled modules (~237 KB of web/ plus packages), `Cache-Control: no-cache`, and a sha-256 ETag computed by reading the file on every request. 100k joins ≈ 5M revalidations in 2 min (~42k req/s), and the module waterfall adds round trips before first paint. read. New. | Immutable, content-addressed URLs (`/v/<sha>/…`), ETags computed at start-up, a CDN in front, and `modulepreload` for the graph in index.html. |
| E-6 | LOW | PROTOCOL.md rule 5 | **A refused element op resyncs from `since: 0`, a full snapshot** (14 MB in the measured example) each time. An annotator racing a note lock pays it per refusal. | For M3: resync from the last applied seq when the op-id table proves nothing else diverged. |

## 2. Proposed fix jobs (file ownership is disjoint, and disjoint from p7-tab)

| Job | Owns | Closes | When |
|---|---|---|---|
| **J1 p7-collab-perf** (client) | web/adapters/dom/collab/{ui,frame,draw}.js, web/core/collab/{records-model,notes-model,presence-model}.js, new tests in test/web/collab/perf*.test.js | C-1, C-6 (ui side), C-7 (client), C-15 | now |
| **J2 p7-chrome** (client) | web/adapters/dom/app.js, web/core/roles.js, web/main.js, web/dev-main.js, test/web/ui-*.test.js | C-2, C-4 (online/visibility), C-6 (pass the clock), C-8, C-9, C-17 | now |
| **J3 p8-one-link** (client) | web/core/sync.js, web/core/session.js, web/adapters/collab/sync.js (→ core), web/ports/{transport,collab}.js, test/web/sync.test.js, test/web/adapters/collab-rig.js | C-3, C-4 (watchdog), C-5, C-12, C-13 | **after p7-tab** (same files) and E-1 |
| **J4 p7-arch-tests** (client) | test/web/architecture.test.js, new test/web/core-runtime-globals.test.js, new ws-backed rig in test/web/adapters/ | C-10, C-14, C-16 (test side) | now |
| **J5 metrics port** (client, M3) | web/ports/metrics.js, web/adapters/metrics/* | C-11 | M3 |
| **E jobs** (engine) | E-1 + E-2 + E-3 in one job (all in replica.js, plus PROTOCOL.md and gateway.js for E-1); E-4 gateway presence; E-5 static.js | E-* | engine's call |

**For p7-tab (hello/session code):** four things would make the per-tab id awkward.

- **The hello is built inside the Replica** (`replica.connectMessages`, called at web/core/sync.js:95). Adding `tab` means an engine change, or a hack in session.js's `watched` send wrapper.
- **There are two binds per tab** (session.js:81-86), so the same `tab` goes out on two hellos. The gateway must count a (user, tab) once across two connections. Those connections may land on **different gateways** behind a load balancer, which splits a per-gateway count.
- **Nothing in web/ mints or keeps a tab id yet.** It needs the clock port's `random` (core rule), and sessionStorage if it should survive a reload.
- **J3 (one link per tab) removes the two-hello problem.** If p7-tab lands first, keep its tab id in `createSession`'s options so J3 can carry it over.

## 3. Hexagonal review (brief goal 1)

- **Boundary test bites:** **ran** 13 mutants in the worktree.
  - **Killed:** core imports an adapter (static, and the collab sync adapter); main.js imports dev-users; dom/app.js imports local.js (transitive dev); collab ui imports the fake; an adapter dynamically imports another adapter.
  - **Survived:** C-14's five evasions, the `new URL` dev edge, and a structuredClone control (allowed, correctly).
- **Composition roots:** main.js and dev-main.js are the only page files that pick adapters (dev.js, collab/dev.js and the worker entry are the dev roots). main.js's runtime graph has no dev module (ran).
- **Served set vs main.js's graph (ran):** static.js serves exactly that graph plus index.html, style.css and collab.css. Nothing in the graph goes unserved, and nothing outside it is served. Unreachable from main.js: storage/memory.js (test-only, C-16) and three type-only ports (they load nothing). Fine.
- **Contract matrix (ran, grep):** every port has a shared contract that every adapter runs.

  | Contract | Adapters that run it |
  |---|---|
  | transport | reference, local, shared-worker, ws |
  | net | local, shared-worker, ws |
  | storage | memory, session, local |
  | clock | virtual, browser |
  | auth | fake, http |
  | collab | fake, sync |

  Gaps: the collab UI's own clock shape (C-6), the `frame` scheduler, and no core-over-ws rig (C-10).
- **Quirks core leans on:**
  - The transport's object-literal shape (C-5).
  - The in-page room's stepped delivery in tests (C-10).
  - A downstream that always talks: no idle detection (C-4).
  - Not rAF: core never reads it; the DOM adapters do (allowed).
  - Not the fake's synchronous delivery: the contract runs both adapters, and the sync adapter coalesces through an injected `frame`.
- **Missing ports:** none for core. Core reads no global (the token scan passes; C-14 for its limits). The DOM adapters read globals directly, which is allowed but leaves C-6 and C-17. A metrics port is missing (C-11).

## 4. distributed-systems-design skill, CHECKER mode (client side of the NFRs)

**Step 1, scope:** CLAUDE.md's NFRs, client side only.

- **Per board:** a handful of editors, ~2k annotators, 100k viewers.
- **Latency:** editors < 150 ms; viewers < 1 s.
- **Rendering:** 60–120 fps.
- **Joins:** 100k in 2 min, about 830 joins/s.

**Step 2, estimate** (numbers from the code; measured where marked):

| Quantity | Number |
|---|---|
| Presence up | cursor 52 B, select (3 ids) 126 B, laser (2 pts) 94 B, preview (1 element) 521 B **(measured)**. Cursor at 20/s ≈ 1 KB/s up. |
| Presence down per connection | 50-cursor batch 5.2 KB × 20/s ≈ **105 KB/s**; ×2 links per tab today. |
| Join | 2 × snapshot. Measured 14 MB snapshot (20k elements + 30k comments): **decode 18 ms, load 26 ms, ~23 MB heap per Replica**. About 0.8 MB per 1k comments in the Replica alone, plus the Editor's clone of the board and the UI's records copies. |
| Join wave | 830 joins/s → ~1,660 hellos/s with two links; about 42k static revalidations/s (E-5). |
| Frame budget (16.7 ms) on a busy board | records frame ~36 ms (C-7); pan at 10k threads = recordsView 5.4 ms + 10k pin updates (C-1); wheel pan = full chrome rebuild (C-2). |
| Latency socket → paint | decode + `replica.receive` + `editor.receive`, then the next rAF: ≤ 1 frame plus decode, inside both budgets. Ops go out at once (token bucket 20/s, burst 100). |

**Step 3, high-level design:** a gateway over WebSocket; two links per tab, each with its own Replica; the Editors; the
canvas paint; and the collab UI over the collab port. It is shaped right, apart from the second link (C-3).

**Step 4, deep dives (skill checklists):**

- **Ch12 presence:**
  - "Heartbeat mechanism for presence": yes for presence (10 s repeat, 30 s expiry).
  - "Heartbeat timeout handles intermittent network": **no** for the link (C-4, E-1).
  - "Large-group presence handled differently / presence fan-out addressed": **no** (E-4).
- **Ch4 rate limiting:**
  - The client paces as a courtesy, and the gateway enforces (right).
  - The writer cap retries on backoff (p7-wire2).
- **Ch1/Ch2 retry and thundering herd:** the jitter window is too narrow after a proven link (E-2).
- **Failure modes walked:**

  | Failure | Behaviour | Verdict |
  |---|---|---|
  | Drop and resume mid-op | ops kept, resent after welcome | OK; tested (p7-wire) |
  | Refused op + resync | a full snapshot each time | E-6 |
  | Slow socket | the 16 KB presence gate and the 4 MB / 10 s hard cap | OK |
  | Role change | handled (`readOnly`, collab M2) | OK |
  | Token expiry | the page is stranded | C-9 |
  | A gateway that never answers | the 10 s connect watchdog, then backoff | OK |
  | A gateway that goes quiet after welcome | never noticed | C-4 |

**Step 5, wrap-up:**

- **Top bottlenecks:** C-3 + E-4 (bytes), C-1/C-2/C-7 (frame time), E-2 + E-5 (join waves).
- **Monitoring:** none on the client (C-11).
- **At 10×:** E-4 and E-5 dominate egress.

## 5. Next-milestone readiness (brief goal 3)

**M3 (smoothing):**

- **Remote cursors and previews jump at 20 Hz.** presence-model keeps only the latest point, so they need interpolation in draw.js.
- **Records:** incremental (E-3 / C-7).
- **Pins:** culled and transformed (C-1).
- **Chrome:** rebuilt only when what it shows changes (C-2, C-8).
- **Big snapshots:** decode off the main thread (a 14 MB snapshot is ~45 ms of main-thread work today, plus 2× for the two links).
- **The metrics port** (C-11) to see any of it.

**M5 (mobile):**

- **Memory:** two links and ~23 MB per Replica for a mid-size board are too much for low-end phones (C-3 first).
- **app.js is a 511-line adapter** that mixes input (pointer, touch, keys), chrome, dialogs and the frame loop. Split it into an input adapter (pointer and touch → session commands), a chrome renderer and the loop, so a mobile shell can reuse the input and core.
- **Background tabs:** no `visibilitychange`/`pagehide` handling, so no reconnect on resume (C-4) and the presence repeat keeps timing in the background.
- **Not seen yet:** a real-browser phone layout (p7-wire didn't capture one either).

**Job split:** J1–J4 now (J3 after p7-tab), J5 at M3; the input/chrome split of app.js at M5 (owner: whoever holds J2's files then).

## 6. sdd ensemble second opinion

**Setup:**

- **Harnesses:** codex (effort high) and grok both passed `check_adapter`. agy failed it (quota 429, resets in 53 h).
- **Where:** both ran read-only in the worktree on the same 13 findings, F1–F13.
- **What I asked for:** a verdict with file:line evidence for each finding, plus any HIGH this list misses.

| Finding | codex | grok | Result |
|---|---|---|---|
| F1 = C-5 transport spread | confirmed (session.js:67-69, transport.js:18-41) | confirmed | **confirmed** |
| F2 = C-6 collab UI clock | confirmed (app.js:63, ui.js:33-38, clock.js:23-30) | confirmed | **confirmed** |
| F3 = C-1 pins every frame | confirmed (frame.js:18, ui.js:119-132) | confirmed, and named it again as its "missed HIGH" | **confirmed** |
| F4 = C-7 / E-3 records frame | confirmed (replica.js:591-596, ui.js:235-254) | confirmed | **confirmed** |
| F5 = C-2 wheel chrome rebuild | confirmed (app.js:174-179, :461-488) | confirmed | **confirmed** |
| F6 = C-3 two links, everything twice | confirmed (replica.js:92, room.js:26: snapshots carry all streams) | confirmed | **confirmed** (plus my probe: 218 KB on each link) |
| F7 = E-4 presence to every connection | confirmed (gateway.js:420, :526-539) | confirmed | **confirmed** |
| F8 = E-2 reconnect herd | confirmed (replica.js:318-324, :338-339) | confirmed | **confirmed** |
| F9 = C-4 / E-1 silent idle link | **refuted** (see below) | confirmed | **stands, scope narrowed** |
| F10 = C-9 token expiry | confirmed (roles.js:89, app.js:443; sync.js:339-345 supports a new token, but nothing in the page supplies one) | confirmed | **confirmed** |
| F11 = C-12 `sniff` | confirmed (session.js:54-62) | confirmed | **confirmed** |
| F12 = E-5 static serving | confirmed (static.js:202-212) | confirmed | **confirmed** |
| F13 = C-14 boundary blind spots | confirmed (also arch-scan.js:15-24 documents the misses) | confirmed | **confirmed** (and my mutants ran) |

**F9: why codex's refutation doesn't hold for the client:**

- **What codex cited:** the gateway pings idle connections and closes any it hasn't heard from in 30 s (gateway.js:72, :777-778; PROTOCOL.md:225-230).
- **Why that's not enough:** it frees the server's slot. But on a half-open path, the gateway's close packet never reaches the client. The client still has no deadline of its own (replica.js:310-315), and my virtual-clock probe shows it stays `live` with 0 hellos.
- **Kept as HIGH**, with the scope narrowed to "the client never notices". The server side is fine.
- **Not yet checked:** how fast real browsers surface a dead TCP path (OS keepalive) in a live run.

**New from the ensemble:**

- **codex:** at the 100k-element board cap, every repaint walks `doc.visible()` before viewport culling (packages/core/render.js:236-239), triggered from the frame loop (app.js:497-504). I had only noted this as a core-side LOW. It goes in as **E-7** below. packages/core is herdr-draw's code and is not edited here.
- **grok:** its "missed HIGH" is C-1 again.

| id | sev | file:line | what | proposed fix |
|---|---|---|---|---|
| E-7 | MEDIUM (bites at M4; HIGH at the 100k-element cap) | packages/core/render.js:236-239 (herdr-draw's core) | **Every repaint walks all visible elements before culling,** and any incoming op or pan frame repaints. | In herdr-draw: a spatial index (grid or R-tree) for paintScene's culling. Re-copy per CLAUDE.md. Owner: whoever runs herdr-draw changes (CEO-approved step). |

## 7. What I did NOT check

- **No headless Chrome this round.**
  - C-1 and C-2's DOM costs are estimates from reading. Bun has no DOM, so only the pure parts are measured.
  - Phone layout not seen.
- **Thin reading:**
  - Read only by skimming or not at all: web/core/signin.js beyond the exp check, web/adapters/transport/local.js and shared-worker/*, the storage, clock and auth adapters, web/adapters/dom/panel.js, export.js and dom.js, the dev roots (dev.js, collab/dev.js), packages/core's paintScene culling.
  - Gateway thinning under load (E-4's numbers assume ~50 active cursors).
- **Not reproduced:** the reconnect herd (E-2) is from reading; I did not run a gateway restart.
- **Heap figures:** from one bun process with the parsed message still referenced, so treat them as ±30%.
- **Not run:** the full `bun test` (only test/web, in the worktree).
