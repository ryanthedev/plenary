// Spaces and Groups (server/auth/spaces.js, PROTOCOL.md § Spaces and Groups): create by permission, pickers, pages, rename, general access
// and its announcements, and the no-leak rule, over the real tenancy and the memory Registry, then over the HTTP routes.
import { test, expect, beforeEach, describe } from "bun:test";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy as makeTenancy } from "../../server/auth/tenancy.js";
import { spaceService, ANNOUNCE } from "../../server/auth/spaces.js";
import { httpRoutes } from "../../server/auth/http.js";
import { sessions as makeSessions } from "../../server/auth/session.js";
import { devAuth } from "../../server/auth/dev.js";

let r, ten, svc, acme, announced;
const ident = (n, domain = "acme.com") => ({ user: `google:${n}`, name: n, email: `${n}@${domain}`, domain });
const ada = ident("ada"), max = ident("max"), kim = ident("kim", "partner.io"), root = { ...ident("root"), user: "google:root" };
let product, design, secret, platform, loose;

beforeEach(async () => {
  r = memoryRegistry();
  ten = makeTenancy({ registry: r });
  announced = [];
  svc = spaceService({ registry: r, tenancy: ten, announce: (tenant, board) => { announced.push(board); } });
  acme = await r.createTenant({ domain: "acme.com", admins: ["google:root"] });
  product = await r.createGroup({ tenant: acme.id, name: "Product", generalRole: null, owner: "google:ada" });
  design = await r.createSpace({ tenant: acme.id, name: "Design", group: product.id, generalRole: "viewer", owner: "google:ada" });
  secret = await r.createSpace({ tenant: acme.id, name: "Secret roadmap", generalRole: null, owner: "google:root" });
  platform = await r.createSpace({ tenant: acme.id, name: "Platform", generalRole: "viewer" });           // everyone views
  loose = await r.createSpace({ tenant: acme.id, name: "Everyone edits", generalRole: "editor" });
});
const code = p => p.then(() => null, e => e.code ?? e.message);

describe("POST /boards: board.create at the Space, or the personal space", () => {
  test("no space: the personal space, always, owner grant, private by default", async () => {
    const b = await svc.createBoard(max, { title: "  Offsite ideas " });
    expect(b).toMatchObject({ title: "Offsite ideas", memberRole: null, tenant: acme.id });
    const sp = await r.space(b.space);
    expect(sp).toMatchObject({ kind: "personal", owner: "google:max", generalRole: null });
    expect(await r.grant(b.id, "google:max")).toBe("owner");
    expect(await ten.role(ada, b.id)).toBe(null);                    // nobody else sees a personal board
    expect((await svc.createBoard(max, {})).space).toBe(b.space);   // one personal space
  });
  test("a Space where the caller can create (editor via general access or via a grant); owner of it too", async () => {
    expect((await svc.createBoard(max, { space: loose.id })).space).toBe(loose.id);
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: { type: "user", id: "google:max" }, role: "editor" });
    expect((await svc.createBoard(max, { space: platform.id })).space).toBe(platform.id);
    expect((await svc.createBoard(ada, { space: design.id })).space).toBe(design.id);
  });
  test("a Group editor creates in its Spaces (a role on a container covers what is inside)", async () => {
    await r.setScopedGrant({ scope: { type: "group", id: product.id }, subject: { type: "user", id: "google:max" }, role: "editor" });
    expect((await svc.createBoard(max, { space: design.id })).space).toBe(design.id);
  });
  test("viewer, hidden, unknown, other-Unit and nonsense spaces are all one refusal", async () => {
    const globex = await r.createTenant({ domain: "globex.com" });
    const foreign = await r.createSpace({ tenant: globex.id, name: "Theirs", generalRole: "editor" });
    for (const space of [platform.id, secret.id, "s-nope00000000", foreign.id]) expect(await code(svc.createBoard(max, { space }))).toBe("forbidden");
    expect(await code(svc.createBoard(max, { space: "a b" }))).toBe("bad-request");
    expect(await r.boardsIn({ type: "space", id: secret.id })).toEqual({ ids: [], next: null });
  });
  test("a guest and a user with no Unit never create, even where an id is known", async () => {
    for (const who of [kim, { user: "dev:z", name: "z", email: null, domain: null }]) {
      expect(await code(svc.createBoard(who, {}))).toBe("forbidden");
      expect(await code(svc.createBoard(who, { space: loose.id }))).toBe("forbidden");
    }
    // a scoped grant written for a guest is inert
    await r.setScopedGrant({ scope: { type: "space", id: secret.id }, subject: { type: "user", id: kim.user }, role: "owner" });
    expect(await code(svc.createBoard(kim, { space: secret.id }))).toBe("forbidden");
  });
  test("a Unit admin creates anywhere by permission, without opening what they create in", async () => {
    expect((await svc.createBoard(root, { space: platform.id })).space).toBe(platform.id);
    expect((await svc.createBoard(root, { space: design.id })).space).toBe(design.id);
  });
  test("validation: title, memberRole (never owner); nothing is made on a bad request", async () => {
    const before = (await r.boardsIn({ type: "unit", id: acme.id })).ids.length;
    expect(await code(svc.createBoard(max, { title: "x".repeat(201) }))).toBe("bad-request");
    expect(await code(svc.createBoard(max, { title: 5 }))).toBe("bad-request");
    expect(await code(svc.createBoard(max, { memberRole: "owner" }))).toBe("bad-request");
    expect(await code(svc.createBoard(max, { memberRole: "god" }))).toBe("bad-request");
    expect((await r.boardsIn({ type: "unit", id: acme.id })).ids.length).toBe(before);
    expect((await svc.createBoard(max, { memberRole: "viewer" })).memberRole).toBe("viewer");
  });
});

describe("the New board picker lists exactly where POST /boards succeeds (and never a Space the person can't open)", () => {
  test("personal first, then the Spaces with board.create; viewers, hidden Spaces and hidden Groups are absent", async () => {
    const got = await svc.boardPicker(max);
    expect(got.spaces.map(s => s.name)).toEqual(["max's space", "Everyone edits"]);
    expect(got.spaces[0]).toMatchObject({ personal: true, general: null, group: null });
    expect(JSON.stringify(got)).not.toMatch(/Secret|Product|Platform|Design/);
    expect(got.more).toBe(false);
  });
  test("a Group's name appears only when the person can open the Group", async () => {
    await r.setScopedGrant({ scope: { type: "space", id: design.id }, subject: { type: "user", id: "google:max" }, role: "editor" });
    let got = await svc.boardPicker(max);
    expect(got.spaces.find(s => s.id === design.id)).toMatchObject({ name: "Design", group: null });       // Space-level grant: the Group stays unnamed
    await r.setScopedGrant({ scope: { type: "group", id: product.id }, subject: { type: "user", id: "google:max" }, role: "viewer" });
    got = await svc.boardPicker(max);
    expect(got.spaces.find(s => s.id === design.id).group).toEqual({ id: product.id, name: "Product" });
  });
  test("agreement: every listed Space accepts a board, every open-but-unlisted one refuses", async () => {
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: { type: "user", id: "google:max" }, role: "annotator" });
    await r.setScopedGrant({ scope: { type: "group", id: product.id }, subject: { type: "user", id: "google:max" }, role: "editor" });
    const listed = new Set((await svc.boardPicker(max)).spaces.map(s => s.id));
    for (const s of [design, secret, platform, loose]) {
      const ok = (await code(svc.createBoard(max, { space: s.id }))) === null;
      expect([s.name, ok]).toEqual([s.name, listed.has(s.id)]);
    }
  });
  test("guests get no picker; the admin's list leaves out Spaces they cannot open", async () => {
    expect(await code(svc.boardPicker(kim))).toBe("forbidden");
    await r.createSpace({ tenant: acme.id, name: "Ada private", generalRole: null, owner: "google:ada" });
    const names = (await svc.boardPicker(root)).spaces.map(s => s.name);
    expect(names).not.toContain("Ada private");      // admin board content is off: a Space they do not open is not named
    expect(names).toContain("Platform");
    expect(names).toContain("Secret roadmap");       // they own it
  });
  test("bounded: more than the candidate page sets `more`, and the work is capped", async () => {
    for (let i = 0; i < 120; i++) await r.createSpace({ tenant: acme.id, name: `S${i}`, generalRole: "viewer" });
    let reads = 0;
    const counting = { ...ten, effective: (...a) => { reads++; return ten.effective(...a); } };
    const s2 = spaceService({ registry: r, tenancy: counting });
    const got = await s2.boardPicker(max);
    expect(got.more).toBe(true);
    expect(reads).toBeLessThanOrEqual(1 + 40 + 20);
  });
});

describe("POST /spaces and the New space pickers", () => {
  test("any Unit member makes a Space at the root; defaults to viewer general access; the creator owns it", async () => {
    const s = await svc.createSpace(max, { name: " Q4 Planning " });
    expect(s).toMatchObject({ name: "Q4 Planning", personal: false, general: "viewer", group: null });
    expect(await r.scopedGrants({ type: "space", id: s.id })).toEqual([{ subject: { type: "user", id: "google:max" }, role: "owner" }]);
    expect((await svc.createSpace(max, { name: "Hidden", general: null })).general).toBe(null);
    expect((await svc.createSpace(max, { name: "E", general: "editor" })).general).toBe("editor");
  });
  test("in a Group: needs Group editor; a plain member, a viewer, a hidden or unknown Group are one refusal", async () => {
    const globex = await r.createTenant({ domain: "globex.com" });
    const foreign = await r.createGroup({ tenant: globex.id, name: "G" });
    for (const group of [product.id, "g-nope00000000", foreign.id]) expect(await code(svc.createSpace(max, { name: "x", group }))).toBe("forbidden");
    await r.setScopedGrant({ scope: { type: "group", id: product.id }, subject: { type: "user", id: "google:max" }, role: "viewer" });
    expect(await code(svc.createSpace(max, { name: "x", group: product.id }))).toBe("forbidden");
    await r.setScopedGrant({ scope: { type: "group", id: product.id }, subject: { type: "user", id: "google:max" }, role: "editor" });
    expect(await svc.createSpace(max, { name: "In group", group: product.id })).toMatchObject({ group: { id: product.id, name: "Product" } });
    expect((await r.spacesIn(product.id)).spaces.map(s => s.name)).toContain("In group");
  });
  test("guests never create a Space; the Unit member role decides the root (edit it away and members cannot)", async () => {
    expect(await code(svc.createSpace(kim, { name: "x" }))).toBe("forbidden");
    await r.updateRole(acme.id, "member", { permissions: [] });
    expect(await code(svc.createSpace(max, { name: "x" }))).toBe("forbidden");
    expect((await svc.createSpace(root, { name: "admins still can" })).name).toBe("admins still can");
  });
  test("validation", async () => {
    for (const o of [{ name: "" }, { name: "   " }, { name: 5 }, { name: "x".repeat(201) }, { name: "ok", general: "owner" }, { name: "ok", general: "god" }, { name: "ok", group: "a b" }])
      expect(await code(svc.createSpace(max, o))).toBe("bad-request");
  });
  test("the pickers: root for members; only Groups the person can open and create in", async () => {
    expect(await svc.spacePicker(max)).toEqual({ root: true, groups: [], more: false });
    await r.setScopedGrant({ scope: { type: "group", id: product.id }, subject: { type: "user", id: "google:max" }, role: "viewer" });
    expect((await svc.spacePicker(max)).groups).toEqual([]);                      // viewer: can open, cannot create
    await r.setScopedGrant({ scope: { type: "group", id: product.id }, subject: { type: "user", id: "google:max" }, role: "editor" });
    expect((await svc.spacePicker(max)).groups).toEqual([{ id: product.id, name: "Product" }]);
    expect(await code(svc.spacePicker(kim))).toBe("forbidden");
    await r.updateRole(acme.id, "member", { permissions: [] });
    expect((await svc.spacePicker(ada)).root).toBe(false);
  });
});

describe("pages: Space and Group answer the same for hidden, unknown and other-Unit ids", () => {
  test("a Space page: boards, can.*, the Group only when open", async () => {
    const b1 = await r.createBoard({ tenant: acme.id, title: "Roadmap", space: design.id });
    await r.createBoard({ tenant: acme.id, title: "Alpha", space: design.id });
    const p = await svc.spacePage(ada, design.id);
    expect(p.space).toEqual({ id: design.id, name: "Design", personal: false, general: "viewer", group: { id: product.id, name: "Product" } });
    expect(p.can).toEqual({ createBoard: true, rename: true, general: true });
    expect(p.boards.map(c => c.title)).toEqual(["Alpha", "Roadmap"]);
    expect(p.boards.every(c => c.can.rename)).toBe(true);
    expect(p.more).toBe(false);
    const v = await svc.spacePage(max, design.id);                    // Design has general viewer; Product has none: max opens Design but not Product
    expect(v.space.group).toBe(null);
    expect(v.can).toEqual({ createBoard: false, rename: false, general: false });
    expect(v.boards.find(c => c.id === b1.id).can).toEqual({ rename: false, move: false });
  });
  test("byte-identical refusal for hidden, unknown, other-Unit and guest requests", async () => {
    const globex = await r.createTenant({ domain: "globex.com" });
    const foreign = await r.createSpace({ tenant: globex.id, name: "Theirs", generalRole: "viewer" });
    await r.createBoard({ tenant: acme.id, title: "Hidden board", space: secret.id });
    // a direct grant on ONE board inside the private Space does not make the Space page open
    const inside = await r.createBoard({ tenant: acme.id, title: "Shared one", space: secret.id });
    await r.setGrant(inside.id, "google:max", "viewer");
    const errs = [];
    for (const [who, id] of [[max, secret.id], [max, "s-nope00000000"], [max, foreign.id], [kim, design.id], [kim, secret.id], [max, "!!"]])
      errs.push(await svc.spacePage(who, id).then(() => "OPEN", e => `${e.code}:${e.message}`));
    expect(new Set(errs)).toEqual(new Set(["not-found:not found"]));
    // another person's personal space is hidden the same way
    await svc.createBoard(ada, {});
    const adas = (await svc.boardPicker(ada)).spaces[0].id;
    expect(await code(svc.spacePage(max, adas))).toBe("not-found");
    expect((await svc.spacePage(ada, adas)).space).toMatchObject({ personal: true, general: null });
    expect((await svc.spacePage(ada, adas)).can).toMatchObject({ rename: false, general: false });   // a personal space keeps its name and privacy
  });
  test("a Group page lists its Spaces; someone who opens one Space but not the Group gets not-found; the Group name never leaks", async () => {
    const g = await svc.groupPage(ada, product.id);
    expect(g.group).toEqual({ id: product.id, name: "Product", general: null });
    expect(g.spaces.map(s => s.name)).toEqual(["Design"]);
    expect(g.can).toEqual({ createSpace: true, rename: true, general: true });
    expect(g.next).toBe(null);
    expect(await code(svc.groupPage(max, product.id))).toBe("not-found");          // max opens Design (general viewer) but not Product
    expect((await svc.spacePage(max, design.id)).space.name).toBe("Design");
    expect(await code(svc.groupPage(max, "g-nope00000000"))).toBe("not-found");
    expect(await code(svc.groupPage(kim, product.id))).toBe("not-found");
    expect(await code(svc.groupPage(ada, product.id, "bad cursor!"))).toBe("bad-request");
  });
  test("a Group page is bounded: pages of 100 by id with a cursor", async () => {
    for (let i = 0; i < 104; i++) await r.createSpace({ tenant: acme.id, name: `X${String(i).padStart(3, "0")}`, group: product.id });
    const a = await svc.groupPage(ada, product.id);
    expect(a.spaces.length).toBe(100);
    expect(a.next).not.toBe(null);
    const b = await svc.groupPage(ada, product.id, a.next);
    expect(b.spaces.length).toBe(5);
    expect(b.next).toBe(null);
  });
});

describe("rename and general access", () => {
  test("Space and Group rename need members.manage; viewers, editors, hidden and unknown are one refusal", async () => {
    expect((await svc.update(ada, "space", design.id, { name: " Design 2 " })).name).toBe("Design 2");
    expect((await svc.update(ada, "group", product.id, { name: "Product 2" }))).toMatchObject({ name: "Product 2" });
    await r.setScopedGrant({ scope: { type: "space", id: design.id }, subject: { type: "user", id: "google:max" }, role: "editor" });
    for (const [who, type, id] of [[max, "space", design.id], [max, "space", secret.id], [max, "space", "s-nope00000000"], [kim, "space", design.id], [max, "group", product.id], [max, "group", "g-nope"]])
      expect(await code(svc.update(who, type, id, { name: "x" }))).toBe("forbidden");
    expect((await r.space(design.id)).name).toBe("Design 2");
    expect((await svc.update(root, "space", secret.id, { name: "Admin may" })).name).toBe("Admin may");   // admin: members.manage
  });
  test("a personal space cannot be renamed or opened up; validation; at least one field", async () => {
    await svc.createBoard(max, {});
    const mine = (await svc.boardPicker(max)).spaces[0];
    for (const who of [max, root]) {                       // the owner and a Unit admin get the ordinary 403: nothing says which Space is personal
      expect(await code(svc.update(who, "space", mine.id, { name: "x" }))).toBe("forbidden");
      expect(await code(svc.update(who, "space", mine.id, { general: "viewer" }))).toBe("forbidden");
    }
    expect(await code(svc.update(max, "space", "s-nope00000000", { name: "x" }))).toBe("forbidden");
    expect((await r.space(mine.id)).generalRole).toBe(null);
    for (const patch of [{}, { name: "" }, { name: 3 }, { general: "owner" }, { general: "x" }])
      expect(await code(svc.update(ada, "space", design.id, patch))).toBe("bad-request");
  });
  test("a general-access change announces every board it reaches; a rename announces nothing", async () => {
    const mk = (space, n) => Promise.all(Array.from({ length: n }, () => r.createBoard({ tenant: acme.id, space })));
    const inDesign = await mk(design.id, 3), elsewhere = await mk(platform.id, 2);
    await svc.update(ada, "space", design.id, { name: "Renamed" });
    expect(announced).toEqual([]);
    expect((await svc.update(ada, "space", design.id, { general: null })).general).toBe(null);
    await svc.settled();
    expect(announced.sort()).toEqual(inDesign.map(b => b.id).sort());
    announced.length = 0;
    expect((await r.space(design.id)).generalRole).toBe(null);
    await svc.update(ada, "group", product.id, { general: "viewer" });                          // a Group reaches its Spaces' boards
    await svc.settled();
    expect(announced.sort()).toEqual(inDesign.map(b => b.id).sort());
    expect(elsewhere.length).toBe(2);
    expect(await ten.role(max, inDesign[0].id)).toBe("viewer");                                 // and the new access is what the resolver answers
  });
  test("the announcement fan-out is bounded and a failing publish never fails the change", async () => {
    for (let i = 0; i < 8; i++) await r.createBoard({ tenant: acme.id, space: design.id });
    const warns = [];
    const flaky = spaceService({ registry: r, tenancy: ten, announce: () => { throw new Error("bus down"); }, log: { warn: (m) => warns.push(m) } });
    expect((await flaky.update(ada, "space", design.id, { general: "commenter" })).general).toBe("commenter");
    await flaky.settled();
    expect(warns.length).toBe(8);
    let pages = 0;
    const paging = { ...r, boardsIn: async (...a) => { pages++; const p = await r.boardsIn(...a); return { ids: p.ids, next: "b-more0000000000x" }; } };
    const s3 = spaceService({ registry: paging, tenancy: ten, announce: () => {}, log: { warn: (m) => warns.push(m) } });
    await s3.update(ada, "space", design.id, { general: "viewer" });
    await s3.settled();
    expect(pages).toBe(ANNOUNCE.pages);
    expect(warns.at(-1)).toMatch(/bound/);
  });
  test("board rename: board.edit or members.manage; viewers, strangers and unknown boards are one refusal; nothing announced", async () => {
    const b = await r.createBoard({ tenant: acme.id, title: "old", space: design.id });
    expect((await svc.renameBoard(ada, b.id, "  New  ")).title).toBe("New");               // Space owner
    await r.setGrant(b.id, "google:max", "editor");
    expect((await svc.renameBoard(max, b.id, "By editor")).title).toBe("By editor");
    expect((await svc.renameBoard(max, b.id, "")).title).toBe("");
    await r.setGrant(b.id, "google:max", "annotator");
    for (const [who, id] of [[max, b.id], [kim, b.id], [max, "b-nope000000000000"], [max, "x y"]]) expect(await code(svc.renameBoard(who, id, "no"))).toBe("forbidden");
    expect(await code(svc.renameBoard(ada, b.id, "x".repeat(201)))).toBe("bad-request");
    expect(announced).toEqual([]);
    expect((await r.board(b.id)).title).toBe("");
  });
});

describe("uniform work and no-name answers (PROTOCOL.md § Spaces and Groups)", () => {
  // Wrap the Registry so every call is counted by method; a refusal must do the same Registry work whatever the id was.
  // ONE call log is shared by `run`, which resets it: callers must run cases one after another, never under Promise.all.
  const counted = (wrap = x => x) => {
    const calls = [];
    const reg = new Proxy(r, { get: (t, k) => (typeof t[k] === "function" ? (...a) => { calls.push(String(k)); return t[k](...a); } : t[k]) });
    const s = spaceService({ registry: reg, tenancy: wrap(makeTenancy({ registry: reg })), announce: () => {} });
    return { s, run: async f => { calls.length = 0; await f(s).catch(() => {}); return [...calls].sort().join(","); } };
  };
  test("harness self-check: the counter tells a non-uniform service from a uniform one", async () => {
    // A tenancy that answers an unknown id without reading anything (the early-return bug): its cost must differ from a real id's.
    const early = ten => ({ ...ten, effective: (who, scope, o) => (scope.id === "s-nope00000000" ? Promise.resolve({ ladder: null, permissions: new Set(), sources: [], until: null }) : ten.effective(who, scope, o)) });
    const bug = counted(early), good = counted();
    const cost = async (h, id) => h.run(s => s.update(max, "space", id, { name: "x" }));
    expect(await cost(good, secret.id)).toBe(await cost(good, "s-nope00000000"));
    expect(await cost(bug, secret.id)).not.toBe(await cost(bug, "s-nope00000000"));
  });
  test("DW-3: hidden, unknown, other-Unit and malformed ids cost the same Registry calls, for every route", async () => {
    const globex = await r.createTenant({ domain: "globex.com" });
    const foreign = await r.createSpace({ tenant: globex.id, name: "Theirs" }), foreignGroup = await r.createGroup({ tenant: globex.id, name: "TheirG", generalRole: "viewer" });
    const hiddenGroup = await r.createGroup({ tenant: acme.id, name: "Hidden group", generalRole: null, owner: "google:ada" });
    const { run } = counted();
    const spaceIds = [secret.id, "s-nope00000000", foreign.id];
    const groupIds = [hiddenGroup.id, "g-nope00000000", foreignGroup.id];
    const cases = {
      "GET space": (id) => s => s.spacePage(max, id),
      "PATCH space": (id) => s => s.update(max, "space", id, { name: "x" }),
      "POST board": (id) => s => s.createBoard(max, { space: id }),
    };
    for (const [name, mk] of Object.entries(cases)) {
      const costs = new Set();
      for (const id of spaceIds) costs.add(await run(mk(id)));       // serial: one shared call log
      expect([name, costs.size]).toEqual([name, 1]);
    }
    const gcases = { "GET group": id => s => s.groupPage(max, id), "PATCH group": id => s => s.update(max, "group", id, { name: "x" }), "POST space in group": id => s => s.createSpace(max, { name: "n", group: id }) };
    for (const [name, mk] of Object.entries(gcases)) {
      const costs = new Set();
      for (const id of groupIds) costs.add(await run(mk(id)));       // serial: one shared call log
      expect([name, costs.size]).toEqual([name, 1]);
    }
    const bcosts = new Set();
    for (const id of [(await r.createBoard({ tenant: acme.id, space: secret.id })).id, "b-nope000000000000", (await r.createBoard({ tenant: globex.id, space: foreign.id })).id])
      bcosts.add(await run(s => s.renameBoard(max, id, "x")));
    expect(bcosts.size).toBe(1);
  });
  test("DW-4: a manager who cannot open a Space learns no stored name from PATCH, only what they sent", async () => {
    const priv = await r.createSpace({ tenant: acme.id, name: "Ada private", generalRole: null, owner: "google:ada" });
    const renamed = await svc.update(root, "space", priv.id, { name: "Fresh" });
    expect(renamed).toEqual({ id: priv.id, name: "Fresh" });
    const out = await svc.update(root, "space", priv.id, { general: null });
    expect(out).toEqual({ id: priv.id, general: null });
    expect(JSON.stringify(out)).not.toContain("Fresh");
    const hg = await r.createGroup({ tenant: acme.id, name: "Closed G", generalRole: null, owner: "google:ada" });
    expect(await svc.update(root, "group", hg.id, { general: "viewer" })).toEqual({ id: hg.id, general: "viewer" });
  });
  test("DW-5: a Unit admin cannot create a board in another member's personal space, with the ordinary refusal", async () => {
    const mine = await svc.createBoard(max, {});
    expect(await code(svc.createBoard(root, { space: mine.space }))).toBe("forbidden");
    expect(await r.boardsIn({ type: "space", id: mine.space })).toEqual({ ids: [mine.id], next: null });
    expect((await svc.createBoard(max, { space: mine.space })).space).toBe(mine.space);       // its owner still can
  });
});

describe("announcements: coalesced per scope, capped overall, the final state always announced", () => {
  const mkBoards = n => Promise.all(Array.from({ length: n }, () => r.createBoard({ tenant: acme.id, space: design.id })));
  const counting = (extra = {}) => {
    let pagers = 0, published = 0;
    const reg = new Proxy(r, { get: (t, k) => (k === "boardsIn" ? (...a) => { pagers++; return t.boardsIn(...a); } : t[k]) });
    const s = spaceService({ registry: reg, tenancy: makeTenancy({ registry: reg }), announce: () => { published++; }, ...extra });
    return { s, stats: () => ({ pagers, published }) };
  };
  test("a burst of 200 PATCHes on one Space runs at most 2 pagers, and the last pass starts after the last write", async () => {
    await mkBoards(20);
    const { s, stats } = counting();
    const roles = ["viewer", "commenter", "annotator", "editor"];
    await Promise.all(Array.from({ length: 200 }, (_, i) => s.update(ada, "space", design.id, { general: roles[i % 4] })));
    await s.settled();
    expect(stats().pagers).toBeLessThanOrEqual(2);
    expect(stats().published).toBeLessThanOrEqual(40);
    expect(stats().published).toBeGreaterThanOrEqual(20);
  });
  test("a change during a running pass gets one more pass after it (and not before the write)", async () => {
    await mkBoards(3);
    let gate, seen = [];
    const hold = new Promise(res => { gate = res; });
    let first = true;
    const reg = new Proxy(r, { get: (t, k) => (k === "boardsIn" ? async (...a) => { const p = await t.boardsIn(...a); seen.push((await t.space(design.id)).generalRole); if (first) { first = false; await hold; } return p; } : t[k]) });
    const s = spaceService({ registry: reg, tenancy: makeTenancy({ registry: reg }), announce: () => {} });
    await s.update(ada, "space", design.id, { general: "commenter" });
    await new Promise(res => setTimeout(res, 5));
    await s.update(ada, "space", design.id, { general: "editor" });            // arrives while pass 1 is held
    gate();
    await s.settled();
    expect(seen.length).toBe(2);
    expect(seen.at(-1)).toBe("editor");                                          // pass 2 ran after the last write
  });
  // A Registry whose boardsIn waits on a gate per scope, so a test decides when each pass ends.
  const gated = () => {
    const live = new Set(), starts = [], gates = new Map(); let maxLive = 0;
    const reg = new Proxy(r, { get: (t, k) => (k === "boardsIn" ? async (scope, ...a) => {
      live.add(scope.id); starts.push(scope.id); maxLive = Math.max(maxLive, live.size);
      if (gates.has(scope.id)) await gates.get(scope.id);
      live.delete(scope.id); return t.boardsIn(scope, ...a);
    } : t[k]) });
    const hold = id => { let open; gates.set(id, new Promise(res => { open = res; })); return open; };
    return { reg, live, starts, hold, maxLive: () => maxLive };
  };
  const newSpaces = (n, tenant = acme.id, owner = "google:ada") => Promise.all(Array.from({ length: n }, (_, i) => r.createSpace({ tenant, name: "Q" + i, generalRole: "viewer", owner })));
  const tick = () => new Promise(res => setTimeout(res, 5));

  test("scopes over the cap wait in a queue and run as slots free; none is dropped, and the cap holds", async () => {
    const g = gated(), sp = await newSpaces(ANNOUNCE.perTenant + 6);
    const opens = sp.map(x => g.hold(x.id));
    const s = spaceService({ registry: g.reg, tenancy: makeTenancy({ registry: g.reg }), announce: () => {} });
    await Promise.all(sp.map(x => s.update(ada, "space", x.id, { general: "editor" })));          // an upgrade: not a revocation
    await tick();
    expect(g.live.size).toBe(ANNOUNCE.perTenant);                                                  // one Unit may run perTenant at once
    opens.slice(0, 2).forEach(f => f()); await tick();
    expect(g.live.size).toBe(ANNOUNCE.perTenant);                                                  // freed slots were refilled from the queue
    opens.forEach(f => f()); await s.settled();
    expect(new Set(g.starts)).toEqual(new Set(sp.map(x => x.id)));                                 // every scope was announced
    expect(g.maxLive()).toBeLessThanOrEqual(ANNOUNCE.perTenant);
  });
  test("tenant fairness: one Unit's burst does not delay another Unit's announce beyond a slot", async () => {
    const g = gated(), globex = await r.createTenant({ domain: "globex.com", admins: ["google:gadmin"] });
    const a = await newSpaces(20), b = await r.createSpace({ tenant: globex.id, name: "B", generalRole: "viewer", owner: "google:gita" });
    const opens = a.map(x => g.hold(x.id));
    const s = spaceService({ registry: g.reg, tenancy: makeTenancy({ registry: g.reg }), announce: () => {} });
    await Promise.all(a.map(x => s.update(ada, "space", x.id, { general: "editor" })));
    await s.update(ident("gita", "globex.com"), "space", b.id, { general: "editor" });
    await tick();
    expect(g.starts).toContain(b.id);                                                              // B started while A's burst still waits
    expect(g.starts.filter(id => id !== b.id).length).toBe(ANNOUNCE.perTenant);
    opens.forEach(f => f()); await s.settled();
  });
  test("a revocation under a full cap is announced at once, ahead of the queue", async () => {
    const g = gated(), sp = await newSpaces(ANNOUNCE.perTenant + 3), target = sp.at(-1);
    const opens = sp.slice(0, -1).map(x => g.hold(x.id));
    const s = spaceService({ registry: g.reg, tenancy: makeTenancy({ registry: g.reg }), announce: () => {} });
    for (const x of sp.slice(0, -1)) await s.update(ada, "space", x.id, { general: "editor" });
    await tick();
    expect(g.live.size).toBe(ANNOUNCE.perTenant);                                                  // full for this Unit
    await s.update(ada, "space", target.id, { general: null });                                    // viewer -> only people added: a revocation
    await tick();
    expect(g.starts).toContain(target.id);                                                         // started although the Unit's slots are full
    opens.forEach(f => f()); await s.settled();
    expect(new Set(g.starts)).toEqual(new Set(sp.map(x => x.id)));
  });
  test("revocations have a per-Unit budget: Unit A's flood of revocations does not delay Unit B's revocation", async () => {
    const g = gated(), globex = await r.createTenant({ domain: "globex.com" });
    const a = await newSpaces(ANNOUNCE.perTenant * 2 + 4), b = await r.createSpace({ tenant: globex.id, name: "B", generalRole: "viewer", owner: "google:gita" });
    const opens = a.map(x => g.hold(x.id));
    const s = spaceService({ registry: g.reg, tenancy: makeTenancy({ registry: g.reg }), announce: () => {} });
    for (const x of a) await s.update(ada, "space", x.id, { general: null });                      // viewer -> only people added: revocations
    await tick();
    expect(g.live.size).toBe(ANNOUNCE.perTenant * 2);                                              // A is held to its revocation budget
    await s.update(ident("gita", "globex.com"), "space", b.id, { general: null });
    await tick();
    expect(g.starts).toContain(b.id);                                                              // B's revocation started at once
    opens.forEach(f => f()); await s.settled();
    expect(new Set(g.starts)).toEqual(new Set([...a.map(x => x.id), b.id]));                       // and none of A's was dropped
  });
  test("revocations are FIFO among themselves: an old one starts at the first free slot while newer ones keep arriving", async () => {
    const g = gated(), n = ANNOUNCE.perTenant * 2, sp = await newSpaces(n + 1 + 10);
    const full = sp.slice(0, n), [old, ...newer] = sp.slice(n);
    const opens = full.map(x => g.hold(x.id));
    const s = spaceService({ registry: g.reg, tenancy: makeTenancy({ registry: g.reg }), announce: () => {} });
    const revoke = x => s.update(ada, "space", x.id, { general: null });
    for (const x of full) await revoke(x);
    await tick();
    expect(g.live.size).toBe(n);                                                                     // the Unit's revocation budget is full
    await revoke(old);
    for (const x of newer) await revoke(x);                                                          // newer revocations stream in behind it
    opens[0](); await tick();                                                                        // ONE slot frees
    const next = g.starts.slice(n);
    expect(next[0]).toBe(old.id);                                                                    // the oldest waiting revocation takes it, not the newest
    opens.forEach(f => f()); await s.settled();
    expect(g.starts.slice(n)).toEqual([old, ...newer].map(x => x.id));                               // and the rest follow in arrival order
  });
  test("close(): the queue is forgotten, nothing starts afterwards, and later changes are no-ops", async () => {
    const g = gated(), sp = await newSpaces(ANNOUNCE.perTenant + 5);
    let published = 0;
    await Promise.all(sp.map(x => r.createBoard({ tenant: acme.id, space: x.id })));
    const opens = sp.map(x => g.hold(x.id));
    const s = spaceService({ registry: g.reg, tenancy: makeTenancy({ registry: g.reg }), announce: () => { published++; } });
    for (const x of sp) await s.update(ada, "space", x.id, { general: "editor" });
    await tick();
    expect(g.starts.length).toBe(ANNOUNCE.perTenant);                                                // the rest wait in the queue
    s.close();
    opens.forEach(f => f()); await s.settled(); await tick();
    expect(g.starts.length).toBe(ANNOUNCE.perTenant);                                                // none of the queued scopes ever started
    expect(published).toBe(0);                                                                       // and the running passes stop before publishing on a closed bus
    s.announceChange({ id: acme.id }, { type: "space", id: sp[0].id }, { revoke: true }); await s.settled();
    expect(g.starts.length).toBe(ANNOUNCE.perTenant);
  });
  test("revocation priority does not carry over to an ordinary re-pass", async () => {
    const g = gated(), sp = await newSpaces(ANNOUNCE.perTenant + 2), [x, ...rest] = sp, normal = rest.slice(0, ANNOUNCE.perTenant), y = rest.at(-1);
    const un = { id: acme.id };
    let passes = 0;
    const reg = new Proxy(g.reg, { get: (t, k) => (k === "boardsIn" ? async (scope, ...a2) => { const out = await t.boardsIn(scope, ...a2); if (scope.id === x.id && ++passes <= ANNOUNCE.repasses) s.announceChange(un, { type: "space", id: x.id }); return out; } : t[k]) });
    const s = spaceService({ registry: reg, tenancy: makeTenancy({ registry: reg }), announce: () => {} });
    const opens = normal.map(n => g.hold(n.id));
    for (const n of normal) s.announceChange(un, { type: "space", id: n.id });                     // the Unit's ordinary slots are now full
    await tick();
    s.announceChange(un, { type: "space", id: y.id });                                             // waits behind them
    s.announceChange(un, { type: "space", id: x.id }, { revoke: true });                           // a revocation: runs in the revocation budget
    await tick();
    expect(g.starts.filter(id => id === x.id).length).toBe(ANNOUNCE.repasses);                     // x used its passes, each re-pass an ordinary change
    await tick();
    expect(g.starts.filter(id => id === x.id).length).toBe(ANNOUNCE.repasses);                     // and did NOT restart ahead of the full ordinary slots
    opens[0](); await tick();
    expect(g.starts.indexOf(y.id)).toBeGreaterThan(-1);
    expect(g.starts.indexOf(y.id)).toBeLessThan(g.starts.lastIndexOf(x.id));                       // y (queued first) runs before x's next pass
    opens.forEach(f => f()); await s.settled();
  });
  test("a revocation that arrives during a pass keeps its priority for the next one", async () => {
    const g = gated(), sp = await newSpaces(ANNOUNCE.perTenant + 1), [x, ...rest] = sp, waiting = rest.at(-1), busy = rest.slice(0, -1);
    const un = { id: acme.id };
    let passes = 0;
    const reg = new Proxy(g.reg, { get: (t, k) => (k === "boardsIn" ? async (scope, ...a2) => { const out = await t.boardsIn(scope, ...a2); if (scope.id === x.id && ++passes <= ANNOUNCE.repasses) s.announceChange(un, { type: "space", id: x.id }, { revoke: true }); return out; } : t[k]) });
    const s = spaceService({ registry: reg, tenancy: makeTenancy({ registry: reg }), announce: () => {} });
    const openX = g.hold(x.id), opens = busy.map(n => g.hold(n.id));
    s.announceChange(un, { type: "space", id: x.id });                                              // x runs as an ordinary scope (held)
    for (const n of busy) s.announceChange(un, { type: "space", id: n.id });
    s.announceChange(un, { type: "space", id: waiting.id });                                        // the Unit's ordinary slots are full; this one waits
    await tick();
    expect(g.starts.includes(waiting.id)).toBe(false);
    openX(); await tick();                                                                          // x finishes 3 passes, each followed by a revocation, then yields
    const xs = g.starts.map((id, i) => [id, i]).filter(([id]) => id === x.id);
    expect(xs.length).toBe(ANNOUNCE.repasses + 1);                                                  // it came back at once for a 4th pass: the revocation kept its priority
    expect(xs.at(-1)[1]).toBeLessThan(g.starts.indexOf(waiting.id));                                // ahead of the scope that had been waiting
    opens.forEach(f => f()); await s.settled();
  });
  test("a scope that keeps changing yields its slot after ANNOUNCE.repasses passes, to the back of the queue", async () => {
    const g = gated(), [x, y] = await newSpaces(2);
    let n = 0;
    const reg = new Proxy(g.reg, { get: (t, k) => (k === "boardsIn" ? async (scope, ...a) => { const out = await t.boardsIn(scope, ...a); if (scope.id === x.id && ++n < 6) s.announceChange(acmeUnit, { type: "space", id: x.id }); return out; } : t[k]) });
    const acmeUnit = { id: acme.id };
    const s = spaceService({ registry: reg, tenancy: makeTenancy({ registry: reg }), announce: () => {} });
    s.announceChange(acmeUnit, { type: "space", id: x.id });
    s.announceChange(acmeUnit, { type: "space", id: y.id });
    await s.settled();
    expect(n).toBe(6);                                                                              // x kept getting new work and still finished all of it
    expect(g.starts.filter(id => id === x.id).length).toBe(6);
    expect(g.starts.includes(y.id)).toBe(true);
  });
  test("no lost re-pass: a change landing at any microtask after the last publish still gets its pass", async () => {
    const acmeUnit = { id: acme.id };
    await r.createBoard({ tenant: acme.id, space: design.id });
    for (let depth = 0; depth <= 14; depth++) {
      let pagers = 0, first = true, svc2;
      const reg = new Proxy(r, { get: (t, k) => (k === "boardsIn" ? (...a) => { pagers++; return t.boardsIn(...a); } : t[k]) });
      const hop = n => (n <= 0 ? svc2.announceChange(acmeUnit, { type: "space", id: design.id }) : queueMicrotask(() => hop(n - 1)));
      svc2 = spaceService({ registry: reg, tenancy: makeTenancy({ registry: reg }), announce: () => { if (first) { first = false; hop(depth); } } });
      svc2.announceChange(acmeUnit, { type: "space", id: design.id });
      await svc2.settled();
      await tick();
      expect([depth, pagers]).toEqual([depth, 2]);
    }
  });
  test("a log.warn that throws inside the announcement is not an unhandled rejection", async () => {
    await mkBoards(2);
    const bad = new Proxy(r, { get: (t, k) => (k === "boardsIn" ? async () => { throw new Error("db down"); } : t[k]) });
    const s = spaceService({ registry: bad, tenancy: makeTenancy({ registry: bad }), announce: () => {}, log: { warn: () => { throw new Error("log down"); } } });
    let unhandled = 0; const on = () => { unhandled++; }; process.on("unhandledRejection", on);
    await s.update(ada, "space", design.id, { general: "editor" });
    await s.settled(); await new Promise(res => setTimeout(res, 10));
    process.off("unhandledRejection", on);
    expect(unhandled).toBe(0);
  });
});

describe("POST /groups: group.create at the Unit root", () => {
  test("a Unit admin creates a Group and owns it; a member, a guest and a name-less call do not", async () => {
    const g = await svc.createGroup(root, { name: "  Platform org " });
    expect(g).toEqual({ id: expect.any(String), name: "Platform org", general: null });
    expect(await r.scopedGrants({ type: "group", id: g.id })).toEqual([expect.objectContaining({ role: "owner", subject: { type: "user", id: "google:root" } })]);   // the creator owns it
    expect(await code(svc.createGroup(max, { name: "x" }))).toBe("forbidden");
    expect(await code(svc.createGroup(kim, { name: "x" }))).toBe("forbidden");
    expect(await code(svc.createGroup(root, { name: "" }))).toBe("bad-request");
    expect(await code(svc.createGroup(root, { name: "x", general: "owner" }))).toBe("bad-request");
    expect((await svc.createGroup(root, { name: "Open", general: "viewer" })).general).toBe("viewer");
  });
  test("a custom Unit role with group.create lets its holder create a Group: checked by permission, not role name", async () => {
    expect(await code(svc.createGroup(max, { name: "x" }))).toBe("forbidden");
    const role = await r.createRole({ tenant: acme.id, name: "Org builder", base: "viewer", boardRole: "viewer", permissions: ["group.create"] });
    await r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: { type: "user", id: "google:max" }, role: role.id });
    expect((await svc.createGroup(max, { name: "Mine" })).name).toBe("Mine");
    expect((await ten.effective(max, { type: "group", id: product.id })).permissions.has("group.create")).toBe(false);   // clipped: Unit only
  });
});

describe("over HTTP: statuses, bodies, and the leak answers byte for byte", () => {
  let routes;
  const ORIGIN = "https://plenary.test";
  const config = { cookieKey: "k".repeat(32), postLoginUrl: ORIGIN + "/", boardUrl: ORIGIN + "/b/{board}", publicUrl: ORIGIN };
  const api = async (tok, path, method = "GET", body) => {
    const res = await routes(new Request(ORIGIN + path, { method, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
    return { status: res.status, text: await res.text() };
  };
  beforeEach(async () => {
    const dev = devAuth({ enabled: true, tokens: { ada: { name: "ada", domain: "acme.com", email: "ada@acme.com" }, max: { name: "max", domain: "acme.com", email: "max@acme.com" }, kim: { name: "kim", email: "kim@partner.io" } } });
    await r.setScopedGrant({ scope: { type: "group", id: product.id }, subject: { type: "user", id: "dev:ada" }, role: "owner" });
    await r.setScopedGrant({ scope: { type: "space", id: design.id }, subject: { type: "user", id: "dev:ada" }, role: "owner" });
    routes = httpRoutes({ registry: r, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy: ten, config, dev });
  });
  test("401 without a token on every route", async () => {
    for (const [m, p] of [["GET", "/spaces?can=board.create"], ["GET", "/groups?can=space.create"], ["POST", "/spaces"], ["GET", `/spaces/${design.id}`], ["PATCH", `/spaces/${design.id}`], ["GET", `/groups/${product.id}`], ["PATCH", `/groups/${product.id}`], ["PATCH", "/boards/b-x"]])
      expect((await api(null, p, m, m === "GET" ? undefined : {})).status).toBe(401);
  });
  test("create a Space, a board in it, rename both; a non-member sees neither", async () => {
    const s = await api("max", "/spaces", "POST", { name: "Q4 Planning", general: null });
    expect(s.status).toBe(201);
    const space = JSON.parse(s.text).space;
    const b = await api("max", "/boards", "POST", { title: "Offsite", space: space.id });
    expect(b.status).toBe(201);
    const board = JSON.parse(b.text).board;
    expect((await api("max", `/spaces/${space.id}`, "PATCH", { name: "Q4" })).status).toBe(200);
    expect(JSON.parse((await api("max", `/boards/${board.id}`, "PATCH", { title: "Offsite 2" })).text).board.title).toBe("Offsite 2");
    const page = JSON.parse((await api("max", `/spaces/${space.id}`)).text);
    expect([page.space.name, page.boards.map(c => c.title)]).toEqual(["Q4", ["Offsite 2"]]);
    for (const who of ["ada", "kim"]) {
      expect((await api(who, `/spaces/${space.id}`)).status).toBe(404);
      expect((await api(who, `/spaces/${space.id}`, "PATCH", { name: "x" })).status).toBe(403);
      expect((await api(who, `/boards/${board.id}`, "PATCH", { title: "x" })).status).toBe(403);
      expect((await api(who, "/boards", "POST", { space: space.id })).status).toBe(403);
      expect((await api(who, "/spaces?can=board.create")).text).not.toContain("Q4");
    }
  });
  test("POST /groups: 201 for a Unit admin, 403 for a member, 400 for a bad body", async () => {
    expect((await api("max", "/groups", "POST", { name: "x" })).status).toBe(403);
    await r.addTenantAdmin(acme.id, "dev:ada");
    const ok = await api("ada", "/groups", "POST", { name: "Org" });
    expect([ok.status, JSON.parse(ok.text).group.name]).toEqual([201, "Org"]);
    expect((await api("ada", "/groups", "POST", {})).status).toBe(400);
    expect((await api("ada", "/groups", "POST", { name: "x", extra: 1 })).status).toBe(400);
    expect((await api(null, "/groups", "POST", { name: "x" })).status).toBe(401);
  });
  test("hidden, unknown and other-Unit ids: identical status and body, reads and writes", async () => {
    const globex = await r.createTenant({ domain: "globex.com" });
    const foreign = await r.createSpace({ tenant: globex.id, name: "Theirs" }), foreignGroup = await r.createGroup({ tenant: globex.id, name: "TheirG", generalRole: "viewer" });
    const reads = ["max", "kim"].flatMap(w => [secret.id, "s-nope00000000", foreign.id].map(id => api(w, `/spaces/${id}`)));
    const rs = await Promise.all(reads);
    expect(new Set(rs.map(x => x.status + x.text))).toEqual(new Set(['404{"error":"not-found"}']));
    const gs = await Promise.all(["max", "kim"].flatMap(w => [product.id, "g-nope00000000", foreignGroup.id].map(id => api(w, `/groups/${id}`))));
    expect(new Set(gs.map(x => x.status + x.text))).toEqual(new Set(['404{"error":"not-found"}']));
    const ws = await Promise.all([
      ...[secret.id, "s-nope00000000", foreign.id].map(id => api("max", `/spaces/${id}`, "PATCH", { name: "x" })),
      ...[secret.id, "s-nope00000000", foreign.id].map(id => api("max", "/boards", "POST", { space: id })),
      ...[product.id, "g-nope00000000", foreignGroup.id].map(id => api("max", "/spaces", "POST", { name: "x", group: id })),
    ]);
    expect(new Set(ws.map(x => x.status + x.text))).toEqual(new Set(['403{"error":"forbidden"}']));
    for (const t of [...rs, ...gs, ...ws]) expect(t.text).not.toMatch(/Secret|Theirs|TheirG|Product/);
  });
  test("pickers over HTTP: names only what the person may use; ?can= is required and exact", async () => {
    const p = JSON.parse((await api("max", "/spaces?can=board.create")).text);
    expect(p.spaces.map(s => s.name)).toEqual(["max's space", "Everyone edits"]);
    expect(JSON.parse((await api("max", "/groups?can=space.create")).text)).toEqual({ root: true, groups: [], more: false });
    for (const q of ["", "?can=x", "?can=board.create&x=1", "?can=space.create"]) expect((await api("max", "/spaces" + q)).status).toBe(400);
    expect((await api("kim", "/spaces?can=board.create")).status).toBe(403);
    expect((await api("kim", "/groups?can=space.create")).status).toBe(403);
    expect((await api("kim", "/boards", "POST", {})).status).toBe(403);
    expect((await api("kim", "/spaces", "POST", { name: "x" })).status).toBe(403);
  });
  test("bodies: unknown fields and bad JSON are 400; PATCH needs a field; a general change announces", async () => {
    expect((await api("ada", "/spaces", "POST", { name: "x", tenant: "t" })).text).toBe('{"error":"unknown-field","field":"tenant"}');
    expect((await api("ada", `/spaces/${design.id}`, "PATCH", {})).status).toBe(400);
    expect((await api("ada", "/boards/b-x", "PATCH", {})).status).toBe(400);
    expect((await api("ada", "/spaces/x y", "GET")).status).toBe(404);
    const ok = await api("ada", `/groups/${product.id}`, "PATCH", { general: "viewer" });
    expect([ok.status, JSON.parse(ok.text).group.general]).toEqual([200, "viewer"]);
    expect((await api("ada", `/groups/${product.id}?after=a%20b`)).status).toBe(400);
  });
});
