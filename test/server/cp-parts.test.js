// server/encode/cp-parts.js: the pure helpers behind checkpoint parts (PROTOCOL.md § Recovery, "Checkpoint parts").
import { test, expect } from "bun:test";
import { splitParts, headerOf, parseHeader, orphanGroups, PART_CHARS } from "../../server/encode/cp-parts.js";

test("splitParts: parts join back to the text, none longer than the size, and no surrogate pair is cut", () => {
  const text = "a😀b".repeat(1000) + "😀";
  for (const size of [1, 2, 3, 7, 64, 4096]) {
    const parts = splitParts(text, size);
    expect(parts.join("")).toBe(text);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(size);
      if (size > 1) expect(/[\ud800-\udbff]$/.test(p) || /^[\udc00-\udfff]/.test(p)).toBe(false);   // never the half of a pair
    }
  }
  expect(splitParts("", 10)).toEqual([]);
  expect(splitParts("abc", PART_CHARS)).toEqual(["abc"]);
});

test("header: round trips, and no JSON text (nor an old single-row checkpoint) parses as one", () => {
  expect(parseHeader(headerOf("w-1", 5, 12345))).toEqual({ wid: "w-1", parts: 5, chars: 12345 });
  for (const j of ['{"seq":1}', "{}", "[]", "", '{"seq":1,"cp-parts":1}']) expect(parseHeader(j)).toBe(null);
  expect(parseHeader(undefined)).toBe(null);
});

test("orphanGroups: parts no header names and not newer than the newest header; a newer group may be in flight", () => {
  const headers = [{ seq: 10, data: headerOf("w10", 2, 5) }, { seq: 20, data: headerOf("w20", 2, 5) }, { seq: 15, data: '{"seq":15}' }];
  const groups = [
    { seq: 10, wid: "w10" }, { seq: 20, wid: "w20" },           // named
    { seq: 20, wid: "lost" }, { seq: 12, wid: "crashed" },      // unnamed, old enough to judge
    { seq: 30, wid: "inflight" },                               // newer than every header: left alone
  ];
  expect(orphanGroups(headers, groups)).toEqual([{ seq: 20, wid: "lost" }, { seq: 12, wid: "crashed" }]);
  expect(orphanGroups([], groups)).toEqual([]);                  // no header at all: nothing is old enough
});
