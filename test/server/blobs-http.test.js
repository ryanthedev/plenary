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
  expect((await s.ask({ t: "blob", sha1: "x" })).sha1).toBe(undefined);
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
