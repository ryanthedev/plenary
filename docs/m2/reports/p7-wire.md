# Report: p7-wire (collab over sync)

**Done.** The sync layer now provides the collab port, and the collab UI is mounted in both roots (`web/main.js`, `web/dev-main.js`).

- **M1–M4 closed,** plus the count-only `here`, the `stale-setting` consumer, the writer-cap `limit`, and congestion on the status pill.
- **Tests:** `bun test test/web` passes (598). The new contract (`test/web/contracts/collab-contract.js`, 13 tests) passes against both the fake and the sync-side adapter (26 runs).
- **Mutations:** 28 of 29 mutants are killed; the one survivor is equivalent (see Mutations).
- **Headless Chrome:**
  - The dev page with three tabs shows every collab feature.
  - The production page boots on the real tree (HEAD 050ef13, rig, port 0) with no 404 except favicon.ico, and collab runs over `/ws`.

Worker: plenary-p7-wire. Manager: t14k. Nothing committed.

## Design (APPLIER, systems-design v0.1.0)

**Scope** (from the brief and the NFRs, not asked again):
- **Per board:** a handful of editors, ~2k annotators, 100k viewers. Editors get < 150 ms in the home region, viewers < 1 s.
- **Presence** may drop. Records are never lost once acked.
- **Two connections per tab** (one per stream) is a given from p6.

**Estimate** (client side):
- **Presence in:** ≤ 50 cursors per gateway batch, at 20 batches/s.
- **Records:** up to 10k threads per board.
- **Busy room:** 200 people reacting means ~200 records entries/s. At the measured ~35 ms per full records rebuild, firing per entry would stall the main thread. That is why records changes are coalesced (M4).

**High-level design:**
```
gateway ──ws──▶ board connection (Replica A) ──┐  presence, here, emotes, records, previews
        └─ws──▶ notes connection (Replica B) ──┤  notes(), noteAuthor, element("notes")
                                               ▼
web/core/sync.js bindEditor handle (the only protocol importer) ── onRoom events + accessors
web/core/session.js: merges both (status, congested, limited, settingsRefused, onRoom, onStatus)
web/adapters/collab/sync.js: the collab port over the session      web/adapters/collab/fake.js: the fake
web/adapters/dom/app.js: mounts web/adapters/dom/collab/ui.js over the port the root passes (main.js, dev-main.js)
```

**Decisions** (the port doc header is in `web/adapters/collab/sync.js`):

| Question | Decision | Why |
|---|---|---|
| Which connection carries presence and records | **Board**, only that one | One Replica means records and its pending overlay always agree. Forwarding both connections would double emotes and lasers. |
| `me.client` | The board connection's wire id (`replica.client`, the name plus the session part) | It's the id others' batches name me by. |
| My other connection | Presence from **either** of my client ids is dropped | The gateway relays my notes connection's previews back to my board connection. |
| `port.status` | The board connection's status | Presence and records live and die with it. |
| Status pill | The session's merged status (worse of the two), plus congestion and `limited` | The pill is about edits on both streams. |
| `port.role` | Board `welcome.role`, falling back to the last one seen (never null once seen) | Records still queue offline. On main, `Replica.reset` no longer clears `role`, so the fallback is belt and braces. |
| `me` | One stable object whose fields update (`user` from welcome) | Mount at any time; rule 13 may change `user`. |
| `onRecords` | At most once per animation frame; `records()` cached per records revision | M4 |
| Count-only `here` | Keep the last writer list and names; update only the counts. An explicit `[]` still clears. | t14k addition |
| Writer-cap `limit` (id-less, before welcome) | Status `limited`; no backoff loop; the banner and pill tell the user to close a tab and press Retry (`reconnect()`) | v1.1 delta |
| `stale-setting` | `refusedSettings` are listed and become `ready` on `retryReady`. Banner: "Apply mine again" (re-sends on the current base) or "Keep theirs". | Engine's LOW |

**Deep dives:**
- **Rate limiting (Ch4): drop, never queue.**
  - Every presence send passes, in order: live status, the role table (`presenceProblem`), the backlog gate (`backlogBytes() ≤ 16 KB`), and `presenceLimiter`.
  - The UI's outbox already paces stricter than the gateway's bucket.
- **Chat-system presence (Ch12): heartbeat, not connect/disconnect.** The 10 s repeat and 30 s expiry are unchanged.
  - **Dev rooms:** `local.js` now acts like a gateway for `here` and `emotes`. It sends the writer list to a joiner and when the list changes, count-only otherwise, and sums viewers' emotes per 500 ms window instead of relaying them.

**Wrap-up:**
- **Bottleneck 1:** `Replica.recordsState()` rebuilds the whole records copy per revision (packages/protocol). Coalescing caps this at once per frame, not per entry. The incremental fix belongs to engine.
- **Bottleneck 2:** each tab counts twice in `viewers` (see Risks).
- **Bottleneck 3:** pins re-place on every view or board change, which is O(threads) per frame while panning.
- **Failure:** a lost connection clears presence and resets the outbox. Records stay pending and are re-sent; on resume, my cursor and selection go out again.
- **At 10×:** the gateway's cursor thinning (50 per board) becomes load-bearing. The client has no cap of its own on peers (p7-collabv design check, unchanged).

## Files

| File | Change |
|---|---|
| `web/core/sync.js` | `bindEditor` takes `onRoom` and exposes: `client`, `user`, `lastRole`, `limited`, `congested()`, `sendPresence()` (gated), `record()`, `recordsState()`, `recordsRev`, `pendingRecords()`, `previewEntries()`, `noteAuthor()`, `element()`, `elements()`, `settingsRefused`, `retrySetting()`, `dismissSetting()`. It also handles the writer-cap stop, rule-5 records refusals (looked up before `receive`), and the role and settings events. |
| `web/core/session.js` | `onRoom`, `onStatus`, `congested`, `limited`, `settingsRefused`, `retrySetting`, `dismissSetting`, `roomUser`, `links` (test hook). Merged status adds `limited`. |
| `web/core/roles.js` | `pillFor`: "Too many tabs" for `limited`; "slow link" when congested. |
| `web/core/collab/presence-model.js` | A count-only `here` keeps the writer list and names. |
| `web/ports/collab.js` | Port doc: the adapters and the contract test; `role` never null once seen; `me` one stable object; `status` = the presence connection's (plus `limited`); presence never mine, never twice; `onHere` always the full shape (count-only keeps the list); `onEmotes` `{ counts }`; `onRecords` may be coalesced to once per frame; records actions paced by the Replica. Stale p7-collab notes removed. |
| `web/adapters/collab/sync.js` | **New:** the sync-side collab port adapter (with its decisions as the header). |
| `web/adapters/collab/fake.js` | Count-only `here` kept; `onEmotes` delivers `{ counts }` only (both are port rules now). |
| `web/adapters/dom/collab/ui.js` | M3: separate desktop and phone "+N" badges (`PHONE_AVATARS = 2`). |
| `web/adapters/dom/collab/collab.css` | Phone and desktop "+N"; the presence overlay canvas; the collab drawer embedded in the page drawer and sheet. |
| `web/adapters/dom/app.js` | Mounts the collab UI over the root's `collab` port factory, replacing the stubs: avatars (`here`), the emote bar and phone emote button, comments in the drawer and sheet. Also: pointer presence, selection presence (sent from the frame loop, so an Escape or a tool switch clears it on peers too), laser while the Laser tool drags, right-click (and 💬) to comment, `layout()` on view or board change, theme, congestion on the pill, and banners for the writer cap and refused settings. Returns `collab`, `port`, `startComment`. |
| `web/main.js`, `web/dev-main.js` | Pass `collab: (S, o) => syncCollabPort(S, { name: me.name, ...o })`. |
| `web/index.html`, `web/dev-main.html` | Link `adapters/dom/collab/collab.css` (index.html's relative hrefs are served). |
| `web/adapters/transport/local.js` | A gateway stand-in for `here` (users once; viewers as connections; count-only when only counts change) and `emotes` (500 ms windows). `broadcast()` test hook. |
| `test/web/contracts/collab-contract.js` | **New:** `collabContract(name, makeAdapter)`, 13 tests. |
| `test/web/adapters/collab-rig.js` | **New:** `syncRig`, the sync adapter's driver: two real sessions (me and the peer Bo) on the reference room, virtual clock. |
| `test/web/adapters/collab.test.js` | **New:** the contract against the fake and the sync adapter. |
| `test/web/collab/wire.test.js` | **New:** 20 sync-only and UI tests (below). |
| `test/web/architecture.test.js` | `web/adapters/collab/` is no longer a dev path (only `*/fake.js` is). The production graph must contain `adapters/collab/sync.js` and `dom/collab/ui.js`. |
| `test/web/core/page-signin.test.js` | `mountApp`'s return keys now include `collab`, `port`, `startComment` (none carries the token or the sign-in). |

## Tests (Must-close → test)

| Item | Test(s) |
|---|---|
| M1 presence in, once, from the board connection | contract "others' presence arrives once"; wire "presence and here come from the board connection only" |
| M1 presence out, `me.client` | contract "send forwards…"; wire "me.client is the board connection's wire id" |
| M1 my two client ids filtered | wire "my own notes connection's presence never shows as a peer" |
| M1 `here`, emotes | contract "here…count-only…", "emotes"; wire "the real room's here: names, a count-only here…" |
| M1 records and pending overlay | contract "my thread shows at once as pending, then confirmed", "react, unreact, reply, resolve, reopen and delete" |
| M1 refused | contract "a refused action fires onRefused"; wire "onRefused: only a rule-5 refusal…never stale" |
| M1 `noteAuthor`, `notes()`, `element()` | contract "notes: notes(), noteAuthor and element…" (deleted → null) |
| M1 previews with the sender | contract "previews: others' drags with the sender" |
| M1 role during a resync, status | contract "role change mid-session…never null", "a drop…records sent while down are kept"; wire "M2: role stays the last one while reconnecting" |
| M2 role change mid-session | wire: editor → viewer (cursor, laser, select and the 10 s repeat stop; startComment refused; the viewers-see-presenters flag applies; emotes still go); editor → commenter (laser stops; cursor and comments work); "a compose box left open across a downgrade sends nothing" |
| M3 "+N" on phones | wire "M3: +N counts against what phones show", "no phone +N when two or fewer write" |
| M4 coalescing | wire "M4: onRecords is coalesced: 40 entries…one call, and records() is cached" |
| Count-only `here` (t14k) | model, port (contract, both adapters) and UI ("count-only here through the UI never clears the avatar row") |
| `stale-setting` | wire "the losing settings change is listed, becomes ready, and a retry lands it"; "dismiss forgets it" |
| Writer-cap `limit` | wire "an id-less limit before welcome stops the link…no reconnect loop" (10 virtual minutes, one hello; Retry sends one); "the session's merged status is limited when either connection is"; "the pill says so" |
| Presence gate | wire "nothing goes out over 16 KB of backlog, and nothing while not live" |

## Mutations

Each mutant was applied to one file, the collab tests were run (`test/web/collab`, `test/web/adapters/collab.test.js`), then the file was restored. Script: the scratchpad's `p7/mut.py`.

- **Killed (28):**
  - **Port wiring:** forward notes-connection presence; echo filter on the board client only; `me.client` = the notes client; status = not the board's; pending left out; refusals never forwarded; refusals also fired for stale (code filter removed); `noteAuthor` unwired; `element` ignores deletion; previews without the sender; port role null while down.
  - **M2** (the three p7-collabv named as surviving): the outbox's role captured once at mount and used throughout `createOutbox`, killed by both M2 downgrade tests; `presence.setRole` a no-op; `recordProblem`'s role frozen, killed by "a compose box left open across a downgrade to viewer sends nothing".
  - **M3 and M4:** phone "+N" counted against 5; `onRecords` per entry; `records()` not cached.
  - **Count-only `here`:** it clears the list (in the model, and in the sync port); it clears the names (`writerBy`).
  - **Writer cap:** the cap not caught; `reconnect()` keeps it.
  - **Pill:** `limited` not shown; congestion ignored.
  - **Settings:** never ready; retry sends nothing.
  - **Presence gate:** removed; presence sent while not live.
- **Survived (1, equivalent):** removing `limited` from the `onDrop` guard. `pump()` already returns early while limited, so nothing reconnects. The guard only spares one `connectionFailed()` count.
- **Removed as equivalent before the final run:**
  - A separate role branch in the port's `onStatus`: a role changes only with a welcome, which always changes status.
  - A `listed` guard on `writerBy`: the kept list rebuilds the same map.

## How I checked it in a browser (headless Chrome, debug port 0, PIDs recorded and killed; static server and rig on port 0)

- **Dev page** (`web/dev-main.html?board=p7w&net=shared`): three tabs on one SharedWorker room: ada (owner, presenter), cy (annotator), ed (viewer).
  - **Ada:** drew a rectangle with the real mouse and selected it.
  - **Cy:** right-clicked to comment and posted a thread through the compose box.
  - **Ada:** reacted 👍.
  - **Ed:** clicked 😂 three times on the emote bar.
  - **Ada:** ran a laser and cursor loop and sent 👍 emotes.
  - **Seen on cy and ed:** Ada's cursor, selection (1 id) and laser trail; avatars Ada and Cy; floating 👍; the 😂 count of 3 on the bar; 1 pin; the thread with 👍 1. Pills: "Live" for cy, "View only" for ed. The viewer sees no annotator cursors (the flag).
  - **Seen on Ada:** Cy's cursor, the pin, and the 😂 count.
  - **Ed's comments drawer and thread:** read-only ("Viewers read comments; they can't reply or react").
  - **Ghost selection:** after Ada cleared her selection, Cy's view dropped it within 0.8 s.
  - **Stale-setting banner:** a fourth tab, bo (editor), and Ada set the timeline duration at the same moment. Bo lost and got the banner "⚠ Your change to timeline was not saved: someone changed it first. [Apply mine again] [Keep theirs]". Pressing Apply mine again landed 7000 on both tabs and the banner went away.
  - **Run on the final code** (after every edit in this job). **Console errors:** none. **Failed requests:** only favicon.ico.
  - **Screenshots** (scratchpad `p7/`): `dev-cy.png`, `dev-ed.png`, `dev-ada.png`, `dev-ed-thread.png`, `dev-stale-banner.png`.
- **Production page** (index.html through `test/server/rig.js`, port 0, the real tree at **050ef13**, nothing patched): three tabs (owner, annotator, viewer) with dev tokens in session storage.
  - **Each tab:** live over `/ws` (`net.kind` "ws"); `me.client` = its board connection id; avatars owner and annotator; cursors seen across tabs (the viewer sees the owner's only); the viewer's 🔥 counted at everyone; the annotator's thread acked (pending 0) with 1 pin everywhere.
  - **Failed requests:** only favicon.ico. **Console errors:** none. **Server "not served" log lines:** none.
  - **Before 050ef13,** the same run 404'd on `/adapters/collab/sync.js` (server DENY rule; engine fixed it).

## NOT verified

- **Real mouse input in background headless tabs:** CDP mouse events sent to a tab that isn't in front don't produce pointer events. Cross-tab cursors were checked with the real mouse in a two-tab run (cy in front), and in the three-tab run by calling `collab.pointer` directly.
- **Phone layout in a real browser:** M3 is tested in the fake DOM and the CSS was read, but there is no 390 px screenshot.
- **Big rooms:** the gateway's `here` pacing and cursor thinning, and the coalesced records path under a real 200-reactions/s load (only measured by the verifier at 10k threads before this job).
- **The writer cap against the real gateway:** only the scripted transport tests (bind and session); 9 real writer connections were not opened, and the "Too many tabs" banner was never rendered in a browser (its text is in app.js; the pill is unit-tested).
- **`stale-setting` from the real server:** checked on the reference room only.
- **Full `bun test`:** 1124 pass, 9 fail. None is in `test/web` or imports `web/`.
  - `test/core-source.test.js`: known to fail on main.
  - `test/server/gateway.test.js` and `test/server/tune.test.js`: `server/gateway.js` is being changed in the working tree by another job (p2-tune, busy at the time).
  - I did not re-run those against a clean tree.

## Risks and notes

- **One viewer tab shows as "2 watching" (needs engine or protocol, most important):** see the first bullet below.

- **One viewer tab counts as 2 watching** (seen on both pages). Each tab opens two connections (board and notes), and `here.viewers` counts viewer **connections** (PROTOCOL.md § Presence, "What is counted"). At 100k viewers that shows 200k.
  - Fix options (engine or protocol): count viewers per (user, client-prefix), or have viewers open one connection.
  - Writers count once (users).
- **The writer cap hits at the fifth tab,** not the ninth: 2 connections per tab, against 8 writer connections per (user, board) per gateway.
- **`collab.layout()` runs on every view or board change** (pin re-placement, O(threads) per frame while panning or with incoming ops). Fine for tens of threads; for thousands, cull pins to the viewport.
- **The comments drawer** is the collab UI's own node inside the page drawer, with its own header hidden by CSS. The page's notes tab is unchanged (`editNote` and `deleteNote` aren't offered on the port), so notes rows there still say "You" or "—" rather than names.
- **`limited`** is a new status name (web/core/sync.js and the session). Anything else switching on status (e.g. drawh) won't know it.

## Round 2 (p7-wire2: fix round for p7-wirev)

**Done.** The writer cap now retries on rule 12's backoff, as PROTOCOL.md § Pacing says, and the verifier's 12 untested mutants now have tests. LOW-1 and LOW-2 are fixed; LOW-3 is left as decided.

- **Tests:** `bun test test/web` passes (614). Full `bun test`: see the end of this section.
- **Mutations:** 21 of 21 mutants killed, each run against the whole `test/web`.
- **Headless Chrome, production rig:** the same user opened 5 tabs. Tab 5 was capped, showing only the cap banner and the cap tooltip. 817 ms after tab 1 closed, tab 5 was live, with no click.

Applied the systems design skill (APPLIER, chapter 4 rate limiting and chapter 12 reconnects): a refused connection is one failed attempt on the existing backoff. There is no second timer, no floor and no queue, so a capped tab settles at one try per 15–30 s, which is far from a loop.

### Changes

| File | Change |
|---|---|
| `web/core/sync.js` | **The cap retries.** The id-less `limit` before welcome counts as a failed attempt (`replica.connectionFailed()`) and goes down on the Replica's own backoff (`reconnectWait()`); its close is then ignored (`down`). `limited` stays set through every retry until a welcome clears it, so the status stays `limited`, never "connecting", during retries. `nextTryAt` gives the armed retry's time. `reconnect()` (Retry) still tries at once. Removed: the `pump` early return, and the `limited` guards on `onMessage` and `onDrop`. |
| `web/core/session.js` | `limitedNextTry`: the earliest armed retry of the two connections. |
| `web/core/roles.js` | **New:** `connectionBanner()` (pure; at most one connection banner; a capped tab gets only the cap's, with "Trying again in N s") and `pillTitleFor()` (the cap's text wins over the viewer's "no live connection"). The pill's sub-text for the cap is now "close one: retrying by itself". |
| `web/adapters/dom/app.js` | Banners and the pill tooltip come from those two (LOW-1). The countdown is part of the chrome key, so it refreshes each second. Per-frame collab work moved to `./collab/frame.js`. |
| `web/adapters/dom/collab/frame.js` | **New:** `collabFrame(S, collab)`. Each frame it sends my selection when it changed (whatever changed it) and re-lays pins when the view or board changed. Testable without a DOM. |
| `web/adapters/dom/collab/ui.js` | `destroy()` calls `port.destroy?.()` (LOW-2). |
| `web/adapters/collab/sync.js` | `destroy()` also drops every subscriber, so a records frame queued before it runs with no one listening. |
| `web/ports/collab.js` | Optional `destroy?()` documented. |
| `test/web/collab/wire2.test.js` | **New:** 16 tests (below). |
| `test/web/collab/wire.test.js` | The old "no reconnect loop, wait for Retry" cap test is removed (superseded). |

### Tests and mutants (each test fails under its mutant; whole `test/web` run per mutant; all 21 killed)

| Mutant | Killed by (`wire2.test.js` unless noted) |
|---|---|
| **V1** `record()` dropped over the 16 KB presence gate | "records ops are never dropped by the presence gate" |
| **V2** id-less `limit` caught after welcome (a blob refusal) | "cap: an id-less limit AFTER welcome…never stops the tab" |
| **V3** `limit` with an id caught as the cap | "cap: an error with an id before any welcome…never trips the cap" (the guard is pinned even though a real op's answer can't come before its welcome); also "a limit WITH an id…onRefused says it" |
| **V4** `retrySetting` before `ready` | "stale-setting: no retry before ready; ready lands on the refused change whose key moved" |
| **V5** `ready` set on the wrong entry | same test: two refusals, and only the first one's key moves |
| **V6** selection not sent from the frame | "frame: my selection goes out whenever it changed…" |
| **V7** `layout()` not called from the frame | same |
| **V8** `congested` reads the board connection only | "congested: either connection's backlog shows on the pill…" |
| **V9** viewer pill drops "slow link" | same |
| **V10** `me.user` never updated from welcome | "me.user follows welcome.user (rule 13)…" |
| **V11** `notes()` read from the board connection | "notes() and noteAuthor come from the notes connection: my own unacked note shows at once" |
| **V12** `noteAuthor` asks the board connection first | same (the board copy is made to answer wrong) |
| **C1** the cap's refusal not counted as a failed attempt | "cap: the refusal itself is the failed attempt: a close that never comes (half-open)…" (without it, the retry waits for the 10 s watchdog) |
| **C2** `limited` not cleared on welcome | "cap: a slot frees: the next automatic try gets in…" |
| **C3** a retry shows "connecting" instead of `limited` | "cap: refused, the tab stays limited and tries again on the backoff, with no click" |
| **C4** `nextTryAt` not the armed time | same |
| **C5** a fixed fast retry instead of the backoff | same, and "cap: a tab that stays capped never tries more often than rule 12 allows" (waits 750, 1500, 3000, 6000 ms…, then 15–30 s; nothing early, exactly one try each) |
| **L1a** `limited` falls through to "Connecting…" | "LOW-1: limited shows only the cap banner…" |
| **L1b** the pill tooltip ignores the cap | same |
| **L2a** `mountCollab.destroy()` keeps the port | "LOW-2: mountCollab's destroy() calls port.destroy()…" |
| **L2b** subscribers kept after `port.destroy()` (a queued records frame fires) | same |

**Also tested, no mutant needed:**
- "cap: Retry still tries at once".
- "the session's limitedNextTry is the bind's armed retry", plus merged status `limited` (round 1).

**Equivalent, removed rather than tested:** a `destroyed` flag in the sync adapter. Dropping the subscribers already silences a queued frame (L2b covers it).

### Headless Chrome (production rig, port 0, real tree; Chrome PID recorded and killed; rig stopped)

**Setup:** `test/server/rig.js` with dev token `editor`, so all 5 tabs are the same user. Tabs 1–4 live: 8 writer connections.

**Tab 5 while capped:**
- Status `limited`.
- One banner only: "⚠ This board is open in too many of your tabs (at most 8 open writer connections per user on a board). Close one; this tab gets in by itself. Trying again now. [Retry now]". No "Connecting…".
- Pill: "Too many tabs".
- Tooltip: "This board is open in too many of your tabs. Close one: this tab tries again by itself (or press Retry)."
- Screenshot: `cap-t5-limited.png`.

**After closing tab 1** (`Target.closeTarget`):
- Tab 5 went live 817 ms later, with no click: notes first, then board.
- Banners gone, pill "Live", `limited` null.
- Screenshot: `cap-t5-live.png`.

**Errors:** no console errors, no failed requests.

**Not measured in that run:** the gap between hellos (asserted on the virtual clock instead). Screenshots are in the scratchpad's `p7/` folder.

**NOT verified:** a tab capped for minutes in a real browser (the 15–30 s settling is tested on the virtual clock only); a half-open socket on the real gateway; LOW-3 (left as decided).

**Full `bun test`:** 1159 pass, 1 fail: `test/core-source.test.js`, the known drift on main. Nothing new fails.

**Change after the Chrome run:** the pill's sub-text changed from "close one, then retry" (what the screenshot shows) to "close one: retrying by itself". Only `pillFor`'s string changed, and its test checks the pill's main text. Not re-run in Chrome.

## Round 3 (p7-wirev R2-M1: an `auth` refusal wins over the cap)

**Fixed.** Before, a capped tab whose automatic retry was refused `auth` kept the cap banner forever. Now it shows "refused" and the sign-in banner, and stops trying.

**Changes (`web/core/sync.js`):**
- **Check order:** `refreshStatus()` checks `replica.needAuth` before `limited`.
- **Getter:** `limited` reads null while `needAuth` is set, so nothing shows a stale cap (the session's `S.limited` and the banner text included).
- **`connect()` and `goDown()` checked, no change needed:**
  - An `auth` refusal never goes down: it sets no resync, and its close is ignored (`onDrop` returns on `needAuth`).
  - `reconnect()` (Retry or sign-in) clears `limited` before connecting.

**Test** (`test/web/collab/wire2.test.js`, virtual clock): "cap, then `auth` on the automatic retry: refused (not limited), the refused banner, and no more hellos".
- The tab is capped, its retry goes out at 750 ms, and the retry is refused `auth`.
- Then the status is `refused`, `limited` is null, no retry is armed, and `connectionBanner` gives the "refused this sign-in" banner.
- 10 virtual minutes later, still 2 hellos and still `refused`.

**Mutants** (each run against all of `test/web`):

| Mutant | Result |
|---|---|
| The old order (`limited` before `needAuth` in `refreshStatus`) | **Killed** by the test above |
| The `limited` getter shows the stale cap while refused | **Killed** by the same test |

**Also tried:** clearing `limited` when `auth` arrives, together with the new order. That made the old-order mutant equivalent (either change alone fixed it), so I kept the order as the single mechanism plus the masking getter. Both are now killable.

**Tests:** `bun test test/web` passes (615). Not re-run in Chrome (the change is in the status logic, and the virtual-clock test drives the real bind).
