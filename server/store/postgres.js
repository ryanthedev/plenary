// The Store port on Postgres (PROTOCOL.md § Store): the durable log and checkpoints for a cluster.
// Same contract as server/store/sqlite.js (method names, errors, the `maxBytes` / `bytes` read extension):
//
//   append(tenant, board, entries, expectSeq)   atomic and conditional; a stale expectSeq throws PortError "conflict"
//   read(tenant, board, fromSeq, limit, maxBytes?)   entries with seq >= fromSeq, ascending, at most `limit`
//   lastSeq(tenant, board)                      the board's last seq (0 = empty)
//   putCheckpoint(tenant, board, cp)            kept by cp.seq; the newest few per board are kept
//   getCheckpoint(tenant, board, beforeSeq?)    the highest seq (below beforeSeq, if given), never the last write
//   openEpoch(tenant, board), epoch(tenant, board)   the board's epoch in its lease record (pl_leases)
//
// Least privilege: start-up creates only missing tables (migrate() in server/pg/schema.js, to_regclass first), so
// the server may run as a role that reads and writes the tables without owning the schema.
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
import { needId, PortError } from "../ids.js";
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
  // The board's lease record: its epoch now (§ Recovery, Room identity); phase 4 adds the holder and expiry.
  pl_leases: "tenant TEXT NOT NULL, board TEXT NOT NULL, epoch BIGINT NOT NULL, PRIMARY KEY (tenant, board)",
});

/**
 * @param {{ url?: string, sql?: import("bun").SQL, max?: number, schema?: string, keepCheckpoints?: number }} o
 * @returns {Promise<{ append: Function, read: Function, lastSeq: Function, putCheckpoint: Function,
 *   getCheckpoint: Function, settings(): Promise<object>, close(): Promise<void> }>}
 */
export async function postgresStore({ url, sql, max, schema = "public", keepCheckpoints = 3 }) {
  if (!sql && !url) throw new Error("postgres store: pass url or sql");
  const s = needSchema(schema);
  const owned = !sql;
  const db = sql ?? new SQL(max ? { url, max } : url);
  let open = true;
  const E = `"${s}".pl_entries`, C = `"${s}".pl_checkpoints`, L = `"${s}".pl_leases`;

  try {
    await db.begin(async tx => {
      await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [`plenary-schema:${s}`]);
      await migrate(tx, s, STORE_TABLES);
    });
  } catch (err) { if (owned) await db.close(); throw err; }

  const ready = (tenant, board) => {
    if (!open) throw new PortError("closed", "the store is closed");
    needId(tenant, "tenant"); needId(board, "board");
  };
  /** One durable write transaction: every write path goes through here, so none can miss synchronous_commit. */
  const write = f => db.begin(async tx => { await tx.unsafe("SET LOCAL synchronous_commit = on"); return f(tx); });
  const lastOf = async (q, tenant, board) =>
    Number((await q.unsafe(`SELECT coalesce(max(seq), 0) AS m FROM ${E} WHERE tenant = $1 AND board = $2`, [tenant, board]))[0].m);

  return {
    /** Writes every entry or none, only if the board's last seq is `expectSeq`. Resolves once durable. */
    async append(tenant, board, entries, expectSeq) {
      ready(tenant, board);
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
    async putCheckpoint(tenant, board, cp) {
      ready(tenant, board);
      if (!cp || typeof cp !== "object" || !Number.isSafeInteger(cp.seq) || cp.seq < 0) throw new PortError("bad-entry", "a checkpoint needs a seq");
      const data = JSON.stringify(cp);
      await write(async tx => {
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

    /** A room is being built: the board's next epoch (1 on the first call), committed durably before it resolves. */
    async openEpoch(tenant, board) {
      ready(tenant, board);
      const rows = await write(tx => tx.unsafe(`INSERT INTO ${L} (tenant, board, epoch) VALUES ($1, $2, 1)
        ON CONFLICT (tenant, board) DO UPDATE SET epoch = ${L}.epoch + 1 RETURNING epoch`, [tenant, board]));
      return Number(rows[0].epoch);
    },

    /** The board's latest epoch; 0 = no room was ever built. */
    async epoch(tenant, board) {
      ready(tenant, board);
      const rows = await db.unsafe(`SELECT epoch FROM ${L} WHERE tenant = $1 AND board = $2`, [tenant, board]);
      return rows.length ? Number(rows[0].epoch) : 0;
    },

    /** What a write transaction runs with, read back from Postgres (for /health and tests). */
    async settings() {
      return write(async tx => {
        const one = async name => Object.values((await tx.unsafe(`SHOW ${name}`))[0])[0];
        return { synchronous_commit: await one("synchronous_commit"), fsync: await one("fsync") };
      });
    },

    async close() { if (!open) return; open = false; if (owned) await db.close(); },
  };
}
