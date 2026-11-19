// The Share dialog's server side (PROTOCOL.md § Share dialog, #52): who may read and change a board's invites and links (the `members.manage`
// PERMISSION, never a role name), what GET /boards/:board/share lists (live ones, guests tagged, nothing for anyone else), the invite's 30-day
// default, the guest/owner cap, and idempotent revoke. Over the HTTP routes with the in-memory Registry.
import { test, expect, beforeEach } from "bun:test";
import { httpRoutes } from "../../server/auth/http.js";
import { sessions as makeSessions } from "../../server/auth/session.js";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy as makeTenancy } from "../../server/auth/tenancy.js";
import { devAuth } from "../../server/auth/dev.js";
import { INVITE_TTL_MS } from "../../server/admin/boards.js";
import { mkBoard } from "./fixtures.js";

const ORIGIN = "https://plenary.test";
const config = { cookieKey: "k".repeat(32), postLoginUrl: ORIGIN + "/", boardUrl: ORIGIN + "/b/{board}", publicUrl: ORIGIN };
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 19);
let clock, mem, routes, acme, board, logs;
const now = () => clock;

const U = id => ({ type: "user", id });
const tokens = {
  ada: { name: "ada", domain: "acme.com", email: "ada@acme.com" },       // Unit admin
  own: { name: "own", domain: "acme.com", email: "own@acme.com" },       // board owner by grant
  edi: { name: "edi", domain: "acme.com", email: "edi@acme.com" },       // editor by grant: board content, no management
  fac: { name: "fac", domain: "acme.com", email: "fac@acme.com" },       // a custom role that carries members.manage, held at the Space
  vie: { name: "vie", domain: "acme.com", email: "vie@acme.com" },       // plain Unit member
  out: { name: "out", domain: "globex.com", email: "out@globex.com" },   // another Unit
  gst: { name: "gst", domain: null, email: "gst@gmail.com" },            // a guest holding an owner grant on this one board
};
const call = (method, path, { tok = "ada", body, key } = {}) => routes(new Request(ORIGIN + path, { method,
  headers: { authorization: `Bearer ${tok}`, ...(body ? { "content-type": "application/json" } : {}), ...(key ? { "idempotency-key": key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
const share = (tok, id = board) => call("GET", `/boards/${id}/share`, { tok });

beforeEach(async () => {
  clock = T0; logs = [];
  mem = memoryRegistry({ now });
  const tenancy = makeTenancy({ registry: mem, now });
  acme = await mem.createTenant({ domain: "acme.com", domains: ["acme.com", "acme.org"], admins: ["dev:ada"] });
  await mem.createTenant({ domain: "globex.com" });
  for (const n of ["own", "edi", "fac", "vie"]) await mem.touchMember(acme.id, { user: "dev:" + n, name: n, email: n + "@acme.com" });
  const sp = await mem.createSpace({ tenant: acme.id, name: "Design", generalRole: null, owner: "dev:ada" });
  const role = await mem.createRole({ tenant: acme.id, name: "Facilitator", boardRole: "viewer", permissions: ["members.manage"] });
  await mem.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: U("dev:fac"), role: role.id });
  board = (await mem.createBoard({ tenant: acme.id, title: "Roadmap", space: sp.id, owner: "dev:own" })).id;
  await mem.setGrant(board, "dev:edi", "editor");
  await mem.setGrant(board, "dev:gst", "owner");
  routes = httpRoutes({ registry: mem, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy, now, config, dev: devAuth({ enabled: true, tokens }),
    timers: { set: () => 0, clear() {} }, log: { warn: (m, f) => logs.push(m + JSON.stringify(f ?? {})), info: m => logs.push(m), error: m => logs.push(m) } });
});

test("DW-52.1 an invite: role and the 30-day default expiry (null is never; a past time is refused); the share read lists it with the guest tag", async () => {
  const a = await call("POST", `/boards/${board}/invites`, { body: { email: "Kim@Partner.io", role: "annotator" } });
  expect(a.status).toBe(201);
  const inv = (await a.json()).invite;
  expect(inv).toMatchObject({ email: "kim@partner.io", role: "annotator", expiresAt: T0 + 30 * DAY, guest: true });
  expect((await (await call("POST", `/boards/${board}/invites`, { body: { email: "ann@acme.org", role: "viewer" } })).json()).invite.guest).toBe(false);
  expect(INVITE_TTL_MS).toBe(30 * DAY);
  expect((await (await call("POST", `/boards/${board}/invites`, { body: { email: "x@acme.com", role: "viewer", expiresAt: null } })).json()).invite.expiresAt).toBeNull();
  expect((await call("POST", `/boards/${board}/invites`, { body: { email: "x@acme.com", role: "viewer", expiresAt: T0 - 1 } })).status).toBe(400);
  await call("POST", `/boards/${board}/invites`, { body: { email: "Lee@Acme.org", role: "viewer" } });
  const v = await (await share("ada")).json();
  expect(v.unit.domains).toEqual(["acme.com", "acme.org"]);
  expect(v.limits).toEqual({ inviteRoles: ["viewer", "commenter", "annotator", "editor"], linkRoles: ["viewer", "annotator", "editor"], inviteTtlMs: 30 * DAY });
  const byEmail = Object.fromEntries(v.invites.map(i => [i.email, i]));
  expect(byEmail["kim@partner.io"]).toMatchObject({ id: inv.id, guest: true, role: "annotator" });
  expect(byEmail["lee@acme.org"].guest).toBe(false);                                   // a secondary domain of the Unit is inside
  expect(byEmail["x@acme.com"].guest).toBe(false);
});

test("DW-52.2 a link: role and expiry; the share read lists it with its url; its id is the capability", async () => {
  const r = await call("POST", `/boards/${board}/links`, { body: { role: "viewer", expiresAt: T0 + 7 * DAY } });
  expect(r.status).toBe(201);
  const { link, url } = await r.json();
  expect(link).toMatchObject({ role: "viewer", expiresAt: T0 + 7 * DAY });
  expect(url).toBe(`${ORIGIN}/links/${link.id}`);
  expect((await call("POST", `/boards/${board}/links`, { body: { role: "owner" } })).status).toBe(400);
  const v = await (await share("own")).json();
  expect(v.links).toEqual([{ id: link.id, role: "viewer", expiresAt: T0 + 7 * DAY, createdAt: T0, url: `${ORIGIN}/links/${link.id}` }]);
});

test("a revoked or expired invite or link is not listed", async () => {
  const i = (await (await call("POST", `/boards/${board}/invites`, { body: { email: "a@b.io", role: "viewer", expiresAt: T0 + 1000 } })).json()).invite;
  const j = (await (await call("POST", `/boards/${board}/invites`, { body: { email: "c@d.io", role: "viewer" } })).json()).invite;
  const l = (await (await call("POST", `/boards/${board}/links`, { body: { role: "viewer" } })).json()).link;
  clock += 2000;
  expect((await (await share("ada")).json()).invites.map(x => x.id)).toEqual([j.id]);
  expect((await call("DELETE", `/boards/${board}/invites/${j.id}`)).status).toBe(204);
  expect((await call("DELETE", `/boards/${board}/links/${l.id}`)).status).toBe(204);
  const v = await (await share("ada")).json();
  expect([v.invites, v.links]).toEqual([[], []]);
  expect(i.id).toBeTruthy();
});

test("DW-52.3 who may open it is the members.manage permission: owner, Unit admin, a custom role that carries it, a guest who owns the board; nobody else, and all refusals are one answer", async () => {
  const ok = [];
  for (const tok of ["ada", "own", "fac", "gst"]) ok.push([tok, (await share(tok)).status]);
  expect(ok).toEqual([["ada", 200], ["own", 200], ["fac", 200], ["gst", 200]]);
  const refusals = [];
  for (const tok of ["edi", "vie", "out"]) { const r = await share(tok); refusals.push([r.status, await r.text()]); }
  const unknown = await share("ada", "b-nosuchboard00000"); refusals.push([unknown.status, await unknown.text()]);
  expect(new Set(refusals.map(r => r[0]))).toEqual(new Set([403]));
  expect(new Set(refusals.map(r => r[1])).size).toBe(1);                                // the same body: nothing says which
  // The same permission gates every write, and the lists of the older routes.
  for (const tok of ["edi", "vie", "out"]) {
    expect((await call("POST", `/boards/${board}/invites`, { tok, body: { email: "z@z.io", role: "viewer" } })).status).toBe(403);
    expect((await call("POST", `/boards/${board}/links`, { tok, body: { role: "viewer" } })).status).toBe(403);
    expect((await call("GET", `/boards/${board}/invites`, { tok })).status).toBe(403);
    expect((await call("GET", `/boards/${board}/links`, { tok })).status).toBe(403);
  }
  expect((await call("POST", `/boards/${board}/invites`, { tok: "fac", body: { email: "z@z.io", role: "viewer" } })).status).toBe(201);   // custom role: allowed
});

test("DW-52.3b a manager's role NAME is not what counts: an editor with a management-less custom role is refused, owner by name at another board too", async () => {
  const sp2 = await mem.createSpace({ tenant: acme.id, name: "Other", generalRole: null, owner: "dev:ada" });
  const plain = await mem.createRole({ tenant: acme.id, name: "Plain", boardRole: "editor", permissions: [] });
  await mem.setScopedGrant({ scope: { type: "space", id: sp2.id }, subject: U("dev:vie"), role: plain.id });
  const b2 = (await mem.createBoard({ tenant: acme.id, title: "Two", space: sp2.id, owner: "dev:ada" })).id;
  expect((await share("vie", b2)).status).toBe(403);                                   // editor content, no members.manage
  expect((await share("own", b2)).status).toBe(403);                                   // owner of the first board only
});

test("DW-52.4 guests: an invite never carries owner (a guest address or a member's), links neither; the resolver caps what a row says", async () => {
  for (const email of ["kim@partner.io", "x@acme.com"]) {
    expect((await call("POST", `/boards/${board}/invites`, { body: { email, role: "owner" } })).status).toBe(400);
    expect((await call("POST", `/boards/${board}/invites`, { body: { email, role: "editor" } })).status).toBe(201);
  }
  expect((await call("POST", `/boards/${board}/links`, { body: { role: "owner" } })).status).toBe(400);
  expect((await call("POST", `/boards/${board}/invites`, { body: { email: "kim@partner.io", role: "bogus" } })).status).toBe(400);
  // A row that somehow says owner (written around the routes) still gives a guest at most editor.
  const row = await mem.createInvite({ board, email: "evil@partner.io", role: "owner", by: "dev:ada" });
  const t = makeTenancy({ registry: mem, now });
  expect(await t.role({ user: "google:evil", name: "e", email: "evil@partner.io", domain: null }, board)).toBe("editor");
  expect(row.role).toBe("owner");
});

test("revoke is idempotent: a second DELETE, an expired one, answer 204; another board's invite and an unknown id are the one 403", async () => {
  const i = (await (await call("POST", `/boards/${board}/invites`, { body: { email: "a@b.io", role: "viewer" } })).json()).invite;
  const l = (await (await call("POST", `/boards/${board}/links`, { body: { role: "viewer" } })).json()).link;
  for (let n = 0; n < 2; n++) {
    expect((await call("DELETE", `/boards/${board}/invites/${i.id}`)).status).toBe(204);
    expect((await call("DELETE", `/boards/${board}/links/${l.id}`)).status).toBe(204);
  }
  const sp = await mem.createSpace({ tenant: acme.id, name: "S3", generalRole: null, owner: "dev:ada" });
  const b2 = (await mem.createBoard({ tenant: acme.id, title: "Two", space: sp.id, owner: "dev:ada" })).id;
  const i2 = (await (await call("POST", `/boards/${b2}/invites`, { body: { email: "q@r.io", role: "viewer" } })).json()).invite;
  expect((await call("DELETE", `/boards/${board}/invites/${i2.id}`)).status).toBe(403);
  expect((await call("DELETE", `/boards/${board}/invites/i-nosuch`)).status).toBe(403);
  expect((await call("DELETE", `/boards/${board}/links/nosuchlink`)).status).toBe(403);
  expect((await call("DELETE", `/boards/${board}/invites/${i.id}`, { tok: "edi" })).status).toBe(403);   // a non-manager cannot even repeat it
  expect((await mem.invite(i2.id)).revoked).toBe(false);
});

test("an invite create retried with its Idempotency-Key is one invite, replayed with the same expiry", async () => {
  const a = await call("POST", `/boards/${board}/invites`, { body: { email: "k@p.io", role: "viewer" }, key: "key-share-0001" });
  clock += 60_000;
  const b = await call("POST", `/boards/${board}/invites`, { body: { email: "k@p.io", role: "viewer" }, key: "key-share-0001" });
  expect(b.headers.get("idempotent-replayed")).toBe("true");
  expect((await b.json()).invite).toEqual((await a.json()).invite);
  expect((await (await share("ada")).json()).invites).toHaveLength(1);
});

test("a link's id never reaches a log line (create, redeem, revoke, read)", async () => {
  const { link } = await (await call("POST", `/boards/${board}/links`, { body: { role: "viewer" } })).json();
  await call("GET", `/boards/${board}/share`); await call("GET", `/links/${link.id}`, { tok: "vie" });
  await call("DELETE", `/boards/${board}/links/${link.id}`);
  expect(logs.filter(l => l.includes(link.id))).toEqual([]);
});

test("DW-52.9 no board-ladder escalation: a viewer-step manager gives at most Viewer by invite, link and grant (self-grant included); a Unit admin and an owner are not capped", async () => {
  const put = (tok, user, role) => call("PUT", `/access/board/${board}/grants/user/${encodeURIComponent(user)}`, { tok, body: { role } });
  // fac holds members.manage with a VIEWER board role (the Facilitator custom role of the fixture)
  const v = await (await share("fac")).json();
  expect(v.limits.inviteRoles).toEqual(["viewer"]); expect(v.limits.linkRoles).toEqual(["viewer"]);
  expect((await call("POST", `/boards/${board}/invites`, { tok: "fac", body: { email: "a@b.io", role: "editor" } })).status).toBe(403);
  expect((await call("POST", `/boards/${board}/invites`, { tok: "fac", body: { email: "a@b.io", role: "viewer" } })).status).toBe(201);
  expect((await call("POST", `/boards/${board}/links`, { tok: "fac", body: { role: "annotator" } })).status).toBe(403);
  expect((await call("POST", `/boards/${board}/links`, { tok: "fac", body: { role: "viewer" } })).status).toBe(201);
  // the grant route: nobody, themselves included, gets more than a Viewer from fac
  expect((await put("fac", "dev:fac", "editor")).status).toBe(403);
  expect((await put("fac", "dev:vie", "editor")).status).toBe(403);
  expect((await put("fac", "dev:vie", "viewer")).status).toBe(200);
  const page = await (await call("GET", `/access/board/${board}`, { tok: "fac" })).json();
  expect(page.roles.filter(r => !r.custom).map(r => r.id)).toEqual(["viewer"]);          // the picker offers only what is allowed
  // an owner is capped at nothing below owner; a Unit admin (a Unit-wide permission, not a role name) is exempt whatever board role it holds
  expect((await call("POST", `/boards/${board}/invites`, { tok: "own", body: { email: "c@d.io", role: "editor" } })).status).toBe(201);
  expect((await call("POST", `/boards/${board}/invites`, { tok: "ada", body: { email: "e@f.io", role: "editor" } })).status).toBe(201);
  expect((await put("ada", "dev:vie", "editor")).status).toBe(200);
  expect((await (await share("ada")).json()).limits.inviteRoles).toContain("editor");
});

test("DW-52.2b expiresAt: a safe integer in the future, at most 10 years ahead, for invites and links (the same on every adapter: refused before one is touched)", async () => {
  const bad = [T0 + 0.5 * DAY + 0.5, 1e300, T0 + 11 * 365 * DAY, "soon", T0, -5, 2 ** 60];
  for (const expiresAt of bad) {
    expect((await call("POST", `/boards/${board}/invites`, { body: { email: "a@b.io", role: "viewer", expiresAt } })).status).toBe(400);
    expect((await call("POST", `/boards/${board}/links`, { body: { role: "viewer", expiresAt } })).status).toBe(400);
  }
  const edge = T0 + 10 * 365 * DAY;
  expect((await call("POST", `/boards/${board}/links`, { body: { role: "viewer", expiresAt: edge } })).status).toBe(201);
  expect((await call("POST", `/boards/${board}/links`, { body: { role: "viewer", expiresAt: edge + 1 } })).status).toBe(400);
});

test("DW-52.8 a guest manager (owner outside the Unit) is not sent the Unit's domains; a Unit member is", async () => {
  expect((await (await share("gst")).json()).unit).toBeNull();
  expect((await (await share("own")).json()).unit).toEqual({ domains: ["acme.com", "acme.org"] });
  await call("POST", `/boards/${board}/invites`, { tok: "gst", body: { email: "kim@partner.io", role: "viewer" } });
  expect((await (await share("gst")).json()).invites[0].guest).toBe(true);               // tagged server-side
});

test("DW-52.2c the same expiry rule on the durable SQLite Registry: refused values never reach it, the edge value round-trips as an exact integer", async () => {
  const { sqliteRegistry } = await import("../../server/registry/sqlite.js");
  const { mkdtempSync, rmSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "plenary-share-exp-"));
  const reg = sqliteRegistry({ path: join(dir, "r.db"), fullfsync: false });
  try {
    const t = await reg.createTenant({ domain: "acme.com", admins: ["dev:ada"] });
    const b = (await mkBoard(reg, { tenant: t.id, title: "B", owner: "dev:ada" })).id;
    const r = httpRoutes({ registry: reg, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy: makeTenancy({ registry: reg, now }), now, config, dev: devAuth({ enabled: true, tokens }), log: { warn() {} } });
    const go = body => r(new Request(`${ORIGIN}/boards/${b}/links`, { method: "POST", headers: { authorization: "Bearer ada", "content-type": "application/json" }, body: JSON.stringify(body) }));
    for (const expiresAt of [1e300, T0 + 0.5, T0 + 11 * 365 * DAY]) expect((await go({ role: "viewer", expiresAt })).status).toBe(400);
    const edge = T0 + 10 * 365 * DAY, made = await go({ role: "viewer", expiresAt: edge });
    expect(made.status).toBe(201);
    expect((await reg.link((await made.json()).link.id)).expiresAt).toBe(edge);
  } finally { await reg.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("DW-52.10 hiddenAbove: a boolean, only when access also comes from a Space or Group the caller cannot open (no names, no counts); computed where the rows are hidden", async () => {
  const page = async (tok, id = board) => (await call("GET", `/access/board/${id}`, { tok })).json();
  // edi holds the board directly and cannot open the Space (general access off, no grant there), which holds an owner grant: some access is out of sight
  const edi = await page("edi");
  expect(edi.hiddenAbove).toBe(true);
  expect(JSON.stringify(edi)).not.toContain("Design");                                   // the hidden Space's name is never sent
  expect(edi.inherited).toEqual([]);
  expect(await page("fac")).not.toHaveProperty("hiddenAbove");                           // fac can open the Space: its rows show instead
  expect(await page("ada")).not.toHaveProperty("hiddenAbove");                           // a Unit admin opens everything
  // a closed Space that holds nothing hides nothing
  const empty = await mem.createSpace({ tenant: acme.id, name: "Empty", generalRole: null });
  const b2 = (await mem.createBoard({ tenant: acme.id, title: "Two", space: empty.id, owner: "dev:own" })).id;
  expect(await page("own", b2)).not.toHaveProperty("hiddenAbove");
  // an open Space (general access) is not hidden from a member who can open it
  const open = await mem.createSpace({ tenant: acme.id, name: "Open", generalRole: "viewer", owner: "dev:ada" });
  const b3 = (await mem.createBoard({ tenant: acme.id, title: "Three", space: open.id, owner: "dev:own" })).id;
  expect(await page("own", b3)).not.toHaveProperty("hiddenAbove");
  // a person who cannot open the board at all gets the ordinary 404, nothing about the Space
  expect((await call("GET", `/access/board/${board}`, { tok: "vie" })).status).toBe(404);
});

test("expiresAt refusals say what is wanted: a whole number of ms in the future, at most 10 years ahead (the AdminError message, for logs and API callers)", async () => {
  const { createLink, AdminError } = await import("../../server/admin/boards.js");
  const ada = { user: "dev:ada", name: "ada", email: "ada@acme.com", domain: "acme.com" };
  for (const expiresAt of [1e300, T0 + 0.5, T0 - 1]) {
    const e = await createLink({ caller: ada, board, role: "viewer", expiresAt }, { registry: mem, tenancy: makeTenancy({ registry: mem, now }), now }).catch(x => x);
    expect(e).toBeInstanceOf(AdminError); expect(e.code).toBe("bad-request");
    expect(e.message).toBe("expiresAt must be a whole number of ms in the future, at most 10 years ahead");
  }
});
