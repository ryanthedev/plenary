// The Store port on SQLite (PROTOCOL.md § Store): the durable log and checkpoints for a single node.
//
//   append(tenant, board, entries, expectSeq)   atomic and conditional; a stale expectSeq throws PortError "conflict"
//   read(tenant, board, fromSeq, limit, maxBytes?)   entries with seq >= fromSeq, ascending, at most `limit`
//                                               (and, if maxBytes is given, about that much text: always >= 1 entry)
//   lastSeq(tenant, board)                      the board's last seq (0 = empty)
//   putCheckpoint(tenant, board, cp)            kept by cp.seq; the newest few per board are kept
//   getCheckpoint(tenant, board, beforeSeq?)    the highest seq (below beforeSeq, if given), never the last write
//
// Durable = WAL + synchronous=FULL (+ fullfsync on macOS, where a plain fsync doesn't reach the platter): a
// resolved append survives a process crash and power loss. The API is async (Postgres will be); SQLite itself
// runs synchronously inside each call, so one call never interleaves with another in this process.
// The board registry is NOT here: it is the Registry port's (server/auth/registry.js).

import { Database } from "bun:sqlite";
import { needId, PortError } from "../ids.js";

const MAX_READ = 10_000;
const posInt = v => Number.isSafeInteger(v) && v > 0;

/** @param {{ path: string, fullfsync?: boolean, busyTimeoutMs?: number, keepCheckpoints?: number }} o — `path` is a file (":memory:" for throwaway use). */
export function sqliteStore({ path, fullfsync = true, busyTimeoutMs = 5000, keepCheckpoints = 3 }) {
  const db = new Database(path, { create: true, strict: true });
  let open = true;
  db.run(`PRAGMA busy_timeout=${Math.max(0, Math.floor(busyTimeoutMs))}`);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA synchronous=FULL");
  db.run(`PRAGMA fullfsync=${fullfsync ? "ON" : "OFF"}`);
  db.run(`PRAGMA checkpoint_fullfsync=${fullfsync ? "ON" : "OFF"}`);
  db.run(`CREATE TABLE IF NOT EXISTS entries (
    tenant TEXT NOT NULL, board TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (tenant, board, seq)) WITHOUT ROWID`);
  db.run(`CREATE TABLE IF NOT EXISTS checkpoints (
    tenant TEXT NOT NULL, board TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (tenant, board, seq)) WITHOUT ROWID`);

  const qLast = db.query("SELECT max(seq) AS m FROM entries WHERE tenant = ? AND board = ?");
  const qInsert = db.query("INSERT INTO entries (tenant, board, seq, data) VALUES (?, ?, ?, ?)");
  const qRead = db.query("SELECT data FROM entries WHERE tenant = ? AND board = ? AND seq >= ? ORDER BY seq ASC LIMIT ?");
  const qSizes = db.query("SELECT length(data) AS n FROM entries WHERE tenant = ? AND board = ? AND seq >= ? ORDER BY seq ASC LIMIT ?");
  // SEAM(p2): § Recovery decides how a bad checkpoint is dealt with. Today the first write for a seq is kept, a
  // second writer at that seq is ignored, one older than the newest `keepCheckpoints` is pruned at once, and there
  // is no call to remove a bad one (a rebuild steps past it with getCheckpoint's beforeSeq).
  // One row per (board, seq); the first write for a seq is kept. Older ones stay so a rebuild can step back past
  // a bad checkpoint (getCheckpoint's beforeSeq); all but the newest `keepCheckpoints` are pruned.
  const qPutCp = db.query("INSERT OR IGNORE INTO checkpoints (tenant, board, seq, data) VALUES (?, ?, ?, ?)");
  const qPruneCp = db.query(`DELETE FROM checkpoints WHERE tenant = ?1 AND board = ?2 AND seq NOT IN
    (SELECT seq FROM checkpoints WHERE tenant = ?1 AND board = ?2 ORDER BY seq DESC LIMIT ?3)`);
  const qGetCp = db.query("SELECT data FROM checkpoints WHERE tenant = ? AND board = ? AND seq < ? ORDER BY seq DESC LIMIT 1");
  const putCpTx = db.transaction((tenant, board, seq, data) => { qPutCp.run(tenant, board, seq, data); qPruneCp.run(tenant, board, keepCheckpoints); });

  // BEGIN IMMEDIATE: the write lock is taken before the read, so two handles (two processes) can't both see the
  // same last seq and both insert. The primary key is the second fence.
  const appendTx = db.transaction((tenant, board, rows, expectSeq) => {
    const last = qLast.get(tenant, board).m ?? 0;
    if (last !== expectSeq) throw new PortError("conflict", `board is at seq ${last}, not ${expectSeq}`);
    for (const [seq, data] of rows) qInsert.run(tenant, board, seq, data);
  });

  const ready = (tenant, board) => {
    if (!open) throw new PortError("closed", "the store is closed");
    needId(tenant, "tenant"); needId(board, "board");
  };

  return {
    /** Writes every entry or none, only if the board's last seq is `expectSeq`. Resolves once durable. */
    async append(tenant, board, entries, expectSeq) {
      ready(tenant, board);
      if (!Number.isSafeInteger(expectSeq) || expectSeq < 0) throw new PortError("bad-entry", "expectSeq must be a non-negative integer");
      if (!Array.isArray(entries) || !entries.length) throw new PortError("bad-entry", "append needs at least one entry");
      // Everything is checked and serialised before the transaction starts: a bad entry writes nothing.
      const rows = entries.map((e, i) => {
        if (!e || typeof e !== "object" || e.seq !== expectSeq + 1 + i) throw new PortError("bad-entry", `entry ${i} must have seq ${expectSeq + 1 + i}`);
        if (e.tenant !== tenant || e.board !== board) throw new PortError("bad-entry", `entry ${i} belongs to another board`);
        let data;
        try { data = JSON.stringify(e); } catch { data = undefined; }
        if (typeof data !== "string") throw new PortError("bad-entry", `entry ${i} can't be serialised`);
        return [e.seq, data];
      });
      try { appendTx.immediate(tenant, board, rows, expectSeq); }
      catch (err) {
        if (err instanceof PortError) throw err;
        // The unique key fired: someone else holds that seq. Same answer as a stale expectSeq.
        if (String(err?.code).startsWith("SQLITE_CONSTRAINT")) throw new PortError("conflict", "that seq is already written");
        throw err;
      }
    },

    /**
     * Entries with seq >= fromSeq, ascending, at most `limit` (default 1000, capped at 10,000).
     * Extension to § Store (the port pages by count): with `maxBytes`, the page also stops once it holds about that
     * much stored text, so one page of 1,000,000-char entries can't be 100 MB; it always holds at least one entry.
     * The returned array carries `bytes` (each entry's stored length, same order), so a caller can budget memory
     * without encoding the entries again. `bytes` is a plain extra property: a copy of the array won't have it.
     */
    async read(tenant, board, fromSeq = 1, limit = 1000, maxBytes) {
      ready(tenant, board);
      if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) throw new PortError("bad-entry", "fromSeq must be a non-negative integer");
      if (!posInt(limit)) throw new PortError("bad-entry", "limit must be a positive integer");
      if (maxBytes !== undefined && !posInt(maxBytes)) throw new PortError("bad-entry", "maxBytes must be a positive integer");
      let n = Math.min(limit, MAX_READ);
      if (maxBytes !== undefined) {
        // Sizes first (no row text is read), then only as many rows as fit.
        let sum = 0, fit = 0;
        for (const r of qSizes.iterate(tenant, board, fromSeq, n)) { if (fit && sum + r.n > maxBytes) break; sum += r.n; fit++; }
        if (!fit) return Object.assign([], { bytes: [] });
        n = fit;
      }
      const bytes = [], entries = [];
      for (const r of qRead.all(tenant, board, fromSeq, n)) { bytes.push(r.data.length); entries.push(JSON.parse(r.data)); }
      return Object.assign(entries, { bytes });
    },

    /** The board's last seq, 0 if it has no entries. */
    async lastSeq(tenant, board) {
      ready(tenant, board);
      return qLast.get(tenant, board).m ?? 0;
    },

    /** Stores `cp` under its seq (`cp.seq` is required; the rest is the room's). An older one never hides a newer one. */
    async putCheckpoint(tenant, board, cp) {
      ready(tenant, board);
      if (!cp || typeof cp !== "object" || !Number.isSafeInteger(cp.seq) || cp.seq < 0) throw new PortError("bad-entry", "a checkpoint needs a seq");
      putCpTx.immediate(tenant, board, cp.seq, JSON.stringify(cp));
    },

    /** The checkpoint with the highest seq; with `beforeSeq`, the highest below it (to step back past a bad one). */
    async getCheckpoint(tenant, board, beforeSeq) {
      ready(tenant, board);
      if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) throw new PortError("bad-entry", "beforeSeq must be a non-negative integer");
      const row = qGetCp.get(tenant, board, beforeSeq ?? Number.MAX_SAFE_INTEGER);
      return row ? JSON.parse(row.data) : null;
    },

    /** What the store was opened with, read back from SQLite (for /health and tests). */
    pragmas() {
      const one = name => Object.values(db.query(`PRAGMA ${name}`).get())[0];
      return { journal_mode: one("journal_mode"), synchronous: one("synchronous"), fullfsync: one("fullfsync") };
    },

    async close() { if (!open) return; open = false; db.close(); },
  };
}
