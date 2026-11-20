// Move board with an access diff (server/auth/move.js, PROTOCOL.md § Move board, #53): who may move where (permissions), the diff computed by the enforcing resolver, the no-leak
// rule, the compare-and-set move, idempotency, undo, the announcement, and the HTTP routes.
import { test, expect, beforeEach, describe } from "bun:test";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy as makeTenancy } from "../../server/auth/tenancy.js";
import { spaceService } from "../../server/auth/spaces.js";
import { moveService, givenBy } from "../../server/auth/move.js";
import { mayMove } from "../../server/auth/resolver.js";
import { announcingRegistry } from "../../server/main.js";
import { httpRoutes } from "../../server/auth/http.js";
import { sessions as makeSessions } from "../../server/auth/session.js";
import { devAuth } from "../../server/auth/dev.js";

const ident = (n, domain = "acme.com") => ({ user: `google:${n}`, name: n, email: `${n}@${domain}`, domain });
const ada = ident("ada"), max = ident("max"), kim = ident("kim", "partner.io"), root = ident("root"), zed = ident("zed");
let r, ten, svc, mv, acme, product, design, secret, platform, adasSpace, designers, board;
const code = p => p.then(() => null, e => e.code ?? e.message);
const names = list => list.map(e => `${e.subject.name}:${e.before?.id ?? "-"}>${e.after?.id ?? "-"}`).sort();

beforeEach(async () => {
  r = memoryRegistry();
  ten = makeTenancy({ registry: r });
  svc = spaceService({ registry: r, tenancy: ten });
  mv = moveService({ registry: r, tenancy: ten, spaces: svc });
  acme = await r.createTenant({ domain: "acme.com", admins: ["google:root"] });
  for (const p of [ada, max, zed, root]) await r.touchMember(acme.id, { user: p.user, name: p.name, email: p.email });
  product = await r.createGroup({ tenant: acme.id, name: "Product", generalRole: null, owner: "google:ada" });
  design = await r.createSpace({ tenant: acme.id, name: "Design", group: product.id, generalRole: "viewer", owner: "google:ada" });
  secret = await r.createSpace({ tenant: acme.id, name: "Secret", generalRole: null, owner: "google:root" });
  platform = await r.createSpace({ tenant: acme.id, name: "Platform", generalRole: null, owner: "google:ada" });
  designers = await r.createTeam({ tenant: acme.id, name: "Design team" });
  await r.setTeamMember(designers.id, "google:zed", true);
  await r.setScopedGrant({ scope: { type: "space", id: design.id }, subject: { type: "team", id: designers.id }, role: "editor" });
  adasSpace = await r.ensurePersonalSpace(acme.id, "google:ada");
  board = await r.createBoard({ tenant: acme.id, title: "Roadmap", space: adasSpace.id, owner: "google:ada", memberRole: null });
});

describe("who may move where", () => {
  test("options: only Spaces the mover may put a board in, never the current one, personal first", async () => {
    const o = await mv.options(ada, board.id);
    expect(o.board).toEqual({ id: board.id, title: "Roadmap" });
    expect(o.from).toMatchObject({ id: adasSpace.id, personal: true });
    expect(o.destinations.map(d => d.name)).toEqual(["Design", "Platform"]);   // not Secret (cannot open), not her own space (current)
    const inDesign = await r.createBoard({ tenant: acme.id, title: "D", space: design.id, owner: "google:ada" });
    expect((await mv.options(ada, inDesign.id)).destinations.map(d => d.name)).toEqual(["ada's space", "Platform"]);
  });
  test("a non-mover (editor, stranger, guest, unknown id, other Unit) gets the one forbidden", async () => {
    await r.setGrant(board.id, "google:max", "editor");
    const globex = await r.createTenant({ domain: "globex.com" });
    const alien = await r.createBoard({ tenant: globex.id, space: (await r.createSpace({ tenant: globex.id, name: "G" })).id, title: "x", owner: "google:g" });
    for (const [who, id] of [[max, board.id], [zed, board.id], [kim, board.id], [ada, "b-nope0000000000"], [ada, alien.id], [ada, "a b"]]) {
      expect(await code(mv.options(who, id))).toBe("forbidden");
      expect(await code(mv.preview(who, id, design.id))).toBe("forbidden");
      expect(await code(mv.move(who, id, { from: platform.id, to: design.id }))).toBe("forbidden");
    }
  });
  test("a non-mover costs the board read, the access reads and nothing else (no destination, name or diff reads)", async () => {
    const calls = [];
    const reg = new Proxy(r, { get: (t, k) => (typeof t[k] === "function" ? (...a) => { calls.push(String(k)); return t[k](...a); } : t[k]) });
    const m = moveService({ registry: reg, tenancy: makeTenancy({ registry: reg }), spaces: spaceService({ registry: reg, tenancy: makeTenancy({ registry: reg }) }) });
    await code(m.preview(max, board.id, design.id));
    const cost = [...calls].sort().join();
    for (const banned of ["space", "spaceCandidates", "accessContexts", "membersAmong", "teamsAmong", "invites", "links", "moveBoard", "ensurePersonalSpace"]) expect(calls.includes(banned)).toBe(false);
    calls.length = 0; await code(m.preview(ada, "b-nope0000000000", design.id));
    expect([...calls].sort().join()).toBe(cost.replace(/\bboard\b/, "board"));   // an unknown board does the same reads as a real one a stranger meets
  });
  test("a destination the mover cannot open, cannot create in, another Unit's, unknown, or someone else's personal space is forbidden", async () => {
    const globex = await r.createTenant({ domain: "globex.com" });
    const foreign = await r.createSpace({ tenant: globex.id, name: "F", generalRole: "editor" });
    const maxs = await r.ensurePersonalSpace(acme.id, "google:max");
    for (const to of [secret.id, foreign.id, "s-nope00000000", maxs.id]) expect(await code(mv.move(ada, board.id, { from: adasSpace.id, to }))).toBe("forbidden");
    const viewOnly = await r.createSpace({ tenant: acme.id, name: "ViewOnly", generalRole: "viewer" });         // opens, cannot create
    expect(await code(mv.move(ada, board.id, { from: adasSpace.id, to: viewOnly.id }))).toBe("forbidden");
    expect((await r.board(board.id)).space).toBe(adasSpace.id);
  });
  test("a Unit admin moves any board by the Unit-wide move permission (no board content needed), and is exempt from the ladder rule", async () => {
    const b = await r.createBoard({ tenant: acme.id, title: "Shared one", space: design.id, owner: "google:ada", memberRole: null });   // a personal-space board is the owner's (below)
    expect((await mv.move(root, b.id, { from: design.id, to: platform.id })).moved).toBe(true);
    expect((await r.board(b.id)).space).toBe(platform.id);
  });
  test("a Space owner (move at the Space) moves a board they do not own; a Space editor cannot", async () => {
    const b = await r.createBoard({ tenant: acme.id, title: "Theirs", space: platform.id, owner: "google:max" });
    expect(await code(mv.move(zed, b.id, { from: platform.id, to: design.id }))).toBe("forbidden");
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: { type: "user", id: "google:zed" }, role: "editor" });
    expect(await code(mv.move(zed, b.id, { from: platform.id, to: design.id }))).toBe("forbidden");   // editor has no `move`
    expect((await mv.move(ada, b.id, { from: platform.id, to: design.id })).moved).toBe(true);        // Space owner: `move` at the Space covers its boards
  });
  test("no escalation: a custom role with move and a viewer board step may not move a board into a Space that gives others editor", async () => {
    const role = await r.createRole({ tenant: acme.id, name: "Mover", boardRole: "viewer", permissions: ["move", "board.create"] });
    const b = await r.createBoard({ tenant: acme.id, title: "B", space: platform.id });
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: { type: "user", id: "google:max" }, role: role.id });
    await r.setScopedGrant({ scope: { type: "space", id: design.id }, subject: { type: "user", id: "google:max" }, role: role.id });
    expect(givenBy(await r.accessContext({ type: "space", id: design.id }))).toBe("owner");   // Design's owner (ada) and its Team (editor)
    expect(await code(mv.move(max, b.id, { from: platform.id, to: design.id }))).toBe("forbidden");   // max opens and creates there, but would hand Design's owner and Team more than his viewer step
    expect((await mv.options(max, b.id)).destinations.map(d => d.id)).not.toContain(design.id);
    const quiet = await r.createSpace({ tenant: acme.id, name: "Quiet", generalRole: "viewer" });
    await r.setScopedGrant({ scope: { type: "space", id: quiet.id }, subject: { type: "user", id: "google:max" }, role: role.id });
    expect((await mv.move(max, b.id, { from: platform.id, to: quiet.id })).moved).toBe(true);              // viewer for others: within what max holds
    expect(givenBy(await r.accessContext({ type: "space", id: design.id }))).toBe("owner");   // the mover's own grant counts too (Design's owner is ada herself): no skipping self
    const c = await r.createBoard({ tenant: acme.id, title: "C", space: platform.id });
    expect((await mv.move(root, c.id, { from: platform.id, to: design.id })).moved).toBe(true);              // a Unit admin is exempt
  });
  test("HIGH-1: a mover below owner cannot become owner by moving a board into a Space they own, or into their personal space", async () => {
    const role = await r.createRole({ tenant: acme.id, name: "Mover", boardRole: "viewer", permissions: ["move", "board.create"] });
    const b = await r.createBoard({ tenant: acme.id, title: "Adas", space: platform.id, owner: "google:ada" });
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: { type: "user", id: "google:max" }, role: role.id });
    const mine = await r.createSpace({ tenant: acme.id, name: "Mine", generalRole: null, owner: "google:max" });
    const maxs = await r.ensurePersonalSpace(acme.id, "google:max");
    expect((await ten.effective(max, b.id)).ladder).toBe("viewer");
    for (const to of [mine.id, maxs.id]) expect(await code(mv.move(max, b.id, { from: platform.id, to }))).toBe("forbidden");
    expect((await r.board(b.id)).space).toBe(platform.id);
    expect((await mv.options(max, b.id)).destinations.map(d => d.id)).not.toContain(mine.id);
    expect((await mv.options(max, b.id)).destinations.map(d => d.id)).not.toContain(maxs.id);
    expect((await ten.effective(max, b.id)).ladder).toBe("viewer");            // never raised
  });
  test("HIGH-1: a mover with `move` and no board content at all (a stored role with no board step) cannot go from nothing to owner either", async () => {
    const none = await r.createRole({ tenant: acme.id, name: "MoveOnly", boardRole: null, permissions: ["move", "board.create"] });   // the Registry stores what it is given; roleDef reads no ladder from it
    const b = await r.createBoard({ tenant: acme.id, title: "Adas", space: platform.id, owner: "google:ada" });
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: { type: "user", id: "google:max" }, role: none.id });
    const mine = await r.createSpace({ tenant: acme.id, name: "Mine", generalRole: null, owner: "google:max" });
    const a0 = await ten.effective(max, b.id);
    expect([a0.ladder, a0.permissions.has("move")]).toEqual([null, true]);
    expect(await code(mv.move(max, b.id, { from: platform.id, to: mine.id }))).toBe("forbidden");
    expect(await code(mv.move(max, b.id, { from: platform.id, to: (await r.ensurePersonalSpace(acme.id, "google:max")).id }))).toBe("forbidden");
    expect((await r.board(b.id)).space).toBe(platform.id);
    expect((await ten.effective(max, b.id)).ladder).toBeNull();
  });
  test("HIGH-1: a board owner (and so an owner-step mover) still moves into a Space they own or their personal space", async () => {
    const mine = await r.createSpace({ tenant: acme.id, name: "Mine", generalRole: null, owner: "google:ada" });
    expect((await mv.move(ada, board.id, { from: adasSpace.id, to: mine.id })).moved).toBe(true);
    expect((await mv.move(ada, board.id, { from: mine.id, to: adasSpace.id })).moved).toBe(true);
  });
});

describe("a personal-space board is its owner's (TECH-DEBT 67)", () => {
  const rootSpace = () => r.createSpace({ tenant: acme.id, name: "Root's", generalRole: null, owner: "google:root" });
  test("a manage-only Unit admin (holds `move` everywhere) cannot move a member's personal-space board out: the route refuses, and can.move is false", async () => {
    const dst = await rootSpace();
    expect(await code(mv.move(root, board.id, { from: adasSpace.id, to: dst.id }))).toBe("forbidden");
    expect(await code(mv.options(root, board.id))).toBe("forbidden");
    expect(await code(mv.preview(root, board.id, dst.id))).toBe("forbidden");
    expect((await r.board(board.id)).space).toBe(adasSpace.id);
    const a = await ten.effective(root, board.id);
    expect(a.permissions.has("move")).toBe(true);                     // the raw permission is there ...
    expect(mayMove(a)).toBe(false);                                   // ... the offer is not
    expect((await ten.access(root, board.id)).move).toBe(false);
  });
  test("a content-access admin (board content on) may, like the owner; and a manage-only admin still moves a SHARED-space board", async () => {
    const dst = await rootSpace();
    const ten2 = makeTenancy({ registry: r, adminBoardContent: true });
    const mv2 = moveService({ registry: r, tenancy: ten2, spaces: spaceService({ registry: r, tenancy: ten2 }) });
    expect(mayMove(await ten2.effective(root, board.id))).toBe(true);
    expect((await mv2.move(root, board.id, { from: adasSpace.id, to: dst.id })).moved).toBe(true);
    const shared = await r.createBoard({ tenant: acme.id, title: "S", space: design.id, owner: "google:ada", memberRole: null });
    expect((await mv.move(root, shared.id, { from: design.id, to: dst.id })).moved).toBe(true);
  });
  test("the owner moves their own personal-space board out", async () => {
    expect((await mv.move(ada, board.id, { from: adasSpace.id, to: design.id })).moved).toBe(true);
    expect(mayMove(await ten.effective(ada, board.id))).toBe(true);
  });
});

describe("the access diff", () => {
  test("gains, keeps, loses: personal board into Design", async () => {
    await r.setGrant(board.id, "google:max", "viewer");           // a direct grant travels
    const d = await mv.preview(ada, board.id, design.id);
    expect(d.to).toEqual({ id: design.id, name: "Design", personal: false });
    expect(d.from).toMatchObject({ id: adasSpace.id, personal: true });
    expect(names(d.gains)).toEqual(["Design team:->editor", "Everyone in the organization:->viewer"].sort());
    expect(names(d.keeps)).toEqual(["ada:owner>owner", "max:viewer>viewer"]);   // max's viewer grant travels; Design's viewer for everyone adds nothing to it
    expect(names(d.loses)).toEqual([]);
  });
  test("loses: out of Design into the personal space", async () => {
    const b = await r.createBoard({ tenant: acme.id, title: "D", space: design.id, owner: "google:ada" });
    const d = await mv.preview(ada, b.id, adasSpace.id);
    expect(names(d.loses)).toEqual(["Design team:editor>-", "Everyone in the organization:viewer>-"].sort());
    expect(names(d.keeps)).toEqual(["ada:owner>owner"]);
    expect(d.gains).toEqual([]);
    expect(d.keeps.find(e => e.self).subject.id).toBe("google:ada");
  });
  test("the diff equals what the resolver says once the board has moved (people, Teams' members, everyone)", async () => {
    await r.setGrant(board.id, "google:max", "annotator");
    await r.setGrant(board.id, "google:zed", "viewer");
    const people = [ada, max, zed];
    const d = await mv.preview(ada, board.id, design.id);
    const before = Object.fromEntries(await Promise.all(people.map(async p => [p.user, (await ten.effective(p, board.id)).ladder])));
    await mv.move(ada, board.id, { from: adasSpace.id, to: design.id });
    for (const p of people) {
      const e = [...d.gains, ...d.keeps, ...d.loses].find(x => x.subject.id === p.user);
      const now = (await ten.effective(p, board.id)).ladder;
      expect(e?.after?.id ?? null).toBe(now);
      expect(e?.before?.id ?? null).toBe(before[p.user]);
    }
    const every = [...d.gains, ...d.keeps].find(e => e.subject.type === "everyone");
    expect(every.after.id).toBe((await ten.effective(ident("nobody"), board.id)).ladder);
  });
  test("a person's role is the highest over what they hold: zed's grant (annotator) is raised by the Team (editor)", async () => {
    await r.setGrant(board.id, "google:zed", "annotator");
    const d = await mv.preview(ada, board.id, design.id);
    const z = d.gains.find(e => e.subject.id === "google:zed");
    expect([z.before.id, z.after.id]).toEqual(["annotator", "editor"]);
  });
  test("invites and links travel and are counted for a manager (members.manage) only", async () => {
    await r.createInvite({ board: board.id, email: "p@partner.io", role: "viewer", by: "google:ada", expiresAt: Date.now() + 1e9 });
    await r.createInvite({ board: board.id, email: "old@partner.io", role: "viewer", by: "google:ada", expiresAt: Date.now() - 1 });
    await r.createLink({ board: board.id, role: "viewer", by: "google:ada" });
    expect(await mv.preview(ada, board.id, design.id)).toMatchObject({ invites: 1, links: 1 });       // the expired one does not count
  });
  test("the counts are null for a mover without members.manage", async () => {
    const open = await r.createSpace({ tenant: acme.id, name: "Open", generalRole: "editor" });
    const role = await r.createRole({ tenant: acme.id, name: "OnlyMove", boardRole: "editor", permissions: ["move"] });
    const b = await r.createBoard({ tenant: acme.id, title: "S", space: platform.id });
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: { type: "user", id: "google:max" }, role: role.id });
    await r.createInvite({ board: b.id, email: "p@partner.io", role: "viewer", by: "google:ada" });
    const d = await mv.preview(max, b.id, open.id);
    expect(d).toMatchObject({ invites: null, links: null });
    expect(JSON.stringify(d)).not.toContain("partner.io");
  });
  test("no leak: a source Space the mover cannot open is not named, its people and Teams are not listed, and hidden says so (no count)", async () => {
    // ada owns the board but cannot open Secret, where it lives; Secret grants max and a Team
    await r.setScopedGrant({ scope: { type: "space", id: secret.id }, subject: { type: "user", id: "google:max" }, role: "editor" });
    await r.setScopedGrant({ scope: { type: "space", id: secret.id }, subject: { type: "team", id: designers.id }, role: "viewer" });
    const b = await r.createBoard({ tenant: acme.id, title: "Hushed", space: secret.id, owner: "google:ada" });
    const d = await mv.preview(ada, b.id, design.id);
    expect(d.from).toEqual({ hidden: true });
    expect(d.hidden).toBe(true);
    const text = JSON.stringify(d);
    for (const leak of ["Secret", "google:max", "max", secret.id, "root"]) expect(text).not.toContain(leak);
    expect(d.keeps.map(e => e.subject.id)).toEqual(["google:ada"]);
    expect(d.loses).toEqual([]);                 // nobody visible loses: everything lost is through the hidden Space
    expect(Object.keys(d).sort()).toEqual(["board", "from", "gains", "hidden", "invites", "keeps", "links", "loses", "more", "to"]);
    // a Team reachable ONLY through the hidden Space shows up as a gain from Design (visible), at its destination role only
    expect(d.gains.find(e => e.subject.type === "team")).toMatchObject({ subject: { name: "Design team" }, before: null, after: { id: "editor" } });
    expect(JSON.stringify(await mv.options(ada, b.id))).not.toContain("Secret");
  });
  test("hidden is false when every container is open or empty", async () => {
    expect((await mv.preview(ada, board.id, design.id)).hidden).toBe(false);
  });
  test("a person with a board grant and a guest (no directory row) get no general access in the diff", async () => {
    await r.setGrant(board.id, "google:kim", "viewer");
    const d = await mv.preview(ada, board.id, design.id);
    const k = [...d.gains, ...d.keeps].find(e => e.subject.id === "google:kim");
    expect([k.before.id, k.after.id]).toEqual(["viewer", "viewer"]);          // never lifted by Design's general viewer: a guest is not a member
  });
  test("bad destinations: the current Space, nothing, unknown", async () => {
    expect(await code(mv.preview(ada, board.id, adasSpace.id))).toBe("bad-request");
    expect(await code(mv.preview(ada, board.id, undefined))).toBe("forbidden");
    expect(await code(mv.preview(ada, board.id, "s-nope00000000"))).toBe("forbidden");
  });
});

describe("the move: compare-and-set, idempotent, undo", () => {
  test("moves, answers the undo, and the board stays where it moved", async () => {
    const out = await mv.move(ada, board.id, { from: adasSpace.id, to: design.id });
    expect(out).toMatchObject({ moved: true, board: { id: board.id, space: { id: design.id, name: "Design" } }, undo: { space: { id: adasSpace.id, personal: true } } });
    expect((await r.board(board.id)).space).toBe(design.id);
    expect(await r.grant(board.id, "google:ada")).toBe("owner");           // direct grants travel
  });
  test("`from` is required: a missing, null or malformed one is bad-request, and nothing moves", async () => {
    for (const body of [{ to: design.id }, { from: null, to: design.id }, { from: "a b", to: design.id }]) expect(await code(mv.move(ada, board.id, body))).toBe("bad-request");
    expect((await r.board(board.id)).space).toBe(adasSpace.id);
  });
  test("undo is a move back; double undo is a harmless no-op; a move in between makes it 409 moved", async () => {
    await mv.move(ada, board.id, { from: adasSpace.id, to: design.id });
    const back = await mv.move(ada, board.id, { from: design.id, to: adasSpace.id });
    expect(back.moved).toBe(true);
    expect((await mv.move(ada, board.id, { from: design.id, to: adasSpace.id })).moved).toBe(false);
    await mv.move(ada, board.id, { from: adasSpace.id, to: design.id });
    await mv.move(ada, board.id, { from: design.id, to: platform.id });     // someone moves it on
    expect(await code(mv.move(ada, board.id, { from: design.id, to: adasSpace.id }))).toBe("moved");
    expect((await r.board(board.id)).space).toBe(platform.id);
  });
  test("undo is forbidden once the mover can no longer put a board back in the original Space, and the board stays", async () => {
    const tmp = await r.createSpace({ tenant: acme.id, name: "Tmp", generalRole: null, owner: "google:ada" });
    await r.setScopedGrant({ scope: { type: "space", id: tmp.id }, subject: { type: "user", id: "google:max" }, role: "owner" });
    const b = await r.createBoard({ tenant: acme.id, title: "T", space: tmp.id, owner: "google:ada" });
    const out = await mv.move(ada, b.id, { from: tmp.id, to: design.id });
    expect(out.undo.space.id).toBe(tmp.id);
    await r.setScopedGrant({ scope: { type: "space", id: tmp.id }, subject: { type: "user", id: "google:ada" }, role: null });
    expect(await code(mv.move(ada, b.id, { from: design.id, to: tmp.id }))).toBe("forbidden");
    expect((await r.board(b.id)).space).toBe(design.id);
  });
  test("bad bodies are 400 before any read of the board", async () => {
    for (const body of [{}, { to: 5 }, { from: 5, to: design.id }, { from: design.id, to: design.id }, { from: "a b", to: design.id }]) expect(await code(mv.move(ada, board.id, body))).toBe("bad-request");
  });
  test("concurrent moves to two Spaces: exactly one wins, the other is moved, and no state is interleaved", async () => {
    const out = await Promise.allSettled([mv.move(ada, board.id, { from: adasSpace.id, to: design.id }), mv.move(ada, board.id, { from: adasSpace.id, to: platform.id })]);
    expect(out.filter(o => o.status === "fulfilled").length).toBe(1);
    expect(out.find(o => o.status === "rejected").reason.code).toBe("moved");
  });
});

describe("review fixes (#53)", () => {
  test("MED-1: undo is decided after the write: a Space owner who moves Zed's board into a Space where they are only an editor is offered no Undo", async () => {
    const b2 = await r.createSpace({ tenant: acme.id, name: "B2", generalRole: null, owner: "google:root" });
    await r.setScopedGrant({ scope: { type: "space", id: b2.id }, subject: { type: "user", id: "google:ada" }, role: "editor" });
    const zeds = await r.createBoard({ tenant: acme.id, title: "Zeds", space: platform.id, owner: "google:zed" });
    const out = await mv.move(ada, zeds.id, { from: platform.id, to: b2.id });
    expect(out).toMatchObject({ moved: true, undo: null });                       // ada is a Space-A owner (move at A) but only an editor at B: no move there
    expect(await code(mv.move(ada, zeds.id, { from: b2.id, to: platform.id }))).toBe("forbidden");   // so the answer never promised what is refused
  });
  test("MED-1: an offered undo succeeds", async () => {
    const out = await mv.move(ada, board.id, { from: adasSpace.id, to: design.id });
    expect(out.undo.space.id).toBe(adasSpace.id);
    expect((await mv.move(ada, board.id, { from: design.id, to: out.undo.space.id })).moved).toBe(true);
  });
  test("MED-1b: replay by the same caller whose board is now in `to` answers the first result even without move there; a board moved on is 409; an unopenable `to` is 403", async () => {
    const b2 = await r.createSpace({ tenant: acme.id, name: "B2", generalRole: null, owner: "google:root" });
    await r.setScopedGrant({ scope: { type: "space", id: b2.id }, subject: { type: "user", id: "google:ada" }, role: "editor" });
    const zeds = await r.createBoard({ tenant: acme.id, title: "Zeds", space: platform.id, owner: "google:zed" });
    await mv.move(ada, zeds.id, { from: platform.id, to: b2.id });
    const rep = await mv.replay(ada, zeds.id, { from: platform.id, to: b2.id }, `${zeds.id}:moved`);
    expect(rep).toMatchObject({ moved: true, undo: null, board: { id: zeds.id, space: { id: b2.id, name: "B2" } } });
    await r.moveBoard({ board: zeds.id, from: b2.id, to: design.id });
    expect(await code(mv.replay(ada, zeds.id, { from: platform.id, to: b2.id }, `${zeds.id}:moved`))).toBe("moved");
    expect(await code(mv.replay(max, zeds.id, { from: platform.id, to: b2.id }, `${zeds.id}:moved`))).toBe("forbidden");   // max cannot open B2
  });
  test("LOW-4: a replay reports the real moved flag (noop stays false) and offers undo only for a real move", async () => {
    await mv.move(ada, board.id, { from: adasSpace.id, to: design.id });
    expect(await mv.replay(ada, board.id, { from: adasSpace.id, to: design.id }, `${board.id}:noop`)).toMatchObject({ moved: false, undo: null });
    expect(await mv.replay(ada, board.id, { from: adasSpace.id, to: design.id }, `${board.id}:moved`)).toMatchObject({ moved: true, undo: { space: { id: adasSpace.id } } });
  });
  test("LOW-2: preview of a Space the caller can't open is the one 403 whether or not the board is in it; of the board's own open Space it is 400", async () => {
    const hushed = await r.createBoard({ tenant: acme.id, title: "H", space: secret.id, owner: "google:ada" });
    expect(await code(mv.preview(ada, hushed.id, secret.id))).toBe("forbidden");           // the board IS in Secret: still 403, no oracle
    expect(await code(mv.preview(ada, hushed.id, platform.id))).toBe(null);   // an openable, creatable other Space previews fine
    expect(await code(mv.preview(ada, board.id, adasSpace.id))).toBe("bad-request");       // her own open Space: the board is already there
  });
  test("LOW-3: a stale `from` is 409 moved before anything is written; a board already in `to` stays the no-op success", async () => {
    expect(await code(mv.move(ada, board.id, { from: platform.id, to: design.id }))).toBe("moved");      // it is in her personal space
    expect((await r.board(board.id)).space).toBe(adasSpace.id);
    await mv.move(ada, board.id, { from: adasSpace.id, to: design.id });
    expect((await mv.move(ada, board.id, { from: platform.id, to: design.id })).moved).toBe(false);       // already there: harmless whatever `from` says
  });
});

describe("the announcement", () => {
  test("a move announces { board } on the grants subject exactly once, through the announcing Registry", async () => {
    const published = [];
    const bus = { publish: async (subject, msg) => { published.push([subject, msg]); } };
    const reg = announcingRegistry(r, bus, { warn() {} });
    const m = moveService({ registry: reg, tenancy: makeTenancy({ registry: reg }), spaces: spaceService({ registry: reg, tenancy: makeTenancy({ registry: reg }) }) });
    await m.move(ada, board.id, { from: adasSpace.id, to: design.id });
    expect(published.length).toBe(1);
    expect(published[0][0]).toContain(board.id);
    expect(published[0][1]).toEqual({ board: board.id });
  });
});

describe("over HTTP", () => {
  let routes;
  const ORIGIN = "https://plenary.test";
  const api = async (tok, path, method = "GET", body, headers = {}) => {
    const res = await routes(new Request(ORIGIN + path, { method, headers: { authorization: `Bearer ${tok}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined }));
    return { status: res.status, text: await res.text(), headers: res.headers };
  };
  beforeEach(async () => {
    const dev = devAuth({ enabled: true, tokens: { ada: { name: "ada", domain: "acme.com", email: "ada@acme.com", user: "google:ada" }, max: { name: "max", domain: "acme.com", email: "max@acme.com", user: "google:max" } } });
    routes = httpRoutes({ registry: r, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy: ten,
      config: { cookieKey: "k".repeat(32), postLoginUrl: ORIGIN + "/", boardUrl: ORIGIN + "/b/{board}", publicUrl: ORIGIN }, dev });
    // dev users are `dev:<name>`: make them the Unit's people
    await r.setGrant(board.id, "dev:ada", "owner");
    await r.setScopedGrant({ scope: { type: "space", id: design.id }, subject: { type: "user", id: "dev:ada" }, role: "owner" });
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: { type: "user", id: "dev:ada" }, role: "owner" });
    await r.touchMember(acme.id, { user: "dev:ada", name: "ada", email: "ada@acme.com" });
    await r.touchMember(acme.id, { user: "dev:max", name: "max", email: "max@acme.com" });
  });
  test("options, preview and move; a non-mover and a stranger get the same 403 body", async () => {
    const o = JSON.parse((await api("ada", `/boards/${board.id}/move`)).text);
    expect(o.destinations.map(d => d.name)).toContain("Design");
    const p = await api("ada", `/boards/${board.id}/move/preview?to=${design.id}`);
    expect(p.status).toBe(200);
    expect(JSON.parse(p.text).gains.length).toBeGreaterThan(0);
    const a = await api("max", `/boards/${board.id}/move`), b = await api("max", "/boards/b-nope0000000000/move");
    expect([a.status, a.text]).toEqual([b.status, b.text]);
    expect(a.status).toBe(403);
    expect((await api("ada", `/boards/${board.id}/move/preview`)).status).toBe(400);
    expect((await api("ada", `/boards/${board.id}/move/preview?to=${design.id}&x=1`)).status).toBe(400);
  });
  test("POST: 200, 409 moved, unknown field 400, idempotency-key replays exactly once and a reused key is 422", async () => {
    const body = { from: adasSpace.id, to: design.id };
    await r.moveBoard({ board: board.id, from: adasSpace.id, to: platform.id });
    await r.moveBoard({ board: board.id, from: platform.id, to: adasSpace.id });
    const key = { "idempotency-key": "move-key-http-1" };
    const first = await api("ada", `/boards/${board.id}/move`, "POST", body, key);
    expect(first.status).toBe(200);
    expect(JSON.parse(first.text).moved).toBe(true);
    expect((await api("ada", `/boards/${board.id}/move`, "POST", { from: design.id, to: platform.id })).status).toBe(200);   // on, unkeyed
    const moved = await api("ada", `/boards/${board.id}/move`, "POST", body, key);                                 // the board moved on since: the key's `to` no longer holds it
    expect(moved.status).toBe(409);
    expect((await r.board(board.id)).space).toBe(platform.id);                                                       // and nothing moved
    expect((await api("ada", `/boards/${board.id}/move`, "POST", { from: adasSpace.id, to: platform.id }, key)).status).toBe(422);
    expect(await api("ada", `/boards/${board.id}/move`, "POST", { from: adasSpace.id, to: design.id })).toMatchObject({ status: 409, text: '{"error":"moved"}' });
    expect((await api("ada", `/boards/${board.id}/move`, "POST", { ...body, x: 1 })).status).toBe(400);
    expect((await api("ada", `/boards/${board.id}/move`, "POST", { from: null })).status).toBe(400);
  });
  test("MED-1b over HTTP: a Space owner's keyed move into a Space where they are an editor replays 200 (not 403), with the real moved flag; the same key for another body is 422", async () => {
    const b2 = await r.createSpace({ tenant: acme.id, name: "B2", generalRole: null, owner: "google:root" });
    await r.setScopedGrant({ scope: { type: "space", id: b2.id }, subject: { type: "user", id: "dev:ada" }, role: "editor" });
    const zeds = await r.createBoard({ tenant: acme.id, title: "Zeds", space: platform.id, owner: "google:zed" });
    const body = { from: platform.id, to: b2.id }, key = { "idempotency-key": "move-key-http-2" };
    const first = await api("ada", `/boards/${zeds.id}/move`, "POST", body, key);
    expect(first.status).toBe(200);
    expect(JSON.parse(first.text)).toMatchObject({ moved: true, undo: null });
    const again = await api("ada", `/boards/${zeds.id}/move`, "POST", body, key);
    expect([again.status, again.headers.get("idempotent-replayed")]).toEqual([200, "true"]);
    expect(JSON.parse(again.text)).toMatchObject({ moved: true, board: { id: zeds.id, space: { id: b2.id } } });
    expect((await api("ada", `/boards/${zeds.id}/move`, "POST", { from: platform.id, to: design.id }, key)).status).toBe(422);
    // a no-op under its own key replays as a no-op
    const nk = { "idempotency-key": "move-key-http-3" };
    await r.moveBoard({ board: board.id, from: adasSpace.id, to: platform.id });
    const n1 = await api("ada", `/boards/${board.id}/move`, "POST", { from: design.id, to: platform.id }, nk), n2 = await api("ada", `/boards/${board.id}/move`, "POST", { from: design.id, to: platform.id }, nk);
    expect([n1.status, JSON.parse(n1.text).moved, n2.status, JSON.parse(n2.text).moved, n2.headers.get("idempotent-replayed")]).toEqual([200, false, 200, false, "true"]);
  });
  test("a card's can.move is true for a mover, false for a viewer", async () => {
    await r.moveBoard({ board: board.id, from: adasSpace.id, to: platform.id });
    const p = JSON.parse((await api("ada", `/spaces/${platform.id}`)).text);
    expect(p.boards.find(c => c.id === board.id).can.move).toBe(true);
    await r.setScopedGrant({ scope: { type: "space", id: platform.id }, subject: { type: "user", id: "dev:max" }, role: "viewer" });
    await r.setGrant(board.id, "dev:ada", "viewer").catch(() => {});
    expect(JSON.parse((await api("max", `/spaces/${platform.id}`)).text).boards.find(c => c.id === board.id).can.move).toBe(false);
  });
});
