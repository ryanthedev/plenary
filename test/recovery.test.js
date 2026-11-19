// Phase 2's gate (PROTOCOL.md § Recovery, § Op ids): a room rebuilt from its log is the room it was.
import { test, expect } from "bun:test";
import { world, errors, direct, slowLog, tick } from "./world.js";
import { Room } from "../packages/protocol/room.js";
import { MemoryLog } from "../packages/protocol/ports.js";
import { W, H, EVICT_EVERY } from "../packages/protocol/envelope.js";
import { makeElement, clone } from "../packages/core/model.js";

const rect = (id, extra = {}) => makeElement("rectangle", { id, ...extra });
const point = { point: { x: 1, y: 2 } };

// A little of everything the log can hold: both element streams, settings, deletes, comments, reactions.
function busy(seed) {
  const w = world(["owner", "editor", "annotator", "commenter"], seed);
  const [owner, editor, annotator, commenter] = w.clients;
  w.settle();
  for (let i = 0; i < 12; i++) w.send(i % 2 ? owner : editor, "board", { elements: [rect(`b${i}`, { x: i })] });
  w.send(owner, "board", { appState: { grid: 20, snap: true } });
  w.send(annotator, "notes", { elements: [rect("note-a")] });
  w.send(editor, "notes", { elements: [rect("note-e")], appState: { grid: 5 } });
  w.settle();
  w.send(editor, "board", { elements: [{ ...clone(editor.r.streams.board.get("b3")), isDeleted: true }] });
  w.send(commenter, "records", { do: "thread", id: "t1", anchor: point, text: "first" });
  w.settle();
  w.send(annotator, "records", { do: "reply", id: "r1", thread: "t1", text: "reply" });
  w.send(owner, "records", { do: "react", id: "t1", emoji: "👍", on: true });
  w.send(editor, "records", { do: "resolve", id: "t1" });
  w.settle();
  return w;
}

for (const checkpoint of [false, true]) test(`a room rebuilt from the log ${checkpoint ? "and a checkpoint" : "alone"} equals the original`, () => {
  const w = busy(31);
  if (checkpoint) { w.room.checkpoint(); w.send(w.clients[0], "board", { elements: [rect("after")] }); w.send(w.clients[3], "records", { do: "reopen", id: "t1" }); w.settle(); }
  const before = clone(w.room.state()), old = w.room;
  expect(before.seq).toBeGreaterThan(18);
  expect(before.records.threads[0].comments.length).toBe(2);
  expect(before.clients.length).toBe(4);
  expect(before.noteAuthor).toEqual([["note-a", "u2"], ["note-e", "u1"]]);
  const room = w.rebuild();
  expect(room).not.toBe(old);
  expect(room.base.seq).toBe(checkpoint ? old.base.seq : 0);
  expect(room.tail.length).toBe(before.seq - room.base.seq);     // the kept tail = entries after the checkpoint
  expect(clone(room.state())).toEqual(before);
  expect(room.chars).toEqual(old.chars);
  expect(room.records.chars).toBe(old.records.chars);
  w.settle();
  for (const c of w.clients) expect(c.r.state().board).toEqual(w.clients[0].r.state().board);
});

test("an acked op resent to the rebuilt room gets the same ack and seq, and nothing is logged", () => {
  const w = world(["editor"], 32);
  w.settle();
  const c = w.clients[0], m = w.send(c, "board", { elements: [rect("once")] });
  w.settle();
  const seq = w.room.seq, logged = w.log.entries.length;
  expect(c.r.pending.size).toBe(0);
  for (const checkpoint of [false, true]) {
    w.rebuild({ checkpoint }); w.settle();
    c.inbox = [];
    w.raw(c, m);                                   // the same op, again
    expect(c.inbox).toEqual([{ t: "ack", id: m.id, seq: 1 }]);
    expect(w.room.seq).toBe(seq);
    expect(w.log.entries.length).toBe(logged);
  }
});

test("an annotator is still refused on another's note after a rebuild, even a deleted one", () => {
  const w = world(["annotator", "annotator", "editor"], 33);
  w.settle();
  const [a, b, ed] = w.clients;
  w.send(a, "notes", { elements: [rect("mine")] }); w.send(a, "notes", { elements: [rect("gone")] }); w.settle();
  w.send(ed, "notes", { elements: [{ ...clone(ed.r.streams.notes.getAny("gone")), isDeleted: true }] }); w.settle();
  for (const checkpoint of [false, true]) {
    w.rebuild({ checkpoint }); w.settle();
    const seq = w.room.seq;
    for (const id of ["mine", "gone"]) {
      w.raw(b, { t: "op", id: `${b.r.client}:${++b.r.counter}`, stream: "notes", op: { elements: [{ ...rect(id), version: 50 }] } });
      expect(errors(b).at(-1).code).toBe("forbidden");
    }
    expect(w.room.seq).toBe(seq);
    expect(w.room.streams.notes.get("mine")).toBeTruthy();
  }
});

test("no seq gap or reuse after a rebuild; a conditional append with a stale expectSeq throws conflict", () => {
  const w = world(["editor"], 34);
  w.settle();
  const c = w.clients[0];
  for (let i = 0; i < 5; i++) w.send(c, "board", { elements: [rect(`e${i}`)] });
  w.settle(); w.rebuild(); w.settle();
  w.send(c, "board", { elements: [rect("next")] }); w.settle();
  expect(w.log.entries.map(e => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(w.log.entries[5]).toMatchObject({ board: "b1", tenant: "t1", by: "u0", at: w.log.entries[5].at, rv: 1 });
  expect(typeof w.log.entries[5].at).toBe("number");
  const stale = { ...w.log.entries[5], seq: 6 };
  expect(() => w.log.append([stale], 5)).toThrow("the log ends at 6");
  let code; try { w.log.append([stale], 5); } catch (err) { code = err.code; }
  expect(code).toBe("conflict");
  expect(() => w.log.append([{ ...stale, seq: 9 }], 6)).toThrow();            // not the next seq
  expect(w.log.entries.length).toBe(6);
});

test("a room whose log moved under it (another host took over) stops: nothing acked, everyone hears unavailable", () => {
  const d = direct();
  const a = d.join("ua", "editor", "a");
  a.op(1, "board", { elements: [rect("x")] });
  d.log.append([{ ...d.log.entries[0], seq: 2, id: "other:1" }], 1);      // the other host's entry
  a.op(2, "board", { elements: [rect("y")] });
  expect(a.of("ack").length).toBe(1);
  expect(a.inbox.at(-1)).toMatchObject({ t: "error", id: "a:2", code: "unavailable" });
  expect(d.room.stopped).toBe(true);
  a.op(3, "board", { elements: [rect("z")] });
  expect(a.inbox.at(-1)).toMatchObject({ code: "unavailable" });
  expect(d.log.entries.length).toBe(2);
  const b = d.join("ub", "editor", "b");
  expect(b.inbox).toEqual([expect.objectContaining({ t: "error", code: "unavailable" })]);
});

test("a checkpoint that doesn't match the log, or is past its end, is skipped; a broken log refuses to start", () => {
  const w = busy(35);
  w.room.checkpoint();                                                    // a good one, at the current seq
  const good = w.room.base.seq;
  w.send(w.clients[0], "board", { elements: [rect("later")] }); w.settle();
  const want = clone(w.room.state());
  const cp = w.log.getCheckpoint();
  w.log.putCheckpoint({ ...cp, seq: good + 1, id: "someone-else:9" });    // from a fenced-off host: entry S differs
  w.log.putCheckpoint({ ...cp, seq: good + 500 });                        // past the log's end
  const room = w.rebuild({ keep: true });
  expect(w.reports.filter(r => r.what === "bad-checkpoint").map(r => r.seq)).toEqual([good + 500, good + 1]);
  expect(room.base.seq).toBe(good);
  expect(clone(room.state())).toEqual(want);
  // No usable checkpoint at all: start empty at 0 (M2 keeps the whole log).
  const log2 = new MemoryLog(); log2.entries = w.log.entries.slice();
  log2.putCheckpoint({ ...cp, at: -1 });
  expect(clone(Room.fromLog({ board: "b1", tenant: "t1", log: log2 }).state())).toEqual(want);
  // A gap, a repeated seq, or another board's entry is corruption.
  const all = w.log.entries;
  for (const broken of [[all[0], all[2]], [all[0], all[0]], [all[0], { ...all[1], board: "b2" }], [all[1]]])
    expect(() => Room.rebuild({ board: "b1", tenant: "t1", log: new MemoryLog(), entries: broken })).toThrow();
  let code; try { Room.rebuild({ board: "b1", tenant: "t1", log: new MemoryLog(), entries: [all[0], all[2]] }); } catch (err) { code = err.code; }
  expect(code).toBe("corrupt-log");
});

test("a rebuilt room answers unavailable to a connection it never welcomed; the op stays pending and lands once", () => {
  const w = world(["editor"], 36);
  w.settle();
  const c = w.clients[0];
  w.send(c, "board", { elements: [rect("a")] }); w.settle();
  w.rebuild({ keep: true });                       // the gateway still holds the old connection
  w.send(c, "board", { elements: [rect("b")] });
  w.flush(c);
  expect(errors(c).at(-1)).toMatchObject({ code: "unavailable", id: `${c.r.client}:2` });
  expect(w.room.seq).toBe(1);
  c.r.receive(errors(c).at(-1));
  expect(c.r.pending.size).toBe(1);
  expect(c.r.resync).toBe(true);
  expect(c.r.applied).toBe(1);                     // not a refusal: the copy is kept
  w.settle();
  expect(w.room.streams.board.get("b")).toBeTruthy();
  expect(w.log.entries.length).toBe(2);
  expect(c.r.pending.size).toBe(0);
});

test("a missing n is a lost message: unavailable, the connection is dropped, nothing is logged out of order", () => {
  const d = direct();
  const a = d.join("ua", "editor", "a");
  d.room.receive(a.c, { t: "op", id: "a:2", sentAt: 0, stream: "board", op: { elements: [rect("second")] } }, { n: 3 });   // n = 2 was lost
  expect(a.inbox.at(-1)).toMatchObject({ code: "unavailable", id: "a:2" });
  expect(a.c.closed).toBe(true);
  expect(d.room.conns.size).toBe(0);
  d.room.receive(a.c, { t: "op", id: "a:1", sentAt: 0, stream: "board", op: { elements: [rect("first")] } }, { n: 2 });
  expect(a.inbox.at(-1)).toMatchObject({ code: "unavailable" });
  expect(d.log.entries.length).toBe(0);
  const again = d.join("ua", "editor", "a");       // reconnects, resends in order
  again.op(1, "board", { elements: [rect("first")] }); again.op(2, "board", { elements: [rect("second")] });
  expect(d.log.entries.map(e => e.id)).toEqual(["a:1", "a:2"]);
  d.room.disconnect(again.c);                      // the close notice drops what the room kept for it
  expect(d.room.conns.size).toBe(0);
});

test("a second hello on a connection is refused and the connection closed", () => {
  const d = direct();
  const a = d.join("ua", "editor", "a");
  d.room.receive(a.c, { t: "hello", v: 1, board: "b1", since: 0, client: "a" }, { n: 2, user: "ua", role: "owner" });
  expect(a.inbox.at(-1)).toMatchObject({ t: "error", code: "bad-op" });
  expect(a.c.closed).toBe(true);
});

// ---- the op-id table (§ Op ids) ----

const small = { rules: { 1: { W: 4, H: 40, every: 8 } } };

test("the published bounds", () => { expect([W, H, EVICT_EVERY]).toEqual([256, 100_000, 1024]); });

test("more resends than the room remembers: the old ones get stale, the recent ones their ack; none is logged twice", () => {
  const d = direct(new MemoryLog(), small);
  const a = d.join("ua", "editor", "a");
  for (let i = 1; i <= 6; i++) a.op(i, "board", { elements: [rect(`e${i}`)] });
  expect(d.log.entries.length).toBe(6);
  const back = Room.fromLog({ board: "b1", tenant: "t1", log: d.log, ...small });   // and it survives a rebuild
  for (const room of [d.room, back]) {
    const inbox = [], c = room.connect(m => inbox.push(m));
    room.receive(c, { t: "hello", v: 1, board: "b1", since: 6, client: "a" }, { user: "ua", role: "editor" });
    expect(inbox[0]).toMatchObject({ t: "welcome", seq: 6, high: 6, horizon: 0 });
    for (let i = 1; i <= 6; i++) room.receive(c, { t: "op", id: `a:${i}`, sentAt: 0, stream: "board", op: { elements: [rect(`e${i}`)] } });
    expect(inbox.slice(1).map(m => m.code ?? m.seq)).toEqual(["stale", "stale", 3, 4, 5, 6]);
  }
  expect(d.log.entries.length).toBe(6);
  expect(back.clients.get("a:ua").recent.length).toBe(4);
});

test("a silent client is forgotten after H entries; its old op gets stale even if the eviction falls between welcome and resend", () => {
  const d = direct(new MemoryLog(), small);
  const a = d.join("ua", "editor", "a");
  a.op(1, "board", { elements: [rect("mine")] });                    // logged at seq 1; say the ack was lost
  const b = d.join("ub", "editor", "b");
  for (let i = 1; i <= 30; i++) b.op(i, "board", { elements: [rect(`b${i}`)] });
  const a2 = d.join("ua", "editor", "a", 1);                          // welcomed while still remembered
  expect(a2.inbox[0]).toMatchObject({ t: "welcome", high: 1, horizon: 0 });
  for (let i = 31; i <= 60; i++) b.op(i, "board", { elements: [rect(`b${i}`)] });   // …then the eviction tick passes
  expect(d.room.clients.has("a:ua")).toBe(false);
  expect(d.room.horizon).toBe(1);
  a2.op(1, "board", { elements: [rect("mine")] }, 0);                 // the resend: sentAt 0 < horizon
  expect(a2.inbox.at(-1)).toMatchObject({ t: "error", id: "a:1", code: "stale" });
  expect(d.log.entries.filter(e => e.id === "a:1").length).toBe(1);   // never logged twice
  expect(d.room.clients.get("b:ub").recent.length).toBe(4);           // pairs are bounded too
  a2.op(2, "board", { elements: [rect("new")] }, d.room.seq);         // an op made after the horizon is fine
  expect(a2.of("ack").at(-1)).toEqual({ t: "ack", id: "a:2", seq: 62 });
  const back = Room.fromLog({ board: "b1", tenant: "t1", log: d.log, ...small });   // replay evicts alike
  expect(clone(back.state())).toEqual(clone(d.room.state()));
  expect(back.horizon).toBe(1);
});

test("a forgotten client drops what it can't confirm, says how many, and resyncs; the op is in the log once", () => {
  const w = world(["editor", "editor"], 37, small);
  w.settle();
  const [a, b] = w.clients;
  w.send(a, "board", { elements: [rect("lost-ack")] });
  w.flush(a); w.drop(a);                                               // logged, but the ack never arrives
  expect(a.r.pending.size).toBe(1);
  for (let i = 0; i < 60; i++) { w.send(b, "board", { elements: [rect(`b${i}`)] }); w.settle(); }
  expect(w.room.horizon).toBe(1);
  w.connect(a); w.flush(a);
  const welcome = a.inbox.find(m => m.t === "welcome");
  expect(welcome).toMatchObject({ high: 0, horizon: 1 });
  const did = a.r.receive(welcome);
  expect(did).toMatchObject({ reset: true, dropped: [`${a.r.client}:1`] });
  expect([a.r.pending.size, a.r.unconfirmed, a.r.resync]).toEqual([0, 1, true]);
  w.settle();
  expect(a.r.state()).toEqual(b.r.state());
  expect(a.r.streams.board.get("lost-ack")).toBeTruthy();             // the resync shows it had landed
  expect(w.log.entries.filter(e => e.by === "u0").length).toBe(1);
});

// ---- resolved vs speculative (§ Recovery): a store that answers later ----

test("group commit: a resend of an in-flight op waits and gets the same seq; welcome, catch-up and checkpoints show only resolved state", async () => {
  const slow = slowLog(), d = direct(slow);
  const a = d.join("ua", "editor", "a");
  a.op(1, "board", { elements: [rect("one")] });
  a.op(2, "notes", { elements: [rect("two")] });
  a.op(3, "records", { do: "thread", id: "t1", anchor: point, text: "hi" });
  expect(slow.waiting.length).toBe(1);                                 // one append in flight; the rest queue behind it
  expect(slow.waiting[0].entries.map(e => e.seq)).toEqual([1]);
  expect(a.of("ack")).toEqual([]);
  a.op(1, "board", { elements: [rect("one")] });                       // a resend while it is in flight
  a.op(3, "records", { do: "thread", id: "t1", anchor: point, text: "hi" });   // and of one still queued
  expect(a.inbox.length).toBe(1);                                      // only the welcome: nothing is answered early
  const late = d.join("ub", "editor", "b");
  expect(late.inbox).toEqual([expect.objectContaining({ t: "welcome", seq: 0, high: 0 })]);
  const a2 = d.join("ua", "editor", "a");
  expect(a2.inbox[0]).toMatchObject({ seq: 0, high: 0 });              // high is the resolved one
  const cp = d.room.checkpoint();
  expect(cp.seq).toBe(0);
  expect([cp.streams.board.elements.length, cp.streams.notes.elements.length, cp.records.threads.length, cp.clients.list.length, cp.noteAuthor.length]).toEqual([0, 0, 0, 0, 0]);
  expect(d.room.seq).toBe(3);                                          // the speculative state is ahead
  slow.waiting.shift().land(); await tick();
  expect(a.of("ack")).toEqual([{ t: "ack", id: "a:1", seq: 1 }, { t: "ack", id: "a:1", seq: 1 }]);
  expect(slow.waiting[0].entries.map(e => e.seq)).toEqual([2, 3]);     // the group commit
  expect(late.of("entries").flatMap(m => m.entries).map(e => e.seq)).toEqual([1]);
  expect(d.join("ua", "editor", "a").inbox[0]).toMatchObject({ seq: 1, high: 1 });
  slow.waiting.shift().land(); await tick();
  expect(a.of("ack").map(m => [m.id, m.seq])).toEqual([["a:1", 1], ["a:1", 1], ["a:2", 2], ["a:3", 3], ["a:3", 3]]);
  expect(late.of("entries").flatMap(m => m.entries).map(e => e.seq)).toEqual([1, 2, 3]);
  expect(slow.log.entries.length).toBe(3);
  expect(clone(Room.fromLog({ board: "b1", tenant: "t1", log: slow.log }).state())).toEqual(clone(d.room.state()));
});

test("a failed append: nothing is acked or broadcast, the speculative state is dropped, held answers become unavailable", async () => {
  const slow = slowLog(), d = direct(slow);
  const a = d.join("ua", "annotator", "a"), b = d.join("ub", "annotator", "b"), e = d.join("ue", "editor", "e");
  a.op(1, "notes", { elements: [rect("note")] });                      // in flight
  e.op(1, "board", { elements: [rect("queued")] });                    // queued behind it
  a.op(1, "notes", { elements: [rect("note")] });                      // a resend, waiting for the append
  b.op(1, "notes", { elements: [{ ...rect("note"), version: 2 }] });   // refused because of an unresolved entry: held
  expect([a.inbox.length, b.inbox.length, e.inbox.length]).toEqual([1, 1, 1]);
  slow.waiting.shift().fail(new Error("disk full")); await tick();
  expect(d.room.stopped).toBe(true);
  for (const x of [a, b, e]) { expect(x.of("ack")).toEqual([]); expect(x.of("entries")).toEqual([]); }
  expect(a.inbox.slice(1).map(m => [m.id, m.code])).toEqual([["a:1", "unavailable"], ["a:1", "unavailable"]]);
  expect(b.inbox.slice(1).map(m => [m.id, m.code])).toEqual([["b:1", "unavailable"]]);   // not "forbidden": the note never became durable
  expect(e.inbox.slice(1).map(m => [m.id, m.code])).toEqual([["e:1", "unavailable"]]);
  expect(slow.waiting.length).toBe(0);                                 // the queued entry was never appended
  expect(slow.log.entries.length).toBe(0);
  const back = Room.fromLog({ board: "b1", tenant: "t1", log: slow.log });
  expect(back.seq).toBe(0);
  expect(back.streams.notes.get("note")).toBe(null);
  expect(back.noteAuthor.size).toBe(0);
});

test("a refusal that read an unresolved entry waits for it, then is sent", async () => {
  const slow = slowLog(), d = direct(slow);
  const a = d.join("ua", "annotator", "a"), b = d.join("ub", "annotator", "b");
  a.op(1, "notes", { elements: [rect("note")] });
  b.op(1, "notes", { elements: [{ ...rect("note"), version: 2 }] });
  b.op(2, "board", { elements: [rect("x")] });                         // role alone decides this one: answered at once
  expect(b.inbox.slice(1).map(m => [m.id, m.code])).toEqual([["b:2", "forbidden"]]);
  slow.waiting.shift().land(); await tick();
  expect(b.of("error").map(m => [m.id, m.code])).toEqual([["b:2", "forbidden"], ["b:1", "forbidden"]]);
});

test("checkpoints by itself every 1,000 entries, and a late joiner then gets a snapshot with records and note authors", () => {
  const d = direct(undefined, { foldBytes: Infinity });   // the entry-count rule alone (the byte rule has its own tests below)
  const a = d.join("ua", "editor", "a");
  a.op(1, "records", { do: "thread", id: "t1", anchor: point, text: "kept" });
  a.op(2, "notes", { elements: [rect("n1")] });
  for (let i = 3; i <= 1000; i++) a.op(i, "board", { elements: [rect(`e${i % 50}`, { version: i })] }, i - 1);
  expect(d.room.base.seq).toBe(1000);
  expect(d.log.getCheckpoint().seq).toBe(1000);
  expect(d.room.tail.length).toBe(0);
  a.op(1001, "board", { elements: [rect("after")] }, 1000);
  const late = d.join("ub", "viewer", "b");
  expect(late.inbox.map(m => m.t)).toEqual(["welcome", "snapshot", "entries"]);
  expect(late.inbox[0].high).toBeUndefined();                          // viewers send no ops
  const snap = late.inbox[1];
  expect(Object.keys(snap).sort()).toEqual(["appSeq", "noteAuthor", "records", "seq", "streams", "t"]);   // never the op-id table
  expect(snap.records.threads[0].comments[0].text).toBe("kept");
  expect(snap.noteAuthor).toEqual([["n1", "ua"]]);
  expect(d.join("uc", "viewer", "c", 1000).inbox.map(m => m.t)).toEqual(["welcome", "entries"]);
});

// § Recovery, "When": a join is the snapshot plus the tail, so the tail is bounded in bytes too, not only in entries.
const fat = (id, version, pad) => rect(id, { version, customData: { pad: "x".repeat(pad) } });
const sizeOf = room => room.chars.board + room.chars.notes + room.records.chars;

test("DW-1: a board folds once the tail holds foldBytes of ops, far short of 1,000 entries", () => {
  const d = direct(undefined, { foldBytes: 4_000 });
  const a = d.join("ua", "editor", "a");
  let i = 0;
  while (d.room.base.seq === 0 && i < 100) a.op(++i, "board", { elements: [fat("e0", i, 300)] }, i - 1);   // one shape rewritten (state ~400 chars)
  expect(d.room.base.seq).toBeGreaterThan(0);
  expect(d.room.base.seq).toBeLessThan(40);
  expect(d.log.getCheckpoint().seq).toBe(d.room.base.seq);
  expect(d.room.heartbeat().cp).toBe(d.room.base.seq);                    // announced once written
});

test("a fold is never taken before the tail is a quarter of the state's size, so its writes cost at most about 4x the log", () => {
  const d = direct(undefined, { foldBytes: 1_000 });
  const a = d.join("ua", "editor", "a");
  for (let i = 1; i <= 30; i++) a.op(i, "board", { elements: [fat("big" + i, 1, 2_000)] }, i - 1);   // 30 inserts: folds along the way
  const folds = d.log.checkpoints.length;
  expect(folds).toBeGreaterThan(2);
  for (const cp of d.log.checkpoints) expect(cp.seq).toBeGreaterThan(0);
  // Between two folds the tail was at least a quarter of the state of the later fold: total checkpoint bytes <= ~4x the log.
  const logBytes = d.log.entries.reduce((n, e) => n + JSON.stringify(e.op).length, 0);
  const cpBytes = d.log.checkpoints.reduce((n, cp) => n + JSON.stringify(cp).length, 0);
  expect(cpBytes).toBeLessThanOrEqual(5 * logBytes);
  expect(sizeOf(d.room)).toBeGreaterThan(50_000);
});

test("a tail under foldBytes does not fold, whatever its entry count (small boards are not rewritten per op)", () => {
  const d = direct(undefined, { foldBytes: 1_000_000 });
  const a = d.join("ua", "editor", "a");
  for (let i = 1; i <= 200; i++) a.op(i, "board", { elements: [rect("e0", { version: i })] }, i - 1);
  expect(d.room.base.seq).toBe(0);
  expect(d.log.getCheckpoint()).toBeNull();
});

test("a byte fold taken while later ops are still unresolved holds only resolved state; a rebuild from it equals the room", async () => {
  const slow = slowLog(), d = direct(slow, { foldBytes: 1_500 });
  const a = d.join("ua", "editor", "a");
  for (let i = 1; i <= 8; i++) a.op(i, "board", { elements: [fat("e" + i, 1, 400)] });   // 1 in flight, 7 queued
  slow.waiting.shift().land(); await tick();                           // 1 resolves; 2..8 go out as one append
  a.op(9, "board", { elements: [fat("e9", 1, 400)] }); a.op(10, "board", { elements: [fat("e10", 1, 400)] });   // queued behind it
  slow.waiting.shift().land(); await tick();                           // 2..8 resolve: ~3,200 chars of tail, due; 9 and 10 are unresolved
  expect(d.room.seq).toBe(10);
  expect(d.room.base.seq).toBe(8);                                     // folded at the resolved seq, not at 10
  expect(slow.log.getCheckpoint().seq).toBe(8);
  expect(slow.log.getCheckpoint().streams.board.elements.map(e => e.id).sort()).toEqual(["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"].sort());
  while (slow.waiting.length) { slow.waiting.shift().land(); await tick(); }
  expect(clone(Room.fromLog({ board: "b1", tenant: "t1", log: slow.log }).state())).toEqual(clone(d.room.state()));
});

test("after a rebuild, an old connection's op is refused unavailable, and its later resend of an earlier op is not stale", () => {
  const d = direct();
  const a = d.join("ua", "editor", "a");
  a.op(1, "board", { elements: [rect("one")] });
  const back = Room.fromLog({ board: "b1", tenant: "t1", log: d.log, now: () => 5 });
  // Ops 2 and 3 were in flight when the host died; 2 was lost, 3 reaches the new room on the old connection.
  back.receive(a.c, { t: "op", id: "a:3", sentAt: 1, stream: "board", op: { elements: [rect("three")] } }, { n: 57 });
  expect(a.inbox.at(-1)).toMatchObject({ code: "unavailable", id: "a:3" });
  expect(back.seq).toBe(1);                                             // never accepted: high stays 1
  const inbox = [], c = back.connect(m => inbox.push(m));
  back.receive(c, { t: "hello", v: 1, board: "b1", since: 1, client: "a" }, { n: 1, user: "ua", role: "editor" });
  expect(inbox[0]).toMatchObject({ t: "welcome", seq: 1, high: 1 });
  back.receive(c, { t: "op", id: "a:2", sentAt: 1, stream: "board", op: { elements: [rect("two")] } }, { n: 2 });
  back.receive(c, { t: "op", id: "a:3", sentAt: 1, stream: "board", op: { elements: [rect("three")] } }, { n: 3 });
  expect(inbox.filter(m => m.t === "ack").map(m => [m.id, m.seq])).toEqual([["a:2", 2], ["a:3", 3]]);   // not stale
});

test("close notices, a gateway's connection list and 30 s of gateway silence drop what the room kept; a 4 s append is a failure", async () => {
  let t = 0;
  const slow = slowLog(), room = new Room({ board: "b1", tenant: "t1", log: slow, now: () => t });
  const open = (gateway, id) => { const inbox = [], c = room.connect(m => inbox.push(m), { gateway, id }); room.receive(c, { t: "hello", v: 1, board: "b1", since: 0, client: id }, { n: 1, user: `u-${id}`, role: "editor" }); return { c, inbox }; };
  const a = open("g1", "a"), b = open("g1", "b"), c = open("g2", "c");
  expect(room.conns.size).toBe(3);
  room.listed("g1", ["b"]);                                             // g1 no longer lists a: its close notice was lost
  expect([a.c.closed, b.c.closed, c.c.closed, room.conns.size]).toEqual([true, false, false, 2]);
  room.receive(a.c, { t: "op", id: "a:1", sentAt: 0, stream: "board", op: { elements: [rect("x")] } }, { n: 2 });
  expect(a.inbox.at(-1).code).toBe("unavailable");
  t = 29_000; room.receive(c.c, { t: "nothing" }, { n: 2 });           // g2 is heard from; g1 stays silent
  t = 30_000; room.sweep();
  expect([b.c.closed, c.c.closed, room.conns.size]).toEqual([true, false, 1]);
  room.receive(c.c, { t: "op", id: "c:1", sentAt: 0, stream: "board", op: { elements: [rect("y")] } }, { n: 3 });
  t += 3999; room.sweep(); expect(room.stopped).toBe(false);
  t += 1; room.sweep();                                                 // the store never answered
  expect(room.stopped).toBe(true);
  expect(c.inbox.at(-1)).toMatchObject({ code: "unavailable", id: "c:1" });
  slow.waiting.shift().land(); await tick();                            // a late success changes nothing here: no ack
  expect(c.inbox.filter(m => m.t === "ack")).toEqual([]);
  expect(Room.fromLog({ board: "b1", tenant: "t1", log: slow.log }).seq).toBe(1);   // the rebuild settles that it landed
});
