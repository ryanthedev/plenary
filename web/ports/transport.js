// Transport port: how web/'s core (sync.js) talks to one board stream. Driven port; types and limits only, no logic.
// Imports nothing. Contract test: test/web/contracts/transport-contract.js (transportContract).
//
// Contract: the p2-land header of web/sync.js, plus rules marked [added] that the header leaves implicit. p2's
// localRoom keeps them all (transportContract run against it, outside the repo); net.js sharedNet keeps them as far as
// its page side goes (read, not run; its worker side unchecked).
//   A transport is ONE logical link to a room, carried over a sequence of connections. Each connection has a
//   generation; at any moment at most one generation is current.
//   send(msg)      Queue one message object on the CURRENT connection (a wire transport runs the codec). [added]
//                  A message not yet sent when reopen() is called is dropped, never carried onto the new
//                  connection. After close() it does nothing.
//   onMessage(fn)  fn(msg) for each message of the CURRENT connection, in the order the far side sent them.
//                  Delivery may be synchronous or asynchronous. [added] One handler: a later call replaces it.
//   reopen()       REQUIRED. Drop the current connection and open a new one (a new generation). From the moment
//                  it is called, no message and no onDrop of an older generation is ever delivered, even one the
//                  far side had already queued. The room refuses a second hello on one connection, so a
//                  transport without reopen() could never recover from a resync. [added] After close() it does nothing.
//   close()        Finished for good: the current connection is dropped, nothing more is delivered, no reopen
//                  follows. Only the binding handle's close() calls it; sync.js's own resync path never does.
//   onDrop?(fn)    Optional for a transport with no outbound buffer; REQUIRED for one with a buffer, because the
//                  hard cap (below) reports through it. fn() when the CURRENT connection closed or errored WITHOUT the client asking (a socket
//                  drop, before welcome or later). The client then counts it, waits its backoff and reopens. A
//                  transport never reports a close the client started (reopen, close), nor one of an older
//                  generation. [added] Each drop is reported at most once.
//
//   congested()    REQUIRED to implement, optional to call (p6-edgev M1). true when the CURRENT connection's
//                  outbound backlog (bytes queued before open + bytes the socket has not yet put on the wire) is
//                  over CONGESTED_BYTES (256 KB). A pure read: it never throws, never drops anything itself (the
//                  transport cannot tell presence from ops), is false after close() and describes the NEW
//                  connection right after reopen(). A transport with no outbound buffer (in-memory) returns false.
//                  What the CORE must do with it (sync.js; p6-hex): while congested(), do not send `presence`
//                  messages (PROTOCOL.md § Presence: k = cursor, select, laser, preview, emote; they may drop at any
//                  hop). For the latest-wins kinds (cursor, select, preview) keep only the latest and send it once
//                  congested() is false; laser and emote are simply dropped. NEVER skip or delay hello, any `op`
//                  (appState included), or anything the room acknowledges. Ops queue behind the backlog.
//   Hard cap [added]: a backlog over HARD_CAP_BYTES (4 MB) that makes NO DRAIN PROGRESS for HARD_CAP_MS (10 s)
//                  counts as an unasked drop: the transport closes that connection and reports onDrop once. Measured
//                  on the clock port's mono(), sampled at least every HARD_CAP_SAMPLE_MS. Progress between two
//                  samples = previous backlog + bytes the client added since − backlog now; any progress, or one
//                  sample at or under the cap, restarts the count. So a slow but moving link is never dropped (and
//                  cannot loop on a resend burst); only a stalled one is (manager decision, 2026-11-12). The core's
//                  resync then resends unacked ops on the next connection. reopen()/close() during the hold cancel it. A transport may also
//                  refuse a pre-open queue past HARD_CAP_BYTES at once, as a drop reported on a later microtask.
//
// Failure behaviour [added]: a transport never throws from send/reopen/close for a network reason; a dead link shows up as
// onDrop (or as silence, which the Replica's watchdog turns into a resync). Retry and backoff live in the core
// (Replica.reconnectWait with jitter from the clock port), never in an adapter, so every adapter backs off the same.

/**
 * @typedef {object} Transport
 * @property {(msg: object) => void} send
 * @property {(fn: (msg: object) => void) => void} onMessage
 * @property {() => void} reopen
 * @property {() => void} close
 * @property {(fn: () => void) => void} [onDrop]
 * @property {() => boolean} congested
 */

/** Outbound backlog (bytes) above which the core stops sending presence. */
export const CONGESTED_BYTES = 256 * 1024;
/** Outbound backlog (bytes) that, with no drain progress for HARD_CAP_MS, counts as a dead link (onDrop). */
export const HARD_CAP_BYTES = 4 * 1024 * 1024;
export const HARD_CAP_MS = 10_000;
/** How often a transport over the hard cap samples its backlog. */
export const HARD_CAP_SAMPLE_MS = 1_000;
