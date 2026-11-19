// SQLite's accessContext runs the SAME statements for a scope that exists and one that doesn't (PROTOCOL.md § Spaces and Groups: a refusal's
// cost must not tell an unknown id from a hidden one). Statements are counted by wrapping bun:sqlite's prepared statements.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteRegistry } from "../../server/registry/sqlite.js";

test("accessContext(s): same statement count for existing, unknown and other-type ids, per scope type", async () => {
  let count = 0;
  const orig = Database.prototype.query;
  Database.prototype.query = function (sql) {
    const st = orig.call(this, sql);
    return new Proxy(st, { get: (t, k) => (typeof t[k] === "function" ? (...a) => { if (k === "get" || k === "all" || k === "run") count++; return t[k](...a); } : t[k]) });
  };
  const dir = mkdtempSync(join(tmpdir(), "sqlite-uniform-"));
  try {
    const r = sqliteRegistry({ path: join(dir, "r.db"), fullfsync: false });
    const t = await r.createTenant({ domain: "acme.test", admins: [] });
    const g = await r.createGroup({ tenant: t.id, name: "G", generalRole: "viewer", owner: "dev:a" });
    const sp = await r.createSpace({ tenant: t.id, name: "S", group: g.id, owner: "dev:a" });
    const sp2 = await r.createSpace({ tenant: t.id, name: "S2", group: g.id, owner: "dev:a" });
    const b = await r.createBoard({ tenant: t.id, title: "B", space: sp.id });
    // Team grants on every real scope: the team-members read has work to do for them, and must still run for an unknown id.
    const team = await r.createTeam({ tenant: t.id, name: "Crew" });
    for (const scope of [{ type: "unit", id: t.id }, { type: "group", id: g.id }, { type: "space", id: sp.id }, { type: "space", id: sp2.id }, { type: "board", id: b.id }])
      await r.setScopedGrant({ scope, subject: { type: "team", id: team.id }, role: "viewer" });
    const cost = async scope => { count = 0; await r.accessContext(scope, { users: ["dev:a"] }); return count; };
    for (const [type, real] of [["space", sp.id], ["group", g.id], ["board", b.id], ["unit", t.id]]) {
      const known = await cost({ type, id: real }), unknown = await cost({ type, id: "x-nope" });
      expect([type, unknown]).toEqual([type, known]);
    }
    count = 0; await r.accessContexts([{ type: "space", id: sp.id }, { type: "space", id: "s-nope" }], { users: ["dev:a"] });
    const batch = count;
    count = 0; await r.accessContexts([{ type: "space", id: sp.id }, { type: "space", id: sp2.id }], { users: ["dev:a"] });
    expect(batch).toBe(count);
    await r.close();
  } finally { Database.prototype.query = orig; rmSync(dir, { recursive: true, force: true }); }
});
