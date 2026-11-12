// p7-perf round 2 (M3): frame.js's domClock(), the collab UI's default clock (D1), keeps the clock port's contract
// and matches web/adapters/clock/browser.js's behaviour, so the copy can't drift unguarded.
import { test, expect, afterEach } from "bun:test";
import { clockContract } from "../contracts/clock-contract.js";
import { domClock } from "../../../web/adapters/dom/collab/frame.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
clockContract("domClock (frame.js)", () => ({ clock: domClock(), advance: ms => sleep(ms) }));

const realPerf = globalThis.performance, realNow = Date.now;
afterEach(() => { globalThis.performance = realPerf; Date.now = realNow; });

test("domClock: mono is performance.now, not the wall clock", () => {
  globalThis.performance = { now: () => 1234.5 };
  Date.now = () => 9e12;
  const c = domClock();
  expect(c.mono()).toBe(1234.5);
  expect(c.now()).toBe(9e12);
});

test("domClock: without performance.now, mono clamps the wall clock so it never goes backwards", () => {
  globalThis.performance = undefined;
  let w = 5000; Date.now = () => w;
  const c = domClock();
  expect(c.mono()).toBe(5000);
  w = 1000; expect(c.mono()).toBe(5000);
  w = 6000; expect(c.mono()).toBe(6000);
});

test("domClock: set() treats a negative or NaN delay as 0 and passes a good one through", async () => {
  const seen = [], realSet = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { seen.push(ms); return 0; };
  try { const c = domClock(); c.set(() => {}, -5); c.set(() => {}, NaN); c.set(() => {}, 40); }
  finally { globalThis.setTimeout = realSet; }
  expect(seen).toEqual([0, 0, 40]);
});
