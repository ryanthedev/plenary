// The permission resolver (server/auth/resolver.js) and the permission tables (server/auth/permissions.js), pure: every
// row is handed in, so these tests build contexts by hand and need no Registry.
import { test, expect, describe } from "bun:test";
import { resolveAccess, isUnitAdmin, isUnitMember } from "../../server/auth/resolver.js";
import { roleDef, roleProblem, ALLOWED_AT, MGMT_PERMS, CONTENT_PERMS } from "../../server/auth/permissions.js";

const T = 1000;
const tenant = { id: "t-acme", domain: "acme.com", domains: ["acme.com", "acme.io"], kind: "company", admins: ["google:root", "email:boss@acme.com"], createdAt: 0 };
const group = { id: "g-1", tenant: "t-acme", name: "Product", generalRole: null, createdAt: 0 };
const space = { id: "s-1", tenant: "t-acme", group: "g-1", name: "Design", kind: "shared", owner: null, generalRole: null, createdAt: 0 };
const board = { id: "b-1", tenant: "t-acme", title: "", memberRole: null, space: "s-1", createdAt: 0 };
const me = { user: "google:me", email: "me@acme.com", domain: "acme.com" };
const guest = { user: "google:kim", email: "kim@partner.io", domain: null };
const U = id => ({ type: "user", id }), TM = id => ({ type: "team", id });
const sg = (subject, role) => ({ subject, role });
/** A context with every container by default. */
const ctx = (o = {}) => ({ tenant, board, space, group, scoped: { unit: [], group: [], space: [], board: [] }, roles: [], teams: {}, ...o });
const ladder = (rows, id = me, opts) => resolveAccess(rows, id, T, opts).ladder;
const perms = (rows, id = me, opts) => [...resolveAccess(rows, id, T, opts).permissions].sort();

describe("sources and the ladder role", () => {
  test("no source: no role, no permissions, no sources (a Unit member still has the member role's own permissions)", () => {
    const a = resolveAccess({ ctx: ctx() }, guest, T);
    expect([a.ladder, [...a.permissions], a.sources]).toEqual([null, [], []]);
    const m = resolveAccess({ ctx: ctx() }, me, T);
    expect(m.ladder).toBe(null);
    expect([...m.permissions]).toEqual(["space.create"]);
    expect(m.sources).toMatchObject([{ kind: "unit", scope: { type: "unit", id: "t-acme" }, role: "member" }]);
  });

  test("direct grant on the board", () => {
    const a = resolveAccess({ ctx: ctx(), grant: "editor" }, guest, T);
    expect(a.ladder).toBe("editor");
    expect(a.sources).toMatchObject([{ kind: "direct", scope: { type: "board", id: "b-1" }, role: "editor", ladder: "editor" }]);
    expect([...a.permissions].sort()).toEqual(["board.annotate", "board.comment", "board.edit", "board.view"]);
  });

  test("a board owner may manage members, move, delete and transfer that board, and nothing wider", () => {
    expect(perms({ ctx: ctx(), grant: "owner" }, guest)).toEqual([...CONTENT_PERMS, "delete", "members.manage", "move", "transfer"].sort());
  });

  test("team grant on the board names the team; a team the user is not in counts for nothing", () => {
    const c = ctx({ scoped: { unit: [], group: [], space: [], board: [sg(TM("tm-a"), "editor"), sg(TM("tm-b"), "owner")] }, teams: { "tm-a": ["google:me"], "tm-b": ["google:other"] } });
    const a = resolveAccess({ ctx: c }, guest, T);
    expect(a.ladder).toBe(null);
    const b = resolveAccess({ ctx: c }, { ...guest, user: "google:me" }, T);
    expect(b.ladder).toBe("editor");
    expect(b.sources).toMatchObject([{ kind: "team", team: "tm-a", scope: { type: "board" }, role: "editor" }]);
  });

  test("Space grants (user and team) reach the board; so do Group grants", () => {
    const c = ctx({ scoped: { unit: [], space: [sg(U("google:me"), "annotator")], group: [sg(TM("tm-a"), "editor")], board: [] }, teams: { "tm-a": ["google:me"] } });
    const a = resolveAccess({ ctx: c }, me, T);
    expect(a.ladder).toBe("editor");
    expect(a.sources.map(s => [s.kind, s.scope.type, s.role])).toEqual([["direct", "space", "annotator"], ["team", "group", "editor"], ["unit", "unit", "member"]]);
  });

  test("union, highest wins: a lower direct grant never lowers a higher source, and nothing subtracts", () => {
    const c = ctx({ scoped: { unit: [], group: [], space: [sg(U("google:me"), "editor")], board: [] } });
    expect(ladder({ ctx: c, grant: "viewer" })).toBe("editor");
    expect(ladder({ ctx: c }, { ...me, user: "google:other" })).toBe(null);   // the Space grant is for `me` only
  });

  test("a board can't be more private than its Space: Space general access reaches boards whose own general access is none", () => {
    const open = ctx({ space: { ...space, generalRole: "viewer" }, board: { ...board, memberRole: null } });
    expect(ladder({ ctx: open })).toBe("viewer");
    expect(resolveAccess({ ctx: open }, me, T).sources[0]).toMatchObject({ kind: "general", scope: { type: "space", id: "s-1" } });
    expect(ladder({ ctx: open }, guest)).toBe(null);            // general access is for Unit members only
  });

  test("general access on the board, Space and Group: capped below owner, members only, via any of the Unit's domains", () => {
    const g = ctx({ board: { ...board, memberRole: null }, space: { ...space, generalRole: null }, group: { ...group, generalRole: "commenter" } });
    expect(ladder({ ctx: g })).toBe("commenter");
    expect(resolveAccess({ ctx: g }, me, T).sources[0]).toMatchObject({ kind: "general", scope: { type: "group", id: "g-1" } });
    const owner = ctx({ board: { ...board, memberRole: "owner" }, space: { ...space, generalRole: "owner" } });
    expect(ladder({ ctx: owner })).toBe("editor");   // a stored "owner" general role is capped to editor: general access never gives owner
  });

  test("general access follows every domain of the Unit; another domain gets none", () => {
    const c = ctx({ board: { ...board, memberRole: "viewer" } });
    expect(ladder({ ctx: c }, { user: "google:x", domain: "acme.io" })).toBe("viewer");
    expect(ladder({ ctx: c }, { user: "google:x", domain: "globex.com" })).toBe(null);
    expect(isUnitMember(tenant, { domain: "acme.io" })).toBe(true);
    expect(isUnitMember(tenant, { domain: null })).toBe(false);
  });

  test("invites and links: board scope, capped, live only, `until` is the soonest expiry", () => {
    const rows = {
      ctx: ctx(),
      invites: [{ role: "editor", expiresAt: 5000, revoked: false }, { role: "owner", expiresAt: null, revoked: false }, { role: "editor", expiresAt: 10, revoked: false }, { role: "editor", revoked: true }],
      links: [{ board: "b-1", role: "annotator", expiresAt: 3000, revoked: false }, { board: "b-other", role: "editor", expiresAt: null, revoked: false }, null],
    };
    const a = resolveAccess(rows, guest, T);
    expect(a.ladder).toBe("editor");                     // the owner invite is capped to editor; the expired and revoked ones count for nothing
    expect(a.until).toBe(3000);
    expect(a.sources.map(s => s.kind + ":" + s.role)).toEqual(["invite:editor", "invite:editor", "link:annotator"]);
    expect(resolveAccess({ ...rows, links: [{ board: "b-1", role: "owner", expiresAt: null, revoked: false }] }, guest, T).sources.pop().role).toBe("editor");
  });

  test("a link with a role outside LINK_ROLES (commenter) counts for the highest allowed step at or below it", () => {
    const a = resolveAccess({ ctx: ctx(), links: [{ board: "b-1", role: "commenter", expiresAt: null, revoked: false }] }, guest, T);
    expect(a.ladder).toBe("viewer");
  });

  test("unknown and wrongly-scoped roles count for nothing", () => {
    const c = ctx({ scoped: { unit: [sg(U("google:me"), "viewer")], group: [sg(U("google:me"), "admin")], space: [sg(U("google:me"), "r-ghost")], board: [] } });
    const a = resolveAccess({ ctx: c, grant: "bogus" }, me, T);
    expect(a.ladder).toBe(null);
    expect(a.sources.map(s => s.kind)).toEqual(["unit"]);   // only the member role
  });
});

describe("the Unit", () => {
  test("a Unit admin has every management permission and, by default, no board content", () => {
    const a = resolveAccess({ ctx: ctx() }, { user: "google:root", domain: "acme.com" }, T);
    expect(a.ladder).toBe(null);
    expect([...a.permissions].sort()).toEqual([...MGMT_PERMS].sort());
    expect(resolveAccess({ ctx: ctx() }, { user: "google:root", domain: "acme.com" }, T, { adminBoardContent: true }).ladder).toBe("owner");
  });

  test("admins by user id or by email: the email entry needs a Google user, a verified-domain member, and that email", () => {
    expect(isUnitAdmin(tenant, { user: "google:root" })).toBe(true);
    expect(isUnitAdmin(tenant, { user: "google:b", email: "Boss@acme.com", domain: "acme.com" })).toBe(true);
    expect(isUnitAdmin(tenant, { user: "google:b", email: "boss@acme.com", domain: "evil.com" })).toBe(false);
    expect(isUnitAdmin(tenant, { user: "dev:b", email: "boss@acme.com", domain: "acme.com" })).toBe(false);
    expect(isUnitAdmin(tenant, { user: "email:boss@acme.com" })).toBe(false);
    expect(isUnitAdmin(null, { user: "google:root" })).toBe(false);
  });

  test("a role granted on the Unit reaches every board in it (a custom role at Unit scope)", () => {
    const role = { id: "r-1", tenant: "t-acme", name: "Auditor", base: "viewer", boardRole: "viewer", permissions: ["roles.manage", "delete"], createdAt: 0 };
    const c = ctx({ roles: [role], scoped: { unit: [sg(U("google:kim"), "r-1")], group: [], space: [], board: [] } });
    const a = resolveAccess({ ctx: c }, guest, T);
    expect(a.ladder).toBe("viewer");
    expect([...a.permissions].sort()).toEqual(["board.view", "delete", "roles.manage"]);
  });

  test("the Unit member role can be edited: removing space.create, or giving board content to every member", () => {
    const edit = p => ctx({ roles: [{ id: "member", tenant: "t-acme", name: "Unit member", base: null, boardRole: p.boardRole, permissions: p.permissions, createdAt: 0 }] });
    expect(perms({ ctx: edit({ boardRole: null, permissions: [] }) })).toEqual([]);
    const v = resolveAccess({ ctx: edit({ boardRole: "viewer", permissions: ["board.create"] }) }, me, T);
    expect(v.ladder).toBe("viewer");
    expect([...v.permissions].sort()).toEqual(["board.create", "board.view"]);
    expect(resolveAccess({ ctx: edit({ boardRole: "viewer", permissions: [] }) }, guest, T).ladder).toBe(null);   // members only
  });
});

describe("containers: permissions asked of a Space, a Group, the Unit", () => {
  const spaceCtx = (o = {}) => ({ tenant, board: null, space, group, scoped: { unit: [], group: [], space: [], board: [] }, roles: [], teams: {}, ...o });
  test("Space owner may create boards, manage members, move and delete; not create Spaces or manage roles (a member gets space.create from the member role)", () => {
    const c = spaceCtx({ scoped: { unit: [], group: [], space: [sg(U("google:me"), "owner"), sg(U("google:kim"), "owner")], board: [] } });
    // space.create is the Unit member role's (every member may create a Space at the root), not the Space owner's
    expect(perms({ ctx: c }, guest)).toEqual([...CONTENT_PERMS, "board.create", "delete", "members.manage", "move", "transfer"].sort());
    expect(perms({ ctx: c })).toEqual([...CONTENT_PERMS, "board.create", "delete", "members.manage", "move", "space.create", "transfer"].sort());
  });
  test("Space editor creates boards but does not manage members; Space viewer creates nothing", () => {
    const e = perms({ ctx: spaceCtx({ scoped: { unit: [], group: [], space: [sg(U("google:me"), "editor")], board: [] } }) });
    expect(e).toContain("board.create"); expect(e).not.toContain("members.manage");
    const v = perms({ ctx: spaceCtx({ scoped: { unit: [], group: [], space: [sg(U("google:me"), "viewer")], board: [] } }) });
    expect(v).not.toContain("board.create");
  });
  test("a Group editor can create Spaces in the Group and boards in all its Spaces", () => {
    const c = spaceCtx({ space: null, scoped: { unit: [], group: [sg(U("google:me"), "editor")], space: [], board: [] } });
    const p = perms({ ctx: c });
    expect(p).toContain("space.create"); expect(p).toContain("board.create"); expect(p).not.toContain("members.manage");
  });
  test("a Space's own chain is Space, Group, Unit: a Group owner holds members.manage over the Space", () => {
    expect(perms({ ctx: spaceCtx({ scoped: { unit: [], group: [sg(U("google:me"), "owner")], space: [], board: [] } }) })).toContain("members.manage");
  });
  test("the personal-space owner can create boards there and nowhere else", () => {
    const personal = { ...space, id: "s-me", kind: "personal", owner: "google:me", group: null };
    const mine = spaceCtx({ space: personal, group: null, scoped: { unit: [], group: [], space: [sg(U("google:me"), "owner")], board: [] } });
    expect(perms({ ctx: mine })).toContain("board.create");
    const theirs = spaceCtx({ space: { ...personal, id: "s-other", owner: "google:z" }, group: null });
    expect(perms({ ctx: theirs })).not.toContain("board.create");
  });
  test("an unknown tenant context grants nothing", () => {
    const a = resolveAccess({ ctx: { tenant: null } }, me, T);
    expect([a.ladder, [...a.permissions], a.sources]).toEqual([null, [], []]);
  });
});

describe("permissions.js", () => {
  test("built-in ladder roles at each scope match the journey table", () => {
    const has = (role, scope) => [...(roleDef(role, scope)?.permissions ?? [])].filter(p => MGMT_PERMS.includes(p)).sort();
    expect(has("owner", "group")).toEqual(["board.create", "delete", "members.manage", "move", "space.create", "transfer"]);
    expect(has("editor", "group")).toEqual(["board.create", "space.create"]);
    expect(has("viewer", "group")).toEqual([]);
    expect(has("owner", "space")).toEqual(["board.create", "delete", "members.manage", "move", "transfer"]);
    expect(has("editor", "space")).toEqual(["board.create"]);
    expect(has("owner", "board")).toEqual(["delete", "members.manage", "move", "transfer"]);
    expect(has("editor", "board")).toEqual([]);
  });
  test("roles are valid only where they make sense", () => {
    expect(roleDef("viewer", "unit")).toBe(null);
    expect(roleDef("admin", "space")).toBe(null);
    expect(roleDef("member", "board")).toBe(null);
    expect(roleDef("nope", "board")).toBe(null);
    expect(roleDef(null, "board")).toBe(null);
    expect(roleDef("viewer", "planet")).toBe(null);
  });
  test("a custom role is clipped to its scope and carries exactly its one board ladder role", () => {
    const roles = new Map([["r-1", { id: "r-1", permissions: [...MGMT_PERMS], boardRole: "editor" }], ["r-2", { id: "r-2", permissions: ["delete"], boardRole: "owner" }]]);
    for (const scope of ["unit", "group", "space", "board"]) {
      const d = roleDef("r-1", scope, roles);
      expect([...d.permissions].filter(p => MGMT_PERMS.includes(p)).sort()).toEqual([...ALLOWED_AT[scope]].sort());
      expect(d.ladder).toBe("editor");
    }
    expect(roleDef("r-2", "space", roles).ladder).toBe(null);     // a stored "owner" board role is not trusted
  });
  test("roleProblem: one board ladder role (viewer..editor), distinct management permissions", () => {
    expect(roleProblem({ boardRole: "editor", permissions: ["delete"] })).toBe(null);
    expect(roleProblem({ boardRole: "owner", permissions: [] })).toMatch(/exactly one/);
    expect(roleProblem({ boardRole: null, permissions: [] })).toMatch(/exactly one/);
    expect(roleProblem({ boardRole: null, permissions: [] }, { member: true })).toBe(null);
    expect(roleProblem({ boardRole: "viewer", permissions: ["board.view"] })).toMatch(/management/);
    expect(roleProblem({ boardRole: "viewer", permissions: ["delete", "delete"] })).toMatch(/distinct/);
    expect(roleProblem(null)).toBe("bad role");
  });
});
