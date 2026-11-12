// The WebSocket transport adapter (web/adapters/transport/ws.js): the transport contract over a fake WebSocket the
// contract drives, its own rules (no token outside hello, queue before open, codec errors), and a real socket
// against a tiny Bun WebSocket server on port 0.
import { describe, test, expect, afterEach } from "bun:test";
import { transportContract } from "../contracts/transport-contract.js";
import { wsTransport } from "../../../web/adapters/transport/ws.js";

const URL_ = "wss://app.plenary.test/ws";
const tick = () => new Promise(r => setTimeout(r, 0));

/**
 * A fake browser WebSocket plus the far side. Async like the real one: it opens, delivers and closes on later
 * tasks. HOSTILE on purpose: the far side's late messages and closes are dispatched to whatever handlers the
 * socket still has, even after the client closed it, so only the adapter's own generation rule stops them.
 * Far side: answers { t: "req", i } with { t: "ans", i } on the same socket.
 */
function fakeWorld() {
  const sockets = [];
  class FakeWS {
    constructor(url, protocols) {
      this.url = url; this.protocols = protocols; this.args = arguments.length;
      this.readyState = 0; this.up = []; this.frames = []; this.closedByClient = false;
      this.onopen = this.onmessage = this.onerror = this.onclose = null;
      sockets.push(this);
      setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.({}); } }, 0);
    }
    send(data) {
      if (this.readyState !== 1) throw new Error("InvalidStateError");
      this.up.push(data); this.frames.push(data);
    }
    close() {
      if (this.readyState >= 2) return;
      this.readyState = 2; this.closedByClient = true;
      setTimeout(() => { this.readyState = 3; this.onclose?.({ code: 1000, wasClean: true }); }, 0);
    }
    // ── far side ──
    emit(obj) { const data = typeof obj === "string" ? obj : JSON.stringify(obj); setTimeout(() => this.onmessage?.({ data }), 0); }
    serve() {
      if (this.readyState !== 1) return;
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
  const transport = wsTransport({ url: URL_, WebSocket: w.FakeWS });
  return {
    transport,
    request: i => ({ t: "req", i }),
    answerOf: m => (m?.t === "ans" ? m.i : undefined),
    async serve() { await w.opened(); w.latest().serve(); },        // waits for open + the adapter's queue flush
    async flush() { for (let k = 0; k < 20; k++) { await tick(); w.latest().serve(); } },
    async drop() { await w.opened(); const s = w.latest(); if (s.readyState === 1) s.serverClose(); },
    async hold() { await w.opened(); const s = w.latest(); return i => s.emit({ t: "ans", i }); },
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
