// The client's copy (PROTOCOL.md rules 2, 4, 5, 12, 13; § Pacing; normalize on send), driven by hand:
// one Replica on an ordered link to a room, with the clock in the test's hands.
import { test, expect } from "bun:test";
import { direct, world, errors } from "./world.js";
import { Replica } from "../packages/protocol/replica.js";
import { Doc } from "../packages/core/doc.js";
import { makeElement, touch, clone, emptyScene } from "../packages/core/model.js";

const rect = (id, extra = {}) => makeElement("rectangle", { id, ...extra });
const wire = m => JSON.parse(JSON.stringify(m));

/** A replica on a link: `open()` connects, `up()` sends what is due, `down()` delivers the room's answers. */
function link(d, clock, user = "u1", role = "editor", name = "c") {
  const l = { r: new Replica({ client: name, now: () => clock.t, random: () => 0 }), inbox: [], sent: [], c: null, n: 0, did: [] };
  l.open = () => {
    if (l.c) d.room.disconnect(l.c);
    l.inbox = []; l.n = 0; l.c = d.room.connect(m => l.inbox.push(wire(m)));
    const [hello] = l.r.connectMessages("tok", "b1");
    d.room.receive(l.c, wire(hello), { n: ++l.n, user, role });
    return l;
  };
  l.up = () => { const out = l.r.outgoing(); for (const m of out) { l.sent.push({ id: m.id, at: clock.t }); d.room.receive(l.c, wire(m), { n: ++l.n }); } return out; };
  l.down = () => { const got = l.inbox; l.inbox = []; for (const m of got) l.did.push(l.r.receive(m)); return got; };
  l.sync = () => { for (let i = 0; i < 10; i++) { l.down(); l.up(); } l.down(); return l; };
  return l;
}

test("normalize on send: a 5,000-move drag then one send is accepted; a seeded element goes out at version 1", () => {
  const d = direct(), clock = { t: 0 }, a = link(d, clock).open().sync();
  a.r.local("board", { elements: [rect("box")] }); a.sync();
  expect(d.room.streams.board.get("box").version).toBe(1);
  const dragged = clone(a.r.streams.board.get("box"));
  for (let i = 0; i < 5000; i++) { touch(dragged); dragged.x = i; }           // an editor bumps the version on every move
  expect(dragged.version).toBe(5001);
  const m = a.r.local("board", { elements: [dragged] });
  expect(m.op.elements[0].version).toBe(2);                                   // one past what the replica knows
  expect(m.op.elements[0].versionNonce).not.toBe(dragged.versionNonce);       // and a fresh nonce
  expect(dragged.version).toBe(5001);                                         // the caller's object is left alone
  a.sync();
  expect(errors(a)).toEqual([]);
  expect(a.r.pending.size).toBe(0);
  expect(d.room.streams.board.get("box")).toMatchObject({ x: 4999, version: 2 });
  // Seeding from a file: whatever version the file says, an id the replica doesn't know goes out at 1.
  expect(a.r.local("board", { elements: [rect("seeded", { version: 9999 })] }).op.elements[0].version).toBe(1);
  // Several pending edits of one element stack: 3, 4, 5.
  const more = [1, 2, 3].map(i => a.r.local("board", { elements: [{ ...clone(a.r.streams.board.get("box")), x: -i }] }).op.elements[0].version);
  expect(more).toEqual([3, 4, 5]);
  a.sync();
  expect(d.room.streams.board.get("box")).toMatchObject({ x: -3, version: 5 });
  expect(d.room.streams.board.get("seeded").version).toBe(1);
  expect(a.r.state().board).toEqual({ elements: [...d.room.streams.board.byId.values()].sort((x, y) => (x.id < y.id ? -1 : 1)), appState: d.room.streams.board.appState.herdr });
});

test("a refused element op: receive() says so, the copy is reset, pending ops stay visible, and the caller is told to reconnect from 0", () => {
  const d = direct(), clock = { t: 0 }, ed = link(d, clock, "u0", "editor", "e").open().sync(), a = link(d, clock, "u1", "annotator", "a").open().sync();
  ed.r.local("board", { elements: [rect("theirs")] }); ed.sync(); a.sync();
  expect(a.r.applied).toBe(1);
  const bad = a.r.local("board", { elements: [{ ...clone(a.r.streams.board.get("theirs")), x: 999 }] });   // an annotator can't write the board
  const note = a.r.local("notes", { elements: [rect("my-note")] });                                         // a good op behind it
  expect(a.r.streams.board.get("theirs").x).toBe(999);                        // shown at once
  a.up();
  const [refusal, ack] = a.inbox; a.inbox = [];
  expect([refusal.code, refusal.id, ack.t]).toEqual(["forbidden", bad.id, "ack"]);
  const did = a.r.receive(refusal);
  expect(did).toEqual({ entries: [], snapshot: false, reset: true, settled: [], dropped: [bad.id], refusedSettings: [], retryReady: [] });
  expect([a.r.resync, a.r.applied]).toEqual([true, 0]);
  expect(a.r.streams.board.getAny("theirs")).toBe(null);                      // the copy is gone…
  expect(a.r.streams.notes.get("my-note")).toBeTruthy();                      // …but the pending note is still shown
  expect([...a.r.pending.keys()]).toEqual([note.id]);
  expect(a.r.outgoing()).toEqual([]);                                         // nothing more on this connection
  expect(a.r.connectMessages("tok", "b1")).toEqual([{ t: "hello", v: 1, token: "tok", board: "b1", since: 0, client: a.r.client }]);
  a.open().sync();                                                            // a new connection, never a second hello
  expect(a.r.pending.size).toBe(0);
  expect(a.r.streams.board.get("theirs").x).toBe(0);
  expect(d.log.entries.map(e => e.id)).toEqual([`${ed.r.client}:1`, note.id]);  // the note landed once
});

test("receive() returns what it applied: entries in seq order, a snapshot, what settled", () => {
  const d = direct(), clock = { t: 0 }, a = link(d, clock, "u0", "editor", "a").open().sync(), b = link(d, clock, "u1", "editor", "b").open().sync();
  const m = a.r.local("board", { elements: [rect("one")] }); a.r.local("board", { elements: [rect("two")] }); a.up();
  const entries = b.inbox.flatMap(x => x.entries); b.inbox = [];
  expect(b.r.receive({ t: "entries", entries: [entries[1]] }).entries).toEqual([]);                 // ahead of a gap: buffered
  expect(b.r.receive({ t: "entries", entries: [entries[0]] }).entries.map(e => e.seq)).toEqual([1, 2]);
  expect(b.r.receive({ t: "entries", entries }).entries).toEqual([]);                                // a repeat applies nothing
  const acks = a.inbox.filter(x => x.t === "ack"), mine = a.inbox.filter(x => x.t === "entries"); a.inbox = [];
  expect(a.r.receive(acks[0])).toMatchObject({ entries: [], settled: [] });                          // acked, entry not yet applied
  expect(a.r.receive(mine[0])).toMatchObject({ settled: [m.id] });
  expect(a.r.receive({ ...mine[1], entries: mine[1].entries.map(e => ({ ...e, by: "someone-else" })) }).settled).toEqual([]);   // rule 4: same id, another user
  expect(a.r.pending.size).toBe(1);
  d.room.checkpoint();
  const late = link(d, clock, "u2", "viewer", "late").open();
  late.r.receive(late.inbox[0]);                                              // its welcome (catch-up applies only after it)
  expect(late.r.receive(late.inbox[1])).toMatchObject({ snapshot: true, entries: [] });
  expect(late.r.streams.board.live().length).toBe(2);
});

test("ops wait for welcome; resends go right after it, new ops only once caught up; each op is written once per connection", () => {
  const d = direct(), clock = { t: 0 }, other = link(d, clock, "u0", "editor", "o").open().sync();
  for (let i = 0; i < 3; i++) other.r.local("board", { elements: [rect(`o${i}`)] });
  other.sync();
  const a = link(d, clock, "u1", "editor", "a");
  const first = a.r.local("board", { elements: [rect("early")] });            // made before any connection
  expect(a.r.outgoing()).toEqual([]);
  a.open();
  expect(a.r.outgoing()).toEqual([]);                                         // no welcome yet
  const [welcome, catchUp] = a.inbox; a.inbox = [];
  a.r.receive(welcome);
  expect(a.r.outgoing()).toEqual([]);                                         // welcomed, but behind welcome.seq
  a.r.receive(catchUp);
  const out = a.up();
  expect(out.map(m => [m.id, m.sentAt])).toEqual([[first.id, 3]]);            // sentAt = the seq applied when first sent
  expect(a.r.outgoing()).toEqual([]);                                         // never resent on a live connection
  clock.t += 9000;
  expect(a.r.outgoing()).toEqual([]);
  // The ack is lost with the connection. On the next one the op is a resend: it goes right after welcome.
  for (let i = 3; i < 6; i++) other.r.local("board", { elements: [rect(`o${i}`)] });
  other.sync();
  a.open();
  const second = a.r.local("board", { elements: [rect("later")] });
  a.r.receive(a.inbox.shift());                                               // the welcome only: still behind
  expect(a.r.outgoing().map(m => [m.id, m.sentAt])).toEqual([[first.id, 3]]); // same id, same sentAt; the new op waits
  a.sync();
  expect(a.sent.map(s => s.id)).toEqual([first.id, second.id]);
  expect(d.log.entries.filter(e => e.by === "u1").map(e => e.id)).toEqual([first.id, second.id]);
  expect(a.r.pending.size).toBe(0);
});

test("pacing: 250 pending ops leave at the rate after welcome (100, then 20 a second), none refused, all acked", () => {
  const d = direct(), clock = { t: 0 }, a = link(d, clock).open().sync();
  for (let i = 0; i < 250; i++) a.r.local("board", { elements: [rect(`e${i}`)] });
  expect(a.r.outgoing().length).toBe(100);                                    // written, then the connection dies: lost
  clock.t += 60_000;
  a.open(); a.down();
  expect(a.up().length).toBe(100);                                            // the burst
  expect(a.r.paceWait()).toBe(50);                                            // one more in 50 ms
  expect(a.up().length).toBe(0);
  clock.t += 49; expect(a.up().length).toBe(0);
  clock.t += 1; expect(a.up().length).toBe(1);
  a.down();
  while (a.r.paceWait() !== null) { clock.t += a.r.wait(); a.up(); a.down(); }
  expect(a.sent.length).toBe(250);
  const start = a.sent[0].at, bySecond = s => a.sent.filter(x => x.at - start >= s * 1000 && x.at - start < (s + 1) * 1000).length;
  expect([0, 1, 2, 3, 4, 5, 6, 7].map(bySecond)).toEqual([119, 20, 20, 20, 20, 20, 20, 11]);   // 100 at once, then 20/s
  expect(new Set(a.sent.map(s => s.id)).size).toBe(250);                      // each once
  expect(a.sent.map(s => Number(s.id.split(":")[1]))).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));   // in counter order
  expect(a.did.flatMap(x => x.dropped)).toEqual([]);
  expect(errors(a)).toEqual([]);
  expect([a.r.pending.size, a.r.resync, d.log.entries.length]).toEqual([0, false, 250]);
});

test("rule 2's timeout counts from the send, not from waiting on the pace; then the connection is suspect and ops are kept", () => {
  const d = direct(), clock = { t: 0 }, a = link(d, clock).open().sync();
  for (let i = 0; i < 101; i++) a.r.local("board", { elements: [rect(`e${i}`)] });
  a.up(); a.down();                                                           // 100 sent and acked; one waits for the pace
  expect(a.r.pending.size).toBe(1);
  clock.t += 30_000;                                                          // it waited far longer than 10 s, unsent
  const [late] = a.r.outgoing();                                              // written now (to a socket that then stalls)
  expect(late.id).toBe(`${a.r.client}:101`);
  expect(a.r.resync).toBe(false);
  expect(a.r.wait()).toBe(10_000);
  clock.t += 9999; a.r.outgoing(); expect(a.r.resync).toBe(false);
  clock.t += 1; expect(a.r.outgoing()).toEqual([]);
  expect([a.r.resync, a.r.pending.size, a.r.applied]).toEqual([true, 1, 100]);   // reconnect; nothing dropped, no reset
  a.open().sync();
  expect([a.r.pending.size, d.log.entries.length]).toEqual([0, 101]);
});

test("rule 12: no welcome, or no catch-up progress, for 10 s asks for a reconnect; waits grow, with jitter, and reset after a proven connection", () => {
  const d = direct(), clock = { t: 0 }, other = link(d, clock, "u0", "editor", "o").open().sync();
  other.r.local("board", { elements: [rect("x")] }); other.sync();
  let roll = 0;
  const r = new Replica({ client: "t", now: () => clock.t, random: () => roll });
  expect(r.wait()).toBe(null);                                                // not connected: nothing to wait for
  r.connectMessages("tok", "b1");                                             // the hello is lost
  expect(r.wait()).toBe(10_000);
  clock.t += 9999; r.outgoing(); expect(r.resync).toBe(false);
  clock.t += 1; r.outgoing();
  expect([r.resync, r.fails]).toEqual([true, 1]);
  expect(r.reconnectWait()).toBe(500);                                        // min(30 s, 0.5 s × 2^1) × 0.5
  roll = 0.999; expect(Math.round(r.reconnectWait())).toBe(1000);             // × [0.5, 1)
  roll = 0;
  r.connectMessages("tok", "b1");
  r.receive({ t: "welcome", seq: 1, role: "editor", user: "u1", high: 0, horizon: 0, rv: 1 });   // then the catch-up is lost
  clock.t += 10_000; r.outgoing();
  expect([r.resync, r.fails]).toEqual([true, 2]);
  expect(r.reconnectWait()).toBe(1000);
  r.fails = 12; expect(r.reconnectWait()).toBe(15_000);                       // capped at 30 s (× 0.5)
  r.connectMessages("tok", "b1");
  r.receive({ t: "welcome", seq: 1, role: "editor", user: "u1", high: 0, horizon: 0, rv: 1 });
  clock.t += 9000;
  r.receive({ t: "entries", entries: [d.log.entries[0]] });                   // progress: caught up
  expect(r.fails).toBe(12);                                                   // caught up is not yet proven
  clock.t += 60_000; r.outgoing();
  expect(r.resync).toBe(false);                                               // an idle, healthy connection never times out
  expect(r.reconnectWait()).toBe(250);                                        // it stayed up: the next wait starts over
  expect(r.fails).toBe(0);
});

test("unavailable and auth are not refusals: pending ops are kept, the copy is kept; version stops the client", () => {
  const d = direct(), clock = { t: 0 }, a = link(d, clock).open().sync();
  a.r.local("board", { elements: [rect("kept")] }); a.sync();
  const m = a.r.local("board", { elements: [rect("pending")] });
  expect(a.r.receive({ t: "error", id: m.id, code: "unavailable", message: "moving" })).toMatchObject({ reset: false, dropped: [] });
  expect([a.r.resync, a.r.pending.size, a.r.applied, a.r.fails]).toEqual([true, 1, 1, 1]);
  a.r.connectMessages("tok", "b1");
  a.r.receive({ t: "error", code: "auth", message: "sign in" });
  expect([a.r.needAuth, a.r.resync, a.r.pending.size, a.r.applied]).toEqual([true, false, 1, 1]);
  clock.t += 60_000;                                                          // no timer may turn a refusal into a blind retry
  expect([a.r.outgoing(), a.r.wait(), a.r.resync, a.r.fails]).toEqual([[], null, false, 1]);
  a.open().sync();
  expect([a.r.pending.size, d.log.entries.length, a.r.fails]).toEqual([0, 2, 1]);   // caught up, not yet proven
  const b = link(d, clock, "u2", "editor", "b").open().sync();
  b.r.local("board", { elements: [rect("never")] });
  b.r.receive({ t: "entries", entries: [{ ...d.log.entries[0], seq: 3, rv: 99 }] });                // rules this app doesn't know
  expect(b.r.stopped).toBe("version");
  expect(b.r.outgoing()).toEqual([]);
  expect(b.r.pending.size).toBe(1);
});

test("rule 13: pending ops belong to the user who made them; another user's welcome drops them and says how many", () => {
  const d = direct(), clock = { t: 0 }, a = link(d, clock, "u1").open().sync();
  a.r.local("board", { elements: [rect("ok")] }); a.sync();
  a.r.local("board", { elements: [rect("u1-made-this")] }); a.r.local("board", { elements: [rect("and-this")] });
  a.r.connectMessages("tok2", "b1");
  const did = a.r.receive({ t: "welcome", seq: 1, role: "editor", user: "u2", high: 0, horizon: 0, rv: 1 });
  expect(did.dropped.length).toBe(2);
  expect([a.r.pending.size, a.r.discarded, did.reset, a.r.resync, a.r.user]).toEqual([0, 2, true, true, "u2"]);
  expect(a.r.streams.board.getAny("u1-made-this")).toBe(null);
  expect(a.r.outgoing()).toEqual([]);
  expect(d.log.entries.length).toBe(1);
});

test("an edit made during a resync is stamped again against the fresh copy and lands live", () => {
  const w = world(["editor", "editor"], 51);
  w.settle();
  const [a, b] = w.clients;
  w.send(a, "board", { elements: [rect("shape", { x: 64 })] }); w.settle();
  for (let i = 0; i < 4; i++) { w.send(b, "board", { elements: [clone(b.r.streams.board.get("shape"))] }); w.settle(); }
  expect(w.room.streams.board.get("shape").version).toBe(5);
  const onScreen = clone(a.r.streams.board.get("shape"));                     // what a's editor shows
  const bad = w.send(a, "board", { appState: { bogus: 1 } });
  w.flush(a);
  expect(a.r.receive(errors(a).find(e => e.id === bad.id)).reset).toBe(true); // refused: the replica is empty now
  expect(a.r.streams.board.getAny("shape")).toBe(null);
  const m = w.send(a, "board", { elements: [{ ...onScreen, x: 564 }] });      // the user nudges it mid-resync
  expect(m.op.elements[0].version).toBe(1);                                   // all the empty replica can know
  expect(a.r.streams.board.get("shape").x).toBe(564);                         // and it shows
  w.settle();                                                                 // reconnect from 0, catch up, then send
  const entry = w.log.entries.find(e => e.id === m.id);
  expect(entry.op.elements[0].version).toBe(6);                               // one past the room's copy, not 1
  expect(w.room.streams.board.get("shape")).toMatchObject({ x: 564, version: 6 });
  for (const c of w.clients) expect(c.r.streams.board.get("shape").x).toBe(564);
  expect(a.r.state()).toEqual(b.r.state());
  expect(w.log.entries.filter(e => e.id === m.id).length).toBe(1);
});

test("an unsent edit that a peer overtakes is stamped past the peer's before it goes (never acked dead)", () => {
  const d = direct(), clock = { t: 0 }, a = link(d, clock, "u0", "editor", "a").open().sync(), b = link(d, clock, "u1", "editor", "b").open().sync();
  a.r.local("board", { elements: [rect("s")] }); a.sync(); b.sync();
  for (let i = 0; i < 100; i++) b.r.local("notes", { elements: [rect(`n${i}`)] });
  b.up(); b.down();                                                           // b's burst is spent
  const mine = b.r.local("board", { elements: [{ ...clone(b.r.streams.board.get("s")), x: 7 }] });   // waits for the pace, at version 2
  for (let i = 0; i < 3; i++) { a.r.local("board", { elements: [{ ...clone(a.r.streams.board.get("s")), x: 100 + i }] }); a.sync(); }
  b.down();                                                                   // a's three edits arrive first: the room is at version 4
  const stamped = mine.op.elements[0].version;                                // 5, or 4 when b's nonce wins the tie at 4: it leads either way
  expect(stamped === 5 || stamped === 4).toBe(true);
  expect(b.r.streams.board.get("s").x).toBe(7);                               // b's own edit is still what b sees
  clock.t += 1000; b.sync(); a.sync();
  expect(d.room.streams.board.get("s")).toMatchObject({ x: 7, version: stamped });
  expect(a.r.streams.board.get("s").x).toBe(7);
});

test("after a cancelled 5,000-move drag the replica's copy wins, so a peer's edit still applies", () => {
  const d = direct(), clock = { t: 0 }, a = link(d, clock, "u0", "editor", "a").open().sync(), b = link(d, clock, "u1", "editor", "b").open().sync();
  a.r.local("board", { elements: [rect("box")] }); a.sync(); b.sync();
  // a's editor keeps its own copy of the stream (as web/ does), fed with what receive() returns.
  const editor = new Doc(emptyScene());
  const feed = did => { for (const e of did.entries) if (e.stream === "board" && e.op.elements) editor.apply({ elements: e.op.elements }); };
  editor.apply({ elements: [clone(a.r.streams.board.get("box"))] });
  const live = editor.get("box");
  for (let i = 0; i < 5000; i++) { touch(live); live.x = i; }                 // the drag: a version per move, no op
  // Escape: the gesture ends with no commit. The editor's copy is far ahead of the replica's, with nothing pending.
  expect([editor.get("box").version, a.r.streams.board.get("box").version, a.r.hasPending("board", "box")]).toEqual([5001, 1, false]);
  const back = a.r.reconcile("board", [...editor.byId.values()]);
  expect(back.map(el => [el.id, el.version, el.x])).toEqual([["box", 1, 0]]);
  editor.apply({ elements: back }, { force: true });                          // the replica's copy wins
  b.r.local("board", { elements: [{ ...clone(b.r.streams.board.get("box")), x: 40 }] }); b.sync();
  a.down(); a.did.slice(-2).forEach(feed);
  expect(editor.get("box")).toMatchObject({ x: 40, version: 2 });             // the peer's edit applies
  expect(editor.get("box")).toEqual(a.r.streams.board.get("box"));
  // Nothing to reconcile while a real edit is pending, or when the editor is not ahead.
  const pendingEdit = clone(editor.get("box")); touch(pendingEdit); touch(pendingEdit);
  a.r.local("board", { elements: [pendingEdit] });
  expect(a.r.reconcile("board", [pendingEdit])).toEqual([]);
  expect(a.r.reconcile("board", [clone(a.r.streams.board.get("box"))])).toEqual([]);
  expect(a.r.reconcile("board", [rect("never-sent", { version: 9 })])).toEqual([{ id: "never-sent", gone: true }]);
});

test("previews expire after 5 s, clear on leave and on the final op's entry", () => {
  const clock = { t: 0 }, r = new Replica({ client: "p", now: () => clock.t });
  const batch = (client, id) => ({ t: "presence", batch: [{ user: "u9", client, k: "preview", stream: "board", elements: [rect(id)] }] });
  r.receive(batch("x", "one")); clock.t += 3000; r.receive(batch("y", "two"));
  clock.t += 2000; r.prunePreviews();
  expect([...r.previews.keys()]).toEqual(["two"]);
  r.receive(batch("x", "three"));
  r.receive({ t: "presence", batch: [{ user: "u9", client: "y", k: "leave" }] });
  expect([...r.previews.keys()]).toEqual(["three"]);
  expect(r.streams.board.getAny("three")).toBe(null);                         // never merged into the board
});

test("previews are kept per stream: a notes view never lists board previews, and one stream's final op clears only its own", () => {
  const clock = { t: 0 }, r = new Replica({ client: "p", now: () => clock.t });
  const batch = (stream, id, extra = {}) => ({ t: "presence", batch: [{ user: "u9", client: "x", k: "preview", stream, elements: [rect(id, extra)] }] });
  r.receive(batch("board", "b1")); r.receive(batch("notes", "n1")); r.receive(batch("board", "same", { x: 1 })); r.receive(batch("notes", "same", { x: 2 }));
  expect(r.previewsOf("board").map(el => el.id).sort()).toEqual(["b1", "same"]);
  expect(r.previewsOf("notes").map(el => [el.id, el.x]).sort()).toEqual([["n1", 0], ["same", 2]]);
  expect(r.previewsOf("records")).toEqual([]);
  expect([...r.previews.keys()].sort()).toEqual(["b1", "n1", "same"]);          // the all-streams view older callers use
  r.receive({ t: "presence", batch: [{ user: "u9", client: "x", k: "preview", elements: [rect("no-stream")] }] });   // no stream: ignored
  expect(r.previews.has("no-stream")).toBe(false);
  // The final op for "same" lands on the board: the board preview goes, the notes one stays.
  r.receive({ t: "welcome", seq: 0, role: "viewer", user: "u1", horizon: 0, rv: 1 });
  r.receive({ t: "entries", entries: [{ seq: 1, board: "b1", tenant: "t1", stream: "board", op: { elements: [rect("same")] }, by: "u9", id: "x:1", at: 1, rv: 1 }] });
  expect(r.previewsOf("board").map(el => el.id)).toEqual(["b1"]);
  expect(r.previewsOf("notes").map(el => el.id).sort()).toEqual(["n1", "same"]);
  expect(r.previews.get("same").x).toBe(2);
  clock.t += 4000; r.receive(batch("notes", "n1"));                           // refreshed; the rest expire at 5 s
  clock.t += 1000;
  expect([r.previewsOf("board"), r.previewsOf("notes").map(el => el.id), [...r.previews.keys()]]).toEqual([[], ["n1"], ["n1"]]);
  r.receive({ t: "presence", batch: [{ user: "u9", client: "x", k: "leave" }] });
  expect(r.previewsOf("notes")).toEqual([]);
});

test("a socket that drops counts toward the backoff: before welcome, after it, once per connection; only catching up resets it", () => {
  const d = direct(), clock = { t: 0 }, a = link(d, clock);
  const m = a.r.local("board", { elements: [rect("kept")] });
  const waits = [];
  for (let i = 0; i < 4; i++) {                                               // the socket dies before any welcome, four times
    a.r.connectMessages("tok", "b1");
    a.r.connectionFailed();
    expect([a.r.resync, a.r.outgoing(), a.r.wait()]).toEqual([true, [], null]);
    waits.push(a.r.reconnectWait());
  }
  expect(waits).toEqual([500, 1000, 2000, 4000]);                             // min(30 s, 0.5 s × 2^k) × 0.5 (the test's random is 0)
  expect([a.r.fails, a.r.pending.size, a.r.pending.has(m.id)]).toEqual([4, 1, true]);
  a.r.connectMessages("tok", "b1");                                           // welcomed, then dropped mid catch-up: still a failure
  a.r.receive({ t: "welcome", seq: 5, role: "editor", user: "u1", high: 0, horizon: 0, rv: 1 });
  a.r.connectionFailed(); a.r.connectionFailed();                             // told twice (error, then close): counted once
  expect(a.r.fails).toBe(5);
  a.r.connectMessages("tok", "b1");                                           // a timeout and then the close it causes: counted once
  clock.t += 10_000; a.r.outgoing(); a.r.connectionFailed();
  expect(a.r.fails).toBe(6);
  a.r.connectMessages("tok", "b1");                                           // `unavailable`, then the server's close: once
  a.r.receive({ t: "error", code: "unavailable", message: "moving" }); a.r.connectionFailed();
  expect(a.r.fails).toBe(7);
  a.open().sync();                                                            // a good connection: caught up, and it stays up
  expect([a.r.fails, a.r.pending.size, d.log.entries.length]).toEqual([7, 0, 1]);
  clock.t += 10_000;
  a.r.connectionFailed();                                                     // proven, then dropped: counted as the first failure
  expect([a.r.fails, a.r.resync, a.r.applied, a.r.reconnectWait()]).toEqual([1, true, 1, 500]);
  const idle = new Replica({ client: "never", now: () => clock.t });
  idle.connectionFailed();                                                    // no connection was ever started: nothing to count
  expect([idle.fails, idle.resync]).toEqual([0, false]);
});

test("a server that welcomes and then drops still meets growing waits; only 10 s of staying up after catch-up starts them over", () => {
  const d = direct(), clock = { t: 0 }, a = link(d, clock);
  const drops = [], timeouts = [];
  for (let i = 0; i < 6; i++) {                                               // an idle board: welcome.seq == applied, then the socket drops
    a.open().sync();
    expect([a.r.welcomed, a.r.applied, a.r.target]).toEqual([true, 0, 0]);
    clock.t += 9999;                                                          // not quite 10 s
    a.r.connectionFailed();
    drops.push(a.r.reconnectWait());
  }
  expect(drops).toEqual([500, 1000, 2000, 4000, 8000, 15_000]);
  a.open().sync(); clock.t += 10_000;                                         // this one stays up 10 s: proven
  a.r.connectionFailed();
  expect([a.r.reconnectWait(), a.r.fails]).toEqual([500, 1]);
  // The same with an op that gets no answer for 10 s on each connection (welcomed, caught up, then silence).
  const b = link(d, clock, "u2", "editor", "b");
  for (let i = 0; i < 6; i++) {
    b.open().sync();
    b.r.local("board", { elements: [rect(`t${i}`)] });
    b.r.outgoing();                                                           // written; the answer never comes
    clock.t += 9999; b.r.outgoing(); expect(b.r.resync).toBe(false);
    clock.t += 1; b.r.outgoing(); expect(b.r.resync).toBe(true);
    timeouts.push(b.r.reconnectWait());
  }
  expect(timeouts).toEqual([500, 1000, 2000, 4000, 8000, 15_000]);
  expect(b.r.pending.size).toBe(1);                                           // each was resent and acked on the next connection; the last is kept
  // A connection that worked for 10 s and only then went silent is a first failure again.
  b.open().sync(); clock.t += 10_000;
  b.r.local("board", { elements: [rect("late")] }); b.r.outgoing();
  clock.t += 10_000; b.r.outgoing();
  expect([b.r.resync, b.r.reconnectWait()]).toEqual([true, 500]);
  // A refusal's resync after a long healthy connection is not held back by old failures.
  b.open().sync(); clock.t += 10_000;
  const bad = b.r.local("board", { appState: { bogus: 1 } });
  d.room.receive(b.c, JSON.parse(JSON.stringify(b.r.outgoing()[0])), { n: ++b.n });
  b.down();
  expect([b.r.resync, b.r.pending.has(bad.id), b.r.reconnectWait(), b.r.fails]).toEqual([true, false, 250, 0]);
});

// p6-sync2v M3: ops made during a resync were stamped v1…vk on the empty copy; once k passed the room's
// version only the top was re-stamped, so the lower ones went out at versions the room had already passed.
for (const k of [1, 2, 4, 5, 7, 12]) test(`a chain of ${k} edits on one element made during a resync: none goes out at or below the room's version, and the last one wins`, () => {
  for (let seed = 1; seed <= 40; seed++) {
    const w = world(["editor", "editor"], 600 + seed);
    w.settle();
    const [a, b] = w.clients;
    w.send(a, "board", { elements: [rect("shape", { x: 0 })] }); w.settle();
    for (let i = 0; i < 3; i++) { w.send(b, "board", { elements: [clone(b.r.streams.board.get("shape"))] }); w.settle(); }
    expect(w.room.streams.board.get("shape").version).toBe(4);                // the room's copy: r = 4
    const onScreen = clone(a.r.streams.board.get("shape"));
    const bad = w.send(a, "board", { appState: { bogus: 1 } });
    w.flush(a);
    a.r.receive(errors(a).find(e => e.id === bad.id));                        // refused: a's copy is empty, a resync is due
    const chain = [], knew = new Map(), out = a.r.outgoing.bind(a.r);
    // What a had confirmed of the room's copy at the moment each op left (a peer's edit still in flight is a fair race).
    a.r.outgoing = () => { const ms = out(); for (const m of ms) if (!knew.has(m.id)) knew.set(m.id, a.r.roomVersion("board", "shape")); return ms; };
    for (let i = 1; i <= k; i++) chain.push(w.send(a, "board", { elements: [{ ...onScreen, x: 1000 + i }] }).id);
    const peer = seed % 2 ? w.send(b, "board", { elements: [{ ...clone(b.r.streams.board.get("shape")), x: -5 }] }).id : null;   // a concurrent v5
    if (seed % 4 === 1) w.flush(b);                                           // sometimes the peer's edit is logged first for sure
    for (let i = 0; i < (seed % 7) * 3; i++) w.step();
    if (seed % 5 === 0) w.rebuild();                                          // and sometimes the room restarts in the middle
    w.settle();
    const sent = [];
    for (const e of w.log.entries) for (const el of e.op.elements ?? []) if (el.id === "shape" && chain.includes(e.id)) sent.push({ at: chain.indexOf(e.id), version: el.version, knew: knew.get(e.id) });
    expect([seed, sent.map(s => s.at)]).toEqual([seed, chain.map((_, i) => i)]);               // all logged, once, in order
    expect([seed, sent.filter(s => !(s.knew >= 4) || s.version <= s.knew)]).toEqual([seed, []]);   // each went out above the room's version (≥ 4) as a knew it
    expect([seed, sent.map(s => s.version - sent[0].version)]).toEqual([seed, chain.map((_, i) => i)]);   // r + 1, r + 2, … in send order
    // With no peer racing, the chain's last op is the final state everywhere (with one, the usual merge decides; copies agree).
    if (!peer) {
      expect([seed, w.room.streams.board.get("shape").version]).toEqual([seed, 4 + k]);
      expect([seed, w.room.streams.board.get("shape").x]).toEqual([seed, 1000 + k]);
      for (const c of w.clients) expect([seed, c.r.streams.board.get("shape").x, c.r.pending.size]).toEqual([seed, 1000 + k, 0]);
    }
    expect(a.r.state()).toEqual(b.r.state());
    if (peer) expect(w.log.entries.filter(e => e.id === peer).length).toBe(1);
  }
});

test("re-stamping leaves ops already sent byte for byte, and counts them: unsent ops go after them", () => {
  const d = direct(), clock = { t: 0 }, a = link(d, clock).open().sync();
  a.r.local("board", { elements: [rect("s")] }); a.sync();                    // the room: v1
  const first = a.r.local("board", { elements: [{ ...clone(a.r.streams.board.get("s")), x: 1 }] });
  const [written] = a.r.outgoing();                                           // v2 is written; the connection dies before it arrives
  const bytes = JSON.stringify(written);
  const second = a.r.local("board", { elements: [{ ...clone(a.r.streams.board.get("s")), x: 2 }] });   // v3, never sent
  const third = a.r.local("board", { elements: [{ ...clone(a.r.streams.board.get("s")), x: 3 }] });    // v4, never sent
  const other = link(d, clock, "u2", "editor", "o").open().sync();
  for (let i = 0; i < 5; i++) { other.r.local("board", { elements: [{ ...clone(other.r.streams.board.get("s")), x: -i }] }); other.sync(); }
  expect(d.room.streams.board.get("s").version).toBe(6);                      // the room moved on to v6 meanwhile
  expect(a.r.roomVersion("board", "s")).toBe(1);                              // a hasn't heard yet
  a.open(); a.down();                                                         // welcome + catch-up
  expect(a.r.roomVersion("board", "s")).toBe(6);
  expect([second.op.elements[0].version, third.op.elements[0].version]).toEqual([7, 8]);   // past the room's copy, in order
  expect(JSON.stringify(first)).toBe(bytes);                                  // the resend is the same op
  expect(a.r.streams.board.get("s").x).toBe(3);                               // a still sees its latest edit
  a.sync(); other.sync();
  expect(d.log.entries.find(e => e.id === first.id).op.elements[0].version).toBe(2);   // logged as sent: an honest loser to v6
  expect(d.room.streams.board.get("s")).toMatchObject({ x: 3, version: 8 });
  expect(other.r.streams.board.get("s").x).toBe(3);
  expect(a.r.roomVersion("board", "s")).toBe(8);
});

test("hello.tab: `new Replica({ tab })` puts it in every hello; without `tab` the hello has no tab key; a bad tab throws", () => {
  const withTab = new Replica({ client: "w", tab: "0123456789abcdef" });
  const [h1] = withTab.connectMessages("tok", "b1");
  expect(h1).toEqual({ t: "hello", v: 1, token: "tok", board: "b1", since: 0, client: withTab.client, tab: "0123456789abcdef" });
  withTab.connectionFailed();
  expect(withTab.connectMessages("tok", "b1")[0].tab).toBe("0123456789abcdef");   // the same tab on every reconnect
  const plain = new Replica({ client: "p" });
  const [h2] = plain.connectMessages("tok", "b1");
  expect(Object.hasOwn(h2, "tab")).toBe(false);                               // absent, not `tab: undefined`
  expect(JSON.parse(JSON.stringify(h2))).toEqual(h2);
  for (const tab of ["", "x".repeat(33), "a:b", 7, null]) expect(() => new Replica({ client: "x", tab })).toThrow();
  // The room ignores the field (only the gateway counts tabs): a hello with `tab` is welcomed as usual.
  const d = direct(), got = [], c = d.room.connect(m => got.push(wire(m)));
  d.room.receive(c, wire(h1), { n: 1, user: "u", role: "editor" });
  expect(got[0]).toMatchObject({ t: "welcome", user: "u" });
});

test("welcome.can.share is kept as canShare: true only when the welcome says so, false when absent or not exactly true", () => {
  const mk = can => { const r = new Replica({ client: "c" }); r.receive({ t: "welcome", seq: 0, role: "annotator", user: "u", horizon: 0, rv: 1, ...(can ? { can } : {}) }); return r; };
  expect(mk({ share: true }).canShare).toBe(true);
  expect(mk({ share: "yes" }).canShare).toBe(false);
  expect(mk(null).canShare).toBe(false);
  expect(new Replica({ client: "c" }).canShare).toBe(false);
});
