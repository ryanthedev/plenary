// @ts-check
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
import { needId, PortError } from "../../../core/ids.js";
import { assertShapes, onBusyRetry } from "../../support/sqlite/schema.js";
import { DEFAULT_READ_LIMIT, needBoard, needLeaseEpoch, needTtl, checkAppend, checkRead, fitBytes, checkCheckpoint, checkBeforeSeq, checkBlobRefs, checkPend, checkReap } from "../../../ports/store.js";
import { encodeSliced } from "../../support/encode/sliced.js";
import { PART_CHARS, splitParts, headerOf, parseHeader, orphanGroups, headerLike } from "../../support/encode/cp-parts.js";

/** Part rows deleted per statement. */
const DROP_STEP = 1;

/**
 * @param {{ path: string, fullfsync?: boolean, busyTimeoutMs?: number, keepCheckpoints?: number, now?: () => number,
 *   partChars?: number, onPart?: (step: string) => void | Promise<void>, onSkip?: (s: { tenant: string, board: string, seq: number }) => void }} opts
 *   `path` is a file (":memory:" for throwaway use). `now`: the lease clock in ms (default Date.now; tests inject one).
 *   `partChars`: the most chars in one checkpoint part (default 1 Mi). `onPart`: test hook, awaited before each part
 *   ("part:<n>"), before the header ("header") and before each orphan group's delete ("sweep"); a throw aborts the write there (a sweep never fails a write). `onSkip`: called once for each checkpoint getCheckpoint skips because its parts are missing (the server logs it).
 * @returns {import("../../../ports/store.js").Store & { pragmas(): Record<string, any> }}
 */
export function sqliteStore(opts) {
  const db = new Database(opts.path, { create: true, strict: true });
  try { return build(db, opts); }
  catch (err) { try { db.close(); } catch {} throw err; }   // a failed start-up (a busy file, an old-format file) never leaks the handle
}

/** The Store's tables. Run on the file (CREATE IF NOT EXISTS) and on a scratch database, whose shapes the file's must match. */
const createTables = d => {
  d.run(`CREATE TABLE IF NOT EXISTS entries (
    tenant TEXT NOT NULL, board TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (tenant, board, seq)) WITHOUT ROWID`);
  d.run(`CREATE TABLE IF NOT EXISTS checkpoints (
    tenant TEXT NOT NULL, board TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (tenant, board, seq)) WITHOUT ROWID`);
  // Parts of a checkpoint too big for one row (server/encode/cp-parts.js). `wid` = one write attempt; a part is
  // readable only when a header row in `checkpoints` names its (seq, wid).
  d.run(`CREATE TABLE IF NOT EXISTS checkpoint_parts (
    tenant TEXT NOT NULL, board TEXT NOT NULL, seq INTEGER NOT NULL, wid TEXT NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (tenant, board, seq, wid, n))`);   // a rowid table on purpose: the key lives in a narrow index, so counting a write's parts never walks megabytes of row text
  // The lease record: holder NULL = nobody holds it (released, or a single-node openEpoch, which takes no lease).
  d.run(`CREATE TABLE IF NOT EXISTS leases (
    tenant TEXT NOT NULL, board TEXT NOT NULL, epoch INTEGER NOT NULL, holder TEXT, expires_at INTEGER,
    PRIMARY KEY (tenant, board)) WITHOUT ROWID`);
  // Blob references (PROTOCOL.md § Blobs, "References and purge"): which boards use a hash, the uploads about to be used
  // (until_at on the store's clock), and the hashes no board uses any more (condemned_at: when; claimed_until: a reaper's claim; revived: a reference arrived under a claim, so the reaper puts the bytes back).
  d.run(`CREATE TABLE IF NOT EXISTS blob_refs (
    tenant TEXT NOT NULL, sha1 TEXT NOT NULL, board TEXT NOT NULL, PRIMARY KEY (tenant, sha1, board)) WITHOUT ROWID`);
  d.run(`CREATE TABLE IF NOT EXISTS blob_pending (
    tenant TEXT NOT NULL, sha1 TEXT NOT NULL, board TEXT NOT NULL, until_at INTEGER NOT NULL, PRIMARY KEY (tenant, sha1, board)) WITHOUT ROWID`);
  d.run(`CREATE TABLE IF NOT EXISTS blob_condemned (
    tenant TEXT NOT NULL, sha1 TEXT NOT NULL, condemned_at INTEGER NOT NULL, claimed_until INTEGER, revived INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant, sha1)) WITHOUT ROWID`);
  // Indexes (created with the tables, only when missing): the purge looks references up by board, the prune by expiry.
  d.run("CREATE INDEX IF NOT EXISTS blob_refs_board ON blob_refs (tenant, board)");
  d.run("CREATE INDEX IF NOT EXISTS blob_pending_board ON blob_pending (tenant, board)");
  d.run("CREATE INDEX IF NOT EXISTS blob_pending_until ON blob_pending (until_at)");
};

function build(db, { fullfsync = true, busyTimeoutMs = 5000, keepCheckpoints = 3, now = Date.now, partChars = PART_CHARS, onPart = undefined, onSkip = undefined }) {
  let open = true;
  db.run(`PRAGMA busy_timeout=${Math.max(0, Math.floor(busyTimeoutMs))}`);
  // Before any write to the file (no WAL switch, no CREATE): an old-format file is refused as it was found.
  assertShapes(db, createTables, "sqlite store");
  // Several processes opening one brand-new file at once: the switch to WAL needs an exclusive lock and SQLite answers BUSY for it without
  // consulting the busy handler (TECH-DEBT row 64), so skip it once the file reads WAL (it is persistent) and retry it, and the first schema
  // transaction, with a short backoff within the busy_timeout budget.
  const deadline = Date.now() + Math.max(0, Math.floor(busyTimeoutMs));
  onBusyRetry(db, deadline, () => { if (db.query("PRAGMA journal_mode").get()?.journal_mode !== "wal") db.run("PRAGMA journal_mode=WAL"); });
  db.run("PRAGMA synchronous=FULL");
  db.run(`PRAGMA fullfsync=${fullfsync ? "ON" : "OFF"}`);
  db.run(`PRAGMA checkpoint_fullfsync=${fullfsync ? "ON" : "OFF"}`);
  onBusyRetry(db, deadline, () => db.transaction(() => createTables(db)).immediate());   // all or none: a half-made file would be refused as old-format at the next start
  db.run(`PRAGMA busy_timeout=${Math.max(0, Math.floor(busyTimeoutMs))}`);                // start-up spent part of it; runtime gets the whole budget

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
  const qPurge = ["entries", "checkpoints", "checkpoint_parts", "leases"].map(tb => db.query(`DELETE FROM ${tb} WHERE tenant = ? AND board = ?`));
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
  // Blob references. ?1 tenant ?2 sha1 ?3 now. "In use" = a reference of any board, or a pending one that has not expired.
  const qRef = db.query("INSERT OR IGNORE INTO blob_refs (tenant, sha1, board) VALUES (?, ?, ?)");
  const qUnpend = db.query("DELETE FROM blob_pending WHERE tenant = ? AND sha1 = ? AND board = ?");
  // A new reference ends an UNCLAIMED condemnation; under a claim (live or lapsed) the bytes may already be quarantined, so the row stays, marked revived, for the reaper to settle.
  const qUncondemn = db.query("DELETE FROM blob_condemned WHERE tenant = ? AND sha1 = ? AND claimed_until IS NULL");
  const qRevive = db.query("UPDATE blob_condemned SET revived = 1 WHERE tenant = ? AND sha1 = ? AND claimed_until IS NOT NULL");
  const qDelRefs = db.query("DELETE FROM blob_refs WHERE tenant = ? AND board = ? RETURNING sha1");
  const qDelPend = db.query("DELETE FROM blob_pending WHERE tenant = ? AND board = ? RETURNING sha1");
  const inUse = `(EXISTS (SELECT 1 FROM blob_refs WHERE tenant = ?1 AND sha1 = ?2) OR EXISTS (SELECT 1 FROM blob_pending WHERE tenant = ?1 AND sha1 = ?2 AND until_at > ?3))`;
  const qInUse = db.query(`SELECT ${inUse} AS used`);
  const qCondemn = db.query("INSERT OR IGNORE INTO blob_condemned (tenant, sha1, condemned_at) VALUES (?, ?, ?)");
  const qLiveClaim = db.query("SELECT 1 AS x FROM blob_condemned WHERE tenant = ? AND sha1 = ? AND claimed_until > ?");
  const qPend = db.query(`INSERT INTO blob_pending (tenant, sha1, board, until_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (tenant, sha1, board) DO UPDATE SET until_at = max(until_at, excluded.until_at)`);
  const qCondemned = db.query(`SELECT tenant, sha1 FROM blob_condemned WHERE condemned_at <= ?1 AND (claimed_until IS NULL OR claimed_until <= ?2)
    AND (tenant, sha1) > (?3, ?4) ORDER BY tenant, sha1 LIMIT ?5`);
  const qClaim = db.query(`UPDATE blob_condemned SET claimed_until = ?4 WHERE tenant = ?1 AND sha1 = ?2 AND condemned_at <= ?5
    AND (claimed_until IS NULL OR claimed_until <= ?3) AND (claimed_until IS NOT NULL OR NOT ${inUse})`);
  const qDropReferenced = db.query(`DELETE FROM blob_condemned WHERE tenant = ?1 AND sha1 = ?2 AND claimed_until IS NULL
    AND EXISTS (SELECT 1 FROM blob_refs WHERE tenant = ?1 AND sha1 = ?2)`);
  const qClaimed = db.query("SELECT revived FROM blob_condemned WHERE tenant = ? AND sha1 = ? AND claimed_until IS NOT NULL");
  const qMarkRevived = db.query("UPDATE blob_condemned SET revived = 1 WHERE tenant = ? AND sha1 = ? AND claimed_until IS NOT NULL");
  const qSettle = db.query("DELETE FROM blob_condemned WHERE tenant = ? AND sha1 = ? AND claimed_until IS NOT NULL RETURNING revived");
  const qPrune = db.query(`DELETE FROM blob_pending WHERE (tenant, sha1, board) IN (SELECT tenant, sha1, board FROM blob_pending WHERE until_at <= ? LIMIT ?)`);

  const appendTx = db.transaction((tenant, board, rows, expectSeq, epoch, refs) => {
    fence(tenant, board, epoch);   // first: a fenced host hears "fenced" (stop), not "conflict" (rebuild)
    const last = qLast.get(tenant, board).m ?? 0;
    if (last !== expectSeq) throw new PortError("conflict", `board is at seq ${last}, not ${expectSeq}`);
    for (const [seq, data] of rows) qInsert.run(tenant, board, seq, data);
    // The references ride in the entries' transaction: an acknowledged op always has them. Each replaces the board's pending one and cancels a condemnation.
    for (const sha1 of refs) { qRef.run(tenant, sha1, board); qUnpend.run(tenant, sha1, board); qUncondemn.run(tenant, sha1); qRevive.run(tenant, sha1); }
  });

  const ready = (tenant, board) => {
    if (!open) throw new PortError("closed", "the store is closed");
    needBoard(tenant, board);
  };
  const clock = () => { const t = now(); if (!Number.isSafeInteger(t)) throw new PortError("bad-clock", "the store's clock gave a non-integer"); return t; };
  const granted = row => row ? { epoch: row.epoch, expiresAt: row.expires_at } : null;

  return {
    /**
     * Writes every entry or none, only if the board's last seq is `expectSeq` and only if `epoch` is
     * the board's lease epoch (else PortError "fenced"; no epoch at all is "bad-entry": every write is fenced). Resolves once durable.
     */
    async append(tenant, board, entries, expectSeq, epoch, opts) {
      ready(tenant, board);
      const refs = checkBlobRefs(opts);
      // Everything is checked and serialised before the transaction starts: a bad entry writes nothing.
      const { seqs, datas } = checkAppend(tenant, board, entries, expectSeq, epoch);
      const rows = seqs.map((seq, i) => [seq, datas[i]]);
      try { appendTx.immediate(tenant, board, rows, expectSeq, epoch, refs); }
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
    async read(tenant, board, fromSeq = 1, limit = DEFAULT_READ_LIMIT, maxBytes) {
      ready(tenant, board);
      let n = checkRead(fromSeq, limit, maxBytes);
      if (maxBytes !== undefined) {
        // Sizes first (no row text is read), then only as many rows as fit.
        const fit = fitBytes((function* () { for (const r of qSizes.iterate(tenant, board, fromSeq, n)) yield r.n; })(), maxBytes);
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
      ready(tenant, board); checkCheckpoint(cp, epoch);
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
      checkBeforeSeq(beforeSeq);
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
        try { onSkip?.({ tenant, board, seq: row.seq }); } catch { /* a logger must not fail a read */ }
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
      ready(tenant, board); needId(holder, "holder"); needLeaseEpoch(epoch); needTtl(ttlMs);
      return db.transaction(() => granted(qRenew.get(tenant, board, holder, epoch, clock() + ttlMs))).immediate();
    },

    /** Gives the lease up if `holder` holds it at `epoch`; otherwise does nothing. The epoch is kept. */
    async release(tenant, board, holder, epoch) {
      ready(tenant, board); needId(holder, "holder"); needLeaseEpoch(epoch);
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

    /**
     * Deletes everything the store holds for one board, in one transaction (PROTOCOL.md § Trash and restore, "Purge"): its
     * references too, and every hash that is left with no reference and no live pending one is condemned. Idempotent.
     */
    async purgeBoard(tenant, board) {
      ready(tenant, board);
      db.transaction(() => {
        for (const q of qPurge) q.run(tenant, board);
        const t = clock();
        const hashes = new Set([...qDelRefs.all(tenant, board), ...qDelPend.all(tenant, board)].map(r => r.sha1));
        for (const sha1 of hashes) if (!qInUse.get(tenant, sha1, t).used) qCondemn.run(tenant, sha1, t);
      }).immediate();
    },

    /** A pending reference, and the end of any condemnation; refused while a reaper's claim is live. */
    async blobPend(tenant, board, sha1, ttlMs) {
      ready(tenant, board); checkPend(sha1, ttlMs);
      db.transaction(() => {
        const t = clock();
        if (qLiveClaim.get(tenant, sha1, t)) throw new PortError("unavailable", "the blob is being deleted: ask again shortly");
        qUncondemn.run(tenant, sha1); qRevive.run(tenant, sha1); qPend.run(tenant, sha1, board, t + ttlMs);
      }).immediate();
    },

    /** Condemned long enough and not claimed, in (tenant, sha1) order after the cursor. */
    async blobCondemned({ graceMs, after = null, limit } = /** @type {any} */ ({})) {
      if (!open) throw new PortError("closed", "the store is closed");
      checkReap({ graceMs, limit, after });
      const t = clock();
      return qCondemned.all(t - graceMs, t, after?.tenant ?? "", after?.sha1 ?? "", limit).map(r => ({ tenant: r.tenant, sha1: r.sha1 }));
    },

    /** The reaper's conditional claim: only while the hash is still condemned for graceMs, unclaimed and unreferenced. */
    async blobClaim(tenant, sha1, { graceMs, claimMs } = /** @type {any} */ ({})) {
      needId(tenant, "tenant"); checkPend(sha1, 1); checkReap({ graceMs, claimMs }, { claim: true });
      if (!open) throw new PortError("closed", "the store is closed");
      return db.transaction(() => {
        const t = clock();
        if (qClaim.run(tenant, sha1, t, t + claimMs, t - graceMs).changes) return true;
        qDropReferenced.run(tenant, sha1);   // a hash a board references is not condemned (a purge raced a new reference)
        return false;
      }).immediate();
    },

    /**
     * The reaper's settle calls (PROTOCOL.md § Blobs, "References and purge"). Without options, after the bytes were quarantined: is anything
     * referencing the hash (a revived mark, a reference, a live pending upload)? Yes: false says put the bytes back, and the claimed row STAYS (marked
     * revived). No: true says delete them, and the row stays too. So a restore or a delete that fails is retried by the next claim, whose verdict is
     * the same. With `{ restored: true }`, after the restore: drops the row. With `{ deleted: true }`, after the delete: drops the row; false = a
     * reference arrived since the verdict (the bytes are gone: the client's re-upload heals it); a missing row is true.
     */
    async blobReaped(tenant, sha1, { deleted = false, restored = false } = {}) {
      needId(tenant, "tenant"); checkPend(sha1, 1);
      if (!open) throw new PortError("closed", "the store is closed");
      return db.transaction(() => {
        if (restored) { qSettle.get(tenant, sha1); return true; }
        if (deleted) { const row = qSettle.get(tenant, sha1); return !row || (!row.revived && !qInUse.get(tenant, sha1, clock()).used); }
        const row = qClaimed.get(tenant, sha1);
        if (!row) return false;
        if (row.revived || qInUse.get(tenant, sha1, clock()).used) { qMarkRevived.run(tenant, sha1); return false; }   // keep: the row STAYS (revived) until the restore is done, so a failed restore is retried
        return true;
      }).immediate();
    },

    /** Deletes at most `limit` expired pending references. */
    async blobPrune(limit) {
      if (!open) throw new PortError("closed", "the store is closed");
      if (!Number.isSafeInteger(limit) || limit < 1) throw new PortError("bad-entry", "limit must be a positive integer");
      return db.transaction(() => qPrune.run(clock(), limit).changes).immediate();
    },

    /** What the store was opened with, read back from SQLite (for /health and tests). */
    pragmas() {
      const one = name => Object.values(db.query(`PRAGMA ${name}`).get())[0];
      return { journal_mode: one("journal_mode"), synchronous: one("synchronous"), fullfsync: one("fullfsync") };
    },

    async close() { if (!open) return; open = false; db.close(); },
  };
}
