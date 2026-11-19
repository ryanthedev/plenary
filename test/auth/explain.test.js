// Access explanation and requests (server/auth/explain.js, access.js, spaces.js; PROTOCOL.md § Access explanation and requests, #51): the explanation comes from the
// resolver's own Access, so it cannot drift from enforcement; it leaks nothing a caller may not see; Ask for access is idempotent and rate limited.
import { test, expect, beforeEach, describe } from "bun:test";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy as makeTenancy } from "../../server/auth/tenancy.js";
import { accessService } from "../../server/auth/access.js";
import { spaceService } from "../../server/auth/spaces.js";
import { needsOf, mineOf } from "../../server/auth/explain.js";
import { httpRoutes } from "../../server/auth/http.js";
import { sessions as makeSessions } from "../../server/auth/session.js";
import { devAuth } from "../../server/auth/dev.js";
import { ASK } from "../../server/auth/registry-port.js";

const ident = (n, domain = "acme.com") => ({ user: `google:${n}`, name: n, email: `${n}@${domain}`, domain });
const dev = ident("dev"), pat = ident("pat"), tom = ident("tom"), root = ident("root"), kim = ident("kim", "partner.io"), eve = ident("eve");
const U = id => ({ type: "user", id });
const code = p => p.then(() => null, e => e.code ?? e.message);
let r, ten, svc, spaces, clock, acme, eng, platform, secret, infra, board;

beforeEach(async () => {
  clock = { t: Date.UTC(2026, 10, 19) };
  r = memoryRegistry({ now: () => clock.t });
  ten = makeTenancy({ registry: r, now: () => clock.t });
  svc = accessService({ registry: r, tenancy: ten, now: () => clock.t });
  spaces = spaceService({ registry: r, tenancy: ten, now: () => clock.t });
  acme = await r.createTenant({ domain: "acme.com", admins: ["google:root"] });
  for (const p of [dev, pat, tom, root, eve]) await r.touchMember(acme.id, { user: p.user, name: p.name, email: p.email });
  eng = await r.createGroup({ tenant: acme.id, name: "Engineering", generalRole: "commenter", owner: "google:tom" });
  platform = await r.createSpace({ tenant: acme.id, name: "Platform", group: eng.id, generalRole: null, owner: "google:pat" });
  secret = await r.createSpace({ tenant: acme.id, name: "Secret", generalRole: null, owner: "google:pat" });
  infra = await r.createTeam({ tenant: acme.id, name: "Infra" });
  await r.setTeamMember(infra.id, dev.user, true);
  await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: { type: "team", id: infra.id }, role: "viewer" });
  board = await r.createBoard({ tenant: acme.id, title: "Arch", space: platform.id, owner: "google:pat" });
});

describe("mine: the resolver's sources, the strongest marked", () => {
  test("a viewer through a Team and a commenter through the Group: both listed, only the top one marked, names filled", async () => {
    const p = await svc.accessPage(dev, "space", platform.id);
    expect(p.mine.role).toEqual({ id: "commenter", name: "Commenter" });
    expect(p.mine.sources).toEqual([
      { kind: "team", scope: { type: "space", id: platform.id, name: "Platform" }, role: "viewer", roleName: "Viewer", ladder: "viewer", team: { id: infra.id, name: "Infra" }, strongest: false },
      { kind: "general", scope: { type: "group", id: eng.id, name: "Engineering" }, role: "commenter", roleName: "Commenter", ladder: "commenter", strongest: true },
      { kind: "unit", scope: { type: "unit", id: acme.id }, role: "member", roleName: "Member", ladder: null, strongest: false },
    ]);
  });
  test("ties are all marked; nothing is marked without board content (a Unit admin)", async () => {
    await r.setScopedGrant({ scope: { type: "group", id: eng.id }, subject: U(dev.user), role: "commenter" });
    expect((await svc.accessPage(dev, "space", platform.id)).mine.sources.filter(s => s.strongest).length).toBe(2);
    const admin = await svc.accessPage(root, "space", secret.id);
    expect(admin.mine.role).toBeNull();
    expect(admin.mine.sources).toMatchObject([{ kind: "unit", role: "admin", strongest: false }, { kind: "unit", role: "member", strongest: false }]);
    expect(admin.mine.sources.some(s => s.strongest)).toBe(false);
  });
  test("every source kind is reported, and the role equals the room's hello role (one source of truth)", async () => {
    await r.setGrant(board.id, dev.user, "annotator");
    await r.createInvite({ board: board.id, email: dev.email, role: "viewer", by: pat.user });
    const link = await r.createLink({ board: board.id, role: "editor", by: pat.user });
    await r.addLinkUse(link.id, dev.user);
    await r.setScopedGrant({ scope: { type: "board", id: board.id }, subject: { type: "team", id: infra.id }, role: "viewer" });
    const role = await r.createRole({ tenant: acme.id, name: "Reader", boardRole: "commenter", permissions: [] });
    await r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: U(dev.user), role: role.id });
    await r.updateRole(acme.id, "member", { boardRole: "viewer", permissions: ["space.create"] });
    const ex = await svc.boardExplain(dev, board.id);
    expect(new Set(ex.mine.sources.map(s => s.kind))).toEqual(new Set(["direct", "team", "general", "invite", "link", "unit"]));
    expect(ex.mine.role.id).toBe("editor");
    expect(ex.mine.role.id).toBe(await ten.role(dev, board.id));
    expect(ex.mine.sources.filter(s => s.strongest).map(s => s.kind)).toEqual(["link"]);
    for (const who of [dev, pat, tom, eve, root, kim]) {
      const e = await svc.boardExplain(who, board.id).catch(() => null);
      expect(e?.mine.role?.id ?? null).toBe(e ? await ten.role(who, board.id) : null);
    }
  });
  test("needs comes from roleDef: Editor creates boards in a Space and Spaces in a Group, edits a board; none at the Unit", async () => {
    expect(needsOf("space", new Map())).toEqual({ "board.create": { role: "editor", roleName: "Editor" } });
    expect(needsOf("group", new Map())).toEqual({ "space.create": { role: "editor", roleName: "Editor" } });
    expect(needsOf("board", new Map())).toEqual({ "board.edit": { role: "editor", roleName: "Editor" } });
    expect(needsOf("unit", new Map())).toEqual({});
    const p = await svc.accessPage(dev, "space", platform.id);
    expect(p.needs).toEqual({ "board.create": { role: "editor", roleName: "Editor" } });
  });
  test("mineOf with no names leaves them out", () => {
    const m = mineOf({ ladder: "viewer", sources: [{ kind: "general", scope: { type: "space", id: "s" }, role: "viewer", permissions: [], ladder: "viewer" }] }, { roles: new Map() });
    expect(m.sources[0].scope).toEqual({ type: "space", id: "s" });
  });
});

describe("the Space page explains a disabled New board from the same Access as can.createBoard", () => {
  test("a viewer gets why; an editor, an owner and a personal space get none", async () => {
    const v = await spaces.spacePage(dev, platform.id);
    expect(v.can.createBoard).toBe(false);
    expect(v.why.mine.role.id).toBe("commenter");
    expect(v.why.needs["board.create"].role).toBe("editor");
    expect(v.why.owners).toEqual([{ type: "user", id: pat.user, name: "pat" }, { type: "user", id: tom.user, name: "tom" }]);
    expect(v.why.ask).toEqual({ can: true, roles: [{ id: "annotator", name: "Annotator" }, { id: "editor", name: "Editor" }], pending: null, retryAfterMs: null });
    expect((await spaces.spacePage(pat, platform.id)).why).toBeUndefined();
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: U(dev.user), role: "editor" });
    const e = await spaces.spacePage(dev, platform.id);
    expect(e.can.createBoard).toBe(true);
    expect(e.why).toBeUndefined();
    const mine = await r.ensurePersonalSpace(acme.id, dev.user);
    expect((await spaces.spacePage(dev, mine.id)).why).toBeUndefined();
  });
  test("owners are who may grant: a custom role with members.manage counts, a Team is named, an unknown name falls back to the id", async () => {
    const fac = await r.createRole({ tenant: acme.id, name: "Facilitator", boardRole: "viewer", permissions: ["members.manage"] });
    const ops = await r.createTeam({ tenant: acme.id, name: "Ops" });
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: { type: "team", id: ops.id }, role: fac.id });
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: U("google:ghost"), role: "owner" });
    const names = (await spaces.spacePage(dev, platform.id)).why.owners.map(o => o.name);
    expect(names).toEqual(expect.arrayContaining(["Ops", "pat", "tom", "ghost"]));
  });
});

describe("Who has access accounts for every source of access", () => {
  test("Unit admins, a Unit grant with board content and the Unit member role are listed on a Space page; one with no content is not", async () => {
    const reader = await r.createRole({ tenant: acme.id, name: "Reader", boardRole: "viewer", permissions: [] });
    const mgmt = await r.createRole({ tenant: acme.id, name: "Mgmt", boardRole: "viewer", permissions: ["team.manage"] });
    await r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: U(eve.user), role: reader.id });
    await r.updateRole(acme.id, "member", { boardRole: "viewer", permissions: [] });
    const p = await svc.accessPage(pat, "space", platform.id);
    expect(p.organization).toEqual({ admins: [{ user: "google:root", name: "root" }], more: false, memberRole: "viewer" });
    expect(p.inherited.filter(x => x.scope.type === "unit")).toEqual([{ scope: { type: "unit", id: acme.id }, subject: { type: "user", id: eve.user, name: "eve", email: eve.email }, role: reader.id, roleName: "Reader", via: "inherited" }]);
    expect(p.general).toContainEqual({ scope: { type: "unit", id: acme.id }, role: "viewer" });
    expect(mgmt.id).toBeTruthy();
    // eve really has access through the Unit grant only: the page accounts for her
    const sb = await r.createBoard({ tenant: acme.id, title: "S", space: secret.id });
    const ev = await svc.boardExplain(eve, sb.id);
    expect(ev.mine.role.id).toBe("viewer");
    expect(ev.mine.sources.filter(s => s.ladder).map(s => `${s.kind}@${s.scope.type}`)).toEqual(["direct@unit", "unit@unit"]);
    expect((await svc.accessPage(pat, "space", secret.id)).inherited.map(x => x.subject.id)).toContain(eve.user);
  });
  test("the Unit page does not repeat the organization block", async () => {
    expect((await svc.accessPage(root, "unit", acme.id)).organization).toBeUndefined();
  });
});

describe("no leaks", () => {
  const counted = () => {
    const calls = [];
    const reg = new Proxy(r, { get: (t, k) => (typeof t[k] === "function" ? (...a) => { calls.push(String(k)); return t[k](...a); } : t[k]) });
    const s = accessService({ registry: reg, tenancy: makeTenancy({ registry: reg }), now: () => clock.t });
    return { run: async f => { calls.length = 0; const res = await f(s).then(() => "ok", e => e.code ?? e.message); return [res, [...calls].sort().join(",")]; } };
  };
  test("a member who cannot open the Space, another Unit's id and an unknown id: one answer, one cost, on every new read and write", async () => {
    const globex = await r.createTenant({ domain: "globex.com" });
    const fSpace = await r.createSpace({ tenant: globex.id, name: "Theirs", generalRole: "viewer" });
    const fBoard = await r.createBoard({ tenant: globex.id, space: fSpace.id });
    const hidBoard = await r.createBoard({ tenant: acme.id, space: secret.id });
    const { run } = counted();
    const cases = {
      "GET space": [id => s => s.accessPage(eve, "space", id), [secret.id, "s-nope00000000", fSpace.id]],
      "GET board": [id => s => s.accessPage(eve, "board", id), [hidBoard.id, "b-nope000000000000", fBoard.id]],
      "explain board": [id => s => s.boardExplain(eve, id), [hidBoard.id, "b-nope000000000000", fBoard.id]],
      "POST request": [id => s => s.requestAccess(eve, "space", id, "editor"), [secret.id, "s-nope00000000", fSpace.id]],
      "POST request board": [id => s => s.requestAccess(eve, "board", id, "editor"), [hidBoard.id, "b-nope000000000000", fBoard.id]],
      "DELETE request": [id => s => s.dismissRequest(eve, "space", id, "google:dev"), [secret.id, "s-nope00000000", fSpace.id]],
    };
    for (const [name, [mkcall, ids]] of Object.entries(cases)) {
      const out = [];
      for (const id of ids) out.push(await run(mkcall(id)));
      expect([name, out[1]]).toEqual([name, out[0]]);
      expect([name, out[2]]).toEqual([name, out[0]]);
      expect(out[0][0]).not.toBe("ok");
    }
  });
  test("a guest on a linked board sees only their own board-scope sources: no owners, no Ask, no member list, no other Space", async () => {
    const link = await r.createLink({ board: board.id, role: "viewer", by: pat.user });
    await r.addLinkUse(link.id, kim.user);
    const ex = await svc.boardExplain(kim, board.id);
    expect(ex.mine.role.id).toBe("viewer");
    expect(ex.mine.sources).toEqual([{ kind: "link", scope: { type: "board", id: board.id, name: "Arch" }, role: "viewer", roleName: "Viewer", ladder: "viewer", strongest: true }]);
    expect(ex.owners).toEqual([]);
    expect(ex.ask).toEqual({ can: false, roles: [], pending: null, retryAfterMs: null });
    expect(JSON.stringify(ex)).not.toMatch(/Platform|Engineering|Infra|pat|tom/);
    expect(await code(svc.accessPage(kim, "board", board.id))).toBe("forbidden".replace("forbidden", "not-found"));
    expect(await code(svc.requestAccess(kim, "board", board.id, "editor"))).toBe("forbidden");
    expect(await code(svc.boardExplain(kim, "b-nope000000000000"))).toBe("not-found");
  });
  test("an explanation names no Space, Group or Team the caller holds no source through", async () => {
    const hid = await r.createBoard({ tenant: acme.id, title: "H", space: secret.id });
    expect(await code(svc.boardExplain(eve, hid.id))).toBe("not-found");
    const other = await r.createSpace({ tenant: acme.id, name: "Other", generalRole: null, owner: "google:pat" });
    await r.setScopedGrant({ scope: { type: "space", id: other.id }, subject: U(eve.user), role: "viewer" });
    const p = await svc.accessPage(eve, "space", other.id);
    expect(JSON.stringify(p.mine)).not.toMatch(/Engineering|Infra|Secret|Platform/);
    expect(JSON.stringify(p.owners)).not.toMatch(/tom/);
  });
  test("requests (with the requesters' names) go only to a current members.manage holder", async () => {
    await svc.requestAccess(dev, "space", platform.id, "editor");
    expect((await svc.accessPage(dev, "space", platform.id)).requests).toBeUndefined();
    expect((await svc.accessPage(eve, "space", platform.id).catch(() => ({}))).requests).toBeUndefined();
    const seen = await svc.accessPage(pat, "space", platform.id);
    expect(seen.requests).toEqual([{ user: { type: "user", id: dev.user, name: "dev", email: dev.email }, role: "editor", roleName: "Editor", at: clock.t }]);
    expect((await svc.accessPage(root, "space", platform.id)).requests.length).toBe(1);   // a Unit admin manages everywhere
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: U(tom.user), role: "owner" });
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: U(pat.user), role: "editor" });
    expect((await svc.accessPage(pat, "space", platform.id)).requests).toBeUndefined();   // demoted: no longer shown
  });
});

describe("Ask for access", () => {
  test("a viewer asks; it is stored, shown to the owners as pending, and the page of the asker says so", async () => {
    const q = await svc.requestAccess(dev, "space", platform.id, "editor");
    expect(q).toEqual({ role: "editor", roleName: "Editor", at: clock.t, state: "pending" });
    const mine = await svc.accessPage(dev, "space", platform.id);
    expect(mine.ask.pending).toEqual({ role: "editor", roleName: "Editor", at: clock.t });
  });
  test("asking again while pending changes nothing", async () => {
    const a = await svc.requestAccess(dev, "space", platform.id, "editor");
    clock.t += 5000;
    expect(await svc.requestAccess(dev, "space", platform.id, "annotator")).toEqual(a);
    expect((await r.accessRequests({ type: "space", id: platform.id })).length).toBe(1);
  });
  test("works at a Group and a board; the role must be one the page offers", async () => {
    await svc.requestAccess(dev, "group", eng.id, "editor");
    expect((await svc.requestAccess(dev, "board", board.id, "annotator")).state).toBe("pending");
    for (const role of ["owner", "viewer", "admin", "nonsense"]) expect(await code(svc.requestAccess(dev, "space", platform.id, role))).toBe("bad-role");
    expect(await code(svc.requestAccess(dev, "space", platform.id, 5))).toBe("bad-request");
  });
  test("refused: the Unit, a personal space, someone who manages, a guest, a user with no Unit", async () => {
    expect(await code(svc.requestAccess(dev, "unit", acme.id, "editor"))).toBe("forbidden");
    const mine = await r.ensurePersonalSpace(acme.id, pat.user);
    expect(await code(svc.requestAccess(dev, "space", mine.id, "editor"))).toBe("forbidden");
    expect(await code(svc.requestAccess(pat, "space", platform.id, "editor"))).toBe("forbidden");
    expect(await code(svc.requestAccess(root, "space", platform.id, "editor"))).toBe("forbidden");
    expect(await code(svc.requestAccess(kim, "space", platform.id, "editor"))).toBe("forbidden");
    expect(await code(svc.requestAccess({ user: "dev:z", name: "z", email: null, domain: null }, "space", platform.id, "editor"))).toBe("forbidden");
    expect(await r.accessRequests({ type: "space", id: platform.id })).toEqual([]);
  });
  test("dismissing keeps the cooldown: a new ask is rate-limited with the wait, then works", async () => {
    await svc.requestAccess(dev, "space", platform.id, "editor");
    await svc.dismissRequest(pat, "space", platform.id, dev.user);
    await svc.dismissRequest(pat, "space", platform.id, dev.user);   // idempotent
    const err = await svc.requestAccess(dev, "space", platform.id, "editor").catch(e => e);
    expect(err).toMatchObject({ code: "rate-limited", data: { retryAfter: ASK.cooldownMs / 1000 } });
    const p = await svc.accessPage(dev, "space", platform.id);
    expect(p.ask).toMatchObject({ pending: null, retryAfterMs: ASK.cooldownMs });
    expect(p.requests).toBeUndefined();
    clock.t += ASK.cooldownMs;
    expect((await svc.requestAccess(dev, "space", platform.id, "editor")).state).toBe("pending");
  });
  test("only a manager dismisses; a bad user id is a bad request", async () => {
    await svc.requestAccess(dev, "space", platform.id, "editor");
    expect(await code(svc.dismissRequest(dev, "space", platform.id, dev.user))).toBe("forbidden");
    expect(await code(svc.dismissRequest(pat, "space", platform.id, ""))).toBe("bad-request");
    expect((await r.accessRequests({ type: "space", id: platform.id })).length).toBe(1);
  });
  test("granting the role closes the request, on a Space and on a board", async () => {
    await svc.requestAccess(dev, "space", platform.id, "editor");
    await svc.requestAccess(dev, "board", board.id, "editor");
    await svc.setGrant(pat, "space", platform.id, "user", dev.user, "editor");
    expect(await r.accessRequest({ type: "space", id: platform.id }, dev.user)).toBeNull();
    expect(await r.accessRequest({ type: "board", id: board.id }, dev.user)).toMatchObject({ state: "pending" });
    await svc.setGrant(pat, "board", board.id, "user", dev.user, "editor").catch(() => {});
    // the board grant route of the admin layer closes it too
    const { setGrant } = await import("../../server/admin/boards.js");
    await setGrant({ caller: pat, board: board.id, user: dev.user, role: "editor" }, { registry: r });
    expect(await r.accessRequest({ type: "board", id: board.id }, dev.user)).toBeNull();
  });
});

describe("over HTTP", () => {
  let routes;
  const ORIGIN = "https://plenary.test";
  const config = { cookieKey: "k".repeat(32), postLoginUrl: ORIGIN + "/", boardUrl: ORIGIN + "/b/{board}", publicUrl: ORIGIN };
  const call = async (tok, path, method = "GET", body, headers = {}) => {
    const res = await routes(new Request(ORIGIN + path, { method, headers: { authorization: `Bearer ${tok}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  let space;
  beforeEach(async () => {
    const d = devAuth({ enabled: true, tokens: { dev: { name: "dev", domain: "acme.com", email: "dev@acme.com" }, pat: { name: "pat", domain: "acme.com", email: "pat@acme.com" }, kim: { name: "kim", email: "kim@partner.io" } } });
    for (const u of ["dev", "pat"]) await r.touchMember(acme.id, { user: `dev:${u}`, name: u, email: `${u}@acme.com` });
    space = await r.createSpace({ tenant: acme.id, name: "Docs", generalRole: "viewer", owner: "dev:pat" });
    routes = httpRoutes({ registry: r, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy: ten, config, dev: d, now: () => clock.t });
  });
  test("POST requests: 201, replay with the same key, a changed body is 422, a retry after the limit still replays, GET shows it to the owner only", async () => {
    const k = { "idempotency-key": "ask-key-0001" };
    const a = await call("dev", `/access/space/${space.id}/requests`, "POST", { role: "editor" }, k);
    expect(a).toMatchObject({ status: 201, body: { request: { role: "editor", state: "pending" } } });
    await call("pat", `/access/space/${space.id}/requests/${encodeURIComponent("dev:dev")}`, "DELETE");   // dismissed: the next fresh ask is limited
    const again = await call("dev", `/access/space/${space.id}/requests`, "POST", { role: "editor" }, k);
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect((await call("dev", `/access/space/${space.id}/requests`, "POST", { role: "annotator" }, k)).status).toBe(422);
    const limited = await call("dev", `/access/space/${space.id}/requests`, "POST", { role: "editor" }, { "idempotency-key": "ask-key-0002" });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: "rate-limited", retryAfter: ASK.cooldownMs / 1000 });
    expect(limited.headers.get("retry-after")).toBe(String(ASK.cooldownMs / 1000));
    expect((await call("kim", `/access/space/${space.id}/requests`, "POST", { role: "editor" })).status).toBe(403);
    expect((await call("dev", `/access/space/${space.id}/requests`, "POST", { role: "editor", note: "x" })).body).toEqual({ error: "unknown-field", field: "note" });
  });
  test("GET /boards/:board/explain: a member, a guest by link, and no one else; GET /spaces/:id carries why for a viewer", async () => {
    const b = await r.createBoard({ tenant: acme.id, title: "B", space: space.id });
    const link = await r.createLink({ board: b.id, role: "viewer", by: "dev:pat" });
    await r.addLinkUse(link.id, "dev:kim");
    const m = await call("dev", `/boards/${b.id}/explain`);
    expect(m.status).toBe(200);
    expect(m.body.mine.role.id).toBe("viewer");
    expect(m.body.owners).toEqual([{ type: "user", id: "dev:pat", name: "pat" }]);
    const g = await call("kim", `/boards/${b.id}/explain`);
    expect(g.body.mine.sources.map(s => s.kind)).toEqual(["link"]);
    expect(g.body.owners).toEqual([]);
    expect((await call("kim", `/boards/b-nope000000000000/explain`)).status).toBe(404);
    expect((await call("dev", `/spaces/${space.id}`)).body.why.ask.can).toBe(true);
    expect((await call("pat", `/spaces/${space.id}`)).body.why).toBeUndefined();
  });
});
