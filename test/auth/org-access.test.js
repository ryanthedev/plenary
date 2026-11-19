// Board organization through the real tenancy over a Registry (memory): the defaults, the room's one ladder role, and
// the effective permissions with their sources. The pure rule is test/auth/resolver.test.js; adapters are
// test/auth/registry-contract.js.
import { test, expect, beforeEach } from "bun:test";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy, roleCache } from "../../server/auth/tenancy.js";

let r, ten, acme, now = () => 1_000;
const id = (n, domain = "acme.com") => ({ user: `google:${n}`, email: `${n}@${domain ?? "x.org"}`, domain });
const board = async (space, o = {}) => r.createBoard({ tenant: acme.id, space, ...o });

beforeEach(async () => {
  r = memoryRegistry({ now });
  ten = tenancy({ registry: r, now });
  acme = await r.createTenant({ domain: "acme.com", domains: ["acme.io"], admins: ["google:root"] });
});

test("defaults: a personal space is private, a new Space gives viewer, a new board inherits", async () => {
  const mine = await r.ensurePersonalSpace(acme.id, "google:ann");
  const draft = await board(mine.id);
  expect([mine.generalRole, draft.memberRole]).toEqual([null, null]);
  expect(await ten.role(id("bob"), draft.id)).toBe(null);                       // another member sees nothing
  expect(await ten.role(id("ann"), draft.id)).toBe("owner");                    // the personal space's owner owns what is in it
  const shared = await r.createSpace({ tenant: acme.id, name: "Design" });
  expect(shared.generalRole).toBe("viewer");
  const b = await board(shared.id);
  expect(b.memberRole).toBe(null);
  expect(await ten.role(id("bob"), b.id)).toBe("viewer");                       // inherited from the Space
  expect(await ten.role(id("bob", "acme.io"), b.id)).toBe("viewer");            // the Unit's second domain counts
  expect(await ten.role(id("kim", "partner.io"), b.id)).toBe(null);             // a guest does not
  expect(await ten.role(id("kim", null), b.id)).toBe(null);
});

test("a board is never more private than its Space; a Space with general access none gives nobody a role", async () => {
  const sp = await r.createSpace({ tenant: acme.id, name: "Closed", generalRole: null });
  const b = await board(sp.id, { memberRole: null });
  expect(await ten.role(id("bob"), b.id)).toBe(null);
  await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "user", id: "google:bob" }, role: "editor" });
  expect(await ten.role(id("bob"), b.id)).toBe("editor");
  const noOverride = await board(sp.id, { memberRole: null });
  expect(await ten.role(id("bob"), noOverride.id)).toBe("editor");               // no per-board "restrict": grants only add
});

test("the room gets one ladder role: the highest of team, Space, Group, general and direct grants, owner included", async () => {
  const g = await r.createGroup({ tenant: acme.id, name: "Product" });
  const sp = await r.createSpace({ tenant: acme.id, name: "Design", group: g.id, generalRole: "viewer" });
  const infra = await r.createTeam({ tenant: acme.id, name: "Infra" });
  await r.setTeamMember(infra.id, "google:dev", true);
  const b = await board(sp.id);
  const dev = id("dev");
  expect(await ten.role(dev, b.id)).toBe("viewer");
  await r.setScopedGrant({ scope: { type: "group", id: g.id }, subject: { type: "team", id: infra.id }, role: "annotator" });
  expect(await ten.role(dev, b.id)).toBe("annotator");
  await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "team", id: infra.id }, role: "editor" });
  expect(await ten.role(dev, b.id)).toBe("editor");
  await r.setGrant(b.id, "google:dev", "viewer");                                // lower direct grant: highest still wins
  expect(await ten.role(dev, b.id)).toBe("editor");
  await r.setScopedGrant({ scope: { type: "group", id: g.id }, subject: { type: "user", id: "google:dev" }, role: "owner" });
  expect(await ten.role(dev, b.id)).toBe("owner");
  await r.setTeamMember(infra.id, "google:dev", false);                          // leaving the team removes only the team's grants
  expect(await ten.role(dev, b.id)).toBe("owner");
  expect(await ten.role(id("bob"), b.id)).toBe("viewer");
});

test("effective: permissions and the source of each (\"viewer via team Infra on Space Platform\")", async () => {
  const sp = await r.createSpace({ tenant: acme.id, name: "Platform", generalRole: null });
  const infra = await r.createTeam({ tenant: acme.id, name: "Infra" });
  await r.setTeamMember(infra.id, "google:dev", true);
  await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "team", id: infra.id }, role: "viewer" });
  const b = await board(sp.id);
  const a = await ten.effective(id("dev"), b.id);
  expect(a.ladder).toBe("viewer");
  expect(a.permissions.has("board.view")).toBe(true);
  expect(a.permissions.has("board.create")).toBe(false);
  expect(a.sources).toMatchObject([
    { kind: "team", team: infra.id, scope: { type: "space", id: sp.id }, role: "viewer", ladder: "viewer" },
    { kind: "unit", role: "member" }]);
  const inSpace = await ten.effective(id("dev"), { type: "space", id: sp.id });
  expect(inSpace.permissions.has("board.create")).toBe(false);                    // "New board" disabled for a viewer (J10)
  await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "team", id: infra.id }, role: "editor" });
  expect((await ten.effective(id("dev"), { type: "space", id: sp.id })).permissions.has("board.create")).toBe(true);
  expect(await ten.effective(id("dev"), "b-nope")).toMatchObject({ ladder: null, sources: [] });
  expect((await ten.effective(id("dev"), { type: "group", id: "g-nope" })).sources).toEqual([]);
  expect((await ten.effective(null, b.id)).ladder).toBe(null);
});

test("custom roles: a role on a Space gives its board role to the room and its management permissions to the admin layer", async () => {
  const sp = await r.createSpace({ tenant: acme.id, name: "Workshops", generalRole: null });
  const fac = await r.createRole({ tenant: acme.id, name: "Facilitator", base: "editor", boardRole: "annotator", permissions: ["board.create", "members.manage", "roles.manage"] });
  await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "user", id: "google:fay" }, role: fac.id });
  const b = await board(sp.id);
  expect(await ten.role(id("fay"), b.id)).toBe("annotator");
  const a = await ten.effective(id("fay", null), { type: "space", id: sp.id });
  expect([...a.permissions].sort()).toEqual(["board.annotate", "board.comment", "board.create", "board.view", "members.manage"]);   // roles.manage is Unit-only
  await r.updateRole(acme.id, fac.id, { boardRole: "editor" });
  expect(await ten.role(id("fay"), b.id)).toBe("editor");                        // edits take effect on the next read
});

test("Unit admin: management permissions everywhere, but no room role unless the deployment opts in", async () => {
  const sp = await r.createSpace({ tenant: acme.id, name: "Closed", generalRole: null });
  const b = await board(sp.id);
  const root = { user: "google:root", email: "root@acme.com", domain: "acme.com" };
  expect(await ten.role(root, b.id)).toBe(null);                                  // today's rule: an admin enters no room without a role
  expect((await ten.effective(root, b.id)).permissions.has("transfer")).toBe(true);
  expect(await tenancy({ registry: r, now, adminBoardContent: true }).role(root, b.id)).toBe("owner");
});

test("rolesFor (the re-check pass) and role (a hello) agree on every source, and through the cache", async () => {
  const g = await r.createGroup({ tenant: acme.id, name: "P", owner: "google:gina" });
  const sp = await r.createSpace({ tenant: acme.id, name: "D", group: g.id, generalRole: null });
  const tm = await r.createTeam({ tenant: acme.id, name: "T" });
  await r.setTeamMember(tm.id, "google:tia", true);
  await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "team", id: tm.id }, role: "commenter" });
  const b = await board(sp.id);
  const link = await r.createLink({ board: b.id, role: "viewer", by: "google:gina" });
  await r.addLinkUse(link.id, "google:lou");
  await r.createInvite({ board: b.id, email: "ivy@partner.io", role: "annotator", by: "google:gina" });
  const people = [id("gina"), id("tia"), id("lou", null), id("ivy", "partner.io"), id("zed"), { ...id("root"), user: "google:root" }];
  const many = await ten.rolesFor(b.id, people);
  const cache = roleCache({ registry: r, now });
  const one = [];
  for (const p of people) one.push(await ten.role(p, b.id));
  expect(people.map((p, i) => [p.user, one[i]])).toEqual([["google:gina", "owner"], ["google:tia", "commenter"], ["google:lou", "viewer"], ["google:ivy", "annotator"], ["google:zed", null], ["google:root", null]]);
  expect(people.map(p => many.get(`${p.user}\n${p.email ?? ""}\n${p.domain ?? ""}`))).toEqual(one);
  for (let i = 0; i < people.length; i++) expect(await cache.role(people[i], b.id)).toBe(one[i]);
  expect(cache.stats().fills).toBe(4);   // the four roles; a null answer is never cached
});

test("a stale-proof read: scoped grant changes show on the very next uncached role()", async () => {
  const sp = await r.createSpace({ tenant: acme.id, name: "D", generalRole: null });
  const b = await board(sp.id);
  const who = id("bob");
  expect(await ten.role(who, b.id)).toBe(null);
  await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "user", id: "google:bob" }, role: "viewer" });
  expect(await ten.role(who, b.id)).toBe("viewer");
  await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "user", id: "google:bob" }, role: null });
  expect(await ten.role(who, b.id)).toBe(null);
});
