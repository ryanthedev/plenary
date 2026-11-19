// Roles (server/auth/roles.js, PROTOCOL.md § Roles, #50): the permission gate, the no-escalation rule, validation, the many-people confirmation,
// delete-while-in-use, the leak rules, the announcements a role edit owes, and the HTTP routes, over the real tenancy and the memory Registry.
import { test, expect, beforeEach, describe } from "bun:test";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy as makeTenancy } from "../../server/auth/tenancy.js";
import { rolesService, LIMITS } from "../../server/auth/roles.js";
import { accessService } from "../../server/auth/access.js";
import { httpRoutes } from "../../server/auth/http.js";
import { sessions as makeSessions } from "../../server/auth/session.js";
import { devAuth } from "../../server/auth/dev.js";
import { ALLOWED_AT, MGMT_PERMS } from "../../server/auth/permissions.js";

let r, ten, svc, acme, globex, ann;
const ident = (n, domain = "acme.com") => ({ user: `google:${n}`, name: n, email: `${n}@${domain}`, domain });
const root = ident("root"), ada = ident("ada"), max = ident("max"), lee = ident("lee"), kim = ident("kim", "partner.io"), gia = ident("gia", "globex.com");
const U = id => ({ type: "user", id });
const T = id => ({ type: "team", id });
const code = p => p.then(() => null, e => e.code ?? e.message);
const mk = (registry = r) => rolesService({ registry, tenancy: makeTenancy({ registry }), announce: (unit, scope, o) => ann.push({ scope: `${scope.type}:${scope.id}`, revoke: !!o?.revoke }) });
const holdAtUnit = (user, roleId) => r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: U(user), role: roleId });
const byId = (list, id) => list.roles.find(x => x.id === id);

beforeEach(async () => {
  r = memoryRegistry();
  ten = makeTenancy({ registry: r });
  ann = [];
  svc = mk();
  acme = await r.createTenant({ domain: "acme.com", admins: ["google:root"] });
  globex = await r.createTenant({ domain: "globex.com", admins: ["google:gia"] });
  for (const p of [root, ada, max, lee]) await r.touchMember(acme.id, { user: p.user, name: p.name, email: p.email });
});

describe("the gate: roles.manage at the Unit", () => {
  test("a Unit admin lists; a member, a guest and a user with no Unit get the one not-found; a custom role with roles.manage lists too", async () => {
    expect((await svc.list(root)).can.admin).toBe(true);
    for (const who of [max, kim, { user: "dev:z", name: "z", email: null, domain: null }]) expect(await code(svc.list(who))).toBe("not-found");
    const mgr = await r.createRole({ tenant: acme.id, name: "Role keeper", boardRole: "viewer", permissions: ["roles.manage"] });
    await holdAtUnit(max.user, mgr.id);
    const l = await svc.list(max);
    expect(l.can.admin).toBe(false);
    expect(l.matrix.tickable.sort()).toEqual(["roles.manage", "space.create"]);   // the Unit member role's space.create is theirs too
  });
  test("every write is the ordinary refusal for a caller without roles.manage", async () => {
    const c = await r.createRole({ tenant: acme.id, name: "C", boardRole: "viewer" });
    for (const who of [max, kim, { user: "dev:z", name: "z", email: null, domain: null }]) {
      expect(await code(svc.create(who, { name: "x", boardRole: "viewer", permissions: [] }))).toBe("forbidden");
      expect(await code(svc.update(who, c.id, { name: "x" }))).toBe("forbidden");
      expect(await code(svc.remove(who, c.id))).toBe("forbidden");
    }
    expect((await r.roles(acme.id)).length).toBe(1);
  });
  test("roles.manage is a Unit permission: a Space role carrying it grants nothing", async () => {
    const mgr = await r.createRole({ tenant: acme.id, name: "Role keeper", boardRole: "viewer", permissions: ["roles.manage"] });
    const sp = await r.createSpace({ tenant: acme.id, name: "S" });
    await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: U(max.user), role: mgr.id });
    expect(await code(svc.list(max))).toBe("not-found");
  });
});

describe("the list and the matrix", () => {
  test("built-ins are read-only, the member role is editable, custom roles carry their usage; scopes come from roleDef and ALLOWED_AT", async () => {
    const c = await r.createRole({ tenant: acme.id, name: "Facilitator", base: "editor", boardRole: "editor", permissions: ["members.manage", "board.create"] });
    const sp = await r.createSpace({ tenant: acme.id, name: "S" });
    await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: U(max.user), role: c.id });
    const l = await svc.list(root);
    expect(l.roles.map(x => x.id).slice(0, 7)).toEqual(["viewer", "commenter", "annotator", "editor", "owner", "admin", "member"]);
    for (const id of ["viewer", "editor", "owner", "admin"]) expect(byId(l, id)).toMatchObject({ kind: "builtin", editable: false, used: null });
    expect(byId(l, "member")).toMatchObject({ kind: "member", editable: true, permissions: ["space.create"], ladder: null });
    expect(byId(l, c.id)).toMatchObject({ kind: "custom", editable: true, base: "editor", ladder: "editor", used: { places: 1, capped: false } });
    expect(byId(l, c.id).scopes.space).toEqual(["board.view", "board.comment", "board.annotate", "board.edit", "members.manage", "board.create"].filter(p => byId(l, c.id).scopes.space.includes(p)));
    expect(byId(l, c.id).scopes.board).toContain("members.manage");
    expect(byId(l, c.id).scopes.board).not.toContain("board.create");              // not at a board
    for (const row of l.matrix.permissions.filter(p => p.group === "management")) expect(row.scopes).toEqual(["unit", "group", "space", "board"].filter(s => ALLOWED_AT[s].includes(row.id)));
    expect(l.matrix.permissions.find(p => p.id === "roles.manage").scopes).toEqual(["unit"]);
    expect(l.matrix.tickable).toEqual(MGMT_PERMS);
    expect(l.matrix.ladders).toEqual(["viewer", "commenter", "annotator", "editor"]);
    expect(l.matrix.content).toEqual({ viewer: ["board.view"], commenter: ["board.view", "board.comment"], annotator: ["board.view", "board.comment", "board.annotate"], editor: ["board.view", "board.comment", "board.annotate", "board.edit"] });
  });
  test("usage is a bounded count: 100+ is shown capped; the member role shows the directory size, capped at 50", async () => {
    const c = await r.createRole({ tenant: acme.id, name: "Many", boardRole: "viewer" });
    const sp = await r.createSpace({ tenant: acme.id, name: "S" });
    for (let i = 0; i < 101; i++) await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: U(`google:p${i}`), role: c.id });
    for (let i = 0; i < 60; i++) await r.touchMember(acme.id, { user: `google:m${i}`, name: `M${i}` });
    const l = await svc.list(root);
    expect(byId(l, c.id).used).toEqual({ places: 100, capped: true });
    expect(byId(l, "member").used).toEqual({ members: 50, capped: true });
  });
  test("a non-admin's tickable permissions and ladder steps are only what they hold themselves", async () => {
    const mgr = await r.createRole({ tenant: acme.id, name: "Keeper", boardRole: "annotator", permissions: ["roles.manage", "board.create"] });
    await holdAtUnit(max.user, mgr.id);
    const l = await svc.list(max);
    expect(l.matrix.tickable.sort()).toEqual(["board.create", "roles.manage", "space.create"]);
    expect(l.matrix.ladders).toEqual(["viewer", "commenter", "annotator"]);
  });
  test("another Unit's roles never show", async () => {
    await r.createRole({ tenant: globex.id, name: "Secret", boardRole: "viewer" });
    expect((await svc.list(root)).roles.some(x => x.name === "Secret")).toBe(false);
  });
});

describe("create and edit", () => {
  test("duplicate a built-in: name trimmed, base kept, row stored, nothing announced", async () => {
    const made = await svc.create(root, { name: "  Facilitator ", base: "editor", boardRole: "editor", permissions: ["members.manage"] });
    expect(made).toMatchObject({ name: "Facilitator", base: "editor", ladder: "editor", permissions: ["members.manage"], kind: "custom", used: { places: 0, capped: false } });
    expect(await r.role(acme.id, made.id)).toMatchObject({ name: "Facilitator", boardRole: "editor" });
    expect(ann).toEqual([]);
    const copy = await svc.create(root, { name: "Facilitator 2", base: made.id, boardRole: "viewer", permissions: [] });
    expect(copy.base).toBe(made.id);
  });
  test("validation: name, ladder step (never owner), permissions (distinct management ones), base", async () => {
    const ok = { name: "x", boardRole: "viewer", permissions: [] };
    for (const bad of [{ name: "" }, { name: "  " }, { name: "x".repeat(201) }, { name: 5 }, { boardRole: "owner" }, { boardRole: null }, { boardRole: "admin" },
      { permissions: ["board.edit"] }, { permissions: ["nope"] }, { permissions: ["delete", "delete"] }, { permissions: "delete" }, { base: "r-nope00000000" }, { base: 5 }, { base: globex.id }])
      expect([bad, await code(svc.create(root, { ...ok, ...bad }))]).toEqual([bad, "bad-request"]);
    expect((await r.roles(acme.id)).length).toBe(0);
  });
  test("a base of another Unit's role is refused", async () => {
    const g = await r.createRole({ tenant: globex.id, name: "G", boardRole: "viewer" });
    expect(await code(svc.create(root, { name: "x", boardRole: "viewer", permissions: [], base: g.id }))).toBe("bad-request");
  });
  test("custom roles are capped per Unit: the 51st is too-large, and the cap is not a count another Unit shares", async () => {
    for (let i = 0; i < LIMITS.custom; i++) await svc.create(root, { name: `R${i}`, boardRole: "viewer", permissions: [] });
    expect(await code(svc.create(root, { name: "one more", boardRole: "viewer", permissions: [] }))).toBe("too-large");
    expect((await r.roles(acme.id)).length).toBe(LIMITS.custom);
    expect((await svc.list(root)).roles.length).toBe(7 + LIMITS.custom);
    expect((await rolesService({ registry: r, tenancy: ten }).create(gia, { name: "mine", boardRole: "viewer", permissions: [] })).name).toBe("mine");
  });
  test("edit: name, ladder step and permissions; the answer is the view; a no-op writes and announces nothing", async () => {
    const c = await svc.create(root, { name: "A", boardRole: "viewer", permissions: ["board.create"] });
    expect(await svc.update(root, c.id, { name: "B" })).toMatchObject({ name: "B", ladder: "viewer" });
    expect(ann).toEqual([]);
    const up = await svc.update(root, c.id, { boardRole: "annotator", permissions: ["board.create", "move"] });
    expect(up).toMatchObject({ ladder: "annotator", permissions: ["board.create", "move"] });
    expect(await r.role(acme.id, c.id)).toMatchObject({ boardRole: "annotator", permissions: ["board.create", "move"] });
    expect(await svc.update(root, c.id, { permissions: ["move", "board.create"] })).toMatchObject({ ladder: "annotator" });   // same set: nothing
    expect(ann).toEqual([]);                                                          // unused: nothing to re-check
    for (const bad of [{ boardRole: "owner" }, { boardRole: null }, { permissions: ["board.view"] }, { name: "" }])
      expect([bad, await code(svc.update(root, c.id, bad))]).toEqual([bad, "bad-request"]);
  });
  test("the Unit member role: its permissions only; name and board content are fixed (400)", async () => {
    expect((await svc.update(root, "member", { permissions: ["space.create", "board.create"] })).permissions).toEqual(["space.create", "board.create"]);
    expect(await code(svc.update(root, "member", { name: "All hands" }))).toBe("bad-request");
    expect(await code(svc.update(root, "member", { boardRole: "viewer" }))).toBe("bad-request");
    expect(await code(svc.update(root, "member", { permissions: ["board.edit"] }))).toBe("bad-request");
    expect(await r.role(acme.id, "member")).toMatchObject({ boardRole: null, permissions: ["space.create", "board.create"] });
    expect(ann.length).toBe(1);                                                       // the member role reaches everyone: announced
    expect(await code(svc.remove(root, "member"))).toBe("bad-request");
  });
  test("a role held by a custom role cannot be given the owner step: the ladder stops at editor", async () => {
    const c = await svc.create(root, { name: "A", boardRole: "editor", permissions: ["transfer", "delete", "members.manage"] });
    expect(await code(svc.update(root, c.id, { boardRole: "owner" }))).toBe("bad-request");
    expect((await r.role(acme.id, c.id)).boardRole).toBe("editor");
  });
});

describe("no escalation (non-admin editors)", () => {
  let keeper;
  beforeEach(async () => {
    keeper = await r.createRole({ tenant: acme.id, name: "Keeper", boardRole: "annotator", permissions: ["roles.manage", "board.create", "members.manage"] });
    await holdAtUnit(max.user, keeper.id);
  });
  test("a role cannot carry a permission or a ladder step the editor does not hold", async () => {
    expect((await svc.create(max, { name: "ok", boardRole: "annotator", permissions: ["board.create"] })).name).toBe("ok");
    for (const bad of [{ permissions: ["delete"] }, { permissions: ["board.create", "transfer"] }, { boardRole: "editor" }, { permissions: ["group.create"] }, { permissions: ["team.manage"] }])
      expect([bad, await code(svc.create(max, { name: "x", boardRole: "viewer", permissions: [], ...bad }))]).toEqual([bad, "forbidden"]);
    expect((await r.roles(acme.id)).map(x => x.name).sort()).toEqual(["Keeper", "ok"]);
  });
  test("editing: neither the role as it is nor as it would become may exceed the editor", async () => {
    const mine = await svc.create(max, { name: "mine", boardRole: "viewer", permissions: ["board.create"] });
    expect(await code(svc.update(max, mine.id, { boardRole: "editor" }))).toBe("forbidden");           // raising the ladder above their own
    expect(await code(svc.update(max, mine.id, { permissions: ["board.create", "delete"] }))).toBe("forbidden");
    const above = await r.createRole({ tenant: acme.id, name: "Above", boardRole: "viewer", permissions: ["delete"] });
    expect(await code(svc.update(max, above.id, { name: "Renamed" }))).toBe("forbidden");             // a role above them cannot be touched, even to rename
    expect(await code(svc.update(max, above.id, { permissions: [] }))).toBe("forbidden");             // nor lowered
    expect(await code(svc.remove(max, above.id))).toBe("forbidden");
    expect(await r.role(acme.id, above.id)).toMatchObject({ name: "Above", permissions: ["delete"] });
    expect((await svc.update(max, mine.id, { permissions: ["members.manage"] })).permissions).toEqual(["members.manage"]);
  });
  test("a Unit admin may give any management permission and any step up to editor", async () => {
    const c = await svc.create(root, { name: "Big", boardRole: "editor", permissions: [...MGMT_PERMS] });
    expect(c.permissions).toEqual(MGMT_PERMS);
  });
  test("a role the editor holds may be lowered, never raised: they cannot widen their own role", async () => {
    expect(await code(svc.update(max, keeper.id, { permissions: ["roles.manage", "board.create", "members.manage", "delete"] }))).toBe("forbidden");
    expect(await code(svc.update(max, keeper.id, { boardRole: "editor" }))).toBe("forbidden");
    expect((await svc.update(max, keeper.id, { permissions: ["roles.manage"] })).permissions).toEqual(["roles.manage"]);
  });
  test("the Unit member role's permissions count as the caller's own: a holder of roles.manage and a viewer step may mint space.create (the member role has it), never group.create", async () => {
    const k2 = await r.createRole({ tenant: acme.id, name: "Keeper 2", boardRole: "viewer", permissions: ["roles.manage"] });
    await holdAtUnit(lee.user, k2.id);
    expect((await svc.create(lee, { name: "spaces", boardRole: "viewer", permissions: ["space.create"] })).permissions).toEqual(["space.create"]);
    expect(await code(svc.create(lee, { name: "groups", boardRole: "viewer", permissions: ["group.create"] }))).toBe("forbidden");
    // such a role gives space.create at the Unit and Groups only, and nothing at a Space: minting it grants nothing anywhere by itself
    const minted = (await svc.list(lee)).roles.find(x => x.name === "spaces");
    expect(minted.scopes.space).not.toContain("space.create");
    expect(minted.scopes.group).toContain("space.create");
  });
  test("a caller with roles.manage but no board content of their own (only the Unit member role gives them anything) cannot mint any role: every role has a board step", async () => {
    await svc.update(root, "member", { permissions: ["space.create", "roles.manage"], confirm: true });
    expect(await code(svc.create(lee, { name: "spaces", boardRole: "viewer", permissions: ["space.create"] }))).toBe("forbidden");
    expect((await svc.list(lee)).can.admin).toBe(false);
  });
  test("the list says what THIS caller may edit: the member role only for a Unit admin; a custom role above the caller is read-only, one within their rights is editable", async () => {
    const mgr = await r.createRole({ tenant: acme.id, name: "Mgr", boardRole: "editor", permissions: ["roles.manage", "board.create"] });
    const low = await r.createRole({ tenant: acme.id, name: "Low", boardRole: "viewer", permissions: ["board.create"] });
    const high = await r.createRole({ tenant: acme.id, name: "High", boardRole: "editor", permissions: ["roles.manage", "board.create", "delete"] });
    await holdAtUnit(lee.user, mgr.id);
    const l = await svc.list(lee), a = await svc.list(root);
    expect([byId(l, "member").editable, byId(l, low.id).editable, byId(l, high.id).editable, byId(l, mgr.id).editable]).toEqual([false, true, false, true]);
    expect([byId(a, "member").editable, byId(a, high.id).editable]).toEqual([true, true]);
    expect(await code(svc.update(lee, high.id, { name: "x" }))).toBe("forbidden");         // what the list says is what the write does
    expect((await svc.update(lee, low.id, { name: "Lower" })).editable).toBe(true);
  });
  test("the Unit member role changes what EVERY member may do: a non-admin roles.manage holder (with a board step and the member permissions) is refused; a Unit admin edits it", async () => {
    const mgr = await r.createRole({ tenant: acme.id, name: "Mgr", boardRole: "editor", permissions: ["roles.manage", "space.create"] });
    await holdAtUnit(lee.user, mgr.id);
    expect(await code(svc.update(lee, "member", { permissions: [] }))).toBe("forbidden");                 // would strip space.create from every member
    expect(await code(svc.update(lee, "member", { permissions: ["space.create"] }))).toBe("forbidden");   // even a no-op: one answer
    expect(await r.role(acme.id, "member")).toBe(null);
    expect(ann).toEqual([]);
    expect((await svc.update(lee, mgr.id, { permissions: ["roles.manage"] })).permissions).toEqual(["roles.manage"]);   // a custom role it holds in full is still editable
    expect((await svc.update(root, "member", { permissions: [] })).permissions).toEqual([]);
  });
  test("a grant of a role deleted between the access read and the write is refused 400 bad-role and stores nothing (the Registry checks the role in the write)", async () => {
    const c = await r.createRole({ tenant: acme.id, name: "Soon gone", boardRole: "viewer" });
    const sp = await r.createSpace({ tenant: acme.id, name: "S", owner: "google:root" });
    const racing = { ...r, setScopedGrant: async o => { await r.deleteRole(acme.id, c.id); return r.setScopedGrant(o); } };
    const access = accessService({ registry: racing, tenancy: makeTenancy({ registry: racing }) });
    expect(await code(access.setGrant(root, "space", sp.id, "user", ada.user, c.id))).toBe("bad-role");
    expect(await r.scopedGrants({ type: "space", id: sp.id })).toEqual([{ subject: U("google:root"), role: "owner" }]);
  });
  test("the team.manage back door: after a role gains a permission, a team.manage holder who lacks it can no longer change the Team that holds it", async () => {
    const tm = await r.createRole({ tenant: acme.id, name: "Team keeper", boardRole: "viewer", permissions: ["team.manage"] });
    await holdAtUnit(lee.user, tm.id);
    const delegate = await r.createRole({ tenant: acme.id, name: "Delegate", boardRole: "viewer", permissions: ["members.manage", "board.create"] });
    const sp = await r.createSpace({ tenant: acme.id, name: "S", owner: "google:root" });
    await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: U(lee.user), role: delegate.id });
    const role = await svc.create(root, { name: "Ops", boardRole: "viewer", permissions: ["board.create"] });
    const team = await r.createTeam({ tenant: acme.id, name: "Ops team" });
    await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: T(team.id), role: role.id });
    const access = accessService({ registry: r, tenancy: ten });
    await access.setMember(lee, team.id, ada.user, true);                                                  // lee can give the role as it is
    expect(await r.teamMembers(team.id)).toContain(ada.user);
    await svc.update(root, role.id, { permissions: ["board.create", "delete"] });                          // Ops now holds `delete`, which lee does not
    expect(await code(access.setMember(lee, team.id, max.user, true))).toBe("forbidden");
    expect(await code(access.setMember(lee, team.id, ada.user, false))).toBe("forbidden");
    expect(await r.teamMembers(team.id)).toEqual([ada.user]);
  });
});

describe("delete: refused while in use", () => {
  test("in-use carries a count and changes nothing; once the last grant goes the delete works; built-ins and unknown ids are refused", async () => {
    const c = await svc.create(root, { name: "A", boardRole: "viewer", permissions: [] });
    const sp = await r.createSpace({ tenant: acme.id, name: "S" }), team = await r.createTeam({ tenant: acme.id, name: "T" });
    await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: U(max.user), role: c.id });
    await r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: T(team.id), role: c.id });
    const e = await svc.remove(root, c.id).catch(x => x);
    expect([e.code, e.data]).toEqual(["in-use", { places: 2, capped: false }]);
    expect(await r.role(acme.id, c.id)).toMatchObject({ id: c.id });
    await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: U(max.user), role: null });
    expect(await code(svc.remove(root, c.id))).toBe("in-use");
    await r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: T(team.id), role: null });
    await svc.remove(root, c.id);
    expect(await r.role(acme.id, c.id)).toBe(null);
    expect(ann).toEqual([]);
    for (const id of [c.id, "viewer", "owner", "admin", "r-nope00000000", "", "a/b"]) expect([id, await code(svc.remove(root, id))]).toEqual([id, "forbidden"]);
  });
  test("a deletion that lost a race (the role is gone between the check and the delete) is the ordinary refusal, not a 503", async () => {
    const c = await svc.create(root, { name: "A", boardRole: "viewer", permissions: [] });
    const racing = new Proxy(r, { get: (o, k) => (k === "deleteRole" ? async (...a) => { await o.deleteRole(...a); return o.deleteRole(...a); } : o[k]) });
    expect(await code(mk(racing).remove(root, c.id))).toBe("forbidden");
  });
  test("an edit that lost a race with a delete is the ordinary refusal", async () => {
    const c = await svc.create(root, { name: "A", boardRole: "viewer", permissions: [] });
    const racing = new Proxy(r, { get: (o, k) => (k === "updateRole" ? async (...a) => { await o.deleteRole(acme.id, c.id); return o.updateRole(...a); } : o[k]) });
    expect(await code(mk(racing).update(root, c.id, { name: "B" }))).toBe("forbidden");
  });
});

describe("leaks: hidden, unknown and other-Unit role ids answer alike and cost the same", () => {
  test("the same refusal and the same Registry calls for an unknown id, another Unit's role and a built-in, for a manager; and for a non-manager, whatever the id", async () => {
    const other = await r.createRole({ tenant: globex.id, name: "Theirs", boardRole: "viewer" });
    const mine = await r.createRole({ tenant: acme.id, name: "Mine", boardRole: "viewer" });
    const calls = [];
    const spy = new Proxy(r, { get: (o, k) => (typeof o[k] === "function" ? (...a) => { calls.push(String(k)); return o[k](...a); } : o[k]) });
    const s = mk(spy);
    const probe = async (who, id, f) => { calls.length = 0; const c = await code(f(who, id)); return [c, [...calls].sort()]; };
    const patch = (w, i) => s.update(w, i, { name: "x" }), del = (w, i) => s.remove(w, i);
    for (const f of [patch, del]) {
      const base = await probe(root, "r-nope00000000", f);
      expect(base[0]).toBe("forbidden");
      for (const id of [other.id, "viewer", "admin", "not an id!", "a".repeat(80)]) expect([id, await probe(root, id, f)]).toEqual([id, base]);
      const nobody = await probe(max, mine.id, f);                              // a member sees the same for a real role of the Unit
      expect(nobody[0]).toBe("forbidden");
      expect(await probe(max, other.id, f)).toEqual(nobody);
    }
    expect(await r.role(globex.id, other.id)).toMatchObject({ name: "Theirs" });   // nothing of the other Unit changed
  });
  test("no error or count names a scope or a person; an in-use answer is a number", async () => {
    const c = await r.createRole({ tenant: acme.id, name: "A", boardRole: "viewer" });
    const sp = await r.createSpace({ tenant: acme.id, name: "Secret roadmap" });
    await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: U(max.user), role: c.id });
    const e = await svc.remove(root, c.id).catch(x => x);
    expect(JSON.stringify([e.message, e.data])).not.toMatch(/Secret|google:|s-/);
    expect(await code(svc.list(kim))).toBe("not-found");
  });
  test("another Unit's grant of the same role string neither counts nor blocks a delete", async () => {
    const c = await r.createRole({ tenant: acme.id, name: "A", boardRole: "viewer" });
    const gs = await r.createSpace({ tenant: globex.id, name: "G" });
    expect((await r.setScopedGrant({ scope: { type: "space", id: gs.id }, subject: U("google:gia"), role: c.id }).catch(e => e)).code).toBe("no-role");     // the Registry refuses it
    expect(byId(await svc.list(root), c.id).used).toEqual({ places: 0, capped: false });
    await svc.remove(root, c.id);
  });
});

describe("the many-people confirmation", () => {
  const spaces = async n => { const out = []; for (let i = 0; i < n; i++) out.push(await r.createSpace({ tenant: acme.id, name: `S${i}` })); return out; };
  test("more than 10 places: the edit is held with the count until confirmed; a rename and an unused role never ask", async () => {
    const c = await svc.create(root, { name: "A", boardRole: "viewer", permissions: ["board.create"] });
    for (const sp of await spaces(11)) await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: U(max.user), role: c.id });
    const e = await svc.update(root, c.id, { permissions: [] }).catch(x => x);
    expect([e.code, e.data]).toEqual(["confirm-required", { impact: { places: 11, people: 1, capped: false } }]);
    expect((await r.role(acme.id, c.id)).permissions).toEqual(["board.create"]);     // nothing changed
    expect(ann).toEqual([]);
    expect(await svc.update(root, c.id, { name: "Renamed" })).toMatchObject({ name: "Renamed" });
    expect(await svc.update(root, c.id, { permissions: [], confirm: true })).toMatchObject({ permissions: [] });
    expect(ann).toEqual([{ scope: `unit:${acme.id}`, revoke: true }]);
    const quiet = await svc.create(root, { name: "Q", boardRole: "viewer", permissions: [] });
    expect(await svc.update(root, quiet.id, { boardRole: "editor" })).toMatchObject({ ladder: "editor" });
  });
  test("10 places and 50 people are not many; 51 people held through one Team is", async () => {
    const c = await svc.create(root, { name: "A", boardRole: "viewer", permissions: ["board.create"] });
    const sp = await spaces(10);
    for (const s of sp) await r.setScopedGrant({ scope: { type: "space", id: s.id }, subject: U(max.user), role: c.id });
    expect(await svc.update(root, c.id, { permissions: ["move"] })).toMatchObject({ permissions: ["move"] });
    const team = await r.createTeam({ tenant: acme.id, name: "Big" });
    for (let i = 0; i < 51; i++) await r.setTeamMember(team.id, `google:t${i}`, true);
    const d = await r.createRole({ tenant: acme.id, name: "D", boardRole: "viewer", permissions: ["move"] });
    await r.setScopedGrant({ scope: { type: "space", id: sp[0].id }, subject: T(team.id), role: d.id });
    const e = await svc.update(root, d.id, { permissions: [] }).catch(x => x);
    expect([e.code, e.data.impact]).toEqual(["confirm-required", { places: 1, people: 51, capped: false }]);
  });
  test("people are distinct: one person in 51 places is one person, so it asks for the places and says 1", async () => {
    const c = await svc.create(root, { name: "Solo", boardRole: "viewer", permissions: ["board.create"] });
    for (const sp of await spaces(51)) await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: U(max.user), role: c.id });
    const e = await svc.update(root, c.id, { permissions: [] }).catch(x => x);
    expect([e.code, e.data.impact]).toEqual(["confirm-required", { places: 51, people: 1, capped: false }]);
  });
  test("the member role asks once the Unit has more than 50 members, with their count", async () => {
    for (let i = 0; i < 49; i++) await r.touchMember(acme.id, { user: `google:m${i}`, name: `M${i}` });        // 4 + 49 = 53
    const e = await svc.update(root, "member", { permissions: [] }).catch(x => x);
    expect([e.code, e.data.impact]).toEqual(["confirm-required", { places: 0, people: 50, capped: true }]);
    expect((await r.role(acme.id, "member"))).toBe(null);
    expect((await svc.update(root, "member", { permissions: [], confirm: true })).permissions).toEqual([]);
  });
  test("a few members: no confirmation needed", async () => {
    expect((await svc.update(root, "member", { permissions: [] })).permissions).toEqual([]);
  });
});

describe("freshness: what a role edit announces", () => {
  async function used() {
    const c = await svc.create(root, { name: "A", boardRole: "annotator", permissions: ["board.create", "move"] });
    const sp = await r.createSpace({ tenant: acme.id, name: "S" });
    await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: U(max.user), role: c.id });
    ann.length = 0;
    return c;
  }
  test("removing a permission, lowering the step, or swapping one for another is a revocation of the whole Unit", async () => {
    const c = await used();
    await svc.update(root, c.id, { permissions: ["board.create"] });
    await svc.update(root, c.id, { boardRole: "viewer" });
    await svc.update(root, c.id, { permissions: ["delete"] });
    expect(ann).toEqual(Array(3).fill({ scope: `unit:${acme.id}`, revoke: true }));
  });
  test("a pure widening is announced, not as a revocation; a rename announces nothing", async () => {
    const c = await used();
    await svc.update(root, c.id, { permissions: ["board.create", "move", "delete"], boardRole: "editor" });
    expect(ann).toEqual([{ scope: `unit:${acme.id}`, revoke: false }]);
    ann.length = 0;
    await svc.update(root, c.id, { name: "Other" });
    expect(ann).toEqual([]);
  });
  test("a role no grant holds announces nothing", async () => {
    const c = await svc.create(root, { name: "B", boardRole: "viewer", permissions: ["move"] });
    await svc.update(root, c.id, { permissions: [] });
    expect(ann).toEqual([]);
  });
  test("the announcement and the new definition are visible to the very next access answer", async () => {
    const c = await used();
    const sp = (await r.spaces(acme.id)).at(-1);
    expect((await ten.effective(max, { type: "space", id: sp.id })).permissions.has("move")).toBe(true);
    await svc.update(root, c.id, { permissions: ["board.create"] });
    const after = await ten.effective(max, { type: "space", id: sp.id });
    expect([after.permissions.has("move"), after.permissions.has("board.create"), after.ladder]).toEqual([false, true, "annotator"]);
  });
});

describe("over HTTP", () => {
  let routes;
  const ORIGIN = "https://plenary.test";
  const config = { cookieKey: "k".repeat(32), postLoginUrl: ORIGIN + "/", boardUrl: ORIGIN + "/b/{board}", publicUrl: ORIGIN };
  const api = async (tok, path, method = "GET", body, headers = {}) => {
    const res = await routes(new Request(ORIGIN + path, { method, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  beforeEach(async () => {
    const dev = devAuth({ enabled: true, tokens: { root: { name: "root", domain: "acme.com", email: "root@acme.com" }, max: { name: "max", domain: "acme.com", email: "max@acme.com" }, kim: { name: "kim", email: "kim@partner.io" } } });
    await r.addTenantAdmin(acme.id, "dev:root");
    routes = httpRoutes({ registry: r, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy: ten, config, dev,
      roles: rolesService({ registry: r, tenancy: ten, announce: (unit, scope, o) => ann.push({ scope: `${scope.type}:${scope.id}`, revoke: !!o?.revoke }) }) });
  });
  test("401 without a token on every route", async () => {
    for (const [m, p, b] of [["GET", "/roles"], ["POST", "/roles", {}], ["PATCH", "/roles/x", {}], ["DELETE", "/roles/x"]]) expect([m, (await api(null, p, m, b)).status]).toEqual([m, 401]);
  });
  test("create 201, list, patch, delete 204, and the refusals", async () => {
    const c = await api("root", "/roles", "POST", { name: "Host", base: "editor", boardRole: "editor", permissions: ["members.manage"] });
    expect(c.status).toBe(201);
    const id = c.body.role.id;
    expect((await api("max", "/roles")).status).toBe(404);
    expect((await api("kim", "/roles")).status).toBe(404);
    expect((await api("max", "/roles", "POST", { name: "x", boardRole: "viewer", permissions: [] })).status).toBe(403);
    expect((await api("root", "/roles")).body.roles.map(x => x.id)).toContain(id);
    expect((await api("root", `/roles/${id}`, "PATCH", { name: "Host 2" })).body.role.name).toBe("Host 2");
    expect((await api("root", `/roles/${id}`, "PATCH", { boardRole: "owner" })).status).toBe(400);
    expect((await api("root", `/roles/${id}`, "PATCH", { unknown: 1 })).status).toBe(400);
    expect((await api("max", `/roles/${id}`, "DELETE")).status).toBe(403);
    expect((await api("root", `/roles/${id}`, "DELETE")).status).toBe(204);
    expect((await api("root", `/roles/${id}`, "DELETE")).status).toBe(403);
    expect((await api("root", "/roles/viewer", "DELETE")).status).toBe(403);
  });
  test("409 in-use and 409 confirm-required carry their counts; too-large is 409", async () => {
    const id = (await api("root", "/roles", "POST", { name: "A", boardRole: "viewer", permissions: ["move"] })).body.role.id;
    const sp = await r.createSpace({ tenant: acme.id, name: "S" });
    for (let i = 0; i < 11; i++) await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: U(`dev:p${i}`), role: id });
    const held = await api("root", `/roles/${id}`, "PATCH", { permissions: [] });
    expect([held.status, held.body]).toEqual([409, { error: "confirm-required", impact: { places: 11, people: 11, capped: false } }]);
    expect((await api("root", `/roles/${id}`, "PATCH", { permissions: [], confirm: true })).status).toBe(200);
    const used = await api("root", `/roles/${id}`, "DELETE");
    expect([used.status, used.body]).toEqual([409, { error: "in-use", places: 11, capped: false }]);
    expect((await api("root", `/roles/${id}`, "PATCH", { confirm: "yes", permissions: ["move"] })).status).toBe(409);     // only a literal true confirms
    for (let i = 0; i < LIMITS.custom - 1; i++) await r.createRole({ tenant: acme.id, name: `F${i}`, boardRole: "viewer" });
    expect((await api("root", "/roles", "POST", { name: "over", boardRole: "viewer", permissions: [] })).body).toEqual({ error: "too-large" });
  });
  test("POST /roles takes an Idempotency-Key: a retry returns the same role and makes no second one; a changed body is 422", async () => {
    const body = { name: "Once", boardRole: "viewer", permissions: [] }, h = { "idempotency-key": "role-key-0001" };
    const a = await api("root", "/roles", "POST", body, h), b = await api("root", "/roles", "POST", body, h);
    expect([a.status, b.status, b.headers.get("idempotent-replayed")]).toEqual([201, 201, "true"]);
    expect(b.body.role.id).toBe(a.body.role.id);
    expect((await r.roles(acme.id)).length).toBe(1);
    expect((await api("root", "/roles", "POST", { ...body, name: "Twice" }, h)).status).toBe(422);
    await r.deleteRole(acme.id, a.body.role.id);
    expect((await api("root", "/roles", "POST", body, h)).status).toBe(404);                                  // a replay of a role since deleted
    await r.createRole({ tenant: acme.id, name: "X", boardRole: "viewer" });
    const c = await api("root", "/roles", "POST", { name: "Third", boardRole: "viewer", permissions: [] }, { "idempotency-key": "role-key-0002" });
    expect(c.status).toBe(201);
    // another user's key is its own: a second manager (a custom role carrying roles.manage and a board step) gets a new role, not the first one's replay
    const mgr = await r.createRole({ tenant: acme.id, name: "Mgr", boardRole: "editor", permissions: ["roles.manage"] });
    await r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: U("dev:max"), role: mgr.id });
    const d = await api("max", "/roles", "POST", { name: "Third", boardRole: "viewer", permissions: [] }, { "idempotency-key": "role-key-0002" });
    expect([d.status, d.headers.get("idempotent-replayed")]).toEqual([201, null]);
    expect(d.body.role.id).not.toBe(c.body.role.id);
  });
  test("a replay is authorized again: a manager who lost roles.manage, or whose rights no longer cover the role, gets 403 and never the stored role", async () => {
    const mgr = await r.createRole({ tenant: acme.id, name: "Mgr", boardRole: "editor", permissions: ["roles.manage", "move"] });
    await r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: U("dev:max"), role: mgr.id });
    const body = { name: "Mine", boardRole: "viewer", permissions: ["move"] }, h = { "idempotency-key": "role-key-0003" };
    const first = await api("max", "/roles", "POST", body, h);
    expect(first.status).toBe(201);
    await r.updateRole(acme.id, mgr.id, { permissions: ["roles.manage"] });                     // `move` is no longer held: the role is above max now
    const above = await api("max", "/roles", "POST", body, h);
    expect([above.status, above.body]).toEqual([403, { error: "forbidden" }]);
    await r.updateRole(acme.id, mgr.id, { permissions: ["roles.manage", "move"] });
    expect((await api("max", "/roles", "POST", body, h)).headers.get("idempotent-replayed")).toBe("true");
    await r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: U("dev:max"), role: null });   // lost roles.manage
    const lost = await api("max", "/roles", "POST", body, h);
    expect([lost.status, lost.body]).toEqual([403, { error: "forbidden" }]);
  });
});
