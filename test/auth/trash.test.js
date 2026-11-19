// Trash and restore (server/auth/trash.js, PROTOCOL.md § Trash and restore, #54): who may trash and restore (the `delete` permission), what a trashed board is to everyone else
// (no role, no listing, no management, no new use of a link), the Space that takes its boards with it, the Trash list, the board-URL notice, the announcement and the HTTP routes.
import { test, expect, beforeEach, describe } from "bun:test";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy as makeTenancy, roleCache } from "../../server/auth/tenancy.js";
import { spaceService } from "../../server/auth/spaces.js";
import { homeService } from "../../server/auth/home.js";
import { trashService } from "../../server/auth/trash.js";
import { TRASH } from "../../server/auth/registry-port.js";
import { announcingRegistry } from "../../server/main.js";
import { httpRoutes } from "../../server/auth/http.js";
import { sessions as makeSessions } from "../../server/auth/session.js";
import { devAuth } from "../../server/auth/dev.js";
import { createInvite, createLink } from "../../server/admin/boards.js";

const ident = (n, domain = "acme.com") => ({ user: `google:${n}`, name: n, email: `${n}@${domain}`, domain });
const ada = ident("ada"), max = ident("max"), kim = ident("kim", "partner.io"), root = ident("root"), zed = ident("zed");
const DAY = 24 * 3600_000;
let clock, r, ten, spaces, home, tr, acme, product, design, platform, adasSpace, board;
const code = p => p.then(() => null, e => e.code ?? e.message);

beforeEach(async () => {
  clock = { t: Date.UTC(2026, 10, 11) };
  r = memoryRegistry({ now: () => clock.t });
  ten = makeTenancy({ registry: r, now: () => clock.t });
  home = homeService({ registry: r, tenancy: ten });
  spaces = spaceService({ registry: r, tenancy: ten, home });
  tr = trashService({ registry: r, tenancy: ten, spaces, now: () => clock.t });
  acme = await r.createTenant({ domain: "acme.com", admins: ["google:root"] });
  for (const p of [ada, max, zed, root]) await r.touchMember(acme.id, { user: p.user, name: p.name, email: p.email });
  product = await r.createGroup({ tenant: acme.id, name: "Product", generalRole: null, owner: "google:ada" });
  design = await r.createSpace({ tenant: acme.id, name: "Design", group: product.id, generalRole: "viewer", owner: "google:ada" });
  platform = await r.createSpace({ tenant: acme.id, name: "Platform", generalRole: "editor", owner: "google:root" });
  adasSpace = await r.ensurePersonalSpace(acme.id, "google:ada");
  board = await r.createBoard({ tenant: acme.id, title: "Roadmap", space: design.id, owner: "google:ada", memberRole: null });
});

describe("who may trash and restore (the `delete` permission)", () => {
  test("a board owner, a Space owner and a Unit admin may; an editor, a viewer, a stranger, a guest, an unknown id and another Unit's board get the one forbidden", async () => {
    await r.setGrant(board.id, "google:max", "editor");
    const globex = await r.createTenant({ domain: "globex.com" });
    const alien = await r.createBoard({ tenant: globex.id, space: (await r.createSpace({ tenant: globex.id, name: "G" })).id, title: "x", owner: "google:g" });
    for (const [who, id] of [[max, board.id], [zed, board.id], [kim, board.id], [ada, "b-nope0000000000"], [ada, alien.id], [ada, "a b"]]) {
      expect(await code(tr.trashBoard(who, id, { from: design.id }))).toBe("forbidden");
      expect(await code(tr.restoreBoard(who, id))).toBe("forbidden");
    }
    expect((await r.board(board.id)).trashedAt).toBe(null);
    expect((await tr.trashBoard(root, board.id, { from: design.id })).trashed).toBe(true);          // Unit admin: `delete` at the Unit, no board content needed
    expect((await tr.restoreBoard(ada, board.id)).restored).toBe(true);                           // the board owner
    expect((await tr.trashBoard(ada, board.id, { from: design.id })).trashed).toBe(true);
  });
  test("a custom role carrying `delete` is enough (permissions, not role names); the same role without it is not", async () => {
    const withDel = await r.createRole({ tenant: acme.id, name: "Janitor", boardRole: "viewer", permissions: ["delete"] });
    const without = await r.createRole({ tenant: acme.id, name: "Peeker", boardRole: "viewer", permissions: ["move"] });
    await r.setScopedGrant({ scope: { type: "space", id: design.id }, subject: { type: "user", id: "google:max" }, role: without.id });
    expect(await code(tr.trashBoard(max, board.id, { from: design.id }))).toBe("forbidden");
    await r.setScopedGrant({ scope: { type: "space", id: design.id }, subject: { type: "user", id: "google:max" }, role: withDel.id });
    expect((await tr.trashBoard(max, board.id, { from: design.id })).trashed).toBe(true);
  });
  test("a non-deleter costs the same reads as a stranger and reaches no write", async () => {
    const calls = [];
    const reg = new Proxy(r, { get: (t, k) => (typeof t[k] === "function" ? (...a) => { calls.push(String(k)); return t[k](...a); } : t[k]) });
    const svc = trashService({ registry: reg, tenancy: makeTenancy({ registry: reg }), spaces });
    await code(svc.trashBoard(max, board.id, { from: design.id }));
    for (const banned of ["trashBoard", "restoreBoard", "trashSpace", "restoreSpace", "space"]) expect(calls.includes(banned)).toBe(false);
  });
  test("`from` is required: a missing or non-id value is bad-request; a stale `from` is moved and nothing changes", async () => {
    for (const from of [undefined, null, 5, "a b"]) expect(await code(tr.trashBoard(ada, board.id, { from }))).toBe("bad-request");
    expect(await code(tr.trashBoard(ada, board.id, { from: platform.id }))).toBe("moved");
    expect((await r.board(board.id)).trashedAt).toBe(null);
  });
});

describe("a trashed board is out of reach", () => {
  beforeEach(async () => {
    await r.setGrant(board.id, "google:max", "editor");
    await r.setGrant(board.id, "google:kim", "viewer");   // a guest's direct grant
    await tr.trashBoard(ada, board.id, { from: design.id });
  });
  test("every role is null: owner, editor, guest, Space-wide general access and the Unit admin get no room", async () => {
    for (const who of [ada, max, kim, zed, root]) expect(await ten.role(who, board.id)).toBe(null);
    for (const who of [ada, max, kim, zed, root]) expect((await ten.access(who, board.id)).role).toBe(null);
  });
  test("every permission is gone but `delete`, which only a holder keeps", async () => {
    const a = await ten.effective(ada, board.id), m = await ten.effective(max, board.id);
    expect([...a.permissions]).toEqual(["delete"]);
    expect([...m.permissions]).toEqual([]);
    expect(a.ladder).toBe(null);
    expect(a.trashed).toMatchObject({ by: "google:ada", at: clock.t, ladder: "owner", with: null });
    expect(m.trashed.ladder).toBe("editor");
  });
  test("the room's re-check pass (rolesFor) and the role cache see no role either", async () => {
    const m = await ten.resolveMany(board.id, [ada, max, kim]);
    for (const v of m.values()) expect(v.role).toBe(null);
    const cache = roleCache({ registry: r, now: () => clock.t });
    expect(await cache.role(ada, board.id)).toBe(null);
    await tr.restoreBoard(ada, board.id);
    cache.invalidate(board.id);
    expect(await cache.role(ada, board.id)).toBe("owner");
  });
  test("it leaves Home's lists, the Space page, search and the picker", async () => {
    const page = await spaces.spacePage(ada, design.id);
    expect(page.boards.map(b => b.id)).not.toContain(board.id);
    expect((await home.search(ada, "Roadmap")).results.map(b => b.id)).not.toContain(board.id);
    expect((await home.spaceBoards(ada, design.id)).results.map(b => b.id)).not.toContain(board.id);
    const live = await r.createBoard({ tenant: acme.id, title: "Live", space: design.id, owner: "google:ada" });   // the control: a live board shows in the same lists
    for (const b of [board, live]) { await r.markOpened("google:ada", b.id); await r.setStarred("google:ada", b.id, true); }
    const h = await home.home(ada);
    for (const list of [h.recent, h.starred]) { expect(list.map(b => b.id)).toContain(live.id); expect(list.map(b => b.id)).not.toContain(board.id); }
    expect(JSON.stringify(h)).not.toContain(board.id);
  });
  test("management and sharing are refused: invites, links, grants, move, rename", async () => {
    const deps = { registry: r, tenancy: ten, now: () => clock.t };
    expect(await code(createInvite({ caller: ada, board: board.id, email: "x@y.com", role: "viewer" }, deps))).toBe("forbidden");
    expect(await code(createLink({ caller: ada, board: board.id, role: "viewer" }, deps))).toBe("forbidden");
    expect(await code(spaces.renameBoard(ada, board.id, "New"))).toBeTruthy();
    expect((await r.board(board.id)).title).toBe("Roadmap");
  });
  test("redeeming a share link of a trashed board answers like an unknown link and records no use; after Restore it works", async () => {
    await tr.restoreBoard(ada, board.id);
    const lk = await r.createLink({ board: board.id, role: "viewer", by: "google:ada" });
    await tr.trashBoard(ada, board.id, { from: design.id });
    expect(await ten.redeemLink(kim, lk.id)).toBe(null);
    expect(await r.linkUses(board.id, kim.user)).toEqual([]);
    await tr.restoreBoard(ada, board.id);
    expect(await ten.redeemLink(zed, lk.id)).toEqual({ board: board.id });
  });
  test("an invite to a trashed board gives nothing, and works again after Restore", async () => {
    await tr.restoreBoard(ada, board.id);
    await r.createInvite({ board: board.id, email: "kim@partner.io", role: "viewer", by: "google:ada", expiresAt: null });
    const lone = ident("lonely", "partner.io");
    await r.createInvite({ board: board.id, email: lone.email, role: "editor", by: "google:ada", expiresAt: null });
    expect(await ten.role(lone, board.id)).toBe("editor");
    await tr.trashBoard(ada, board.id, { from: design.id });
    expect(await ten.role(lone, board.id)).toBe(null);
    await tr.restoreBoard(ada, board.id);
    expect(await ten.role(lone, board.id)).toBe("editor");
  });
  test("Restore brings back exactly the grants, invites and links it had", async () => {
    await tr.restoreBoard(ada, board.id);
    expect(await ten.role(max, board.id)).toBe("editor");
    expect(await ten.role(kim, board.id)).toBe("viewer");
    expect(await ten.role(ada, board.id)).toBe("owner");
    expect(await ten.role(zed, board.id)).toBe("viewer");   // Design's general access again
  });
});

describe("trash, undo and restore", () => {
  test("trash answers the board, its Space, the clock and an undo; a second trash is a no-op; undo (restore) is a no-op the second time", async () => {
    const o = await tr.trashBoard(ada, board.id, { from: design.id });
    expect(o).toMatchObject({ board: { id: board.id, title: "Roadmap", space: { id: design.id, name: "Design" } }, trashed: true, trashedAt: clock.t, expiresAt: clock.t + TRASH.ttlMs, undo: { restore: true } });
    const again = await tr.trashBoard(ada, board.id, { from: design.id });
    expect(again).toMatchObject({ trashed: false, undo: null });
    expect(again.trashedAt).toBe(o.trashedAt);
    expect(await tr.restoreBoard(ada, board.id)).toMatchObject({ restored: true, board: { id: board.id, space: { id: design.id } } });
    expect((await tr.restoreBoard(ada, board.id)).restored).toBe(false);
  });
  test("a board whose Space is in Trash is not restored on its own (409 space-in-trash); one taken with its Space is restored through the Space", async () => {
    const other = await r.createBoard({ tenant: acme.id, title: "Other", space: design.id, owner: "google:ada" });
    await tr.trashBoard(ada, board.id, { from: design.id });
    await tr.trashSpace(ada, design.id);
    expect(await code(tr.restoreBoard(ada, board.id))).toBe("space-in-trash");
    expect(await code(tr.restoreBoard(ada, other.id))).toBe("with-space");
    await tr.restoreSpace(ada, design.id);
    expect((await r.board(other.id)).trashedAt).toBe(null);
    expect((await r.board(board.id)).trashedAt).not.toBe(null);   // its own clock: still in Trash
    expect((await tr.restoreBoard(ada, board.id)).restored).toBe(true);
  });
  test("a claimed (being purged) board cannot be restored: 409 purged", async () => {
    await tr.trashBoard(ada, board.id, { from: design.id });
    clock.t += TRASH.ttlMs;
    await r.purgeClaim({ type: "board", id: board.id, before: clock.t });
    expect(await code(tr.restoreBoard(ada, board.id))).toBe("purged");
  });
});

describe("a Space in Trash", () => {
  test("needs `delete` on the Space; never a personal Space; takes its boards and its own page, picker and create rights with it", async () => {
    const b2 = await r.createBoard({ tenant: acme.id, title: "Two", space: design.id, owner: "google:ada" });
    expect(await code(tr.trashSpace(max, design.id))).toBe("forbidden");
    expect(await code(tr.trashSpace(ada, adasSpace.id))).toBe("forbidden");
    expect(await code(tr.trashSpace(ada, "s-nope00000000"))).toBe("forbidden");
    const o = await tr.trashSpace(ada, design.id);
    expect(o).toMatchObject({ space: { id: design.id, name: "Design" }, trashed: true, boards: 2, undo: { restore: true } });
    for (const b of [board, b2]) expect(await ten.role(ada, b.id)).toBe(null);
    expect(await code(spaces.spacePage(ada, design.id))).toBe("not-found");
    expect(await code(spaces.createBoard(ada, { title: "x", space: design.id }))).toBe("forbidden");
    expect((await spaces.boardPicker(ada)).spaces.map(s => s.id)).not.toContain(design.id);
    expect((await ten.effective(ada, { type: "space", id: design.id })).permissions.has("board.create")).toBe(false);
    expect(await tr.restoreSpace(ada, design.id)).toMatchObject({ restored: true, boards: 2 });
    for (const b of [board, b2]) expect(await ten.role(ada, b.id)).toBe("owner");
    expect((await spaces.spacePage(ada, design.id)).boards).toHaveLength(2);
  });
  test("a Space holder with `delete` at the Group (Group owner) may trash its Spaces; trashing announces every board in it, trashed ones included", async () => {
    await r.setScopedGrant({ scope: { type: "group", id: product.id }, subject: { type: "user", id: "google:zed" }, role: "owner" });
    const sent = [];
    const sv = spaceService({ registry: r, tenancy: ten, home, announce: async (tenant, b) => { sent.push(b); } });
    const t2 = trashService({ registry: r, tenancy: ten, spaces: sv, now: () => clock.t });
    const b2 = await r.createBoard({ tenant: acme.id, title: "Two", space: design.id, owner: "google:ada" });
    await t2.trashSpace(zed, design.id);
    await sv.settled();
    expect(sent.sort()).toEqual([board.id, b2.id].sort());
    sent.length = 0;
    await t2.restoreSpace(zed, design.id);
    await sv.settled();
    expect(sent.sort()).toEqual([board.id, b2.id].sort());
  });
});

describe("the Trash list", () => {
  test("lists what the caller may restore: where each board was, who deleted it, the days left; newest first", async () => {
    const b2 = await r.createBoard({ tenant: acme.id, title: "Two", space: design.id, owner: "google:ada" });
    await tr.trashBoard(ada, board.id, { from: design.id });
    clock.t += 3 * DAY + 1000;
    await tr.trashBoard(ada, b2.id, { from: design.id });
    clock.t += DAY;
    const list = await tr.list(ada);
    expect(list.more).toBe(false);
    expect(list.items.map(i => i.title)).toEqual(["Two", "Roadmap"]);
    expect(list.items[0]).toMatchObject({ type: "board", id: b2.id, from: { space: { id: design.id, name: "Design", personal: false }, group: { id: product.id, name: "Product" } }, by: { id: "google:ada", name: "ada" }, daysLeft: 29 });
    expect(list.items[1].daysLeft).toBe(26);
    expect(list.items[0].expiresAt).toBe(list.items[0].trashedAt + TRASH.ttlMs);
  });
  test("a person sees only items they hold `delete` on: not another's board, a Unit admin sees all of the Unit, a stranger and a guest none", async () => {
    const mine = await r.createBoard({ tenant: acme.id, title: "Max's", space: platform.id, owner: "google:max" });
    await tr.trashBoard(ada, board.id, { from: design.id });
    await tr.trashBoard(max, mine.id, { from: platform.id });
    expect((await tr.list(ada)).items.map(i => i.title)).toEqual(["Roadmap"]);
    expect((await tr.list(max)).items.map(i => i.title)).toEqual(["Max's"]);
    expect((await tr.list(zed)).items).toEqual([]);
    expect((await tr.list(root)).items.map(i => i.title).sort()).toEqual(["Max's", "Roadmap"]);
    expect(await code(tr.list(kim))).toBe("forbidden");
  });
  test("no leak: a board owner who cannot open its Space sees the board but not the Space's name; the deleter's name is shown only to those listed", async () => {
    const secret = await r.createSpace({ tenant: acme.id, name: "Secret plans", generalRole: null, owner: "google:root" });
    const b = await r.createBoard({ tenant: acme.id, title: "Hush", space: secret.id, owner: "google:max" });
    await tr.trashBoard(max, b.id, { from: secret.id });
    const item = (await tr.list(max)).items[0];
    expect(item.from).toEqual({ space: null, group: null });
    expect(JSON.stringify(await tr.list(max))).not.toContain("Secret plans");
    expect((await tr.list(root)).items[0].from.space.name).toBe("Secret plans");
  });
  test("a Space is one row (its boards are not listed); a board trashed before its Space keeps its own row and clock", async () => {
    const b2 = await r.createBoard({ tenant: acme.id, title: "Two", space: design.id, owner: "google:ada" });
    await tr.trashBoard(ada, board.id, { from: design.id });
    clock.t += 2 * DAY;
    await tr.trashSpace(ada, design.id);
    const items = (await tr.list(ada)).items;
    expect(items.map(i => [i.type, i.name ?? i.title, i.boards])).toEqual([["space", "Design", 1], ["board", "Roadmap", undefined]]);
    expect(items.find(i => i.type === "board").daysLeft).toBe(28);
    expect(items.find(i => i.type === "space")).toMatchObject({ daysLeft: 30, group: { id: product.id, name: "Product" } });
    expect(b2.id).toBeTruthy();
  });
  test("a long Trash is read in bounded pages: at most 50 items and `more`", async () => {
    const sp = await r.createSpace({ tenant: acme.id, name: "Many", generalRole: null, owner: "google:ada" });
    for (let i = 0; i < 55; i++) { const b = await r.createBoard({ tenant: acme.id, title: `b${i}`, space: sp.id, owner: "google:ada" }); await tr.trashBoard(ada, b.id, { from: sp.id }); }
    const out = await tr.list(ada);
    expect(out.items).toHaveLength(50);
    expect(out.more).toBe(true);
  });
});

describe("the board-URL notice", () => {
  beforeEach(async () => {
    await r.setGrant(board.id, "google:max", "editor");
    await tr.trashBoard(ada, board.id, { from: design.id });
    clock.t += 2 * DAY;
  });
  test("a restorer sees the notice with who, where and days left, and canRestore", async () => {
    const n = await tr.notice(ada, board.id);
    expect(n).toMatchObject({ board: { id: board.id, title: "Roadmap" }, daysLeft: 28, canRestore: true, by: { id: "google:ada", name: "ada" }, from: { space: { id: design.id, name: "Design" }, group: { name: "Product" } } });
    expect(n.expiresAt).toBe(n.trashedAt + TRASH.ttlMs);
  });
  test("someone who could open it before sees only that it is in Trash (no who, no where, no restore)", async () => {
    const n = await tr.notice(max, board.id);
    expect(n).toMatchObject({ board: { id: board.id }, canRestore: false });
    expect(n.by).toBeUndefined(); expect(n.from).toBeUndefined();
    expect((await tr.notice(zed, board.id)).canRestore).toBe(false);   // Design's general access: could open
  });
  test("a stranger, a guest with no grant, a live board, an unknown id and another Unit's board are the same forbidden", async () => {
    const live = await r.createBoard({ tenant: acme.id, title: "Live", space: design.id, owner: "google:ada" });
    const hidden = await r.createSpace({ tenant: acme.id, name: "Hidden", generalRole: null, owner: "google:root" });
    const hb = await r.createBoard({ tenant: acme.id, title: "HB", space: hidden.id, owner: "google:root" });
    await tr.trashBoard(root, hb.id, { from: hidden.id });
    const answers = [];
    for (const [who, id] of [[kim, board.id], [ada, live.id], [ada, "b-nope0000000000"], [max, hb.id], [ada, hb.id]]) answers.push(await code(tr.notice(who, id)));
    expect(answers[0]).toBe("forbidden");
    expect(new Set(answers)).toEqual(new Set(["forbidden"]));
    expect((await tr.notice(root, hb.id)).canRestore).toBe(true);
  });
  test("a board that went with its Space says so; restoring goes through the Space, for those who hold `delete` there", async () => {
    const b2 = await r.createBoard({ tenant: acme.id, title: "Two", space: platform.id, owner: "google:max" });
    await tr.trashSpace(root, platform.id);
    const n = await tr.notice(max, b2.id);
    expect(n).toMatchObject({ canRestore: false, via: { space: { id: platform.id, name: "Platform" }, canRestore: false } });
    expect((await tr.notice(root, b2.id)).via.canRestore).toBe(true);
  });
});

describe("freshness: trash and restore announce the board", () => {
  test("a trash and a restore through the announcing Registry each announce { board } once", async () => {
    const published = [];
    const bus = { publish: async (subject, msg) => { published.push([subject, msg]); } };
    const reg = announcingRegistry(r, bus, { warn() {} });
    const svc = trashService({ registry: reg, tenancy: makeTenancy({ registry: reg }), spaces });
    await svc.trashBoard(ada, board.id, { from: design.id });
    await svc.restoreBoard(ada, board.id);
    expect(published.map(p => p[1])).toEqual([{ board: board.id }, { board: board.id }]);
    expect(published.every(p => p[0].includes(board.id))).toBe(true);
    await svc.restoreBoard(ada, board.id);                                  // a no-op still announces: harmless
    expect(published.length).toBe(3);
  });
});

describe("over HTTP", () => {
  let routes;
  const ORIGIN = "https://plenary.test";
  const api = async (tok, path, method = "GET", body, headers = {}) => {
    const res = await routes(new Request(ORIGIN + path, { method, headers: { authorization: `Bearer ${tok}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined }));
    return { status: res.status, json: res.headers.get("content-type")?.includes("json") ? JSON.parse(await res.clone().text()) : null, text: await res.text(), headers: res.headers };
  };
  beforeEach(async () => {
    const dev = devAuth({ enabled: true, tokens: { ada: { name: "ada", domain: "acme.com", email: "ada@acme.com", user: "google:ada" }, max: { name: "max", domain: "acme.com", email: "max@acme.com", user: "google:max" } } });
    routes = httpRoutes({ registry: r, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy: ten, home, spaces, trash: tr, now: () => clock.t,
      config: { cookieKey: "k".repeat(32), postLoginUrl: ORIGIN + "/", boardUrl: ORIGIN + "/b/{board}", publicUrl: ORIGIN }, dev });
    await r.setGrant(board.id, "dev:ada", "owner");
    await r.setScopedGrant({ scope: { type: "space", id: design.id }, subject: { type: "user", id: "dev:ada" }, role: "owner" });
    await r.touchMember(acme.id, { user: "dev:ada", name: "ada", email: "ada@acme.com" });
    await r.touchMember(acme.id, { user: "dev:max", name: "max", email: "max@acme.com" });
  });
  test("trash then restore: 200s, the keyed trash replays once, a reused key is 422, stale from is 409 moved, a body that is not { from } is 400", async () => {
    const key = { "idempotency-key": "trash-key-http-1" };
    const first = await api("ada", `/boards/${board.id}/trash`, "POST", { from: design.id }, key);
    expect([first.status, first.json.trashed, first.json.undo]).toEqual([200, true, { restore: true }]);
    const again = await api("ada", `/boards/${board.id}/trash`, "POST", { from: design.id }, key);
    expect([again.status, again.json.trashed, again.headers.get("idempotent-replayed")]).toEqual([200, true, "true"]);
    expect((await api("ada", `/boards/${board.id}/trash`, "POST", { from: platform.id }, key)).status).toBe(422);
    expect((await api("ada", `/boards/${board.id}/trash`, "POST", { from: platform.id })).status).toBe(200);   // already in Trash: a no-op whatever `from`
    const rk = { "idempotency-key": "restore-key-http-1" };
    const rest = await api("ada", `/boards/${board.id}/restore`, "POST", {}, rk);
    expect([rest.status, rest.json.restored]).toEqual([200, true]);
    const rep = await api("ada", `/boards/${board.id}/restore`, "POST", {}, rk);
    expect([rep.status, rep.json.restored, rep.headers.get("idempotent-replayed")]).toEqual([200, true, "true"]);
    expect((await api("ada", `/boards/${board.id}/trash`, "POST", { from: platform.id })).status).toBe(409);
    expect((await api("ada", `/boards/${board.id}/trash`, "POST", { from: design.id, x: 1 })).status).toBe(400);
    expect((await api("ada", `/boards/${board.id}/trash`, "POST", {})).status).toBe(400);
    expect((await api("ada", `/boards/${board.id}/restore`, "POST", { x: 1 })).status).toBe(400);
  });
  test("a non-deleter and a stranger get the same 403 body, on every route", async () => {
    for (const [path, method, body] of [[`/boards/${board.id}/trash`, "POST", { from: design.id }], [`/boards/${board.id}/restore`, "POST", {}], [`/spaces/${design.id}/trash`, "POST", {}], [`/spaces/${design.id}/restore`, "POST", {}], [`/boards/${board.id}/trash`, "GET"]]) {
      const a = await api("max", path, method, body), b = await api("max", path.replace(/b-[a-z0-9]+|s-[a-z0-9]+/, "x-nope"), method, body);
      expect([a.status, a.text]).toEqual([b.status, b.text]);
      expect(a.status).toBe(403);
    }
  });
  test("the notice, the list and the Space routes", async () => {
    expect((await api("ada", `/boards/${board.id}/trash`)).status).toBe(403);                 // live: not in Trash
    await api("ada", `/boards/${board.id}/trash`, "POST", { from: design.id });
    const n = await api("ada", `/boards/${board.id}/trash`);
    expect([n.status, n.json.canRestore, n.json.board.title]).toEqual([200, true, "Roadmap"]);
    const l = await api("ada", "/trash");
    expect([l.status, l.json.items.map(i => i.id)]).toEqual([200, [board.id]]);
    expect((await api("max", "/trash")).json.items).toEqual([]);
    const sp = await api("ada", `/spaces/${design.id}/trash`, "POST", {});
    expect([sp.status, sp.json.trashed, sp.json.boards]).toEqual([200, true, 0]);
    expect((await api("ada", `/spaces/${design.id}`)).status).toBe(404);
    expect((await api("ada", `/boards/${board.id}/restore`, "POST", {})).status).toBe(409);   // its Space is in Trash
    expect((await api("ada", `/spaces/${design.id}/restore`, "POST", {})).json.restored).toBe(true);
    expect((await api("ada", `/boards/${board.id}/restore`, "POST", {})).json.restored).toBe(true);
    expect((await api("ada", `/spaces/${design.id}`)).status).toBe(200);
  });
  test("a card's can.trash follows the `delete` permission", async () => {
    const p = JSON.parse((await api("ada", `/spaces/${design.id}`)).text);
    expect(p.boards.find(c => c.id === board.id).can.trash).toBe(true);
    expect(p.can.trash).toBe(true);
    await r.setScopedGrant({ scope: { type: "space", id: design.id }, subject: { type: "user", id: "dev:max" }, role: "editor" });
    const q = JSON.parse((await api("max", `/spaces/${design.id}`)).text);
    expect(q.boards.find(c => c.id === board.id).can.trash).toBe(false);
    expect(q.can.trash).toBe(false);
    const pp = JSON.parse((await api("ada", `/spaces/${(await r.ensurePersonalSpace(acme.id, "dev:ada")).id}`)).text);
    expect(pp.can.trash).toBe(false);                                                         // a personal Space is never trashed
  });
});
