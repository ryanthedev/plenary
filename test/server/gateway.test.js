// The gateway over real sockets: /health, auth before the room, bad frames, durability order, convergence.
import { test, expect, afterAll } from "bun:test";
import { rig, tokenOf, SECRET, settled, roomState, client } from "./rig.js";
import { cleanup, sleep, until, deferred } from "./helpers.js";
import { canWrite } from "../../packages/protocol/envelope.js";
import { makeElement, touch, clone } from "../../packages/core/model.js";

afterAll(cleanup);
const rect = (id, x = 0) => makeElement("rectangle", { id, x, y: 0, width: 10, height: 10 });
const hello = (r, name, extra = {}) => ({ t: "hello", v: 1, token: tokenOf(name), board: r.ids.board, since: 0, client: "raw", ...extra });
// `here` (presence summary, § Presence) comes right after catch-up and on every count change; these tests are about the
// op stream, so they read past it.
const noHere = m => m.t !== "here";
const noSecrets = r => expect(r.lines.join("")).not.toContain(SECRET);

test("/health answers 200 with small JSON; other paths 404; /ws without an upgrade 426", async () => {
  const r = await rig();
  const h = await r.health();
  expect(h.status).toBe(200);
  expect(h.body).toMatchObject({ ok: true, rooms: 0, gateway: { conns: 0 } });
  expect((await fetch(r.server.url + "/nope")).status).toBe(404);
  expect((await fetch(r.server.url + "/ws")).status).toBe(426);
  expect((await fetch(r.server.url + "/health", { method: "POST" })).status).toBe(404);
  await r.stop();
});

test("an extra http handler serves its routes; one that throws gives 500 and the server lives", async () => {
  const { createServer } = await import("../../server/server.js");
  const r = await rig();
  const s = createServer({ auth: {}, registry: {}, store: r.store, bus: r.bus, port: 0, http: (req, url) => { if (url.pathname === "/boom") throw new Error("boom"); if (url.pathname === "/hi") return new Response("hi"); } });
  expect(await (await fetch(s.url + "/hi")).text()).toBe("hi");
  expect((await fetch(s.url + "/boom")).status).toBe(500);
  expect((await fetch(s.url + "/health")).status).toBe(200);
  await s.stop(); await r.stop();
});

test("auth is refused before a room sees the hello: bad token, unknown board, no role", async () => {
  const r = await rig();
  const cases = {
    "bad token": { t: "hello", v: 1, token: `${SECRET}-wrong`, board: r.ids.board, since: 0, client: "raw" },
    "no token": { t: "hello", v: 1, board: r.ids.board, since: 0, client: "raw" },
    "token not a string": { t: "hello", v: 1, token: { [SECRET]: 1 }, board: r.ids.board, since: 0, client: "raw" },
    "unknown board": hello(r, "owner", { board: "b-doesnotexist00000" }),
    "board id with a subject wildcard": hello(r, "owner", { board: `${r.ids.tenant}.*` }),
    "board id that is a path": hello(r, "owner", { board: "../../etc" }),
    "board is not a string": hello(r, "owner", { board: { id: r.ids.board } }),
    "valid token, no role on a real board": hello(r, "stranger"),
    "a role on one board is not a role on another": hello(r, "owner", { board: r.ids.otherBoard }),
  };
  const answers = {};
  for (const [name, msg] of Object.entries(cases)) {
    const s = await r.sock();
    s.send(msg); s.send({ t: "op", id: "raw:1", sentAt: 0, stream: "board", op: { elements: [rect("x")] } });
    const closed = await s.whenClosed();
    answers[name] = s.msgs;
    expect([name, closed.code]).toEqual([name, 1008]);
    expect([name, s.msgs]).toEqual([name, [{ t: "error", code: "auth", message: "not allowed" }]]);
  }
  // Unknown board and no-role are indistinguishable (rule 7).
  expect(answers["unknown board"]).toEqual(answers["valid token, no role on a real board"]);
  await r.bus.flush();
  expect(r.inbox).toEqual([]);                                    // nothing reached any room's inbox
  expect(r.server.rooms.stats().rooms).toBe(0);                   // and no room was even opened
  expect(await r.store.lastSeq(r.ids.tenant, r.ids.board)).toBe(0);
  expect((await r.health()).body.gateway).toMatchObject({ conns: 0, accepted: 0, refusedAuth: Object.keys(cases).length });
  noSecrets(r);
  await r.stop();
});

test("the order is verify, then board, then role, then the room; the room gets {user, role, client} and never the token", async () => {
  const order = [];
  const r = await rig({
    wrapAuth: a => ({ verify: async t => { order.push("verify"); const v = await a.verify(t); order.push("verified"); return v; }, role: async (i, b) => { order.push("role"); const v = await a.role(i, b); order.push("role known"); return v; } }),
    wrapRegistry: g => ({ ...g, board: async id => { order.push("board"); const v = await g.board(id); order.push("board known"); return v; } }),
    wrapStore: s => ({ ...s, acquire: async (...a) => { order.push("room opens"); return s.acquire(...a); } }),
  });
  const s = await r.sock();
  s.send(hello(r, "editor", { extra: `${SECRET}-smuggled` }));
  const welcome = await s.next(m => m.t === "welcome");
  expect(welcome).toMatchObject({ role: "editor", user: "dev:editor", seq: 0 });
  expect(r.calls).toEqual({ verify: 1, board: 1, role: 1 });
  // Each step finished before the next began, and the room was not even opened until all three had.
  expect(order.slice(0, 7)).toEqual(["verify", "verified", "board", "board known", "role", "role known", "room opens"]);
  expect(r.inbox.length).toBe(1);
  expect(r.inbox[0]).toMatchObject({ n: 1, user: "dev:editor", role: "editor", client: "raw", msg: { t: "hello", v: 1, board: r.ids.board, client: "raw" } });
  expect(r.inbox[0].msg.since).toBeUndefined();                   // catch-up is the gateway's (rule 8): the room never sees `since`
  expect(JSON.stringify(r.inbox)).not.toContain(SECRET);          // not the token, nor anything else from the hello
  noSecrets(r);
  await r.stop();
});

test("slow auth: ops after welcome are acked in order and numbered per connection", async () => {
  const r = await rig({ verifyDelayMs: 60 });
  const s = await r.sock();
  s.send(hello(r, "editor"));
  await s.next(m => m.t === "welcome");
  s.send({ t: "op", id: "raw:2", sentAt: 0, stream: "board", op: { elements: [rect("b")] } });
  s.send({ t: "op", id: "raw:3", sentAt: 0, stream: "board", op: { elements: [rect("c")] } });
  await s.next(m => m.t === "ack" && m.id === "raw:3");
  // The room publishes each entry before it acks it (§ Bus), and the feed delivers in seq order.
  expect(s.msgs.filter(noHere).map(m => m.t === "ack" ? `ack ${m.id}@${m.seq}` : m.t)).toEqual(["welcome", "entries", "ack raw:2@1", "entries", "ack raw:3@2"]);
  expect(r.inbox.map(m => [m.n, m.msg.t])).toEqual([[1, "hello"], [2, "op"], [3, "op"]]);
  await r.stop();
});

test("rule 11: an op that arrives before its connection's welcome gets `auth` with its id, and never reaches the room", async () => {
  const { subjects } = await import("../../server/bus/port.js");
  // The room's replies to this gateway arrive 150 ms late, so the op behind the hello is read before the welcome.
  const r = await rig({ wrapBus: b => ({ ...b, subscribe: (subject, fn) => b.subscribe(subject, subject.startsWith("plen-gw.") ? m => setTimeout(() => fn(m), 150) : fn) }) });
  const s = await r.sock();
  s.send(hello(r, "editor"));
  s.send({ t: "op", id: "raw:1", sentAt: 0, stream: "board", op: { elements: [rect("a")] } });
  await s.next(m => m.t === "welcome");
  expect(s.msgs[0]).toMatchObject({ t: "error", id: "raw:1", code: "auth" });
  await r.idle();
  expect(r.inbox.map(m => m.msg?.t)).toEqual(["hello"]);
  expect(await r.store.lastSeq(r.ids.tenant, r.ids.board)).toBe(0);
  expect(subjects.gateway("g-x")).toBe("plen-gw.g-x");
  await r.stop();
});

test("bad frames get an error and/or a close, never reach a room, and never kill the process", async () => {
  const r = await rig({ limits: { maxFrameBytes: 64 * 1024, maxHelloChars: 2048, maxStrikes: 3 } });
  const good = await r.client("owner").connect();
  await until(() => good.r.role === "owner", "the good client's welcome");
  const stillFine = async () => {
    expect((await r.health()).status).toBe(200);
    const before = (await r.room()).seq;
    good.send("board", { elements: [rect("ok" + before)] });
    await settled(r, [good]);
    expect((await r.room()).seq).toBe(before + 1);
  };

  // Before hello: one bad frame, one error, closed.
  const firsts = {
    binary: [new Uint8Array([1, 2, 3, 4]), "bad-op"],
    "not json": [`{"t":"hello","token":"${SECRET}-in-garbage", oops`, "bad-op"],
    "json but an array": ["[1,2,3]", "bad-op"],
    "json but a string": [`"${SECRET}"`, "bad-op"],
    "json null": ["null", "bad-op"],
    "no type": [JSON.stringify({ token: tokenOf("owner"), board: r.ids.board }), "bad-op"],
    "type is not a string": [JSON.stringify({ t: 5 }), "bad-op"],
    "an op before hello": [JSON.stringify({ t: "op", id: "raw:1", sentAt: 0, stream: "board", op: { elements: [rect("x")] } }), "auth"],
    "hello with a bad client id": [JSON.stringify(hello(r, "owner", { client: "a:b" })), "bad-op"],
    "hello with a bad since": [JSON.stringify(hello(r, "owner", { since: -1 })), "bad-op"],
    "hello for another protocol version": [JSON.stringify(hello(r, "owner", { v: 99 })), "version"],
    "a hello too large to be one": [JSON.stringify(hello(r, "owner", { pad: "x".repeat(4000) })), "too-large"],
    "a hello nested too deep": [JSON.stringify(hello(r, "owner", { pad: JSON.parse("[".repeat(100) + "]".repeat(100)) })), "bad-op"],
    "empty": ["", "bad-op"],
  };
  const inboxBefore = r.inbox.length;
  for (const [name, [frame, code]] of Object.entries(firsts)) {
    const s = await r.sock();
    s.send(frame);
    const closed = await s.whenClosed();
    expect([name, closed.code, s.msgs.length, s.msgs[0]?.t, s.msgs[0]?.code]).toEqual([name, 1008, 1, "error", code]);
  }
  await r.bus.flush();
  expect(r.inbox.length).toBe(inboxBefore);
  // Rule 11: presence before the hello is dropped, not an error; the hello after it works.
  const early = await r.sock();
  early.send({ t: "presence", k: "cursor", x: 1, y: 2 }); early.send(hello(r, "viewer", { client: "early" }));
  expect(await early.next(m => m.t === "welcome")).toMatchObject({ role: "viewer" });
  expect(early.msgs.some(m => m.t === "error")).toBe(false);
  await early.close();
  await stillFine();

  // Over the transport cap: closed by the transport, before or after hello.
  for (const live of [false, true]) {
    const s = await r.sock();
    if (live) { s.send(hello(r, "editor")); await s.next(m => m.t === "welcome"); }
    s.send("x".repeat(70 * 1024));
    expect((await s.whenClosed()).code).toBe(1009);
  }
  await stillFine();

  // After hello: bad frames get an error each, the connection keeps working, and the third one closes it.
  const s = await r.sock();
  s.send(hello(r, "editor")); await s.next(m => m.t === "welcome");
  s.send("not json at all");
  s.send({ t: "op", id: "raw:1", sentAt: 0, stream: "board", op: { elements: [rect("mid")] } });   // still served between strikes
  s.send({ t: "launch-missiles" });
  await s.next(m => m.t === "ack" && m.id === "raw:1");
  expect(s.msgs.filter(m => m.t === "error").map(m => m.code)).toEqual(["bad-op", "bad-op"]);
  s.send({ t: "blob", sha1: "a".repeat(40) });                                             // not served yet: strike three
  expect((await s.whenClosed()).code).toBe(1008);
  expect(s.msgs.filter(m => m.t === "error").length).toBe(3);
  // Rule 11: a second hello gets `bad-op` and the connection is closed at once; the room never sees it.
  const twice = await r.sock(), seen = r.inbox.length;
  twice.send(hello(r, "editor", { client: "twice" })); await twice.next(m => m.t === "welcome");
  twice.send(hello(r, "owner", { client: "twice" }));
  expect((await twice.whenClosed()).code).toBe(1008);
  expect(twice.msgs.at(-1)).toEqual({ t: "error", code: "bad-op", message: "already said hello" });
  await r.bus.flush();
  const mine = r.inbox.slice(seen);
  expect(mine.map(m => m.msg?.t ?? (m.closed ? "closed" : "?"))).toEqual(["hello", "closed"]);
  expect(mine.map(m => m.n)).toEqual([1, 2]);                              // § Bus: the close notice is numbered too
  expect(mine[0].name).toBe("editor");                                     // …and a hello carries the display name
  // Wrong-shape ops do reach the room, which answers by id (so the client can undo them); the socket stays open.
  const t = await r.sock();
  t.send(hello(r, "viewer", { client: "v" })); await t.next(m => m.t === "welcome");
  t.send({ t: "op" });
  t.send({ t: "op", id: "v:1", sentAt: 0, stream: "nope", op: {} });
  t.send({ t: "op", id: "v:2", sentAt: 0, stream: "board", op: { elements: [rect("no")] } });
  t.send({ t: "op", id: "v:3", sentAt: 0, stream: "board", op: { elements: [null, 5, "x"] } });
  t.send({ t: "presence", k: "cursor", x: 1, y: 2 });                                      // dropped silently for now
  await t.next(m => m.id === "v:3");
  expect(t.msgs.filter(m => m.t === "error").map(m => m.code)).toEqual(["bad-op", "bad-op", "forbidden", "bad-op"]);
  expect(t.ws.readyState).toBe(WebSocket.OPEN);
  await t.close();
  await stillFine();
  noSecrets(r);
  expect(r.logs().some(l => l.msg === "frame refused" && l.why === "undecodable")).toBe(true);
  await r.stop();
});

test("a port that throws during hello answers `unavailable`, closes, and the process lives", async () => {
  let breakVerify = true, breakBoard = false, breakRead = false;
  const r = await rig({
    wrapAuth: a => ({ ...a, verify: async t => { if (breakVerify) throw new Error(`idp down while checking ${t}`); return a.verify(t); } }),
    wrapRegistry: g => ({ ...g, board: async id => { if (breakBoard) throw new Error("registry down"); return g.board(id); } }),
    wrapStore: s => ({ ...s, read: async (...a) => { if (breakRead) throw new Error("disk gone"); return s.read(...a); } }),
  });
  const attempt = async () => { const s = await r.sock(); s.send(hello(r, "editor")); const closed = await s.whenClosed(); return [s.msgs.map(m => m.code), closed.code]; };
  expect(await attempt()).toEqual([["unavailable"], 1013]);
  breakVerify = false; breakBoard = true;
  expect(await attempt()).toEqual([["unavailable"], 1013]);
  breakBoard = false; breakRead = true;                           // the room can't rebuild
  expect(await attempt()).toEqual([["unavailable"], 1013]);
  expect(r.server.rooms.stats().rooms).toBe(0);
  breakRead = false;                                              // and it recovers by itself
  const s = await r.sock(); s.send(hello(r, "editor"));
  expect(await s.next(m => m.t === "welcome")).toMatchObject({ role: "editor" });
  expect(r.inbox.length).toBe(1);
  noSecrets(r);                                                   // the error text carried the token; logs must not
  await r.stop();
});

test("rule 1: nothing is acked or broadcast before the append resolves", async () => {
  let gate = null;
  const r = await rig({ wrapStore: s => ({ ...s, append: async (...a) => { if (gate) await gate.promise; return s.append(...a); } }) });
  const a = await r.sock(), b = await r.sock();
  a.send(hello(r, "editor", { client: "a" })); b.send(hello(r, "viewer", { client: "b" }));
  await a.next(m => m.t === "welcome"); await b.next(m => m.t === "welcome");
  gate = deferred();
  a.send({ t: "op", id: "a:1", sentAt: 0, stream: "board", op: { elements: [rect("one")] } });
  a.send({ t: "op", id: "a:2", sentAt: 0, stream: "board", op: { elements: [rect("two")] } });
  // A viewer who joins while the append is in flight is welcomed at the resolved seq and shown nothing unresolved.
  const late = await r.sock(); late.send(hello(r, "viewer", { client: "late" }));
  await sleep(80);
  expect(a.msgs.filter(noHere).map(m => m.t)).toEqual(["welcome"]);
  expect(b.msgs.filter(noHere).map(m => m.t)).toEqual(["welcome"]);
  expect(late.msgs.filter(noHere).map(m => [m.t, m.seq])).toEqual([["welcome", 0]]);
  expect(await r.rawStore.lastSeq(r.ids.tenant, r.ids.board)).toBe(0);
  const g = gate; gate = null; g.resolve();
  await a.next(m => m.t === "ack" && m.id === "a:2");
  await b.next(m => m.t === "entries" && m.entries[0].seq === 2);
  await late.next(m => m.t === "entries");
  expect(a.msgs.filter(m => m.t === "ack")).toEqual([{ t: "ack", id: "a:1", seq: 1 }, { t: "ack", id: "a:2", seq: 2 }]);
  expect(late.msgs.filter(m => m.t === "entries").flatMap(m => m.entries.map(e => e.seq))).toEqual([1, 2]);
  expect((await r.rawStore.read(r.ids.tenant, r.ids.board, 1, 10)).map(e => [e.seq, e.id, e.by])).toEqual([[1, "a:1", "dev:editor"], [2, "a:2", "dev:editor"]]);
  await r.stop();
});

test("the entries subject carries each entry once, after it is durable", async () => {
  const r = await rig({ host: { heartbeatMs: 50 } });   // a quick heartbeat, so a later beat comes within the test
  const { subjects } = await import("../../server/bus/memory.js");
  const seen = [], beats = [];
  r.bus.subscribe(subjects.entries(r.ids.tenant, r.ids.board), async m => { if (!m.items) return beats.push(m); seen.push({ ...m, durableThen: await r.rawStore.lastSeq(r.ids.tenant, r.ids.board) }); });
  const c = await r.client("editor").connect();
  for (let i = 0; i < 3; i++) c.send("board", { elements: [rect("e" + i)] });
  await settled(r, [c]); await r.bus.flush();
  // Group commit may put several entries in one message; each seq is carried exactly once, in order, once durable.
  expect(seen.flatMap(m => m.items.map(t => JSON.parse(t).seq))).toEqual([1, 2, 3]);
  expect(seen.every(m => m.items.length === m.to - m.from + 1 && m.durableThen >= m.to)).toBe(true);
  expect(JSON.parse(seen[0].items[0])).toMatchObject({ seq: 1, tenant: r.ids.tenant, board: r.ids.board, id: expect.stringMatching(/:1$/) });
  // The room's heartbeat names its epoch (§ Bus); it is published as soon as the room is built.
  // The first one, of a newly built room only, says `opened` (a host waiting on the lease answers the hellos it held).
  expect(beats[0]).toEqual({ seq: 0, epoch: 1, cp: 0, opened: true });
  await until(() => beats.length >= 2, "a later heartbeat", 2_000);
  expect(beats.at(-1)).toEqual({ seq: 3, epoch: 1, cp: 0 });                  // later beats: no `opened`
  await r.stop();
});

for (const mode of ["rejects", "conflicts", "times out", "times out and then lands late"]) test(`when the append ${mode}: no ack ever, everyone gets \`unavailable\`, and the room rebuilds from the Store`, async () => {
  let fail = false, late = null; const never = deferred(), landNow = deferred();
  const r = await rig({
    host: mode.startsWith("times out") ? { appendTimeoutMs: 400 } : {},
    wrapStore: s => ({ ...s, append: async (tenant, board, entries, expectSeq, ...rest) => {
      if (!fail) return s.append(tenant, board, entries, expectSeq, ...rest);
      if (mode === "rejects") throw new Error("disk full");
      if (mode === "times out") return never.promise;
      if (mode === "times out and then lands late") {
        // The write the room gave up on is still on its way to the disk; the test decides when it arrives.
        late = landNow.promise.then(() => s.append(tenant, board, entries, expectSeq, ...rest)).then(() => "landed", e => e.code);
        return never.promise;
      }
      // Another host got there first: the real store says conflict.
      await s.append(tenant, board, [{ ...entries[0], id: "usurper:1", by: "dev:other", op: { elements: [rect("theirs")] } }], expectSeq, ...rest);
      return s.append(tenant, board, entries, expectSeq, ...rest);
    } }),
  });
  const a = await r.sock(), b = await r.sock();
  a.send(hello(r, "editor", { client: "a" })); b.send(hello(r, "viewer", { client: "b" }));
  await a.next(m => m.t === "welcome"); await b.next(m => m.t === "welcome");
  a.send({ t: "op", id: "a:1", sentAt: 0, stream: "board", op: { elements: [rect("kept")] } });
  await a.next(m => m.t === "ack");
  fail = true;
  a.send({ t: "op", id: "a:2", sentAt: 0, stream: "board", op: { elements: [rect("lost")] } });
  a.send({ t: "op", id: "a:3", sentAt: 0, stream: "board", op: { elements: [rect("queued-behind")] } });
  const ca = await a.whenClosed();
  expect(ca.code).toBe(1013);
  expect(a.msgs.at(-1)).toMatchObject({ t: "error", code: "unavailable" });
  expect(a.msgs.filter(m => m.t === "error").map(m => m.id)).toContain("a:2");          // the held answer names the op
  expect(a.msgs.filter(m => m.t === "ack").map(m => m.id)).toEqual(["a:1"]);            // a:2 and a:3 were never acked
  // The viewer never reached the room (rule 8), so it stays connected, and was never shown an unresolved entry.
  expect(b.closed).toBe(null);
  expect(b.msgs.some(m => m.t === "entries" && m.entries.some(e => e.id !== "a:1"))).toBe(false);
  expect(r.server.rooms.stats().rooms).toBe(0);
  fail = false;

  // Reconnect: the room is rebuilt from what the Store really holds, and sequencing carries on without a gap.
  const stored = mode === "conflicts" ? 2 : 1;
  const c = await r.sock(); c.send(hello(r, "editor", { client: "a" }));
  expect(await c.next(m => m.t === "welcome")).toMatchObject({ seq: stored });
  c.send({ t: "op", id: "a:1", sentAt: 0, stream: "board", op: { elements: [rect("kept")] } });    // a resend of the acked op
  c.send({ t: "op", id: "a:2", sentAt: 0, stream: "board", op: { elements: [rect("lost")] } });    // a resend of the unacked one
  await c.next(m => m.t === "ack" && m.id === "a:2");
  expect(c.msgs.filter(m => m.t === "ack")).toEqual([{ t: "ack", id: "a:1", seq: 1 }, { t: "ack", id: "a:2", seq: stored + 1 }]);
  const log = await r.rawStore.read(r.ids.tenant, r.ids.board, 1, 100);
  expect(log.map(e => e.seq)).toEqual(Array.from({ length: stored + 1 }, (_, i) => i + 1));
  expect(log.filter(e => e.id === "a:1").length).toBe(1);                               // the resend landed once
  expect(log.filter(e => e.id === "a:2").length).toBe(1);
  expect(roomState(await r.room()).board.elements.map(e => e.id).sort()).toEqual(mode === "conflicts" ? ["kept", "lost", "theirs"] : ["kept", "lost"]);
  if (late) {
    // The late write now reaches a Store that has moved on: it is fenced off, and the op is still there once.
    landNow.resolve();
    expect(await late).toBe("fenced");
    expect((await r.rawStore.read(r.ids.tenant, r.ids.board, 1, 100)).map(e => e.id)).toEqual(["a:1", "a:2"]);
    c.send({ t: "op", id: "a:4", sentAt: 0, stream: "board", op: { elements: [rect("after")] } });   // and the room is fine
    expect(await c.next(m => m.t === "ack" && m.id === "a:4")).toEqual({ t: "ack", id: "a:4", seq: 3 });
  }
  never.resolve();
  await r.stop();
});

test("a room that throws: before logging, only the sender hears; after logging, the room is rebuilt and nothing is stored", async () => {
  const r = await rig();
  const a = await r.sock(), b = await r.sock();
  a.send(hello(r, "editor", { client: "a" })); b.send(hello(r, "editor", { client: "b" }));
  await a.next(m => m.t === "welcome"); await b.next(m => m.t === "welcome");
  const room = await r.room(), receive = room.receive.bind(room), apply = room.applyEntry.bind(room);
  room.receive = (c, m, meta) => { if (m.id === "a:1") throw new Error("bug before logging"); return receive(c, m, meta); };
  a.send({ t: "op", id: "a:1", sentAt: 0, stream: "board", op: { elements: [rect("x")] } });
  expect(await a.next(m => m.t === "error")).toEqual({ t: "error", id: "a:1", code: "bad-op", message: "that message could not be handled" });
  b.send({ t: "op", id: "b:1", sentAt: 0, stream: "board", op: { elements: [rect("fine")] } });
  await b.next(m => m.t === "ack");                                                     // the board is still up for everyone
  expect(a.ws.readyState).toBe(WebSocket.OPEN);

  room.applyEntry = e => { if (e.id === "a:2") throw new Error("bug after logging"); return apply(e); };
  a.send({ t: "op", id: "a:2", sentAt: 0, stream: "board", op: { elements: [rect("y")] } });
  expect((await a.whenClosed()).code).toBe(1013);
  expect((await b.whenClosed()).code).toBe(1013);
  expect(a.msgs.some(m => m.t === "ack")).toBe(false);
  expect((await r.rawStore.read(r.ids.tenant, r.ids.board, 1, 10)).map(e => e.id)).toEqual(["b:1"]);
  const c = await r.sock(); c.send(hello(r, "viewer", { client: "c" }));
  expect(await c.next(m => m.t === "welcome")).toMatchObject({ seq: 1 });
  expect((await r.health()).status).toBe(200);
  await r.stop();
});

test("lifecycle: sockets that close mid-auth or after hello leave no room connections behind", async () => {
  const r = await rig({ verifyDelayMs: 80 });
  const early = await r.sock();
  early.send(hello(r, "editor"));
  early.send({ t: "op", id: "raw:1", sentAt: 0, stream: "board", op: { elements: [rect("never")] } });
  await early.close();                                            // gone while verify is still pending
  await sleep(200); await r.bus.flush();
  expect(r.inbox).toEqual([]);
  expect(r.server.rooms.stats().rooms).toBe(0);
  expect((await r.health()).body.gateway.conns).toBe(0);

  const cs = [await r.sock(), await r.sock(), await r.sock()];
  cs.forEach((s, i) => s.send(hello(r, "editor", { client: "c" + i })));
  for (const s of cs) await s.next(m => m.t === "welcome");
  expect((await r.room()).conns.size).toBe(3);
  await cs[0].close(); cs[1].ws.terminate?.() ?? cs[1].ws.close();
  await until(async () => { await r.idle(); return (await r.room()).conns.size === 1; }, "the room to forget closed sockets");
  expect((await r.server.rooms.peek(r.ids.tenant, r.ids.board)).conns).toBe(1);
  expect((await r.health()).body.gateway.conns).toBe(1);
  cs[2].send({ t: "op", id: "c2:1", sentAt: 0, stream: "board", op: { elements: [rect("still")] } });
  await cs[2].next(m => m.t === "ack");
  await r.stop();
  expect((await cs[2].whenClosed()).code).toBe(1001);
});

test("a socket that never says hello is closed", async () => {
  const r = await rig({ limits: { helloTimeoutMs: 60 } });
  const s = await r.sock();
  expect((await s.whenClosed()).code).toBe(1008);
  expect(s.msgs).toEqual([{ t: "error", code: "auth", message: "say hello first" }]);
  const ok = await r.sock(); ok.send(hello(r, "viewer"));
  await ok.next(m => m.t === "welcome"); await sleep(120);
  expect(ok.ws.readyState).toBe(WebSocket.OPEN);                  // the timer is only for sockets that haven't said hello
  await r.stop();
});

test("a hello the bus dropped (at-most-once) doesn't leave a silent socket: `unavailable`, then a close", async () => {
  let dropHellos = true;
  const r = await rig({ limits: { helloTimeoutMs: 100 }, wrapBus: b => ({ ...b, publish: async (subject, m) => (dropHellos && m?.msg?.t === "hello" ? undefined : b.publish(subject, m)) }) });
  const s = await r.sock(); s.send(hello(r, "editor"));
  expect((await s.whenClosed()).code).toBe(1013);
  expect(s.msgs).toEqual([{ t: "error", code: "unavailable", message: "try again shortly" }]);
  dropHellos = false;
  const again = await r.sock(); again.send(hello(r, "editor"));
  await again.next(m => m.t === "welcome");
  await r.stop();
});

test("a log with a gap or a foreign entry is corruption: the room refuses to start, the server lives", async () => {
  let damage = null;
  const r = await rig({ wrapStore: s => ({ ...s, read: async (...a) => { const rows = await s.read(...a); return damage ? damage(rows) : rows; } }) });
  const w = await r.sock(); w.send(hello(r, "editor", { client: "w" })); await w.next(m => m.t === "welcome");
  for (let i = 1; i <= 4; i++) w.send({ t: "op", id: `w:${i}`, sentAt: 0, stream: "board", op: { elements: [rect("g" + i)] } });
  await w.next(m => m.t === "ack" && m.id === "w:4");
  const { dir, registry, ids } = r; await r.stop();
  // The clean stop wrote a checkpoint at 4; it is hidden, so the rebuild replays the (damaged) log from seq 1.
  const r2 = await rig({ dir, registry, ids, wrapStore: s => ({ ...s, getCheckpoint: async () => null, read: async (...a) => { const rows = await s.read(...a); return damage ? damage(rows) : rows; } }) });
  for (const [name, d] of Object.entries({
    gap: rows => rows.filter(e => e.seq !== 2),
    repeat: rows => rows.flatMap(e => (e.seq === 2 ? [e, e] : [e])),
    "another board's entry": rows => rows.map(e => (e.seq === 3 ? { ...e, board: ids.otherBoard } : e)),
  })) {
    damage = d;
    // A writer's hello builds the room (a viewer's never does: rule 8), and the build refuses a broken log.
    const s = await r2.sock(); s.send(hello(r2, "editor"));
    expect([name, (await s.whenClosed()).code, s.msgs]).toEqual([name, 1013, [{ t: "error", code: "unavailable", message: "try again shortly" }]]);
    expect(r2.server.rooms.stats().rooms).toBe(0);
  }
  expect(r2.logs().some(l => l.msg === "room failed to open" && l.err?.code === "corrupt-log")).toBe(true);
  damage = null;
  const ok = await r2.sock(); ok.send(hello(r2, "viewer"));
  expect(await ok.next(m => m.t === "welcome")).toMatchObject({ seq: 4 });
  expect((await r2.health()).status).toBe(200);
  await r2.stop();
});

// ---- fix round (docs/m2/reports/p3-scaffoldv.md) ----

test("H1: nestedDeeperThan counts brackets outside strings, in one pass", async () => {
  const { nestedDeeperThan } = await import("../../server/gateway.js");
  const nest = n => "[".repeat(n) + "]".repeat(n);
  expect(nestedDeeperThan(nest(64), 64)).toBe(false);
  expect(nestedDeeperThan(nest(65), 64)).toBe(true);
  expect(nestedDeeperThan(JSON.stringify({ a: "[[[[{{{{", b: "\\\"[[[[", c: ["]]]]", { d: "{" }] }), 3)).toBe(false);
  expect(nestedDeeperThan(JSON.stringify({ a: { b: { c: { d: 1 } } } }), 3)).toBe(true);
  expect(nestedDeeperThan(JSON.stringify(Array.from({ length: 5000 }, () => [[1], { a: 2 }])), 3)).toBe(false);   // wide, not deep
  expect(nestedDeeperThan('"[[[[[[[[', 3)).toBe(false);                 // an unterminated string: the decoder refuses it next
  expect(nestedDeeperThan("{".repeat(900_000), 64)).toBe(true);
});

test("H1: a 30,000-deep op is refused before it is parsed, nothing is stored, and joins stay fast", async () => {
  // "Before it is parsed" and "joins stay fast" are counted, not timed: the cliff is JSON.parse on a deep 180 KB frame
  // (about 0.6 s each on the loop that serves everyone), so no frame this size may reach JSON.parse at all.
  const realParse = JSON.parse, bigParses = [];
  JSON.parse = (text, ...rest) => { if (typeof text === "string" && text.length > 100_000) bigParses.push(text.length); return realParse(text, ...rest); };
  try { await deepOpTest(); } finally { JSON.parse = realParse; }
  expect(bigParses).toEqual([]);
});
async function deepOpTest() {
  const r = await rig();
  // Built as text: JSON.stringify of something this deep is the very cliff under test (about 0.6 s a go).
  const deepOp = (id, el, n) => `{"t":"op","id":"${id}","sentAt":0,"stream":"notes","op":{"elements":[{"id":"${el}","version":1,"versionNonce":1,"type":"rectangle","customData":${'{"a":'.repeat(n)}1${"}".repeat(n)}}]}}`;
  const a = await r.sock(), watcher = await r.sock();
  a.send(hello(r, "annotator", { client: "a" })); watcher.send(hello(r, "viewer", { client: "w" }));
  await a.next(m => m.t === "welcome"); await watcher.next(m => m.t === "welcome");
  for (let i = 1; i <= 6; i++) a.send(deepOp(`a:${i}`, "deep" + i, 30_000));                     // 180 KB each, valid JSON
  await a.next(m => m.id === "a:6");
  expect(a.msgs.filter(m => m.t === "error").map(m => [m.id, m.code])).toEqual([1, 2, 3, 4, 5, 6].map(i => [`a:${i}`, "bad-op"]));
  await r.bus.flush(); await r.idle();
  expect(r.inbox.filter(m => m.msg?.t === "op")).toEqual([]);            // the room never saw one
  expect(await r.rawStore.lastSeq(r.ids.tenant, r.ids.board)).toBe(0);
  // v1.1 § Limits: a frame of 64 levels passes the gateway, 65 don't (the frame is 4 levels deep around
  // `customData`); the op itself may be at most 62 deep (the op object is level 1), checked by the room.
  a.send(deepOp("a:7", "ok", 59));
  a.send(deepOp("a:8", "no", 61));
  // (The refusal comes from the gateway and the ack from the room after a durable append: either may arrive first.)
  await a.next(m => m.id === "a:8"); await a.next(m => m.t === "ack" && m.id === "a:7");
  expect(a.msgs.filter(m => m.id === "a:7" || m.id === "a:8").map(m => `${m.t} ${m.id}`).sort()).toEqual(["ack a:7", "error a:8"]);
  // A join, and /health at the same moment, are answered with the deep ops still in flight (the verifier measured 2.1 s each).
  const [late, health] = await Promise.all([r.sock().then(async s => { s.send(hello(r, "viewer", { client: "late" })); await s.next(m => m.t === "entries"); return s; }), r.health()]);
  expect(health.status).toBe(200);
  expect(late.msgs.filter(noHere).map(m => m.t)).toEqual(["welcome", "entries"]);
  expect(watcher.msgs.filter(m => m.t === "entries").length).toBe(1);    // only the one valid op was broadcast
  expect(a.ws.readyState).toBe(WebSocket.OPEN);
  await r.stop();
}

test("H1: catch-up is right for every `since`, and the same bytes go to every joiner", async () => {
  const r = await rig();
  const w = await r.sock(); w.send(hello(r, "editor", { client: "w" })); await w.next(m => m.t === "welcome");
  for (let i = 1; i <= 5; i++) w.send({ t: "op", id: `w:${i}`, sentAt: 0, stream: "board", op: { elements: [rect("e" + i, i)] } });
  await w.next(m => m.t === "ack" && m.id === "w:5");
  (await r.room()).checkpoint();                                         // the room folds at 5 (it does every 1,000 by itself)
  await until(async () => (await r.rawStore.getCheckpoint(r.ids.tenant, r.ids.board))?.seq === 5, "the checkpoint to be stored");
  for (let i = 6; i <= 8; i++) w.send({ t: "op", id: `w:${i}`, sentAt: 0, stream: "board", op: { elements: [rect("e" + i, i)] } });
  await w.next(m => m.t === "ack" && m.id === "w:8");
  await w.close(); await r.idle();                                       // the board's feed goes; joiners start one from the Store
  const join = async since => { const s = await r.sock(); s.send(hello(r, "viewer", { client: "j" + since, since })); await s.next(m => m.t === "welcome"); await r.idle(); await r.bus.flush(); await sleep(20); return s; };
  const shape = s => s.msgs.filter(noHere).map(m => (m.t === "entries" ? `entries ${m.entries.map(e => e.seq)}` : m.t === "snapshot" ? `snapshot@${m.seq}` : m.t));
  expect(shape(await join(0))).toEqual(["welcome", "snapshot@5", "entries 6,7,8"]);
  expect(shape(await join(3))).toEqual(["welcome", "snapshot@5", "entries 6,7,8"]);
  expect(shape(await join(5))).toEqual(["welcome", "entries 6,7,8"]);
  expect(shape(await join(6))).toEqual(["welcome", "entries 7,8"]);
  expect(shape(await join(8))).toEqual(["welcome"]);
  expect(shape(await join(99))).toEqual(["welcome"]);
  const one = await join(0), two = await join(0);
  expect(one.raw.slice(1)).toEqual(two.raw.slice(1));
  expect(one.msgs[0]).toMatchObject({ t: "welcome", seq: 8, role: "viewer" });
  expect(one.msgs[1].streams.board.elements.map(e => e.id).sort()).toEqual(["e1", "e2", "e3", "e4", "e5"]);
  // A Replica fed those frames ends where the room is.
  const c = await r.client("viewer", "fresh").connect();
  await settled(r, [c]);
  expect(c.r.state()).toEqual(roomState(await r.room()));
  await r.stop();
});

test("M1/M4: what waits behind a slow sign-in is bounded in bytes; 1,500 small unsent ops still get through", async () => {
  const held = deferred(); let answered = false;
  const r = await rig({ limits: { opRate: 100_000, opBurst: 2_000 }, wrapAuth: a => ({ ...a, verify: async t => { if (t.endsWith("wrong")) { await held.promise; answered = true; } else await sleep(30); return a.verify(t); } }) });
  // A flood behind a hello whose sign-in hasn't answered: refused with `unavailable` while it is still pending.
  const flood = await r.sock();
  flood.send({ t: "hello", v: 1, token: `${SECRET}-wrong`, board: r.ids.board, since: 0, client: "f" });
  for (let i = 0; i < 40; i++) flood.send("x".repeat(100_000));         // 4 MB against a 2 MiB bound
  expect((await flood.whenClosed()).code).toBe(1013);
  expect(answered).toBe(false);                                         // closed without waiting for auth
  expect(flood.msgs).toEqual([{ t: "error", code: "unavailable", message: "too much sent at once" }]);
  held.resolve();
  // Before any hello, nothing bigger than a hello is even scanned (a dropped presence frame doesn't open the door).
  const sneak = await r.sock();
  sneak.send({ t: "presence", k: "cursor", x: 1, y: 1 }); sneak.send("[".repeat(100_000));
  expect((await sneak.whenClosed()).code).toBe(1008);
  expect(sneak.msgs).toEqual([{ t: "error", code: "too-large", message: "hello is too large" }]);
  // A client reconnecting with many small pending ops resends them right after its welcome (rule 2). (The gateway's
  // op pace is raised here: this is about the bytes, and § Pacing has its own test.)
  const s = await r.sock();
  s.send(hello(r, "editor", { client: "many" }));
  await s.next(m => m.t === "welcome");
  for (let i = 1; i <= 1500; i++) s.send({ t: "op", id: `many:${i}`, sentAt: 0, stream: "board", op: { elements: [rect("m" + i)] } });
  await s.next(m => m.t === "ack" && m.id === "many:1500", "the last ack", 15000);
  expect(s.msgs.filter(m => m.t === "ack").length).toBe(1500);
  expect(s.msgs.some(m => m.t === "error")).toBe(false);
  await r.bus.flush();
  expect(r.inbox.filter(m => m.msg?.t === "op").every(m => m.user === "dev:editor")).toBe(true);   // none of the flood got in
  noSecrets(r);
  await r.stop();
}, 30000);

test("M2: a valid user whose sign-in is slow is told `unavailable`, not `auth`", async () => {
  const r = await rig({ verifyDelayMs: 300, limits: { helloTimeoutMs: 60 } });
  const s = await r.sock(); s.send(hello(r, "editor"));
  expect((await s.whenClosed()).code).toBe(1013);
  expect(s.msgs).toEqual([{ t: "error", code: "unavailable", message: "try again shortly" }]);
  await sleep(300); await r.bus.flush();
  expect(r.inbox).toEqual([]);                                            // and the late answer doesn't open anything
  await r.stop();
});

test("M5: a v0 `transient` op is refused, not relayed and not logged; an inbox gap closes the connection", async () => {
  const r = await rig();
  const a = await r.sock(), v = await r.sock();
  a.send(hello(r, "annotator", { client: "a" })); v.send(hello(r, "viewer", { client: "v" }));
  await a.next(m => m.t === "welcome"); await v.next(m => m.t === "welcome");
  for (let i = 1; i <= 12; i++) a.send({ t: "op", id: `a:${i}`, sentAt: 0, stream: "notes", transient: true, op: { elements: [rect("drag")] } });
  a.send({ t: "op", id: "a:13", sentAt: 0, stream: "notes", extra: "ignored", op: { elements: [rect("real")] } });
  await a.next(m => m.t === "ack" && m.id === "a:13");
  expect(a.msgs.filter(m => m.t === "error").length).toBe(12);            // each answered by id, and no strike-out
  expect(a.msgs.filter(m => m.t === "error").every(m => m.code === "bad-op" && /^a:\d+$/.test(m.id))).toBe(true);
  await r.idle(); await r.bus.flush(); await sleep(20);
  expect(v.msgs.filter(noHere).map(m => m.t)).toEqual(["welcome", "entries"]);           // no `transient` relay reached the viewer
  expect(r.inbox.filter(m => m.msg?.t === "op").map(m => Object.keys(m.msg).sort())).toEqual([["id", "op", "sentAt", "stream", "t"]]);
  expect((await r.rawStore.read(r.ids.tenant, r.ids.board, 1, 10)).map(e => e.id)).toEqual(["a:13"]);

  // Rule 6: the room host notices a lost inbox message by its number and sends the connection away to resend.
  const { subjects } = await import("../../server/bus/memory.js");
  const mine = r.inbox.find(m => m.client === "a" && m.msg.t === "hello");
  await r.bus.publish(subjects.inbox(r.ids.tenant, r.ids.board), { ...mine, n: 99, msg: { t: "op", id: "a:14", sentAt: 0, stream: "notes", op: { elements: [rect("after-gap")] } } });
  expect((await a.whenClosed()).code).toBe(1013);
  expect(a.msgs.at(-1)).toMatchObject({ t: "error", code: "unavailable" });
  expect((await r.room()).conns.size).toBe(0);                            // the viewer never was one (rule 8)
  expect(v.closed).toBe(null);
  expect(await r.rawStore.lastSeq(r.ids.tenant, r.ids.board)).toBe(1);
  await r.stop();
});

test("L5: a Room that throws on a hello leaves no half-open connection", async () => {
  const r = await rig();
  const first = await r.sock(); first.send(hello(r, "editor", { client: "first" })); await first.next(m => m.t === "welcome");
  const room = await r.room(), receive = room.receive.bind(room);
  room.receive = (c, m, meta) => { if (m.t === "hello" && m.client === "boom") throw new Error("bug in hello"); return receive(c, m, meta); };
  const s = await r.sock(); s.send(hello(r, "editor", { client: "boom" }));
  expect((await s.whenClosed()).code).toBe(1013);
  expect(s.msgs).toEqual([{ t: "error", code: "unavailable", message: "the board is restarting: reconnect" }]);
  await r.idle();
  expect((await r.room()).conns.size).toBe(1);
  expect((await r.server.rooms.peek(r.ids.tenant, r.ids.board)).conns).toBe(1);
  first.send({ t: "op", id: "first:1", sentAt: 0, stream: "board", op: { elements: [rect("fine")] } });
  await first.next(m => m.t === "ack");                                   // everyone else is untouched
  await r.stop();
});

test("L7: strikes fade with time; a burst of bad frames still closes the connection", async () => {
  const r = await rig({ limits: { maxStrikes: 3, strikeDecayMs: 40 } });
  const s = await r.sock(); s.send(hello(r, "editor")); await s.next(m => m.t === "welcome");
  for (let round = 0; round < 4; round++) { s.send("junk"); s.send("junk"); await sleep(120); }   // 8 in all, never 3 at once
  expect(s.ws.readyState).toBe(WebSocket.OPEN);
  expect(s.msgs.filter(m => m.t === "error").length).toBe(8);
  s.send("junk"); s.send("junk"); s.send("junk");
  expect((await s.whenClosed()).code).toBe(1008);
  await r.stop();
});

// ---- convergence over real sockets ----

const rngOf = seed => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
// One random edit a client is allowed to make (the generator of test/convergence.test.js).
function edit(rng, c, role) {
  const stream = canWrite(role, "board") && rng() < 0.7 ? "board" : "notes";
  if (!canWrite(role, stream)) return;
  const doc = c.r.streams[stream], live = [...doc.byId.values()].filter(e => !e.isDeleted), roll = rng();
  if (stream === "board" && roll < 0.12) return c.send(stream, { appState: { grid: Math.floor(rng() * 40), snap: rng() < 0.5 } });
  if (!live.length || roll < 0.4) {
    const type = rng() < 0.15 ? "image" : "rectangle";
    return c.send(stream, { elements: [makeElement(type, { x: Math.floor(rng() * 500), y: Math.floor(rng() * 500), width: 80, height: 60, ...(type === "image" ? { fileId: "a".repeat(40) } : {}) })] });
  }
  const el = clone(live[Math.floor(rng() * live.length)]);
  if (roll < 0.55) el.isDeleted = true; else el.x += Math.floor(rng() * 50) - 25;
  c.send(stream, { elements: [touch(el)] });
}

for (const seed of [1, 2]) test(`clients converge through the Room over real sockets, with drops and reconnects, and survive a server restart (seed ${seed})`, async () => {
  const rng = rngOf(seed), roles = ["owner", "editor", "editor0", "annotator", "viewer"];
  const roleOf = n => n.replace(/\d+$/, "");
  let r = await rig();
  let clients = await Promise.all(roles.map(n => r.client(n).connect()));
  for (let round = 0; round < 300; round++) {
    const c = clients[Math.floor(rng() * clients.length)];
    if (rng() < 0.6) edit(rng, c, roleOf(c.name));
    if (rng() < 0.03 && c.open) await c.drop();                    // the phone goes to sleep
    else if (!c.s && rng() < 0.3) await c.connect();               // and wakes up, resending what it had
    if (round % 7 === 0) await sleep(1);
  }
  for (const c of clients) if (!c.s) await c.connect();
  await settled(r, clients);
  let room = await r.room();
  const want = roomState(room);
  expect(want.applied).toBeGreaterThan(40);
  expect(want.board.elements.length).toBeGreaterThan(5);
  expect(want.notes.elements.length).toBeGreaterThan(0);
  for (const c of clients) { expect(c.r.pending.size).toBe(0); expect([c.name, c.r.state()]).toEqual([c.name, want]); }
  // A brand-new client (`since: 0`) ends in the same state.
  const fresh = await r.client("viewer", "fresh").connect();
  await settled(r, [fresh]);
  expect(fresh.r.state()).toEqual(want);
  // Every seq is in the Store exactly once, in order, by a writer.
  const log = await r.rawStore.read(r.ids.tenant, r.ids.board, 1, 10000);
  expect(log.map(e => e.seq)).toEqual(Array.from({ length: room.seq }, (_, i) => i + 1));
  expect(new Set(log.map(e => `${e.by}|${e.id}`)).size).toBe(log.length);
  expect(log.some(e => e.by === "dev:viewer")).toBe(false);

  // Restart: a new server on the same data rebuilds the same board from the log alone.
  const { dir, registry, ids } = r;
  for (const c of clients) c.wantOpen = false;
  await r.stop();
  r = await rig({ dir, registry, ids, host: { pageSize: 7 }, limits: { feed: { pageSize: 7 } } });   // the rebuild and the feed read many pages
  await r.server.rooms.open(ids.tenant, ids.board);                // viewers never build a room: build it to compare
  const after = await client(r, "viewer", "after-restart").connect();
  await settled(r, [after]);
  room = await r.room();
  expect(roomState(room)).toEqual(want);
  expect(after.r.state()).toEqual(want);
  // An old client comes back with its old `since`, edits, and gets the next seq: no gap, no reuse.
  const back = clients[1]; back.s = null;
  const rebound = Object.assign(client(r, "editor"), { r: back.r });
  await rebound.connect();
  rebound.send("board", { elements: [rect("after-restart")] });
  await settled(r, [rebound, after]);
  expect((await r.room()).seq).toBe(want.applied + 1);
  expect(after.r.state()).toEqual(rebound.r.state());
  expect(after.r.streams.board.get("after-restart")).toBeTruthy();
  noSecrets(r);
  await r.stop();
}, 30000);
