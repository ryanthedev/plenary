# Plenary M3 (Smoothing) + M5 (Mobile Web & PWA) Plan

**Reviewed & refined via `sdd` (`codex`, high effort) on 2026-11-22 — all 6 review findings incorporated.**

**Scope decisions (2026-11-22):**
- **Open-source Mobile Web + PWA** (no native iOS/Android shell in M5).
- **Chrome on iOS (WKWebView) is the first-class default mobile target** (dynamic toolbar / `100dvh`, `visualViewport` keyboard shifts, 16 px input anti-zoom, WebKit pinch/overscroll prevention, no `SharedWorker`, 3× DPR canvas memory budget, aggressive background WebSocket suspension).
- **Hexagonal boundaries preserved:** `packages/core/` remains platform-free (no DOM/browser globals); `packages/protocol/` remains pure (`test/purity.test.js`); `web/core/` imports only `web/ports/` and `packages/` (`test/web/architecture.test.js`); `server/` respects `test/architecture.test.js`.
- **Plain JS + JSDoc, no build step.**

---

## Orchestration & Dispatch Process

1. **Plan review first (`sdd` `codex` reviewer):** Done — `codex` reviewed `docs/m3-m5/PLAN.md` against the live codebase and surfaced 1 HIGH, 4 MEDIUM, 1 LOW findings, all incorporated below.
2. **Phased execution (Phases 1 → 5):**
   - **Single writer per tree:** Never dispatch two tree-writing jobs into the same `cwd`. Where phases are file-disjoint, parallel writers use isolated `git worktree`s (`../plenary-m3-*`) and merge cleanly onto `main`.
   - **Phase loop:** `BUILD → LOCAL GATE (bun test + architecture/purity checks) → INDEPENDENT REVIEW (sdd codex diff review) → FIX CONFIRMED FINDINGS → COMMIT`.
   - **Permanent CI gates:** Every phase adds deterministic unit/integration tests to `bun test` (no flaky wall-clock thresholds in permanent tests; elapsed timings go in benchmark reports).
   - **Real-device checkpoint:** After Phase 4 lands, run `bun server/main.js` and test live on iPhone Chrome against the Mac to tune touch/pinch/keyboard feel before closing Phase 5.

---

## Phase 1 — M3 Core: Render Speed, Spatial Index & Smooth Camera

**Files:** `packages/core/spatial.js` (new, pure), `packages/core/render.js`, `packages/core/geometry.js`, `packages/core/doc.js`, `packages/core/editor.js`, `web/adapters/dom/paint.js`, `web/adapters/dom/app.js`, `test/core/m3-perf.test.js`

1. **Spatial grid index (`packages/core/spatial.js`, pure):**
   - Uniform-cell spatial index over `doc` elements, keyed/invalidated by `doc` revision counter (no manual caller drift).
   - Indexed `queryRect(rect)` returns candidate elements whose padded `bbox(el)` (accounting for stroke width, arrowheads, roughness, rotation, and bound labels/frames) intersects `rect`, **sorted in exact `doc` layer + z-order**.
   - Indexed `hitTest(point, pad)` queries only the cells covering `point ± pad` instead of scanning all N elements.
   - Note: `packages/core/spatial.js` is under `CORE_DIRS` (`packages/core/`), so it is automatically classified as core by `test/architecture.test.js` and must import only sibling core modules (zero host globals or bare packages).
2. **Viewport culling + view-independent world-space geometry cache (`packages/core/render.js`):**
   - `paintScene(doc, view, size, theme, opts)` queries the spatial index for the visible world rect (instead of scanning all `doc.visible()` elements), skipping off-screen elements and hidden layers before painting.
   - **Cache what is truly view-independent:** cache unprojected **world-space geometry** (local/world outline points, rough-sketch world paths, fill hatch lines, bound-label anchor offsets) keyed by `(el.id, el.version, el.versionNonce)` (plus host `(version, versionNonce)` for bound text labels and arrow bindings) in a bounded `Map`.
   - **Never cache screen-projected / animated / layer-opacity-baked items across view changes:** `project()`, zoom-dependent text sizing, `animState` (when timeline playback/scrub is active), `theme`, and `layer.opacity` are applied cheaply at paint time only to the ~O(visible) elements in the viewport.
   - Expose optional instrumentation counter (`stats: { visited, cacheHits, cacheMisses }`) for deterministic testing.
3. **Damped camera & inertia (`packages/core/editor.js`):**
   - Pure animated camera transitions (`animateViewTo(target, { durationMs })`) for `zoomToFit`, jump-to-thread, and zoom shortcuts.
   - Pan velocity tracking + exponential deceleration (`stepCamera(dtMs)`) after hand/touch flicks, cleanly cancelled on next pointer down.
   - Uses explicit `dtMs` / injected `clock` (100% deterministic in unit tests).
4. **Backing-store DPR memory guard (`web/adapters/dom/paint.js`):**
   - Cap canvas backing-store pixel budget (e.g. max 8,388,608 px ≈ 8 MP) by scaling effective DPR down only when `cssW * cssH * dpr * dpr` exceeds the cap, keeping 3× iPhone screens crisp while staying safely under WKWebView's GPU canvas memory ceiling.
5. **Phase 1 Gate (`test/core/m3-perf.test.js` — deterministic work bounds):**
   - On a 10,000-element board with ~100–200 elements in viewport:
     - `paintScene` visits ≤ visible + small margin (≪ 1,000 elements, not 10,000).
     - Panning/zooming across unchanged elements produces **0 world-geometry cache misses** for already-seen elements (`cacheHits > 0`, `cacheMisses === 0`).
     - Updating 1 element invalidates only that element (and its bound label / bound arrow), leaving all other cached geometry intact.
     - `hitTest` via spatial index checks ≪ 5% of elements on a 10,000-element board and returns the exact same top element as linear scan across randomized queries.
     - Exact pixel/display-list parity with unculled render for shapes, rotated elements, arrowheads, bound labels, frames, images, and animated elements.
   - Camera damping/inertia tests (monotonic convergence, zoom-bound clamping, immediate cancel on pointer down).
   - `test/purity.test.js`, `test/architecture.test.js`, `test/web/architecture.test.js` all pass.

---

## Phase 2 — M3 Collab: 60–120 fps Presence Interpolation & HTTP Snapshot Client (`F9`)

**Files:** `web/ports/net.js`, `web/adapters/net/snapshot.js` (new) or `web/adapters/transport/ws.js`, `web/main.js`, `packages/protocol/replica.js`, `web/core/sync.js`, `web/core/collab/presence-model.js`, `web/adapters/dom/paint.js`, `test/web/m3-presence-smooth.test.js`, `test/web/m3-http-snap.test.js`

1. **Frame-rate-independent presence interpolation (`web/core/collab/presence-model.js`, `web/adapters/dom/paint.js`):**
   - Separate raw target presence (`cursor`, `preview`) from smoothed display state.
   - Advance display state via `1 - Math.exp(-dtMs / tauMs)` (`tauMs ≈ 45 ms`) so 50–100 ms server ticks render smoothly at 60–120 fps.
   - Smooth laser alpha decay and floating emote particle lifecycles on the overlay layer (no main-canvas repaint when only presence animates).
   - **Zero idle battery drain:** stop requesting `rAF` once all interpolated targets settle within `< 0.25 px` and all laser/emote particles expire.
2. **HTTP snapshot fetch port & `Replica` state machine (`F9`):**
   - **Port (`web/ports/net.js`):** add `fetchSnapshot(url, { signal }) → Promise<object>` (returns parsed snapshot JSON) so `web/core/sync.js` never touches browser `fetch` directly (`test/web/architecture.test.js` stays green). Implement browser `fetch` adapter in `web/adapters/transport/ws.js` (or `web/adapters/net/snapshot.js`) and wire in `web/main.js`.
   - **`Replica` (`packages/protocol/replica.js`):**
     - Accept optional `snapHttp: boolean` option; `connectMessages()` includes `snap: "http"` in `hello` when `snapHttp` is true and not fallen back.
     - In `welcome(msg)`: when `msg.snapshot` (`{ seq, url, bytes }`) is present and `msg.snapshot.seq > this.applied`: enter `awaitingSnapshot` state (`{ seq: msg.snapshot.seq, url: msg.snapshot.url }`), buffer any arriving `entries` (`> applied`), and surface the fetch request to `sync.js` (via callback/return).
     - When `sync.js` completes `fetchSnapshot(url)`, it feeds the snapshot object straight into `replica.receive(snapshotMsg)` (which applies the snapshot, clears `awaitingSnapshot`, and flushes all buffered tail entries in `seq` order up to `welcome.seq`).
     - If `msg.snapshot.seq <= this.applied`: ignore the HTTP fetch (already at or past that snapshot) and apply tail entries normally.
     - **Failure fallback:** if `fetchSnapshot(url)` fails (network error, 401/404/500, bad JSON, or timeout), disable `snapHttp` for the next reconnect on this link, close and reconnect cleanly so the server sends the inline WS snapshot — **never dropping pending ops** and cancelling any in-flight `AbortController` if the socket closes first.
3. **Phase 2 Gate:**
   - Presence tests: exponential convergence, settle-to-idle (`needsFrame === false` when settled), laser/emote decay.
   - Snapshot state-machine & live gateway E2E tests: entries arriving during fetch and after fetch, `snapshot.seq <= applied`, HTTP failure fallback with pending ops preserved, and live `sync.js` + `ws.js` against a checkpointed `createServer` verifying identical board state.

---

## Phase 3 — M5 Input: Touch Gestures & Stylus / Apple Pencil

**Files:** `packages/core/model.js`, `packages/core/render.js`, `packages/core/editor.js`, `packages/protocol/envelope.js`, `web/adapters/dom/app.js`, `test/core/m5-touch.test.js`

1. **Multi-touch gesture recognizer in `packages/core/editor.js`:**
   - Track active pointers (`Map<pointerId, { x, y, type, pressure, t }>`) inside `Editor` (platform-free).
   - **2-finger pinch-to-zoom + pan:** anchored at the live midpoint of the two fingers; smooth scale clamping; transitions cleanly to Phase 1 camera inertia on release; cancels any accidental 1-finger stroke that just started (`< 80 ms` and `< 8 px`) when the second finger lands so pinching never leaves stray ink dots.
   - **2-finger tap → Undo, 3-finger tap → Redo** (taps within slop and `< 250 ms`).
   - **Viewer mode default:** 1-finger drag pans immediately (no box-select), while tap still inspects comment pins/threads.
   - **Adaptive touch slop:** scale `HANDLE`, `SNAP`, `DRAG_SLOP`, and `PORT_SNAP` by ~2.5× when `pointerType === "touch"` (tight precision preserved for `"mouse"` and `"pen"`).
2. **Stylus / Apple Pencil & canonical `pressures` array:**
   - **Palm rejection:** while a `"pen"` pointer is active (and for a 300 ms grace window after pen up), suppress single-finger `"touch"` drawing/selection while still allowing 2-finger touch pan/zoom.
   - **Coalesced events:** in `web/adapters/dom/app.js`, read `e.getCoalescedEvents?.()` for `freedraw`/`laser` so 120–240 Hz Apple Pencil & iPhone touch produces smooth curves.
   - **Canonical pressure shape:** reuse the existing `pressures: number[]` field already initialized on `freedraw` elements in `packages/core/model.js:51–53` (parallel to `points: [x, y][]`, values clamped to `[0.1, 1.0]`, never mutating `points` tuples). Update `packages/core/render.js` to render variable-width segments when `pressures` has valid non-uniform entries, falling back cleanly to fixed-width `strokeWidth` for legacy/empty/mismatched `pressures`.
3. **Phase 3 Gate (`test/core/m5-touch.test.js`):**
   - Pinch midpoint invariance (world point under midpoint stays fixed across zoom), stray-dot cancellation on 2nd-finger land, 2-finger undo / 3-finger redo, viewer 1-finger pan, palm rejection during pen stroke, adaptive touch slop, and `pressures` rendering + malformed/legacy fallback tests.

---

## Phase 4 — M5 Chrome-on-iOS Shell, Viewport & Responsive UI

**Files:** `web/index.html`, `web/style.css`, `web/adapters/dom/collab/collab.css`, `web/adapters/dom/app.js`, `web/adapters/dom/panel.js`, `test/web/m5-mobile-ui.test.js`

1. **Chrome-on-iOS (WKWebView) viewport & gesture hardening:**
   - Use `height: 100dvh` with `--vv-height` and `--vv-top` updated from `window.visualViewport` (`resize` and `scroll`) so `.app`, `.dock`, and `.sheet` stay pinned cleanly above Chrome iOS's dynamic toolbar and software keyboard.
   - Apply `env(safe-area-inset-top/bottom/left/right)` to `.topbar`, `.dock`, `.hud-*`, and `.sheet`.
   - Lock browser gestures on the canvas: `overscroll-behavior: none` on `html, body`, `touch-action: none` on `.canvas` / `canvas.board`, and `preventDefault()` on WebKit `gesturestart`/`gesturechange`.
   - Enforce `font-size: 16px` minimum on all text inputs/textareas (`.ink`, comment composer, thread reply, search) on `@media (pointer: coarse)` so Chrome on iOS never auto-zooms on focus.
2. **Touch-first responsive layout (390×844 phone & 768×1024 tablet):**
   - Minimum 44×44 px hit targets on coarse pointers for primary tools, emote bar, and sheet controls.
   - Swipe-down-to-dismiss **bottom sheets** (`.sheet`) for tools, notes list, and comment threads (matching `docs/m2/design/shots/phone-*.png`).
   - Compact top bar on phone widths (`<= 640px`): board title + connection pill + viewer count + overflow menu; tools & emotes in bottom dock.
3. **Phase 4 Gate (`test/web/m5-mobile-ui.test.js`):**
   - Automated checks verifying `visualViewport` CSS variable sync, `>= 16px` coarse-pointer input font sizes, safe-area inset rules, bottom-sheet open/swipe-dismiss, and viewer/annotator/presenter mobile layout invariants.

---

## Phase 5 — M5 PWA & Mobile Network Resilience

**Files:** `web/manifest.webmanifest`, `web/icons/icon.svg`, `web/icons/icon-192.png`, `web/icons/icon-512.png`, `web/index.html`, `server/static.js`, `web/adapters/dom/app.js`, `test/server/static.test.js`, `test/web/m5-resume.test.js`

1. **PWA plumbing (no Service Worker in M5 — immutable `/v/<build>/...` HTTP cache avoids stale-cache OAuth pitfalls):**
   - Add `web/manifest.webmanifest` (`name: "Plenary"`, `display: "standalone"`, `start_url: "/"`, theme/background colors, icons) and `<link rel="manifest">`, `<meta name="theme-color">` (synced with light/dark theme toggle), and `apple-mobile-web-app-capable`.
   - **Static allowlist (`server/static.js`):** add `.webmanifest` (`application/manifest+json`) and `.png`/`.svg` MIME types, AND parse `<link rel="manifest">` JSON `icons[].src` during `staticSite()` startup walk so every declared icon is added to the startup allowlist and memory cache (no 404s on icons!).
2. **Mobile background/foreground resume (reconciled with existing probes in `web/adapters/dom/app.js:617–667`):**
   - Extend the existing `visibilitychange` / `online` probe in `web/adapters/dom/app.js` to also listen to `window.pageshow` (`e.persisted` for iOS bfcache restores).
   - Preserve the existing recent-message guard, already-sent-hello guard, role-based jitter (avoiding reconnect storms), and `Replica.reconnectWait()` backoff invariants — never spawning duplicate hellos or bypassing backoff on an unhealthy server.
3. **Phase 5 Gate:**
   - `test/server/static.test.js`: GET/HEAD `/manifest.webmanifest` (`application/manifest+json`) and every declared icon URL return 200 with valid content.
   - `test/web/m5-resume.test.js`: `pageshow` (`persisted: true`) + `visibilitychange` + `online` trigger exactly one probe (no duplicate hello, respects recent-message guard and backoff).
   - Full `bun test` green (0 failures) + live verification pass on iPhone Chrome against local `bun server/main.js`.
