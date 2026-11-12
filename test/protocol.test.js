// The room's rules (PROTOCOL.md): roles per stream, idempotent resends, catch-up, no pictures in ops,
// previews never logged.
import { test, expect } from "bun:test";
import { world, errors } from "./world.js";
import { makeElement } from "../packages/core/model.js";

test("roles: viewers write nothing, annotators only notes, editors both", () => {
  const w = world(["viewer", "annotator", "editor"], 3);
  w.settle();
  const [viewer, annotator, editor] = w.clients;
  let n = 100;
  for (const [c, stream] of [[viewer, "board"], [viewer, "notes"], [annotator, "board"]]) {
    w.raw(c, { t: "op", id: `${c.r.client}:${++n}`, stream, op: { elements: [makeElement("rectangle")] } });
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
  w.flush(c);                                // reaches the room…
  expect(w.room.seq).toBe(1);
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
  w.connect(b); w.flush(b);                                 // deliver the hello
  expect(b.inbox.some(m => m.t === "snapshot")).toBe(false);
  expect(b.inbox.filter(m => m.t === "entries").flatMap(m => m.entries).length).toBe(20);
  w.settle();
  w.drop(b);
  for (let i = 0; i < 5; i++) w.send(a, "board", { elements: [makeElement("rectangle")] });
  w.settle(); w.room.checkpoint();
  w.connect(b); w.flush(b);
  expect(b.inbox.some(m => m.t === "snapshot")).toBe(true);
  w.settle();
  expect(b.r.streams.board.live().length).toBe(25);
});

test("pictures travel by id, never inside an op; bad ops are refused with a reason", () => {
  const w = world(["editor"], 8);
  w.settle();
  const c = w.clients[0];
  w.raw(c, { t: "op", id: `${c.r.client}:1`, stream: "board", op: { files: { abc: { dataURL: "data:image/png;base64,AAAA" } } } });
  expect(errors(c).at(-1).code).toBe("no-files");
  w.raw(c, { t: "op", id: `${c.r.client}:2`, stream: "board", op: { elements: [{ id: "x" }] } });
  expect(errors(c).at(-1).code).toBe("bad-op");
  w.raw(c, { t: "op", id: `${c.r.client}:3`, stream: "secret", op: { elements: [] } });
  expect(errors(c).at(-1).code).toBe("bad-op");
  expect(w.room.seq).toBe(0);
});

test("previews are presence: shown over the board, never an op, never logged; a room refuses presence", () => {
  const w = world(["editor", "viewer"], 10);
  w.settle();
  const [ed, viewer] = w.clients, el = makeElement("rectangle", { id: "drag" });
  const before = ed.r.counter, m = ed.r.preview("board", [el]);
  expect(m).toMatchObject({ t: "presence", k: "preview", stream: "board" });
  expect(ed.r.counter).toBe(before);                         // no op counter used
  expect(ed.r.pending.size).toBe(0);
  w.raw(ed, m);                                              // a gateway relays presence; the room never takes it
  expect(errors(ed).at(-1).code).toBe("bad-op");
  expect(w.room.seq).toBe(0);
  expect(w.log.entries.length).toBe(0);
  viewer.r.receive({ t: "presence", batch: [{ user: "u0", client: ed.r.client, ...m, t: undefined }] });   // as a gateway would relay it
  expect(viewer.r.previews.has("drag")).toBe(true);
  expect(viewer.r.streams.board.get("drag")).toBe(null);
  w.send(ed, "board", { elements: [el] }); w.settle();        // the final op's entry clears the preview
  expect(viewer.r.previews.has("drag")).toBe(false);
  expect(viewer.r.streams.board.get("drag")).toBeTruthy();
});

test("no hello, no ops; a refused token never reaches the room", () => {
  const w = world(["editor"], 12);
  const c = w.clients[0];
  c.outbox = [];                                              // the hello is never sent
  w.raw(c, { t: "op", id: `${c.r.client}:1`, stream: "board", op: { elements: [makeElement("rectangle")] } });
  expect(errors(c).at(-1).code).toBe("auth");
  w.raw(c, { t: "hello", v: 1, token: "nope", board: "b1", since: 0, client: "c0" });   // the gateway stand-in refuses it
  expect(errors(c).at(-1).code).toBe("auth");
  expect(c.conn.user).toBe(null);
  expect(w.room.seq).toBe(0);
});

test("an unknown protocol version is refused with `version`, and the client stops", () => {
  const w = world(["editor"], 13);
  const c = w.clients[0];
  c.outbox = [];
  w.raw(c, { t: "hello", v: 2, token: "tok0", board: "b1", since: 0, client: "c0" });
  expect(errors(c).at(-1).code).toBe("version");
  expect(c.conn.closed).toBe(true);
  c.r.receive(errors(c).at(-1));
  expect(c.r.stopped).toBe("version");
  expect(c.r.outgoing()).toEqual([]);
});
