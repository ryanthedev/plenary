# Report: p7-chrome (J2 of p7-audit: page chrome, link liveness, token expiry)

**Done: wheel panning and incoming ops no longer rebuild the chrome (0 rebuilds, down from 65 per part in headless Chrome).**

- **Resume:** the page reconnects on `online`, and after a hide of over 30 s unless the room spoke in the last 10 s. Both are jittered.
- **Sign-in:** a refused or expiring sign-in offers "Sign in again", which returns to the board.
- **Clocks:** the collab UI and the cap countdown run on the clock port.
- **t14k's add:** `jumpTo` honours `scale`.

- **Who:** worker plenary-p7-chrome, manager t14k. Not committed.
- **Tests:** `bun test` gives **1274 pass, 1 fail** (1412 tests; other jobs added tests meanwhile).
  - **The fail:** `test/core-source.test.js` ("packages/core is still herdr-draw's core") compares against herdr-draw's own repo, whose `editor.js` changed. Not from this job.
  - **Earlier run:** one run also had 3 failures in engine's in-flight server files, which pass now.
- **Commit order:** independent of p7-perf. My `ui-app.test.js` passes 10/10 both with p7-perf's ui.js (in the tree) and with HEAD's ui.js (run in a HEAD worktree with my four files copied in).

## What changed

| File | Change |
|---|---|
| web/adapters/dom/app.js | **C-2/C-8:** chrome split into parts with content keys. **In place:** zoom %, pill, timeline head/fill/time. **C-4:** `online` / visibility reconnect. **C-6:** clock port + `frame` to `mountCollab`. **C-9:** "Sign in again" link and expiry banner. **C-17:** countdown on `clock.now()`. **t14k:** `jumpTo({ x, y, scale? })`. The toast, click counter, blob revoke and first-fit now use the clock port or the frame loop: no `setTimeout`, `setInterval`, `performance.now` or `Date.now` is left. |
| web/core/roles.js | **Pure helpers:** `expiryNotice`, `EXPIRY_WARN_MS` (5 min), `shouldProbe`, `RESUME_PROBE_MS` (30 s), `rememberBoard` / `takeReturnBoard` (`RETURN_KEY`). **`connectionBanner`** takes `relogin` and says how many unsent edits leaving loses. |
| web/main.js | **Passes** `clock`, `expAt` (`signIn.exp` × 1000) and `relogin` (`/auth/login`; `go()` stores the board id in session storage, then `location.assign`). **The sign-in gate** remembers the board too (a reload after expiry). **On a fresh `signed-in` load** with no `?board=`, it takes the stored board once and puts it back in the address bar. |
| web/dev-main.js | **Passes** `clock`, `expAt` and `relogin: null` (the in-browser rooms know only dev tokens). |
| test/web/ui-app.test.js (new) | **10 tests** on the real `mountApp`: a stub DOM over `localRoom` and its virtual clock. It restores its globals in `afterAll`. |

### C-2 / C-8: when the chrome rebuilds

- **Two triggers.**
  - **`chromeDirty`:** a local action (click, key, tool, resize, a session event). Every part rebuilds, as before.
  - **Part keys:** each of the nine parts (topbar, panel, drawer, timeline, hud, overlays, dock, sheet, dialogs) has a key built from what it shows. A part rebuilds only when its key changes.
- **When keys are checked:** at most every 250 ms, and only when something moved (`S.version()`, the connection, a countdown, playback).
- **Wheel and ctrl-wheel** no longer set `chromeDirty`.
- **No scans per frame.** Keys read memos computed once per `Doc.rev`, the Doc's change counter: it bumps on every applied change, local or the room's, and never on a pan. The memos hold:
  - the notes count and rows (sorted once; labels come from a map, not `labelOf` per row)
  - the frames, animation marks, duration, and element counts per layer
- **Updated in place each frame** (text and style compares, never rebuilt):
  - the zoom %
  - the pill (pending edits no longer rebuild the topbar)
  - the timeline's head, fill and time while playing (the old loop rebuilt the timeline every playing frame)
- **Panel key:** exactly what `renderPanel` reads: `propsModel`, selection sizes, the animation preset, frames, `frameAt`, play, layers with their counts, and the active layer.
  - **Why it matters:** style chips and Undo don't mark the chrome dirty, but their result still shows.
- **Counters:** `plenary.ui.rebuilds` counts rebuilds per part.

### C-4 (page side): reconnect on resume

- **The lever:** the session handle offers only `reconnect()`, which skips the backoff and keeps pending ops. The hello carries `since: replica.applied` (replica.js:92), so a reconnect costs a catch-up, not a snapshot.
- **`online`:** reconnects after a jitter of `clock.random()` × 2 s.
- **Visible after a hide of over 30 s:** measured on mono *or* wall time, because mono may stop during a laptop's sleep.
  - **Skip:** when any room event (presence, `here`, emotes, records) arrived within the last 10 s. That link is alive.
  - **Otherwise:** reconnect after the same jitter.
- **Never:** while refused or stopped (the same token or app is refused again), while capped (it would defeat the cap's backoff), or mid-gesture (`shouldProbe`).
- **Left for J3:** the idle-link watchdog in sync.js, which needs engine's heartbeat (E-1).

### C-6: the clock port to the collab UI

- **What app.js passes:** the root's clock port plus `frame: fn => requestAnimationFrame(fn)`.
- **Aliases for HEAD's ui.js:** the clock object also carries `setTimer`, `clearTimer` and `raf`, the old shape that HEAD's ui.js reads. p7-perf's ui.js detects the port and ignores them. Drop them after p7-perf is committed.

### C-9: token expiry

- **Refused banner:** shows a "Sign in again" link (`href="/auth/login"`) next to Retry.
  - **Click:** stores the board id in session storage (`plenary.return`), then leaves.
  - **Modified click (new tab):** left to the browser.
  - **Unsent edits:** the text says how many are lost on leaving.
- **Expiry warning:** from 5 min before `exp` it reads "ends in N min", with the link. After that it reads "has ended" until the link drops. It isn't shown alongside the refused banner.
- **Why the page stores the board:** the server's `/auth/login` has no return parameter. Its targets come from config only, so there is no open redirect (server/auth/http.js:58), and it always lands on `/`.
  - **On the way back:** main.js takes the stored board once, only after a fresh `signed-in`, only with no board in the URL, and only if it matches the board-id regex.
- **The token** never enters app.js, a URL or localStorage. page-signin.test.js's source scan still passes, and `mountApp`'s return keys are unchanged.

### t14k's add: `jumpTo({ x, y, scale? })`

- **What it does:** an optional `scale` is clamped to the page's zoom limits, 0.1–8 (now named constants shared with wheel and pinch). The centre is worked out at the new scale.
- **Bad input:** a missing, NaN or ≤ 0 scale keeps the current scale.
- **JSDoc:** updated.
- **Test:** the "jumpTo" case in ui-app.test.js.

## Tests and evidence

**Unit tests:** test/web/ui-app.test.js, 10 tests on the real app.js.

| Test | Shows |
|---|---|
| C-2/C-8 | **No rebuilds:** 60 wheel frames, 5 ctrl-wheel frames and 100 incoming ops leave `replaceChildren` on topbar, panel, drawer and timeline at **0**. **No scans:** `frames()` is called 0 times while panning. **Zoom %:** the same node, and current. **Real changes still land:** an incoming note (topbar +1, "Notes 1"; drawer +1), an animation mark (timeline +1), a new shape (panel +1). |
| C-2 local | A panel style chip and Undo, neither of which marks the chrome, still flip the chip's `on`. |
| Playback | ⇧Space rebuilds the timeline once (▶ to ❚❚). Then 10 frames: the head moves every frame, on the same node, with 0 more rebuilds. |
| C-4 | **`online`:** both links reconnect once, after the jitter (random 0.75: nothing at 1.4 s, done by 1.6 s). **Hidden 10 s:** nothing. **Hidden 31 s:** both links reconnect. **Hidden 40 s, room heard 6 s earlier:** nothing. **Heard 11 s earlier:** reconnect. **`shouldProbe`:** refuses refused, stopped, limited and a gesture. |
| C-9 (3 tests) | **Refused:** a link to `/auth/login`, Retry kept; a click stores `b1` and prevents the default, a meta-click doesn't. **Expiry:** nothing at 6 min, "5 min" at 5, then "1 min", then "ended". **`takeReturnBoard`:** works once, only after `signed-in`, only with no board, never accepts a non-id, never throws. |
| C-17 | The countdown reads "12 s", then "7 s" after 5 virtual seconds. The virtual clock is near 0, far from `Date.now()`. |
| C-6 | The page with the collab UI mounts and runs 60 virtual seconds on the virtual clock. |
| jumpTo | **Centres** at the current scale, then at 2.5. **Shares** the view with the notes Editor. **Clamps** 50 to 8 and 0.001 to 0.1, and ignores NaN. **Zoom %** reads 10%. |

**Mutants:** 21, each applied to app.js or roles.js, then restored. All are killed now.

- **Two survived the first round:** "no `online` jitter" (M10) and "memo ignores nothing / no memo" (M13). I tightened the tests: the C-4 test now pins the jitter delay, and the pan asserts 0 `frames()` calls. Both are killed now.
- **The full list:**
  - **Rebuild triggers:** wheel sets `chromeDirty`; the topbar key is `S.version()`; every key check forced.
  - **Memos:** memo ignores `rev`; no memo at all.
  - **In-place updates:** zoom % rebuilt in the hud; no timeline in-place update.
  - **Panel:** key without `propsModel`.
  - **Reconnect:** no `online` probe; no visible probe; no jitter (×2); `shouldProbe` always true; no heard-recently check; heard window 60 s.
  - **Sign-in and countdown:** countdown on `Date.now()`; no relogin link; no expiry banner.
  - **`jumpTo`:** ignores scale; scale unclamped.

**Headless Chrome on the production rig** (test/server/rig.js on port 0, index.html + main.js + ws).

- **Board:** 300 shapes and 100 notes, signed in as an editor via a stored session.
- **Counting:** a MutationObserver on the containers, the same instrument for before and after.
- **Before:** a HEAD worktree at 422526c, whose app.js is unchanged since **001813a**. The worktree has since been removed.

| | Before (app.js @ 001813a) | After |
|---|---|---|
| 60 wheel-pan + 5 ctrl-wheel frames (topbar / panel / drawer / timeline / hud) | 130 / 65 / 65 / 65 / 65 | **0 / 0 / 0 / 0 / 0** (zoom % read 117%, current) |
| 100 incoming ops (a shape nudged); the page saw x=1099 | 20 / 10 / 10 / 10 / 10 | **0 / 0 / 0 / 0 / 0** |
| 1 incoming note | every part once | topbar 1 and drawer 1 ("Notes 101"); nothing else |

- **Reading the topbar counts:** one topbar rebuild shows as 2–3 mutation records, because the kept pill and avatar nodes move out first. `ui.rebuilds` says 1.
- **Banner paths in that Chrome:**
  - **Expiry:** a session expiring in 4 min read "⚠ Your sign-in ends in 4 min. Sign in again to stay connected.", with a link to `/auth/login`.
  - **Refused (a dead token):** the pill read "Refused · sign in again". The banner read "⚠ The room refused this sign-in (token or board). Sign in again to keep going.", with the link and Retry.
  - **Clicking the link:** went to `/auth/login` with `plenary.return` set to the board id. No token was in the URL or localStorage.
- **A reconnect on a healthy live link:** `S.reconnect()` went connecting, then live in 4 ms (board) and 17 ms (notes) on localhost. The pill and banner showed "Connecting…" for one frame (about 14 ms). On a real network that lasts about one round trip plus the catch-up.
- **Processes:** Chrome and the server ran from one script, and Chrome was killed by its own PID.

## Systems design skill (APPLIER, systems-design v0.1.0)

**Applied after coding, not before.** The brief asked for before. The pass changed the design: it added the heard-recently skip and jitter on visibility.

- **Phase 1, scope:** CLAUDE.md's NFRs, client side.
  - 100k viewers a board; viewers < 1 s; 100k joins in 2 min (~830/s); 60–120 fps; two links a tab today.
  - Features in scope: chrome cost, resume liveness, sign-in expiry.
- **Phase 2, estimate** (assumptions labelled):
  - **Chrome:** O(1) per frame (a few compares). A rebuild runs at most 4/s and costs O(≤ 200 rows), plus O(n) once per Doc revision. Before: 5 parts × every pan frame, each with O(notes) and O(board) scans (C-2).
  - **Resume, uncorrelated:** assume each of 100k viewers comes back from a hide of over 30 s once every 10 min. That is ~167 tabs/s × 2 links = **~330 hellos/s** (~40% of the 830/s join budget), ~670/s at a 2× peak. Each is a catch-up, plus the gateway's token verify and role lookup.
  - **Resume, correlated** (a whole all-hands switches back at once, say within 5 s): 200k hellos over ~7 s with the 2 s jitter is **~29k/s, ~35× the budget.**
    - **Busy board:** the heard-recently skip removes it. Presence flows to every connection, and `here` comes every ≤ 5 s on big boards, so healthy tabs send nothing.
    - **Residual:** a *silent* board with a correlated return still herds. That needs E-1's heartbeat (then "heard" is always true for a live link) and J3's probe.
  - **`online`:** per-network events, so correlated only for one office's network. The jitter spreads it; one office (≤ thousands of tabs) is within budget.
- **Phase 3, high-level:** page, then session handle, then two links, then gateway. No new component. The page decides *when* to resync and the session decides *how*. Use cases walked: wheel pan, incoming ops, laptop wake, network switch, token death.
- **Phase 4, deep dives:**
  - **Ch12 (heartbeat, presence):** I use the room's own downstream traffic as a liveness signal; a 10 s window avoids flapping. A tradeoff: a dead link that delivered its last message less than 10 s before the tab came back is not probed. Only J3's watchdog fixes that.
  - **Ch1/techniques (reconnection storm, jitter):** jitter on both triggers, capped at 2 s so a real dead link is still found well within a viewer's patience. Never probed while capped or refused, so the gateway's limits hold.
  - **Caching (techniques: invalidation):** the per-revision memos are invalidated by the Doc's own counter. No stale reads, because `rev` bumps on every applied change.
- **Phase 5, wrap-up:**
  - **Top bottlenecks left:** (1) a correlated return on a silent board (E-1 + J3); (2) two links a tab double every hello (C-3, J3); (3) the comment pins' per-frame cost (C-1, p7-perf).
  - **Failure walked:** a token expires mid-meeting. The warning shows at 5 min; at expiry the link keeps working until the next reconnect; then the refused banner offers sign-in, which returns to the board.
  - **Monitoring:** `ui.rebuilds` exists for tests only. A metrics port (C-11, J5) should export rebuilds and reconnects.
  - **At 10×:** the correlated-return herd dominates, so E-1 is a must.

## What I did NOT check

- **The return trip after a real Google sign-in.** The rig has no OIDC, so `takeReturnBoard` in main.js is unit-tested only. The stash being written was checked in Chrome.
- **Real `online` and `visibilitychange` events in a browser.** Only stubbed; no real laptop sleep or Wi-Fi switch.
- **Phone layout and the sheet.** The sheet's key has no test of its own.
- **The C-6 test is weak.** It would also pass with HEAD's ui.js falling back to real timers. p7-perf's tests own the ui.js side.
- **Playback in a real browser.** Unit-tested only.
- **dev-main.js** is only build-checked (`bun build`); no browser run.

## Risks

- **A part key that misses something it shows** leaves that part stale until the next local action. The panel key mirrors `renderPanel` today; a new panel section must extend `panelKey`.
- **Expiry uses the browser's wall clock against the server's `exp`.** Clock skew shows the warning early or late. The banner can't be dismissed.
- **A reconnect on a healthy link** flashes "Connecting…" for one round trip. With the heard-recently skip this happens mostly on quiet boards.
- **Correlated resume on a silent board:** see Phase 2 (E-1 + J3).

## Round 2 (after p7-chromev FAILed on tests only)

- **(1) Verifier's tests added:** docs/m2/reports/p7-chromev.tests.js.txt is appended unchanged to test/web/ui-app.test.js (V1–V10, K1–K6; read before running). The file now has **27 tests, green in 5 of 5 runs** (`bun test test/web/ui-app.test.js` ×5: 27 pass, 0 fail each time).
- **(2) LOW-1:** p7-perf is committed (b1d0b6e), so the dead `setTimer` / `clearTimer` / `raf` aliases are gone. app.js passes the root's `clock` straight to `mountCollab` (with `frame`). No app.js code changed beyond that.
- **Full `bun test`:** **1318 pass, 3 fail** (1469 tests, 76 files). None of the failures are in this job's files:
  - `test/core-source.test.js`: herdr-draw drift, as in round 1.
  - `test/server/room-host-lease.test.js` "MEDIUM-3 (repro F)…" and `test/server/gateway.test.js` "the entries subject carries each entry once…": these test server/room-host.js, server/store/* and server/bus/port.js, which other sessions are changing now (uncommitted in the tree). Neither imports web/.
