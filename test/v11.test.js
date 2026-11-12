// PROTOCOL.md v1.1: op size in UTF-8 bytes, depth 62, settings compare-and-set (`appBase`, `stale-setting`),
// room identity (`welcome.room`, epochs), mixed changes split, seeding with kept versions, op frames' head.
import { test, expect } from "bun:test";
import { direct, world, slowLog, tick, errors } from "./world.js";
import { Room } from "../packages/protocol/room.js";
import { Replica } from "../packages/protocol/replica.js";
import { MemoryLog } from "../packages/protocol/ports.js";
import { jsonCodec, frameOpId } from "../packages/protocol/codec.js";
import {
  opProblem, utf8Bytes, MAX_OP_BYTES, MAX_OP_DEPTH, MAX_FRAME_DEPTH, APPEND_TIMEOUT_MS, MAX_WRITER_CONNS, PING_IDLE_MS, CONN_SILENCE_MS,
} from "../packages/protocol/envelope.js";
import { makeElement, clone } from "../packages/core/model.js";

const rect = (id, extra = {}) => makeElement("rectangle", { id, ...extra });
const wire = m => jsonCodec.decode(jsonCodec.encode(m));
const layer = (id, name = id) => ({ id, name, visible: true, locked: false, opacity: 100 });

/** A replica on an ordered link to a room (as in replica.test.js): open, up (send what is due), down (deliver). */
function link(d, clock, user = "u1", role = "editor", name = "c", board = "b1") {
  const l = { r: new Replica({ client: name, now: () => clock.t, random: () => 0 }), inbox: [], c: null, n: 0, did: [] };
  l.open = (room = d.room) => {
    if (l.c) d.room.disconnect(l.c);
    l.inbox = []; l.n = 0; l.c = room.connect(m => l.inbox.push(wire(m)));
    const [hello] = l.r.connectMessages("tok", board);
    room.receive(l.c, wire(hello), { n: ++l.n, user, role });
    return l;
  };
  l.up = () => { const out = l.r.outgoing(); for (const m of out) d.room.receive(l.c, wire(m), { n: ++l.n }); return out; };
  l.down = () => { const got = l.inbox; l.inbox = []; for (const m of got) l.did.push(l.r.receive(m)); return got; };
  l.sync = () => { for (let i = 0; i < 10; i++) { l.down(); l.up(); } l.down(); return l; };
  l.all = key => l.did.flatMap(x => x[key]);
  return l;
}

// ---- envelope, codec, ports ----

test("v1.1 constants", () => {
  expect([MAX_OP_BYTES, MAX_OP_DEPTH, MAX_FRAME_DEPTH, APPEND_TIMEOUT_MS, MAX_WRITER_CONNS, PING_IDLE_MS, CONN_SILENCE_MS])
    .toEqual([1_000_000, 62, 64, 4000, 8, 10_000, 30_000]);
});

test("utf8Bytes counts like an encoder: ASCII 1, Latin 2, CJK 3, astral 4, a lone surrogate 3", () => {
  for (const s of ["", "abc", "é", "日本語", "😀", "a😀b", "\u{10ffff}", "x߿ࠀ", JSON.stringify({ t: "日\ud800x" })])
    expect([s, utf8Bytes(s)]).toEqual([s, Buffer.byteLength(s, "utf8")]);
  expect(utf8Bytes("\ud800")).toBe(3);       // lone high surrogate
  expect(utf8Bytes("\udc00x")).toBe(4);      // lone low surrogate, then ASCII
});

test("the op cap is in UTF-8 bytes: 400k CJK chars (1.2 MB) are too-large, 990k ASCII chars pass", () => {
  const op = text => ({ t: "op", id: "c:1", sentAt: 0, stream: "board", op: { elements: [rect("t", { type: "text", text })] } });
  const cjk = op("日".repeat(400_000));
  expect(JSON.stringify(cjk.op).length).toBeLessThan(MAX_OP_BYTES);   // under the cap in chars…
  expect(opProblem(cjk)).toMatchObject({ code: "too-large" });       // …but not in bytes
  expect(opProblem(op("x".repeat(990_000)))).toBe(null);
  expect(opProblem(op("x".repeat(1_000_000))).code).toBe("too-large");
  const d = direct(), a = d.join("ua", "editor", "a");
  a.op(1, "board", cjk.op);
  expect(a.inbox.at(-1)).toMatchObject({ t: "error", id: "a:1", code: "too-large" });
  expect(d.log.entries.length).toBe(0);
});

test("the byte cap's boundary: exactly MAX_OP_BYTES passes, one byte more is too-large", () => {
  const el = rect("t", { type: "text", version: 1, versionNonce: 1 });   // built once: its random seed changes its length
  const op = text => ({ t: "op", id: "c:1", sentAt: 0, stream: "board", op: { elements: [{ ...el, text }] } });
  const overhead = utf8Bytes(JSON.stringify(op("").op)), fill = MAX_OP_BYTES - overhead;
  expect(utf8Bytes(JSON.stringify(op("x".repeat(fill)).op))).toBe(MAX_OP_BYTES);
  expect(opProblem(op("x".repeat(fill)))).toBe(null);
  expect(opProblem(op("x".repeat(fill + 1))).code).toBe("too-large");
  expect(opProblem(op("é" + "x".repeat(fill - 1))).code).toBe("too-large");   // same chars, one more byte
});

test("appBase shape: same keys as appState, integers ≥ 0; no base without settings; no elements with settings", () => {
  const m = op => ({ t: "op", id: "c:1", sentAt: 0, stream: "board", op });
  expect(opProblem(m({ appState: { grid: 10 }, appBase: { grid: 0 } }))).toBe(null);
  expect(opProblem(m({ appState: { grid: 10, snap: true }, appBase: { grid: 3, snap: 0 } }))).toBe(null);
  for (const op of [
    { appState: { grid: 10 } },                                    // no base
    { appState: { grid: 10 }, appBase: {} },                       // missing key
    { appState: { grid: 10 }, appBase: { grid: 0, snap: 0 } },     // extra key
    { appState: { grid: 10 }, appBase: { snap: 0 } },              // wrong key
    { appState: { grid: 10 }, appBase: { grid: -1 } },
    { appState: { grid: 10 }, appBase: { grid: 1.5 } },
    { appState: { grid: 10 }, appBase: { grid: "0" } },
    { appState: { grid: 10 }, appBase: [0] },
    { elements: [rect("x")], appBase: { grid: 0 } },               // a base with no settings
    { elements: [rect("x")], appState: { grid: 1 }, appBase: { grid: 0 } },   // mixed
    { elements: [], appState: { grid: 1 }, appBase: { grid: 0 } },            // mixed, even empty
  ]) expect([op, opProblem(m(op))?.code]).toEqual([op, "bad-op"]);
  expect(opProblem(m({ appState: { evil: 1 }, appBase: { evil: 0 } })).message).toContain("unknown board setting");   // the value check comes first
});

test("an op frame starts {\"t\":\"op\",\"id\": whatever order its keys were built in; a gateway can read the id from the head", () => {
  const text = jsonCodec.encode({ sentAt: 3, stream: "board", op: { elements: [] }, id: "web.x:7", t: "op" });
  expect(text.startsWith('{"t":"op","id":"web.x:7",')).toBe(true);
  expect(JSON.parse(text)).toEqual({ t: "op", id: "web.x:7", sentAt: 3, stream: "board", op: { elements: [] } });
  expect(frameOpId(text)).toBe("web.x:7");
  expect(frameOpId(text + "[".repeat(100))).toBe("web.x:7");                // a frame too deep to decode still names its op
  expect([frameOpId('{"t":"hello"}'), frameOpId('{"id":"a:1","t":"op"}'), frameOpId(null)]).toEqual([null, null, null]);
  expect(jsonCodec.encode({ t: "hello", v: 1 })).toBe('{"t":"hello","v":1}');
  const r = new Replica({ client: "c" }); r.connectMessages("tok", "b1"); r.receive({ t: "welcome", seq: 0, role: "editor", user: "u", high: 0, horizon: 0, rv: 1 });
  r.local("board", { elements: [rect("x")] });
  expect(jsonCodec.encode(r.outgoing()[0]).startsWith(`{"t":"op","id":"${r.client}:1",`)).toBe(true);
});

test("MemoryLog epochs: 0 before any room, then +1 per build", () => {
  const log = new MemoryLog();
  expect(log.epoch()).toBe(0);
  expect([log.openEpoch(), log.openEpoch(), log.epoch()]).toEqual([1, 2, 2]);
});

// ---- room identity ----

test("every welcome names the room: board and epoch; the epoch rises on every rebuild; the heartbeat is { resolved seq, epoch }", () => {
  const w = world(["editor", "viewer"], 3);
  w.settle();
  expect(w.room.epoch).toBe(1);
  w.send(w.clients[0], "board", { elements: [rect("a")] }); w.settle();
  const epochs = [w.room.epoch];
  for (let i = 0; i < 3; i++) { w.rebuild({ checkpoint: i === 1 }); epochs.push(w.room.epoch); }
  expect(epochs).toEqual([1, 2, 3, 4]);
  expect(w.log.epoch()).toBe(4);
  // A fresh hello on the latest room: writer and viewer alike see { board, epoch }.
  const d = { room: w.room }, clock = { t: 0 };
  const ed = link(d, clock, "u0", "editor", "x").open(), vw = link(d, clock, "u1", "viewer", "y").open();
  expect(ed.inbox[0]).toMatchObject({ t: "welcome", high: 0, room: { board: "b1", epoch: 4 } });
  expect(vw.inbox[0].room).toEqual({ board: "b1", epoch: 4 });
  expect(w.room.heartbeat()).toEqual({ seq: 1, epoch: 4 });
});

test("the heartbeat names the resolved seq, not the speculative one", async () => {
  const slow = slowLog(), d = direct(slow, { epoch: 7 }), a = d.join("ua", "editor", "a");
  a.op(1, "board", { elements: [rect("x")] });
  expect([d.room.seq, d.room.heartbeat()]).toEqual([1, { seq: 0, epoch: 7 }]);
  slow.waiting.shift().land(); await tick();
  expect(d.room.heartbeat()).toEqual({ seq: 1, epoch: 7 });
  expect(Room.fromLog({ board: "b1", tenant: "t1", log: slow.log }).epoch).toBe(1);   // the MemoryLog's own count
});

test("a writer's welcome from a lower epoch closes and reconnects (a failed attempt); a viewer's is only recorded", () => {
  const log = new MemoryLog(), clock = { t: 0 };
  const d = { room: new Room({ board: "b1", tenant: "t1", log, now: () => 5, epoch: 5 }) };
  const a = link(d, clock, "u1", "editor", "a").open().sync();
  expect([a.r.epochSeen, a.r.epoch, a.r.welcomed]).toEqual([5, 5, true]);
  // A stale host (epoch 4) welcomes it: not welcomed, reconnect with backoff.
  d.room = new Room({ board: "b1", tenant: "t1", log, now: () => 5, epoch: 4 });
  a.open(); a.down();
  expect([a.r.welcomed, a.r.resync, a.r.fails]).toEqual([false, true, 1]);
  expect(a.r.outgoing()).toEqual([]);
  // The right host again: welcomed.
  d.room = Room.fromLog({ board: "b1", tenant: "t1", log, now: () => 5, epoch: 6 });
  a.open().sync();
  expect([a.r.welcomed, a.r.resync, a.r.epochSeen]).toEqual([true, false, 6]);
  // A viewer meets a lagging gateway-built welcome: recorded, never a reconnect.
  const v = link(d, clock, "u2", "viewer", "v").open().sync();
  expect([v.r.epoch, v.r.epochSeen]).toEqual([6, 0]);
  d.room = new Room({ board: "b1", tenant: "t1", log, now: () => 5, epoch: 2 });
  v.open().sync();
  expect([v.r.welcomed, v.r.resync, v.r.epoch]).toEqual([true, false, 2]);
});

test("a welcome naming another board closes and reconnects", () => {
  const d = { room: new Room({ board: "b2", tenant: "t1", log: new MemoryLog(), now: () => 5 }) }, clock = { t: 0 };
  const r = new Replica({ client: "c", now: () => clock.t, random: () => 0 });
  r.connectMessages("tok", "b1");
  r.receive({ t: "welcome", seq: 0, role: "editor", user: "u1", high: 0, horizon: 0, rv: 1, room: { board: "b2", epoch: 1 } });
  expect([r.welcomed, r.resync, r.fails]).toEqual([false, true, 1]);
  expect(d.room.board).toBe("b2");
});

test("a higher epoch whose welcome.seq is below what the client applied: the Store lost entries, so resync from 0", () => {
  const log = new MemoryLog(), clock = { t: 0 };
  const d = { room: new Room({ board: "b1", tenant: "t1", log, now: () => 5, epoch: 1 }) };
  const a = link(d, clock).open().sync();
  for (const id of ["x", "y", "z"]) a.r.local("board", { elements: [rect(id)] });
  a.sync();
  expect(a.r.applied).toBe(3);
  // The new host's Store kept only the first entry.
  const lost = new MemoryLog(); lost.append(log.entries.slice(0, 1), 0);
  d.room = Room.fromLog({ board: "b1", tenant: "t1", log: lost, now: () => 5, epoch: 2 });
  a.open(); a.down();
  expect([a.r.resync, a.r.applied, a.r.epochSeen, a.r.fails]).toEqual([true, 0, 2, 0]);
  expect(a.did.at(-1).reset).toBe(true);
  a.open().sync();
  expect([a.r.applied, a.r.streams.board.getAny("z")]).toEqual([1, null]);
  // Settings after the loss are based on what the room has now, not on acked seqs it lost.
  a.r.local("board", { appState: { grid: 3 } }); a.sync();
  expect(lost.entries.at(-1).op).toEqual({ appState: { grid: 3 }, appBase: { grid: 0 } });
  // A higher epoch with no regression is a normal rebuild.
  d.room = Room.fromLog({ board: "b1", tenant: "t1", log: lost, now: () => 5, epoch: 3 });
  a.open(); a.down();
  expect([a.r.resync, a.r.welcomed, a.r.applied]).toEqual([false, true, 2]);
});

test("a welcome with no room (a pre-v1.1 server) is accepted unchecked", () => {
  const r = new Replica({ client: "c" });
  r.connectMessages("tok", "b1");
  r.receive({ t: "welcome", seq: 0, role: "editor", user: "u1", high: 0, horizon: 0, rv: 1 });
  expect([r.welcomed, r.resync, r.epoch]).toEqual([true, false, null]);
});

// ---- settings compare-and-set: the room ----

test("concurrent settings: one winner; the other gets a soft stale-setting and nothing is logged", () => {
  const d = direct(), a = d.join("ua", "editor", "a"), b = d.join("ub", "editor", "b");
  a.op(1, "board", { appState: { layers: [layer("one")] }, appBase: { layers: 0 } });
  b.op(1, "board", { appState: { layers: [layer("two")] }, appBase: { layers: 0 } });
  expect(a.of("ack")).toEqual([{ t: "ack", id: "a:1", seq: 1 }]);
  expect(b.of("error").at(-1)).toMatchObject({ t: "error", id: "b:1", code: "stale-setting" });
  expect(d.log.entries.length).toBe(1);
  expect(d.room.streams.board.appState.herdr.layers).toEqual([layer("one")]);
  // A resend of the accepted op meets the op-id table first: its ack, not a stale-setting against its own seq.
  a.op(1, "board", { appState: { layers: [layer("one")] }, appBase: { layers: 0 } });
  expect(a.inbox.at(-1)).toEqual({ t: "ack", id: "a:1", seq: 1 });
  // b on the current base: accepted.
  b.op(2, "board", { appState: { layers: [layer("two")] }, appBase: { layers: 1 } });
  expect(b.of("ack").at(-1)).toEqual({ t: "ack", id: "b:2", seq: 2 });
  // All or nothing: one stale key refuses the whole op.
  a.op(2, "board", { appState: { grid: 5, layers: [layer("x")] }, appBase: { grid: 0, layers: 1 } });
  expect(a.of("error").at(-1)).toMatchObject({ code: "stale-setting", id: "a:2" });
  expect([d.log.entries.length, d.room.streams.board.appState.herdr.grid]).toEqual([2, undefined]);
  expect(d.room.appSeq.board).toEqual({ layers: 2 });
});

test("a deliberate revert (current base) is accepted; a stale save of the same old value is refused", () => {
  const d = direct(), a = d.join("ua", "editor", "a"), b = d.join("ub", "editor", "b");
  a.op(1, "board", { appState: { grid: 10 }, appBase: { grid: 0 } });   // seq 1
  a.op(2, "board", { appState: { grid: 20 }, appBase: { grid: 1 } });   // seq 2
  b.op(1, "board", { appState: { grid: 10 }, appBase: { grid: 1 } });   // b saw 10 at seq 1 and saves it again: stale
  expect(b.of("error").at(-1)).toMatchObject({ code: "stale-setting", id: "b:1" });
  b.op(2, "board", { appState: { grid: 10 }, appBase: { grid: 2 } });   // b saw 20 and puts 10 back: a revert
  expect(b.of("ack").at(-1)).toEqual({ t: "ack", id: "b:2", seq: 3 });
  expect(d.room.streams.board.appState.herdr.grid).toBe(10);
});

test("the base check runs against speculative state, and a stale-setting decided against an unresolved entry is held, then sent", async () => {
  const slow = slowLog(), d = direct(slow), a = d.join("ua", "editor", "a"), b = d.join("ub", "editor", "b");
  a.op(1, "board", { appState: { grid: 10 }, appBase: { grid: 0 } });   // accepted, append in flight
  b.op(1, "board", { appState: { grid: 20 }, appBase: { grid: 0 } });   // stale against a's unresolved entry
  expect([a.inbox.filter(m => m.t !== "welcome"), b.inbox.filter(m => m.t !== "welcome")]).toEqual([[], []]);   // nothing yet
  slow.waiting.shift().land(); await tick();
  expect(a.of("ack")).toEqual([{ t: "ack", id: "a:1", seq: 1 }]);
  expect(b.of("error")).toMatchObject([{ id: "b:1", code: "stale-setting" }]);
});

test("a held stale-setting becomes unavailable when the append it depended on fails", async () => {
  const slow = slowLog(), d = direct(slow), a = d.join("ua", "editor", "a"), b = d.join("ub", "editor", "b");
  a.op(1, "board", { appState: { grid: 10 }, appBase: { grid: 0 } });
  b.op(1, "board", { appState: { grid: 20 }, appBase: { grid: 0 } });
  slow.waiting.shift().fail(Object.assign(new Error("disk"), { code: "io" })); await tick();
  expect(b.of("error")).toMatchObject([{ id: "b:1", code: "unavailable" }]);
  expect(d.log.entries ?? slow.log.entries).toEqual([]);
  // The rebuilt room decides again: b's op is now current.
  const room = Room.fromLog({ board: "b1", tenant: "t1", log: slow.log, now: () => 5 });
  const inbox = [], c = room.connect(m => inbox.push(m));
  room.receive(c, { t: "hello", v: 1, board: "b1", since: 0, client: "b" }, { n: 1, user: "ub", role: "editor" });
  room.receive(c, { t: "op", id: "b:1", sentAt: 0, stream: "board", op: { appState: { grid: 20 }, appBase: { grid: 0 } } }, { n: 2 });
  expect(inbox.filter(m => m.t === "ack")).toEqual([{ t: "ack", id: "b:1", seq: 1 }]);
});

test("replay applies logged settings as they were: a rebuilt room equals the original, appSeq included", () => {
  const d = direct(), a = d.join("ua", "editor", "a"), b = d.join("ub", "editor", "b");
  a.op(1, "board", { appState: { grid: 1, snap: true }, appBase: { grid: 0, snap: 0 } });
  b.op(1, "board", { appState: { grid: 2 }, appBase: { grid: 0 } });            // refused
  b.op(2, "board", { appState: { grid: 2 }, appBase: { grid: 1 } });
  a.op(2, "notes", { appState: { layers: [layer("n")] }, appBase: { layers: 0 } });
  a.op(3, "board", { appState: { snap: false }, appBase: { snap: 1 } });
  const want = d.room.state();
  expect(want.appSeq).toEqual({ board: { grid: 2, snap: 4 }, notes: { layers: 3 } });   // a refusal takes no seq
  expect(Room.fromLog({ board: "b1", tenant: "t1", log: d.log, now: () => 5 }).state()).toEqual(want);
  d.room.checkpoint();
  expect(Room.fromLog({ board: "b1", tenant: "t1", log: d.log, now: () => 5 }).state()).toEqual(want);
});

// ---- settings: the replica ----

test("two replicas race on layers: one wins, the loser is told (no reset, no resync), and nothing is lost silently", () => {
  const d = direct(), clock = { t: 0 };
  const a = link(d, clock, "u1", "editor", "a").open().sync(), b = link(d, clock, "u2", "editor", "b").open().sync();
  a.r.local("board", { appState: { layers: [layer("A")] } });
  b.r.local("board", { appState: { layers: [layer("B")] } });
  expect(b.r.streams.board.appState.herdr.layers).toEqual([layer("B")]);       // shown at once
  a.up(); b.up(); a.down(); b.down();
  expect(d.log.entries.length).toBe(1);
  const refused = b.all("refusedSettings");
  expect(refused).toMatchObject([{ stream: "board", code: "stale-setting", appState: { layers: [layer("B")] }, appBase: { layers: 0 }, held: null }]);
  expect([b.r.resync, b.all("reset").some(Boolean), b.r.pending.size]).toEqual([false, false, 0]);
  a.sync(); b.sync();
  for (const l of [a, b]) expect(l.r.streams.board.appState.herdr.layers).toEqual([layer("A")]);
  // The loser's app was told when it may retry: only once the winner's entry is applied there.
  expect(b.all("retryReady")).toEqual([{ id: refused[0].id, stream: "board", keys: ["layers"] }]);
  b.r.local("board", { appState: { layers: [layer("A"), layer("B")] } }); b.sync(); a.sync();
  for (const l of [a, b]) expect(l.r.streams.board.appState.herdr.layers).toEqual([layer("A"), layer("B")]);
  expect(errors(a).concat(errors(b)).filter(e => e.code !== "stale-setting")).toEqual([]);
});

test("one settings op in flight per key: back-to-back changes are held, shown, and go out as one op on the acked op's seq", async () => {
  const slow = slowLog(), d = direct(slow), clock = { t: 0 }, a = link(d, clock).open().sync();
  const first = a.r.local("board", { appState: { grid: 10 } });
  expect(first.op).toEqual({ appState: { grid: 10 }, appBase: { grid: 0 } });
  a.up();
  const h1 = a.r.local("board", { appState: { grid: 11 } }), h2 = a.r.local("board", { appState: { grid: 12, snap: true } });
  expect([h1.id, h1.held, h2.held]).toEqual([null, true, true]);
  expect(a.r.heldSettings().board).toEqual({ grid: 12, snap: true });
  expect(a.r.streams.board.appState.herdr).toMatchObject({ grid: 12, snap: true });   // shown at once
  expect(a.up()).toEqual([]);                                                          // nothing more goes yet
  slow.waiting.shift().land(); await tick();
  // The ack lands before the entry: the held change goes out based on the acked op's seq.
  const ack = a.inbox.find(m => m.t === "ack");
  a.did.push(a.r.receive(ack));
  const [next] = a.up();
  expect(next.op).toEqual({ appState: { grid: 12, snap: true }, appBase: { grid: 1, snap: 0 } });
  expect(Number(next.id.split(":")[1])).toBe(Number(first.id.split(":")[1]) + 1);   // its counter is minted at release
  slow.waiting.shift().land(); await tick();
  a.sync();
  expect(a.r.pending.size).toBe(0);
  expect(slow.log.entries.map(e => e.op)).toEqual([first.op, next.op]);
  expect(d.room.streams.board.appState.herdr).toMatchObject({ grid: 12, snap: true });
});

test("a refused settings op takes the held changes to its keys with it; the retry gate holds new changes until the conflict is applied", () => {
  const d = direct(), clock = { t: 0 };
  const a = link(d, clock, "u1", "editor", "a").open().sync(), b = link(d, clock, "u2", "editor", "b").open().sync();
  a.r.local("board", { appState: { grid: 5 } }); a.up();                       // the room: grid = 5 at seq 1 (b hasn't seen it)
  b.r.local("board", { appState: { grid: 7 } }); b.up();                       // refused: base 0
  b.r.local("board", { appState: { grid: 8 } });                               // held behind it
  b.r.local("board", { appState: { snap: true } });                            // held too (one patch per stream), though snap is free
  // b receives only the refusal, not yet the winning entry.
  const refusal = b.inbox.find(m => m.t === "error"); b.inbox = b.inbox.filter(m => m !== refusal);
  const did = b.r.receive(refusal);
  expect(did.refusedSettings).toMatchObject([{ code: "stale-setting", appState: { grid: 7 }, held: { grid: 8 } }]);
  expect([did.reset, b.r.resync, did.retryReady]).toEqual([false, false, []]);
  // What's left of the held patch (snap) has no busy key now: it goes out on its own.
  expect(b.r.heldSettings().board).toBe(null);
  expect(b.up().map(m => m.op)).toEqual([{ appState: { snap: true }, appBase: { snap: 0 } }]);
  // A new change to grid now waits behind the gate: it can't be based on an entry b hasn't applied.
  b.r.local("board", { appState: { grid: 9 } });
  expect(b.r.outgoing()).toEqual([]);
  expect(b.r.heldSettings().board).toEqual({ grid: 9 });
  // The winning entry arrives: the gate opens, and the held change goes out on the base it was made on (0):
  // b's user made it before seeing a's 5, so the room refuses it, and the app is told at once.
  b.down();
  expect(b.all("retryReady")).toMatchObject([{ stream: "board", keys: ["grid"] }]);
  const [held] = b.up();
  expect(held.op).toEqual({ appState: { grid: 9 }, appBase: { grid: 0 } });
  b.sync();
  expect(b.all("refusedSettings").at(-1)).toMatchObject({ id: held.id, code: "stale-setting", appBase: { grid: 0 } });
  expect(b.all("retryReady").at(-1)).toEqual({ id: held.id, stream: "board", keys: ["grid"] });
  // The app re-reads (5) and retries: now based on what the user saw, accepted.
  const [retry] = (b.r.local("board", { appState: { grid: 9 } }), b.up());
  expect(retry.op).toEqual({ appState: { grid: 9 }, appBase: { grid: 1 } });
  b.sync(); a.sync();
  for (const l of [a, b]) expect(l.r.streams.board.appState.herdr).toMatchObject({ grid: 9, snap: true });
});

test("a two-key op refused on one key retries once that key moves past its base", () => {
  const d = direct(), clock = { t: 0 };
  const a = link(d, clock, "u1", "editor", "a").open().sync(), b = link(d, clock, "u2", "editor", "b").open().sync();
  a.r.local("board", { appState: { snap: true } }); a.up();                   // seq 1 sets snap
  b.r.local("board", { appState: { grid: 3, snap: false } }); b.up();         // grid current, snap stale
  const refusal = b.inbox.find(m => m.t === "error"); b.inbox = b.inbox.filter(m => m !== refusal);
  b.r.receive(refusal);
  expect(b.r.gates).toMatchObject([{ appBase: { grid: 0, snap: 0 } }]);
  b.down();                                                                   // snap's appSeq is now 1 > 0
  expect(b.all("retryReady")).toMatchObject([{ keys: ["grid", "snap"] }]);
  expect(b.r.gates).toEqual([]);
});

test("a change with elements and settings goes out as two ops, elements first", () => {
  const d = direct(), clock = { t: 0 }, a = link(d, clock).open().sync();
  const m = a.r.local("board", { elements: [rect("x")], appState: { grid: 4 }, appBase: { grid: 99 } });
  expect(m.op.elements.map(e => e.id)).toEqual(["x"]);                        // the elements op is returned
  expect(m.op.appState).toBeUndefined();
  const sent = a.up();
  expect(sent.map(s => Object.keys(s.op))).toEqual([["elements"], ["appState", "appBase"]]);
  expect(sent[1].op.appBase).toEqual({ grid: 0 });                            // the caller's base is ignored
  a.sync();
  expect(errors(a)).toEqual([]);
  expect(d.log.entries.map(e => e.seq)).toEqual([1, 2]);
  // A settings-only change returns the settings op.
  expect(a.r.local("board", { appState: { snap: true } }).op).toEqual({ appState: { snap: true }, appBase: { snap: 0 } });
});

test("after `stale` on a settings op, held changes wait for the resync and go out on the base the user saw: a value they didn't see is never overwritten", () => {
  const d = direct(), clock = { t: 0 }, a = link(d, clock, "u1", "editor", "a").open().sync();
  const sent = a.r.local("board", { appState: { grid: 1 } });
  a.r.local("board", { appState: { grid: 2 } });                               // held, made on what a saw: grid never set (base 0)
  a.up(); a.inbox = [];                                                        // seq 1; the ack is lost
  const other = link(d, clock, "u2", "editor", "o").open().sync();
  other.r.local("board", { appState: { grid: 50 } }); other.sync();           // seq 2, which a never saw
  // The room answers the resend `stale` (say it forgot this client): the op may or may not have landed.
  const did = a.r.receive({ t: "error", id: sent.id, code: "stale", message: "" });
  expect(did.dropped).toEqual([sent.id]);
  expect(a.r.heldSettings().board).toEqual({ grid: 2 });
  expect(a.r.outgoing()).toEqual([]);                                          // nothing goes before the resync
  expect(a.r.resync).toBe(true);
  a.open().sync();
  expect(a.r.heldSettings().board).toBe(null);
  // It went out on base 0 (what a saw), so the room refused it: grid 50 stands, and the app was told it may retry now.
  const refused = a.all("refusedSettings");
  expect(refused).toMatchObject([{ code: "stale-setting", appState: { grid: 2 }, appBase: { grid: 0 } }]);
  expect(a.all("retryReady")).toEqual([{ id: refused[0].id, stream: "board", keys: ["grid"] }]);
  expect(d.room.streams.board.appState.herdr.grid).toBe(50);
  expect(d.log.entries.length).toBe(2);
});

test("after `stale` on a settings op that never landed, with no other writer, the held change is accepted", () => {
  const d = direct(), clock = { t: 0 }, a = link(d, clock, "u1", "editor", "a").open().sync();
  const sent = a.r.local("board", { appState: { grid: 1 } });
  a.r.local("board", { appState: { grid: 2 } });                               // held
  expect(a.r.outgoing().map(m => m.id)).toEqual([sent.id]);                    // written, but lost on the way
  a.r.receive({ t: "error", id: sent.id, code: "stale", message: "" });
  a.open().sync();
  expect(a.all("refusedSettings")).toEqual([]);
  expect(d.log.entries.map(e => e.op)).toEqual([{ appState: { grid: 2 }, appBase: { grid: 0 } }]);
});

test("M1: a settings change made during a resync is based on what the user saw: accepted with no conflict, refused with one", () => {
  for (const conflict of [false, true]) {
    const w = world(["editor", "editor"], 91);
    w.settle();
    const [a, b] = w.clients;
    w.send(b, "board", { appState: { grid: 10 } }); w.settle();               // a has seen grid at seq 1
    const bad = w.send(a, "board", { appState: { bogus: 1 } });                // refused bad-op: a hard refusal, a resets
    w.flush(a);
    const did = a.r.receive(errors(a).find(e => e.id === bad.id));
    expect([did.reset, a.r.applied]).toEqual([true, 0]);
    if (conflict) { w.send(b, "board", { appState: { grid: 30 } }); w.flush(b); }   // b changes grid while a resyncs
    const m = a.r.local("board", { appState: { grid: 25 } });                  // made during the resync
    expect(m.op.appBase).toEqual({ grid: 1 });                                // what a saw, not the empty copy's 0
    const refused = [], r0 = a.r.receive.bind(a.r);
    a.r.receive = x => { const dd = r0(x); refused.push(...dd.refusedSettings.map(z => z.code)); return dd; };
    w.settle();
    expect([conflict, refused, w.room.streams.board.appState.herdr.grid]).toEqual(conflict ? [true, ["stale-setting"], 30] : [false, [], 25]);
  }
});

test("M2: after a Store loss, a settings op stamped before it opens no retry gate when refused; later changes go out", () => {
  const welcome = (seq, epoch) => ({ t: "welcome", seq, role: "editor", user: "u1", high: 0, horizon: 0, rv: 1, room: { board: "b1", epoch } });
  const ent = (seq, k, v) => ({ seq, board: "b1", tenant: "t1", stream: "board", op: { appState: { [k]: v }, appBase: { [k]: 0 } }, by: "u9", id: `z:${seq}`, at: 1, rv: 1 });
  const clock = { t: 0 }, r = new Replica({ client: "a", now: () => clock.t, random: () => 0 });
  r.connectMessages("tok", "b1"); r.receive(welcome(0, 1));
  for (let s = 1; s <= 50; s++) r.receive({ t: "entries", entries: [ent(s, "grid", s)] });   // appSeq.grid = 50
  const m = r.local("board", { appState: { grid: 7 } });
  expect(m.op.appBase).toEqual({ grid: 50 });
  r.outgoing(); r.connectionFailed();
  r.connectMessages("tok", "b1");
  expect(r.receive(welcome(30, 2)).reset).toBe(true);                          // a higher epoch, seq 30 < 50: the Store lost entries
  r.connectMessages("tok", "b1"); r.receive(welcome(30, 2));
  for (let s = 1; s <= 30; s++) r.receive({ t: "entries", entries: [ent(s, "grid", s)] });   // the room's appSeq.grid = 30
  expect(r.outgoing()[0].op.appBase).toEqual({ grid: 50 });                    // a resend keeps its bytes
  const d2 = r.receive({ t: "error", id: m.id, code: "stale-setting", message: "" });
  expect(d2.retryReady).toEqual([{ id: m.id, stream: "board", keys: ["grid"] }]);   // told at once
  expect([r.gates, r.busy("board", "grid")]).toEqual([[], false]);
  const next = r.local("board", { appState: { grid: 9 } });                    // not held: based on the resynced copy
  expect([next.held, next.op.appBase]).toEqual([undefined, { grid: 30 }]);
});

// ---- seeding with kept versions ----

test("seeding with keepVersions: versions and nonces go out unchanged and are never re-stamped, not even on a resync", () => {
  const d = direct(), clock = { t: 0 }, ed = link(d, clock, "u0", "editor", "e").open().sync();
  ed.r.local("board", { elements: [rect("old")] }); ed.r.local("board", { elements: [{ ...rect("old"), x: 1 }] }); ed.sync();   // the room has "old" at version 2
  const imp = link(d, clock, "u1", "editor", "i").open().sync();
  const file = [rect("old", { version: 40, versionNonce: 111 }), rect("new", { version: 7, versionNonce: 222 }), rect("huge", { version: 5000, versionNonce: 333 }), rect("far", { version: 1500, versionNonce: 444 })];
  // The importer's rule (§ The element op, seeding), against the confirmed copy after catch-up.
  const send = [], held = [];
  for (const el of file) {
    const room = imp.r.roomVersion("board", el.id);
    if (!room && el.version > 1000) send.push({ ...el, version: 1, versionNonce: 999 });
    else if (room && el.version > room + 1000) held.push(el.id);
    else send.push(el);
  }
  expect(held).toEqual([]);
  const m = imp.r.local("board", { elements: send }, { keepVersions: true });
  expect(m.op.elements.map(e => [e.id, e.version, e.versionNonce])).toEqual([["old", 40, 111], ["new", 7, 222], ["huge", 1, 999], ["far", 1, 999]]);
  // A resync before it is sent: the copy is reset, and the kept op is not re-stamped.
  imp.r.reset();
  imp.r.restampAll();
  expect(imp.r.pending.get(m.id).op.elements.map(e => e.version)).toEqual([40, 7, 1, 1]);
  imp.open().sync();
  expect(errors(imp)).toEqual([]);
  expect(["old", "new", "huge"].map(id => d.room.streams.board.get(id).version)).toEqual([40, 7, 1]);
  // An ordinary local() after it still normalizes: one past the kept version.
  expect(imp.r.local("board", { elements: [{ ...rect("new"), x: 9 }] }).op.elements[0].version).toBe(8);
});

test("an element the room has more than 1,000 below the file's version is held back by the importer (the room would refuse it)", () => {
  const d = direct(), clock = { t: 0 }, a = link(d, clock).open().sync();
  a.r.local("board", { elements: [rect("x")] }); a.sync();
  expect(a.r.roomVersion("board", "x")).toBe(1);
  // Sent raw anyway, the room refuses it: that's why the importer holds it back.
  const m = a.r.local("board", { elements: [rect("x", { version: 1002, versionNonce: 5 })] }, { keepVersions: true });
  a.up(); a.down();
  expect(a.all("dropped")).toContain(m.id);
  expect(a.r.resync).toBe(true);                                              // a refused element op: rule 5
});

// ---- whole-system check: many seeds ----

test("convergence with concurrent multi-key settings: every logged settings base equals the key's appSeq before it; nothing is left held", () => {
  for (const seed of [21, 22, 23, 24]) {
    const w = world(["owner", "editor", "editor", "viewer"], seed);
    for (let round = 0; round < 300; round++) {
      const c = w.clients[Math.floor(w.rng() * 3)];
      const roll = w.rng();
      if (roll < 0.3) w.send(c, "board", { appState: { grid: Math.floor(w.rng() * 40), ...(w.rng() < 0.5 ? { snap: w.rng() < 0.5 } : {}) } });
      else if (roll < 0.4) w.send(c, "notes", { appState: { layers: [layer(`l${Math.floor(w.rng() * 5)}`)] } });
      else if (roll < 0.6) w.send(c, "board", { elements: [rect(`e${Math.floor(w.rng() * 20)}`, { x: round })] });
      if (w.rng() < 0.02 && c.conn) w.drop(c);
      if (!c.conn && w.rng() < 0.3) w.connect(c);
      for (let k = 0; k < 3; k++) w.step();
      if (round === 150) w.rebuild();
    }
    for (const c of w.clients) if (!c.conn) w.connect(c);
    w.settle();
    const seqs = { board: {}, notes: {} };
    let settings = 0;
    for (const e of w.log.entries) if (e.op.appState) {
      settings++;
      for (const k of Object.keys(e.op.appState)) { expect(e.op.appBase[k]).toBe(seqs[e.stream][k] ?? 0); seqs[e.stream][k] = e.seq; }
    }
    expect(settings).toBeGreaterThan(10);
    expect(seqs).toEqual(w.room.appSeq);
    for (const c of w.clients) {
      expect([c.r.pending.size, c.r.heldSettings()]).toEqual([0, { board: null, notes: null }]);
      expect(c.r.streams.board.appState.herdr).toEqual(w.room.streams.board.appState.herdr);
      expect(c.r.streams.notes.appState.herdr).toEqual(w.room.streams.notes.appState.herdr);
    }
  }
});

test("L2: a room built without an epoch opens the log's next one, so a later rebuild never repeats it", () => {
  const d = direct();
  const rebuilt = Room.fromLog({ board: "b1", tenant: "t1", log: d.log, now: () => 5 });
  expect([d.room.epoch, rebuilt.epoch, d.log.epoch()]).toEqual([1, 2, 2]);
  expect(new Room({ board: "b1", tenant: "t1", log: { append() {} } }).epoch).toBe(1);   // a log with no epochs: 1
});

// ---- fix round 2 ----

test("R2-M2: a held change keeps the base it was made on; released after a peer's entry it hid, it is refused, and the peer's value stands", () => {
  const d = direct(), clock = { t: 0 }, a = link(d, clock, "ua", "editor", "a").open().sync();
  a.r.local("board", { appState: { grid: 1 } });
  a.up();                                                                     // a:1 logged at seq 1; answers wait in a.inbox
  const h = a.r.local("board", { appState: { grid: 2 } });                    // held behind it; a shows 2
  expect([h.held, a.r.streams.board.appState.herdr.grid]).toEqual([true, 2]);
  const b = d.join("ub", "editor", "b", 0);
  b.op(1, "board", { appState: { grid: 3 }, appBase: { grid: 1 } }, 1);      // b saw a's 1 and sets 3: seq 2
  // a gets both entries in one message (a group commit or catch-up), then its ack: b's 3 is never shown.
  const entries = a.inbox.filter(m => m.t === "entries").flatMap(m => m.entries), ack = a.inbox.find(m => m.t === "ack");
  a.inbox = [];
  a.r.receive({ t: "entries", entries });
  expect(a.r.streams.board.appState.herdr.grid).toBe(2);
  a.did.push(a.r.receive(ack));
  const [out] = a.up();
  expect(out.op).toEqual({ appState: { grid: 2 }, appBase: { grid: 1 } });   // fixed when made (0), raised by a's own seq 1; never 2
  a.sync();
  expect(a.all("refusedSettings")).toMatchObject([{ id: out.id, code: "stale-setting" }]);
  expect(a.all("retryReady")).toEqual([{ id: out.id, stream: "board", keys: ["grid"] }]);
  expect(d.room.streams.board.appState.herdr.grid).toBe(3);
  expect(a.r.streams.board.appState.herdr.grid).toBe(3);
});

test("R2-M1: a Store loss drops held changes (they lost their base) and tells the app; nothing goes out with a key missing from appBase", () => {
  const welcome = (seq, epoch, high = 0) => ({ t: "welcome", seq, role: "editor", user: "u1", high, horizon: 0, rv: 1, room: { board: "b1", epoch } });
  const ent = (seq, k, v) => ({ seq, board: "b1", tenant: "t1", stream: "board", op: { appState: { [k]: v }, appBase: { [k]: seq - 1 } }, by: "u9", id: `z:${seq}`, at: 1, rv: 1 });
  const r = new Replica({ client: "a", now: () => 0, random: () => 0 });
  r.connectMessages("tok", "b1"); r.receive(welcome(0, 1));
  for (let s = 1; s <= 10; s++) r.receive({ t: "entries", entries: [ent(s, "grid", s)] });
  const m = r.local("board", { appState: { grid: 77 } }); r.outgoing();       // sent at base 10
  r.local("board", { appState: { grid: 78 } });                               // held behind it
  r.connectionFailed(); r.connectMessages("tok", "b1");
  const lost = r.receive(welcome(6, 2, 5));                                   // epoch 2, seq 6 < applied 10: the Store lost entries
  expect(lost.refusedSettings).toEqual([{ id: null, stream: "board", code: "store-lost", appState: { grid: 78 }, appBase: null, held: { grid: 78 } }]);
  expect(lost.retryReady).toEqual([{ id: null, stream: "board", keys: ["grid"] }]);
  expect(r.heldSettings().board).toBe(null);
  r.connectMessages("tok", "b1"); r.receive(welcome(6, 2, 5));
  for (let s = 1; s <= 6; s++) r.receive({ t: "entries", entries: [ent(s, "grid", s)] });
  r.receive({ t: "error", id: m.id, code: "stale", message: "" });
  r.connectMessages("tok", "b1"); r.receive(welcome(6, 2, 5));
  for (let s = 1; s <= 6; s++) r.receive({ t: "entries", entries: [ent(s, "grid", s)] });
  expect(r.outgoing()).toEqual([]);                                           // nothing held is left to send
  expect(r.streams.board.appState.herdr.grid).toBe(6);
  const next = r.local("board", { appState: { grid: 79 } });                  // the app retries on the resynced copy
  expect(next.op.appBase).toEqual({ grid: 6 });
});

test("rule 13: another user's welcome drops held settings changes too, and says so", () => {
  const r = new Replica({ client: "a", now: () => 0, random: () => 0 });
  const welcome = user => ({ t: "welcome", seq: 0, role: "editor", user, high: 0, horizon: 0, rv: 1, room: { board: "b1", epoch: 1 } });
  r.connectMessages("tok", "b1"); r.receive(welcome("u1"));
  r.local("board", { appState: { grid: 1 } }); r.local("board", { appState: { grid: 2 } });
  r.connectionFailed(); r.connectMessages("tok2", "b1");
  const did = r.receive(welcome("u2"));
  expect(did.refusedSettings).toMatchObject([{ id: null, code: "user-changed", held: { grid: 2 } }]);
  expect([r.pending.size, r.heldSettings().board]).toEqual([0, null]);
});

test("the op builder refuses to build a settings op without a full base", () => {
  const r = new Replica({ client: "a" });
  expect(() => r.push("board", { appState: { grid: 1 }, appBase: {} })).toThrow("bad settings op");
  expect(() => r.push("board", { appState: { grid: 1, snap: true }, appBase: { grid: 0 } })).toThrow("bad settings op");
  expect(r.push("board", { appState: { grid: 1 }, appBase: { grid: 0 } }).id).toBe(`${r.client}:1`);   // a refused build mints no counter
});

test("previewEntries(stream): others' live previews with who sent them, expiring like previewsOf", () => {
  const clock = { t: 0 }, r = new Replica({ client: "a", now: () => clock.t });
  const el = id => rect(id);
  r.receive({ t: "presence", batch: [
    { k: "preview", stream: "board", elements: [el("x")], user: "u2", client: "c2" },
    { k: "preview", stream: "notes", elements: [el("n")], user: "u3", client: "c3" },
  ] });
  expect(r.previewEntries("board")).toEqual([{ element: el("x"), user: "u2", client: "c2", at: 0 }].map(e => ({ ...e, element: r.previewsOf("board")[0] })));
  expect(r.previewEntries("notes").map(e => [e.element.id, e.user, e.client])).toEqual([["n", "u3", "c3"]]);
  clock.t = 4999; expect(r.previewEntries("board").length).toBe(1);
  clock.t = 5000; expect([r.previewEntries("board"), r.previewsOf("board")]).toEqual([[], []]);
});

test("pendingOf(stream): this client's unacknowledged ops on a stream, in send order, with whether each was written", () => {
  const d = direct(), clock = { t: 0 }, a = link(d, clock).open().sync();
  const e1 = a.r.local("board", { elements: [rect("x")] });
  const n1 = a.r.local("notes", { elements: [rect("n")] });
  const s1 = a.r.local("board", { appState: { grid: 3 } });
  a.r.local("board", { appState: { grid: 4 } });                              // held: not an op yet
  expect(a.r.pendingOf("board")).toEqual([{ id: e1.id, op: e1.op, sent: false }, { id: s1.id, op: s1.op, sent: false }]);
  expect(a.r.pendingOf("notes").map(p => p.id)).toEqual([n1.id]);
  a.r.outgoing();
  expect(a.r.pendingOf("board").map(p => p.sent)).toEqual([true, true]);
  a.r.pendingOf("board")[0].op.elements[0].x = 999;                           // a copy: changing it changes nothing
  expect(a.r.pending.get(e1.id).op.elements[0].x).not.toBe(999);
  a.inbox = []; a.open().sync();
  expect([a.r.pendingOf("board"), a.r.pendingOf("notes"), a.r.pendingOf("records")]).toEqual([[], [], []]);
});

// ---- fix round 3 ----

test("R3-M1: a held key's base is fixed by its first held change; a second change after a hidden peer entry is refused, and the peer's value stands", () => {
  const d = direct();
  const a = new Replica({ client: "a", now: () => 0, random: () => 0 });
  const ain = [], ac = d.room.connect(m => ain.push(wire(m))); let an = 0;
  const say = m => d.room.receive(ac, wire(m), { n: ++an, ...(m.t === "hello" ? { user: "ua", role: "editor" } : {}) });
  for (const m of a.connectMessages("tok", "b1")) say(m);
  while (ain.length) a.receive(ain.shift());
  const take = t => { const i = ain.findIndex(m => m.t === t); return i < 0 ? null : ain.splice(i, 1)[0]; };
  const b = d.join("ub", "editor", "b", 0), c = d.join("uc", "editor", "c", 0);
  b.op(1, "board", { appState: { grid: 3 }, appBase: { grid: 0 } });                    // seq 1: b's grid (a will see it hidden)
  c.op(1, "board", { appState: { layers: [layer("L")] }, appBase: { layers: 0 } });     // seq 2: c's layers
  a.local("board", { appState: { snap: true, layers: [layer("A")] } });                 // a's two-key op on base 0
  for (const m of a.outgoing()) say(m);                                                  // refused stale-setting (layers)
  const entries = ain.filter(m => m.t === "entries").flatMap(m => m.entries);
  for (let i = ain.length - 1; i >= 0; i--) if (ain[i].t === "entries") ain.splice(i, 1);
  a.receive(take("error"));                                                              // a gate on {snap, layers}
  a.local("board", { appState: { snap: false, grid: 5 } });                             // held whole (snap gated); grid's base fixed at 0
  a.receive({ t: "entries", entries: [entries[0]] });                                   // b's grid 3: applied, hidden by the held 5
  expect(a.streams.board.appState.herdr.grid).toBe(5);
  a.local("board", { appState: { grid: 6 } });                                           // a second change: keeps base 0
  a.receive({ t: "entries", entries: [entries[1]] });                                   // c's layers: the gate opens, the patch goes
  const out = a.outgoing();
  expect(out.map(m => m.op)).toEqual([{ appState: { snap: false, grid: 6 }, appBase: { snap: 0, grid: 0 } }]);
  for (const m of out) say(m);
  expect(ain.filter(m => m.t === "error").map(m => m.code)).toEqual(["stale-setting"]);
  expect(d.room.streams.board.appState.herdr.grid).toBe(3);
});

test("R2-L1: entries that reach the client before its welcome are applied after it, and never look like a Store loss", () => {
  const ent = (seq, k, v) => ({ seq, board: "b1", tenant: "t1", stream: "board", op: { appState: { [k]: v }, appBase: { [k]: seq - 1 } }, by: "u9", id: `z:${seq}`, at: 1, rv: 1 });
  const welcome = (seq, epoch) => ({ t: "welcome", seq, role: "editor", user: "u1", high: 0, horizon: 0, rv: 1, room: { board: "b1", epoch } });
  const r = new Replica({ client: "a", now: () => 0, random: () => 0 });
  r.connectMessages("tok", "b1");
  // The first-ever connection: a live entry (seq 2) and catch-up (seq 1) beat the welcome (epoch 1, seq 1).
  expect(r.receive({ t: "entries", entries: [ent(2, "grid", 2)] }).entries).toEqual([]);   // kept, not applied yet
  r.receive({ t: "entries", entries: [ent(1, "grid", 1)] });
  expect(r.applied).toBe(0);
  const did = r.receive(welcome(1, 1));
  expect([did.reset, r.resync, r.applied, did.entries.map(e => e.seq)]).toEqual([false, false, 2, [1, 2]]);
  r.local("board", { appState: { snap: true } }); r.local("board", { appState: { snap: false } });   // one sent, one held
  // A reconnect to a rebuilt room (epoch 2) whose welcome lags a live entry: still a normal rebuild.
  r.connectionFailed(); r.connectMessages("tok", "b1");
  r.receive({ t: "entries", entries: [ent(3, "grid", 3)] });
  const again = r.receive(welcome(2, 2));
  expect([again.reset, again.refusedSettings, r.heldSettings().board, r.applied]).toEqual([false, [], { snap: false }, 3]);
  // A real loss is still caught: welcome.seq below what was applied before this connection.
  r.connectionFailed(); r.connectMessages("tok", "b1");
  expect(r.receive(welcome(1, 3)).reset).toBe(true);
});
