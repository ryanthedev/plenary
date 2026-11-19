// Teams and access (server/auth/access.js, PROTOCOL.md § Teams and access, #49): Team CRUD by `team.manage`, the access page and grant writes at every scope,
// the role picker, the last-owner rule, the no-leak rule, the announcements each change owes, and the HTTP routes, over the real tenancy and the memory Registry.
import { test, expect, beforeEach, describe } from "bun:test";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy as makeTenancy } from "../../server/auth/tenancy.js";
import { accessService, LIMITS } from "../../server/auth/access.js";
import { httpRoutes } from "../../server/auth/http.js";
import { sessions as makeSessions } from "../../server/auth/session.js";
import { devAuth } from "../../server/auth/dev.js";
import { mkBoard } from "./fixtures.js";

let r, ten, svc, acme, ann;
const ident = (n, domain = "acme.com") => ({ user: `google:${n}`, name: n, email: `${n}@${domain}`, domain });
const ada = ident("ada"), max = ident("max"), lee = ident("lee"), kim = ident("kim", "partner.io"), root = ident("root");
let product, design, secret, platform, board, infra;
const U = id => ({ type: "user", id });
const T = id => ({ type: "team", id });
const code = p => p.then(() => null, e => e.code ?? e.message);
const grants = async (type, id) => (await r.scopedGrants({ type, id })).map(g => `${g.subject.type}:${g.subject.id}:${g.role}`).sort();
const mk = (registry = r, extra = {}) => accessService({ registry, tenancy: makeTenancy({ registry }), announce: (unit, scope, o) => ann.push({ scope: `${scope.type}:${scope.id}`, revoke: !!o?.revoke }), ...extra });

beforeEach(async () => {
  r = memoryRegistry();
  ten = makeTenancy({ registry: r });
  ann = [];
  svc = mk();
  acme = await r.createTenant({ domain: "acme.com", admins: ["google:root"] });
  for (const p of [ada, max, lee, root]) await r.touchMember(acme.id, { user: p.user, name: p.name, email: p.email });
  product = await r.createGroup({ tenant: acme.id, name: "Product", generalRole: null, owner: "google:ada" });
  design = await r.createSpace({ tenant: acme.id, name: "Design", group: product.id, generalRole: "viewer", owner: "google:ada" });
  secret = await r.createSpace({ tenant: acme.id, name: "Secret roadmap", generalRole: null, owner: "google:root" });
  platform = await r.createSpace({ tenant: acme.id, name: "Platform", generalRole: "viewer" });
  board = await r.createBoard({ tenant: acme.id, title: "Roadmap", space: design.id });
  await r.setGrant(board.id, "google:ada", "owner");
  infra = await r.createTeam({ tenant: acme.id, name: "Infra" });
});

describe("Teams: team.manage at the Unit decides", () => {
  test("a Unit admin creates, renames and deletes; a member, a guest and a user with no Unit are refused", async () => {
    const t = await svc.createTeam(root, { name: "  Design  " });
    expect(t).toMatchObject({ name: "Design", size: 0 });
    expect(await svc.renameTeam(root, t.id, "Design crew")).toMatchObject({ id: t.id, name: "Design crew" });
    for (const who of [max, kim, { user: "dev:z", name: "z", email: null, domain: null }]) {
      expect(await code(svc.createTeam(who, { name: "x" }))).toBe("forbidden");
      expect(await code(svc.renameTeam(who, t.id, "x"))).toBe("forbidden");
      expect(await code(svc.deleteTeam(who, t.id))).toBe("forbidden");
      expect(await code(svc.setMember(who, t.id, ada.user, true))).toBe("forbidden");
    }
    expect((await r.team(t.id)).name).toBe("Design crew");
    await svc.deleteTeam(root, t.id);
    expect(await r.team(t.id)).toBe(null);
    await svc.deleteTeam(root, t.id).then(() => { throw new Error("a deleted team is a refusal"); }, e => expect(e.code).toBe("forbidden"));
  });
  test("a custom Unit role with team.manage lets its holder manage Teams: checked by permission, not role name", async () => {
    const fac = await r.createRole({ tenant: acme.id, name: "Facilitator", boardRole: "viewer", permissions: ["team.manage"] });
    expect(await code(svc.createTeam(max, { name: "x" }))).toBe("forbidden");
    await r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: U(max.user), role: fac.id });
    expect((await svc.createTeam(max, { name: "Ops" })).name).toBe("Ops");
    // team.manage means nothing below the Unit: a Space role carrying it grants nothing there
    const sp = await r.createRole({ tenant: acme.id, name: "SpaceTeams", boardRole: "viewer", permissions: ["team.manage"] });
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: U(lee.user), role: sp.id });
    expect(await code(svc.createTeam(lee, { name: "x" }))).toBe("forbidden");
  });
  test("validation: names 1-200, ids, cursors, queries", async () => {
    for (const name of ["", "   ", "x".repeat(201), 5, null, "a\0b"]) expect(await code(svc.createTeam(root, { name }))).toBe("bad-request");
    expect(await code(svc.listTeams(max, { after: "a\nb" }))).toBe("bad-request");
    expect(await code(svc.listTeams(max, { q: "x".repeat(101) }))).toBe("bad-request");
    expect(await code(svc.setMember(root, infra.id, "", true))).toBe("bad-request");
    expect(await code(svc.setMember(root, infra.id, "a\nb", true))).toBe("bad-request");
  });
  test("any Unit member lists Teams, paged and searchable; a guest is refused; can.create follows team.manage", async () => {
    for (let i = 0; i < 60; i++) await r.createTeam({ tenant: acme.id, name: i % 2 ? `Odd ${i}` : `Even ${i}` });
    const all = []; let after = null, pages = 0;
    do { const p = await svc.listTeams(max, { after }); all.push(...p.teams); after = p.next; pages++; expect(p.can.create).toBe(false); } while (after);
    expect(pages).toBe(2);
    expect(all).toHaveLength(61);
    expect((await svc.listTeams(max, { q: "ODD" })).teams.every(t => /^Odd/.test(t.name))).toBe(true);
    expect((await svc.listTeams(root)).can.create).toBe(true);
    expect(await code(svc.listTeams(kim))).toBe("forbidden");
  });
  test("a Team of another Unit never shows in the list, the page or the directory", async () => {
    const globex = await r.createTenant({ domain: "globex.com" });
    const theirs = await r.createTeam({ tenant: globex.id, name: "Theirs" });
    expect(JSON.stringify(await svc.listTeams(root))).not.toContain("Theirs");
    expect(JSON.stringify(await svc.directory(max, { q: "Theirs" }))).not.toContain("Theirs");
    expect(await code(svc.teamPage(max, theirs.id))).toBe("not-found");
    expect(await code(svc.renameTeam(root, theirs.id, "x"))).toBe("forbidden");
    expect(await code(svc.deleteTeam(root, theirs.id))).toBe("forbidden");
    expect(await code(svc.setMember(root, theirs.id, ada.user, true))).toBe("forbidden");
    expect((await r.team(theirs.id)).name).toBe("Theirs");
  });
});

describe("Team members are Unit members; guests are inert", () => {
  test("add and remove are idempotent; the page lists members by id with names, or the id's plain name", async () => {
    await svc.setMember(root, infra.id, ada.user, true);
    await svc.setMember(root, infra.id, ada.user, true);
    await svc.setMember(root, infra.id, "google:root", true);       // a Unit admin named by id counts, even with no directory row of their own
    const pg = await svc.teamPage(max, infra.id);
    expect(pg.team).toMatchObject({ id: infra.id, name: "Infra", size: 2 });
    expect(pg.members).toEqual([{ user: "google:ada", name: "ada", email: "ada@acme.com" }, { user: "google:root", name: "root", email: "root@acme.com" }]);
    expect(pg.can.manage).toBe(false);
    await svc.setMember(root, infra.id, ada.user, false);
    await svc.setMember(root, infra.id, ada.user, false);
    expect((await svc.teamPage(root, infra.id)).members.map(m => m.user)).toEqual(["google:root"]);
    expect((await svc.teamPage(root, infra.id)).can.manage).toBe(true);
  });
  test("a guest, a never-seen person and another Unit's member are unknown-person; nothing is stored", async () => {
    const globex = await r.createTenant({ domain: "globex.com" });
    await r.touchMember(globex.id, { user: "google:gina", name: "Gina" });
    for (const u of [kim.user, "google:nobody", "google:gina"]) expect(await code(svc.setMember(root, infra.id, u, true))).toBe("unknown-person");
    expect(await r.teamMembers(infra.id)).toEqual([]);
  });
  test("a member page is bounded and paged; a bad cursor is a 400, not a restart", async () => {
    for (let i = 0; i < 55; i++) { const u = `google:u${String(i).padStart(3, "0")}`; await r.touchMember(acme.id, { user: u }); await r.setTeamMember(infra.id, u, true); }
    const a = await svc.teamPage(max, infra.id), b = await svc.teamPage(max, infra.id, a.next);
    expect([a.members.length, b.members.length, b.next]).toEqual([LIMITS.rows, 5, null]);
    expect(await code(svc.teamPage(max, infra.id, "a\nb"))).toBe("bad-request");
  });
});

describe("a Team's grants are the caller's to give: adding or removing a member is granting or revoking each of them", () => {
  const custom = async () => (await r.createRole({ tenant: acme.id, name: "TeamAdmin", boardRole: "viewer", permissions: ["team.manage"] })).id;
  /** max holds team.manage at the Unit, and manages `mine` (owner) but not `theirs`; Infra owns `theirs` and has a member (so it counts) */
  async function setup() {
    const mine = await r.createSpace({ tenant: acme.id, name: "X", owner: "google:ada" }), theirs = await r.createSpace({ tenant: acme.id, name: "Y secret", generalRole: null, owner: "google:ada" });
    await r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: U(max.user), role: await custom() });
    await r.setScopedGrant({ scope: { type: "space", id: mine.id }, subject: U(max.user), role: "owner" });
    await r.setScopedGrant({ scope: { type: "space", id: mine.id }, subject: T(infra.id), role: "viewer" });
    await r.setScopedGrant({ scope: { type: "space", id: theirs.id }, subject: T(infra.id), role: "owner" });
    await r.setTeamMember(infra.id, lee.user, true);
    return { mine, theirs };
  }
  test("a manager of Space X only cannot add themselves (or anyone) to a Team that owns Space Y: the ordinary refusal, nothing about Y", async () => {
    const { theirs } = await setup();
    const hidden = await svc.setMember(max, infra.id, max.user, true).then(() => null, e => e);
    expect(hidden.code).toBe("forbidden");
    expect(hidden.message).toBe("not allowed");
    expect(JSON.stringify(hidden)).not.toMatch(/Y secret|owner/);
    expect(JSON.stringify(hidden)).not.toContain(theirs.id);
    expect(await r.teamMembers(infra.id)).toEqual([lee.user]);
    expect(await code(svc.setMember(max, infra.id, lee.user, false))).toBe("forbidden");             // removing is revoking Y's owner: the same check
    expect(await code(svc.deleteTeam(max, infra.id))).toBe("forbidden");
    expect(await r.team(infra.id)).not.toBe(null);
  });
  test("the refusal is the same whether the Team's other scope exists, is hidden, or is another's: same body as any 403", async () => {
    await setup();
    const a = await svc.setMember(max, infra.id, max.user, true).catch(e => e);
    const b = await svc.setMember(max, "tm-nope00000000", max.user, true).catch(e => e);
    expect([a.code, a.message]).toEqual([b.code, b.message]);
  });
  test("a Unit admin can; so can someone who manages every scope the Team holds", async () => {
    const { theirs } = await setup();
    await svc.setMember(root, infra.id, max.user, true);
    expect(await r.teamMembers(infra.id)).toEqual([lee.user, max.user].sort());
    await svc.setMember(root, infra.id, max.user, false);
    await r.setScopedGrant({ scope: { type: "space", id: theirs.id }, subject: U(max.user), role: "owner" });
    await svc.setMember(max, infra.id, max.user, true);
    expect(await r.teamMembers(infra.id)).toContain(max.user);
    await svc.setMember(max, infra.id, max.user, false);
    expect(await r.teamMembers(infra.id)).toEqual([lee.user]);
  });
  test("a board owner role is not the caller's to give either: a Team with owner on a board needs a Unit admin", async () => {
    await setup();
    await r.setScopedGrant({ scope: { type: "board", id: board.id }, subject: T(infra.id), role: "owner" });
    const ada2 = { ...ada }, fac = await custom();
    await r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: U(ada.user), role: fac });
    expect(await code(svc.setMember(ada2, infra.id, ada.user, true))).toBe("forbidden");
  });
  test("stale roles on a Team's scopes are ignored; an empty Team is open to a team manager", async () => {
    await r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: U(max.user), role: await custom() });
    const t2 = await r.createTeam({ tenant: acme.id, name: "Stale" });
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: T(t2.id), role: "wizard" });
    await svc.setMember(max, t2.id, lee.user, true);
    await svc.setMember(max, infra.id, lee.user, true);
  });
  test("bounded: a Team with more scopes than the cap is refused to a non-admin without reading them all", async () => {
    await r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: U(max.user), role: await custom() });
    let seen = 0;
    const many = new Proxy(r, { get: (t, k) => (k === "scopesOf" ? async (_s, o) => { seen = o.limit; return { scopes: Array.from({ length: o.limit }, (_, i) => ({ type: "board", id: `b${i}`, role: "viewer" })), next: "x" }; } : t[k]) });
    expect(await code(mk(many).setMember(max, infra.id, lee.user, true))).toBe("forbidden");
    expect(seen).toBe(LIMITS.teamScopes + 1);
    expect(await code(mk(many).setMember(root, infra.id, lee.user, true))).toBe(null);          // a Unit admin is not subject to it
  });
  test("granting a Team a role fails exactly as it would for a person", async () => {
    const { mine } = await setup();
    const fac = await r.createRole({ tenant: acme.id, name: "Wide", boardRole: "editor", permissions: ["delete"] });
    await r.setScopedGrant({ scope: { type: "space", id: mine.id }, subject: U(lee.user), role: "editor" });
    for (const [t, who] of [["user", kim.user], ["team", infra.id]]) {
      // bad roles, escalation and non-managers answer alike for either subject kind
      expect(await code(svc.setGrant(max, "space", mine.id, t, who === kim.user ? max.user : who, "god"))).toBe("bad-role");
      expect(await code(svc.setGrant(lee, "space", mine.id, t, t === "user" ? max.user : who, "viewer"))).toBe("forbidden");
    }
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: U(max.user), role: (await r.createRole({ tenant: acme.id, name: "Fac", boardRole: "viewer", permissions: ["members.manage"] })).id });
    for (const [t, id] of [["user", ada.user], ["team", infra.id]]) expect(await code(svc.setGrant(max, "space", platform.id, t, id, fac.id))).toBe("forbidden");
  });
});

describe("directory: the picker's search is the caller's own Unit", () => {
  test("people and Teams by substring, at most 8 each; a guest is refused; another Unit is never searched", async () => {
    const globex = await r.createTenant({ domain: "globex.com" });
    await r.touchMember(globex.id, { user: "google:adam", name: "Adam Globex" });
    for (let i = 0; i < 12; i++) await r.touchMember(acme.id, { user: `google:p${i}`, name: `Pat ${i}` });
    const d = await svc.directory(max, { q: "pat" });
    expect(d.people).toHaveLength(LIMITS.search);
    expect(d.people.every(p => /^Pat/.test(p.name))).toBe(true);
    expect((await svc.directory(max, { q: "ada" })).people.map(p => p.user)).toEqual(["google:ada"]);        // not Adam Globex
    expect((await svc.directory(max, { q: "infra" })).teams.map(t => t.name)).toEqual(["Infra"]);
    expect((await svc.directory(max)).people.length).toBeGreaterThan(0);
    expect(await code(svc.directory(kim, { q: "a" }))).toBe("forbidden");
    expect(await code(svc.directory(max, { q: 5 }))).toBe("bad-request");
  });
});

describe("Teams: freshness (every change announces, revocations never dropped)", () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  test("adding a member announces each scope the Team holds, as an ordinary change; removing, as a revocation", async () => {
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: T(infra.id), role: "editor" });
    await r.setScopedGrant({ scope: { type: "board", id: board.id }, subject: T(infra.id), role: "viewer" });
    await svc.setMember(root, infra.id, max.user, true);
    await svc.settled();
    expect(ann.sort((a, b) => (a.scope < b.scope ? -1 : 1))).toEqual([{ scope: `board:${board.id}`, revoke: false }, { scope: `space:${platform.id}`, revoke: false }].sort((a, b) => (a.scope < b.scope ? -1 : 1)));
    ann.length = 0;
    await svc.setMember(root, infra.id, max.user, false);
    await svc.settled();
    expect(ann.every(a => a.revoke)).toBe(true);
    expect(ann).toHaveLength(2);
  });
  test("deleting a Team announces every scope it held as a revocation, after the delete", async () => {
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: T(infra.id), role: "editor" });
    await r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: T(infra.id), role: (await r.createRole({ tenant: acme.id, name: "R", boardRole: "viewer" })).id });
    await svc.deleteTeam(root, infra.id);
    await svc.settled();
    expect(ann.map(a => a.scope).sort()).toEqual([`space:${platform.id}`, `unit:${acme.id}`].sort());
    expect(ann.every(a => a.revoke)).toBe(true);
  });
  test("a rename and a refused write announce nothing", async () => {
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: T(infra.id), role: "editor" });
    await svc.renameTeam(root, infra.id, "Platform team");
    await svc.setMember(root, infra.id, kim.user, true).catch(() => {});
    await svc.setMember(max, infra.id, ada.user, true).catch(() => {});
    await svc.settled();
    expect(ann).toEqual([]);
  });
  test("a walk over many scopes pages through all of them, and waits (never drops) while the scheduler's backlog is high", async () => {
    for (let i = 0; i < 1200; i++) { const b = await mkBoard(r, { tenant: acme.id }); await r.setScopedGrant({ scope: { type: "board", id: b.id }, subject: T(infra.id), role: "viewer" }); }
    let backlog = LIMITS.backlog + 1, waited = 0;
    const slow = mk(r, { backlog: () => backlog, settled: async () => { waited++; backlog = 0; } });
    await slow.setMember(root, infra.id, max.user, false);
    await slow.settled();
    expect(waited).toBeGreaterThanOrEqual(1);
    expect(ann).toHaveLength(1200);
    expect(ann.every(a => a.revoke)).toBe(true);
  });
  test("a Registry error while paging a revocation is retried; a lasting one is logged, not thrown", async () => {
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: T(infra.id), role: "editor" });
    let fails = 1; const logs = [];
    const flaky = new Proxy(r, { get: (t, k) => (k === "scopesOf" ? async (...a) => { if (fails-- > 0) throw new Error("db down"); return t.scopesOf(...a); } : t[k]) });
    const s = mk(flaky, { log: { warn: (m) => logs.push(m) } });
    await s.setMember(root, infra.id, max.user, false);
    await s.settled();
    expect(ann).toEqual([{ scope: `space:${platform.id}`, revoke: true }]);
    ann.length = 0; fails = 99;
    await s.setMember(root, infra.id, max.user, true);       // the write itself is not undone by an announcement failure
    await s.settled();
    expect(logs.some(m => /team announcement failed/.test(m))).toBe(true);
    expect(await r.teamMembers(infra.id)).toEqual([max.user]);
  });
  test("deleting a Team with grants on more than 5000 scopes is too-large, and changes nothing", async () => {
    const many = new Proxy(r, { get: (t, k) => (k === "scopesOf" ? async () => ({ scopes: Array.from({ length: LIMITS.scopes + 1 }, (_, i) => ({ type: "board", id: `b${i}`, role: "viewer" })), next: null }) : t[k]) });
    expect(await code(mk(many).deleteTeam(root, infra.id))).toBe("too-large");
    expect(await r.team(infra.id)).not.toBe(null);
  });
  test("last owner: a Team that is the only counted owner of a Space can be neither deleted nor emptied, and nothing is announced", async () => {
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: T(infra.id), role: "owner" });
    await svc.setMember(root, infra.id, max.user, true);
    await svc.settled(); ann.length = 0;
    expect(await code(svc.deleteTeam(root, infra.id))).toBe("last-owner");
    expect(await code(svc.setMember(root, infra.id, max.user, false))).toBe("last-owner");
    await svc.settled();
    expect(ann).toEqual([]);
    expect(await r.teamMembers(infra.id)).toEqual([max.user]);
    await svc.setGrant(root, "space", platform.id, "user", ada.user, "owner");       // a second owner: now it can go
    await svc.deleteTeam(root, infra.id);
    expect(await r.team(infra.id)).toBe(null);
  });
});

describe("access page: who has access, through what, and the picker", () => {
  test("a Space owner sees direct people, Team rows, general access and the Group's inherited rows; viewers see them read-only", async () => {
    await r.setScopedGrant({ scope: { type: "space", id: design.id }, subject: T(infra.id), role: "editor" });
    await r.setScopedGrant({ scope: { type: "space", id: design.id }, subject: U(max.user), role: "commenter" });
    await r.setScopedGrant({ scope: { type: "group", id: product.id }, subject: T(infra.id), role: "viewer" });
    await r.setTeamMember(infra.id, lee.user, true);
    const p = await svc.accessPage(ada, "space", design.id);
    expect(p.scope).toMatchObject({ type: "space", id: design.id, name: "Design" });
    expect(p.can.manage).toBe(true);
    expect(p.rows.map(x => [x.subject.type, x.subject.name, x.role, x.roleName, x.via])).toEqual([
      ["team", "Infra", "editor", "Editor", "team"], ["user", "ada", "owner", "Owner", "direct"], ["user", "max", "commenter", "Commenter", "direct"]]);
    expect(p.rows[0].subject.size).toBe(1);
    expect(p.rows.every(x => x.can.change && x.can.remove)).toBe(true);
    expect(p.general).toEqual([{ scope: { type: "space", id: design.id, name: "Design" }, role: "viewer" }]);
    expect(p.inherited).toEqual([{ scope: { type: "group", id: product.id, name: "Product" }, subject: expect.objectContaining({ type: "team", name: "Infra" }), role: "viewer", roleName: "Viewer", via: "inherited" },
      { scope: { type: "group", id: product.id, name: "Product" }, subject: expect.objectContaining({ type: "user", name: "ada" }), role: "owner", roleName: "Owner", via: "inherited" }].sort((a, b) => (a.subject.type < b.subject.type ? -1 : 1)));
    expect(p.roles.map(x => x.id)).toEqual(["viewer", "commenter", "annotator", "editor", "owner"]);
    expect(p.roles.every(x => x.summary && x.people)).toBe(true);
    // lee (a Space viewer via the Infra team and general access) sees who has access, with no controls
    const v = await svc.accessPage(lee, "space", design.id);
    expect(v.can.manage).toBe(false);
    expect(v.rows).toHaveLength(3);
    expect(v.rows.every(x => !x.can.change && !x.can.remove)).toBe(true);
    expect(v.roles).toEqual([]);
  });
  test("the picker lists custom roles valid at the scope, filtered by ALLOWED_AT and by what the caller may give", async () => {
    const fac = await r.createRole({ tenant: acme.id, name: "Facilitator", boardRole: "annotator", permissions: ["members.manage", "board.create"] });
    const wide = await r.createRole({ tenant: acme.id, name: "Wide", boardRole: "editor", permissions: ["delete", "move", "transfer", "members.manage"] });
    const spaceOwner = await svc.accessPage(ada, "space", design.id);
    expect(spaceOwner.roles.map(x => x.name)).toEqual(["Viewer", "Commenter", "Annotator", "Editor", "Owner", "Facilitator", "Wide"]);
    expect(spaceOwner.roles.find(x => x.id === fac.id)).toMatchObject({ custom: true, ladder: "annotator", people: true });
    // a facilitator (members.manage + board.create only, board role annotator) can give neither Owner nor Wide, and no board role above its own (Editor): no escalation
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: U(lee.user), role: fac.id });
    const asLee = await svc.accessPage(lee, "space", platform.id);
    expect(asLee.can.manage).toBe(true);
    expect(asLee.roles.map(x => x.name)).toEqual(["Viewer", "Commenter", "Annotator", "Facilitator"]);
    expect(await code(svc.setGrant(lee, "space", platform.id, "user", max.user, "owner"))).toBe("forbidden");
    expect(await code(svc.setGrant(lee, "space", platform.id, "user", max.user, wide.id))).toBe("forbidden");
    expect(await svc.setGrant(lee, "space", platform.id, "user", max.user, fac.id)).toMatchObject({ role: fac.id, roleName: "Facilitator" });
    // a role that has no meaning at the Space (roles.manage is Unit-only) is simply clipped, still listed; the Unit page lists custom roles only
    const unit = await svc.accessPage(root, "unit", acme.id);
    expect(unit.roles.map(x => x.name)).toEqual(["Facilitator", "Wide"]);
    expect(unit.admins).toEqual([{ user: "google:root", name: "root", email: "root@acme.com" }]);
  });
  test("a board lists its people and Team grants, its Space's general access and inherited rows; custom roles are for Teams only", async () => {
    const fac = await r.createRole({ tenant: acme.id, name: "Facilitator", boardRole: "annotator", permissions: ["members.manage"] });
    await r.setScopedGrant({ scope: { type: "board", id: board.id }, subject: T(infra.id), role: "viewer" });
    await r.setGrant(board.id, max.user, "editor");
    const p = await svc.accessPage(ada, "board", board.id);
    expect(p.rows.map(x => `${x.subject.type}:${x.subject.name}:${x.role}`)).toEqual(["team:Infra:viewer", "user:ada:owner", "user:max:editor"]);
    expect(p.roles.map(x => x.id)).toEqual(["viewer", "commenter", "annotator", "editor", fac.id]);        // Owner only for a Unit admin (today's rule)
    expect(p.roles.find(x => x.id === fac.id).people).toBe(false);
    expect(p.general.map(g => g.scope.type)).toEqual(["space"]);
    expect(p.inherited.map(g => g.scope.type)).toEqual(["space", "group"]);
    const asAdmin = await svc.accessPage(root, "board", board.id);                                          // a Unit admin may give Owner on a board
    expect(asAdmin.roles.map(x => x.id)).toContain("owner");
    expect(asAdmin.rows.every(x => x.can.change)).toBe(true);
  });
});

describe("grant writes: add, change, remove, idempotency, announcements", () => {
  test("add a person and a Team; change the role; remove; each announces the scope, a demotion or removal as a revocation, a repeat as nothing", async () => {
    const put = (st, sid, role) => svc.setGrant(ada, "space", design.id, st, sid, role);
    expect(await put("user", max.user, "viewer")).toMatchObject({ subject: { type: "user", id: max.user, name: "max" }, role: "viewer", via: "direct" });
    expect(await put("team", infra.id, "annotator")).toMatchObject({ subject: { type: "team", name: "Infra" }, via: "team" });
    expect(ann).toEqual([{ scope: `space:${design.id}`, revoke: false }, { scope: `space:${design.id}`, revoke: false }]);
    ann.length = 0;
    await put("user", max.user, "viewer");                                           // same role: nothing changes, nothing announced
    expect(ann).toEqual([]);
    await put("user", max.user, "editor");                                           // up: ordinary
    await put("user", max.user, "commenter");                                        // down: a revocation
    await put("team", infra.id, "annotator");                                        // same
    expect(ann.map(a => a.revoke)).toEqual([false, true]);
    ann.length = 0;
    expect(await svc.setGrant(ada, "space", design.id, "user", max.user, null)).toBe(null);
    expect(await svc.setGrant(ada, "space", design.id, "user", max.user, null)).toBe(null);      // gone already: idempotent
    expect(ann).toEqual([{ scope: `space:${design.id}`, revoke: true }]);
    expect(await grants("space", design.id)).toEqual([`team:${infra.id}:annotator`, "user:google:ada:owner"]);
  });
  test("groups and the Unit work the same way; the Unit takes custom roles only", async () => {
    const fac = await r.createRole({ tenant: acme.id, name: "Facilitator", boardRole: "annotator", permissions: ["board.create"] });
    await svc.setGrant(ada, "group", product.id, "user", max.user, "editor");
    expect(await grants("group", product.id)).toContain("user:google:max:editor");
    expect(await code(svc.setGrant(root, "unit", acme.id, "user", max.user, "editor"))).toBe("bad-role");     // a ladder role is not a Unit role
    expect(await code(svc.setGrant(root, "unit", acme.id, "user", max.user, "admin"))).toBe("bad-role");
    expect(await code(svc.setGrant(root, "unit", acme.id, "user", max.user, "member"))).toBe("bad-role");
    await svc.setGrant(root, "unit", acme.id, "user", max.user, fac.id);
    await svc.setGrant(root, "unit", acme.id, "team", infra.id, fac.id);
    expect(await grants("unit", acme.id)).toEqual([`team:${infra.id}:${fac.id}`, `user:google:max:${fac.id}`]);
    expect(ann.map(a => a.scope)).toEqual([`group:${product.id}`, `unit:${acme.id}`, `unit:${acme.id}`]);
  });
  test("a viewer, an editor, a stranger, a guest and a user with no Unit cannot change access, with the one refusal", async () => {
    await r.setScopedGrant({ scope: { type: "space", id: design.id }, subject: U(lee.user), role: "editor" });
    for (const who of [max, lee, kim, { user: "dev:z", name: "z", email: null, domain: null }]) {
      expect(await code(svc.setGrant(who, "space", design.id, "user", max.user, "editor"))).toBe("forbidden");
      expect(await code(svc.setGrant(who, "space", design.id, "user", ada.user, null))).toBe("forbidden");
    }
    expect(await grants("space", design.id)).toEqual(["user:google:ada:owner", "user:google:lee:editor"]);
    expect(ann).toEqual([]);
  });
  test("subjects: a guest or never-seen person is unknown-person; a Team of another Unit or an unknown Team is a refusal; removal needs no directory row", async () => {
    const globex = await r.createTenant({ domain: "globex.com" });
    const theirs = await r.createTeam({ tenant: globex.id, name: "Theirs" });
    for (const u of [kim.user, "google:nobody"]) expect(await code(svc.setGrant(ada, "space", design.id, "user", u, "viewer"))).toBe("unknown-person");
    for (const t of [theirs.id, "tm-nope00000000"]) expect(await code(svc.setGrant(ada, "space", design.id, "team", t, "viewer"))).toBe("forbidden");
    await r.setScopedGrant({ scope: { type: "space", id: design.id }, subject: U("google:old"), role: "viewer" });     // a grant older than the directory
    await svc.setGrant(ada, "space", design.id, "user", "google:old", null);
    expect(await grants("space", design.id)).toEqual(["user:google:ada:owner"]);
  });
  test("a guest at board scope: an existing guest's role can be changed or cleared by the owner (can.change agrees), and a guest can be given a board role; above a board a guest still cannot be added", async () => {
    await r.setGrant(board.id, kim.user, "editor");
    const row = (await svc.accessPage(ada, "board", board.id)).rows.find(x => x.subject.id === kim.user);
    expect(row).toMatchObject({ role: "editor", can: { change: true, remove: true } });
    expect(await svc.setGrant(ada, "board", board.id, "user", kim.user, "viewer")).toMatchObject({ role: "viewer" });
    expect(await r.grant(board.id, kim.user)).toBe("viewer");
    // a new guest: accepted once they redeemed a link of this board
    const lk = await r.createLink({ board: board.id, role: "viewer", by: ada.user });
    expect(await code(svc.setGrant(ada, "board", board.id, "user", "google:newguest", "commenter"))).toBe("unknown-person");
    await r.addLinkUse(lk.id, "google:newguest");
    expect(await svc.setGrant(ada, "board", board.id, "user", "google:newguest", "commenter")).toMatchObject({ role: "commenter" });
    await svc.setGrant(ada, "board", board.id, "user", kim.user, null);
    expect(await r.grant(board.id, kim.user)).toBe(null);
    expect(await code(svc.setGrant(ada, "space", design.id, "user", kim.user, "viewer"))).toBe("unknown-person");
    // a stale guest row above a board can still be changed or cleared: no directory row is needed for an existing grant
    await r.setScopedGrant({ scope: { type: "space", id: design.id }, subject: U(kim.user), role: "editor" });
    const stale = (await svc.accessPage(ada, "space", design.id)).rows.find(x => x.subject.id === kim.user);
    expect(stale.can.change).toBe(true);
    expect(await svc.setGrant(ada, "space", design.id, "user", kim.user, "viewer")).toMatchObject({ role: "viewer" });
  });
  test("a NEW person grant on a board needs a person the server knows: directory, link use or an existing grant; email:, garbage, another Unit's member and never-seen ids are refused", async () => {
    const globex = await r.createTenant({ domain: "globex.com" });
    await r.touchMember(globex.id, { user: "google:gina", name: "Gina" });
    await r.addTenantAdmin(acme.id, "email:zed@acme.com");
    for (const u of ["email:zed@acme.com", "email:", "google:nobody", "google:gina", "dev:ADA", "x".repeat(201), "a\0b"]) {
      expect([u.slice(0, 12), await code(svc.setGrant(ada, "board", board.id, "user", u, "viewer"))]).toEqual([u.slice(0, 12), u.includes("\0") || u.length > 200 ? "bad-request" : "unknown-person"]);
      expect(await r.grant(board.id, u)).toBe(null);
    }
    expect(await svc.setGrant(ada, "board", board.id, "user", max.user, "viewer")).toMatchObject({ role: "viewer" });          // in the directory
    expect(await svc.setGrant(root, "board", board.id, "user", "google:root", "viewer").catch(e => e.code)).not.toBe("unknown-person");   // an admin named by id
  });
  test("an `email:` admin entry (not yet seen) is not a person: it cannot be added to a Team", async () => {
    await r.addTenantAdmin(acme.id, "email:zed@acme.com");
    expect(await code(svc.setMember(root, infra.id, "email:zed@acme.com", true))).toBe("unknown-person");
    expect(await code(svc.setGrant(ada, "space", design.id, "user", "email:zed@acme.com", "viewer"))).toBe("unknown-person");
    expect(await r.teamMembers(infra.id)).toEqual([]);
  });
  test("validation: roles, subject types, ids", async () => {
    expect(await code(svc.setGrant(ada, "space", design.id, "user", max.user, "god"))).toBe("bad-role");
    expect(await code(svc.setGrant(ada, "space", design.id, "user", max.user, ""))).toBe("bad-request");
    expect(await code(svc.setGrant(ada, "space", design.id, "user", max.user, 5))).toBe("bad-request");
    expect(await code(svc.setGrant(ada, "space", design.id, "robot", max.user, "viewer"))).toBe("bad-request");
    expect(await code(svc.setGrant(ada, "space", design.id, "team", "a b", "viewer"))).toBe("bad-request");
    expect(await code(svc.setGrant(ada, "planet", design.id, "user", max.user, "viewer"))).toBe("forbidden");
  });
  test("a stale stored role (valid nowhere) can be cleared by any manager and counts for nothing", async () => {
    await r.setScopedGrant({ scope: { type: "space", id: design.id }, subject: U(max.user), role: "wizard" });
    const p = await svc.accessPage(ada, "space", design.id);
    const row = p.rows.find(x => x.subject.id === max.user);
    expect(row).toMatchObject({ role: "wizard", roleName: "wizard", can: { change: true, remove: true } });
    await svc.setGrant(ada, "space", design.id, "user", max.user, null);
    expect(await grants("space", design.id)).toEqual(["user:google:ada:owner"]);
  });
  test("a personal space's access is its owner's own: no controls, writes refused", async () => {
    const mine = await r.ensurePersonalSpace(acme.id, max.user);
    const p = await svc.accessPage(max, "space", mine.id);
    expect(p).toMatchObject({ can: { manage: false }, roles: [], scope: { personal: true } });
    expect(await code(svc.setGrant(max, "space", mine.id, "user", ada.user, "viewer"))).toBe("forbidden");
    expect(await code(svc.setGrant(root, "space", mine.id, "user", ada.user, "viewer"))).toBe("forbidden");
  });
});

describe("board scope keeps today's rules", () => {
  test("a board owner grants up to editor and may change another owner's grant only their own; only a Unit admin gives owner", async () => {
    expect(await svc.setGrant(ada, "board", board.id, "user", max.user, "editor")).toMatchObject({ role: "editor" });
    expect(await r.grant(board.id, max.user)).toBe("editor");
    expect(await code(svc.setGrant(ada, "board", board.id, "user", lee.user, "owner"))).toBe("forbidden");
    await r.setGrant(board.id, lee.user, "owner");
    expect(await code(svc.setGrant(ada, "board", board.id, "user", lee.user, "viewer"))).toBe("forbidden");        // another owner's grant
    expect(await code(svc.setGrant(ada, "board", board.id, "user", lee.user, null))).toBe("forbidden");
    const row = (await svc.accessPage(ada, "board", board.id)).rows.find(x => x.subject.id === lee.user);
    expect(row.can).toEqual({ change: false, remove: false });
    expect(await code(svc.setGrant(ada, "board", board.id, "user", ada.user, "editor"))).toBe(null);               // their own: allowed (another owner remains)
    expect(ann.some(a => a.scope === `board:${board.id}`)).toBe(true);
  });
  test("a Team on a board; a custom role only for Teams; a person gets bad-role for it", async () => {
    const fac = await r.createRole({ tenant: acme.id, name: "Facilitator", boardRole: "annotator", permissions: ["members.manage"] });
    await svc.setGrant(ada, "board", board.id, "team", infra.id, "viewer");
    await svc.setGrant(ada, "board", board.id, "team", infra.id, fac.id);
    expect(await r.scopedGrants({ type: "board", id: board.id })).toEqual([{ subject: T(infra.id), role: fac.id }]);
    expect(await code(svc.setGrant(ada, "board", board.id, "user", max.user, fac.id))).toBe("bad-role");
    expect(await code(svc.setGrant(ada, "board", board.id, "team", infra.id, "owner"))).toBe("forbidden");
  });
  test("an editor, a viewer and a stranger cannot manage a board's access; an unknown board is the same not-found", async () => {
    await r.setGrant(board.id, lee.user, "editor");
    for (const who of [lee, max]) expect(await code(svc.setGrant(who, "board", board.id, "user", max.user, "viewer"))).toBe("forbidden");
    expect(await code(svc.accessPage(kim, "board", board.id))).toBe("not-found");
    expect(await code(svc.accessPage(ada, "board", "b-nope000000000000"))).toBe("not-found");
  });
});

describe("last owner at Space and Group", () => {
  test("the last counted owner of a Space or Group is neither removed nor demoted (409), whoever asks, a Unit admin included", async () => {
    for (const [type, id, owner] of [["space", design.id, ada], ["group", product.id, ada]]) {
      for (const role of [null, "editor"]) {
        expect(await code(svc.setGrant(ada, type, id, "user", owner.user, role))).toBe("last-owner");
      }
      expect(await grants(type, id)).toContain("user:google:ada:owner");
    }
    expect(await code(svc.setGrant(root, "space", secret.id, "user", "google:root", null))).toBe("last-owner");
  });
  test("two owners racing to remove each other leave one; a Team owner counts while it has a member", async () => {
    await svc.setGrant(ada, "space", design.id, "user", max.user, "owner");
    const res = await Promise.allSettled([svc.setGrant(ada, "space", design.id, "user", ada.user, null), svc.setGrant(max, "space", design.id, "user", max.user, null)]);
    expect(res.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(res.find(x => x.status === "rejected").reason.code).toBe("last-owner");
    expect((await grants("space", design.id)).filter(g => g.endsWith(":owner"))).toHaveLength(1);
    // an empty Team does not guard
    const owner = (await grants("space", design.id)).find(g => g.endsWith(":owner")).slice("user:".length, -":owner".length);
    const who = [ada, max].find(p => p.user === owner);
    await svc.setGrant(who, "space", design.id, "team", infra.id, "owner");
    expect(await code(svc.setGrant(who, "space", design.id, "user", owner, null))).toBe("last-owner");
    await svc.setMember(root, infra.id, lee.user, true);
    expect(await svc.setGrant(who, "space", design.id, "user", owner, null)).toBe(null);
  });
});

describe("no leaks: hidden, unknown and other-Unit ids answer alike and cost the same", () => {
  const counted = () => {
    const calls = [];
    const reg = new Proxy(r, { get: (t, k) => (typeof t[k] === "function" ? (...a) => { calls.push(String(k)); return t[k](...a); } : t[k]) });
    const s = accessService({ registry: reg, tenancy: makeTenancy({ registry: reg }), announce: () => {} });
    return { run: async f => { calls.length = 0; const res = await f(s).then(() => "ok", e => e.code ?? e.message); return [res, [...calls].sort().join(",")]; } };
  };
  test("GET and PUT/DELETE at a Space, Group, board and Team: one answer, one cost, whatever the id", async () => {
    const globex = await r.createTenant({ domain: "globex.com" });
    const fSpace = await r.createSpace({ tenant: globex.id, name: "Theirs" }), fGroup = await r.createGroup({ tenant: globex.id, name: "TheirG", generalRole: "viewer" });
    const fBoard = await r.createBoard({ tenant: globex.id, space: fSpace.id }), fTeam = await r.createTeam({ tenant: globex.id, name: "TheirT" });
    const hidGroup = await r.createGroup({ tenant: acme.id, name: "Hidden group", generalRole: null, owner: "google:ada" });
    const hidBoard = await r.createBoard({ tenant: acme.id, space: secret.id });
    const { run } = counted();
    const cases = {
      "GET space": [id => s => s.accessPage(max, "space", id), [secret.id, "s-nope00000000", fSpace.id]],
      "GET group": [id => s => s.accessPage(max, "group", id), [hidGroup.id, "g-nope00000000", fGroup.id]],
      "GET board": [id => s => s.accessPage(max, "board", id), [hidBoard.id, "b-nope000000000000", fBoard.id]],
      "PUT space": [id => s => s.setGrant(max, "space", id, "user", lee.user, "viewer"), [secret.id, "s-nope00000000", fSpace.id]],
      "DELETE group": [id => s => s.setGrant(max, "group", id, "user", lee.user, null), [hidGroup.id, "g-nope00000000", fGroup.id]],
      "PUT board": [id => s => s.setGrant(max, "board", id, "user", lee.user, "viewer"), [hidBoard.id, "b-nope000000000000", fBoard.id]],
      "GET team": [id => s => s.teamPage(max, id), ["tm-nope00000000", fTeam.id]],
      "PATCH team": [id => s => s.renameTeam(max, id, "x"), [infra.id, "tm-nope00000000", fTeam.id]],
      "DELETE team": [id => s => s.deleteTeam(max, id), [infra.id, "tm-nope00000000", fTeam.id]],
      "PUT member": [id => s => s.setMember(max, id, lee.user, true), [infra.id, "tm-nope00000000", fTeam.id]],
    };
    for (const [name, [mkcase, ids]] of Object.entries(cases)) {
      const seen = new Set();
      for (const id of ids) seen.add(JSON.stringify(await run(mkcase(id))));
      expect([name, seen.size]).toEqual([name, 1]);
    }
  });
  test("the manager of a Space they cannot open learns no name: the page shows the scope without it", async () => {
    // root is a Unit admin: manages every Space, opens none of the private ones while admin board content is off
    const priv = await r.createSpace({ tenant: acme.id, name: "Ada private", generalRole: null, owner: "google:ada" });
    const p = await svc.accessPage(root, "space", priv.id);
    expect(p.can.manage).toBe(true);
    expect(p.scope).toEqual({ type: "space", id: priv.id });
    expect(p.general).toEqual([]);
    expect(p.inherited).toEqual([]);
    expect(JSON.stringify(p)).not.toContain("Ada private");
  });
  test("a Space's Group name and grants appear only to someone who can open the Group", async () => {
    await r.setScopedGrant({ scope: { type: "space", id: design.id }, subject: U(max.user), role: "viewer" });
    const p = await svc.accessPage(max, "space", design.id);
    expect(JSON.stringify(p)).not.toContain("Product");
    await r.setScopedGrant({ scope: { type: "group", id: product.id }, subject: U(max.user), role: "viewer" });
    expect(JSON.stringify(await svc.accessPage(max, "space", design.id))).toContain("Product");
  });
});

describe("over HTTP", () => {
  let routes;
  const ORIGIN = "https://plenary.test";
  const config = { cookieKey: "k".repeat(32), postLoginUrl: ORIGIN + "/", boardUrl: ORIGIN + "/b/{board}", publicUrl: ORIGIN };
  const api = async (tok, path, method = "GET", body) => {
    const res = await routes(new Request(ORIGIN + path, { method, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
    return { status: res.status, text: await res.text(), json: () => JSON.parse(res.status === 204 ? "null" : "{}") };
  };
  const J = async (tok, path, method, body) => { const x = await api(tok, path, method, body); return { status: x.status, body: x.text ? JSON.parse(x.text) : null }; };
  beforeEach(async () => {
    const dev = devAuth({ enabled: true, tokens: { ada: { name: "ada", domain: "acme.com", email: "ada@acme.com" }, max: { name: "max", domain: "acme.com", email: "max@acme.com" }, kim: { name: "kim", email: "kim@partner.io" }, root: { name: "root", domain: "acme.com", email: "root@acme.com" } } });
    for (const u of ["ada", "max", "root"]) await r.touchMember(acme.id, { user: `dev:${u}`, name: u, email: `${u}@acme.com` });
    await r.addTenantAdmin(acme.id, "dev:root");
    await r.setScopedGrant({ scope: { type: "space", id: design.id }, subject: U("dev:ada"), role: "owner" });
    routes = httpRoutes({ registry: r, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy: ten, config, dev,
      access: accessService({ registry: r, tenancy: ten, announce: (unit, scope, o) => ann.push({ scope: `${scope.type}:${scope.id}`, revoke: !!o?.revoke }) }) });
  });
  test("401 without a token on every route", async () => {
    for (const [m, p] of [["GET", "/teams"], ["POST", "/teams"], ["GET", "/teams/x"], ["PATCH", "/teams/x"], ["DELETE", "/teams/x"], ["PUT", "/teams/x/members/u"], ["DELETE", "/teams/x/members/u"],
      ["GET", "/directory"], ["GET", "/access/space/x"], ["PUT", "/access/space/x/grants/user/u"], ["DELETE", "/access/space/x/grants/user/u"]])
      expect([m, p, (await api(null, p, m, m === "GET" || m === "DELETE" ? undefined : {})).status]).toEqual([m, p, 401]);
  });
  test("Teams: create 201, list, page, rename, add member 204, remove 204, delete 204, the refusals", async () => {
    const c = await J("root", "/teams", "POST", { name: "Design" });
    expect(c.status).toBe(201);
    const id = c.body.team.id;
    expect((await J("max", "/teams", "POST", { name: "x" })).status).toBe(403);
    expect((await J("kim", "/teams")).status).toBe(403);
    expect((await J("max", "/teams?q=desi")).body.teams.map(t => t.id)).toContain(id);
    expect((await J("max", "/teams?after=a%0Ab")).status).toBe(400);
    expect((await J("root", `/teams/${id}`, "PATCH", { name: "Design crew" })).body.team.name).toBe("Design crew");
    expect((await api("root", `/teams/${id}/members/${encodeURIComponent("dev:ada")}`, "PUT")).status).toBe(204);
    expect((await api("root", `/teams/${id}/members/${encodeURIComponent("dev:ada")}`, "PUT")).status).toBe(204);
    expect((await J("root", `/teams/${id}/members/${encodeURIComponent("dev:kim")}`, "PUT"))).toEqual({ status: 400, body: { error: "unknown-person" } });
    expect((await J("max", `/teams/${id}`)).body).toMatchObject({ team: { name: "Design crew", size: 1 }, can: { manage: false }, members: [{ user: "dev:ada", name: "ada" }] });
    expect((await api("root", `/teams/${id}/members/${encodeURIComponent("dev:ada")}`, "DELETE")).status).toBe(204);
    expect((await J("root", `/teams/${id}`, "PATCH", { name: "x", extra: 1 }))).toEqual({ status: 400, body: { error: "unknown-field", field: "extra" } });
    expect((await api("root", `/teams/${id}`, "DELETE")).status).toBe(204);
    expect((await J("max", `/teams/${id}`)).status).toBe(404);
    expect((await J("root", `/teams/${id}`, "PATCH", { name: "x" })).status).toBe(403);
  });
  test("access: page, put (200 row), change, delete 204, bad-role 400, last-owner 409, hidden 404 / 403 byte for byte", async () => {
    const p = await J("ada", `/access/space/${design.id}`);
    expect(p.status).toBe(200);
    expect(p.body.can.manage).toBe(true);
    const u = encodeURIComponent("dev:max");
    const put = await J("ada", `/access/space/${design.id}/grants/user/${u}`, "PUT", { role: "editor" });
    expect(put).toMatchObject({ status: 200, body: { row: { subject: { id: "dev:max", name: "max" }, role: "editor", roleName: "Editor", via: "direct" } } });
    expect((await J("ada", `/access/space/${design.id}/grants/team/${infra.id}`, "PUT", { role: "viewer" })).body.row.subject.name).toBe("Infra");
    expect((await J("ada", `/access/space/${design.id}/grants/user/${u}`, "PUT", { role: "god" }))).toEqual({ status: 400, body: { error: "bad-role" } });
    expect((await J("ada", `/access/space/${design.id}/grants/user/${u}`, "PUT", {})).status).toBe(400);
    expect((await J("ada", `/access/space/${design.id}/grants/user/${u}`, "PUT", { role: "viewer", x: 1 })).body.error).toBe("unknown-field");
    expect((await api("ada", `/access/space/${design.id}/grants/user/${u}`, "DELETE")).status).toBe(204);
    const solo = await r.createSpace({ tenant: acme.id, name: "Solo", owner: "dev:ada" });
    expect((await J("ada", `/access/space/${solo.id}/grants/user/${encodeURIComponent("dev:ada")}`, "DELETE"))).toEqual({ status: 409, body: { error: "last-owner" } });
    const hidden = [await J("max", `/access/space/${secret.id}`), await J("max", "/access/space/s-nope00000000"), await J("kim", `/access/space/${secret.id}`)];
    expect(new Set(hidden.map(h => JSON.stringify(h))).size).toBe(1);
    expect(hidden[0].status).toBe(404);
    const w = [await J("max", `/access/space/${secret.id}/grants/user/${u}`, "PUT", { role: "viewer" }), await J("max", `/access/space/s-nope00000000/grants/user/${u}`, "PUT", { role: "viewer" })];
    expect(new Set(w.map(h => JSON.stringify(h))).size).toBe(1);
    expect(w[0].status).toBe(403);
    expect((await J("ada", "/access/planet/x")).status).toBe(404);
  });
  test("directory: people and Teams of the caller's Unit; a guest 403", async () => {
    const d = await J("max", "/directory?q=ad");
    expect(d.body.people.map(x => x.user)).toContain("dev:ada");
    expect((await J("kim", "/directory")).status).toBe(403);
    expect((await J("max", "/directory?q=" + "x".repeat(101))).status).toBe(400);
  });
  test("a Team delete that would orphan a Space is 409 last-owner; too many scopes is 409 too-large", async () => {
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: T(infra.id), role: "owner" });
    await r.setTeamMember(infra.id, "google:lee", true);
    expect(await J("root", `/teams/${infra.id}`, "DELETE")).toEqual({ status: 409, body: { error: "last-owner" } });
    expect(await J("root", `/teams/${infra.id}/members/google%3Alee`, "DELETE")).toEqual({ status: 409, body: { error: "last-owner" } });
  });
});
