// Transport port: how web/'s core (sync.js) talks to one board stream. Driven port; no code, types only.
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
//   onDrop?(fn)    Optional. fn() when the CURRENT connection closed or errored WITHOUT the client asking (a socket
//                  drop, before welcome or later). The client then counts it, waits its backoff and reopens. A
//                  transport never reports a close the client started (reopen, close), nor one of an older
//                  generation. [added] Each drop is reported at most once.
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
 */

export {};
