// HTTP & announcingRegistry tests for board lifecycle: PATCH /boards/:board and DELETE /boards/:board.
import { describe, test, expect, beforeEach } from "bun:test";
import { httpRoutes } from "../../server/adapters/driving/auth-http.js";
import { sessions as makeSessions } from "../../server/adapters/driven/auth/session.js";
import { memoryRegistry } from "../../server/adapters/driven/auth/registry.js";
import { tenancy as makeTenancy, roleCache, identityKey } from "../../server/core/auth/tenancy.js";
import { memoryBus } from "../../server/adapters/driven/bus/memory.js";
import { subjects } from "../../server/ports/bus.js";
import { announcingRegistry } from "../../server/main.js";

const ORIGIN = "https://plenary.test";
const config = {
  postLoginUrl: ORIGIN + "/",
  boardUrl: ORIGIN + "/b/{board}",
  publicUrl: ORIGIN,
};

describe("Board lifecycle: PATCH /boards/:board and DELETE /boards/:board", () => {
  let clock, rawRegistry, bus, registry, sessions, tenancy, routes, acme;
  let ownerTok, editorTok, viewerTok, strangerTok, nonOwnerAdminTok;
  let announced;

  const api = (path, token, method = "GET", body) => routes(new Request(ORIGIN + path, {
    method,
    headers: {
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));

  beforeEach(async () => {
    clock = { t: Date.UTC(2026, 10, 22, 12) };
    const now = () => clock.t;
    rawRegistry = memoryRegistry({ now });
    bus = memoryBus();
    const log = { warn() {}, error() {}, info() {}, debug() {} };
    registry = announcingRegistry(rawRegistry, bus, log);
    sessions = await makeSessions({ key: "s".repeat(32), now });
    tenancy = makeTenancy({ registry, now });
    acme = await registry.createTenant({ domain: "acme.com", admins: ["google:owner", "google:otheradmin"] });
    routes = httpRoutes({ registry, sessions, oidc: null, tenancy, now, config });

    ownerTok = await sessions.issue({ user: "google:owner", name: "Owner", email: "owner@acme.com", domain: "acme.com" });
    editorTok = await sessions.issue({ user: "google:editor", name: "Editor", email: "editor@acme.com", domain: "acme.com" });
    viewerTok = await sessions.issue({ user: "google:viewer", name: "Viewer", email: "viewer@acme.com", domain: "acme.com" });
    strangerTok = await sessions.issue({ user: "google:stranger", name: "Stranger", email: "stranger@other.com", domain: "other.com" });
    nonOwnerAdminTok = await sessions.issue({ user: "google:otheradmin", name: "OtherAdmin", email: "otheradmin@acme.com", domain: "acme.com" });
    announced = [];
  });

  async function makeBoard(title = "Original", memberRole = "viewer") {
    const res = await api("/boards", ownerTok, "POST", { title, memberRole });
    expect(res.status).toBe(201);
    const { board } = await res.json();
    await registry.setGrant(board.id, "google:editor", "editor");
    await registry.setGrant(board.id, "google:viewer", "viewer");
    await bus.subscribe(subjects.grants(acme.id, board.id), msg => announced.push(msg));
    announced.length = 0;
    return board;
  }

  test("PATCH /boards/:board: owner updates title and memberRole, logs board.update, announces only on memberRole change", async () => {
    const board = await makeBoard("Old Title", "viewer");

    // Title-only rename succeeds and does NOT announce grants invalidation
    const r1 = await api(`/boards/${board.id}`, ownerTok, "PATCH", { title: "  New Title  " });
    expect(r1.status).toBe(200);
    expect((await r1.json()).board).toMatchObject({ id: board.id, title: "New Title", memberRole: "viewer" });
    expect(announced).toEqual([]);

    // memberRole change succeeds and DOES announce { board }
    const r2 = await api(`/boards/${board.id}`, ownerTok, "PATCH", { memberRole: "editor" });
    expect(r2.status).toBe(200);
    expect((await r2.json()).board).toMatchObject({ id: board.id, title: "New Title", memberRole: "editor" });
    expect(announced).toEqual([{ board: board.id }]);

    // memberRole: "none" normalizes to null and announces { board }
    const r3 = await api(`/boards/${board.id}`, ownerTok, "PATCH", { memberRole: "none" });
    expect(r3.status).toBe(200);
    expect((await r3.json()).board).toMatchObject({ id: board.id, memberRole: null });
    expect(announced).toEqual([{ board: board.id }, { board: board.id }]);

    // Audit log recorded board.update events
    const auditRes = await api(`/boards/${board.id}/audit`, ownerTok);
    expect(auditRes.status).toBe(200);
    const { events } = await auditRes.json();
    const updates = events.filter(e => e.action === "board.update");
    expect(updates.length).toBe(3);
    expect(updates[0].detail).toEqual({ title: "New Title", memberRole: null });

    // Compound ZWJ emoji titles are accepted (L1)
    const r4 = await api(`/boards/${board.id}`, ownerTok, "PATCH", { title: "🚀 Launch 👨‍👩‍👧‍👦" });
    expect(r4.status).toBe(200);
    expect((await r4.json()).board.title).toBe("🚀 Launch 👨‍👩‍👧‍👦");
  });

  test("PATCH /boards/:board: guest owner can rename but cannot change memberRole (M3)", async () => {
    const board = await makeBoard("Guest Owned", null);
    await registry.setGrant(board.id, "google:stranger", "owner");

    // Guest owner can rename
    const rTitle = await api(`/boards/${board.id}`, strangerTok, "PATCH", { title: "Guest Renamed" });
    expect(rTitle.status).toBe(200);
    expect((await rTitle.json()).board.title).toBe("Guest Renamed");

    // Guest owner CANNOT change memberRole (tenant admin required)
    const rRole = await api(`/boards/${board.id}`, strangerTok, "PATCH", { memberRole: "editor" });
    expect(rRole.status).toBe(403);
    expect((await registry.board(board.id)).memberRole).toBe(null);
  });

  test("roleCache.invalidate drops cached board record on memberRole change and deleteBoard (H1)", async () => {
    const board = await makeBoard("Cached Board", "editor");
    const cache = roleCache({ registry: rawRegistry, now: () => clock.t });
    const member = { user: "google:member", email: "member@acme.com", domain: "acme.com" };
    const mk = identityKey(member);

    // Warm the cache: Workspace member gets memberRole "editor"
    expect(await cache.role(member, board.id)).toBe("editor");
    expect((await cache.rolesFor(board.id, [member])).get(mk)).toBe("editor");

    // Lower memberRole to null + invalidate(board) -> immediately revoked (not stale for 10 min)
    await rawRegistry.updateBoard(board.id, { memberRole: null });
    cache.invalidate(board.id);
    expect(await cache.role(member, board.id)).toBe(null);
    expect((await cache.rolesFor(board.id, [member])).get(mk)).toBe(null);

    // Raise back to viewer, warm cache again, then deleteBoard + invalidate(board) -> immediately revoked
    await rawRegistry.updateBoard(board.id, { memberRole: "viewer" });
    cache.invalidate(board.id);
    expect(await cache.role(member, board.id)).toBe("viewer");

    await rawRegistry.deleteBoard(board.id);
    cache.invalidate(board.id);
    expect(await cache.role(member, board.id)).toBe(null);
    expect((await cache.rolesFor(board.id, [member])).get(mk)).toBe(null);
  });

  test("PATCH /boards/:board: non-owners and unknown boards get 403; invalid payloads get 400", async () => {
    const board = await makeBoard();

    // Users without board.edit (viewer, stranger, non-owner tenant admin without content tier) -> 403
    for (const tok of [viewerTok, strangerTok, nonOwnerAdminTok]) {
      const r = await api(`/boards/${board.id}`, tok, "PATCH", { title: "Hacked" });
      expect(r.status).toBe(403);
    }
    // Unknown board -> 403
    expect((await api("/boards/b-nope000000000000", ownerTok, "PATCH", { title: "Ghost" })).status).toBe(403);

    // Invalid payloads -> 400
    expect((await api(`/boards/${board.id}`, ownerTok, "PATCH", {})).status).toBe(400);
    expect((await api(`/boards/${board.id}`, ownerTok, "PATCH", { title: "Ok", bogus: 1 })).status).toBe(400);
    expect((await api(`/boards/${board.id}`, ownerTok, "PATCH", { title: "a".repeat(201) })).status).toBe(400);
    expect((await api(`/boards/${board.id}`, ownerTok, "PATCH", { title: "bad\u0007bell" })).status).toBe(400);
    expect((await api(`/boards/${board.id}`, ownerTok, "PATCH", { title: "bidi\u202Eoverride" })).status).toBe(400);
    expect((await api(`/boards/${board.id}`, ownerTok, "PATCH", { memberRole: "owner" })).status).toBe(400);
    expect((await api(`/boards/${board.id}`, ownerTok, "PATCH", { memberRole: "invalid" })).status).toBe(400);
    expect((await api(`/boards/${board.id}`, ownerTok, "PATCH", { title: 42 })).status).toBe(400);
  });

  test("DELETE /boards/:board: owner gets 204, non-owners get 403, audit preserved, board gone, announces invalidation", async () => {
    const board = await makeBoard("Temp Board", "viewer");
    const invRes = await api(`/boards/${board.id}/invites`, ownerTok, "POST", { email: "bob@globex.com", role: "viewer" });
    expect(invRes.status).toBe(201);
    const lnkRes = await api(`/boards/${board.id}/links`, ownerTok, "POST", { role: "viewer" });
    expect(lnkRes.status).toBe(201);
    announced.length = 0;

    // Non-owners -> 403
    for (const tok of [editorTok, viewerTok, strangerTok, nonOwnerAdminTok]) {
      expect((await api(`/boards/${board.id}`, tok, "DELETE")).status).toBe(403);
    }
    expect((await api("/boards/b-nope000000000000", ownerTok, "DELETE")).status).toBe(403);
    expect(announced).toEqual([]);

    // Owner deletes -> 204
    const del = await api(`/boards/${board.id}`, ownerTok, "DELETE");
    expect(del.status).toBe(204);

    // Grants invalidation announced so live WebSockets disconnect cleanly
    expect(announced).toEqual([{ board: board.id }]);

    // Board is gone from registry, GET /boards, and subsequent board routes
    expect(await registry.board(board.id)).toBe(null);
    const listRes = await api("/boards", ownerTok);
    expect((await listRes.json()).boards.some(b => b.id === board.id)).toBe(false);
    expect((await api(`/boards/${board.id}`, ownerTok, "PATCH", { title: "After" })).status).toBe(403);
    expect((await api(`/boards/${board.id}/invites`, ownerTok)).status).toBe(403);
    expect((await api(`/boards/${board.id}`, ownerTok, "DELETE")).status).toBe(403);

    // board.delete audit event is preserved in reg_audit (visible in tenant audit log)
    const auditRes = await api(`/admin/audit?board=${encodeURIComponent(board.id)}`, ownerTok);
    expect(auditRes.status).toBe(200);
    const { events } = await auditRes.json();
    expect(events.some(e => e.action === "board.delete" && e.board === board.id && e.detail?.title === "Temp Board")).toBe(true);
    expect(events.some(e => e.action === "board.create" && e.board === board.id)).toBe(true);
  });
});
