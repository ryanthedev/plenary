// The Clock contract (web/ports/clock.js), as reusable bun tests. Every clock adapter runs it:
//
//   clockContract("virtual", () => { const c = virtualClock(); return { clock: c, advance: async ms => c.advance(ms) }; });
//   clockContract("browser", () => ({ clock: browserClock(), advance: ms => sleep(ms) }));
//
// makeClock(): a FRESH clock plus `advance(ms)` (async) that lets at least ms pass on that clock and runs the timers
// due by then (virtual: clock.advance; browser: a real wait). Tests use short times (≤ 40 ms) so a real clock stays
// fast. Nothing here assumes now() is monotonic (a browser's wall clock may jump).

import { describe, test, expect, beforeEach } from "bun:test";

/**
 * @param {string} name
 * @param {() => { clock: import("../../../web/ports/clock.js").Clock, advance(ms: number): Promise<void> }} makeClock
 * @param {{ skip?: boolean }} [opts]
 */
export function clockContract(name, makeClock, opts = {}) {
  describe.skipIf(!!opts.skip)(`Clock contract: ${name}`, () => {
    let c, advance;
    beforeEach(() => { ({ clock: c, advance } = makeClock()); });

    test("now() is a finite number of ms; works detached", () => {
      const { now } = c;
      expect(Number.isFinite(now())).toBe(true);
    });

    test("mono() is finite and never goes backwards, across calls and timers; works detached", async () => {
      const { mono } = c;
      const xs = [mono()];
      for (let i = 0; i < 1000; i++) xs.push(mono());
      await advance(10);
      xs.push(mono());
      for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
      expect(Number.isFinite(xs.at(-1))).toBe(true);
      expect(xs.at(-1) - xs[0]).toBeGreaterThanOrEqual(9);   // it moves with time (≥ the wait, 1 ms slack for a real clock)
    });

    test("a timer due exactly at the end of the wait fires (virtual: advance lands on its due time)", async () => {
      let n = 0;
      c.set(() => { n++; }, 20);
      await advance(20);
      expect(n).toBe(1);
    });

    test("random() is in [0, 1), varies, works detached", () => {
      const { random } = c;
      const xs = Array.from({ length: 200 }, () => random());
      for (const x of xs) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); }
      expect(new Set(xs).size).toBeGreaterThan(150);
    });

    test("set fires once, not synchronously, not before ms", async () => {
      let n = 0;
      c.set(() => { n++; }, 20);
      expect(n).toBe(0);
      await advance(5);
      expect(n).toBe(0);
      await advance(30);
      expect(n).toBe(1);
      await advance(30);
      expect(n).toBe(1);
    });

    test("set with 0, negative or NaN ms still fires later, never inside set", async () => {
      const got = [];
      c.set(() => got.push("zero"), 0);
      c.set(() => got.push("neg"), -5);
      c.set(() => got.push("nan"), NaN);
      expect(got).toEqual([]);
      await advance(10);
      expect(got.sort()).toEqual(["nan", "neg", "zero"]);
    });

    test("clear: the timer never fires; clearing again, a fired or an unknown handle is a no-op", async () => {
      let a = 0, b = 0;
      const ha = c.set(() => { a++; }, 10), hb = c.set(() => { b++; }, 5);
      c.clear(ha);
      c.clear(ha);
      await advance(30);
      expect(a).toBe(0);
      expect(b).toBe(1);
      expect(() => { c.clear(hb); c.clear(undefined); c.clear(null); }).not.toThrow();
    });

    test("different due times fire in due order", async () => {
      const got = [];
      c.set(() => got.push(30), 30);
      c.set(() => got.push(5), 5);
      c.set(() => got.push(15), 15);
      await advance(60);
      expect(got).toEqual([5, 15, 30]);
    });

    test("set and clear work detached (sync.js passes the clock as its `timers`)", async () => {
      const { set, clear } = c;
      let n = 0;
      const h = set(() => { n++; }, 5);
      set(() => { n += 10; }, 5);
      clear(h);
      await advance(20);
      expect(n).toBe(10);
    });
  });
}
