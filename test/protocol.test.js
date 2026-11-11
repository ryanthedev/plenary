// The room's rules (PROTOCOL.md): roles per stream, idempotent resends, catch-up, no pictures in ops,
// previews never logged.
import { test, expect } from "bun:test";
import { world } from "./world.js";
import { makeElement } from "../packages/core/model.js";

const errors = c => c.inbox.filter(m => m.t === "error");

test("roles: viewers write nothing, annotators only notes, editors both", () => {
  const w = world(["viewer", "annotator", "editor"], 3);
  w.settle();
  const [viewer, annotator, editor] = w.clients;
  for (const [c, stream] of [[viewer, "board"], [viewer, "notes"], [annotator, "board"]]) {
    w.room.receive(c.conn, { t: "op", id: `${c.r.client}:x-${stream}`, stream, op: { elements: [makeElement("rectangle")] } });
    expect(errors(c).at(-1).code).toBe("forbidden");
  }
  w.send(annotator, "notes", { elements: [makeElement("rectangle")] });
  w.send(editor, "board", { elements: [makeElement("rectangle")] });
  w.settle();
  expect(w.room.seq).toBe(2);
});

test("a resend after a lost ack is acked again, not logged twice", () => {
  const w = world(["editor"], 5);
  w.settle();
  const c = w.clients[0], m = w.send(c, "board", { elements: [makeElement("rectangle")] });
  w.room.receive(c.conn, m);                 // reaches the room…
  w.drop(c);                                 // …but the ack is lost with the connection
  expect(c.r.pending.size).toBe(1);
  w.connect(c); w.settle();                  // hello + the same op id again
  expect(w.room.seq).toBe(1);
  expect(w.log.entries.length).toBe(1);
  expect(c.r.pending.size).toBe(0);
});

test("catch-up: only the missing entries, or a snapshot when the log was folded", () => {
  const w = world(["editor", "editor"], 7);
  w.settle();
  const [a, b] = w.clients;
  w.drop(b);
  for (let i = 0; i < 20; i++) w.send(a, "board", { elements: [makeElement("rectangle", { x: i })] });
  w.settle();
  w.connect(b); w.room.receive(b.conn, b.outbox.shift());   // deliver the hello
  expect(b.inbox.some(m => m.t === "snapshot")).toBe(false);
  expect(b.inbox.filter(m => m.t === "entries").flatMap(m => m.entries).length).toBe(20);
  w.settle();
  w.drop(b);
  for (let i = 0; i < 5; i++) w.send(a, "board", { elements: [makeElement("rectangle")] });
  w.settle(); w.room.compact();
  w.connect(b); w.room.receive(b.conn, b.outbox.shift());
  expect(b.inbox.some(m => m.t === "snapshot")).toBe(true);
  w.settle();
  expect(b.r.streams.board.live().length).toBe(25);
});

test("pictures travel by id, never inside an op; bad ops are refused with a reason", () => {
  const w = world(["editor"], 8);
  w.settle();
  const c = w.clients[0];
  w.room.receive(c.conn, { t: "op", id: "c0:f", stream: "board", op: { files: { abc: { dataURL: "data:image/png;base64,AAAA" } } } });
  expect(errors(c).at(-1).code).toBe("no-files");
  w.room.receive(c.conn, { t: "op", id: "c0:e", stream: "board", op: { elements: [{ id: "x" }] } });
  expect(errors(c).at(-1).code).toBe("bad-op");
  w.room.receive(c.conn, { t: "op", id: "c0:s", stream: "secret", op: { elements: [] } });
  expect(errors(c).at(-1).code).toBe("bad-op");
  expect(w.room.seq).toBe(0);
});

test("previews are relayed to others and never logged or applied", () => {
  const w = world(["editor", "viewer"], 10);
  w.settle();
  const [ed, viewer] = w.clients, el = makeElement("rectangle", { id: "drag" });
  w.send(ed, "board", { elements: [el] }, { transient: true });
  w.settle();
  expect(w.room.seq).toBe(0);
  expect(w.room.streams.board.get("drag")).toBe(null);
  expect(viewer.r.previews.has("drag")).toBe(true);
  expect(viewer.r.streams.board.get("drag")).toBe(null);
});

test("no hello, no ops; a refused token gets nothing", () => {
  const w = world(["editor"], 12);
  const c = w.clients[0];
  w.room.receive(c.conn, { t: "op", id: "c0:1", stream: "board", op: { elements: [makeElement("rectangle")] } });
  expect(errors(c).at(-1).code).toBe("auth");
  w.room.receive(c.conn, { t: "hello", token: "nope", board: "b1", since: 0, client: "c0" });
  expect(errors(c).at(-1).code).toBe("auth");
});
