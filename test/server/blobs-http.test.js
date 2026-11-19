// The blob path of the server (PROTOCOL.md § Blobs): the gateway's `blob` request over a real socket and the
// `/blobs/<token>` HTTP route, with real roles (test/server/rig.js). The unit rules (signing, quota) are in blob-access.test.js.
import { test, expect, afterAll } from "bun:test";
import { rig, tokenOf } from "./rig.js";
import { cleanup, fakePng, sha1, until } from "./helpers.js";

afterAll(cleanup);
const SIG = "a".repeat(40);

/** A welcomed socket as `role`, with ask(msg) → the next blob/error answer to it. */
async function as(r, role) {
  const s = await r.sock();
  s.send({ t: "hello", v: 1, token: tokenOf(role), board: r.ids.board, since: 0, client: role });
  await s.next(m => m.t === "welcome");
  let seen = 0;
  s.ask = async msg => { s.send(msg); const m = await until(() => s.msgs.slice(seen).find(x => x.t === "blob" || (x.t === "error" && x.id === undefined)), "an answer"); seen = s.msgs.indexOf(m) + 1; return m; };
  return s;
}
const ask = async (s, sha1_, put) => s.ask({ t: "blob", sha1: sha1_, ...(put ? { put: true } : {}) });
/** The URL is a path here (no PUBLIC_URL in the rig). */
const tok = url => url.slice(url.lastIndexOf("/") + 1);

test("roles: any role reads, annotators and up upload, commenters and viewers can't (answered with the sha1, no id, connection kept)", async () => {
  const r = await rig();
  for (const [role, get, put] of [["viewer", true, false], ["commenter", true, false], ["annotator", true, true], ["editor", true, true], ["owner", true, true]]) {
    const s = await as(r, role);
    expect(await ask(s, SIG)).toMatchObject({ t: "blob", sha1: SIG, url: expect.stringContaining("/blobs/") });
    const up = await ask(s, SIG, true);
    if (put) expect(up).toMatchObject({ t: "blob", sha1: SIG });
    else expect(up).toEqual({ t: "error", sha1: SIG, code: "forbidden", message: expect.any(String) });
    expect(get).toBe(true);
    expect(s.closed).toBe(null);
    s.close();
  }
});

test("a malformed request is bad-op without a signature, never closes the connection, and a good one works after it", async () => {
  const r = await rig({ limits: { blobRate: 1e6 } }), s = await as(r, "editor");
  for (const bad of [{ sha1: SIG.toUpperCase() }, { sha1: "a".repeat(39) }, { sha1: "../../etc/passwd" }, {}, { sha1: 5 }, { sha1: SIG + "0" }])
    expect(await s.ask({ t: "blob", ...bad })).toMatchObject({ t: "error", code: "bad-op" });
  for (const put of [false, "yes", 1, null]) expect(await s.ask({ t: "blob", sha1: SIG, put })).toMatchObject({ t: "error", code: "bad-op", sha1: SIG });
  // The short string is echoed even though it is no sha1, so the client's one request slot is freed; a long one is not echoed.
  expect((await s.ask({ t: "blob", sha1: "x" })).sha1).toBe("x");
  expect((await s.ask({ t: "blob", sha1: "y".repeat(65) })).sha1).toBe(undefined);
  expect((await s.ask({ t: "blob", sha1: 5 })).sha1).toBe(undefined);
  expect(await ask(s, SIG)).toMatchObject({ t: "blob" });
  expect(s.closed).toBe(null);
});

test("blob requests are limited to 10/s per connection (refused ones count), as limit", async () => {
  const r = await rig({ limits: {} }), s = await as(r, "editor");
  for (let i = 0; i < 40; i++) s.send({ t: "blob", sha1: SIG });
  await until(() => s.msgs.filter(m => m.t === "blob" || m.t === "error").length >= 40, "40 answers");
  const limited = s.msgs.filter(m => m.t === "error" && m.code === "limit"), served = s.msgs.filter(m => m.t === "blob");
  expect(served.length).toBeGreaterThanOrEqual(10);
  expect(served.length).toBeLessThan(16);                      // 10 in the bucket plus what trickled back in
  expect(limited.length).toBe(40 - served.length);
  expect(limited[0].sha1).toBe(SIG);
});

test("put URLs: 30 a minute per user per board, then limit; the window slides", async () => {
  let t = 1_000_000;
  const r = await rig({ now: () => t, limits: { blobRate: 1e6 } }), s = await as(r, "editor");
  for (let i = 0; i < 30; i++) expect(await ask(s, SIG, true)).toMatchObject({ t: "blob" });
  expect(await ask(s, SIG, true)).toMatchObject({ t: "error", code: "limit", sha1: SIG });
  expect(await ask(s, SIG)).toMatchObject({ t: "blob" });                     // gets are not counted
  const other = await as(r, "owner");
  expect(await ask(other, SIG, true)).toMatchObject({ t: "blob" });            // another user has its own count
  t += 61_000;
  expect(await ask(s, SIG, true)).toMatchObject({ t: "blob" });
});

test("with a publicUrl the signed URL is absolute on it (a trailing slash is dropped)", async () => {
  const r = await rig({ server: { publicUrl: "https://plenary.example.test/" } }), s = await as(r, "viewer");
  expect((await ask(s, SIG)).url).toMatch(/^https:\/\/plenary\.example\.test\/blobs\/[\w-]+\.[\w-]+$/);
});

test("a server without a blob store answers unavailable", async () => {
  const r = await rig({ blobs: null }), s = await as(r, "editor");
  expect(await ask(s, SIG)).toMatchObject({ t: "error", code: "unavailable", sha1: SIG });
  expect((await fetch(`${r.server.url}/blobs/x.y`)).status).toBe(404);
});

test("HTTP: put 201 then 200, get 200 with type, nosniff, no-store; the bytes round-trip", async () => {
  const r = await rig(), s = await as(r, "editor"), bytes = fakePng(2000, 5), h = sha1(bytes);
  const put = tok((await ask(s, h, true)).url), get = tok((await ask(s, h)).url);
  const base = r.server.url + "/blobs/";
  const a = await fetch(base + put, { method: "PUT", body: bytes });
  expect(a.status).toBe(201);
  expect((await fetch(base + put, { method: "PUT", body: bytes })).status).toBe(200);
  const g = await fetch(base + get);
  expect(g.status).toBe(200);
  expect(g.headers.get("content-type")).toBe("image/png");
  expect(g.headers.get("x-content-type-options")).toBe("nosniff");
  expect(g.headers.get("cache-control")).toBe("no-store");
  expect(g.headers.get("content-security-policy")).toContain("sandbox");
  expect(new Uint8Array(await g.arrayBuffer())).toEqual(bytes);
  expect((await ask(s, sha1(fakePng(30, 2)))).url).toBeTruthy();
});

test("HTTP put refusals: mismatch 422, SVG 415, empty 400, chunked 400, over 10 MB 413, none of it stored", async () => {
  const r = await rig(), s = await as(r, "editor"), bytes = fakePng(500, 1), h = sha1(bytes);
  const url = async (hh = h) => r.server.url + "/blobs/" + tok((await ask(s, hh, true)).url);
  expect((await fetch(await url(), { method: "PUT", body: fakePng(500, 2) })).status).toBe(422);
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
  const rs = await fetch(await url(sha1(svg)), { method: "PUT", body: svg });
  expect([rs.status, (await rs.json()).error]).toEqual([415, "not-image"]);
  expect((await fetch(await url(), { method: "PUT", body: "" })).status).toBe(400);
  const chunked = new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
  expect((await fetch(await url(), { method: "PUT", body: chunked, duplex: "half" })).status).toBe(400);
  const big = fakePng(10 * 1024 * 1024 + 1, 3);
  expect((await fetch(await url(sha1(big)), { method: "PUT", body: big })).status).toBe(413);
  expect(await r.server.blobs.get(r.ids.tenant, h)).toBe(null);
  expect(await r.server.blobs.get(r.ids.tenant, sha1(svg))).toBe(null);
});

test("HTTP tokens: tampered 401, a get token can't put (405), unknown verbs 405, odd paths 404/401", async () => {
  const r = await rig(), s = await as(r, "editor"), bytes = fakePng(300, 1), h = sha1(bytes);
  const get = tok((await ask(s, h)).url), put = tok((await ask(s, h, true)).url), base = r.server.url + "/blobs/";
  const flip = x => x.slice(0, -2) + (x.at(-2) === "A" ? "B" : "A") + x.at(-1);
  expect((await fetch(base + flip(put), { method: "PUT", body: bytes })).status).toBe(401);
  expect((await fetch(base + flip(get))).status).toBe(401);
  const wrong = await fetch(base + get, { method: "PUT", body: bytes });
  expect([wrong.status, wrong.headers.get("allow")]).toEqual([405, "GET, PUT"]);
  expect((await fetch(base + put)).status).toBe(405);
  expect((await fetch(base + put, { method: "DELETE" })).status).toBe(405);
  expect((await fetch(base + put + "/x")).status).toBe(404);
  expect((await fetch(base)).status).toBe(404);
  expect((await fetch(base + "garbage")).status).toBe(401);
  expect(await r.server.blobs.get(r.ids.tenant, h)).toBe(null);
});

test("HTTP: a URL stops working after 5 minutes", async () => {
  let t = 1_000_000;
  const r = await rig({ now: () => t }), s = await as(r, "editor"), bytes = fakePng(300, 1), h = sha1(bytes);
  const put = r.server.url + "/blobs/" + tok((await ask(s, h, true)).url);
  t += 5 * 60_000 + 1;
  expect((await fetch(put, { method: "PUT", body: bytes })).status).toBe(401);
});

test("HTTP quota: 507 when full, a stored blob can still be put again", async () => {
  const r = await rig({ server: { quotaBytes: 1000 } }), s = await as(r, "editor");
  const a = fakePng(600, 1), b = fakePng(600, 2), put = async x => (await fetch(r.server.url + "/blobs/" + tok((await ask(s, sha1(x), true)).url), { method: "PUT", body: x })).status;
  expect(await put(a)).toBe(201);
  expect(await put(b)).toBe(507);
  expect(await put(a)).toBe(200);
});

test("DW-42.1: a signed URL survives a restart only with a shared key; without one the client asks again", async () => {
  const key = new Uint8Array(32).fill(5), bytes = fakePng(300, 1), h = sha1(bytes);
  const a = await rig({ server: { blobKey: key } }), s = await as(a, "editor");
  const put = tok((await ask(s, h, true)).url);
  await a.stop();
  const b = await rig({ dir: a.dir, registry: a.registry, ids: a.ids, server: { blobKey: key } });
  expect((await fetch(b.server.url + "/blobs/" + put, { method: "PUT", body: bytes })).status).toBe(201);   // verified by the new process
  await b.stop();
  const c = await rig({ dir: a.dir, registry: a.registry, ids: a.ids });                                    // another key: the old URL is dead…
  expect((await fetch(c.server.url + "/blobs/" + put, { method: "PUT", body: bytes })).status).toBe(401);
  const s2 = await as(c, "viewer");                                                                         // …and a new ask works, for the bytes stored before
  const g = await fetch(c.server.url + (await ask(s2, h)).url);
  expect(new Uint8Array(await g.arrayBuffer())).toEqual(bytes);
});

/** A raw HTTP PUT that sends its headers and `sent` bytes of a body it promised `len` of, then stalls. */
async function stalledPut(r, token, len, sent) {
  const url = new URL(r.server.url), chunks = [];
  let closed = false;
  const sock = await Bun.connect({ hostname: url.hostname, port: Number(url.port), socket: {
    data(_, d) { chunks.push(Buffer.from(d).toString()); }, close() { closed = true; }, error() { closed = true; }, open(s) {
      s.write(`PUT /blobs/${token} HTTP/1.1\r\nHost: x\r\nContent-Length: ${len}\r\n\r\n`); s.write(new Uint8Array(sent).fill(1)); } } });
  return { sock, reply: () => chunks.join(""), closed: () => closed, end: () => sock.end() };
}

test("PUT bodies in flight are limited per node: past the limit 503 busy (retryable), and a freed slot works again", async () => {
  const r = await rig({ server: { maxBlobPuts: 2 } }), s = await as(r, "editor"), bytes = fakePng(300, 1), h = sha1(bytes);
  const put = async () => tok((await ask(s, h, true)).url);
  const a = await stalledPut(r, await put(), 300, 10), b = await stalledPut(r, await put(), 300, 10);
  const third = await put();
  await until(async () => (await fetch(r.server.url + "/blobs/" + third, { method: "PUT", body: bytes })).status === 503, "the third PUT refused as busy");
  const busy = await fetch(r.server.url + "/blobs/" + third, { method: "PUT", body: bytes });
  expect([busy.status, (await busy.json()).error, busy.headers.get("retry-after")]).toEqual([503, "busy", "2"]);
  a.end();                                                                      // a stalled upload that goes away frees its slot
  await until(async () => (await fetch(r.server.url + "/blobs/" + third, { method: "PUT", body: bytes })).status === 201, "a freed slot");
  b.end();
});

/** Timers a test fires by hand: no real waiting. */
const handTimers = () => { const q = []; return { q, set: (fn, ms) => { const t = { fn, ms }; q.push(t); return t; }, clear: t => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); }, fireAll: () => { for (const t of q.splice(0)) t.fn(); } }; };

test("one user's stalled uploads can't take the node's slots: the per-user cap refuses their third, another user still uploads", async () => {
  const r = await rig({ server: { maxBlobPuts: 8, blobHttp: { maxPutsPerUser: 2 } } }), a = await as(r, "editor"), b = await as(r, "owner");
  const bytes = fakePng(300, 5), h = sha1(bytes), url = async s => tok((await ask(s, h, true)).url);
  const x1 = await stalledPut(r, await url(a), 300, 10), x2 = await stalledPut(r, await url(a), 300, 10);
  const third = await url(a);
  await until(async () => (await fetch(r.server.url + "/blobs/" + third, { method: "PUT", body: bytes })).status === 503, "the third PUT of one user refused");
  expect((await fetch(r.server.url + "/blobs/" + await url(b), { method: "PUT", body: bytes })).status).toBe(201);   // the node has room for others
  x1.end(); x2.end();
});

test("the per-user cap is per account, not per board: uploads spread over several boards still hit it", async () => {
  const r = await rig({ server: { maxBlobPuts: 8, blobHttp: { maxPutsPerUser: 2 } } });
  const boards = [r.ids.board, r.ids.otherBoard];
  await r.registry.setGrant(r.ids.otherBoard, "dev:editor", "editor");
  const bytes = fakePng(300, 8), h = sha1(bytes), socks = [];
  for (const board of boards) { const s = await r.sock(); s.send({ t: "hello", v: 1, token: tokenOf("editor"), board, since: 0, client: "e" + socks.length }); await s.next(m => m.t === "welcome"); let seen = 0; s.ask = async m => { s.send(m); const x = await until(() => s.msgs.slice(seen).find(y => y.t === "blob" || y.t === "error"), "answer"); seen = s.msgs.indexOf(x) + 1; return x; }; socks.push(s); }
  const url = async s => tok((await ask(s, h, true)).url);
  const x1 = await stalledPut(r, await url(socks[0]), 300, 10), x2 = await stalledPut(r, await url(socks[1]), 300, 10);   // one on each board
  const third = await url(socks[1]);
  await until(async () => (await fetch(r.server.url + "/blobs/" + third, { method: "PUT", body: bytes })).status === 503, "the same account's third PUT refused on a third board slot");
  x1.end(); x2.end();
});

test("a second PUT on a token already being read is refused 409, and the token works again once the first is gone", async () => {
  const r = await rig({ server: { blobHttp: { maxPutsPerUser: 8 } } }), s = await as(r, "editor"), bytes = fakePng(300, 6), h = sha1(bytes);
  const t = tok((await ask(s, h, true)).url);
  const first = await stalledPut(r, t, 300, 10);
  await until(async () => { const x = await fetch(r.server.url + "/blobs/" + t, { method: "PUT", body: bytes }); return x.status === 409 && (await x.json()).error === "in-flight"; }, "the same token refused while in flight");
  first.end();
  await until(async () => (await fetch(r.server.url + "/blobs/" + t, { method: "PUT", body: bytes })).status === 201, "the token usable again");
});

test("a body that drips is cut off at the total deadline (virtual time), however often it sends: 408, and the slot is freed", async () => {
  const timers = handTimers();
  const r = await rig({ server: { blobHttp: { timers, bodyDeadlineMs: 120_000, maxPutsPerUser: 1 } } }), s = await as(r, "editor"), bytes = fakePng(300, 7), h = sha1(bytes);
  const t = tok((await ask(s, h, true)).url), t2 = tok((await ask(s, h, true)).url);
  const drip = await stalledPut(r, t, 300, 10);
  await until(() => timers.q.length === 1, "the deadline armed for the body");
  expect(timers.q[0].ms).toBe(120_000);
  drip.sock.write(new Uint8Array(5).fill(1));                              // it keeps sending: the idle timeout never fires
  expect((await fetch(r.server.url + "/blobs/" + t2, { method: "PUT", body: bytes })).status).toBe(503);   // its slot is held
  timers.fireAll();                                                        // the deadline passes
  await until(() => drip.reply().startsWith("HTTP/1.1 408"), "408 for the drip");
  expect(drip.reply()).toContain("timeout");
  expect((await fetch(r.server.url + "/blobs/" + t2, { method: "PUT", body: bytes })).status).toBe(201);   // freed
  drip.end();
});

test("an upload that stops sending is cut by the idle timeout the server sets (not Bun's default)", async () => {
  const r = await rig({ server: { idleTimeoutSec: 1 } }), s = await as(r, "editor"), h = sha1(fakePng(300, 3));
  const stalled = await stalledPut(r, tok((await ask(s, h, true)).url), 1000, 10);
  await until(() => stalled.closed(), "the stalled upload closed by the idle timeout", 6000);
});
