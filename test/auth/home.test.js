// The Home screen's read side (server/auth/home.js, PROTOCOL.md § Home) over the real tenancy and the memory Registry:
// listings hold only boards the person can open now (the access-leak tests), Recent / Starred / Shared / tree / search,
// what a guest sees, the batch access check agreeing with the single-board resolver, and its statement count.
import { test, expect, beforeEach, describe } from "bun:test";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy } from "../../server/auth/tenancy.js";
import { homeService, recentRecorder, LIMITS, OTHER } from "../../server/auth/home.js";

let clock, r, ten, home, acme;
const now = () => clock;
const ident = (n, domain = "acme.com") => ({ user: `google:${n}`, name: n, email: `${n}@${domain ?? "x.org"}`, domain });
const ada = ident("ada"), kim = ident("kim", "partner.io");
const mk = (space, title, o = {}) => r.createBoard({ tenant: acme.id, space, title, ...o });
const ids = cards => cards.map(c => c.id);

beforeEach(async () => {
  clock = 1_000_000;
  r = memoryRegistry({ now });
  ten = tenancy({ registry: r, now });
  home = homeService({ registry: r, tenancy: ten });
  acme = await r.createTenant({ domain: "acme.com", admins: ["google:root"] });
});

describe("access leak: a board the person can't open never appears, however it got into a list", () => {
  test("recent, starred, shared and search all drop a Space board with no access", async () => {
    const open = await r.createSpace({ tenant: acme.id, name: "Open" });
    const closed = await r.createSpace({ tenant: acme.id, name: "Closed secrets", generalRole: null });
    const ok = await mk(open.id, "Roadmap ok");
    const secret = await mk(closed.id, "Roadmap secret", { memberRole: null });
    const hidden = await mk(undefined, "Roadmap hidden", { memberRole: null });          // unfiled, members get nothing
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
    expect(h.tree.spaces.map(s => s.name)).toEqual(["Closed"]);
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
    expect(h.tree.other.boards).toEqual([]);
  });
});

describe("Recent, Starred, Shared", () => {
  test("recent: newest first, capped at 12, each with its path and role", async () => {
    const g = await r.createGroup({ tenant: acme.id, name: "Product" });
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

  test("shared: direct grants, invites, links across Units, by title; owned boards are not 'shared'", async () => {
    const globex = await r.createTenant({ domain: "globex.com" });
    const sp = await r.createSpace({ tenant: acme.id, name: "Closed", generalRole: null });
    const g1 = await mk(sp.id, "Zeta", { memberRole: null }), g2 = await mk(sp.id, "alpha", { memberRole: null }), mine = await mk(sp.id, "Mine", { memberRole: null });
    await r.setGrant(g1.id, ada.user, "editor"); await r.setGrant(g2.id, ada.user, "viewer"); await r.setGrant(mine.id, ada.user, "owner");
    const foreign = await r.createBoard({ tenant: globex.id, title: "Foreign", memberRole: null });
    const l = await r.createLink({ board: foreign.id, role: "annotator", by: "x" }); await r.addLinkUse(l.id, ada.user);
    const h = await home.home(ada);
    expect(h.shared.map(c => c.title)).toEqual(["alpha", "Foreign", "Zeta"]);
    expect(h.shared.find(c => c.title === "Foreign")).toMatchObject({ role: "annotator", path: [OTHER] });
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
    expect(h.tree.spaces.map(s => s.name)).toEqual(["Platform"]);
  });
});

describe("the tree", () => {
  test("only Groups and Spaces the person can open in; personal spaces are private; unfiled boards under Other boards", async () => {
    const g = await r.createGroup({ tenant: acme.id, name: "Product" });
    const hiddenGroup = await r.createGroup({ tenant: acme.id, name: "Board only", generalRole: null });
    await r.createSpace({ tenant: acme.id, name: "Design", group: g.id });
    await r.createSpace({ tenant: acme.id, name: "Tucked", group: hiddenGroup.id, generalRole: null });
    await r.createSpace({ tenant: acme.id, name: "Social" });
    await r.createSpace({ tenant: acme.id, name: "Locked", generalRole: null });
    await r.ensurePersonalSpace(acme.id, ada.user); await r.ensurePersonalSpace(acme.id, "google:bob");
    const open = await mk(undefined, "Old board"); await mk(undefined, "Old private", { memberRole: null });
    const t = (await home.home(ada)).tree;
    expect(t.groups.map(x => [x.name, x.spaces.map(s => s.name)])).toEqual([["Product", ["Design"]]]);
    expect(t.spaces.map(s => [s.name, s.personal]).sort()).toEqual([["Social", false], ["ada's space", true]]);
    expect(t.other).toEqual({ boards: [{ id: open.id, title: "Old board" }], more: false });
  });

  test("a Group the person can open shows even with no open Space", async () => {
    const g = await r.createGroup({ tenant: acme.id, name: "Shelf", generalRole: "viewer" });
    await r.createGroup({ tenant: acme.id, name: "Nobody's shelf" });                  // general access none: not shown
    expect((await home.home(ada)).tree.groups).toEqual([{ id: g.id, name: "Shelf", spaces: [] }]);
  });
});

describe("search", () => {
  test("title or Space name, with each result's path; scoped to the person's Unit; capped at 20", async () => {
    const g = await r.createGroup({ tenant: acme.id, name: "Product" });
    const sp = await r.createSpace({ tenant: acme.id, name: "Design Lab", group: g.id });
    const a = await mk(sp.id, "Roadmap"), b = await mk(undefined, "Design review");
    const globex = await r.createTenant({ domain: "globex.com" });
    await r.createBoard({ tenant: globex.id, title: "Design globex" });
    const res = await home.search(ada, "design");
    expect(res.results.map(c => [c.title, c.path.map(p => p.name)]).sort()).toEqual([["Design review", ["Other boards"]], ["Roadmap", ["Product", "Design Lab"]]]);
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
  test("accessMany costs a fixed number of Registry calls: one boardRows, one accessContext per distinct Space", async () => {
    const spaces = await Promise.all(["a", "b", "c"].map(n => r.createSpace({ tenant: acme.id, name: n })));
    const boards = [];
    for (let i = 0; i < 90; i++) boards.push(await mk(spaces[i % 3].id, `b${i}`));
    for (let i = 0; i < 10; i++) boards.push(await mk(undefined, `u${i}`));
    const calls = {};
    const spy = new Proxy(r, { get: (t, k) => (typeof t[k] === "function" ? (...a) => { calls[k] = (calls[k] ?? 0) + 1; return t[k](...a); } : t[k]) });
    const found = await tenancy({ registry: spy, now }).accessMany(ada, boards.map(b => b.id));
    expect(found.size).toBe(100);
    expect(calls).toEqual({ boardRows: 1, accessContext: 4 });                  // 3 Spaces + the Unit, however many boards
  });

  test("accessMany agrees with tenancy.effective on a random registry (ladder, permissions, sources)", async () => {
    let seed = 7;
    const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const pick = a => a[rnd(a.length)];
    const roles = ["viewer", "commenter", "annotator", "editor", "owner"], generals = [null, "viewer", "annotator", "editor"];
    const people = [ada, ident("bob"), ident("cy", "acme.io"), kim, ident("dee", null), { user: "google:root", email: "root@acme.com", domain: "acme.com" }];
    await r.addTenantDomain(acme.id, "acme.io");
    const teams = [];
    for (let i = 0; i < 3; i++) { const t = await r.createTeam({ tenant: acme.id, name: `t${i}` }); teams.push(t); for (const p of people) if (rnd(2)) await r.setTeamMember(t.id, p.user, true); }
    const groups = [await r.createGroup({ tenant: acme.id, name: "g", generalRole: pick(generals) })];
    const spaces = [null];
    for (let i = 0; i < 4; i++) spaces.push((await r.createSpace({ tenant: acme.id, name: `s${i}`, group: rnd(2) ? groups[0].id : null, generalRole: pick(generals) })).id);
    for (const s of spaces.slice(1)) for (const p of people) if (rnd(4) === 0) await r.setScopedGrant({ scope: { type: "space", id: s }, subject: { type: "user", id: p.user }, role: pick(roles.slice(0, 4)) });
    await r.setScopedGrant({ scope: { type: "group", id: groups[0].id }, subject: { type: "team", id: teams[0].id }, role: "viewer" });
    const boards = [];
    for (let i = 0; i < 40; i++) {
      const b = await mk(pick(spaces) ?? undefined, `b${i}`, { memberRole: pick(generals) });
      boards.push(b);
      for (const p of people) {
        if (rnd(6) === 0) await r.setGrant(b.id, p.user, pick(roles));
        if (rnd(8) === 0) await r.createInvite({ board: b.id, email: p.email, role: pick(["viewer", "editor"]), expiresAt: rnd(2) ? clock + 5000 : null, by: "x" });
        if (rnd(8) === 0) { const l = await r.createLink({ board: b.id, role: pick(["viewer", "annotator"]), by: "x" }); await r.addLinkUse(l.id, p.user); if (rnd(3) === 0) await r.revokeLink(l.id); }
      }
      if (rnd(5) === 0) await r.setScopedGrant({ scope: { type: "board", id: b.id }, subject: { type: "team", id: pick(teams).id }, role: pick(["viewer", "editor"]) });
    }
    clock += 6000;                                                               // some invites have expired now
    let someOpen = 0;
    for (const p of people) {
      const batch = await ten.accessMany(p, boards.map(b => b.id));
      for (const b of boards) {
        const one = await ten.effective(p, b.id), many = batch.get(b.id).access;
        if (one.ladder) someOpen++;
        expect([b.id, p.user, many.ladder, [...many.permissions].sort(), many.sources]).toEqual([b.id, p.user, one.ladder, [...one.permissions].sort(), one.sources]);
      }
    }
    expect(someOpen).toBeGreaterThan(20);                                        // the scenario isn't vacuous
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
