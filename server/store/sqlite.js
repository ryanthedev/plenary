// The Store port on SQLite (PROTOCOL.md § Store): the durable log and checkpoints for a single node.
//
//   append(tenant, board, entries, expectSeq, epoch)    atomic and conditional; a stale expectSeq throws PortError
//                                               "conflict"; an `epoch` that isn't the board's lease epoch
//                                               throws "fenced" (checked in the same transaction); none: "bad-entry"
//   read(tenant, board, fromSeq, limit, maxBytes?)   entries with seq >= fromSeq, ascending, at most `limit`
//                                               (and, if maxBytes is given, about that much text: always >= 1 entry)
//   lastSeq(tenant, board)                      the board's last seq (0 = empty)
//   putCheckpoint(tenant, board, cp, epoch)     kept by cp.seq; the newest few per board are kept; fenced like append.
//                                               A big one is stored as parts, each committed and fenced apart (§ Recovery,
//                                               "Checkpoint parts"), so no one SQLite call holds the event loop for long
//   getCheckpoint(tenant, board, beforeSeq?)    the highest seq (below beforeSeq, if given), never the last write
//   openEpoch(tenant, board)                    durable atomic increment of the board's epoch (1 on the first call)
//   epoch(tenant, board)                        the board's epoch, 0 if no room was ever built
//   acquire(tenant, board, holder, ttlMs)       take the board's lease if free, expired or ours; always a new epoch
//   renew(tenant, board, holder, epoch, ttlMs)  extend it, only as its holder at that epoch; else null
//   release(tenant, board, holder, epoch)       give it up (idempotent); the epoch stays
//   lease(tenant, board)                        { holder, epoch, expiresAt, live, remainingMs } or null
//
// The epoch lives in the board's lease record (`leases`: holder, epoch, expires_at), not in a checkpoint
// (PROTOCOL.md § Recovery, Room identity). Expiry is judged on the store's clock only (`now`, injected for tests):
// on SQLite the store is one process, so its clock is the database's. Never compare it with another host's clock.
//
// Durable = WAL + synchronous=FULL (+ fullfsync on macOS, where a plain fsync doesn't reach the platter): a
// resolved append survives a process crash and power loss. The API is async (Postgres will be); SQLite itself
// runs synchronously inside each call, so one call never interleaves with another in this process.
// The board registry is NOT here: it is the Registry port's (server/auth/registry.js).

import { Database } from "bun:sqlite";
import { needId, PortError } from "../ids.js";
import { encodeSliced } from "../encode/sliced.js";
import { PART_CHARS, splitParts, headerOf, parseHeader, orphanGroups, headerLike } from "../encode/cp-parts.js";

const MAX_READ = 10_000;
/** The longest lease (ms): a holder that dies with a longer one would block its board for that long. */
const MAX_TTL = 10 * 60_000;
/** Part rows deleted per statement. */
const DROP_STEP = 1;
const posInt = v => Number.isSafeInteger(v) && v > 0;

/**
 * @param {{ path: string, fullfsync?: boolean, busyTimeoutMs?: number, keepCheckpoints?: number, now?: () => number,
 *   partChars?: number, onPart?: (step: string) => void | Promise<void> }} o
 *   `path` is a file (":memory:" for throwaway use). `now`: the lease clock in ms (default Date.now; tests inject one).
 *   `partChars`: the most chars in one checkpoint part (default 1 Mi). `onPart`: test hook, awaited before each part
 *   ("part:<n>"), before the header ("header") and before each orphan group's delete ("sweep"); a throw aborts the write there (a sweep never fails a write).
 */
export function sqliteStore({ path, fullfsync = true, busyTimeoutMs = 5000, keepCheckpoints = 3, now = Date.now,
  partChars = PART_CHARS, onPart }) {
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
  // Parts of a checkpoint too big for one row (server/encode/cp-parts.js). `wid` = one write attempt; a part is
  // readable only when a header row in `checkpoints` names its (seq, wid).
  db.run(`CREATE TABLE IF NOT EXISTS checkpoint_parts (
    tenant TEXT NOT NULL, board TEXT NOT NULL, seq INTEGER NOT NULL, wid TEXT NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (tenant, board, seq, wid, n))`);   // a rowid table on purpose: the key lives in a narrow index, so counting a write's parts never walks megabytes of row text

  // The lease record: holder NULL = nobody holds it (released, or a single-node openEpoch, which takes no lease).
  db.run(`CREATE TABLE IF NOT EXISTS leases (
    tenant TEXT NOT NULL, board TEXT NOT NULL, epoch INTEGER NOT NULL, holder TEXT, expires_at INTEGER,
    PRIMARY KEY (tenant, board)) WITHOUT ROWID`);
  // A file made before the lease columns existed (epoch only): add them; its rows read as unheld.
  const cols = new Set(db.query("PRAGMA table_info(leases)").all().map(c => c.name));
  for (const [col, type] of [["holder", "TEXT"], ["expires_at", "INTEGER"]]) if (!cols.has(col)) db.run(`ALTER TABLE leases ADD COLUMN ${col} ${type}`);

  const qOpenEpoch = db.query(`INSERT INTO leases (tenant, board, epoch) VALUES (?, ?, 1)
    ON CONFLICT (tenant, board) DO UPDATE SET epoch = epoch + 1, holder = NULL, expires_at = NULL RETURNING epoch`);
  const qEpoch = db.query("SELECT epoch FROM leases WHERE tenant = ? AND board = ?");
  // ?1 tenant ?2 board ?3 holder ?4 new expiry ?5 now. The WHERE is judged on the row as it stands, in the write lock.
  const qAcquire = db.query(`INSERT INTO leases (tenant, board, epoch, holder, expires_at) VALUES (?1, ?2, 1, ?3, ?4)
    ON CONFLICT (tenant, board) DO UPDATE SET epoch = epoch + 1, holder = ?3, expires_at = ?4
    WHERE holder IS NULL OR expires_at IS NULL OR expires_at <= ?5 OR holder = ?3
    RETURNING epoch, expires_at`);
  const qRenew = db.query(`UPDATE leases SET expires_at = ?5 WHERE tenant = ?1 AND board = ?2 AND holder = ?3 AND epoch = ?4
    RETURNING epoch, expires_at`);
  const qRelease = db.query("UPDATE leases SET holder = NULL, expires_at = NULL WHERE tenant = ? AND board = ? AND holder = ? AND epoch = ?");
  const qLease = db.query("SELECT holder, epoch, expires_at FROM leases WHERE tenant = ? AND board = ?");
  const qLast = db.query("SELECT max(seq) AS m FROM entries WHERE tenant = ? AND board = ?");
  const qInsert = db.query("INSERT INTO entries (tenant, board, seq, data) VALUES (?, ?, ?, ?)");
  const qRead = db.query("SELECT data FROM entries WHERE tenant = ? AND board = ? AND seq >= ? ORDER BY seq ASC LIMIT ?");
  const qSizes = db.query("SELECT length(data) AS n FROM entries WHERE tenant = ? AND board = ? AND seq >= ? ORDER BY seq ASC LIMIT ?");
  // § Recovery (PROTOCOL.md, Store and "bad checkpoint"): a checkpoint whose entry S doesn't match the log is skipped,
  // never deleted: the room's rebuild and each gateway's feed step past it with getCheckpoint's beforeSeq. A second
  // writer at the same seq is ignored; one older than the newest `keepCheckpoints` is pruned at once.
  // One row per (board, seq); the first write for a seq is kept. Older ones stay so a rebuild can step back past
  // a bad checkpoint (getCheckpoint's beforeSeq); all but the newest `keepCheckpoints` are pruned.
  const qPutCp = db.query("INSERT OR IGNORE INTO checkpoints (tenant, board, seq, data) VALUES (?, ?, ?, ?)");
  const qPruneCp = db.query(`DELETE FROM checkpoints WHERE tenant = ?1 AND board = ?2 AND seq NOT IN
    (SELECT seq FROM checkpoints WHERE tenant = ?1 AND board = ?2 ORDER BY seq DESC LIMIT ?3)`);
  const qGetCp = db.query("SELECT seq, data FROM checkpoints WHERE tenant = ? AND board = ? AND seq < ? ORDER BY seq DESC LIMIT 1");
  /** The epoch fence: inside the write transaction, so no takeover lands between the check and the write. */
  const fence = (tenant, board, epoch) => {
    const cur = qEpoch.get(tenant, board)?.epoch ?? 0;
    if (cur !== epoch) throw new PortError("fenced", `the board's lease is at epoch ${cur}, not ${epoch}`);
  };
  const putCpTx = db.transaction((tenant, board, seq, data, epoch) => {
    fence(tenant, board, epoch);
    qPutCp.run(tenant, board, seq, data); qPruneCp.run(tenant, board, keepCheckpoints);
  });
  const qPutPart = db.query("INSERT INTO checkpoint_parts (tenant, board, seq, wid, n, data) VALUES (?, ?, ?, ?, ?, ?)");
  const qCountParts = db.query("SELECT count(*) AS c FROM checkpoint_parts WHERE tenant = ? AND board = ? AND seq = ? AND wid = ?");
  const qGetParts = db.query("SELECT data FROM checkpoint_parts WHERE tenant = ? AND board = ? AND seq = ? AND wid = ? AND n = ?");
  const qHeaders = db.query("SELECT seq, data FROM checkpoints WHERE tenant = ? AND board = ?");
  const qGroups = db.query("SELECT DISTINCT seq, wid FROM checkpoint_parts WHERE tenant = ? AND board = ?");
  // Conditional in the same statement: a part is deleted only while no header names its write, so a header that lands
  // while a sweep is yielding (a slow write finishing) keeps its parts (?6 = headerLike(wid)).
  const qDelParts = db.query(`DELETE FROM checkpoint_parts WHERE tenant = ?1 AND board = ?2 AND seq = ?3 AND wid = ?4 AND n IN
    (SELECT n FROM checkpoint_parts WHERE tenant = ?1 AND board = ?2 AND seq = ?3 AND wid = ?4 ORDER BY n LIMIT ?5)
    AND NOT EXISTS (SELECT 1 FROM checkpoints WHERE tenant = ?1 AND board = ?2 AND seq = ?3 AND data LIKE ?6)`);
  /** One part, in its own transaction, fenced: a takeover between two parts stops the write at the next one. */
  const putPartTx = db.transaction((tenant, board, seq, wid, n, data, epoch) => { fence(tenant, board, epoch); qPutPart.run(tenant, board, seq, wid, n, data); });
  /** The header makes the checkpoint visible: fenced, and only if every part is there (a cleanup can't have taken one). */
  const putHeaderTx = db.transaction((tenant, board, seq, wid, parts, header, epoch) => {
    fence(tenant, board, epoch);
    if (qCountParts.get(tenant, board, seq, wid).c !== parts) throw new PortError("unavailable", "a checkpoint part is missing: try again");
    qPutCp.run(tenant, board, seq, header); qPruneCp.run(tenant, board, keepCheckpoints);
  });
  const yieldNow = () => new Promise(r => setImmediate(r));
  /** Deletes part groups in steps of a few rows (freeing big rows is a synchronous cost too), the loop breathing between. */
  const dropGroup = async (tenant, board, { seq, wid }) => {
    while (qDelParts.run(tenant, board, seq, wid, DROP_STEP, headerLike(wid)).changes > 0) await yieldNow();
  };
  /** Removes part rows no header names (aborted, fenced, pruned or crashed writes), older than the newest header. Never throws. */
  const sweepParts = async (tenant, board, mine) => {
    try {
      const gone = orphanGroups(qHeaders.all(tenant, board), qGroups.all(tenant, board));
      if (mine && !gone.some(g => g.wid === mine.wid)) gone.push(mine);   // an aborted write's own, whatever the newest header
      for (const g of gone) { await onPart?.("sweep"); await dropGroup(tenant, board, g); }
    } catch { /* best effort: the next checkpoint's sweep takes what is left */ }
  };

  // BEGIN IMMEDIATE: the write lock is taken before the read, so two handles (two processes) can't both see the
  // same last seq and both insert. The primary key is the second fence.
  const appendTx = db.transaction((tenant, board, rows, expectSeq, epoch) => {
    fence(tenant, board, epoch);   // first: a fenced host hears "fenced" (stop), not "conflict" (rebuild)
    const last = qLast.get(tenant, board).m ?? 0;
    if (last !== expectSeq) throw new PortError("conflict", `board is at seq ${last}, not ${expectSeq}`);
    for (const [seq, data] of rows) qInsert.run(tenant, board, seq, data);
  });

  const ready = (tenant, board) => {
    if (!open) throw new PortError("closed", "the store is closed");
    needId(tenant, "tenant"); needId(board, "board");
  };
  const needEpoch = epoch => { if (epoch !== undefined && !posInt(epoch)) throw new PortError("bad-entry", "epoch must be a positive integer"); };
  /** Every write is fenced (p4-host, L5): append and putCheckpoint without the writer's lease epoch are refused. */
  const needWriteEpoch = epoch => { if (!posInt(epoch)) throw new PortError("bad-entry", "a write needs the board's lease epoch (a positive integer)"); };
  const needTtl = ttlMs => { if (!posInt(ttlMs) || ttlMs > MAX_TTL) throw new PortError("bad-entry", `ttlMs must be a positive integer up to ${MAX_TTL}`); };
  const clock = () => { const t = now(); if (!Number.isSafeInteger(t)) throw new PortError("bad-clock", "the store's clock gave a non-integer"); return t; };
  const granted = row => row ? { epoch: row.epoch, expiresAt: row.expires_at } : null;

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
      const rows = entries.map((e, i) => {
        if (!e || typeof e !== "object" || e.seq !== expectSeq + 1 + i) throw new PortError("bad-entry", `entry ${i} must have seq ${expectSeq + 1 + i}`);
        if (e.tenant !== tenant || e.board !== board) throw new PortError("bad-entry", `entry ${i} belongs to another board`);
        let data;
        try { data = JSON.stringify(e); } catch { data = undefined; }
        if (typeof data !== "string") throw new PortError("bad-entry", `entry ${i} can't be serialised`);
        return [e.seq, data];
      });
      try { appendTx.immediate(tenant, board, rows, expectSeq, epoch); }
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
    async putCheckpoint(tenant, board, cp, epoch) {
      ready(tenant, board); needWriteEpoch(epoch);
      if (!cp || typeof cp !== "object" || !Number.isSafeInteger(cp.seq) || cp.seq < 0) throw new PortError("bad-entry", "a checkpoint needs a seq");
      // Encoded in slices (the event loop breathes between them); the fence is checked in each transaction below.
      const text = await encodeSliced(cp);
      if (text.length <= partChars) return void putCpTx.immediate(tenant, board, cp.seq, text, epoch);
      // Parts: each in its own fenced transaction, the loop breathing between; the header row makes them visible
      // (§ Recovery, "Checkpoint parts"). A crash or abort before it leaves the previous checkpoint the newest.
      const parts = splitParts(text, partChars), wid = crypto.randomUUID(), mine = { seq: cp.seq, wid };
      try {
        for (let n = 0; n < parts.length; n++) {
          await onPart?.(`part:${n}`);
          putPartTx.immediate(tenant, board, cp.seq, wid, n, parts[n], epoch); await yieldNow();
        }
        await onPart?.("header");
        putHeaderTx.immediate(tenant, board, cp.seq, wid, parts.length, headerOf(wid, parts.length, text.length), epoch);
      } catch (err) { await sweepParts(tenant, board, mine); throw err; }
      await sweepParts(tenant, board);   // the first write of a seq stays: a second one's parts are orphans now, as are the pruned ones
    },

    /** The checkpoint with the highest seq; with `beforeSeq`, the highest below it (to step back past a bad one). */
    async getCheckpoint(tenant, board, beforeSeq) {
      ready(tenant, board);
      if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) throw new PortError("bad-entry", "beforeSeq must be a non-negative integer");
      // A header may name parts a newer checkpoint's prune has just removed: look again (it then finds a newer header).
      // A header whose parts stay missing is a bad checkpoint: skipped, so the caller gets the next one below it.
      for (let below = beforeSeq ?? Number.MAX_SAFE_INTEGER; ;) {
        let text = null, row;
        for (let attempt = 0; attempt < 3 && text === null; attempt++) {
          row = qGetCp.get(tenant, board, below);
          if (!row) return null;
          const head = parseHeader(row.data);
          if (!head) return JSON.parse(row.data);
          const chunks = [];
          for (let n = 0; n < head.parts; n++) {
            const part = qGetParts.get(tenant, board, row.seq, head.wid, n);
            if (!part) break;
            chunks.push(part.data); await yieldNow();
          }
          if (chunks.length !== head.parts) continue;
          text = chunks.join("");
          if (text.length !== head.chars) throw new PortError("corrupt", `checkpoint ${row.seq}'s parts hold ${text.length} chars, not ${head.chars}`);
        }
        if (text !== null) return JSON.parse(text);
        below = row.seq;
      }
    },

    /**
     * A room is being built: the board's next epoch, durable before it resolves (§ Recovery, Room identity).
     * Single node: it takes the board without a lease (holder cleared), so any lease holder is fenced off.
     */
    async openEpoch(tenant, board) {
      ready(tenant, board);
      return db.transaction(() => qOpenEpoch.get(tenant, board).epoch).immediate();
    },

    /** The board's latest epoch; 0 = no room was ever built. */
    async epoch(tenant, board) {
      ready(tenant, board);
      return qEpoch.get(tenant, board)?.epoch ?? 0;
    },

    /**
     * Takes the board's lease if nobody holds it, it has expired (on this store's clock), or `holder` holds it.
     * Every success is a new room incarnation: the epoch rises by 1, durably, in the same step. null = held by another.
     * @returns {Promise<null | { epoch: number, expiresAt: number }>} expiresAt is on the store's clock, not the caller's
     */
    async acquire(tenant, board, holder, ttlMs) {
      ready(tenant, board); needId(holder, "holder"); needTtl(ttlMs);
      return db.transaction(() => { const t = clock(); return granted(qAcquire.get(tenant, board, holder, t + ttlMs, t)); }).immediate();
    },

    /** Extends the lease to now + ttlMs, only for its holder at that epoch (even if it lapsed and nobody took it). */
    async renew(tenant, board, holder, epoch, ttlMs) {
      ready(tenant, board); needId(holder, "holder"); needEpoch(epoch); needTtl(ttlMs);
      if (epoch === undefined) throw new PortError("bad-entry", "renew needs the lease's epoch");
      return db.transaction(() => granted(qRenew.get(tenant, board, holder, epoch, clock() + ttlMs))).immediate();
    },

    /** Gives the lease up if `holder` holds it at `epoch`; otherwise does nothing. The epoch is kept. */
    async release(tenant, board, holder, epoch) {
      ready(tenant, board); needId(holder, "holder"); needEpoch(epoch);
      if (epoch === undefined) throw new PortError("bad-entry", "release needs the lease's epoch");
      db.transaction(() => qRelease.run(tenant, board, holder, epoch)).immediate();
    },

    /**
     * The lease record, judged on this store's clock: `live` = held and not expired; `remainingMs` = how long until it
     * expires on that clock (0 unless live), so a caller can wait for expiry without comparing clocks. null = no room
     * was ever built.
     */
    async lease(tenant, board) {
      ready(tenant, board);
      const row = qLease.get(tenant, board);
      if (!row) return null;
      const t = clock();
      const live = row.holder !== null && row.expires_at !== null && row.expires_at > t;
      return { holder: row.holder, epoch: row.epoch, expiresAt: row.expires_at, live, remainingMs: live ? row.expires_at - t : 0 };
    },

    /** What the store was opened with, read back from SQLite (for /health and tests). */
    pragmas() {
      const one = name => Object.values(db.query(`PRAGMA ${name}`).get())[0];
      return { journal_mode: one("journal_mode"), synchronous: one("synchronous"), fullfsync: one("fullfsync") };
    },

    async close() { if (!open) return; open = false; db.close(); },
  };
}
