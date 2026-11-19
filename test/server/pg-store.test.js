// The Postgres Store (server/store/postgres.js): the shared Store contract, plus what only Postgres has
// (synchronous_commit, a real row-level race on one seq, concurrent schema creation, pool ownership).
// Skips unless DATABASE_URL is set (CI's test-cluster-services job sets it). Each test gets its own schema,
// dropped after; one client is shared by the file.
import { describe, test, expect, afterAll, setDefaultTimeout } from "bun:test";
import { SQL } from "bun";
import { postgresStore } from "../../server/store/postgres.js";
import { storeContract, entry, code, own } from "./store-contract.js";

const url = process.env.DATABASE_URL;
const T = "t-aaa", B = "b-one";
// Every test here does real Postgres work (schema creation, pools, lock waits). Bun's 5 s default fails them under machine load (TECH-DEBT
// row 36), so this is a failure-only ceiling: it fires only when a call never returns. Nothing asserts on how long a test took.
setDefaultTimeout(30_000);
// How long a call that must settle (as "unavailable", a conflict ...) may take before the test calls it hung. Failure-only, like the ceiling above.
const HUNG_MS = 20_000;
/** `p`'s outcome, or "still waiting" after HUNG_MS; the timer is cleared once `p` settles so a passing run leaves none pending. */
const orHung = async p => { let timer; try { return await Promise.race([p, new Promise(r => { timer = setTimeout(r, HUNG_MS, "still waiting"); })]); } finally { clearTimeout(timer); } };

describe.skipIf(!url)("postgres store", () => {
  /** @type {SQL} */ let sql;
  const client = () => (sql ??= new SQL({ url, max: 4 }));
  afterAll(async () => { if (sql) await sql.close(); });
  let n = 0;
  /** Poll pg_stat_activity until `n` backends are waiting on a lock in a statement matching `like`; a clear failure after HUNG_MS. */
  const waitBlocked = async (like, what, { n = 1, done = () => false } = {}) => {
    let c = 0;
    for (const end = Date.now() + HUNG_MS; Date.now() < end; await Bun.sleep(10)) {
      c = (await client().unsafe(`SELECT count(*)::int AS c FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1`, [like]))[0].c;
      if (c >= n) return;
      if (done()) throw new Error(`${what} finished instead of waiting`);
    }
    throw new Error(`timed out after ${HUNG_MS} ms: ${what} never showed as lock-waiting in pg_stat_activity (${c}/${n})`);
  };
  const schemaName = () => `pl_test_store_${process.pid}_${Date.now().toString(36)}_${++n}`;
  const drop = s => client().unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);

  storeContract("postgres", async opts => {
    const schema = schemaName();
    const open = () => postgresStore({ sql: client(), schema, ...opts });
    const q = (sqlText, ...a) => client().unsafe(sqlText, a);
    const store = await open();
    return { store, another: open, cleanup: () => drop(schema), raw: {
      putCheckpointRow: (t, b, seq, data) => q(`INSERT INTO "${schema}".pl_checkpoints (tenant, board, seq, data) VALUES ($1, $2, $3, $4)`, t, b, seq, data),
      putPartRow: (t, b, seq, wid, n, data) => q(`INSERT INTO "${schema}".pl_checkpoint_parts (tenant, board, seq, wid, n, data) VALUES ($1, $2, $3, $4, $5, $6)`, t, b, seq, wid, n, data),
      partRows: async (t, b) => (await q(`SELECT count(*)::int AS c FROM "${schema}".pl_checkpoint_parts WHERE tenant = $1 AND board = $2`, t, b))[0].c,
      putRefRow: (t, b, sha1) => q(`INSERT INTO "${schema}".pl_blob_refs (tenant, sha1, board) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, t, sha1, b),
      refRows: async (t, b) => (await q(`SELECT count(*)::int AS c FROM "${schema}".pl_blob_refs WHERE tenant = $1 AND board = $2`, t, b))[0].c,
      pendingRows: async (t, b) => (await q(`SELECT count(*)::int AS c FROM "${schema}".pl_blob_pending WHERE tenant = $1 AND board = $2`, t, b))[0].c,
    } };
  });

  test("DW-iso: clusterId is c-+16, stable across calls and reopen, one id for a racing start, a different one per database", async () => {
    const a = schemaName(), b = schemaName();
    const stores = [], pools = [];
    try {
      // Eight nodes asking at once on a fresh schema: one id wins, all of them return it.
      // each node has its own connection, as separate processes do (not one shared pool)
      const nodes = await Promise.all(Array.from({ length: 8 }, async () => { const own = new SQL({ url, max: 1 }); pools.push(own); return postgresStore({ sql: own, schema: a }); }));
      stores.push(...nodes);
      const ids = await Promise.all(nodes.map(n => n.clusterId()));
      expect(ids[0]).toMatch(/^c-[a-z0-9]{16}$/);
      expect(new Set(ids).size).toBe(1);
      expect(await nodes[0].clusterId()).toBe(ids[0]);
      expect((await client().unsafe(`SELECT count(*)::int AS n FROM "${a}".pl_cluster`))[0].n).toBe(1);
      const again = await postgresStore({ sql: client(), schema: a }); stores.push(again);
      expect(await again.clusterId()).toBe(ids[0]);               // a restarted node on the same database
      const other = await postgresStore({ sql: client(), schema: b }); stores.push(other);
      expect(await other.clusterId()).not.toBe(ids[0]);           // another database is another cluster
      await expect(client().unsafe(`INSERT INTO "${a}".pl_cluster (id) VALUES ('c-bbbbbbbbbbbbbbbb')`)).rejects.toThrow();   // never a second row
    } finally { for (const x of stores) await x.close(); for (const p of pools) await p.close(); await drop(a); await drop(b); }
  });

  test("clusterId on a closed store is refused", async () => {
    const schema = schemaName();
    const store = await postgresStore({ sql: client(), schema });
    try { await store.close(); await expect(store.clusterId()).rejects.toMatchObject({ code: "closed" }); } finally { await drop(schema); }
  });

  test("a write transaction runs with synchronous_commit=on and fsync on", async () => {
    const schema = schemaName();
    const store = await postgresStore({ sql: client(), schema });
    try { expect(await store.settings()).toEqual({ synchronous_commit: "on", fsync: "on", idle_in_transaction_session_timeout: "5s" }); }
    finally { await store.close(); await drop(schema); }
  });

  test("an append at a seq another connection holds uncommitted waits for it, then gets conflict", async () => {
    const schema = schemaName();
    const store = await postgresStore({ url, schema, max: 2 });           // its own pool: a different connection for sure
    const other = await client().reserve();
    try {
      const e = await own(store);
      await store.append(T, B, [entry(1)], 0, e);
      await other.unsafe("BEGIN");
      await other.unsafe(`INSERT INTO "${schema}".pl_entries (tenant, board, seq, data) VALUES ($1, $2, 2, $3)`, [T, B, JSON.stringify(entry(2, { by: "other" }))]);
      let settled = false;
      const p = code(store.append(T, B, [entry(2)], 1, e)).finally(() => { settled = true; });
      await waitBlocked(`%INSERT INTO "${schema}".pl_entries%`, "the append's insert, parked behind the other connection's row", { done: () => settled });
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
      const e = await own(store);
      await store.append(T, B, [entry(1)], 0, e);
      await other.unsafe("BEGIN");
      await other.unsafe(`INSERT INTO "${schema}".pl_entries (tenant, board, seq, data) VALUES ($1, $2, 2, 'x')`, [T, B]);
      const p = code(store.append(T, B, [entry(2)], 1, e));
      await waitBlocked(`%INSERT INTO "${schema}".pl_entries%`, "the append's insert, parked behind the other connection's row");   // else the ROLLBACK could come first and prove nothing
      await other.unsafe("ROLLBACK");
      expect(await p).toBe("resolved");
      expect(await store.read(T, B, 1, 10)).toEqual([entry(1), entry(2)]);
    } finally {
      other.release();
      await store.close();
      await drop(schema);
    }
  });

  test("fence: an append waits on a takeover's uncommitted epoch bump, then is fenced; on its rollback it lands", async () => {
    const schema = schemaName();
    const store = await postgresStore({ url, schema, max: 2 });           // its own pool: a different connection for sure
    const other = await client().reserve();
    try {
      const { epoch } = await store.acquire(T, B, "h-a", 60_000);
      await store.append(T, B, [entry(1)], 0, epoch);
      for (const [end, want] of [["COMMIT", "fenced"], ["ROLLBACK", "resolved"]]) {
        const at = await store.lastSeq(T, B), cur = await store.epoch(T, B);
        await other.unsafe("BEGIN");
        await other.unsafe(`UPDATE "${schema}".pl_leases SET epoch = epoch + 1, holder = 'h-b' WHERE tenant = $1 AND board = $2`, [T, B]);
        let settled = false;
        const p = code(store.append(T, B, [entry(at + 1)], at, cur)).finally(() => { settled = true; });
        await waitBlocked(`%"${schema}".pl_leases%FOR SHARE%`, "the append's fence (FOR SHARE), parked behind the takeover", { done: () => settled });
        expect(settled).toBe(false);                              // FOR SHARE waits for the takeover to decide
        await other.unsafe(end);
        expect(await p).toBe(want);
        if (end === "COMMIT") await other.unsafe(`UPDATE "${schema}".pl_leases SET holder = 'h-a' WHERE tenant = $1 AND board = $2`, [T, B]);
      }
      expect((await store.read(T, B, 1, 10)).map(e => e.seq)).toEqual([1, 2]);   // the fenced one wrote nothing
      // And the other way round: a takeover waits for an append in flight, so it commits after it, never before.
      const cur = await store.epoch(T, B);
      await other.unsafe("BEGIN");
      await other.unsafe(`SELECT epoch FROM "${schema}".pl_leases WHERE tenant = $1 AND board = $2 FOR SHARE`, [T, B]);   // an append's lock
      let taken = false;
      const take = store.renew(T, B, "h-a", cur, 60_000).finally(() => { taken = true; });   // a lease write: waits (within its lock bound)
      await waitBlocked(`%UPDATE "${schema}".pl_leases%`, "the lease write, parked behind the append's FOR SHARE", { done: () => taken });
      expect(taken).toBe(false);
      await other.unsafe("COMMIT");
      expect((await take).epoch).toBe(cur);
    } finally {
      other.release();
      await store.close();
      await drop(schema);
    }
  });

  test("lease expiry is on the database's clock: expiresAt = clock_timestamp() + ttl", async () => {
    const schema = schemaName();
    const store = await postgresStore({ sql: client(), schema });
    try {
      const [{ t0 }] = await client().unsafe("SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS t0");
      const got = await store.acquire(T, B, "h-a", 5_000);
      const [{ t1 }] = await client().unsafe("SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS t1");
      expect(got.expiresAt).toBeGreaterThanOrEqual(Number(t0) + 5_000);
      expect(got.expiresAt).toBeLessThanOrEqual(Number(t1) + 5_000);
      expect(await store.lease(T, B)).toEqual({ holder: "h-a", epoch: 1, expiresAt: got.expiresAt, live: true, remainingMs: expect.any(Number) });
    } finally { await store.close(); await drop(schema); }
  });

  test("a pl_leases made before the lease (epoch only) is an old-format store: start-up refuses it with code old-format and changes nothing", async () => {
    const schema = schemaName();
    await client().unsafe(`CREATE SCHEMA "${schema}"`);
    await client().unsafe(`CREATE TABLE "${schema}".pl_leases (tenant TEXT NOT NULL, board TEXT NOT NULL, epoch BIGINT NOT NULL, PRIMARY KEY (tenant, board))`);
    await client().unsafe(`INSERT INTO "${schema}".pl_leases VALUES ($1, $2, 5)`, [T, B]);
    const cols = async () => (await client().unsafe(`SELECT attname FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
      [`"${schema}".pl_leases`])).map(r => r.attname);
    try {
      const err = await postgresStore({ sql: client(), schema }).then(() => null, e => e);
      expect(err?.code).toBe("old-format");
      expect(err.message).toContain("Reset the store");
      expect(err.message).toContain(`drop the schema "${schema}"`);                  // never advises dropping the one table: the epochs would restart at 1
      expect(await cols()).toEqual(["tenant", "board", "epoch"]);                  // start-up changed nothing
    } finally { await drop(schema); }
  });

  test("start-up waits at most lockTimeoutMs for the schema's start-up lock, then fails with a clear lock-timeout", async () => {
    const schema = schemaName();
    const holder = await client().reserve();
    try {
      await holder.unsafe("BEGIN");
      await holder.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [`plenary-schema:${schema}`]);   // a wedged migrator
      const t0 = Date.now();
      const err = await postgresStore({ sql: client(), schema, lockTimeoutMs: 300 }).then(() => null, e => e);
      expect(err?.code).toBe("lock-timeout");
      expect(err.message).toContain(`schema "${schema}"`);
      await holder.unsafe("COMMIT");
      const store = await postgresStore({ sql: client(), schema, lockTimeoutMs: 300 });   // lock free: starts
      await store.close();
    } finally { holder.release(); await drop(schema); }
  });

  // ---- Round 2 (p4-store-leasev H1, M1, L3) ----

  const DBMS = "SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS t";

  for (const what of ["append", "checkpoint"]) test(`H1 window: a takeover can't commit while a fenced ${what} is past its fence check`, async () => {
    // Kills "the fence runs outside the write's transaction": the write is parked after its fence (an uncommitted row
    // at the key it inserts), and a takeover must wait for it (FOR SHARE held in the write's transaction).
    const schema = schemaName();
    const store = await postgresStore({ url, schema, max: 2 });
    const parker = await client().reserve(), taker = await client().reserve();
    try {
      const { epoch } = await store.acquire(T, B, "h-a", 60_000);
      await store.append(T, B, [entry(1)], 0, epoch);
      await parker.unsafe("BEGIN");
      if (what === "append") await parker.unsafe(`INSERT INTO "${schema}".pl_entries VALUES ($1, $2, 2, '{}')`, [T, B]);
      else await parker.unsafe(`INSERT INTO "${schema}".pl_checkpoints VALUES ($1, $2, 9, '{}')`, [T, B]);
      let wrote = null, took = false;
      const w = (what === "append" ? code(store.append(T, B, [entry(2)], 1, epoch)) : code(store.putCheckpoint(T, B, { seq: 9, by: "a" }, epoch)))
        .then(r => { wrote = r; return r; });
      const table = what === "append" ? "pl_entries" : "pl_checkpoints";
      await waitBlocked(`%INSERT INTO "${schema}".${table}%`, `the fenced ${what}'s insert, parked behind the open row`);   // past its fence check
      const take = taker.unsafe(`UPDATE "${schema}".pl_leases SET epoch = epoch + 1, holder = 'h-b' WHERE tenant = $1 AND board = $2`, [T, B])
        .then(() => { took = true; });
      await waitBlocked(`UPDATE "${schema}".pl_leases SET epoch = epoch + 1%`, "the takeover's UPDATE", { done: () => took });   // waiting on the write's FOR SHARE
      expect(took).toBe(false);                                    // the takeover waits behind the parked write
      expect(wrote).toBe(null);
      await parker.unsafe("ROLLBACK");
      expect(await w).toBe("resolved");                            // fenced in before the takeover: it lands
      await take;
      expect(await store.epoch(T, B)).toBe(epoch + 1);
    } finally { parker.release(); taker.release(); await store.close(); await drop(schema); }
  });

  test("H1 host clock: a host clock an hour off changes nothing; expiresAt and liveness follow the database", async () => {
    const schema = schemaName();
    const store = await postgresStore({ url, schema, max: 2 });
    const real = Date.now;
    try {
      Date.now = () => real() + 3_600_000;                         // this host is an hour ahead
      const t0 = Number((await client().unsafe(DBMS))[0].t);
      const a = await store.acquire(T, B, "h-a", 5_000);
      const t1 = Number((await client().unsafe(DBMS))[0].t);
      expect(a.expiresAt).toBeGreaterThanOrEqual(t0 + 5_000);
      expect(a.expiresAt).toBeLessThanOrEqual(t1 + 5_000);
      Date.now = () => real() - 3_600_000;                         // an hour behind: a live lease stays live
      expect((await store.lease(T, B)).live).toBe(true);
      expect(await store.acquire(T, B, "h-b", 5_000)).toBe(null);
    } finally { Date.now = real; await store.close(); await drop(schema); }
  });

  test("H1 clock_timestamp, not now(): acquire's expiry is stamped after its lock wait", async () => {
    const schema = schemaName();
    const store = await postgresStore({ url, schema, max: 2 });
    const blocker = await client().reserve();
    try {
      await store.acquire(T, B, "h-a", 1);
      await Bun.sleep(5);
      await blocker.unsafe("BEGIN");
      await blocker.unsafe(`SELECT 1 FROM "${schema}".pl_leases WHERE tenant = $1 AND board = $2 FOR UPDATE`, [T, B]);
      const p = store.acquire(T, B, "h-b", 5_000);
      await waitBlocked(`%INSERT INTO "${schema}".pl_leases%`, "acquire's lease lock, parked behind the blocker");   // it is now waiting, so its clock reading is still to come
      await Bun.sleep(50);   // margin only: lets the wait span more than the clock's 1 ms, so a now()-stamped expiry reads clearly early. Never a sync point.
      const tr = Number((await blocker.unsafe(DBMS))[0].t);
      await blocker.unsafe("COMMIT");
      expect((await p).expiresAt).toBeGreaterThanOrEqual(tr + 5_000);   // judged after the wait, not at its start
    } finally { blocker.release(); await store.close(); await drop(schema); }
  });

  test("M1: a takeover behind a stalled holder's transaction settles within leaseLockTimeoutMs as unavailable, then succeeds once it ends", async () => {
    // The verifier's repro: an open transaction holding FOR SHARE on the lease row stands in for a paused append.
    const schema = schemaName();
    const store = await postgresStore({ url, schema, max: 2, leaseLockTimeoutMs: 500 });
    const stalled = await client().reserve();
    try {
      await store.acquire(T, B, "h-a", 200);
      await stalled.unsafe("BEGIN");
      await stalled.unsafe(`SELECT epoch FROM "${schema}".pl_leases WHERE tenant = $1 AND board = $2 FOR SHARE`, [T, B]);
      await Bun.sleep(300);
      expect((await store.lease(T, B)).live).toBe(false);
      const got = await orHung(code(store.acquire(T, B, "h-b", 60_000)));
      expect(got).toBe("unavailable");                             // a PortError the caller retries, not a hang
      expect(await code(store.renew(T, B, "h-a", 1, 60_000))).toBe("unavailable");   // renew and release are bounded too
      expect(await code(store.release(T, B, "h-a", 1))).toBe("unavailable");
      await stalled.unsafe("COMMIT");
      expect((await store.acquire(T, B, "h-b", 60_000))?.epoch).toBe(2);
    } finally { stalled.release(); await store.close(); await drop(schema); }
  });

  test("a checkpoint write stuck behind another session's lock on the lease row settles within leaseLockTimeoutMs as unavailable, then succeeds once it ends", async () => {
    const schema = schemaName();
    const store = await postgresStore({ url, schema, max: 2, leaseLockTimeoutMs: 500 });
    const stalled = await client().reserve();
    try {
      const e = (await store.acquire(T, B, "h-a", 60_000)).epoch;
      await stalled.unsafe("BEGIN");
      await stalled.unsafe(`SELECT epoch FROM "${schema}".pl_leases WHERE tenant = $1 AND board = $2 FOR UPDATE`, [T, B]);   // a takeover mid-flight
      expect(await orHung(code(store.putCheckpoint(T, B, { seq: 3 }, e)))).toBe("unavailable");   // the fence's FOR SHARE waits, then gives up: never forever
      await stalled.unsafe("COMMIT");
      await store.putCheckpoint(T, B, { seq: 3 }, e);
      expect((await store.getCheckpoint(T, B)).seq).toBe(3);
    } finally { stalled.release(); await store.close(); await drop(schema); }
  });

  test("R2-L1: a lease call's lock wait is capped at half its ttl, even when leaseLockTimeoutMs is longer", async () => {
    const schema = schemaName();
    // The adapter runs on a client we own, whose transactions' statements are recorded: the bound Postgres is given is
    // read off the `SET LOCAL lock_timeout` itself (a wall-clock window can't tell 200 ms from a too-long 2 s cap).
    const own = new SQL({ url, max: 2 }), sets = [];
    const lockTimeouts = () => sets.map(q => /lock_timeout = (\d+)/.exec(q)?.[1]).filter(Boolean).map(Number);
    const spied = new Proxy(own, { get(t, k) {
      if (k !== "begin") { const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v; }
      return f => t.begin(tx => f(new Proxy(tx, { get(x, kk) {
        const v = Reflect.get(x, kk);
        if (kk === "unsafe") return (q, ...a) => { sets.push(q); return v.call(x, q, ...a); };
        return typeof v === "function" ? v.bind(x) : v;
      } })));
    } });
    const store = await postgresStore({ sql: spied, schema, leaseLockTimeoutMs: 5_000 });
    const stalled = await client().reserve();
    try {
      await store.acquire(T, B, "h-a", 60_000);
      await stalled.unsafe("BEGIN");
      await stalled.unsafe(`SELECT epoch FROM "${schema}".pl_leases WHERE tenant = $1 AND board = $2 FOR SHARE`, [T, B]);
      for (const call of [() => store.renew(T, B, "h-a", 1, 400), () => store.acquire(T, B, "h-b", 400)]) {
        sets.length = 0;
        const t0 = performance.now();
        const got = await orHung(code(call()));
        const took = performance.now() - t0;
        expect(got).toBe("unavailable");
        expect(took).toBeGreaterThanOrEqual(150);                  // it did wait on the lock ...
        expect(lockTimeouts()).toEqual([200]);                     // ... bounded at ttl/2 = 200 ms, not the 5 s setting
      }
      await stalled.unsafe("ROLLBACK");
      sets.length = 0;
      await store.release(T, B, "h-a", 1);                         // no ttl: leaseLockTimeoutMs itself bounds it
      expect(lockTimeouts()).toEqual([5_000]);
    } finally { await stalled.unsafe("ROLLBACK").catch(() => {}); stalled.release(); await store.close(); await own.close(); await drop(schema); }
  }, 60_000);   // two calls, each may wait HUNG_MS before the test calls it hung

  test("M1: a holder paused mid-write is cut off by the server (idle_in_transaction_session_timeout), so the takeover goes through", async () => {
    const schema = schemaName();
    const own = new SQL({ url, max: 2 });
    // The holder's client: a real fenced append that stops sending right after its fence (FOR SHARE), as a paused
    // process or a partition would, leaving its transaction open on the server.
    let resume, fenced;
    const pause = new Promise(r => { resume = r; }), atFence = new Promise(r => { fenced = r; });
    const pausing = tx => new Proxy(tx, { get: (t, k) => k !== "unsafe" ? (typeof t[k] === "function" ? t[k].bind(t) : t[k])
      : async (q, args) => { const out = await t.unsafe(q, args); if (/FOR SHARE/.test(q)) { fenced(); await pause; } return out; } });
    const holderSql = new Proxy(own, { get: (o, k) => k === "begin" ? f => o.begin(tx => f(pausing(tx))) : (typeof o[k] === "function" ? o[k].bind(o) : o[k]) });
    const holder = await postgresStore({ sql: holderSql, schema, txIdleTimeoutMs: 300 });
    const other = await postgresStore({ sql: client(), schema, leaseLockTimeoutMs: 5_000 });
    try {
      expect((await other.settings()).idle_in_transaction_session_timeout).toBe("5s");      // every write transaction sets it
      const { epoch } = await holder.acquire(T, B, "h-a", 100);
      const p = code(holder.append(T, B, [entry(1)], 0, epoch));
      await atFence;                                                // paused, its FOR SHARE held
      await Bun.sleep(150);                                         // the lease lapses
      const took = await other.acquire(T, B, "h-b", 60_000);        // waits only until the server ends the paused transaction
      expect(took?.epoch).toBe(epoch + 1);
      resume();
      expect(await p).toBe("unavailable");                          // never lands; R2-L2: a PortError, not a raw PostgresError (25P03)
      expect(await other.lastSeq(T, B)).toBe(0);
    } finally { resume(); await holder.close(); await other.close(); await own.close().catch(() => {}); await drop(schema); }
  });

  for (const [priv, table] of [["UPDATE", "pl_leases"], ["DELETE", "pl_leases"], ["DELETE", "pl_entries"]]) {
    test(`L3: a role without ${priv} on ${table} is refused at start-up (denied), not at its first fenced write or purge`, async () => {
      const [{ ok }] = await client().unsafe("SELECT rolsuper OR rolcreaterole AS ok FROM pg_roles WHERE rolname = current_user");
      if (!ok) { console.warn(`pg-store: skipping L3 ${priv} ${table} (the DATABASE_URL role can't create roles)`); return; }
      const schema = schemaName(), role = `pl_test_app_${process.pid}_${++n}`, pass = "pl-test-" + Date.now().toString(36);
      const owner = await postgresStore({ sql: client(), schema });
      await owner.close();
      await client().unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${pass}'`);
      await client().unsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
      await client().unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
      await client().unsafe(`REVOKE ${priv} ON "${schema}".${table} FROM "${role}"`);
      const u = new URL(url); u.username = role; u.password = pass;
      const app = new SQL({ url: u.toString(), max: 2 });
      try {
        const err = await postgresStore({ sql: app, schema }).then(() => null, e => e);
        expect(err?.code).toBe("denied");
        expect(err.message).toContain(`${priv} on ${table}`);
      } finally {
        await app.close(); await drop(schema);
        await client().unsafe(`DROP ROLE IF EXISTS "${role}"`);
      }
    });
  }

  test("ten stores on separate pools racing at one seq: exactly one wins per round", async () => {
    const schema = schemaName();
    let stores = [];
    try {
      const opened = await Promise.allSettled(Array.from({ length: 10 }, () => postgresStore({ url, schema, max: 2 })));   // concurrent schema creation too
      stores = opened.filter(x => x.status === "fulfilled").map(x => x.value);
      expect(opened.filter(x => x.status === "rejected").map(x => String(x.reason))).toEqual([]);
      const e = await own(stores[0]);   // one epoch for all: this race is the conditional append's (the fence's is in the contract)
      for (let at = 0; at < 10; at++) {
        const res = await Promise.all(stores.map((s, i) => code(s.append(T, B, [entry(at + 1, { by: `h${i}` })], at, e))));
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
      expect(await store.openEpoch(T, B)).toBe(1);
      const l = await store.acquire(T, B, "h-a", 60_000);                         // lease writes and FOR SHARE need only row grants
      await store.append(T, B, [entry(1)], 0, l.epoch);
      expect((await store.read(T, B, 1, 10)).map(e => e.seq)).toEqual([1]);
      await store.append(T, B, [entry(2)], 1, l.epoch);
      await store.renew(T, B, "h-a", l.epoch, 60_000);
      await store.putCheckpoint(T, B, { seq: 1, id: "c:1", by: "u1", at: 1 }, l.epoch);
      await store.release(T, B, "h-a", l.epoch);
      expect((await store.getCheckpoint(T, B))?.seq).toBe(1);
      await store.blobPend(T, B, "c".repeat(40), 60_000);                          // INSERT/UPDATE on pl_blob_pending
      await store.append(T, B, [entry(3)], 2, l.epoch, { blobRefs: ["d".repeat(40)] });   // INSERT on pl_blob_refs, DELETE on pl_blob_pending and pl_blob_condemned
      await store.purgeBoard(T, B);                                              // the Trash purge: DELETE on pl_entries, pl_checkpoints(+parts), pl_leases and the blob tables; INSERT into pl_blob_condemned
      expect((await store.blobCondemned({ graceMs: 0, limit: 10 })).map(r => r.sha1)).toEqual(["c".repeat(40), "d".repeat(40)]);
      expect(await store.blobClaim(T, "c".repeat(40), { graceMs: 0, claimMs: 60_000 })).toBe(true);   // UPDATE on pl_blob_condemned
      expect(await store.blobReaped(T, "c".repeat(40))).toBe(true);
      expect(await store.blobPrune(10)).toBe(0);
      expect(await store.read(T, B, 1, 10)).toEqual([]);
      expect(await store.getCheckpoint(T, B)).toBe(null);
      await store.close();
      // The same role on a schema nobody migrated: refused (it may not CREATE), so the test above proves least privilege.
      const denied = await postgresStore({ sql: app, schema: bare }).then(() => null, e => e);
      expect(denied?.code).toBe("denied");                                       // wrapped, with the fix in the message
      expect(denied.message).toMatch(/permission denied.*run the migrate step as the schema owner/s);
      await expect(app.unsafe(`CREATE TABLE "${schema}".pl_extra (x INT)`)).rejects.toThrow(/permission denied/);
    } finally {
      await app.close();
      await drop(schema); await drop(bare);
      await client().unsafe(`DROP ROLE IF EXISTS "${role}"`);
    }
  });

  test("#92 no backfill: a blob table with other columns than this version's is an old-format store, refused with code old-format and left as found", async () => {
    for (const table of ["pl_blob_refs", "pl_blob_pending", "pl_blob_condemned"]) {
      const schema = schemaName();
      try {
        await (await postgresStore({ sql: client(), schema })).close();
        await client().unsafe(`DROP TABLE "${schema}".${table}`);
        await client().unsafe(`CREATE TABLE "${schema}".${table} (tenant TEXT NOT NULL, sha1 TEXT NOT NULL)`);
        const err = await postgresStore({ sql: client(), schema }).then(() => null, e => e);
        expect(err?.code).toBe("old-format");
        expect(err.message).toContain(table);
        expect((await client().unsafe(`SELECT count(*)::int AS c FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0`, [`"${schema}".${table}`]))[0].c).toBe(2);
      } finally { await drop(schema); }
    }
  });

  test("start-up probe (#92): a role short of one right on a blob table is refused with code denied, naming the table and the right", async () => {
    const [{ ok }] = await client().unsafe("SELECT rolsuper OR rolcreaterole AS ok FROM pg_roles WHERE rolname = current_user");
    if (!ok) { console.warn("pg-store: skipping the blob grants probe (the DATABASE_URL role can't create roles)"); return; }
    const schema = schemaName(), role = `pl_test_blobprobe_${process.pid}_${++n}`, pass = "pl-test-" + Date.now().toString(36);
    let app = null;
    try {
      await (await postgresStore({ sql: client(), schema })).close();
      await client().unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${pass}'`);
      await client().unsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
      await client().unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
      const u = new URL(url); u.username = role; u.password = pass;
      app = new SQL({ url: u.toString(), max: 1 });
      for (const [table, right] of [["pl_blob_refs", "DELETE"], ["pl_blob_refs", "INSERT"], ["pl_blob_pending", "UPDATE"], ["pl_blob_pending", "DELETE"], ["pl_blob_condemned", "UPDATE"], ["pl_blob_condemned", "DELETE"], ["pl_blob_condemned", "INSERT"]]) {
        await client().unsafe(`REVOKE ${right} ON "${schema}".${table} FROM "${role}"`);
        const err = await postgresStore({ sql: app, schema }).then(() => null, e => e);
        expect(err?.code).toBe("denied");
        expect(err.message).toContain(`lacks ${right} on ${table})`);
        await client().unsafe(`GRANT ${right} ON "${schema}".${table} TO "${role}"`);
      }
      await (await postgresStore({ sql: app, schema })).close?.();                  // every right: it starts
    } finally { if (app) await app.close(); await drop(schema); await client().unsafe(`DROP ROLE IF EXISTS "${role}"`); }
  });

  test("upgrade: a schema made before checkpoint parts gets pl_checkpoint_parts on the owner's next start and still reads its one-row checkpoints", async () => {
    const schema = schemaName();
    try {
      await (await postgresStore({ sql: client(), schema })).close?.();
      await client().unsafe(`DROP TABLE "${schema}".pl_checkpoint_parts`);                  // the schema as the old release left it
      const cp = { seq: 4, pad: "😀".repeat(500) };
      await client().unsafe(`INSERT INTO "${schema}".pl_checkpoints (tenant, board, seq, data) VALUES ($1, $2, 4, $3)`, [T, B, JSON.stringify(cp)]);
      const store = await postgresStore({ sql: client(), schema, partChars: 300 });        // migrate creates the missing table
      expect(await store.getCheckpoint(T, B)).toEqual(cp);
      const e = await store.openEpoch(T, B);
      await store.putCheckpoint(T, B, { ...cp, seq: 5 }, e);
      expect((await store.getCheckpoint(T, B)).seq).toBe(5);
      expect((await client().unsafe(`SELECT count(*)::int AS c FROM "${schema}".pl_checkpoint_parts`))[0].c).toBeGreaterThan(1);
      await store.close();
    } finally { await drop(schema); }
  });

  // ---- The checkpoint lock (a header's commit vs a sweep's delete) ----
  const PART = 4000;
  const big = (seq, tag) => ({ seq, tag, streams: { board: { elements: Array.from({ length: 125 }, (_, i) => ({ id: `e${i}`, text: "x".repeat(70) + tag })) } } });
  const lockKey = (schema, t = T, b = B) => `plenary-cp:${schema}:${t}:${b}`;
  /** An outside session holding the board's checkpoint lock until `release()`. */
  const holdLock = async (schema, t, b) => {
    let release; const held = new Promise(r => { release = r; });
    let acquired; const got = new Promise(r => { acquired = r; });
    const tx = client().begin(async q => { await q.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey(schema, t, b)]); acquired(); await held; });
    await got;
    return { release: async () => { release(); await tx; } };
  };

  test("the header's transaction takes the checkpoint lock: a sweep released into the window between its part count and its commit waits, and the checkpoint stays readable", async () => {
    const schema = schemaName();
    const gateA = Promise.withResolvers(), gateB = Promise.withResolvers(), bReady = Promise.withResolvers();
    let holdA = true, holdB = true, counted = false;
    const store = await postgresStore({ sql: client(), schema, partChars: PART, onPart: async step => {
      if (step === "header" && holdA) { holdA = false; await gateA.promise; }                 // seq 25: every part in, header held back
      else if (step === "sweep" && holdB) { holdB = false; bReady.resolve(); await gateB.promise; }   // seq 30: header landed, its sweep paused
      else if (step === "header-counted" && counted) { counted = false; gateB.resolve(); await Bun.sleep(150); }   // 25 has counted its parts: the sweep's delete runs now
    } });
    try {
      const e = await own(store);
      const late = store.putCheckpoint(T, B, big(25, "late"), e);
      await Bun.sleep(30);
      const newest = store.putCheckpoint(T, B, big(30, "newest"), e);
      await bReady.promise;
      counted = true; gateA.resolve();
      await Promise.all([late, newest]);
      expect((await store.getCheckpoint(T, B)).tag).toBe("newest");
      expect((await store.getCheckpoint(T, B, 30))?.tag).toBe("late");                         // complete: without the lock the delete wins and this is skipped
      await store.close();
    } finally { await drop(schema); }
  });

  test("an outside session holding the checkpoint lock: a write's header gives up as unavailable naming it, within ~2 x leaseLockTimeoutMs, and a sweep waits no longer than that", async () => {
    const schema = schemaName();
    const t = 300;
    let hold = null, takeOnSweep = false;
    const store = await postgresStore({ sql: client(), schema, partChars: PART, leaseLockTimeoutMs: t, onPart: async step => {
      if (step === "sweep" && takeOnSweep && !hold) hold = await holdLock(schema);   // the first sweep finds the lock taken
    } });
    try {
      const e = await own(store);
      // (a) the lock is taken before the write: its header can't commit.
      let first = await holdLock(schema);
      const t0 = performance.now();
      const err = await store.putCheckpoint(T, B, big(10, "a"), e).catch(x => x);
      expect(err.code).toBe("unavailable");
      expect(err.message).toContain("checkpoint lock");
      expect(performance.now() - t0).toBeLessThan(2 * t + 1500);                         // plus the parts' own writes; far under the 4 s of an unbounded wait
      await first.release();
      expect(await store.getCheckpoint(T, B)).toBe(null);                                // nothing became visible
      takeOnSweep = true;
      // (b) a sweep that can't get the lock gives up quietly: the write itself succeeded.
      await client().unsafe(`INSERT INTO "${schema}".pl_checkpoint_parts (tenant, board, seq, wid, n, data) VALUES ($1, $2, 1, 'orphan', 0, 'x')`, [T, B]);
      const t1 = performance.now();
      await store.putCheckpoint(T, B, big(20, "b"), e);
      expect(performance.now() - t1).toBeLessThan(2 * t + 1500);
      expect((await store.getCheckpoint(T, B)).tag).toBe("b");
      await hold.release();
      await store.putCheckpoint(T, B, big(30, "c"), e);                                  // the next write sweeps the orphan
      expect((await client().unsafe(`SELECT count(*)::int AS c FROM "${schema}".pl_checkpoint_parts WHERE wid = 'orphan'`))[0].c).toBe(0);
      await store.close();
    } finally { await drop(schema); }
  });

  test("bad schema names and missing connection are refused", async () => {
    await expect(postgresStore({ sql: client(), schema: 'x"; DROP TABLE y; --' })).rejects.toThrow("bad schema name");
    await expect(postgresStore({ sql: client(), schema: "Upper" })).rejects.toThrow("bad schema name");
    await expect(postgresStore({ schema: "x" })).rejects.toThrow("pass url or sql");
  });
});
