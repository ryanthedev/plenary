// M1's gate: every copy that applies the room's log ends in the same state, whatever the network does.
// Several replicas edit at once (elements, deletes, appState, notes, pictures by id); the room's messages
// arrive shuffled and duplicated; clients drop their connection and come back with a resend.
import { test, expect } from "bun:test";
import { world } from "./world.js";
import { canWrite } from "../packages/protocol/envelope.js";
import { makeElement, touch, clone } from "../packages/core/model.js";

const roomState = room => { const out = { applied: room.seq }; for (const s of ["board", "notes"]) { const d = room.streams[s]; out[s] = { elements: [...d.byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), appState: d.appState.herdr }; } return out; };

// One random edit a client is allowed to make.
function edit(w, c) {
  const stream = canWrite(c.role, "board") && w.rng() < 0.7 ? "board" : "notes";
  if (!canWrite(c.role, stream)) return;
  const doc = c.r.streams[stream], live = [...doc.byId.values()].filter(e => !e.isDeleted), roll = w.rng();
  if (stream === "board" && roll < 0.12) return w.send(c, stream, { appState: { grid: Math.floor(w.rng() * 40), snap: w.rng() < 0.5 } });
  if (!live.length || roll < 0.4) {
    const type = w.rng() < 0.15 ? "image" : "rectangle";
    const el = makeElement(type, { x: Math.floor(w.rng() * 500), y: Math.floor(w.rng() * 500), width: 80, height: 60, ...(type === "image" ? { fileId: "a".repeat(40) } : {}) });
    return w.send(c, stream, { elements: [el] });
  }
  const el = clone(live[Math.floor(w.rng() * live.length)]);
  if (roll < 0.55) el.isDeleted = true; else el.x += Math.floor(w.rng() * 50) - 25;
  w.send(c, stream, { elements: [touch(el)] });
}

for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) test(`replicas converge under shuffled, duplicated delivery and reconnects (seed ${seed})`, () => {
  const w = world(["owner", "editor", "editor", "annotator", "viewer"], seed);
  for (let round = 0; round < 400; round++) {
    const c = w.clients[Math.floor(w.rng() * w.clients.length)];
    if (w.rng() < 0.6) edit(w, c);
    if (w.rng() < 0.02 && c.conn) w.drop(c);                    // the phone goes to sleep
    if (!c.conn && w.rng() < 0.3) w.connect(c);                // and wakes up
    for (let k = 0; k < 3; k++) w.step();
    if (round === 200) w.room.compact();                       // later joiners start from a snapshot
  }
  for (const c of w.clients) if (!c.conn) w.connect(c);
  w.settle();
  const want = roomState(w.room);
  expect(want.applied).toBeGreaterThan(50);
  expect(want.board.elements.length).toBeGreaterThan(5);
  expect(want.notes.elements.length).toBeGreaterThan(0);
  for (const c of w.clients) {
    expect(c.r.pending.size).toBe(0);
    expect(c.r.state()).toEqual(want);
  }
  expect(w.log.entries.length).toBe(w.room.seq);               // every seq logged exactly once
});

test("two editors change the same element at the same version: every copy keeps the same winner", () => {
  const w = world(["editor", "editor", "viewer"], 9);
  const el = makeElement("rectangle", { id: "shared" });
  w.send(w.clients[0], "board", { elements: [el] }); w.settle();
  const a = touch(clone(w.clients[0].r.streams.board.get("shared"))); a.x = 100;
  const b = touch(clone(w.clients[1].r.streams.board.get("shared"))); b.x = 200;
  expect(a.version).toBe(b.version);
  w.send(w.clients[0], "board", { elements: [a] }); w.send(w.clients[1], "board", { elements: [b] }); w.settle();
  const x = w.room.streams.board.get("shared").x;
  expect(x).toBe(a.versionNonce < b.versionNonce ? 100 : 200);
  for (const c of w.clients) expect(c.r.streams.board.get("shared").x).toBe(x);
});

test("appState keys follow the room's order, not arrival order; a client's own patch shows until acked", () => {
  const w = world(["editor", "editor", "viewer"], 11);
  w.send(w.clients[0], "board", { appState: { grid: 10 } });
  w.send(w.clients[1], "board", { appState: { grid: 20 } });
  expect(w.clients[0].r.streams.board.appState.herdr.grid).toBe(10);   // optimistic
  w.settle();
  const g = w.room.streams.board.appState.herdr.grid;
  for (const c of w.clients) expect(c.r.streams.board.appState.herdr.grid).toBe(g);
});
