// Fix round 2 (docs/m2/reports/p3-scaffoldv2.md): catch-up is streamed in bounded frames and paced by the socket,
// the kept tail is folded by bytes, what the process owes its readers is budgeted, and a burst yields the loop.
import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { cpSync } from "node:fs";
import { rig, tokenOf, settled, roomState, client, rawSock, sock } from "./rig.js";
import { cleanup, sleep, until, tempDir, deferred } from "./helpers.js";
import { sqliteStore } from "../../server/store/sqlite.js";
import { createBreather } from "../../server/breather.js";

afterAll(cleanup);
const MB = 1024 * 1024;
// A gateway feed rebases onto a fold on the room host's next heartbeat (default 2 s): tests that fold and then join wait for it.
const HB = 100;
const hello = (r, name, extra = {}) => ({ t: "hello", v: 1, token: tokenOf(name), board: r.ids.board, since: 0, client: name, ...extra });
// A small element op whose version rises with n (v1.1: a settings op needs `appBase`, so traffic uses elements).
const tick = n => ({ id: "tick", type: "rectangle", version: n, versionNonce: n, x: n % 100, y: 0, width: 1, height: 1, isDeleted: false });
const big = (id, version, chars, fill = "x") => ({ id, version, versionNonce: version, type: "text", x: 0, y: 0, width: 10, height: 10, isDeleted: false, text: fill.repeat(chars) });
/** Write `ops` as `name`, one at a time (each acked and echoed before the next, so the writer is never the slow reader). */
async function write(r, name, stream, ops) {
  const s = await r.sock(); s.send(hello(r, name)); await s.next(m => m.t === "welcome");
  for (const [i, el] of ops.entries()) {
    const id = `${name}:${i + 1}`;
    s.send({ t: "op", id, sentAt: 0, stream, op: { elements: [el] } });
    await s.next(m => m.t === "ack" && m.id === id, `the ack of ${id}`, 30000);
    await s.next(m => m.t === "entries" && m.entries.some(e => e.id === id), `the echo of ${id}`, 30000);
  }
  expect(s.msgs.filter(m => m.t === "error")).toEqual([]);
  await s.close();
}

test("H1: an annotator rewriting one note over and over leaves the board joinable, before and after a restart", async () => {
  // The verifier's attack (280 × 990 KB), scaled: 40 rewrites of one 200 KB note = 8 MB of log for 200 KB of board.
  // The user budget is 2 MB: the unfolded tail (8 MB) could never be owed to a joiner, the folded board can.
  const opts = { host: { heartbeatMs: HB, tailFoldBytes: 1 * MB, chunkBytes: 256 * 1024 }, limits: { maxUserBufferedBytes: 2 * MB, maxTotalBufferedBytes: 8 * MB } };
  let r = await rig(opts);
  await write(r, "annotator", "notes", Array.from({ length: 40 }, (_, i) => big("note", i + 1, 200_000, String(i % 10))));
  for (const phase of ["before the restart", "after the restart"]) {
    await r.server.rooms.open(r.ids.tenant, r.ids.board);                // after the restart: rebuilt from the log
    const peek = await r.server.rooms.peek(r.ids.tenant, r.ids.board);
    expect([phase, peek.room.seq]).toEqual([phase, 40]);
    expect(peek.tailBytes).toBeLessThan(1 * MB + 250_000);               // folded by bytes: never 1,000 entries here
    expect(peek.room.tail.length).toBeLessThan(8);
    // Three fresh viewers at once, raw frames counted.
    const joiners = await Promise.all([1, 2, 3].map(async i => { const s = await r.sock(); s.send(hello(r, "viewer", { client: "j" + i })); return s; }));
    for (const s of joiners) {
      await until(() => lastSeq(s) === 40, `${phase}: the end of the catch-up`);   // after the restart: the clean-stop checkpoint is at 40, so a snapshot alone
      expect(s.msgs.map(m => m.t).slice(0, 2)).toEqual(["welcome", "snapshot"]);
      expect(s.raw.reduce((n, f) => n + f.length, 0)).toBeLessThan(1.6 * MB);   // near the board's real size, not 8 MB
      for (const f of s.raw) expect(f.length).toBeLessThan(256 * 1024 + 210_000);   // no frame over the chunk bound (+ one entry)
      expect(s.ws.readyState).toBe(WebSocket.OPEN);
    }
    // And a Replica fed that catch-up holds the room's board.
    const c = await client(r, "viewer", "fresh-" + phase.length).connect();
    await settled(r, [c]);
    expect(c.r.state()).toEqual(roomState(await r.room()));
    expect(c.r.streams.notes.get("note").text).toBe("9".repeat(200_000));
    expect(r.logs().filter(l => l.msg === "reader closed" || l.msg.startsWith("joiner turned away"))).toEqual([]);
    if (phase === "before the restart") { const { dir, registry, ids } = r; await r.stop(); r = await rig({ ...opts, dir, registry, ids }); }
  }
  // The log itself is whole: folding is in memory only.
  expect(await r.rawStore.lastSeq(r.ids.tenant, r.ids.board)).toBe(40);
  await r.stop();
}, 60000);

test("H1: a tail bigger than any one frame arrives as bounded frames, in order, complete", async () => {
  const r = await rig({ host: { heartbeatMs: HB, chunkBytes: 64 * 1024, tailFoldBytes: 64 * MB } });
  await write(r, "editor", "board", Array.from({ length: 30 }, (_, i) => big("e" + i, 1, 40_000)));   // 1.2 MB of tail, never folded
  const s = await r.sock(); s.send(hello(r, "viewer"));
  await until(() => s.msgs.filter(m => m.t === "entries").flatMap(m => m.entries).length === 30, "all 30 entries");
  const frames = s.msgs.filter(m => m.t === "entries");
  expect(frames.length).toBeGreaterThan(10);                              // not one frame
  expect(frames.flatMap(m => m.entries).map(e => e.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  for (const f of s.raw) expect(f.length).toBeLessThan(64 * 1024 + 41_000);
  // A reconnecting client mid-tail gets exactly what it lacks, also in bounded frames.
  const back = await r.sock(); back.send(hello(r, "viewer", { client: "back", since: 17 }));
  await until(() => back.msgs.filter(m => m.t === "entries").flatMap(m => m.entries).at(-1)?.seq === 30, "the rest");
  expect(back.msgs.filter(m => m.t === "entries").flatMap(m => m.entries).map(e => e.seq)).toEqual(Array.from({ length: 13 }, (_, i) => i + 18));
  expect(back.msgs.some(m => m.t === "snapshot")).toBe(false);
  await r.stop();
}, 30000);

// ---- round 3: a queued catch-up frame is shared text and costs nothing; only what is in a socket counts ----

const got = s => s.raw.reduce((n, f) => n + f.length, 0);
const lastSeq = s => s.msgs.filter(m => m.t === "entries").flatMap(m => m.entries).at(-1)?.seq ?? s.msgs.find(m => m.t === "snapshot")?.seq ?? 0;

for (const shape of ["a snapshot bigger than the share", "a tail bigger than the share"]) test(`H1 (round 3): a board bigger than a user's whole budget is joinable from scratch: ${shape}`, async () => {
  // Scaled from the verifier's 70 MB board against the 64 MiB share: a 10 MB board against a 4 MiB share (and a
  // 12 MiB process budget). Before this round every such join was refused, the owner's too.
  const fold = shape.startsWith("a snapshot") ? 1 * MB : 64 * MB;
  const opts = { limits: { maxUserBufferedBytes: 4 * MB, maxTotalBufferedBytes: 12 * MB, sweepMs: 50 }, host: { heartbeatMs: HB, tailFoldBytes: fold } };
  let r = await rig(opts);
  await write(r, "owner", "board", Array.from({ length: 10 }, (_, i) => big("b" + i, 1, 990_000)));
  for (const phase of ["before the restart", "after the restart"]) {
    await r.server.rooms.open(r.ids.tenant, r.ids.board);
    const peek = await r.server.rooms.peek(r.ids.tenant, r.ids.board);
    // The host folds when the tail passes `fold` AND is at least half the state (the 2x bound), so with 1 MB the last
    // fold is at seq 8 (a tail of 2 x 990 KB is under half of 10 MB). A clean stop checkpoints (§ Recovery, "When"),
    // so after the restart both shapes join from a snapshot of the whole board.
    if (phase === "after the restart") expect(peek.room.base.seq).toBe(10);
    else if (fold === 1 * MB) expect(peek.room.base.seq).toBe(8); else expect(peek.room.tail.length).toBe(10);
    // The owner, and three tabs of one viewer, all at the same moment, all from scratch.
    const names = ["owner", "viewer", "viewer", "viewer"];
    const joiners = await Promise.all(names.map(async (n, i) => { const s = await r.sock(); s.send(hello(r, n, { client: "tab" + i })); return s; }));
    for (const [i, s] of joiners.entries()) {
      await until(() => lastSeq(s) === 10 || s.closed, `${phase}: ${names[i]} tab ${i} to catch up`, 20000);
      expect([phase, names[i], s.closed, s.msgs.filter(m => m.t === "error")]).toEqual([phase, names[i], null, []]);
      expect(got(s)).toBeGreaterThan(9_900_000);                          // the whole board, more than twice the share
    }
    expect(r.server.gateway.stats().turnedAway).toBe(0);
    expect(r.logs().filter(l => l.msg === "reader closed")).toEqual([]);
    // A Replica fed that catch-up holds the room's board, and can write.
    const c = await client(r, "owner", "replica-" + phase.length).connect();
    await settled(r, [c]);
    expect(c.r.state()).toEqual(roomState(await r.room()));
    for (const s of joiners) await s.close(); await c.drop();
    await until(() => r.server.gateway.stats().conns === 0, "sockets gone");
    expect([r.server.gateway.stats().owedBytes, r.server.gateway.stats().owedTracked, r.server.gateway.stats().waitingJoiners]).toEqual([0, 0, 0]);
    if (phase === "before the restart") { const { dir, registry, ids } = r; await r.stop(); r = await rig({ ...opts, dir, registry, ids }); }
  }
  await r.stop();
}, 90000);

test("H1 (round 3): a slow reader of a board bigger than its budget gets all of it; the server never owes it more than a socket's worth", async () => {
  const r = await rig({ limits: { maxUserBufferedBytes: 4 * MB, maxTotalBufferedBytes: 12 * MB, stallMs: 600_000, sweepMs: 50 }, host: { heartbeatMs: HB, tailFoldBytes: 64 * MB, chunkBytes: 256 * 1024 } });
  await write(r, "editor", "board", Array.from({ length: 24 }, (_, i) => big("s" + i, 1, 500_000)));   // a 12 MB tail in ~500 KB frames
  const s = await rawSock(r.server.wsUrl); s.send(hello(r, "viewer"));
  let peak = 0; const watch = setInterval(() => { peak = Math.max(peak, r.server.gateway.stats().owedBytes); }, 5);
  await sleep(300);                                                       // not reading: most of the board waits as references
  expect(r.server.gateway.stats().owedBytes).toBeLessThan(2 * MB);        // one or two frames in the socket, not 12 MB
  s.read();
  await until(() => s.got > 24 * 500_000, "the whole catch-up", 60000);
  clearInterval(watch);
  expect(peak).toBeLessThan(4 * MB);
  await until(() => r.server.gateway.stats().owedBytes === 0, "the socket to empty", 30000);
  expect(s.ended).toBe(false);
  expect(r.logs().some(l => l.msg === "reader closed")).toBe(false);
  s.destroy(); await r.stop();
}, 120000);

test("H1: sockets that never read stay under the budget, are cut even while they send presence, and lock nobody else out", async () => {
  // A 24 MB board in one snapshot frame. The kernel swallows a few MB per socket, so a non-reader that was handed
  // the snapshot is owed well over 8 MB; a 32 MiB share has room for one such socket at a time.
  // stallMs elapses on the gateway's clock, which the test moves (`skew`): each cut costs a jump, not 1.5 s of waiting.
  const limits = { maxUserBufferedBytes: 32 * MB, maxTotalBufferedBytes: 96 * MB, stallMs: 1500, stallGraceMs: 60_000, sweepMs: 50 };
  let skew = 0;
  const r = await board24({ limits, host: { heartbeatMs: HB, tailFoldBytes: 1 * MB }, now: () => Date.now() + skew });
  const stats = () => r.server.gateway.stats();
  let peak = 0; const watch = setInterval(() => { peak = Math.max(peak, stats().owedBytes, stats().owedTracked); }, 5);
  // Six sockets on the viewer account, none of which ever reads; each keeps "talking" (presence every 40 ms).
  const dead = [];
  for (let i = 0; i < 6; i++) { const s = await rawSock(r.server.wsUrl); s.send(hello(r, "viewer", { client: "dead" + i })); dead.push(s); }
  const chatter = setInterval(() => { for (const s of dead) s.send({ t: "presence", k: "cursor", x: 1, y: 2 }); }, 40);
  // The server's own state, not a timer: some sockets hold the snapshot, the rest wait for room.
  await until(() => stats().owedBytes > 8 * MB && stats().waitingJoiners >= 3, "the non-readers to hold the share and the rest to wait", 60000);
  const held = stats();
  expect(held.owedBytes).toBeLessThanOrEqual(32 * MB);                    // one account's share, whatever it opens
  // Meanwhile another user joins and gets the whole board: one account at its cap doesn't lock the others out.
  const ok = await r.sock(); ok.send(hello(r, "commenter"));
  await ok.next(m => m.t === "snapshot", "the other user's snapshot", 60000);
  expect((await r.health()).status).toBe(200);
  // Every non-reader is cut in turn: each gets the frame once there is room, reads nothing for stallMs, and goes,
  // although none of them ever stops sending.
  // One jump per cut, each past stallMs and the six together well short of stallGraceMs (60 s): only the stall rule
  // can be what cuts them. (A jump that finds nobody holding bytes yet is retried after 200 ms.)
  for (let jumps = 0; stats().conns > 1; jumps++) {
    if (jumps > 100) throw new Error("the non-readers were not cut");
    const before = stats().cut; skew += 1600;
    await until(() => stats().cut > before || stats().conns === 1, "a non-reader to be cut", 200).catch(() => {});
  }
  clearInterval(chatter); clearInterval(watch);
  expect(peak).toBeLessThanOrEqual(32 * MB + 24 * MB + 2 * MB);           // the account's share + the one honest joiner, never more
  expect(stats().cut).toBe(6);
  expect(r.logs().filter(l => l.msg === "reader closed").every(l => /stalled/.test(l.why))).toBe(true);
  await ok.close(); await until(() => stats().conns === 0, "all sockets gone", 30000);
  expect([stats().owedBytes, stats().owedTracked, stats().queuedBytes, stats().users, stats().waitingJoiners]).toEqual([0, 0, 0, 0, 0]);   // nothing leaks
  const again = await r.sock(); again.send(hello(r, "viewer", { client: "again" }));
  await again.next(m => m.t === "snapshot", "a reading viewer's snapshot", 60000);
  for (const s of dead) s.destroy();
  await r.stop();
}, 90000);

test("H1: non-readers spread over several accounts can't keep joiners out: the longest-stalled is cut to make room", async () => {
  // Each account stays under its own share; together they fill the process budget. stallMs is far away (60 s), so
  // only the make-room rule (stallGraceMs) can let anyone else in.
  // stallGraceMs (400 ms) is judged on the gateway's clock, which the test moves once (`skew`) instead of waiting.
  const limits = { maxUserBufferedBytes: 32 * MB, maxTotalBufferedBytes: 48 * MB, stallMs: 600_000, stallGraceMs: 400, helloTimeoutMs: 120_000, maxCatchUpWaitMs: 120_000, sweepMs: 50 };
  let skew = 0;
  const r = await board24({ limits, host: { heartbeatMs: HB, tailFoldBytes: 1 * MB }, now: () => Date.now() + skew });
  const stats = () => r.server.gateway.stats();
  const dead = [], accepted0 = stats().accepted;
  for (const account of ["editor1", "editor2", "editor3", "editor4"]) { const s = await rawSock(r.server.wsUrl); s.send(hello(r, account)); dead.push(s); }
  await until(() => stats().accepted === accepted0 + 4 && stats().owedBytes > 16 * MB, "the non-readers to hold the room", 60000);   // they really hold it…
  expect(stats().owedBytes).toBeLessThanOrEqual(48 * MB);                 // …and no more than the budget
  // (The clock moves only while an honest joiner waits, below.)
  // Honest joiners get in one after another: whoever has read nothing the longest goes. By the make-room rule, not
  // by a timer running out: the stall rule (10 min here) can't fire, and nobody is told to wait and come back.
  const honest = []; let jumps = 0;
  for (const name of ["viewer", "commenter", "annotator"]) {
    const s = await r.sock(); s.send(hello(r, name, { client: "honest-" + name })); honest.push(s);
    // The gateway's clock runs on while it waits (500 ms a poll, at most 50 s in all: its own limits are 120 s), so the
    // grace and the pace window it judges the dead sockets by elapse without the test sleeping through them.
    await until(() => { if (jumps++ < 100) skew += 500; return s.msgs.some(m => m.t === "snapshot" || m.t === "error"); }, "an honest joiner's snapshot", 90000);
    expect(s.msgs.filter(m => m.t === "error")).toEqual([]);
  }
  expect(r.logs().some(l => l.msg === "reader closed" && /making room/.test(l.why))).toBe(true);
  expect(r.logs().some(l => l.msg === "reader closed" && /stalled/.test(l.why))).toBe(false);
  expect(stats().turnedAway).toBe(0);
  for (const s of dead) s.destroy(); for (const s of honest) await s.close();
  await until(() => stats().conns === 0, "all sockets gone", 30000);
  expect([stats().owedBytes, stats().owedTracked, stats().waitingJoiners]).toEqual([0, 0, 0]);
  await r.stop();
}, 300000);

test("a joiner that waits too long for room is told `unavailable`, not left hanging", async () => {
  const limits = { maxUserBufferedBytes: 32 * MB, maxTotalBufferedBytes: 30 * MB, stallMs: 600_000, stallGraceMs: 600_000, helloTimeoutMs: 120_000, maxCatchUpWaitMs: 400, sweepMs: 50 };
  const r = await board24({ limits, host: { heartbeatMs: HB, tailFoldBytes: 1 * MB } });
  const hog = await rawSock(r.server.wsUrl); hog.send(hello(r, "editor1"));
  // It holds the snapshot unread (24 MB less what the kernel took): with 30 MB in all, a second 24 MB copy can't fit.
  await until(() => r.server.gateway.stats().sharedTexts === 0 && r.server.gateway.stats().owedBytes > 6 * MB, "the hog to hold its snapshot", 60000);
  // A writer is busy meanwhile: live entries pile up behind the waiting joiner's catch-up. They must not make it
  // look like a reader that isn't reading (it would be reset instead of told).
  const w = await r.sock(); w.send(hello(r, "editor", { since: 24 })); await w.next(m => m.t === "welcome");
  let n = 0; const writing = setInterval(() => { w.send({ t: "op", id: `editor:${++n}`, sentAt: 0, stream: "board", op: { elements: [tick(n)] } }); }, 5);
  const s = await r.sock(); s.send(hello(r, "viewer"));
  expect((await s.whenClosed()).code).toBe(1013);
  clearInterval(writing);
  expect(s.msgs.map(m => m.t)).toEqual(["welcome", "error"]);
  expect(s.msgs[1]).toMatchObject({ code: "unavailable" });
  expect(r.server.gateway.stats().turnedAway).toBe(1);
  expect(r.logs().filter(l => l.msg === "reader closed")).toEqual([]);    // told, not reset; and the writer was untouched
  expect(w.closed).toBe(null);
  hog.destroy(); await r.stop();
}, 180000);

test("the connection cap holds when many hellos from one user are in flight together", async () => {
  const gate = deferred();
  const r = await rig({ limits: { maxConnsPerUser: 2 }, wrapStore: s => ({ ...s, read: async (...a) => { await gate.promise; return s.read(...a); } }) });
  const socks = [];
  for (let i = 0; i < 6; i++) { const s = await r.sock(); s.send(hello(r, "editor", { client: "f" + i })); socks.push(s); }
  await sleep(100);                                                       // all six are past auth, waiting on the room
  gate.resolve();
  const ends = await Promise.all(socks.map(s => Promise.race([s.next(m => m.t === "welcome").then(() => "welcome"), s.whenClosed().then(c => `closed ${c.code}`)])));
  expect(ends.filter(e => e === "welcome").length).toBe(2);
  expect(ends.filter(e => e === "closed 1013").length).toBe(4);
  expect(r.server.gateway.stats().conns).toBe(2);
  expect((await r.room()).conns.size).toBe(2);
  await r.stop();
}, 60000);

test("a cap on connections per user: the newest is told `unavailable`; other users are untouched", async () => {
  const r = await rig({ limits: { maxConnsPerUser: 3 } });
  const mine = [];
  for (let i = 0; i < 3; i++) { const s = await r.sock(); s.send(hello(r, "editor", { client: "e" + i })); await s.next(m => m.t === "welcome"); mine.push(s); }
  const extra = await r.sock(); extra.send(hello(r, "editor", { client: "e3" }));
  expect((await extra.whenClosed()).code).toBe(1013);
  expect(extra.msgs).toEqual([{ t: "error", code: "unavailable", message: "too many connections for this user" }]);
  const other = await r.sock(); other.send(hello(r, "viewer")); await other.next(m => m.t === "welcome");
  await mine[0].close(); await until(() => r.server.gateway.stats().conns === 3, "the slot to free");
  const now = await r.sock(); now.send(hello(r, "editor", { client: "e4" })); await now.next(m => m.t === "welcome");
  expect(r.server.gateway.stats().conns).toBe(4);
  // v1: viewers never reach the room (rule 8), so the room knows only the three live editor connections.
  await until(async () => (await r.room()).conns.size === 3, "the room to hold e1, e2, e4");
  await r.stop();
}, 60000);

test("L1: bytes waiting behind slow sign-ins are bounded over the whole process, not only per socket", async () => {
  const held = deferred();
  const r = await rig({ limits: { maxTotalQueuedBytes: 300_000 }, wrapAuth: a => ({ ...a, verify: async t => { await held.promise; return a.verify(t); } }) });
  const socks = [];
  for (let i = 0; i < 4; i++) {
    const s = await r.sock(); s.send(hello(r, "editor", { client: "q" + i })); s.send("x".repeat(120_000)); socks.push(s);
    // Arrival order across sockets is what the rule is about: wait until the server has queued (or refused) this one.
    if (i < 2) await until(() => r.server.gateway.stats().queuedBytes >= (i + 1) * 120_000, `socket ${i}'s frames to be queued`, 30000);
    else await s.whenClosed();
  }
  expect((await socks[2].whenClosed()).code).toBe(1013);                  // the third would pass 300,000: refused, the newest
  expect(socks[2].msgs).toEqual([{ t: "error", code: "unavailable", message: "the server is busy: try again shortly" }]);
  expect(r.server.gateway.stats().queuedBytes).toBeLessThanOrEqual(300_000);
  expect(socks[0].ws.readyState).toBe(WebSocket.OPEN);
  held.resolve();
  await socks[0].next(m => m.t === "welcome");
  for (const s of socks) await s.close();
  await until(() => r.server.gateway.stats().conns === 0, "sockets gone", 30000);
  expect(r.server.gateway.stats().queuedBytes).toBe(0);
  await r.stop();
}, 60000);

test("M1: one writer's burst doesn't freeze the process: /health keeps answering all the way through", async () => {
  const r = await rig();
  const s = await r.sock(); s.send(hello(r, "editor"));
  await s.next(m => m.t === "welcome");
  // What is measured is not how fast /health answers, nor how long a burst takes (seconds with macOS's fullfsync,
  // ~130 ms per 4,000 ops on Linux), but WHEN /health answers: in the middle of a burst, with some of its acks
  // arrived and some not. A loop the burst held would answer only before the burst starts or after its last ack.
  // So bursts are sent until /health has answered mid-burst MID times, counted, not timed. A frozen loop never
  // does: it gives up after MAX_BURSTS and fails. Measured over 10 bursts of 2,000 (Bun 1.4.4): breather on,
  // 414–570 mid-burst answers on macOS and 23–25 on Linux; breather disabled, 0 on macOS and 1–3 on Linux (the loop
  // still turns between inbound socket reads). The bar sits between them with over 2× margin each way.
  const B = 2000, MID = 10, MAX_BURSTS = 10;
  let acks = 0, scanned = 0;
  const countAcks = () => { for (; scanned < s.msgs.length; scanned++) if (s.msgs[scanned].t === "ack") acks++; return acks; };
  let burstStart = 0, inBurst = false, polling = true, polls = 0; const mid = new Set();
  const poller = (async () => {
    while (polling) {
      await r.health(); polls++;
      const a = countAcks();
      if (inBurst && a > burstStart && a < burstStart + B) mid.add(a);      // some of this burst acked, not all
      await sleep(5);
    }
  })();
  let bursts = 0;
  while (mid.size < MID && bursts < MAX_BURSTS) {
    burstStart = countAcks(); inBurst = true; bursts++;
    for (let i = 1; i <= B; i++) { const n = burstStart + i; s.send({ t: "op", id: `editor:${n}`, sentAt: 0, stream: "board", op: { elements: [tick(n)] } }); }
    await s.next(m => m.t === "ack" && m.id === `editor:${burstStart + B}`, "the burst's last ack", 120000);
    inBurst = false;
  }
  polling = false; await poller;
  expect(countAcks()).toBe(bursts * B);                                   // every op of every burst acked
  expect(mid.size).toBeGreaterThanOrEqual(MID);                           // /health answered in the middle of bursts
  await r.stop();
}, 300000);

test("M1: the breather yields only after a slice of uninterrupted work", async () => {
  let t = 0;
  const breathe = createBreather({ sliceMs: 8, now: () => t });
  await breathe(); await breathe();
  expect(breathe.stats().yields).toBe(0);
  t = 9; await breathe();
  expect(breathe.stats().yields).toBe(1);
  t = 12; await breathe();
  expect(breathe.stats().yields).toBe(1);
  // Real time: a busy loop of 300 ms lets a timer fire in the middle.
  const real = createBreather({ sliceMs: 5 });
  let fired = 0; const timer = setTimeout(() => { fired = performance.now(); }, 20);
  const start = performance.now();
  let end = 0;
  while (performance.now() - start < 300) { const until_ = performance.now() + 1; while (performance.now() < until_); await real(); }
  end = performance.now();
  clearTimeout(timer);
  // The timer fired DURING the busy loop (a loop that never yields would let it fire only after). Load can delay
  // the timer, not move it past the loop: the loop yields every 5 ms of its own work, whatever the clock does.
  expect(fired).toBeGreaterThan(0);
  expect(fired).toBeLessThan(end);
});

test("L5: a client refused by the room resyncs, and settled() waits for it (the helper's old race, made certain)", async () => {
  const r = await rig();
  const ed = await r.client("editor").connect(), an = await r.client("annotator").connect();
  await until(() => ed.r.role && an.r.role, "welcomes");
  ed.send("notes", { elements: [big("theirs", 1, 10)] });
  await settled(r, [ed, an]);
  for (let round = 0; round < 15; round++) {
    // The annotator edits the editor's note: `forbidden`, so its Replica drops everything and reconnects with since 0.
    an.send("notes", { elements: [{ ...an.r.streams.notes.get("theirs"), version: 2 + round, versionNonce: 5 }] });
    ed.send("board", { elements: [big("r" + round, 1, 10)] });
    await until(() => an.errors.length > round, "the refusal");
    await settled(r, [ed, an]);                                           // called in the very window the old helper missed
    expect([round, an.r.state()]).toEqual([round, roomState(await r.room())]);
  }
  expect(an.connects).toBeGreaterThan(15);
  await r.stop();
}, 30000);

test("Store.read can stop a page by size (an extension to § Store), and reports each entry's stored size", async () => {
  const store = sqliteStore({ path: join(tempDir(), "p.db") });
  const entry = (seq, chars) => ({ seq, board: "b-1", tenant: "t-1", stream: "board", op: { elements: [big("e", seq, chars)] }, by: "u", id: `c:${seq}` });
  const { epoch } = await store.acquire("t-1", "b-1", "h-test", 60_000);   // every write is fenced (§ Store)
  await store.append("t-1", "b-1", [entry(1, 50_000), entry(2, 50_000), entry(3, 50_000), entry(4, 10), entry(5, 300_000)], 0, epoch);
  const seqs = p => p.map(e => e.seq);
  expect(seqs(await store.read("t-1", "b-1", 1, 100))).toEqual([1, 2, 3, 4, 5]);
  expect(seqs(await store.read("t-1", "b-1", 1, 100, 120_000))).toEqual([1, 2]);
  expect(seqs(await store.read("t-1", "b-1", 3, 100, 120_000))).toEqual([3, 4]);
  expect(seqs(await store.read("t-1", "b-1", 5, 100, 1000))).toEqual([5]);        // always at least one entry
  expect(seqs(await store.read("t-1", "b-1", 6, 100, 1000))).toEqual([]);
  expect(seqs(await store.read("t-1", "b-1", 1, 1, 10_000_000))).toEqual([1]);    // the count limit still applies
  const page = await store.read("t-1", "b-1", 1, 100);
  expect(page.bytes).toEqual(page.map(e => JSON.stringify(e).length));
  await expect(store.read("t-1", "b-1", 1, 100, 0)).rejects.toMatchObject({ code: "bad-entry" });
  await store.close();
});

// ---- round 3, second pass: the same budgets with a writer active and with readers that only trickle ----

test("a writer active during catch-up doesn't get a slow joiner (or its other tab) cut", async () => {
  // A 10 MB snapshot against a 4 MiB share: while one tab's socket still holds the snapshot, live entries flow to
  // both of that user's tabs. They must queue behind the catch-up, not cut it.
  const r = await rig({ limits: { maxUserBufferedBytes: 4 * MB, maxTotalBufferedBytes: 12 * MB, sweepMs: 50, stallMs: 600_000, helloTimeoutMs: 120_000 }, host: { heartbeatMs: HB, tailFoldBytes: 1 * MB } });
  await write(r, "owner", "board", Array.from({ length: 10 }, (_, i) => big("b" + i, 1, 990_000)));
  await foldAll(r);
  const w = await r.sock(); w.send(hello(r, "editor", { since: 10 })); await w.next(m => m.t === "welcome");
  const slow = await rawSock(r.server.wsUrl); slow.send(hello(r, "viewer", { client: "slow" }));
  const tab2 = await r.sock(); tab2.send(hello(r, "viewer", { client: "tab2" }));
  let n = 0; const writing = setInterval(() => { w.send({ t: "op", id: `editor:${++n}`, sentAt: 0, stream: "board", op: { elements: [tick(n)] } }); }, 10);
  // The slow tab holds the snapshot and reads nothing yet; the other tab (same user, 4 MiB share) is parked behind
  // it; live entries are being written meanwhile. All three from the server's and the writer's own signals.
  await until(() => r.server.gateway.stats().accepted === 4 && r.server.gateway.stats().owedBytes > 0 && r.server.gateway.stats().waitingJoiners === 1 && w.msgs.filter(m => m.t === "ack").length >= 10, "the slow tab to hold its snapshot while entries are written", 60000);
  slow.read();
  await until(() => slow.got > 9_900_000, "the slow tab's catch-up", 60000);
  await until(() => lastSeq(tab2) >= 10 + 30, "live entries on the other tab", 60000);
  clearInterval(writing);
  expect(slow.ended).toBe(false);
  expect(tab2.closed).toBe(null);
  expect(tab2.msgs.filter(m => m.t === "error")).toEqual([]);
  expect(r.logs().filter(l => l.msg === "reader closed")).toEqual([]);
  expect(r.server.gateway.stats().turnedAway).toBe(0);
  slow.destroy(); await r.stop();
}, 240000);

const python = Bun.which("python3");
test.skipIf(!python)("trickle readers can't hold the budget against a joiner: the one too slow to ever finish makes way (needs python3: skipped without it)", async () => {
  // A 24 MB board in one snapshot. stallMs is far away (60 s): a trickle reader never "stalls", it drains a little
  // all the time. Only the pace rule can move it.
  const limits = { maxUserBufferedBytes: 32 * MB, maxTotalBufferedBytes: 48 * MB, stallMs: 600_000, stallGraceMs: 400, slowEtaMs: 20_000, helloTimeoutMs: 120_000, maxCatchUpWaitMs: 120_000, sweepMs: 50 };
  const r = await board24({ limits, host: { heartbeatMs: HB, tailFoldBytes: 1 * MB } });
  const stats = () => r.server.gateway.stats();
  // Two accounts, one trickle reader each (a Python client with a 4 KB receive buffer, 32 KB every 200 ms:
  // 160 KB/s, over two minutes for what each socket holds). Only python reads slowly enough: a paused Node or Bun
  // socket pulls everything the kernel has.
  const tricklers = [];
  for (const account of ["editor1", "editor2"]) {
    const child = Bun.spawn([python, new URL("./trickle.py", import.meta.url).pathname, String(r.server.port), "/ws", JSON.stringify(hello(r, account)), "32768", "0.2"], { stdout: "pipe", stderr: "ignore" });
    const t = { child, got: 0 }; tricklers.push(t);
    (async () => { const dec = new TextDecoder(); for await (const chunk of child.stdout) { const n = dec.decode(chunk).trim().split("\n").pop(); if (n) t.got = Number(n); } })();
  }
  // Wait for the state, not for time: both are in, both are reading a little, and their sockets hold the snapshot.
  // Each holds 24 MB less what the kernel took; whatever that is, a third 24 MB copy can't fit in 48 MB beside both.
  await until(() => tricklers.every(t => t.got > 0) && stats().owedBytes > 24 * MB, "both tricklers to hold their snapshot", 60000);
  const honest = await r.sock(); honest.send(hello(r, "viewer"));
  // It gets in by the pace rule: a trickler is cut to make room. (Not by time running out: the 60 s stall rule never
  // fired, and it was never turned away after the 30 s wait; those are what the server reports, not a stopwatch.)
  await honest.next(m => m.t === "snapshot" || m.t === "error", "the honest joiner's snapshot", 90000);
  expect(honest.msgs.filter(m => m.t === "error")).toEqual([]);
  expect(stats().turnedAway).toBe(0);
  expect(r.logs().filter(l => l.msg === "reader closed").map(l => l.why)).toEqual(["making room for a joiner: its socket is full and it reads too slowly to empty it"]);
  for (const t of tricklers) { t.child.kill("SIGKILL"); await t.child.exited; }   // each by its own handle
  await r.stop();
}, 240000);

test("a reader getting through its catch-up at a fair pace is left alone: the joiner behind it waits its turn", async () => {
  const limits = { maxUserBufferedBytes: 32 * MB, maxTotalBufferedBytes: 48 * MB, stallMs: 600_000, stallGraceMs: 400, slowEtaMs: 20_000, helloTimeoutMs: 120_000, maxCatchUpWaitMs: 120_000, sweepMs: 50 };
  const r = await board24({ limits, host: { heartbeatMs: HB, tailFoldBytes: 1 * MB } });
  const stats = () => r.server.gateway.stats();
  const steady = await rawSock(r.server.wsUrl); steady.send(hello(r, "editor3")); steady.trickle(512 * 1024, 20);   // ~25 MB/s
  const second = await rawSock(r.server.wsUrl); second.send(hello(r, "editor4")); second.trickle(512 * 1024, 20);
  const third = await r.sock(); third.send(hello(r, "commenter"));       // up to 2 × 24 MB in sockets: it may wait for room
  await third.next(m => m.t === "snapshot", "the third joiner's snapshot", 90000);
  await until(() => steady.got > 23_000_000 && second.got > 23_000_000, "both steady readers to finish", 90000);
  expect(r.logs().filter(l => l.msg === "reader closed")).toEqual([]);
  expect(stats().turnedAway).toBe(0);
  steady.destroy(); second.destroy(); await r.stop();
}, 240000);

test("joiners parked across folds can't pin a board's worth of replaced text each: the longest-waiting are told to come back", async () => {
  // A hog (a socket that reads nothing) holds part of its 6 MB snapshot in its socket. Every later joiner is the same
  // user, and the user budget (1 MB) is smaller than any snapshot, so a joiner waits exactly while the hog's socket
  // holds any byte at all: no kernel buffer size matters (only that it takes less than the 6 MB board).
  // Between arrivals the board folds, so each waiter references a DIFFERENT snapshot string (6.0, 6.3 … 7.2 MB).
  // Distinct queued catch-up text is bounded (14 MB): without the bound the five would pin 33 MB.
  const limits = { maxUserBufferedBytes: 1 * MB, maxTotalBufferedBytes: 256 * MB, maxSharedQueuedBytes: 14 * MB, stallMs: 600_000, stallGraceMs: 600_000, maxCatchUpWaitMs: 600_000, helloTimeoutMs: 600_000, sweepMs: 50 };
  const r = await rig({ limits, host: { heartbeatMs: HB, tailFoldBytes: 256 * 1024 } });
  await write(r, "editor", "board", Array.from({ length: 6 }, (_, i) => big("b" + i, 1, 990_000)));   // a 6 MB board
  const stats = () => r.server.gateway.stats();
  const baseSeq = async () => (await r.server.rooms.peek(r.ids.tenant, r.ids.board)).room.base.seq;
  // v1: the host folds by bytes only while the tail is at least half the board (the 2x bound), which 300 KB of
  // growth on a 6 MB board never is: the test checkpoints through the Room itself, and the gateway's feed rebases
  // onto it (on the room's next heartbeat), so each joiner below gets a different snapshot string.
  const fold = async seq => { await r.idle(); const room = await r.room(); if (room.base.seq < seq) room.checkpoint(); expect(await baseSeq()).toBe(seq); };
  await fold(6);
  const hog = await rawSock(r.server.wsUrl); hog.send(hello(r, "editor1"));
  await until(() => stats().owedBytes > 0 && stats().sharedTexts === 0, "the hog's snapshot to be in its socket", 60000);
  const w = await r.sock(); w.send(hello(r, "editor", { client: "w", since: 6 })); await w.next(m => m.t === "welcome", "the writer's welcome", 60000);
  const parked = [];
  let peakShared = 0;
  for (let i = 0; i < 5; i++) {
    const s = await r.sock(); s.send(hello(r, "editor1", { client: "p" + i })); parked.push(s);
    await s.next(m => m.t === "welcome", `joiner ${i}'s welcome`, 60000);
    // Parked (or already sent away to make room for it): the server says which, not a timer.
    await until(() => stats().waitingJoiners + stats().turnedAway === i + 1, `joiner ${i} to be parked`, 60000);
    expect(hog.ended).toBe(false);                                        // the precondition: the hog still holds bytes…
    expect(stats().owedBytes).toBeGreaterThan(0);                         // …so every joiner had to wait
    peakShared = Math.max(peakShared, stats().sharedBytes);
    // The board grows by 300 KB and folds: the next joiner gets a new, bigger snapshot string.
    const id = `w:${i + 1}`; w.send({ t: "op", id, sentAt: 0, stream: "board", op: { elements: [big("grow" + i, 1, 300_000)] } });
    await w.next(m => m.t === "ack" && m.id === id, "the growth op", 60000);
    await fold(7 + i);
    await until(() => r.server.gateway.feed(r.ids.tenant, r.ids.board)?.base === 7 + i, `the feed to rebase onto ${7 + i}`, 10000);   // a new snapshot for the next joiner
  }
  expect(peakShared).toBeLessThanOrEqual(14 * MB);                        // 33 MB if nobody were sent away
  expect(peakShared).toBeGreaterThan(6 * MB);
  // The server turned some away; wait until the clients have heard it, then check who.
  const awayCount = stats().turnedAway;
  expect(awayCount).toBeGreaterThanOrEqual(2);                            // 5 distinct texts of 6–7 MB against 14 MB
  await until(() => parked.filter(s => s.closed).length === awayCount, "the turned-away joiners to see their close", 60000);
  // The ones sent away are exactly the ones that had waited longest: a prefix of the arrival order.
  expect(parked.map(s => !!s.closed)).toEqual(parked.map((_, i) => i < awayCount));
  for (const s of parked.slice(0, awayCount)) { expect(s.closed.code).toBe(1013); expect(s.msgs.at(-1)).toMatchObject({ t: "error", code: "unavailable" }); }
  expect(w.closed).toBe(null);
  // When the hog goes, whoever is still waiting gets in.
  hog.destroy();
  await until(() => parked.filter(s => !s.closed).every(s => s.msgs.some(m => m.t === "snapshot")), "the remaining joiners", 90000);
  for (const s of parked) if (!s.closed) await s.close(); await w.close();
  await until(() => stats().conns === 0, "all sockets gone", 60000);
  expect([stats().owedBytes, stats().owedTracked, stats().sharedBytes, stats().sharedTexts, stats().waitingJoiners]).toEqual([0, 0, 0, 0, 0]);
  await r.stop();
}, 300000);

// ---- fix round 4: frames over Bun's backpressureLimit, and sizes in UTF-8 bytes ----

/**
 * A ~12 MB (UTF-8) board in ~4 M chars (U+4E2D is 3 bytes): one snapshot frame. A raw reader holds it unread while
 * live entries queue behind it, and a second tab of the same user parks behind it; then it reads.
 * Load-proof: every wait is on a server or socket signal; the timeouts are backstops only, and the server's own
 * timers (stall, hello) are set far beyond them, so a busy machine can slow this but not change its outcome.
 */
/**
 * Fold the whole board into one checkpoint, so a joiner from 0 gets it as one snapshot. The scaffold's host folded
 * whenever its tail passed `tailFoldBytes`; the v1 host also needs the tail to be at least half the board (the 2x
 * bound), which a board written as distinct elements rarely meets. Tests about one big snapshot say so here.
 */
async function foldAll(r) {
  await r.idle();
  const room = await r.room();
  if (room.base.seq < room.resolved) room.checkpoint();
  expect(room.base.seq).toBe(room.seq);
}

/**
 * The 24 x 990 KB board that five tests need, folded into one snapshot: written once per file, then each test gets a
 * copy of its directory (and the Registry that knows its ids) and a rig on it, so each opens a room rebuilt from the
 * clean-stop checkpoint (seq 24, base 24), exactly the state foldAll leaves. Writing it took over a second a test.
 */
let seed24;
async function board24(opts) {
  seed24 ??= (async () => {
    const r0 = await rig({ host: { heartbeatMs: HB, tailFoldBytes: 1 * MB } });
    await write(r0, "editor", "board", Array.from({ length: 24 }, (_, i) => big("b" + i, 1, 990_000)));
    await foldAll(r0); await r0.stop();
    return { dir: r0.dir, registry: r0.registry, ids: r0.ids };
  })();
  const seed = await seed24, dir = tempDir();
  cpSync(seed.dir, dir, { recursive: true });
  const r = await rig({ ...opts, dir, registry: seed.registry, ids: seed.ids });
  await r.server.rooms.open(r.ids.tenant, r.ids.board);
  await foldAll(r);
  return r;
}

async function bigJoin(maxSnapshotBytes) {
  const limits = { maxUserBufferedBytes: 1 * MB, maxTotalBufferedBytes: 64 * MB, maxSnapshotBytes, stallMs: 600_000, stallGraceMs: 600_000, helloTimeoutMs: 600_000, maxCatchUpWaitMs: 600_000, sweepMs: 50 };
  const r = await rig({ limits, host: { heartbeatMs: HB, tailFoldBytes: 256 * 1024 } });
  await write(r, "annotator", "notes", Array.from({ length: 12 }, (_, i) => big("n" + i, 1, 330_000, "中")));
  await foldAll(r);
  const stats = () => r.server.gateway.stats();
  const w = await r.sock(); w.send(hello(r, "editor", { client: "w", since: 12 })); await w.next(m => m.t === "welcome", "the writer's welcome", 60000);
  const j = await rawSock(r.server.wsUrl, { frames: true }); j.send(hello(r, "viewer", { client: "big" }));
  // The server's signal that the snapshot left the queue for the reader's socket: no shared text held, no waiter,
  // bytes owed. (How much of it the kernel took doesn't matter: the socket still holds most of it when live frames
  // arrive behind it, and the read below can't start before.)
  await until(() => stats().accepted === 3, "the reader's hello", 60000);
  await r.idle();                                                         // the room has answered it: welcome and snapshot are with the gateway
  await until(() => stats().sharedTexts === 0 && stats().waitingJoiners === 0 && stats().owedBytes > 0, "the snapshot to be in the reader's socket", 60000);
  // The same user's second tab: its copy of the snapshot can't fit beside the first (1 MB share), so it parks, and
  // the shared text it waits on is counted in UTF-8 BYTES (round 3's L2): ~12 MB, not the ~4 M chars of the string.
  const k = await r.sock(); k.send(hello(r, "viewer", { client: "tab2" }));
  await until(() => stats().waitingJoiners === 1, "the second tab to park", 60000);
  expect(stats().sharedTexts).toBe(1);
  expect(stats().sharedBytes).toBeGreaterThan(11 * MB);
  // Live traffic for both, queued behind the snapshot (each op acked to the writer first).
  for (let n = 1; n <= 20; n++) { const id = `w:${n}`; w.send({ t: "op", id, sentAt: 0, stream: "board", op: { elements: [tick(n)] } }); await w.next(m => m.t === "ack" && m.id === id, "ack " + id, 60000); }
  await r.idle();                                                         // the room has handed every entry to the gateway
  j.read();
  await until(() => j.ended || j.texts.some(t => t.includes('"seq":32')), "the reader's last live entry (or its close)", 90000);
  expect(j.ended).toBe(false);                                            // old code: cut here (a frame dropped behind the snapshot)
  const msgs = j.texts.map(t => JSON.parse(t));
  expect(msgs.map(m => m.t).slice(0, 2)).toEqual(["welcome", "snapshot"]);
  const snap = j.texts[1];
  expect(Buffer.byteLength(snap)).toBeGreaterThan(11 * MB);              // the frame really was ~2× the old limit
  expect(snap.length).toBeLessThan(5 * MB);                               // …in under 5 M chars: bytes, not chars, are what the socket holds
  expect(msgs[1].streams.notes.elements.filter(e => e.text === "中".repeat(330_000)).length).toBe(12);
  expect(msgs.filter(m => m.t === "entries").flatMap(m => m.entries).map(e => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => 13 + i));
  // The second tab gets in once the first has drained, and gets everything too.
  await until(() => k.closed || lastSeq(k) === 32, "the second tab's catch-up", 90000);
  expect(k.closed).toBe(null);
  expect(k.msgs.map(m => m.t).slice(0, 2)).toEqual(["welcome", "snapshot"]);
  const logs = r.logs();
  j.destroy(); await k.close(); await w.close();
  await until(() => stats().conns === 0, "all sockets gone", 60000);
  expect([stats().owedBytes, stats().owedTracked, stats().sharedBytes, stats().sharedTexts]).toEqual([0, 0, 0, 0]);
  await r.stop();
  return logs;
}
const OVER_LIMIT = "outbound frame over the socket's backpressureLimit: the board is past the spec's caps (PROTOCOL.md § Limits); frames behind it wait for the socket to empty";
const outboundTrouble = logs => logs.filter(l => l.msg === "reader closed" || l.msg.startsWith("joiner turned away") || l.msg.startsWith("outbound frame")).map(l => l.msg);

test("R4-H2: a board whose snapshot is several times the old socket limit joins from since 0, with live traffic queued behind it", async () => {
  // Scaled. The old limit (2 × user budget + maxFrameBytes) is 6 MB here; the snapshot is ~12 MB. Old code: `drain`
  // fires with ~10 MB still held, the next live frame goes to a socket over Bun's limit, Bun drops it (send → 0),
  // and the reader is cut. Now the limit is sized from § Limits (here maxSnapshotBytes 16 MB → 17 MB).
  expect(outboundTrouble(await bigJoin(16 * MB))).toEqual([]);            // nothing cut, dropped, turned away or warned
}, 240000);

test("R4-H2: with the limit BELOW the snapshot, flush() holds frames behind it until the socket drains: nothing dropped", async () => {
  // maxSnapshotBytes 4 MB → limit 5 MB, under the ~12 MB snapshot (a board past the spec's caps). The snapshot still
  // goes (into an empty socket), and every live frame behind it waits for the socket to drain under 5 MB instead of
  // being handed to Bun while it holds ~10 MB (which Bun would drop). Said once, loudly.
  expect(outboundTrouble(await bigJoin(4 * MB))).toEqual([OVER_LIMIT]);
}, 240000);

test("R4-H2: a frame over the socket limit (past the spec's caps) is still sent, and logged loudly once per text", async () => {
  // Scaled: limits so small that the 3 MB board's snapshot is over backpressureLimit (2 MB) and over the "client
  // message" warning size. It is sent whole (Bun takes any frame into an empty socket), and said once, not per joiner.
  const limits = { maxUserBufferedBytes: 1 * MB, maxSnapshotBytes: 1 * MB, maxClientMessageBytes: 1 * MB, stallMs: 600_000, helloTimeoutMs: 600_000, maxCatchUpWaitMs: 600_000 };
  const r = await rig({ limits, host: { heartbeatMs: HB, tailFoldBytes: 256 * 1024 } });
  await write(r, "editor", "board", Array.from({ length: 3 }, (_, i) => big("b" + i, 1, 990_000)));
  await foldAll(r);
  for (const name of ["viewer", "commenter"]) {
    const s = await r.sock(); s.send(hello(r, name));
    const snap = await s.next(m => m.t === "snapshot", name + "'s snapshot", 60000);
    expect(snap.streams.board.elements.length).toBe(3);
    await s.close();
  }
  const loud = r.logs().filter(l => l.msg.startsWith("outbound frame"));
  expect(loud.map(l => l.msg)).toEqual([OVER_LIMIT]);
  expect(loud[0].bytes).toBeGreaterThan(2 * MB);
  expect(r.logs().filter(l => l.msg === "reader closed" || l.msg.startsWith("joiner turned away"))).toEqual([]);
  await r.stop();
}, 180000);
