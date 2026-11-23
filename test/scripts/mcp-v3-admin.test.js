// Tests for Wave 12B — Plenary MCP Server v0.3.0 & CLI v3 (Admin, Versions, Moderation, Share Policy & Compliance).
// Covers:
//   1. Unit tests: validation, passcode non-leakage, GDPR confirm:true guard, CLI v3 parsing/dispatch, MCP v3 schema/dispatch.
//   2. Live E2E tests against a real Plenary server (HTTP Admin API + Home + Spaces + Versions + Compliance + Protocol v1.1 WS).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "../../server/adapters/driving/server.js";
import { sqliteStore } from "../../server/adapters/driven/store/sqlite.js";
import { sqliteRegistry } from "../../server/adapters/driven/registry/sqlite.js";
import { memoryBus } from "../../server/adapters/driven/bus/memory.js";
import { devAuth } from "../../server/adapters/driven/auth/dev.js";
import { authPort } from "../../server/ports/auth.js";
import { tenancy as makeTenancy } from "../../server/core/auth/tenancy.js";
import { homeService } from "../../server/core/auth/home.js";
import { httpRoutes } from "../../server/adapters/driving/auth-http.js";

import { createPlenaryClient, PlenaryError } from "../../scripts/plenary-client.js";
import { parseCliArgs, runCli } from "../../scripts/plenary-cli.js";
import { createMcpHandler, TOOLS, SERVER_INFO } from "../../scripts/plenary-mcp.js";

// ── Unit tests: client validators, security guards, CLI v3 & MCP v3 ─────────

describe("plenary-client v3 validation & safety guards", () => {
  const client = createPlenaryClient({ url: "http://127.0.0.1:1", token: "tok" });

  test("createShareLink validates passcode length (4..128) and noDownload without leaking passcode", async () => {
    const tooShort = "abc";
    const tooLong = "p".repeat(129);
    for (const bad of [tooShort, tooLong, 1234]) {
      let caught;
      try {
        await client.createShareLink({ board: "b1", role: "viewer", passcode: /** @type {any} */ (bad) });
      } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(PlenaryError);
      expect(caught.code).toBe("bad-request");
      expect(caught.message).not.toContain(String(bad));
    }

    await expect(client.createShareLink({
      board: "b1",
      role: "viewer",
      noDownload: /** @type {any} */ ("yes"),
    })).rejects.toMatchObject({ code: "bad-request" });
  });

  test("setModeration validates inputs against packages/protocol/moderation.js", async () => {
    await expect(client.setModeration({ board: "b1" })).rejects.toMatchObject({ code: "bad-request" });
    await expect(client.setModeration({ board: "b1", locked: /** @type {any} */ ("true") }))
      .rejects.toMatchObject({ code: "bad-request" });
    await expect(client.setModeration({ board: "b1", mutedUsers: ["dev:bob", "dev:bob"] }))
      .rejects.toMatchObject({ code: "bad-request" });
    await expect(client.setModeration({ board: "b1", mutedUsers: [""] }))
      .rejects.toMatchObject({ code: "bad-request" });
    await expect(client.setModeration({
      board: "b1",
      mutedUsers: Array.from({ length: 201 }, (_, i) => `dev:u${i}`),
    })).rejects.toMatchObject({ code: "bad-request" });
  });

  test("gdprEraseUser strictly requires explicit confirm: true boolean before any HTTP call", async () => {
    for (const badConfirm of [undefined, false, null, "true", 1]) {
      await expect(client.gdprEraseUser({
        userId: "dev:bob",
        confirm: /** @type {any} */ (badConfirm),
      })).rejects.toMatchObject({ code: "confirm-required" });
    }
    await expect(client.gdprEraseUser({ userId: "email:bob@acme.test", confirm: true }))
      .rejects.toMatchObject({ code: "bad-request" });
    await expect(client.gdprEraseUser({ userId: "", confirm: true }))
      .rejects.toMatchObject({ code: "bad-request" });
  });

  test("manageVersions, manageSpaces, manageOrg, and exportComplianceData reject invalid inputs", async () => {
    await expect(client.manageVersions({ board: "b1", action: "bogus" })).rejects.toMatchObject({ code: "bad-request" });
    await expect(client.manageVersions({ board: "b1", action: "create", label: "   " })).rejects.toMatchObject({ code: "bad-request" });
    await expect(client.manageVersions({ board: "b1", action: "get", versionId: "../x" })).rejects.toMatchObject({ code: "bad-request" });
    await expect(client.manageSpaces({ action: "bogus" })).rejects.toMatchObject({ code: "bad-request" });
    await expect(client.manageSpaces({ action: "create_area", name: "" })).rejects.toMatchObject({ code: "bad-request" });
    await expect(client.manageSpaces({ action: "create_space", name: "S", general: "owner" })).rejects.toMatchObject({ code: "bad-request" });
    await expect(client.manageOrg({ action: "bogus" })).rejects.toMatchObject({ code: "bad-request" });
    await expect(client.manageOrg({ action: "add_member", tenant: "t1", email: "not-an-email" })).rejects.toMatchObject({ code: "bad-request" });
    await expect(client.exportComplianceData({ scope: "board" })).rejects.toMatchObject({ code: "bad-request" });
    await expect(client.exportComplianceData({ scope: "other" })).rejects.toMatchObject({ code: "bad-request" });
  });
});

describe("CLI v3 argument parsing & dispatch", () => {
  test("parses all 6 new v0.3 commands (kebab-case and snake_case)", () => {
    const pairs = [
      ["set-moderation", "set_moderation"],
      ["manage-versions", "manage_versions"],
      ["manage-spaces", "manage_spaces"],
      ["manage-org", "manage_org"],
      ["export-compliance-data", "export_compliance_data"],
      ["gdpr-erase-user", "gdpr_erase_user"],
    ];
    for (const [kebab, snake] of pairs) {
      expect(parseCliArgs([kebab]).command).toBe(snake);
      expect(parseCliArgs([snake]).command).toBe(snake);
    }
  });

  test("runCli dispatches all v3 commands and never leaks share-link passcode to stderr", async () => {
    /** @type {Array<{ fn: string, args: any }>} */
    const calls = [];
    const mockClient = {
      createShareLink: async a => { calls.push({ fn: "createShareLink", args: a }); return { ok: true }; },
      setModeration: async a => { calls.push({ fn: "setModeration", args: a }); return { ok: true }; },
      manageVersions: async a => { calls.push({ fn: "manageVersions", args: a }); return { ok: true }; },
      manageSpaces: async a => { calls.push({ fn: "manageSpaces", args: a }); return { ok: true }; },
      manageOrg: async a => { calls.push({ fn: "manageOrg", args: a }); return { ok: true }; },
      exportComplianceData: async a => { calls.push({ fn: "exportComplianceData", args: a }); return { ok: true }; },
      gdprEraseUser: async a => { calls.push({ fn: "gdprEraseUser", args: a }); return { ok: true }; },
    };
    const env = { PLENARY_URL: "http://127.0.0.1:1", PLENARY_TOKEN: "tok" };
    const run = argv => runCli(argv, env, { out: () => {}, err: () => {}, clientFactory: () => mockClient });

    expect(await run(["create-share-link", "--board", "b1", "--role", "viewer", "--passcode", "s3cr3t!", "--no-download"])).toBe(0);
    expect(await run(["set-moderation", "--board", "b1", "--locked", "true", "--muted-users", "dev:bob,dev:carol"])).toBe(0);
    expect(await run(["manage-versions", "--board", "b1", "--action", "create", "--label", "Release v1"])).toBe(0);
    expect(await run(["manage-spaces", "--action", "create_space", "--name", "Eng", "--group", "g1", "--general", "editor"])).toBe(0);
    expect(await run(["manage-org", "--action", "add_member", "--tenant-id", "t1", "--email", "alice@acme.test"])).toBe(0);
    expect(await run(["export-compliance-data", "--scope", "board", "--board", "b1"])).toBe(0);
    expect(await run(["gdpr-erase-user", "--user-id", "dev:bob", "--confirm", "--tenant-id", "t1"])).toBe(0);

    expect(calls).toEqual([
      { fn: "createShareLink", args: { board: "b1", role: "viewer", passcode: "s3cr3t!", noDownload: true } },
      { fn: "setModeration", args: { board: "b1", locked: true, mutedUsers: ["dev:bob", "dev:carol"] } },
      { fn: "manageVersions", args: { board: "b1", action: "create", label: "Release v1" } },
      { fn: "manageSpaces", args: { action: "create_space", name: "Eng", group: "g1", general: "editor" } },
      { fn: "manageOrg", args: { action: "add_member", tenant: "t1", email: "alice@acme.test" } },
      { fn: "exportComplianceData", args: { scope: "board", board: "b1" } },
      { fn: "gdprEraseUser", args: { userId: "dev:bob", confirm: true, tenant: "t1" } },
    ]);

    // Verify `--confirm false` cannot accidentally authorize GDPR erasure (rejected as usage error, exit 2)
    let calledOnConfirmFalse = false;
    const codeConfirmFalse = await runCli(
      ["gdpr-erase-user", "--user-id", "dev:bob", "--confirm", "false"],
      env,
      {
        out: () => {},
        err: () => {},
        clientFactory: () => ({
          gdprEraseUser: async () => { calledOnConfirmFalse = true; return { ok: true }; },
        }),
      },
    );
    expect(codeConfirmFalse).toBe(2);
    expect(calledOnConfirmFalse).toBe(false);

    // Verify invalid passcode error via real client never prints passcode to stderr
    const errLines = [];
    const code = await runCli(
      ["create-share-link", "--board", "b1", "--passcode", "xy"],
      env,
      { out: () => {}, err: s => errLines.push(s) },
    );
    expect(code).toBe(1);
    expect(errLines.join("\n")).not.toContain("xy");
  });
});

describe("MCP v0.3.0 handler", () => {
  test("exposes 22 tools at version 0.3.0 and enforces gdpr_erase_user confirm:true via JSON-RPC", async () => {
    expect(SERVER_INFO.version).toBe("0.3.0");
    expect(TOOLS.length).toBe(22);

    const names = new Set(TOOLS.map(t => t.name));
    for (const expected of [
      "set_moderation",
      "manage_versions",
      "manage_spaces",
      "manage_org",
      "export_compliance_data",
      "gdpr_erase_user",
    ]) {
      expect(names.has(expected)).toBe(true);
    }

    const shareTool = TOOLS.find(t => t.name === "create_share_link");
    expect(shareTool.inputSchema.properties.passcode).toBeDefined();
    expect(shareTool.inputSchema.properties.noDownload).toBeDefined();

    const realClient = createPlenaryClient({ url: "http://127.0.0.1:1", token: "tok" });
    const handle = createMcpHandler({ clientFactory: () => realClient });

    const blocked = await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "gdpr_erase_user", arguments: { userId: "dev:bob", confirm: false } },
    });
    expect(blocked.result.isError).toBe(true);
    expect(JSON.parse(blocked.result.content[0].text).code).toBe("confirm-required");
  });
});

// ── Live E2E tests against real Plenary server ───────────────────────────────

describe("live E2E: MCP v0.3.0 admin, versions, moderation, share policy & compliance", () => {
  const ADMIN_TOKEN = "mcp-v3-admin-token";
  const BOB_TOKEN = "mcp-v3-bob-token";
  let dir, store, registry, bus, server, tenant, boardId;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "plenary-mcp-v3-"));
    store = sqliteStore({ path: join(dir, "plenary.db") });
    registry = sqliteRegistry({ path: join(dir, "registry.db") });
    bus = memoryBus();

    tenant = await registry.createTenant({ domain: "acme.test", admins: ["dev:admin"] });
    const dev = devAuth({
      enabled: true,
      tokens: {
        [ADMIN_TOKEN]: { name: "admin", email: "admin@acme.test", domain: "acme.test" },
        [BOB_TOKEN]: { name: "bob", email: "bob@acme.test", domain: "acme.test" },
      },
    });
    const ten = makeTenancy({ registry });
    const home = homeService({ registry, tenancy: ten });
    const auth = authPort({ dev, tenancy: ten });
    const sessions = { async issue() { return ""; }, async verify() { return null; } };

    let httpHandler = null;
    server = createServer({
      auth,
      registry,
      store,
      bus,
      port: 0,
      static: false,
      http: (req, url) => httpHandler(req, url),
    });
    httpHandler = httpRoutes({
      registry,
      sessions,
      tenancy: ten,
      home,
      dev,
      config: {
        postLoginUrl: `${server.url}/`,
        boardUrl: `${server.url}/?board={board}`,
        publicUrl: server.url,
      },
    });

    // Touch Bob in the member directory so he exists in the tenant for GDPR erasure testing
    await registry.touchMember(tenant.id, { user: "dev:bob", name: "Bob", email: "bob@acme.test", domain: "acme.test" });

    const client = createPlenaryClient({ url: server.url, token: ADMIN_TOKEN });
    const created = await client.createBoard({ title: "MCP v3 E2E Board", memberRole: "editor" });
    boardId = created.board.id;
  });

  afterAll(async () => {
    if (server) await server.stop();
    if (bus) await bus.close();
    if (store) await store.close();
    if (registry) await registry.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("#37 Share Link Policy: passcode & noDownload enforced end-to-end", async () => {
    const client = createPlenaryClient({ url: server.url, token: ADMIN_TOKEN });
    const created = await client.createShareLink({
      board: boardId,
      role: "viewer",
      passcode: "top-secret-42",
      noDownload: true,
    });
    expect(created.link.hasPasscode).toBe(true);
    expect(created.link.noDownload).toBe(true);
    expect(created.link.passcode).toBeUndefined();
    expect(created.url).toContain(`/links/${created.link.id}`);

    // Redeeming without passcode -> 401 passcode-required
    const resNoPass = await fetch(`${server.url}/links/${encodeURIComponent(created.link.id)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOB_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(resNoPass.status).toBe(401);
    expect((await resNoPass.json()).error).toBe("passcode-required");

    // Redeeming with wrong passcode -> 403 bad-passcode
    const resBadPass = await fetch(`${server.url}/links/${encodeURIComponent(created.link.id)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOB_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ passcode: "wrong-pass" }),
    });
    expect(resBadPass.status).toBe(403);
    expect((await resBadPass.json()).error).toBe("bad-passcode");

    // Redeeming with correct passcode -> 200 { board, url, noDownload: true }
    const resOk = await fetch(`${server.url}/links/${encodeURIComponent(created.link.id)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOB_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ passcode: "top-secret-42" }),
    });
    expect(resOk.status).toBe(200);
    const redeemed = await resOk.json();
    expect(redeemed.board).toBe(boardId);
    expect(redeemed.noDownload).toBe(true);
  });

  test("#33 All-Hands Moderation: set_moderation updates appState.herdr.moderation over WS", async () => {
    const client = createPlenaryClient({ url: server.url, token: ADMIN_TOKEN });

    const r1 = await client.setModeration({ board: boardId, locked: true, mutedUsers: ["dev:bob"] });
    expect(r1.moderation).toEqual({ locked: true, mutedUsers: ["dev:bob"] });

    const s1 = await client.readBoard({ board: boardId });
    expect(s1.appState.moderation).toEqual({ locked: true, mutedUsers: ["dev:bob"] });

    // Partial update: unlock while preserving mutedUsers
    const r2 = await client.setModeration({ board: boardId, locked: false });
    expect(r2.moderation).toEqual({ locked: false, mutedUsers: ["dev:bob"] });

    // Clear mutedUsers
    const r3 = await client.setModeration({ board: boardId, mutedUsers: [] });
    expect(r3.moderation).toEqual({ locked: false, mutedUsers: [] });
  });

  test("#19 Version History: manage_versions create (auto-captures scene), list, get, delete", async () => {
    const client = createPlenaryClient({ url: server.url, token: ADMIN_TOKEN });

    await client.addElements({
      board: boardId,
      elements: [{ id: "v-rect-1", type: "rectangle", x: 10, y: 20, width: 120, height: 60 }],
    });

    const created = await client.manageVersions({ board: boardId, action: "create", label: "Milestone 1" });
    expect(created.version.label).toBe("Milestone 1");
    expect(created.version.elementCount).toBe(1);
    const versionId = created.version.id;

    const listed = await client.manageVersions({ board: boardId, action: "list" });
    expect(listed.versions.length).toBe(1);
    expect(listed.versions[0].id).toBe(versionId);

    const fetched = await client.manageVersions({ board: boardId, action: "get", versionId });
    expect(fetched.version.id).toBe(versionId);
    expect(fetched.version.snapshot.elements.some(e => e.id === "v-rect-1")).toBe(true);

    const deleted = await client.manageVersions({ board: boardId, action: "delete", versionId });
    expect(deleted).toEqual({ ok: true, board: boardId, versionId, deleted: true });

    const afterDel = await client.manageVersions({ board: boardId, action: "list" });
    expect(afterDel.versions).toEqual([]);
  });

  test("Areas, Spaces & Board Lifecycle: manage_spaces list_home, create_area, create_space, trash_board, restore_board", async () => {
    const client = createPlenaryClient({ url: server.url, token: ADMIN_TOKEN });

    const home = await client.manageSpaces({ action: "list_home" });
    expect(home.unit.id).toBe(tenant.id);
    expect(typeof home.tree).toBe("object");
    expect(home.tree).not.toBeNull();

    const areaRes = await client.manageSpaces({ action: "create_area", name: "Engineering", general: "viewer" });
    expect(areaRes.group.name).toBe("Engineering");
    const groupId = areaRes.group.id;

    const spaceRes = await client.manageSpaces({ action: "create_space", name: "Platform", group: groupId, general: "editor" });
    expect(spaceRes.space.name).toBe("Platform");
    expect(spaceRes.space.group.id).toBe(groupId);
    const spaceId = spaceRes.space.id;

    const spaceBoard = await client.createBoard({ title: "Lifecycle Board", space: spaceId });
    const sbId = spaceBoard.board.id;

    // Trash board without explicit `from` (auto-resolved from /boards)
    const trashed = await client.manageSpaces({ action: "trash_board", board: sbId });
    expect(trashed.trashed).toBe(true);
    expect(trashed.board.id).toBe(sbId);

    // Restore board
    const restored = await client.manageSpaces({ action: "restore_board", board: sbId });
    expect(restored.restored).toBe(true);
    expect(restored.board.id).toBe(sbId);
  });

  test("Members & Roles: manage_org list_roles + personal tenant list_members, add_member, remove_member", async () => {
    const client = createPlenaryClient({ url: server.url, token: ADMIN_TOKEN });

    const rolesRes = await client.manageOrg({ action: "list_roles" });
    expect(Array.isArray(rolesRes.roles)).toBe(true);
    expect(rolesRes.roles.some(r => r.id === "owner")).toBe(true);

    // Create a personal org so add_member / remove_member work (domain tenants manage membership via domain)
    const createOrgRes = await fetch(`${server.url}/tenants`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "My Personal Org" }),
    });
    expect(createOrgRes.status).toBe(201);
    const { tenant: personalOrg } = await createOrgRes.json();

    const added = await client.manageOrg({ action: "add_member", tenant: personalOrg.id, email: "guest@example.com" });
    expect(added.email).toBe("guest@example.com");

    const members1 = await client.manageOrg({ action: "list_members", tenant: personalOrg.id });
    expect(members1.members).toContain("guest@example.com");

    const removed = await client.manageOrg({ action: "remove_member", tenant: personalOrg.id, email: "guest@example.com" });
    expect(removed).toEqual({ ok: true, tenant: personalOrg.id, email: "guest@example.com", removed: true });

    const members2 = await client.manageOrg({ action: "list_members", tenant: personalOrg.id });
    expect(members2.members).not.toContain("guest@example.com");
  });

  test("#34 Compliance & GDPR: export_compliance_data (board & tenant) and gdpr_erase_user via MCP handler", async () => {
    const client = createPlenaryClient({ url: server.url, token: ADMIN_TOKEN });
    const handle = createMcpHandler({ clientFactory: () => client });

    // Board-scoped compliance export via MCP
    const boardExpResp = await handle({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "export_compliance_data", arguments: { scope: "board", board: boardId } },
    });
    expect(boardExpResp.result.isError).toBeUndefined();
    const boardExport = JSON.parse(boardExpResp.result.content[0].text);
    expect(boardExport.schemaVersion).toBe(1);
    expect(boardExport.board.id).toBe(boardId);
    // Share link tokens are redacted in compliance export
    expect(boardExport.shareLinks.length).toBeGreaterThanOrEqual(1);
    expect(boardExport.shareLinks.every(l => l.redacted === true)).toBe(true);

    // Tenant-scoped compliance export via MCP
    const tenantExpResp = await handle({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "export_compliance_data", arguments: { scope: "tenant", tenant: tenant.id } },
    });
    expect(tenantExpResp.result.isError).toBeUndefined();
    const tenantExport = JSON.parse(tenantExpResp.result.content[0].text);
    expect(tenantExport.schemaVersion).toBe(1);
    expect(tenantExport.tenant.id).toBe(tenant.id);

    // GDPR erase without confirm:true is refused before hitting server
    const eraseRefused = await handle({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "gdpr_erase_user", arguments: { userId: "dev:bob", tenant: tenant.id, confirm: false } },
    });
    expect(eraseRefused.result.isError).toBe(true);
    expect(JSON.parse(eraseRefused.result.content[0].text).code).toBe("confirm-required");

    // GDPR erase with confirm:true succeeds on non-admin user dev:bob
    const eraseOk = await handle({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "gdpr_erase_user", arguments: { userId: "dev:bob", tenant: tenant.id, confirm: true } },
    });
    expect(eraseOk.result.isError).toBeUndefined();
    const erased = JSON.parse(eraseOk.result.content[0].text);
    expect(erased.erased).toBe(true);
    expect(erased.targetUserId).toBe("dev:bob");
  });
});
