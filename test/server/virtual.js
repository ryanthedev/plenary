// Time a test moves itself: timers that run only when advance() is called, and a clock that reads the same time.
// For the room host (`timers`, `monotonic`) and a Store (`now`) in test/server: a lease's ttl, a heartbeat or a deadline
// is then counted in virtual milliseconds and costs no real ones, and no test asserts on how long the machine took.

/** @param {{ start?: number, settle: () => Promise<void> }} o settle: let what the last timer started (bus, Store) finish. */
export function virtualTime({ start = 1_000_000, settle }) {
  let t = start, id = 0;
  const q = new Map();
  const add = (fn, ms, every) => {
    const h = { id: ++id, at: t + Math.max(0, ms || 0), fn, every };
    q.set(h.id, h);
    return Object.assign(h, { unref: () => h, ref: () => h });
  };
  const clear = h => { if (h && typeof h === "object") q.delete(h.id); };
  const timers = { setTimeout: (fn, ms) => add(fn, ms), setInterval: (fn, ms) => add(fn, ms, Math.max(1, ms)), clearTimeout: clear, clearInterval: clear };
  return {
    timers, now: () => t, pending: () => q.size,
    /** How far off each pending one-shot timer is (intervals left out). */
    oneShots: () => [...q.values()].filter(h => !h.every).map(h => h.at - t),
    /** Run every timer due within `ms`, in order, settling after each; then the clock is `ms` later. */
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const h of q.values()) if (h.at <= end && (!next || h.at < next.at || (h.at === next.at && h.id < next.id))) next = h;
        if (!next) break;
        t = Math.max(t, next.at);
        if (next.every) next.at = t + next.every; else q.delete(next.id);
        next.fn();
        await settle();
      }
      t = end;
      await settle();
    },
    /** advance(step) until `done()` is true, at most `maxMs` of virtual time; returns the virtual ms it took (or null). */
    async until(done, maxMs, step = 10) {
      const t0 = t;
      for (; t - t0 <= maxMs; await this.advance(step)) if (await done()) return t - t0;
      return null;
    },
  };
}
/** settle(): a few turns of the event loop and the bus, enough for a Store call and the messages it causes. */
export const settleWith = bus => async () => { for (let i = 0; i < 4; i++) { await bus.flush(); await new Promise(r => setImmediate(r)); } };
