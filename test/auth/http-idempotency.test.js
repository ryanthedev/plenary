// Idempotent creates over HTTP (PROTOCOL.md "Idempotent creates", #73): the Idempotency-Key header on POST /boards, /spaces, /groups,
// invites and links. A retry returns the first answer, a changed request is refused, a cut-off create keeps its outcome.
import { test, expect, beforeEach } from "bun:test";
import { httpRoutes } from "../../server/auth/http.js";
import { sessions as makeSessions } from "../../server/auth/session.js";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy as makeTenancy } from "../../server/auth/tenancy.js";
import { homeService } from "../../server/auth/home.js";
import { devAuth } from "../../server/auth/dev.js";

const ORIGIN = "https://plenary.test";
const config = { cookieKey: "k".repeat(32), postLoginUrl: ORIGIN + "/", boardUrl: ORIGIN + "/b/{board}", publicUrl: ORIGIN };
const DEADLINE = 8000;
const flush = () => new Promise(r => setImmediate(r));

function virtualTimers() {
  let t = 0, id = 0; const q = new Map();
  return { set: (fn, ms) => { q.set(++id, { fn, at: t + ms }); return id; }, clear: h => { q.delete(h); },
    advance(ms) { t += ms; for (const [h, e] of [...q]) if (e.at <= t) { q.delete(h); e.fn(); } } };
}

let mem, reg, routes, vt, acme, hooks;
/** `hooks.before[method]` may return a promise a registry call waits on (a slow call), or throw (a failing one). */
beforeEach(async () => {
  hooks = { before: {}, created: [] };
  vt = virtualTimers();
  mem = memoryRegistry();
  reg = new Proxy(mem, { get(o, k) { const v = o[k]; return typeof v === "function" ? async (...a) => { await hooks.before[k]?.(...a); const out = await v.apply(o, a); if (k === "createBoard") hooks.created.push(out.id); return out; } : v; } });
  const tenancy = makeTenancy({ registry: reg });
  const dev = devAuth({ enabled: true, tokens: { ada: { name: "ada", domain: "acme.com", email: "ada@acme.com" }, bo: { name: "bo", domain: "acme.com", email: "bo@acme.com" } } });
  acme = await mem.createTenant({ domain: "acme.com", admins: ["dev:ada"] });
  routes = httpRoutes({ registry: reg, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy, home: homeService({ registry: reg, tenancy }), config, dev, timers: vt, log: { warn() {} } });
});

const post = (path, body, { tok = "ada", key } = {}) => routes(new Request(ORIGIN + path, { method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${tok}`, ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) }));
const boards = async () => [...hooks.created];
const K = "key-aaaa-0001";

test("DW-F1 POST /boards with a key: the retry gets the first answer (same board, replay header) and nothing is created twice", async () => {
  const a = await post("/boards", { title: "Roadmap" }, { key: K });
  expect(a.status).toBe(201);
  expect(a.headers.get("idempotent-replayed")).toBeNull();
  const first = (await a.json()).board;
  const b = await post("/boards", { title: "Roadmap" }, { key: K });
  expect(b.status).toBe(201);
  expect(b.headers.get("idempotent-replayed")).toBe("true");
  expect((await b.json()).board.id).toBe(first.id);
  expect(await boards()).toEqual([first.id]);
});

test("without a key every create is new (nothing changes for a keyless caller)", async () => {
  await post("/boards", { title: "Roadmap" }); await post("/boards", { title: "Roadmap" });
  expect(await boards()).toHaveLength(2);
});

test("the same key with a different body or another route is 422 idempotency-key-reused and runs nothing", async () => {
  await post("/boards", { title: "One" }, { key: K });
  const other = await post("/boards", { title: "Two" }, { key: K });
  expect(other.status).toBe(422);
  expect(await other.json()).toEqual({ error: "idempotency-key-reused" });
  expect((await post("/spaces", { name: "One" }, { key: K })).status).toBe(422);
  expect(await boards()).toHaveLength(1);
});

test("a key belongs to its user: another user's create under the same key is new", async () => {
  const a = await (await post("/boards", { title: "Mine" }, { key: K })).json();
  const b = await (await post("/boards", { title: "Mine" }, { tok: "bo", key: K })).json();
  expect(b.board.id).not.toBe(a.board.id);
});

test("a malformed key is 400 bad-idempotency-key", async () => {
  for (const key of ["short", "x".repeat(65), "has space 12345", "ünïcode-key-1"]) {
    const r = await post("/boards", { title: "t" }, { key });
    expect([key, r.status, (await r.json()).error]).toEqual([key, 400, "bad-idempotency-key"]);
  }
  expect(await boards()).toHaveLength(0);
});

test("a retry while the first is still running is 409 in-progress with Retry-After; once it finishes the retry gets its answer", async () => {
  let release; hooks.before.createBoard = () => new Promise(r => { release = r; });
  const first = post("/boards", { title: "Slow" }, { key: K });
  await flush(); await flush();
  const mid = await post("/boards", { title: "Slow" }, { key: K });
  expect(mid.status).toBe(409);
  expect(mid.headers.get("retry-after")).toBe("1");
  expect(await mid.json()).toEqual({ error: "in-progress" });
  release(); const done = await (await first).json();
  const again = await post("/boards", { title: "Slow" }, { key: K });
  expect((await again.json()).board.id).toBe(done.board.id);
});

test("DW-F2 a deadline cut between create and the owner grant keeps its outcome: the retry returns owner-grant-failed WITH the board id", async () => {
  let calls = 0;   // the first owner grant hangs, then fails when freed; its retry fails at once
  hooks.before.setGrant = () => (calls++ === 0 ? new Promise((_, rej) => { hooks.freeGrant = () => rej(new Error("db down")); }) : Promise.reject(new Error("db down")));
  const first = post("/boards", { title: "Cut" }, { key: K });
  await flush(); await flush(); await flush();
  vt.advance(DEADLINE);
  expect((await first).status).toBe(503);   // the client sees a bare unavailable
  hooks.freeGrant();                        // the cut-off call goes on: its owner grant fails, is retried once, fails again
  await flush(); await flush(); await flush(); await flush();
  const retry = await post("/boards", { title: "Cut" }, { key: K });
  expect(retry.status).toBe(503);
  const body = await retry.json();
  expect(body.error).toBe("owner-grant-failed");
  expect(typeof body.board).toBe("string");
  expect(await boards()).toEqual([body.board]);   // the one board, named in the answer
  expect(retry.headers.get("idempotent-replayed")).toBe("true");
});

test("an owner-grant failure with no deadline is stored too: a retry replays it without creating a second board", async () => {
  hooks.before.setGrant = () => { throw new Error("db down"); };
  const a = await post("/boards", { title: "NoOwner" }, { key: K });
  const first = await a.json();
  expect([a.status, first.error]).toEqual([503, "owner-grant-failed"]);
  hooks.before.setGrant = undefined;
  const b = await post("/boards", { title: "NoOwner" }, { key: K });
  expect(await b.json()).toEqual(first);
  expect(await boards()).toEqual([first.board]);
});

test("a refusal made before anything was written is not stored: the claim is dropped", async () => {
  const r = await post("/boards", { title: "t", space: "nope" }, { key: K });
  expect(r.status).toBe(403);
  expect(mem.idemSize()).toBe(0);
});

test("spaces, groups, invites and links replay the same object under one key", async () => {
  const sp = [await (await post("/spaces", { name: "S" }, { key: "key-space-01" })).json(), await (await post("/spaces", { name: "S" }, { key: "key-space-01" })).json()];
  expect(sp[1].space.id).toBe(sp[0].space.id);
  const gr = [await (await post("/groups", { name: "G" }, { key: "key-group-01" })).json(), await (await post("/groups", { name: "G" }, { key: "key-group-01" })).json()];
  expect(gr[1].group.id).toBe(gr[0].group.id);
  const board = (await (await post("/boards", { title: "B" })).json()).board.id;
  const inv = [await (await post(`/boards/${board}/invites`, { email: "x@y.com", role: "viewer" }, { key: "key-inv-0001" })).json(), await (await post(`/boards/${board}/invites`, { email: "x@y.com", role: "viewer" }, { key: "key-inv-0001" })).json()];
  expect(inv[1].invite.id).toBe(inv[0].invite.id);
  expect(await mem.invites(board)).toHaveLength(1);
  const lk = [await (await post(`/boards/${board}/links`, { role: "viewer" }, { key: "key-link-001" })).json(), await (await post(`/boards/${board}/links`, { role: "viewer" }, { key: "key-link-001" })).json()];
  expect(lk[1].link.id).toBe(lk[0].link.id);
  expect(lk[1].url).toBe(lk[0].url);
  expect(await mem.links(board)).toHaveLength(1);
  // the board id is part of the request: the same key on another board is a changed request
  const other = (await (await post("/boards", { title: "C" })).json()).board.id;
  expect((await post(`/boards/${other}/links`, { role: "viewer" }, { key: "key-link-001" })).status).toBe(422);
});
