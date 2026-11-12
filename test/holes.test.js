// Holes the convergence gate can't see, because its ops all come from long-lived replicas and touch().
import { test, expect } from "bun:test";
import { world, errors } from "./world.js";
import { makeElement, touch, clone } from "../packages/core/model.js";


test("a reloaded client reusing its name doesn't collide with its old op ids", () => {
  const w = world(["editor", "viewer"], 21);
  const c = w.clients[0];
  w.send(c, "board", { elements: [makeElement("rectangle", { id: "first" })] }); w.settle();
  c.r = w.replica("c0");                           // the page reloads: same name, counter back at 0
  w.drop(c); w.connect(c); w.settle();
  w.send(c, "board", { elements: [makeElement("rectangle", { id: "second" })] }); w.settle();
  expect(w.room.streams.board.get("second")).toBeTruthy();
  for (const x of w.clients) expect(x.r.streams.board.get("second")).toBeTruthy();
});

test("one user can't send ops under another client's id", () => {
  const w = world(["editor", "editor"], 22);
  w.settle();
  const [a, b] = w.clients;
  const m = w.send(a, "board", { elements: [makeElement("rectangle")] }); w.settle();
  w.raw(b, { t: "op", id: m.id, stream: "board", op: { elements: [makeElement("rectangle", { id: "spoof" })] } });
  expect(errors(b).at(-1).code).toBe("bad-op");
  expect(w.room.streams.board.get("spoof")).toBe(null);
});

test("elements without a versionNonce are refused (ties need one)", () => {
  const w = world(["editor"], 23);
  w.settle();
  const c = w.clients[0], el = makeElement("rectangle"); delete el.versionNonce;
  w.raw(c, { t: "op", id: `${c.r.client}:99`, stream: "board", op: { elements: [el] } });
  expect(errors(c).at(-1).code).toBe("bad-op");
});

test("a refused op is undone on the sender: it re-syncs to the room's state", () => {
  const w = world(["annotator", "editor"], 24);
  w.settle();
  const [ann, ed] = w.clients;
  w.send(ed, "board", { elements: [makeElement("rectangle", { id: "real" })], appState: { grid: 8 } }); w.settle();
  const bad = touch(clone(ann.r.streams.board.get("real"))); bad.x = 999;
  w.send(ann, "board", { elements: [bad], appState: { grid: 99 } });   // shown at once, then refused
  expect(ann.r.streams.board.get("real").x).toBe(999);
  w.settle();
  expect(ann.r.streams.board.get("real").x).toBe(w.room.streams.board.get("real").x);
  expect(ann.r.streams.board.appState.herdr.grid).toBe(8);
  expect(ann.r.state()).toEqual(ed.r.state());
});

test("hello for another board is refused; the role comes from the gateway, never the client; entries carry board and tenant", () => {
  const w = world(["editor"], 25);
  const c = w.clients[0];
  c.outbox = [];
  w.raw(c, { t: "hello", v: 1, token: "tok0", board: "other", since: 0, client: c.r.client });
  expect(errors(c).at(-1).code).toBe("auth");
  const loose = w.room.connect(m => c.inbox.push(m));          // a hello with no verified identity, claiming a role
  w.room.receive(loose, { t: "hello", v: 1, board: "b1", since: 0, client: "x", user: "u0", role: "owner" });
  expect(errors(c).at(-1).code).toBe("auth");
  expect(loose.user).toBe(null);
  w.drop(c); w.connect(c); w.settle();
  w.send(c, "board", { elements: [makeElement("rectangle")] }); w.settle();
  expect(w.log.entries[0]).toMatchObject({ board: "b1", tenant: "t1", by: "u0" });
});

test("no one can lock an element with a huge version", () => {
  const w = world(["editor", "editor"], 26);
  w.settle();
  const [a, b] = w.clients, el = makeElement("rectangle", { id: "lockme" });
  w.send(a, "board", { elements: [el] }); w.settle();
  const evil = clone(w.room.streams.board.get("lockme")); evil.version = Number.MAX_SAFE_INTEGER;
  w.raw(b, { t: "op", id: `${b.r.client}:1`, stream: "board", op: { elements: [evil] } });
  expect(errors(b).at(-1).code).toBe("bad-op");
  const ok = touch(clone(w.room.streams.board.get("lockme"))); ok.x = 5;
  w.send(a, "board", { elements: [ok] }); w.settle();
  expect(w.room.streams.board.get("lockme").x).toBe(5);
});

test("annotators change only their own notes; editors moderate everyone's", () => {
  const w = world(["annotator", "annotator", "editor"], 27);
  w.settle();
  const [a, b, ed] = w.clients;
  w.send(a, "notes", { elements: [makeElement("rectangle", { id: "mine" })] }); w.settle();
  const hijack = touch(clone(b.r.streams.notes.get("mine"))); hijack.isDeleted = true;
  w.send(b, "notes", { elements: [hijack] }); w.settle();
  expect(w.room.streams.notes.get("mine")).toBeTruthy();
  expect(b.r.state()).toEqual(a.r.state());                       // b's refused delete was undone on b
  const mod = touch(clone(ed.r.streams.notes.get("mine"))); mod.isDeleted = true;
  w.send(ed, "notes", { elements: [mod] }); w.settle();
  expect(w.room.streams.notes.get("mine")).toBe(null);
});

test("board settings are checked: unknown keys and bad values are refused", () => {
  const w = world(["editor"], 28);
  w.settle();
  const c = w.clients[0];
  let n = 0;
  for (const appState of [{ evil: 1 }, { grid: -5 }, { grid: "20" }, { layers: [] }, { layers: [{ id: "x" }] }, { snap: "yes" }, { timeline: { duration: Infinity } }]) {
    w.raw(c, { t: "op", id: `${c.r.client}:${++n}`, stream: "board", op: { appState } });
    expect([appState, errors(c).at(-1).code]).toEqual([appState, "bad-op"]);
  }
  w.send(c, "board", { appState: { grid: 20, snap: false, layers: [{ id: "base", name: "Layer 1", visible: true, locked: false, opacity: 100 }] } }); w.settle();
  expect(w.room.streams.board.appState.herdr.grid).toBe(20);
});

test("prototype keys in settings are refused, and don't crash the room", () => {
  const w = world(["editor"], 29);
  w.settle();
  const c = w.clients[0];
  let n = 0;
  for (const raw of ['{"__proto__":{"grid":1}}', '{"constructor":1}', '{"toString":1}']) {
    const appState = JSON.parse(raw);
    expect(() => w.raw(c, { t: "op", id: `${c.r.client}:${++n}`, stream: "board", op: { appState } })).not.toThrow();
    expect(errors(c).at(-1).code).toBe("bad-op");
  }
  expect(Object.getPrototypeOf(w.room.streams.board.appState.herdr)).toBe(Object.prototype);
});

test("annotators can't change the notes stream's settings", () => {
  const w = world(["annotator"], 30);
  w.settle();
  const c = w.clients[0];
  w.send(c, "notes", { appState: { grid: 40 } }); w.settle();
  expect(w.room.streams.notes.appState.herdr.grid).toBeUndefined();
  expect(c.r.streams.notes.appState.herdr.grid).toBeUndefined();   // undone on the sender too
});
