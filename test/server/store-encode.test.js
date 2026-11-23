// encodeSliced (server/encode/sliced.js) must produce exactly JSON.stringify's text, in slices that yield.
import { test, expect } from "bun:test";
import { encodeSliced } from "../../server/adapters/support/encode/sliced.js";

const seeded = seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
function gen(rng, depth) {
  const r = rng();
  if (depth > 6 || r < 0.35) return [null, true, false, 0, -1.5, 1e21, "x", "q\"\\\n é😀", undefined, () => 1, Symbol("s")][Math.floor(rng() * 11)];
  if (r < 0.65) return Array.from({ length: Math.floor(rng() * 5) }, () => gen(rng, depth + 1));
  const o = {}; for (let i = Math.floor(rng() * 5); i > 0; i--) o["k" + Math.floor(rng() * 9)] = gen(rng, depth + 1);
  return o;
}

test("encodeSliced equals JSON.stringify on many random values (undefined, functions, symbols, nesting)", async () => {
  const rng = seeded(7);
  for (let i = 0; i < 400; i++) {
    const v = gen(rng, 0);
    expect(await encodeSliced(v, { yieldNow: async () => {}, sliceChars: 8 })).toBe(JSON.stringify(v));
  }
  for (const v of [undefined, () => 1, null, 5, "s", [], {}, [undefined], { a: undefined }, { toJSON: () => ({ z: 1 }) }, [{ toJSON: () => undefined }]])
    expect(await encodeSliced(v)).toBe(JSON.stringify(v));
});

test("encodeSliced yields between slices of a big checkpoint-shaped value, and each slice is bounded", async () => {
  const elements = Array.from({ length: 5000 }, (_, i) => ({ id: "e" + i, type: "rectangle", points: [[i, i]], text: "x".repeat(100) }));
  const cp = { seq: 3, streams: { board: { elements, appState: { herdr: { layers: [{ id: "base" }] } } } }, noteAuthor: [["a", "b"]] };
  let yields = 0;
  const text = await encodeSliced(cp, { yieldNow: async () => { yields++; }, sliceChars: 64 * 1024 });
  expect(text).toBe(JSON.stringify(cp));
  expect(yields).toBe(Math.floor(text.length / (64 * 1024)));   // one yield per sliceChars (a deterministic step count)
  expect(yields).toBeGreaterThan(5);
});

test("encodeSliced cuts a thread of many big comments into pieces (records are walked deeper than elements)", async () => {
  const comments = Array.from({ length: 400 }, (_, i) => ({ id: "c" + i, by: "u", text: "t".repeat(10_000), reactions: {} }));
  const cp = { seq: 1, records: { threads: [{ id: "t1", anchor: { x: 1 }, comments }] } };
  let yields = 0;
  const text = await encodeSliced(cp, { yieldNow: async () => { yields++; }, sliceChars: 256 * 1024 });
  expect(text).toBe(JSON.stringify(cp));
  expect(yields).toBeGreaterThanOrEqual(12);                   // 4 MB in one piece would have been 1 yield at most
});
