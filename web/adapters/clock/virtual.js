// Clock adapter: a deterministic virtual clock for tests. Implements web/ports/clock.js, plus advance(ms).
// Time moves only in advance(); timers fire there in due order, equal due times in the order they were set, with
// now() (and mono()) equal to the timer's due time inside its callback; a timer due exactly at the target fires. A timer set during advance() that falls due before the
// target fires in the same advance. random() is seeded (mulberry32): the same seed gives the same sequence.

/**
 * @param {{ t0?: number, seed?: number }} [o]
 * @returns {import("../../ports/clock.js").Clock & { advance(ms: number): void, readonly pending: number }}
 */
export function virtualClock({ t0 = 0, seed = 1 } = {}) {
  let t = t0, n = 0, s = seed >>> 0;
  /** @type {{ h: number, at: number, fn: () => void }[]} */
  let q = [];
  const next = until => {
    let best = null;
    for (const x of q) if (x.at <= until && (!best || x.at < best.at || (x.at === best.at && x.h < best.h))) best = x;
    return best;
  };
  return {
    now: () => t,
    mono: () => t,
    set: (fn, ms) => { const h = ++n; q.push({ h, at: t + (Number.isFinite(ms) && ms > 0 ? ms : 0), fn }); return h; },
    clear: h => { q = q.filter(x => x.h !== h); },
    random: () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let r = s;
      r = Math.imul(r ^ (r >>> 15), r | 1);
      r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    },
    /** Move time forward by ms (≥ 0), firing every timer due on the way. A throwing callback does not stop the
     *  others; the first error is rethrown after the advance. */
    advance(ms) {
      if (!(ms >= 0)) throw new RangeError("advance: ms must be ≥ 0");
      const until = t + ms;
      let err = null;
      for (let x; (x = next(until));) {
        q = q.filter(y => y !== x);
        t = x.at;
        try { x.fn(); } catch (e) { err ??= e; }
      }
      t = until;
      if (err) throw err;
    },
    get pending() { return q.length; },
  };
}
