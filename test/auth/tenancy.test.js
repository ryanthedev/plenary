import { test, expect, beforeEach } from "bun:test";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy } from "../../server/auth/tenancy.js";
import { createBoard } from "./fixtures.js";
import { isUnitAdmin } from "../../server/auth/resolver.js";
import { createInvite, createLink, revokeInvite, revokeLink, listInvites, listLinks, setGrant, AdminError } from "../../server/admin/boards.js";

let clock, registry, model, acme, globex, admin, board;
const now = () => clock.t;
const id = (user, domain, email = null) => ({ user, name: user, email, domain });
const ann = id("google:ann", "acme.com", "ann@acme.com");          // Acme member
const bob = id("google:bob", "globex.com", "bob@globex.com");      // other tenant
const gus = id("google:gus", null, "gus@gmail.com");               // no Workspace
const DAY = 86_400_000;

beforeEach(async () => {
  clock = { t: Date.UTC(2026, 10, 11) };
  registry = memoryRegistry({ now });
  model = tenancy({ registry, now });
  admin = id("google:root", "acme.com", "root@acme.com");
  acme = await registry.createTenant({ domain: "acme.com", admins: [admin.user] });
  globex = await registry.createTenant({ domain: "globex.com", admins: ["google:gadmin"] });
  board = await createBoard({ caller: admin, tenant: acme.id, title: "All hands" }, { registry });
  for (const p of [ann, bob]) await registry.touchMember(acme.id, { user: p.user });     // the directory (a new person grant on a board needs a known person); it adds no access
});

test("tenant and board ids are server-minted [a-z0-9-], never a domain, never a dot", async () => {
  for (const t of [acme, globex]) {
    expect(t.id).toMatch(/^[a-z0-9-]+$/);
    expect(t.id).not.toContain("acme");
    expect(t.id).not.toContain("globex");
  }
  expect(board.id).toMatch(/^[a-z0-9-]+$/);
  expect((await registry.tenantByDomain("ACME.com")).id).toBe(acme.id);
  await expect(registry.createTenant({ domain: "acme.com" })).rejects.toThrow();
});

test("Workspace member gets the board's memberRole, default viewer", async () => {
  expect(board.memberRole).toBe("viewer");
  expect(await model.role(ann, board.id)).toBe("viewer");
  const b2 = await createBoard({ caller: admin, tenant: acme.id, memberRole: "annotator" }, { registry });
  expect(await model.role(ann, b2.id)).toBe("annotator");
  const b3 = await createBoard({ caller: admin, tenant: acme.id, memberRole: null }, { registry });
  expect(await model.role(ann, b3.id)).toBe(null);
});

test("the creator is owner; a grant beats the default; a lower grant doesn't demote (highest wins)", async () => {
  expect(await model.role(admin, board.id)).toBe("owner");
  await setGrant({ caller: admin, board: board.id, user: ann.user, role: "editor" }, { registry });
  expect(await model.role(ann, board.id)).toBe("editor");
  const b2 = await createBoard({ caller: admin, tenant: acme.id, memberRole: "annotator" }, { registry });
  await setGrant({ caller: admin, board: b2.id, user: ann.user, role: "viewer" }, { registry });
  expect(await model.role(ann, b2.id)).toBe("annotator");
});

test("a user from another domain gets nothing, except by invite (cross-domain works)", async () => {
  expect(await model.role(bob, board.id)).toBe(null);
  expect(await model.role(gus, board.id)).toBe(null);
  await createInvite({ caller: admin, board: board.id, email: "Bob@Globex.com", role: "annotator" }, { registry, tenancy: model, now });
  expect(await model.role(bob, board.id)).toBe("annotator");
  // The invite matches only a verified email (identity.email is null when Google says unverified).
  expect(await model.role({ ...bob, email: null }, board.id)).toBe(null);
  // Domain is not email: an @acme.com email without hd is not a member.
  expect(await model.role(id("google:y", null, "y@acme.com"), board.id)).toBe(null);
});

test("invite expiry and revoke take effect on the next role() call", async () => {
  const inv = await createInvite({ caller: admin, board: board.id, email: "gus@gmail.com", role: "editor", expiresAt: clock.t + DAY }, { registry, tenancy: model, now });
  expect(await model.role(gus, board.id)).toBe("editor");
  clock.t += DAY;
  expect(await model.role(gus, board.id)).toBe(null);
  const inv2 = await createInvite({ caller: admin, board: board.id, email: "gus@gmail.com", role: "viewer" }, { registry, tenancy: model, now });
  expect(await model.role(gus, board.id)).toBe("viewer");
  await revokeInvite({ caller: admin, board: board.id, invite: inv2.id }, { registry, tenancy: model });
  expect(await model.role(gus, board.id)).toBe(null);
  expect((await listInvites({ caller: admin, board: board.id }, { registry, tenancy: model })).map(i => i.id).sort()).toEqual([inv.id, inv2.id].sort());
});

test("share link: role, redeem, expiry, revoke (next role() call); only editor/annotator/viewer", async () => {
  for (const r of ["owner", "commenter", "admin", undefined])
    await expect(createLink({ caller: admin, board: board.id, role: r }, { registry, tenancy: model, now })).rejects.toBeInstanceOf(AdminError);
  const link = await createLink({ caller: admin, board: board.id, role: "annotator", expiresAt: clock.t + DAY }, { registry, tenancy: model, now });
  expect(link.id).toMatch(/^[a-z0-9]{26}$/);
  expect(await model.role(gus, board.id)).toBe(null);                     // not redeemed yet
  expect(await model.redeemLink(gus, link.id)).toEqual({ board: board.id });
  expect(await model.role(gus, board.id)).toBe("annotator");
  expect(await model.role(bob, board.id)).toBe(null);                     // only who redeemed
  clock.t += DAY;
  expect(await model.role(gus, board.id)).toBe(null);                     // expired
  expect(await model.redeemLink(bob, link.id)).toBe(null);

  const l2 = await createLink({ caller: admin, board: board.id, role: "editor" }, { registry, tenancy: model, now });
  await model.redeemLink(bob, l2.id);
  expect(await model.role(bob, board.id)).toBe("editor");
  await revokeLink({ caller: admin, board: board.id, link: l2.id }, { registry, tenancy: model });
  expect(await model.role(bob, board.id)).toBe(null);                     // revoked
  expect(await model.redeemLink(bob, l2.id)).toBe(null);
  expect(await model.redeemLink(bob, "nope")).toBe(null);
  expect((await listLinks({ caller: admin, board: board.id }, { registry, tenancy: model })).length).toBe(2);
});

test("unknown board == board with no role: both null, and role() writes nothing", async () => {
  const before = JSON.stringify(await registry.tenant(acme.id));
  expect(await model.role(bob, board.id)).toBe(null);
  expect(await model.role(bob, "b-doesnotexist")).toBe(null);
  expect(await model.role(admin, "b-doesnotexist")).toBe(null);
  expect(await registry.board("b-doesnotexist")).toBe(null);
  expect(JSON.stringify(await registry.tenant(acme.id))).toBe(before);
  for (const bad of [null, undefined, {}, { user: 1 }]) expect(await model.role(bad, board.id)).toBe(null);
});

test("cross-tenant: nothing in tenant A resolves a role on tenant B's board", async () => {
  const gadmin = id("google:gadmin", "globex.com", "g@globex.com");
  const gb = await createBoard({ caller: gadmin, tenant: globex.id, memberRole: "editor" }, { registry });
  expect(await model.role(bob, gb.id)).toBe("editor");
  expect(await model.role(ann, gb.id)).toBe(null);
  expect(await model.role(admin, gb.id)).toBe(null);                      // Acme's admin
  // An Acme link or invite doesn't reach Globex's board.
  const link = await createLink({ caller: admin, board: board.id, role: "editor" }, { registry, tenancy: model, now });
  await model.redeemLink(ann, link.id);
  await createInvite({ caller: admin, board: board.id, email: "ann@acme.com", role: "editor" }, { registry, tenancy: model, now });
  expect(await model.role(ann, gb.id)).toBe(null);
  // Acme's admin can't manage Globex's board, and gets the same answer as for a board that doesn't exist.
  const e1 = await createLink({ caller: admin, board: gb.id, role: "viewer" }, { registry, tenancy: model, now }).catch(e => e);
  const e2 = await createLink({ caller: admin, board: "b-nope", role: "viewer" }, { registry, tenancy: model, now }).catch(e => e);
  expect([e1.code, e1.message]).toEqual([e2.code, e2.message]);
  expect(e1.code).toBe("forbidden");
  // Explicit cross-tenant invite to that board does work.
  await createInvite({ caller: gadmin, board: gb.id, email: "ann@acme.com", role: "annotator" }, { registry, tenancy: model, now });
  expect(await model.role(ann, gb.id)).toBe("annotator");
});

test("fixtures createBoard: an unfiled board with its owner grant (board creation by permission: test/auth/spaces.test.js)", async () => {
  const b = await createBoard({ caller: admin, tenant: acme.id, title: "Q4" }, { registry });
  expect(b.id).toMatch(/^[a-z0-9-]+$/);
  expect(await registry.board(b.id)).toMatchObject({ id: b.id, tenant: acme.id, title: "Q4", memberRole: "viewer", space: null });
  expect(await registry.grant(b.id, admin.user)).toBe("owner");
});

test("admin: a board owner (not tenant admin) manages invites and links; a member can't", async () => {
  await setGrant({ caller: admin, board: board.id, user: ann.user, role: "owner" }, { registry });
  const l = await createLink({ caller: ann, board: board.id, role: "viewer" }, { registry, tenancy: model, now });
  expect(l.by).toBe(ann.user);
  const carl = id("google:carl", "acme.com");
  await expect(createInvite({ caller: carl, board: board.id, email: "x@y.z", role: "viewer" }, { registry, tenancy: model, now })).rejects.toMatchObject({ code: "forbidden" });
  await expect(revokeLink({ caller: carl, board: board.id, link: l.id }, { registry, tenancy: model })).rejects.toMatchObject({ code: "forbidden" });
  await expect(createInvite({ caller: admin, board: board.id, email: "x@y.z", role: "owner" }, { registry, tenancy: model, now })).rejects.toMatchObject({ code: "bad-request" });
  await expect(createInvite({ caller: admin, board: board.id, email: "nope", role: "viewer" }, { registry, tenancy: model, now })).rejects.toMatchObject({ code: "bad-request" });
  await expect(createLink({ caller: admin, board: board.id, role: "viewer", expiresAt: clock.t - 1 }, { registry, tenancy: model, now })).rejects.toMatchObject({ code: "bad-request" });
});

test("a revoke that names another board's link or invite is refused", async () => {
  const b2 = await createBoard({ caller: admin, tenant: acme.id }, { registry });
  const l = await createLink({ caller: admin, board: b2.id, role: "viewer" }, { registry, tenancy: model, now });
  await expect(revokeLink({ caller: admin, board: board.id, link: l.id }, { registry, tenancy: model })).rejects.toMatchObject({ code: "forbidden" });
  expect((await registry.link(l.id)).revoked).toBe(false);
});

// ---- Fix round (p5-authv) ----

test("M5: role() caps what the Registry holds: unknown roles ignored, memberRole/invites below owner, links to LINK_ROLES", async () => {
  // Direct Registry writes, bypassing the admin checks (the engine's SQL Registry is a second writer).
  const b = await registry.createBoard({ tenant: acme.id, memberRole: "owner" });
  expect(await model.role(ann, b.id)).toBe("editor");
  const b2 = await registry.createBoard({ tenant: acme.id, memberRole: "god" });
  expect(await model.role(ann, b2.id)).toBe(null);
  await registry.setGrant(b2.id, ann.user, "god");
  expect(await model.role(ann, b2.id)).toBe(null);
  await registry.createInvite({ board: b2.id, email: "gus@gmail.com", role: "owner", by: "x" });
  expect(await model.role(gus, b2.id)).toBe("editor");
  const l = await registry.createLink({ board: b2.id, role: "owner", by: "x" });
  await model.redeemLink(bob, l.id);
  expect(await model.role(bob, b2.id)).toBe("editor");
  const l2 = await registry.createLink({ board: b.id, role: "commenter", by: "x" });
  await model.redeemLink(bob, l2.id);
  expect(await model.role(bob, b.id)).toBe("viewer");
  await registry.setGrant(b2.id, bob.user, "owner");               // a real grant of owner still counts
  expect(await model.role(bob, b2.id)).toBe("owner");
});

test("M6: only tenant admins grant owner; owners grant up to editor; the last owner stays", async () => {
  await setGrant({ caller: admin, board: board.id, user: ann.user, role: "owner" }, { registry });
  // Ann is a board owner, not a tenant admin.
  for (const user of [bob.user, gus.user, "google:carl"])
    await expect(setGrant({ caller: ann, board: board.id, user, role: "owner" }, { registry })).rejects.toMatchObject({ code: "forbidden" });
  await setGrant({ caller: ann, board: board.id, user: bob.user, role: "editor" }, { registry });
  expect(await model.role(bob, board.id)).toBe("editor");
  // Ann can't strip or demote the creator (another owner)...
  await expect(setGrant({ caller: ann, board: board.id, user: admin.user, role: null }, { registry })).rejects.toMatchObject({ code: "forbidden" });
  await expect(setGrant({ caller: ann, board: board.id, user: admin.user, role: "viewer" }, { registry })).rejects.toMatchObject({ code: "forbidden" });
  expect(await model.role(admin, board.id)).toBe("owner");
  // ...but may step down herself while another owner remains.
  await setGrant({ caller: ann, board: board.id, user: ann.user, role: "editor" }, { registry });
  expect(await registry.grant(board.id, ann.user)).toBe("editor");
  // The last owner can't be removed or demoted, even by a tenant admin.
  await expect(setGrant({ caller: admin, board: board.id, user: admin.user, role: null }, { registry })).rejects.toMatchObject({ code: "last-owner" });
  await expect(setGrant({ caller: admin, board: board.id, user: admin.user, role: "editor" }, { registry })).rejects.toMatchObject({ code: "last-owner" });
  // With a second owner (granted by the admin, cross-tenant allowed by explicit grant), the first can go.
  await setGrant({ caller: admin, board: board.id, user: bob.user, role: "owner" }, { registry });
  await setGrant({ caller: admin, board: board.id, user: admin.user, role: null }, { registry });
  expect(await registry.grant(board.id, admin.user)).toBe(null);
  // Bob is now the last owner; he can't step down.
  await expect(setGrant({ caller: bob, board: board.id, user: bob.user, role: "editor" }, { registry })).rejects.toMatchObject({ code: "last-owner" });
});

// ---- Fix round (p5-fix) ----

test("p5-fix 3: registry.setGrant refuses to remove or demote the last owner, and changes nothing", async () => {
  const before = await registry.grants(board.id);
  for (const role of [null, "editor", "viewer"])
    await expect(registry.setGrant(board.id, admin.user, role)).rejects.toMatchObject({ code: "last-owner" });
  expect(await registry.grants(board.id)).toEqual(before);
  // Granting owner to an owner, or touching a non-owner, is fine.
  await registry.setGrant(board.id, admin.user, "owner");
  await registry.setGrant(board.id, ann.user, "editor");
  await registry.setGrant(board.id, ann.user, null);
  // With a second owner, one may go; then the other is the last.
  await registry.setGrant(board.id, bob.user, "owner");
  await registry.setGrant(board.id, admin.user, null);
  await expect(registry.setGrant(board.id, bob.user, "editor")).rejects.toMatchObject({ code: "last-owner" });
  expect(await registry.grant(board.id, bob.user)).toBe("owner");
});

test("p5-fix 3 (p5-authv R1): two concurrent demotions of the only two owners leave one owner", async () => {
  await setGrant({ caller: admin, board: board.id, user: ann.user, role: "owner" }, { registry });
  // Both owners step down at once.
  const r = await Promise.allSettled([
    setGrant({ caller: admin, board: board.id, user: admin.user, role: "editor" }, { registry }),
    setGrant({ caller: ann, board: board.id, user: ann.user, role: null }, { registry }),
  ]);
  expect(r.filter(x => x.status === "fulfilled").length).toBe(1);
  const lost = r.find(x => x.status === "rejected");
  expect(lost.reason).toBeInstanceOf(AdminError);
  expect(lost.reason.code).toBe("last-owner");
  expect((await registry.grants(board.id)).filter(g => g.role === "owner").length).toBe(1);
  // A tenant admin removing both owners at once: same result.
  await setGrant({ caller: admin, board: board.id, user: bob.user, role: "owner" }, { registry });
  const owners = (await registry.grants(board.id)).filter(g => g.role === "owner").map(g => g.user);
  expect(owners.length).toBe(2);
  await Promise.allSettled(owners.map(user => setGrant({ caller: admin, board: board.id, user, role: null }, { registry })));
  expect((await registry.grants(board.id)).filter(g => g.role === "owner").length).toBe(1);
});

test("a Unit with a second domain: members of either get memberRole; an email admin on either domain is an admin, other domains are not", async () => {
  await registry.addTenantDomain(acme.id, "acme.io");
  await registry.addTenantAdmin(acme.id, "email:pat@acme.io");
  const lee = id("google:lee", "acme.io", "lee@acme.io");
  expect(await model.role(lee, board.id)).toBe("viewer");
  const pat = id("google:pat", "acme.io", "pat@acme.io");
  const t = await registry.tenant(acme.id);
  expect(isUnitAdmin(t, pat)).toBe(true);
  expect(isUnitAdmin(t, id("google:pat", "evil.com", "pat@acme.io"))).toBe(false);
  expect(await model.role(id("google:zed", "globex.com", "z@globex.com"), board.id)).toBe(null);
});

test("setGrant (the old route) names only people the server knows on the board: directory, existing grant, link use; email:, garbage, another Unit's member and never-seen ids are unknown-person", async () => {
  await registry.touchMember(globex.id, { user: "google:gina" });
  await registry.addTenantAdmin(acme.id, "email:zed@acme.com");
  for (const user of ["email:zed@acme.com", "email:", "google:nobody", "google:gina", "dev:ANN", "not a user"]) {
    await expect(setGrant({ caller: admin, board: board.id, user, role: "viewer" }, { registry })).rejects.toMatchObject({ code: "unknown-person" });
    expect(await registry.grant(board.id, user)).toBe(null);
  }
  await expect(setGrant({ caller: admin, board: board.id, user: "google:nobody", role: null }, { registry })).resolves.toBeUndefined();   // removing nothing is never refused
  // a directory member and a guest who redeemed a link of this board
  await setGrant({ caller: admin, board: board.id, user: ann.user, role: "editor" }, { registry });
  const l = await registry.createLink({ board: board.id, role: "viewer", by: admin.user });
  await expect(setGrant({ caller: admin, board: board.id, user: gus.user, role: "viewer" }, { registry })).rejects.toMatchObject({ code: "unknown-person" });
  await registry.addLinkUse(l.id, gus.user);
  await setGrant({ caller: admin, board: board.id, user: gus.user, role: "viewer" }, { registry });
  // an existing grant can be changed whatever happens to the person's other records
  await registry.setGrant(board.id, "google:old", "viewer");
  await setGrant({ caller: admin, board: board.id, user: "google:old", role: "editor" }, { registry });
  expect(await registry.grant(board.id, "google:old")).toBe("editor");
  await setGrant({ caller: admin, board: board.id, user: "google:old", role: null }, { registry });
  expect(await registry.grant(board.id, "google:old")).toBe(null);
});
