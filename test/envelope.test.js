// The checks every op passes before a room looks at the board (PROTOCOL.md § Limits, § The element op).
import { test, expect } from "bun:test";
import { direct } from "./world.js";
import { opProblem, parseOpId, isSha1, canWrite, recordProblem, deeperThan, STREAMS, ELEMENT_STREAMS, PROTOCOL_VERSION, RULES_VERSION, MAX_OP_DEPTH, OP_RATE, CAPS } from "../packages/protocol/envelope.js";
import { makeElement } from "../packages/core/model.js";

const rect = (id, extra = {}) => makeElement("rectangle", { id, ...extra });
const op = (over = {}) => ({ t: "op", id: "c:1", sentAt: 0, stream: "board", op: { elements: [rect("x")] }, ...over });
// An element whose customData nests `levels` objects deep; the op around it adds three levels (op, elements, element).
const nested = levels => { const el = rect("deep"); let at = el.customData = {}; for (let i = 1; i < levels; i++) at = at.inner = {}; return el; };

test("streams, writers and versions as published", () => {
  expect([PROTOCOL_VERSION, RULES_VERSION, STREAMS, ELEMENT_STREAMS, OP_RATE]).toEqual([1, 1, ["board", "notes", "records"], ["board", "notes"], { perSecond: 20, burst: 100 }]);
  const table = role => STREAMS.filter(s => canWrite(role, s));
  expect(table("owner")).toEqual(["board", "notes", "records"]);
  expect(table("editor")).toEqual(["board", "notes", "records"]);
  expect(table("annotator")).toEqual(["notes", "records"]);
  expect(table("commenter")).toEqual(["records"]);            // v1: comments and reactions only, not notes
  expect(table("viewer")).toEqual([]);
  expect(CAPS.notes.ids).toBe(200_000);
});

test("op ids are client:counter with a positive integer counter; sentAt is an integer ≥ 0", () => {
  expect(parseOpId("web.abc:12")).toEqual({ client: "web.abc", counter: 12 });
  for (const id of ["c:0", "c:-1", "c:1.5", "c:01", "c:x", "c:", ":1", "c", "a:b:1", "c:1e3", "c:99999999999999999", 7, null])
    expect([id, parseOpId(id)]).toEqual([id, null]);
  expect(opProblem(op())).toBe(null);
  expect(opProblem(op({ id: "c:x" })).code).toBe("bad-op");
  for (const sentAt of [undefined, -1, 1.5, "3", null]) expect([sentAt, opProblem(op({ sentAt }))?.code]).toEqual([sentAt, "bad-op"]);
});

test("shape is checked before the id, so a bad id never hides a shape error", () => {
  expect(opProblem(op({ id: "nope", op: { files: { a: {} } } })).code).toBe("no-files");
  expect(opProblem(op({ id: "nope", stream: "secret" })).message).toContain("unknown stream");
  expect(opProblem(op({ id: "nope", op: { elements: [rect("big", { text: "x".repeat(1_000_001) })] } })).code).toBe("too-large");
  expect(opProblem(op({ op: {} })).message).toBe("empty op");
  expect(opProblem(op({ stream: "records", op: { elements: [rect("x")] } })).code).toBe("bad-op");   // element ops don't go in records
});

test("an image's fileId is 40 lowercase hex characters", () => {
  const image = fileId => op({ op: { elements: [makeElement("image", { id: "i", fileId })] } });
  expect(opProblem(image("a".repeat(40)))).toBe(null);
  expect(opProblem(image(null))).toBe(null);                  // not uploaded yet
  expect([isSha1("0123456789abcdef0123456789abcdef01234567"), isSha1("../other-tenant/x"), isSha1(undefined)]).toEqual([true, false, false]);
  for (const fileId of ["../t-other/x", "A".repeat(40), "a".repeat(39), 5]) expect([fileId, opProblem(image(fileId))?.code]).toEqual([fileId, "bad-op"]);
});

test("an op nested deeper than 64 levels is refused; a 30,000-deep one quickly, with no crash and nothing logged", () => {
  expect(MAX_OP_DEPTH).toBe(64);
  expect(opProblem(op({ op: { elements: [nested(61)] } }))).toBe(null);            // 3 + 61 = 64 levels pass
  expect(opProblem(op({ op: { elements: [nested(62)] } })).code).toBe("bad-op");
  const deep = nested(30_000), started = performance.now();
  expect(deeperThan(deep, 64)).toBe(true);
  expect(opProblem(op({ op: { elements: [deep] } }))).toMatchObject({ code: "bad-op", message: "an op nests at most 64 levels deep" });
  let arrays = []; for (let i = 0; i < 30_000; i++) arrays = [arrays];
  expect(opProblem(op({ op: { elements: arrays } })).code).toBe("bad-op");
  expect(opProblem(op({ stream: "records", op: { do: "thread", id: "t", text: "x", anchor: { point: deep } } })).code).toBe("bad-op");
  const d = direct(), a = d.join("ua", "editor", "a");
  expect(() => a.op(1, "board", { elements: [deep] })).not.toThrow();
  expect(a.inbox.at(-1)).toMatchObject({ t: "error", id: "a:1", code: "bad-op" });
  expect(d.log.entries.length).toBe(0);
  expect(performance.now() - started).toBeLessThan(500);
});

test("a first write counts from version 0: no exemption from the jump cap", () => {
  const d = direct(), a = d.join("ua", "editor", "a");
  a.op(1, "board", { elements: [rect("high", { version: 1001 })] });
  expect(a.inbox.at(-1)).toMatchObject({ code: "bad-op", id: "a:1" });
  a.op(2, "board", { elements: [rect("ok", { version: 1000 })] });
  expect(a.inbox.at(-2)).toEqual({ t: "ack", id: "a:2", seq: 1 });
});

test("the role is checked before the op-id table: a resend after the role was lowered gets forbidden, not its old ack", () => {
  const d = direct(), a = d.join("ua", "editor", "a");
  a.op(1, "board", { elements: [rect("x")] });
  const lowered = d.join("ua", "viewer", "a");
  lowered.op(1, "board", { elements: [rect("x")] });
  expect(lowered.inbox.at(-1)).toMatchObject({ code: "forbidden", id: "a:1" });
  expect(d.log.entries.length).toBe(1);
});

test("record actions are checked for shape", () => {
  const point = { point: { x: 1, y: 2 } };
  expect(recordProblem({ do: "thread", id: "t", anchor: point, text: "hi" })).toBe(null);
  expect(recordProblem({ do: "thread", id: "t", anchor: { stream: "notes", element: "n1", x: 0, y: 0 }, text: "hi" })).toBe(null);
  expect(recordProblem({ do: "react", id: "t", emoji: "👍", on: false })).toBe(null);
  for (const bad of [{ do: "like", id: "t" }, { do: "thread", id: "t", anchor: point, text: "" }, { do: "thread", id: "t", anchor: { point: { x: "1", y: 2 } }, text: "a" },
    { do: "thread", id: "t", anchor: { stream: "records", element: "e", x: 0, y: 0 }, text: "a" }, { do: "thread", id: "x".repeat(65), anchor: point, text: "a" },
    { do: "reply", id: "r", text: "a" }, { do: "react", id: "t", emoji: "👍" }, { do: "react", id: "t", emoji: "x".repeat(33), on: true }, { do: "move", id: "t" }, null])
    expect([bad, recordProblem(bad)?.code]).toEqual([bad, "bad-op"]);
  expect(recordProblem({ do: "edit", id: "c", text: "x".repeat(10_001) }).code).toBe("limit");
});
