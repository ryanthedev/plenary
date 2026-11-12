**PASS** (no HIGH). 2 MEDIUM, 3 LOW. One MEDIUM needs a decision from the manager or engine: the writer cap never retries on its own, but PROTOCOL.md says it must.

# Report: p7-wirev (verify collab over sync, mounted in both roots)

Verifier: plenary-p7-wirev (t1gw). Manager: t14k. Read only; nothing committed. I checked the job's diff (`git diff web test/web` plus the 5 new files) on main at 050ef13, then at 1d73436, an auth commit that touches nothing in web/.

## Summary

| Check | Result |
|---|---|
| `bun test test/web` | 598 pass, 0 fail |
| Full `bun test` | 1142 pass, 1 fail: `test/core-source.test.js`, the drift already known on main. The builder's other 8 failures (gateway, tune) are gone now that those tracks have moved on. |
| Must-close items (M1–M4, count-only `here`, `stale-setting`, writer cap, congestion on the pill) | Closed in the code and in the browser. The writer cap is closed as the brief worded it, but it deviates from PROTOCOL.md (MEDIUM-1). |
| Contract | I read the contract, the rig and the runner. The same 13 tests run on the fake and on the sync adapter (26 pass), with no per-adapter branch or skip. The sync rig drives 2 real sessions on `local.js`; its `here()` and `emotes()` inject raw gateway messages, which is right for an adapter test. `local.js`'s new `here`/`emotes` stand-in mirrors the gateway, including counting viewer connections. No test/web assertion was weakened (see below). |
| Presence rules | The presence gate covers cursors, selections, laser, emotes and previews. Records and element ops never go through it. My own second connection is filtered. Role is never null once seen. All checked by reading the code and in the browser; part of it is untested (MEDIUM-2). |
| Boundaries and serving | The architecture test still bites (4 import mutants, all caught). The production page has no 404 except favicon, collab runs over `/ws`, and the token appears only in `hello`. |
| Headless Chrome | Dev page with 3 tabs; production page with 3 tabs, then 5 tabs. Every feature works, and so does every break attempt in the brief: drop mid-thread, refused op + resync, role change, burst. Details are below. |
| sdd ensemble | codex (high) and grok passed `check_adapter`; agy is out of quota (429, resets in 54 h); kimi is not logged in. The one finding both agreed on is refuted as HIGH and rated LOW (LOW-2). |

## Findings

### HIGH

None.

### MEDIUM

**MEDIUM-1. The writer-cap `limit` never retries on its own, but PROTOCOL.md says it must** (`web/core/sync.js:114`, `:181`; PROTOCOL.md § Pacing, lines 221–229, in HEAD).

- **What PROTOCOL.md says:** the client "retries with backoff (rule 12; it counts as a failed attempt)". It also guarantees: "an honest user with ≤ 8 live tabs is never kept out longer than about 30 s plus backoff".
- **What the code does:** once limited, `pump()` returns early and `onDrop` is ignored. Only the Retry button (`reconnect()`) tries again.
- **Seen in the browser** (production rig, 5 tabs as `dev:editor`):
  - Tab 5 was `limited` on both connections.
  - I closed tab 1, which freed 2 slots, and waited 40 s.
  - Tab 5 sent 0 new hellos and stayed limited. Retry then made it live at once.
- **Why it matters:** a tab refused because of a half-open socket, or because the user closed a different tab, waits forever for a click. That breaks the protocol's 30 s guarantee. Each tab also counts twice (see the design check), so this hits at the 5th tab.
- **Why it isn't HIGH:** the brief asked for "no retry loop, shown to the user", and that is what was built. The brief and PROTOCOL.md disagree.
- **Decision needed (manager or engine):** either retry on the rule-12 backoff while still showing the banner (the protocol's wording), or change PROTOCOL.md to "wait for the user". A slow backoff (for example ≥ 30 s) would still avoid a loop.

**MEDIUM-2. Several of the job's own rules have no test that fails when they break** (the builder's report says "each new rule fails under a mutation").

- **How I checked:** I ran my own mutants on an isolated copy, each against all of `bun test test/web`. 28 ran; 1 more was skipped because its anchor didn't match. 9 were killed. Of the 19 survivors, 6 are equivalent today and 1 is probably equivalent (listed below). These 12 survived and are not equivalent (11 rows; the last row is 2 mutants):

| Mutant (file:line) | What breaks, untested |
|---|---|
| `record()` dropped when the backlog is over 16 KB (`web/core/sync.js:294`) | **Real records ops dropped by the presence gate** (a HIGH-class rule in this brief). The code is right today; only element commits are tested against the gate (`test/web/sync.test.js:946`). |
| Limit caught after welcome (`!replica.welcomed` removed, `sync.js:181`) | An id-less `limit` for a `blob` request (PROTOCOL.md:770) would then stop the tab as "Too many tabs". |
| Limit caught with an `id` (`msg.id === undefined` removed, `sync.js:181`) | A rule-5 `limit` refusal of one records op would stop the tab. |
| `retrySetting` before `ready` (`sync.js:314`) | A retry would be built on the old base and refused again. |
| `ready` set on the wrong entry (`sync.js`, the `retryReady` loop) | Only one refused setting is ever tested. |
| `sendSelection()` removed from the frame loop (`web/adapters/dom/app.js:514`) | Escape or a tool switch no longer clears my selection on peers (ghost selection). Verified only in the browser. |
| `collab.layout()` removed (`app.js:516`) | Pins stop following pan and zoom. |
| `congested` reads the board connection only (`web/core/session.js`) | A slow notes connection is not shown on the pill. |
| Viewer pill drops "slow link" (`web/core/roles.js`) | |
| `me.user` never updated from welcome (`web/adapters/collab/sync.js:44`) | Rule 13 (another user signs in on this client) would leave the wrong `me.user`. |
| `notes()` and `noteAuthor` read from the board connection (`collab/sync.js:97–98`) | The header's claim that the notes connection shows my own unacked notes is untested. |

- **Equivalent today (no test needed):** port role without the `lastRole` fallback (checked in the code: `Replica` sets `role` only in its constructor and at welcome); `onLeave` from my own client (it deletes a peer that doesn't exist); records cache with no rev check (`recordsSoon` and `record()` clear it anyway); count-only viewers set to 0, in the model and in the port (2 mutants; PROTOCOL.md's shape always carries `viewers`: read in the spec and seen in real gateway frames, not proven for every gateway path); `stale-setting` added to the records-refusal list (read in the spec, not verified: records ops are never refused with it).
- **Probably equivalent (not verified):** settings refusals on the notes connection skipped. My reading is that settings ride the board stream, but I didn't confirm it.
- **The builder's own 29 mutants:** not re-run (their script is in the builder's scratchpad). Mine overlap theirs on the presence gate, count-only `here`, the writer cap, the phone "+N" and the echo filter, and those agree with their results.
- **Fix:** about 6 small tests. The first two rows matter most.

### LOW

- **LOW-1. A capped tab shows contradictory text** (`web/adapters/dom/app.js:454`, `:456`, `:289`, `:293`).
  - **Banners:** both "⟳ Connecting… the live view is paused." and the "too many of your tabs" banner show.
  - **Why:** `limited` is not `live`, so the Connecting branch fires too.
  - **Pill tooltip:** it says "No live connection…". The limited text at `:293` can never show for the cap: before any welcome, `S.effective` is viewer, so `:289` returns first.
  - Seen in the browser (screenshot `cap-t5.png`).
- **LOW-2. `port.destroy()` is never called** (codex and grok agreed; `web/adapters/dom/collab/ui.js:334`, `web/adapters/collab/sync.js:54`, `:100`).
  - **The bug:** `mountCollab`'s `destroy()` doesn't release the port. A records frame already queued fires even after `port.destroy()`.
  - **Confirmed, but LOW:** neither root ever unmounts the app, so nothing leaks in practice today. It would matter for a future remount (board switch without reload).
- **LOW-3. Rapid emote clicks are dropped silently.** Of 30 quick clicks, 1 got through (4/s pacing). This is p7-collabv's known LOW, unchanged.

### grok findings refuted

- **"records() may be stale before the frame":** wrong. `recordsSoon` sets `cache = null` synchronously (`collab/sync.js:51`), and `record()` bumps it too.
- **"refusedSettings has no consumer":** wrong. The session and the app banners consume it (`app.js:458`), not the port, and that works in the browser (the builder's run). `S.retrySetting` is wired.
- **grok 4–6 (here edge cases, `me` race, contract vs real):** no concrete failure. The count-only `here` and the explicit `[]` paths are both killed by mutants.

## Tests weakened?

`git diff test/web` shows two changes:

- **architecture.test.js:** `web/adapters/collab/` is no longer a dev path, with a stated reason (sync.js is production). `*/fake.js` is still dev, and the test now also requires sync.js and `dom/collab/ui.js` in the production graph. It still bites:
  - main.js importing `collab/fake.js`: caught.
  - main.js importing `web/collab/dev.js`: caught.
  - `collab/sync.js` importing `transport/local.js`: 3 tests fail.
  - `collab/sync.js` importing packages/protocol: caught.
- **page-signin.test.js:** the exact list of `mountApp`'s return keys grows by `collab`, `port`, `startComment`. It still checks that no token or sign-in data is exposed.

Nothing was deleted.

## Headless Chrome (headless Chrome over raw CDP; debug port 0; harness PID 85301 and Chrome PID 85309, both killed by PID)

**Dev page** (`web/dev-main.html?net=shared`, one SharedWorker room; ada owner, cy annotator, ed viewer):

- **Presence:**
  - Ada's rectangle, drawn with the real mouse: her cursor and her 1-id selection showed on cy, and her cursor on ed.
  - Laser: ada's laser reached cy (on production, the trail's points `pts` were checked).
  - Emotes: the viewer's 😂 was counted on all 3 tabs; ada's 👏 floated.
  - Pills: Live, Live, View only.
- **Records:**
  - Thread from cy: on all 3 tabs, pending 0.
  - Ada's 👍: seen by cy.
  - Viewer's react: refused and toasted "Not saved".
  - A bad anchor (no x, y) came back through `onRefused` as `bad-op` with the room's message.
- **Ghost selection:** Escape on ada cleared her selection on cy within 1.2 s.
- **Drop mid-thread:**
  - On drop, cy's status went to `connecting`, its role stayed `annotator`, and the peer cursors were cleared.
  - A reply and a 🎉 made while down showed as pending 2. After the resume: pending 0, and ada saw both.
- **Burst:** 40 react/unreact toggles end in the starting state, so this check could not fail. I reran it on production with 41 toggles: ❤️ by the owner on both tabs, pending 0.
- **Background tabs:** pins and the drawer update on `requestAnimationFrame` (M4 coalescing), so a hidden tab shows them when it comes to the front. This is by design.
- **Errors:** console errors none; failed requests only favicon.ico.

**Production page** (`index.html` through `test/server/rig.js`, port 0; owner, annotator, viewer):

- **Basics:**
  - All live over `ws://…/ws`, with avatars O and A.
  - Count-only `here` from the real gateway: the owner received `{t:'here', writerCount:2, viewers:2}` with no `writers`, and the avatar row kept "O E" while the count changed from 0 to 2 watching.
  - Double fan-out measured: while the owner moved a cursor, each of the viewer tab's 2 connections received all 10 presence frames.
  - Cursors across tabs: the viewer sees only the owner's, which is the viewers-see-presenters flag.
  - Thread acked everywhere; 🔥 counted everywhere.
- **Token:**
  - In the WebSocket frames: only in `hello`. The annotator's tab sent 5 hellos across 2 role changes, and no other frame carried it.
  - In HTTP URLs or headers: never.
  - Failed requests: only favicon.ico. Server warn or error lines: none.
- **Serving:** `adapters/collab/sync.js` and `collab.css` get 200. `collab/fake.js`, `transport/local.js`, `dev-main.html` and `collab/dev.js` get 404.
- **Role change mid-session** (`setGrant` plus a `grants` bus message):
  - The annotator was demoted to viewer. Status went `["connecting","annotator"] → ["live","viewer"]`, and `port.role` was never null.
  - As a viewer, cursors are not sent, a reply is refused (toast), and `startComment` is refused.
  - In front, the pill says "View only" with the read-only banner (screenshot `prod-demoted-ann.png`).
  - Restoring the role went back to annotator and "Live".
- **Refused op + resync:**
  - The editor was demoted silently (registry only, no `grants` message), then `reconnect()`. While the socket was down, it drew a rectangle and replied to a thread: pending 2, 1 of them records.
  - It came back as viewer. The rectangle op was refused `forbidden`, which forced a resync (`connecting → catching-up → live`), and the shape went away.
  - The reply was refused `forbidden`: `onRefused` fired once even though the room answered that id twice, and the toast said "Not saved: viewers can't write".
  - `port.role` was never null on the way. Final state: pending 0, "View only" with the read-only banner, console clean (screenshot `prod-refused-resync.png`).
- **Writer cap:** see MEDIUM-1. Tabs 1–4 live, tab 5 `limited`; 2 hellos, no loop; Retry works.

Screenshots and scripts are in the scratchpad: `/private/tmp/claude-501/-Users-r-repos-plenary/977b74b7-806b-4d84-85bd-59f341658b60/scratchpad/shots/` and `…/scratchpad/tools/` (`harness.js`, `cdp.js`, `dev2.js`, `dev3.js`, `prod1.js`, `prod3.js`, `prod4.js`, `prod5.js`, `cap.js`, `mut.py`).

## Design check (CHECKER, distributed-systems-design: SKILL.md § 3 and chapter 12 on presence)

| Point | Verdict | Notes |
|---|---|---|
| **Board-only connection for presence and records** | ✓ sound | One Replica keeps records and the pending overlay consistent, and nothing is delivered twice. The echo filter covers both of my client ids; that rests on the killed `previews-mine` mutant (my note-drag run in the browser produced no previews at all, so it proved nothing). The cost is that the notes connection still receives every presence batch and throws it away (measured, next row). |
| **Two connections per tab: the double count** | ✗ **MEDIUM now, HIGH before M4** | Seen on both pages: one viewer tab shows "2 watching". (1) The number on screen is wrong by 2× (100k shows as 200k). (2) The writer cap hits at the 5th tab, and with MEDIUM-1 that tab stays stuck. (3) The worst part, for capacity: every viewer tab costs 2 sockets and 2 fan-outs of presence, `here` and `emotes`. At 100k viewers that is 200k sockets, and presence fan-out doubles (about 2M → 4M messages/s at 20 batches/s; the doubling is measured on the rig's single gateway, and the 100k figures are arithmetic). The fix belongs to engine or protocol (count per user and client prefix, or one connection per viewer), as the builder said. It is already with engine; not fixed here. |
| **Coalescing (M4) and the records rebuild cost** | ✓ for M4, ⚠ for scale | M4 is closed: one `onRecords` per frame, not one per entry (killed mutant), with `records()` cached per revision. But each frame with a change still costs a full `Replica.recordsState()` rebuild. At the builder's ~35 ms for 10k threads (I did not re-measure), a busy room keeps the main thread saturated at about 28 fps with no time left for drawing. An incremental `recordsState` in engine is the real fix. |
| **Pin layout per frame** | ⚠ LOW | `collab.layout()` re-places every pin on any view or version change, which is O(threads) DOM work per frame while panning. Fine for tens of threads, not for thousands. Culling to the viewport is the fix. |
| **Drop and resume** | ✓ | Following chapter 12 (heartbeat, not connect/disconnect toggling): on a drop, this client clears its own view of peers; others drop me after the 30 s expiry. Records stay pending, are resent with the same ids, and land once (seen in the browser). Role holds across the resync. |
| **Rate limiting (chapter 4: drop vs queue)** | ✓ | Presence passes, in order: live status, the role table, the backlog gate, then the limiter. Over the gate it is skipped, never queued; real ops are never gated (code read; the test gap is MEDIUM-2). |
| **10×** | ⚠ | The client has no cap of its own on peers. It relies on the gateway's cursor thinning (50 per board) and on `here` being count-only for viewers. The double count and the records rebuild (above) are the first walls. |

## What I did NOT check

- **Phone layout (M3) in a real browser:** no 390 px screenshot. It is tested in the fake DOM, and both phone mutants are killed.
- **Real mouse in background tabs:** cross-tab cursors were driven with the real mouse only on the tab in front; other tabs were driven through `collab.pointer`.
- **The records rebuild cost:** not re-measured (the ~35 ms at 10k threads is the builder's number).
- **The gateway's `here` pacing and thinning under load:** not checked.
- **Two refused settings at once:** not checked, and no test covers it (MEDIUM-2).
- **`stale-setting` from the real server:** checked only in the builder's dev run.
- **Ensemble size:** only codex and grok ran (agy out of quota, kimi not logged in).
- **Notes-stream previews:** my note drag in the browser produced no previews (the drag probably missed the note), so both note previews and the echo filter rest on the contract and the mutants.
- **Commenter chrome (not this job):** a commenter, who may comment, gets the viewer chrome and a "View only" pill. That comes from `uiRole` in `web/core/roles.js:15`, which predates this job and is unchanged by it. Worth a look by whoever owns the chrome.
- **The background-tab "Live" pill:** after a demotion, a tab in the background still showed "Live" until it was brought to the front. The chrome repaints on `requestAnimationFrame`, so this is expected; I confirmed the front-tab behaviour.

## Round 2

**PASS** (no HIGH). All of round 1's MEDIUM-1, MEDIUM-2, LOW-1 and LOW-2 are closed. One new MEDIUM came in with the fix (R2-M1): a one-line fix plus one test, best done before the commit.

I checked `git diff web test/web` against e4cba6c (round 1, now committed), plus `test/web/collab/wire2.test.js` and `web/adapters/dom/collab/frame.js`.

### Checks

| # | Check | Result |
|---|---|---|
| 1 | **MEDIUM-1:** the cap retries by itself | **Closed.** An id-less `limit` before welcome calls `replica.connectionFailed()` (`web/core/sync.js:186`) and goes down on the Replica's own backoff, with no extra floor.<br>In Chrome, a capped tab's tries were spaced about 0.6 s, 1 s, 5 s, 10 s, 17 s (rule 12, two connections).<br>Retry (`reconnect()`) still tries at once (mutant R killed).<br>A `limit` after welcome, or one with an `id`, is not the cap (V2, V3 killed). |
| 2 | **MEDIUM-2:** every one of my 12 mutants is killed | **Closed.** I re-ran all 12 myself on an isolated copy, each against all of `test/web`: **12 of 12 killed** (V1–V12).<br>I also wrote my own versions of the builder's new mutants: 12 of 13 killed. The survivor, C3a, is a transient status event; it is LOW-R2-1. |
| 3 | **LOW-1 and LOW-2** | **Closed.** In Chrome a capped tab shows one banner only ("…Close one; this tab gets in by itself. Trying again in N s. [Retry now]") and the cap tooltip. The countdown is correct (sampled every 0.6 s for 30 s).<br>`mountCollab.destroy()` calls `port.destroy()` (L2a killed). `port.destroy()` clears every subscriber, so a records frame queued before it does nothing (L2b killed). |
| 4 | **Serving** | Through the rig, `adapters/dom/collab/frame.js` and `adapters/collab/sync.js` get 200, and `adapters/collab/fake.js` gets 404. No 404 in the pages except favicon; no console errors. |
| 5 | **No `tab` in hello; no test weakened; boundaries** | Hello keys are exactly `t, v, token, board, since, client` (checked on the real frames in Chrome).<br>One test was removed from `wire.test.js`: the round-1 "no reconnect loop, wait for Retry" test. Its behaviour is now wrong by design, and `wire2.test.js`'s 5 cap tests replace it (including "never tries more often than rule 12 allows"), so the removal is justified.<br>The architecture test still bites: main.js importing `collab/fake.js` fails, `frame.js` importing `transport/local.js` fails 3 tests, and `frame.js` importing packages/protocol fails. |
| 6 | **Chrome, 5 tabs as one user** | Tab 5 stayed `limited` for 45 s (only `limited`, never "connecting"; 12 hellos across its 2 connections). I closed tab 1, and **tab 5 was live 16.8 s later with no click**. The builder saw 817 ms; the gap is just where tab 5 was in its backoff. Pill "Live", no banner. Screenshots: `r2-cap-limited.png`, `r2-cap-live.png`. |

Tests: `bun test test/web` gives 614 pass, 0 fail.

### MEDIUM

**R2-M1. A capped tab whose retry is refused for sign-in says "Too many tabs, gets in by itself" forever** (`web/core/sync.js:107–108`).

- **The cause:** `refreshStatus()` checks `limited` before `replica.needAuth`. `limited` is cleared only by a welcome.
- **How it happens:** a tab capped long enough for its token to expire (tokens last 1 h), or whose access is revoked meanwhile, gets `auth` on a retry. The Replica then stops retrying, which is correct (rule 12: never retry a refusal blindly). But the status stays `limited`, so:
  - the pill says "Too many tabs · close one: retrying by itself";
  - the banner says "this tab gets in by itself";
  - "The room refused this sign-in" never shows.
  The user is told to wait for something that will never happen.
- **Reproduced** in a scratch test on the virtual clock (deleted afterwards): capped, then the retry hello was answered `{t:'error', code:'auth'}`. Status stayed `limited`, 0 hellos in the next 10 minutes, and the cap banner was still there.
  - `version` is handled correctly: `stopped` comes first.
  - Pressing Retry does recover: `reconnect()` clears `limited`, and the user then sees "Refused".
- **Why it is new:** in round 1 a capped tab never retried, so it could not meet `auth` on its own.
- **Fix:** test `needAuth` before `limited` in `refreshStatus()` (or clear `limited` when `needAuth` is set), and add a test: capped, then `auth` on the retry, gives `refused`.

### LOW

- **LOW-R2-1. A Retry emits a brief `connecting`** (`web/core/sync.js:96`).
  - Mutating `connect()`'s `setStatus(limited ? "limited" : "connecting")` to always say `connecting` survives every test. `pump()`'s `refreshStatus()` sets `limited` again within the same call.
  - The only effect is one extra `onStatus` pair (`connecting`, then `limited`) per retry. That makes the collab UI clear presence and reset its outbox, which is harmless while capped because nothing is live.
  - Close to equivalent; no action needed.

### Mutants (my versions, each against all of `bun test test/web`)

- **My 12 from round 1:** V1–V12, killed 12 of 12.
- **The builder's cap and LOW mutants, my versions:** 12 of 13 killed.
  - Killed: C1 refusal not a failed attempt; C2 `limited` never cleared; C3b `goDown` shows connecting; C4 `nextTryAt` wrong; C5 fixed fast retry; C6 the round-1 never-retry; L1a banner falls through; L1b tooltip; L2a UI keeps the port; L2b subscribers kept; R Retry not immediate.
  - Survived: C3a (LOW-R2-1).
- **The builder's own mutation script:** not re-run; it lives in their scratchpad.

### What I did NOT check (round 2)

- **A tab capped for many minutes in Chrome:** watched for 45 s only. The 15–30 s plateau is tested on the virtual clock.
- **A half-open socket on the real gateway.**
- **R2-M1 in Chrome:** checked on the virtual clock only; it needs a token that expires mid-cap.
- **Ensemble:** no new sdd ensemble this round. The diff is small, and I read it all myself.

Processes: harness PIDs 57753 (Chrome 57757) and 62674 (Chrome 62677), each killed by PID; servers on port 0; the scratch test is deleted.

## Round 3

**PASS.** R2-M1 is closed, and nothing else changed since round 2.

| Check | Result |
|---|---|
| **Nothing else changed** | A `diff -ru` of web/ and test/web against my round-2 snapshot shows only two changes in `web/core/sync.js`: `refreshStatus()` checks `needAuth` before `limited` (`:108`), and the `limited` getter reads null while refused (`:283`). test/web gains one test at the end of `wire2.test.js`. Nothing else differs. |
| **My repro** (scratch test on the virtual clock, deleted afterwards) | The tab was capped 5 times on the backoff, then the next retry was answered `auth`. Status is `refused`, `limited` and `nextTryAt` are null, the pill says "Refused", and the banner is the sign-in one ("…refused this sign-in"). **No more hellos in 10 minutes.** |
| **Session level** (scratch) | Both connections were capped, then the board connection's retry was refused `auth` while notes was still capped. The merged status is `refused`, so the sign-in banner wins. |
| **Retry** | While refused, `reconnect("tk2")` sends one hello at once, with the new token. While capped, Retry still tries at once. |
| **Plain cap path** | Capped, then the retry is welcomed: `limited` is cleared and the status goes on to live. Every round-2 cap test still passes. |
| **Mutants** (my isolated copy, each against all of `bun test test/web` and my scratch tests) | Old order (`limited` before `needAuth`): **killed** (the new test, plus 2 of mine). Getter ignoring the refusal: **killed**. Both together: **killed**. |
| **Tests** | `bun test test/web`: 615 pass, 0 fail. |

Not checked in round 3: a browser run of the `auth`-after-cap path (it needs a token that expires mid-cap). The rest of the round-2 Chrome results are unaffected: the change touches only the order of status checks and one getter.
