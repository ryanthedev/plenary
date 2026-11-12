# Report: p6-edge2 (ws backpressure, sign-in test gaps)

Worker p6-edge2 (client), manager client (t14k). Base: main at ac91d62. Not committed. Closes p6-edgev **M1**
(outbound backpressure) and **M2** (sign-in rules unpinned), plus **LOW-1** and **LOW-2**. LOW-3, LOW-4 and LOW-5
belong to other people's files (see section 7).

`bun test`, whole repo: **677 pass, 78 skip, 0 fail** (baseline on main before this job: 606 / 78 / 0).

## Decision (manager client, t14k, 2026-11-12): drop only a stalled link

- **The rule now:** a backlog over 4 MB is a drop only when it makes **no drain progress** for 10 s. Before, it was a
  drop whenever it stayed over 4 MB for 10 s.
- **Why:** under the old rule, a slow but moving link with a resend burst over 4 MB was dropped, and every
  reconnect resent the same burst, so it could loop.
- **How progress is measured:** between two 1 s samples, progress = previous backlog + bytes the client added since
  − backlog now. Adds are counted, so a link that drains while the core adds even more still counts as moving. A
  plain "bufferedAmount went down" test would drop it, and a mutation of exactly that is killed.
- **What restarts the 10 s count:** any progress, or one sample at or under the cap.
- **Changed:** the port text, ws.js, the reference transport, and the contract. The contract has a new required
  driver hook, `trickle(n)` (the far side reads n bytes and stays stalled), and four new cases:
  - **Slow drain:** over the cap for 40 s while draining 8 KB/s gives no drop.
  - **Growing but draining:** a backlog that grows while draining gives no drop.
  - **Stalled while sending:** a stalled link while the client keeps sending is a drop, because adding is not draining.
  - **Count from last progress:** a link that drains and then stops drops 10 s after its last progress.
- **Kept:** the stalled case (no drop before 10 s, one drop at 10 s).

## 1. Design (distributed-systems-design v0.1.0, APPLIER mode, before coding)

**Scope.** This is the client's uplink on one board socket. Editors need < 150 ms in their home region, and an
acknowledged op is never lost. Presence (PROTOCOL.md § Presence: `presence` messages with k = cursor, select,
laser, preview, emote) is never saved and may drop at any hop. PROTOCOL.md
paces ops at 20/s with a burst of 100, and cursors at 20/s, but neither pacer is on main yet. The brief fixed the
numbers (256 KB watermark; 4 MB held for 10 s), so there were no scope questions to ask.

**Estimate.**
- **Normal traffic:** a cursor at 20/s × ~100 B is about 2 KB/s. A large op (a pasted drawing) is 10–100 KB
  (an assumption, not measured).
- **Previews are the big presence:** PROTOCOL.md § Presence allows a `preview` up to 64 KB at 20/s, about 1.3 MB/s.
  That is the realistic way an editor fills a slow uplink.
- **What the watermark means:** 256 KB is about 2 s of backlog on a 1 Mbit/s uplink, and about 0.2 s on 10 Mbit/s.
  Normal presence never reaches it; a stalled or very slow link reaches it within seconds.
- **What the hard cap means:** 4 MB with nothing leaving for 10 s is a link that is not moving. Holding it longer only delays the
  resync that rescues the held ops.

**High-level shape (hexagonal).**
- **Port** (`web/ports/transport.js`): `congested()` plus the limits as constants. The port says what the core must
  do with it.
- **Adapter** (`web/adapters/transport/ws.js`): measures the backlog as pre-open queue bytes plus `ws.bufferedAmount`
  and enforces the hard cap on the injected clock port.
- **Core** (`web/sync.js`, p6-hex): decides what to skip. The transport cannot tell presence from ops, so it never
  drops a message itself.

**Deep dive 1: the signal (Ch12, WebSocket; Ch1, a queue as buffer).**
- **Choice:** a pure boolean read the core polls before sending presence, rather than an event.
- **Why:** an event would need hysteresis and a second callback. Polling costs one addition per presence frame, and
  the core already has a point where it decides to send.
- **Trade-off:** the transport does not shed load itself. Ops always queue, so latency degrades rather than
  correctness.

**Deep dive 2: the hard cap (failure detection).**
- **Choice:** a clock timer per socket samples the backlog every 1 s while it is over the cap. A drop needs 10 s over
  the cap with no drain progress; any progress, or a sample at or under the cap, restarts the count (see Decision).
- **Why a timer:** a check only inside `send()` would never fire for a stalled link whose core has gone quiet.
- **Why count added bytes:** `bufferedAmount` alone mixes bytes leaving with bytes the core adds. The adapter knows
  what it added, so it can tell drained from not drained.
- **Pre-open queue:** a byte cap of 4 MB is a drop at once, because a socket that never opened has nothing to drain
  into.

**Wrap-up.**
- **Bottleneck 1: ops still wait behind a big backlog.** Only skipping presence prevents it; the transport cannot
  reorder.
- **Bottleneck 2: a slow link's backlog is not bounded by the transport.** Since the Decision, it is never
  dropped while it moves. Bounding it is the core's job: skip presence and pace ops (section 6).
- **Bottleneck 3: a closed socket may keep draining.** Unverified in a browser (section 5).
- **Failure walk-through:**
  - **Verified (tests):** the uplink stalls, the backlog passes 4 MB, and 10 s later the adapter closes the socket and
    reports onDrop once.
  - **Verified by reading main:** after a reconnect, unacked ops are resent. `Replica.connectMessages` returns the
    hello plus every op still in `replica.pending` (`packages/protocol/replica.js:27,34`). sync.js sends only the
    hello at once and keeps the rest until `welcome` (`web/sync.js:62-65`, `157-160`). Nothing acknowledged is lost,
    because an ack only comes from the room.
  - **Not on main yet:** sync.js does not subscribe to onDrop. Its caller reconnects through `handle.reconnect()`
    (`web/sync.js:204`), and `Replica.reconnectWait` (backoff with jitter) does not exist yet. Wiring onDrop to
    backoff and reconnect is p2-land's or p6-hex's work.
- **Monitoring:** onDrop is already counted by the core; a congested-time counter for the status pill is p6-hex's call.
- **At 10× scale:** nothing here is shared. The cost is per socket.

## 2. Files

| File | Change |
|---|---|
| `web/ports/transport.js` | Adds `congested()`, which every adapter must implement and the core may call. `onDrop` becomes required for a transport with an outbound buffer, because the hard cap reports through it. Defines the watermark and the hard-cap rule, says exactly what the core must do, and exports `CONGESTED_BYTES` (256 KB), `HARD_CAP_BYTES` (4 MB), `HARD_CAP_MS` (10 s) and `HARD_CAP_SAMPLE_MS` (1 s). The header now reads "types and limits only, no logic". |
| `web/adapters/transport/ws.js` | Adds `congested()`, measuring backlog as queue bytes plus `bufferedAmount` (a missing value counts as 0). Adds `frameBytes()` (UTF-8 length of a text frame, `byteLength` of a binary one) and the pre-open byte cap `maxQueuedBytes` (default 4 MB). The hard cap runs on the injected `clock` (`mono`/`set`/`clear`; the browser's timers if none is passed), one timer per socket, cleared in `retire()`. **LOW-2:** every drop found inside `send()` (count overflow, byte overflow, a throwing `ws.send`) closes the socket at once and reports onDrop on a microtask, only if that socket is still current. New options are `clock`, `watermark`, `hardCapBytes`, `hardCapMs` and `sampleMs`, all defaulting to the port's values. The import header now names the port import too. |
| `test/web/contracts/transport-contract.js` | Adds a **backpressure** section. It is required and never skipped: a driver must provide `stall`/`drain`/`trickle`/`advance` or declare `bufferless: true`, in which case `congested()` is asserted to stay false. Exports `pad(n)`. |
| `test/web/contracts/reference-transport.js` | Implements `congested()` and the hard cap on a virtual clock, plus the `stall`/`drain`/`trickle`/`advance` driver hooks. |
| `test/web/contracts/reference-transport.test.js` | A second contract run, "reference (bufferless)", so the contract's bufferless branch is exercised too. |
| `test/web/adapters/transport-ws.test.js` | Gives the fake WebSocket a `bufferedAmount` and `stall`/`drain`; the driver gets a virtual clock. Two existing tests now expect the drop on a microtask (LOW-2). Seven new tests (section 3). |
| `test/web/core/signin.test.js` | Console trap, two hostile fragments, a MAX_FRAGMENT boundary test, and a jitter-source test. |
| `web/core/signin.js` | Not changed: no test exposed a bug. |

## 3. Tests added

**Contract, backpressure section** (run against both the reference transport and ws):
- **Interface:** `congested()` exists and is false on a fresh connection.
- **No silent skip:** the driver provides the hooks or declares `bufferless`; when bufferless, `congested()` stays false.
- **Watermark:** under it gives false, over it true, and false again once drained.
- **Nothing dropped:** everything sent while congested still arrives, in order.
- **New connections:** after reopen it is false; after close it is false.
- **Hard cap held:** stalled over the cap for the whole hold is exactly one drop, nothing more after, and reopen then
  works.
- **Decision cases:** slow drain, growing but draining, stalled while sending, and counting from the last progress
  (see Decision).
- **Hard cap drained:** draining before the hold ends gives no drop.
- **Restart:** one sample under the cap restarts the hold (18 s over in total, never 10 s straight, gives no drop).
- **Cancel:** reopen or close during the hold gives no drop.

**ws only:**
- **Exact defaults:** the watermark is exactly `CONGESTED_BYTES` (at it false, one byte over true; the pre-open queue
  counts; a missing `bufferedAmount` counts as 0). The pre-open queue holds exactly `HARD_CAP_BYTES`, and more is a
  drop. The hard cap is exactly `HARD_CAP_BYTES` held `HARD_CAP_MS`, on the injected clock.
- **Bytes, not characters:** UTF-8 counting (`é`, `€`, emoji) for `frameBytes`, and for `congested()` with non-ASCII
  text.
- **No leaked timers:** reopen and close clear the hold's timer.
- **LOW-2:** an overflow followed by a reopen in the same tick reports no drop.

**signin:**
- **No logging:** a console trap on all six methods, restored before the assertion, runs in every test.
- **New hostile fragments:** `#code=%41%42`, and a fragment over MAX_FRAGMENT made only of `&x=1` padding with a
  valid `code=` (only the cap rejects it).
- **Boundary:** a fragment of exactly MAX_FRAGMENT characters is still exchanged.
- **Jitter source:** with `clock.random` stubbed to return r (0, 0.25 and 0.999) and `Math.random` made to throw for
  the duration of the call, the random is drawn once and the retry happens at exactly `500 + floor(r × 1500)` ms,
  not 1 ms earlier.

## 4. Mutation check

All mutations ran in a scratch copy of the repo, never in the shared tree; the target test file was run per mutation.
The script is `/private/tmp/claude-501/-Users-r-repos-plenary/7fab8e80-a4fd-4e9b-8252-036ca91cecb3/scratchpad/mutate.py`.
**All 26 rule mutations are killed.** One mutation now survives as an equivalent: "a dip under the cap does not
restart the count". A backlog can only fall under the cap by draining, and draining already restarts the count, so
the two programs behave the same. The table below is the final run, after the Decision.

| Mutation | Result | Caught by |
|---|---|---|
| **Watermark removed** (`congested` always false) | KILLED (4) | contract "watermark…" |
| Watermark `>=` instead of `>` | KILLED | ws "defaults: the watermark is … exactly" |
| **Pre-open byte cap removed** | KILLED | ws "the pre-open queue holds HARD_CAP_BYTES exactly" |
| **Hard-cap drop removed** | KILLED (5) | contract "hard cap: a stalled backlog … one drop" |
| **Decision: progress ignored (the old rule)** | KILLED (3) | contract "a slow link … keeps draining is never dropped" |
| Decision: progress = backlog went down (adds ignored) | KILLED | contract "draining while the client adds more … no drop" |
| Decision: zero drain counts as progress (`>=`) | KILLED (5) | contract "a stalled backlog … one drop" |
| Decision: added bytes counted as drained | KILLED | contract "stalled while the client keeps sending is a drop" |
| Decision: sends not counted as added | KILLED | contract "draining while the client adds more…" |
| Decision, reference: progress ignored | KILLED (3) | contract on reference |
| Hard cap: a dip does not restart the count | SURVIVED (equivalent, see above) | — |
| Hold timer not cleared on retire | KILLED | ws "reopen and close … clear its timer" (survived at first; that test was added for it) |
| Hold measured with `Date.now` instead of the clock | KILLED (4) | contract "hard cap…" |
| Bytes counted as `string.length` | KILLED | ws "counted in UTF-8 bytes" (survived at first; that test was added for it) |
| Overflow drop synchronous again (LOW-2) | KILLED (2) | ws "past maxQueued…" |
| Deferred drop reported despite a reopen | KILLED | ws "a drop found inside send() and a reopen in the same tick" |
| `congested()` true after a drop or close | KILLED | contract "hard cap…" |
| Reference: watermark removed / hard-cap drop removed | KILLED (4 / 4) | contract on reference |
| **signin: `console.log` of the code** / `console.debug` of the token | KILLED (24 / 14) | console trap |
| **signin: `Math.random` instead of `clock.random`** | KILLED | "the jitter comes from clock.random…" |
| signin: percent-decoding the code | KILLED | hostile "escaped, valid once decoded" |
| **signin: MAX_FRAGMENT cap removed** | KILLED | hostile "over MAX_FRAGMENT only by padding" |
| signin: MAX_FRAGMENT `>=` | KILLED | "exactly MAX_FRAGMENT characters is still looked at" |

## 5. NOT verified

- **No real browser.** Not checked: `bufferedAmount` behaviour (including after `close()`, when a browser may keep
  sending what is buffered), or whether Chrome or Safari raise it the way the fake does.
- **No real backlog on a real socket.** Bun's client does report `bufferedAmount` (checked: about 670 KB after one
  1 MB send on loopback), but loopback drains too fast and too variably for a test that does not flake. The real
  socket tests from p6-edge still pass.
- **No live gateway** was run for this job.
- **The core side is not written** (p6-hex), so nothing here proves presence is actually skipped.
- **Other transports are not checked.** p2's `localRoom` and `net.js` `sharedNet` are not run against the contract in
  this repo, so their lack of `congested()` is not caught by any test here.
- **No sdd ensemble review** was run; builders may farm out work, and verifiers run the review.
- **The presence rule in practice:** today's sync.js still sends drag previews as v0 `transient` ops through
  `replica.local` (`web/sync.js:176`), not as `presence`. Whether those must be skipped too, and whether the Replica
  tracks them as pending, is for p6-hex and p2-land to settle when previews move to the presence channel.

## 6. Risks

- **Port change breaks other transports.** `congested()` is now required. `localRoom` (bufferless: return false and
  declare `bufferless: true` in its driver) and `sharedNet` (its page side buffers into a MessagePort; returning
  false is honest only if the worker applies its own cap) fail the contract until their owners add it.
- **Slow vs stalled: resolved by the Decision.** A slow but moving link is no longer dropped, so a resend burst
  cannot loop. The cost is that a link draining a trickle (even 1 byte a second) is never dropped by the hard cap, and
  its backlog can keep growing if the core keeps adding. Two other mechanisms bound it: the core skipping presence
  and pacing ops, and the Replica's 10 s op timeout (rule 2), which forces a resync when acks stop coming. Neither
  is on main yet (p2-land / p6-hex).
- **Before open, only the hello is queued** (sync.js holds the other unacked ops until `welcome`,
  `web/sync.js:62-65`), so the pre-open byte cap is not a risk for resyncs.
- **Latency, not loss, is the residual.** Ops sent while the link is congested still wait behind up to 256 KB+ of
  backlog. Skipping presence stops it growing, but does not empty it.
- **Clock wiring.** If the composition root forgets to pass `clock`, the adapter falls back to the global timers and
  `performance.now`. It works, but cannot be driven in tests from the root.

## 7. What p6-hex must do in the core (and notes for others)

**p6-hex (web/sync.js and the composition root):**
1. **Wire the clock.** Pass the clock port to `wsTransport({ url, WebSocket, clock })`.
2. **Skip only presence.** Before sending a `presence` message (PROTOCOL.md § Presence: k = `cursor`, `select`,
   `laser`, `preview`, `emote`), call `transport.congested()`. If it is true, do not send it.
3. **Keep the latest of the latest-wins kinds.** For `cursor`, `select` and `preview` (latest per element), keep only
   the latest state. `laser` and `emote` are one-shot: drop them.
4. **Never skip the rest.** Never skip or delay `hello`, any `op` (including appState and selection carried in an
   op), or anything the room acknowledges or answers, because of `congested()`.
5. **Flush the latest state.** When `congested()` turns false (checked on the next presence tick or frame), send the
   kept latest state once, not the skipped history.
6. **Treat a hard-cap drop like any other.** It arrives as an ordinary `onDrop`. sync.js on main does not subscribe
   to onDrop yet; once it does, count it, back off (`Replica.reconnectWait`, p2-land), and reopen. Unacked ops are
   already resent after welcome.
7. **Update the type in the sync.js header.** It still reads `{ send, onMessage, reopen? }`; it should match the port:
   `reopen` required, `onDrop` optional, `congested` present.
8. **Optional:** show congestion in the connection status pill.

**Others (outside my files):**
- **p2 / localRoom and net.js owners:** implement `congested()`. localRoom returns false and its driver declares
  `bufferless: true`; for sharedNet, decide where its buffer is measured.
- **LOW-3, `web/adapters/auth/http.js`:** add `redirect: "error"` to the exchange fetch (one line, defence in depth).
- **LOW-4, LOW-5, p6-hex UI copy:** the `invalid-code` message should not blame the person. A failed exchange that
  falls back to a stored session should say "sign-in failed; still signed in as <name>".
- **Retry-jitter width (p6-edgev design table):** widening 0.5–2 s, or honouring `Retry-After`, is a signin.js
  decision for the manager. Not changed here, because no test exposed a bug.
