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
import { IDEM, ASK } from "../../server/auth/registry-port.js";
import { mkBoard, spaceOf } from "./fixtures.js";

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
      const b = await mkBoard(r, { tenant: t.id, ...o });
      return { t, b };
    };
    const sorted = async b => (await r.grants(b)).sort((x, y) => x.user.localeCompare(y.user));
    const owners = async b => (await r.grants(b)).filter(g => g.role === "owner").map(g => g.user).sort();

    // ---- idempotent creates (PROTOCOL.md "Idempotent creates"): the key's row is written in the create's own atomic step ----

    describe("idempotency keys (exactly-once creates)", () => {
      const U = "dev:ada", K = "key-0001-aaaa", FP = "f".repeat(64), FP2 = "0".repeat(64);
      const idem = (o = {}) => ({ user: U, key: K, fp: FP, ...o });
      /** Each keyed create, as a function of its idem (a tenant, a board for invites and links). */
      const creates = async () => {
        const { t, b } = await tenantWithBoard();
        const n = { v: 0 };
        return {
          board: i => mkBoard(r, { tenant: t.id, title: "T", owner: U, idem: i }),
          group: i => r.createGroup({ tenant: t.id, name: "G", owner: U, idem: i }),
          space: i => r.createSpace({ tenant: t.id, name: "S", owner: U, idem: i }),
          team: i => r.createTeam({ tenant: t.id, name: "Tm", idem: i }),
          role: i => r.createRole({ tenant: t.id, name: "Rl", boardRole: "viewer", permissions: ["move"], idem: i }),
          invite: i => r.createInvite({ board: b.id, email: "x@y.com", role: "viewer", by: U, idem: i }),
          link: i => r.createLink({ board: b.id, role: "viewer", by: U, idem: i }),
        };
      };
      const KINDS_ = ["board", "group", "space", "team", "role", "invite", "link"];

      for (const kind of KINDS_) {
        test(`${kind}: the first create stores the key with its id; a repeat rejects idem-replay naming that id and creates nothing; another fingerprint is idem-mismatch`, async () => {
          const c = await creates();
          expect(await r.idemGet(idem())).toEqual({ state: "none" });
          const made = await c[kind](idem());
          expect(await r.idemGet(idem())).toEqual({ state: "done", ref: made.id });
          expect(await r.idemGet(idem({ fp: FP2 }))).toEqual({ state: "mismatch" });
          await expect(c[kind](idem())).rejects.toMatchObject({ code: "idem-replay", ref: made.id });
          await expect(c[kind](idem({ fp: FP2 }))).rejects.toMatchObject({ code: "idem-mismatch" });
          expect(await r.idemSize()).toBe(1);
          // nothing was made by the rejected repeats
          const again = await c[kind](idem({ key: "key-0002-bbbb" }));
          expect(again.id).not.toBe(made.id);
        });
      }
      test("a board made with an owner and a key: the owner grant is part of the same step", async () => {
        const c = await creates();
        const b = await c.board(idem());
        expect(await r.grants(b.id)).toEqual([{ user: U, role: "owner" }]);
      });
      test("a create that FAILS leaves no key behind (the key row rolls back with it), so the retry runs fresh", async () => {
        const { t } = await tenantWithBoard();
        const sp = await r.createSpace({ tenant: t.id, name: "S" });
        await expect(r.createSpace({ tenant: t.id, name: "S", group: "g-nonexistent", idem: idem() })).rejects.toThrow();
        await expect(r.createBoard({ tenant: "t-nonexistent", space: sp.id, idem: idem() })).rejects.toThrow(/no such tenant/);   // reaches createBoard itself
        expect(await r.idemGet(idem())).toEqual({ state: "none" });
        expect(await r.idemSize()).toBe(0);
        expect((await mkBoard(r, { tenant: t.id, idem: idem() })).id).toBeTruthy();
      });
      test("role: a create refused by the cap leaves no key; a replay of a role that fit is a replay even when the Unit is full now; concurrent same key makes one role", async () => {
        const { t } = await tenantWithBoard();
        await r.createRole({ tenant: t.id, name: "A", boardRole: "viewer", max: 1 });
        await expect(r.createRole({ tenant: t.id, name: "B", boardRole: "viewer", max: 1, idem: idem() })).rejects.toMatchObject({ code: "limit" });
        expect(await r.idemGet(idem())).toEqual({ state: "none" });
        expect(await r.idemSize()).toBe(0);
        const made = await r.createRole({ tenant: t.id, name: "B", boardRole: "viewer", max: 2, idem: idem() });
        await expect(r.createRole({ tenant: t.id, name: "B", boardRole: "viewer", max: 2, idem: idem() })).rejects.toMatchObject({ code: "idem-replay", ref: made.id });   // full now: still a replay
        await expect(r.createRole({ tenant: t.id, name: "B", boardRole: "viewer", max: 2, idem: idem({ fp: FP2 }) })).rejects.toMatchObject({ code: "idem-mismatch" });
        const out = await Promise.allSettled(Array.from({ length: 6 }, () => r.createRole({ tenant: t.id, name: "C", boardRole: "viewer", idem: idem({ key: "key-0009-cccc" }) })));
        expect(out.filter(o => o.status === "fulfilled")).toHaveLength(1);
        for (const l of out.filter(o => o.status === "rejected")) expect(l.reason).toMatchObject({ code: "idem-replay" });
        expect((await r.roles(t.id)).map(x => x.name).sort()).toEqual(["A", "B", "C"]);
      });
      test("keys are per user and per key: another user, or another key, is independent", async () => {
        const c = await creates();
        const a = await c.board(idem());
        const b = await c.board(idem({ user: "dev:bob" }));
        const d = await c.board(idem({ key: "key-0002-bbbb" }));
        expect(new Set([a.id, b.id, d.id]).size).toBe(3);
      });
      test("a key row lives IDEM.ttlMs (24 h); after that the key counts as absent and the next create replaces it", async () => {
        const c = await creates();
        const a = await c.board(idem());
        clock.t += IDEM.ttlMs - 1;
        expect(await r.idemGet(idem())).toEqual({ state: "done", ref: a.id });
        await expect(c.board(idem())).rejects.toMatchObject({ code: "idem-replay" });
        clock.t += 1;
        expect(await r.idemGet(idem())).toEqual({ state: "none" });
        const b = await c.board(idem({ fp: FP2 }));   // free again, even for another body
        expect(b.id).not.toBe(a.id);
        expect(await r.idemGet(idem({ fp: FP2 }))).toEqual({ state: "done", ref: b.id });
        expect(await r.idemSize()).toBe(1);
      });
      test("expired rows are pruned by age as keyed creates arrive (bounded storage)", async () => {
        const c = await creates();
        for (let i = 0; i < 100; i++) await c.team(idem({ key: `old-key-${String(i).padStart(4, "0")}` }));
        expect(await r.idemSize()).toBe(100);
        clock.t += IDEM.ttlMs + 1;
        for (let i = 0; i < 64; i++) await c.team(idem({ key: `new-key-${String(i).padStart(4, "0")}` }));
        await new Promise(res => setTimeout(res, 300));   // the prune is a separate, un-awaited call on Postgres
        expect(await r.idemSize()).toBeLessThan(100);
      });
      test("concurrent creates of one key: exactly one object is made, the others reject idem-replay naming it", async () => {
        const c = await creates();
        const out = await Promise.allSettled(Array.from({ length: 8 }, () => c.board(idem())));
        const won = out.filter(o => o.status === "fulfilled");
        expect(won).toHaveLength(1);
        const lost = out.filter(o => o.status === "rejected");
        expect(lost).toHaveLength(7);
        for (const l of lost) expect(l.reason).toMatchObject({ code: "idem-replay", ref: won[0].value.id });
        const t = (await r.tenantByDomain("acme.com")).id;
        expect((await r.boardsIn({ type: "unit", id: t })).ids).toHaveLength(2);   // the setup board + the one made
      });
      test("a create without a key is unaffected; a bad user, key or fingerprint rejects before anything is made", async () => {
        const { t } = await tenantWithBoard();
        await mkBoard(r, { tenant: t.id }); await mkBoard(r, { tenant: t.id });
        expect(await r.idemSize()).toBe(0);
        for (const bad of [idem({ user: 5 }), idem({ key: "" }), idem({ fp: undefined })]) {
          await expect(mkBoard(r, { tenant: t.id, idem: bad })).rejects.toThrow();
          await expect(r.idemGet(bad)).rejects.toThrow();
        }
      });
    });

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
      const { t, b } = await tenantWithBoard({ memberRole: "viewer" });   // mkBoard's own default, passed explicitly
      expect(b.id).toMatch(/^b-[a-z0-9]{16}$/);
      expect(b).toMatchObject({ tenant: t.id, title: "", memberRole: "viewer", createdAt: T0 });
      expect(await r.board(b.id)).toEqual(b);
      const c = await mkBoard(r, { tenant: t.id, title: "All hands", memberRole: null });
      expect(c).toMatchObject({ title: "All hands", memberRole: null });
      expect(c.id).not.toBe(b.id);
      expect(await r.board("b-nope000000000000")).toBe(null);
    });

    test("createBoard: unknown tenant rejects", async () => {
      const sp = await r.createSpace({ tenant: (await r.createTenant({ domain: "real.com" })).id, name: "S" });
      await expect(r.createBoard({ tenant: "t-nope00000000", space: sp.id })).rejects.toThrow(/no such tenant/);
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
      const c = await mkBoard(r, { tenant: t.id });
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
      const c = await mkBoard(r, { tenant: t.id });
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
      const c = await mkBoard(r, { tenant: t.id });
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
      const c = await mkBoard(r, { tenant: t.id });
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
      const c = await mkBoard(r, { tenant: t.id });
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

      test("createBoard: a board in a Space defaults to null (inherit) and records the Space; with no Space (or another Unit's, or an unknown one) it is refused and nothing is written", async () => {
        const t = await unit();
        const sp = await r.createSpace({ tenant: t.id, name: "Design" });
        const b = await r.createBoard({ tenant: t.id, space: sp.id });
        const c = await r.createBoard({ tenant: t.id, space: sp.id, memberRole: "editor" });
        expect([b.memberRole, b.space]).toEqual([null, sp.id]);
        expect([c.memberRole, c.space]).toEqual(["editor", sp.id]);
        expect(await r.board(b.id)).toEqual(b);
        const other = await r.createTenant({ domain: "globex.com" });
        const ok = await r.createBoard({ tenant: other.id, space: (await r.createSpace({ tenant: other.id, name: "O" })).id });
        // Every refusal says "no such space" and leaves nothing behind: no board in either Unit, no owner grant, no idempotency key.
        const attempts = [[t.id, undefined], [t.id, null], [t.id, ""], [t.id, "s-nope00000000"], [other.id, sp.id]];
        for (const [tenant, space] of attempts) {
          await expect(r.createBoard({ tenant, owner: "google:own", idem: { user: "google:own", key: "key-0001-refused", fp: "f".repeat(64) }, ...(space === undefined ? {} : { space }) })).rejects.toThrow(/no such space/);
        }
        expect(await r.idemGet({ user: "google:own", key: "key-0001-refused", fp: "f".repeat(64) })).toEqual({ state: "none" });
        expect(await r.idemSize()).toBe(0);
        expect(await r.sharedBoards("google:own", null)).toEqual([]);   // no owner grant was written
        expect((await r.searchBoards(t.id)).ids.sort()).toEqual([b.id, c.id].sort());   // only the two filed boards exist,
        expect((await r.searchBoards(other.id)).ids).toEqual([ok.id]);                   // and the other Unit has only its own
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
        const cr = await r.createRole({ tenant: t.id, name: "Cr", boardRole: "viewer" });
        await r.setScopedGrant({ scope: { type: "unit", id: t.id }, subject: { type: "team", id: tm.id }, role: cr.id });
        expect((await r.scopedGrants({ type: "unit", id: t.id }))[0].role).toBe(cr.id);
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

      // ---- Teams and access (PROTOCOL.md § Teams and access, #49) ----

      test("renameTeam / teamsPage / teamMembersPage: paged by id, q filters by ASCII-folded name, size counts members (capped)", async () => {
        const t = await unit(), other = await r.createTenant({ domain: "globex.com" });
        const made = [];
        for (const n of ["Design", "Infra", "Design Ops", "Sales_100%"]) made.push(await r.createTeam({ tenant: t.id, name: n }));
        await r.createTeam({ tenant: other.id, name: "Elsewhere" });
        for (const u of ["google:c", "google:a", "google:b"]) await r.setTeamMember(made[0].id, u, true);
        const all = []; let after = null, pages = 0;
        do { const p = await r.teamsPage(t.id, { after, limit: 3 }); all.push(...p.teams); after = p.next; pages++; } while (after);
        expect(all.map(x => x.id)).toEqual(made.map(x => x.id).sort());
        expect(pages).toBe(2);
        expect(all.find(x => x.id === made[0].id)).toMatchObject({ name: "Design", size: 3, tenant: t.id });
        expect((await r.teamsPage(t.id, { q: "dEsIgN" })).teams.map(x => x.name).sort()).toEqual(["Design", "Design Ops"]);
        expect((await r.teamsPage(t.id, { q: "_100%" })).teams.map(x => x.name)).toEqual(["Sales_100%"]);   // LIKE characters are literal
        expect((await r.teamsPage(t.id, { q: "%" })).teams.map(x => x.name)).toEqual(["Sales_100%"]);
        expect((await r.teamsPage(t.id, { q: "  " })).teams).toHaveLength(4);
        expect((await r.teamsPage("t-nope00000000")).teams).toEqual([]);
        const among = await r.teamsAmong(t.id, [made[0].id, made[2].id, made[0].id, "tm-nope00000000", (await r.teamsPage(other.id)).teams[0].id]);   // another Unit's Team is absent
        expect(among.map(x => x.id)).toEqual([made[0].id, made[2].id].sort());
        expect(among.find(x => x.id === made[0].id).size).toBe(3);
        expect(await r.teamsAmong(t.id, [])).toEqual([]);
        for (const bad of ["", 5, "a\nb"]) await expect(r.teamsPage(t.id, { after: bad })).rejects.toThrow("bad cursor");
        const ms = []; after = null;
        do { const p = await r.teamMembersPage(made[0].id, { after, limit: 2 }); ms.push(...p.users); after = p.next; } while (after);
        expect(ms).toEqual(["google:a", "google:b", "google:c"]);
        expect(await r.teamMembersPage("tm-nope00000000")).toEqual({ users: [], next: null });
        const renamed = await r.renameTeam(made[1].id, "  Platform  ");
        expect(renamed).toMatchObject({ id: made[1].id, name: "Platform", tenant: t.id });
        expect((await r.team(made[1].id)).name).toBe("Platform");
        await expect(r.renameTeam(made[1].id, "   ")).rejects.toThrow();
        await expect(r.renameTeam("tm-nope00000000", "X")).rejects.toThrow();
      });

      test("scopedGrantsPage: by subject type then id, cursor is a previous next, an unknown scope lists none", async () => {
        const t = await unit();
        const sp = await r.createSpace({ tenant: t.id, name: "Design", owner: "google:ann" });
        const tm = await r.createTeam({ tenant: t.id, name: "Leads" });
        await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "team", id: tm.id }, role: "editor" });
        for (const u of ["google:zed", "google:bob"]) await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "user", id: u }, role: "viewer" });
        const got = []; let after = null;
        do { const p = await r.scopedGrantsPage({ type: "space", id: sp.id }, { after, limit: 2 }); got.push(...p.grants); after = p.next; } while (after);
        expect(got.map(g => `${g.subject.type}:${g.subject.id}:${g.role}`)).toEqual([`team:${tm.id}:editor`, "user:google:ann:owner", "user:google:bob:viewer", "user:google:zed:viewer"]);
        expect(await r.scopedGrantsPage({ type: "space", id: "s-nope00000000" })).toEqual({ grants: [], next: null });
        expect(await r.scopedGrant({ type: "space", id: sp.id }, { type: "team", id: tm.id })).toBe("editor");
        expect(await r.scopedGrant({ type: "space", id: sp.id }, { type: "user", id: "google:nobody" })).toBe(null);
        expect(await r.scopedGrant({ type: "space", id: "s-nope00000000" }, { type: "user", id: "google:bob" })).toBe(null);
        for (const bad of ["", "space\nx", "a"]) await expect(r.scopedGrantsPage({ type: "space", id: sp.id }, { after: bad })).rejects.toThrow("bad cursor");
      });

      test("deleteTeam removes the Team, its members and every grant it holds; an unknown Team rejects", async () => {
        const t = await unit();
        const sp = await r.createSpace({ tenant: t.id, name: "Design", owner: "google:ann" });
        const b = await r.createBoard({ tenant: t.id, space: sp.id });
        const tm = await r.createTeam({ tenant: t.id, name: "Leads" }), keep = await r.createTeam({ tenant: t.id, name: "Keep" });
        await r.setTeamMember(tm.id, "google:lee", true);
        for (const [type, id] of [["space", sp.id], ["board", b.id], ["unit", t.id]]) {
          await r.setScopedGrant({ scope: { type, id }, subject: { type: "team", id: tm.id }, role: "viewer" });
          await r.setScopedGrant({ scope: { type, id }, subject: { type: "team", id: keep.id }, role: "viewer" });
        }
        await r.deleteTeam(tm.id);
        expect(await r.team(tm.id)).toBe(null);
        expect(await r.teamMembers(tm.id)).toEqual([]);
        expect((await r.teamsPage(t.id)).teams.map(x => x.id)).toEqual([keep.id]);
        for (const [type, id] of [["space", sp.id], ["board", b.id], ["unit", t.id]])
          expect((await r.scopedGrants({ type, id })).filter(g => g.subject.type === "team").map(g => g.subject.id)).toEqual([keep.id]);
        expect((await r.scopesOf({ type: "team", id: tm.id })).scopes).toEqual([]);
        await expect(r.deleteTeam(tm.id)).rejects.toThrow();
        await expect(r.deleteTeam("tm-nope00000000")).rejects.toThrow();
      });

      test("deleteTeam keeps one owner: refused (nothing changes) while the Team is the only counted owner; an empty Team guards nothing", async () => {
        const t = await unit();
        const sp = await r.createSpace({ tenant: t.id, name: "Design", owner: "google:ann" });
        const g = await r.createGroup({ tenant: t.id, name: "P", owner: "google:ann" });
        const tm = await r.createTeam({ tenant: t.id, name: "Leads" });
        for (const scope of [{ type: "space", id: sp.id }, { type: "group", id: g.id }]) {
          await r.setScopedGrant({ scope, subject: { type: "team", id: tm.id }, role: "owner" });
          await r.setTeamMember(tm.id, "google:lee", true);
        }
        await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "user", id: "google:ann" }, role: null });   // the Team is Design's only counted owner
        expect((await r.deleteTeam(tm.id).catch(e => e)).code).toBe("last-owner");
        expect(await r.team(tm.id)).toMatchObject({ id: tm.id });
        expect(await r.teamMembers(tm.id)).toEqual(["google:lee"]);
        expect(await r.scopedGrants({ type: "space", id: sp.id })).toEqual([{ subject: { type: "team", id: tm.id }, role: "owner" }]);
        await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "user", id: "google:ann" }, role: "owner" });
        await r.deleteTeam(tm.id);                                                              // Ann still owns Design and Product: fine
        expect(await r.scopedGrants({ type: "space", id: sp.id })).toEqual([{ subject: { type: "user", id: "google:ann" }, role: "owner" }]);
        // an empty Team that is the only owner on paper guards nothing, so it can go (the real owner is the user)
        const empty = await r.createTeam({ tenant: t.id, name: "Empty" });
        await r.setScopedGrant({ scope: { type: "group", id: g.id }, subject: { type: "team", id: empty.id }, role: "owner" });
        await r.deleteTeam(empty.id);
      });

      test("last owner under concurrency: deleting the Team that owns, racing a demotion of the other owner, leaves one counted owner", async () => {
        for (let round = 0; round < 3; round++) {
          const t = await unit({ domain: `r${round}.acme.com` });
          const sp = await r.createSpace({ tenant: t.id, name: "Design", owner: "google:ann" });
          const tm = await r.createTeam({ tenant: t.id, name: "Leads" });
          await r.setTeamMember(tm.id, "google:lee", true);
          await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "team", id: tm.id }, role: "owner" });
          const res = await Promise.allSettled([r.deleteTeam(tm.id), r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "user", id: "google:ann" }, role: null })]);
          expect(res.filter(x => x.status === "fulfilled")).toHaveLength(1);
          expect(res.find(x => x.status === "rejected").reason.code).toBe("last-owner");
          expect((await r.scopedGrants({ type: "space", id: sp.id })).filter(g => g.role === "owner")).toHaveLength(1);
        }
      });

      test("last owner under concurrency: two Teams each losing their last member at once leave a counted owner", async () => {
        const t = await unit();
        const sp = await r.createSpace({ tenant: t.id, name: "Design", owner: "google:ann" });
        const a = await r.createTeam({ tenant: t.id, name: "A" }), b = await r.createTeam({ tenant: t.id, name: "B" });
        await r.setTeamMember(a.id, "google:x", true); await r.setTeamMember(b.id, "google:y", true);
        for (const tm of [a, b]) await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "team", id: tm.id }, role: "owner" });
        await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "user", id: "google:ann" }, role: null });
        const res = await Promise.allSettled([r.setTeamMember(a.id, "google:x", false), r.setTeamMember(b.id, "google:y", false), r.deleteTeam(a.id)]);
        expect(res.filter(x => x.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
        const left = await Promise.all([a, b].map(async tm => (await r.team(tm.id)) && (await r.teamMembers(tm.id)).length));
        expect(left.some(n => n > 0)).toBe(true);                                             // some Team still has a member and still owns
        expect((await r.scopedGrants({ type: "space", id: sp.id })).some(g => g.role === "owner")).toBe(true);
      });

      test("the member directory: touchMember upserts (idempotent), is per Unit, membersAmong and findMembers read it", async () => {
        const t = await unit(), other = await r.createTenant({ domain: "globex.com" });
        await r.touchMember(t.id, { user: "google:ann", name: "Ann Lee", email: "ann@acme.com" });
        await r.touchMember(t.id, { user: "google:ann", name: "Ann Lee", email: "ann@acme.com" });
        await r.touchMember(t.id, { user: "google:bob", name: null });
        await r.touchMember(t.id, { user: "google:cy", name: "Cy 100%_", email: "cy@acme.com" });
        await r.touchMember(other.id, { user: "google:ann", name: "Other Ann" });
        expect((await r.membersAmong(t.id, ["google:ann", "google:nobody", "google:ann"]))).toEqual([{ user: "google:ann", name: "Ann Lee", email: "ann@acme.com", removed: false }]);
        expect((await r.membersAmong(other.id, ["google:ann"]))[0].name).toBe("Other Ann");
        expect(await r.membersAmong(t.id, [])).toEqual([]);
        await r.touchMember(t.id, { user: "google:ann", name: "Ann Smith", email: "ann@acme.com" });   // a changed name overwrites
        expect((await r.membersAmong(t.id, ["google:ann"]))[0].name).toBe("Ann Smith");
        expect((await r.findMembers(t.id, {})).map(m => m.user)).toEqual(["google:ann", "google:cy", "google:bob"]);          // by name (else the id), then id: "Ann Smith", "Cy 100%_", "google:bob"
        expect((await r.findMembers(t.id, { q: "SMITH" })).map(m => m.user)).toEqual(["google:ann"]);
        expect((await r.findMembers(t.id, { q: "cy@acme" })).map(m => m.user)).toEqual(["google:cy"]);                           // email
        expect((await r.findMembers(t.id, { q: "bob" })).map(m => m.user)).toEqual(["google:bob"]);                              // user id
        expect((await r.findMembers(t.id, { q: "100%_" })).map(m => m.user)).toEqual(["google:cy"]);                             // LIKE characters are literal
        expect((await r.findMembers(t.id, { q: "%" })).map(m => m.user)).toEqual(["google:cy"]);
        expect(await r.findMembers(t.id, { q: "zzz" })).toEqual([]);
        expect((await r.findMembers(t.id, { limit: 2 }))).toHaveLength(2);
        await expect(r.touchMember("t-nope00000000", { user: "google:x" })).rejects.toThrow();
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
          if (i < 1) ids.none.push((await mkBoard(r, { tenant: t.id })).id);
        }
        await mkBoard(r, { tenant: other.id });
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

      test("spacesIn pages a Group's Spaces by id; a Space outside it, another Group, an unknown Group and a bad cursor", async () => {
        const t = await unit();
        const g = await r.createGroup({ tenant: t.id, name: "P" }), g2 = await r.createGroup({ tenant: t.id, name: "Q" });
        const mine = [];
        for (let i = 0; i < 5; i++) mine.push((await r.createSpace({ tenant: t.id, name: `S${i}`, group: g.id })).id);
        await r.createSpace({ tenant: t.id, name: "root" });
        const elsewhere = await r.createSpace({ tenant: t.id, name: "other", group: g2.id });
        const all = async limit => { const out = []; let after = null, pages = 0; do { const p = await r.spacesIn(g.id, { after, limit }); out.push(...p.spaces); after = p.next; pages++; } while (after); return { out, pages }; };
        const paged = await all(2);
        expect(paged.pages).toBe(3);
        expect(paged.out.map(x => x.id)).toEqual([...mine].sort());
        expect(paged.out[0]).toMatchObject({ tenant: t.id, group: g.id, kind: "shared", generalRole: "viewer" });
        expect((await all(1000)).pages).toBe(1);
        expect((await r.spacesIn(g2.id)).spaces.map(x => x.id)).toEqual([elsewhere.id]);
        expect(await r.spacesIn("g-nope00000000")).toEqual({ spaces: [], next: null });
        for (const bad of ["", 5, "a\nb", {}]) await expect(r.spacesIn(g.id, { after: bad })).rejects.toThrow("bad cursor");
      });

      test("rename: a board's title, a Space's and a Group's name; validated like create; nothing else changes; unknown rejects", async () => {
        const t = await unit();
        const g = await r.createGroup({ tenant: t.id, name: "P", generalRole: "viewer" }), sp = await r.createSpace({ tenant: t.id, name: "A", group: g.id });
        const b = await r.createBoard({ tenant: t.id, title: "old", space: sp.id, memberRole: "editor" });
        expect(await r.rename({ type: "board", id: b.id }, "  new title ")).toEqual({ ...b, title: "new title" });
        expect(await r.board(b.id)).toEqual({ ...b, title: "new title" });
        expect((await r.rename({ type: "board", id: b.id }, "  ")).title).toBe("");                       // a board may be untitled
        expect(await r.rename({ type: "space", id: sp.id }, " Renamed ")).toEqual({ ...sp, name: "Renamed" });
        expect(await r.space(sp.id)).toEqual({ ...sp, name: "Renamed" });
        expect(await r.rename({ type: "group", id: g.id }, "Product 2")).toEqual({ ...g, name: "Product 2" });
        expect((await r.board(b.id)).space).toBe(sp.id);
        for (const bad of ["", "   ", 5, null, "x".repeat(201)]) await expect(r.rename({ type: "space", id: sp.id }, bad)).rejects.toThrow("bad name");
        await expect(r.rename({ type: "board", id: b.id }, "x".repeat(201))).rejects.toThrow("bad title");
        await expect(r.rename({ type: "board", id: b.id }, 7)).rejects.toThrow("bad title");
        await expect(r.rename({ type: "board", id: "b-nope000000000000" }, "x")).rejects.toThrow();
        await expect(r.rename({ type: "space", id: "s-nope00000000" }, "x")).rejects.toThrow();
        await expect(r.rename({ type: "group", id: "g-nope00000000" }, "x")).rejects.toThrow();
        for (const bad of [{ type: "unit", id: t.id }, { type: "team", id: "x" }, null, { type: "space", id: "" }]) await expect(r.rename(bad, "x")).rejects.toThrow("bad scope");
      });

      test("updateScope: name and/or general access in one step; nothing else changes; null = only people added; validation and unknown scopes reject", async () => {
        const t = await unit();
        const g = await r.createGroup({ tenant: t.id, name: "P" }), sp = await r.createSpace({ tenant: t.id, name: "A", group: g.id, owner: "google:ann" });
        expect(await r.updateScope({ type: "space", id: sp.id }, { generalRole: "editor" })).toEqual({ ...sp, generalRole: "editor" });
        expect((await r.updateScope({ type: "space", id: sp.id }, { generalRole: null })).generalRole).toBeNull();
        expect(await r.updateScope({ type: "space", id: sp.id }, { name: " B ", generalRole: "viewer" })).toEqual({ ...sp, name: "B", generalRole: "viewer" });
        expect(await r.space(sp.id)).toEqual({ ...sp, name: "B", generalRole: "viewer" });
        expect(await r.updateScope({ type: "group", id: g.id }, { name: "Q", generalRole: "commenter" })).toEqual({ ...g, name: "Q", generalRole: "commenter" });
        expect((await r.updateScope({ type: "group", id: g.id }, { name: "R" })).generalRole).toBe("commenter");        // a missing field is left alone
        expect(await r.scopedGrants({ type: "space", id: sp.id })).toEqual([{ subject: { type: "user", id: "google:ann" }, role: "owner" }]);
        // all or nothing: a bad second field changes neither
        await expect(r.updateScope({ type: "space", id: sp.id }, { name: "Z", generalRole: "x".repeat(65) })).rejects.toThrow("bad role");
        expect((await r.space(sp.id)).name).toBe("B");
        for (const bad of [{}, null, { name: "" }, { name: "x".repeat(201) }]) await expect(r.updateScope({ type: "space", id: sp.id }, bad)).rejects.toThrow();
        await expect(r.updateScope({ type: "space", id: "s-nope00000000" }, { name: "x" })).rejects.toThrow();
        await expect(r.updateScope({ type: "group", id: "g-nope00000000" }, { generalRole: "viewer" })).rejects.toThrow();
        await expect(r.updateScope({ type: "board", id: "b-x" }, { name: "x" })).rejects.toThrow("bad scope");
      });

      test("accessContexts: one answer per Unit, Group or Space scope, each equal to accessContext's; unknown scopes are null; a board scope or too many reject", async () => {
        const t = await unit(), other = await r.createTenant({ domain: "globex.com", admins: ["google:g"] });
        const g = await r.createGroup({ tenant: t.id, name: "P", generalRole: "viewer", owner: "google:ann" });
        const s1 = await r.createSpace({ tenant: t.id, name: "A", group: g.id, owner: "google:bob" }), s2 = await r.createSpace({ tenant: t.id, name: "B", generalRole: null });
        const s3 = await r.createSpace({ tenant: other.id, name: "Theirs" });
        const infra = await r.createTeam({ tenant: t.id, name: "Infra" }), design = await r.createTeam({ tenant: t.id, name: "Design" });
        for (const u of ["google:x", "google:y", "google:z"]) await r.setTeamMember(infra.id, u, true);
        await r.setTeamMember(design.id, "google:y", true);
        await r.setScopedGrant({ scope: { type: "space", id: s1.id }, subject: { type: "team", id: infra.id }, role: "editor" });
        await r.setScopedGrant({ scope: { type: "group", id: g.id }, subject: { type: "team", id: design.id }, role: "viewer" });
        await r.setScopedGrant({ scope: { type: "unit", id: t.id }, subject: { type: "user", id: "google:x" }, role: "member" });
        await r.createRole({ tenant: t.id, name: "Facilitator", boardRole: "editor", permissions: ["board.create"] });
        await r.updateRole(t.id, "member", { permissions: ["space.create", "board.create"] });
        const scopes = [{ type: "unit", id: t.id }, { type: "unit", id: other.id }, { type: "group", id: g.id }, { type: "space", id: s1.id }, { type: "space", id: s2.id }, { type: "space", id: s3.id },
          { type: "space", id: "s-nope00000000" }, { type: "group", id: "g-nope00000000" }, { type: "unit", id: "t-nope00000000" }, { type: "space", id: s1.id }];
        const key = sc => sc.type + "\n" + sc.id;
        for (const users of [undefined, ["google:y"], ["google:nobody"], []]) {
          const got = await r.accessContexts(scopes, users === undefined ? {} : { users });
          expect(got.size).toBe(9);                                                // the duplicate collapses
          for (const sc of scopes) expect([key(sc), got.get(key(sc))]).toEqual([key(sc), await r.accessContext(sc, users === undefined ? {} : { users })]);
        }
        expect((await r.accessContexts([{ type: "space", id: "s-nope00000000" }])).get("space\ns-nope00000000")).toBeNull();
        expect((await r.accessContexts([])).size).toBe(0);
        await expect(r.accessContexts([{ type: "board", id: "b-x" }])).rejects.toThrow("bad scopes");
        await expect(r.accessContexts(Array.from({ length: 201 }, (_, i) => ({ type: "space", id: "s-" + i })))).rejects.toThrow("bad scopes");
        await expect(r.accessContexts("x")).rejects.toThrow("bad scopes");
      });

      test("personalScopesOf: only a subject's grants on a personal space or a board in one, bounded, `more` past the cap", async () => {
        const t = await unit();
        const sp = await r.createSpace({ tenant: t.id, name: "Shared" }), mine = await r.ensurePersonalSpace(t.id, "google:ann");
        const tm = await r.createTeam({ tenant: t.id, name: "Infra" }), subject = { type: "team", id: tm.id };
        const pb = await r.createBoard({ tenant: t.id, space: mine.id }), sb = await r.createBoard({ tenant: t.id, space: sp.id });
        for (const [type, id, role] of [["unit", t.id, "member"], ["space", sp.id, "viewer"], ["board", sb.id, "editor"], ["space", mine.id, "viewer"], ["board", pb.id, "editor"]])
          await r.setScopedGrant({ scope: { type, id }, subject, role });
        const got = await r.personalScopesOf(subject);
        expect(got.more).toBe(false);
        expect(got.scopes.map(s => `${s.type}:${s.id}:${s.role}`).sort()).toEqual([`board:${pb.id}:editor`, `space:${mine.id}:viewer`].sort());
        const one = await r.personalScopesOf(subject, { limit: 1 });
        expect([one.scopes.length, one.more]).toEqual([1, true]);
        expect(await r.personalScopesOf({ type: "team", id: (await r.createTeam({ tenant: t.id, name: "Empty" })).id })).toEqual({ scopes: [], more: false });
        expect(await r.personalScopesOf({ type: "user", id: "google:nobody" })).toEqual({ scopes: [], more: false });
        await expect(r.personalScopesOf({ type: "robot", id: "x" })).rejects.toThrow();
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

      test("roles (#50): createRole max is exact and ignores the member override; deleteRole is refused while any grant holds the role, never the member role; roleUsage counts to cap + 1", async () => {
        const t = await unit(), u = await r.createTenant({ domain: "globex.com" });
        await r.updateRole(t.id, "member", { permissions: [] });                       // the override does not count against max
        const a = await r.createRole({ tenant: t.id, name: "A", boardRole: "viewer", max: 2 });
        await r.createRole({ tenant: t.id, name: "B", boardRole: "viewer", max: 2 });
        await expect(r.createRole({ tenant: t.id, name: "C", boardRole: "viewer", max: 2 })).rejects.toMatchObject({ code: "limit" });
        expect((await r.roles(t.id)).length).toBe(3);
        await r.createRole({ tenant: u.id, name: "A2", boardRole: "viewer", max: 2 });  // another Unit's roles are not counted
        const sp = await r.createSpace({ tenant: t.id, name: "S" }), sp2 = await r.createSpace({ tenant: t.id, name: "S2" });
        const team = await r.createTeam({ tenant: t.id, name: "T" });
        const grant = (scope, subject, role) => r.setScopedGrant({ scope, subject, role });
        await grant({ type: "space", id: sp.id }, { type: "user", id: "google:x" }, a.id);
        await grant({ type: "space", id: sp2.id }, { type: "team", id: team.id }, a.id);
        await grant({ type: "unit", id: t.id }, { type: "user", id: "google:y" }, a.id);
        const use = await r.roleUsage(t.id, [a.id, "r-none00000000"]);
        expect(use.get(a.id)).toEqual({ places: 3, users: 2, teams: [team.id] });
        expect(use.get("r-none00000000")).toEqual({ places: 0, users: 0, teams: [] });
        expect((await r.roleUsage(t.id, [a.id], { cap: 2 })).get(a.id)).toMatchObject({ places: 3, users: 2 });   // cap + 1: "more than 2"
        expect((await r.roleUsage(t.id, [a.id], { cap: 1 })).get(a.id)).toMatchObject({ places: 2, users: 2 });
        await expect(r.deleteRole(t.id, a.id)).rejects.toMatchObject({ code: "in-use" });
        expect(await r.role(t.id, a.id)).toMatchObject({ id: a.id });                 // nothing changed
        await grant({ type: "space", id: sp.id }, { type: "user", id: "google:x" }, null);
        await grant({ type: "space", id: sp2.id }, { type: "team", id: team.id }, null);
        await expect(r.deleteRole(t.id, a.id)).rejects.toMatchObject({ code: "in-use" });   // the Unit grant still holds it
        await grant({ type: "unit", id: t.id }, { type: "user", id: "google:y" }, null);
        await expect(r.deleteRole(u.id, a.id)).rejects.toThrow("no such role");        // another Unit's id is no role
        await r.deleteRole(t.id, a.id);
        expect(await r.role(t.id, a.id)).toBe(null);
        await expect(r.deleteRole(t.id, a.id)).rejects.toThrow("no such role");
        await expect(r.deleteRole(t.id, "member")).rejects.toThrow("bad role");
        await r.createRole({ tenant: t.id, name: "C", boardRole: "viewer", max: 2 });  // a slot is free again
      });

      test("roles (#50): a custom role id is grantable only in its own Unit (code no-role, every scope kind, both subject kinds); usage counts this Unit's grants", async () => {
        const t = await unit(), u = await r.createTenant({ domain: "globex.com" });
        const a = await r.createRole({ tenant: t.id, name: "A", boardRole: "viewer" });
        const ts = await r.createSpace({ tenant: t.id, name: "TS" }), us = await r.createSpace({ tenant: u.id, name: "US" });
        const ug = await r.createGroup({ tenant: u.id, name: "UG" }), ub = await r.createBoard({ tenant: u.id, space: us.id });
        const uteam = await r.createTeam({ tenant: u.id, name: "UT" });
        const user = id => ({ type: "user", id }), team = { type: "team", id: uteam.id };
        for (const [scope, subject] of [[{ type: "space", id: us.id }, user("google:o1")], [{ type: "group", id: ug.id }, team], [{ type: "unit", id: u.id }, user("google:o2")], [{ type: "board", id: ub.id }, team]])
          expect((await r.setScopedGrant({ scope, subject, role: a.id }).catch(e => e)).code).toBe("no-role");     // another Unit's role id
        expect((await r.setScopedGrant({ scope: { type: "space", id: ts.id }, subject: user("google:t1"), role: "r-nosuchrole1" }).catch(e => e)).code).toBe("no-role");
        expect(await r.scopedGrants({ type: "space", id: us.id })).toEqual([]);
        expect((await r.roleUsage(u.id, [a.id])).get(a.id)).toEqual({ places: 0, users: 0, teams: [] });
        await r.setScopedGrant({ scope: { type: "space", id: ts.id }, subject: user("google:t1"), role: a.id });
        expect((await r.roleUsage(t.id, [a.id])).get(a.id)).toEqual({ places: 1, users: 1, teams: [] });
        await r.setScopedGrant({ scope: { type: "space", id: ts.id }, subject: user("google:t1"), role: null });
        await r.deleteRole(t.id, a.id);
        expect((await r.setScopedGrant({ scope: { type: "space", id: ts.id }, subject: user("google:t1"), role: a.id }).catch(e => e)).code).toBe("no-role");   // a grant cannot land on the role just deleted
        expect(await r.scopedGrants({ type: "space", id: ts.id })).toEqual([]);
        await expect(r.roleUsage(t.id, ["member"])).rejects.toThrow("bad role");
        await expect(r.roleUsage(t.id, [a.id, "member"])).rejects.toThrow("bad role");
      });

      test("roles (#50): roleUsage counts DISTINCT users (one person in many places is one), Teams by id, places as rows", async () => {
        const t = await unit();
        const a = await r.createRole({ tenant: t.id, name: "A", boardRole: "viewer" });
        const sps = [];
        for (let i = 0; i < 4; i++) sps.push(await r.createSpace({ tenant: t.id, name: `S${i}` }));
        const tm = await r.createTeam({ tenant: t.id, name: "T" });
        for (const sp of sps) await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "user", id: "google:one" }, role: a.id });
        await r.setScopedGrant({ scope: { type: "space", id: sps[0].id }, subject: { type: "user", id: "google:two" }, role: a.id });
        await r.setScopedGrant({ scope: { type: "space", id: sps[1].id }, subject: { type: "team", id: tm.id }, role: a.id });
        await r.setScopedGrant({ scope: { type: "space", id: sps[2].id }, subject: { type: "team", id: tm.id }, role: a.id });
        expect((await r.roleUsage(t.id, [a.id])).get(a.id)).toEqual({ places: 7, users: 2, teams: [tm.id] });
        expect((await r.roleUsage(t.id, [a.id], { cap: 1 })).get(a.id)).toMatchObject({ places: 2, users: 2 });     // counted to cap + 1
      });

      test("memberCount counts the directory to cap + 1, per Unit", async () => {
        const t = await unit(), u = await r.createTenant({ domain: "globex.com" });
        expect(await r.memberCount(t.id)).toBe(0);
        for (let i = 0; i < 5; i++) await r.touchMember(t.id, { user: `google:m${i}`, name: `M${i}` });
        await r.touchMember(u.id, { user: "google:o", name: "O" });
        expect(await r.memberCount(t.id)).toBe(5);
        expect(await r.memberCount(t.id, { cap: 3 })).toBe(4);
        expect(await r.memberCount(u.id)).toBe(1);
        expect(await r.memberCount("t-nope00000000")).toBe(0);
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
        const filed = await mkBoard(r, { tenant: t.id });
        expect((await r.accessContext({ type: "board", id: filed.id })).space.id).toBe(filed.space);   // a board's chain always has its Space
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

    // ---- Home: Recent, Starred, Shared with me, search, boardRows (PROTOCOL.md § Home) ----
    describe("home", () => {
      const mk = async () => {
        const t = await r.createTenant({ domain: "acme.com", admins: ["dev:root"] });
        const sp = await r.createSpace({ tenant: t.id, name: "Design Studio" });
        const a = await r.createBoard({ tenant: t.id, title: "Roadmap", space: sp.id });
        const b = await mkBoard(r, { tenant: t.id, title: "Offsite 100%_ideas" });
        const c = await mkBoard(r, { tenant: t.id, title: "Other roadmap thing" });
        return { t, sp, a, b, c };
      };

      test("markOpened / recents: newest first, one row per board, limit, unknown board rejects", async () => {
        const { a, b, c } = await mk();
        for (const x of [a, b, c]) { await r.markOpened("dev:ada", x.id); clock.t += 1000; }
        clock.t += 1000;
        await r.markOpened("dev:ada", a.id);      // reopen: moves to the front, no duplicate
        const rec = await r.recents("dev:ada");
        expect(rec.map(x => x.board)).toEqual([a.id, c.id, b.id]);
        expect(rec[0].at).toBe(clock.t);
        expect((await r.recents("dev:ada", { limit: 2 })).map(x => x.board)).toEqual([a.id, c.id]);
        expect(await r.recents("dev:bob")).toEqual([]);
        await expect(r.markOpened("dev:ada", "b-nope000000000000")).rejects.toThrow();
      });

      test("markOpened keeps only the newest 50 rows per user (other users untouched)", async () => {
        const { t } = await mk();
        const ids = [];
        for (let i = 0; i < 55; i++) { ids.push((await mkBoard(r, { tenant: t.id, title: `b${i}` })).id); }
        for (const id of ids) { await r.markOpened("dev:ada", id); clock.t += 1; }
        await r.markOpened("dev:bob", ids[0]);
        const rec = await r.recents("dev:ada", { limit: 1000 });
        expect(rec.length).toBe(50);
        expect(rec[0].board).toBe(ids[54]);
        expect(rec.map(x => x.board)).not.toContain(ids[0]);
        expect((await r.recents("dev:bob")).map(x => x.board)).toEqual([ids[0]]);
      });

      test("setStarred / starred / starredAmong: idempotent, newest star first, un-star never rejects", async () => {
        const { a, b } = await mk();
        await r.setStarred("dev:ada", a.id, true);
        clock.t += 1000;
        await r.setStarred("dev:ada", b.id, true);
        clock.t += 1000;
        await r.setStarred("dev:ada", a.id, true);        // already starred: the star keeps its place
        expect((await r.starred("dev:ada")).map(x => x.board)).toEqual([b.id, a.id]);
        expect((await r.starredAmong("dev:ada", [a.id, "b-nope000000000000"])).sort()).toEqual([a.id]);
        expect(await r.starredAmong("dev:bob", [a.id, b.id])).toEqual([]);
        await r.setStarred("dev:ada", a.id, false);
        await r.setStarred("dev:ada", a.id, false);
        await r.setStarred("dev:ada", "b-nope000000000000", false);
        expect((await r.starred("dev:ada")).map(x => x.board)).toEqual([b.id]);
        await expect(r.setStarred("dev:ada", "b-nope000000000000", true)).rejects.toThrow();
        expect(await r.starredAmong("dev:ada", [])).toEqual([]);
      });

      test("sharedBoards: every source on the board itself (grants incl. owner, a Team's, non-revoked invites, redeemed links)", async () => {
        const { t, a, b, c } = await mk();
        const d = await mkBoard(r, { tenant: t.id, title: "D" });
        const e = await mkBoard(r, { tenant: t.id, title: "E" });
        const f = await mkBoard(r, { tenant: t.id, title: "F" });
        const g = await mkBoard(r, { tenant: t.id, title: "G" });
        await r.setGrant(a.id, "google:ann", "editor");
        await r.setGrant(b.id, "google:ann", "owner");                                  // ownership counts: Home labels it "Your boards" for a guest
        await r.createInvite({ board: c.id, email: "Ann@Example.com", role: "viewer", by: "dev:root" });
        const dead = await r.createInvite({ board: e.id, email: "ann@example.com", role: "viewer", by: "dev:root" });
        await r.revokeInvite(dead.id);
        const l = await r.createLink({ board: d.id, role: "viewer", by: "dev:root" });
        await r.addLinkUse(l.id, "google:ann");
        const team = await r.createTeam({ tenant: t.id, name: "Infra" }), other = await r.createTeam({ tenant: t.id, name: "Other" });
        await r.setTeamMember(team.id, "google:ann", true);
        await r.setScopedGrant({ scope: { type: "board", id: f.id }, subject: { type: "team", id: team.id }, role: "viewer" });
        await r.setScopedGrant({ scope: { type: "board", id: g.id }, subject: { type: "team", id: other.id }, role: "viewer" });   // a Team she is not in
        expect((await r.sharedBoards("google:ann", "ann@example.com")).sort()).toEqual([a.id, b.id, c.id, d.id, f.id].sort());
        expect((await r.sharedBoards("google:ann", null)).sort()).toEqual([a.id, b.id, d.id, f.id].sort());
        expect(await r.sharedBoards("google:nobody", "nobody@example.com")).toEqual([]);
        expect((await r.sharedBoards("google:ann", "ann@example.com", { limit: 1 })).length).toBe(1);
        await r.setTeamMember(team.id, "google:ann", false);
        expect(await r.sharedBoards("google:ann", null)).not.toContain(f.id);
      });

      test("searchBoards: title or Space name, case-insensitive, LIKE characters literal, tenant-scoped, paged", async () => {
        const { t, a, b, c } = await mk();
        const other = await r.createTenant({ domain: "globex.com" });
        await mkBoard(r, { tenant: other.id, title: "Roadmap" });
        expect((await r.searchBoards(t.id, { q: "ROADMAP" })).ids.sort()).toEqual([a.id, c.id].sort());
        expect((await r.searchBoards(t.id, { q: "design studio" })).ids).toEqual([a.id]);     // a Space name finds its boards
        expect((await r.searchBoards(t.id, { q: "100%_" })).ids).toEqual([b.id]);
        expect((await r.searchBoards(t.id, { q: "%" })).ids).toEqual([b.id]);                // not a wildcard
        expect((await r.searchBoards(t.id, { q: "_" })).ids).toEqual([b.id]);
        expect((await r.searchBoards(t.id, { q: "\\" })).ids).toEqual([]);
        expect((await r.searchBoards(t.id, { q: "zzz" })).ids).toEqual([]);
        expect((await r.searchBoards(t.id)).ids.sort()).toEqual([a.id, b.id, c.id].sort());   // no q: every board, each in a Space
        // Paging is by the scan window, never by the number of matches: both matches come back together, and `next` stays null.
        const both = await r.searchBoards(t.id, { q: "roadmap" });
        expect(both.ids.sort()).toEqual([a.id, c.id].sort());
        expect(both.next).toBe(null);
        const w1 = await r.searchBoards(t.id, { q: "roadmap", scan: 1 });
        expect(w1.next).toBe([a.id, b.id, c.id].sort()[0]);                  // examined one board; the Unit goes on
        const w2 = await r.searchBoards(t.id, { q: "roadmap", scan: 1, after: w1.next });
        expect(w2.next).toBe([a.id, b.id, c.id].sort()[1]);
        await expect(r.searchBoards(t.id, { q: "   " })).rejects.toThrow();
        await expect(r.searchBoards(t.id, { q: "x".repeat(101) })).rejects.toThrow();
        await expect(r.searchBoards(t.id, { q: "a", after: "x\ny" })).rejects.toThrow("bad cursor");
        expect((await r.searchBoards("t-nope00000000", { q: "a" })).ids).toEqual([]);
      });

      test("searchBoards: ASCII case-folding only (a non-ASCII capital is not folded)", async () => {
        const t = await r.createTenant({ domain: "fold.com" });
        const a = await mkBoard(r, { tenant: t.id, title: "Caf\u00c9 menu" }), b = await mkBoard(r, { tenant: t.id, title: "CAF\u00e9 plan" });
        expect((await r.searchBoards(t.id, { q: "caf\u00c9" })).ids).toEqual([a.id]);
        expect((await r.searchBoards(t.id, { q: "caf\u00e9" })).ids).toEqual([b.id]);
        expect((await r.searchBoards(t.id, { q: "CAF" })).ids.sort()).toEqual([a.id, b.id].sort());
      });

      test("searchBoards: `next` depends only on the scan window, never on how many boards matched", async () => {
        const t = await r.createTenant({ domain: "many.com" });
        for (let i = 0; i < 30; i++) await mkBoard(r, { tenant: t.id, title: `falcon ${i}` });
        const some = await r.searchBoards(t.id, { q: "falcon", scan: 100 }), none = await r.searchBoards(t.id, { q: "qqqq", scan: 100 });
        expect([some.ids.length, some.next, none.ids.length, none.next]).toEqual([30, null, 0, null]);   // 30 matches in one window: all returned, nothing "more"
        const cut = await r.searchBoards(t.id, { q: "falcon", scan: 10 }), cutNone = await r.searchBoards(t.id, { q: "qqqq", scan: 10 });
        expect(cut.ids.length).toBe(10);
        expect(cut.next).toBe(cutNone.next);                                 // the same cursor whether or not anything matched
        expect(cut.next).not.toBe(null);
      });

      test("searchBoards is work-bounded: a page examines at most `scan` boards and `next` says where it stopped, even with no match", async () => {
        const t = await r.createTenant({ domain: "scan.com" });
        const made = [];
        for (let i = 0; i < 25; i++) made.push((await mkBoard(r, { tenant: t.id, title: i === 22 ? "needle" : `hay ${i}` })).id);
        made.sort();
        const found = [];
        let after = null, pages = 0;
        do { const p = await r.searchBoards(t.id, { q: "needle", after, scan: 10 }); found.push(...p.ids); after = p.next; pages++; } while (after && pages < 10);
        expect(pages).toBe(3);                                                   // 25 boards, 10 examined per page: 10 + 10 + 5
        const need = (await r.searchBoards(t.id, { q: "needle" })).ids;
        expect(found).toEqual(need);
        expect(need.length).toBe(1);
        const first = await r.searchBoards(t.id, { q: "zzzzzz", scan: 10 });
        expect(first.ids).toEqual([]);
        expect(first.next).toBe(made[9]);                                        // examined ten, none matched, the Unit goes on
        expect((await r.searchBoards(t.id, { q: "zzzzzz", scan: 25 })).next).toBe(null);   // examined everything: done
      });

      test("spaceCandidates / groupCandidates: Spaces and Groups a member COULD open, in SQL pages; their Groups come along", async () => {
        const t = await r.createTenant({ domain: "cand.com" });
        const open = await r.createGroup({ tenant: t.id, name: "Open", generalRole: "viewer" });
        const shut = await r.createGroup({ tenant: t.id, name: "Shut", generalRole: null });
        const granted = await r.createGroup({ tenant: t.id, name: "Granted", generalRole: null });
        const team = await r.createTeam({ tenant: t.id, name: "Infra" });
        await r.setTeamMember(team.id, "dev:ann", true);
        await r.setScopedGrant({ scope: { type: "group", id: granted.id }, subject: { type: "user", id: "dev:ann" }, role: "viewer" });
        const sp = {};
        sp.general = await r.createSpace({ tenant: t.id, name: "General" });
        sp.closed = await r.createSpace({ tenant: t.id, name: "Closed", generalRole: null });
        sp.mine = await r.ensurePersonalSpace(t.id, "dev:ann");
        sp.theirs = await r.ensurePersonalSpace(t.id, "dev:bob");
        sp.byUser = await r.createSpace({ tenant: t.id, name: "ByUser", generalRole: null });
        sp.byTeam = await r.createSpace({ tenant: t.id, name: "ByTeam", generalRole: null });
        sp.inOpen = await r.createSpace({ tenant: t.id, name: "InOpen", generalRole: null, group: open.id });
        sp.inShut = await r.createSpace({ tenant: t.id, name: "InShut", generalRole: null, group: shut.id });
        sp.inGranted = await r.createSpace({ tenant: t.id, name: "InGranted", generalRole: null, group: granted.id });
        await r.setScopedGrant({ scope: { type: "space", id: sp.byUser.id }, subject: { type: "user", id: "dev:ann" }, role: "editor" });
        await r.setScopedGrant({ scope: { type: "space", id: sp.byTeam.id }, subject: { type: "team", id: team.id }, role: "editor" });
        const other = await r.createTenant({ domain: "elsewhere.com" });
        await r.createSpace({ tenant: other.id, name: "Elsewhere" });
        const names = async o => (await r.spaceCandidates(t.id, { user: "dev:ann", ...o })).spaces.map(x => x.name).sort();
        expect(await names()).toEqual(["ByTeam", "ByUser", "General", "InGranted", "InOpen", "ann's space"].sort());
        expect((await names({ all: true })).length).toBe(9);                       // a Unit-level role: every Space of the Unit, nothing of another Unit
        const first = await r.spaceCandidates(t.id, { user: "dev:ann", all: true, limit: 4 });
        expect(first.spaces.length).toBe(4);
        expect(first.next).toBe(first.spaces[3].id);
        const rest = await r.spaceCandidates(t.id, { user: "dev:ann", all: true, limit: 200, after: first.next });
        expect(rest.next).toBe(null);
        expect([...first.spaces, ...rest.spaces].map(x => x.id)).toEqual([...first.spaces, ...rest.spaces].map(x => x.id).sort());
        const withGroups = await r.spaceCandidates(t.id, { user: "dev:ann" });
        expect(withGroups.groups.map(g => g.name).sort()).toEqual(["Granted", "Open"]);   // the Groups of the returned Spaces (Shut's Space isn't one)
        expect((await r.groupCandidates(t.id, { user: "dev:ann" })).map(g => g.name).sort()).toEqual(["Granted", "Open"]);
        expect((await r.groupCandidates(t.id, { user: "dev:ann", all: true })).length).toBe(3);
        expect((await r.groupCandidates(t.id, { user: "dev:ann", all: true, limit: 2 })).length).toBe(2);
        expect((await r.spaceCandidates("t-nope00000000", { user: "dev:ann" })).spaces).toEqual([]);
        await expect(r.spaceCandidates(t.id, { user: "dev:ann", after: "x\ny" })).rejects.toThrow("bad cursor");
      });

      test("markOpened under concurrency keeps at most the newest 50 rows per user (a full list, then 24 writes at once)", async () => {
        const { t } = await mk();
        const ids = [];
        for (let i = 0; i < 76; i++) ids.push((await mkBoard(r, { tenant: t.id, title: `c${i}` })).id);
        for (const id of ids.slice(0, 50)) { await r.markOpened("dev:cc", id); clock.t += 1; }   // the list is full
        clock.t += 1000;
        await Promise.all(ids.slice(50).map(id => r.markOpened("dev:cc", id)));                   // concurrent writes each prune a snapshot that misses the others
        const rec = await r.recents("dev:cc", { limit: 1000 });
        expect(rec.length).toBe(50);
        expect(rec.map(x => x.board)).toEqual(expect.arrayContaining(ids.slice(50)));            // every new one is kept, the 24 oldest are gone
        expect(rec.map(x => x.board)).not.toContain(ids[0]);
      });

      test("boardRows: the board-scope rows for one user over a batch; unknown ids absent", async () => {
        const { t, sp, a, b } = await mk();
        const team = await r.createTeam({ tenant: t.id, name: "Infra" });
        const other = await r.createTeam({ tenant: t.id, name: "Other" });
        await r.setTeamMember(team.id, "google:ann", true);
        await r.setScopedGrant({ scope: { type: "board", id: a.id }, subject: { type: "team", id: team.id }, role: "editor" });
        await r.setScopedGrant({ scope: { type: "board", id: a.id }, subject: { type: "team", id: other.id }, role: "viewer" });
        await r.setGrant(a.id, "google:ann", "annotator");
        await r.createInvite({ board: a.id, email: "ann@example.com", role: "viewer", by: "dev:root" });
        await r.createInvite({ board: a.id, email: "someone@example.com", role: "viewer", by: "dev:root" });
        const l = await r.createLink({ board: b.id, role: "viewer", by: "dev:root" });
        await r.addLinkUse(l.id, "google:ann");
        const m = await r.boardRows([a.id, b.id, "b-nope000000000000", a.id], { user: "google:ann", email: "ann@example.com" });
        expect([...m.keys()].sort()).toEqual([a.id, b.id].sort());
        const ra = m.get(a.id);
        expect(ra.board).toMatchObject({ id: a.id, tenant: t.id, title: "Roadmap", space: sp.id });
        expect(ra.grant).toBe("annotator");
        expect(ra.teamGrants).toEqual([{ subject: { type: "team", id: team.id }, role: "editor" }, { subject: { type: "team", id: other.id }, role: "viewer" }]);
        expect(ra.myTeams).toEqual([team.id]);
        expect(ra.invites.map(i => i.email)).toEqual(["ann@example.com"]);
        expect(ra.links).toEqual([]);
        const rb = m.get(b.id);
        expect(rb).toMatchObject({ grant: null, teamGrants: [], myTeams: [], invites: [] });
        expect(rb.board.space).toBe(await spaceOf(r, t.id));
        expect(rb.links.map(x => x.id)).toEqual([l.id]);
        expect((await r.boardRows([a.id], { user: "google:bob" })).get(a.id)).toMatchObject({ grant: null, myTeams: [], invites: [], links: [] });
        expect((await r.boardRows([], { user: "google:ann" })).size).toBe(0);
      });
    });

    // ---- access requests (#51): one atomic step per ask; the limits live in the Registry so every gateway agrees ----
    describe("access requests", () => {
      const U = "google:ann", FP = "f".repeat(64);
      const mk = async () => {
        const t = await r.createTenant({ domain: "acme.com", admins: ["google:root"] });
        const sp = await r.createSpace({ tenant: t.id, name: "Platform", owner: "google:own" });
        const b = await r.createBoard({ tenant: t.id, title: "B", space: sp.id, owner: "google:own" });
        return { t, sp, b, S: { type: "space", id: sp.id } };
      };
      const ask = (t, S, o = {}) => r.requestAccess({ tenant: t.id, scope: S, user: U, role: "editor", ...o });

      test("asks once per (scope, person): a second ask returns the open request, unchanged and not newer", async () => {
        const { t, S } = await mk();
        const a = await ask(t, S);
        expect(a).toMatchObject({ tenant: t.id, scope: S, user: U, role: "editor", state: "pending", at: T0 });
        clock.t += 1000;
        expect(await ask(t, S, { role: "annotator" })).toEqual(a);
        expect(await r.accessRequests(S)).toEqual([a]);
        expect(await r.accessRequest(S, U)).toEqual(a);
        expect(await r.accessRequest(S, "google:bob")).toBeNull();
      });
      test("works at a Group and a board; a Unit, an unknown scope and another Unit's scope are refused and change nothing", async () => {
        const { t, sp, b } = await mk();
        const g = await r.createGroup({ tenant: t.id, name: "G", owner: "google:own" });
        for (const S of [{ type: "group", id: g.id }, { type: "board", id: b.id }]) expect((await ask(t, S)).scope).toEqual(S);
        await expect(ask(t, { type: "unit", id: t.id })).rejects.toThrow();
        await expect(ask(t, { type: "space", id: "s-nope00000000" })).rejects.toThrow();
        const t2 = await r.createTenant({ domain: "other.com" });
        await expect(ask(t2, { type: "space", id: sp.id })).rejects.toThrow();
        await expect(ask(t, { type: "space", id: sp.id }, { role: "" })).rejects.toThrow();
        expect(await r.accessRequests({ type: "space", id: sp.id })).toEqual([]);
      });
      test("accessRequests lists only the scope's pending ones, newest first, bounded by limit", async () => {
        const { t, S } = await mk();
        for (const u of ["google:a", "google:b", "google:c"]) { await r.requestAccess({ tenant: t.id, scope: S, user: u, role: "viewer" }); clock.t += 10; }
        expect((await r.accessRequests(S)).map(x => x.user)).toEqual(["google:c", "google:b", "google:a"]);
        expect((await r.accessRequests(S, { limit: 2 })).map(x => x.user)).toEqual(["google:c", "google:b"]);
        await r.closeAccessRequest(S, "google:b", "dismissed");
        expect((await r.accessRequests(S)).map(x => x.user)).toEqual(["google:c", "google:a"]);
      });
      test("a dismissed request keeps its cooldown: a new ask is rate-limited with the wait, and works once it has passed", async () => {
        const { t, S } = await mk();
        await ask(t, S);
        expect(await r.closeAccessRequest(S, U, "dismissed")).toBe(true);
        expect(await r.closeAccessRequest(S, U, "dismissed")).toBe(false);   // idempotent
        expect(await r.accessRequest(S, U)).toMatchObject({ state: "dismissed" });
        clock.t += 3600_000;
        await expect(ask(t, S)).rejects.toMatchObject({ code: "rate-limited", retryAfterMs: ASK.cooldownMs - 3600_000 });
        clock.t += ASK.cooldownMs - 3600_000 - 1;
        await expect(ask(t, S)).rejects.toMatchObject({ code: "rate-limited", retryAfterMs: 1 });
        clock.t += 1;
        expect(await r.accessRequest(S, U)).toBeNull();
        const again = await ask(t, S);
        expect(again).toMatchObject({ state: "pending", at: clock.t });
        expect((await r.accessRequests(S)).length).toBe(1);
      });
      test("granting closes the request: it is no longer returned, asking again is allowed, and the row still counts toward the person's quota", async () => {
        const { t, S } = await mk();
        await ask(t, S);
        expect(await r.closeAccessRequest(S, U, "granted")).toBe(true);
        expect(await r.accessRequest(S, U)).toBeNull();
        expect(await r.accessRequests(S)).toEqual([]);
        expect(await r.closeAccessRequest(S, U, "granted")).toBe(false);
        expect((await ask(t, S)).state).toBe("pending");
        await expect(r.closeAccessRequest(S, U, "bogus")).rejects.toThrow();
      });
      test("a grant does not return quota: perUser counts granted rows too", async () => {
        const { t } = await mk();
        for (let i = 0; i < 3; i++) { const sp = await r.createSpace({ tenant: t.id, name: "S" + i, owner: "google:own" }); const S = { type: "space", id: sp.id }; await r.requestAccess({ tenant: t.id, scope: S, user: U, role: "editor", limits: { perUser: 3 } }); await r.closeAccessRequest(S, U, "granted"); }
        const sp = await r.createSpace({ tenant: t.id, name: "S9", owner: "google:own" });
        await expect(r.requestAccess({ tenant: t.id, scope: { type: "space", id: sp.id }, user: U, role: "editor", limits: { perUser: 3 } })).rejects.toMatchObject({ code: "rate-limited" });
      });
      test("the cooldown runs from the dismissal, not from the ask: dismissing a day-old request still holds 24 h", async () => {
        const { t, S } = await mk();
        await ask(t, S);
        clock.t += ASK.cooldownMs + 5000;                 // asked long ago; dismissed now
        expect(await r.closeAccessRequest(S, U, "dismissed")).toBe(true);
        expect(await r.accessRequest(S, U)).toMatchObject({ state: "dismissed", closedAt: clock.t });
        await expect(ask(t, S)).rejects.toMatchObject({ code: "rate-limited", retryAfterMs: ASK.cooldownMs });
        clock.t += ASK.cooldownMs - 1;
        await expect(ask(t, S)).rejects.toMatchObject({ code: "rate-limited", retryAfterMs: 1 });
        clock.t += 1;
        expect((await ask(t, S)).state).toBe("pending");
      });
      test("concurrent asks by different people on one scope never pass the scope limit (injectable lower limit)", async () => {
        const { t, S } = await mk();
        for (let round = 0; round < 3; round++) {
          const sp = await r.createSpace({ tenant: t.id, name: "R" + round, owner: "google:own" }), SC = { type: "space", id: sp.id };
          const out = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => r.requestAccess({ tenant: t.id, scope: SC, user: "google:c" + i, role: "viewer", limits: { scopePending: 4 } })));
          expect(out.filter(o => o.status === "fulfilled").length).toBe(4);
          for (const o of out.filter(o => o.status === "rejected")) expect(o.reason).toMatchObject({ code: "rate-limited", retryAfterMs: null });
          expect((await r.accessRequests(SC)).length).toBe(4);
        }
        expect(S.id).toBeTruthy();
      });
      test("supersede: a pending ask for another role is replaced (a new id) only when asked to; the scope count leaves the replaced row out", async () => {
        const { t, S } = await mk();
        const a = await r.requestAccess({ tenant: t.id, scope: S, user: "google:c0", role: "viewer", limits: { scopePending: 2 } });
        expect((await r.requestAccess({ tenant: t.id, scope: S, user: "google:c0", role: "editor", limits: { scopePending: 2 } }))).toMatchObject({ id: a.id, role: "viewer" });   // not asked to: as it was
        await r.requestAccess({ tenant: t.id, scope: S, user: "google:c1", role: "viewer", limits: { scopePending: 2 } });   // the scope is full now
        const b = await r.requestAccess({ tenant: t.id, scope: S, user: "google:c0", role: "editor", supersede: true, limits: { scopePending: 2 } });
        expect(b).toMatchObject({ role: "editor", state: "pending" });
        expect(b.id).not.toBe(a.id);                                                   // a key whose ref is the old id can never replay this one
        const same = await r.requestAccess({ tenant: t.id, scope: S, user: "google:c0", role: "editor", supersede: true, limits: { scopePending: 2 } });   // same role: nothing to replace
        expect(same.at).toBe(b.at);
        await expect(r.requestAccess({ tenant: t.id, scope: S, user: "google:c2", role: "viewer", limits: { scopePending: 2 } })).rejects.toMatchObject({ code: "rate-limited" });
        expect((await r.accessRequests(S)).length).toBe(2);
      });
      test("one person may make ASK.perUser requests in the window across scopes; the next is rate-limited until the oldest leaves it", async () => {
        const { t } = await mk();
        const spaces = [];
        for (let i = 0; i < ASK.perUser + 1; i++) spaces.push(await r.createSpace({ tenant: t.id, name: "S" + i, owner: "google:own" }));
        for (let i = 0; i < ASK.perUser; i++) { await ask(t, { type: "space", id: spaces[i].id }); clock.t += 1000; }
        const last = { type: "space", id: spaces[ASK.perUser].id };
        const first = T0 + ASK.windowMs - clock.t;
        await expect(ask(t, last)).rejects.toMatchObject({ code: "rate-limited", retryAfterMs: first });
        await r.requestAccess({ tenant: t.id, scope: last, user: "google:other", role: "viewer" });   // another person is not limited by it
        clock.t = T0 + ASK.windowMs;
        expect((await ask(t, last)).state).toBe("pending");
      });
      test("a scope holds at most ASK.scopePending pending requests; dismissing frees a slot", async () => {
        const { t, S } = await mk();
        for (let i = 0; i < ASK.scopePending; i++) await r.requestAccess({ tenant: t.id, scope: S, user: "google:u" + i, role: "viewer" });
        await expect(ask(t, S)).rejects.toMatchObject({ code: "rate-limited", retryAfterMs: null });
        await r.closeAccessRequest(S, "google:u0", "dismissed");
        expect((await ask(t, S)).state).toBe("pending");
      });
      test("requests older than ASK.ttlMs are ignored and a new ask replaces them", async () => {
        const { t, S } = await mk();
        await ask(t, S);
        clock.t += ASK.ttlMs;
        expect(await r.accessRequests(S)).toEqual([]);
        expect(await r.accessRequest(S, U)).toBeNull();
        expect((await ask(t, S)).at).toBe(clock.t);
      });
      test("the key is checked first and written with the request: a retry replays even when a limit has since been reached", async () => {
        const { t, S } = await mk();
        const idem = { user: U, key: "key-ask-0001", fp: FP };
        const a = await ask(t, S, { idem });
        await expect(ask(t, S, { idem })).rejects.toMatchObject({ code: "idem-replay", ref: a.id });
        await expect(ask(t, S, { idem: { ...idem, fp: "0".repeat(64) } })).rejects.toMatchObject({ code: "idem-mismatch" });
        await r.closeAccessRequest(S, U, "dismissed");
        await expect(ask(t, S, { idem })).rejects.toMatchObject({ code: "idem-replay", ref: a.id });   // not rate-limited: the key wins
        await expect(ask(t, S, { idem: { ...idem, key: "key-ask-0002" } })).rejects.toMatchObject({ code: "rate-limited" });
        expect(await r.idemGet({ ...idem, key: "key-ask-0002" })).toEqual({ state: "none" });   // a refused ask stores no key
      });
      test("a repeat of an open request under a new key returns the same request and records that key", async () => {
        const { t, S } = await mk();
        const a = await ask(t, S);
        const again = await ask(t, S, { idem: { user: U, key: "key-ask-0003", fp: FP } });
        expect(again.id).toBe(a.id);
        expect(await r.idemGet({ user: U, key: "key-ask-0003", fp: FP })).toEqual({ state: "done", ref: a.id });
      });
      test("concurrent asks by one person make exactly one request", async () => {
        const { t, S } = await mk();
        const out = await Promise.allSettled(Array.from({ length: 8 }, () => ask(t, S)));
        expect(out.every(o => o.status === "fulfilled")).toBe(true);
        expect(new Set(out.map(o => o.value.id)).size).toBe(1);
        expect((await r.accessRequests(S)).length).toBe(1);
      });
      test("concurrent asks by one person across scopes never pass perUser", async () => {
        const { t } = await mk();
        const spaces = [];
        for (let i = 0; i < ASK.perUser + 5; i++) spaces.push(await r.createSpace({ tenant: t.id, name: "S" + i, owner: "google:own" }));
        const out = await Promise.allSettled(spaces.map(s => ask(t, { type: "space", id: s.id })));
        expect(out.filter(o => o.status === "fulfilled").length).toBe(ASK.perUser);
        for (const o of out.filter(o => o.status === "rejected")) expect(o.reason).toMatchObject({ code: "rate-limited" });
      });
      test("grantHolders: the scoped grants at the scope whose role is listed, by subject, bounded", async () => {
        const { t, sp, S } = await mk();
        const team = await r.createTeam({ tenant: t.id, name: "Infra" });
        await r.setScopedGrant({ scope: S, subject: { type: "team", id: team.id }, role: "editor" });
        await r.setScopedGrant({ scope: S, subject: { type: "user", id: "google:v" }, role: "viewer" });
        const got = await r.grantHolders(S, ["owner", "editor"]);
        expect(got).toEqual([{ subject: { type: "team", id: team.id }, role: "editor" }, { subject: { type: "user", id: "google:own" }, role: "owner" }]);
        expect(await r.grantHolders(S, [])).toEqual([]);
        expect(await r.grantHolders({ type: "space", id: "s-nope00000000" }, ["owner"])).toEqual([]);
        expect(await r.grantHolders({ type: "group", id: sp.id }, ["owner"])).toEqual([]);
        expect((await r.grantHolders(S, ["owner", "editor"], { limit: 1 })).length).toBe(1);
      });
    });

    // ---- Trash (PROTOCOL.md § Trash and restore): atomic trash, restore and purge with compare-and-set and idempotency keys ----
    describe("trash", () => {
      const U = "dev:ada", DAY = 24 * 3600_000;
      const mk = async () => {
        const t = await r.createTenant({ domain: "acme.com" });
        const g = await r.createGroup({ tenant: t.id, name: "G" });
        const a = await r.createSpace({ tenant: t.id, name: "A", group: g.id, owner: U }), b = await r.createSpace({ tenant: t.id, name: "B", owner: U });
        const b1 = await r.createBoard({ tenant: t.id, title: "one", space: a.id, owner: U }), b2 = await r.createBoard({ tenant: t.id, title: "two", space: a.id, owner: U });
        return { t, g, a, b, b1, b2 };
      };
      const idemOf = (key = "key-trash-0001") => ({ user: U, key, fp: "f".repeat(64) });
      test("trashBoard marks the board (who, when), compare-and-sets on `from`, and a second call is a no-op", async () => {
        const { a, b, b1 } = await mk();
        clock.t += 5;
        const out = await r.trashBoard({ board: b1.id, from: a.id, by: U });
        expect(out).toMatchObject({ trashed: true, board: { id: b1.id, space: a.id, trashedAt: clock.t, trashedBy: U, trashedWith: null } });
        expect(await r.board(b1.id)).toMatchObject({ trashedAt: clock.t, trashedBy: U });
        clock.t += 5;
        expect(await r.trashBoard({ board: b1.id, from: a.id, by: "dev:bo" })).toMatchObject({ trashed: false, board: { trashedAt: clock.t - 5, trashedBy: U } });   // the first clock and person stay
        const b2 = await r.createBoard({ tenant: (await r.board(b1.id)).tenant, space: a.id, owner: U });
        await expect(r.trashBoard({ board: b2.id, from: b.id, by: U })).rejects.toMatchObject({ code: "moved" });   // not in `from`
        expect((await r.board(b2.id)).trashedAt).toBe(null);
      });
      test("input errors: unknown board, a missing `from` or `by`", async () => {
        const { a, b1 } = await mk();
        await expect(r.trashBoard({ board: "b-nope0000000000", from: a.id, by: U })).rejects.toThrow(/no such board/);
        await expect(r.trashBoard({ board: b1.id, by: U })).rejects.toThrow(/no such space/);
        await expect(r.trashBoard({ board: b1.id, from: a.id })).rejects.toThrow(/bad user/);
        expect((await r.board(b1.id)).trashedAt).toBe(null);
      });
      test("a trashed board keeps its grants, invites, links and link uses, and comes back whole", async () => {
        const { a, b1 } = await mk();
        await r.setGrant(b1.id, "dev:bo", "editor");
        const inv = await r.createInvite({ board: b1.id, email: "x@y.com", role: "viewer", by: U });
        const lk = await r.createLink({ board: b1.id, role: "viewer", by: U });
        await r.addLinkUse(lk.id, "dev:cy");
        await r.trashBoard({ board: b1.id, from: a.id, by: U });
        expect(await sorted(b1.id)).toEqual([{ user: "dev:ada", role: "owner" }, { user: "dev:bo", role: "editor" }]);
        expect((await r.invites(b1.id)).map(i => i.id)).toEqual([inv.id]);
        expect(await r.linkUses(b1.id, "dev:cy")).toEqual([lk.id]);
        expect(await r.restoreBoard({ board: b1.id })).toMatchObject({ restored: true, board: { trashedAt: null, trashedBy: null, trashedWith: null, space: a.id } });
        expect(await sorted(b1.id)).toHaveLength(2); expect((await r.invites(b1.id))[0].revoked).toBe(false); expect(await r.linkUses(b1.id, "dev:cy")).toEqual([lk.id]);
        expect((await r.restoreBoard({ board: b1.id })).restored).toBe(false);   // not in Trash: a no-op
      });
      test("the access context carries the trash fields, and the lists leave a trashed board out (boardsIn, searchBoards, sharedBoards) unless asked", async () => {
        const { t, g, a, b1, b2 } = await mk();
        await r.setGrant(b1.id, "dev:bo", "viewer"); await r.setGrant(b2.id, "dev:bo", "viewer");
        await r.trashBoard({ board: b1.id, from: a.id, by: U });
        const ctx = await r.accessContext({ type: "board", id: b1.id });
        expect(ctx.board).toMatchObject({ trashedAt: clock.t, trashedBy: U });
        expect((await r.boardsIn({ type: "space", id: a.id })).ids).toEqual([b2.id]);
        expect((await r.boardsIn({ type: "group", id: g.id })).ids).toEqual([b2.id]);
        expect((await r.boardsIn({ type: "unit", id: t.id })).ids).toEqual([b2.id]);
        expect((await r.boardsIn({ type: "space", id: a.id }, { withTrashed: true })).ids.sort()).toEqual([b1.id, b2.id].sort());
        expect((await r.boardsIn({ type: "unit", id: t.id }, { withTrashed: true })).ids).toHaveLength(2);
        expect((await r.searchBoards(t.id, { q: "one" })).ids).toEqual([]);
        expect((await r.searchBoards(t.id, { q: "two" })).ids).toEqual([b2.id]);
        expect(await r.sharedBoards("dev:bo", null)).toEqual([b2.id]);
      });
      test("addLinkUse of a board in Trash rejects code in-trash and records nothing; after Restore it records", async () => {
        const { a, b1 } = await mk();
        const lk = await r.createLink({ board: b1.id, role: "viewer", by: U });
        await r.trashBoard({ board: b1.id, from: a.id, by: U });
        await expect(r.addLinkUse(lk.id, "dev:cy")).rejects.toMatchObject({ code: "in-trash" });
        expect(await r.linkUses(b1.id, "dev:cy")).toEqual([]);
        await r.restoreBoard({ board: b1.id });
        await r.addLinkUse(lk.id, "dev:cy");
        expect(await r.linkUses(b1.id, "dev:cy")).toEqual([lk.id]);
      });
      test("a board cannot be created in, or moved into, a Space in Trash, and a trashed board cannot be moved", async () => {
        const { t, a, b, b1 } = await mk();
        await r.trashSpace({ space: b.id, by: U });
        await expect(r.createBoard({ tenant: t.id, space: b.id, owner: U })).rejects.toThrow(/no such space/);
        await expect(r.moveBoard({ board: b1.id, from: a.id, to: b.id })).rejects.toThrow(/no such space/);
        await r.trashBoard({ board: b1.id, from: a.id, by: U });
        const c = await r.createSpace({ tenant: t.id, name: "C", owner: U });
        await expect(r.moveBoard({ board: b1.id, from: a.id, to: c.id })).rejects.toMatchObject({ code: "in-trash" });
      });
      test("trashSpace takes every live board with it, with one clock; a board already in Trash keeps its own", async () => {
        const { t, g, a, b1, b2 } = await mk();
        const lone = await r.createBoard({ tenant: t.id, title: "three", space: a.id, owner: U });
        clock.t += DAY;
        await r.trashBoard({ board: b2.id, from: a.id, by: "dev:bo" });
        const own = clock.t;
        clock.t += DAY;
        const out = await r.trashSpace({ space: a.id, by: U });
        expect(out).toMatchObject({ trashed: true, boards: 2, space: { id: a.id, trashedAt: clock.t, trashedBy: U } });
        expect(await r.board(b1.id)).toMatchObject({ trashedAt: clock.t, trashedBy: U, trashedWith: a.id });
        expect(await r.board(lone.id)).toMatchObject({ trashedAt: clock.t, trashedWith: a.id });
        expect(await r.board(b2.id)).toMatchObject({ trashedAt: own, trashedBy: "dev:bo", trashedWith: null });
        expect((await r.space(a.id)).trashedAt).toBe(clock.t);
        expect((await r.spaces(t.id)).map(s => s.id)).not.toContain(a.id);
        expect((await r.spacesIn(g.id)).spaces).toEqual([]);
        expect((await r.spaceCandidates(t.id, { user: U, all: true })).spaces.map(s => s.id)).not.toContain(a.id);
        expect((await r.trashSpace({ space: a.id, by: "dev:bo" }))).toMatchObject({ trashed: false, boards: 0, space: { trashedBy: U } });
      });
      test("restoreSpace brings back the Space and exactly the boards that went with it; a board trashed on its own stays", async () => {
        const { a, b1, b2 } = await mk();
        await r.trashBoard({ board: b2.id, from: a.id, by: U });
        await r.trashSpace({ space: a.id, by: U });
        expect(await r.restoreSpace({ space: a.id })).toMatchObject({ restored: true, boards: 1, space: { trashedAt: null, trashedBy: null } });
        expect(await r.board(b1.id)).toMatchObject({ trashedAt: null, trashedWith: null });
        expect((await r.board(b2.id)).trashedAt).not.toBe(null);
        expect((await r.restoreSpace({ space: a.id })).restored).toBe(false);
      });
      test("restoreBoard refuses a board that went with its Space (with-space) and a board whose own Space is in Trash (space-in-trash)", async () => {
        const { a, b1, b2 } = await mk();
        await r.trashBoard({ board: b2.id, from: a.id, by: U });
        await r.trashSpace({ space: a.id, by: U });
        await expect(r.restoreBoard({ board: b1.id })).rejects.toMatchObject({ code: "with-space" });
        await expect(r.restoreBoard({ board: b2.id })).rejects.toMatchObject({ code: "space-in-trash" });
        expect((await r.board(b1.id)).trashedAt).not.toBe(null);
        await r.restoreSpace({ space: a.id });
        expect((await r.restoreBoard({ board: b2.id })).restored).toBe(true);
      });
      test("a personal Space is never trashed (code personal); unknown Space rejects", async () => {
        const { t } = await mk();
        const p = await r.ensurePersonalSpace(t.id, U);
        await expect(r.trashSpace({ space: p.id, by: U })).rejects.toMatchObject({ code: "personal" });
        await expect(r.trashSpace({ space: "s-nope00000000", by: U })).rejects.toThrow(/no such space/);
        await expect(r.restoreSpace({ space: "s-nope00000000" })).rejects.toThrow(/no such space/);
        expect((await r.space(p.id)).trashedAt).toBe(null);
      });
      test("keys: the key row is written in the same step, a replay answers the first result, another request is a mismatch", async () => {
        const { a, b, b1 } = await mk();
        const idem = idemOf();
        await r.trashBoard({ board: b1.id, from: a.id, by: U, idem });
        await r.restoreBoard({ board: b1.id });
        await expect(r.trashBoard({ board: b1.id, from: a.id, by: U, idem })).rejects.toMatchObject({ code: "idem-replay", ref: `${b1.id}:trashed` });
        expect((await r.board(b1.id)).trashedAt).toBe(null);   // the replay changed nothing
        await expect(r.trashBoard({ board: b1.id, from: b.id, by: U, idem: { ...idem, fp: "b".repeat(64) } })).rejects.toMatchObject({ code: "idem-mismatch" });
        const k2 = idemOf("key-trash-0002");
        await r.trashBoard({ board: b1.id, from: a.id, by: U, idem: k2 });
        await r.restoreBoard({ board: b1.id, idem: k2 }).then(() => { throw new Error("same key, other call"); }, e => expect(e.code).toMatch(/idem-/));
        const k3 = idemOf("key-trash-0003");
        expect((await r.restoreBoard({ board: b1.id, idem: k3 })).restored).toBe(true);
        await expect(r.restoreBoard({ board: b1.id, idem: k3 })).rejects.toMatchObject({ code: "idem-replay", ref: `${b1.id}:restored` });
      });
      test("a refused trash (moved) writes no key row: the same key works for the right request afterwards", async () => {
        const { a, b, b1 } = await mk();
        const idem = idemOf("key-trash-0004");
        await expect(r.trashBoard({ board: b1.id, from: b.id, by: U, idem })).rejects.toMatchObject({ code: "moved" });
        expect(await r.idemGet(idem)).toEqual({ state: "none" });
        expect((await r.trashBoard({ board: b1.id, from: a.id, by: U, idem })).trashed).toBe(true);
      });
      test("space keys: trashSpace and restoreSpace replay with their own refs", async () => {
        const { a } = await mk();
        const k1 = idemOf("key-trash-0005"), k2 = idemOf("key-trash-0006");
        await r.trashSpace({ space: a.id, by: U, idem: k1 });
        await expect(r.trashSpace({ space: a.id, by: U, idem: k1 })).rejects.toMatchObject({ code: "idem-replay", ref: expect.stringMatching(new RegExp(`^${a.id}:trashed:\\d+$`)) });
        await r.restoreSpace({ space: a.id, idem: k2 });
        await expect(r.restoreSpace({ space: a.id, idem: k2 })).rejects.toMatchObject({ code: "idem-replay", ref: expect.stringMatching(new RegExp(`^${a.id}:restored:\\d+$`)) });
      });
      test("concurrent trash and restore of one board: the board ends in one consistent state, each caller gets success or a coded refusal", async () => {
        const { a, b1 } = await mk();
        await r.trashBoard({ board: b1.id, from: a.id, by: U });
        const out = await Promise.allSettled([r.restoreBoard({ board: b1.id }), r.restoreBoard({ board: b1.id }), r.trashBoard({ board: b1.id, from: a.id, by: U })]);
        for (const o of out) if (o.status === "rejected") throw o.reason;   // none of the three can fail: restore of a restored board and trash of a trashed one are no-ops
        const row = await r.board(b1.id);
        expect(row.trashedAt === null ? row.trashedBy === null : row.trashedBy === U).toBe(true);
      });
      test("trashedBoards / trashedSpaces list the Unit's Trash by id, pages, and leave out boards that went with a Space", async () => {
        const { t, a, b, b1, b2 } = await mk();
        const other = await r.createTenant({ domain: "other.com" });
        const os = await r.createSpace({ tenant: other.id, name: "O", owner: "dev:z" });
        const ob = await r.createBoard({ tenant: other.id, space: os.id, owner: "dev:z" });
        await r.trashBoard({ board: ob.id, from: os.id, by: "dev:z" });
        await r.trashBoard({ board: b1.id, from: a.id, by: U });
        await r.trashSpace({ space: b.id, by: U });
        const x = await r.createBoard({ tenant: t.id, space: b.id, owner: U }).catch(() => null);   // refused: the Space is in Trash
        expect(x).toBe(null);
        expect((await r.trashedBoards(t.id)).boards.map(x => x.id)).toEqual([b1.id]);
        const withSpace = await r.createSpace({ tenant: t.id, name: "W", owner: U });
        const w = await r.createBoard({ tenant: t.id, space: withSpace.id, owner: U });
        await r.trashSpace({ space: withSpace.id, by: U });
        expect((await r.trashedBoards(t.id)).boards.map(x => x.id)).toEqual([b1.id]);   // w went with its Space: not listed
        const sp = (await r.trashedSpaces(t.id)).spaces;
        expect(sp.map(s => s.id).sort()).toEqual([b.id, withSpace.id].sort());
        expect(sp.find(s => s.id === withSpace.id)).toMatchObject({ boards: 1, trashedBy: U });
        expect(w.id).toBeTruthy();
        await r.trashBoard({ board: b2.id, from: a.id, by: U });
        const p1 = await r.trashedBoards(t.id, { limit: 1 });
        expect(p1.boards).toHaveLength(1); expect(p1.next).toBe(p1.boards[0].id);
        const p2 = await r.trashedBoards(t.id, { limit: 1, after: p1.next });
        expect([p1.boards[0].id, p2.boards[0].id].sort()).toEqual([b1.id, b2.id].sort()); expect(p2.next).toBe(null);
        await expect(r.trashedBoards(t.id, { after: "bad\ncursor" })).rejects.toThrow(/bad cursor/);
        expect((await r.trashedBoards(other.id)).boards.map(x => x.id)).toEqual([ob.id]);
      });
      test("trashDue lists what has been in Trash since `before` or earlier, oldest first, bounded; claimed rows always", async () => {
        const { a, b, b1, b2 } = await mk();
        await r.trashBoard({ board: b1.id, from: a.id, by: U });
        clock.t += DAY;
        await r.trashBoard({ board: b2.id, from: a.id, by: U });
        clock.t += DAY;
        await r.trashSpace({ space: b.id, by: U });
        expect((await r.trashDue({ before: T0 - 1 })).boards).toEqual([]);
        expect((await r.trashDue({ before: T0 })).boards.map(x => x.id)).toEqual([b1.id]);
        const all = await r.trashDue({ before: clock.t });
        expect(all.boards.map(x => x.id)).toEqual([b1.id, b2.id]); expect(all.spaces.map(x => x.id)).toEqual([b.id]);
        expect((await r.trashDue({ before: clock.t, limit: 1 })).boards).toHaveLength(1);
        await expect(r.trashDue({ before: "x" })).rejects.toThrow(/bad time/);
        expect(await r.purgeClaim({ type: "board", id: b2.id, before: T0 })).toBe(false);   // not due yet
        expect(await r.purgeClaim({ type: "board", id: b2.id, before: T0 + DAY })).toBe(true);
        expect((await r.trashDue({ before: T0 })).boards.map(x => x.id).sort()).toEqual([b1.id, b2.id].sort());   // claimed: listed whatever `before` says
      });
      test("purgeClaim: only a board in Trash and past its time, idempotent; from then on restore is refused (purged) and the Trash list drops it", async () => {
        const { t, a, b1, b2 } = await mk();
        expect(await r.purgeClaim({ type: "board", id: b1.id, before: clock.t + DAY })).toBe(false);   // live
        expect(await r.purgeClaim({ type: "board", id: "b-nope0000000000", before: clock.t + DAY })).toBe(false);
        await r.trashBoard({ board: b1.id, from: a.id, by: U });
        expect(await r.purgeClaim({ type: "board", id: b1.id, before: clock.t - 1 })).toBe(false);
        expect(await r.purgeClaim({ type: "board", id: b1.id, before: clock.t })).toBe(true);
        expect(await r.purgeClaim({ type: "board", id: b1.id, before: 0 })).toBe(true);   // already claimed: stays true
        await expect(r.restoreBoard({ board: b1.id })).rejects.toMatchObject({ code: "purged" });
        expect((await r.trashedBoards(t.id)).boards).toEqual([]);
        expect((await r.board(b1.id)).trashedAt).not.toBe(null);
        await expect(r.purgeClaim({ type: "group", id: b2.id, before: 1 })).rejects.toThrow(/bad purge/);
      });
      test("purgeBoard deletes a CLAIMED board's rows only, is idempotent, and a partial purge resumes", async () => {
        const { t, a, b1, b2 } = await mk();
        await r.setGrant(b1.id, "dev:bo", "editor");
        await r.createInvite({ board: b1.id, email: "x@y.com", role: "viewer", by: U });
        const lk = await r.createLink({ board: b1.id, role: "viewer", by: U });
        await r.addLinkUse(lk.id, "dev:cy");
        await r.markOpened("dev:bo", b1.id); await r.setStarred("dev:bo", b1.id, true);
        await r.setScopedGrant({ scope: { type: "board", id: b1.id }, subject: { type: "team", id: (await r.createTeam({ tenant: t.id, name: "tm" })).id }, role: "viewer" });
        await r.trashBoard({ board: b1.id, from: a.id, by: U });
        expect(await r.purgeBoard(b1.id)).toBe(false);          // not claimed: nothing happens
        expect(await r.board(b1.id)).not.toBe(null); expect(await r.grants(b1.id)).toHaveLength(2);
        await r.purgeClaim({ type: "board", id: b1.id, before: clock.t });
        expect(await r.purgeBoard(b1.id)).toBe(true);
        expect(await r.board(b1.id)).toBe(null);
        expect(await r.grants(b1.id)).toEqual([]); expect(await r.invites(b1.id)).toEqual([]); expect(await r.links(b1.id)).toEqual([]);
        expect(await r.link(lk.id)).toBe(null); expect(await r.linkUses(b1.id, "dev:cy")).toEqual([]);
        expect(await r.recents("dev:bo")).toEqual([]); expect(await r.starred("dev:bo")).toEqual([]);
        expect(await r.accessContext({ type: "board", id: b1.id })).toBe(null);
        expect(await r.purgeBoard(b1.id)).toBe(true);           // gone already: done
        expect((await r.boardsIn({ type: "space", id: a.id }, { withTrashed: true })).ids).toEqual([b2.id]);   // the neighbour is untouched
        expect(await r.grants(b2.id)).toHaveLength(1);
      });
      test("purgeClaim of a Space claims the boards that went with it; purgeSpace waits for them, then removes the Space and its grants", async () => {
        const { t, a, b, b1, b2 } = await mk();
        await r.trashBoard({ board: b2.id, from: a.id, by: U });
        clock.t += DAY;
        await r.trashSpace({ space: a.id, by: U });
        await r.createInvite({ board: b1.id, email: "q@y.com", role: "viewer", by: U });
        expect(await r.purgeSpace(a.id)).toBe(false);                 // not claimed
        expect(await r.purgeClaim({ type: "space", id: a.id, before: clock.t })).toBe(true);
        expect((await r.trashDue({ before: 0 })).boards.map(x => x.id)).toEqual([b1.id]);   // b1 went with the Space: claimed with it; b2 (own clock, not due at `before`) is not
        expect(await r.purgeSpace(a.id)).toBe(false);                 // boards still reference it
        expect(await r.purgeBoard(b1.id)).toBe(true);
        expect(await r.purgeSpace(a.id)).toBe(false);                 // b2 is still there
        await r.purgeClaim({ type: "board", id: b2.id, before: clock.t });
        expect(await r.purgeBoard(b2.id)).toBe(true);
        expect(await r.purgeSpace(a.id)).toBe(true);
        expect(await r.space(a.id)).toBe(null);
        expect(await r.accessContext({ type: "space", id: a.id })).toBe(null);
        expect(await r.purgeSpace(a.id)).toBe(true);
        expect((await r.space(b.id)).id).toBe(b.id);                  // another Space untouched
        expect((await r.spaces(t.id)).map(s => s.id)).toContain(b.id);
      });
      test("a claimed Space cannot be restored (purged)", async () => {
        const { a } = await mk();
        await r.trashSpace({ space: a.id, by: U });
        await r.purgeClaim({ type: "space", id: a.id, before: clock.t });
        await expect(r.restoreSpace({ space: a.id })).rejects.toMatchObject({ code: "purged" });
      });
      test("a board that went to Trash with its Space is claimed ONLY with its Space; a restored Space's boards are never deleted (reviewer P1)", async () => {
        const { a, b1, b2 } = await mk();
        await r.trashSpace({ space: a.id, by: U });
        clock.t += 31 * DAY;
        expect(await r.purgeClaim({ type: "board", id: b1.id, before: clock.t })).toBe(false);   // alone: refused
        expect((await r.trashDue({ before: clock.t, claimed: false })).boards).toEqual([]);      // not offered as unclaimed work either
        expect((await r.restoreSpace({ space: a.id })).boards).toBe(2);
        expect(await r.purgeBoard(b1.id)).toBe(false);                                           // never claimed, and live
        expect(await r.board(b1.id)).toMatchObject({ trashedAt: null });
        expect(await r.board(b2.id)).not.toBe(null);
      });
      test("a Space claim claims its boards together; restoreSpace is then refused (purged) and no board loses its claim half-way; purgeBoard also needs the board in Trash", async () => {
        const { a, b1, b2 } = await mk();
        await r.trashSpace({ space: a.id, by: U });
        expect(await r.purgeClaim({ type: "space", id: a.id, before: clock.t })).toBe(true);
        expect(await r.purgeClaim({ type: "board", id: b1.id, before: clock.t })).toBe(true);    // already claimed by its Space: idempotent
        await expect(r.restoreSpace({ space: a.id })).rejects.toMatchObject({ code: "purged" });
        await expect(r.restoreBoard({ board: b1.id })).rejects.toMatchObject({ code: "purged" });
        expect(await r.purgeBoard(b1.id)).toBe(true);
        expect(await r.board(b1.id)).toBe(null); expect(await r.board(b2.id)).not.toBe(null);
        expect(await r.purgeBoard("b-nope000000000")).toBe(true);
      });
      test("every restore path clears the purge claim: a restored board is not due and is trashable again with a fresh clock", async () => {
        const { a, b1 } = await mk();
        await r.trashBoard({ board: b1.id, from: a.id, by: U });
        await r.restoreBoard({ board: b1.id });
        clock.t += 31 * DAY;
        await r.trashBoard({ board: b1.id, from: a.id, by: U });
        expect((await r.trashDue({ before: clock.t - DAY })).boards).toEqual([]);                // trashed just now: not due, not claimed
        expect(await r.purgeClaim({ type: "board", id: b1.id, before: clock.t - DAY })).toBe(false);
        expect((await r.restoreBoard({ board: b1.id })).restored).toBe(true);
      });
      test("restoreBoard into: a board whose own Space is in Trash moves into the given live Space of the Unit as it is restored; a trashed or foreign Space is refused", async () => {
        const { t, a, b, b1 } = await mk();
        await r.trashBoard({ board: b1.id, from: a.id, by: U });
        await r.trashSpace({ space: a.id, by: U });
        const other = await r.createTenant({ domain: "globex.com" });
        const foreign = await r.createSpace({ tenant: other.id, name: "F", owner: U });
        await expect(r.restoreBoard({ board: b1.id, into: foreign.id })).rejects.toThrow(/no such space/);
        await expect(r.restoreBoard({ board: b1.id, into: a.id })).rejects.toThrow(/no such space/);
        await expect(r.restoreBoard({ board: b1.id })).rejects.toMatchObject({ code: "space-in-trash" });
        expect(await r.restoreBoard({ board: b1.id, into: b.id })).toMatchObject({ restored: true, board: { id: b1.id, space: b.id, trashedAt: null } });
        expect((await r.boardsIn({ type: "space", id: b.id })).ids).toEqual([b1.id]);
        expect(t.id).toBe((await r.board(b1.id)).tenant);
      });
      test("trashDue claimed:false lists due unclaimed own-clock rows; claimed:true pages the claimed rows by id after a cursor", async () => {
        const { t, a, b, b1, b2 } = await mk();
        const c1 = await r.createBoard({ tenant: t.id, title: "three", space: b.id, owner: U });
        await r.trashBoard({ board: c1.id, from: b.id, by: U });
        await r.trashSpace({ space: a.id, by: U });
        clock.t += 31 * DAY;
        const un = await r.trashDue({ before: clock.t, claimed: false });
        expect([un.boards.map(x => x.id), un.spaces.map(x => x.id)]).toEqual([[c1.id], [a.id]]);   // b1, b2 follow their Space
        await r.purgeClaim({ type: "space", id: a.id, before: clock.t }); await r.purgeClaim({ type: "board", id: c1.id, before: clock.t });
        expect(await r.trashDue({ before: clock.t, claimed: false })).toEqual({ boards: [], spaces: [] });
        const all = (await r.trashDue({ before: clock.t, claimed: true })).boards.map(x => x.id);
        expect(all.sort()).toEqual([b1.id, b2.id, c1.id].sort());
        const first = (await r.trashDue({ before: clock.t, claimed: true, limit: 1 })).boards[0].id;
        const next = (await r.trashDue({ before: clock.t, claimed: true, limit: 1, after: { board: first } })).boards[0].id;
        expect(next > first).toBe(true);
        expect((await r.trashDue({ before: clock.t, claimed: true, after: { board: all.sort().at(-1) } })).boards).toEqual([]);
        expect((await r.trashDue({ before: clock.t, claimed: true })).spaces.map(x => x.id)).toEqual([a.id]);
      });
      test("personalSpace is a pure read: null until ensurePersonalSpace creates it, then the same Space", async () => {
        const { t } = await mk();
        expect(await r.personalSpace(t.id, "dev:newcomer")).toBe(null);
        expect(await r.personalSpace(t.id, "dev:newcomer")).toBe(null);          // reading again still creates nothing
        const made = await r.ensurePersonalSpace(t.id, "dev:newcomer");
        expect(await r.personalSpace(t.id, "dev:newcomer")).toMatchObject({ id: made.id, kind: "personal", owner: "dev:newcomer" });
        expect(await r.personalSpace("t-nope00000000", "dev:newcomer")).toBe(null);
      });
      test("keyed Space calls store their board count in the ref", async () => {
        const { a } = await mk();
        await r.trashSpace({ space: a.id, by: U, idem: idemOf("key-space-tr-1") });
        expect((await r.idemGet(idemOf("key-space-tr-1"))).ref).toBe(`${a.id}:trashed:2`);
        await r.restoreSpace({ space: a.id, idem: idemOf("key-space-rs-1") });
        expect((await r.idemGet(idemOf("key-space-rs-1"))).ref).toBe(`${a.id}:restored:2`);
      });
    });

    // ---- moveBoard (PROTOCOL.md § Move board): one atomic compare-and-set of the board's Space ----
    describe("moveBoard", () => {
      const U = "dev:ada";
      const mk = async () => {
        const t = await r.createTenant({ domain: "acme.com" });
        const g = await r.createGroup({ tenant: t.id, name: "G" });
        const a = await r.createSpace({ tenant: t.id, name: "A", owner: U }), b = await r.createSpace({ tenant: t.id, name: "B", group: g.id, owner: U }), c = await r.createSpace({ tenant: t.id, name: "C", owner: U });
        const board = await r.createBoard({ tenant: t.id, title: "T", space: a.id, owner: U });
        return { t, g, a, b, c, board };
      };
      test("moves from the expected Space; the board and its context follow; grants, invites and links stay", async () => {
        const { a, b, g, board } = await mk();
        await r.setGrant(board.id, "dev:bo", "editor");
        const inv = await r.createInvite({ board: board.id, email: "x@y.com", role: "viewer", by: U });
        const lk = await r.createLink({ board: board.id, role: "viewer", by: U });
        const out = await r.moveBoard({ board: board.id, from: a.id, to: b.id });
        expect(out.moved).toBe(true);
        expect(out.board).toMatchObject({ id: board.id, space: b.id, title: "T" });
        expect((await r.board(board.id)).space).toBe(b.id);
        const ctx = await r.accessContext({ type: "board", id: board.id });
        expect(ctx.space.id).toBe(b.id); expect(ctx.group.id).toBe(g.id);
        expect((await r.boardsIn({ type: "space", id: b.id })).ids).toEqual([board.id]);
        expect((await r.boardsIn({ type: "space", id: a.id })).ids).toEqual([]);
        expect(await sorted(board.id)).toEqual([{ user: "dev:ada", role: "owner" }, { user: "dev:bo", role: "editor" }]);
        expect((await r.invite(inv.id)).revoked).toBe(false); expect((await r.link(lk.id)).board).toBe(board.id);
      });
      test("`from` is required (every board has a Space): null, undefined or a non-string rejects \"no such space\" and changes nothing", async () => {
        const { a, b, board } = await mk();
        for (const from of [null, undefined, 5]) await expect(r.moveBoard({ board: board.id, ...(from === undefined ? {} : { from }), to: b.id })).rejects.toThrow(/no such space/);
        expect((await r.board(board.id)).space).toBe(a.id);
      });
      test("already in `to` is a no-op success (moved: false), whatever `from` says", async () => {
        const { a, b, board } = await mk();
        await r.moveBoard({ board: board.id, from: a.id, to: b.id });
        expect(await r.moveBoard({ board: board.id, from: a.id, to: b.id })).toMatchObject({ moved: false, board: { space: b.id } });
        expect((await r.moveBoard({ board: board.id, from: "s-nope00000000", to: b.id })).moved).toBe(false);
      });
      test("a board in neither `from` nor `to` rejects code moved and changes nothing", async () => {
        const { a, b, c, board } = await mk();
        await expect(r.moveBoard({ board: board.id, from: b.id, to: c.id })).rejects.toMatchObject({ code: "moved" });
        await expect(r.moveBoard({ board: board.id, from: "s-nope00000000", to: c.id })).rejects.toMatchObject({ code: "moved" });
        expect((await r.board(board.id)).space).toBe(a.id);
      });
      test("unknown board, unknown Space and another Unit's Space reject", async () => {
        const { a, board } = await mk();
        const t2 = await r.createTenant({ domain: "other.com" });
        const foreign = await r.createSpace({ tenant: t2.id, name: "F", owner: "dev:z" });
        await expect(r.moveBoard({ board: "b-nope0000000000", from: a.id, to: a.id })).rejects.toThrow(/no such board/);
        await expect(r.moveBoard({ board: board.id, from: a.id, to: "s-nope00000000" })).rejects.toThrow(/no such space/);
        await expect(r.moveBoard({ board: board.id, from: a.id, to: foreign.id })).rejects.toThrow(/no such space/);
        expect((await r.board(board.id)).space).toBe(a.id);
      });
      test("concurrent moves to different Spaces: exactly one wins, the other is moved; the board ends in the winner's", async () => {
        const { a, b, c, board } = await mk();
        const out = await Promise.allSettled([r.moveBoard({ board: board.id, from: a.id, to: b.id }), r.moveBoard({ board: board.id, from: a.id, to: c.id })]);
        expect(out.filter(o => o.status === "fulfilled").length).toBe(1);
        const lost = out.find(o => o.status === "rejected");
        expect(lost.reason).toMatchObject({ code: "moved" });
        const won = out.find(o => o.status === "fulfilled").value;
        expect((await r.board(board.id)).space).toBe(won.board.space);
      });
      test("concurrent identical moves: both succeed, one moved", async () => {
        const { a, b, board } = await mk();
        const out = await Promise.all(Array.from({ length: 6 }, () => r.moveBoard({ board: board.id, from: a.id, to: b.id })));
        expect(out.filter(o => o.moved).length).toBe(1);
        expect((await r.board(board.id)).space).toBe(b.id);
      });
      test("a keyed move writes its key in the same step: a repeat rejects idem-replay naming the board and moves nothing; another body is idem-mismatch", async () => {
        const { a, b, board } = await mk();
        const idem = { user: U, key: "move-key-0001", fp: "a".repeat(64) };
        await r.moveBoard({ board: board.id, from: a.id, to: b.id, idem });
        expect(await r.idemGet(idem)).toEqual({ state: "done", ref: `${board.id}:moved` });
        await r.moveBoard({ board: board.id, from: b.id, to: a.id });   // back again, with no key
        await expect(r.moveBoard({ board: board.id, from: a.id, to: b.id, idem })).rejects.toMatchObject({ code: "idem-replay", ref: `${board.id}:moved` });
        expect((await r.board(board.id)).space).toBe(a.id);
        await expect(r.moveBoard({ board: board.id, from: a.id, to: b.id, idem: { ...idem, fp: "b".repeat(64) } })).rejects.toMatchObject({ code: "idem-mismatch" });
      });
      test("a keyed no-op move stores `:noop`, so a replay can report the real flag", async () => {
        const { a, b, board } = await mk();
        await r.moveBoard({ board: board.id, from: a.id, to: b.id });
        const idem = { user: U, key: "move-key-0003", fp: "d".repeat(64) };
        expect((await r.moveBoard({ board: board.id, from: a.id, to: b.id, idem })).moved).toBe(false);
        expect(await r.idemGet(idem)).toEqual({ state: "done", ref: `${board.id}:noop` });
      });
      test("a refused keyed move leaves no key behind (the retry runs fresh)", async () => {
        const { a, b, c, board } = await mk();
        const idem = { user: U, key: "move-key-0002", fp: "c".repeat(64) };
        await expect(r.moveBoard({ board: board.id, from: b.id, to: c.id, idem })).rejects.toMatchObject({ code: "moved" });
        expect(await r.idemGet(idem)).toEqual({ state: "none" });
        expect((await r.moveBoard({ board: board.id, from: a.id, to: c.id, idem })).moved).toBe(true);
      });
    });

    // ---- Leaver offboarding (PROTOCOL.md § Leaver offboarding, #55) ----
    describe("leaver offboarding: ownedAlone, reassignOwner, removeMember", () => {
      const SAM = "google:sam", ADA = "google:ada", BOB = "google:bob", HAND = { to: ADA, name: "x" };
      const setup = async () => {
        const t = await r.createTenant({ domain: "acme.com", admins: ["google:root"] });
        for (const u of [SAM, ADA, BOB, "google:root"]) await r.touchMember(t.id, { user: u, name: u.slice(7), email: u.slice(7) + "@acme.com" });
        return t;
      };
      const keys = async (t, u = SAM) => (await r.ownedAlone(t.id, u)).items.map(i => `${i.type}:${i.id}`).sort();

      test("ownedAlone lists the personal space (always), Groups and Spaces whose only counted owner is the user (trashed too), and not shared ones", async () => {
        const t = await setup();
        const mine = await r.ensurePersonalSpace(t.id, SAM);
        const solo = await r.createSpace({ tenant: t.id, name: "Field notes", owner: SAM });
        const grp = await r.createGroup({ tenant: t.id, name: "G", owner: SAM });
        const shared = await r.createSpace({ tenant: t.id, name: "Shared", owner: SAM });
        await r.setScopedGrant({ scope: { type: "space", id: shared.id }, subject: { type: "user", id: ADA }, role: "owner" });
        const gone = await r.createSpace({ tenant: t.id, name: "Old", owner: SAM });
        await r.trashSpace({ space: gone.id, by: SAM });
        const items = (await r.ownedAlone(t.id, SAM)).items;
        expect(items.map(i => i.id).sort()).toEqual([mine.id, solo.id, grp.id, gone.id].sort());
        expect(items.find(i => i.id === mine.id).personal).toBe(true);
        expect(items.find(i => i.id === solo.id).personal).toBe(false);
        expect(await keys(t, ADA)).toEqual([`space:${(await r.personalSpace(t.id, ADA))?.id}`].filter(x => !x.endsWith("undefined")).concat([]));
      });
      test("a Team owner counts only with a member besides the user; the user alone in a Team that owns a Space still solely owns it", async () => {
        const t = await setup();
        const sp = await r.createSpace({ tenant: t.id, name: "TeamOwned" });
        const team = await r.createTeam({ tenant: t.id, name: "T" });
        await r.setTeamMember(team.id, SAM, true);
        await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "team", id: team.id }, role: "owner" });
        expect(await keys(t)).toContain(`space:${sp.id}`);
        await r.setTeamMember(team.id, BOB, true);
        expect(await keys(t)).not.toContain(`space:${sp.id}`);
      });
      test("paging: a page of one, then the cursor continues, a malformed cursor is refused", async () => {
        const t = await setup();
        for (let i = 0; i < 3; i++) await r.createSpace({ tenant: t.id, name: "S" + i, owner: SAM });
        const seen = []; let after = null;
        do { const p = await r.ownedAlone(t.id, SAM, { after, limit: 1 }); seen.push(...p.items.map(i => i.id)); after = p.next; } while (after);
        expect(new Set(seen).size).toBe(3);
        await expect(r.ownedAlone(t.id, SAM, { after: "nonsense" })).rejects.toThrow();
      });
      test("reassignOwner: the recipient becomes owner and the leaver's grant goes in one step; a second call is a no-op", async () => {
        const t = await setup();
        const sp = await r.createSpace({ tenant: t.id, name: "S", owner: SAM });
        expect(await r.reassignOwner({ scope: { type: "space", id: sp.id }, from: SAM, to: ADA })).toEqual({ done: true });
        expect(await r.scopedGrant({ type: "space", id: sp.id }, { type: "user", id: ADA })).toBe("owner");
        expect(await r.scopedGrant({ type: "space", id: sp.id }, { type: "user", id: SAM })).toBe(null);
        expect(await r.reassignOwner({ scope: { type: "space", id: sp.id }, from: SAM, to: BOB })).toEqual({ done: false });
        expect(await r.scopedGrant({ type: "space", id: sp.id }, { type: "user", id: BOB })).toBe(null);
      });
      test("reassignOwner does nothing once the item is shared with another owner (compare-and-set)", async () => {
        const t = await setup();
        const sp = await r.createSpace({ tenant: t.id, name: "S", owner: SAM });
        await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "user", id: ADA }, role: "owner" });
        expect((await r.reassignOwner({ scope: { type: "space", id: sp.id }, from: SAM, to: BOB })).done).toBe(false);
        expect(await r.scopedGrant({ type: "space", id: sp.id }, { type: "user", id: SAM })).toBe("owner");
      });
      test("reassignOwner of a Team-held Space adds the recipient and keeps the Team", async () => {
        const t = await setup();
        const sp = await r.createSpace({ tenant: t.id, name: "S" });
        const team = await r.createTeam({ tenant: t.id, name: "T" });
        await r.setTeamMember(team.id, SAM, true);
        await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "team", id: team.id }, role: "owner" });
        expect((await r.reassignOwner({ scope: { type: "space", id: sp.id }, from: SAM, to: ADA })).done).toBe(true);
        expect(await r.scopedGrant({ type: "space", id: sp.id }, { type: "team", id: team.id })).toBe("owner");
        expect(await r.scopedGrant({ type: "space", id: sp.id }, { type: "user", id: ADA })).toBe("owner");
      });
      test("a personal space is handed over only WITH the removal: reassignOwner refuses it (personal), removeMember with a handover makes it an archived shared Space owned by the recipient, its boards, grants, invites and links untouched", async () => {
        const t = await setup();
        const mine = await r.ensurePersonalSpace(t.id, SAM);
        const b = await mkBoard(r, { tenant: t.id, title: "Private", space: mine.id, owner: SAM });
        await r.setGrant(b.id, "google:guest", "editor");
        const inv = await r.createInvite({ board: b.id, email: "k@x.io", role: "viewer", by: SAM });
        const link = await r.createLink({ board: b.id, role: "viewer", by: SAM });
        await expect(r.reassignOwner({ scope: { type: "space", id: mine.id }, from: SAM, to: ADA, name: "x" })).rejects.toMatchObject({ code: "personal" });
        expect((await r.space(mine.id)).kind).toBe("personal");
        await expect(r.removeMember({ tenant: t.id, user: SAM, by: ADA })).rejects.toMatchObject({ code: "still-owns" });
        await expect(r.removeMember({ tenant: t.id, user: SAM, by: ADA, handover: { to: SAM, name: "x" } })).rejects.toMatchObject({ code: "bad-recipient" });
        expect((await r.space(mine.id)).kind).toBe("personal");                                 // a refusal rolled the handover back
        expect(await r.removeMember({ tenant: t.id, user: SAM, by: ADA, handover: { to: ADA, name: "Sam's space (archived)" } })).toMatchObject({ removed: true, handedOver: true });
        const sp = await r.space(mine.id);
        expect(sp).toMatchObject({ kind: "shared", owner: null, name: "Sam's space (archived)", generalRole: null });
        expect(sp.archivedAt).toBe(T0);
        expect(await r.personalSpace(t.id, SAM)).toBe(null);
        expect((await r.board(b.id)).space).toBe(mine.id);
        expect(await r.grant(b.id, "google:guest")).toBe("editor");
        expect((await r.invite(inv.id)).revoked).toBe(false);                                   // made BY the leaver: stays
        expect((await r.link(link.id)).revoked).toBe(false);
        expect(await r.scopedGrant({ type: "space", id: mine.id }, { type: "user", id: ADA })).toBe("owner");
      });
      test("removal revokes invites addressed to the leaver's email on this Unit's boards (any case), not other people's, not another Unit's, not ones they created", async () => {
        const t = await setup();
        const other = await r.createTenant({ domain: "other.com" });
        const sp = await r.createSpace({ tenant: t.id, name: "S", owner: ADA });
        const b = await mkBoard(r, { tenant: t.id, title: "B", space: sp.id, owner: ADA });
        const ob = await mkBoard(r, { tenant: other.id, title: "O", owner: "google:x" });
        const mine = await r.createInvite({ board: b.id, email: "Sam@Acme.com", role: "viewer", by: ADA });
        const bobs = await r.createInvite({ board: b.id, email: "bob@acme.com", role: "viewer", by: ADA });
        const made = await r.createInvite({ board: b.id, email: "lee@x.io", role: "viewer", by: SAM });
        const foreign = await r.createInvite({ board: ob.id, email: "sam@acme.com", role: "viewer", by: "google:x" });
        await mkPersonalDone();
        expect((await r.removeMember({ tenant: t.id, user: SAM, by: ADA, handover: HAND })).invites).toBe(1);
        expect((await r.invite(mine.id)).revoked).toBe(true);
        for (const i of [bobs, made, foreign]) expect((await r.invite(i.id)).revoked).toBe(false);
      });
      test("a person the Unit removed cannot be given a grant or Team seat afterwards (removed), and a grant racing the removal never leaves a row naming them", async () => {
        const t = await setup();
        const sp = await r.createSpace({ tenant: t.id, name: "S", owner: ADA });
        const team = await r.createTeam({ tenant: t.id, name: "T" });
        const rs = await Promise.allSettled([r.removeMember({ tenant: t.id, user: SAM, by: ADA, handover: HAND }),
          r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "user", id: SAM }, role: "owner" }), r.setTeamMember(team.id, SAM, true)]);
        expect(rs[0].status).toBe("fulfilled");
        const removed = (await r.memberState(t.id, SAM)).removed;
        expect(removed).toBe(true);
        expect(await r.scopedGrant({ type: "space", id: sp.id }, { type: "user", id: SAM })).toBe(null);
        expect(await r.teamMembers(team.id)).toEqual([]);
        await expect(r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "user", id: SAM }, role: "editor" })).rejects.toMatchObject({ code: "removed" });
        await expect(r.setTeamMember(team.id, SAM, true)).rejects.toMatchObject({ code: "removed" });
        await r.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "user", id: SAM }, role: null });   // clearing is always fine
      });
      test("reassignOwner refuses a recipient who is the leaver, not in the directory or removed (bad-recipient), changing nothing", async () => {
        const t = await setup();
        const sp = await r.createSpace({ tenant: t.id, name: "S", owner: SAM });
        const sp2 = await r.createSpace({ tenant: t.id, name: "S2", owner: BOB });
        for (const to of [SAM, "google:nobody"]) await expect(r.reassignOwner({ scope: { type: "space", id: sp.id }, from: SAM, to })).rejects.toMatchObject({ code: "bad-recipient" });
        await r.reassignOwner({ scope: { type: "space", id: sp2.id }, from: BOB, to: ADA });
        await r.removeMember({ tenant: t.id, user: BOB, by: ADA, handover: HAND });
        await expect(r.reassignOwner({ scope: { type: "space", id: sp.id }, from: SAM, to: BOB })).rejects.toMatchObject({ code: "bad-recipient" });
        expect(await r.scopedGrant({ type: "space", id: sp.id }, { type: "user", id: SAM })).toBe("owner");
      });
      test("removeMember refuses while the user solely owns something (still-owns) and changes nothing; an admin is refused (is-admin)", async () => {
        const t = await setup();
        const sp = await r.createSpace({ tenant: t.id, name: "S", owner: SAM });
        await expect(r.removeMember({ tenant: t.id, user: SAM, by: ADA, handover: HAND })).rejects.toMatchObject({ code: "still-owns" });
        expect((await r.memberState(t.id, SAM)).removed).toBe(false);
        expect(await r.scopedGrant({ type: "space", id: sp.id }, { type: "user", id: SAM })).toBe("owner");
        await expect(r.removeMember({ tenant: t.id, user: "google:root", by: ADA, handover: HAND })).rejects.toMatchObject({ code: "is-admin" });
        await expect(r.removeMember({ tenant: t.id, user: "google:nobody", by: ADA, handover: HAND })).rejects.toThrow();
      });
      test("an admin named by an email: entry is refused too (is-admin), whatever the case of the address; nothing changes", async () => {
        const t = await setup();
        await r.touchMember(t.id, { user: "google:eve", name: "Eve", email: "Eve@Acme.com" });
        await r.addTenantAdmin(t.id, "email:eve@acme.com");
        await expect(r.removeMember({ tenant: t.id, user: "google:eve", by: ADA, handover: HAND })).rejects.toMatchObject({ code: "is-admin" });
        expect((await r.memberState(t.id, "google:eve")).removed).toBe(false);
      });
      test("removeMember marks the member and deletes their board grants, scoped grants, Team memberships and access requests, only in this Unit; guests' rows and others' stay", async () => {
        const t = await setup();
        const other = await r.createTenant({ domain: "other.com" });
        const shared = await r.createSpace({ tenant: t.id, name: "Shared", owner: ADA });
        await r.setScopedGrant({ scope: { type: "space", id: shared.id }, subject: { type: "user", id: SAM }, role: "editor" });
        const b = await mkBoard(r, { tenant: t.id, title: "B", space: shared.id, owner: SAM });
        await r.setGrant(b.id, ADA, "owner");
        const ob = await mkBoard(r, { tenant: other.id, title: "O", owner: "google:x" });
        await r.setGrant(ob.id, SAM, "viewer");          // Sam as a guest in another Unit
        const team = await r.createTeam({ tenant: t.id, name: "T" });
        await r.setTeamMember(team.id, SAM, true); await r.setTeamMember(team.id, ADA, true);
        await r.requestAccess({ tenant: t.id, scope: { type: "space", id: shared.id }, user: SAM, role: "editor" });
        const mine = await r.ensurePersonalSpace(t.id, SAM);
        clock.t += 1000;
        const out = await r.removeMember({ tenant: t.id, user: SAM, by: ADA, handover: HAND });
        expect(out).toMatchObject({ removed: true, teams: 1 });
        expect(out.grants).toBe(1); expect(out.scopedGrants).toBe(2);   // the editor grant and his own owner grant on the personal space he handed over
        expect(await r.memberState(t.id, SAM)).toMatchObject({ removed: true, removedAt: T0 + 1000, removedBy: ADA });
        expect(await r.grant(b.id, SAM)).toBe(null);
        expect(await r.grant(b.id, ADA)).toBe("owner");
        expect(await r.grant(ob.id, SAM)).toBe("viewer");
        expect(await r.scopedGrant({ type: "space", id: shared.id }, { type: "user", id: SAM })).toBe(null);
        expect(await r.teamMembers(team.id)).toEqual([ADA]);
        expect(await r.accessRequest({ type: "space", id: shared.id }, SAM)).toBe(null);
        expect(await r.removeMember({ tenant: t.id, user: SAM, by: ADA, handover: HAND })).toMatchObject({ removed: false });
      });
      test("a removed member is listed as removed, never found, kept by touchMember, and nothing is created for them", async () => {
        const t = await setup();
        await r.ensurePersonalSpace(t.id, SAM);
        await r.removeMember({ tenant: t.id, user: SAM, by: ADA, handover: HAND });
        expect((await r.membersAmong(t.id, [SAM]))[0]).toMatchObject({ user: SAM, removed: true });
        expect((await r.findMembers(t.id, { q: "sam" })).map(m => m.user)).toEqual([]);
        await r.touchMember(t.id, { user: SAM, name: "Sam 2", email: "sam@acme.com" });
        expect(await r.memberState(t.id, SAM)).toMatchObject({ removed: true, name: "Sam 2" });
        await expect(r.ensurePersonalSpace(t.id, SAM)).rejects.toMatchObject({ code: "removed" });
        await expect(r.createSpace({ tenant: t.id, name: "N", owner: SAM })).rejects.toMatchObject({ code: "removed" });
        await expect(r.createGroup({ tenant: t.id, name: "N", owner: SAM })).rejects.toMatchObject({ code: "removed" });
        expect((await r.spaces(t.id)).filter(s => s.name === "N")).toEqual([]);
      });
      test("accessContext and accessContexts name the removed among the requested users, and only those", async () => {
        const t = await setup();
        const sp = await r.createSpace({ tenant: t.id, name: "S" });
        await r.ensurePersonalSpace(t.id, SAM);
        await r.removeMember({ tenant: t.id, user: SAM, by: ADA, handover: HAND });
        expect((await r.accessContext({ type: "space", id: sp.id }, { users: [SAM, ADA] })).removed).toEqual([SAM]);
        expect((await r.accessContext({ type: "space", id: sp.id }, { users: [ADA] })).removed).toEqual([]);
        expect((await r.accessContext({ type: "space", id: sp.id })).removed).toEqual([]);
        expect((await r.accessContexts([{ type: "space", id: sp.id }, { type: "unit", id: t.id }], { users: [SAM] })).get("unit\n" + t.id).removed).toEqual([SAM]);
      });
      test("keyed: reassignOwner and removeMember write their key with the change; a repeat replays the ref, another fingerprint is a mismatch, a refusal leaves no key", async () => {
        const t = await setup();
        const sp = await r.createSpace({ tenant: t.id, name: "S", owner: SAM });
        const k1 = { user: ADA, key: "leave-key-0001", fp: "a".repeat(64) }, k2 = { user: ADA, key: "leave-key-0002", fp: "b".repeat(64) };
        await expect(r.removeMember({ tenant: t.id, user: SAM, by: ADA, handover: HAND, idem: k2 })).rejects.toMatchObject({ code: "still-owns" });
        expect(await r.idemGet(k2)).toEqual({ state: "none" });
        await r.reassignOwner({ scope: { type: "space", id: sp.id }, from: SAM, to: ADA, idem: k1 });
        expect(await r.idemGet(k1)).toEqual({ state: "done", ref: `${sp.id}:reassigned` });
        await expect(r.reassignOwner({ scope: { type: "space", id: sp.id }, from: SAM, to: ADA, idem: k1 })).rejects.toMatchObject({ code: "idem-replay", ref: `${sp.id}:reassigned` });
        await expect(r.reassignOwner({ scope: { type: "space", id: sp.id }, from: SAM, to: BOB, idem: { ...k1, fp: "c".repeat(64) } })).rejects.toMatchObject({ code: "idem-mismatch" });
        await mkPersonalDone(t);
        await r.removeMember({ tenant: t.id, user: SAM, by: ADA, handover: HAND, idem: k2 });
        expect(await r.idemGet(k2)).toEqual({ state: "done", ref: `${SAM}:removed` });
      });
      const mkPersonalDone = async () => {};
      test("concurrent reassigns of one item: exactly one wins (done true), the other is a no-op; the container always has an owner", async () => {
        const t = await setup();
        const sp = await r.createSpace({ tenant: t.id, name: "S", owner: SAM });
        const rs = await Promise.all([ADA, BOB].map(to => r.reassignOwner({ scope: { type: "space", id: sp.id }, from: SAM, to })));
        expect(rs.filter(x => x.done).length).toBe(1);
        const owners = (await r.scopedGrants({ type: "space", id: sp.id })).filter(g => g.role === "owner").map(g => g.subject.id);
        expect(owners.length).toBe(1);
        expect(owners[0]).not.toBe(SAM);
      });
      test("removal racing a create for the leaver: either the create is refused as removed or the removal as still-owns, never an ownerless Space", async () => {
        const t = await setup();
        await mkPersonalDone(t);
        const results = await Promise.allSettled([r.removeMember({ tenant: t.id, user: SAM, by: ADA, handover: HAND }), r.createSpace({ tenant: t.id, name: "Late", owner: SAM })]);
        const removed = (await r.memberState(t.id, SAM)).removed, late = (await r.spaces(t.id)).find(s => s.name === "Late");
        if (removed) expect(late).toBeUndefined(); else expect(results[0].reason?.code).toBe("still-owns");
        if (late) expect(removed).toBe(false);
      });
    });
  });
}
