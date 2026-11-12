// The Postgres Store (server/store/postgres.js): the shared Store contract, plus what only Postgres has
// (synchronous_commit, a real row-level race on one seq, concurrent schema creation, pool ownership).
// Skips unless DATABASE_URL is set (CI's test-cluster-services job sets it). Each test gets its own schema,
// dropped after; one client is shared by the file.
import { describe, test, expect, afterAll } from "bun:test";
import { SQL } from "bun";
import { postgresStore } from "../../server/store/postgres.js";
import { storeContract, entry, code } from "./store-contract.js";

const url = process.env.DATABASE_URL;
const T = "t-aaa", B = "b-one";

describe.skipIf(!url)("postgres store", () => {
  /** @type {SQL} */ let sql;
  const client = () => (sql ??= new SQL({ url, max: 4 }));
  afterAll(async () => { if (sql) await sql.close(); });
  let n = 0;
  const schemaName = () => `pl_test_store_${process.pid}_${Date.now().toString(36)}_${++n}`;
  const drop = s => client().unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);

  storeContract("postgres", async () => {
    const schema = schemaName();
    const open = () => postgresStore({ sql: client(), schema });
    return { store: await open(), another: open, cleanup: () => drop(schema) };
  });

  test("a write transaction runs with synchronous_commit=on and fsync on", async () => {
    const schema = schemaName();
    const store = await postgresStore({ sql: client(), schema });
    try { expect(await store.settings()).toEqual({ synchronous_commit: "on", fsync: "on" }); }
    finally { await store.close(); await drop(schema); }
  });

  test("an append at a seq another connection holds uncommitted waits for it, then gets conflict", async () => {
    const schema = schemaName();
    const store = await postgresStore({ url, schema, max: 2 });           // its own pool: a different connection for sure
    const other = await client().reserve();
    try {
      await store.append(T, B, [entry(1)], 0);
      await other.unsafe("BEGIN");
      await other.unsafe(`INSERT INTO "${schema}".pl_entries (tenant, board, seq, data) VALUES ($1, $2, 2, $3)`, [T, B, JSON.stringify(entry(2, { by: "other" }))]);
      let settled = false;
      const p = code(store.append(T, B, [entry(2)], 1)).finally(() => { settled = true; });
      await Bun.sleep(200);
      expect(settled).toBe(false);                                // blocked on the unique key, not decided yet
      await other.unsafe("COMMIT");
      expect(await p).toBe("conflict");
      expect((await store.read(T, B, 1, 10)).map(e => e.by)).toEqual(["u1", "other"]);
    } finally {
      other.release();
      await store.close();
      await drop(schema);
    }
  });

  test("the same race, other side rolls back: the waiting append then succeeds", async () => {
    const schema = schemaName();
    const store = await postgresStore({ url, schema, max: 2 });
    const other = await client().reserve();
    try {
      await store.append(T, B, [entry(1)], 0);
      await other.unsafe("BEGIN");
      await other.unsafe(`INSERT INTO "${schema}".pl_entries (tenant, board, seq, data) VALUES ($1, $2, 2, 'x')`, [T, B]);
      const p = code(store.append(T, B, [entry(2)], 1));
      await Bun.sleep(100);
      await other.unsafe("ROLLBACK");
      expect(await p).toBe("resolved");
      expect(await store.read(T, B, 1, 10)).toEqual([entry(1), entry(2)]);
    } finally {
      other.release();
      await store.close();
      await drop(schema);
    }
  });

  test("ten stores on separate pools racing at one seq: exactly one wins per round", async () => {
    const schema = schemaName();
    let stores = [];
    try {
      const opened = await Promise.allSettled(Array.from({ length: 10 }, () => postgresStore({ url, schema, max: 2 })));   // concurrent schema creation too
      stores = opened.filter(x => x.status === "fulfilled").map(x => x.value);
      expect(opened.filter(x => x.status === "rejected").map(x => String(x.reason))).toEqual([]);
      for (let at = 0; at < 10; at++) {
        const res = await Promise.all(stores.map((s, i) => code(s.append(T, B, [entry(at + 1, { by: `h${i}` })], at))));
        expect(res.filter(r => r === "resolved").length).toBe(1);
        expect(res.filter(r => r === "conflict").length).toBe(9);
      }
      expect((await stores[0].read(T, B, 1, 100)).map(e => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    } finally {
      for (const s of stores) await s.close();
      await drop(schema);
    }
  });

  test("close() ends a pool the store opened from a url, and leaves a passed-in client open", async () => {
    const schema = schemaName();
    const mine = await postgresStore({ url, schema, max: 2 });
    await mine.close();
    const shared = await postgresStore({ sql: client(), schema });
    await shared.close();
    expect((await client().unsafe("SELECT 1 AS x"))[0].x).toBe(1);   // still usable
    await drop(schema);
  });

  test("least privilege: an owner migrates; a role with only USAGE and row grants then starts the store and writes, and can't create anything", async () => {
    // Needs a DATABASE_URL role that may create roles (CI's and a local cluster's superuser can); skipped otherwise.
    const [{ ok }] = await client().unsafe("SELECT rolsuper OR rolcreaterole AS ok FROM pg_roles WHERE rolname = current_user");
    if (!ok) { console.warn("pg-store: skipping the least-privilege test (the DATABASE_URL role can't create roles)"); return; }
    const schema = schemaName(), bare = schemaName(), role = `pl_test_app_${process.pid}_${++n}`, pass = "pl-test-" + Date.now().toString(36);
    const owner = await postgresStore({ sql: client(), schema });                 // the owner migrates (creates the tables)
    await owner.close();
    await client().unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${pass}'`);
    await client().unsafe(`CREATE SCHEMA "${bare}"`);                            // made for the app, never migrated
    for (const sch of [schema, bare]) await client().unsafe(`GRANT USAGE ON SCHEMA "${sch}" TO "${role}"`);
    await client().unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
    const u = new URL(url); u.username = role; u.password = pass;
    const app = new SQL({ url: u.toString(), max: 2 });
    try {
      const store = await postgresStore({ sql: app, schema });                   // starts: every table exists, no CREATE runs
      await store.append(T, B, [entry(1)], 0);
      expect((await store.read(T, B, 1, 10)).map(e => e.seq)).toEqual([1]);
      expect(await store.openEpoch(T, B)).toBe(1);
      await store.putCheckpoint(T, B, { seq: 1, id: "c:1", by: "u1", at: 1 });
      expect((await store.getCheckpoint(T, B))?.seq).toBe(1);
      await store.close();
      // The same role on a schema nobody migrated: refused (it may not CREATE), so the test above proves least privilege.
      await expect(postgresStore({ sql: app, schema: bare })).rejects.toThrow(/permission denied/);
      await expect(app.unsafe(`CREATE TABLE "${schema}".pl_extra (x INT)`)).rejects.toThrow(/permission denied/);
    } finally {
      await app.close();
      await drop(schema); await drop(bare);
      await client().unsafe(`DROP ROLE IF EXISTS "${role}"`);
    }
  });

  test("bad schema names and missing connection are refused", async () => {
    await expect(postgresStore({ sql: client(), schema: 'x"; DROP TABLE y; --' })).rejects.toThrow("bad schema name");
    await expect(postgresStore({ sql: client(), schema: "Upper" })).rejects.toThrow("bad schema name");
    await expect(postgresStore({ schema: "x" })).rejects.toThrow("pass url or sql");
  });
});
