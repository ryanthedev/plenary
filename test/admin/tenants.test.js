// bootstrapTenant (server/admin/tenants.js) over every Registry adapter: memory, SQLite, Postgres (when
// DATABASE_URL is set, a fresh schema per test as test/server/pg-registry.test.js does). Plus the email-named admin
// match in server/admin/boards.js.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { bootstrapTenant, normAdmin, normDomain } from "../../server/admin/tenants.js";
import { createBoard } from "../../server/admin/boards.js";
import { memoryRegistry } from "../../server/auth/registry.js";
import { sqliteRegistry } from "../../server/registry/sqlite.js";
import { postgresRegistry } from "../../server/registry/postgres.js";

const dir = mkdtempSync(join(tmpdir(), "plenary-bootstrap-"));
let n = 0;
const url = process.env.DATABASE_URL;
/** @type {SQL|undefined} */ let sql;
const schemas = [];
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  if (sql) { for (const s of schemas) await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`); await sql.close(); }
});

const ADAPTERS = [
  ["memory", async () => memoryRegistry()],
  ["sqlite", async () => sqliteRegistry({ path: join(dir, `r${++n}.db`), fullfsync: false })],
  ...(url ? [["postgres", async () => {
    sql ??= new SQL({ url, max: 4 });
    const schema = `pl_test_boot_${process.pid}_${Date.now().toString(36)}_${++n}`;
    schemas.push(schema);
    return postgresRegistry({ sql, schema });
  }]] : []),
];

const sorted = a => [...a].sort();

for (const [name, make] of ADAPTERS) describe(`bootstrapTenant: ${name}`, () => {
  const withReg = fn => async () => { const r = await make(); try { await fn(r); } finally { await r.close?.(); } };

  test("creates the tenant with its admins; domain lower-cased; an email is stored as email:<addr>", withReg(async r => {
    const out = await bootstrapTenant({ registry: r, domain: " Acme.COM ", admins: ["dev:ann", "Alice@Acme.com"] });
    expect(out.created).toBe(true);
    expect(sorted(out.added)).toEqual(["dev:ann", "email:alice@acme.com"]);
    expect(out.tenant).toMatchObject({ domain: "acme.com" });
    expect(sorted(out.tenant.admins)).toEqual(["dev:ann", "email:alice@acme.com"]);
    expect((await r.tenantByDomain("acme.com")).id).toBe(out.tenant.id);
  }));

  test("re-running is a no-op; a new admin is added; nobody is ever removed", withReg(async r => {
    const a = await bootstrapTenant({ registry: r, domain: "acme.com", admins: ["dev:ann"] });
    const again = await bootstrapTenant({ registry: r, domain: "acme.com", admins: ["dev:ann"] });
    expect(again).toMatchObject({ created: false, added: [] });
    expect(again.tenant.id).toBe(a.tenant.id);
    const more = await bootstrapTenant({ registry: r, domain: "ACME.com", admins: ["google:123"] });
    expect(more).toMatchObject({ created: false, added: ["google:123"] });
    expect(sorted(more.tenant.admins)).toEqual(["dev:ann", "google:123"]);
    const none = await bootstrapTenant({ registry: r, domain: "acme.com", admins: [] });
    expect(sorted(none.tenant.admins)).toEqual(["dev:ann", "google:123"]);
  }));

  test("an existing tenant made elsewhere is reused, not duplicated", withReg(async r => {
    const t = await r.createTenant({ domain: "acme.com", admins: ["google:root"] });
    const out = await bootstrapTenant({ registry: r, domain: "acme.com", admins: ["dev:ann"] });
    expect(out).toMatchObject({ created: false, added: ["dev:ann"] });
    expect(out.tenant.id).toBe(t.id);
    expect(sorted(out.tenant.admins)).toEqual(["dev:ann", "google:root"]);
  }));

  test("two concurrent runs with different admins: one tenant holding the union", withReg(async r => {
    const runs = await Promise.all([
      bootstrapTenant({ registry: r, domain: "race.com", admins: ["dev:ann", "dev:bob"] }),
      bootstrapTenant({ registry: r, domain: "race.com", admins: ["dev:cat"] }),
      bootstrapTenant({ registry: r, domain: "race.com", admins: ["dev:bob", "dev:dan"] }),
    ]);
    const ids = new Set(runs.map(x => x.tenant.id));
    expect(ids.size).toBe(1);
    expect(runs.filter(x => x.created).length).toBe(1);
    const t = await r.tenantByDomain("race.com");
    expect(t.id).toBe([...ids][0]);
    expect(sorted(t.admins)).toEqual(["dev:ann", "dev:bob", "dev:cat", "dev:dan"]);
  }));

  test("bad input is refused before the Registry is touched", withReg(async r => {
    for (const domain of [null, "", "  ", "localhost", "not a domain", "a..b", "-x.com"])
      await expect(bootstrapTenant({ registry: r, domain, admins: [] })).rejects.toMatchObject({ code: "bad-request" });
    for (const admin of ["", "ann", "google:", "dev:has space", "x@", 42])
      await expect(bootstrapTenant({ registry: r, domain: "acme.com", admins: [admin] })).rejects.toMatchObject({ code: "bad-request" });
    expect(await r.tenantByDomain("acme.com")).toBe(null);
  }));

  test("an email admin off the tenant's domain, or any control character, is refused and nothing is written", withReg(async r => {
    for (const admin of ["bob@evil.com", "email:bob@evil.com", "bob@sub.acme.com", "bob@acme.com.", "x@acme.com\0", "google:12\u000134", "dev:ann\u007f", "a\u200b@acme.com", "google:1\u0085"])
      await expect(bootstrapTenant({ registry: r, domain: "acme.com", admins: ["dev:ok", admin] })).rejects.toMatchObject({ code: "bad-request" });
    expect(await r.tenantByDomain("acme.com")).toBe(null);
    const ok = await bootstrapTenant({ registry: r, domain: "Acme.com", admins: ["Bob@ACME.com"] });
    expect(ok.tenant.admins).toEqual(["email:bob@acme.com"]);
  }));
});

test("normDomain / normAdmin", () => {
  expect(normDomain("Sub.Acme.CO.uk")).toBe("sub.acme.co.uk");
  expect(normDomain("acme.test")).toBe("acme.test");
  expect(normAdmin(" google:1234567890 ")).toBe("google:1234567890");
  expect(normAdmin("dev:ann")).toBe("dev:ann");
  expect(normAdmin("email:Bob@Acme.com")).toBe("email:bob@acme.com");
  expect(normAdmin("bob@acme.com")).toBe("email:bob@acme.com");
  expect(normAdmin("Bob@Acme.com", "acme.com")).toBe("email:bob@acme.com");
  expect(normAdmin("dev:ann", "acme.com")).toBe("dev:ann");
  expect(() => normAdmin("bob@evil.com", "acme.com")).toThrow(/tenant's domain acme\.com: "bob@evil\.com"/);
  expect(() => normAdmin("x@y\0")).toThrow(/control character: "x@y\\u0000"/);
});

describe("an email-named admin is matched at sign-in (boards.js)", () => {
  const who = o => ({ user: "google:999", name: "Alice", email: "alice@acme.com", domain: "acme.com", ...o });
  const setup = async () => {
    const registry = memoryRegistry();
    const { tenant } = await bootstrapTenant({ registry, domain: "acme.com", admins: ["Alice@Acme.com"] });
    return { registry, tenant };
  };

  test("the vouched email in the tenant's domain may create a board, and becomes its owner by user id", async () => {
    const { registry, tenant } = await setup();
    const b = await createBoard({ caller: who(), tenant: tenant.id, title: "x" }, { registry });
    expect(await registry.grant(b.id, "google:999")).toBe("owner");
  });

  test("no vouched email, another Workspace domain, or a guest with that address: forbidden", async () => {
    const { registry, tenant } = await setup();
    for (const caller of [who({ email: null }), who({ domain: "globex.com" }), who({ domain: null }), who({ email: "bob@acme.com" })])
      await expect(createBoard({ caller, tenant: tenant.id }, { registry })).rejects.toMatchObject({ code: "forbidden" });
  });

  test("a dev token claiming the vouched-looking email and the tenant's domain never matches an email entry", async () => {
    const { registry, tenant } = await setup();
    const caller = { user: "dev:alice", name: "alice", email: "alice@acme.com", domain: "acme.com" };
    await expect(createBoard({ caller, tenant: tenant.id }, { registry })).rejects.toMatchObject({ code: "forbidden" });
  });

  test("an email entry never matches by user id, and a user-id admin still works", async () => {
    const registry = memoryRegistry();
    // The tenant really holds email:alice@acme.com, so only the user-id guard stands between the caller and admin.
    const { tenant } = await bootstrapTenant({ registry, domain: "acme.com", admins: ["dev:ann", "alice@acme.com"] });
    expect(tenant.admins).toContain("email:alice@acme.com");
    await createBoard({ caller: { user: "dev:ann", name: "ann", email: null, domain: null }, tenant: tenant.id }, { registry });
    await expect(createBoard({ caller: { user: "email:alice@acme.com", name: null, email: null, domain: "acme.com" }, tenant: tenant.id }, { registry })).rejects.toMatchObject({ code: "forbidden" });
  });
});
