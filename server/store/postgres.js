// The Store port on Postgres (PROTOCOL.md § Store): the durable log and checkpoints for a cluster.
// Same contract as server/store/sqlite.js (method names, errors, the `maxBytes` / `bytes` read extension):
//
//   append(tenant, board, entries, expectSeq, epoch)    atomic and conditional; a stale expectSeq throws PortError
//                                               "conflict"; an `epoch` not the lease's throws "fenced"; none: "bad-entry"
//   read(tenant, board, fromSeq, limit, maxBytes?)   entries with seq >= fromSeq, ascending, at most `limit`
//   lastSeq(tenant, board)                      the board's last seq (0 = empty)
//   putCheckpoint(tenant, board, cp, epoch)     kept by cp.seq; the newest few per board are kept; fenced like append
//   getCheckpoint(tenant, board, beforeSeq?)    the highest seq (below beforeSeq, if given), never the last write
//   openEpoch(tenant, board), epoch(tenant, board)   the board's epoch in its lease record (pl_leases)
//   acquire / renew / release / lease           the board's lease (holder, epoch, expires_at), as in sqlite.js
//
// Lease time is the DATABASE's clock (clock_timestamp(), in ms since 1970): never the caller's, and not now() (frozen
// at the start of the transaction). Hosts never compare their clocks with it or each other. It is stamped when the
// statement evaluates it: acquire's ON CONFLICT DO UPDATE evaluates after it has the row lock, but renew's plain
// UPDATE evaluates before waiting on the lock, so a renew stuck behind a lock may get a shorter lease (never a longer
// one than the holder's own deadline, send time + ttl).
//
// Bounded waits (p4-store-leasev M1): every write transaction runs with idle_in_transaction_session_timeout
// (`txIdleTimeoutMs`), so a holder paused mid-write is cut off by the server and its FOR SHARE lock released; lease
// calls run with lock_timeout (`leaseLockTimeoutMs`, and at most half the ttl), and a lock wait past it is PortError
// "unavailable": try again. A write the server cut off (SQLSTATE 25P03) is PortError "unavailable" too: none of it
// committed.
//
// The epoch fence: a fenced append or checkpoint reads the lease row FOR SHARE in its own transaction. A takeover's
// acquire (an UPDATE of that row) waits for every such write in flight to commit, and a write that starts after it
// reads the new epoch. So no stale holder's write commits after a takeover commits.
//
// Least privilege: start-up creates only missing tables (migrate() in server/pg/schema.js, to_regclass first), so
// the server may run as a role that reads and writes the tables without owning the schema. It never ALTERs: a
// pl_leases from before the lease is refused with the owner's one-off fix (LEASE_UPGRADE_SQL). Start-up waits at most
// `lockTimeoutMs` for the schema's start-up lock, and a missing privilege is reported as such.
//
// Durable = the write's transaction commits with `SET LOCAL synchronous_commit = on` (the WAL record is flushed on
// this server before COMMIT returns; synchronous standbys, if any are configured, also confirm). It is set per
// transaction, not per session, because the client is a pool and a session setting would stick to one connection.
//
// Fencing: `append` reads max(seq) and inserts in one transaction. READ COMMITTED only ever sees committed rows, so a
// writer can't build on a seq that is later rolled back (no gap); two writers at one seq meet at the primary key
// (tenant, board, seq): the second blocks until the first commits, then fails 23505, reported as "conflict".
//
// The factory is async (the schema is created on start, idempotently, under an advisory lock so several processes
// starting at once don't race on the catalog). Pass `url` (the adapter owns that pool and closes it) or `sql` (a Bun
// SQL client you own; close() leaves it open). `max` caps the pool the adapter opens from `url` (Bun's pool
// opens up to its max, default 10, under concurrent load, so size it against Postgres's max_connections). `schema` names the Postgres schema the tables live in (tests use one
// per test). The adapter never reads the environment.

import { SQL } from "bun";
import { needId, PortError, mintClusterId } from "../ids.js";
import { encodeSliced } from "../encode/sliced.js";
import { needSchema, migrate } from "../pg/schema.js";

const MAX_READ = 10_000;
const posInt = v => Number.isSafeInteger(v) && v > 0;
/** Postgres SQLSTATE for a unique violation. Bun's PostgresError carries it as `errno`. */
const UNIQUE = "23505";

/**
 * The Store's tables (§ Store, Least privilege). Created by `migrate` (server/pg/schema.js), which looks each table
 * up first and creates only what is missing. An operator may run that as the owner role ahead of time
 * (`plenary migrate` is phase 4's).
 */
export const STORE_TABLES = Object.freeze({
  pl_entries: "tenant TEXT NOT NULL, board TEXT NOT NULL, seq BIGINT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (tenant, board, seq)",
  pl_checkpoints: "tenant TEXT NOT NULL, board TEXT NOT NULL, seq BIGINT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (tenant, board, seq)",
  // The board's lease record (§ Recovery, Room identity): holder NULL = unheld (released, or a single-node openEpoch).
  // expires_at: ms on the database's clock.
  pl_leases: "tenant TEXT NOT NULL, board TEXT NOT NULL, epoch BIGINT NOT NULL, holder TEXT, expires_at BIGINT, PRIMARY KEY (tenant, board)",
  // The cluster id (§ Bus, Cluster id): at most one row, minted by the first node that asks; `singleton` is the key, so a second row can't exist.
  pl_cluster: "id TEXT NOT NULL, singleton BOOLEAN NOT NULL DEFAULT true PRIMARY KEY CHECK (singleton)",
});
/** Columns a pl_leases made before the lease (epoch only) lacks. Start-up checks for them and never adds them. */
const LEASE_COLUMNS = Object.freeze({ holder: "TEXT", expires_at: "BIGINT" });
/**
 * The operator's one-off upgrade of a pre-lease schema, run as the schema owner (deploy/README.md). Idempotent.
 * @param {string} schema
 */
export const LEASE_UPGRADE_SQL = schema =>
  `ALTER TABLE "${needSchema(schema)}".pl_leases ADD COLUMN IF NOT EXISTS holder TEXT, ADD COLUMN IF NOT EXISTS expires_at BIGINT;`;
/** SQLSTATEs: insufficient_privilege; lock_not_available (lock_timeout fired); idle_in_transaction_session_timeout. */
const DENIED = "42501", LOCK_TIMEOUT = "55P03", IDLE_CUT = "25P03";
/** What the Store's statements need on each table (L3: probed at start-up, so a misgrant fails at open). */
const NEEDS = Object.freeze({
  pl_entries: ["SELECT", "INSERT"],
  pl_checkpoints: ["SELECT", "INSERT", "DELETE"],
  pl_leases: ["SELECT", "INSERT", "UPDATE"],   // UPDATE: the lease calls, and FOR SHARE in a fenced write
  pl_cluster: ["SELECT", "INSERT"],
});
/** The database's clock, ms since 1970. */
const DB_NOW = "(extract(epoch FROM clock_timestamp()) * 1000)::bigint";
const MAX_TTL = 10 * 60_000;

/**
 * @param {{ url?: string, sql?: import("bun").SQL, max?: number, schema?: string, keepCheckpoints?: number, lockTimeoutMs?: number }} o
 *   lockTimeoutMs: how long start-up waits for the schema's start-up lock (default 15 s), then fails with code "lock-timeout".
 *   txIdleTimeoutMs: a write transaction idle this long (its client paused mid-write) is ended by the server (default 5 s).
 *   leaseLockTimeoutMs: the longest a lease call waits on a row lock (default 2 s, at most half its ttl), then "unavailable".
 * @returns {Promise<{ append: Function, read: Function, lastSeq: Function, putCheckpoint: Function,
 *   getCheckpoint: Function, openEpoch: Function, epoch: Function, acquire: Function, renew: Function,
 *   release: Function, lease: Function, settings(): Promise<object>, clusterId(): Promise<string>, close(): Promise<void> }>}
 */
export async function postgresStore({ url, sql, max, schema = "public", keepCheckpoints = 3, lockTimeoutMs = 15_000,
  txIdleTimeoutMs = 5_000, leaseLockTimeoutMs = 2_000 }) {
  if (!sql && !url) throw new Error("postgres store: pass url or sql");
  const s = needSchema(schema);
  const owned = !sql;
  const db = sql ?? new SQL(max ? { url, max } : url);
  let open = true;
  const K = `"${s}".pl_cluster`, E = `"${s}".pl_entries`, C = `"${s}".pl_checkpoints`, L = `"${s}".pl_leases`;

  try {
    await db.begin(async tx => {
      // A wedged migrator or a hung node holding the schema lock must not block every start-up forever.
      await tx.unsafe(`SET LOCAL lock_timeout = ${Math.max(1, Math.floor(lockTimeoutMs))}`);
      await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [`plenary-schema:${s}`]);
      await migrate(tx, s, STORE_TABLES);
      // Start-up never ALTERs (least privilege): a pl_leases from before the lease is refused with the operator's fix.
      const have = new Set((await tx.unsafe(`SELECT attname FROM pg_attribute
        WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped`, [L])).map(r => r.attname));
      const missing = Object.keys(LEASE_COLUMNS).filter(c => !have.has(c));
      if (missing.length) throw Object.assign(new Error(`postgres store: ${L} predates the lease (missing ${missing.join(", ")}). `
        + `Run as the schema owner: ${LEASE_UPGRADE_SQL(s)}`), { code: "needs-migration" });
      // L3: every privilege the Store's statements use, checked now (a misgrant would otherwise surface at the first
      // fenced write, as a raw 42501). Thrown as Postgres's own 42501, so it is reported like any refusal below.
      const lacking = [];
      for (const [table, privs] of Object.entries(NEEDS)) for (const priv of privs) {
        const [{ ok }] = await tx.unsafe("SELECT has_table_privilege($1, $2) AS ok", [`"${s}".${table}`, priv]);
        if (!ok) lacking.push(`${priv} on ${table}`);
      }
      if (lacking.length) throw Object.assign(new Error(`permission denied: this role lacks ${lacking.join(", ")}`), { errno: DENIED });
    });
  } catch (err) {
    if (owned) await db.close();
    if (err?.errno === LOCK_TIMEOUT) {
      throw Object.assign(new Error(`postgres store: start-up waited ${lockTimeoutMs} ms for schema "${s}"'s start-up lock, `
        + "held by another session (a migrate or a node starting); try again, or end that session", { cause: err }), { code: "lock-timeout" });
    }
    if (err?.errno === DENIED) {
      throw Object.assign(new Error(`postgres store: start-up in schema "${s}" was refused for lack of a privilege (${err.message}). `
        + "If tables are missing, run the migrate step as the schema owner; otherwise grant this role USAGE on the schema "
        + "and SELECT, INSERT, UPDATE, DELETE on its tables (deploy/README.md, Postgres roles)", { cause: err }), { code: "denied" });
    }
    throw err;
  }

  const ready = (tenant, board) => {
    if (!open) throw new PortError("closed", "the store is closed");
    needId(tenant, "tenant"); needId(board, "board");
  };
  const ms = v => Math.max(1, Math.floor(v));
  /**
   * One durable write transaction: every write path goes through here, so none can miss synchronous_commit or the
   * idle cut-off. With `lockMs`, its lock waits are bounded too, and one that times out is PortError "unavailable".
   */
  const write = async (f, lockMs) => {
    try {
      return await db.begin(async tx => {
        await tx.unsafe(`SET LOCAL synchronous_commit = on; SET LOCAL idle_in_transaction_session_timeout = ${ms(txIdleTimeoutMs)}`
          + (lockMs ? `; SET LOCAL lock_timeout = ${ms(lockMs)}` : ""));
        return f(tx);
      });
    } catch (err) {
      if (lockMs && err?.errno === LOCK_TIMEOUT) throw new PortError("unavailable", "the lease row is locked by another session: try again");
      // R2-L2: the server ended this transaction because its client went quiet mid-write (a pause, a partition).
      // Nothing of it committed; like any Store failure the caller retries or rebuilds. Never "fenced".
      if (err?.errno === IDLE_CUT) throw Object.assign(new PortError("unavailable", "the database ended this write: its client paused mid-transaction"), { cause: err });
      throw err;
    }
  };
  /** A lease call's lock bound: leaseLockTimeoutMs, and at most half its ttl. */
  const leaseLock = ttlMs => Math.min(leaseLockTimeoutMs, ttlMs === undefined ? leaseLockTimeoutMs : ttlMs / 2);
  const needEpoch = epoch => { if (epoch !== undefined && !posInt(epoch)) throw new PortError("bad-entry", "epoch must be a positive integer"); };
  /** Every write is fenced (p4-host, L5): append and putCheckpoint without the writer's lease epoch are refused. */
  const needWriteEpoch = epoch => { if (!posInt(epoch)) throw new PortError("bad-entry", "a write needs the board's lease epoch (a positive integer)"); };
  const needTtl = ttlMs => { if (!posInt(ttlMs) || ttlMs > MAX_TTL) throw new PortError("bad-entry", `ttlMs must be a positive integer up to ${MAX_TTL}`); };
  const granted = rows => rows.length ? { epoch: Number(rows[0].epoch), expiresAt: Number(rows[0].expires_at) } : null;
  /** The epoch fence, inside a write transaction: FOR SHARE holds off a takeover until this transaction ends. */
  const fence = async (tx, tenant, board, epoch) => {
    const rows = await tx.unsafe(`SELECT epoch FROM ${L} WHERE tenant = $1 AND board = $2 FOR SHARE`, [tenant, board]);
    const cur = rows.length ? Number(rows[0].epoch) : 0;
    if (cur !== epoch) throw new PortError("fenced", `the board's lease is at epoch ${cur}, not ${epoch}`);
  };
  const lastOf = async (q, tenant, board) =>
    Number((await q.unsafe(`SELECT coalesce(max(seq), 0) AS m FROM ${E} WHERE tenant = $1 AND board = $2`, [tenant, board]))[0].m);

  return {
    /**
     * Writes every entry or none, only if the board's last seq is `expectSeq` and only if `epoch` is
     * the board's lease epoch (else PortError "fenced"; no epoch at all is "bad-entry": every write is fenced). Resolves once durable.
     */
    async append(tenant, board, entries, expectSeq, epoch) {
      ready(tenant, board); needWriteEpoch(epoch);
      if (!Number.isSafeInteger(expectSeq) || expectSeq < 0) throw new PortError("bad-entry", "expectSeq must be a non-negative integer");
      if (!Array.isArray(entries) || !entries.length) throw new PortError("bad-entry", "append needs at least one entry");
      // Everything is checked and serialised before the transaction starts: a bad entry writes nothing.
      const seqs = [], datas = [];
      entries.forEach((e, i) => {
        if (!e || typeof e !== "object" || e.seq !== expectSeq + 1 + i) throw new PortError("bad-entry", `entry ${i} must have seq ${expectSeq + 1 + i}`);
        if (e.tenant !== tenant || e.board !== board) throw new PortError("bad-entry", `entry ${i} belongs to another board`);
        let data;
        try { data = JSON.stringify(e); } catch { data = undefined; }
        if (typeof data !== "string") throw new PortError("bad-entry", `entry ${i} can't be serialised`);
        seqs.push(e.seq); datas.push(data);
      });
      try {
        await write(async tx => {
          await fence(tx, tenant, board, epoch);   // first: a fenced host hears "fenced" (stop), not "conflict" (rebuild)
          const last = await lastOf(tx, tenant, board);
          if (last !== expectSeq) throw new PortError("conflict", `board is at seq ${last}, not ${expectSeq}`);
          await tx.unsafe(`INSERT INTO ${E} (tenant, board, seq, data)
            SELECT $1, $2, u.seq, u.data FROM unnest($3::int8[], $4::text[]) AS u(seq, data)`, [tenant, board, seqs, datas]);
        });
      } catch (err) {
        if (err instanceof PortError) throw err;
        // The unique key fired: someone else holds that seq. Same answer as a stale expectSeq.
        if (err?.errno === UNIQUE) throw new PortError("conflict", "that seq is already written");
        throw err;
      }
    },

    /**
     * Entries with seq >= fromSeq, ascending, at most `limit` (default 1000, capped at 10,000). With `maxBytes`, the
     * page also stops once it holds about that much stored text (always >= 1 entry); the array carries `bytes`
     * (each entry's stored length, same order). Same extension as the SQLite adapter.
     */
    async read(tenant, board, fromSeq = 1, limit = 1000, maxBytes) {
      ready(tenant, board);
      if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) throw new PortError("bad-entry", "fromSeq must be a non-negative integer");
      if (!posInt(limit)) throw new PortError("bad-entry", "limit must be a positive integer");
      if (maxBytes !== undefined && !posInt(maxBytes)) throw new PortError("bad-entry", "maxBytes must be a positive integer");
      let n = Math.min(limit, MAX_READ);
      if (maxBytes !== undefined) {
        // Sizes first (no row text is sent), then only as many rows as fit.
        const sizes = await db.unsafe(`SELECT length(data) AS n FROM ${E} WHERE tenant = $1 AND board = $2 AND seq >= $3
          ORDER BY seq ASC LIMIT $4`, [tenant, board, fromSeq, n]);
        let sum = 0, fit = 0;
        for (const r of sizes) { const k = Number(r.n); if (fit && sum + k > maxBytes) break; sum += k; fit++; }
        if (!fit) return Object.assign([], { bytes: [] });
        n = fit;
      }
      const rows = await db.unsafe(`SELECT data FROM ${E} WHERE tenant = $1 AND board = $2 AND seq >= $3
        ORDER BY seq ASC LIMIT $4`, [tenant, board, fromSeq, n]);
      const bytes = [], out = [];
      for (const r of rows) { bytes.push(r.data.length); out.push(JSON.parse(r.data)); }
      return Object.assign(out, { bytes });
    },

    /** The board's last seq, 0 if it has no entries. */
    async lastSeq(tenant, board) {
      ready(tenant, board);
      return lastOf(db, tenant, board);
    },

    /**
     * Stores `cp` under its seq (`cp.seq` is required). The first write for a seq is kept; all but the newest
     * `keepCheckpoints` per board are pruned in the same transaction. An older one never hides a newer one.
     */
    async putCheckpoint(tenant, board, cp, epoch) {
      ready(tenant, board); needWriteEpoch(epoch);
      if (!cp || typeof cp !== "object" || !Number.isSafeInteger(cp.seq) || cp.seq < 0) throw new PortError("bad-entry", "a checkpoint needs a seq");
      const data = await encodeSliced(cp);   // in slices: the event loop breathes between them
      await write(async tx => {
        await fence(tx, tenant, board, epoch);
        await tx.unsafe(`INSERT INTO ${C} (tenant, board, seq, data) VALUES ($1, $2, $3, $4)
          ON CONFLICT (tenant, board, seq) DO NOTHING`, [tenant, board, cp.seq, data]);
        await tx.unsafe(`DELETE FROM ${C} WHERE tenant = $1 AND board = $2 AND seq NOT IN
          (SELECT seq FROM ${C} WHERE tenant = $1 AND board = $2 ORDER BY seq DESC LIMIT $3)`, [tenant, board, keepCheckpoints]);
      });
    },

    /** The checkpoint with the highest seq; with `beforeSeq`, the highest below it (to step back past a bad one). */
    async getCheckpoint(tenant, board, beforeSeq) {
      ready(tenant, board);
      if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) throw new PortError("bad-entry", "beforeSeq must be a non-negative integer");
      const rows = await db.unsafe(`SELECT data FROM ${C} WHERE tenant = $1 AND board = $2 AND seq < $3
        ORDER BY seq DESC LIMIT 1`, [tenant, board, beforeSeq ?? Number.MAX_SAFE_INTEGER]);
      return rows.length ? JSON.parse(rows[0].data) : null;
    },

    /**
     * A room is being built: the board's next epoch (1 on the first call), committed durably before it resolves.
     * Single node: it takes the board without a lease (holder cleared), so any lease holder is fenced off.
     */
    async openEpoch(tenant, board) {
      ready(tenant, board);
      const rows = await write(tx => tx.unsafe(`INSERT INTO ${L} (tenant, board, epoch) VALUES ($1, $2, 1)
        ON CONFLICT (tenant, board) DO UPDATE SET epoch = ${L}.epoch + 1, holder = NULL, expires_at = NULL RETURNING epoch`, [tenant, board]));
      return Number(rows[0].epoch);
    },

    /** The board's latest epoch; 0 = no room was ever built. */
    async epoch(tenant, board) {
      ready(tenant, board);
      const rows = await db.unsafe(`SELECT epoch FROM ${L} WHERE tenant = $1 AND board = $2`, [tenant, board]);
      return rows.length ? Number(rows[0].epoch) : 0;
    },

    /**
     * Takes the board's lease if nobody holds it, it has expired (database clock), or `holder` holds it. Every
     * success is a new room incarnation: the epoch rises by 1 in the same row and the same commit. null = held.
     * ON CONFLICT DO UPDATE locks the row and judges the WHERE on its latest version, so two racers can't both win.
     * @returns {Promise<null | { epoch: number, expiresAt: number }>} expiresAt is on the database's clock
     */
    async acquire(tenant, board, holder, ttlMs) {
      ready(tenant, board); needId(holder, "holder"); needTtl(ttlMs);
      return granted(await write(tx => tx.unsafe(`INSERT INTO ${L} (tenant, board, epoch, holder, expires_at)
        VALUES ($1, $2, 1, $3, ${DB_NOW} + $4)
        ON CONFLICT (tenant, board) DO UPDATE SET epoch = ${L}.epoch + 1, holder = $3, expires_at = ${DB_NOW} + $4
        WHERE ${L}.holder IS NULL OR ${L}.expires_at IS NULL OR ${L}.expires_at <= ${DB_NOW} OR ${L}.holder = $3
        RETURNING epoch, expires_at`, [tenant, board, holder, ttlMs]), leaseLock(ttlMs)));
    },

    /** Extends the lease to now + ttlMs (database clock), only for its holder at that epoch; else null. */
    async renew(tenant, board, holder, epoch, ttlMs) {
      ready(tenant, board); needId(holder, "holder"); needEpoch(epoch); needTtl(ttlMs);
      if (epoch === undefined) throw new PortError("bad-entry", "renew needs the lease's epoch");
      return granted(await write(tx => tx.unsafe(`UPDATE ${L} SET expires_at = ${DB_NOW} + $5
        WHERE tenant = $1 AND board = $2 AND holder = $3 AND epoch = $4 RETURNING epoch, expires_at`, [tenant, board, holder, epoch, ttlMs]), leaseLock(ttlMs)));
    },

    /** Gives the lease up if `holder` holds it at `epoch`; otherwise does nothing. The epoch is kept. */
    async release(tenant, board, holder, epoch) {
      ready(tenant, board); needId(holder, "holder"); needEpoch(epoch);
      if (epoch === undefined) throw new PortError("bad-entry", "release needs the lease's epoch");
      await write(tx => tx.unsafe(`UPDATE ${L} SET holder = NULL, expires_at = NULL
        WHERE tenant = $1 AND board = $2 AND holder = $3 AND epoch = $4`, [tenant, board, holder, epoch]), leaseLock());
    },

    /**
     * The lease record, judged on the database's clock: `live` = held and not expired; `remainingMs` = expires_at −
     * the database's now (0 unless live), computed in the same statement, so a caller never compares clocks.
     * null = no room ever built.
     */
    async lease(tenant, board) {
      ready(tenant, board);
      const rows = await db.unsafe(`SELECT holder, epoch, expires_at, n.now, (holder IS NOT NULL AND expires_at > n.now) AS live
        FROM ${L}, (SELECT ${DB_NOW} AS now) n WHERE tenant = $1 AND board = $2`, [tenant, board]);
      if (!rows.length) return null;
      const r = rows[0], live = r.live === true;
      return { holder: r.holder, epoch: Number(r.epoch), expiresAt: r.expires_at === null ? null : Number(r.expires_at), live,
        remainingMs: live ? Number(r.expires_at) - Number(r.now) : 0 };
    },

    /**
     * This database's cluster id (§ Bus, Cluster id): "c-" + 16 of [a-z0-9], minted by the first caller and the same
     * for every node and every later call, so two clusters on different databases never share an id and nodes on one
     * database always do. Durable before it is returned (a lost id would give nodes different ones).
     */
    async clusterId() {
      if (!open) throw new PortError("closed", "the store is closed");
      const read = async () => (await db.unsafe(`SELECT id FROM ${K}`))[0]?.id;
      const have = await read();
      if (have) return have;
      await write(tx => tx.unsafe(`INSERT INTO ${K} (id) VALUES ($1) ON CONFLICT DO NOTHING`, [mintClusterId()]));
      return read();   // the winner's row, whoever's it is
    },

    /** What a write transaction runs with, read back from Postgres (for /health and tests). */
    async settings() {
      return write(async tx => {
        const one = async name => Object.values((await tx.unsafe(`SHOW ${name}`))[0])[0];
        return { synchronous_commit: await one("synchronous_commit"), fsync: await one("fsync"),
          idle_in_transaction_session_timeout: await one("idle_in_transaction_session_timeout") };
      });
    },

    async close() { if (!open) return; open = false; if (owned) await db.close(); },
  };
}
