// The WebSocket transport adapter (web/adapters/transport/ws.js): the transport contract over a fake WebSocket the
// contract drives, its own rules (no token outside hello, queue before open, codec errors), and a real socket
// against a tiny Bun WebSocket server on port 0.
import { describe, test, expect, afterEach } from "bun:test";
import { transportContract, pad } from "../contracts/transport-contract.js";
import { wsTransport, frameBytes } from "../../../web/adapters/transport/ws.js";
import { virtualClock } from "../../../web/adapters/clock/virtual.js";
import { CONGESTED_BYTES, HARD_CAP_BYTES, HARD_CAP_MS, HARD_CAP_SAMPLE_MS } from "../../../web/ports/transport.js";

const URL_ = "wss://app.plenary.test/ws";
const tick = () => new Promise(r => setTimeout(r, 0));

/**
 * A fake browser WebSocket plus the far side. Async like the real one: it opens, delivers and closes on later
 * tasks. HOSTILE on purpose: the far side's late messages and closes are dispatched to whatever handlers the
 * socket still has, even after the client closed it, so only the adapter's own generation rule stops them.
 * Far side: answers { t: "req", i } with { t: "ans", i } on the same socket.
 * Backpressure: a stalled socket keeps what is sent in bufferedAmount (UTF-8 bytes) until drain().
 */
function fakeWorld() {
  const sockets = [];
  class FakeWS {
    constructor(url, protocols) {
      this.url = url; this.protocols = protocols; this.args = arguments.length;
      this.readyState = 0; this.up = []; this.frames = []; this.closedByClient = false;
      this.stalled = false; this.bufferedAmount = 0;
      this.onopen = this.onmessage = this.onerror = this.onclose = null;
      sockets.push(this);
      setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.({}); } }, 0);
    }
    send(data) {
      if (this.readyState !== 1) throw new Error("InvalidStateError");
      this.up.push(data); this.frames.push(data);
      if (this.stalled) this.bufferedAmount += frameBytes(data);
    }
    stall() { this.stalled = true; }
    drain() { this.stalled = false; this.bufferedAmount = 0; this.serve(); }
    trickle(n) { this.bufferedAmount = Math.max(0, this.bufferedAmount - n); }
    close() {
      if (this.readyState >= 2) return;
      this.readyState = 2; this.closedByClient = true;
      setTimeout(() => { this.readyState = 3; this.onclose?.({ code: 1000, wasClean: true }); }, 0);
    }
    // ── far side ──
    emit(obj) { const data = typeof obj === "string" ? obj : JSON.stringify(obj); setTimeout(() => this.onmessage?.({ data }), 0); }
    serve() {
      if (this.readyState !== 1 || this.stalled) return;
      for (const d of this.up.splice(0)) { const m = JSON.parse(d); if (m.t === "req") this.emit({ t: "ans", i: m.i }); }
    }
    serverClose(code = 1006) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      setTimeout(() => { this.onerror?.({}); this.onclose?.({ code, wasClean: false }); }, 0);
    }
  }
  const latest = () => sockets[sockets.length - 1];
  // Wait only while CONNECTING (onopen runs in the same task that opens, so the adapter's queue is flushed by then);
  // no extra tick, or queued answers would be delivered before the caller's next step (drop, reopen).
  const opened = async () => { for (let k = 0; k < 20 && latest()?.readyState === 0; k++) await tick(); };
  return { FakeWS, sockets, latest, opened };
}

transportContract("ws (fake WebSocket)", () => {
  const w = fakeWorld();
  const clock = virtualClock();
  const transport = wsTransport({ url: URL_, WebSocket: w.FakeWS, clock });
  return {
    transport,
    request: i => ({ t: "req", i }),
    answerOf: m => (m?.t === "ans" ? m.i : undefined),
    async serve() { await w.opened(); w.latest().serve(); },        // waits for open + the adapter's queue flush
    async flush() { for (let k = 0; k < 20; k++) { await tick(); w.latest().serve(); } },
    async drop() { await w.opened(); const s = w.latest(); if (s.readyState === 1) s.serverClose(); },
    async hold() { await w.opened(); const s = w.latest(); return i => s.emit({ t: "ans", i }); },
    async stall() { await w.opened(); w.latest().stall(); },
    async drain() { await w.opened(); w.latest().drain(); },
    async trickle(n) { await w.opened(); w.latest().trickle(n); },
    advance(ms) { clock.advance(ms); },
  };
});

describe("ws transport adapter", () => {
  test("the socket gets exactly the configured URL and no subprotocols; the token is only in the hello frame", async () => {
    const w = fakeWorld();
    const t = wsTransport({ url: URL_, WebSocket: w.FakeWS });
    t.send({ t: "hello", v: 1, token: "s1.secret.sig", board: "b1", since: 0, client: "web-x" });
    await w.opened();
    const s = w.latest();
    expect(s.url).toBe(URL_);
    expect(s.args).toBe(1);
    expect(s.protocols).toBe(undefined);
    expect(s.frames.length).toBe(1);
    expect(JSON.parse(s.frames[0])).toMatchObject({ t: "hello", token: "s1.secret.sig" });
    t.reopen();
    await w.opened();
    expect(w.sockets.map(x => x.url)).toEqual([URL_, URL_]);
  });

  test("messages sent while CONNECTING go out on open, in order", async () => {
    const w = fakeWorld();
    const t = wsTransport({ url: URL_, WebSocket: w.FakeWS });
    for (let i = 1; i <= 3; i++) t.send({ t: "req", i });
    expect(w.latest().frames).toEqual([]);
    await w.opened();
    expect(w.latest().frames.map(f => JSON.parse(f).i)).toEqual([1, 2, 3]);
  });

  test("past maxQueued before open the link counts as dead: closed and onDrop once", async () => {
    const w = fakeWorld();
    const t = wsTransport({ url: URL_, WebSocket: w.FakeWS, maxQueued: 2 });
    let drops = 0;
    t.onDrop(() => drops++);
    for (let i = 0; i < 5; i++) t.send({ t: "req", i });
    expect(drops).toBe(0);                              // never on the caller's stack (p6-edgev LOW-2)
    expect(w.latest().closedByClient).toBe(true);       // but the socket is closed at once
    await Promise.resolve();
    expect(drops).toBe(1);
    await w.opened(); await tick();
    expect(drops).toBe(1);
    expect(w.latest().frames).toEqual([]);
    expect(w.latest().closedByClient).toBe(true);
  });

  test("a frame the codec rejects (binary for JSON, bad JSON) drops the socket once, never throws", async () => {
    for (const bad of ["{not json", new Uint8Array([1, 2]).buffer]) {
      const w = fakeWorld();
      const t = wsTransport({ url: URL_, WebSocket: w.FakeWS });
      const got = [];
      let drops = 0;
      t.onMessage(m => got.push(m));
      t.onDrop(() => drops++);
      await w.opened();
      const s = w.latest();
      expect(() => s.onmessage({ data: bad })).not.toThrow();
      s.emit({ t: "ans", i: 1 });                       // the socket is dead to the adapter now
      await tick(); await tick();
      expect(drops).toBe(1);
      expect(got).toEqual([]);
      expect(s.closedByClient).toBe(true);
    }
  });

  test("connection refused (error then close before open) is one drop; reopen then works", async () => {
    const w = fakeWorld();
    const t = wsTransport({ url: URL_, WebSocket: w.FakeWS });
    let drops = 0;
    const got = [];
    t.onDrop(() => drops++);
    t.onMessage(m => got.push(m.i));
    w.latest().serverClose();                           // before open
    await tick(); await tick();
    expect(drops).toBe(1);
    t.reopen();
    t.send({ t: "req", i: 4 });
    await w.opened();
    w.latest().serve();
    await tick();
    expect(got).toEqual([4]);
  });

  test("a constructor that throws (bad URL) is a drop on a later microtask, not a throw", async () => {
    const Throwing = function () { throw new SyntaxError("bad url"); };
    let drops = 0, t;
    expect(() => { t = wsTransport({ url: "nope", WebSocket: /** @type {any} */ (Throwing) }); }).not.toThrow();
    t.onDrop(() => drops++);
    expect(() => t.send({ t: "req", i: 1 })).not.toThrow();
    await tick();
    expect(drops).toBe(1);
    expect(() => t.reopen()).not.toThrow();
    t.close();
  });

  test("send on a socket that throws (closing under us) is a drop, not a throw", async () => {
    const w = fakeWorld();
    const t = wsTransport({ url: URL_, WebSocket: w.FakeWS });
    let drops = 0;
    t.onDrop(() => drops++);
    await w.opened();
    w.latest().send = () => { throw new Error("boom"); };
    expect(() => t.send({ t: "req", i: 1 })).not.toThrow();
    expect(drops).toBe(0);
    await Promise.resolve();
    expect(drops).toBe(1);
  });

  test("close() closes the socket and detaches it", async () => {
    const w = fakeWorld();
    const t = wsTransport({ url: URL_, WebSocket: w.FakeWS });
    await w.opened();
    t.close();
    const s = w.latest();
    expect(s.closedByClient).toBe(true);
    expect(s.onmessage).toBe(null);
    t.reopen();
    expect(w.sockets.length).toBe(1);                   // final: no new socket
  });

  test("a drop found inside send() and a reopen in the same tick: no drop is reported (LOW-2)", async () => {
    const w = fakeWorld();
    const t = wsTransport({ url: URL_, WebSocket: w.FakeWS, maxQueued: 2 });
    let drops = 0;
    t.onDrop(() => drops++);
    for (let i = 0; i < 5; i++) t.send({ t: "req", i });
    t.reopen();
    await tick(); await tick();
    expect(drops).toBe(0);
    expect(w.sockets.length).toBe(2);
  });

  test("frameBytes counts UTF-8 bytes of text and byteLength of binary", () => {
    expect(frameBytes("abc")).toBe(3);
    expect(frameBytes("é")).toBe(2);
    expect(frameBytes("€")).toBe(3);
    expect(frameBytes("😀")).toBe(4);
    expect(frameBytes(new Uint8Array(7).buffer)).toBe(7);
    expect(frameBytes(new Uint8Array(5))).toBe(5);
  });

  test("defaults: the watermark is the port's CONGESTED_BYTES, exactly (bufferedAmount + pre-open queue)", async () => {
    const w = fakeWorld();
    const t = wsTransport({ url: URL_, WebSocket: w.FakeWS });
    t.send(pad(CONGESTED_BYTES));                       // before open: the queue counts
    expect(frameBytes(JSON.stringify(pad(CONGESTED_BYTES)))).toBe(CONGESTED_BYTES);
    expect(t.congested()).toBe(false);                  // at the watermark: not over it
    t.send({ t: "x" });
    expect(t.congested()).toBe(true);
    await w.opened();                                   // flushed onto a socket that reads at once
    expect(t.congested()).toBe(false);
    const s = w.latest();
    s.bufferedAmount = CONGESTED_BYTES;
    expect(t.congested()).toBe(false);
    s.bufferedAmount = CONGESTED_BYTES + 1;
    expect(t.congested()).toBe(true);
    s.bufferedAmount = undefined;                       // a socket without bufferedAmount counts as 0
    expect(t.congested()).toBe(false);
  });

  test("defaults: the pre-open queue holds HARD_CAP_BYTES exactly; one byte more is a drop", async () => {
    const w = fakeWorld();
    const t = wsTransport({ url: URL_, WebSocket: w.FakeWS });
    let drops = 0;
    t.onDrop(() => drops++);
    const half = HARD_CAP_BYTES / 2;
    t.send(pad(half)); t.send(pad(half));               // exactly the cap
    await Promise.resolve();
    expect(drops).toBe(0);
    expect(w.latest().closedByClient).toBe(false);
    t.send(pad(18));                                    // 18 bytes over: the queue is past the byte cap
    expect(w.latest().closedByClient).toBe(true);
    await Promise.resolve();
    expect(drops).toBe(1);
  });

  test("the backlog is counted in UTF-8 bytes, not characters", () => {
    const w = fakeWorld();
    const t = wsTransport({ url: URL_, WebSocket: w.FakeWS });
    t.send({ t: "pad", s: "é".repeat(CONGESTED_BYTES / 2 + 16) });  // fewer characters than the watermark, more bytes
    expect(t.congested()).toBe(true);
  });

  test("reopen and close during a hard-cap hold clear its timer (no timer outlives its socket)", async () => {
    const w = fakeWorld();
    const clock = virtualClock();
    const t = wsTransport({ url: URL_, WebSocket: w.FakeWS, clock });
    for (const end of [() => t.reopen(), () => t.close()]) {
      await w.opened();
      w.latest().bufferedAmount = HARD_CAP_BYTES + 1;
      t.send({ t: "x" });
      expect(clock.pending).toBe(1);
      end();
      expect(clock.pending).toBe(0);
    }
  });

  test("defaults: the hard cap is HARD_CAP_BYTES held HARD_CAP_MS, on the injected clock", async () => {
    const w = fakeWorld();
    const clock = virtualClock();
    const t = wsTransport({ url: URL_, WebSocket: w.FakeWS, clock });
    let drops = 0;
    t.onDrop(() => drops++);
    await w.opened();
    const s = w.latest();
    s.bufferedAmount = HARD_CAP_BYTES;                  // at the cap: not over it, no hold starts
    t.send({ t: "x" });                                 // (unstalled fake: send leaves bufferedAmount as set)
    expect(clock.pending).toBe(0);
    s.bufferedAmount = HARD_CAP_BYTES + 1;
    t.send({ t: "x" });
    expect(clock.pending).toBe(1);                      // the hold runs on the clock port, nothing else
    clock.advance(HARD_CAP_MS - 1);
    expect(drops).toBe(0);
    clock.advance(HARD_CAP_SAMPLE_MS);
    expect(drops).toBe(1);
    expect(s.closedByClient).toBe(true);
    expect(clock.pending).toBe(0);
  });
});

// ── a real socket: Bun's WebSocket client against a tiny Bun WebSocket server on port 0 ──────────────────────────
const hasBun = typeof Bun !== "undefined" && typeof Bun.serve === "function" && typeof globalThis.WebSocket === "function";
describe.skipIf(!hasBun)("ws transport adapter over a real socket", () => {
  let server = null;
  afterEach(() => { server?.stop(true); server = null; });

  /** A room-ish server: records each upgrade request and each connection's frames; answers req, closes on "bye". */
  function start() {
    const upgrades = [], conns = [];
    server = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch(req, srv) {
        upgrades.push({ url: req.url, headers: Object.fromEntries(req.headers) });
        const conn = { frames: [], closed: false };
        conns.push(conn);
        return srv.upgrade(req, { data: conn }) ? undefined : new Response("upgrade", { status: 426 });
      },
      websocket: {
        message(ws, data) {
          ws.data.frames.push(String(data));
          const m = JSON.parse(String(data));
          if (m.t === "req") ws.send(JSON.stringify({ t: "ans", i: m.i }));
          if (m.t === "bye") ws.close(1011, "server going away");
        },
        close(ws) { ws.data.closed = true; },
      },
    });
    return { url: `ws://127.0.0.1:${server.port}/ws`, upgrades, conns };
  }
  const until = async (cond, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) { if (Date.now() > end) throw new Error("timed out"); await new Promise(r => setTimeout(r, 5)); }
  };

  test("hello first, then traffic; the token never appears in the URL or any header", async () => {
    const s = start();
    const t = wsTransport({ url: s.url, WebSocket: globalThis.WebSocket });
    const got = [];
    t.onMessage(m => got.push(m.i));
    const token = "s1.REALSECRETTOKEN.sig";
    t.send({ t: "hello", v: 1, token, board: "b1", since: 0, client: "web-1" });
    t.send({ t: "req", i: 1 });
    await until(() => got.length === 1);
    expect(got).toEqual([1]);
    expect(JSON.parse(s.conns[0].frames[0])).toMatchObject({ t: "hello", token });
    expect(s.upgrades.length).toBe(1);
    expect(s.upgrades[0].url).toBe(`http://127.0.0.1:${server.port}/ws`);
    expect(JSON.stringify(s.upgrades[0].headers)).not.toContain("REALSECRETTOKEN");
    expect(s.upgrades[0].headers["sec-websocket-protocol"]).toBe(undefined);
    t.close();
    await until(() => s.conns[0].closed);
  });

  test("reopen opens a second connection and closes the first; a server close is one onDrop; close is final", async () => {
    const s = start();
    const t = wsTransport({ url: s.url, WebSocket: globalThis.WebSocket });
    const got = [];
    let drops = 0;
    t.onMessage(m => got.push(m.i));
    t.onDrop(() => drops++);
    t.send({ t: "req", i: 1 });
    await until(() => got.length === 1);
    t.reopen();
    t.send({ t: "req", i: 2 });
    await until(() => got.length === 2 && s.conns[0].closed);
    expect(got).toEqual([1, 2]);
    expect(s.conns.length).toBe(2);
    expect(drops).toBe(0);                              // the client's own reopen is never a drop
    t.send({ t: "bye" });
    await until(() => drops === 1);
    t.reopen();
    t.send({ t: "req", i: 3 });
    await until(() => got.length === 3);
    expect(got).toEqual([1, 2, 3]);
    t.close();
    await until(() => s.conns[2].closed);
    await new Promise(r => setTimeout(r, 30));
    expect(drops).toBe(1);
    t.send({ t: "req", i: 4 });
    t.reopen();
    await new Promise(r => setTimeout(r, 30));
    expect(s.conns.length).toBe(3);
  });

  test("nothing listening: one drop, no throw", async () => {
    const s = start();
    const url = s.url;
    server.stop(true); server = null;
    const t = wsTransport({ url, WebSocket: globalThis.WebSocket });
    let drops = 0;
    t.onDrop(() => drops++);
    t.send({ t: "hello", v: 1, token: "x", board: "b", since: 0, client: "c" });
    await until(() => drops === 1);
    await new Promise(r => setTimeout(r, 30));
    expect(drops).toBe(1);
    t.close();
  });
});

// p6-edge2v L1: with a clock given, the hard-cap hold uses only that clock, never a global timer or global time.
test("with a clock given, the hold touches no global timer or global time", () => {
  const sockets = [];
  class WS {
    constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.closed = false; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.({}); }
    send(d) { if (this.readyState !== 1) throw new Error("state"); this.bufferedAmount += typeof d === "string" ? Buffer.byteLength(d) : d.byteLength; }
    close() { this.readyState = 3; this.closed = true; }
  }
  const clock = virtualClock();
  const t = wsTransport({ url: "wss://x/ws", WebSocket: WS, clock });
  let drops = 0; t.onDrop(() => drops++);
  sockets.at(-1).open();
  const big = n => ({ t: "pad", s: "x".repeat(n) });
  const saved = { st: globalThis.setTimeout, si: globalThis.setInterval, ct: globalThis.clearTimeout, dn: Date.now, pn: performance.now };
  const used = [];
  globalThis.setTimeout = (...a) => { used.push("setTimeout"); return saved.st(...a); };
  globalThis.setInterval = (...a) => { used.push("setInterval"); return saved.si(...a); };
  globalThis.clearTimeout = (...a) => { used.push("clearTimeout"); return saved.ct(...a); };
  Date.now = () => { used.push("Date.now"); return saved.dn.call(Date); };
  performance.now = () => { used.push("performance.now"); return saved.pn.call(performance); };
  try {
    t.send(big(HARD_CAP_BYTES + 1024));
    t.congested(); t.backlogBytes();
    clock.advance(HARD_CAP_MS + HARD_CAP_SAMPLE_MS);
    t.reopen(); sockets.at(-1).open(); t.send(big(HARD_CAP_BYTES + 1024)); t.reopen(); t.close();
  } finally {
    Object.assign(globalThis, { setTimeout: saved.st, setInterval: saved.si, clearTimeout: saved.ct });
    Date.now = saved.dn; performance.now = saved.pn;
  }
  expect(drops).toBe(1);
  expect(used).toEqual([]);
});
