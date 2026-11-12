# p8-tidy (client): leftover MEDIUM and LOW findings — report

**Status: all seven items done.** `bun test test/web` 797 pass, 0 fail. Of 29 mutants, 27 are killed. Two are equivalent (M3a, whose line I then deleted, and the old merged `status` getter). The Chrome gates pass. Full counts are below.
Not committed (the manager commits).

- **Distributed-systems-design skill, APPLIER mode:** applied to item 1 (the only design-bearing item). See "Design" below.
- **Engram:** recalled before work. One hit mattered: ws.js had no `fail()`, so `dropConnection()` was a no-op in Chrome (L6).

## Files

| File | Why |
|---|---|
| web/adapters/dom/app.js | Item 1 (jitter by role, pill click, a click cancels the probe), L8 (stored `mine` per room user), item 5 (passes `maxScale` and `onList` to the collab UI) |
| web/core/session.js | L2 (merged getters removed), L3 (`wrapTransport` wraps only what the adapter has), L8 (`s.mine` is a getter) |
| web/core/sync.js | L5 (a snapshot reloads each bind whose stream it holds) |
| web/adapters/transport/ws.js | L6 (`fail()`) |
| web/core/collab/records-model.js | Item 5 (`zoomToFit` returns `list: true`) |
| **web/adapters/dom/collab/ui.js** and **web/adapters/dom/collab/collab.css** | **The emote control's files** (item 3). ui.js also holds the cluster click and the comments drawer, so item 5's list lives there too |
| test/web/architecture.test.js | Item 4 (`regexMayStart` after `)`) and its cases |
| test/web/p8-tidy.test.js (new), test/web/ui-app.test.js, test/web/collab/perf.test.js | New tests |
| test/web/ui-land.test.js, test/web/ui-app.test.js (C-17, K1), test/web/contracts/class-transport.test.js | Re-driven or updated for L2/L3 (see "Changed assertions") |

## Per item

### 1. MEDIUM-1: resume jitter by role

- **Window:** `probeJitterMs(role)` (app.js). Presenters (owner, editor) get 0–2 s. Annotators, commenters and viewers get 0–15 s. A role not yet known (no welcome) gets 15 s.
- **The user's own click skips it:**
  - **Retry / Retry now:** these already reconnected at once. They now go through `reconnectNow()`, which also cancels a probe still waiting. Without that, a second hello went out up to 15 s later on a link that was already live.
  - **The pill:** had no click handler. It now reconnects at once when the status isn't live (and `shouldProbe` allows: never while refused, stopped, capped or mid-gesture). A click while live does nothing.
- **Not built (engine's, t18m):** gateway hello admission (a token bucket) is the backstop for a correlated return.
- **Not affected:** reconnects after a socket close still use the Replica's rule-12 backoff, not this jitter.

### 2. L8: `mine` saved under the old user's key

- **Session side:** `s.mine` is now a getter through `mineNow()`. Every reader, app.js's direct reads included, sees the cleared set after a user switch. Before, the clear was lazy.
- **Page side:** app.js keys the stored set by the room's user (`S.connection.lastUser`, falling back to the sign-in user before the first welcome).
  - **On a switch:** it loads the new user's stored set and never writes the old key again.
  - **Result:** user A's stored `mine` survives, and B's notes go under B's key.

### 3. LOW-3: rapid emote clicks — made visible (cooldown), not coalesced

- **Pacing:** unchanged at 4/s (§ Pacing). gate.js isn't mine and still drops over-rate emotes.
- **New behaviour:** after each send, the whole control (bar, phone button, picker) shows it is cooling down until the 250 ms gap has passed:
  - class `cooling`, at 45% opacity with a progress cursor
  - `aria-disabled="true"`
  - the title "Cooling down: emotes go out at most 4 a second"
- **No silent loss:** a click inside the gap lands on a control that visibly isn't taking emotes. The gap comes from `PRESENCE.emote.rate`, and a clock-port timer clears the state when the gap ends.
- **Kept across re-renders:** the state is folded into `renderEmotes()`, so the 1 s tick and `onEmotes` don't wipe it.
- **Why not coalesce:** a held emote arrives late and means nothing. Coalescing 30 clicks into a few would also lose clicks, just less visibly.

### 4. R2-MED-2: a regex after `)`

- **Fix:** the report's matching-paren rule. `)` starts a regex only when its `(` follows `if`, `while`, `for` or `with` (and not `.if`). `out` already has strings and regex bodies blanked, so the parens balance.
- **Why not the simpler fail rule:** it would hit real `(a + b) / 2 // comment` lines.
- **New cases, all must be caught:**
  - The report's line `if (client) /\//.test(board); import(board)…; Date.now()` is caught by both `computedImports` and `globalsIn`.
  - So is a `while (…) /re/` case.
  - `(a + b) / 2` stays division: an `import(x)` after it is still caught, and a `// Date.now` comment after it isn't.

### 5. zoomToFit capped at 4

- **Max scale:** `mountCollab` takes the page's limit from `view.maxScale`. app.js passes `ZOOM_MAX` (8, the same constant `jumpTo` clamps to), so there is one source. Without it (web/collab/dev.js) the default stays 4.
- **List rule** (records-model.js): `list: true` when the members share one point (the fit is infinite) or the view is already at `maxScale`.
  - **The click then lists them:** the comments drawer shows only that cluster's threads ("N threads here · Show all"). It does not zoom, so it can't loop.
  - **Opening the drawer:** the new optional `onList` callback tells app.js to open it (the phone sheet on phones).
  - **The cluster's title** says "click to list them".
- **The report's case:** 600 threads in a 90×60 spot at 4×. A click now goes to 8×, and the next click lists that cluster's members.

### 6. p8-one-linkv L2–L6

- **L2:**
  - **Removed:** the merged getters. `status`, `congested`, `limited`, `limitedNextTry` and `pending` read the link (`C`) alone.
  - **The ui-land `stopped` test:** no longer forces `binds.board.status`. It drives real events instead:
    - **Sticky stop:** after the stop, a real unasked drop (the stub's `fail` → `onDrop`) and a `reconnect()` hello leave it `stopped`.
    - **Stopped beats refused:** a second session gets `auth` (refused), then `version`, and ends `stopped`.
    - **Mutants:** checking refused before stopped in sync.js is killed. So is dropping the `replica.stopped` guard from the onDrop handler.
  - **Equivalence:** a mutant that restores the old merge is equivalent (both binds share one link). L2 was dead code, so its "fails before" test is the re-driven one, not a mutant kill.
- **L3:** `wrapTransport` wraps only the members the adapter has. A transport without `reopen()` now throws through `createSession`, and absent members stay absent. sync.js already reads `congested` and `backlogBytes` as optional.
- **L4:** the code was already stream-aware (`seqOf(e.stream)`, per-stream `confirmedVersion`), so this is a test-only change.
  - **The test:** a board id equal to a note id isn't a known note, and the reverse, for both entry-fed and snapshot-fed ids. An annotator's note reusing a board id counts as theirs.
  - **Mutants:** kills V7 and its snapshot twin.
- **L5, which conflicts with the brief's wording:** a snapshot carries every element stream (PROTOCOL.md `snapshot: streams { board, notes }`; replica.js:436–447 loads each). So "reload only the snapshot's stream", read as one bind, *is* mutant V11.
  - **What I did:** reload each bind whose stream the snapshot holds (in practice both), and add a test that injects a snapshot while live and checks that both Editors reload and match the Replica. This kills V11.
  - **For t14k:** flagging the wording here so you can confirm.
- **L6:** ws.js has `fail()`. The current socket drops as an unasked close would: it is closed and onDrop is reported once. Nothing happens after `close()`.
  - **Wiring:** `globalThis.plenary.S.dropConnection()` reaches it through the wrapper; main.js is unchanged.
  - **Tests:** the bridge test checks the drop, a fresh socket, live again, and the note made before the drop landing.

### 7. LOW-R2-1

Left as is: the verifier called it close to equivalent with no action.

## Design (distributed-systems-design, APPLIER, item 1)

- **NFR:** 100k joins in 2 min, about 830 hellos/s. Since p8-one-link, a reconnect is one hello per tab.
- **Correlated return of a whole all-hands:**

  | Window | 100k tabs give |
  |---|---|
  | 0–2 s (before) | about 50k hellos/s, 60× the budget |
  | 0–15 s (now) | about 6.7k hellos/s, 8× the budget |

- **Still over budget, so the rest is layered:**
  - **The heard-recently skip on visibility:** a busy board sends no hellos at all.
  - **E-1's heartbeat:** it makes "heard" true on every live link.
  - **Gateway admission (engine):** the backstop.
- **Editors:** a handful per board, so 0–2 s costs nothing at scale and keeps their recovery quick.
- **Failure walk:**
  - **A viewer who really lost the link waits up to 15 s, or clicks the pill or Retry for an immediate reconnect.** The pill shows "Connecting…" in that time, so the way out is visible.
  - **A role not known yet takes the wide window.** It errs toward protecting the gateway.
- **Not addressed (needs data I don't have):** scaling the window by the last `here.viewers` (p7-chromev's option 2).

## Changed assertions (none weakened; say if you disagree)

- **class-transport.test.js:** `bare.congested()` was `false` and `bare.backlogBytes()` was `0`.
  - **Now:** `"congested" in bare` and `"backlogBytes" in bare` are false, and the wrapper's keys are exactly what the adapter had.
  - **Why:** this is L3's requested change. The old lines asserted the made-up defaults.
- **ui-app.test.js C-17 and K1 (capped):** they forced `limited`/`status` on `S.binds.*`. Since L2 the session reads the link, so they now force the same getters on `S.connection`. The assertions are unchanged.
- **ui-land.test.js `stopped`:** the forced `binds.board.status` is replaced by real events after the stop (see L2). The assertions are kept, and two are added.

## Tests (each fails before its fix; see the mutants)

| Item | Test |
|---|---|
| 1 | ui-app: "p8-tidy MEDIUM-1: the resume jitter follows the role…"<br>"…the user's own click (the pill, Retry) reconnects at once and cancels the waiting probe"<br>"…Retry (offline banner) also cancels the waiting probe; a role not known yet takes the wide window" |
| 2 | ui-app: "p8-tidy L8: after a same-tab switch to another user, the old user's stored notes survive…" |
| 3 | collab/perf: "p8-tidy LOW-3: 30 quick emote clicks are never lost silently…" |
| 4 | architecture: R2-MED-2 cases in "computed import(…)" and in "the globals rule catches bare globals…" |
| 5 | collab/perf: "p8-tidy zoomToFit: …lists its members when it can't split", "…600 threads in a 90×60 spot at 4×…", "…20 threads on one point…"<br>ui-app: "p8-tidy zoomToFit, wired: …" |
| L2 | ui-land: "p6-sync2v M2: `stopped` wins…" (re-driven) |
| L3–L6 | p8-tidy.test.js: "L3…", "L4…", "L5…", "L6…" |

## Mutants

Each was run against all of `bun test test/web`, one at a time, on a scratchpad copy of the tree (never the shared tree).

| Mutant | Result |
|---|---|
| M1a jitter 2 s for every role | killed (1) |
| M1b jitter 15 s for every role | killed (2, incl. the existing C-4) |
| M1c a click doesn't cancel the probe | killed (1) |
| M1d the pill has no click | killed (1) |
| M1e Retry calls `S.reconnect` directly (no cancel) | killed (1) |
| M1f unknown role takes the editor window | killed (1) |
| M2a mine saved under the mount-time key | killed (1) |
| M2b the user switch isn't noticed in app.js | killed (1) |
| M2c the session's `mine` is a plain Set (lazy clear) | killed (1) |
| M3b the cooldown not shown | killed (1) |
| M3c the cooldown never ends | killed (1) |
| M3a my own cooldown gate in `sendEmote` removed | **survived, equivalent:** gate.js refuses the same click on the same clock. I deleted that line, so it is no longer in the code |
| M4 `)` never / always starts a regex | killed (2 / 2) |
| M5a `zoomToFit` never lists | killed (4) |
| M5b lists only on one point | killed (3) |
| M5c ui.js ignores `view.maxScale` | killed (2) |
| M5d app.js passes no `maxScale` | killed (1) |
| M5e app.js passes no `onList` | killed (1) |
| M5f the drawer ignores the cluster filter | killed (1) |
| L3 the wrapper always adds `reopen` | killed (1) |
| L4 V7: every entry id under notes | killed (1) |
| L4 V7b: snapshot ids under notes | killed (1) |
| L5 V11: a snapshot loads only the first bind | killed (1) |
| L6 ws.js has no `fail()` | killed (1) |
| L6 `fail()` closes but never reports | killed (1) |
| L2b `refused` checked before `stopped` (sync.js `refreshStatus`) | killed (1, the ui-land test) |
| L2c the onDrop handler ignores `replica.stopped` | killed (2) |
| L2 the old merged `status` getter restored | killed (3), but only because the tests now fake the link. **Behaviourally equivalent** on one link |

## Headless Chrome, production rig

- **Setup:** test/server/rig.js on port 0, web/main.js, ws transport, real dev sessions. Driver: `/private/tmp/claude-501/-Users-r-repos-plenary/71823fa5-3424-4ec6-9aee-d44d0810ac1e/scratchpad/drive.js` (kept out of docs/). Three runs.
- **Processes:** Chrome PIDs 73884, 81757 and 10681 were recorded, killed by PID, and confirmed gone. No pkill.

| Gate | Result |
|---|---|
| **Viewer, `online` → new WebSocket** | 13065, 2921, 14971, 8934, 8906, 4962 ms (run 1); 5227, 10941 ms (run 2); 4662 ms (run 3). All within 0–15 s; 8 of 9 over 2 s. Live after each |
| **Editor, `online` → new WebSocket** | 901, 967, 1469, 978, 480, 506 ms (run 1); 270, 1720 ms (run 2); 257 ms (run 3). All within 0–2 s |
| **30 quick emote clicks** (real `Input.dispatchMouseEvent` on 👍, about 15 ms apart) | 3 emote frames sent. The other 27 clicks landed while the bar showed `cooling`, which is every click either sent or visibly refused.<br>Right after a send: `aria-disabled="true"`, the title "Cooling down: emotes go out at most 4 a second", opacity 0.45.<br>The cooldown cleared on its own. Screenshot: `/private/tmp/claude-501/-Users-r-repos-plenary/71823fa5-3424-4ec6-9aee-d44d0810ac1e/scratchpad/emote-cooling.png` |
| **`plenary.S.dropConnection()`** | Status `connecting` at once. 1 WebSocket closed, 1 new one, `live` again |
| **No token in a URL, localStorage or a log** | Checked for the rig's token marker: 57 request and WebSocket URLs, all of localStorage (empty), the browser console, and the server's log (10 lines, run 3). None found |

- **Synthetic events:** `online`/`offline` were synthetic `dispatchEvent`s in a real page (as p7-chromev did).

## `bun test` (full, shared tree)

- **Counts:** 1401 pass, 151 skip, 2 fail (1554 tests, 82 files).
- **Fail 1, known:** test/core-source.test.js (herdr-draw's uncommitted core edits).
- **Fail 2, not this job's:** test/architecture.test.js "packages/, server/ and scripts/ follow the hexagonal import rules". It flags another session's **untracked** files: scripts/cluster-rig.js and scripts/load/*.js ("neither core, adapter nor a composition root").
- **test/web alone:** 797 pass, 0 fail (after the last edits).

## What I did NOT check

- **A real `visibilitychange`, sleep or Wi-Fi switch in Chrome:** visibility is covered only on the virtual clock (ui-app).
- **The phone sheet path of `onList`** (`ui.sheet = "comments"`) in a browser. It is unit-wired only; the desktop drawer path is tested on the page rig.
- **The cluster list and the 8× zoom in Chrome:** checked on the page rig (stub DOM) and the collab rig, not in a real browser.
- **A refused `fail()` race:** `fail()` during a reopen in flight in a real browser (it acts on whatever socket is current).
- **No sdd ensemble review:** builder job; the verifier runs one.

## Risks

- **The pill is a `span` with a click,** so it isn't keyboard reachable (Retry is the keyboard path). It is clickable while not live. It is a new affordance, not in the design mock. It only reconnects, and only when `shouldProbe` allows.
- **15 s for viewers is a real wait** after a genuinely dead link, unless the user clicks. That is the manager's trade-off, stated in the design section.
- **The cluster filter in the drawer is a new UI state.** It clears on "Show all" or on either list tab.

---

# Round 2 (docs/m2/briefs/p8-tidy2.md, answering docs/m2/reports/p8-tidyv.md)

**Status: the 3 HIGHs (H1–H3), the MEDIUM (M1), and L1 and L6 are fixed and tested. L3 and L4 can't be made to fail; the reasons are below.**

- **Tests:** test/web 800 pass, 0 fail.
- **Full `bun test`:** 1423 pass, 153 skip, 1 fail. The fail is the known test/core-source.test.js. No other track's file fails this run.
- **Mutants:** all 11 of round 2's are killed.
- **Chrome:** H3 reproduced and fixed.

## Changes

| # | File | Change |
|---|---|---|
| H3 | web/adapters/dom/app.js | **The resume probe stands down when the link was heard after it was armed.** `heardN` counts any room event (`S.onRoom`) and a welcome (the link reaching `catching-up` or `live`, through `S.onStatus`). A probe remembers `heardN` when armed. At fire time it skips if the count moved: the Replica's backoff already restored the link, and replacing it would be a second hello for one return |
| H1 | test/web/ui-app.test.js | **The pill gate is tested.** A click while refused, limited, stopped or mid-gesture gives 0 reopens; while connecting, 1 |
| L1 | web/adapters/dom/app.js | **One user reconnect at a time.** `reconnectNow()` (pill, Retry) ignores clicks while one is in flight. In flight lasts until the link's next status change, or 5 s at most (`USER_RECONNECT_MS`, clock port) |
| H2 | test/web/architecture.test.js | **The head-word tests now bite.** New cases: `while (go) /\//.test(s); import(spec)` and `for (;;) /\//.test(c); import(d)` are caught; `x.if(a) / 2; // import(y)` and `x . if (a) / 2; …` stay 0. The vacuous `/a\/b/` case was replaced. The member check now skips spaces before the `.` |
| M1 | test/web/architecture.test.js | **`for await (…) /re/`:** when the word before `(` is `await`, the word before it is checked for `for`. `for await (const x of y) /\//.test(x); import(d); Date.now();` is caught by both `computedImports` and `globalsIn`. `await (p) / 2; // import(y)` stays division |
| L6 | test/web/architecture.test.js | **Postfix `++` / `--` end a value** (`i++ / 2` divides). A prefix one can't take a regex, so `++`/`--` right before `/` is always division. `i++ / 2; import(d); Date.now(); // x` and the `--` case are caught |

## Tests (each fails before; see the mutants)

- **ui-app, "p8-tidyv H3: a resume probe stands down when the link was heard after it was armed…"**
  - **The verifier's case:** a viewer, random 0.99, `online`, then a real `dropConnection()`. Result: 1 reopen and 1 hello.
  - **Control:** a silent link, where the probe reopens once.
  - **A welcome with no room event:** the room's `here`, `emotes`, `presence` and `leave` are filtered from the page, and the probe still stands down.
- **ui-app, "p8-tidyv H1: the pill click is refused while refused, capped, stopped or mid-gesture; it reconnects when connecting".**
- **ui-app, "p8-tidyv L1: a double-click on the pill while a reconnect is in flight opens one socket"**, plus "a click works again once the status moved", inside the 5 s window.
- **architecture:** "computedImports …" gets the H2, M1 and L6 lines; "the globals rule …" gets the M1 and L6 lines.
- **Test-only change:** ui-app `setup()` gains an optional `wrap` for the transport, used by the H3 welcome-only case. Existing callers are unchanged.

## Mutants (round 2, each against all of test/web, scratchpad copy)

| Mutant | Result |
|---|---|
| V-H3: the probe ignores heard-since-armed | killed |
| V-H3b: a welcome (status) doesn't count as heard | killed |
| V-1g: the pill without the `shouldProbe` gate | killed |
| V-L1: no in-flight guard | killed |
| V-L1b: the guard never ends on a status change | killed |
| V-4c: drop the `.if` member guard | killed |
| V-4d: drop `while` | killed |
| V-4e: drop `for` | killed |
| V-M1: no `for await` | killed |
| V-M1b: `await` alone counts as a head | killed |
| V-L6: no postfix rule | killed |

## L3 and L4: can't be made to fail (say if you want more)

- **L3 (V-L5b, "reload every bind on a snapshot"):** a snapshot missing a stream never reaches the bind code.
  - **Why:** `Replica.snapshot` reads `msg.streams[s].elements` for every element stream. It throws `TypeError: undefined is not an object (evaluating 'sc.elements')`, which I probed through createSession.
  - **So:** every snapshot that loads holds both streams, and "reload each bind whose stream it holds" equals "reload every bind". The `Object.hasOwn` check stays as the ruling's guard.
  - **What would kill it:** a test that hands a prototype-inherited `streams` object, which no decoded frame can be. I didn't add that.
- **L4 (V-2g, "saving before the first welcome"):** before any welcome there is no role, so `S.mine` can't grow. Only an op that passes the role backstop adds to it.
  - **The only pre-welcome write:** the page's initial set saved back under the same key it was read from.
  - **So:** skipping that write changes nothing observable. The only exception is the save's own normalization (non-strings dropped, the last 5000 kept), which isn't the behaviour L4 is about.

## Chrome, production rig (test/server/rig.js, port 0)

- **The verifier's H3 case:** random pinned to 0.99, `online`, then `plenary.S.dropConnection()`, watched for 17 s.

  | Build | Viewer | Editor |
  |---|---|---|
  | **After the fix** | 1 new socket, 1 hello, `live` | 1 new socket, 1 hello, `live` |
  | **Before** (the same tree with the H3 line removed) | 2 sockets, 2 hellos | 2 sockets, 2 hellos |

- **Server log:** the token marker is absent (8 lines).
- **Driver:** `/private/tmp/claude-501/-Users-r-repos-plenary/71823fa5-3424-4ec6-9aee-d44d0810ac1e/scratchpad/drive-h3.js`.
- **Processes:** Chrome PIDs 50548 and 54034 were recorded, killed by PID, and confirmed gone.

## Not done (manager's rulings)

- **L2 and L5:** no action.
- **Design items 2 (server retry-after) and 3 (window by audience):** these go to engine (t18m) and M4.

## Round 2: what I did NOT check

- **H3 and a real `visibilitychange`** in Chrome (unit only, the same probe path).
- **The L1 guard in Chrome:** the 5 s fallback when a status never changes is unit-tested only.
- **No ensemble review:** builder job.

---

# Round 3 (docs/m2/briefs/p8-tidy3.md, answering p8-tidyv.md "Round 2")

**Status: every round-3 item is fixed and tested. 11 of the 12 mutants are killed; V-L1d is now equivalent (below).**

- **Tests:** test/web 805 pass, 0 fail.
- **Full `bun test`:** 1441 pass, 155 skip, 1 fail (1597 tests, 85 files). The fail is the known test/core-source.test.js. No other track's file failed this run.
- **Other tracks' untracked files present:** deploy/cluster/RIG.md, scripts/cluster-rig.js, scripts/load/, test/deploy/, test/load/, test/server/main-cluster.test.js, test/server/roles.test.js.

## Changes

| # | File | Change |
|---|---|---|
| R2-M2 (HIGH) | web/core/sync.js, web/adapters/dom/app.js | **The link counts its hellos** (`S.connection.hellos`, bumped on every connect: the first, backoff, `reconnect()`). A probe remembers the count when armed and stands down at fire time if it moved: a hello is already out, waiting for its welcome. **A probe now fires only when nothing was sent and nothing was heard since it was armed** |
| R2-L1 | web/core/sync.js, web/core/session.js, web/adapters/dom/app.js | **"Heard" means a message from the room only.**<br>• **sync.js:** a new `onHeard()` fires in `transport.onMessage` for each message on the current connection, after the closed and down checks.<br>• **session.js:** passes it on as `S.onHeard(fn)`.<br>• **app.js:** both the heard stamp (the visibility check) and `heardN` (the probe) use it. `record()`, `recordsChanged()`, `dismissSetting` and `retrySetting` (local `onRoom`s) no longer count.<br>• **Welcome:** it is a room message, so the round-2 status-based bump is gone. |
| R2-M1 | test/web/architecture.test.js | **`++`/`--` is postfix only when what precedes it ends a value:** a non-keyword word, `]`, `}`, or a `)` that doesn't close an if/while/for/with head (new `endsValue`). Otherwise a regex may follow. The wrong comment is replaced |
| R2-L2 | test/web/architecture.test.js | **`of` is a keyword only after a binding** (`endsValue` before it: `for (const x of …)`, `for ([a] of …)`); elsewhere it is a name, so `/` divides. Small, and no new evasion found in the cases below |

## Tests (each fails before; see the mutants)

All in ui-app, using a new `heldSetup()` helper that can hold every room message, which makes a silent or dead link:

- **"p8-tidyv R2-M2: a probe stands down while a hello it didn't send waits for its welcome…"**
  - **The verifier's case:** probe armed for 7.5 s, real drop at 2 s, backoff reopen with replies held. Result at 8.5 s: 1 reopen.
  - **Control:** silent, nothing sent. The probe reopens.
- **"p8-tidyv R2-H1: a room event (here) on a live link after `online` stops the probe":** 0 reopens.
- **"p8-tidyv R2-H2: the L1 guard ends after 5 s even when the status never changes":** the welcome is held. A click at 4 s does nothing; a click at 5.5 s reconnects.
- **"p8-tidyv R2-H3: Retry goes through reconnectNow…":** a double-click on Retry gives 1 reopen. The click's welcome is held past an armed probe's 7.5 s, and there is still 1 reopen.
- **"p8-tidyv R2-L1: a local action inside the jitter window doesn't count as heard…":** owner, silent link, a records op at 0.5 s (a local `onRoom` fires). The probe still reopens at 1.98 s.

In the architecture test:

- **"computedImports …":**
  - **Now caught:** `++/\//.lastIndex; import(d)`, `x = --/\//.lastIndex; import(d)`, `if (x) ++/\//…`, `return ++/\//…`
  - **Still caught:** `a[i]++ / 2; import(d)`, `(a)++ / 2; import(d)` and round 2's `i++`/`i--` lines
  - **`of`:** `const x = of / 2; import(d); …` is caught, and `for (const x of /\//…)` and `for (const [a] of /\//…)` stay regexes
- **"the globals rule …":** the prefix `++`/`--` lines and the `of` line all keep their `Date.now`.

## Mutants (round 3, each against all of test/web, scratchpad copy)

| Mutant | Result |
|---|---|
| V-M2: no hellos check | killed |
| V-M2b: sync.js never counts hellos | killed |
| V-H3c: the heard path doesn't bump `heardN` | killed |
| V-R2L1: heard taken from `onRoom` (local actions count) | killed |
| V-L1c: the 5 s fallback never clears | killed |
| M1e: Retry calls `S.reconnect()` directly | killed |
| V-R2M1: `++` always postfix (round 2's rule) | killed |
| V-R2M1b: `++` never postfix (HEAD's rule) | killed |
| V-R2L2: `of` always a keyword | killed |
| V-R2L2b: `of` never a keyword | killed |
| V-ev: a `)` after a statement head ends a value | killed |
| **V-L1d: `reconnectNow` without `cancelProbe()`** | **survives: now equivalent, by fix 1 itself** |

**Why V-L1d is now equivalent:**
- **Every path sends a hello:** `reconnectNow()` → `S.reconnect()` → `reopen()` → `connect()` sends a hello on every path that does anything (`reopen()` returns early only after `close()`).
- **So the probe stands down anyway:** it sees `hellos` moved, whether or not it was cancelled. The cancel now only frees the timer early.
- **What's left:** the "held welcome past the probe" case (R2-H3) holds for both, and Retry's route is pinned by the double-click case (M1e killed). I kept the cancel as cleanup.
- **For t14k:** if you want it observable, the only handle is the clock's pending-timer count, which I'd rather not test.

## Chrome (sanity, production rig, port 0)

- **The round-1 H3 case** (random 0.99, `online`, then `dropConnection()`): the viewer and the editor each got 1 new socket and 1 hello, then `live`.
- **Server log:** no token.
- **Process:** Chrome PID 36908, killed by PID and confirmed gone.
- **R2-M2 itself:** checked on the page rig only.

## Round 3: what I did NOT check

- **R2-M2 in Chrome:** it needs held welcomes; page rig only.
- **`dismissSetting` / `retrySetting` as "not heard":** covered by construction (they never reach `transport.onMessage`) and by V-R2L1. There's no case of their own.
- **No ensemble review:** builder job.

---

# Round 4 (docs/m2/briefs/p8-tidy4.md, answering p8-tidyv.md "Round 3")

**Status: R3-H1 (ruled MEDIUM), R3-M1 and R3-L1 are fixed and tested. All 9 mutants are killed. I tried a new evasion of my own rule; it worked, and it's fixed (below).**

- **Tests:** test/web 806 pass, 0 fail.
- **Full `bun test`:** 1453 pass, 155 skip, 7 fail (1615 tests, 86 files). **None are in this job's files:**

  | Fail | Whose |
  |---|---|
  | test/core-source.test.js | The known one (herdr-draw's uncommitted core edits) |
  | test/deploy/cluster-rig.test.js, 5 tests ("cluster rig (real postgres, nats, caddy; stub nodes)") | Another track's **untracked** file |
  | test/server/nats-bus.test.js "nats stall: a frozen server (SIGSTOP)…" | Tracked and unchanged. It **passed alone right after** (15 pass, 15 skip, 0 fail), so it looks load-flaky while the cluster-rig tests run alongside |

- **Other tracks' untracked files present:** deploy/cluster/RIG.md, scripts/cluster-rig.js, scripts/load/, test/deploy/, test/load/, test/server/main-cluster.test.js, test/server/roles.test.js.

## Changes

| # | File | Change |
|---|---|---|
| R3-H1 | test/web/ui-app.test.js | **Pins `onHeard()`'s place after `if (closed \|\| down) return;`** (sync.js).<br>**The case:** an `unavailable` error puts the link down (resync, backoff ≥ 500 ms). Then `online` arms a viewer probe for 150 ms. A `here` arrives on the old socket while down. The probe still reopens. |
| R3-M1 | test/web/architecture.test.js | **`++`/`--` is postfix only when the value it follows ends on the same line and isn't a block's `}`.** A line break, or `}`, before it means prefix, so a regex may follow. All five of the verifier's lines are caught. |
| R3-L1 | test/web/architecture.test.js | **`of` is a keyword only inside a `for (…)` / `for await (…)` head:** an unclosed `(` whose word is `for`, plus a binding before `of`. Anywhere else it is a name, and `/` divides. |
| Own evasion | test/web/architecture.test.js | **CR, LS and PS (U+2028, U+2029) are JS line terminators,** just like LF. `codeOnly` now treats all four alike: they end a `//` comment, a string's line and a regex literal, they are kept when blanking, and the `++` rule sees them as line breaks. |

**Why the `of` rule differs from the brief's line-break rule:**
- **The brief's rule would misread legal code:** a line break is legal inside a for head, so `for (const x\nof /\//.exec(s)) import(d)` would read `of` as a name. The `/` would then divide, `/\//` would open a `//` comment, and the import would be hidden: a new evasion.
- **The for-head check covers both cases:** with or without line breaks. `const z = y\nof / 2` is outside any for head, so it is caught.

## The evasion I tried against my own rule

- **What I found:** `x\r++/\//.lastIndex; import(d); Date.now();`, and the same with U+2028 / U+2029, gave **0 imports and no globals**, because the rule only knew `\n`. Bun accepts both forms: the `\r` file ran ("ran-cr"), and the U+2028 one parses, failing only at run time on the undefined `x`.
- **The same gap, pre-existing:** `// a comment<U+2028>import(d);` and `// a comment\rimport(d);` hid the import, because `codeOnly` ended a `//` comment only at `\n`.
- **Fixed with one `isLT` helper,** with five new cases.
- **Also tried, all caught after the fix:**
  - `x // c\n++/\//…`
  - `x /* a\n b */ ++/\//…`
  - `` `t`\n++/\//… ``
  - `for (let i = of / 2; i < 1; i++) import(d)`
  - `const z = y<U+2028>of / 2; …`

## Tests (each fails before)

- **ui-app:** "p8-tidyv R3-H1: a message on the old socket while the link is down (a resync's backoff) isn't heard: the probe still reopens".
- **architecture, "computedImports …":**
  - the verifier's five R3-M1 lines
  - `x /* c */ ++ / 2; import(d)` (postfix through a comment on the same line)
  - `const z = y\nof / 2; …`, `for (const x\nof /\//…)`, `for await (const x of /\//…)`, `f(y, of / 2); …`, `for (let i = of / 2; …)`
  - the CR / LS / PS `++` lines and the two comment-end lines
- **architecture, "the globals rule …":** the five R3-M1 lines and the R3-L1 line keep their `Date.now`.
- **Still passing:** round 2's and round 3's postfix cases (`i++ / 2`, `i-- / 2`, `a[i]++ / 2`, `(a)++ / 2`).

## Mutants (each against all of test/web, scratchpad copy)

| Mutant | Result |
|---|---|
| V-R3a: `onHeard()` above the closed/down check | killed |
| V-ev2: a block's `}` ends a value | killed |
| V-nl: a line break doesn't make `++` prefix | killed |
| V-of1: `of` by round 3's rule (no for-head check) | killed |
| V-of2: `of` by the for-head check alone (no binding check) | killed |
| V-of3: `for await` isn't a for head | killed |
| V-LT: only LF is a line break | killed |
| V-LT2: a `//` comment ends only at LF | killed |

## Round 4: what I did NOT check

- **No Chrome run:** round 4 changed sync.js's tests and the architecture test only; no runtime code changed this round.
- **The `of` rule against a for head containing a nested arrow function with its own parens** (e.g. `for (const x of f((a) => a)) …`): reasoned only. The scan counts parens, so the nested ones balance.
- **No ensemble review:** builder job.
