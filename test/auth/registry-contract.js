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

    // ---- board listing ----

    test("listBoards: per tenant, ordered createdAt DESC then id ASC, returns copies", async () => {
      const t1 = await r.createTenant({ domain: "acme.com" });
      const t2 = await r.createTenant({ domain: "globex.com" });
      expect(await r.listBoards(t1.id)).toEqual([]);
      expect(await r.listBoards("t-nope00000000")).toEqual([]);
      const b1 = await r.createBoard({ tenant: t1.id, title: "Old" });
      clock.t = T0 + 1000;
      const b2 = await r.createBoard({ tenant: t1.id, title: "SameA" });
      const b3 = await r.createBoard({ tenant: t1.id, title: "SameB" });
      await r.createBoard({ tenant: t2.id, title: "OtherTenant" });
      const listed = await r.listBoards(t1.id);
      const tieOrder = [b2, b3].sort((a, b) => (a.id < b.id ? -1 : 1));
      expect(listed.map(b => b.id)).toEqual([tieOrder[0].id, tieOrder[1].id, b1.id]);
      listed[0].title = "mutated";
      expect((await r.listBoards(t1.id))[0].title).toBe(tieOrder[0].title);
    });

    test("listBoardsFor: effective role from grants, memberRole, live links and live invites; excludes inaccessible", async () => {
      const t1 = await r.createTenant({ domain: "acme.com" });
      const t2 = await r.createTenant({ domain: "globex.com" });
      clock.t = T0;
      const bMember = await r.createBoard({ tenant: t1.id, title: "Member", memberRole: "editor" });
      clock.t = T0 + 10;
      const bPrivate = await r.createBoard({ tenant: t1.id, title: "Private", memberRole: null });
      clock.t = T0 + 20;
      const bLink = await r.createBoard({ tenant: t1.id, title: "ViaLink", memberRole: null });
      clock.t = T0 + 30;
      const bInvite = await r.createBoard({ tenant: t1.id, title: "ViaInvite", memberRole: null });
      clock.t = T0 + 40;
      const bHidden = await r.createBoard({ tenant: t1.id, title: "Hidden", memberRole: null });
      await r.createBoard({ tenant: t2.id, title: "Other", memberRole: "editor" });

      // Lower explicit grant does not demote memberRole (highest wins).
      await r.setGrant(bMember.id, "google:ann", "viewer");
      // Explicit owner grant on private board.
      await r.setGrant(bPrivate.id, "google:ann", "owner");
      // Live link on bLink + revoked link on bHidden.
      const lLive = await r.createLink({ board: bLink.id, role: "annotator", expiresAt: T0 + 500, by: "google:root" });
      const lRev = await r.createLink({ board: bHidden.id, role: "editor", by: "google:root" });
      await r.addLinkUse(lLive.id, "google:ann");
      await r.addLinkUse(lRev.id, "google:ann");
      await r.revokeLink(lRev.id);
      // Live invite on bInvite + expired invite on bHidden.
      await r.createInvite({ board: bInvite.id, email: "Ann@Acme.com", role: "commenter", expiresAt: T0 + 500, by: "google:root" });
      await r.createInvite({ board: bHidden.id, email: "ann@acme.com", role: "editor", expiresAt: T0 + 10, by: "google:root" });

      const res = await r.listBoardsFor(t1.id, "google:ann", { email: "ann@acme.com", isMember: true });
      expect(res.map(b => [b.id, b.role])).toEqual([
        [bInvite.id, "commenter"],
        [bLink.id, "annotator"],
        [bPrivate.id, "owner"],
        [bMember.id, "editor"],
      ]);
      // isMember: false does not apply memberRole (explicit viewer grant remains).
      const nonMember = await r.listBoardsFor(t1.id, "google:ann", { isMember: false });
      expect(nonMember.map(b => [b.id, b.role])).toEqual([
        [bLink.id, "annotator"],
        [bPrivate.id, "owner"],
        [bMember.id, "viewer"],
      ]);
      // After link & invite expire, they disappear.
      clock.t = T0 + 600;
      const afterExp = await r.listBoardsFor(t1.id, "google:ann", { email: "ann@acme.com", isMember: true });
      expect(afterExp.map(b => [b.id, b.role])).toEqual([
        [bPrivate.id, "owner"],
        [bMember.id, "editor"],
      ]);
      expect(await r.listBoardsFor("t-nope00000000", "google:ann")).toEqual([]);
    });

    // ---- audit log ----

    test("appendAudit / listAudit: durable, tenant/board scoped, newest-first, keyset cursor pagination", async () => {
      const t1 = await r.createTenant({ domain: "acme.com" });
      const t2 = await r.createTenant({ domain: "globex.com" });
      const b1 = await r.createBoard({ tenant: t1.id, title: "B1" });
      const b2 = await r.createBoard({ tenant: t1.id, title: "B2" });
      await expect(r.appendAudit({ tenant: "t-nope00000000", actor: "u", action: "x" })).rejects.toThrow();

      const e1 = await r.appendAudit({ tenant: t1.id, board: b1.id, actor: "google:a", action: "board.create", target: b1.id, detail: { title: "B1" } });
      const e2 = await r.appendAudit({ tenant: t1.id, board: b1.id, actor: "google:a", action: "grant.set", target: "google:b", detail: { role: "editor" } }); // same timestamp T0
      clock.t = T0 + 100;
      const e3 = await r.appendAudit({ tenant: t1.id, board: b2.id, actor: "google:a", action: "board.create", target: b2.id, detail: null });
      clock.t = T0 + 200;
      const e4 = await r.appendAudit({ tenant: t1.id, board: null, actor: "google:a", action: "tenant.admin", target: "google:c" });
      await r.appendAudit({ tenant: t2.id, board: null, actor: "google:x", action: "other.tenant" });

      expect(e1).toMatchObject({ tenant: t1.id, board: b1.id, actor: "google:a", action: "board.create", target: b1.id, detail: { title: "B1" }, at: T0 });
      expect(e2.id).toBeGreaterThan(e1.id);
      // Returned copy isolation.
      e1.detail.title = "tampered";

      // Tenant-wide newest-first with exact pagination (4 events, limit 2 → 2 pages, last nextBefore is null).
      const p1 = await r.listAudit({ tenant: t1.id, limit: 2 });
      expect(p1.events.map(e => e.id)).toEqual([e4.id, e3.id]);
      expect(p1.nextBefore).toBe(`${e3.at}:${e3.id}`);
      const p2 = await r.listAudit({ tenant: t1.id, limit: 2, before: p1.nextBefore });
      expect(p2.events.map(e => e.id)).toEqual([e2.id, e1.id]);
      expect(p2.events[1].detail).toEqual({ title: "B1" });
      expect(p2.nextBefore).toBe(null);

      // Tie-breaking across pages when two events share the exact same `at`:
      const tie1 = await r.listAudit({ tenant: t1.id, board: b1.id, limit: 1 });
      expect(tie1.events.map(e => e.id)).toEqual([e2.id]);
      expect(tie1.nextBefore).toBe(`${e2.at}:${e2.id}`);
      const tie2 = await r.listAudit({ tenant: t1.id, board: b1.id, limit: 1, before: tie1.nextBefore });
      expect(tie2.events.map(e => e.id)).toEqual([e1.id]);
      expect(tie2.nextBefore).toBe(null);

      // Unknown tenant or invalid cursor returns empty page, never throws.
      expect(await r.listAudit({ tenant: "t-nope00000000" })).toEqual({ events: [], nextBefore: null });
      expect(await r.listAudit({ tenant: t1.id, before: "not-a-cursor" })).toEqual({ events: [], nextBefore: null });
    });
  });
}
