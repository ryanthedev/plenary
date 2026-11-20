// Tiered admin levels (#88; PROTOCOL.md § Admin levels): board content is a permission tier, never part of the Unit admin role.
//   content.shared   open every board in every shared Space (board owner there)
//   content.personal open other people's personal spaces (open, move out, trash, hand over, as their owner would)
// Built-in Unit roles `content-admin` (shared) and `content-admin-personal` (both); a custom role may carry either. Nothing is ever read from a role NAME.
// Three layers: the pure resolver, the services (no escalation, roles screen, Team path, cache), and the HTTP routes end to end (open, Home, search, trash, move, offboarding, explain).
import { test, expect, beforeEach, describe } from "bun:test";
import { resolveAccess } from "../../server/auth/resolver.js";
import { roleDef, roleProblem, tierReach, TIER_ROLES, TIER_PERMS, ROLE_PERMS } from "../../server/auth/permissions.js";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy as makeTenancy, roleCache } from "../../server/auth/tenancy.js";
import { rolesService } from "../../server/auth/roles.js";
import { accessService } from "../../server/auth/access.js";
import { httpRoutes } from "../../server/auth/http.js";
import { homeService } from "../../server/auth/home.js";
import { sessions as makeSessions } from "../../server/auth/session.js";
import { devAuth } from "../../server/auth/dev.js";
import { bootstrapTenant } from "../../server/admin/tenants.js";

const T = 1000;
const tenant = { id: "t-acme", domain: "acme.com", domains: ["acme.com"], kind: "company", admins: ["google:root"], createdAt: 0 };
const shared = { id: "s-1", tenant: "t-acme", group: null, name: "Design", kind: "shared", owner: null, generalRole: null, createdAt: 0 };
const personal = { id: "s-p", tenant: "t-acme", group: null, name: "ada's space", kind: "personal", owner: "google:ada", generalRole: null, createdAt: 0 };
const board = space => ({ id: "b-" + space.id, tenant: "t-acme", title: "", memberRole: null, space: space.id, createdAt: 0 });
const ctx = (space, target = "board", grants = []) => ({ tenant, board: target === "board" ? board(space) : null, space: target === "unit" ? null : space, group: null,
  scoped: { unit: grants, group: [], space: [], board: [] }, roles: [{ id: "r-pers", name: "P", boardRole: "viewer", permissions: ["content.personal"] }, { id: "r-shr", name: "S", boardRole: "viewer", permissions: ["content.shared"] }], teams: {} });
const admin = { user: "google:root", domain: "acme.com" };
const grant = role => [{ subject: { type: "user", id: "google:root" }, role }];
const as = (space, role, target = "board") => resolveAccess({ ctx: ctx(space, target, role ? grant(role) : []) }, admin, T);

describe("resolver: the tier decides, the admin role carries no content", () => {
  test("DW manage-only admin: no board content anywhere, shared management kept, personal spaces nothing at all", () => {
    const sh = as(shared);
    expect(sh.ladder).toBe(null);
    expect([...sh.permissions].sort()).toEqual(["delete", "members.manage", "move", "transfer"]);
    const pe = as(personal);
    expect([pe.ladder, [...pe.permissions]]).toEqual([null, []]);
    expect(as(shared, null, "unit").ladder).toBe(null);
  });
  test("content.shared: owner of every shared board and the Space/Unit root, nothing of a personal space; the source names its permission", () => {
    const sh = as(shared, "content-admin");
    expect(sh.ladder).toBe("owner");
    expect(sh.sources.find(s => s.role === "content-admin")).toMatchObject({ content: "content.shared", ladder: "owner" });
    expect(sh.sources.find(s => s.role === "admin").content).toBeUndefined();
    expect(as(shared, "content-admin", "space").ladder).toBe("owner");
    expect(as(shared, "content-admin", "unit").permissions.has("content.shared")).toBe(true);
    const pe = as(personal, "content-admin");
    expect([pe.ladder, [...pe.permissions], pe.sources.some(s => s.content)]).toEqual([null, [], false]);
  });
  test("content.personal: owner of other people's personal spaces and boards, with the owner's management there (move out, trash, hand over)", () => {
    const pe = as(personal, "content-admin-personal");
    expect(pe.ladder).toBe("owner");
    for (const p of ["board.view", "board.edit", "move", "delete", "transfer", "members.manage"]) expect(pe.permissions.has(p)).toBe(true);
    expect(pe.sources.find(s => s.role === "content-admin-personal")).toMatchObject({ content: "content.personal" });
    expect(as(personal, "content-admin-personal", "space").permissions.has("board.create")).toBe(true);   // hand-over needs the owner role grantable on the Space
    expect(as(personal, "content-admin-personal", "space").ladder).toBe("owner");
    expect(as(shared, "content-admin-personal").ladder).toBe("owner");   // the role carries both
  });
  test("a custom role carrying content.personal alone reaches personal spaces only; its own board step still applies on shared ones", () => {
    const pe = as(personal, "r-pers"), sh = as(shared, "r-pers");
    expect(pe.ladder).toBe("owner");
    expect(sh.ladder).toBe("viewer");                                   // its boardRole, not the owner step: shared content was not granted
    expect(sh.permissions.has("members.manage")).toBe(true);            // the admin's own management on a shared board, unchanged
    expect(as(shared, "r-shr").ladder).toBe("owner");
    expect(as(personal, "r-shr").ladder).toBe(null);                    // content.shared reaches no personal space; its boardRole is a Unit-scope step, dead there
  });
  test("a content holder who is not a Unit admin gets content but no management at the Unit root or on shared Spaces", () => {
    const who = { user: "google:cy", domain: "acme.com" };
    const rows = { ctx: { ...ctx(shared, "space"), scoped: { unit: [{ subject: { type: "user", id: "google:cy" }, role: "content-admin-personal" }], group: [], space: [], board: [] } } };
    const a = resolveAccess(rows, who, T);
    expect(a.ladder).toBe("owner");
    for (const p of ["members.manage", "move", "delete", "transfer", "roles.manage", "team.manage"]) expect(a.permissions.has(p)).toBe(false);
  });
  test("tier roles are Unit-scope only; the member role cannot carry the tier; a stored one is not read", () => {
    for (const role of Object.keys(TIER_ROLES)) { expect(roleDef(role, "space")).toBe(null); expect(roleDef(role, "board")).toBe(null); expect(roleDef(role, "unit").ladder).toBe(null); }
    expect(roleProblem({ boardRole: null, permissions: ["content.shared"] }, { member: true })).toMatch(/management permissions/);
    expect(roleProblem({ boardRole: "viewer", permissions: ["content.shared", "content.personal"] })).toBe(null);
    const roles = new Map([["member", { id: "member", permissions: ["content.shared", "space.create"], boardRole: null }]]);
    expect([...roleDef("member", "unit", roles).permissions]).toEqual(["space.create"]);
    expect(roleDef("r-x", "space", new Map([["r-x", { id: "r-x", permissions: [...TIER_PERMS], boardRole: "viewer" }]])).permissions.has("content.shared")).toBe(false);   // clipped below the Unit
    expect(ROLE_PERMS).toEqual(expect.arrayContaining(TIER_PERMS));
    expect(tierReach(new Set(["content.shared"]), true)).toBe(null);
  });
  test("a person the Unit removed loses the tier with every other Unit source (fail closed)", () => {
    const rows = { ctx: { ...ctx(shared), scoped: { unit: grant("content-admin"), group: [], space: [], board: [] }, removed: ["google:root"] } };
    expect(resolveAccess(rows, admin, T).ladder).toBe(null);
  });
});

// ---------- services and routes over the memory Registry ----------
const ORIGIN = "https://plenary.test";
const ident = n => ({ user: `dev:${n}`, name: n, email: `${n}@acme.com`, domain: "acme.com" });
const NAMES = ["root", "low", "chiefS", "chiefP", "keeper", "ada", "bo"];
let r, acme, ten, api, adaSp, diary, designSp, roadmap, ann;
const code = p => p.then(() => null, e => e.code ?? e.message);
const hold = (user, role) => r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: { type: "user", id: "dev:" + user }, role });

beforeEach(async () => {
  r = memoryRegistry(); ann = [];
  acme = await r.createTenant({ domain: "acme.com", admins: ["dev:root", "dev:low", "dev:chiefS", "dev:chiefP"] });
  for (const n of NAMES) await r.touchMember(acme.id, { user: "dev:" + n, name: n, email: `${n}@acme.com` });
  await hold("chiefS", "content-admin"); await hold("chiefP", "content-admin-personal");
  adaSp = await r.ensurePersonalSpace(acme.id, "dev:ada");
  diary = await r.createBoard({ tenant: acme.id, title: "Diary", space: adaSp.id, owner: "dev:ada", memberRole: null });
  designSp = await r.createSpace({ tenant: acme.id, name: "Design", generalRole: null, owner: "dev:ada" });
  roadmap = await r.createBoard({ tenant: acme.id, title: "Roadmap", space: designSp.id, owner: "dev:ada", memberRole: null });
  ten = makeTenancy({ registry: r });
  const dev = devAuth({ enabled: true, tokens: Object.fromEntries(NAMES.map(n => [n, { name: n, domain: "acme.com", email: `${n}@acme.com` }])) });
  const t = makeTenancy({ registry: r });
  const routes = httpRoutes({ registry: r, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy: t, home: homeService({ registry: r, tenancy: t }),
    config: { cookieKey: "k".repeat(32), postLoginUrl: ORIGIN + "/", boardUrl: ORIGIN + "/b/{board}", publicUrl: ORIGIN }, dev });
  let n = 0;
  api = async (tok, path, method = "GET", body) => {
    const res = await routes(new Request(ORIGIN + path, { method, headers: { authorization: `Bearer ${tok}`, "idempotency-key": `tk-${++n}-${crypto.randomUUID()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }));
    return { status: res.status, json: res.headers.get("content-type")?.includes("json") ? JSON.parse(await res.clone().text()) : null };
  };
});

describe("routes: open a board (the explanation names the permission), by tier", () => {
  for (const [who, sharedOpen, personalOpen] of [["low", false, false], ["chiefS", true, false], ["chiefP", true, true]]) {
    test(`${who}: shared board ${sharedOpen ? "opens" : "does not"}, personal board ${personalOpen ? "opens" : "does not"}`, async () => {
      expect(!!(await ten.role(ident(who), roadmap.id))).toBe(sharedOpen);
      expect(!!(await ten.role(ident(who), diary.id))).toBe(personalOpen);
      const sh = await api(who, `/boards/${roadmap.id}/explain`), pe = await api(who, `/boards/${diary.id}/explain`);
      expect([sh.status === 200 && sh.json.mine.role != null, pe.status === 200 && pe.json.mine.role != null]).toEqual([sharedOpen, personalOpen]);
      if (sharedOpen) expect(sh.json.mine.sources.find(s => s.content)).toMatchObject({ content: "content.shared", roleName: expect.stringContaining("content admin") });
      if (personalOpen) expect(pe.json.mine.sources.find(s => s.content)).toMatchObject({ content: "content.personal" });
      if (!personalOpen) expect(JSON.stringify(pe.json ?? "")).not.toContain("Diary");
    });
  }
  test("a custom role with content.personal alone opens personal spaces, not shared ones", async () => {
    const role = await r.createRole({ tenant: acme.id, name: "Auditor", boardRole: "viewer", permissions: ["content.personal"] });
    await hold("keeper", role.id);
    expect(await ten.role(ident("keeper"), diary.id)).toBe("owner");
    expect(await ten.role(ident("keeper"), roadmap.id)).toBe("viewer");   // shared boards: only the role's own board step (viewer), not the owner step content.shared gives
  });
});

describe("routes: Home tree, search, trash, move, offboarding by tier", () => {
  const names = async who => (await api(who, "/home")).json.tree.spaces.map(s => s.name).sort();
  test("Home's tree: manage-only sees no one else's spaces; content.shared sees shared Spaces only; content.personal sees both", async () => {
    expect(await names("low")).toEqual(["low's space"]);
    expect(await names("chiefS")).toEqual(["Design", "chiefS's space"]);
    expect(await names("chiefP")).toEqual(expect.arrayContaining(["Design", "ada's space", "chiefP's space", "chiefS's space", "low's space"]));
    expect(await names("chiefS")).not.toContain("ada's space");
    expect(await names("low")).not.toContain("Design");
    await hold("keeper", (await r.createRole({ tenant: acme.id, name: "Auditor", boardRole: "viewer", permissions: ["content.personal"] })).id);
    expect(await names("keeper")).toEqual(expect.arrayContaining(["ada's space", "keeper's space", "Design"]));   // content.personal: every personal space; Design only through the role's viewer step
  });
  test("search finds a board exactly where the tier lets the caller open it", async () => {
    const hits = async who => (await api(who, "/home/search?q=Diary")).json.results.map(c => c.id);
    expect(await hits("low")).toEqual([]); expect(await hits("chiefS")).toEqual([]); expect(await hits("chiefP")).toEqual([diary.id]);
    const rd = async who => (await api(who, "/home/search?q=Roadmap")).json.results.map(c => c.id);
    expect(await rd("low")).toEqual([]); expect(await rd("chiefS")).toEqual([roadmap.id]);
  });
  test("trash: personal board needs content.personal; a shared board needs only `delete` (a manage-only admin may), and Trash lists follow", async () => {
    expect((await api("low", `/boards/${diary.id}/trash`, "POST", { from: adaSp.id })).status).toBe(403);
    expect((await api("chiefS", `/boards/${diary.id}/trash`, "POST", { from: adaSp.id })).status).toBe(403);
    expect((await api("chiefP", `/boards/${diary.id}/trash`, "POST", { from: adaSp.id })).status).toBe(200);
    expect((await api("chiefP", `/boards/${diary.id}/restore`, "POST", {})).status).toBe(200);
    expect((await api("low", `/boards/${roadmap.id}/trash`, "POST", { from: designSp.id })).status).toBe(200);
  });
  test("move out of a personal space (#53 comment): content.personal only; a shared Space's board moves by `move` alone", async () => {
    const dst = await r.createSpace({ tenant: acme.id, name: "Dest", generalRole: null, owner: "dev:root" });
    for (const who of ["low", "chiefS"]) expect((await api(who, `/boards/${diary.id}/move`, "POST", { from: adaSp.id, to: dst.id })).status).toBe(403);
    expect((await r.board(diary.id)).space).toBe(adaSp.id);
    expect((await api("chiefP", `/boards/${diary.id}/move`, "POST", { from: adaSp.id, to: dst.id })).status).toBe(200);
    expect((await api("low", `/boards/${roadmap.id}/move`, "POST", { from: designSp.id, to: dst.id })).status).toBe(200);
  });
  test("offboarding: handing over a personal space needs content.personal; content.shared alone is manage-only for it", async () => {
    const item = async who => (await api(who, `/members/${encodeURIComponent("dev:ada")}/offboarding`)).json?.items?.find(i => i.personal);
    expect((await item("low")).can.handover).toBe(false);
    expect((await item("chiefS")).can.handover).toBe(false);
    expect((await item("chiefP")).can.handover).toBe(true);
    expect((await api("chiefS", `/members/${encodeURIComponent("dev:ada")}/remove`, "POST", { to: "dev:bo" })).status).toBe(403);
  });
});

describe("no escalation: the tier is passed on only by a holder", () => {
  const mkRoles = () => rolesService({ registry: r, tenancy: makeTenancy({ registry: r }), announce: (unit, scope, o) => ann.push({ scope: `${scope.type}:${scope.id}`, revoke: !!o?.revoke }) });
  const mkAccess = () => accessService({ registry: r, tenancy: makeTenancy({ registry: r }), announce: () => {} });
  test("roles: an admin without the tier cannot create or edit a role carrying it, cannot tick it; a holder can, only what they hold", async () => {
    const svc = mkRoles();
    const low = ident("low"), s = ident("chiefS"), p = ident("chiefP");
    expect((await svc.list(low)).matrix.tickable).not.toEqual(expect.arrayContaining(TIER_PERMS));
    expect(await code(svc.create(low, { name: "Spy", boardRole: "viewer", permissions: ["content.shared"] }))).toBe("forbidden");
    expect((await svc.list(low)).roles.map(x => x.id)).toEqual(expect.arrayContaining(["content-admin", "content-admin-personal"]));
    expect((await svc.list(low)).matrix.permissions.filter(x => x.group === "content-tier").map(x => x.id)).toEqual(TIER_PERMS);
    expect(await code(svc.create(s, { name: "Both", boardRole: "viewer", permissions: ["content.shared", "content.personal"] }))).toBe("forbidden");   // holds shared only
    const ok = await svc.create(s, { name: "Shared only", boardRole: "viewer", permissions: ["content.shared"] });
    expect(ok.permissions).toEqual(["content.shared"]);
    expect(await code(svc.update(low, ok.id, { permissions: [] }))).toBe("forbidden");           // an admin cannot even edit a role they could not hold
    expect(await code(svc.update(s, ok.id, { permissions: ["content.shared", "content.personal"] }))).toBe("forbidden");
    expect((await svc.create(p, { name: "Both", boardRole: "viewer", permissions: ["content.shared", "content.personal"] })).permissions.length).toBe(2);
    expect(await code(svc.update(low, "member", { permissions: ["content.shared"] }))).toBe("bad-request");   // the member role never carries it
  });
  test("grants: only a holder gives content-admin (shared) or content-admin-personal (needs content.personal); a manage-only admin cannot change or clear one either", async () => {
    const a = mkAccess();
    const give = (who, to, role) => code(a.setGrant(ident(who), "unit", acme.id, "user", "dev:" + to, role));
    expect(await give("low", "bo", "content-admin")).toBe("forbidden");
    expect(await give("root", "bo", "content-admin-personal")).toBe("forbidden");
    expect(await give("chiefS", "bo", "content-admin-personal")).toBe("forbidden");
    expect(await give("chiefS", "bo", "content-admin")).toBe(null);
    expect(await give("low", "bo", null)).toBe("forbidden");                                       // clearing is touching: not theirs
    expect(await give("chiefP", "bo", "content-admin-personal")).toBe(null);
    expect(await give("chiefP", "bo", null)).toBe(null);
    const picks = (await a.accessPage(ident("low"), "unit", acme.id)).roles.map(x => x.id);
    expect(picks).not.toContain("content-admin");
    expect((await a.accessPage(ident("chiefS"), "unit", acme.id)).roles.map(x => x.id)).toEqual(expect.arrayContaining(["content-admin"]));
    expect(await code(a.setGrant(ident("chiefP"), "space", designSp.id, "user", "dev:bo", "content-admin"))).toBe("bad-role");   // Unit scope only
  });
  test("Teams: a manage-only admin cannot add anyone to a Team holding a content role; a holder can", async () => {
    const a = mkAccess();
    const team = await r.createTeam({ tenant: acme.id, name: "Auditors" });
    await r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: { type: "team", id: team.id }, role: "content-admin-personal" });
    expect(await code(a.setMember(ident("low"), team.id, "dev:low", true))).toBe("forbidden");
    expect(await code(a.setMember(ident("chiefS"), team.id, "dev:bo", true))).toBe("forbidden");   // holds shared only
    expect(await code(a.setMember(ident("chiefP"), team.id, "dev:bo", true))).toBe(null);
    expect(await ten.role(ident("bo"), diary.id)).toBe("owner");                                    // the Team's tier reaches the member
    expect(await code(a.setMember(ident("low"), team.id, "dev:bo", false))).toBe(null);              // removing never widens: an admin always may
    expect(await ten.role(ident("bo"), diary.id)).toBe(null);
  });
});

describe("role edits and the cache", () => {
  test("a role gaining or losing a content permission announces the Unit (losing as a revocation), and roleCache serves the new answer after invalidation", async () => {
    const svc = rolesService({ registry: r, tenancy: makeTenancy({ registry: r }), announce: (unit, scope, o) => ann.push({ scope: `${scope.type}:${scope.id}`, revoke: !!o?.revoke }) });
    const role = await svc.create(ident("chiefP"), { name: "Auditor", boardRole: "viewer", permissions: [] });
    await hold("keeper", role.id);
    const cache = roleCache({ registry: r });
    expect(await ten.role(ident("keeper"), diary.id)).toBe(null);
    await svc.update(ident("chiefP"), role.id, { permissions: ["content.personal"] });
    expect(ann.at(-1)).toEqual({ scope: `unit:${acme.id}`, revoke: false });                     // a widening
    expect(await cache.role(ident("keeper"), diary.id)).toBe("owner");                             // read fresh, now cached
    await svc.update(ident("chiefP"), role.id, { permissions: [] });
    expect(ann.at(-1)).toEqual({ scope: `unit:${acme.id}`, revoke: true });                      // a loss
    expect(await cache.role(ident("keeper"), diary.id)).toBe("owner");                             // warm: served until the announcement lands
    cache.invalidate(diary.id);                                                                    // what the gateway does on the `grants` message
    expect(await cache.role(ident("keeper"), diary.id)).toBe(null);
  });
});

describe("operator bootstrap is the one way the first holder appears", () => {
  test("bootstrapTenant grants the built-in roles, additively; an email name is refused", async () => {
    const reg = memoryRegistry();
    const out = await bootstrapTenant({ registry: reg, domain: "globex.com", admins: ["dev:g"], contentAdmins: ["dev:g"], contentAdminsPersonal: ["dev:h"] });
    const unit = { type: "unit", id: out.tenant.id };
    expect([await reg.scopedGrant(unit, { type: "user", id: "dev:g" }), await reg.scopedGrant(unit, { type: "user", id: "dev:h" })]).toEqual(["content-admin", "content-admin-personal"]);
    await bootstrapTenant({ registry: reg, domain: "globex.com", contentAdminsPersonal: ["dev:g"] });      // raised, never lowered
    await bootstrapTenant({ registry: reg, domain: "globex.com", contentAdmins: ["dev:g", "dev:h"] });
    expect([await reg.scopedGrant(unit, { type: "user", id: "dev:g" }), await reg.scopedGrant(unit, { type: "user", id: "dev:h" })]).toEqual(["content-admin-personal", "content-admin-personal"]);
    expect(await code(bootstrapTenant({ registry: reg, domain: "globex.com", contentAdmins: ["a@globex.com"] }))).toBe("bad-request");
  });
});
