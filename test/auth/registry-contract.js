// The Registry contract (PROTOCOL.md § Registry; typedef in server/auth/registry-port.js), as reusable bun tests.
// Every Registry adapter (memory here; SQLite / Postgres in the engine) runs the same suite:
//
//   import { registryContract } from "<repo>/test/auth/registry-contract.js";
//   registryContract("sqlite", async ({ now }) => sqliteRegistry({ path: ":memory:", now }));
//
// `makeRegistry({ now })` is an async factory returning a FRESH, empty Registry. `now()` is the test clock (ms);
// the adapter must stamp `createdAt` with it. Optional third argument `{ cleanup(registry), batch }`: cleanup runs
// after each test; `batch: true` says the adapter implements the optional `linkUsesFor` and runs its tests.
// The suite uses only the public Registry methods, and refusals are matched by `err.code`, never by class.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

/**
 * @param {string} name
 * @param {(o: { now: () => number }) => Promise<import("../../server/auth/registry-port.js").Registry>} makeRegistry
 * @param {{ cleanup?: (r: any) => Promise<void>|void }} [opts]
 */
export function registryContract(name, makeRegistry, opts = {}) {
  describe(`Registry contract: ${name}`, () => {
    const T0 = Date.UTC(2026, 10, 11);
    let clock, r;
    const now = () => clock.t;
    beforeEach(async () => { clock = { t: T0 }; r = await makeRegistry({ now }); });
    afterEach(async () => { if (opts.cleanup) await opts.cleanup(r); });

    const tenantWithBoard = async (o = {}) => {
      const t = await r.createTenant({ domain: "acme.com", admins: ["google:root"] });
      const b = await r.createBoard({ tenant: t.id, ...o });
      return { t, b };
    };
    const sorted = async b => (await r.grants(b)).sort((x, y) => x.user.localeCompare(y.user));
    const owners = async b => (await r.grants(b)).filter(g => g.role === "owner").map(g => g.user).sort();

    // ---- tenants ----

    test("createTenant: minted id t- + 12 [a-z0-9], domain lower-cased, admins, createdAt", async () => {
      const t = await r.createTenant({ domain: "Acme.COM", admins: ["google:root"] });
      expect(t.id).toMatch(/^t-[a-z0-9]{12}$/);
      expect(t).toMatchObject({ domain: "acme.com", admins: ["google:root"], createdAt: T0 });
      expect(await r.tenant(t.id)).toEqual(t);
      const u = await r.createTenant({ domain: "globex.com" });
      expect(u.id).not.toBe(t.id);
      expect(u.admins).toEqual([]);
    });

    test("createTenant: a domain has one tenant (case-insensitive); null domains are not unique", async () => {
      await r.createTenant({ domain: "acme.com" });
      await expect(r.createTenant({ domain: "ACME.com" })).rejects.toThrow();
      const a = await r.createTenant({ domain: null }), b = await r.createTenant({ domain: null });
      expect(a.domain).toBe(null);
      expect(a.id).not.toBe(b.id);
    });

    test("tenant / tenantByDomain: unknown is null; tenantByDomain is case-insensitive", async () => {
      const t = await r.createTenant({ domain: "acme.com" });
      expect(await r.tenant("t-nope00000000")).toBe(null);
      expect((await r.tenantByDomain("ACME.Com"))?.id).toBe(t.id);
      expect((await r.tenantByDomain("acme.com"))?.id).toBe(t.id);
      expect(await r.tenantByDomain("globex.com")).toBe(null);
    });

    test("tenantAdminsAmong: exactly those of the given users who are an admin of any tenant; unknown, empty and odd input give none", async () => {
      await r.createTenant({ domain: "acme.com", admins: ["dev:root"] });
      const u = await r.createTenant({ domain: "globex.com" });
      expect(await r.tenantAdminsAmong(["dev:root", "dev:ann"])).toEqual(["dev:root"]);
      await r.addTenantAdmin(u.id, "dev:ann");
      expect((await r.tenantAdminsAmong(["dev:ann", "dev:root", "dev:an", "dev:ann"])).sort()).toEqual(["dev:ann", "dev:root"]);
      expect(await r.tenantAdminsAmong([])).toEqual([]);
      expect(await r.tenantAdminsAmong(["", "x\0y", "dev:an"])).toEqual([]);
    });

    test("addTenantAdmin: adds once (idempotent); unknown tenant rejects", async () => {
      const t = await r.createTenant({ domain: "acme.com", admins: ["google:root"] });
      await r.addTenantAdmin(t.id, "google:ann");
      await r.addTenantAdmin(t.id, "google:ann");
      expect((await r.tenant(t.id)).admins.sort()).toEqual(["google:ann", "google:root"]);
      await expect(r.addTenantAdmin("t-nope00000000", "google:ann")).rejects.toThrow();
    });

    // ---- boards ----

    test("createBoard: minted id b- + 16, defaults title '' and memberRole viewer; board(id) reads it back", async () => {
      const { t, b } = await tenantWithBoard();
      expect(b.id).toMatch(/^b-[a-z0-9]{16}$/);
      expect(b).toMatchObject({ tenant: t.id, title: "", memberRole: "viewer", createdAt: T0 });
      expect(await r.board(b.id)).toEqual(b);
      const c = await r.createBoard({ tenant: t.id, title: "All hands", memberRole: null });
      expect(c).toMatchObject({ title: "All hands", memberRole: null });
      expect(c.id).not.toBe(b.id);
      expect(await r.board("b-nope000000000000")).toBe(null);
    });

    test("createBoard: unknown tenant rejects", async () => {
      await expect(r.createBoard({ tenant: "t-nope00000000" })).rejects.toThrow();
    });

    test("reads return copies: mutating a result doesn't change the registry", async () => {
      const { t, b } = await tenantWithBoard();
      (await r.board(b.id)).title = "hacked";
      (await r.tenant(t.id)).admins.push("google:evil");
      expect((await r.board(b.id)).title).toBe("");
      expect((await r.tenant(t.id)).admins).toEqual(["google:root"]);
    });

    // ---- grants ----

    test("setGrant / grant / grants: set, overwrite, remove with null; none is null / []", async () => {
      const { b } = await tenantWithBoard();
      expect(await r.grant(b.id, "google:ann")).toBe(null);
      expect(await r.grants(b.id)).toEqual([]);
      await r.setGrant(b.id, "google:ann", "viewer");
      await r.setGrant(b.id, "google:ann", "editor");
      await r.setGrant(b.id, "google:bob", "annotator");
      expect(await r.grant(b.id, "google:ann")).toBe("editor");
      expect((await r.grants(b.id)).sort((x, y) => x.user.localeCompare(y.user))).toEqual([
        { user: "google:ann", role: "editor" }, { user: "google:bob", role: "annotator" }]);
      await r.setGrant(b.id, "google:ann", null);
      expect(await r.grant(b.id, "google:ann")).toBe(null);
      await r.setGrant(b.id, "google:nobody", null);          // removing nothing is fine
      expect(await r.grants(b.id)).toEqual([{ user: "google:bob", role: "annotator" }]);
    });

    test("setGrant: unknown board rejects; grants are per board", async () => {
      const { t, b } = await tenantWithBoard();
      const c = await r.createBoard({ tenant: t.id });
      await expect(r.setGrant("b-nope000000000000", "google:ann", "viewer")).rejects.toThrow();
      await r.setGrant(b.id, "google:ann", "editor");
      expect(await r.grant(c.id, "google:ann")).toBe(null);
    });

    test("setGrant: the last owner can't be removed or demoted (code last-owner), and nothing changes", async () => {
      const { b } = await tenantWithBoard();
      await r.setGrant(b.id, "google:root", "owner");
      await r.setGrant(b.id, "google:ann", "editor");
      const before = await sorted(b.id);
      for (const role of [null, "editor", "commenter", "viewer"])
        await expect(r.setGrant(b.id, "google:root", role)).rejects.toMatchObject({ code: "last-owner" });
      expect(await sorted(b.id)).toEqual(before);
      await r.setGrant(b.id, "google:root", "owner");          // owner → owner is not a demotion
      await r.setGrant(b.id, "google:ann", null);              // non-owners come and go
      await r.setGrant(b.id, "google:bob", "owner");
      await r.setGrant(b.id, "google:root", "viewer");         // two owners: one may go
      expect(await owners(b.id)).toEqual(["google:bob"]);
      await expect(r.setGrant(b.id, "google:bob", null)).rejects.toMatchObject({ code: "last-owner" });
      expect(await owners(b.id)).toEqual(["google:bob"]);
    });

    test("setGrant: a board with no owner yet takes grants (createBoard then setGrant owner)", async () => {
      const { b } = await tenantWithBoard();
      await r.setGrant(b.id, "google:ann", "viewer");
      await r.setGrant(b.id, "google:ann", null);
      await r.setGrant(b.id, "google:root", "owner");
      expect(await owners(b.id)).toEqual(["google:root"]);
    });

    test("setGrant: concurrent removals of every owner leave exactly one (atomic check-and-write)", async () => {
      const { b } = await tenantWithBoard();
      for (const pair of [[null, null], ["editor", "viewer"], [null, "commenter"]]) {
        await r.setGrant(b.id, "google:a", "owner");
        await r.setGrant(b.id, "google:b", "owner");
        const res = await Promise.allSettled([r.setGrant(b.id, "google:a", pair[0]), r.setGrant(b.id, "google:b", pair[1])]);
        expect(res.filter(x => x.status === "fulfilled").length).toBe(1);
        expect(res.find(x => x.status === "rejected").reason).toMatchObject({ code: "last-owner" });
        expect((await owners(b.id)).length).toBe(1);
      }
      // Five owners, five concurrent removals: one survives.
      const users = ["google:1", "google:2", "google:3", "google:4", "google:5"];
      for (const u of users) await r.setGrant(b.id, u, "owner");
      for (const u of ["google:a", "google:b"]) await r.setGrant(b.id, u, null);   // the survivor of the loop goes
      expect(await owners(b.id)).toEqual(users);
      const res = await Promise.allSettled(users.map(u => r.setGrant(b.id, u, null)));
      expect(res.filter(x => x.status === "rejected").every(x => x.reason?.code === "last-owner")).toBe(true);
      expect((await owners(b.id)).length).toBe(1);
    });

    // ---- invites ----

    test("createInvite: minted id i- + 16, email trimmed + lower-cased, defaults; invite(id) reads it back", async () => {
      const { b } = await tenantWithBoard();
      const i = await r.createInvite({ board: b.id, email: "  CFO@Partner.Example ", role: "editor", by: "google:root" });
      expect(i.id).toMatch(/^i-[a-z0-9]{16}$/);
      expect(i).toMatchObject({ board: b.id, email: "cfo@partner.example", role: "editor", expiresAt: null, revoked: false, by: "google:root", createdAt: T0 });
      expect(await r.invite(i.id)).toEqual(i);
      expect(await r.invite("i-nope000000000000")).toBe(null);
      const j = await r.createInvite({ board: b.id, email: "x@y.z", role: "viewer", expiresAt: T0 + 1000, by: "google:root" });
      expect(j.expiresAt).toBe(T0 + 1000);
      await expect(r.createInvite({ board: "b-nope000000000000", email: "x@y.z", role: "viewer", by: "google:root" })).rejects.toThrow();
    });

    test("invites(board) / invitesFor(board, email): per board; email match is case-insensitive", async () => {
      const { t, b } = await tenantWithBoard();
      const c = await r.createBoard({ tenant: t.id });
      const i1 = await r.createInvite({ board: b.id, email: "ann@acme.com", role: "editor", by: "google:root" });
      const i2 = await r.createInvite({ board: b.id, email: "bob@acme.com", role: "viewer", by: "google:root" });
      await r.createInvite({ board: c.id, email: "ann@acme.com", role: "viewer", by: "google:root" });
      expect((await r.invites(b.id)).map(i => i.id).sort()).toEqual([i1.id, i2.id].sort());
      expect((await r.invitesFor(b.id, " ANN@Acme.com")).map(i => i.id)).toEqual([i1.id]);
      expect(await r.invitesFor(b.id, "carl@acme.com")).toEqual([]);
      expect(await r.invites("b-nope000000000000")).toEqual([]);
    });

    test("revokeInvite: marks revoked (still listed), true; unknown id false", async () => {
      const { b } = await tenantWithBoard();
      const i = await r.createInvite({ board: b.id, email: "ann@acme.com", role: "editor", by: "google:root" });
      expect(await r.revokeInvite(i.id)).toBe(true);
      expect((await r.invite(i.id)).revoked).toBe(true);
      expect((await r.invitesFor(b.id, "ann@acme.com"))[0].revoked).toBe(true);
      expect(await r.revokeInvite("i-nope000000000000")).toBe(false);
    });

    // ---- share links ----

    test("createLink: minted 26-char [a-z0-9] id, role per link, defaults; link(id) / links(board)", async () => {
      const { t, b } = await tenantWithBoard();
      const c = await r.createBoard({ tenant: t.id });
      const l = await r.createLink({ board: b.id, role: "annotator", by: "google:root" });
      expect(l.id).toMatch(/^[a-z0-9]{26}$/);
      expect(l).toMatchObject({ board: b.id, role: "annotator", expiresAt: null, revoked: false, by: "google:root", createdAt: T0 });
      expect(await r.link(l.id)).toEqual(l);
      expect(await r.link("nope")).toBe(null);
      const m = await r.createLink({ board: b.id, role: "viewer", expiresAt: T0 + 5, by: "google:root" });
      await r.createLink({ board: c.id, role: "viewer", by: "google:root" });
      expect(m.expiresAt).toBe(T0 + 5);
      expect((await r.links(b.id)).map(x => x.id).sort()).toEqual([l.id, m.id].sort());
      await expect(r.createLink({ board: "b-nope000000000000", role: "viewer", by: "google:root" })).rejects.toThrow();
    });

    test("revokeLink: marks revoked, true; unknown id false", async () => {
      const { b } = await tenantWithBoard();
      const l = await r.createLink({ board: b.id, role: "viewer", by: "google:root" });
      expect(await r.revokeLink(l.id)).toBe(true);
      expect((await r.link(l.id)).revoked).toBe(true);
      expect(await r.revokeLink("nope")).toBe(false);
    });

    test("addLinkUse / linkUses: per board and user, idempotent; unknown link rejects", async () => {
      const { t, b } = await tenantWithBoard();
      const c = await r.createBoard({ tenant: t.id });
      const l1 = await r.createLink({ board: b.id, role: "viewer", by: "google:root" });
      const l2 = await r.createLink({ board: b.id, role: "editor", by: "google:root" });
      const l3 = await r.createLink({ board: c.id, role: "viewer", by: "google:root" });
      await r.addLinkUse(l1.id, "google:ann");
      await r.addLinkUse(l1.id, "google:ann");
      await r.addLinkUse(l2.id, "google:ann");
      await r.addLinkUse(l3.id, "google:ann");
      expect((await r.linkUses(b.id, "google:ann")).sort()).toEqual([l1.id, l2.id].sort());
      expect(await r.linkUses(c.id, "google:ann")).toEqual([l3.id]);
      expect(await r.linkUses(b.id, "google:bob")).toEqual([]);
      await expect(r.addLinkUse("nope", "google:ann")).rejects.toThrow();
    });

    if (opts.batch) test("linkUsesFor (optional batch): equals linkUses per user; users with no use are absent", async () => {
      const { t, b } = await tenantWithBoard();
      const c = await r.createBoard({ tenant: t.id });
      const l1 = await r.createLink({ board: b.id, role: "viewer", by: "google:root" });
      const l2 = await r.createLink({ board: b.id, role: "editor", by: "google:root" });
      const l3 = await r.createLink({ board: c.id, role: "viewer", by: "google:root" });
      await r.addLinkUse(l1.id, "google:ann");
      await r.addLinkUse(l2.id, "google:ann");
      await r.addLinkUse(l2.id, "google:cy");
      await r.addLinkUse(l3.id, "google:bob");
      const users = ["google:ann", "google:bob", "google:cy", "google:nobody"];
      const m = await r.linkUsesFor(b.id, users);
      expect(m).toBeInstanceOf(Map);
      expect([...m.keys()].sort()).toEqual(["google:ann", "google:cy"]);
      for (const u of users) expect(m.get(u) ?? []).toEqual(await r.linkUses(b.id, u));
      expect(await r.linkUsesFor(b.id, [])).toEqual(new Map());
      expect([...(await r.linkUsesFor(c.id, users)).keys()]).toEqual(["google:bob"]);
      // a full chunk (tenancy.js USE_CHUNK) in one call
      const many = Array.from({ length: 1000 }, (_, i) => `google:u${i}`);
      await r.addLinkUse(l1.id, many[999]);
      expect((await r.linkUsesFor(b.id, many)).get(many[999])).toEqual([l1.id]);
    });

    // ---- board organization: Units, Groups, Spaces, Teams, scoped grants, roles, accessContext ----

    describe("organization", () => {
      const unit = (o = {}) => r.createTenant({ domain: "acme.com", admins: ["google:root"], ...o });

      test("tenant: kind defaults to company; several domains, the first is `domain`; tenantByDomain finds each", async () => {
        const t = await unit({ domains: ["Acme.IO", "acme.com", "acme.eu"], kind: "enterprise" });
        expect(t).toMatchObject({ domain: "acme.com", domains: ["acme.com", "acme.io", "acme.eu"], kind: "enterprise" });
        expect((await r.tenantByDomain("ACME.eu"))?.id).toBe(t.id);
        expect(await r.tenant(t.id)).toEqual(t);
        const u = await r.createTenant({ domain: "globex.com" });
        expect(u).toMatchObject({ kind: "company", domains: ["globex.com"] });
        const none = await r.createTenant({ domain: null });
        expect(none).toMatchObject({ domain: null, domains: [] });
        await expect(r.createTenant({ domain: "x.com", kind: "galaxy" })).rejects.toThrow();
      });

      test("addTenantDomain: adds, is idempotent for its own, refuses another tenant's domain (primary or extra)", async () => {
        const t = await unit(), u = await r.createTenant({ domain: "globex.com", domains: ["globex.io"] });
        await r.addTenantDomain(t.id, "Acme.io");
        await r.addTenantDomain(t.id, "acme.io");
        expect((await r.tenant(t.id)).domains).toEqual(["acme.com", "acme.io"]);
        expect((await r.tenantByDomain("acme.io")).id).toBe(t.id);
        await expect(r.addTenantDomain(t.id, "globex.com")).rejects.toThrow();
        await expect(r.addTenantDomain(t.id, "globex.io")).rejects.toThrow();
        await expect(r.createTenant({ domain: "new.com", domains: ["acme.io"] })).rejects.toThrow();
        await expect(r.addTenantDomain("t-nope00000000", "z.com")).rejects.toThrow();
        await expect(r.addTenantDomain(t.id, "  ")).rejects.toThrow();
        const bare = await r.createTenant({ domain: null });
        await r.addTenantDomain(bare.id, "bare.com");
        expect(await r.tenant(bare.id)).toMatchObject({ domain: "bare.com", domains: ["bare.com"] });
        expect(u.domains).toEqual(["globex.com", "globex.io"]);
      });

      test("createBoard: unfiled boards keep memberRole viewer; a board in a Space defaults to null (inherit) and records the Space", async () => {
        const t = await unit();
        const sp = await r.createSpace({ tenant: t.id, name: "Design" });
        const a = await r.createBoard({ tenant: t.id });
        const b = await r.createBoard({ tenant: t.id, space: sp.id });
        const c = await r.createBoard({ tenant: t.id, space: sp.id, memberRole: "editor" });
        expect([a.memberRole, a.space]).toEqual(["viewer", null]);
        expect([b.memberRole, b.space]).toEqual([null, sp.id]);
        expect([c.memberRole, c.space]).toEqual(["editor", sp.id]);
        expect(await r.board(b.id)).toEqual(b);
        const other = await r.createTenant({ domain: "globex.com" });
        await expect(r.createBoard({ tenant: other.id, space: sp.id })).rejects.toThrow();
        await expect(r.createBoard({ tenant: t.id, space: "s-nope00000000" })).rejects.toThrow();
      });

      test("Group and Space: minted ids, defaults (Group none, Space viewer), owner grant in the same step, one tenant", async () => {
        const t = await unit();
        const g = await r.createGroup({ tenant: t.id, name: "  Product ", owner: "google:ann" });
        expect(g).toMatchObject({ name: "Product", tenant: t.id, generalRole: null, createdAt: T0 });
        expect(g.id).toMatch(/^g-[a-z0-9]{12}$/);
        expect(await r.scopedGrants({ type: "group", id: g.id })).toEqual([{ subject: { type: "user", id: "google:ann" }, role: "owner" }]);
        const s = await r.createSpace({ tenant: t.id, name: "Design", group: g.id });
        expect(s).toMatchObject({ group: g.id, kind: "shared", owner: null, generalRole: "viewer" });
        expect(s.id).toMatch(/^s-[a-z0-9]{12}$/);
        const root = await r.createSpace({ tenant: t.id, name: "Root", generalRole: null, owner: "google:bob" });
        expect([root.group, root.generalRole]).toEqual([null, null]);
        expect(await r.space(s.id)).toEqual(s);
        expect((await r.spaces(t.id)).map(x => x.id).sort()).toEqual([s.id, root.id].sort());
        expect((await r.groups(t.id)).map(x => x.id)).toEqual([g.id]);
        expect(await r.group("g-nope00000000")).toBe(null);
        expect(await r.space("nope")).toBe(null);
        const other = await r.createTenant({ domain: "globex.com" });
        await expect(r.createSpace({ tenant: other.id, name: "X", group: g.id })).rejects.toThrow();
        await expect(r.createSpace({ tenant: t.id, name: "" })).rejects.toThrow();
        await expect(r.createGroup({ tenant: "t-nope00000000", name: "X" })).rejects.toThrow();
      });

      test("ensurePersonalSpace: one per (tenant, user), private, owned by the user; idempotent; per tenant", async () => {
        const t = await unit(), u = await r.createTenant({ domain: "globex.com" });
        const a = await r.ensurePersonalSpace(t.id, "google:ann");
        expect(a).toMatchObject({ kind: "personal", owner: "google:ann", generalRole: null, group: null, tenant: t.id });
        expect(await r.ensurePersonalSpace(t.id, "google:ann")).toEqual(a);
        const results = await Promise.all([1, 2, 3, 4].map(() => r.ensurePersonalSpace(t.id, "google:bob")));
        expect(new Set(results.map(x => x.id)).size).toBe(1);
        expect((await r.ensurePersonalSpace(u.id, "google:ann")).id).not.toBe(a.id);
        expect(await r.scopedGrants({ type: "space", id: a.id })).toEqual([{ subject: { type: "user", id: "google:ann" }, role: "owner" }]);
        expect((await r.spaces(t.id)).filter(x => x.kind === "personal")).toHaveLength(2);
        await expect(r.ensurePersonalSpace("t-nope00000000", "google:ann")).rejects.toThrow();
      });

      test("Teams: members set and unset, idempotent; unknown team rejects", async () => {
        const t = await unit();
        const tm = await r.createTeam({ tenant: t.id, name: "Infra" });
        expect(tm.id).toMatch(/^tm-[a-z0-9]{12}$/);
        await r.setTeamMember(tm.id, "google:ann", true);
        await r.setTeamMember(tm.id, "google:ann", true);
        await r.setTeamMember(tm.id, "google:bob", true);
        expect(await r.teamMembers(tm.id)).toEqual(["google:ann", "google:bob"]);
        await r.setTeamMember(tm.id, "google:ann", false);
        expect(await r.teamMembers(tm.id)).toEqual(["google:bob"]);
        expect((await r.teams(t.id)).map(x => x.id)).toEqual([tm.id]);
        expect(await r.team(tm.id)).toEqual(tm);
        expect(await r.teamMembers("tm-nope00000000")).toEqual([]);
        await expect(r.setTeamMember("tm-nope00000000", "x", true)).rejects.toThrow();
      });

      test("scoped grants: upsert, remove, user and Team subjects; refuses a board user grant, another tenant's Team, an unknown scope", async () => {
        const t = await unit(), other = await r.createTenant({ domain: "globex.com" });
        const sp = await r.createSpace({ tenant: t.id, name: "Design" });
        const tm = await r.createTeam({ tenant: t.id, name: "Infra" });
        const foreign = await r.createTeam({ tenant: other.id, name: "Spies" });
        const b = await r.createBoard({ tenant: t.id, space: sp.id });
        const scope = { type: "space", id: sp.id };
        await r.setScopedGrant({ scope, subject: { type: "user", id: "google:ann" }, role: "editor" });
        await r.setScopedGrant({ scope, subject: { type: "team", id: tm.id }, role: "viewer" });
        await r.setScopedGrant({ scope, subject: { type: "user", id: "google:ann" }, role: "annotator" });
        expect(await r.scopedGrants(scope)).toEqual([
          { subject: { type: "user", id: "google:ann" }, role: "annotator" }, { subject: { type: "team", id: tm.id }, role: "viewer" }]);
        await r.setScopedGrant({ scope, subject: { type: "team", id: tm.id }, role: null });
        expect(await r.scopedGrants(scope)).toHaveLength(1);
        await r.setScopedGrant({ scope: { type: "board", id: b.id }, subject: { type: "team", id: tm.id }, role: "editor" });
        await r.setScopedGrant({ scope: { type: "unit", id: t.id }, subject: { type: "team", id: tm.id }, role: "r-whatever" });
        expect((await r.scopedGrants({ type: "unit", id: t.id }))[0].role).toBe("r-whatever");
        await expect(r.setScopedGrant({ scope: { type: "board", id: b.id }, subject: { type: "user", id: "google:ann" }, role: "editor" })).rejects.toThrow();
        await expect(r.setScopedGrant({ scope, subject: { type: "team", id: foreign.id }, role: "viewer" })).rejects.toThrow();
        await expect(r.setScopedGrant({ scope: { type: "space", id: "s-nope00000000" }, subject: { type: "user", id: "x" }, role: "viewer" })).rejects.toThrow();
        await expect(r.setScopedGrant({ scope: { type: "planet", id: "x" }, subject: { type: "user", id: "x" }, role: "viewer" })).rejects.toThrow();
        await expect(r.setScopedGrant({ scope, subject: { type: "robot", id: "x" }, role: "viewer" })).rejects.toThrow();
        await expect(r.setScopedGrant({ scope, subject: { type: "user", id: "x" }, role: "" })).rejects.toThrow();
        expect(await r.scopedGrants({ type: "space", id: "s-nope00000000" })).toEqual([]);
      });

      test("a Group or Space keeps one owner: removing or demoting the last counted owner is refused; a Team counts only while it has a member", async () => {
        const t = await unit();
        const g = await r.createGroup({ tenant: t.id, name: "Product", owner: "google:ann" });
        const sp = await r.createSpace({ tenant: t.id, name: "Design", owner: "google:ann" });
        const tm = await r.createTeam({ tenant: t.id, name: "Leads" });
        for (const scope of [{ type: "group", id: g.id }, { type: "space", id: sp.id }]) {
          const ann = { type: "user", id: "google:ann" }, team = { type: "team", id: tm.id };
          for (const role of [null, "editor"]) expect((await r.setScopedGrant({ scope, subject: ann, role }).catch(e => e)).code).toBe("last-owner");
          expect(await r.scopedGrants(scope)).toEqual([{ subject: ann, role: "owner" }]);
          // an EMPTY Team that owns guards nothing: ann is still the only counted owner
          await r.setScopedGrant({ scope, subject: team, role: "owner" });
          expect((await r.setScopedGrant({ scope, subject: ann, role: null }).catch(e => e)).code).toBe("last-owner");
          await r.setTeamMember(tm.id, "google:lee", true);
          await r.setScopedGrant({ scope, subject: ann, role: null });          // the Team has a member now: a second counted owner
          expect(await r.scopedGrants(scope)).toEqual([{ subject: team, role: "owner" }]);
          // removing the Team's last member would leave no counted owner: refused, nothing changes
          expect((await r.setTeamMember(tm.id, "google:lee", false).catch(e => e)).code).toBe("last-owner");
          expect(await r.teamMembers(tm.id)).toEqual(["google:lee"]);
          await r.setTeamMember(tm.id, "google:kay", true);
          await r.setTeamMember(tm.id, "google:lee", false);                      // another member remains: fine
          expect((await r.setScopedGrant({ scope, subject: team, role: "viewer" }).catch(e => e)).code).toBe("last-owner");
          await r.setScopedGrant({ scope, subject: ann, role: "owner" });
          await r.setScopedGrant({ scope, subject: team, role: null });
          await r.setTeamMember(tm.id, "google:kay", false);                      // the Team owns nothing now: no guard
          await r.setScopedGrant({ scope, subject: ann, role: "viewer" }).then(() => { throw new Error("ann is the last owner"); }, e => expect(e.code).toBe("last-owner"));
        }
      });

      test("last owner under concurrency: two racing demotions of the only two owners leave one", async () => {
        const t = await unit();
        const sp = await r.createSpace({ tenant: t.id, name: "Design", owner: "google:ann" });
        await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "user", id: "google:bob" }, role: "owner" });
        const res = await Promise.allSettled(["google:ann", "google:bob"].map(u => r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "user", id: u }, role: null })));
        expect(res.filter(x => x.status === "fulfilled")).toHaveLength(1);
        expect(res.find(x => x.status === "rejected").reason.code).toBe("last-owner");
        expect((await r.scopedGrants({ type: "space", id: sp.id })).filter(g => g.role === "owner")).toHaveLength(1);
      });

      test("boardsIn pages the board ids of a Space, a Group and a Unit by id; a board and an unknown scope have none", async () => {
        const t = await unit(), other = await r.createTenant({ domain: "globex.com" });
        const g = await r.createGroup({ tenant: t.id, name: "P" });
        const s1 = await r.createSpace({ tenant: t.id, name: "A", group: g.id }), s2 = await r.createSpace({ tenant: t.id, name: "B", group: g.id }), s3 = await r.createSpace({ tenant: t.id, name: "C" });
        const ids = { s1: [], s2: [], s3: [], none: [] };
        for (let i = 0; i < 7; i++) {
          ids.s1.push((await r.createBoard({ tenant: t.id, space: s1.id })).id);
          if (i < 3) ids.s2.push((await r.createBoard({ tenant: t.id, space: s2.id })).id);
          if (i < 2) ids.s3.push((await r.createBoard({ tenant: t.id, space: s3.id })).id);
          if (i < 1) ids.none.push((await r.createBoard({ tenant: t.id })).id);
        }
        await r.createBoard({ tenant: other.id });
        const all = async (scope, limit) => { const out = []; let after = null, pages = 0; do { const p = await r.boardsIn(scope, { after, limit }); out.push(...p.ids); after = p.next; pages++; } while (after); return { out, pages }; };
        expect((await all({ type: "space", id: s1.id }, 3))).toEqual({ out: [...ids.s1].sort(), pages: 3 });
        expect((await all({ type: "space", id: s2.id })).out).toEqual([...ids.s2].sort());
        expect((await all({ type: "group", id: g.id }, 4)).out).toEqual([...ids.s1, ...ids.s2].sort());
        expect((await all({ type: "unit", id: t.id }, 5)).out).toEqual([...ids.s1, ...ids.s2, ...ids.s3, ...ids.none].sort());
        expect((await r.boardsIn({ type: "unit", id: t.id }, { limit: 2 })).ids).toHaveLength(2);
        expect((await r.boardsIn({ type: "unit", id: t.id }, { limit: 10_000 })).ids).toHaveLength(13);
        expect(await r.boardsIn({ type: "board", id: ids.s1[0] })).toEqual({ ids: [], next: null });
        expect(await r.boardsIn({ type: "space", id: "s-nope00000000" })).toEqual({ ids: [], next: null });
        for (const bad of ["", 5, "a\nb", {}]) await expect(r.boardsIn({ type: "unit", id: t.id }, { after: bad })).rejects.toThrow("bad cursor");   // never a silent restart
        expect((await r.boardsIn({ type: "unit", id: t.id }, { after: "b-zzzzzzzzzzzzzzzz" })).ids).toEqual([]);                              // unknown but well formed: a position
        expect((await r.boardsIn({ type: "unit", id: t.id }, { limit: 0 })).ids.length).toBeGreaterThan(0);    // a non-positive limit means the default, never "all"
      });

      test("scopesOf pages the scopes a user or Team holds a grant on (to announce a Team membership change)", async () => {
        const t = await unit();
        const g = await r.createGroup({ tenant: t.id, name: "P" }), sp = await r.createSpace({ tenant: t.id, name: "A" });
        const tm = await r.createTeam({ tenant: t.id, name: "Infra" });
        const b = await r.createBoard({ tenant: t.id, space: sp.id });
        const subject = { type: "team", id: tm.id };
        for (const [type, id, role] of [["unit", t.id, "member"], ["group", g.id, "editor"], ["space", sp.id, "viewer"], ["board", b.id, "editor"]])
          await r.setScopedGrant({ scope: { type, id }, subject, role });
        await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "user", id: "google:ann" }, role: "owner" });
        const one = await r.scopesOf(subject);
        expect(one.next).toBe(null);
        expect(one.scopes.map(s => `${s.type}:${s.role}`).sort()).toEqual(["board:editor", "group:editor", "space:viewer", "unit:member"]);
        const seen = []; let after = null;
        do { const p = await r.scopesOf(subject, { after, limit: 3 }); seen.push(...p.scopes); after = p.next; } while (after);
        expect(seen).toEqual(one.scopes);
        expect((await r.scopesOf({ type: "user", id: "google:ann" })).scopes).toEqual([{ type: "space", id: sp.id, role: "owner" }]);
        expect(await r.scopesOf({ type: "user", id: "google:nobody" })).toEqual({ scopes: [], next: null });
        await expect(r.scopesOf({ type: "robot", id: "x" })).rejects.toThrow();
        for (const bad of ["", "space", "planet\nx", "space\n", 7]) await expect(r.scopesOf(subject, { after: bad })).rejects.toThrow("bad cursor");
      });

      test("roles: create (minted id, cap fields kept), update, the editable member role is created on first update, list is per tenant", async () => {
        const t = await unit(), u = await r.createTenant({ domain: "globex.com" });
        const f = await r.createRole({ tenant: t.id, name: "Facilitator", base: "editor", boardRole: "editor", permissions: ["members.manage", "board.create"] });
        expect(f).toMatchObject({ tenant: t.id, name: "Facilitator", base: "editor", boardRole: "editor", permissions: ["members.manage", "board.create"], createdAt: T0 });
        expect(f.id).toMatch(/^r-[a-z0-9]{12}$/);
        expect(await r.role(t.id, f.id)).toEqual(f);
        expect(await r.role(u.id, f.id)).toBe(null);
        const up = await r.updateRole(t.id, f.id, { name: "Host", permissions: ["delete"] });
        expect(up).toMatchObject({ name: "Host", boardRole: "editor", permissions: ["delete"] });
        expect(await r.role(t.id, "member")).toBe(null);
        const m = await r.updateRole(t.id, "member", { permissions: [] });
        expect(m).toMatchObject({ id: "member", boardRole: null, permissions: [] });
        expect((await r.updateRole(t.id, "member", { boardRole: "viewer" })).permissions).toEqual([]);
        expect((await r.roles(t.id)).map(x => x.id).sort()).toEqual([f.id, "member"].sort());
        expect(await r.roles(u.id)).toEqual([]);
        await expect(r.updateRole(t.id, "r-nope00000000", { name: "x" })).rejects.toThrow();
        await expect(r.updateRole("t-nope00000000", "member", {})).rejects.toThrow();
        await expect(r.createRole({ tenant: t.id, name: "", boardRole: "viewer" })).rejects.toThrow();
      });

      test("accessContext: the whole chain in one answer; unknown scope is null; a Unit and a Space scope work too", async () => {
        const t = await unit({ domains: ["acme.io"], admins: ["google:root"] });
        const g = await r.createGroup({ tenant: t.id, name: "Product", generalRole: "viewer" });
        const sp = await r.createSpace({ tenant: t.id, name: "Design", group: g.id });
        const tm = await r.createTeam({ tenant: t.id, name: "Infra" });
        await r.setTeamMember(tm.id, "google:ann", true);
        const b = await r.createBoard({ tenant: t.id, space: sp.id });
        await r.setScopedGrant({ scope: { type: "board", id: b.id }, subject: { type: "team", id: tm.id }, role: "editor" });
        await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "user", id: "google:bob" }, role: "owner" });
        await r.setScopedGrant({ scope: { type: "group", id: g.id }, subject: { type: "team", id: tm.id }, role: "viewer" });
        await r.setScopedGrant({ scope: { type: "unit", id: t.id }, subject: { type: "user", id: "google:cy" }, role: "member" });
        const role = await r.createRole({ tenant: t.id, name: "Host", boardRole: "annotator" });
        const c = await r.accessContext({ type: "board", id: b.id });
        expect(c.tenant).toEqual(await r.tenant(t.id));
        expect([c.board, c.space, c.group]).toEqual([await r.board(b.id), sp, g]);
        expect(c.scoped.board).toEqual([{ subject: { type: "team", id: tm.id }, role: "editor" }]);
        expect(c.scoped.space).toEqual([{ subject: { type: "user", id: "google:bob" }, role: "owner" }]);
        expect(c.scoped.group).toEqual([{ subject: { type: "team", id: tm.id }, role: "viewer" }]);
        expect(c.scoped.unit).toEqual([{ subject: { type: "user", id: "google:cy" }, role: "member" }]);
        expect(c.roles).toEqual([role]);
        expect(c.teams).toEqual({ [tm.id]: ["google:ann"] });
        const s = await r.accessContext({ type: "space", id: sp.id });
        expect([s.board, s.space.id, s.group.id]).toEqual([null, sp.id, g.id]);
        expect(s.scoped.board).toEqual([]);
        const un = await r.accessContext({ type: "unit", id: t.id });
        expect([un.board, un.space, un.group]).toEqual([null, null, null]);
        expect(un.scoped.space).toEqual([]);
        const legacy = await r.createBoard({ tenant: t.id });
        expect([(await r.accessContext({ type: "board", id: legacy.id })).space]).toEqual([null]);
        for (const bad of [{ type: "board", id: "b-nope00000000" }, { type: "space", id: "nope" }, { type: "group", id: "g-x" }, { type: "unit", id: "t-nope00000000" }])
          expect(await r.accessContext(bad)).toBe(null);
        await expect(r.accessContext({ type: "planet", id: "x" })).rejects.toThrow();
      });

      test("accessContext(users): Team members are limited to the users asked about; (chain): the held chain is used as given and only volatile rows are read", async () => {
        const t = await unit();
        const sp = await r.createSpace({ tenant: t.id, name: "Design" });
        const tm = await r.createTeam({ tenant: t.id, name: "Infra" });
        for (const u of ["google:ann", "google:bob", "google:cy"]) await r.setTeamMember(tm.id, u, true);
        const b = await r.createBoard({ tenant: t.id, space: sp.id });
        await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "team", id: tm.id }, role: "editor" });
        const scope = { type: "board", id: b.id };
        expect((await r.accessContext(scope)).teams[tm.id].sort()).toEqual(["google:ann", "google:bob", "google:cy"]);
        expect((await r.accessContext(scope, { users: ["google:bob", "google:zed"] })).teams).toEqual({ [tm.id]: ["google:bob"] });
        expect((await r.accessContext(scope, { users: [] })).teams).toEqual({ [tm.id]: [] });
        const full = await r.accessContext(scope);
        const held = { tenant: full.tenant, board: full.board, space: full.space, group: full.group };
        await r.setScopedGrant({ scope: { type: "board", id: b.id }, subject: { type: "team", id: tm.id }, role: "viewer" });   // volatile: seen through a held chain
        const viaChain = await r.accessContext(scope, { users: ["google:ann"], chain: held });
        expect([viaChain.tenant, viaChain.board, viaChain.space, viaChain.group]).toEqual([held.tenant, held.board, held.space, held.group]);
        expect(viaChain.scoped.board).toEqual([{ subject: { type: "team", id: tm.id }, role: "viewer" }]);
        expect(viaChain.teams).toEqual({ [tm.id]: ["google:ann"] });
        expect(viaChain.roles).toEqual(full.roles);
      });

      test("accessContext is a snapshot copy: mutating it changes nothing stored", async () => {
        const t = await unit();
        const sp = await r.createSpace({ tenant: t.id, name: "Design", owner: "google:ann" });
        const c = await r.accessContext({ type: "space", id: sp.id });
        c.scoped.space.length = 0; c.tenant.domains.push("evil.com");
        expect((await r.accessContext({ type: "space", id: sp.id })).scoped.space).toHaveLength(1);
        expect((await r.tenant(t.id)).domains).toEqual(["acme.com"]);
      });
    });
  });
}
