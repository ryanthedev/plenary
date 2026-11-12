**PASS** (round 2, fix round 1 of p6-base): 0 HIGH, 3 MEDIUM, 6 LOW. All three round-1 HIGHs are fixed.

# Round 2 (2026-11-11)

I judged `web/sync.js`, `web/paint.js`, `web/dev.js`, `test/web/sync.test.js` and `test/web/paint.test.js` as they
are on disk, not the builder's claims. `bun test`: 263 pass, 0 fail (86 in test/web/). Nothing is committed and I
wrote nothing outside this report and my scratchpad.

sdd ensemble: **single harness** (one codex run, effort high, on the fix-round diff in a scratch git copy). It
found 3 MEDIUM and no HIGH. Its own verdict line was FAIL, on those MEDIUMs; I pass the job because the brief
fails it only on a HIGH. Each codex finding is confirmed or re-rated below.

Evidence: `/private/tmp/claude-501/-Users-r-repos-plenary/ffa42d25-0be0-435b-804d-caef5881c575/scratchpad/`
(`tests/a`–`g.test.js`, `tests/h.js`, `mutate2.js`, `mutate3.js`, `drive.js`, `drive2.out`).

## The three HIGHs

| Round 1 | Now | How I saw it |
|---|---|---|
| **H1** acked edit discarded in the resync window | **Fixed** | My T1: the edit is logged at version 6 (was 1) and x 564 lands in the room, the peer and the Editor. Ops made while not live are held outside the Replica and numbered after catch-up. 80 seeded runs of a busier window (several edits of one shape, undo, redo, a setting, a create, a delete, a peer editing the same shape, a reconnect; with and without `reopen`): what the user saw is what landed, every time (`d.test.js` D5a). A held op that is itself refused does not take the good held ops with it (D5b). |
| **H2** Escape or a tool key mid-drag diverges for good | **Fixed** | 36 combinations of gesture × ending (release, Escape then release, tool change then release, a new press, `cancelGesture`, peer deletes it then Escape then release): strictly equal once the gesture ends, and a peer's later nudge lands (D1). Real Chrome, real mouse and keys: after Escape mid-drag and release both panes have the rectangle at (0, 0) version 2, and after the peer's nudge both are at (0, 40) version 3. |
| **H3** the gate passes while broken | **Fixed** | The gate's helper (`expectConverged`, test/web/sync.test.js:26-32, read) asserts `sync.diff()` is empty (every byId entry: tombstones, version, nonce, content) and `sync.full()` equals the room's. Every round-1 mutation is now caught: m1 (reload merges) fails 16 tests, 12 of them gate tests (it passed the gate in round 1); m7 and m8 fail 21 gate tests each; m6 fails 6; "reload clears gesture and text" fails 1; "ops reach the Replica while not live" fails 5 (4 gate). |

## The builder's "no up" claim: legitimate

My `b.test.js` still prints six "no up at all" rows as not ok. In those rows the pointer is still down, so the
Editor is showing the user's own unfinished drag. D1 ends each of those gestures five ways and the Editor converges
strictly every time. Same for my T4 and T6b, which also never released. Even a release the page never hears
heals: D1's "a new press elsewhere" row converges on the next press. dev.js now handles `pointercancel` too: a
real one in Chrome (touch emulation, cancel mid-create) fired once, removed the half-made shape and logged nothing.

## MEDIUM

- **M1. The watchdog is "no message for 10 s", not rule 2's "an op with no ack or error within 10 s"
  (web/sync.js:54-59, 167).** Every incoming message re-arms the timer, so on a busy board a lost ack is never
  noticed. `d.test.js` D2b: the ack is dropped, a peer draws every 5 s, and for 60 s the client stays `live` with
  1 pending and sends no hello; it reconnects only after 10 quiet seconds. The op itself is logged and applied, so
  nothing is lost: the status pill is wrong and rule 2's timing is not met. codex found the same. **Confirmed.**
  Fix: time each op from its send, separately from the catch-up timer.
- **M2. No backoff, and only `auth` is treated as a connection error (web/sync.js:68, 156).** A hello the room
  answers with an id-less error other than `auth` restarts every 10 s forever (D3: 31 hellos in 300 s, client id
  with a colon). PROTOCOL.md now has rule 12 (growing, jittered waits) and codes `version` (stop) and `unavailable`
  (keep ops, back off); none are handled. codex found this by reading. **Confirmed.** PROTOCOL.md assigns the
  timeouts to the phase-2 Replica, so this belongs with that port; until then the watchdog is a stopgap.
- **M3. Nothing tests that held ops survive a reconnect.** The code is right, but a mutation that drops `held` in
  `restart()` passes all 57 sync tests; my D5a catches it (24 of 80 runs lose the user's edits). Held ops exist
  only in the client, so this path deserves a test.

## LOW

- **L1. Test gaps on correct code** (mutations that pass the builder's suite; my tests show the real code is right):
  held ops sent unstepped (a 1,500-move drag committed while not live is refused by the room in the mutation,
  logged in the real code: `f.test.js`); `close()` leaving its timer armed (D3 sees 1 timer in the mutation, 0 in
  the real code). Three more survivors (a commit leaving ids in `previewed`, a reload keeping `previewed`, the
  timer callback not re-checking "outstanding") look equivalent: by reading, and my D1, D3, D5a and D9 all pass
  against each.
- **L2. A held setting can vanish from the Editor until catch-up ends, on a transport without `reopen`
  (web/sync.js:106-115).** A stale entry runs `syncSettings()` while held ops are not yet in the Replica. From
  codex, rated MEDIUM. **Confirmed by reading, re-rated LOW:** it is a flicker; the setting is restored and lands
  (D5a without `reopen`: 40 of 40), and v1 closes a connection that says hello twice.
- **L3. Undo can try to recreate a refused element.** Only a refused *create* step is pruned; a later step that
  holds the element's old copy stays, so undo resends it and is refused again (one more resync). No throw, no
  id-less element, strict equality after (D7b, D7c).
- **L4. A gap on an idle live link is never noticed.** If entries are lost while nothing is outstanding, later
  entries wait behind the gap for good (fuzz seed 33 with losses on idle links). Outside the client's duty as
  written: PROTOCOL.md § Bus has the gateway repair gaps. Worth one line in the WebSocket transport's brief.
- **L5. sync.js writes into the Editor's Doc and wraps four Editor methods on the instance** (`stepVersions`,
  `reconcile`, the wrappers). The builder says so too. It works (300 fuzz runs), and a second `bindEditor` on the
  same Editor after `close()` works (D8), but a new core method that ends a gesture would slip past the wrappers.
  The clean fix is in core and needs the CEO's OK.
- **L6. A drag committed while not live is numbered only at catch-up**, so a peer who edits the same shape more
  times in that window wins (F1 with a peer: three nudges beat one held drag). Ordinary last-writer-wins: the
  control with no refusal, the same drag and nudges crossing live, ends the same way (`g.test.js` G1: room at
  version 4 with the peer's position in both). Noted so nobody reads it as H1 coming back.

## What I ran

| Check | Result |
|---|---|
| My round-1 repros (`a`, `b`, `c`), ported to the new handle (`full()`, `peek()`), comparing with my own `strictDiff` | T1, T2, T3, T5–T11, C2–C4 strictly equal; T7's typed text now survives; the six open-gesture rows covered above |
| Fuzz, 300 seeded runs, with and without `reopen`: 1,202 refusals, 2,002 reconnects and timeouts, refusals mid-gesture, every gesture ending, undo/redo, settings (D9) | 0 bad: every peer `live`, 0 pending, Editor == Replica == room strictly, no timer left running |
| Same fuzz, also losing messages on idle links | 1 bad of 300 (L4) |
| Watchdog: double `reconnect()`, idle, after `close()`, refused token (D3) | 3 hellos, logged once, 0 timers when idle, after close and when refused; nothing sent after close |
| History after a reload (D7) | real history undoes and redoes across an unrelated refusal; refused creates never throw or send an id-less element |
| Mutations of the new sync.js against the builder's tests (`mutate2.js`, 19; `mutate3.js`, round-1's m1 and m6) | 15 caught, 6 survive: 3 real gaps (M3, L1), 3 that look equivalent |
| Painter: the diff is three tightenings (skip strokes of width ≤ 0, font face by own key, no SVG data URLs), so no new path to the canvas. Each reverted in a scratch copy (`mutate3.js`) | each revert fails 1 test in paint.test.js |
| Seam | no import of packages/protocol in web/ outside sync.js; `.replica` appears nowhere in web/ or test/web/ |
| Browser (Chrome 157 headless, dpr 2, real mouse, key, wheel and touch events) | every tool converges strictly; move, eraser, label, text reach the peer; laser fades to 0 points and logs nothing; ctrl+wheel of 240 zooms 1.65× (was 8×); 0 differing pixels between panes; hostile colors and numbers paint safely, console clean |

Chrome ran on debugging port 0 in my own scratch profile, the server on port 0; I killed only my child (PID 51936)
and checked that nothing was left under the profile path.

## Not checked

- Pen input, a real hi-dpi display, drawing by hand in a visible window, Safari, Firefox.
- A WebSocket transport (none exists) and the 10 s timings on a real clock (all timer tests use an injected clock).
- Pictures in the browser, and peers' live previews.
- `web/app.js` and the `ui-*` tests: they are p6-ui's, outside this job.

---

# Round 1 (original report)

**FAIL**: 3 HIGH, 5 MEDIUM, 8 LOW. Verifier report for p6-base (canvas + sync core), 2026-11-11.

The painter and the seam hold, and two real browser panes converge with every tool. The job fails on
web/sync.js: an acknowledged edit can be thrown away, a keypress during a drag leaves the Editor and the
Replica different for good, and the gate's equality check is too weak to notice either kind of fault.

sdd ensemble: **single harness** (codex, effort high; agy out of quota, others not signed in). Every codex finding
is confirmed or refuted below with my own evidence.

All evidence is in my scratchpad, nothing was written to web/, test/ or packages/:
`/private/tmp/claude-501/-Users-r-repos-plenary/ffa42d25-0be0-435b-804d-caef5881c575/scratchpad/`
(`tests/a.test.js`, `tests/b.test.js`, `tests/c.test.js`, `tests/h.js`, `mutate.js`, `drive.js`, `shot-*.png`).

## HIGH

### H1. An acknowledged edit is discarded when it is made during a resync (web/sync.js:96-101)

- **What happens:** after a refused op the Replica is reset to empty and the Editor keeps showing the old board
  until catch-up ends. An edit to an existing element in that window goes through `step()`, which finds no copy in
  the empty Replica, takes base 0 and sends the element at **version 1**. It also rewrites the Editor's copy to 1.
  The room logs and acks the op, but its own copy is at a higher version, so the edit loses the merge everywhere.
- **How I saw it** (`tests/a.test.js` T1): room copy at version 5, x 64. Refuse an op, step the network until the
  status leaves `live`, nudge the element by 500. Result: log entry seq 6 carries version 1, x 564; the room, the
  peer and the Editor all end at x 64; pending 0.
- **Control** (`mutate.js`, copy `r1-ctl`): the same test with `step()` skipped while not live sends version 6
  and the edit survives everywhere (x 564). So sync.js discards the edit; it is not ordinary last-writer-wins.
- **Why HIGH:** an acked op has no effect. The builder listed this as "edits during a resync are visually lost"
  (risk 4); it is a logged, acked, silently dead op. The window is one round trip in process, and a full since-0
  catch-up over a real socket.
- **codex:** same finding, rated HIGH, with its own repro. **Confirmed.**

### H2. Escape or a tool key during a drag leaves Editor != Replica for good (web/sync.js:113, 60-70)

- **What happens:** core's `livePut` raises the element's version in the Editor on every pointer move; sync.js
  sends those only as transient ops, which never reach the Replica. If the gesture ends without a commit, the
  Editor keeps the moved element at a version far above the Replica's. From then on `feed()` hands peers' edits to
  `editor.receive`, which rejects them because the Editor's version is higher.
- **How to trigger it:** drag a shape, press Escape (or a tool shortcut such as `r`) while dragging, release. Core
  clears the selection, so the release commits nothing.
- **How I saw it, headless** (`tests/b.test.js`, 49 combinations of gesture kind × ending): "move + escape, then
  up" and "move + tool key, then up" end with the Editor at version 26 and the Replica at 2, with different
  positions. A peer's later nudge reaches the Replica and the room but never the Editor (`a.test.js` T3, T4).
  T6b: if the peer deletes the shape meanwhile, the Editor keeps showing a shape that no longer exists.
- **How I saw it, real browser** (`drive.js` step 8, real mouse and key events): pane ada shows the rectangle at
  (150, 180) version 22; pane bo and the room have it at (0, 0) version 2. After bo nudges it, bo is at (0, 40) and
  ada has not moved. Both panes say `live`, 0 pending. Screenshot `shot-4-escape.png`.
- **Why HIGH:** the done-when "two Editors through a Room converge" is false after an ordinary keypress while every
  test passes, and the user's screen is wrong with no sign of it. The builder's comparator would catch it; no test
  ever ends a gesture without a commit.
- **Fix direction (not made):** sync.js must not let transient-only versions outlive a gesture: reconcile the
  Editor to the Replica when a gesture ends without a commit (`editor.g` goes null with no commit), or feed with
  the Replica's copy winning for ids not in an active gesture. The cleaner fix is in core (cancel should restore
  and `livePut` should not bump stored versions), which needs the CEO's OK for herdr-draw.
- **codex:** did not find this. Mine alone.

### H3. The gate can pass while Editor != Replica (web/sync.js:135-139, test/web/sync.test.js:23-31, 85-99)

`streamState` drops deleted elements and compares only `appState.herdr`, and the gate's only refusal is an
appState key. Mutations of `loadEditor` that the tests do not catch (`mutate.js`, each in its own scratch copy):

| Mutation of `loadEditor` / sync.js | GATE tests | Whole test/web/sync.test.js |
|---|---|---|
| m7: drop tombstones and reset every version to 1 | pass | **16 pass, survives** |
| m8: drop tombstones | pass | **16 pass, survives** |
| m3: keep the gesture, text edit, guides across a reload | pass | **16 pass, survives** |
| m1: merge into the Editor instead of replacing it | pass | caught only by "a viewer draws" |
| m4: `feed` never copies appState | pass | caught by the convergence tests |
| m2, m9 (version rewrite removed; feed corrupts nonces) | fail | caught |

- **Two separate gaps** (`tests/c.test.js` C4, run against the real tree and the m7 and m8 copies):
  - **The scenario.** Nowhere in the suite does a reload happen while the board holds an element above version 1
    or a deleted one, so m7 changes nothing there. On a board with a nudged shape (version 5) and a deleted one,
    the builder's comparator does report m7 after the reload.
  - **The comparator.** It never compares tombstones: on that same board m8 still compares equal.
- **m7 matters in use:** on that board the next edit after the reload goes out at a losing version and is acked
  and dead (a nudge of +300 ends at x -26 in the Editor, the room and the peer), as in H1.
- **What the gate needs:** compare every `byId` entry (tombstones, version, versionNonce); reload a board that
  holds edited and deleted elements; refuse an *element* op, not only an appState key; refuse while a gesture and a
  text edit are open; edit an existing element inside the resync window (H1). `tests/h.js` `strictDiff` is such a
  comparator.
- **codex:** found the tombstone half, rated MEDIUM. **Confirmed, and raised to HIGH** by the mutation results:
  the brief names "the gate can pass while broken" as HIGH.

## MEDIUM

- **M1. Pending ops are resent before `welcome` (web/sync.js:41-44).** `connect()` sends the hello and every
  pending op in one go, including held ops that were never sent. PROTOCOL.md rule 2 says resend after `welcome`,
  and a never-sent op waits for catch-up; rule 11 answers ops before `welcome` with `auth`. The v0 reference Room
  accepts it, so nothing breaks today. Against a v1 server an `error` carrying the op's id makes the Replica reset
  and resync (replica.js:56), which could loop. Read from the code; codex confirmed the send order with a test.
  **Confirmed.** Also missing from rule 2: the 10 s no-ack timeout (no timer anywhere in sync.js).
- **M2. Any refusal wipes work in progress (web/sync.js:50-54).** A refusal of one op clears the open gesture,
  the text being typed and all undo history (`a.test.js` T7: typed text gone, `commitText` is a no-op, no throw).
  The refused op need not be related: on the notes stream an annotator changing any setting is refused and resyncs
  (T11). codex found the text half. **Confirmed.** The UI job must hide settings from roles that can't write them.
- **M3. A stuck catch-up has no way out (web/sync.js:72-78).** Status leaves `catching-up` only when
  `replica.applied >= welcome.seq`. A lost message leaves the Editor frozen on the old board with ops piling up in
  `held`; nothing times out. Read from the code, not reproduced (the in-process links never drop a message).
- **M4. `pointercancel` commits the half-made gesture (web/dev.js:61).** It is wired to `pointerUp`, so a
  cancelled touch drops a partial shape on the board. From codex, by reasoning; core has no cancel entry point and
  my matrix shows a plain `pointerUp` always commits. **Plausible, not run** (no touch input here).
- **M5. The returned handle exposes the Replica (web/sync.js:122).** `bindEditor(...).replica` lets any page code
  call the protocol directly, which is what the seam forbids. Nothing in web/ uses it today (grep for `.replica`
  in web/ and test/web/: none outside sync.js); my own driver had to use it to compare copies, which shows the
  missing piece: a strict comparison export.

## LOW

- **L1. Editor-only tombstones (web/sync.js:113).** A bare click with the arrow or line tool leaves a deleted
  element in the Editor that the Replica never had (`a.test.js` T2). Invisible and harmless today. codex rated it
  MEDIUM. **Confirmed, LOW:** the id is never reused, so no later op can collide with it.
- **L2. The laser never fades on the dev page (web/dev.js:90-93).** Nothing calls `editor.tick()`, so laser points
  stay (16 points still there after 1.1 s in Chrome) and the pane repaints every frame forever.
- **L3. `faces[it.font]` indexes a plain object (web/paint.js:80).** A `font` of `constructor` would put a
  function's source into `ctx.font`. Not reachable: core's `fontClass` returns only hand/mono/sans (style.js:105),
  and Chrome ignores an invalid font string. Use an own-key check anyway.
- **L4. SVG data URLs are accepted as pictures (web/paint.js:104).** Safe in an `<img>`, same rule as the SVG
  adapter; some browsers taint the canvas for SVG, which will matter for PNG export.
- **L5. Ctrl+wheel zoom jumps (web/dev.js:62).** Raw `deltaY` goes to core; one ctrl+wheel event of 240 took the
  scale from 1 to the cap of 8. Fine for trackpad pinch, harsh for a mouse wheel.
- **L6. `lineWidth` of 0 or less is ignored by canvas, so the previous width leaks (web/paint.js:71).** Core
  clamps to 0.5, so not reachable from core's list.
- **L7. The builder's report says "128 pass" in one place and 143 in another.** 143 is right.
- **L8. The gate tests settle the network with an unseeded `Math.random` (web/sync.js:176, 184;
  test/web/sync.test.js:94).** `net.settle()` without an rng picks deliveries at random, so each gate run tries one
  unrepeatable interleaving and a failure would not reproduce. Pass a seeded rng and loop over seeds.

## What I checked

| Check | Result |
|---|---|
| `bun test` | 143 pass, 0 fail at the start; 148 pass, 0 fail on my last run (other sessions added tests meanwhile) |
| Seam: imports of packages/protocol in web/ outside sync.js | none; dev.js imports only core, sync.js, paint.js |
| Refusal mid-gesture, mid text edit (T7) | converges strictly; work in progress lost (M2) |
| Ops made before welcome, one of them bad, 30 seeds, entries and snapshot after compact (T9) | all converge strictly. The refusal lands while `live` in all 30 (C1): held ops go out only after catch-up, so the reference Room cannot refuse during catch-up |
| Refusal delivered during catch-up, by a scripted transport: reconnect, `welcome{seq:2}`, `error` for a pending op, a stale entry, then the since-0 answers (C2) | converges strictly; the bad op is not resent |
| Two refusals in a row with good ops between, 300 seeded interleavings (T8, C3) | 300 of 300 converge strictly, each good op logged once |
| Peer deletes what you are dragging (T6) | converges: the drag's commit revives it (last writer wins) |
| Same, but the drag is abandoned (T6b) | diverges (H2) |
| Transport without `reopen` (hello again on one connection), 300 seeded interleavings (T10, C3) | 300 of 300 converge strictly |
| Notes stream with annotators (T11) | own notes work; another's note and settings are refused and resync cleanly |
| Strict fuzz, 20 seeds × 80 rounds, normal gesture endings | 0 mismatches, tombstones and versions included |
| sync.js against rules 1–6 | rule 2 broken (M1); 3, 4, 5 hold; 6's client clause holds (pending ops are resent in counter order, held ops after them); 1 is the room's |
| What sync.js reaches into (brief item 2) | Replica `streams`, `applied`, `pending`, `resync` and the Editor's stored version. Safe in normal use (strict fuzz: 0 mismatches). Unsafe in two places: the version rewrite against an empty Replica (H1), and Editor versions that transients raised and no commit brought back (H2) |
| Painter vs core | every `t:` literal in packages/core is path, text or image (grep); stroke path, fill path, text (free, boxed, rotated, `reveal`) and image are all handled. Text and path maths match the SVG adapter (read in full); `reveal` is extra, the SVG adapter has none |
| Untrusted data | in real Chrome: named and `url()` colors paint gray, bad numbers fall back, no exception, console clean (`shot-5-hostile.png`). A non-data URL never becomes an `Image`: read at web/paint.js:115 and covered by the builder's unit test, not observed in the browser |
| Browser: every element tool by real mouse, alternating panes | Editor == Replica == room, strictly, both panes |
| Browser: move, eraser, double-click label, text | reach the peer; strict equality holds |
| Browser: wheel pan, ctrl+wheel zoom, space-drag pan | all change the view; page itself does not zoom or scroll |
| Browser: laser | nothing logged (seq unchanged); never fades (L2) |
| Browser: pixels at dpr 2 | both canvases 1399×1285, 0 differing pixels. This shows the two panes agree, not that the painter is right (both use it); for that I looked at the screenshots |

Chrome 157.0.8103.51 headless, `--remote-debugging-port=0`, own scratch profile, static server on port 0. I killed only my
child (PID 93442) and checked that it and every process under my scratch profile were gone.

## What I did not check

- Touch and pen input, a real hi-dpi display (dpr 2 was forced by flag), drawing by hand in a visible window.
- Pictures in the browser (the dev page has no paste or drop), beyond the hostile-URL case.
- A WebSocket transport (none exists) and anything about real network loss or reordering.
- Peers' live previews (the painter never draws `replica.previews`).
- Safari and Firefox.
- H1's window over a real network; I forced it by stepping the in-process links.

## For the fix round

1. Don't renumber against an empty Replica: hold edits until caught up, or keep the Editor's own version while not live (H1).
2. Reconcile the Editor with the Replica when a gesture ends without a commit (H2).
3. Export a strict comparison and use it in the gate; add the four gate cases listed under H3.
4. Send pending ops after `welcome`, never-sent ones after catch-up (M1).
