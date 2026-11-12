// Clock adapter: the browser's own time, timers and Math.random. Implements web/ports/clock.js.
// With web/adapters/dom/collab/frame.js's domClock() (the collab UI's fallback, a copy of this: p7-perf D1, kept
// in step by test/web/collab/perf-clock.test.js), the only web/ code that may touch Date.now / performance.now /
// setTimeout / Math.random.
// mono: performance.now; where it is missing (Herdr's QuickJS may lack it) a clamp over Date.now that never goes
// backwards (a backward wall step then freezes mono until the wall clock catches up: deadlines run late, not early).

/** @returns {import("../../ports/clock.js").Clock} */
export function browserClock() {
  const perf = globalThis.performance;
  let last = -Infinity;
  const mono = typeof perf?.now === "function" ? () => perf.now() : () => (last = Math.max(last, Date.now()));
  return {
    now: () => Date.now(),
    mono,
    set: (fn, ms) => setTimeout(fn, Number.isFinite(ms) && ms > 0 ? ms : 0),
    clear: h => { if (h != null) clearTimeout(h); },
    random: () => Math.random(),
  };
}
