**Round 2: PASS** (see "Round 2" below; one non-blocking MEDIUM). Round 1, below, was FAIL.

**FAIL**: the code is right and the numbers reproduce, but 9 mutants on claimed fixes survive the builder's tests (HIGH by the brief's rule), plus 3 more on M1 and M3.

# Report: p7-perfv (verifies p7-perf: collab per-frame cost)

- **Who:** verifier plenary-p7-perfv, manager t14k. Read-only on main. I edited nothing in the tree except this file.
- **Bottom line:** I could not break the behaviour.
  - **Numbers:** the pan-frame figures reproduce, on both the fake port and the real sync port with real Editors.
  - **D1:** `domClock()` passes the clock contract.
  - **Gap:** a large part of the new caching and guard logic is untested. Nine mutants on claimed fixes pass `bun test test/web`, and each is killed by a test I wrote. All of my tests pass on the builder's code.
- **Fix:** adopt those tests (the Appendix holds the whole file; save it as test/web/collab/perf-guards.test.js) and fix M1 and M2.
- **Required for re-verify:** besides H1–H10 (H5 withdrawn), the M1 survivor V37 and the M3 survivors V27/V28 must be killed by a test.

## HIGH

| # | Surviving mutant (on the builder's tests) | Claimed fix it breaks | Killed by |
|---|---|---|---|
| H1 | The fast path ignores zoom: drop `placed.scale === sc` (web/adapters/dom/collab/ui.js:166). | "Zoom changes re-cluster." Zooming **in** keeps the viewport inside the placed box, so pins stay at the old scale (misplaced). The existing tests only zoom out, where the box check catches it anyway. | K15 |
| H2 | Drop the onRecords counter from the records cache key (ui.js:68). | D2: "a port that mutates in place still invalidates." No test uses such a port. | K17 |
| H3 | Drop `role` from the cache key (ui.js:68). | Stale rights: demoted to viewer, the open popover keeps its reply box. | K19 |
| H4 | Drop the `sigs.drawerRev = null` reset on the notes tab. | Back on comments with no records change, the drawer keeps showing the notes rows (stale). | K22 |
| ~~H5~~ | **Withdrawn.** Leaving `rvRev` out of the drawer key in both places (ui.js:336-337) is killed by ui.test.js's "comments drawer lists open and resolved threads…". My first run of this mutant changed only one place. | | (K36 also kills it) |
| H6 | Leave the notes doc's rev out of the board key (web/adapters/dom/collab/frame.js:43). | A thread on a **notes** element doesn't follow it when the element moves (rev bumped in place, as a real Editor does). | K23 |
| H7 | The fast path ignores the open thread: drop `placed.open === S.open` (ui.js:166). | Opening a clustered thread (drawer row, no view change) never makes it a pin. layoutPins' `keep` is tested only as a pure function. | K25 |
| H8 | `reanchor` ignores `home`: a detached thread keeps its last place (web/core/collab/records-model.js:101). | Moved, then deleted, the pin should go to the anchor's own point (records-model header). It stays at the moved corner. | K38 |
| H9 | `put()` always writes (ui.js:163). | "Each pin writes only the values that changed." The re-place test's 14× bound absorbs it. | K30 (0 writes to an unchanged pin) |
| H10 | `if (popHost.childNodes.length) replace(popHost)` deleted outright (ui.js:237). | The open thread is deleted by its author and the popover stays. | K32 |

- **Equivalent or redundant mutants, not findings:**
  - **Records identity alone in the cache key (V18):** redundant with the counter, given the port contract (onRecords is required).
  - **No notes count on mount (V33):** `tick()` sets it first.
  - **Clusters never coarsen (V40):** my mutant was wrong; it collapses to one cluster and still meets the bound.

## MEDIUM

- **M1. A cluster click doesn't open its threads** (ui.js:196). It calls `port.jumpTo(where)`, and app.js's `jumpTo` (app.js:64) centres the view at the **same scale**, so the cluster stays a cluster.
  - **Measured:** at 5% zoom over 10k threads, a 138-thread cluster was clicked. Afterwards there were still 0 pins and 81 clusters, at scale 0.05.
  - **Impact:** the brief's check "a cluster opens to its threads" fails. The cluster's title says "zoom in to see them", but nothing zooms. No test clicks a cluster (mutant V37, which drops the click, survives).
  - **Fix:** zoom to fit the cluster's member bounds, through a port call or a `jumpTo({ x, y, scale })`.
- **M2. A refused selection re-walks the whole Set every frame** (frame.js:29-34). While `collab.selection` returns false, `pendingSel` stays true. The outbox refuses when the status isn't live, or the role may not send `select` (a viewer).
  - **Measured:** each frame then runs `hashIds` plus `[...sel]`. At 100k selected that is 2 walks a frame, **1.5 ms a frame**, for as long as the tab is connecting, catching up or limited.
  - **Same as before:** HEAD did a `join` every frame here, so this is no regression, but C-15 isn't fixed in this state.
  - **Fix:** cap the ids at 500 before spreading (only 500 are ever sent: gate.js `MAX_SELECT_IDS`), and retry on `onStatus` rather than every frame.
- **M3. `domClock()` (D1) is not run through the clock contract**, so a copy drift is unguarded.
  - **Mutants survive:** mono becoming `Date.now` (V27) and `set` passing bad ms through (V28).
  - **The copy is right today:** I ran `clockContract("domClock", …)` in scratch: 9/9 pass, and the text matches web/adapters/clock/browser.js line for line.
  - **Fix:** add that one line to test/web/adapters/clock.test.js (p7-archtest's or client's file), or in the perf test.

## LOW

- **L1. A real hash collision** (frame.js:53, found by codex, confirmed). `hashIds({"id43zx"})` and `hashIds({"idbpad"})` give the same value, `1336113767:1336113767`.
  - **Effect:** a one-for-one swap between colliding ids is never sent, and the 10 s repeat resends the old one. That is about 2⁻³² per swap, where HEAD compared exactly.
  - **Fix:** compare exactly when the size is ≤ 500 (the only ids sent anyway), or add a second hash.
- **L2. The C-15 test checks only lengths** (test/web/collab/perf.test.js:145, codex). After the in-place swap it checks `ids.length`, not that `"new"` was sent.
- **L3. Edge pop-in.** Culling is by anchor point, and a pin's body extends right and up from it.
  - **Example:** with the viewport exactly at the placed box's left edge (fast path), a thread anchored 5 px outside it isn't placed, though its body would show at screen x −5…+23.
  - **Effect:** a sliver, for one frame at most, until the next re-place.
- **L4. The bench reports medians.** On a real pan with a large selection, every 15th frame (`HASH_EVERY`) hashes the Set: about 0.7–1.2 ms at 100k (the builder's own number). The "0.001 ms" row hides that spike. Report the max too.
- **L5. `renderPopover` runs `rv.threads.find` on every pan frame while a thread is open** (ui.js:236). That is O(threads), about 0.05 ms at 10k. Not new.
- **L6. The `me.name` cache key (V20) has no test** (rule 13 renames). It is low impact.
- **L7. browser.js's header is now false** (web/adapters/clock/browser.js:2). It says it is "the only web/ file that may touch Date.now / performance.now / setTimeout / Math.random", but `domClock()` in frame.js does too (D1). Update the comment, or note D1 there.

## What I checked

1. **The numbers:** perf-bench on a HEAD copy and on the tree (`OLD_FRAME=` the HEAD frame.js).

   | Row | HEAD | Tree |
   |---|---|---|
   | Pins in the DOM, 100% zoom | 10,000 | 55 |
   | Pins in the DOM, 5% zoom | 10,000 | 81 |
   | Writes per pan frame | 80,002 | 1 |
   | Zoom frame | 80,002 writes | 270 writes, 0.17 ms |
   | Leaving the placed region | 80,002 writes | 407 writes |
   | Selection check, 100k selected | 0.80 ms | 0.001 ms (median) |
   | `here`, comments tab | 8.4 ms | 0.008 ms |
   | Records change | 43.2 ms | 29.8 ms |

   - **The fixture's shortcuts:** the view is mutated in place, with no version bump and no docs.
   - **So I re-ran it on the real production port:** `syncCollabPort` over two real sessions on the local room (test/web/adapters/collab-rig.js), with real core Editors (`B.view` replaced, `B.changed()`), 400 threads and collabFrame over the real session.
     - **1 write per pan frame,** and `records()` identity stayed stable across the pan.
     - **A peer's new thread pinned** after its records frame. A resolve showed ✓ within one frame, and a delete removed the pin.
     - **My own new thread stayed open** in the same call, before the coalesced onRecords.
2. **C-1 / D2:**
   - **Production `records()`** is keyed on `B.recordsRev`, which every Replica records path bumps (replica.js:80, 116, 457, 474, 491, 520, including a local action, synchronously). So identity moves with every change.
   - **No path found** where records change and neither the identity nor the counter moves. A mutate-in-place port is handled (K17).
   - **`HASH_EVERY`:**
     - **When it waits:** only a same-size in-place change during a pan waits, up to 15 frames.
     - **Size, Set, stream and doc rev changes:** sent at once.
     - **Core's selection edits:** every one either bumps `version`, changes the size or replaces the Set (editor.js:159, 281, 316, 776, 1019; session.js:162).
3. **C-7 / C-15:**
   - **notesView** runs only on the notes tab (`port.notes` is called 0 times per `here` on comments).
   - **nameOf** is a Map.
   - **No join per frame** on pan or still frames, except while refused (M2).
4. **C-6 / D1:**
   - **domClock:** it matches browser.js and passes the contract (M3).
   - **ui.js** has no `Date`, `setTimeout`, `setInterval`, `performance`, `Math.random` or `requestAnimationFrame`. Its only global is `devicePixelRatio`, for the canvas.
   - **The source test** bans six literal strings. A `new Date().getTime()` mutant in renderFloats got past it, but an emote test killed it.
   - **Presence on mono is safe across clients:** laser `t` is used only relatively (presence-model.js:111-112), and ages use local receive time.
5. **Mutants:** I reproduced the builder's 14 (B1–B14); all are killed. I added 26 of my own (V15–V40):

   | Group | Mutants |
   |---|---|
   | Killed by the existing tests | V16, V21, V24, V26, V29, V31, V39 |
   | Survived; killed by my tests | V15, V17, V19, V22, V23, V25, V30, V32, V38 |
   | Killed by the existing tests once both keys were mutated | V36 (my first run changed only one place) |
   | Survived, equivalent | V18, V33, V40 |
   | Survived, low value | V20, V34 (doc swapped at the same rev), V35 |
   | Survived, no test | V27, V28 (M3), V37 (M1) |

6. **Boundaries and serving:**
   - **Dependencies:** p7-perf's files depend on nothing in flight. draw.js's `scaleOf` and fake.js are at HEAD.
   - **app.js (p7-chrome)** passes a port-shaped clock, and `clockPort` takes it as-is.
   - **The rig** (test/server/rig.js, port 0): a crawl of the served module graph from `/` fetched 56 paths. frame.js returned 200.
   - **The only non-200s,** `/ports/clock.js` and `/ports/net.js`, are JSDoc `import("…")` types in comments, which my crawler over-matched. They are not real imports.
   - **The rig's server** exited with my script.
   - **architecture.test.js still bites** (in a scratch copy; p7-archtest has the file in flight). Each mutant adds failures beyond the copy's baseline (one `DEV_MODULES vs static.js DENY` failure, which is copy-only: on main the file passes).
     - **ui.js importing `../../clock/browser.js`:** caught by `checkBoundaries` and by the `web/ rules` test.
     - **records-model.js reading `Date.now`:** caught by "core reads no browser global".
7. **Tests:** `bun test` gave **1242 pass, 138 skip, 1 fail**.
   - **The failure** is test/core-source.test.js on `editor.js`: herdr-draw's core/editor.js is modified and uncommitted (`git -C ../herdr-draw status`). It is not this job.
   - **No test/web/collab file was changed;** only three are new. No assertion was weakened.
8. **sdd ensemble:** codex (effort high) and grok, each in its own scratch copy. agy failed `check_adapter` (quota, 52 h).

   | Finding | Verdict |
   |---|---|
   | codex: the hash collision | **Confirmed** (L1) |
   | codex: the test checks lengths | **Confirmed** (L2) |
   | grok HIGH 1: a stale pin after an element is deleted | **Refuted.** `records({ reanchor: true })` runs `reanchor` on a cache hit, and that bumps `rvRev`, which defeats the fast path. |
   | grok HIGH 2: a duplicate pin and cluster for the open thread | **Refuted.** `keep` does `continue` before the cell. |
   | grok MEDIUM 3: stale records on layout | **Refuted.** onRecords renders directly. |
   | grok MEDIUM 4: a stale shift on resize | **Refuted.** `viewBox()` is read each call, and the shift doesn't depend on size. |
   | grok LOW 5: the C-15 test passes for the wrong reason | **Refuted.** The first pan frame is `panOnly`, and `walks` = 0 holds. |

## Design check (CHECKER, systems-design v0.1.0, client scope)

- **Cache (Ch1):**
  - **Shape:** a read-through cache of the records view.
  - **Invalidation:** records identity, an onRecords counter, role, user and name. It is sound against the production port.
  - **Untested:** most terms are untested (H2, H3, L6), which is the FAIL.
  - **Thundering herd:** none (one consumer).
- **Per frame at 10k threads (measured):**
  - **Pan:** O(1), one transform.
  - **Zoom or leaving the region:** O(threads) of `layoutPins` arithmetic plus O(cap) writes, about 0.2 ms.
  - **Board op:** O(element-anchored threads) `reanchor` plus `port.element` calls. That is 5k lookups, 0.28 ms, on **every frame of a drag**, because a drag bumps `doc.rev` each frame.
- **Per records change, still O(all):**
  - **The port's rebuild:** the Replica's `recordsState` (E-3, 27 ms per p7-audit) and, in the fake, 23 ms.
  - **`recordsView`:** about 4 ms.
  - **The drawer:** a `JSON.stringify` key over every open thread, plus a full row rebuild when it changes.
  - **Budget:** at the 20/s op bucket, that is 600 ms/s of main thread (E-3 plus the view), which exceeds a 16 ms frame budget on the frames it lands in. This is the next bottleneck after this job.
- **Per frame at 100k selected:**
  - **Pan:** O(1), except every 15th frame (about 1 ms).
  - **Non-pan version bumps (hover, drag):** O(selected), about 1 ms, the same as before.
  - **While refused:** 1.5 ms every frame (M2).
- **2k annotators' cursors (measured, bun):**
  - **Model:** a 2k-peer batch takes 0.18 ms to ingest. `view()` takes 0.18 ms, with 20-id selections each.
  - **Draw:** `drawPresence` on a stub canvas takes about 1 ms. A real canvas adds 2k labels and paths, likely several ms (unmeasured).
  - **Scaling:** linear in peers, coalesced to one paint a frame.
- **10× (100k threads, past the protocol cap):**
  - **Re-place:** `layoutPins` becomes about 2 ms per re-place, and `reanchor` per drag frame about 3 ms. Both need a spatial index.
  - **Records change:** `recordsView` becomes about 40 ms, which needs incremental records (E-3 territory).
  - **Pins:** pan stays O(1).
- **Monitoring:** none on the client (C-11/J5), so none of these frame costs is visible in production.
- **Failure walked:** a wall-clock jump is now handled, because presence and pacing run on mono.

## What I did NOT check

- **No real browser.**
  - **Unseen:** style recalc and layout for a re-place, the transformed `.collab-pins` layer, whether collab.css clips the transform, and the cluster's look.
  - **Untimed:** real canvas cost at 2k cursors.
- **Boot:** I didn't boot the production page in headless Chrome. The no-404 check is a crawl of the served module graph, not a page load.
- **Flake:** I didn't loop test/web/collab to chase the builder's one unreproduced failure.
- **Resize:** I didn't drive a resize sequence in a test; I only reasoned from the code that `viewBox` is read per call.
- **dev.js:** I checked only that web/collab/dev.js's view has `toWorld` (dev.js:56), which renderPins now needs. I didn't load dev.html.

## Round 2 (2026-11-12): **PASS**

**PASS.** Every round-1 survivor and every round-1 MEDIUM is now killed or fixed. One new MEDIUM remains: a cluster can't open past scale 4, or when its threads share one spot. It doesn't block.

- **Round-1 survivors:** all 12 (H1–H4, H6–H10, V27, V28, V37) are killed by `bun test test/web`, in a fresh scratch copy of the round-2 tree.
  - **The adopted tests:** test/web/collab/perf-guards.test.js matches my appendix line for line (only the 2-line header differs).
- **New mutants on the round-2 code:** 16 (R1–R16). 13 are killed, 3 are equivalent, and none survives on a claimed fix.
  - **R1 (spread the whole Set instead of the first 500):** first reported as a survivor. That was my runner's fault: the 100k-id failure diff overflowed spawnSync's output buffer. With a larger buffer, and by hand, it is killed by 3 C-15 tests.
  - **R6 (a refusal keeps the stale `sent`), R7 (a retry doesn't force a resend), R9 (`seen` ignores the stream):** equivalent.
    - **R6, R7:** a refusal only happens when the ids differ from `sent`, and a retry always re-sends. My offline, role and stream sequences give the same sends with either mutant applied.
    - **R9:** the two streams have different Sets, so `seen.sel` catches a switch.
- **`bun test`:** 1274 pass, 137 skip, 1 fail. The failure is test/core-source.test.js on herdr-draw's uncommitted core/editor.js, as before.
  - **ui-app.test.js** (t1h3's `jumpTo` clamp test) passes in this run.
- **Bench (re-run):** 1 DOM write per pan frame at 100% and 5%; 55 and 81 pins.
  - **Selection check at 100k selected:** median 0.012 ms, max 0.12 ms (round 1's every-15th-frame spike is gone).
- **M2 (a refused selection), measured at 100k:**
  - **While refused:** a still frame costs 0.0005 ms with 0 reads. A pan frame reads at most 500 ids, 0.012 ms.
  - **Through the real gate** (fake port, offline/live and viewer/editor sequences), the last send is always right:
    - **Offline:** a selection made, or cleared with Escape, while offline goes out on reconnect.
    - **Viewer to editor:** the selection made while a viewer goes out on promotion.
    - **Stream switch:** a switch to notes sends `notes:…`.
  - **Duplicate sends:** `outbox.resume()` re-sends the sticky selection, and the frame then retries, so some selections go out twice. Harmless, because the latest one wins.
- **M1, end to end:** I used app.js's `jumpTo` as t1h3 has it now (app.js:64-71: clamped to [0.1, 8], centred at the new scale).
  - **From the 5% overview:** one click on a 138-thread cluster zooms to 0.288 and puts 223 pins in the DOM.
  - **ui.js's side, on its own:** passes `{ x, y, scale }` (perf.test.js M1 tests; R10–R15 are killed).
- **M3:** perf-clock.test.js runs `clockContract` on `domClock()` and pins mono and `set`. V27 and V28 are killed.
- **L1, L2, L7:** done. The hash is gone, the compare is exact, the colliding pair is tested, the tests check contents, and browser.js's header is fixed.

### New finding

| Severity | Finding |
|---|---|
| MEDIUM | **A cluster can't open past scale 4, or when its members share one point** (web/core/collab/records-model.js:166, `zoomToFit`). The target is `min(max(fit, 2 × scale), max(4, scale))`. Codex found it; my tests confirm it. |

- **At scale ≥ 4, a click only centres.**
  - **Measured:** 600 threads in a 90×60 world spot, viewed at 4×, with 35 clusters. After a click, the scale is still 4, with 35 clusters and 0 pins.
  - **The gap:** app.js allows zooming to 8.
- **Threads on one exact point never open at any zoom,** once the box holds more than the cap.
  - **Measured:** 20 threads on one point with `pinCap` 5. After 4 clicks the scale is 4, with 1 cluster and 0 pins.
  - **Why it's likely in an all-hands:** every thread anchored to the same element sits at that element's top-right corner, so many people commenting on one slide element produces exactly this.
- **Nothing is lost:** the comments drawer still lists every thread, and opening one from the drawer makes it a pin (`keep`, K25).
- **Fix options:**
  - Let `maxScale` follow the page's limit (pass 8, or have `jumpTo` say its max).
  - For a cluster that can't split (zero-size bounds, or already at max zoom), open a list of its threads, or the first one.

### sdd ensemble, round 2

codex ran at effort high, and grok ran; each worked on its own scratch copy of the round-2 diff.

| Finding | Verdict |
|---|---|
| codex: no zoom at scale ≥ 4 or with identical points | **Confirmed** (the MEDIUM above) |
| grok HIGH: a selection is never sent after a role change to viewer | **Refuted.** Viewers may not send `select` (PROTOCOL.md § Presence). On a promotion, the `statusRev` bump retries it (shown above). |
| grok MEDIUM: a stream switch with the same head ids isn't sent | **Refuted.** `sent.stream !== stream` forces the send (frame.js:31), and my test sends `notes:n1`. |
| grok HIGH: `zoomToFit` returns the current scale whenever fit ≤ 2 × scale | **Refuted** as stated. The target is at least 2 × scale unless the 4 cap binds, which is the codex case. |
| grok LOW: off centre for non-square bounds | **Refuted.** The centre is the bounds' midpoint, which is correct. |

### Not checked in round 2

- **No real browser,** as in round 1.
- **The cluster zoom against app.js:** checked against a copy of t1h3's in-flight `jumpTo` logic in my test rig, not the real page.
- **Round-1 LOWs L3, L5 and L6:** still open, as t14k scoped. They don't change the verdict.

## Appendix: perf-guards.test.js (the tests that kill H1–H10; all pass on the builder's code)

```js
// p7-perfv: tests aimed at the surviving mutants. Each must pass on the builder's code.
import { test, expect } from "bun:test";
import { busyBoard, countingDom, panView, frameState, createFakePort } from "./perf-fixture.js";
import { mountCollab } from "../../../web/adapters/dom/collab/ui.js";
import { collabFrame } from "../../../web/adapters/dom/collab/frame.js";

const me = { user: "me", name: "Me", client: "me-1" };
const clk = () => { let m = 0; const q = []; return { now: () => m, mono: () => m, random: () => 0.3, set: (fn, ms) => { const h = { at: m + ms, fn }; q.push(h); return h; }, clear: h => { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); } }; };
const th = (id, anchor, text = "x") => ({ id, by: "u", name: "U", at: 1, anchor, comments: [{ id: `c${id}`, by: "u", name: "U", at: 1, text }] });
function mount(board, o = {}) {
  const dom = countingDom(), view = panView();
  let port = createFakePort({ role: o.role ?? "editor", me, threads: board.threads, elements: board.elements ?? {}, notes: board.notes ?? [] });
  if (o.wrap) port = o.wrap(port);
  const collab = mountCollab({ root: dom.root, port, view, clock: clk(), frame: () => {}, pinCap: o.pinCap });
  const S = frameState(view); S.eds.board.doc = { rev: 1 }; S.eds.notes.doc = { rev: 1 };
  const tick = collabFrame(S, collab); tick();
  const pins = () => dom.root.findAll(e => e.hasClass("pin") && !e.hasClass("cluster"));
  const pin = id => pins().find(p => p.getAttribute("data-thread") === id);
  return { dom, view, port, collab, S, tick, pins, pin };
}

test("K15 zoom in only: pins re-placed at the new scale", () => {
  const m = mount({ threads: [th("a", { point: { x: 100, y: 100 } })] });
  m.view.v.scale = 2; m.tick();
  expect(m.pin("a").style.getPropertyValue("left")).toBe("200px");
  expect(m.dom.root.find(e => e.hasClass("collab-pins")).style.getPropertyValue("transform")).toBe("");
});

test("K17 a port whose records() is one object mutated in place still shows a new thread (D2)", () => {
  const m = mount({ threads: [th("a", { point: { x: 100, y: 100 } })] }, { wrap: p => {
    const stable = { threads: [], pending: [] }, orig = p.records.bind(p);
    p.records = () => { const r = orig(); stable.threads.length = 0; stable.threads.push(...r.threads); stable.pending = r.pending; return stable; };
    return p;
  } });
  m.port.remote({ do: "thread", id: "b", anchor: { point: { x: 200, y: 100 } }, text: "new" }, "u2", "U2");
  expect(!!m.pin("b")).toBe(true);
});

test("K19 a role change (editor to viewer) hides the open popover's reply box", () => {
  const m = mount({ threads: [th("a", { point: { x: 100, y: 100 } })] });
  m.collab.openThread("a");
  const field = () => m.dom.root.find(e => e.tagName === "TEXTAREA");
  expect(field().parentNode.hidden).toBe(false);
  m.port.setStatus("live", "viewer");
  expect(field().parentNode.hidden).toBe(true);
});

test("K22 notes tab, then back to comments with no records change: the comment rows come back", () => {
  const m = mount({ threads: [th("a", { point: { x: 100, y: 100 } })], notes: [{ id: "n1", type: "rectangle", x: 0, y: 0, width: 1, height: 1, updated: 1 }] });
  const rows = () => m.collab.parts.drawer.findAll(e => e.hasClass("thread-row")).length;
  expect(rows()).toBe(1);
  m.collab.showDrawer("notes"); m.collab.showDrawer("comments");
  expect(rows()).toBe(1);
});

test("K23 a thread on a NOTES element follows it when only the notes doc's rev moves", () => {
  const m = mount({ threads: [th("a", { stream: "notes", element: "n", x: 80, y: 0 })], elements: { "notes:n": { x: 0, y: 0, width: 80, height: 40 } } });
  expect(m.pin("a").style.getPropertyValue("left")).toBe("80px");
  m.port.setElement("notes", "n", { x: 300, y: 0, width: 80, height: 40 });
  m.S.eds.notes.doc.rev = 2; m.S.v++; m.tick();
  expect(m.pin("a").style.getPropertyValue("left")).toBe("380px");
});

test("K25 opening a clustered thread (no view change) makes it a pin", () => {
  const T = Array.from({ length: 50 }, (_, i) => th(`t${i}`, { point: { x: 100 + (i % 2), y: 100 } }));
  const m = mount({ threads: T }, { pinCap: 5 });
  expect(!!m.pin("t7")).toBe(false);
  m.collab.openThread("t7"); m.tick();
  expect(!!m.pin("t7")).toBe(true);
});

test("K32 the open thread deleted by its author: the popover goes", () => {
  const m = mount({ threads: [th("a", { point: { x: 100, y: 100 } })] });
  m.collab.openThread("a");
  expect(m.dom.root.find(e => e.tagName === "TEXTAREA")).toBeTruthy();
  m.port.remote({ do: "delete", id: "ca" }, "u", "U");
  expect(m.collab.state.open).toBe(null);
  expect(m.dom.root.find(e => e.tagName === "TEXTAREA")).toBeFalsy();
});

test("K36 a peer's new thread shows in the comments drawer", () => {
  const m = mount({ threads: [th("a", { point: { x: 100, y: 100 } })] });
  const rows = () => m.collab.parts.drawer.findAll(e => e.hasClass("thread-row")).length;
  expect(rows()).toBe(1);
  m.port.remote({ do: "thread", id: "b", anchor: { point: { x: 200, y: 100 } }, text: "new" }, "u2", "U2");
  expect(rows()).toBe(2);
});

test("K38 an element moved then deleted: the detached pin goes to the anchor's own point", () => {
  const m = mount({ threads: [th("a", { stream: "board", element: "e", x: 80, y: 0 })], elements: { "board:e": { x: 0, y: 0, width: 80, height: 40 } } });
  m.port.setElement("board", "e", { x: 300, y: 0, width: 80, height: 40 });
  m.S.eds.board.doc = { rev: 2 }; m.S.v++; m.tick();
  expect(m.pin("a").style.getPropertyValue("left")).toBe("380px");
  m.port.setElement("board", "e", null);
  m.S.eds.board.doc = { rev: 3 }; m.S.v++; m.tick();
  expect(m.pin("a").style.getPropertyValue("left")).toBe("80px");
  expect(m.pin("a").classList.contains("detached")).toBe(true);
});

test("K30 a re-place writes only what changed (an unchanged pin: 0 writes)", () => {
  const m = mount({ threads: [th("a", { point: { x: 100, y: 100 } })] });
  const el = m.pin("a"); let n = 0;
  for (const [o, k] of [[el.style, "setProperty"], [el, "setAttribute"], [el.classList, "toggle"], [el, "replaceChildren"], [el, "append"]]) { const f = o[k]; o[k] = function (...a) { n++; return f.apply(this, a); }; }
  m.port.remote({ do: "thread", id: "far", anchor: { point: { x: 99999, y: 99999 } }, text: "far" }, "u2", "U2");   // a records change: a re-place, a unchanged
  expect(n).toBe(0);
});
```
