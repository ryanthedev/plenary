// Everything here runs on one event loop, and a durable append is a synchronous fsync. So a long run of work (one
// writer's burst of thousands of ops, a rebuild of a long log) must hand the loop back now and then, or every
// other board, socket and /health request on the process waits for the whole run. `breathe()` is awaited between
// units of work, wherever the work is; it returns at once unless the process has gone `sliceMs` without yielding,
// and then waits one turn of the event loop (setImmediate), which lets sockets, timers and HTTP run.
// One slice clock for the whole process: ten boards busy at once still yield every `sliceMs`, not ten times that.
// A writer's burst is bounded by § Pacing (the gateway's per-connection op bucket) and group commit; this still keeps
// a long rebuild or a feed's Store repair from holding the loop (it turns a freeze into latency, nothing more).

/** @param {{ sliceMs?: number, now?: () => number }} [o] */
export function createBreather({ sliceMs = 8, now = () => performance.now() } = {}) {
  let last = now(), yields = 0;
  // Whenever the loop turns by itself, the slice starts again: an idle process never pays a yield.
  const mark = () => { last = now(); armed = false; };
  let armed = false;
  const breathe = async () => {
    if (!armed) { armed = true; setImmediate(mark); }
    if (now() - last < sliceMs) return;
    await new Promise(resolve => setImmediate(resolve));
    last = now(); yields++;
  };
  breathe.stats = () => ({ yields });
  return breathe;
}

/** The process-wide breather. */
export const breathe = createBreather();
