# Brief: p6-land (finish the client half of the p2-land landing)

Base: docs/m2/BRIEF-BASE.md applies. Read docs/m2/OFFICE.md, CLAUDE.md, PROTOCOL.md (v1) first.

- **Your tab:** `worker p6-land (client): land the client on p2-land`. Manager: `manager client` (t14k).
- **Where:** the worktree **/Users/r/repos/plenary-p2** (branch p2-land). Don't commit; engine merges p2-land as one
  green commit. Never touch packages/protocol, server/, test/*.js there. Engine rebases p2-land onto main (which has
  p6-ui, 3c32a5f) after its scaffold fix round and pings your manager first; if web/ui files are missing in the
  worktree when you start, tell your manager and stop.
- **You own (in the worktree):** web/sync.js, web/app.js, web/index.html, web/ui/**, web/dev.js, test/web/**, and
  your report docs/m2/reports/p6-land.md.

## Do

0. **p6-sync2v HIGH H1 first (the merge breaks):** after any resync a SharedWorker tab stays "Connecting…" for good,
   because sync.js calls `transport.close()` meaning "a reopen follows" and p6-ui's net.js/room-worker.js treat
   `close()` as "this link is finished". **Decision (manager): one transport contract, written at the top of
   sync.js and followed by every transport (net.js shared and local, room-worker.js, localRoom):**
   - `reopen()` is **required**: it drops the current connection and opens a new one; messages from the old
     connection must never be delivered after it (a generation per connection). This also fixes p6-sync2v M1
     (no transport without reopen).
   - `close()` means **finished for good**; only `handle.close()` calls it. sync.js's resync path never calls it:
     while down it ignores incoming messages, waits `reconnectWait()`, then calls `reopen()`.
   - Add the missing UI test: a resync over the SharedWorker transport (and over `?net=local`) comes back to `live`
     and the next drawing converges; plus the browser repro from p6-sync2v H1 (three tabs, a refused op).
   - Retry and `reconnect()` must work after a resync too.
   p6-sync2v **M2:** `stopped` shows its own pill text and an "update the app" banner, never "Connecting…".

1. **Findings from p6-sync2v** (/Users/r/repos/plenary/docs/m2/reports/p6-sync2v.md): fix every HIGH and MEDIUM;
   the LOWs too where cheap. Any p6-ui break under the new sync.js/localRoom (call sites listed there) is yours.
2. **New Replica API** (p2-land 3ba2495; docs/m2/reports/p2-recovery.md "Fix round 2"):
   - `handle.previews()` uses `replica.previewsOf(stream)` (per stream).
   - Transports report an unplanned close or error; sync.js then calls `replica.connectionFailed()`, waits
     `reconnectWait()`, reconnects. Never for closes sync.js started. Backoff now resets only after a connection
     has caught up and stayed up 10 s: re-check the sync tests' backoff assumptions.
   - Tests for both (a notes-bound handle never lists board previews; repeated drops before welcome back off).
3. **p6-uiv MEDIUM M1** (/Users/r/repos/plenary/docs/m2/reports/p6-uiv.md): text typed while the connection drops
   must not be lost: keep the draft open and commit it once live again (or hold it as a pending op), never drop it.
   Also L2: a downgrade mid-typing tells the user, not a silent drop.
4. **Sign-in token** (platform p5-http, 4fad32a): after Google sign-in the session token arrives in the URL fragment
   `#token=…` of the post-login URL. On load, read it, keep it for the hello (memory, plus sessionStorage so a
   reload works; never localStorage, never in a URL or a log), and clear the hash at once with
   `history.replaceState`. Keep the dev-token path (`?as=` dev users): sign-in answers 503 until the CEO's Google
   client exists. Tests: the token is read and the hash cleared; the dev path still works; a hostile fragment
   (huge, odd characters, `#token=` twice) never reaches the DOM or the hello unchecked.

## Done when

- `bun test` passes in the worktree (all of it). The strict sync gate and the gesture × ending sweep stay as strong.
- Headless browser: web/index.html with three tabs (presenter, annotator, viewer) and web/dev.html converge; a
  forced drop mid-typing keeps the draft; `#token=` is gone from the address bar after load.
- Report docs/m2/reports/p6-land.md: API changes at the top (for engine), files, tests, how you checked, NOT
  verified, risks. Then stop.
- Processes: never pkill/killall, PIDs only, port 0. sdd helpers allowed; you own every line.
