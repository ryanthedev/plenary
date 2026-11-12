// Presence (PROTOCOL.md § Presence), as units: shapes, rates, coalescing. The relay is the gateway's (phase 3).
import { test, expect } from "bun:test";
import { presenceProblem, presenceLimiter, presenceCoalescer, PRESENCE, EMOTES } from "../packages/protocol/presence.js";
import { makeElement } from "../packages/core/model.js";

test("shapes are checked, and who may send each kind", () => {
  const el = makeElement("rectangle", { id: "p" });
  const ok = [
    ["cursor", { k: "cursor", x: 1, y: 2 }, "commenter"], ["select", { k: "select", stream: "board", ids: ["a", "b"] }, "annotator"],
    ["laser", { k: "laser", pts: [[0, 0, 1], [1, 1, 2]] }, "editor"], ["preview", { k: "preview", stream: "notes", elements: [el] }, "annotator"],
    ["preview", { k: "preview", stream: "board", elements: [el] }, "owner"], ["emote", { k: "emote", e: EMOTES[0] }, "viewer"],
  ];
  for (const [name, msg, role] of ok) expect([name, role, presenceProblem(msg, role)]).toEqual([name, role, null]);
  const bad = [
    [{ k: "cursor", x: 1 }, "editor"], [{ k: "cursor", x: 1, y: Infinity }, "editor"], [{ k: "cursor", x: 1, y: 2 }, "viewer"],
    [{ k: "select", stream: "records", ids: [] }, "editor"], [{ k: "select", stream: "board", ids: Array(501).fill("a") }, "editor"], [{ k: "select", stream: "board", ids: [1] }, "editor"],
    [{ k: "laser", pts: [[0, 0, 1]] }, "annotator"], [{ k: "laser", pts: Array(65).fill([0, 0, 1]) }, "editor"], [{ k: "laser", pts: [[0, 0]] }, "editor"],
    [{ k: "preview", stream: "board", elements: [el] }, "annotator"], [{ k: "preview", stream: "notes", elements: [el] }, "commenter"],
    [{ k: "preview", stream: "board", elements: Array(51).fill(el) }, "editor"], [{ k: "preview", stream: "board", elements: [{ ...el, text: "x".repeat(64_001) }] }, "editor"],
    [{ k: "preview", stream: "board", elements: [{ x: 1 }] }, "editor"],
    [{ k: "emote", e: "not-in-the-set" }, "editor"], [{ k: "leave" }, "editor"], [{ k: "__proto__" }, "editor"], [null, "editor"],
  ];
  for (const [msg, role] of bad) expect([msg?.k, role, typeof presenceProblem(msg, role)]).toEqual([msg?.k, role, "string"]);
});

test("over the rate is dropped (no error); the bucket refills by the injected clock", () => {
  let t = 0;
  const lim = presenceLimiter(() => t);
  const burst = k => { let n = 0; for (let i = 0; i < 100; i++) if (lim.allow(k)) n++; return n; };
  expect(burst("cursor")).toBe(PRESENCE.cursor.rate);       // 20 at once, then nothing
  expect(burst("select")).toBe(5);                           // each kind has its own rate
  expect(burst("emote")).toBe(4);
  expect(lim.allow("cursor")).toBe(false);
  t += 100;                                                  // 100 ms at 20/s = 2 more
  expect(burst("cursor")).toBe(2);
  t += 60_000;                                               // never more than a second's worth saved up
  expect(burst("cursor")).toBe(20);
  expect(burst("laser")).toBe(30);
  expect(lim.allow("nope")).toBe(false);
});

test("coalescing keeps the latest cursor, selection and preview per element, and every laser batch and emote", () => {
  const c = presenceCoalescer();
  const el = (id, x) => ({ id, x });
  c.add("u1", "a", { k: "cursor", x: 1, y: 1 }); c.add("u1", "a", { k: "cursor", x: 2, y: 2 }); c.add("u1", "a", { k: "cursor", x: 3, y: 3 });
  c.add("u2", "b", { k: "cursor", x: 9, y: 9 });
  c.add("u1", "a2", { k: "cursor", x: 7, y: 7 });            // the same user's other tab is its own cursor
  c.add("u1", "a", { k: "select", stream: "board", ids: ["x"] }); c.add("u1", "a", { k: "select", stream: "board", ids: ["y"] });
  c.add("u1", "a", { k: "preview", stream: "board", elements: [el("p", 1), el("q", 1)] }); c.add("u1", "a", { k: "preview", stream: "board", elements: [el("p", 2)] });
  c.add("u1", "a", { k: "laser", pts: [[0, 0, 1]] }); c.add("u1", "a", { k: "laser", pts: [[1, 1, 2]] });
  c.add("u2", "b", { k: "emote", e: "🎉" }); c.add("u2", "b", { k: "emote", e: "🎉" });
  const batch = c.flush();
  const of = (user, client, k) => batch.filter(m => m.user === user && m.client === client && m.k === k);
  expect(of("u1", "a", "cursor")).toEqual([{ user: "u1", client: "a", k: "cursor", x: 3, y: 3 }]);
  expect(of("u1", "a2", "cursor").length).toBe(1);
  expect(of("u2", "b", "cursor")[0].x).toBe(9);
  expect(of("u1", "a", "select")).toEqual([{ user: "u1", client: "a", k: "select", stream: "board", ids: ["y"] }]);
  expect(of("u1", "a", "preview").map(m => m.elements[0]).sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual([el("p", 2), el("q", 1)]);
  expect(of("u1", "a", "laser").length).toBe(2);
  expect(of("u2", "b", "emote").length).toBe(2);
  expect(c.flush()).toEqual([]);                             // nothing is kept after a flush
  c.add("u1", "a", { k: "cursor", x: 1, y: 1 }); c.add("u2", "b", { k: "cursor", x: 1, y: 1 });
  c.leave("u1", "a");                                        // the gateway's leave: its waiting presence goes, the others are told
  expect(c.flush()).toEqual([{ user: "u2", client: "b", k: "cursor", x: 1, y: 1 }, { user: "u1", client: "a", k: "leave" }]);
});
