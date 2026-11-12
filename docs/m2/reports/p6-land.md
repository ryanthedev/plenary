# Report: p6-land (the client half of the p2-land landing)

Worktree /Users/r/repos/plenary-p2, branch `p2-land` at **2c53a90** (engine's fix round 4 landed while I worked;
everything below was re-run on it). Not committed. **`bun test`: 321 pass, 0 fail** (292 at 794298e, + 7 from engine's
2c53a90 in test/replica.test.js, + 22 of mine). Repeated runs: see NOT verified (one unexplained failure early on).
`git diff --quiet -- packages/protocol server ':(glob)test/*.js'`: clean.

## API changes (for engine and p6-ui)

| What | Change |
|---|---|
| **Transport contract** (top of web/sync.js; every transport follows it) | `reopen()` is **required**: `bindEditor` throws a TypeError without it. It drops the current connection and opens a new one, and from then on no message or drop report of an older connection is delivered (a generation per connection). `close()` means **finished for good**: only the handle's `close()` calls it, and the resync path never does (while down, sync.js ignores input, waits `reconnectWait()`, then calls `reopen()`). New optional **`onDrop(fn)`**: the transport calls `fn()` when the current connection closed or errored without sync.js asking. |
| Unplanned drops | On `onDrop`, sync.js calls `replica.connectionFailed()`, waits `reconnectWait()` and reopens. It ignores the report while already down, closed, `refused` or `stopped` (the same token or app would only be refused again). |
| `handle.close()` | Now also calls `transport.close()`, once (a second call does nothing). |
| `handle.previews()` | Uses `replica.previewsOf(stream)`: only the handle's own stream. |
| `handle.reconnect(newToken?)` | New optional argument: sign in again after `refused`; the next hello carries the new token. Without it, unchanged. Session: `S.reconnect(token?)`. |
| `localRoom` | `join()` transports gain `onDrop(fn)` and a test hook **`fail()`** (the connection drops unasked; the client is told). `close()` now removes the link from the network. New `net.tick()` (fire the earliest virtual-clock timer). |
| web/ui/net.js `sharedNet` | **Each connection is a fresh link id**: `reopen()` posts `close` for the old link and `join` for a new one, and only the current link has handlers in the tab. A message the worker posted before it saw the reopen is dropped in the tab. New option `worker` (tests pass a fake `{ port }`). Transports gain `onDrop` and a dev/test `fail()`. |
| Worker protocol | room-worker.js is now a 4-line entry over the new **web/ui/room-host.js** (`roomHost({ users, options }).connect(port)`). Messages: `reopen` is gone (a reopen is close + join). New tab → host `{ t: "drop", link }` (dev/test) and host → tab `{ t: "dropped", link }`. |
| Session (web/ui/session.js) | `createSession` passes `timers`, `now` and `random` through to bindEditor. Combined `status`: `stopped` > `refused` > the rest (it used to show "connecting" when one stream was stopped and the other was not live). **The backstop now checks the role only, not `online`**, so a text box or drag already open when the connection drops commits and is held as a pending op. `online` still gates every new gesture, tool and command. A blocked write sets `s.flash` (toast). New dev hook `S.dropConnection()`. |
| Pill and banner | `stopped`: pill **"Update needed · reload the app"** (before the offline check) and a banner with a Reload button that says how many unacknowledged edits a reload loses. Existing classes only (style.css is not mine). |
| **Sign-in token** (new web/ui/token.js) | `takeToken({ location, history, storage })` reads `#token=…` (and `&link=invalid\|unavailable`) and clears the hash at once with `history.replaceState`, keeping path and query, whatever the fragment held. Valid means the server's shape (`s1.<b64url>.<43-char b64url>`), ≤ 6100 chars, exactly one `token=`, and a fragment ≤ 8192 chars. The token is kept in memory and in sessionStorage (`plenary.session`), never localStorage, and is checked again when read back. `tokenIdentity(token)` gives `{ user, name }` from the unverified payload for display only (short plain strings, else null). |
| **Who signs in** (`chooseSignIn` in web/ui/token.js, used by web/app.js) | An explicit, known `?as=` is the dev path (token `dev-<as>`, unchanged), even when a token is stored. Otherwise the sign-in token (from the fragment, or sessionStorage after a reload), re-checked with `validToken`. Otherwise dev ada. A share-link outcome shows as a toast. |

## Files

| File | Change |
|---|---|
| web/sync.js | Transport contract header; reopen required; resync without `close()`; `onDrop` → `connectionFailed`; `previewsOf`; `reconnect(newToken)`; `close()` closes the transport; localRoom `onDrop`/`fail`/final `close`/`tick`. |
| web/ui/net.js | Link id per connection, `onDrop`, `fail`, injectable worker. |
| web/ui/room-host.js (new), web/ui/room-worker.js | Worker logic moved into a testable host; `drop` and `dropped` messages. |
| web/ui/session.js | Clock pass-through, status precedence, role-only backstop, flash on block, `reconnect(token)`, `dropConnection`. |
| web/ui/roles.js | `stopped` pill. |
| web/ui/token.js (new) | Fragment token; `chooseSignIn`. |
| web/app.js | Token wiring via `chooseSignIn`; `stopped` banner; share-link toast. |
| web/index.html | URL comment mentions `#token`. |
| test/web/sync.test.js | Stub transports gain `reopen: () => {}` (5 tests, required by the contract; no assertion changed); 7 tests added. |
| test/web/ui-land.test.js (new) | 6 tests. |
| test/web/ui-token.test.js (new) | 9 tests. |

Not touched: packages/protocol, server/, test/*.js, web/dev.js, web/paint.js, web/style.css, web/dev.html.

## Findings fixed

| Finding | Fix | Checked by |
|---|---|---|
| p6-sync2v **H1** (SharedWorker tab stuck at "Connecting…" after any resync) | The contract above | ui-land "H1" (three tabs over room-host behind queued fake ports) and the browser run |
| p6-sync2v **M1** (no recovery without reopen) | `reopen` required; bindEditor throws without it | sync "contract: reopen() is required…" |
| p6-sync2v **M2** (`stopped` shown as Connecting…) | Pill, banner, status precedence | ui-land "M2" |
| p6-sync2v M3 (re-stamp the chain) | Engine's; fixed in 2c53a90 (not by me). Suite green on it. | `bun test` |
| p6-sync2v L3 (no drop backoff, no sign-in after refused, old messages after close, previews not per stream) | All four done | Tests below |
| p6-uiv **M1** (draft lost when offline) | Role-only backstop | ui-land "M1" and the browser run |
| p6-uiv L2 (silent drop on downgrade) | Toast | ui-land "L2" |
| p6-sync2v L1, L2; p6-uiv L1, L3, L4 | Not done: notes only, v1 `noteAuthor` seam, mock gaps, test gap. Out of this brief's scope. | — |

## Tests added (22)

- **sync.test.js:**
  - The contract: reopen required; a resync never calls close; `handle.close()` calls it once.
  - localRoom delivers nothing of the old connection after reopen.
  - **Drops before welcome back off 500, 1000, 2000, 4000 ms** (jitter fixed), keep the op, then land.
  - A drop on a live connection reconnects and converges; a drop report while down is ignored.
  - Refused, then a server close: **no second hello** with the refused token; `reconnect(newToken)` signs in (the hello carries it); `reconnect()` after a resync works.
  - A drop report is ignored while down, after `stopped` and after `close()`: no extra hello, timer or status change (and the down case's one backoff timer is the 500 ms rule-12 wait).
  - **Previews per stream:** a notes-bound handle never lists a board drag.
- **ui-land.test.js:**
  - **H1 over the SharedWorker transport:** three tabs, refused op, back to live; the next drawing and note reach all three; Retry after it.
  - **Shared transport stale delivery:** a `msg` and a `dropped` for the old link, in flight across `reopen()`, are not delivered; after `close()`, nothing is.
  - **`?net=local`:** resync, then converge.
  - **M1:** draft typed through offline + drop is kept, held and lands; so does a drag in flight; a new tool can't start offline.
  - **L2:** toast.
  - **M2:** `stopped` wins and has its own pill.
- **ui-token.test.js:**
  - The token is read, stored and cleared (path and query kept); a reload uses the stored copy.
  - Share-link outcome, known values only.
  - 13 hostile fragments: huge, a valid token inside a huge fragment, script and HTML, `token=` twice, wrong prefix, NUL, short MAC, empty payload, broken percent-encoding, `+` and `%2E` tricks, bare `#token`, `#=`. Never a token, never stored, the hash always cleared.
  - A bad fragment keeps a good stored token; a tampered stored value is removed.
  - Storage that throws still works.
  - Identity: only short plain strings.
  - **Who signs in:** `?as=` wins over a token; token only; neither (dev ada); an unknown or `__proto__` `?as=`. The dev path runs end to end (live as bo, every hello `dev-bo`); a session token reaches the hello as is (refused by the dev room).
  - **A hostile fragment never reaches the hello:** four hostile fragments through `takeToken` + `chooseSignIn` + a session: every hello is `dev-ada`. `chooseSignIn` re-checks a bad token handed to it directly.
  - A source check: no localStorage, console or `globalThis.plenary` exposure of the token.

**Strict gate and sweep:** the strict sync gate, the 56-combination gesture × ending sweep, and every other existing
assertion are unchanged. The only edit to existing tests is the `reopen` stub.

## How I checked

- **Mutation check** (put each fix back to the old code, run test/web, restore): **15 of 17 caught; the 2 survivors are equivalent.**
  - The cases: resync calls close (48 tests fail); backstop checks online; old status precedence; no stopped pill; shared transport reuses one link; no L2 flash; drop ignored; previews across streams; `reconnect` ignores the token; `handle.close` not forwarded.
  - The L2 case first "survived" only because that mutation was a syntax error. Redone cleanly, it was caught.
  - Second round: the drop guard without `needAuth` or without `stopped` (caught: a second hello goes out); `chooseSignIn` letting a token beat `?as=`, skipping the re-check, or taking any `?as=` (all caught).
  - **Equivalent survivors:** the drop guard without `down` or without `closed`. Removing either changes nothing observable, because the Replica ignores `connectionFailed()` once a resync is set, and `pump()` returns at once when down or closed. They stay as belt and braces.
- **Headless Chrome (CDP, real mouse and keys)** on the worktree, served read-only on port 0 with a fresh profile:
  - **Three tabs** (`?as=ada|cy|ed&board=v1`, net `shared`):
    - All three were live, and ada's mouse-drawn rectangle reached cy and ed.
    - **H1 repro:** `setAppState({ bogus: 1 })` on ada. She was back to live, and her next ellipse reached both tabs. No console errors.
  - **Forced drop mid-typing** (ada):
    - She pressed T, clicked, and typed "draft". Then `offline` fired and `S.dropConnection()` ran.
    - She typed " kept" and pressed Escape. Her pill read "Offline · 1 edit waiting", with pending 1 and blocked 0.
    - Back `online`: **"draft kept" was in all three tabs**, with diff 0 and pending 0.
  - **`#token`:** `index.html?board=v2#token=<s1-shaped>&link=invalid`.
    - **The address bar is `…/index.html?board=v2`** (hash empty), and the token is in sessionStorage, not localStorage.
    - The avatar is "GR" from the payload, and the toast showed the share-link message.
    - The pill reads "Refused · sign in again", as expected: the dev room knows only dev tokens.
    - After a reload, the hash is still empty and the token is still stored.
  - **Hostile fragment** (`?as=bo` plus `<img onerror>`/`<script>` in the token and in `link`, and `token=` twice):
    - The hash was cleared and nothing was stored.
    - `__pwn` stayed unset and there was no `onerror` in the DOM. The tab went live as bo.
  - **web/dev.html:** a mouse-drawn rectangle in the left pane converged in both panes (diff 0, pending 0).
  - **Cleanup:** I killed only the Chrome PIDs I started (45905, 48312, and 21044 for the re-run after the sign-in refactor), and both are confirmed gone. The static server ran in-process.

## NOT verified

- **One flaky test, platform's, not in my files:** a second loop of 60 full runs that kept the log of any failure
  caught 1 failure (run 10). It was `test/auth/http.test.js:503` "replay guard: per-callback cost stays flat as live
  states grow…": a wall-clock ratio check (`b / a < 3`) measured 4.13 that run. My first loop of 12 full runs also had
  1 failing test, but that loop kept only the counts, so its name is unknown (likely the same test).
  - In all, 2 failures in 72 + 60 = 132 full runs, plus 60 green test/web-only runs. No test/web failure was ever seen.
  - For platform: the check is timing-sensitive under machine load. I didn't touch it (test/*.js and server/ are not mine).
- **No real WebSocket or server:**
  - A real session token is refused by the in-browser rooms until the phase-3 transport exists (the SEAM is in net.js).
  - That transport must follow the contract: a generation per socket, `onDrop` only for the current socket, `close()` final.
- **SharedWorker crash:** nothing reports `onDrop` if the worker itself dies (no event for it). Only the dev `fail()` hook drives drops there.
- **Signing in again after `refused`:** the page has no UI for it. Retry still reconnects with the same token, so a fresh Google sign-in is a page navigation.
- **Not exercised:** `stopped` in a live browser (unit only), real hardware input, and QuickJS/Herdr.
- **Token checks are shape-only.** The signature is the server's job.

## Risks

- **Server format coupling:** `TOKEN_RE` copies the server's token shape (server/auth/session.js). If platform changes the format or MAC, sign-in fails closed (no token is taken). Keep the two in step.
- **Old connection stays up:** while down, the old connection stays open until `reopen()` (by contract). In the dev room the user shows as present through the backoff, and the old link's messages are just ignored.
- **Merged statuses:** `S.status` merges two streams. A notes-only `refused` shows Refused for the whole page, as before.
