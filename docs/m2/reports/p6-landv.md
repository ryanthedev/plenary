**PASS** for the client work: no HIGH against this job's code, and all five earlier findings are closed (p6-sync2v H1, M1, M2; p6-uiv M1, L2). **One MEDIUM for the manager to call (M1): Chrome's on-disk History keeps the full `#token=` URL.** The client can't prevent that; the fix is on the platform side. The brief's HIGH list names "storage", so whether this blocks the merge is your call.

# Verifier report: p6-landv (client half of the p2-land landing)

## Head verified

- **First pass at p2-land 2c53a90,** plus the uncommitted client files. This covered every check below.
- **Second pass at 5d55112.** Engine committed protocol v1.1 (cb343b9, 5d55112) under the worktree while I worked.
  - I re-ran everything except codex and the mutation runs. Same results.
  - The client files were byte-identical at both heads. sha256 was checked at the start and again as the last
    step, after every run (list in scratch `untracked.sha`).
- **Other files in the worktree:** p7-collab's untracked files (web/collab/, test/web/collab/,
  docs/m2/reports/p7-collab.md) appeared during my run. They are not part of this job, and I did not review them.
- **What I touched:** nothing in the worktree. The browser served it read-only. Every mutation ran in a scratch copy.

## HIGH

None.

## MEDIUM

- **M1 (platform's design; escalated). Chrome's History database keeps the post-login URL, token included.**
  - **Measured:** I copied each headless profile's `Default/History` and queried its `urls` table with sqlite3. The
    two profiles that ran the token checks hold 7 `…/index.html?…#token=s1.<payload>.<mac>` rows each. That
    includes the valid-shaped token, written to disk.
  - **Why the client can't fix it:** `history.replaceState` (web/ui/token.js:30) replaces the tab's session-history
    entry. The visit was recorded when the navigation happened, before any page script ran.
  - **Exposure:** the token persists on disk until it expires or the history is cleared. With Chrome Sync it may
    also reach the user's Google account (not checked). That is longer-lived than the sessionStorage copy the brief
    allows.
  - **Fix (platform p5-http):** don't put a bearer token in any URL. For example, redirect with a one-time code
    that the page swaps for the token (POST, single use, seconds to live), or send it as an HttpOnly cookie for the
    gateway. The client change would then be small: token.js reads `#code=` instead.
  - **Not HIGH against this job:** the builder followed the brief's design exactly and cleared the hash at once.
    It is still a token in storage, so the merge decision is the manager's.

## LOW

- **L1. After sign-in, the token stays in the first page load's navigation-timing entry.** Same root cause as M1.
  It is LOW because only same-origin page script can read it, and that script can already read the sessionStorage
  copy the brief allows.
  - `performance.getEntriesByType("navigation")[0].name` still holds the full `…#token=s1.…` URL.
    `history.replaceState` (web/ui/token.js:30) cannot clear that entry.
  - Any script on the page can read it until the next load. After a reload the entry is clean.
  - It is not storage, the address bar, the DOM or a log. I checked all four in headless Chrome, and they were clean.
  - Chrome's history database: see M1.
- **L2. The `?as=` dev path still stores a fragment token** (web/ui/token.js:42, web/app.js:28-32).
  - `index.html?as=cy#token=<valid>` signs in as dev cy, as the brief wants. It also saves the token to
    sessionStorage (`plenary.session`), even though this page never uses it.
  - This is harmless for a dev page, but it is not "keep it only for the hello".
- **L3. One guard has no test that depends on it:** localRoom's generation check (web/sync.js:354).
  - When I removed it, the full test/web suite and my race fuzz still passed.
  - It is redundant today, because `room.disconnect` marks the connection closed and the Room never sends to a
    closed one (packages/protocol/room.js:246, 317, 405, 426).
  - The test "contract: nothing of the old connection is delivered after reopen() (localRoom's generation)" passes
    because of the queue flush and `disconnect`, not because of `gen`.
  - The same goes for sync.js:174 ignoring messages while down: removing that check is not caught either (the
    Replica tolerates the messages).
  - **Not a defect.** It is belt and braces, but the test name claims more than the test checks.
- **L5. The unverified identity also reaches non-display code.** `me.user` from the token payload names a
  localStorage key (`plenary.mine.<board>.<user>`, web/app.js:45) and feeds `createSession({ user })`. There it
  gates only the UI's note lock (web/ui/session.js:117, the v1 `noteAuthor` seam). The room enforces note
  ownership, so this is the same class as p6-uiv L1.
- **L4. Cosmetic:** the offline banner reads "0 edits wait in this tab and send when you reconnect" when nothing is
  pending (web/app.js:420). This text predates this job.

**Seen, not this job's:** codex's full-suite run in its scratch copy got `EADDRINUSE` on port 0 in
test/auth/http.test.js. That is in the same file as the flaky wall-clock test the builder named. My own full runs
were green (321/0 at 2c53a90 twice, and 398/0 at 5d55112).

## The brief's checks

| # | Check | Result |
|---|---|---|
| 1 | `bun test`, and the strict gate and sweep vs f1886d5 | **Pass.** 321/0 at 2c53a90; 398/0 at 5d55112 (the count includes v1.1's and p7-collab's new tests). `git diff f1886d5 -- test/web/sync.test.js` changes only `setup()`'s clock wiring and the two timer tests (both accepted in p6-sync2v), plus `reopen: () => {}` on 5 stub transports. It adds 24 `test(` blocks, 2 of them the rewritten timer tests. **The gate's comparators are byte-identical to f1886d5:** `streamState`, `fullState` and `docDiff`, plus the handle's and localRoom's `state`, `full` and `diff`. **No assertion was removed or loosened**, and there is no `.skip`, `.only` or `.todo` in test/web. |
| 2 | H1 in a real browser | **Fixed.** Headless Chrome (CDP), three tabs of web/index.html `?as=ada\|bo\|cy&board=x` on the SharedWorker room (kind `shared`). Details below. |
| 3 | Transport contract | **Holds.** See the race fuzz, the backoff test and the mutation runs below. |
| 4 | Drafts and the downgrade | **Holds** in the browser, including the case the builder didn't cover. The downgrade toast was checked by test only (see NOT checked). |
| 5 | Sign-in token | **Holds**, apart from L1 and L2. |
| 6 | Engine's re-stamp fix (2c53a90), through sync.js | **Fixed.** p6-sync2v's D5a: **0 of 40 seeds lose** (was 2 of 40), and **0 of 200** ops on the contested shape went out at or below the room's version. The k repro (k = 1, 4, 5, 7; with and without a peer edit; 40 seeds each): **staleSent 0 and userFinalLost 0 in every row** (was 24/40 at k=4 and 40/40 at k≥5). Same at 5d55112. |

### 2. Browser runs

Each script ran at both heads. Each converge check means: every tab is live with pending 0, Editor == Replica
strictly (diff 0), and the same element ids and versions in every tab. No tab logged an error or warning.

| Step | What I did | Result |
|---|---|---|
| Refused op | `setAppState({ bogus })` on ada | ada is back to `live` (resets > 1). Her next drawing reaches bo and cy. |
| Drop | `S.dropConnection()` on bo | bo reconnects; his next drawing converges. |
| Repeated drops | Three drops on ada (two back to back, then one 50 ms later), then drawing while she was down | ada is back live and the drawing lands. |
| Drag across a drop | Drop mid-drag; release after the tab is live again | The shape lands in all tabs. |
| Retry | Clicked the offline banner's "Retry now" button on bo (front tab, network emulated offline); called `S.reconnect()` on cy | Both converge afterwards. |
| Retry while down (run4) | Clicked "Retry now" while bo was `connecting`: once right after a refused op, once during a drop's backoff | Both times bo went back to live (pill "Live"), and the next drawing converged. |
| dev.html resync (run4) | A refused op on pane 0 (`connecting`, resets 1 to 2), then a drawing | Both panes live, n 2, diff 0, pending 0. |
| Refused op on ada while bo drops | bo draws during it, then ada reloads | ada comes back with the same ids and versions as bo, so nothing acknowledged was lost. |
| `?net=local` | A refused op, then a drop mid-drag | Back live; the shape is in the in-page room (n 1, diff 0, pending 0). |
| web/dev.html | Drew in one pane | Both panes live, n 1, diff 0. |

### 3. Transport contract

- **Reading the code** (web/sync.js:17-31, 72-118, 191-195; web/ui/net.js:29-50; web/ui/room-host.js):
  - Only `handle.close()` calls `transport.close()`. The resync path only sets `down` and later calls `reopen()`.
  - The shared transport opens a fresh link id per connection. It deletes the old link's message and drop handlers
    before it joins the new link, so anything the host posted for the old link finds no handler in the tab.
  - `reopen` and `close` never fire `onDrop`. Only localRoom's `fail()` does, and it is synchronous on the current
    link.
- **Stale delivery after `reopen()`:** the evidence for the named races (a reply in flight, two reopens back to
  back, a drop during catch-up, a drop before welcome) is the construction above, plus the builder's
  one-scenario test (ui-land "shared transport"). That test does catch both net.js mutants.
  - **My fuzz cannot see stale delivery**, because the Replica tolerates it (see L3). It checks the end state only.
- **Race fuzz** (scratch `t/fuzz.test.js`): three sessions (ada and bo presenters, cy annotator) over the real
  room-host.js and net.js, behind queued fake MessagePorts, and the same again over localRoom.
  - **Random interleaving:** partial port deliveries (one message at a time, so replies are in flight during a
    reopen), room steps and virtual-clock jumps.
  - **Random actions:** draws, notes, refused ops, drops (single and back to back, before welcome, during catch-up
    and live), `reconnect()` (single and back to back), and text boxes committed while offline and dropped.
  - **Scale:** 60 seeds × 400 steps per transport. In total about 9,800 drops, 1,900 refusals and 1,800 drafts across
    a drop.
  - **End checks:** every tab live with pending 0 and blocked 0; Editor == Replica strictly; Replica == room on both
    streams; and every element any tab drew (counted per action), plus every draft text, is in the room.
  - **Result: 0 bad seeds** at both heads.
- **Is the fuzz strong enough?** I put old bugs back in a scratch copy.
  - **The fuzz caught:** resync calling `close()` (the old H1), drops ignored, and the backstop checking `online`
    (the old p6-uiv M1).
  - **The repo's test/web caught:** the stale shared-link handler, the stale drop handler, the hash not cleared, the
    token put in localStorage, `token=` twice accepted, and the drop backoff skipped (4 tests fail).
  - **Equivalent survivors:** see L3.
- **Backoff** (scratch `t/backoff.test.js`): a drop right after each connection catches up waits 750, 1550, 3000,
  6000, 12000, 22500 and 22500 ms (jitter at 0.5).
  - After 12 s up, the next drop waits 750 ms again, so the 10 s-up reset works.
  - A close that sync.js started never reaches `onDrop`, by code reading and by the builder's test.

### 4. Drafts (headless Chrome, real typing into the canvas text box via `Input.insertText`, Escape by key)

- **D1: the connection comes back while the box is still open.** The builder's test commits while down; this one
  doesn't.
  - ada typed "alpha". Then the network went offline and `S.dropConnection()` ran; the pill read "Offline".
  - She typed " beta", and the network came back. The tab went `live` with the box still open, holding
    "alpha beta".
  - She typed " gamma" and pressed Escape. **"alpha beta gamma" is in all three tabs.**
- **D2: committed while down.** "delta epsilon" was held (pending 1, blocked 0, pill "Offline") and landed
  everywhere once the tab was back online.
- **D3: annotator cy, notes stream.** "note-zeta" was typed across a drop and finished after the tab was live again:
  "note-zeta eta" landed everywhere.
- **Downgrade mid-typing (run4, forced with `S.roleSeen = "viewer"` as p6-uiv did):** I typed "secret-draft" for
  real, then forced the downgrade and pressed Escape.
  - **Result:** blocked 1, pending 0, and the text is in neither tab.
  - **The toast is in the DOM:** "Not sent: the room now gives you view-only access".

### 5. Sign-in token (headless Chrome)

- **A well-formed token,** `#token=s1.<payload>.<43 chars>&link=invalid`, with an HTML/script name in the payload:
  - **Clean:** the address bar has no hash and no token. The token is in no localStorage key, in neither
    `outerHTML` nor any attribute, in no console message of any level, in no resource URL, and not in
    `globalThis.plenary`'s keys. `history.length` is 1.
  - **Kept only in sessionStorage** (`plenary.session`), as the brief allows.
  - **The display name is text only:** the avatar shows "GR", and the hostile name reached the `title` attribute
    escaped. `__pwn` stayed unset, with no `<img>`.
  - **Other checks:** the share-link toast showed, and the room refused the token, as expected for the dev room.
    After a reload, everything above was still clean.
  - **The one exception** is the navigation entry (L1).
- **Hostile fragments,** each in a fresh tab:
  - **The fragments:** huge (> 8192), `token=` twice, `token=` plus a bad second one,
    `<script>`/`<img onerror>` in token and link, and NUL, newline and quote characters.
  - **Result for every one:** the hash was cleared, nothing was stored, nothing reached the HTML, `__pwn` was unset,
    0 `<img>`, 1 script, no console output, and the tab went live as dev ada (or bo with `?as=bo`).
- **`?as=` dev path:** `?as=cy` together with a valid fragment token signs in as dev cy and goes live (L2 for the
  stored copy).
- **Code** (web/ui/token.js):
  - `replaceState` runs before parsing, whatever the fragment held.
  - Tokens are checked against the server's shape (server/auth/session.js:24-26: `s1.<b64url>.<b64url HMAC>`), and
    the stored copy is checked again when read back.
  - `tokenIdentity` returns only short, control-free strings.

### sdd

- **Single harness:** codex (effort high), on the diff in a scratch git copy at 2c53a90 with the builder's report
  removed. Quota beforehand: 5% of the 5-hour window and 7% of the weekly window.
- **Verdict: no actionable defects; "## Findings: None."** It ran 94 targeted tests, all green.
- It did not find L1 to L4. Nothing to confirm or refute.

## NOT checked

- **Stopped early at the manager's request** (about 20 minutes left):
  - A direct stale-delivery oracle in the fuzz (record closed link ids, fail on any handler call for one).
  - A "`reconnect()` several times, then one `fail()` waits only the first backoff step" check. The "a close sync.js
    started never counts" claim rests on code reading (net.js:34, sync.js:348-368) and the builder's tests.

- **No real server:** no real WebSocket, gateway or server; no Herdr/QuickJS.
- **SharedWorker crash:** nothing reports a drop if the worker itself dies, and I did not try killing it.
- **`stopped` in a browser:** no in-browser room can produce it. Unit test and code reading only.
- **The read-only banner after the forced downgrade:** run4's check for "Read-only" in the page text came back false
  while the toast showed. I didn't look into why (it may show only one banner or toast at a time). The p6-uiv
  report saw it.
- **Sign in again after `refused`:** the page has no UI for it. Retry still reconnects with the same token.
- **Chrome Sync** carrying the History rows of M1 off the machine.
- **Real input:** only synthetic CDP events and editor-API gestures, no physical mouse or keyboard. Real typing
  was used only for the drafts.
- **Not reviewed:** p7-collab's new files, and protocol v1.1 itself (engine's). I only re-ran my checks on top of
  it.
- **Mutation runs:** only at 2c53a90.
- **Pre-existing, not this job's:** room-host.js (like the old room-worker.js) never closes a closed tab's links, so
  ghost connections stay in the dev room until the worker exits.

## Scratch

`/private/tmp/claude-501/-Users-r-repos-plenary-p2/04300bea-cb52-4111-b3e4-d6aaafb0b3a4/scratchpad/`:

- `hist/`: copies of the profiles' History databases for M1.
- `br/`: the CDP browser driver and runs, plus `run4.js` (downgrade, Retry while down, dev.html resync). `run1.js` is resync, drops and Retry; `run2.js` is drafts with real typing
  and the pills; `run3.js` is the token, `?net=local` and dev.html. The `*-v11.json` files are the 5d55112 results.
- `t/fuzz.test.js` (the race fuzz), `t/backoff.test.js`, and `t/mutate.js` and `t/mutate2.js` (the mutation runs).
- `d5/d5a.test.js` and `d5/k.test.js`: p6-sync2v's repros, plus a stale-version count. Run them with
  `PLENARY_ROOT=<worktree>`.
- `repo/`: codex's copy. `mut1/`: the mutation copy.

**Processes:** I started Chrome eight times (PIDs 9921, 37113, 60696, 86846, 22055, 24684, 26189 and 77649). Each was
killed by its own script and confirmed gone. The static servers ran in-process on port 0. I killed nothing by
pattern.
