# Report: p6-sync2 (web/sync.js onto the phase-2 Replica)

Worktree /Users/r/repos/plenary-p2, branch `p2-land` at b8bf648, not committed (the engine track merges p2-land).
**State: done. `bun test` in the worktree: 252 pass, 0 fail (was 183 pass, 54 fail), 30 runs in a row with no failure.**

## API changes (for p6-ui and engine; nothing stable was removed or renamed)

| What | Change |
|---|---|
| Status names | **Added `stopped`** (the room speaks a rules/protocol version this app doesn't know: update the app). `refused` now also covers a mid-session `auth` error (token expired), not only a refused hello. `connecting`, `catching-up`, `live` unchanged; during a resync's backoff wait the status is `connecting`. |
| Handle | **Added** `unconfirmed` (count of ops dropped without knowing whether they landed), `discarded` (count dropped because another user signed in on this client, rule 13), `previews()` (others' drags in flight, clones, display only, pruned after 5 s). `status`, `pending`, `role`, `peek`, `diff`, `full`, `state`, `reconnect`, `cancelGesture`, `close`, `resets` keep their meaning. `pending` still counts every unacknowledged op, sent or not (there is no separate "held" list any more). |
| `bindEditor` options | **Added** optional `now` and `random` (the Replica's clock and jitter; tests pass a virtual clock). **`timeoutMs` changed meaning:** the Replica owns every deadline now, so only `0` matters (no timers at all: a resync reconnects at once, nothing times out); other values are ignored. |
| Transport port | **Added** optional `close()`: called when the Replica asks for a resync, before the backoff wait; `reopen()` follows after `reconnectWait()` ms. A transport without `close` keeps working. |
| **Visible regression** | Nothing draws a peer's drag in flight any more (dev page included) until someone paints `handle.previews()`: v0 relayed transient ops into peers' boards; v1 keeps previews over the board, never in it. Peers see the shape jump to its final place on release. p6-ui/phase 7 paints them. |
| Behaviour | A refusal no longer reconnects at once: it waits `reconnectWait()` (250–500 ms the first time, growing per rule 12). `reconnect()` stays immediate (no backoff), as before. |
| `localRoom` (dev page and tests) | Now a gateway stand-in: checks the token itself (`auth` error), passes `{ n, user, role }` with the hello, relays presence to other links (checked with `presenceProblem`, rate-limited) and never to the room, sends `leave` when a link drops. New: `clock: true` (virtual clock; `settle()` fires due timers when the network is idle), `advance(ms)`, `now`, `timers`, `pendingTimers`, `presence` (what the stand-in saw). `compact()` is now `room.checkpoint()`. |

## Files

| File | Change |
|---|---|
| `web/sync.js` | Rewritten binding over the v1 Replica; `localRoom` rewritten as above. Removed: the 10 s watchdog, `stepVersions` and the Editor-version rewrite, `held`, `previewed`, `waiting`, `target`. |
| `test/web/sync.test.js` | Clock wiring, two timeout tests rewritten, 15 tests added (below). |
| `docs/m2/reports/p6-sync2.md` | This report. |

Nothing else touched (packages/protocol, server/, test/*.js, web/ui, web/dev.js, test/web/paint.test.js unchanged).

## How the binding works now (brief items 1–5)

1. **Sending:** one `pump()` after every `receive()`, every `local()` and every timer: send `replica.outgoing()`, then
   either start the resync (if `replica.resync`) or arm **one** timer from `replica.wait()`. No other timer.
   `local()` is called for every commit, live or not; the Editor's copy of each element takes the version and
   nonce `local()` returned (only when the Editor still holds the element as committed).
2. **Previews:** transient Editor ops become `replica.preview(stream, elements)` presence, in pieces of ≤ 50
   elements, each checked with `presenceProblem` and limited with `presenceLimiter` (20/s) before sending. Peers'
   previews are exposed (the Replica has them) via `handle.previews()`; painting them is p6-ui/phase 7.
3. **Receiving:** uses `{ entries, snapshot, reset }` from `receive()`: a snapshot while live reloads the Editor,
   entries feed their ids to the Editor; settings are compared after every message (an ack can change them).
4. **Cancelled gestures:** `replica.reconcile(stream, editorElements)` at every gesture end, **plus** one case it
   skips: an id with a pending op whose Editor copy is ahead (commit a move, then drag the same shape again and
   abandon it before the ack). That case is new in the tests and fails without the extra check. Still live-only:
   mid-resync the Replica is empty and reconcile would call everything "gone".
5. **Resync:** close, wait `reconnectWait()`, `reopen()`, hello. Input is ignored while down. Re-stamping is the
   Replica's (only never-sent ops; resends keep their bytes); tested both ways.

## Tests

- **Changed, with the reason:** `setup()` and every network test pass the virtual clock (`localRoom({ clock: true })`,
  `bindEditor({ timers, now })`), because a resync now waits on a timer and `settle()` must fire it. "a lost
  welcome" and "a lost ack and entry" now run on that clock instead of a fake timer queue fired by hand (the
  Replica checks deadlines against its own clock, so firing a timer early does nothing). Same assertions plus
  "it waited ≥ 10 s" and "resets == 2". Nothing was weakened: the strict gate (24), the 56-combination sweep, H1
  (4 seeds), M2-mid-gesture and the rest are unchanged.
- **Added (15):** preview goes out as presence, never logged, peer sees it over the board and the final entry
  clears it; a 60-element preview goes as 50 + 10 and passes the gateway; **a resend after a since-0 resync is
  byte-identical** although a peer's newer copy came in by snapshot, and the room logs it once; **a never-sent op
  made mid-resync is re-stamped to room version + 1**; **`stopped` and mid-session `auth` (`refused`) reach the
  status** and nothing is sent after; `discarded` counted on a user change; M1 (a lost ack on a busy board
  reconnects ≤ 12.5 s after the send while a peer draws every 2.5 s); M2 (repeated failed connections back off,
  non-decreasing, capped at 30 s); M3 (ops made before welcome survive a reconnect before welcome and land); L1
  (a 1,500-move drag committed before welcome is logged, not refused; `close()` leaves no timer); the
  pending-op reconcile case above; previews limited to 20/s on the client, none from a viewer, a peer's expiring
  after 5 s; a `stale` answer counted in `unconfirmed`; one async test on **real timers** (the page's defaults:
  `localRoom({ auto: true })`, a viewer's refusal resyncs after the real backoff and converges).

## How I checked

- `bun test` (all of it): 252 pass, 0 fail; 30 consecutive runs, 0 failing (ids and nonces are random).
- `git diff --quiet -- packages/protocol server test/*.js`: clean.
- **Mutation check** (script applies one mutation, runs test/web, restores): 21 mutations, all caught: preview
  dropped / unchunked / sent as an op; resends re-stamped and never-sent ops not re-stamped (both mutated in a
  `packages/protocol/replica.js` in place in the worktree for the run and restored at once; the brief says not to
  touch packages/protocol, so noting it: the final diff there is empty); `stopped` and `refused` not surfaced; pending cleared on reconnect
  (M3); `close()` leaving its timer; no `wait()` timer; no backoff; resync without close/wait; status staying
  `live` in the resync window; Editor copy not aligned after `local()`; `discarded` not counted; no reconcile;
  the pending-id reconcile check removed; the client's preview rate limit and `presenceProblem` gate removed;
  `prunePreviews()` dropped from `previews()`; `unconfirmed` not counted.
- One mutation survived at first ("Editor not fed after `outgoing()`"): I removed that code instead of keeping
  it, because by reading the Replica re-stamps an unsent op only when an entry overtakes it (its ids are fed) or
  on a snapshot (the Editor is reloaded), so what `outgoing()` sends already matches the Editor.

## NOT verified

- No browser: web/dev.js (unchanged) was not loaded. Its path (real timers, `localRoom({ auto: true })`) is
  covered by one async test, not by a page.
- No real server, gateway or socket; only the in-process stand-in. Presence relay through the real gateway is
  phase 3.
- Not run in Herdr's QuickJS (web/ is browser code anyway).
- Replica code (b8bf648, "unverified") was taken as given; I found no failure that traced to it.

## Risks and notes for engine

- **Peers' previews are not per stream:** `Replica.presence()` stores previews by element id and drops
  `m.stream`, so a handle bound to `notes` also lists `board` previews. Fix belongs in replica.js (engine).
- **No backoff for transport drops:** `Replica.fails` grows only on its own timeouts and `unavailable`. A socket
  that closes before `welcome` and a page that calls `reconnect()` on close would retry with no growing wait.
  p6-ui's app.js should not call `reconnect()` in a tight loop; better, the Replica could expose a "connection
  failed" call that counts toward rule 12 (engine's call).
- Preview pacing drops over-rate previews client-side; the last preview before a pause may be skipped until the
  next move or the final op (display only).
- **Wider reconcile scan:** the old code reverted only ids a transient op touched; now every Editor element
  ahead of the Replica is put back at each gesture end. Safe by reading core: every element write in
  packages/core/editor.js goes through `commit`/undo (`onOp`, so `local()` aligns it) or `livePut` (transient);
  an open text edit lives in `editor.text`, not the doc, until `commitText` (the existing GATE text-edit test
  covers it across a refusal).
- **Sign-in after `refused`:** the handle has no way to take a new token. Re-binding makes a new Replica and
  loses the pending ops the Replica kept for after sign-in. A `signIn(token)` on the handle would fix it; it is
  an API addition, so not done without a request (p6-ui/manager's call).
- **Transport contract:** after `close()` or `reopen()` a transport must deliver no message from the old
  connection; a late `welcome` would be taken as the new connection's. localRoom guarantees it (a generation
  per link); a real WebSocket transport must too.
- `reconcile` scans every Editor element at each gesture end (pointer down/up, key, tool change): linear in board
  size, fine for thousands, not measured at 100k elements.
