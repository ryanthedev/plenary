# Report: p7-perf (J1 of p7-audit: collab UI per-frame cost)

**Panning a 10k-thread board now costs 1 DOM write a frame, down from 80,002.** Only pins near the view are in the DOM
(55 at 100% zoom, down from 10,000), and the number of pins is capped, with the rest shown as clusters.

- **C-15:** a 100k selection is no longer walked on pan frames.
- **C-7:** the notes rows are built only while the notes tab is open.
- **C-6:** the collab UI's time comes from the clock port: expiry and pacing on `mono`, ids on `random`.
- **Tests:** `bun test` gives 1233 pass, 136 skip and 1 fail. The failure is `test/core-source.test.js` (packages/core has
  drifted from herdr-draw). It was already failing at baseline, before any change here, and it is outside my files.
- **Mutants:** 14 run, all 14 killed.

- **Who:** worker plenary-p7-perf, manager t14k. Not committed (the manager commits).
- **Design:** the distributed-systems-design skill (systems-design v0.1.0) in APPLIER mode, at client scope
  (section 5). It was applied **after** coding: I had read the skill's ground rules in OFFICE.md and the audit's
  CHECKER pass, but didn't load the skill until review, and section 5 is reconciled against it.

## 1. What changed

| File | Change |
|---|---|
| `web/core/collab/records-model.js` | **New pure helpers.** `reanchor(rv, element)` re-resolves element anchors in place, so a board change doesn't rebuild the view. `nameIndex(records)` builds the user → name map (first match wins, in the old scan's order). `layoutPins(threads, { box, cap, cell, keep, maxClusters })` culls threads to a world box, caps the pins and clusters the rest on a grid that coarsens until it has at most `maxClusters` clusters. Element-anchored threads now carry `home` (the anchor's own point) for `reanchor`. |
| `web/core/collab/notes-model.js` | **Bounded selection.** `notesView` keeps the newest `limit` notes in a typed-array heap: O(n log limit), no sort of every note, and stable on ties. It looks up labels only for the rows it shows. New: `notesCount(elements)`, one pass with no allocation. |
| `web/adapters/dom/collab/ui.js` | **Clock and frame (C-6).** `mountCollab({ clock, frame, pinCap })` takes the clock port. `mono` drives presence (expiry, lasers, floats) and outbox pacing; `now` drives the "3 min" stamps and the popover's 30 s refresh; `random` drives record ids; `frame` drives the overlay repaint. No `Date.now`, `setTimeout`, `Math.random` or `requestAnimationFrame` is left (a test checks the source).<br>**Records (C-1/C-7).** `recordsView` is cached per `port.records()` identity, onRecords count, role and me. A board change runs only `reanchor`. `nameOf` uses the index.<br>**Pins (C-1).** The pins sit in one layer. While the zoom is unchanged and the viewport stays inside the region placed last time (the viewport plus half a viewport on each side), a pan sets only that layer's `transform`. Otherwise the pins in the region are re-placed, at most `PIN_CAP` (300), and the rest become `button.pin.cluster` with a count (click it to jump there). Each pin writes only the values that changed.<br>**Drawer (C-7).** The notes rows are built only while the notes tab shows. The "Notes N" label refreshes on the 1 s tick. The comments rows are checked only when the records view changed. The empty popover host is no longer cleared on every frame. |
| `web/adapters/dom/collab/frame.js` | **`collabFrame` (C-15; round 1, replaced in Round 2 by a capped exact compare).** It hashes the selection (order-independent FNV, no allocation) only when the Set, its size or the Editor's `version` moved. While only the view moved (a new view object, same doc and rev), the hash waits up to `HASH_EVERY` = 15 frames. It builds `[...sel]` only for a real change. `layout({ board })` passes `board: true` only when the board or notes doc (or its rev) changed.<br>**New defaults.** `domClock()` and `domFrame(clock)` are what `mountCollab` falls back to (see deviation D1 in section 6). |
| `test/web/collab/perf-fixture.js` | **New:** a seeded busy board (10k threads × 3 comments, 50k notes), a stub DOM that counts writes, a pan driver. |
| `test/web/collab/perf-bench.js` | **New:** the bench (`bun test/web/collab/perf-bench.js`; `OLD_FRAME=<old frame.js>` adds the old selection check). It uses only public API, so the same file measured before and after. |
| `test/web/collab/perf.test.js` | **New:** 13 tests (section 3). |

## 2. Before and after

Measured with bun on this Mac (M-series): the median of 15–60 runs. **DOM writes are counted on the stub DOM, not
timed.** A real browser adds style recalc and layout per write, so those rows are the ones that matter. "Fake DOM"
times include the stub's own cost.

| What (10k threads × 3, 50k notes, 50 cursors, 100k selected) | Before | After |
|---|---|---|
| Pins in the DOM, 1200×800 view at 100% | 10,000 | **55** |
| Pins in the DOM, zoomed out to 5% (whole board) | 10,000 | **81** (clusters with counts) |
| DOM writes per pan frame, 100% zoom | 80,002 | **1** |
| DOM writes per pan frame, 5% zoom | 80,002 | **1** |
| Pan frame, fake DOM (ms) | 12.6 | **0.002** |
| Selection check per pan frame, 100k selected (ms) | 0.89 (the `join` each frame) | **0.001** |
| `here` (1/s) with the comments tab open (ms) | 8.25 (notesView over 50k, plus a nameOf scan per row) | **0.005** |
| `here` with the notes tab open (ms) | (same as above) | 4.9 |
| A records change (a reaction), comments tab (ms) | 41.9 | 32.0 |
| … of which the fake port's own `records()` rebuild (ms) | ~23 | ~23 |
| `recordsView`, pure (ms) | 3.2 | 4.1 (now once per records change, never per frame) |
| `notesView`, pure, 50k notes (ms) | 2.6 | 3.1 (see below) |
| presence `view()`, 50 cursors (ms) | 0.017 | 0.016 |
| **Worst frames (after only):** a zoom frame, 100% → 55% (a full re-place each frame) | (80,002 writes) | 270 writes, 0.16 ms fake DOM |
| A pan frame that leaves the placed region (one re-place) | (80,002 writes) | 407 writes, 0.05 ms fake DOM |
| A board-op frame: reanchor 5k element-anchored threads | (recordsView + 80,002 writes) | 0.2 ms, writes only for moved pins |

**Reading the numbers:**

- **A records change is about 9 ms of UI work** (32 minus the fake's 23), down from about 19. In production, the
  port's share is the Replica's `recordsState` rebuild (E-3, engine; 27 ms in p7-audit). That one is left alone, as
  the brief says.
- **`notesView` on its own is not faster.** The fixture's notes arrive in ascending `updated` order, which is the
  heap's worst case. The win is that it no longer runs on the comments tab (the default) or on every `here`.
- **`recordsView` got slightly slower** from the added `home` field. That is noise-level, and it now runs once per
  records change instead of per frame.

## 3. Tests (test/web/collab/perf.test.js) and mutants

| Test | Shows |
|---|---|
| C-1 pan O(1) | 60 pan frames: ≤ 1 write a frame and 0 `port.element` calls, the same for 1k and 10k threads. The layer's transform is the pan. |
| C-1 re-place | Panning past the margin re-places only threads inside the viewport plus margin, with writes bounded by 14 × (pins + clusters) + removals: O(cap), not O(threads). |
| C-1 cap | Zoomed out over 10k threads with `pinCap` 50: ≤ 50 pins, ≤ `MAX_CLUSTERS` clusters, and pins plus cluster counts = 10,000. |
| C-1 layoutPins | The open thread stays a pin past the cap; the grid coarsens to fit `maxClusters`; counts are conserved. |
| C-1 board change | A moved element moves its pin when the doc's rev changes, and only then are anchors looked up. |
| C-15 pan (round 1; replaced in Round 2) | A 100k `Set` subclass counts iterations: 0 walks over 14 pan-only frames. A same-size in-place change mid-pan is sent within `HASH_EVERY` frames. |
| C-15 Editor | core's real Editor bumps `version` on `select` and replaces `view` on `wheel` without touching `doc.rev`. These are the guard's assumptions, so a core change that breaks them fails here. |
| C-7 drawer | On the comments tab, a `here` calls `port.notes()` 0 times. The notes tab builds 200 rows. A new note shows in the label within the 1 s tick ("Notes 900" → "Notes 901") and is listed first. |
| C-7 notesView | The bounded top-N equals a full stable sort (3,000 notes, ties, deleted notes, labels), plus an explicit tie at the cut. |
| C-7 nameIndex | The first match wins, in scan order. |
| C-6 expiry | Presence on the virtual clock with wall and mono apart: +1 h and then −2 h of wall time expire nothing. 30 s of mono expires the peers. |
| C-6 pacing and ids | A paced cursor goes out on a mono timer across a backward wall step. A record id comes from the port's `random`. |
| C-6 source | ui.js has no `Date.now`, `setTimeout`, `clearTimeout`, `Math.random`, `requestAnimationFrame` or `performance.now`. |

**Mutants:** each one was applied, `bun test test/web/collab` was run, and the file was restored.

| Mutant | Result |
|---|---|
| M1 the pan re-places every frame (no fast path) | killed (C-1 pan) |
| M2 a pan re-resolves anchors | killed (C-1 pan) |
| M3 no pin cap | killed (C-1 cap) |
| M4 presence on wall `now` | killed (C-6 expiry) |
| M5 outbox on wall `now` | killed (C-6 pacing) |
| M6 the selection is hashed every pan frame | killed (C-15 pan) |
| M7 notesView runs on the comments tab | killed (C-7 drawer) |
| M8 equal `updated` displaces an earlier note | killed (C-7 notesView). It first survived, because the random data never put a tie at the cut; the explicit tie case now catches it. |
| M9 nameIndex: the last match wins | killed |
| M10 ids not from `clock.random` | killed (C-6 ids) |
| M11 a board change never re-anchors | killed (C-1 board change) |
| M12 the open thread is not kept a pin | killed (layoutPins) |
| M13 the notes count is never refreshed | killed. It first survived, because 1,000 and 1,001 both show as "1k"; the test now uses 900. |
| M14 the deferred hash is never forced | killed (C-15 pan) |

The existing tests still pass unchanged: ui.test.js (pin left/top, element follow, detach), wire2's frame test, and
architecture.test.js.

## 4. What I did NOT check

- **No real browser.** The transform-on-the-layer scheme, the cluster's look and the real cost of a re-place (style
  recalc and layout) are unverified in Chrome.
  - `collab.css` (not mine) has no `.pin.cluster` rule, so clusters look like plain pins with a count. Suggested for
    whoever owns collab.css: a larger, muted bubble.
  - The `.collab-pins` layer must not be `contain`ed or sized so that a transform clips it. I didn't read collab.css
    for this.
- **app.js doesn't pass `clock` or `frame` yet.** p7-chrome adds that. Until then, the page runs on `domClock()` (the
  browser's).
- **The comments drawer still builds every row** (10k at the cap) whenever a row's content changes (a new thread, a
  rename, a count). A reaction alone no longer rebuilds it. It needs a virtualised or capped list (a UI decision, not
  in this brief).
- **"Notes N" can lag up to 1 s** on the comments tab, because the port has no notes-changed signal. Proposal for
  web/ports/collab.js (J3's files): an `onNotes` or a `notesRev`. With it, the notes view could also be cached per
  revision (truly incremental), which I could not do over a port that returns a fresh array each call.
- **The `here` with the notes tab open is still O(notes)** (4.9 ms at 50k), once per second.
- **The selection hash is still O(selected) on a non-pan version bump** (hover, a drag, playback): 0.7–1.2 ms at
  100k ids (random 21-character ids: 1.2 ms). The old `join` cost 0.9 ms. So at 100k selected, a frame that isn't a
  pan is no better than before. It is better only on pans and on still frames. Fixing that needs a selection counter
  in core's Editor (herdr-draw's code: not edited here).
- **One `test/web` run failed once and didn't reproduce** in three re-runs. Other sessions were editing test/web at
  the time (the expect counts moved between runs). I didn't capture which test it was.
- **`perf-fixture.js` and `perf-bench.js` are not `*.test.js` files.** The brief named new files `perf*.test.js`.
  These two are a helper and a runnable bench, so `bun test` doesn't run the bench.
- **(Round 1 only; gone in Round 2.)** **`HASH_EVERY` delays a selection change made during a pan** by up to 15 frames (~250 ms). A change in size, Set or
  doc is sent at once. Only a same-size in-place swap while the view moves waits.
- **The legacy clock shape** `{ now, setTimer, clearTimer, raf }` (with mono = now) is still accepted, because
  test/web/collab/{ui,wire,wire2}.test.js pass it and those files aren't mine. Moving them to the port shape is a
  follow-up; then `clockPort`'s legacy branch can go.
- **Not re-run:** the headless-Chrome rigs; the sync adapter under a real board (bench and tests use the fake port).

## 5. Systems design skill (APPLIER, client scope; applied after coding)

- **Phase 1, scope:** this job is the client's 60–120 fps NFR on a busy board. The numbers are from CLAUDE.md and the
  brief: 10k threads (the protocol's cap) × 3 comments, 50 cursors, 100k selected, 50k notes. A frame has 16.7 ms
  (8.3 ms at 120 Hz) for paint, the chrome (p7-chrome) and this. Assumed: a pan at 60 fps, records changes at ≤ 20/s
  (the op bucket), `here` 1/s. The scope came from the brief, so I asked no one.
- **Phase 2, estimate:** before, a pan frame did ~80k DOM writes (8 per pin) plus a 3–5 ms `recordsView`. At ~0.1 µs
  per write in a browser that is ≫ 16 ms. A `here` was O(notes) (8 ms at 50k). The target is ≤ 1 ms of collab work
  on a pan frame, and O(cap) writes on any frame.
- **Phase 3, high-level design:** split the work by what triggers it.

  | Trigger | Work |
  |---|---|
  | Pan | one layer transform, O(1) |
  | Leaving the region, or a zoom | O(threads) arithmetic + O(cap) writes |
  | Board change | `reanchor`: O(element-anchored threads) |
  | Records change | one `recordsView` |
  | `here` | O(1), unless the notes tab is open |

- **Phase 4, deep dives:**
  - **Caching (Ch1):** the records view is a read-through cache. Its invalidation key is records identity, an
    onRecords counter, role and me. The stale risk is a port that changes records without firing onRecords, which
    the port contract forbids.
  - **Presence (Ch12):** heartbeat expiry now runs on a monotonic clock. A wall jump (NTP, laptop wake) neither drops
    live peers nor keeps dead ones.
  - **Bounding the DOM:** the cap plus clusters keep it at ≤ 300 pins + 200 clusters at any zoom. The cost: below
    the cap a pin's exact place is known, above it you see counts until you zoom in.
  - **The selection hash:** it trades up to ~250 ms of staleness, for a rare case (a same-size swap during a pan),
    for O(1) pan frames.
- **Phase 5, wrap-up:**
  - **Top 3 bottlenecks left:**
    - E-3, the Replica's records rebuild (engine).
    - The comments drawer rebuilding every row on a content change.
    - The selection hash on non-pan frames at very large selections.
  - **Failure walked:** a wall-clock jump mid-session is now handled.
  - **Monitoring:** the client has none (C-11, J5), so these frame costs can't be watched in production.
  - **At 10×** (100k threads, past today's protocol cap): culling is still O(threads) arithmetic per re-place, about
    1 ms. It would need a spatial grid index.

## 6. Deviations from the brief

- **D1, the default clock (accepted by t14k, 2026-11-12).** The brief says to default "through the existing DOM clock adapter". That is
  `web/adapters/clock/browser.js`, but ui.js may not import it: an adapter never imports another adapter
  (architecture.test.js:59, `adapter-imports`). So the default lives in the dom group as `frame.js`'s `domClock()`. It
  copies browserClock's behaviour, and DOM adapters may read globals. Once app.js passes the root's clock (p7-chrome),
  it is used only by web/collab/dev.js.
- **D2, records cache key.** The cache is keyed on `port.records()` identity **plus** an onRecords counter, so a port
  that mutates in place still invalidates.

## Round 2 (after p7-perfv FAIL; t14k's fix list)

**All six items are fixed (the verifier's appendix, M1, M2, M3, and LOWs L1/L2/L7), and 29 of 29 mutants are
killed.** That includes everything the re-verify needs: H1–H10 (H5 withdrawn), V37, V27 and V28.

- **Tests:** `bun test` gives 1271 pass, 137 skip and 2 fail. Neither failure is in my files:
  - **`test/core-source.test.js`:** herdr-draw's uncommitted core/editor.js. t14k confirmed this is not this job.
  - **`test/web/ui-app.test.js` "jumpTo (the collab port's) … clamped to the zoom limits":** t1h3's test for
    app.js's `jumpTo`. It expects scale 50 clamped to 8 and gets 50, so it is t1h3's work in flight on app.js (the M1
    ask below). My cluster zoom never asks for more than 4.
- **Collab tests:** `bun test test/web/collab` gives 117 pass, 0 fail.

### What changed

| Item | Change |
|---|---|
| (1) Verifier tests | The report's Appendix is saved verbatim as `test/web/collab/perf-guards.test.js` (10 tests: K15, K17, K19, K22, K23, K25, K30, K32, K36, K38). |
| (2) M1, a cluster click opens | `layoutPins` clusters now carry their members' `bounds`. A new pure `zoomToFit(bounds, { w, h, scale })` gives the centre, and the scale that fits the members in 80% of the view: at least 2× the current scale (each click zooms in), at most 4. The cluster's click calls `port.jumpTo({ x, y, scale })`. **web/ports/collab.js** (t14k's ruling): `jumpTo?({ x, y, scale? })`, with scale optional; a port that ignores it still centres. **app.js not edited:** t14k asked t1h3 to make its `jumpTo` honour scale. Until then, a production click only centres. |
| (3) M2, refused selection | `collabFrame` reads only the first `MAX_SELECT_IDS` (500) ids of the selection (`headIds`), never the whole Set. It compares them exactly with what was last sent. A send the outbox refused is retried when `collab.statusRev` moves (mountCollab bumps it on every onStatus), not every frame. A collab object without `statusRev` (wire2's stub) still retries every frame. This also removes the hash, `hashIds` and the `HASH_EVERY` pan deferral: reading 500 ids costs microseconds, so a mid-pan change goes out at once. |
| (4) M3, domClock contract | New `test/web/collab/perf-clock.test.js` runs `clockContract("domClock (frame.js)")` (9 cases). It also pins that mono is `performance.now` (with the wall clock stubbed elsewhere), the clamp fallback without `performance`, and `set`'s bad-ms handling. |
| L1, hash collision | Gone with the hash: the compare is exact. A test swaps the verifier's colliding pair `id43zx` → `idbpad` and sees it sent. |
| L2, contents not lengths | The C-15 tests check the ids sent, e.g. `[...first 500 without el5, "el500"]`. |
| L7, browser.js header | It now names frame.js's `domClock()` as the D1 copy and the test that keeps the two in step. |

### Mutants (each applied, `bun test test/web/collab` run, file restored)

| Mutant | Killed by |
|---|---|
| H1 the fast path ignores zoom | K15, M1 |
| H2 no onRecords counter in the cache key | K17 |
| H3 no role in the key | K19 |
| H4 no drawer-key reset on the notes tab | K22 |
| H6 the notes doc's rev not in the board key | K23 |
| H7 the fast path ignores the open thread | K25 |
| H8 reanchor ignores `home` | K38 |
| H9 `put()` always writes | K30 |
| H10 the popover is never cleared | K32 |
| V37 a cluster click does nothing | M1 cluster-click test |
| V27 domClock mono = `Date.now` | perf-clock (2 tests) |
| V28 domClock `set` passes bad ms | perf-clock |
| R2a no 500-id cap (walks 100k) | C-15 ×3 |
| R2b a refused send retried every frame | C-15 (M2) |
| R2c statusRev never bumps | C-15 (M2) statusRev |
| R2d the cluster jump without a scale | M1 ×2 |
| R2e the selection compared by length only | C-15 contents, L1 |
| Round 1's B1–B5 and B7–B13 (B6/B14 targeted the removed hash deferral) | all killed again |

### Bench, re-run

The pan, zoom, re-place and `here` rows are unchanged from round 1. The selection row now shows the worst frame too
(verifier note L4):

| Selection check per pan frame, 100k selected | Median (ms) | Max (ms) |
|---|---|---|
| Before p7-perf (the `join` each frame) | 0.78 | 1.05 |
| Round 1 (hash, deferred while panning) | 0.001 | ~1 (every 15th frame, per p7-perfv) |
| **Round 2 (first 500 ids, exact compare)** | **0.010** | **0.17** |

The max is now about what any non-pan frame costs too (hover, drag), so round 1's "no better than before on non-pan
frames at 100k" note no longer applies.

### Still not checked

- **No real browser this round either.** The cluster zoom in the real page waits on t1h3's app.js change.
- **Verifier LOWs L3, L5 and L6 are not addressed** (t14k listed only L1, L2 and L7):
  - **L3:** pins can pop in at the edge for one frame.
  - **L5:** `rv.threads.find` runs per pan frame while a thread is open (about 0.05 ms).
  - **L6:** the `me.name` cache key has no test.
