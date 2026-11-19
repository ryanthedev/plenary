// wsNet's picture path (web/adapters/transport/ws.js blobClient; PROTOCOL.md § Blobs "Client rules") over a fake
// WebSocket, a fake fetch and a virtual clock: asks wait for welcome, one at a time and paced, retries with backoff,
// final failures reported, asks repeated after a reconnect, and the session never sees a blob message.
import { describe, test, expect } from "bun:test";
import { wsNet } from "../../../web/adapters/transport/ws.js";
import { virtualClock } from "../../../web/adapters/clock/virtual.js";

const tick = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const dataURL = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;
const ID = "a".repeat(40), ID2 = "b".repeat(40);

class FakeWS {
  static all = [];
  constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; FakeWS.all.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); }); }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; }
  say(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
  drop() { this.readyState = 3; this.onerror?.({}); this.onclose?.({}); }
  get asks() { return this.sent.filter(m => m.t === "blob"); }
}

/** A net with one welcomed connection. `routes`: fetch handler (url, init) → Response. */
async function setup(routes = () => new Response("", { status: 500 })) {
  FakeWS.all = [];
  const clock = virtualClock(), calls = [];
  const fetch = async (url, init = {}) => { calls.push({ url, method: init.method ?? "GET", init }); return routes(url, init, calls); };
  const net = wsNet({ url: "ws://x.test/ws", WebSocket: FakeWS, fetch, clock });
  const files = [], fails = [], passed = [];
  net.onFile(f => files.push(f)); net.onFail(f => fails.push(f));
  const tr = net.join(); tr.onMessage(m => passed.push(m));
  await tick();
  const ws = () => FakeWS.all.at(-1);
  const welcome = () => { ws().say({ t: "welcome", seq: 0, role: "editor" }); return tick(); };
  return { net, tr, clock, calls, files, fails, passed, ws, welcome, FakeWS };
}
const ok = (bytes = PNG, type = "image/png") => new Response(bytes, { status: 200, headers: { "content-type": type } });

describe("wsNet blobs", () => {
  test("DW-42.2: put asks only after welcome, then PUTs the decoded bytes to the signed URL", async () => {
    const s = await setup(() => new Response("{}", { status: 201 }));
    s.net.put({ id: ID, mimeType: "image/png", dataURL });
    s.clock.advance(500); await tick();
    expect(s.ws().asks).toEqual([]);                                   // not welcomed: a blob frame before hello would get the socket closed
    await s.welcome();
    expect(s.ws().asks).toEqual([{ t: "blob", sha1: ID, put: true }]);
    s.ws().say({ t: "blob", sha1: ID, url: "http://x.test/blobs/tok" }); await tick();
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toMatchObject({ url: "http://x.test/blobs/tok", method: "PUT" });
    expect([...s.calls[0].init.body]).toEqual([...PNG]);
    expect(s.fails).toEqual([]);
  });

  test("a path answer (no PUBLIC_URL on the server) is resolved against the origin the client connected to", async () => {
    const s = await setup(() => ok());
    await s.welcome();
    s.net.want(ID);
    s.ws().say({ t: "blob", sha1: ID, url: "/blobs/rel.tok" }); await tick();
    expect(s.calls[0].url).toBe("http://x.test/blobs/rel.tok");
  });

  test("want asks a GET, turns the bytes into a data URL, and asks once however often it is called", async () => {
    const s = await setup(() => ok());
    await s.welcome();
    for (let i = 0; i < 5; i++) s.net.want(ID);
    expect(s.ws().asks).toEqual([{ t: "blob", sha1: ID }]);
    s.ws().say({ t: "blob", sha1: ID, url: "http://x.test/blobs/g" }); await tick();
    expect(s.files).toEqual([{ id: ID, mimeType: "image/png", dataURL }]);
    s.clock.advance(120); s.net.want(ID);                              // asked again after it arrived: the Editor lost it, so fetch again
    expect(s.ws().asks).toHaveLength(2);
  });

  test("one request in flight, at least 120 ms apart", async () => {
    const s = await setup(() => ok());
    await s.welcome();
    s.net.want(ID); s.net.want(ID2);
    expect(s.ws().asks).toHaveLength(1);                               // the second waits for the first's answer
    s.ws().say({ t: "blob", sha1: ID, url: "http://x.test/blobs/1" }); await tick();
    expect(s.ws().asks).toHaveLength(1);                               // answered, but the pace says wait
    s.clock.advance(120); await tick();
    expect(s.ws().asks.map(a => a.sha1)).toEqual([ID, ID2]);
  });

  test("a GET 404 (the upload hasn't landed) is asked again with a fresh URL after a backoff", async () => {
    let n = 0;
    const s = await setup(() => (++n === 1 ? new Response("{}", { status: 404 }) : ok()));
    await s.welcome();
    s.net.want(ID);
    s.ws().say({ t: "blob", sha1: ID, url: "http://x.test/blobs/1" }); await tick();
    expect(s.files).toEqual([]);
    s.clock.advance(1100); await tick();
    expect(s.ws().asks).toHaveLength(2);
    s.ws().say({ t: "blob", sha1: ID, url: "http://x.test/blobs/2" }); await tick();
    expect(s.calls.map(c => c.url)).toEqual(["http://x.test/blobs/1", "http://x.test/blobs/2"]);
    expect(s.files).toHaveLength(1);
  });

  test("a refused request: limit/unavailable is retried, forbidden is final and reported for an upload", async () => {
    const s = await setup();
    await s.welcome();
    s.net.put({ id: ID, mimeType: "image/png", dataURL });
    s.ws().say({ t: "error", code: "limit", message: "slow down", sha1: ID }); await tick();
    expect(s.fails).toEqual([{ id: ID, verb: "PUT", code: "limit", retrying: true }]);   // told once, not a final failure
    s.clock.advance(2100); await tick();                                // a limit backs off 2 s (jittered down to 1 s), not 1 s
    expect(s.ws().asks).toHaveLength(2);
    s.ws().say({ t: "error", code: "forbidden", message: "no", sha1: ID }); await tick();
    expect(s.fails.at(-1)).toEqual({ id: ID, verb: "PUT", code: "forbidden" });
    s.clock.advance(120_000); await tick();
    expect(s.ws().asks).toHaveLength(2);                               // final: never asked again
    expect(s.passed.map(m => m.t)).toEqual(["welcome"]);              // the session saw none of the blob traffic
  });

  test("an upload the server refuses for good (quota) is reported once and not retried by itself; a new put of it is a new try", async () => {
    const s = await setup(() => new Response(JSON.stringify({ error: "quota" }), { status: 507 }));
    await s.welcome();
    s.net.put({ id: ID, mimeType: "image/png", dataURL });
    s.ws().say({ t: "blob", sha1: ID, url: "http://x.test/blobs/q" }); await tick();
    expect(s.fails).toEqual([{ id: ID, verb: "PUT", code: "quota" }]);
    s.clock.advance(120_000); await tick();
    expect(s.ws().asks).toHaveLength(1);
    expect(s.calls).toHaveLength(1);
    s.net.put({ id: ID, mimeType: "image/png", dataURL });             // the user adds the picture again (maybe after freeing space)
    expect(s.ws().asks).toHaveLength(2);
  });

  test("a 503 on the PUT is retried on a fresh URL until it works", async () => {
    let n = 0;
    const s = await setup(() => new Response("{}", { status: ++n < 3 ? 503 : 201 }));
    await s.welcome();
    s.net.put({ id: ID, mimeType: "image/png", dataURL });
    for (let i = 1; i <= 3; i++) {
      s.clock.advance(5000); await tick();
      s.ws().say({ t: "blob", sha1: ID, url: `http://x.test/blobs/${i}` }); await tick();
    }
    expect(s.calls.map(c => c.url)).toEqual(["http://x.test/blobs/1", "http://x.test/blobs/2", "http://x.test/blobs/3"]);
    expect(s.fails).toEqual([]);
    s.clock.advance(60_000); await tick();
    expect(s.ws().asks).toHaveLength(3);                               // done: nothing more asked
  });

  test("a request in flight when the connection drops is asked again after the next welcome", async () => {
    const s = await setup(() => ok());
    const drops = []; s.tr.onDrop(() => drops.push(1));
    await s.welcome();
    s.net.want(ID);
    s.ws().drop(); await tick();
    expect(drops).toHaveLength(1);                                     // the session still hears of the drop
    s.tr.reopen(); await tick();
    expect(FakeWS.all).toHaveLength(2);
    expect(s.ws().asks).toEqual([]);                                   // not welcomed yet
    await s.welcome(); s.clock.advance(200); await tick();
    expect(s.ws().asks).toEqual([{ t: "blob", sha1: ID }]);
  });

  test("messages that aren't blob replies reach the session untouched", async () => {
    const s = await setup();
    await s.welcome();
    s.ws().say({ t: "entries", entries: [] }); s.ws().say({ t: "error", code: "limit", message: "tabs" }); s.ws().say({ t: "ack", id: "c:1", seq: 1 });
    await tick();
    expect(s.passed.map(m => m.t)).toEqual(["welcome", "entries", "error", "ack"]);
  });

  test("after 6 failed tries the picture rests for 30 s (want is ignored), then is asked again on the next call", async () => {
    const s = await setup(() => new Response("{}", { status: 404 }));
    await s.welcome();
    s.net.want(ID);
    for (let i = 1; i <= 6; i++) {
      s.ws().say({ t: "blob", sha1: ID, url: `http://x.test/blobs/${i}` }); await tick();
      for (const n = s.ws().asks.length; i < 6 && s.ws().asks.length === n;) { s.clock.advance(500); await tick(); }   // until the backoff asks again
    }
    const asked = s.ws().asks.length;
    expect(asked).toBe(6);
    s.net.want(ID); s.clock.advance(10_000); await tick();
    expect(s.ws().asks).toHaveLength(asked);                           // resting
    s.clock.advance(25_000); s.net.want(ID); await tick();
    expect(s.ws().asks).toHaveLength(asked + 1);
  });

  test("a non-image answer to a GET is final and never becomes a file", async () => {
    const s = await setup(() => ok(new TextEncoder().encode("<svg/>"), "image/svg+xml"));
    await s.welcome();
    s.net.want(ID);
    s.ws().say({ t: "blob", sha1: ID, url: "http://x.test/blobs/s" }); await tick();
    expect(s.files).toEqual([]);
    s.clock.advance(120_000); await tick();
    expect(s.ws().asks).toHaveLength(1);
  });

  test("a stale answer for a request given up on is ignored", async () => {
    const s = await setup(() => ok());
    await s.welcome();
    s.net.want(ID);
    s.clock.advance(10_001); await tick();                             // no answer in 10 s: asked again later
    s.ws().say({ t: "blob", sha1: ID2, url: "http://x.test/blobs/x" }); await tick();
    expect(s.calls).toEqual([]);
  });

  test("an id that isn't 40 lowercase hex is never asked for (it would hold the one request slot for nothing)", async () => {
    const s = await setup(() => ok());
    await s.welcome();
    for (const bad of ["x", "A".repeat(40), "a".repeat(39), "a".repeat(41), "../etc/passwd", "", null, undefined, 5]) { s.net.want(bad); s.net.put({ id: bad, mimeType: "image/png", dataURL }); }
    s.clock.advance(500); await tick();
    expect(s.ws().asks).toEqual([]);
    s.net.want(ID);                                                    // and a good one right after is asked at once
    expect(s.ws().asks).toEqual([{ t: "blob", sha1: ID }]);
  });

  test("35 uploads against a 30-a-minute put limit all go up: `limit` is no failed try, it backs off, and the user is told once each", async () => {
    const s = await setup(() => new Response("{}", { status: 201 }));
    const stamps = [], uploaded = new Set();
    const ws = () => s.ws();
    // A server stand-in on the virtual clock: 30 put URLs per sliding minute, then `limit` with the sha1.
    const serve = m => queueMicrotask(() => {
      if (m.t !== "blob") return;
      const now = s.clock.now();
      while (stamps.length && now - stamps[0] >= 60_000) stamps.shift();
      if (m.put && stamps.length >= 30) return ws().say({ t: "error", code: "limit", message: "slow", sha1: m.sha1 });
      if (m.put) stamps.push(now);
      ws().say({ t: "blob", sha1: m.sha1, url: `http://x.test/blobs/${m.sha1}` });
    });
    await s.welcome();
    const orig = ws().send.bind(ws()); ws().send = d => { orig(d); serve(JSON.parse(d)); };
    const ids = Array.from({ length: 35 }, (_, i) => i.toString(16).padStart(40, "0"));
    for (const id of ids) s.net.put({ id, mimeType: "image/png", dataURL });
    for (let i = 0; i < 600 && s.calls.length < 35; i++) { s.clock.advance(500); await tick(2); }
    for (const c of s.calls) uploaded.add(c.url);
    expect(s.calls).toHaveLength(35);
    expect(uploaded.size).toBe(35);                                    // each exactly once
    expect(s.fails.every(f => f.code === "limit" && f.retrying)).toBe(true);
    expect(s.fails.length).toBe(new Set(s.fails.map(f => f.id)).size); // told once per picture
    expect(s.fails.length).toBeGreaterThan(0);
  });

  test("an upload that used up its tries wakes itself 30 s later and goes up when the server is back (no welcome needed)", async () => {
    let up = false;
    const s = await setup(() => new Response("{}", { status: up ? 201 : 503 }));
    await s.welcome();
    s.net.put({ id: ID, mimeType: "image/png", dataURL });
    const answer = async () => { s.ws().say({ t: "blob", sha1: ID, url: "http://x.test/blobs/u" }); await tick(); };
    for (let i = 0; i < 6; i++) {
      await answer();                                                  // a URL that works, then a PUT that gets a 503
      if (i < 5) for (const n = s.ws().asks.length; s.ws().asks.length === n;) { s.clock.advance(500); await tick(); }
    }
    expect(s.fails).toEqual([{ id: ID, verb: "PUT", code: "gave-up", retrying: true }]);
    up = true;
    for (const n = s.ws().asks.length; s.ws().asks.length === n;) { s.clock.advance(1000); await tick(); }   // the 30 s rest ends by itself
    await answer();
    expect(s.calls.at(-1).method).toBe("PUT");
    expect(s.fails).toHaveLength(1);                                   // the toast isn't repeated
    s.clock.advance(120_000); await tick();
    expect(s.ws().asks).toHaveLength(7);                               // and it is done: nothing more asked
  });
});
