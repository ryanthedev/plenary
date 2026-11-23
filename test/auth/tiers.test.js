// Tiered admin levels (#88; PROTOCOL.md § Admin levels): board content is a permission tier, never part of the Unit admin role.
//   content.shared   open every board in every shared Space (board owner there)
//   content.personal open other people's personal spaces (open, move out, trash, hand over, as their owner would)
// Built-in Unit roles `content-admin` (shared) and `content-admin-personal` (both); a custom role may carry either. Nothing is ever read from a role NAME.
// Three layers: the pure resolver, the services (no escalation, roles screen, Team path, cache), and the HTTP routes end to end (open, Home, search, trash, move, offboarding, explain).
import { test, expect, beforeEach, describe } from "bun:test";
import { resolveAccess, holdsTier, ownLadder } from "../../server/core/auth/resolver.js";
import { roleDef, roleProblem, tierReach, TIER_ROLES, TIER_PERMS, ROLE_PERMS } from "../../server/core/auth/permissions.js";
import { memoryRegistry } from "../../server/adapters/driven/auth/registry.js";
import { tenancy as makeTenancy, roleCache } from "../../server/core/auth/tenancy.js";
import { rolesService } from "../../server/core/auth/roles.js";
import { accessService } from "../../server/core/auth/access.js";
import { httpRoutes } from "../../server/adapters/driving/auth-http.js";
import { homeService } from "../../server/core/auth/home.js";
import { sessions as makeSessions } from "../../server/adapters/driven/auth/session.js";
import { devAuth } from "../../server/adapters/driven/auth/dev.js";
import { bootstrapTenant } from "../../server/core/admin/tenants.js";

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
    for (const p of ["board.view", "board.edit", "move", "delete"]) expect(pe.permissions.has(p)).toBe(true);
    for (const p of ["members.manage", "transfer", "board.create"]) expect(pe.permissions.has(p)).toBe(false);          // open and act as owner for move-out/trash/handover only; never share or create (#88 M2)
    expect(holdsTier(pe)).toBe(true);
    expect(ownLadder(pe)).toBe(null);                                                                                   // the tier's owner step never counts toward what the holder may hand out
    expect(pe.sources.find(s => s.role === "content-admin-personal")).toMatchObject({ content: "content.personal" });
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
const NAMES = ["root", "low", "chiefS", "chiefP", "keeper", "ada", "bo", "cy"];
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
  test("move out of a personal space (#53 comment): content.personal only; a shared board moves only for someone who would not gain a role (the tier's owner step)", async () => {
    const dst = await r.createSpace({ tenant: acme.id, name: "Dest", generalRole: null, owner: "dev:ada" });   // owned by the board's own owner, no general access: nobody gains
    for (const who of ["low", "chiefS"]) expect((await api(who, `/boards/${diary.id}/move`, "POST", { from: adaSp.id, to: dst.id })).status).toBe(403);
    expect((await r.board(diary.id)).space).toBe(adaSp.id);
    expect((await api("chiefP", `/boards/${diary.id}/move`, "POST", { from: adaSp.id, to: dst.id })).status).toBe(200);
    // a manage-only admin opens no Space, so they move nothing (rule 2); a content.shared holder moves a shared board between Spaces with the same people (and back)
    expect((await api("low", `/boards/${roadmap.id}/move`, "POST", { from: designSp.id, to: dst.id })).status).toBe(403);
    expect((await api("chiefS", `/boards/${roadmap.id}/move`, "POST", { from: designSp.id, to: dst.id })).status).toBe(200);
    expect((await api("chiefS", `/boards/${roadmap.id}/move`, "POST", { from: dst.id, to: designSp.id })).status).toBe(200);
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
  test("grants: only a holder gives content-admin (shared) or content-admin-personal (needs content.personal); a manage-only admin may clear or lower one, never raise it", async () => {
    const a = mkAccess();
    const give = (who, to, role) => code(a.setGrant(ident(who), "unit", acme.id, "user", "dev:" + to, role));
    expect(await give("low", "bo", "content-admin")).toBe("forbidden");
    expect(await give("root", "bo", "content-admin-personal")).toBe("forbidden");
    expect(await give("chiefS", "bo", "content-admin-personal")).toBe("forbidden");
    expect(await give("chiefS", "bo", "content-admin")).toBe(null);
    expect(await give("low", "bo", null)).toBe(null);                                              // removing never widens: any manager may clear a tier grant (decision a)
    expect(await give("chiefS", "bo", "content-admin")).toBe(null);
    expect(await give("low", "bo", "content-admin-personal")).toBe("forbidden");                    // but never widen it
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
    // LOW-2: a user who already holds another Unit role is not silently skipped: they are reported (the CLI exits 1)
    const role = await reg.createRole({ tenant: out.tenant.id, name: "Other", boardRole: "viewer", permissions: [] });
    await reg.setScopedGrant({ scope: unit, subject: { type: "user", id: "dev:k" }, role: role.id });
    const again = await bootstrapTenant({ registry: reg, domain: "globex.com", contentAdmins: ["dev:k"] });
    expect([again.content, again.skipped]).toEqual([[], [{ user: "dev:k", role: role.id }]]);
    expect(await reg.scopedGrant(unit, { type: "user", id: "dev:k" })).toBe(role.id);
  });
});

// ---------- H1 / M2 (review of #88): every ladder exemption is the tier, never "is a Unit admin" ----------
describe("a manage-only Unit admin is held to their own board role (E1-E5); the matching tier holder is exempt", () => {
  const UID = () => acme.id;
  const SELF = "dev:low";
  let lowSp;
  beforeEach(async () => { lowSp = await r.ensurePersonalSpace(acme.id, SELF); });
  test("E1: PUT /access/board/:b/grants/user/<self> owner (and a viewer, and to a third party) is refused; a content.shared holder may", async () => {
    for (const [role, who] of [["owner", SELF], ["viewer", SELF], ["viewer", "dev:bo"]])
      expect((await api("low", `/access/board/${roadmap.id}/grants/user/${who}`, "PUT", { role })).status).toBe(403);
    expect(await r.grant(roadmap.id, SELF)).toBe(null);
    expect((await api("low", `/boards/${roadmap.id}/grants/${SELF}`, "PUT", { role: "owner" })).status).toBe(403);   // the legacy route too
    expect((await api("chiefS", `/access/board/${roadmap.id}/grants/user/dev:chiefS`, "PUT", { role: "owner" })).status).toBe(200);
    expect(await r.grant(roadmap.id, "dev:chiefS")).toBe("owner");
  });
  test("E2: a custom role (it always carries a board role) granted to oneself at the Unit is refused; a holder may", async () => {
    const role = await r.createRole({ tenant: acme.id, name: "Peeker", boardRole: "viewer", permissions: [] });
    expect((await api("low", `/access/unit/${UID()}/grants/user/${SELF}`, "PUT", { role: role.id })).status).toBe(403);
    expect(await r.scopedGrant({ type: "unit", id: UID() }, { type: "user", id: SELF })).toBe(null);
    expect((await api("chiefS", `/access/unit/${UID()}/grants/user/dev:bo`, "PUT", { role: role.id })).status).toBe(200);
  });
  test("E3: moving a shared board into one's own personal space (or an open Space) is refused, tier or not: the tier's owner step never counts toward a gain", async () => {
    expect((await api("low", `/boards/${roadmap.id}/move`, "POST", { from: designSp.id, to: lowSp.id })).status).toBe(403);
    expect((await r.board(roadmap.id)).space).toBe(designSp.id);
    expect((await api("chiefS", `/boards/${roadmap.id}/move`, "POST", { from: designSp.id, to: (await r.ensurePersonalSpace(acme.id, "dev:chiefS")).id })).status).toBe(403);
    const open = await r.createSpace({ tenant: acme.id, name: "Open", generalRole: "editor", owner: "dev:ada" });
    for (const who of ["low", "chiefS", "chiefP"]) expect((await api(who, `/boards/${roadmap.id}/move`, "POST", { from: designSp.id, to: open.id })).status).toBe(403);
    expect((await r.board(roadmap.id)).space).toBe(designSp.id);
  });
  test("E4: PATCH /spaces/:s general access widened is refused (narrowing and renaming are not); a holder may widen", async () => {
    expect((await api("low", `/spaces/${designSp.id}`, "PATCH", { general: "editor" })).status).toBe(403);
    expect((await r.space(designSp.id)).generalRole).toBe(null);
    expect((await api("low", `/spaces/${designSp.id}`, "PATCH", { name: "Design 2" })).status).toBe(200);
    expect((await api("chiefS", `/spaces/${designSp.id}`, "PATCH", { general: "editor" })).status).toBe(200);
    expect((await api("low", `/spaces/${designSp.id}`, "PATCH", { general: null })).status).toBe(200);              // narrowing never needs a role
  });
  test("E5: a link or an invite on a shared board is refused (the share list offers no role); a holder may, up to any role", async () => {
    expect((await api("low", `/boards/${roadmap.id}/links`, "POST", { role: "viewer", expiresAt: null })).status).toBe(403);
    expect((await api("low", `/boards/${roadmap.id}/invites`, "POST", { email: "x@acme.com", role: "viewer", expiresAt: null })).status).toBe(403);
    const share = await api("low", `/boards/${roadmap.id}/share`);
    expect([share.json.limits.inviteRoles, share.json.limits.linkRoles]).toEqual([[], []]);
    expect((await api("chiefS", `/boards/${roadmap.id}/links`, "POST", { role: "editor", expiresAt: null })).status).toBe(201);
    expect((await api("chiefS", `/boards/${roadmap.id}/invites`, "POST", { email: "x@acme.com", role: "editor", expiresAt: null })).status).toBe(201);
  });
  test("what the manage-only admin keeps: Teams, role definitions, Space settings other than access, trash of a shared board, removing a grant", async () => {
    const t = await api("low", "/teams", "POST", { name: "Ops" });
    expect(t.status).toBe(201);
    expect((await api("low", "/roles", "POST", { name: "Plain", boardRole: "viewer", permissions: ["move"] })).status).toBe(201);
    expect((await api("low", `/spaces/${designSp.id}`, "PATCH", { name: "Design 3" })).status).toBe(200);
    expect((await api("low", `/boards/${roadmap.id}/trash`, "POST", { from: designSp.id })).status).toBe(200);
  });
  test("Teams: a manage-only admin cannot add THEMSELF to a Team that holds a board role (the same check as anyone); adding another member stays the admin's", async () => {
    const team = await r.createTeam({ tenant: acme.id, name: "Editors" });
    await r.setScopedGrant({ scope: { type: "space", id: designSp.id }, subject: { type: "team", id: team.id }, role: "editor" });
    expect((await api("low", `/teams/${team.id}/members/${SELF}`, "PUT")).status).toBe(403);
    expect((await api("low", `/teams/${team.id}/members/dev:bo`, "PUT")).status).toBe(204);
    expect(await ten.role(ident("low"), roadmap.id)).toBe(null);
  });
  test("offboarding: a manage-only admin reassigns a leaver's shared Space to ANOTHER member, never to themself; a holder may take it", async () => {
    const sp = await r.createSpace({ tenant: acme.id, name: "Leaver's", generalRole: null, owner: "dev:bo" });
    const ask = (who, to) => api(who, `/members/${encodeURIComponent("dev:bo")}/offboarding/reassign`, "POST", { type: "space", id: sp.id, to }, undefined);
    expect((await ask("low", SELF)).status).toBe(403);
    expect((await ask("low", "dev:ada")).status).toBe(200);
    const sp2 = await r.createSpace({ tenant: acme.id, name: "Leaver's 2", generalRole: null, owner: "dev:bo" });
    const mine = await api("chiefS", `/members/${encodeURIComponent("dev:bo")}/offboarding/reassign`, "POST", { type: "space", id: sp2.id, to: "dev:chiefS" });
    expect(mine.status).toBe(200);
  });
});

describe("M2: content.personal opens and acts as owner for move-out, trash, restore and handover only", () => {
  test("a content.personal holder cannot share a personal board, make a link or invite, transfer it, or create a board in someone's personal space", async () => {
    for (const [path, method, body] of [[`/boards/${diary.id}/grants/dev:bo`, "PUT", { role: "viewer" }], [`/access/board/${diary.id}/grants/user/dev:bo`, "PUT", { role: "viewer" }],
      [`/access/board/${diary.id}/grants/user/dev:chiefP`, "PUT", { role: "owner" }], [`/boards/${diary.id}/links`, "POST", { role: "viewer", expiresAt: null }],
      [`/boards/${diary.id}/invites`, "POST", { email: "x@acme.com", role: "viewer", expiresAt: null }], ["/boards", "POST", { space: adaSp.id, title: "planted" }]])
      expect([path, (await api("chiefP", path, method, body)).status]).toEqual([path, 403]);
    const a = await ten.effective(ident("chiefP"), diary.id);
    expect(["members.manage", "transfer", "board.create"].some(p => a.permissions.has(p))).toBe(false);
    for (const [path, method, body, want] of [[`/boards/${diary.id}`, "PATCH", { title: "Renamed" }, 200], [`/boards/${diary.id}/trash`, "POST", { from: adaSp.id }, 200], [`/boards/${diary.id}/restore`, "POST", {}, 200]])
      expect([path, (await api("chiefP", path, method, body)).status]).toEqual([path, want]);
  });
  test("content.shared likewise: its owner step opens a shared board but does not by itself let a non-admin holder share it", async () => {
    await r.touchMember(acme.id, { user: "dev:pure", name: "pure", email: "pure@acme.com" });
    const ten2 = makeTenancy({ registry: r });
    await r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: { type: "user", id: "dev:pure" }, role: "content-admin" });
    const a = await ten2.effective(ident("pure"), roadmap.id);
    expect([a.ladder, a.permissions.has("members.manage"), holdsTier(a), ownLadder(a)]).toEqual(["owner", false, true, null]);
  });
});

describe("who holds the tier is visible, and the built-ins are guarded", () => {
  test("every Unit admin sees the tier holders on the Unit access page and a 'used in N places' count on the built-in roles (read-only)", async () => {
    const page = await api("low", `/access/unit/${acme.id}`);
    const rows = page.json.rows.filter(x => x.role.startsWith("content-admin"));
    expect(rows.map(x => [x.subject.id, x.role]).sort()).toEqual([["dev:chiefP", "content-admin-personal"], ["dev:chiefS", "content-admin"]]);
    expect(rows.every(x => x.can.remove === true && x.can.change === false)).toBe(true);                          // may clear, may not change or raise
    const list = await api("low", "/roles");
    const byId = id => list.json.roles.find(x => x.id === id);
    expect([byId("content-admin").used, byId("content-admin-personal").used]).toEqual([{ places: 1, capped: false }, { places: 1, capped: false }]);
    expect(byId("content-admin").editable).toBe(false);
  });
  test("LOW-6: a copy of a tier role is refused to someone who could not hold it; a holder may copy; a custom role's summary names the tier separately", async () => {
    expect((await api("low", "/roles", "POST", { name: "Copy", boardRole: "viewer", permissions: [], base: "content-admin" })).status).toBe(403);
    expect((await api("chiefS", "/roles", "POST", { name: "Copy", boardRole: "viewer", permissions: ["move", "content.shared"], base: "content-admin" })).status).toBe(201);
    const l = await api("chiefS", "/roles");
    expect(l.json.roles.find(x => x.name === "Copy").summary).toBe("Viewer board access, plus 1 management permission, plus opening shared boards");
    expect((await api("low", "/roles", "POST", { name: "Odd", boardRole: "viewer", permissions: [], base: "constructor" })).status).toBe(400);
  });
});

describe("a ladder exemption is the tier (mutant guard)", () => {
  test("the resolver's tier source is what exempts: holdsTier is false for an admin without it and for a content.shared holder on a personal board", async () => {
    expect(holdsTier(await ten.effective(ident("low"), roadmap.id))).toBe(false);
    expect(holdsTier(await ten.effective(ident("chiefS"), roadmap.id))).toBe(true);
    expect(holdsTier(await ten.effective(ident("chiefS"), diary.id))).toBe(false);
    expect(holdsTier(await ten.effective(ident("chiefP"), diary.id))).toBe(true);
  });
});

describe("move: the per-person gain rule (the tier never hands out a role) and the ladder exemption needs a Unit-wide say", () => {
  test("a content.personal holder cannot move a private board into their own Space or an open Space (then share it); into a Space where nobody gains it moves, and Undo is computed after the write", async () => {
    const role = await r.createRole({ tenant: acme.id, name: "Auditor", boardRole: "viewer", permissions: ["content.personal", "move", "board.create"] });
    await hold("keeper", role.id);
    const own = await r.ensurePersonalSpace(acme.id, "dev:keeper");
    const mineShared = await r.createSpace({ tenant: acme.id, name: "Keeper's", generalRole: null, owner: "dev:keeper" });
    const open = await r.createSpace({ tenant: acme.id, name: "Open", generalRole: "editor", owner: "dev:ada" });
    const quiet = await r.createSpace({ tenant: acme.id, name: "Quiet", generalRole: null, owner: "dev:ada" });
    const to = id => api("keeper", `/boards/${diary.id}/move`, "POST", { from: adaSp.id, to: id });
    for (const id of [own.id, mineShared.id, open.id]) expect([id, (await to(id)).status]).toEqual([id, 403]);
    expect((await r.board(diary.id)).space).toBe(adaSp.id);
    const opts = await api("keeper", `/boards/${diary.id}/move`);
    expect(opts.json.destinations.map(d => d.name).sort()).toEqual(["Design", "Quiet"]);         // only where nobody gains; never their own Space or the open one
    const out = await to(quiet.id);
    expect(out.status).toBe(200);
    expect(out.json.undo).toBe(null);                                                           // no longer a board keeper may move: no Undo offered
  });
  test("a content.shared holder moves a board between Spaces whose people are the same (nobody gains) and is offered exactly those, with Undo; a manage-only admin moves nothing and is offered nothing", async () => {
    const same = await r.createSpace({ tenant: acme.id, name: "Same people", generalRole: null, owner: "dev:ada" });
    await r.createSpace({ tenant: acme.id, name: "Open", generalRole: "editor", owner: "dev:ada" });
    expect((await api("low", `/boards/${roadmap.id}/move`)).json.destinations).toEqual([]);
    expect((await api("low", `/boards/${roadmap.id}/move`, "POST", { from: designSp.id, to: same.id })).status).toBe(403);
    const o = await api("chiefS", `/boards/${roadmap.id}/move`);
    expect(o.json.destinations.map(d => d.name)).toEqual(["Same people"]);                          // never the Open Space (everyone would gain editor)
    const out = await api("chiefS", `/boards/${roadmap.id}/move`, "POST", { from: designSp.id, to: same.id });
    expect(out.status).toBe(200);
    expect(out.json.undo?.space.id).toBe(designSp.id);
  });
  test("M1: a content.shared holder whose only say on a board is a LOCAL role (viewer + members.manage) is held to that viewer step; a Unit admin holding the tier keeps the power", async () => {
    const mgr = await r.createRole({ tenant: acme.id, name: "Local manager", boardRole: "viewer", permissions: ["members.manage"] });
    await r.setScopedGrant({ scope: { type: "space", id: designSp.id }, subject: { type: "user", id: "dev:cy" }, role: mgr.id });
    const grant = (who, role) => api(who, `/access/board/${roadmap.id}/grants/user/dev:bo`, "PUT", { role });
    const link = (who, role) => api(who, `/boards/${roadmap.id}/links`, "POST", { role, expiresAt: null });
    for (const withTier of [false, true]) {
      if (withTier) await hold("cy", "content-admin");
      expect([withTier, (await grant("cy", "editor")).status]).toEqual([withTier, 403]);
      expect([withTier, (await link("cy", "editor")).status]).toEqual([withTier, 403]);
      expect([withTier, (await api("cy", `/spaces/${designSp.id}`, "PATCH", { general: "editor" })).status]).toEqual([withTier, 403]);
      expect([withTier, (await link("cy", "viewer")).status]).toEqual([withTier, 201]);           // their own step is theirs to give
    }
    expect((await grant("chiefS", "editor")).status).toBe(200);                                  // a Unit admin with the tier is exempt
    expect((await link("chiefS", "editor")).status).toBe(201);
  });
});

describe("restore does not launder the tier; move routes enforce rule 2 and leak no name; a pure content.personal holder cannot move out", () => {
  test("H1: a content.shared holder with a local {viewer, delete} Space role restores a board into their own personal space only if they would not gain a role: refused with and without the tier, so no owner step to share from", async () => {
    const janitor = await r.createRole({ tenant: acme.id, name: "Janitor", boardRole: "viewer", permissions: ["delete"] });
    await r.setScopedGrant({ scope: { type: "space", id: designSp.id }, subject: { type: "user", id: "dev:cy" }, role: janitor.id });
    expect((await api("ada", `/boards/${roadmap.id}/trash`, "POST", { from: designSp.id })).status).toBe(200);
    expect((await api("ada", `/spaces/${designSp.id}/trash`, "POST", {})).status).toBe(200);
    for (const withTier of [false, true]) {
      if (withTier) await hold("cy", "content-admin");
      const res = await api("cy", `/boards/${roadmap.id}/restore`, "POST", {});
      expect([withTier, res.status, res.json?.error]).toEqual([withTier, 409, "would-escalate"]);
    }
    expect((await r.board(roadmap.id)).trashedAt).not.toBe(null);
    expect((await api("cy", `/access/board/${roadmap.id}/grants/user/dev:bo`, "PUT", { role: "editor" })).status).toBe(403);
  });
  test("H2: a move of a shared board into a Space the caller cannot open is the bare 403 on every move route, and the options leak no title", async () => {
    const secret = await r.createSpace({ tenant: acme.id, name: "Hidden vault", generalRole: null, owner: "dev:ada" });
    const body = res => JSON.stringify(res.json ?? "");
    for (const res of [await api("low", `/boards/${roadmap.id}/move`, "POST", { from: designSp.id, to: secret.id }), await api("low", `/boards/${roadmap.id}/move/preview?to=${secret.id}`)]) {
      expect(res.status).toBe(403);
      expect(body(res)).toBe('{"error":"forbidden"}');
    }
    const o = await api("low", `/boards/${roadmap.id}/move`);
    expect(o.status).toBe(200);
    expect(o.json.board).toEqual({ id: roadmap.id });
    for (const leak of ["Roadmap", "Hidden vault", "Design"]) expect(body(o)).not.toContain(leak);
    const fine = await api("chiefS", `/boards/${roadmap.id}/move`);
    expect(fine.json.board.title).toBe("Roadmap");                                               // the title goes to someone who opens the board
    expect((await api("chiefS", `/boards/${roadmap.id}/move/preview?to=${secret.id}`)).status).toBe(200);
  });
  test("M1: a content.personal holder with no board.create at the destination (the tier gives move and delete only) is refused and offered nothing; an admin who also holds it moves out", async () => {
    const pure = await r.createRole({ tenant: acme.id, name: "Pure", boardRole: "viewer", permissions: ["content.personal"] });
    await hold("keeper", pure.id);
    const quiet = await r.createSpace({ tenant: acme.id, name: "Quiet", generalRole: null, owner: "dev:ada" });
    expect((await api("keeper", `/boards/${diary.id}/move`)).json.destinations).toEqual([]);
    expect((await api("keeper", `/boards/${diary.id}/move`, "POST", { from: adaSp.id, to: quiet.id })).status).toBe(403);
    expect((await api("chiefP", `/boards/${diary.id}/move`, "POST", { from: adaSp.id, to: quiet.id })).status).toBe(200);
  });
});

describe("round 5: restore gain check with an existing personal space, Trash titles, board create needs the Space open", () => {
  const trashRoadmap = async () => {
    expect((await api("ada", `/boards/${roadmap.id}/trash`, "POST", { from: designSp.id })).status).toBe(200);
  };
  test("B1: restoring into an EXISTING personal space is still gain-checked: cy with a {viewer, delete} Space role gets 409 would-escalate, the board stays in Trash and cy holds no role", async () => {
    const janitor = await r.createRole({ tenant: acme.id, name: "Janitor", boardRole: "viewer", permissions: ["delete"] });
    await r.setScopedGrant({ scope: { type: "space", id: designSp.id }, subject: { type: "user", id: "dev:cy" }, role: janitor.id });
    await r.ensurePersonalSpace(acme.id, "dev:cy");
    await trashRoadmap();
    expect((await api("ada", `/spaces/${designSp.id}/trash`, "POST", {})).status).toBe(200);
    for (const withTier of [false, true]) {
      if (withTier) await hold("cy", "content-admin");
      const res = await api("cy", `/boards/${roadmap.id}/restore`, "POST", {});
      expect([withTier, res.status, res.json?.error]).toEqual([withTier, 409, "would-escalate"]);
    }
    expect((await r.board(roadmap.id)).trashedAt).not.toBe(null);
    expect((await api("cy", `/boards/${roadmap.id}`)).status).not.toBe(200);
  });
  test("B1 positive: the owner restoring with an existing personal space is restored into it", async () => {
    const adaOwn = adaSp;
    await trashRoadmap();
    expect((await api("ada", `/spaces/${designSp.id}/trash`, "POST", {})).status).toBe(200);
    const res = await api("ada", `/boards/${roadmap.id}/restore`, "POST", {});
    expect(res.status).toBe(200);
    expect(res.json.movedTo).toEqual({ id: adaOwn.id, name: adaOwn.name, personal: true });
    expect((await r.board(roadmap.id)).space).toBe(adaOwn.id);
  });
  test("M1: a manage-only admin sees no board title in Trash (trash answer, list, notice, restore answer); the owner sees it everywhere", async () => {
    const body = res => JSON.stringify(res.json ?? "");
    const t = await api("low", `/boards/${roadmap.id}/trash`, "POST", { from: designSp.id });
    expect(t.status).toBe(200);
    expect(t.json.board).toEqual({ id: roadmap.id, space: { id: designSp.id } });
    expect(body(t)).not.toContain("Roadmap");
    const list = await api("low", "/trash");
    expect(list.json.items.find(i => i.id === roadmap.id)).toBeDefined();
    expect(body(list)).not.toContain("Roadmap");
    const notice = await api("low", `/boards/${roadmap.id}/trash`);
    expect(notice.status).toBe(200);
    expect(notice.json.board).toEqual({ id: roadmap.id });
    expect(body(notice)).not.toContain("Roadmap");
    expect((await api("ada", "/trash")).json.items.find(i => i.id === roadmap.id).title).toBe("Roadmap");
    expect((await api("ada", `/boards/${roadmap.id}/trash`)).json.board.title).toBe("Roadmap");
    const back = await api("low", `/boards/${roadmap.id}/restore`, "POST", {});
    expect(back.status).toBe(200);
    expect(back.json.board.title).toBeUndefined();
    expect(body(back)).not.toContain("Roadmap");
    const own = await api("ada", `/boards/${roadmap.id}/trash`, "POST", { from: designSp.id });
    expect(own.json.board.title).toBe("Roadmap");
    expect((await api("ada", `/boards/${roadmap.id}/restore`, "POST", {})).json.board.title).toBe("Roadmap");
  });
  test("LOW-2: a manage-only admin cannot create a board in a Space it cannot open, by id; the owner and a content.shared holder can", async () => {
    const secret = await r.createSpace({ tenant: acme.id, name: "Hidden vault", generalRole: null, owner: "dev:ada" });
    const res = await api("low", "/boards", "POST", { title: "Sneak", space: secret.id });
    expect([res.status, JSON.stringify(res.json)]).toEqual([403, '{"error":"forbidden"}']);
    expect((await api("ada", "/boards", "POST", { title: "Fine", space: secret.id })).status).toBe(201);
  });
});
