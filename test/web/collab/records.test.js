// Comment threads: order with the pending overlay, anchors following and detaching, rights per role, and the
// fake port's records reducer agreeing with the protocol's Records.
import { test, expect } from "bun:test";
import { recordsView, newRecordId, ago } from "../../../web/core/collab/records-model.js";
import { createFakePort, applyRecord } from "../../../web/adapters/collab/fake.js";
import { Records } from "../../../packages/protocol/records.js";
import { ROLES } from "../../../packages/protocol/envelope.js";

const ME = { user: "me", name: "Jordan P.", client: "me-1" };
const port = (role = "annotator", extra = {}) => createFakePort({ role, me: ME, now: () => 5_000, ...extra });
const view = p => recordsView(p.records(), { me: p.me, role: p.role, element: p.element });

test("order: confirmed threads in seq order, then mine pending (dimmed) until acked", () => {
  const p = port();
  p.remote({ do: "thread", id: "a", anchor: { point: { x: 0, y: 0 } }, text: "A" }, "maya", "Maya");
  p.thread({ id: "mine", anchor: { point: { x: 5, y: 5 } }, text: "Mine" });
  p.remote({ do: "thread", id: "b", anchor: { point: { x: 1, y: 1 } }, text: "B" }, "dev", "Dev");
  p.reply({ id: "r1", thread: "a", text: "my reply" });
  let v = view(p);
  expect(v.threads.map(t => [t.id, t.pending])).toEqual([["a", false], ["b", false], ["mine", true]]);
  expect(v.threads[0].comments.map(c => [c.id, c.pending, c.name])).toEqual([["a", false, "Maya"], ["r1", true, "Jordan P."]]);
  p.ack(1);
  v = view(p);
  expect(v.threads.map(t => [t.id, t.pending])).toEqual([["a", false], ["b", false], ["mine", false]]);
  expect(v.threads[0].comments[1].pending).toBe(true);
  p.ackAll();
  expect(view(p).threads[0].comments[1]).toMatchObject({ pending: false, name: "Jordan P.", mine: true });
});

test("pending resolve, reaction and delete are marked; a refused one leaves the overlay", () => {
  const p = port("commenter");
  p.remote({ do: "thread", id: "a", anchor: { point: { x: 0, y: 0 } }, text: "A" }, "maya", "Maya");
  p.remote({ do: "reply", id: "b", thread: "a", text: "B" }, "dev", "Dev");
  const refused = []; p.onRefused(r => refused.push(r));
  p.resolve({ id: "a" }); p.react({ id: "b", emoji: "👍" });
  let t = view(p).threads[0];
  expect(t.resolved).toMatchObject({ by: "me", name: "Jordan P." }); expect(t.statePending).toBe(true);
  expect(t.comments[1].reactions).toEqual([{ emoji: "👍", n: 1, mine: true, pending: true }]);
  p.refuseNext("limit", "full");
  t = view(p).threads[0];
  expect(t.resolved).toBeNull(); expect(refused.map(r => r.code)).toEqual(["limit"]);
  p.ack(1);
  expect(view(p).threads[0].comments[1].reactions).toEqual([{ emoji: "👍", n: 1, mine: true, pending: false }]);
  // A commenter may not delete Dev's comment: the room refuses, the overlay drops it.
  p.deleteComment({ id: "b" });
  expect(view(p).threads[0].comments[1]).toMatchObject({ deleted: true, pending: true });
  p.ack(1);
  expect(view(p).threads[0].comments[1]).toMatchObject({ deleted: false, text: "B" });
  expect(refused.at(-1).code).toBe("forbidden");
});

test("an element anchor follows the element, and detaches (at its own x, y) when the element is deleted", () => {
  const p = port("editor", { elements: { "board:ship": { x: 100, y: 50, width: 80, height: 40 } } });
  p.remote({ do: "thread", id: "t", anchor: { stream: "board", element: "ship", x: 180, y: 50 }, text: "Locked?" }, "maya", "Maya");
  expect(view(p).threads[0]).toMatchObject({ x: 180, y: 50, detached: false, on: { stream: "board", element: "ship" } });
  p.setElement("board", "ship", { x: 300, y: 200, width: 80, height: 40 });
  expect(view(p).threads[0]).toMatchObject({ x: 380, y: 200, detached: false });
  p.setElement("board", "ship", { x: 300, y: 200, width: 80, height: 40, isDeleted: true });
  expect(view(p).threads[0]).toMatchObject({ x: 180, y: 50, detached: true });
  p.setElement("board", "ship", null);
  expect(view(p).threads[0].detached).toBe(true);
});

test("a thread whose first comment is deleted is hidden; a deleted reply shows as deleted", () => {
  const p = port("editor");
  p.remote({ do: "thread", id: "t", anchor: { point: { x: 0, y: 0 } }, text: "x" }, "maya", "Maya");
  p.remote({ do: "reply", id: "r", thread: "t", text: "y" }, "dev", "Dev");
  p.remote({ do: "delete", id: "r" }, "dev", "Dev");
  expect(view(p).threads[0].comments[1]).toMatchObject({ deleted: true, text: "", canDelete: false });
  expect(view(p).threads[0].count).toBe(1);
  p.remote({ do: "delete", id: "t" }, "maya", "Maya");
  expect(view(p).threads).toEqual([]);
});

test("rights per role: writers reply, resolve and react; delete is the author's or a presenter's; viewers read", () => {
  const rows = {};
  for (const role of ROLES) {
    const p = port(role);
    p.remote({ do: "thread", id: "t", anchor: { point: { x: 0, y: 0 } }, text: "x" }, "maya", "Maya");
    p.remote({ do: "reply", id: "mine", thread: "t", text: "y" }, "me", "Jordan P.");
    const t = view(p).threads[0];
    rows[role] = [t.canReply, t.canResolve, t.comments[0].canReact, t.comments[0].canDelete, t.comments[1].canDelete];
  }
  expect(rows).toEqual({
    owner: [true, true, true, true, true], editor: [true, true, true, true, true],
    annotator: [true, true, true, false, true], commenter: [true, true, true, false, true],
    viewer: [false, false, false, false, false],
  });
});

test("records reducer (fake port) equals the protocol's Records on the same actions, no-ops and dead targets included", () => {
  const ops = [
    ["a", { do: "thread", id: "t1", anchor: { point: { x: 1, y: 2 } }, text: "one" }],
    ["b", { do: "reply", id: "c1", thread: "t1", text: "two" }],
    ["a", { do: "react", id: "c1", emoji: "👍", on: true }], ["b", { do: "react", id: "c1", emoji: "👍", on: true }],
    ["a", { do: "react", id: "c1", emoji: "👍", on: true }], ["a", { do: "react", id: "c1", emoji: "👍", on: false }],
    ["a", { do: "resolve", id: "t1" }], ["b", { do: "resolve", id: "t1" }], ["b", { do: "reopen", id: "t1" }],
    ["a", { do: "thread", id: "t2", anchor: { stream: "notes", element: "n1", x: 0, y: 0 }, text: "three" }],
    ["b", { do: "delete", id: "c1" }], ["b", { do: "delete", id: "c1" }], ["a", { do: "react", id: "c1", emoji: "🔥", on: true }],
    ["a", { do: "delete", id: "t2" }], ["b", { do: "reply", id: "c9", thread: "t2", text: "dead" }], ["b", { do: "resolve", id: "t2" }],
    ["a", { do: "edit", id: "t1", text: "one!" }], ["a", { do: "move", id: "t1", anchor: { point: { x: 9, y: 9 } } }],
    ["a", { do: "thread", id: "t1", anchor: { point: { x: 1, y: 2 } }, text: "dup" }], ["a", { do: "nonsense" }],
  ];
  const r = new Records(), mine = [];
  ops.forEach(([by, op], i) => {
    const a = r.apply(op, by, i, by.toUpperCase()), b = applyRecord(mine, op, by, i, by.toUpperCase());
    expect(`${i} ${b}`).toBe(`${i} ${a}`);
  });
  expect(mine).toEqual(r.toJSON().threads);
});

test("record ids are ≤ 64 chars and differ; ago() reads", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newRecordId(Math.random)));
  expect(ids.size).toBe(200);
  for (const id of ids) expect(id.length).toBeLessThanOrEqual(64);
  expect([ago(0, 10_000), ago(0, 180_000), ago(0, 7_200_000), ago(0, 3 * 86_400_000)]).toEqual(["now", "3 min", "2 h", "3 d"]);
});

test("newRecordId takes its random source from the caller (the clock port), never Math.random", () => {
  expect(() => newRecordId()).toThrow(TypeError);
  const real = Math.random;
  Math.random = () => { throw new Error("core read Math.random"); };
  try { expect(newRecordId(() => 0)).toBe("c" + "a".repeat(14)); } finally { Math.random = real; }
});
