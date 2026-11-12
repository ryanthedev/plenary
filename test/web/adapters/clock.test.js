// Clock adapters (web/adapters/clock/*) against the clock contract, plus the virtual clock's own rules.
import { describe, test, expect } from "bun:test";
import { clockContract } from "../contracts/clock-contract.js";
import { browserClock } from "../../../web/adapters/clock/browser.js";
import { virtualClock } from "../../../web/adapters/clock/virtual.js";

clockContract("virtual", () => { const c = virtualClock(); return { clock: c, advance: async ms => c.advance(ms) }; });
clockContract("browser", () => ({ clock: browserClock(), advance: ms => new Promise(r => setTimeout(r, ms + 2)) }));

describe("virtual clock", () => {
  test("starts at t0; now() moves only in advance()", () => {
    const c = virtualClock({ t0: 1000 });
    expect(c.now()).toBe(1000);
    c.advance(250);
    expect(c.now()).toBe(1250);
  });
  test("equal due times fire in the order set; now() inside a callback is its due time", () => {
    const c = virtualClock(), got = [];
    c.set(() => got.push(["a", c.now()]), 10);
    c.set(() => got.push(["b", c.now()]), 10);
    c.set(() => got.push(["c", c.now()]), 4);
    c.advance(100);
    expect(got).toEqual([["c", 4], ["a", 10], ["b", 10]]);
    expect(c.now()).toBe(100);
  });
  test("a timer set during advance fires in the same advance when due by its end, else stays pending", () => {
    const c = virtualClock(), got = [];
    c.set(() => { got.push(c.now()); c.set(() => got.push(c.now()), 5); c.set(() => got.push("late"), 500); }, 10);
    c.advance(20);
    expect(got).toEqual([10, 15]);
    expect(c.pending).toBe(1);
  });
  test("the same seed gives the same random sequence; another seed differs", () => {
    const seq = s => { const c = virtualClock({ seed: s }); return Array.from({ length: 5 }, () => c.random()); };
    expect(seq(7)).toEqual(seq(7));
    expect(seq(7)).not.toEqual(seq(8));
  });
  test("a throwing callback does not stop the others; the first error is rethrown after", () => {
    const c = virtualClock(), got = [];
    c.set(() => { throw new Error("boom"); }, 1);
    c.set(() => got.push(2), 2);
    expect(() => c.advance(5)).toThrow("boom");
    expect(got).toEqual([2]);
    expect(c.now()).toBe(5);
  });
  test("advance with a negative or NaN ms is a RangeError", () => {
    const c = virtualClock();
    expect(() => c.advance(-1)).toThrow(RangeError);
    expect(() => c.advance(NaN)).toThrow(RangeError);
  });
});

describe("browser clock", () => {
  // p6-portsv R2-L1: where performance.now exists, mono() IS it (not the Date.now clamp).
  test("with performance.now present, mono() follows it, not Date.now", () => {
    const perf = Object.getOwnPropertyDescriptor(globalThis, "performance"), realNow = Date.now;
    let p = 1000;
    try {
      Object.defineProperty(globalThis, "performance", { value: { now: () => p }, configurable: true, writable: true });
      Date.now = () => 5;
      const c = browserClock();
      expect(c.mono()).toBe(1000);
      p = 1234.5;
      expect(c.mono()).toBe(1234.5);
    } finally {
      Date.now = realNow;
      if (perf) Object.defineProperty(globalThis, "performance", perf);
    }
  });

  test("without performance.now (Herdr's QuickJS), mono() is Date.now clamped: a backward wall step never shows", () => {
    const perf = Object.getOwnPropertyDescriptor(globalThis, "performance"), realNow = Date.now;
    let wall = 1_000_000;
    try {
      Object.defineProperty(globalThis, "performance", { value: undefined, configurable: true, writable: true });
      Date.now = () => wall;
      const c = browserClock();
      expect(c.mono()).toBe(1_000_000);
      wall = 900_000;                       // NTP steps the wall clock back
      expect(c.now()).toBe(900_000);
      expect(c.mono()).toBe(1_000_000);     // mono holds
      wall = 1_000_050;
      expect(c.mono()).toBe(1_000_050);
    } finally {
      Date.now = realNow;
      if (perf) Object.defineProperty(globalThis, "performance", perf);
    }
  });
});
