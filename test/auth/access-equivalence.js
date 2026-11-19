// `tenancy.accessMany` (the Home batch) must answer exactly what `tenancy.effective` answers board by board: ladder,
// permissions, sources and `until`. Run on every Registry adapter (memory in home.test.js, SQLite in test/server/registry.test.js,
// Postgres in test/server/pg-registry.test.js). A seeded random Unit: Groups and Spaces with general access, user and Team grants
// on Spaces, Groups and boards, custom roles, direct grants, live / expiring / revoked invites and links, a second Unit in the same
// batch, guests and Unit admins; checked with adminBoardContent off and on.
import { test, expect } from "bun:test";
import { tenancy } from "../../server/auth/tenancy.js";

const ROLES = ["viewer", "commenter", "annotator", "editor", "owner"], GENERAL = [null, "viewer", "annotator", "editor"];

/**
 * @param {string} name
 * @param {(o: { now: () => number }) => Promise<import("../../server/auth/registry-port.js").Registry>} makeRegistry
 * @param {{ seeds?: number[], cleanup?: (r: any) => Promise<void>|void }} [o]
 */
export function accessEquivalence(name, makeRegistry, { seeds = [7, 19, 101], cleanup } = {}) {
  for (const seed of seeds) for (const adminBoardContent of [false, true]) {
    test(`accessMany equals effective on a random Unit (${name}, seed ${seed}, adminBoardContent ${adminBoardContent})`, async () => {
      let clock = 1_000_000, s = seed;
      const now = () => clock;
      const rnd = n => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s >>> 4) % n; };
      const pick = a => a[rnd(a.length)];
      const r = await makeRegistry({ now });
      try {
        const ten = tenancy({ registry: r, now, adminBoardContent });
        const acme = await r.createTenant({ domain: "acme.com", domains: ["acme.io"], admins: ["google:root"] });
        const globex = await r.createTenant({ domain: "globex.com" });
        const people = [
          { user: "google:ada", email: "ada@acme.com", domain: "acme.com" }, { user: "google:bob", email: "bob@acme.com", domain: "acme.com" },
          { user: "google:cy", email: "cy@acme.io", domain: "acme.io" }, { user: "google:kim", email: "kim@partner.io", domain: "partner.io" },
          { user: "google:dee", email: "dee@x.org", domain: null }, { user: "google:root", email: "root@acme.com", domain: "acme.com" },
          { user: "google:gus", email: "gus@globex.com", domain: "globex.com" },
        ];
        const custom = [];
        for (const base of ["editor", "viewer"]) custom.push((await r.createRole({ tenant: acme.id, name: `c-${base}`, boardRole: base, permissions: ["move"] })).id);
        const grantable = [...ROLES.slice(0, 4), ...custom];
        const teams = [];
        for (let i = 0; i < 3; i++) { const t = await r.createTeam({ tenant: acme.id, name: `t${i}` }); teams.push(t); for (const p of people) if (rnd(2)) await r.setTeamMember(t.id, p.user, true); }
        const groups = [];
        for (let i = 0; i < 2; i++) groups.push(await r.createGroup({ tenant: acme.id, name: `g${i}`, generalRole: pick(GENERAL) }));
        const spaces = [null];
        for (let i = 0; i < 5; i++) spaces.push((await r.createSpace({ tenant: acme.id, name: `s${i}`, group: pick([null, ...groups.map(g => g.id)]), generalRole: pick(GENERAL) })).id);
        spaces.push((await r.ensurePersonalSpace(acme.id, "google:ada")).id);
        const subj = () => (rnd(2) ? { type: "user", id: pick(people).user } : { type: "team", id: pick(teams).id });
        for (const sp of spaces.slice(1)) if (rnd(2)) await r.setScopedGrant({ scope: { type: "space", id: sp }, subject: subj(), role: pick(grantable) });
        for (const g of groups) { await r.setScopedGrant({ scope: { type: "group", id: g.id }, subject: { type: "user", id: pick(people).user }, role: pick(grantable) }); if (rnd(2)) await r.setScopedGrant({ scope: { type: "group", id: g.id }, subject: { type: "team", id: pick(teams).id }, role: pick(ROLES.slice(0, 4)) }); }
        if (rnd(2)) await r.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: subj(), role: pick(grantable) });
        const boards = [];
        const mkBoard = async (tenant, space) => {
          const b = await r.createBoard({ tenant, title: `b${boards.length}`, ...(space ? { space } : {}), memberRole: pick(GENERAL) });
          boards.push(b);
          for (const p of people) {
            if (rnd(6) === 0) await r.setGrant(b.id, p.user, pick(ROLES));
            if (rnd(8) === 0) await r.createInvite({ board: b.id, email: p.email, role: pick(["viewer", "editor"]), expiresAt: pick([null, clock + 5000, clock + 5000_000]), by: "x" });
            if (rnd(8) === 0) { const l = await r.createLink({ board: b.id, role: pick(["viewer", "annotator"]), expiresAt: pick([null, clock + 7000]), by: "x" }); await r.addLinkUse(l.id, p.user); if (rnd(4) === 0) await r.revokeLink(l.id); }
          }
          if (tenant === acme.id && rnd(5) === 0) await r.setScopedGrant({ scope: { type: "board", id: b.id }, subject: { type: "team", id: pick(teams).id }, role: pick(["viewer", "editor"]) });
        };
        for (let i = 0; i < 40; i++) await mkBoard(acme.id, pick(spaces));
        for (let i = 0; i < 4; i++) await mkBoard(globex.id, null);              // a second Unit in the same batch
        clock += 6000;                                                           // some invites and links have expired now
        let open = 0;
        for (const p of people) {
          const batch = await ten.accessMany(p, boards.map(b => b.id));
          expect(batch.size).toBe(boards.length);
          for (const b of boards) {
            const one = await ten.effective(p, b.id), many = batch.get(b.id).access;
            if (one.ladder) open++;
            expect({ b: b.id, p: p.user, ladder: many.ladder, perms: [...many.permissions].sort(), sources: many.sources, until: many.until })
              .toEqual({ b: b.id, p: p.user, ladder: one.ladder, perms: [...one.permissions].sort(), sources: one.sources, until: one.until });
          }
        }
        expect(open).toBeGreaterThan(40);                                        // the scenario isn't vacuous
      } finally { await cleanup?.(r); }
    });
  }
}
