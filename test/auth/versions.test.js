// Board version history & named snapshots (#19): domain service, HTTP routes, SQLite persistence, and web HTTP adapter.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRegistry } from "../../server/adapters/driven/auth/registry.js";
import { sqliteRegistry } from "../../server/adapters/driven/registry/sqlite.js";
import { tenancy as makeTenancy } from "../../server/core/auth/tenancy.js";
import { versionService, sanitizeVersionLabel, validateSnapshot } from "../../server/core/auth/versions.js";
import { httpRoutes } from "../../server/adapters/driving/auth-http.js";
import { sessions as makeSessions } from "../../server/adapters/driven/auth/session.js";
import { devAuth } from "../../server/adapters/driven/auth/dev.js";
import { httpVersions } from "../../web/adapters/versions/http.js";
import { mkBoard } from "./fixtures.js";

const dir = mkdtempSync(join(tmpdir(), "plenary-versions-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let dbSeq = 0;
const dbFile = () => join(dir, `v${++dbSeq}.db`);

const ORIGIN = "https://plenary.test";
const CONFIG = { cookieKey: "k".repeat(32), postLoginUrl: ORIGIN + "/", boardUrl: ORIGIN + "/b/{board}", publicUrl: ORIGIN };

async function setup(makeReg, opts = {}) {
  let t = 10_000;
  const now = () => (t += 100);
  const registry = makeReg({ now });
  const tenancy = makeTenancy({ registry, now });
  const tenantA = await registry.createTenant({ domain: "acme.com", admins: ["dev:admin"] });
  const tenantB = await registry.createTenant({ domain: "other.com", admins: ["dev:other"] });
  const privSpaceA = await registry.createSpace({ tenant: tenantA.id, name: "Private A", generalRole: null, owner: "dev:owner" });
  const boardA = await registry.createBoard({ tenant: tenantA.id, space: privSpaceA.id, title: "Alpha", owner: "dev:owner" });
  const boardA2 = await registry.createBoard({ tenant: tenantA.id, space: privSpaceA.id, title: "Beta", owner: "dev:owner" });
  const boardB = await mkBoard(registry, { tenant: tenantB.id, title: "Other", owner: "dev:other" });
  await registry.setGrant(boardA.id, "dev:editor", "editor");
  await registry.setGrant(boardA.id, "dev:annotator", "annotator");
  await registry.setGrant(boardA.id, "dev:commenter", "commenter");
  await registry.setGrant(boardA.id, "dev:viewer", "viewer");
  await registry.setGrant(boardA2.id, "dev:editor", "editor");

  const users = {
    owner: { user: "dev:owner", name: "Olivia Owner", email: "owner@acme.com", domain: "acme.com" },
    editor: { user: "dev:editor", name: "Eddie Editor", email: "editor@acme.com", domain: "acme.com" },
    annotator: { user: "dev:annotator", name: "Ann Annotator", email: "ann@acme.com", domain: "acme.com" },
    commenter: { user: "dev:commenter", name: "Cam Commenter", email: "cam@acme.com", domain: "acme.com" },
    viewer: { user: "dev:viewer", name: "Val Viewer", email: "val@acme.com", domain: "acme.com" },
    outsider: { user: "dev:outsider", name: "Out Sider", email: "out@acme.com", domain: "acme.com" },
    other: { user: "dev:other", name: "Other Tenant", email: "other@other.com", domain: "other.com" },
  };
  const service = versionService({ registry, tenancy, now, ...opts });
  return { registry, tenancy, tenantA, tenantB, boardA, boardA2, boardB, users, service, now };
}

describe("label & snapshot validation", () => {
  test("sanitizeVersionLabel trims, strips control/bidi chars, and enforces length <= 120", () => {
    expect(sanitizeVersionLabel("  Sprint 4\t\n\u202E  ")).toBe("Sprint 4");
    expect(sanitizeVersionLabel("x".repeat(120))).toBe("x".repeat(120));
    expect(() => sanitizeVersionLabel("")).toThrow(/label is required/);
    expect(() => sanitizeVersionLabel("   \n\t\u200F  ")).toThrow(/label is required/);
    expect(() => sanitizeVersionLabel("x".repeat(121))).toThrow(/at most 120/);
    expect(() => sanitizeVersionLabel(123)).toThrow(/must be a string/);
  });

  test("validateSnapshot validates shape, counts array or object elements, and enforces byte cap", () => {
    expect(validateSnapshot({ elements: [{ id: "1" }, { id: "2" }] }).elementCount).toBe(2);
    expect(validateSnapshot({ elements: { a: {}, b: {}, c: {} } }).elementCount).toBe(3);
    expect(validateSnapshot({ version: 1 }).elementCount).toBe(0);
    expect(() => validateSnapshot(null)).toThrow(/JSON object/);
    expect(() => validateSnapshot([])).toThrow(/JSON object/);
    expect(() => validateSnapshot({ elements: "nope" })).toThrow(/array or object/);
    expect(() => validateSnapshot({ data: "a".repeat(200) }, 100)).toThrow(/exceeds 100 bytes/);
  });
});

for (const [name, makeReg] of [
  ["memory", ({ now }) => memoryRegistry({ now })],
  ["sqlite", ({ now }) => sqliteRegistry({ path: dbFile(), now, fullfsync: false })],
]) {
  describe(`versionService (${name})`, () => {
    test("role enforcement: viewer+ list/get, editor+ create/delete, outsider/other-tenant/trashed forbidden", async () => {
      const { registry, boardA, boardB, users, service } = await setup(makeReg);
      try {
        // Viewer/commenter/annotator cannot create
        for (const u of [users.viewer, users.commenter, users.annotator, users.outsider, users.other]) {
          await expect(service.create(u, boardA.id, { label: "v1", snapshot: { elements: [] } })).rejects.toMatchObject({ code: "forbidden" });
        }
        // Editor and owner can create
        const c1 = await service.create(users.editor, boardA.id, { label: "Initial draft", snapshot: { elements: [{ id: "e1" }] } });
        const c2 = await service.create(users.owner, boardA.id, { label: "Final review", snapshot: { elements: [{ id: "e1" }, { id: "e2" }] } });
        expect(c1.version).toMatchObject({ label: "Initial draft", createdBy: "dev:editor", createdByName: "Eddie Editor", elementCount: 1 });
        expect("snapshot" in c1.version).toBe(false);
        expect("snapshotJson" in c1.version).toBe(false);

        // Viewer/commenter/annotator/editor/owner can list (newest first, no snapshot field) and get (with snapshot)
        for (const u of [users.viewer, users.commenter, users.annotator, users.editor, users.owner]) {
          const listed = await service.list(u, boardA.id);
          expect(listed.versions.map(v => v.id)).toEqual([c2.version.id, c1.version.id]);
          expect(listed.versions.every(v => !("snapshot" in v) && !("snapshotJson" in v))).toBe(true);
          const got = await service.get(u, boardA.id, c1.version.id);
          expect(got.version.snapshot).toEqual({ elements: [{ id: "e1" }] });
        }

        // Outsider / other tenant cannot list or get
        for (const u of [users.outsider, users.other]) {
          await expect(service.list(u, boardA.id)).rejects.toMatchObject({ code: "forbidden" });
          await expect(service.get(u, boardA.id, c1.version.id)).rejects.toMatchObject({ code: "forbidden" });
        }
        // Unknown board -> forbidden
        await expect(service.list(users.owner, "b-missing")).rejects.toMatchObject({ code: "forbidden" });

        // Viewer/commenter/annotator cannot delete
        for (const u of [users.viewer, users.commenter, users.annotator, users.outsider, users.other]) {
          await expect(service.remove(u, boardA.id, c1.version.id)).rejects.toMatchObject({ code: "forbidden" });
        }
        // Editor can delete
        expect(await service.remove(users.editor, boardA.id, c1.version.id)).toBe(true);
        await expect(service.get(users.owner, boardA.id, c1.version.id)).rejects.toMatchObject({ code: "not-found" });
        await expect(service.remove(users.owner, boardA.id, c1.version.id)).rejects.toMatchObject({ code: "not-found" });

        // Trashed board -> forbidden for all operations, and registry rejects createBoardVersion atomically with code "in-trash"
        await registry.trashBoard({ board: boardA.id, from: boardA.space, by: users.owner.user });
        await expect(registry.createBoardVersion({
          tenantId: boardA.tenant,
          boardId: boardA.id,
          label: "raced",
          createdBy: users.owner.user,
          elementCount: 0,
          snapshotJson: "{}",
        })).rejects.toMatchObject({ code: "in-trash" });
        await expect(service.list(users.owner, boardA.id)).rejects.toMatchObject({ code: "forbidden" });
        await expect(service.get(users.owner, boardA.id, c2.version.id)).rejects.toMatchObject({ code: "forbidden" });
        await expect(service.create(users.owner, boardA.id, { label: "x", snapshot: {} })).rejects.toMatchObject({ code: "forbidden" });
        await expect(service.remove(users.owner, boardA.id, c2.version.id)).rejects.toMatchObject({ code: "forbidden" });

        // Other tenant's board still works independently
        const ob = await service.create(users.other, boardB.id, { label: "Other v1", snapshot: { elements: [] } });
        expect(ob.version.label).toBe("Other v1");
      } finally { await registry.close(); }
    });

    test("cross-board isolation: versionId from boardA cannot be fetched or deleted via boardA2", async () => {
      const { registry, boardA, boardA2, users, service } = await setup(makeReg);
      try {
        const { version } = await service.create(users.owner, boardA.id, { label: "Only A", snapshot: { elements: [{ id: "1" }] } });
        await expect(service.get(users.owner, boardA2.id, version.id)).rejects.toMatchObject({ code: "not-found" });
        await expect(service.remove(users.owner, boardA2.id, version.id)).rejects.toMatchObject({ code: "not-found" });
        expect((await service.get(users.owner, boardA.id, version.id)).version.id).toBe(version.id);
      } finally { await registry.close(); }
    });

    test("enforces maxPerBoard cap and allows new version after delete", async () => {
      const { registry, boardA, users, service } = await setup(makeReg, { maxPerBoard: 3 });
      try {
        const v1 = await service.create(users.editor, boardA.id, { label: "v1", snapshot: { elements: [] } });
        await service.create(users.editor, boardA.id, { label: "v2", snapshot: { elements: [] } });
        await service.create(users.editor, boardA.id, { label: "v3", snapshot: { elements: [] } });
        await expect(service.create(users.editor, boardA.id, { label: "v4", snapshot: { elements: [] } })).rejects.toMatchObject({ code: "limit" });
        await service.remove(users.editor, boardA.id, v1.version.id);
        const v4 = await service.create(users.editor, boardA.id, { label: "v4", snapshot: { elements: [] } });
        expect(v4.version.label).toBe("v4");
      } finally { await registry.close(); }
    });
  });
}

describe("HTTP routes & web/adapters/versions/http.js", () => {
  async function httpSetup() {
    let t = 50_000;
    const now = () => (t += 100);
    const registry = sqliteRegistry({ path: dbFile(), now, fullfsync: false });
    const tenancy = makeTenancy({ registry, now });
    const acme = await registry.createTenant({ domain: "acme.com", admins: ["dev:admin"] });
    const board = await mkBoard(registry, { tenant: acme.id, title: "Design", owner: "dev:owner" });
    await registry.setGrant(board.id, "dev:editor", "editor");
    await registry.setGrant(board.id, "dev:viewer", "viewer");
    const dev = devAuth({
      enabled: true,
      tokens: {
        owner: { name: "owner", domain: "acme.com", email: "owner@acme.com" },
        editor: { name: "editor", domain: "acme.com", email: "editor@acme.com" },
        viewer: { name: "viewer", domain: "acme.com", email: "viewer@acme.com" },
        outsider: { name: "outsider", domain: "acme.com", email: "out@acme.com" },
      },
    });
    const handler = httpRoutes({
      registry,
      sessions: await makeSessions({ key: "s".repeat(32) }),
      tenancy,
      dev,
      now,
      config: CONFIG,
      log: { warn() {} },
    });
    const call = (method, path, token, body) => handler(new Request(ORIGIN + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    }));
    return { registry, board, handler, call };
  }

  test("full CRUD lifecycle, large (>16KB) snapshot, 413 cap, 429 cap, and auth/role codes", async () => {
    const { registry, board, call } = await httpSetup();
    try {
      // Unauthenticated -> 401
      expect((await call("GET", `/boards/${board.id}/versions`, null)).status).toBe(401);

      // Viewer cannot create -> 403
      expect((await call("POST", `/boards/${board.id}/versions`, "viewer", { label: "nope", snapshot: { elements: [] } })).status).toBe(403);

      // Large snapshot (> 16 KB default maxBody, under 2 MB cap) succeeds!
      const bigText = "x".repeat(40_000);
      const created = await call("POST", `/boards/${board.id}/versions`, "editor", {
        label: "Milestone 1",
        snapshot: { elements: [{ id: "big", text: bigText }] },
      });
      expect(created.status).toBe(201);
      const { version } = await created.json();
      expect(version).toMatchObject({ label: "Milestone 1", createdBy: "dev:editor", elementCount: 1 });
      expect(version.snapshot).toBeUndefined();

      // Viewer lists (metadata only) and fetches full snapshot
      const listed = await call("GET", `/boards/${board.id}/versions`, "viewer");
      expect(listed.status).toBe(200);
      const listBody = await listed.json();
      expect(listBody.versions).toHaveLength(1);
      expect(listBody.versions[0].snapshot).toBeUndefined();

      const fetched = await call("GET", `/boards/${board.id}/versions/${version.id}`, "viewer");
      expect(fetched.status).toBe(200);
      expect((await fetched.json()).version.snapshot.elements[0].text.length).toBe(40_000);

      // Payload > 2 MB -> 413 too-large
      const huge = await call("POST", `/boards/${board.id}/versions`, "editor", {
        label: "Too big",
        snapshot: { elements: [{ id: "h", text: "z".repeat(2 * 1024 * 1024 + 50) }] },
      });
      expect(huge.status).toBe(413);
      expect(await huge.json()).toEqual({ error: "too-large" });

      // Bad label / unknown field -> 400
      expect((await call("POST", `/boards/${board.id}/versions`, "editor", { label: "   ", snapshot: {} })).status).toBe(400);
      expect((await call("POST", `/boards/${board.id}/versions`, "editor", { label: "ok", snapshot: {}, extra: 1 })).status).toBe(400);

      // Viewer cannot delete -> 403; editor deletes -> 204
      expect((await call("DELETE", `/boards/${board.id}/versions/${version.id}`, "viewer")).status).toBe(403);
      expect((await call("DELETE", `/boards/${board.id}/versions/${version.id}`, "editor")).status).toBe(204);
      expect((await call("GET", `/boards/${board.id}/versions/${version.id}`, "viewer")).status).toBe(404);
    } finally { await registry.close(); }
  });

  test("web/adapters/versions/http.js works end-to-end against httpRoutes and maps errors cleanly", async () => {
    const { registry, board, handler } = await httpSetup();
    try {
      const fetchVia = (url, init) => handler(new Request(url, init));
      const editorApi = httpVersions({ fetch: fetchVia, token: "editor", base: ORIGIN });
      const viewerApi = httpVersions({ fetch: fetchVia, token: "viewer", base: ORIGIN });

      const c = await editorApi.create(board.id, { label: "Adapter snap", snapshot: { elements: [{ id: "a" }] } });
      expect("version" in c && c.version.label).toBe("Adapter snap");
      const vid = /** @type {any} */ (c).version.id;

      const l = await viewerApi.list(board.id);
      expect("versions" in l && l.versions).toHaveLength(1);

      const g = await viewerApi.get(board.id, vid);
      expect("version" in g && g.version.snapshot).toEqual({ elements: [{ id: "a" }] });

      expect(await viewerApi.remove(board.id, vid)).toEqual({ error: "forbidden" });
      expect(await editorApi.remove(board.id, vid)).toEqual({ ok: true });
      expect(await viewerApi.get(board.id, vid)).toEqual({ error: "notfound" });

      // Error mapping for network failure, 401, 413, 429, 500
      const netFail = httpVersions({ fetch: async () => { throw new Error("offline"); }, token: "t", base: ORIGIN });
      expect(await netFail.list(board.id)).toEqual({ error: "network" });
      const statusApi = status => httpVersions({
        fetch: async () => new Response(JSON.stringify({ error: "x" }), { status }),
        token: "t",
        base: ORIGIN,
      });
      expect(await statusApi(401).list(board.id)).toEqual({ error: "auth" });
      expect(await statusApi(413).create(board.id, { label: "x", snapshot: {} })).toEqual({ error: "too-large" });
      expect(await statusApi(429).create(board.id, { label: "x", snapshot: {} })).toEqual({ error: "limit" });
      expect(await statusApi(500).list(board.id)).toEqual({ error: "unavailable" });
      expect(await editorApi.list("../bad")).toEqual({ error: "forbidden" });
    } finally { await registry.close(); }
  });
});
