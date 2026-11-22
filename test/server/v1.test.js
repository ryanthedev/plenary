// The server on protocol v1.1 (brief p2-swap): presence relay, recovery across restarts and rebuilds, the bus cap,
// § Pacing (writer cap, op bucket, queue cap), revocation by token expiry, and rule 6's connection lists.
import { test, expect, afterAll } from "bun:test";
import { rig, client, tokenOf, settled, rawSock } from "./rig.js";
import { cleanup, sleep, until } from "./helpers.js";
import { subjects } from "../../server/bus/port.js";
import { splitEntries } from "../../server/room-host.js";
import { makeElement } from "../../packages/core/model.js";

afterAll(cleanup);
const rect = (id, x = 0) => makeElement("rectangle", { id, x, y: 0, width: 10, height: 10 });
const hello = (r, name, extra = {}) => ({ t: "hello", v: 1, token: tokenOf(name), board: r.ids.board, since: 0, client: name, ...extra });
const op = (client, n, el, extra = {}) => ({ t: "op", id: `${client}:${n}`, sentAt: 0, stream: "board", op: { elements: [el] }, ...extra });

test("presence is relayed between two clients (not back to its sender) and never reaches the room, the log or a checkpoint", async () => {
  const r = await rig();
  const seen = [];
  r.bus.subscribe(subjects.entries(r.ids.tenant, r.ids.board), m => seen.push(m));
  const a = await r.sock(), b = await r.sock(), v = await r.sock();
  a.send(hello(r, "editor")); b.send(hello(r, "annotator")); v.send(hello(r, "viewer"));
  for (const s of [a, b, v]) await s.next(m => m.t === "welcome");
  a.send({ t: "presence", k: "cursor", x: 10, y: 20 });
  a.send({ t: "presence", k: "laser", pts: [[1, 2, 3]] });
  a.send({ t: "presence", k: "cursor", x: 1, y: 2, junk: "x".repeat(10) });   // extra fields never travel
  b.send({ t: "presence", k: "laser", pts: [[1, 2, 3]] });                    // annotators can't laser: dropped silently
  v.send({ t: "presence", k: "cursor", x: 5, y: 5 });                         // viewers send emotes only
  const got = await b.next(m => m.t === "presence" && m.batch.some(x => x.k === "cursor" && x.x === 1));
  expect(got.batch.find(x => x.k === "cursor")).toEqual({ user: "dev:editor", client: "editor", k: "cursor", x: 1, y: 2 });
  await v.next(m => m.t === "presence");
  await sleep(120);
  expect(a.msgs.some(m => m.t === "presence" && m.batch.some(x => x.user === "dev:editor"))).toBe(false);   // not echoed
  expect([...b.msgs, ...v.msgs].filter(m => m.t === "presence").flatMap(m => m.batch).some(x => x.user !== "dev:editor")).toBe(false);
  expect(a.msgs.concat(b.msgs, v.msgs).some(m => m.t === "error")).toBe(false);   // presence never gets an error
  // Leaving tells the others.
  await a.close();
  await b.next(m => m.t === "presence" && m.batch.some(x => x.k === "leave" && x.user === "dev:editor"));
  // Nothing of it in the room's inbox, the log, the entries subject, or a checkpoint.
  await r.idle();
  expect(r.inbox.some(m => m.msg?.t === "presence")).toBe(false);
  expect(await r.store.lastSeq(r.ids.tenant, r.ids.board)).toBe(0);
  expect(seen.every(m => !m.items)).toBe(true);
  (await r.room()).checkpoint();
  await until(async () => (await r.rawStore.getCheckpoint(r.ids.tenant, r.ids.board)) !== null, "a checkpoint");
  expect(JSON.stringify(await r.rawStore.getCheckpoint(r.ids.tenant, r.ids.board))).not.toContain("cursor");
  await r.stop();
});

test("viewers' emotes arrive as summed counts per window, never as presence and never at the room", async () => {
  const r = await rig({ limits: { emoteWindowMs: 50 } });
  const w = await r.sock(), v1 = await r.sock(), v2 = await r.sock();
  w.send(hello(r, "editor")); v1.send(hello(r, "viewer", { client: "v1" })); v2.send(hello(r, "viewer", { client: "v2" }));
  for (const s of [w, v1, v2]) await s.next(m => m.t === "welcome");
  v1.send({ t: "presence", k: "emote", e: "🎉" }); v2.send({ t: "presence", k: "emote", e: "🎉" }); v2.send({ t: "presence", k: "emote", e: "🔥" });
  v1.send({ t: "presence", k: "emote", e: "not-an-emote" });
  const got = await w.next(m => m.t === "emotes");
  expect(got.counts).toEqual({ "🎉": 2, "🔥": 1 });
  expect(w.msgs.some(m => m.t === "presence" && m.batch.some(x => x.k === "emote"))).toBe(false);
  await r.stop();
});

test("a resend after a server restart gets the same seq (rule 2 across restarts); nothing is logged twice", async () => {
  let r = await rig();
  const a = client(r, "editor", "persist");
  await a.connect();
  const sent = a.send("board", { elements: [rect("one")] });
  await settled(r, [a]);
  const ackSeq = a.msgs.find(m => m.t === "ack" && m.id === sent.id).seq;
  const { dir, registry, ids } = r;
  await a.drop(); await r.stop();
  r = await rig({ dir, registry, ids });
  // The same op, as the client resends it after its welcome: same id, same sentAt.
  const s = await r.sock(); s.send(hello(r, "editor", { client: sent.id.split(":")[0] }));   // the Replica's own client id
  const welcome = await s.next(m => m.t === "welcome");
  expect(welcome.high).toBe(Number(sent.id.split(":")[1]));
  expect(welcome.room.epoch).toBe(2);                                  // a new build, a higher epoch
  s.send({ t: "op", id: sent.id, sentAt: sent.sentAt, stream: "board", op: sent.op });
  expect(await s.next(m => m.t === "ack")).toEqual({ t: "ack", id: sent.id, seq: ackSeq });
  expect((await r.rawStore.read(r.ids.tenant, r.ids.board, 1, 10)).map(e => e.id)).toEqual([sent.id]);
  await r.stop();
});

test("an op from a connection the rebuilt room never welcomed gets `unavailable` with its id, is not logged, and the client is closed", async () => {
  let failNext = false;
  const r = await rig({ wrapStore: s => ({ ...s, append: async (...a) => { if (failNext) { failNext = false; throw new Error("disk hiccup"); } return s.append(...a); } }) });
  const a = await r.sock(), b = await r.sock();
  a.send(hello(r, "editor", { client: "a" })); b.send(hello(r, "owner", { client: "b" }));
  await a.next(m => m.t === "welcome"); await b.next(m => m.t === "welcome");
  failNext = true;
  a.send(op("a", 1, rect("x")));                                      // the append fails: the room is thrown away
  await a.whenClosed();
  await r.server.rooms.open(r.ids.tenant, r.ids.board);               // a new room (new epoch) knows no connection
  const room = await r.room();
  expect(room.epoch).toBe(2);
  // b's socket was told too (every writer of the failed room is), but its last frames may already be on the bus:
  // the rebuilt room must refuse them by connection, whatever their `n`. Replay b's own envelope at the next n.
  const env = r.inbox.find(m => m.client === "b" && m.msg?.t === "hello");
  const replies = [];
  r.bus.subscribe(subjects.gateway(r.server.gateway.id), m => replies.push(m));
  await r.bus.publish(subjects.inbox(r.ids.tenant, r.ids.board), { ...env, n: 2, msg: op("b", 1, rect("y")) });
  await r.idle();
  expect(await r.rawStore.lastSeq(r.ids.tenant, r.ids.board)).toBe(0);
  await b.whenClosed();
  expect(b.msgs.filter(m => m.t === "error").map(m => m.code)).toContain("unavailable");
  // What the rebuilt room said to that connection: `unavailable` naming the op, and a close for the gateway.
  expect(replies.map(m => [JSON.parse(m.data), m.close])).toEqual([[{ t: "error", id: "b:1", code: "unavailable", message: "this room has not welcomed that connection: reconnect" }, 1013]]);
  await r.stop();
});

test("the bus cap: `.entries` batches are split under it in seq order, and an op too big for the inbox gets `too-large` with its id", async () => {
  // splitEntries itself: quotes double when re-encoded, so the cap is measured on the escaped form.
  const entries = Array.from({ length: 6 }, (_, i) => ({ seq: i + 1 }));
  const items = entries.map((e, i) => JSON.stringify({ seq: e.seq, text: '"'.repeat(300 + i) }));
  const parts = splitEntries(entries, items, 1500);
  expect(parts.flatMap(p => p.items)).toEqual(items);
  expect(parts.every(p => JSON.stringify(p).length <= 1500)).toBe(true);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.map(p => [p.from, p.to])).toEqual(parts.map(p => [JSON.parse(p.items[0]).seq, JSON.parse(p.items.at(-1)).seq]));

  // Over a real (small-capped) bus: a group commit of several ops goes out split; every client still gets each once.
  const cap = 40 * 1024;
  const { memoryBus } = await import("../../server/bus/memory.js");
  const r = await rig({ wrapBus: () => memoryBus({ maxBytes: cap }) });
  const msgs = [];
  r.bus.subscribe(subjects.entries(r.ids.tenant, r.ids.board), m => { if (m.items) msgs.push(m); });
  const w = await r.sock(), v = await r.sock();
  w.send(hello(r, "editor")); v.send(hello(r, "viewer"));
  await w.next(m => m.t === "welcome"); await v.next(m => m.t === "welcome");
  const fat = i => ({ ...rect("f" + i), customData: { pad: '"'.repeat(12_000) } });   // ~24 KB on the bus each
  for (let i = 1; i <= 6; i++) w.send(op("editor", i, fat(i)));
  await w.next(m => m.t === "ack" && m.id === "editor:6");
  await until(() => v.msgs.filter(m => m.t === "entries").flatMap(m => m.entries).length === 6, "the viewer to get all six");
  expect(v.msgs.filter(m => m.t === "entries").flatMap(m => m.entries.map(e => e.seq))).toEqual([1, 2, 3, 4, 5, 6]);
  expect(msgs.every(m => JSON.stringify(m).length <= cap)).toBe(true);
  // An op whose inbox envelope can't fit: answered by id, never numbered (the next op is no gap).
  w.send(op("editor", 7, { ...rect("huge"), customData: { pad: "x".repeat(cap) } }));
  expect(await w.next(m => m.id === "editor:7")).toMatchObject({ t: "error", code: "too-large" });
  w.send(op("editor", 8, rect("after")));
  expect(await w.next(m => m.t === "ack" && m.id === "editor:8")).toMatchObject({ seq: 7 });
  await r.stop();
});

test("§ Pacing: a ninth writer connection per (user, board) gets `limit` and is closed; viewers and other users are not counted", async () => {
  const r = await rig();
  const eight = [];
  for (let i = 0; i < 8; i++) { const s = await r.sock(); s.send(hello(r, "editor", { client: "tab" + i })); await s.next(m => m.t === "welcome"); eight.push(s); }
  const ninth = await r.sock(); ninth.send(hello(r, "editor", { client: "tab8" }));
  expect((await ninth.whenClosed()).code).toBe(1008);
  expect(ninth.msgs).toEqual([{ t: "error", code: "limit", message: "at most 8 open writer tabs per user on a board" }]);
  const other = await r.sock(); other.send(hello(r, "owner")); await other.next(m => m.t === "welcome");
  // A slot frees when the gateway sees a connection close.
  await eight[0].close();
  await sleep(30);
  const again = await r.sock(); again.send(hello(r, "editor", { client: "tab9" }));
  await again.next(m => m.t === "welcome");
  await r.stop();
});

test("§ Pacing: over-rate ops wait in the gateway in order and are all acked; past the queue cap the connection gets `unavailable`", async () => {
  const r = await rig({ limits: { opRate: 50, opBurst: 5, maxOpQueue: 30 } });
  const s = await r.sock(); s.send(hello(r, "editor")); await s.next(m => m.t === "welcome");
  const t0 = Date.now();
  for (let i = 1; i <= 25; i++) s.send(op("editor", i, rect("p" + i)));
  await s.next(m => m.t === "ack" && m.id === "editor:25", "the last ack", 10_000);
  expect(Date.now() - t0).toBeGreaterThan(300);                        // 20 over the burst at 50/s: ≥ 400 ms, paced
  const acks = s.msgs.filter(m => m.t === "ack");
  expect(acks.map(m => m.id)).toEqual(Array.from({ length: 25 }, (_, i) => `editor:${i + 1}`));
  expect(acks.map(m => m.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  expect(s.msgs.some(m => m.t === "error")).toBe(false);
  // A client that ignores the pace by far: queue cap → `unavailable`, closed (it keeps its ops and resends).
  for (let i = 26; i <= 100; i++) s.send(op("editor", i, rect("q" + i)));
  expect((await s.whenClosed()).code).toBe(1013);
  expect(s.msgs.at(-1)).toMatchObject({ t: "error", code: "unavailable" });
  await r.stop();
});

test("a connection is closed with `auth` when its token's expiry passes; an expired token is refused at hello", async () => {
  // The expiry is stamped when verify runs (1-2 s ahead), not before the rig is built: on a loaded machine, building
  // the rig and saying hello took over a second, the token was already expired at hello, and the welcome never came
  // (bun's 5 s default timeout, manager t18m, 2026-11-12). `expired` switches to a past expiry for the second half.
  let expired = false;
  const r = await rig({ wrapAuth: a => ({ ...a, verify: async t => { const id = await a.verify(t); return id && { ...id, exp: Math.floor(Date.now() / 1000) + (expired ? -1 : 2) }; } }) });
  const s = await r.sock(); s.send(hello(r, "editor")); await s.next(m => m.t === "welcome");
  expect((await s.whenClosed(5_000)).code).toBe(1008);
  expect(s.msgs.at(-1)).toMatchObject({ t: "error", code: "auth", message: "your sign-in expired" });
  expired = true;
  const late = await r.sock(); late.send(hello(r, "editor"));
  expect((await late.whenClosed()).code).toBe(1008);
  expect(late.msgs).toEqual([{ t: "error", code: "auth", message: "not allowed" }]);
  await r.stop();
}, 20000);

test("rule 6: a room forgets a gateway silent for 30 s (its clock), unless the gateway's 5 s connection lists keep it heard", async () => {
  for (const lists of [true, false]) {
    let skew = 0;
    const r = await rig({ host: { now: () => Date.now() + skew, sweepMs: 20 }, limits: { connListMs: lists ? 20 : 3_600_000 } });
    const s = await r.sock(); s.send(hello(r, "editor")); await s.next(m => m.t === "welcome");
    for (let i = 0; i < 31; i++) { skew += 1_000; await sleep(10); }  // 31 s pass on the room's clock, a second per 10 ms
    await sleep(60);
    s.send(op("editor", 1, rect("after-silence")));
    const answer = await s.next(m => m.id === "editor:1");
    expect([lists, answer.t, answer.code]).toEqual(lists ? [true, "ack", undefined] : [false, "error", "unavailable"]);
    await r.stop();
  }
});

test("a board feed picks up the host's checkpoint written just after the entries that triggered it (on the next heartbeat): a joiner from 0 gets that snapshot and only the entries after it", async () => {
  // One 50 KB text rewritten 10 times: the host folds by bytes (tailFoldBytes 64 KB) only when nothing is in flight
  // (room-host.js foldIfDue). Its checkpoint is written right after the entries are published, so the feed's look on
  // those entries misses it; the heartbeat (2 s) brings the retry.
  // Deterministic order (p2-tunev LOW 2): op 1, then ops 2 and 3 together (op 2's fold is skipped while 3 is in flight),
  // then 4 to 10 one at a time. Folds land on 3, 5, 7, 9 and op 10 alone is under the trigger, so the room's base
  // settles at 9, not 10. The test asserts on whatever base the room settles at, never on a fixed seq.
  const r = await rig({ host: { tailFoldBytes: 64 * 1024 } });
  const w = await r.sock(); w.send(hello(r, "editor")); await w.next(m => m.t === "welcome");
  const text = n => ({ id: "note", type: "text", version: n, versionNonce: n, x: 0, y: 0, width: 10, height: 10, isDeleted: false, text: String(n % 10).repeat(50_000) });
  const ack = n => w.next(m => m.t === "ack" && m.id === `editor:${n}`);
  w.send(op("editor", 1, text(1))); await ack(1);
  w.send(op("editor", 2, text(2))); w.send(op("editor", 3, text(3))); await ack(2); await ack(3);
  for (let n = 4; n <= 10; n++) { w.send(op("editor", n, text(n))); await ack(n); }
  await r.idle();
  // The host folds in a setTimeout(0) queued when the entries resolve: once resolved is 10, one more macrotask turn
  // has run every fold that will ever come.
  await until(async () => (await r.room()).resolved === 10, "the room to resolve op 10", 15000);
  await sleep(0); await sleep(0);
  const base = (await r.room()).base.seq;
  expect(base).toBeGreaterThan(0);                                         // the byte trigger folded at least once
  const feed = () => r.server.gateway.feed(r.ids.tenant, r.ids.board);
  await until(() => feed()?.base === base, `the feed to rebase onto seq ${base} (on the next heartbeat)`, 15000);
  expect(feed()).toMatchObject({ base, seq: 10, tail: 10 - base });
  const j = await r.sock(); j.send(hello(r, "viewer"));
  const snap = await j.next(m => m.t === "snapshot");
  expect(snap.seq).toBe(base);
  await until(() => j.msgs.filter(m => m.t === "entries").flatMap(m => m.entries ?? []).length >= 10 - base, "the tail after the snapshot");
  await sleep(100);
  const seqs = j.msgs.filter(m => m.t === "entries").flatMap(m => (m.entries ?? []).map(e => e.seq));
  expect(seqs).toEqual(Array.from({ length: 10 - base }, (_, i) => base + 1 + i));   // only what follows the snapshot
  expect(w.closed).toBe(null);
  await r.stop();
}, 20000);

test("§ Pacing: frames read from a live socket faster than they are handled are capped in bytes: past maxLiveQueuedBytes, `unavailable` and close", async () => {
  // One TCP write of 300 frames of ~1 KB: Bun hands them to the gateway back to back, before its pump handles one.
  const r = await rig({ limits: { maxLiveQueuedBytes: 32 * 1024 } });
  const s = await rawSock(r.server.wsUrl, { frames: true }); s.send(hello(r, "editor"));
  s.read();
  await until(() => s.texts.some(t => t.includes('"welcome"')), "the welcome");
  const pad = "x".repeat(1000);
  const burst = Array.from({ length: 300 }, (_, i) => ({ t: "presence", k: "cursor", x: i, y: 0, pad }));
  for (const m of burst) s.send(m);
  await s.closed;
  expect(s.texts.map(t => JSON.parse(t)).filter(m => m.t === "error")).toEqual([{ t: "error", code: "unavailable", message: "too much sent at once" }]);
  expect(r.logs().some(l => l.msg === "frame queue overflow" && l.state === "live")).toBe(true);
  // A well-behaved client on the same board is untouched.
  const ok = await r.sock(); ok.send(hello(r, "viewer")); await ok.next(m => m.t === "welcome");
  expect(ok.closed).toBe(null);
  await r.stop();
}, 20000);

test("§ Pacing: an idle viewer that answers pings survives the idle timeout; a socket that never answers is closed", async () => {
  // idleTimeoutSec 8 (Bun's smallest useful value; it pings idle sockets itself). Bun's client answers pings; the raw
  // socket never does (it reads frames but writes nothing after its hello).
  const r = await rig({ limits: { idleTimeoutSec: 8 } });
  const v = await r.sock(); v.send(hello(r, "viewer")); await v.next(m => m.t === "welcome");
  const raw = await rawSock(r.server.wsUrl); raw.send(hello(r, "viewer", { client: "raw" })); raw.read();
  await until(() => r.server.gateway.stats().conns === 2, "both connected");
  const t0 = Date.now();
  await until(() => raw.ended, "the silent socket to be closed", 25000);
  const after = (Date.now() - t0) / 1000;
  expect(after).toBeGreaterThan(4);                                     // not at once: only after the idle timeout
  await sleep(10_000);                                                  // past the timeout again for the idle viewer
  expect(v.closed).toBe(null);
  expect(r.server.gateway.stats().conns).toBe(1);
  await r.stop();
}, 60000);
