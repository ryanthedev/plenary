// server/blob-access.js (signing, scoping, quota) over the real disk adapter, with an injected clock. No HTTP, no socket.
import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { blobAccess, URL_TTL_MS } from "../../server/blob-access.js";
import { diskBlobs } from "../../server/blobs/disk.js";
import { PortError } from "../../server/ids.js";
import { tempDir, cleanup, fakePng, sha1 } from "./helpers.js";

afterAll(cleanup);
const KEY = new Uint8Array(32).fill(7);
const tokenOf = url => url.slice(url.lastIndexOf("/") + 1);

function make(o = {}) {
  const clock = { t: 1_000_000 };
  const inner = o.blobs ?? diskBlobs({ dir: join(tempDir(), "blobs") });
  const calls = { usage: 0, put: 0 };
  const blobs = { put: (...a) => { calls.put++; return inner.put(...a); }, get: (...a) => inner.get(...a), usage: (...a) => { calls.usage++; return inner.usage(...a); }, ...(o.wrap ?? {}) };
  const access = blobAccess({ blobs, key: o.key ?? KEY, origin: "http://h.test", now: () => clock.t, ...(o.quotaBytes !== undefined ? { quotaBytes: o.quotaBytes } : {}) });
  return { access, clock, calls, inner };
}
const putUrl = (a, tenant, bytes, board = "b1") => a.url(tenant, board, sha1(bytes), "PUT").then(tokenOf);
const getUrl = (a, tenant, h, board = "b1") => a.url(tenant, board, h, "GET").then(tokenOf);

test("DW-42.2: a put token stores the bytes, a get token reads them back with the sniffed type; put twice is 201 then 200 semantics", async () => {
  const { access } = make(), bytes = fakePng(500, 3), h = sha1(bytes);
  expect(await access.put(await putUrl(access, "t1", bytes), bytes)).toEqual({ ok: true, created: true });
  expect(await access.put(await putUrl(access, "t1", bytes), bytes)).toEqual({ ok: true, created: false });
  const got = await access.get(await getUrl(access, "t1", h));
  expect(got).toMatchObject({ ok: true, type: "image/png" });
  expect(got.bytes).toEqual(bytes);
  expect(await access.get(await getUrl(access, "t1", sha1(fakePng(40, 9))))).toEqual({ ok: false, code: "not-found" });
});

test("the url names this server's origin and a path /blobs/<token>", async () => {
  const { access } = make();
  expect(await access.url("t1", "b1", "a".repeat(40), "GET")).toMatch(/^http:\/\/h\.test\/blobs\/[\w-]+\.[\w-]+$/);
});

test("a token is good for 5 minutes and no longer", async () => {
  const { access, clock } = make(), bytes = fakePng(100, 1);
  const tok = await putUrl(access, "t1", bytes);
  clock.t += URL_TTL_MS - 1;
  expect((await access.verify(tok, "PUT")).ok).toBe(true);
  clock.t += 2;
  expect(await access.put(tok, bytes)).toEqual({ ok: false, code: "bad-token" });
});

test("forged, tampered, foreign-key and malformed tokens are bad-token", async () => {
  const { access } = make(), other = make({ key: new Uint8Array(32).fill(8) }).access;
  const bytes = fakePng(100, 1), tok = await putUrl(access, "t1", bytes);
  const [payload, mac] = tok.split(".");
  const swapped = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), tenant: "t2" })).toString("base64url");
  const flip = s => s.slice(0, -2) + (s.at(-2) === "A" ? "B" : "A") + s.at(-1);
  for (const bad of [`${swapped}.${mac}`, `${payload}.${flip(mac)}`, `${flip(payload)}.${mac}`, await putUrl(other, "t1", bytes), "", ".", "a.b", "a.b.c", payload, "x".repeat(2000), `${payload}.`, null, 5])
    expect(await access.put(bad, bytes)).toEqual({ ok: false, code: "bad-token" });
  expect(await access.get(`${swapped}.${mac}`)).toEqual({ ok: false, code: "bad-token" });
});

test("a token works for its own verb only", async () => {
  const { access } = make(), bytes = fakePng(100, 2);
  expect(await access.put(await getUrl(access, "t1", sha1(bytes)), bytes)).toEqual({ ok: false, code: "wrong-verb" });
  expect(await access.get(await putUrl(access, "t1", bytes))).toEqual({ ok: false, code: "wrong-verb" });
});

test("tenant scoping: a blob is only reachable through a token of its tenant, and boards of a tenant share it", async () => {
  const { access } = make(), bytes = fakePng(100, 4), h = sha1(bytes);
  await access.put(await putUrl(access, "t1", bytes, "b1"), bytes);
  expect(await access.get(await getUrl(access, "t2", h))).toEqual({ ok: false, code: "not-found" });
  expect((await access.get(await getUrl(access, "t1", h, "b2"))).ok).toBe(true);
});

test("url refuses a scope that isn't an id, a sha1 and a verb", async () => {
  const { access } = make();
  for (const a of [["../x", "b", "a".repeat(40), "GET"], ["t", "b/c", "a".repeat(40), "GET"], ["t", "b", "A".repeat(40), "GET"], ["t", "b", "a".repeat(40), "DELETE"]])
    await expect(access.url(...a)).rejects.toMatchObject({ code: "bad-id" });
});

test("bad bytes: a hash mismatch, an SVG and an empty body are refused and nothing is stored or counted", async () => {
  const { access, inner } = make({ quotaBytes: 300 }), good = fakePng(200, 5);
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
  expect(await access.put(await putUrl(access, "t1", good), fakePng(200, 6))).toEqual({ ok: false, code: "hash-mismatch" });
  expect(await access.put(await putUrl(access, "t1", svg), svg)).toEqual({ ok: false, code: "not-image" });
  expect(await access.put(await putUrl(access, "t1", good), new Uint8Array(0))).toEqual({ ok: false, code: "bad-length" });
  expect(await inner.usage("t1")).toBe(0);
  expect((await access.put(await putUrl(access, "t1", good), good)).ok).toBe(true);   // the refusals gave their reservations back
});

test("the 10 MB cap: one byte over is too-large", async () => {
  const { access } = make(), big = fakePng(10 * 1024 * 1024 + 1, 1);
  expect(await access.put(await putUrl(access, "t1", big), big)).toEqual({ ok: false, code: "too-large" });
});

test("quota: puts racing on one node can't go over it together", async () => {
  const { access, inner } = make({ quotaBytes: 1000 });
  const imgs = [fakePng(400, 1), fakePng(400, 2), fakePng(400, 3)];
  const res = await Promise.all(imgs.map(async b => access.put(await putUrl(access, "t1", b), b)));
  expect(res.filter(r => r.ok)).toHaveLength(2);
  expect(res.filter(r => !r.ok)).toEqual([{ ok: false, code: "quota" }]);
  expect(await inner.usage("t1")).toBe(800);
});

test("quota: a tenant's earlier data counts (read once), another tenant has its own, a blob it already holds costs nothing", async () => {
  const dir = join(tempDir(), "blobs"), seed = diskBlobs({ dir }), old = fakePng(900, 1);
  await seed.put("t1", sha1(old), old);
  const { access, calls } = make({ blobs: diskBlobs({ dir }), quotaBytes: 1000 });
  const more = fakePng(200, 2);
  expect(await access.put(await putUrl(access, "t1", more), more)).toEqual({ ok: false, code: "quota" });
  expect((await access.put(await putUrl(access, "t2", more), more)).ok).toBe(true);
  expect(await access.put(await putUrl(access, "t1", old), old)).toEqual({ ok: true, created: false });   // at the limit, but already stored
  await access.put(await putUrl(access, "t1", more), more);
  expect(calls.usage).toBe(2);                                                                              // t1 once, t2 once
});

test("a usage read that fails is unavailable, and the next put reads again", async () => {
  let fail = true;
  const { access } = make({ wrap: { usage: async () => { if (fail) throw new PortError("unavailable", "down"); return 0; } } }), b = fakePng(100, 1);
  expect(await access.put(await putUrl(access, "t1", b), b)).toEqual({ ok: false, code: "unavailable" });
  fail = false;
  expect((await access.put(await putUrl(access, "t1", b), b)).ok).toBe(true);
});

test("an adapter that fails or times out is unavailable (retryable), and its reservation is returned", async () => {
  let n = 0;
  const { access } = make({ quotaBytes: 150, wrap: { put: async () => { if (++n === 1) throw new PortError("timeout", "slow"); if (n === 2) throw new Error("boom"); return true; } } });
  const b = fakePng(100, 1), tok = () => putUrl(access, "t1", b);
  expect(await access.put(await tok(), b)).toEqual({ ok: false, code: "unavailable" });
  expect(await access.put(await tok(), b)).toEqual({ ok: false, code: "unavailable" });
  expect((await access.put(await tok(), b)).ok).toBe(true);                                                // 100 fits in 150: nothing stayed reserved
});

test("a stored blob that isn't an image is never served", async () => {
  const { access } = make({ wrap: { get: async () => new Uint8Array(50).fill(1) } });
  expect(await access.get(await getUrl(access, "t1", "a".repeat(40)))).toEqual({ ok: false, code: "unavailable" });
});

test("construction checks its inputs", () => {
  const blobs = diskBlobs({ dir: tempDir() }), base = { blobs, key: KEY, origin: "" };
  expect(() => blobAccess({ ...base, key: new Uint8Array(8) })).toThrow(TypeError);
  expect(() => blobAccess({ ...base, blobs: { put() {}, get() {} } })).toThrow(TypeError);
  expect(() => blobAccess({ ...base, origin: 5 })).toThrow(TypeError);
  expect(() => blobAccess({ ...base, quotaBytes: -1 })).toThrow(TypeError);
});
