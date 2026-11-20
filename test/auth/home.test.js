// The Home screen's read side (server/auth/home.js, PROTOCOL.md § Home) over the real tenancy and the memory Registry:
// listings hold only boards the person can open now (the access-leak tests), Recent / Starred / Shared / tree / search,
// what a guest sees, the batch access check agreeing with the single-board resolver, and its statement count.
import { test, expect, beforeEach, describe } from "bun:test";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy } from "../../server/auth/tenancy.js";
import { accessEquivalence } from "./access-equivalence.js";
import { homeService, recentRecorder, LIMITS, SHARED_PART } from "../../server/auth/home.js";
import { mkBoard } from "./fixtures.js";

let clock, r, ten, home, acme;
const now = () => clock;
const ident = (n, domain = "acme.com") => ({ user: `google:${n}`, name: n, email: `${n}@${domain ?? "x.org"}`, domain });
const ada = ident("ada"), kim = ident("kim", "partner.io");
const mk = (space, title, o = {}) => mkBoard(r, { tenant: acme.id, space, title, ...o });   // no `space`: the fixture Space (no general access)
const ids = cards => cards.map(c => c.id);

beforeEach(async () => {
  clock = 1_000_000;
  r = memoryRegistry({ now });
  ten = tenancy({ registry: r, now });
  home = homeService({ registry: r, tenancy: ten });
  acme = await r.createTenant({ domain: "acme.com", admins: ["google:root"] });
});

describe("a member's place and what they may create (#48)", () => {
  test("home gives every Unit member a personal space once, and says who may create a Group", async () => {
    const root = ident("root");
    const h1 = await home.home(ada);
    expect(h1.tree.spaces.map(s => s.name)).toEqual(["ada's space"]);
    expect((await home.home(ada)).tree.spaces.length).toBe(1);               // idempotent
    expect(h1.can).toEqual({ createGroup: false, manageAccess: false, manageRoles: false });
    expect((await home.home(root)).can).toEqual({ createGroup: true, manageAccess: true, manageRoles: true });
    const g = await home.home(kim);                                         // a guest has no Unit, so no personal space and no Group
    expect([g.tree, g.can]).toEqual([null, { createGroup: false, manageAccess: false, manageRoles: false }]);
  });
});

describe("TECH-DEBT row 66: a Unit-wide board role reaches no personal space", () => {
  test("with the member role giving viewer, Home's tree, recent and search show a member nobody else's personal space or its boards; a content-access admin sees them", async () => {
    const bob = ident("bob"), root = ident("root");
    await r.updateRole(acme.id, "member", { boardRole: "viewer", permissions: [] });
    await home.home(ada); await home.home(bob);
    const diary = await mk((await r.personalSpace(acme.id, ada.user)).id, "Diary entries", { memberRole: null, owner: ada.user });
    await r.markOpened(bob.user, diary.id);
    const shared = await r.createSpace({ tenant: acme.id, name: "Team" });
    const hb = await home.home(bob);
    expect(hb.tree.spaces.map(s => s.name).sort()).toEqual(["Team", "bob's space"]);
    expect(ids(hb.recent)).toEqual([]);
    expect((await home.search(bob, "Diary")).results.map(c => c.id)).toEqual([]);
    expect((await ten.role(bob, diary.id))).toBe(null);
    await r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: { type: "user", id: root.user }, role: "content-admin-personal" });
    const admin = homeService({ registry: r, tenancy: tenancy({ registry: r, now }) });
    expect((await admin.home(root)).tree.spaces.map(s => s.name).sort()).toEqual(["Team", "ada's space", "bob's space", "root's space"]);
    expect(ids((await admin.search(root, "Diary")).results)).toEqual([diary.id]);
    expect(shared.id).toBeTruthy();
  });
});

describe("access leak: a board the person can't open never appears, however it got into a list", () => {
  test("recent, starred, shared and search all drop a Space board with no access", async () => {
    const open = await r.createSpace({ tenant: acme.id, name: "Open" });
    const closed = await r.createSpace({ tenant: acme.id, name: "Closed secrets", generalRole: null });
    const ok = await mk(open.id, "Roadmap ok");
    const secret = await mk(closed.id, "Roadmap secret", { memberRole: null });
    const hidden = await mk(undefined, "Roadmap hidden", { memberRole: null });          // in the fixture Space, members get nothing
    for (const b of [ok, secret, hidden]) { await r.markOpened(ada.user, b.id); clock += 10; }
    for (const b of [ok, secret, hidden]) await r.setStarred(ada.user, b.id, true);       // rows exist (the Registry can't know)
    await r.setGrant(secret.id, ada.user, "viewer"); await r.setGrant(secret.id, ada.user, null);   // a past grant, now gone
    const h = await home.home(ada);
    expect(ids(h.recent)).toEqual([ok.id]);
    expect(ids(h.starred)).toEqual([ok.id]);
    expect(h.shared).toEqual([]);
    expect(ids((await home.search(ada, "roadmap")).results)).toEqual([ok.id]);
    expect(ids((await home.search(ada, "secrets")).results)).toEqual([]);                  // by Space name too
    expect(JSON.stringify(h)).not.toContain(secret.id);
    expect(JSON.stringify(h)).not.toContain(hidden.id);
    expect(JSON.stringify(h)).not.toContain("secrets");                                   // not even the Space's name in the tree
  });

  test("access given later shows up, access taken away disappears, with no stale list", async () => {
    const closed = await r.createSpace({ tenant: acme.id, name: "Closed", generalRole: null });
    const b = await mk(closed.id, "Plan", { memberRole: null });
    await r.markOpened(ada.user, b.id);
    expect((await home.home(ada)).recent).toEqual([]);
    await r.setScopedGrant({ scope: { type: "space", id: closed.id }, subject: { type: "user", id: ada.user }, role: "editor" });
    const h = await home.home(ada);
    expect(h.recent.map(c => [c.id, c.role])).toEqual([[b.id, "editor"]]);
    expect(h.tree.spaces.map(s => s.name).sort()).toEqual(["Closed", "ada's space"]);
    await r.setScopedGrant({ scope: { type: "space", id: closed.id }, subject: { type: "user", id: ada.user }, role: null });
    expect((await home.home(ada)).recent).toEqual([]);
  });

  test("an expired invite, a revoked link and a revoked invite give no Shared with me entry", async () => {
    const a = await mk(undefined, "A", { memberRole: null }), b = await mk(undefined, "B", { memberRole: null }), c = await mk(undefined, "C", { memberRole: null });
    await r.createInvite({ board: a.id, email: kim.email, role: "viewer", expiresAt: clock + 1000, by: "x" });
    const l = await r.createLink({ board: b.id, role: "viewer", by: "x" }); await r.addLinkUse(l.id, kim.user);
    const i = await r.createInvite({ board: c.id, email: kim.email, role: "viewer", by: "x" });
    expect(ids((await home.home(kim)).shared).sort()).toEqual([a.id, b.id, c.id].sort());
    clock += 2000; await r.revokeLink(l.id); await r.revokeInvite(i.id);
    expect((await home.home(kim)).shared).toEqual([]);
  });

  test("a Unit admin has no board content by being admin: an unopenable board stays out of every list", async () => {
    const root = ident("root");
    const b = await mk(undefined, "Private", { memberRole: null });
    await r.markOpened(root.user, b.id);
    const h = await home.home({ ...root, user: "google:root" });
    expect(h.recent).toEqual([]);
    expect(h.shared).toEqual([]);
    expect((await home.search(root, "Private")).results).toEqual([]);
  });
});

describe("Recent, Starred, Shared", () => {
  test("recent: newest first, capped at 12, each with its path and role", async () => {
    const g = await r.createGroup({ tenant: acme.id, name: "Product", generalRole: "viewer" });
    const sp = await r.createSpace({ tenant: acme.id, name: "Design", group: g.id });
    const made = [];
    for (let i = 0; i < 15; i++) { const b = await mk(sp.id, `b${i}`); made.push(b); await r.markOpened(ada.user, b.id); clock += 10; }
    const h = await home.home(ada);
    expect(ids(h.recent)).toEqual(made.slice(3).reverse().map(b => b.id));
    expect(h.recent.length).toBe(LIMITS.recent);
    expect(h.recent[0]).toMatchObject({ title: "b14", role: "viewer", path: [{ type: "group", name: "Product" }, { type: "space", name: "Design" }], starred: false });
    expect(h.recent[0].at).toBe(clock - 10);
  });

  test("starred: flag shows on every list, un-starring removes it, starring needs a role", async () => {
    const sp = await r.createSpace({ tenant: acme.id, name: "S" });
    const closed = await r.createSpace({ tenant: acme.id, name: "C", generalRole: null });
    const a = await mk(sp.id, "A"), b = await mk(closed.id, "B", { memberRole: null });
    expect(await home.star(ada, a.id, true)).toBe(true);
    expect(await home.star(ada, b.id, true)).toBe(false);                    // no role: nothing written
    expect(await home.star(ada, "b-nope000000000000", true)).toBe(false);
    expect(await r.starred(ada.user)).toHaveLength(1);
    await r.markOpened(ada.user, a.id);
    const h = await home.home(ada);
    expect(h.starred.map(c => c.id)).toEqual([a.id]);
    expect(h.recent[0].starred).toBe(true);
    expect((await home.search(ada, "A")).results.find(c => c.id === a.id).starred).toBe(true);
    expect(await home.star(ada, a.id, false)).toBe(true);
    expect(await home.star(ada, a.id, false)).toBe(true);                    // idempotent
    expect((await home.home(ada)).starred).toEqual([]);
  });

  test("shared: direct grants, invites, links across Units, by title", async () => {
    const globex = await r.createTenant({ domain: "globex.com" });
    const sp = await r.createSpace({ tenant: acme.id, name: "Closed", generalRole: null });
    const g1 = await mk(sp.id, "Zeta", { memberRole: null }), g2 = await mk(sp.id, "alpha", { memberRole: null }), mine = await mk(sp.id, "Mine", { memberRole: null });
    await r.setGrant(g1.id, ada.user, "editor"); await r.setGrant(g2.id, ada.user, "viewer"); await r.setGrant(mine.id, ada.user, "owner");
    const foreign = await mkBoard(r, { tenant: globex.id, title: "Foreign", memberRole: null });
    const l = await r.createLink({ board: foreign.id, role: "annotator", by: "x" }); await r.addLinkUse(l.id, ada.user);
    const h = await home.home(ada);
    expect(h.shared.map(c => c.title)).toEqual(["alpha", "Foreign", "Mine", "Zeta"]);     // Mine: owned, but in a Space she can't open, so nowhere else
    expect(h.shared.find(c => c.title === "Foreign")).toMatchObject({ role: "annotator", path: [SHARED_PART] });   // another Unit's board: never a name from this Unit
  });

  test("a team grant on the Space and on the board itself both count", async () => {
    const infra = await r.createTeam({ tenant: acme.id, name: "Infra" });
    await r.setTeamMember(infra.id, ada.user, true);
    const sp = await r.createSpace({ tenant: acme.id, name: "Platform", generalRole: null });
    const inSpace = await mk(sp.id, "Via space", { memberRole: null });
    const lone = await mk(undefined, "Via board", { memberRole: null });
    await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "team", id: infra.id }, role: "editor" });
    await r.setScopedGrant({ scope: { type: "board", id: lone.id }, subject: { type: "team", id: infra.id }, role: "annotator" });
    for (const b of [inSpace, lone]) await r.markOpened(ada.user, b.id);
    const h = await home.home(ada);
    expect(Object.fromEntries(h.recent.map(c => [c.title, c.role]))).toEqual({ "Via space": "editor", "Via board": "annotator" });
    expect(h.tree.spaces.map(s => s.name).sort()).toEqual(["Platform", "ada's space"]);
  });
});

describe("the tree", () => {
  test("only Groups and Spaces the person can open in; personal spaces are private", async () => {
    const g = await r.createGroup({ tenant: acme.id, name: "Product", generalRole: "viewer" });
    const hiddenGroup = await r.createGroup({ tenant: acme.id, name: "Board only", generalRole: null });
    await r.createSpace({ tenant: acme.id, name: "Design", group: g.id });
    await r.createSpace({ tenant: acme.id, name: "Tucked", group: hiddenGroup.id, generalRole: null });
    await r.createSpace({ tenant: acme.id, name: "Social" });
    await r.createSpace({ tenant: acme.id, name: "Locked", generalRole: null });
    await r.ensurePersonalSpace(acme.id, ada.user); await r.ensurePersonalSpace(acme.id, "google:bob");
    const t = (await home.home(ada)).tree;
    expect(t.groups.map(x => [x.name, x.spaces.map(s => s.name)])).toEqual([["Product", ["Design"]]]);
    expect(t.spaces.map(s => [s.name, s.personal]).sort()).toEqual([["Social", false], ["ada's space", true]]);
    expect(JSON.stringify(t)).not.toMatch(/Board only|Tucked|Locked/);
    expect(t.other).toBeUndefined();   // no "Other boards": every board is in a Space
  });

  test("a Group the person can open shows even with no open Space", async () => {
    const g = await r.createGroup({ tenant: acme.id, name: "Shelf", generalRole: "viewer" });
    await r.createGroup({ tenant: acme.id, name: "Nobody's shelf" });                  // general access none: not shown
    expect((await home.home(ada)).tree.groups).toEqual([{ id: g.id, name: "Shelf", spaces: [] }]);
  });
});

describe("search", () => {
  test("title or Space name, with each result's path; scoped to the person's Unit; capped at 20", async () => {
    const g = await r.createGroup({ tenant: acme.id, name: "Product", generalRole: "viewer" });
    const sp = await r.createSpace({ tenant: acme.id, name: "Design Lab", group: g.id });
    const a = await mk(sp.id, "Roadmap"), b = await mk(undefined, "Design review");
    const globex = await r.createTenant({ domain: "globex.com" });
    await mkBoard(r, { tenant: globex.id, title: "Design globex" });
    const res = await home.search(ada, "design");
    expect(res.results.map(c => [c.title, c.path.map(p => p.name)]).sort()).toEqual([["Design review", ["Shared with you"]], ["Roadmap", ["Product", "Design Lab"]]]);
    expect(res.more).toBe(false);
    expect(new Set(ids(res.results))).toEqual(new Set([a.id, b.id]));
    for (let i = 0; i < 30; i++) await mk(sp.id, `design ${i}`);
    const many = await home.search(ada, "design");
    expect(many.results.length).toBe(LIMITS.search);
  });

  test("a search that hits only unopenable boards in its first page still finds an openable one on the next", async () => {
    const closed = await r.createSpace({ tenant: acme.id, name: "Closed", generalRole: null });
    for (let i = 0; i < 100; i++) await mk(closed.id, `plan ${i}`, { memberRole: null });
    const ok = await mk(undefined, "plan visible");
    const res = await home.search(ada, "plan");
    expect(ids(res.results)).toEqual([ok.id]);
    expect(res.more).toBe(false);
  });

  test("a guest searches only titles among what is shared with them", async () => {
    const a = await mk(undefined, "Kickoff plan", { memberRole: null }), b = await mk(undefined, "Budget", { memberRole: null });
    await mk(undefined, "Kickoff other", { memberRole: null });
    for (const x of [a, b]) await r.createInvite({ board: x.id, email: kim.email, role: "viewer", by: "x" });
    expect(ids((await home.search(kim, "kickoff")).results)).toEqual([a.id]);
    expect((await home.search(kim, "acme")).results).toEqual([]);
  });

  test("LIKE characters are literal", async () => {
    const a = await mk(undefined, "100% done");
    await mk(undefined, "plain");
    expect(ids((await home.search(ada, "%")).results)).toEqual([a.id]);
  });
});

describe("a guest's Home", () => {
  test("shows Shared with me only: no recent, starred or tree, and no Unit", async () => {
    const b = await mk(undefined, "Partner board", { memberRole: null });
    const other = await mk(undefined, "Seen once", { memberRole: null });
    await r.createInvite({ board: b.id, email: kim.email, role: "editor", by: "x" });
    await r.markOpened(kim.user, other.id); await r.setStarred(kim.user, other.id, true);
    const h = await home.home(kim);
    expect(h).toMatchObject({ guest: true, unit: null, recent: [], starred: [], tree: null });
    expect(h.shared.map(c => [c.id, c.role])).toEqual([[b.id, "editor"]]);
    expect(await home.home({ user: "google:gm", email: "x@gmail.com", domain: null })).toMatchObject({ guest: true, shared: [] });
  });
});

describe("the batch access check", () => {
  test("accessMany costs a fixed number of Registry calls: one boardRows and ONE accessContexts, whatever the number of Spaces (TECH-DEBT row 35)", async () => {
    const spaces = await Promise.all(["a", "b", "c"].map(n => r.createSpace({ tenant: acme.id, name: n })));
    const boards = [];
    for (let i = 0; i < 90; i++) boards.push(await mk(spaces[i % 3].id, `b${i}`));
    for (let i = 0; i < 10; i++) boards.push(await mk(undefined, `u${i}`));
    const calls = {};
    const spy = new Proxy(r, { get: (t, k) => (typeof t[k] === "function" ? (...a) => { calls[k] = (calls[k] ?? 0) + 1; return t[k](...a); } : t[k]) });
    const found = await tenancy({ registry: spy, now }).accessMany(ada, boards.map(b => b.id));
    expect(found.size).toBe(100);
    expect(calls).toEqual({ boardRows: 1, accessContexts: 1 });                // 3 Spaces + the Unit in one batch, however many boards
  });
});

describe("recentRecorder", () => {
  test("writes once per (user, board) per window, again after it, and drops a failed write without throwing", async () => {
    let t = 0; const wrote = [];
    let fail = false;
    const reg = { async markOpened(u, b) { if (fail) throw new Error("down"); wrote.push([u, b]); } };
    const warns = [];
    const rec = recentRecorder({ registry: reg, now: () => t, windowMs: 100, max: 3, log: { warn: (m, f) => warns.push([m, f.board]) } });
    rec("u", "b1"); rec("u", "b1"); rec("u", "b2"); rec("v", "b1");
    await new Promise(res => setTimeout(res, 0));
    expect(wrote).toEqual([["u", "b1"], ["u", "b2"], ["v", "b1"]]);
    t = 150; rec("u", "b1");
    await new Promise(res => setTimeout(res, 0));
    expect(wrote.length).toBe(4);
    fail = true; t = 400; rec("u", "b9");
    await new Promise(res => setTimeout(res, 0));
    expect(warns).toEqual([["recent write failed", "b9"]]);
    fail = false; rec("u", "b9");                                               // a failed write is retried at once, not held off for the window
    await new Promise(res => setTimeout(res, 0));
    expect(wrote.at(-1)).toEqual(["u", "b9"]);
    rec(1, "b"); rec("u", null);                                                 // junk is ignored
    for (let i = 0; i < 10; i++) rec("w", "x" + i);                              // the dedupe map stays bounded (max 3): no throw
  });
});

describe("names are access too: path redaction and Space-name search (member and guest)", () => {
  const setup = async () => {
    const hiddenGroup = await r.createGroup({ tenant: acme.id, name: "Hidden Group" });
    const secret = await r.createSpace({ tenant: acme.id, name: "Secret Plans", group: hiddenGroup.id, generalRole: null });
    const planB = await mk(secret.id, "Plan B", { memberRole: null });
    await r.setGrant(planB.id, ada.user, "editor");                                    // a direct grant on one board inside a private Space
    return { hiddenGroup, secret, planB };
  };

  test("a member with a direct grant sees the board, with 'Shared with you' for the Space and Group above it, in every list", async () => {
    const { planB } = await setup();
    await r.markOpened(ada.user, planB.id); await r.setStarred(ada.user, planB.id, true);
    const h = await home.home(ada);
    for (const list of [h.recent, h.starred, h.shared]) expect(list.map(c => [c.id, c.path])).toEqual([[planB.id, [SHARED_PART]]]);
    expect((await home.search(ada, "plan b")).results.map(c => c.path)).toEqual([[SHARED_PART]]);
    expect(JSON.stringify(h)).not.toMatch(/Secret Plans|Hidden Group/);
    expect(JSON.stringify(h.tree)).not.toMatch(/Secret Plans|Hidden Group/);
  });

  test("a Space-name search can't probe a hidden Space: its name finds nothing, its boards still answer to their own titles", async () => {
    await setup();
    for (const q of ["secret", "SECRET plans", "hidden group", "plans"]) {
      const res = await home.search(ada, q);
      expect(res.results.map(c => c.title)).toEqual(q === "plans" ? [] : []);
    }
    expect((await home.search(ada, "Plan B")).results).toHaveLength(1);
  });

  test("an openable Space's name is both shown and searchable", async () => {
    const g = await r.createGroup({ tenant: acme.id, name: "Visible Group", generalRole: "viewer" });
    const sp = await r.createSpace({ tenant: acme.id, name: "Quarterly", group: g.id });
    const b = await mk(sp.id, "Untitled-1");
    const res = await home.search(ada, "quarterly");
    expect(res.results.map(c => [c.id, c.path.map(p => p.name)])).toEqual([[b.id, ["Visible Group", "Quarterly"]]]);
  });

  test("a Group the person can't open is dropped from the path of a board in a Space they can", async () => {
    const g = await r.createGroup({ tenant: acme.id, name: "Closed Group" });                     // general access none
    const sp = await r.createSpace({ tenant: acme.id, name: "Open Space", group: g.id });          // viewer for everyone
    const b = await mk(sp.id, "In open");
    await r.markOpened(ada.user, b.id);
    const h = await home.home(ada);
    expect(h.recent[0].path.map(p => p.name)).toEqual(["Open Space"]);
    expect(JSON.stringify(h)).not.toContain("Closed Group");
    expect(h.tree.groups).toEqual([]);                                                            // and not in the tree either
    expect(h.tree.spaces.map(x => x.name).sort()).toEqual(["Open Space", "ada's space"]);
  });

  test("a guest never sees another Unit's Group or Space names, on any list or in search", async () => {
    const { secret, planB } = await setup();
    const open = await r.createSpace({ tenant: acme.id, name: "Public Space", generalRole: "viewer" });
    const pub = await mk(open.id, "Public board", { memberRole: null });
    for (const b of [planB, pub]) await r.createInvite({ board: b.id, email: kim.email, role: "viewer", by: "x" });
    await r.markOpened(kim.user, planB.id);
    const h = await home.home(kim);
    expect(h.shared.map(c => c.path)).toEqual([[SHARED_PART], [SHARED_PART]]);
    expect(h.recent.map(c => c.path)).toEqual([[SHARED_PART]]);
    expect(JSON.stringify(h)).not.toMatch(/Secret Plans|Hidden Group|Public Space/);
    for (const q of ["secret", "public space", "plan b"]) expect(JSON.stringify(await home.search(kim, q))).not.toMatch(/Secret Plans|Hidden Group|Public Space/);
    expect((await home.search(kim, "secret")).results).toEqual([]);
    expect(await home.spaceBoards(kim, secret.id)).toEqual({ space: null, results: [], more: false });   // a guest has no Unit to browse
  });
});

describe("Your boards, Shared with me, and guests", () => {
  test("a guest's owned boards are 'Your boards' (owned), the rest Shared; they also get Recent but no Starred", async () => {
    const mineB = await mk(undefined, "Mine", { memberRole: null }), theirs = await mk(undefined, "Theirs", { memberRole: null });
    await r.setGrant(mineB.id, kim.user, "owner"); await r.setGrant(theirs.id, kim.user, "editor");
    await r.markOpened(kim.user, theirs.id);
    const h = await home.home(kim);
    expect(h.owned.map(c => c.title)).toEqual(["Mine"]);
    expect(h.shared.map(c => c.title)).toEqual(["Theirs"]);
    expect(h.recent.map(c => c.title)).toEqual(["Theirs"]);
    expect(h).toMatchObject({ guest: true, starred: [], tree: null });
    expect(await home.star(kim, theirs.id, true)).toBe(false);                    // no Starred for guests
    expect(await r.starred(kim.user)).toEqual([]);
    expect((await home.search(kim, "mine")).results.map(c => c.title)).toEqual(["Mine"]);
  });

  test("a member's owned boards are not duplicated in Shared when the tree shows them; an owned board in a closed Space still is", async () => {
    const open = await r.createSpace({ tenant: acme.id, name: "Open" }), closed = await r.createSpace({ tenant: acme.id, name: "Closed", generalRole: null });
    const a = await mk(open.id, "Owned open"), b = await mk(closed.id, "Owned closed", { memberRole: null });
    for (const x of [a, b]) await r.setGrant(x.id, ada.user, "owner");
    const h = await home.home(ada);
    expect(h.owned).toEqual([]);
    expect(h.shared.map(x => x.title)).toEqual(["Owned closed"]);                   // not in Open (the tree shows that one)
  });

  test("Shared means a source on the board itself whose Space they can't open: a Team grant counts, a board in an openable Space doesn't", async () => {
    const infra = await r.createTeam({ tenant: acme.id, name: "Infra" }); await r.setTeamMember(infra.id, ada.user, true);
    const open = await r.createSpace({ tenant: acme.id, name: "Open" }), closed = await r.createSpace({ tenant: acme.id, name: "Closed", generalRole: null });
    const viaTeam = await mk(closed.id, "Via team", { memberRole: null }), inOpen = await mk(open.id, "In open space"), viaGrant = await mk(closed.id, "Via grant", { memberRole: null });
    await r.setScopedGrant({ scope: { type: "board", id: viaTeam.id }, subject: { type: "team", id: infra.id }, role: "viewer" });
    await r.setGrant(inOpen.id, ada.user, "editor"); await r.setGrant(viaGrant.id, ada.user, "viewer");
    const h = await home.home(ada);
    expect(h.shared.map(c => c.title)).toEqual(["Via grant", "Via team"]);
  });

  test("a member may star; a guest may not (home.star false), and an un-star is always allowed", async () => {
    const b = await mk(undefined, "B");
    expect(await home.star(ada, b.id, true)).toBe(true);
    expect(await home.star(kim, b.id, false)).toBe(true);
  });
});

describe("one Space's boards (the tree's click)", () => {
  test("lists the Space's openable boards by id and names the Space only when it can be opened", async () => {
    const open = await r.createSpace({ tenant: acme.id, name: "Design" }), closed = await r.createSpace({ tenant: acme.id, name: "Closed", generalRole: null });
    const other = await r.createSpace({ tenant: acme.id, name: "Design 2" });
    const a = await mk(open.id, "A"), b = await mk(open.id, "B"); await mk(other.id, "Elsewhere");
    const hidden = await mk(closed.id, "Hidden", { memberRole: null }), reach = await mk(closed.id, "Reached", { memberRole: null });
    await r.setGrant(reach.id, ada.user, "viewer");
    const res = await home.spaceBoards(ada, open.id);
    expect(res.space).toEqual({ id: open.id, name: "Design" });
    expect(ids(res.results)).toEqual([a.id, b.id]);                                   // "Design 2"'s board is not here: it is by id, not by text
    const sealed = await home.spaceBoards(ada, closed.id);
    expect(sealed.space).toBe(null);
    expect(ids(sealed.results)).toEqual([reach.id]);
    expect(JSON.stringify(sealed)).not.toMatch(/Closed|Hidden/);
    expect(ids(sealed.results)).not.toContain(hidden.id);
    expect(await home.spaceBoards(ada, "s-nope")).toEqual({ space: null, results: [], more: false });
    const globex = await r.createTenant({ domain: "globex.com" }), gs = await r.createSpace({ tenant: globex.id, name: "G" });
    expect(await home.spaceBoards(ada, gs.id)).toEqual({ space: null, results: [], more: false });   // another Unit's Space
  });
});

describe("can on Home cards (#91)", () => {
  test("a member's Home and search cards carry can.move from the resolver's `move` permission (an owner has it, a plain viewer does not); a guest's cards carry no `can`", async () => {
    const sp = await r.createSpace({ tenant: acme.id, name: "Design" });
    const mine = await mk(sp.id, "Mine"), theirs = await mk(sp.id, "Theirs");
    await r.setGrant(mine.id, ada.user, "owner"); await r.setGrant(theirs.id, ada.user, "viewer");
    const via = [await home.search(ada, "Mine"), await home.search(ada, "Theirs")].map(x => x.results[0]);
    expect(via[0].can.move).toBe(true);
    expect(via[1].can.move).toBe(false);
    expect(Object.keys(via[0].can).sort()).toEqual(["move", "rename", "trash"]);
    await r.setGrant(mine.id, kim.user, "owner");
    const g = await home.home(kim);
    expect(g.guest).toBe(true);
    expect(g.owned.length + g.shared.length).toBeGreaterThan(0);
    for (const c of [...g.shared, ...g.owned]) expect(c.can).toBeUndefined();
  });
});

describe("can.move needs the board's own Unit (#91)", () => {
  test("an acme member holding owner on a globex board is offered no Move on Home (the route would refuse them); the same member's own-Unit board is", async () => {
    const globex = await r.createTenant({ domain: "globex.com" }), gs = await r.createSpace({ tenant: globex.id, name: "G" });
    const foreign = await mkBoard(r, { tenant: globex.id, space: gs.id, title: "Foreign" });
    await r.setGrant(foreign.id, ada.user, "owner");
    const sp = await r.createSpace({ tenant: acme.id, name: "Design" }), own = await mk(sp.id, "Own"); await r.setGrant(own.id, ada.user, "owner");
    const h = await home.home(ada), found = [...h.shared, ...(await home.search(ada, "Foreign")).results].filter(c => c.id === foreign.id);
    expect(found.length).toBeGreaterThan(0);
    for (const c of found) expect(c.can.move).toBe(false);
    expect((await home.search(ada, "Own")).results[0].can.move).toBe(true);
  });
  test("GET /home/search?space= cards carry can (LOW-1)", async () => {
    const sp = await r.createSpace({ tenant: acme.id, name: "Design" }), b = await mk(sp.id, "B"); await r.setGrant(b.id, ada.user, "owner");
    const res = await home.spaceBoards(ada, sp.id);
    expect(res.results.map(c => [c.id, c.can.move])).toEqual([[b.id, true]]);
  });
});

describe("bounds", () => {
  const spy = reg => { const calls = {}; return { calls, reg: new Proxy(reg, { get: (t, k) => (typeof t[k] === "function" ? (...a) => { calls[k] = (calls[k] ?? 0) + 1; return t[k](...a); } : t[k]) }) }; };

  test("the tree reads a page of Space candidates, never the whole Unit, and flags what it left out", async () => {
    for (let i = 0; i < 130; i++) await r.createSpace({ tenant: acme.id, name: `s${String(i).padStart(3, "0")}` });
    const { calls, reg } = spy(r);
    const h = await homeService({ registry: reg, tenancy: tenancy({ registry: reg, now }) }).home(ada);
    expect(h.tree.spaces.length).toBe(LIMITS.spaces);
    expect(h.tree.more).toBe(true);
    expect(calls.spaces).toBeUndefined();                                              // Registry.spaces(tenant) (the whole Unit) is never called
    expect(calls.groups).toBeUndefined();
    expect(calls.spaceCandidates).toBe(1);
    expect(calls.accessContext ?? 0).toBeLessThanOrEqual(3);                           // general access resolved from the rows in hand: no per-Space reads
  });

  test("Spaces that need the resolver's full answer (grants) are checked at most a fixed number of times; the rest set `more`", async () => {
    for (let i = 0; i < 60; i++) { const s = await r.createSpace({ tenant: acme.id, name: `g${i}`, generalRole: null }); await r.setScopedGrant({ scope: { type: "space", id: s.id }, subject: { type: "user", id: ada.user }, role: "viewer" }); }
    const { calls, reg } = spy(r);
    const h = await homeService({ registry: reg, tenancy: tenancy({ registry: reg, now }) }).home(ada);
    expect(h.tree.spaces.length).toBe(40);
    expect(h.tree.more).toBe(true);
    expect(calls.accessContext).toBeLessThanOrEqual(45);
  });

  test("search is work-bounded: when the Unit goes on past what it scanned it says `more`", async () => {
    const sp = await r.createSpace({ tenant: acme.id, name: "Many" });
    for (let i = 0; i < 6; i++) await mk(sp.id, `hay ${i}`);
    const { calls, reg } = spy(r);
    const small = new Proxy(reg, { get: (t, k) => (k === "searchBoards" ? (tenant, o) => t.searchBoards(tenant, { ...o, scan: 2 }) : t[k]) });
    const res = await homeService({ registry: small, tenancy: tenancy({ registry: small, now }) }).search(ada, "hay");
    expect(calls.searchBoards).toBe(2);                                                  // two pages, then it stops
    expect(res.results.length).toBe(4);
    expect(res.more).toBe(true);
  });
});

describe("what is hidden must not change what is said (search `more`, Space route)", () => {
  const hiddenSpace = async (n, name = "Project Falcon acquisition") => {
    const sp = await r.createSpace({ tenant: acme.id, name, generalRole: null });
    for (let i = 0; i < n; i++) await mk(sp.id, `board ${i}`, { memberRole: null });
    return sp;
  };

  test("search: 230 boards in a hidden Space whose name matches give the same answer as a query that matches nothing", async () => {
    await hiddenSpace(230);
    const byName = await home.search(ada, "falcon"), nothing = await home.search(ada, "qqqq");
    expect([byName.results, byName.more]).toEqual([[], false]);
    expect([nothing.results, nothing.more]).toEqual([[], false]);
    expect(JSON.stringify(byName).replace("falcon", "X")).toBe(JSON.stringify(nothing).replace("qqqq", "X"));
  });

  test("search: visible matches are not crowded out by hidden ones in the same window, and more means only visible overflow or the window's end", async () => {
    await hiddenSpace(230);
    const open = await r.createSpace({ tenant: acme.id, name: "Open" });
    const vis = await mk(open.id, "Falcon notes");
    expect(ids((await home.search(ada, "falcon")).results)).toEqual([vis.id]);
    for (let i = 0; i < 25; i++) await mk(open.id, `falcon ${i}`);
    const many = await home.search(ada, "falcon");
    expect(many.results.length).toBe(LIMITS.search);
    expect(many.more).toBe(true);                                   // a 21st openable match
  });

  test("search: `more` when the window ends before the Unit does (and it doesn't depend on matches)", async () => {
    for (let i = 0; i < 5; i++) await mk(undefined, `plain ${i}`);
    const tiny = new Proxy(r, { get: (t, k) => (k === "searchBoards" ? (tenant, o) => t.searchBoards(tenant, { ...o, scan: 2 }) : t[k]) });
    const svc = homeService({ registry: tiny, tenancy: tenancy({ registry: tiny, now }) });
    expect((await svc.search(ada, "plain")).more).toBe(true);
    expect((await svc.search(ada, "qqqq")).more).toBe(true);
  });

  test("space route: a hidden Space with 650 boards (more than the 3 pages it reads) answers exactly like an unknown id", async () => {
    const sp = await hiddenSpace(650, "Hidden Nine");
    const hidden = await home.spaceBoards(ada, sp.id), unknown = await home.spaceBoards(ada, "s-nope");
    expect(hidden).toEqual(unknown);
    expect(hidden).toEqual({ space: null, results: [], more: false });
  });

  test("space route: an open Space pages past 200 boards and says more only when the pages ran out; its overflow past 50 cards says more", async () => {
    const sp = await r.createSpace({ tenant: acme.id, name: "Big" });
    for (let i = 0; i < 60; i++) await mk(sp.id, `x${i}`);
    const res = await home.spaceBoards(ada, sp.id);
    expect([res.space.name, res.results.length, res.more]).toEqual(["Big", LIMITS.space, true]);
  });
});

describe("tree.more on Group overflow, and owned cards", () => {
  test("60 Groups the person can open: the tree shows 50 and says more", async () => {
    for (let i = 0; i < 60; i++) await r.createGroup({ tenant: acme.id, name: `grp ${String(i).padStart(2, "0")}`, generalRole: "viewer" });
    const t = (await home.home(ada)).tree;
    expect(t.groups.length).toBe(50);
    expect(t.more).toBe(true);
    const fewer = await (async () => { const reg2 = memoryRegistry({ now }); const u = await reg2.createTenant({ domain: "acme.com" }); for (let i = 0; i < 50; i++) await reg2.createGroup({ tenant: u.id, name: `g${i}`, generalRole: "viewer" });
      const t2 = tenancy({ registry: reg2, now }); return (await homeService({ registry: reg2, tenancy: t2, now }).home(ada)).tree; })();
    expect([fewer.groups.length, fewer.more]).toEqual([50, false]);                      // exactly the cap is not an overflow
  });

  test("a guest's owned card has no path (not 'Shared with you')", async () => {
    const b = await mk(undefined, "Mine", { memberRole: null });
    await r.setGrant(b.id, kim.user, "owner");
    const h = await home.home(kim);
    expect(h.owned.map(c => [c.title, c.path])).toEqual([["Mine", []]]);
  });
});

describe("recentRecorder under a join storm", () => {
  test("10,000 welcomes with a slow Registry: at most maxInFlight writes run at once, the rest are dropped and counted, never queued", async () => {
    let t = 0, running = 0, peak = 0, started = 0; const waiting = [];
    const reg = { markOpened: () => new Promise(res => { started++; running++; peak = Math.max(peak, running); waiting.push(() => { running--; res(); }); }) };
    const warns = [];
    const rec = recentRecorder({ registry: reg, now: () => t, maxInFlight: 16, windowMs: 60_000, log: { warn: m => warns.push(m) } });
    for (let i = 0; i < 10_000; i++) { rec("u" + (i % 2000), "b" + i); if (i % 1000 === 0) t += 1; }
    await Promise.resolve(); await Promise.resolve();
    expect(started).toBe(16);
    expect(peak).toBe(16);
    expect(rec.stats()).toMatchObject({ inFlight: 16, dropped: 9_984 });
    expect(warns.length).toBe(1);                                                        // one line per window, not one per drop
    while (waiting.length) { waiting.shift()(); await new Promise(res => setTimeout(res, 0)); }
    expect(rec.stats()).toMatchObject({ written: 16, inFlight: 0 });
    rec("u0", "b-dropped-earlier");                                                      // a dropped welcome wasn't remembered: the next one writes
    await Promise.resolve(); await Promise.resolve();
    expect(started).toBe(17);
  });
});

accessEquivalence("memory", async ({ now }) => memoryRegistry({ now }));
