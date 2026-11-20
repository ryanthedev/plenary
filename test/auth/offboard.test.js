// Leaver offboarding (server/auth/offboard.js, PROTOCOL.md § Leaver offboarding, #55): what a leaver solely owns, per-item reassignment with defaults, who may do it
// (`members.manage` at the Unit, the owner role grantable at the item), the removal that refuses while anything is left, and what a removed person is to everyone else.
import { test, expect, beforeEach, describe } from "bun:test";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy as makeTenancy } from "../../server/auth/tenancy.js";
import { spaceService } from "../../server/auth/spaces.js";
import { homeService } from "../../server/auth/home.js";
import { offboardService } from "../../server/auth/offboard.js";
import { httpRoutes } from "../../server/auth/http.js";
import { sessions as makeSessions } from "../../server/auth/session.js";
import { devAuth } from "../../server/auth/dev.js";
import { mkBoard } from "./fixtures.js";
import { identityKey, roleCache } from "../../server/auth/tenancy.js";

const ident = (n, domain = "acme.com") => ({ user: `google:${n}`, name: n[0].toUpperCase() + n.slice(1), email: `${n}@${domain}`, domain });
const root = ident("root"), ada = ident("ada"), sam = ident("sam"), bob = ident("bob"), cy = ident("cy"), kim = ident("kim", "partner.io");
const code = p => p.then(() => null, e => e.code ?? e.message);
let clock, r, ten, manageOnly, off, acme, fieldNotes, group, shared, samSpace, secret, noted, announced, manager;

beforeEach(async () => {
  clock = { t: Date.UTC(2026, 10, 11) };
  r = memoryRegistry({ now: () => clock.t });
  ten = makeTenancy({ registry: r, now: () => clock.t, adminBoardContent: true });          // root can open personal spaces; the manage-only case builds its own below
  manageOnly = makeTenancy({ registry: r, now: () => clock.t });
  announced = []; manager = null;
  off = offboardService({ registry: r, tenancy: ten, announce: (unit, scope, o) => announced.push([scope.type, scope.id, !!o?.revoke]), managerOf: async () => manager });
  acme = await r.createTenant({ domain: "acme.com", admins: ["google:root"] });
  for (const p of [root, ada, sam, bob, cy]) await r.touchMember(acme.id, { user: p.user, name: p.name, email: p.email });
  samSpace = await r.ensurePersonalSpace(acme.id, sam.user);
  secret = await mkBoard(r, { tenant: acme.id, title: "Secret plan", space: samSpace.id, owner: sam.user });
  await r.setGrant(secret.id, kim.user, "editor");                                    // an outside guest
  fieldNotes = await r.createSpace({ tenant: acme.id, name: "Field notes", generalRole: "viewer", owner: sam.user });
  noted = await mkBoard(r, { tenant: acme.id, title: "Interview notes", space: fieldNotes.id, owner: sam.user });
  group = await r.createGroup({ tenant: acme.id, name: "Research", owner: sam.user });
  shared = await r.createSpace({ tenant: acme.id, name: "Shared", generalRole: "viewer", owner: sam.user });
  await r.setScopedGrant({ scope: { type: "space", id: shared.id }, subject: { type: "user", id: ada.user }, role: "owner" });
});

const moveAll2 = async (svc, to = ada.user, who = root) => {
  for (const i of (await svc.list(who, sam.user)).items.filter(i => !i.personal)) await svc.reassign(who, sam.user, { type: i.type, id: i.id, to });
};
const moveAll = async (to = ada.user, who = root) => {
  const page = await off.list(who, sam.user);
  for (const i of page.items.filter(i => !i.personal)) await off.reassign(who, sam.user, { type: i.type, id: i.id, to });
};

describe("the list", () => {
  test("names what Sam solely owns (personal space, Space, Group) and not the Space he shares; counts boards, never titles; defaults to the remover", async () => {
    const out = await off.list(root, sam.user);
    expect(out.items.map(i => [i.type, i.name, i.personal, i.boards ?? null]).sort()).toEqual([["group", "Research", false, null], ["space", "Field notes", false, 1], ["space", "Sam's space", true, 1]]);
    expect(out.items.filter(i => !i.personal).every(i => i.can.reassign)).toBe(true);
    expect(out.items.find(i => i.personal).can).toEqual({ reassign: false, handover: true, why: "Goes with the removal" });
    expect(out.defaults).toEqual({ recipient: { id: root.user, name: "Root" }, reason: "remover" });
    expect(out.member).toEqual({ id: sam.user, name: "Sam", email: "sam@acme.com", removed: false });
    expect(out.canRemove).toBe(false);
    expect(JSON.stringify(out)).not.toContain("Secret plan");
    expect(JSON.stringify(out)).not.toContain("Interview notes");
  });
  test("the manager seam: a live manager is the default; an unknown, removed or self manager falls back to the remover", async () => {
    manager = ada.user;
    expect((await off.list(root, sam.user)).defaults).toEqual({ recipient: { id: ada.user, name: "Ada" }, reason: "manager" });
    manager = "google:nobody";
    expect((await off.list(root, sam.user)).defaults.reason).toBe("remover");
    manager = sam.user;
    expect((await off.list(root, sam.user)).defaults.reason).toBe("remover");
  });
  test("a leaver with nothing owned lists nothing, and an admin is blocked from removal", async () => {
    expect((await off.list(root, bob.user)).items.length).toBe(1 - 1 + (await r.personalSpace(acme.id, bob.user) ? 1 : 0));
    const a = await off.list(root, root.user);
    expect(a.blocked).toBe("admin");
    expect(a.canRemove).toBe(false);
  });
  test("pages by cursor and refuses a malformed one", async () => {
    for (let i = 0; i < 3; i++) await r.createSpace({ tenant: acme.id, name: "X" + i, owner: sam.user });
    const p1 = await off.list(root, sam.user);
    expect(p1.items.length).toBe(6);
    expect(await code(off.list(root, sam.user, "garbage"))).toBe("bad-request");
    expect((await off.list(root, sam.user, p1.items[0].type + "\n" + p1.items[0].id)).items.length).toBe(5);
  });
  test("an unknown person is not-found; a caller without members.manage, a guest and a stranger are forbidden", async () => {
    expect(await code(off.list(root, "google:nobody"))).toBe("not-found");
    for (const who of [bob, kim, ident("zed", "elsewhere.io")]) expect(await code(off.list(who, sam.user))).toBe("forbidden");
  });
});

describe("who may reassign (permissions, never role names)", () => {
  const give = async (who, perms, boardRole = "editor") => {
    const role = await r.createRole({ tenant: acme.id, name: "People", boardRole, permissions: perms });
    await r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: { type: "user", id: who.user }, role: role.id });
  };
  test("a members.manage holder without the owner role's permissions sees every item as not reassignable, and a reassign is forbidden", async () => {
    await give(cy, ["members.manage"]);
    const out = await off.list(cy, sam.user);
    expect(out.items.length).toBe(3);
    expect(out.items.every(i => !i.can.reassign && i.can.why)).toBe(true);
    expect(await code(off.reassign(cy, sam.user, { type: "space", id: fieldNotes.id, to: ada.user }))).toBe("forbidden");
    expect((await r.scopedGrant({ type: "space", id: fieldNotes.id }, { type: "user", id: sam.user }))).toBe("owner");
  });
  test("a holder of every owner permission with an editor board step cannot hand out owner (no board-ladder escalation) unless a Unit admin", async () => {
    await give(cy, ["members.manage", "board.create", "move", "delete", "transfer"], "editor");
    expect(await code(off.reassign(cy, sam.user, { type: "space", id: fieldNotes.id, to: ada.user }))).toBe("forbidden");
    expect((await off.reassign(root, sam.user, { type: "space", id: fieldNotes.id, to: ada.user })).done).toBe(true);
  });
  describe("a personal space is private to its owner (HIGH-2)", () => {
    const mo = () => offboardService({ registry: r, tenancy: manageOnly, announce: () => {}, managerOf: async () => null });
    test("a manage-only Unit admin sees the personal space as a count, cannot hand it over, and cannot remove its owner; nothing changes", async () => {
      expect((await manageOnly.effective(root, secret.id)).ladder).toBe(null);
      const out = await mo().list(root, sam.user);
      const mine = out.items.find(i => i.personal);
      expect(mine.can).toEqual({ reassign: false, handover: false, why: "Private to its owner: needs board-content access" });
      expect(JSON.stringify(out)).not.toContain("Secret plan");
      expect(out.canRemove).toBe(false);
      await moveAll2(mo());
      expect(await code(mo().remove(root, sam.user, { to: ada.user }))).toBe("forbidden");
      expect((await r.memberState(acme.id, sam.user)).removed).toBe(false);
      expect((await r.personalSpace(acme.id, sam.user)).id).toBe(samSpace.id);
      expect(await manageOnly.role(ada, secret.id)).toBe(null);
    });
    test("an admin with board-content access hands it over with the removal: archived, owned by the recipient, who now owns the boards", async () => {
      expect((await ten.effective(root, secret.id)).ladder).toBe("owner");
      await moveAll(ada.user);
      expect((await off.list(root, sam.user)).canRemove).toBe(true);
      await off.remove(root, sam.user, { to: ada.user });
      expect(await r.scopedGrant({ type: "space", id: samSpace.id }, { type: "user", id: ada.user })).toBe("owner");
      expect((await ten.effective(ada, secret.id)).ladder).toBe("owner");
    });
    test("row 66: a Unit member role with a boardRole, or a Unit-scope custom-role grant with one, reaches nobody's personal-space boards; only the owner, board-level sources and content-access admins do", async () => {
      await r.updateRole(acme.id, "member", { boardRole: "viewer", permissions: [] });
      expect(await ten.role(bob, secret.id)).toBe(null);                                         // Bob: plain member, member role viewer
      expect(await ten.role(bob, noted.id)).toBe("viewer");                                      // ... still reaches a shared Space's boards via the member role / general access
      expect((await manageOnly.effective(root, secret.id)).ladder).toBe(null);                  // a manage-only admin: nothing
      const role = await r.createRole({ tenant: acme.id, name: "Wide", boardRole: "editor", permissions: ["members.manage"] });
      await r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: { type: "user", id: cy.user }, role: role.id });
      expect(await ten.role(cy, secret.id)).toBe(null);                                          // a Unit-scope custom role with a boardRole
      expect(await ten.role(cy, noted.id)).not.toBe(null);
      expect(await ten.role(sam, secret.id)).toBe("owner");                                      // the owner
      expect(await ten.role(kim, secret.id)).toBe("editor");                                     // a board-level grant (a guest)
      expect(await ten.role(root, secret.id)).toBe("owner");                                     // a content-access admin
      expect((await ten.effective(bob, { type: "space", id: samSpace.id })).ladder).toBe(null);  // and the space itself
      const bobAt = (await manageOnly.effective(bob, secret.id)).permissions;
      expect([...bobAt].filter(p => ["view", "comment", "edit"].includes(p))).toEqual([]);
    });
    test("row 66: in that config a manage-only admin still cannot hand the personal space over, a content-access admin can", async () => {
      await r.updateRole(acme.id, "member", { boardRole: "editor", permissions: [] });
      await moveAll2(mo());
      expect(await code(mo().remove(root, sam.user, { to: ada.user }))).toBe("forbidden");
      expect((await r.memberState(acme.id, sam.user)).removed).toBe(false);
      await moveAll(ada.user);
      expect(await code(off.remove(root, sam.user, { to: ada.user }))).toBe(null);
    });
    test("a live member's personal space can never be reassigned on its own, by anyone, even with content access", async () => {
      expect(await code(off.reassign(root, sam.user, { type: "space", id: samSpace.id, to: ada.user }))).toBe("personal");
      expect(await r.scopedGrant({ type: "space", id: samSpace.id }, { type: "user", id: ada.user })).toBe(null);
      expect((await r.personalSpace(acme.id, sam.user)).id).toBe(samSpace.id);
    });
    test("the removal needs a live recipient for the personal space; none or a bad one changes nothing", async () => {
      await moveAll(ada.user);
      for (const body of [undefined, {}, { to: sam.user }, { to: "google:nobody" }]) expect(await code(off.remove(root, sam.user, body))).toBe("bad-recipient");
      expect((await r.memberState(acme.id, sam.user)).removed).toBe(false);
    });
  });
  test("an item in another Unit, an unknown one and a malformed body are refused", async () => {
    const other = await r.createTenant({ domain: "other.com" });
    const foreign = await r.createSpace({ tenant: other.id, name: "F", owner: "google:x" });
    expect(await code(off.reassign(root, sam.user, { type: "space", id: foreign.id, to: ada.user }))).toBe("forbidden");
    expect(await code(off.reassign(root, sam.user, { type: "space", id: "s-nope", to: ada.user }))).toBe("forbidden");
    expect(await code(off.reassign(root, sam.user, { type: "board", id: noted.id, to: ada.user }))).toBe("bad-request");
    expect(await code(off.reassign(root, sam.user, { type: "space", id: fieldNotes.id }))).toBe("bad-request");
  });
  test("the recipient must be another live member: the leaver, a stranger and a removed person are bad-recipient", async () => {
    for (const to of [sam.user, "google:nobody"]) expect(await code(off.reassign(root, sam.user, { type: "space", id: fieldNotes.id, to }))).toBe("bad-recipient");
    await moveAll(ada.user);
    await off.remove(root, sam.user, { to: ada.user });
    const late = await r.createSpace({ tenant: acme.id, name: "Late", owner: bob.user });
    expect(await code(off.reassign(root, bob.user, { type: "space", id: late.id, to: sam.user }))).toBe("bad-recipient");
  });
});

describe("reassigning and removing", () => {
  test("the whole flow: items move, boards and guests keep working, then Sam is removed and is a guest everywhere", async () => {
    const before = await ten.role(sam, noted.id);
    expect(before).toBe("owner");
    await moveAll(ada.user);
    expect(await code(off.remove(root, sam.user, { to: ada.user }))).toBe(null);
    // content and guests stay
    expect((await r.board(secret.id)).space).toBe(samSpace.id);
    expect(await r.grant(secret.id, kim.user)).toBe("editor");
    expect(await ten.role(kim, secret.id)).toBe("editor");
    expect(await ten.role(ada, secret.id)).toBe("owner");
    expect(await r.space(samSpace.id)).toMatchObject({ kind: "shared", owner: null, name: "Sam's space (archived)", archivedAt: clock.t });
    // the leaver is a guest
    expect(await ten.tenantOf(sam)).toBe(null);
    expect(await ten.role(sam, noted.id)).toBe(null);                              // not even the general viewer access
    expect(await ten.role(sam, secret.id)).toBe(null);
    expect(await r.grant(noted.id, sam.user)).toBe(null);
    expect((await off.list(root, sam.user)).member.removed).toBe(true);
    expect((await off.list(root, sam.user)).canRemove).toBe(false);
  });
  test("Sam's shared Space (co-owned with Ada) is left alone: removal drops his grant, Ada keeps it", async () => {
    await moveAll(ada.user);
    await off.remove(root, sam.user, { to: ada.user });
    expect(await r.scopedGrant({ type: "space", id: shared.id }, { type: "user", id: sam.user })).toBe(null);
    expect(await r.scopedGrant({ type: "space", id: shared.id }, { type: "user", id: ada.user })).toBe("owner");
  });
  test("removal is refused while anything is left (still-owns, nothing changes) and after a partial offboarding the leaver is still active", async () => {
    const first = (await off.list(root, sam.user)).items.find(i => !i.personal);
    await off.reassign(root, sam.user, { type: first.type, id: first.id, to: ada.user });
    expect(await code(off.remove(root, sam.user, { to: ada.user }))).toBe("still-owns");
    expect((await r.memberState(acme.id, sam.user)).removed).toBe(false);
    expect(await ten.role(sam, noted.id)).not.toBe(null);
    expect(announced.filter(a => a[0] === "unit")).toEqual([]);
  });
  test("a Space the leaver gains between the list and the removal is caught by the removal", async () => {
    await moveAll(ada.user);
    await r.createSpace({ tenant: acme.id, name: "Late", owner: sam.user });
    expect(await code(off.remove(root, sam.user, { to: ada.user }))).toBe("still-owns");
  });
  test("reassign is idempotent: the second call is done:false and changes nothing; a Space that gained another owner is left", async () => {
    const a = await off.reassign(root, sam.user, { type: "space", id: fieldNotes.id, to: ada.user });
    const b = await off.reassign(root, sam.user, { type: "space", id: fieldNotes.id, to: bob.user });
    expect([a.done, b.done]).toEqual([true, false]);
    expect(await r.scopedGrant({ type: "space", id: fieldNotes.id }, { type: "user", id: bob.user })).toBe(null);
    expect(a.item).toMatchObject({ id: fieldNotes.id, name: "Field notes", archived: false });
    expect(a.to).toEqual({ id: ada.user, name: "Ada" });
  });
  test("announcements: a reassignment announces its scope and the removal announces the Unit, both as revocations; a no-op announces nothing", async () => {
    await off.reassign(root, sam.user, { type: "space", id: fieldNotes.id, to: ada.user });
    await off.reassign(root, sam.user, { type: "space", id: fieldNotes.id, to: ada.user });
    expect(announced).toEqual([["space", fieldNotes.id, true]]);
    await moveAll(ada.user);
    await off.remove(root, sam.user, { to: ada.user });
    expect(announced.at(-1)).toEqual(["unit", acme.id, true]);
    const n = announced.length;
    await off.remove(root, sam.user, { to: ada.user });
    expect(announced.length).toBe(n);
  });
  test("an admin cannot be removed (is-admin), nobody removes themselves, an unknown person is not-found, and a non-manager is forbidden", async () => {
    expect(await code(off.remove(root, "google:root"))).toBe("bad-request");     // the caller is the admin: yourself
    const other = ident("zoe");
    await r.touchMember(acme.id, { user: other.user, name: "Zoe", email: "zoe@acme.com" });
    await r.addTenantAdmin(acme.id, other.user);
    expect(await code(off.remove(root, other.user))).toBe("is-admin");
    expect(await code(off.remove(root, "google:nobody"))).toBe("not-found");
    expect(await code(off.remove(bob, sam.user))).toBe("forbidden");
  });
  test("an admin named by an email: entry is blocked and refused like one named by id; a removed person is never an admin to the resolver", async () => {
    await r.addTenantAdmin(acme.id, "email:bob@acme.com");
    expect((await off.list(root, bob.user)).blocked).toBe("admin");
    expect(await code(off.remove(root, bob.user))).toBe("is-admin");
    // an admin entry added AFTER the removal gives the removed person nothing
    await moveAll(ada.user);
    await off.remove(root, sam.user, { to: ada.user });
    await r.addTenantAdmin(acme.id, sam.user);
    expect((await ten.effective(sam, { type: "unit", id: acme.id })).permissions.size).toBe(0);
  });
  test("a removed person's identity: HTTP says no Unit, the room says no role, and a board grant to them is refused as unknown-person", async () => {
    await moveAll(ada.user);
    await off.remove(root, sam.user, { to: ada.user });
    expect(await ten.tenantOf(sam)).toBe(null);
    expect((await ten.effective(sam, { type: "unit", id: acme.id })).permissions.size).toBe(0);
    const { knownOnBoard } = await import("../../server/admin/boards.js");
    expect(await knownOnBoard(r, noted, sam.user)).toBe(false);
    expect(await knownOnBoard(r, noted, bob.user)).toBe(true);
  });
  test("every way the room and Home read a role agrees: rolesFor (the gateway's re-check), a cold roleCache hello and accessMany see the removed member as a guest", async () => {
    expect((await ten.rolesFor(noted.id, [sam])).get(identityKey(sam))).toBe("owner");
    const cache = roleCache({ registry: r, now: () => clock.t });
    expect(await cache.role(sam, noted.id)).toBe("owner");
    await moveAll(ada.user);
    await off.remove(root, sam.user, { to: ada.user });
    cache.invalidate(noted.id);                                                       // what the gateway does on the removal's announcement
    expect((await ten.rolesFor(noted.id, [sam])).get(identityKey(sam))).toBe(null);
    expect(await cache.role(sam, noted.id)).toBe(null);
    expect((await ten.accessMany(sam, [noted.id])).get(noted.id)?.access.ladder ?? null).toBe(null);
  });
  test("HIGH-1: a removed person re-added to the admin list, by id or by an email: entry, manages no board (no grant PUT/DELETE) and is unknown on every board", async () => {
    const { setGrant, knownOnBoard } = await import("../../server/admin/boards.js");
    await moveAll(ada.user);
    await off.remove(root, sam.user, { to: ada.user });
    for (const entry of [sam.user, "email:sam@acme.com"]) {
      await r.addTenantAdmin(acme.id, entry);
      expect(await code(setGrant({ caller: sam, board: noted.id, user: bob.user, role: "viewer" }, { registry: r }))).toBe("forbidden");
      expect(await code(setGrant({ caller: sam, board: noted.id, user: ada.user, role: null }, { registry: r }))).toBe("forbidden");
      expect(await knownOnBoard(r, noted, sam.user)).toBe(false);
    }
    expect(await r.grant(noted.id, bob.user)).toBe(null);
    expect(await code(setGrant({ caller: root, board: noted.id, user: bob.user, role: "viewer" }, { registry: r }))).toBe(null);   // a live admin still can
  });
  test("MED-2: an invite addressed to the leaver's own email is revoked with the removal, so it gives the removed person no ladder role", async () => {
    const inv = await r.createInvite({ board: noted.id, email: "sam@acme.com", role: "editor", by: ada.user });
    const other = await r.createInvite({ board: noted.id, email: "lee@partner.io", role: "viewer", by: ada.user });
    await moveAll(ada.user);
    await off.remove(root, sam.user, { to: ada.user });
    expect((await r.invite(inv.id)).revoked).toBe(true);
    expect((await r.invite(other.id)).revoked).toBe(false);
    expect(await ten.role({ user: "google:sam", email: "sam@acme.com" }, noted.id)).toBe(null);
  });
  test("LOW-4: the removal drops this node's warm roleCache entries by itself (no manual invalidate)", async () => {
    const cache = roleCache({ registry: r, now: () => clock.t });
    const wired = offboardService({ registry: r, tenancy: ten, announce: () => {}, forget: u => cache.forgetUser(u) });
    expect(await cache.role(sam, noted.id)).toBe("owner");
    expect(await cache.role(sam, secret.id)).toBe("owner");
    expect(await cache.role(ada, noted.id)).toBe("viewer");                         // warm too (the Space's general role)
    for (const i of (await wired.list(root, sam.user)).items.filter(i => !i.personal)) await wired.reassign(root, sam.user, { type: i.type, id: i.id, to: ada.user });
    expect(await cache.role(sam, noted.id)).not.toBe(null);                          // still warm until the removal
    await wired.remove(root, sam.user, { to: ada.user });
    expect(await cache.role(sam, noted.id)).toBe(null);
    expect(await cache.role(sam, secret.id)).toBe(null);
    expect(await cache.role(ada, noted.id)).not.toBe(null);                       // other people's entries are untouched
  });
  test("invites a leaver created and links he made stay valid", async () => {
    const inv = await r.createInvite({ board: noted.id, email: "lee@partner.io", role: "viewer", by: sam.user });
    const link = await r.createLink({ board: noted.id, role: "viewer", by: sam.user });
    await moveAll(ada.user);
    await off.remove(root, sam.user, { to: ada.user });
    expect((await r.invite(inv.id)).revoked).toBe(false);
    expect((await r.link(link.id)).revoked).toBe(false);
    expect(await ten.role({ user: "google:lee", email: "lee@partner.io" }, noted.id)).toBe("viewer");
  });
});

describe("over HTTP", () => {
  let routes;
  const ORIGIN = "https://plenary.test";
  const api = async (tok, path, method = "GET", body, headers = {}) => {
    const res = await routes(new Request(ORIGIN + path, { method, headers: { authorization: `Bearer ${tok}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined }));
    return { status: res.status, json: res.headers.get("content-type")?.includes("json") ? JSON.parse(await res.clone().text()) : null, headers: res.headers };
  };
  const U = encodeURIComponent("dev:sam");
  let hfn;
  beforeEach(async () => {
    const tok = n => ({ name: n, domain: "acme.com", email: `${n}@acme.com` });
    for (const n of ["root", "ada", "bob", "sam"]) await r.touchMember(acme.id, { user: "dev:" + n, name: n, email: `${n}@acme.com` });
    await r.addTenantAdmin(acme.id, "dev:root");
    await r.ensurePersonalSpace(acme.id, "dev:sam");
    hfn = await r.createSpace({ tenant: acme.id, name: "HFN", owner: "dev:sam" });
    await r.createGroup({ tenant: acme.id, name: "HG", owner: "dev:sam" });
    const dev = devAuth({ enabled: true, tokens: { root: tok("root"), ada: tok("ada"), bob: tok("bob"), sam: tok("sam") } });
    routes = httpRoutes({ registry: r, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy: ten, home: homeService({ registry: r, tenancy: ten }), offboard: off, now: () => clock.t,
      config: { cookieKey: "k".repeat(32), postLoginUrl: ORIGIN + "/", boardUrl: ORIGIN + "/b/{board}", publicUrl: ORIGIN }, dev });
  });
  test("list, keyed reassign (replay, reused key), keyed remove, and the same 403 for a non-manager", async () => {
    const list = await api("root", `/members/${U}/offboarding`);
    expect(list.status).toBe(200);
    expect(list.json.items.length).toBe(3);
    expect((await api("bob", `/members/${U}/offboarding`)).status).toBe(403);
    expect((await api("bob", `/members/${U}/remove`, "POST", {})).status).toBe(403);
    expect((await api("root", `/members/${U}/offboarding?x=1`)).status).toBe(400);
    const key = { "idempotency-key": "reassign-key-1" }, body = { type: "space", id: hfn.id, to: "dev:ada" };
    const a = await api("root", `/members/${U}/offboarding/reassign`, "POST", body, key);
    expect([a.status, a.json.done]).toEqual([200, true]);
    const again = await api("root", `/members/${U}/offboarding/reassign`, "POST", body, key);
    expect([again.status, again.json.done, again.headers.get("idempotent-replayed")]).toEqual([200, true, "true"]);
    expect((await api("root", `/members/${U}/offboarding/reassign`, "POST", { ...body, to: "dev:bob" }, key)).status).toBe(422);
    expect((await api("root", `/members/${U}/offboarding/reassign`, "POST", { ...body, to: "google:nobody" })).status).toBe(400);
    expect((await api("root", `/members/${U}/remove`, "POST", { to: "dev:ada" })).json).toEqual({ error: "still-owns" });
    expect((await api("root", `/members/${U}/offboarding/reassign`, "POST", { type: "space", id: (await r.personalSpace(acme.id, "dev:sam")).id, to: "dev:ada" })).json).toEqual({ error: "personal" });
    for (const i of (await api("root", `/members/${U}/offboarding`)).json.items.filter(i => !i.personal)) await api("root", `/members/${U}/offboarding/reassign`, "POST", { type: i.type, id: i.id, to: "dev:ada" });
    expect((await api("root", `/members/${U}/offboarding`)).json.canRemove).toBe(true);
    const rk = { "idempotency-key": "remove-key-0001" };
    expect((await api("root", `/members/${U}/remove`, "POST", {})).status).toBe(400);                  // the personal space needs a new owner
    expect((await api("root", `/members/${U}/remove`, "POST", { to: "dev:sam" })).status).toBe(400);
    const rm = await api("root", `/members/${U}/remove`, "POST", { to: "dev:ada" }, rk);
    expect([rm.status, rm.json.removed]).toEqual([200, true]);
    const rp = await api("root", `/members/${U}/remove`, "POST", { to: "dev:ada" }, rk);
    expect([rp.status, rp.json.removed, rp.headers.get("idempotent-replayed")]).toEqual([200, true, "true"]);
    const home = await api("sam", "/home");                                         // the removed person has no Unit: a guest
    expect([home.status, home.json.guest, home.json.unit]).toEqual([200, true, null]);
    expect((await r.personalSpace(acme.id, "dev:sam"))).toBe(null);
  });
});
