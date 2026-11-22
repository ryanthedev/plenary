// @ts-check
// Clock port: time, timers and randomness for web/'s core, so tests run it on a virtual clock with a seeded
// random. Imports nothing. Contract test: test/web/contracts/clock-contract.js (clockContract).
//
// Contract:
//   now()           Wall time in ms since the epoch (a finite number), for stamps another machine reads (an op's
//                   sentAt, a record's created). It may jump (NTP, laptop wake): never measure a deadline with it.
//   mono()          Monotonic ms from an arbitrary origin (performance.now on a browser): never goes backwards,
//                   for deadlines and intervals (watchdogs, rate limits, frame timing). Only differences mean
//                   anything; never compare it across machines or store it. (p6-portsv M2. Today the Replica and
//                   presenceLimiter take one `now` for both uses; splitting them is p6-hex/engine work.)
//   set(fn, ms)     Call fn() once, no earlier than ms later (a timer due exactly at a virtual advance's target
//                   fires in that advance) (ms < 0 or NaN counts as 0), never synchronously
//                   inside set. Returns a handle.
//   clear(handle)   The timer never fires. Clearing a fired, cleared or unknown handle does nothing.
//   random()        A number in [0, 1) (backoff jitter, ids). Not for secrets.
//   Animation frames are NOT here: requestAnimationFrame belongs to the DOM adapters (collab renderers, paint).
//   Timers with different due times fire in due order. Every method works detached (`const { now } = clock`),
//   because the core hands them on as bare functions; the object also fits sync.js's `timers` ({ set, clear }).
//
// Failure behaviour: none of these can fail. A throwing timer callback is the callback's problem; it must not stop
// other timers (the browser runs each on its own task; the virtual clock reports the first error after the batch).

/**
 * @typedef {object} Clock
 * @property {() => number} now
 * @property {() => number} mono
 * @property {(fn: () => void, ms: number) => any} set
 * @property {(handle: any) => void} clear
 * @property {() => number} random
 */

export {};
