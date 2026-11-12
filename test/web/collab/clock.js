// A fake clock with timers, for the collab tests.
export function fakeClock(start = 1_000_000) {
  let t = start, seq = 0;
  const timers = new Map();
  const clock = {
    now: () => t,
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { at: t + Math.max(0, ms), fn }); return id; },
    clearTimer(id) { timers.delete(id); },
    /** Move time forward, running due timers in order. */
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
        if (!next) break;
        timers.delete(next[0]); t = Math.max(t, next[1].at); next[1].fn();
      }
      t = end;
    },
    get pending() { return timers.size; },
  };
  return clock;
}
