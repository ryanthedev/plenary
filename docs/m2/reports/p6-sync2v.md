**FAIL** — the p6-ui merge breaks: after any resync, a tab on the SharedWorker room sits at "Connecting…" for good, and its waiting edit is lost on reload (H1). sync.js itself holds every gate.

# Verifier report: p6-sync2v (web/sync.js on the phase-2 Replica)

**Head verified: p2-land 794298e** (rebased onto main by engine; p6-ui's files are in the worktree), with the
uncommitted web/sync.js and test/web/sync.test.js. Earlier runs at b8bf648 and 3ba2495 gave the same results.
`git diff --stat packages/protocol` was empty on each head I tested (Replica edits arrive as commits). I edited nothing
in the worktree: browser runs served it read-only, and every change I tried was in a scratch copy.

## HIGH

### H1. p6-ui merge: a resync kills the SharedWorker link; the tab never reconnects
- **Where:** web/sync.js:79 `goDown()` calls `transport.close?.()`, then calls `reopen()` after `reconnectWait()`.
  web/ui/net.js:29 `close` posts `close` **and deletes the message handler**. web/ui/room-worker.js:33 `close`
  closes **and deletes the link**. So the following `reopen` goes to a link the worker no longer has, and replies have
  no handler. The two sides mean different things by `close()`: sync.js means "drop this connection, a reopen
  follows"; p6-ui means "this link is finished".
- **Repro (headless Chrome, the worktree at 794298e served as is, three tabs of web/index.html `?as=ada|bo|cy&board=v1`,
  net kind `shared`):**
  1. All three tabs go live; A draws a rectangle and B and C see it.
  2. A does `setAppState({ bogus: 1 })`; the room refuses it and the copy resets (rule 5).
  3. A's board stream stays `connecting` for more than 15 s. A's next drawing stays pending (pending 1) and never
     reaches B or C. No console errors.
  4. Reloading A brings it back to `live`, but **the waiting drawing is gone**.

  `reconnect()` and the "Retry" button (web/app.js:409-410) cannot help, because they reopen the same dead link.
- **Control (scratch copy of 794298e):** net.js `close` keeps its handler and room-worker.js `close` keeps the link.
  Run the same script: A is back to `live`, the next drawing converges in all three tabs, and a reload is clean.
- **What triggers it:** any `resync`, which means a refused op, `unavailable`, the 10 s op or connect timeout, or a
  `stale` answer. `?net=local` (web/ui/net.js:37, localRoom) is fine.
- **Fix (manager's call):**
  - **Option 1:** p6-ui makes `close()` non-destructive, while still dropping the old connection's messages (the
    builder's transport-contract risk).
  - **Option 2:** sync.js uses a separately named port method.
  - **Either way:** add a UI test that resyncs over the SharedWorker transport. `bun test` stays green today
    (292/0 at 794298e) because no UI test does this.

## MEDIUM

### M1. A transport without `reopen()` never recovers from a resync
- **Where:** web/sync.js:17-19 says "without it the hello goes again on the same one", and :78 calls
  `transport.reopen?.()`.
- **What goes wrong:**
  1. The room refuses a second hello on one connection (room.js `hello`: `bad-op`, "one hello per connection", with
     no op id, so the Replica ignores it).
  2. The 10 s connect watchdog fires, the client resyncs and sends hello again, and is refused again.
  3. This repeats forever, with backoff.
- **Repro:** p6-basev's D5a without `reopen`: 40 of 40 runs never settle; the virtual clock reaches about 86 days with
  8 ops pending.
- **Fix:** make `reopen` required in the port and say so, or treat that refusal as fatal. p6-ui's transports have
  `reopen`; a Herdr/drawh WebSocket transport must have it too.

### M2. `stopped` shows as "Connecting…" in p6-ui
- **Where:** web/ui/session.js:83 passes `stopped` through, and web/ui/roles.js:72 labels everything that is neither
  live nor `catching-up` as "Connecting…". web/app.js:409 has a banner only for `refused`.
- **Effect:** the Replica never retries after `stopped`, so the user waits forever with no "update the app" message.
- **Owner:** p6-ui (the builder listed `stopped` as an API addition). Found by codex and confirmed by reading; not run
  in a browser.

### M3 (engine, replica.js, not sync.js). Ops made during a resync go out at versions at or below the room's copy
- **Where:** packages/protocol/replica.js `restamp()` skips an op when "my edits lead already", meaning the copy
  equals the **top** of my pending chain. Ops made while the Replica was empty are stamped v1…vk. Once k exceeds
  the room's version, the top leads and nothing is re-stamped, so v1…v(room) go out dead. That contradicts the
  comment above `restamp()`: "never goes out at a stale version and gets acked dead".
- **Measured on 3ba2495** (scratch `basev/k.test.js`; the room's copy at v4; k nudges in the resync window):
  - **Stale versions sent:** 0 of 40 runs at k=1, 24 at k=4, 40 at k=5, 40 at k=7.
  - **No peer:** the user's final position is never lost, because the chain's own last op lands.
  - **With a concurrent peer edit (also v5):** 0 losses in 160 runs.
- **Where a loss did show:** p6-basev's D5a (a busier window), 2 of 40 seeds. The user's chain ends at v5 and ties
  the peer's v5 on version, and the peer wins the tie-break although the room ordered it first. A correctly
  re-stamped chain (v5…v9) would have won.
- **Why MEDIUM:** this is a lost tie, not an acked op lost outright. A chain made during a resync loses a race a
  live client would win, and the dead intermediate entries are harmless in every run I made.
- **Owner:** engine decides whether to re-stamp the whole unsent chain. sync.js needs no change.

## LOW

- **L1. `timeoutMs` changed meaning** (only `0` matters now). p6-ui never passes it.
- **L2. `compact()` stays** (localRoom maps it to `room.checkpoint()`), and p6-ui doesn't call it. localRoom now checks
  tokens, and p6-ui's DEV_USERS tokens pass (all three tabs reached `live`).
- **L3. The builder's risks:**
  - **No backoff for transport drops:** still open. 794298e adds `Replica.connectionFailed()`; sync.js doesn't call it.
  - **No sign-in after `refused`:** still open. Retry (app.js:409) calls `reconnect()` with the same token.
  - **Old-connection messages after `close()`:** a real constraint on H1's option 1; localRoom handles it with a
    generation number per link.
  - **Previews not per stream:** `previews()` still lists every stream; 794298e adds `previewsOf`.
  - **Wider reconcile scan:** not measured.

## Must-hold checks

| Gate | Result |
|---|---|
| An acked op is never lost | **sync.js: holds.** H1-repro T1: logged at v6, x 564 in the room, the peer and the Editor; strict []. The D9 fuzz (below): 0 bad. The Replica tie case is M3. |
| Only never-sent ops re-stamped; resends keep bytes | **Holds.** My own check: across the D9 fuzz (150 runs, 601 refusals, 979 reconnects/timeouts), **15,092 resends, all byte-identical** to the first send of that id. `sentAt` is a protocol field (envelope.js). |
| Timers only from `wait()`/`reconnectWait()` | **Holds.** sync.js:58-70 `arm()` is the only `timers.set`; there is no second ack timer, and `close()` clears the timer. |
| Drag previews as presence, never ops | **Holds.** sync.js:187 returns before `local()` for transient ops. In Chrome the peer saw the preview mid-drag, and seq didn't move. |
| Strict gate and gesture × ending sweep not weakened | **Holds.** `git diff f1886d5 -- test/web/sync.test.js` changes only `setup()` (clock wiring) and the two timer tests (virtual clock; same assertions plus "waited ≥ 10 s" and "resets == 2"), and adds 15 tests. No assertion was removed. codex agrees. |

## What I ran

- **`bun test` in the worktree:** 252/0 (b8bf648), 255/0 (3ba2495), 292/0 reported at 794298e.
- **p6-basev's repros**, copied to my scratchpad and moved onto `localRoom({ clock: true })` with `net.timers/now`:
  - **H1 (T1):** fixed.
  - **H2 (T3, Escape mid-drag):** strict [] after release, and a peer's nudge lands.
  - **D1:** 36 gesture × ending combinations, 0 not converged.
  - **D5b:** passes.
  - **D5a:** see M1 and M3.
  - **D9 fuzz with `reopen`,** run on the worktree at 794298e: 150 runs, 0 bad (status, pending, Editor == Replica
    strictly, Replica == room), plus the resend byte check.
- **Merge:** a scratch copy (worktree + p6-ui files) at b8bf648 and 3ba2495 gave `bun test` 268/0 and 271/0, and H1 in
  two tabs. Then the worktree itself at 794298e, in three tabs: H1 again. The control was run at each head.
- **web/dev.html in headless Chrome, real mouse and keys:** two panes converge, and the peer's preview is visible
  mid-drag. Escape mid-drag then release changes nothing (seq unchanged, strict []), and a peer's nudge afterwards
  lands (v3 everywhere).
- **sdd: single harness** (codex, effort high, on the diff in a scratch git copy with p6-ui's files). It found H1
  (confirmed by the browser repro and control), M1 (confirmed by D5a) and M2 (confirmed by reading). It reported no
  weakened assertion, extra timer or preview sent as an op, which agrees with my checks. It did not find M3.

## NOT checked

- A real gateway, socket or server; Herdr/QuickJS.
- A repeat of the builder's mutation run (I took its 21 mutations as given).
- p6-ui features beyond connect, draw, resync and reload (notes stream, annotators, export) after the merge.
- `stopped`, `needAuth` and `refused` → Retry in a browser.
- The reconcile scan at large board sizes.

Scratch: /private/tmp/claude-501/-Users-r-repos-plenary-p2/5fe8d584-2e59-4282-b318-27bf179f7b9f/scratchpad
(`basev/` repros incl. k.test.js and D9r, `ui3.js` + `cdp.js` browser driver, `ctl3/` control copy). I killed only
the Chrome PIDs I started.
