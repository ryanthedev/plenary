// web/adapters/transport/ws.js, compressed catch-up (PROTOCOL.md § Joining): the URL asks for deflate only when the
// runtime can inflate; a binary frame is inflated and delivered like the text frame it stands for, in arrival order.
import { test, expect } from "bun:test";
import { deflateSync } from "node:zlib";
import { wsTransport, withDeflate, browserInflate } from "../../../web/adapters/transport/ws.js";
import { jsonCodec } from "../../../packages/protocol/codec.js";

const URL_ = "wss://app.plenary.test/ws";
const tick = () => new Promise(r => setTimeout(r, 0));
const nodeInflate = async bytes => new Uint8Array((await import("node:zlib")).inflateSync(bytes));

function world() {
  const sockets = [];
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 0); }
    send(d) { this.sent.push(d); }
    close() { this.readyState = 3; }
    deliver(data) { this.onmessage?.({ data }); }
  }
  return { FakeWS, sockets, open: async () => { await tick(); return sockets[sockets.length - 1]; } };
}
const z = obj => { const b = deflateSync(Buffer.from(JSON.stringify(obj))); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };   // an ArrayBuffer, as binaryType "arraybuffer" delivers

test("DW-43.2: the URL asks for deflate (z=deflate, nothing else changes) only when an inflate is given; never with a binary codec", async () => {
  expect(withDeflate("wss://h:8443/ws")).toBe("wss://h:8443/ws?z=deflate");
  expect(withDeflate("ws://h/ws?x=1")).toBe("ws://h/ws?x=1&z=deflate");
  for (const [o, want] of [[{ inflate: nodeInflate }, URL_ + "?z=deflate"], [{ inflate: null }, URL_], [{}, URL_], [{ inflate: nodeInflate, codec: { encode: x => x, decode: x => x } }, URL_]]) {
    const w = world();
    wsTransport({ url: URL_, WebSocket: w.FakeWS, ...o });
    expect((await w.open()).url).toBe(want);
  }
  const w = world(); const t = wsTransport({ url: URL_, WebSocket: w.FakeWS, inflate: nodeInflate });
  t.reopen();
  expect(w.sockets.map(s => s.url)).toEqual([URL_ + "?z=deflate", URL_ + "?z=deflate"]);   // every connection asks, a reconnect too
});

test("a binary frame is inflated and delivered; text frames behind it wait for it, so order is arrival order", async () => {
  const w = world(), got = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const slow = async bytes => { await gate; return nodeInflate(bytes); };
  const t = wsTransport({ url: URL_, WebSocket: w.FakeWS, inflate: slow });
  t.onMessage(m => got.push(m));
  const s = await w.open();
  s.deliver(JSON.stringify({ t: "welcome", seq: 5 }));
  s.deliver(z({ t: "snapshot", seq: 5, streams: {} }));
  s.deliver(JSON.stringify({ t: "entries", entries: [{ seq: 6 }] }));
  s.deliver(z({ t: "entries", entries: [{ seq: 7 }] }));
  s.deliver(JSON.stringify({ t: "here", viewers: 1 }));
  await tick();
  expect(got.map(m => m.t)).toEqual(["welcome"]);                          // the text frame ahead of the first binary one went at once
  release();
  for (let i = 0; i < 20 && got.length < 5; i++) await tick();
  expect(got.map(m => m.t)).toEqual(["welcome", "snapshot", "entries", "entries", "here"]);
  expect(got[3].entries[0].seq).toBe(7);
});

test("with no binary frame in flight, a text frame is delivered synchronously (no added latency for live entries)", async () => {
  const w = world(), got = [];
  const t = wsTransport({ url: URL_, WebSocket: w.FakeWS, inflate: nodeInflate });
  t.onMessage(m => got.push(m));
  const s = await w.open();
  s.deliver(JSON.stringify({ t: "ack", id: "a:1", seq: 1 }));
  expect(got.length).toBe(1);
  s.deliver(z({ t: "snapshot", seq: 1 }));
  for (let i = 0; i < 20 && got.length < 2; i++) await tick();
  s.deliver(JSON.stringify({ t: "ack", id: "a:2", seq: 2 }));            // the chain has drained: sync again
  expect(got.map(m => m.t)).toEqual(["ack", "snapshot", "ack"]);
});

test("a binary frame that does not inflate drops the socket once (onDrop), and nothing after it is delivered", async () => {
  const w = world(), got = []; let drops = 0;
  const t = wsTransport({ url: URL_, WebSocket: w.FakeWS, inflate: nodeInflate });
  t.onMessage(m => got.push(m)); t.onDrop(() => { drops++; });
  const s = await w.open();
  s.deliver(new Uint8Array([1, 2, 3, 4, 5]).buffer);                       // not a zlib stream
  s.deliver(JSON.stringify({ t: "entries", entries: [] }));
  for (let i = 0; i < 10; i++) await tick();
  expect(drops).toBe(1);
  expect(got).toEqual([]);
});

test("without an inflate a binary frame is the codec's to refuse, as before: the socket drops", async () => {
  const w = world(); let drops = 0;
  const t = wsTransport({ url: URL_, WebSocket: w.FakeWS });
  t.onMessage(() => {}); t.onDrop(() => { drops++; });
  (await w.open()).deliver(new Uint8Array([1]).buffer);
  await tick();
  expect(drops).toBe(1);
});

test("browserInflate, where the runtime has DecompressionStream, inflates a zlib stream", async () => {
  const inflate = browserInflate();
  expect(typeof inflate).toBe("function");
  const text = JSON.stringify({ t: "snapshot", seq: 1, pad: "x".repeat(5000) });
  expect(new TextDecoder().decode(await inflate(new Uint8Array(deflateSync(Buffer.from(text)))))).toBe(text);
  expect(jsonCodec.decode(text).seq).toBe(1);
});

test("F2: a throw from the core's onMessage on an inflated frame escapes like the text path's: no drop, no reconnect, the chain lives on", async () => {
  const w = world(), got = []; let drops = 0;
  const t = wsTransport({ url: URL_, WebSocket: w.FakeWS, inflate: nodeInflate });
  t.onMessage(m => { if (m.t === "snapshot") throw new Error("core bug"); got.push(m.t); });
  t.onDrop(() => { drops++; });
  const s = await w.open();
  const rethrows = [], realQM = globalThis.queueMicrotask;   // the transport rethrows through queueMicrotask: capture it, then run it
  globalThis.queueMicrotask = f => { rethrows.push(f); };
  try {
    s.deliver(z({ t: "snapshot", seq: 1 }));
    s.deliver(z({ t: "entries", entries: [] }));
    for (let i = 0; i < 20 && got.length < 1; i++) await tick();
    await tick();
  } finally { globalThis.queueMicrotask = realQM; }
  const escaped = rethrows.map(f => { try { f(); return null; } catch (e) { return e.message; } }).filter(Boolean);
  expect(escaped).toEqual(["core bug"]);                                   // surfaced, as the text path's throw is
  expect(drops).toBe(0);                                                   // not a reconnect
  expect(w.sockets.length).toBe(1);
  expect(got).toEqual(["entries"]);                                        // and the next frame still arrives
});

test("a reconnect while the old socket's binary frame is still inflating: nothing from the old socket reaches the new connection", async () => {
  const w = world(), got = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const t = wsTransport({ url: URL_, WebSocket: w.FakeWS, inflate: async b => { await gate; return nodeInflate(b); } });
  t.onMessage(m => got.push(m));
  const old = await w.open();
  old.deliver(z({ t: "snapshot", seq: 9, streams: {} }));                  // inflating (gated)
  old.deliver(JSON.stringify({ t: "entries", entries: [{ seq: 10 }] }));   // queued behind it
  t.reopen();
  const fresh = await w.open();
  expect(fresh).not.toBe(old);
  fresh.deliver(JSON.stringify({ t: "welcome", seq: 0 }));                 // the new connection has nothing behind it: synchronous
  release();
  for (let i = 0; i < 20; i++) await tick();
  expect(got.map(m => m.t)).toEqual(["welcome"]);
  fresh.deliver(z({ t: "snapshot", seq: 0, streams: {} }));
  for (let i = 0; i < 20 && got.length < 2; i++) await tick();
  expect(got.map(m => m.t)).toEqual(["welcome", "snapshot"]);
});
