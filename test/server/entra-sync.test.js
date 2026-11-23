// @ts-check
import { describe, test, expect } from "bun:test";
import {
  EntraSyncError,
  normalizeGroupMapping,
  computeEntraSyncPlan,
  applyEntraSyncPlan,
} from "../../server/core/auth/entra-sync.js";
import { ENTRA_DIRECTORY_METHODS } from "../../server/ports/entra-directory.js";
import { entraGraphDirectory } from "../../server/adapters/driven/auth/entra-graph.js";
import { memoryEntraDirectory } from "../../server/adapters/driven/auth/entra-memory.js";
import { entraSyncRoutes } from "../../server/adapters/driving/entra-sync-http.js";
import { memoryRegistry } from "../../server/adapters/driven/auth/registry.js";
import { isUnitAdmin } from "../../server/core/auth/resolver.js";

describe("Entra ID sync — pure core", () => {
  test("normalizeGroupMapping maps array/object/Map inputs and enforces no privilege escalation", () => {
    const fromArray = normalizeGroupMapping([
      { groupId: "grp-eng", teamName: "Engineering", role: "Editor" },
      { groupId: "grp-ops", teamId: "tm-ops123", role: "viewer" },
    ]);
    expect(fromArray).toEqual({
      "grp-eng": { teamId: null, teamName: "Engineering", role: "editor" },
      "grp-ops": { teamId: "tm-ops123", teamName: null, role: "viewer" },
    });

    const fromObj = normalizeGroupMapping({
      "grp-design": { teamName: "Design" },
    });
    expect(fromObj["grp-design"]).toEqual({ teamId: null, teamName: "Design", role: "viewer" });

    // Reject privileged / escalated roles.
    for (const badRole of ["admin", "member", "owner", "content-admin", "content-admin-personal", "superadmin"]) {
      let caught = null;
      try {
        normalizeGroupMapping([{ groupId: "grp-1", teamName: "X", role: badRole }]);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EntraSyncError);
      expect(caught.code).toBe("privilege-escalation");
    }

    // Respect tighter allowedRoles for acting Unit admin.
    expect(() =>
      normalizeGroupMapping(
        [{ groupId: "grp-1", teamName: "X", role: "editor" }],
        { allowedRoles: ["viewer", "commenter"] },
      ),
    ).toThrow(EntraSyncError);

    // Reject prototype-pollution keys.
    expect(() => normalizeGroupMapping([{ groupId: "__proto__", teamName: "Bad" }])).toThrow(EntraSyncError);
  });

  test("computeEntraSyncPlan handles create, add, remove, email normalization, invalid emails, idempotency, and untouched non-Entra teams", () => {
    const mappings = normalizeGroupMapping([
      { groupId: "grp-eng", teamName: "Engineering", role: "editor" },
      { groupId: "grp-new", teamName: "Platform", role: "viewer" },
    ]);

    const entraGroups = [
      {
        id: "grp-eng",
        displayName: "Eng Group",
        members: [
          { id: "u1", mail: "Alice@Acme.com" },
          { id: "u2", mail: null, userPrincipalName: "bob@acme.com" },
          { id: "u3", mail: "not-an-email", userPrincipalName: "" },
          { id: "u4", mail: null, userPrincipalName: null },
          { id: "u5", mail: "alice@acme.com" }, // duplicate after normalization
        ],
      },
      {
        id: "grp-new",
        displayName: "Platform Group",
        members: [
          { id: "u6", mail: "carol@acme.com" },
        ],
      },
    ];

    const currentTeams = [
      { id: "tm-eng", name: "Engineering", members: ["alice@acme.com", "leaver@acme.com"] },
      { id: "tm-manual", name: "Manual Local Team", members: ["local-only@acme.com"] },
    ];

    const plan = computeEntraSyncPlan({ entraGroups, currentTeams, mappings });

    // Creates new mapped team.
    expect(plan.toCreateTeams).toEqual([
      { groupId: "grp-new", teamName: "Platform", role: "viewer", members: ["carol@acme.com"] },
    ]);
    // Adds bob to existing Engineering and carol to new Platform.
    expect(plan.toAddMembers).toEqual([
      { groupId: "grp-eng", teamId: "tm-eng", teamName: "Engineering", email: "bob@acme.com", role: "editor" },
      { groupId: "grp-new", teamId: null, teamName: "Platform", email: "carol@acme.com", role: "viewer" },
    ]);
    // Removes leaver from Engineering; Manual Local Team is untouched!
    expect(plan.toRemoveMembers).toEqual([
      { groupId: "grp-eng", teamId: "tm-eng", teamName: "Engineering", email: "leaver@acme.com" },
    ]);
    expect(plan.unchanged).toEqual([
      { groupId: "grp-eng", teamId: "tm-eng", teamName: "Engineering", email: "alice@acme.com" },
    ]);
    // Warnings for u3 and u4 without valid emails.
    expect(plan.warnings.length).toBe(2);
    expect(plan.warnings.every(w => w.code === "invalid-email")).toBe(true);

    // Non-Entra team must not appear in any mutation list.
    const touchedTeamIds = new Set([
      ...plan.toAddMembers.map(x => x.teamId),
      ...plan.toRemoveMembers.map(x => x.teamId),
    ]);
    expect(touchedTeamIds.has("tm-manual")).toBe(false);

    // Idempotent re-run once state matches desired.
    const syncedTeams = [
      { id: "tm-eng", name: "Engineering", members: ["alice@acme.com", "bob@acme.com"] },
      { id: "tm-plat", name: "Platform", members: ["carol@acme.com"] },
      { id: "tm-manual", name: "Manual Local Team", members: ["local-only@acme.com"] },
    ];
    const rerun = computeEntraSyncPlan({ entraGroups, currentTeams: syncedTeams, mappings });
    expect(rerun.toCreateTeams).toEqual([]);
    expect(rerun.toAddMembers).toEqual([]);
    expect(rerun.toRemoveMembers).toEqual([]);
    expect(rerun.unchanged.length).toBe(3);
  });

  test("applyEntraSyncPlan respects dryRun and writes through Registry port on live run", async () => {
    const registry = memoryRegistry();
    const tenant = await registry.createTenant({ name: "Acme", domain: "acme.com", admins: ["dev:admin"] });
    const existing = await registry.createTeam({ tenant: tenant.id, name: "Engineering" });
    await registry.setTeamMember(existing.id, "alice@acme.com", true);
    await registry.setTeamMember(existing.id, "leaver@acme.com", true);
    const manual = await registry.createTeam({ tenant: tenant.id, name: "Manual Team" });
    await registry.setTeamMember(manual.id, "keep@acme.com", true);

    const plan = computeEntraSyncPlan({
      entraGroups: [
        { id: "grp-eng", displayName: "Engineering", members: [{ id: "1", mail: "alice@acme.com" }, { id: "2", mail: "bob@acme.com" }] },
        { id: "grp-design", displayName: "Design", members: [{ id: "3", mail: "dana@acme.com" }] },
      ],
      currentTeams: [
        { id: existing.id, name: existing.name, members: await registry.teamMembers(existing.id) },
        { id: manual.id, name: manual.name, members: await registry.teamMembers(manual.id) },
      ],
      mappings: [
        { groupId: "grp-eng", teamId: existing.id, teamName: "Engineering", role: "editor" },
        { groupId: "grp-design", teamName: "Design", role: "viewer" },
      ],
    });

    // Dry run: zero writes.
    const dryRes = await applyEntraSyncPlan({ plan, registry, tenantId: tenant.id, actor: "dev:admin", dryRun: true });
    expect(dryRes.dryRun).toBe(true);
    expect(dryRes.applied).toBe(false);
    expect((await registry.teams(tenant.id)).length).toBe(2);
    expect((await registry.teamMembers(existing.id)).sort()).toEqual(["alice@acme.com", "leaver@acme.com"]);

    // Live run: creates Design, updates Engineering, leaves Manual Team untouched, writes audit event.
    const liveRes = await applyEntraSyncPlan({ plan, registry, tenantId: tenant.id, actor: "dev:admin", dryRun: false });
    expect(liveRes.applied).toBe(true);
    expect(liveRes.createdTeams.length).toBe(1);
    expect(liveRes.addedMembers.length).toBe(2);
    expect(liveRes.removedMembers.length).toBe(1);

    const teamsAfter = await registry.teams(tenant.id);
    expect(teamsAfter.length).toBe(3);
    expect((await registry.teamMembers(existing.id)).sort()).toEqual(["alice@acme.com", "bob@acme.com"]);
    expect(await registry.teamMembers(manual.id)).toEqual(["keep@acme.com"]);
    const designTeam = teamsAfter.find(t => t.name === "Design");
    expect(designTeam).toBeTruthy();
    expect(await registry.teamMembers(designTeam.id)).toEqual(["dana@acme.com"]);

    const audit = await registry.listAudit({ tenant: tenant.id });
    expect(audit.events.some(e => e.action === "entra.sync" && e.actor === "dev:admin")).toBe(true);
  });
});

describe("Entra ID sync — Graph driven adapter", () => {
  test("acquires token from login.microsoftonline.com, caches it, and paginates @odata.nextLink", async () => {
    const calls = [];
    const mockFetch = async (url, init) => {
      calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
      if (url === "https://login.microsoftonline.com/tenant-123/oauth2/v2.0/token") {
        return new Response(JSON.stringify({ access_token: "tok-secret-xyz", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://graph.microsoft.com/v1.0/groups?$skiptoken=page2") {
        return new Response(
          JSON.stringify({ value: [{ id: "g2", displayName: "Group 2" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.startsWith("https://graph.microsoft.com/v1.0/groups?")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "g1", displayName: "Group 1" }],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/groups?$skiptoken=page2",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.startsWith("https://graph.microsoft.com/v1.0/groups/g1/members?")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "m1", displayName: "Alice", mail: "alice@acme.com", userPrincipalName: "alice@acme.com" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const dir = entraGraphDirectory({
      tenantId: "tenant-123",
      clientId: "cid-1",
      clientSecret: "super-secret-value",
      fetch: /** @type {any} */ (mockFetch),
    });

    for (const m of ENTRA_DIRECTORY_METHODS) expect(typeof dir[m]).toBe("function");

    const groups = await dir.listGroups();
    expect(groups.map(g => g.id)).toEqual(["g1", "g2"]);

    const members = await dir.listGroupMembers("g1");
    expect(members).toEqual([
      { id: "m1", displayName: "Alice", mail: "alice@acme.com", userPrincipalName: "alice@acme.com" },
    ]);

    // Token endpoint should only be called once (cached for listGroupMembers).
    const tokenCalls = calls.filter(c => c.url.includes("login.microsoftonline.com"));
    expect(tokenCalls.length).toBe(1);
    expect(String(tokenCalls[0].body)).toContain("grant_type=client_credentials");
  });

  test("rejects spoofed @odata.nextLink pointing off graph.microsoft.com before fetching", async () => {
    const fetchedUrls = [];
    const mockFetch = async url => {
      fetchedUrls.push(url);
      if (url.includes("login.microsoftonline.com")) {
        return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3600 }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          value: [{ id: "g1", displayName: "Group 1" }],
          "@odata.nextLink": "https://evil.attacker.com/v1.0/groups?$skiptoken=steal",
        }),
        { status: 200 },
      );
    };

    const dir = entraGraphDirectory({
      tenantId: "tenant-123",
      clientId: "cid-1",
      clientSecret: "secret-1",
      fetch: /** @type {any} */ (mockFetch),
    });

    let err = null;
    try {
      await dir.listGroups();
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.code).toBe("disallowed-host");
    // Must NEVER have issued a request to the attacker host!
    expect(fetchedUrls.some(u => u.includes("evil.attacker.com"))).toBe(false);
  });

  test("caps pagination to prevent runaway loops", async () => {
    let pageNum = 0;
    const mockFetch = async url => {
      if (url.includes("login.microsoftonline.com")) {
        return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3600 }), { status: 200 });
      }
      pageNum++;
      return new Response(
        JSON.stringify({
          value: [{ id: `g-${pageNum}`, displayName: `Group ${pageNum}` }],
          "@odata.nextLink": `https://graph.microsoft.com/v1.0/groups?$skiptoken=p${pageNum + 1}`,
        }),
        { status: 200 },
      );
    };

    const dir = entraGraphDirectory({
      tenantId: "tenant-123",
      clientId: "cid-1",
      clientSecret: "secret-1",
      maxPages: 3,
      fetch: /** @type {any} */ (mockFetch),
    });

    const groups = await dir.listGroups();
    expect(groups.length).toBe(3);
    expect(pageNum).toBe(3);
  });

  test("enforces timeout and redacts clientSecret and access token on errors", async () => {
    const secret = "ultra-secret-client-credential-999";
    const token = "eyJ-super-secret-bearer-token-888";

    // 1. Timeout test
    const hangingFetch = () => new Promise(() => {});
    const slowDir = entraGraphDirectory({
      tenantId: "tenant-123",
      clientId: "cid-1",
      clientSecret: secret,
      timeoutMs: 25,
      fetch: /** @type {any} */ (hangingFetch),
    });

    let timeoutErr = null;
    try {
      await slowDir.listGroups();
    } catch (e) {
      timeoutErr = e;
    }
    expect(timeoutErr).toBeTruthy();
    expect(timeoutErr.code).toBe("timeout");
    expect(timeoutErr.message).not.toContain(secret);

    // 2. Redaction on token failure
    const failingTokenFetch = async () =>
      new Response(`invalid_client: bad secret ${secret}`, { status: 401 });
    const badTokenDir = entraGraphDirectory({
      tenantId: "tenant-123",
      clientId: "cid-1",
      clientSecret: secret,
      fetch: /** @type {any} */ (failingTokenFetch),
    });

    let tokenErr = null;
    try {
      await badTokenDir.listGroups();
    } catch (e) {
      tokenErr = e;
    }
    expect(tokenErr).toBeTruthy();
    expect(tokenErr.message).not.toContain(secret);
    expect(tokenErr.message).toContain("[REDACTED]");

    // 3. Redaction of access token on Graph failure
    const failingGraphFetch = async url => {
      if (url.includes("login.microsoftonline.com")) {
        return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), { status: 200 });
      }
      return new Response(`error echoing token ${token} and ${secret}`, { status: 500 });
    };
    const badGraphDir = entraGraphDirectory({
      tenantId: "tenant-123",
      clientId: "cid-1",
      clientSecret: secret,
      fetch: /** @type {any} */ (failingGraphFetch),
    });

    let graphErr = null;
    try {
      await badGraphDir.listGroups();
    } catch (e) {
      graphErr = e;
    }
    expect(graphErr).toBeTruthy();
    expect(graphErr.message).not.toContain(token);
    expect(graphErr.message).not.toContain(secret);
    expect(graphErr.message).toContain("[REDACTED]");
  });
});

describe("Entra ID sync — HTTP driving adapter", () => {
  async function setup() {
    const registry = memoryRegistry();
    const tenant = await registry.createTenant({
      name: "Acme Corp",
      domain: "acme.com",
      admins: ["dev:unit-admin"],
    });
    const manualTeam = await registry.createTeam({ tenant: tenant.id, name: "Local Only" });
    await registry.setTeamMember(manualTeam.id, "local@acme.com", true);

    const directory = memoryEntraDirectory({
      groups: [
        { id: "grp-eng", displayName: "Engineering", description: "Eng org" },
        { id: "grp-sales", displayName: "Sales", description: "Sales org" },
      ],
      membersByGroup: {
        "grp-eng": [
          { id: "e1", displayName: "Alice", mail: "alice@acme.com" },
          { id: "e2", displayName: "Bob", userPrincipalName: "bob@acme.com" },
        ],
        "grp-sales": [
          { id: "e3", displayName: "Carol", mail: "carol@acme.com" },
        ],
      },
    });

    const sessions = {
      "tok-admin": { user: "dev:unit-admin", email: "admin@acme.com", domain: "acme.com" },
      "tok-member": { user: "dev:regular-user", email: "alice@acme.com", domain: "acme.com" },
    };

    const handler = entraSyncRoutes({
      directory,
      registry,
      resolveSession: req => {
        const auth = req.headers.get("authorization") ?? "";
        const m = /^Bearer\s+(.+)$/i.exec(auth);
        return m ? (sessions[m[1]] ?? null) : null;
      },
      isUnitAdmin: (session, _tenantId, tenantRow) => isUnitAdmin(tenantRow, session),
    });

    return { registry, tenant, manualTeam, handler };
  }

  test("enforces 401 unauthenticated and 403 non-Unit-admin on both routes", async () => {
    const { tenant, handler } = await setup();

    // Unrelated route returns null.
    const other = await handler(new Request("https://plenary.test/health"));
    expect(other).toBeNull();

    // Unauthenticated -> 401.
    const r401Groups = await handler(new Request(`https://plenary.test/tenants/${tenant.id}/entra/groups`));
    expect(r401Groups.status).toBe(401);

    const r401Sync = await handler(
      new Request(`https://plenary.test/tenants/${tenant.id}/entra/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mappings: [] }),
      }),
    );
    expect(r401Sync.status).toBe(401);

    // Non-Unit-admin -> 403.
    const r403Groups = await handler(
      new Request(`https://plenary.test/tenants/${tenant.id}/entra/groups`, {
        headers: { authorization: "Bearer tok-member" },
      }),
    );
    expect(r403Groups.status).toBe(403);

    const r403Sync = await handler(
      new Request(`https://plenary.test/tenants/${tenant.id}/entra/sync`, {
        method: "POST",
        headers: { authorization: "Bearer tok-member", "content-type": "application/json" },
        body: JSON.stringify({ mappings: [{ groupId: "grp-eng", teamName: "Engineering", role: "viewer" }] }),
      }),
    );
    expect(r403Sync.status).toBe(403);
  });

  test("Unit admin can list Entra groups, dry-run sync, live sync, and is blocked from privilege escalation", async () => {
    const { registry, tenant, manualTeam, handler } = await setup();

    // 1. GET /tenants/:tenant/entra/groups
    const groupsRes = await handler(
      new Request(`https://plenary.test/tenants/${tenant.id}/entra/groups`, {
        headers: { authorization: "Bearer tok-admin" },
      }),
    );
    expect(groupsRes.status).toBe(200);
    const groupsBody = await groupsRes.json();
    expect(groupsBody.groups.map(g => g.id)).toEqual(["grp-eng", "grp-sales"]);

    // 2. Privilege escalation attempt -> 403
    const escRes = await handler(
      new Request(`https://plenary.test/tenants/${tenant.id}/entra/sync`, {
        method: "POST",
        headers: { authorization: "Bearer tok-admin", "content-type": "application/json" },
        body: JSON.stringify({
          mappings: [{ groupId: "grp-eng", teamName: "Engineering", role: "admin" }],
        }),
      }),
    );
    expect(escRes.status).toBe(403);
    expect((await escRes.json()).error).toBe("privilege-escalation");

    // 3. Dry-run sync -> 200, no Registry writes
    const dryRes = await handler(
      new Request(`https://plenary.test/tenants/${tenant.id}/entra/sync`, {
        method: "POST",
        headers: { authorization: "Bearer tok-admin", "content-type": "application/json" },
        body: JSON.stringify({
          dryRun: true,
          mappings: [{ groupId: "grp-eng", teamName: "Engineering", role: "editor" }],
        }),
      }),
    );
    expect(dryRes.status).toBe(200);
    const dryBody = await dryRes.json();
    expect(dryBody.dryRun).toBe(true);
    expect(dryBody.summary).toEqual({
      createdTeams: 1,
      addedMembers: 2,
      removedMembers: 0,
      unchanged: 0,
      warnings: 0,
    });
    expect((await registry.teams(tenant.id)).length).toBe(1); // only manualTeam

    // 4. Live sync -> 200, creates Engineering with 2 members, keeps Local Only untouched
    const liveRes = await handler(
      new Request(`https://plenary.test/tenants/${tenant.id}/entra/sync`, {
        method: "POST",
        headers: { authorization: "Bearer tok-admin", "content-type": "application/json" },
        body: JSON.stringify({
          dryRun: false,
          mappings: [{ groupId: "grp-eng", teamName: "Engineering", role: "editor" }],
        }),
      }),
    );
    expect(liveRes.status).toBe(200);
    const liveBody = await liveRes.json();
    expect(liveBody.dryRun).toBe(false);
    expect(liveBody.summary.createdTeams).toBe(1);
    expect(liveBody.summary.addedMembers).toBe(2);

    const teams = await registry.teams(tenant.id);
    expect(teams.length).toBe(2);
    const eng = teams.find(t => t.name === "Engineering");
    expect(eng).toBeTruthy();
    expect((await registry.teamMembers(eng.id)).sort()).toEqual(["alice@acme.com", "bob@acme.com"]);
    expect(await registry.teamMembers(manualTeam.id)).toEqual(["local@acme.com"]);

    // 5. Idempotent second live sync -> 0 creates/adds/removes, 2 unchanged
    const rerunRes = await handler(
      new Request(`https://plenary.test/tenants/${tenant.id}/entra/sync`, {
        method: "POST",
        headers: { authorization: "Bearer tok-admin", "content-type": "application/json" },
        body: JSON.stringify({
          mappings: [{ groupId: "grp-eng", teamName: "Engineering", role: "editor" }],
        }),
      }),
    );
    expect(rerunRes.status).toBe(200);
    const rerunBody = await rerunRes.json();
    expect(rerunBody.summary).toEqual({
      createdTeams: 0,
      addedMembers: 0,
      removedMembers: 0,
      unchanged: 2,
      warnings: 0,
    });
  });
});
