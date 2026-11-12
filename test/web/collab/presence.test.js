// Others' presence: expiry, leave, names from `here`, who sees whose cursor, emotes vs counts.
import { test, expect } from "bun:test";
import { createPresence, colorOf, initials, LASER_FADE_MS } from "../../../web/core/collab/presence-model.js";
import { presenceCoalescer } from "../../../packages/protocol/presence.js";
import { fakeClock } from "./clock.js";

const HERE = { writers: [{ user: "maya", name: "Maya", role: "owner" }, { user: "dev", name: "Dev K.", role: "editor" }, { user: "pri", name: "Priya", role: "annotator" }], writerCount: 40, viewers: 12408 };
const make = (role = "editor") => { const c = fakeClock(); const p = createPresence({ now: c.now, me: { user: "me", client: "me-1" }, role }); p.here(HERE); return { c, p }; };

test("a client is dropped on leave, or after 30 s of silence; a repeat keeps it", () => {
  const { c, p } = make();
  p.ingest([{ user: "maya", client: "m1", k: "cursor", x: 1, y: 2 }, { user: "dev", client: "d1", k: "cursor", x: 3, y: 4 }, { user: "pri", client: "p1", k: "cursor", x: 5, y: 6 }]);
  expect(p.view().cursors.map(x => x.name)).toEqual(["Maya", "Dev K.", "Priya"]);
  p.leave("maya", "m1");
  c.advance(20_000);
  p.ingest([{ user: "dev", client: "d1", k: "cursor", x: 3, y: 4 }]);   // the 10 s repeat
  c.advance(9_999);
  expect(p.view().cursors.map(x => x.name)).toEqual(["Dev K.", "Priya"]);
  c.advance(1);
  expect(p.view().cursors.map(x => x.name)).toEqual(["Dev K."]);
  p.ingest([{ user: "dev", client: "d1", k: "leave" }]);   // a leave inside a batch
  expect(p.view().cursors).toEqual([]);
});

test("the gateway's coalesced batch (protocol presenceCoalescer) is understood, own echo ignored", () => {
  const { p } = make();
  const co = presenceCoalescer();
  co.add("maya", "m1", { k: "cursor", x: 1, y: 1 }); co.add("maya", "m1", { k: "cursor", x: 9, y: 9 });
  co.add("maya", "m1", { k: "select", stream: "board", ids: ["a"] });
  co.add("maya", "m1", { k: "laser", pts: [[0, 0, 10], [5, 5, 30]] });
  co.add("me", "me-1", { k: "cursor", x: 7, y: 7 });
  co.add("me", "me-2", { k: "cursor", x: 8, y: 8 });      // my other tab is someone to see
  p.ingest(co.flush());
  const v = p.view();
  expect(v.cursors.map(x => [x.user, x.client, x.x])).toEqual([["maya", "m1", 9], ["me", "me-2", 8]]);
  expect(v.selections).toMatchObject([{ user: "maya", stream: "board", ids: ["a"], name: "Maya" }]);
  expect(v.lasers[0].pts.map(q => q.age)).toEqual([20, 0]);
});

test("lasers fade; a select with no ids clears", () => {
  const { c, p } = make();
  p.ingest([{ user: "maya", client: "m1", k: "laser", pts: [[0, 0, 1]] }, { user: "maya", client: "m1", k: "select", stream: "board", ids: ["a"] }]);
  c.advance(LASER_FADE_MS - 1); expect(p.view().lasers.length).toBe(1);
  c.advance(1); expect(p.view().lasers.length).toBe(0);
  p.ingest([{ user: "maya", client: "m1", k: "select", stream: "board", ids: [] }]);
  expect(p.view().selections).toEqual([]);
});

test("viewers see presenters' cursors and selections only (flag); writers see everyone's; unknown role is hidden from viewers", () => {
  const batch = [
    { user: "maya", client: "m1", k: "cursor", x: 1, y: 1 }, { user: "pri", client: "p1", k: "cursor", x: 2, y: 2 },
    { user: "ghost", client: "g1", k: "cursor", x: 3, y: 3 }, { user: "pri", client: "p1", k: "select", stream: "notes", ids: ["n"] },
  ];
  const v = make("viewer"); v.p.ingest(batch);
  expect(v.p.view().cursors.map(x => x.user)).toEqual(["maya"]);
  expect(v.p.view().selections).toEqual([]);
  const w = make("commenter"); w.p.ingest(batch);
  expect(w.p.view().cursors.map(x => [x.user, x.name])).toEqual([["maya", "Maya"], ["pri", "Priya"], ["ghost", "Someone"]]);
  const open = createPresence({ now: () => 0, me: { user: "me", client: "c" }, role: "viewer", flags: { viewersSeePresentersOnly: false } });
  open.ingest(batch); expect(open.view().cursors.length).toBe(3);
});

test("writers' emotes float and fade; viewers' emotes are only counts", () => {
  const { c, p } = make("viewer");
  p.ingest([{ user: "maya", client: "m1", k: "emote", e: "🎉" }, { user: "maya", client: "m1", k: "emote", e: "<b>x</b>" }]);
  expect(p.view().floaters.map(f => f.e)).toEqual(["🎉"]);
  p.emotes({ counts: { "👏": 1200, "🔥": 3, "<img>": 9, "👍": -4 } });
  c.advance(500); p.emotes({ counts: { "👏": 30 } });
  expect(p.view().counts).toEqual({ "👏": 1230, "🔥": 3 });
  c.advance(10_000);
  expect(p.view().counts).toEqual({});
  expect(p.view().floaters).toEqual([]);
});

test("here: at most 50 writers kept, counts never below the list; clear drops everything", () => {
  const { p } = make();
  p.here({ writers: [...Array(80).keys()].map(i => ({ user: `u${i}`, name: `U ${i}`, role: "annotator" })), writerCount: 3, viewers: -5 });
  const h = p.view().here;
  expect(h.writers.length).toBe(50); expect(h.writerCount).toBe(50); expect(h.viewers).toBe(0);
  p.ingest([{ user: "u1", client: "x", k: "cursor", x: 0, y: 0 }]); p.clear();
  expect(p.view().cursors).toEqual([]);
});

test("colors are stable per user; initials from names, hostile or empty", () => {
  expect(colorOf("maya")).toBe(colorOf("maya"));
  expect(initials("Dev K.")).toBe("DK"); expect(initials("maya")).toBe("M"); expect(initials("")).toBe("?");
  expect(initials("<img src=x onerror=alert(1)>")).toBe("IO");
});
