// Idempotent creates over HTTP (PROTOCOL.md "Idempotent creates", #73, exactly-once #86): the Idempotency-Key header on POST /boards, /spaces,
// /groups, /teams, invites and links. A retry returns the first object (never a 409, never a second one), a changed request is refused, and a create
// that committed and then failed unclearly (or a crash before the answer) is answered the same way.
import { test, expect, beforeEach } from "bun:test";
import { httpRoutes } from "../../server/auth/http.js";
import { sessions as makeSessions } from "../../server/auth/session.js";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy as makeTenancy } from "../../server/auth/tenancy.js";
import { homeService } from "../../server/auth/home.js";
import { devAuth } from "../../server/auth/dev.js";
import { readLink, readInvite } from "../../server/admin/boards.js";

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
  hooks = { before: {}, after: {}, fake: {}, reads: [], created: [] };
  vt = virtualTimers();
  mem = memoryRegistry();
  reg = new Proxy(mem, { get(o, k) { const v = o[k]; return typeof v === "function" ? async (...a) => { if (hooks.fake[k]) return hooks.fake[k](...a); await hooks.before[k]?.(...a); const out = await v.apply(o, a); if (k === "createBoard") hooks.created.push(out.id); if (k === "idemGet") hooks.reads.push(out); await hooks.after[k]?.(out); return out; } : v; } });
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

test("DW-86a a create that COMMITS and whose response is then lost (deadline 503): the retry returns the first board at once, no 409, no second board", async () => {
  let release; hooks.after.createBoard = () => new Promise(r => { release = r; });   // committed; the handler is still running when the deadline hits
  const first = post("/boards", { title: "Cut" }, { key: K });
  await flush(); await flush(); await flush();
  expect(await boards()).toHaveLength(1);
  const mid = await post("/boards", { title: "Cut" }, { key: K });   // a retry while the first is still running: answered from the committed key, immediately
  expect(mid.status).toBe(201);
  expect(mid.headers.get("idempotent-replayed")).toBe("true");
  vt.advance(DEADLINE);
  expect((await first).status).toBe(503);
  release(); await flush(); await flush();
  const retry = await post("/boards", { title: "Cut" }, { key: K });
  expect(retry.status).toBe(201);
  expect((await retry.json()).board.id).toBe((await boards())[0]);
  expect(await boards()).toHaveLength(1);
});

test("a board made under a key is made with its owner in the same step (nothing to repair, no owner-grant-failed)", async () => {
  const made = await (await post("/boards", { title: "Mine" }, { key: K })).json();
  expect(await mem.grants(made.board.id)).toEqual([{ user: "dev:ada", role: "owner" }]);
  hooks.before.setGrant = () => { throw new Error("db down"); };   // a failing grant call is not part of a create any more
  const b = await post("/boards", { title: "Other" }, { key: "key-bbbb-0002" });
  expect(b.status).toBe(201);
  expect(await mem.grants((await b.json()).board.id)).toEqual([{ user: "dev:ada", role: "owner" }]);
});

test("a refusal made before anything was written is a failure of the create: its key row rolls back with it", async () => {
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

// ---- the replay is authorized again (security review): a stored answer is a reference, never a body, and never outlives the caller's access ----

const owned = async () => {   // a board ada owns, with bo as a second owner
  const board = (await (await post("/boards", { title: "Shared" })).json()).board.id;
  await mem.setGrant(board, "dev:bo", "owner");
  return board;
};

test("SEC a link made by an owner who then loses the board: replaying the key is 403 forbidden with no token anywhere in the body, and only a reference was stored", async () => {
  const board = await owned();
  const first = await post(`/boards/${board}/links`, { role: "viewer" }, { tok: "bo", key: K });
  const made = await first.json();
  expect(first.status).toBe(201);
  // what is stored under a key is the object's id only: no body, no url. (A link's id is the id reg_links already holds in the same store.)
  expect(await post(`/boards/${board}/links`, { role: "viewer" }, { tok: "bo", key: K }).then(r => r.status)).toBe(201);   // still allowed: replayed
  expect(hooks.reads.at(-1)).toEqual({ state: "done", ref: made.link.id });
  await mem.setGrant(board, "dev:bo", "viewer");   // bo is no longer a manager
  const replay = await post(`/boards/${board}/links`, { role: "viewer" }, { tok: "bo", key: K });
  expect(replay.status).toBe(403);
  const text = await replay.text();
  expect(text).not.toContain(made.link.id);
  expect(text).not.toContain("link");
  expect(replay.headers.get("idempotent-replayed")).toBeNull();
});

test("SEC the same for an invite, and a replay of a revoked link is 404", async () => {
  const board = await owned();
  const inv = await (await post(`/boards/${board}/invites`, { email: "x@y.com", role: "viewer" }, { tok: "bo", key: "key-inv-sec01" })).json();
  const lk = await (await post(`/boards/${board}/links`, { role: "viewer" }, { tok: "bo", key: "key-lnk-sec01" })).json();
  await mem.revokeLink(lk.link.id);
  const stillLink = await post(`/boards/${board}/links`, { role: "viewer" }, { tok: "bo", key: "key-lnk-sec01" });
  expect(stillLink.status).toBe(404);   // L7: a revoked link is gone, not a 201 with its url
  expect(await stillLink.json()).toEqual({ error: "not-found" });
  await mem.setGrant(board, "dev:bo", "viewer");
  const r = await post(`/boards/${board}/invites`, { email: "x@y.com", role: "viewer" }, { tok: "bo", key: "key-inv-sec01" });
  expect(r.status).toBe(403);
  expect(await r.text()).not.toContain(inv.invite.id);
});

test("SEC a board made in a Space by an editor who then loses board.create there: the replay is 403; a Space or Group made under a key likewise", async () => {
  const sp = (await (await post("/spaces", { name: "Shared" })).json()).space.id;
  await mem.setScopedGrant({ scope: { type: "space", id: sp }, subject: { type: "user", id: "dev:bo" }, role: "editor" });
  const made = await (await post("/boards", { title: "Mine", space: sp }, { tok: "bo", key: K })).json();
  expect((await post("/boards", { title: "Mine", space: sp }, { tok: "bo", key: K })).status).toBe(201);
  await mem.setScopedGrant({ scope: { type: "space", id: sp }, subject: { type: "user", id: "dev:bo" }, role: null });
  await mem.setScopedGrant({ scope: { type: "space", id: sp }, subject: { type: "user", id: "dev:bo" }, role: "viewer" });
  const r = await post("/boards", { title: "Mine", space: sp }, { tok: "bo", key: K });
  expect(r.status).toBe(403);
  expect(await r.text()).not.toContain(made.board.id);
  // a Space under a Group: bo is a Group editor, then not
  const g = (await (await post("/groups", { name: "Team" })).json()).group.id;
  await mem.setScopedGrant({ scope: { type: "group", id: g }, subject: { type: "user", id: "dev:bo" }, role: "editor" });
  const s2 = await (await post("/spaces", { name: "Under", group: g }, { tok: "bo", key: "key-sp-sec01" })).json();
  expect(s2.space.id).toBeTruthy();
  await mem.setScopedGrant({ scope: { type: "group", id: g }, subject: { type: "user", id: "dev:bo" }, role: null });
  const r2 = await post("/spaces", { name: "Under", group: g }, { tok: "bo", key: "key-sp-sec01" });
  expect(r2.status).toBe(403);
  expect(await r2.text()).not.toContain(s2.space.id);
  // a Group is replayed by its creator while they still hold group.create (the unit admin here), and answers as the create did
  const gr = await (await post("/groups", { name: "Again" }, { key: "key-gr-sec01" })).json();
  const grAgain = await post("/groups", { name: "Again" }, { key: "key-gr-sec01" });
  expect([grAgain.status, (await grAgain.json()).group.id]).toEqual([201, gr.group.id]);
});

test("SEC another user replaying the same key never sees the first user's result (keys are per user): they get their own object, not a replay", async () => {
  const board = await owned();
  const a = await (await post(`/boards/${board}/links`, { role: "viewer" }, { key: K })).json();
  const b = await post(`/boards/${board}/links`, { role: "viewer" }, { tok: "bo", key: K });
  expect(b.headers.get("idempotent-replayed")).toBeNull();
  const bb = await b.json();
  expect(bb.link.id).not.toBe(a.link.id);
  expect(JSON.stringify(bb)).not.toContain(a.link.id);
});

// ---- the key row and the object commit together, or neither does ----

test("DW-86b a create that COMMITS and then fails unclearly (client-timeout) or crashes before its answer: the retry returns the first board immediately, never 409 and never a second board", async () => {
  hooks.after.createBoard = () => { throw Object.assign(new Error("no answer"), { code: "client-timeout" }); };
  const first = await post("/boards", { title: "Maybe" }, { key: K });
  expect(first.status).toBe(503);
  expect(await boards()).toHaveLength(1);                    // it did commit
  hooks.after.createBoard = undefined;
  const retry = await post("/boards", { title: "Maybe" }, { key: K });
  expect(retry.status).toBe(201);
  expect(retry.headers.get("idempotent-replayed")).toBe("true");
  expect((await retry.json()).board.id).toBe((await boards())[0]);
  expect(await boards()).toHaveLength(1);                    // still exactly one
  expect(mem.idemSize()).toBe(1);
});

test("a create that fails BEFORE committing leaves no key: the retry runs as a first use and creates once", async () => {
  let n = 0;
  hooks.before.createBoard = () => { if (n++ === 0) throw new Error("queue-timeout"); };
  expect((await post("/boards", { title: "Again" }, { key: K })).status).toBe(503);
  expect(await boards()).toHaveLength(0);
  expect(mem.idemSize()).toBe(0);
  const retry = await post("/boards", { title: "Again" }, { key: K });
  expect(retry.status).toBe(201);
  expect(retry.headers.get("idempotent-replayed")).toBeNull();
  expect(await boards()).toHaveLength(1);
});

test("a create that races the first one (its pre-read said none) is answered by the create's own idem-replay, not a second object; a changed body is 422", async () => {
  const first = await (await post("/boards", { title: "Roadmap" }, { key: K })).json();
  hooks.fake.idemGet = async () => ({ state: "none" });   // the pre-read ran before the first committed
  const raced = await post("/boards", { title: "Roadmap" }, { key: K });
  expect([raced.status, raced.headers.get("idempotent-replayed")]).toEqual([201, "true"]);
  expect((await raced.json()).board.id).toBe(first.board.id);
  const changed = await post("/boards", { title: "Different" }, { key: K });
  expect([changed.status, (await changed.json()).error]).toEqual([422, "idempotency-key-reused"]);
  expect(await boards()).toEqual([first.board.id]);
});

test("POST /teams with a key: the retry returns the first Team (replay header), a changed body is 422, a keyless create is new each time", async () => {
  const a = await post("/teams", { name: "Platform" }, { key: K });
  expect(a.status).toBe(201);
  expect(a.headers.get("idempotent-replayed")).toBeNull();
  const first = (await a.json()).team;
  const b = await post("/teams", { name: "Platform" }, { key: K });
  expect([b.status, b.headers.get("idempotent-replayed")]).toEqual([201, "true"]);
  expect((await b.json()).team).toEqual(first);
  expect(await mem.teams(acme.id)).toHaveLength(1);
  const c = await post("/teams", { name: "Other" }, { key: K });
  expect(c.status).toBe(422);
  expect(await c.json()).toEqual({ error: "idempotency-key-reused" });
  expect((await post("/teams", { name: "Platform" })).status).toBe(201);
  expect(await mem.teams(acme.id)).toHaveLength(2);
});

test("SEC a Team created under a key by someone who then loses team.manage: the replay is 403 and the body names no Team", async () => {
  const fac = await mem.createRole({ tenant: acme.id, name: "Facilitator", boardRole: "viewer", permissions: ["team.manage"] });
  const grant = role => mem.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: { type: "user", id: "dev:bo" }, role });
  await grant(fac.id);
  const made = await (await post("/teams", { name: "Ops" }, { tok: "bo", key: K })).json();
  expect(made.team.id).toBeTruthy();
  expect((await post("/teams", { name: "Ops" }, { tok: "bo", key: K })).status).toBe(201);   // still allowed: replayed
  await grant(null);
  const r = await post("/teams", { name: "Ops" }, { tok: "bo", key: K });
  expect(r.status).toBe(403);
  expect(r.headers.get("idempotent-replayed")).toBeNull();
  expect(await r.text()).not.toContain(made.team.id);
});

test("POST /teams replay is authorized again, and a Team created after a lost response is not duplicated", async () => {
  hooks.after.createTeam = () => { throw Object.assign(new Error("no answer"), { code: "client-timeout" }); };
  expect((await post("/teams", { name: "Lost" }, { key: K })).status).toBe(503);
  hooks.after.createTeam = undefined;
  expect(await mem.teams(acme.id)).toHaveLength(1);
  const retry = await post("/teams", { name: "Lost" }, { key: K });
  expect([retry.status, retry.headers.get("idempotent-replayed")]).toEqual([201, "true"]);
  expect(await mem.teams(acme.id)).toHaveLength(1);
  // bo holds no team.manage: never made one under this key, and gets the route's 403 (no key row is written for a refusal)
  const refused = await post("/teams", { name: "Lost" }, { tok: "bo", key: K });
  expect(refused.status).toBe(403);
  expect(mem.idemSize()).toBe(1);
});

// ---- L7 ----

test("L7 readLink / readInvite: a revoked or expired one is not-found, a live one is returned", async () => {
  const board = (await (await post("/boards", { title: "B" })).json()).board.id;
  const caller = { user: "dev:ada", name: null, email: null, domain: null };
  const l = await mem.createLink({ board, role: "viewer", expiresAt: 5000, by: "dev:ada" });
  const i = await mem.createInvite({ board, email: "x@y.com", role: "viewer", expiresAt: 5000, by: "dev:ada" });
  const at = t => ({ registry: mem, now: () => t });
  expect((await readLink({ caller, board, link: l.id }, at(4999))).id).toBe(l.id);
  expect((await readInvite({ caller, board, invite: i.id }, at(4999))).id).toBe(i.id);
  await expect(readLink({ caller, board, link: l.id }, at(5000))).rejects.toMatchObject({ code: "not-found" });
  await expect(readInvite({ caller, board, invite: i.id }, at(5000))).rejects.toMatchObject({ code: "not-found" });
  await mem.revokeInvite(i.id);
  await expect(readInvite({ caller, board, invite: i.id }, at(1))).rejects.toMatchObject({ code: "not-found" });
});

test("an access request's key retried after a later ask replaced the request is 409 superseded, never the newer request", async () => {
  await mem.touchMember(acme.id, { user: "dev:bo", name: "bo", email: "bo@acme.com" });
  const sp = (await (await post("/spaces", { name: "S", general: "viewer" })).json()).space.id;
  const a = await post(`/access/space/${sp}/requests`, { role: "commenter" }, { tok: "bo", key: K });
  expect(a.status).toBe(201);
  expect((await a.json()).request.role).toBe("commenter");
  const again = await post(`/access/space/${sp}/requests`, { role: "commenter" }, { tok: "bo", key: K });
  expect([again.status, again.headers.get("idempotent-replayed")]).toEqual([201, "true"]);
  await mem.requestAccess({ tenant: acme.id, scope: { type: "space", id: sp }, user: "dev:bo", role: "editor", supersede: true });   // a later ask replaced it
  const stale = await post(`/access/space/${sp}/requests`, { role: "commenter" }, { tok: "bo", key: K });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ error: "superseded" });
});
