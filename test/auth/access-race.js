// Last owner through the access service, on two handles of one durable Registry (SQLite: two handles on one file; Postgres: two connections),
// so the rule is exercised end to end (service -> adapter) and not only at the adapter. Used by test/server/registry.test.js and pg-registry.test.js.
//
//   accessRace("postgres", async () => ({ a, b, close }), { rounds })       a, b: two Registry handles on ONE store; close(): closes both
import { describe, test, expect } from "bun:test";
import { tenancy as makeTenancy } from "../../server/core/auth/tenancy.js";
import { accessService } from "../../server/core/auth/access.js";

export function accessRace(name, open, { rounds = 8 } = {}) {
  describe(`access service on two ${name} handles: the last owner holds under races`, () => {
    const ident = n => ({ user: `google:${n}`, name: n, email: `${n}@acme.com`, domain: "acme.com" });
    const svc = reg => accessService({ registry: reg, tenancy: makeTenancy({ registry: reg }) });
    const owners = async (reg, type, id) => (await reg.scopedGrants({ type, id })).filter(g => g.role === "owner");
    const code = p => p.then(() => null, e => e.code ?? e.message);

    test("two owners removing each other through different handles: exactly one removal wins, every round, at a Space and a Group", async () => {
      const { a, b, close } = await open();
      try {
        const t = await a.createTenant({ domain: "acme.com", admins: ["google:root"] });
        for (const u of ["x", "y"]) await a.touchMember(t.id, { user: `google:${u}`, name: u });
        const sp = await a.createSpace({ tenant: t.id, name: "D" }), g = await a.createGroup({ tenant: t.id, name: "P" });
        const sa = svc(a), sb = svc(b), x = ident("x"), y = ident("y");
        for (const [type, id] of [["space", sp.id], ["group", g.id]]) for (let round = 0; round < rounds; round++) {
          await a.setScopedGrant({ scope: { type, id }, subject: { type: "user", id: x.user }, role: "owner" });
          await a.setScopedGrant({ scope: { type, id }, subject: { type: "user", id: y.user }, role: "owner" });
          const res = await Promise.all([code(sa.setGrant(x, type, id, "user", x.user, round % 2 ? "viewer" : null)), code(sb.setGrant(y, type, id, "user", y.user, null))]);
          expect(res.filter(r => r === null)).toHaveLength(1);
          expect(res.find(r => r !== null)).toBe("last-owner");
          for (const h of [a, b]) expect(await owners(h, type, id)).toHaveLength(1);
          await a.setScopedGrant({ scope: { type, id }, subject: { type: "user", id: x.user }, role: "owner" });
          await a.setScopedGrant({ scope: { type, id }, subject: { type: "user", id: y.user }, role: null }).catch(() => {});
        }
      } finally { await close(); }
    });

    test("deleting the Team that owns races the other owner's removal: one wins, the Space keeps a counted owner, every round", async () => {
      const { a, b, close } = await open();
      try {
        const t = await a.createTenant({ domain: "acme.com", admins: ["google:root"] });
        const sp = await a.createSpace({ tenant: t.id, name: "D", owner: "google:ann" });
        const ann = ident("ann"), root = ident("root");
        for (let round = 0; round < rounds; round++) {
          const tm = await a.createTeam({ tenant: t.id, name: `Leads ${round}` });
          await a.setTeamMember(tm.id, "google:lee", true);
          await a.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "team", id: tm.id }, role: "owner" });
          await a.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "user", id: ann.user }, role: "owner" });
          const res = await Promise.all([code(svc(a).deleteTeam(root, tm.id)), code(svc(b).setGrant(ann, "space", sp.id, "user", ann.user, null))]);
          // Either order is legal, but the Space can't end without a counted owner: if the Team went first Ann stays, if Ann went first the Team stays.
          expect(res.filter(r => r === null).length).toBeGreaterThanOrEqual(1);
          if (res.every(r => r === null)) throw new Error("both succeeded: the Space would have no owner");
          expect(res.find(r => r !== null)).toBe("last-owner");
          const left = await a.scopedGrants({ type: "space", id: sp.id });
          expect(left.filter(g => g.role === "owner")).toHaveLength(1);
          await a.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "user", id: ann.user }, role: "owner" });
          if (await a.team(tm.id)) await a.deleteTeam(tm.id);
        }
      } finally { await close(); }
    });

    test("two Teams that are the only owners each losing their last member (one by delete) at once: a counted owner remains", async () => {
      const { a, b, close } = await open();
      try {
        const t = await a.createTenant({ domain: "acme.com", admins: ["google:root"] });
        const root = ident("root");
        for (let round = 0; round < rounds; round++) {
          const sp = await a.createSpace({ tenant: t.id, name: `D${round}` });            // a fresh Space per round: no owner but the two Teams
          const tx = await a.createTeam({ tenant: t.id, name: `X${round}` }), ty = await a.createTeam({ tenant: t.id, name: `Y${round}` });
          await a.setTeamMember(tx.id, "google:x", true); await a.setTeamMember(ty.id, "google:y", true);
          for (const tm of [tx, ty]) await a.setScopedGrant({ scope: { type: "space", id: sp.id }, subject: { type: "team", id: tm.id }, role: "owner" });
          const res = await Promise.all([code(svc(a).setMember(root, tx.id, "google:x", false)), code(svc(b).deleteTeam(root, ty.id))]);
          expect(res.filter(r => r === null).length).toBe(1);
          expect(res.find(r => r !== null)).toBe("last-owner");
          const counted = [];
          for (const tm of [tx, ty]) if ((await a.team(tm.id)) && (await a.teamMembers(tm.id)).length) counted.push(tm.id);
          expect(counted).toHaveLength(1);
        }
      } finally { await close(); }
    });
  });
}
