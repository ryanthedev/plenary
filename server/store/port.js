// @ts-check
// The Store port (PROTOCOL.md § Store, § Recovery): the durable log, checkpoints and lease of every board. THE contract
// for adapters (sqlite.js, postgres.js); the room never sees it (a room host binds tenant, board and epoch into a Log,
// packages/protocol/ports.js). Port-level: core code imports this and never an adapter; adapters import their
// validators from here so every adapter refuses the same input with the same code.
// Every adapter passes test/server/store-contract.js; test/server/adapter-surface.test.js pins the method list.
//
// ERRORS. Every refusal is a PortError (server/ids.js) whose `code` callers match (never the class):
//   bad-id       tenant, board or holder is not a server id ([a-z0-9-], 1-64, no "." "*" ">" "/")
//   bad-entry    any other bad argument: a non-integer seq/epoch/limit/ttl, a missing epoch on a write, an entry that is not
//                `expectSeq + 1 + i` or belongs to another board or can't be JSON-serialised. NOTHING is written.
//   conflict     append: the board's last seq is not `expectSeq` (or that seq was just taken). Rebuild from the Store.
//   fenced       append / putCheckpoint: `epoch` is not the board's current lease epoch. Stop serving the board.
//   unavailable  retry: a lease row or checkpoint lock is held by another session past its bound, a checkpoint part is
//                missing at the header, or the database ended an idle write transaction. Nothing of the call is visible.
//   corrupt      getCheckpoint: a header's parts hold the wrong number of chars. Not retried.
//   closed       any call after close().
//   unavailable  (also) blobPend: a reaper holds a live claim on the hash; ask again shortly.
//   bad-clock    the injected clock (SQLite `now`) gave a non-integer: a lease call grants nothing.
//   old-format   OPEN, at start-up: a table's columns differ from this version's DDL. The store is refused, never read or ALTERed;
//                the operator resets it (SQLite: delete the file; Postgres: drop the schema).
// An infrastructure failure (database down, timeout) REJECTS with whatever error the driver gave; it never resolves to
// null or [] (a room treats a rejection as "the Store is unavailable" and rebuilds).
//
// GUARANTEES.
//   Durable   a resolved write survives a process crash and power loss on its node (SQLite synchronous=FULL, Postgres
//             commit with synchronous_commit=on).
//   Atomic    append writes every entry or none; one transaction checks the fence, the last seq and inserts.
//   Fenced    the epoch check is in the write's own transaction, BEFORE the seq check (a stale host hears "fenced", stop,
//             not "conflict", rebuild). A takeover between check and write cannot happen.
//   Clock     lease expiry is judged on the Store's own clock (SQLite: injected `now`, Postgres: the database's), never a
//             host's. `expiresAt` is on that clock; callers wait `remainingMs` on their own, never compare the two.
//   Bounds    read: at most MAX_READ entries per call. Lease ttl: at most MAX_LEASE_TTL_MS (a dead holder blocks its board
//             at most that long). Checkpoints: the newest KEEP (default 3) per board are kept; a big one is stored as parts
//             (PROTOCOL.md § Recovery, "Checkpoint parts"), each fenced apart, visible only when its header row lands.
//   Idempotent  release is a no-op unless held at that epoch; putCheckpoint of a seq that exists keeps the FIRST write.
//
// ADAPTER-ONLY members (diagnostics and start-up, never called by core code): sqlite `pragmas()`, postgres `settings()`.
// OPTIONAL capability: `clusterId()` (the Postgres adapter; a single node has no cluster). main.js asks for it only in
// cluster mode and refuses a cluster store without it.

import { needId, isSha1, PortError } from "../ids.js";

/** The most entries one `read` returns, whatever `limit` asks. */
export const MAX_READ = 10_000;
/** `read`'s default `limit`. */
export const DEFAULT_READ_LIMIT = 1000;
/** The longest lease (ms): a holder that dies with a longer one would block its board for that long. */
export const MAX_LEASE_TTL_MS = 10 * 60_000;
/** How many blob references one statement writes (an append of more is written in chunks, never refused: PROTOCOL.md § Blobs, "References and purge"). */
export const BLOB_REF_CHUNK = 10_000;
/** The longest a pending blob reference may last. */
export const MAX_PENDING_MS = 24 * 3_600_000;
/** `blobCondemned`'s page cap. */
export const MAX_CONDEMNED_PAGE = 1000;
/** The method names of the Store port, in declaration order (test/server/adapter-surface.test.js checks every adapter has exactly these, plus the adapter-only ones). */
export const STORE_METHODS = Object.freeze(["append", "read", "lastSeq", "putCheckpoint", "getCheckpoint", "openEpoch", "epoch", "acquire", "renew", "release", "lease", "purgeBoard", "blobPend", "blobCondemned", "blobClaim", "blobReaped", "blobPrune", "close"]);

/**
 * @typedef {{ epoch: number, expiresAt: number }} StoreLease  what acquire / renew grant; `expiresAt` is on the Store's clock
 * @typedef {{ holder: null | string, epoch: number, expiresAt: null | number, live: boolean, remainingMs: number }} LeaseRecord
 *   holder null = nobody holds it (released, or a single-node openEpoch); `live` = held and not expired; `remainingMs` = ms
 *   until expiry on the Store's clock, measured there (0 unless live).
 * @typedef {Record<string, any>[] & { bytes: number[] }} EntryPage  entries ascending by seq; `bytes[i]` = entry i's stored length in chars
 *
 * @typedef {object} Store
 * @property {(tenant: string, board: string, entries: object[], expectSeq: number, epoch: number, opts?: { blobRefs?: string[] }) => Promise<void>} append
 *   Writes every entry or none. entries[i].seq must be expectSeq + 1 + i and entries[i].tenant / .board must match. At
 *   least one entry. epoch: REQUIRED positive integer, the lease epoch the writer holds. Errors: bad-id, bad-entry,
 *   fenced, conflict. Resolves once durable. `opts.blobRefs`: the SHA-1 fileIds the entries' image elements name (any
 *   number, each 40 lowercase hex, else bad-entry; never refused over their count). They are written as the board's blob references in the SAME
 *   transaction as the entries (in chunks of BLOB_REF_CHUNK); each also replaces the board's pending reference for it, and cancels the hash's
 *   condemnation, or, when a reaper has claimed it, marks it revived (the reaper then puts the bytes back).
 * @property {(tenant: string, board: string, fromSeq?: number, limit?: number, maxBytes?: number) => Promise<EntryPage>} read
 *   Entries with seq >= fromSeq (default 1), ascending, at most min(limit, MAX_READ) (default DEFAULT_READ_LIMIT). With
 *   maxBytes the page also stops once it holds about that much stored text, and always holds >= 1 entry if any
 *   qualifies. fromSeq: integer >= 0; limit, maxBytes: positive integers (else bad-entry). [] when none.
 * @property {(tenant: string, board: string) => Promise<number>} lastSeq  the board's last seq; 0 = empty
 * @property {(tenant: string, board: string, cp: Record<string, any> & { seq: number }, epoch: number) => Promise<void>} putCheckpoint
 *   Stored under cp.seq (integer >= 0, else bad-entry). The highest seq wins, never the last write; a second write of one
 *   seq is ignored; all but the newest KEEP are pruned. epoch as in append (fenced). May reject "unavailable" when it is
 *   overtaken mid-write by a newer checkpoint; nothing of it stays visible.
 * @property {(tenant: string, board: string, beforeSeq?: number) => Promise<null | Record<string, any>>} getCheckpoint
 *   The checkpoint with the highest seq, or the highest below beforeSeq (integer >= 0), so a caller steps back past a bad
 *   one. A header whose parts are gone is skipped (onSkip hook), never returned. null = none.
 * @property {(tenant: string, board: string) => Promise<number>} openEpoch
 *   Durable atomic increment of the board's epoch (1 on the first call), kept in its lease record. Takes the board with no
 *   lease (holder cleared), so any lease holder is fenced off. Single node.
 * @property {(tenant: string, board: string) => Promise<number>} epoch  the board's epoch; 0 = no room was ever built
 * @property {(tenant: string, board: string, holder: string, ttlMs: number) => Promise<null | StoreLease>} acquire
 *   The lease if free, expired (Store clock) or already `holder`'s; every success bumps the epoch (a new incarnation).
 *   null = held by another. ttlMs: positive integer <= MAX_LEASE_TTL_MS. Rejects "unavailable" if the lease row can't be
 *   locked in time (another session holds it): retry.
 * @property {(tenant: string, board: string, holder: string, epoch: number, ttlMs: number) => Promise<null | StoreLease>} renew
 *   Extends to now + ttlMs, only as `holder` at `epoch` (even if it lapsed and nobody took it); else null. epoch required.
 * @property {(tenant: string, board: string, holder: string, epoch: number) => Promise<void>} release  as `holder` at `epoch` only, else a no-op; the epoch stays
 * @property {(tenant: string, board: string) => Promise<null | LeaseRecord>} lease  null = no room was ever built
 * @property {(tenant: string, board: string) => Promise<void>} purgeBoard  PROTOCOL.md § Trash and restore, "Purge": deletes the board's entries, checkpoints, checkpoint parts, lease record, blob references and pending references, and condemns each hash left with no reference and no live pending one, in ONE transaction; idempotent (nothing there is not an error); a stale host's later write is "fenced" (no lease row). The caller (the trash sweeper) has already made the board unreachable
 * @property {(tenant: string, board: string, sha1: string, ttlMs: number) => Promise<void>} blobPend
 *   A pending reference until the Store's clock + ttlMs (positive integer <= MAX_PENDING_MS; a second call extends it) and cancels the hash's condemnation (a claimed one is marked revived instead). Rejects "unavailable" while a reaper's claim on the hash is live.
 * @property {(o: { graceMs: number, after?: { tenant: string, sha1: string } | null, limit: number }) => Promise<{ tenant: string, sha1: string }[]>} blobCondemned
 *   Hashes condemned at least graceMs (integer >= 0) ago on the Store's clock and not under a live claim, ascending by (tenant, sha1) after `after`, at most limit (1..MAX_CONDEMNED_PAGE).
 * @property {(tenant: string, sha1: string, o: { graceMs: number, claimMs: number }) => Promise<boolean>} blobClaim
 *   The reaper's conditional claim (claimMs: positive integer): true only if the hash is condemned for graceMs, not under a live claim, and either STILL UNREFERENCED with no live pending reference, or claimed before (a reaper died mid-way: it must put the bytes back or finish). An unclaimed hash that has a reference loses its condemnation.
 * @property {(tenant: string, sha1: string, o?: { deleted?: boolean, restored?: boolean }) => Promise<boolean>} blobReaped
 *   The settle, after the bytes were quarantined. Without `deleted`: true = nothing references the hash (no revive mark, reference or live pending upload): delete the bytes (the claimed row stays, so a failed delete is retried); false = put them back (the row stays, marked revived, so a failed restore is retried). With `restored: true` (after the restore) or `deleted: true` (after the delete): drops the row; false = a reference arrived since the verdict; a missing row is true.
 * @property {(limit: number) => Promise<number>} blobPrune  deletes at most limit (positive integer) expired pending references; returns how many
 * @property {() => Promise<void>} close  idempotent; every later call rejects "closed"
 */

/** A positive safe integer. */
export const posInt = v => Number.isSafeInteger(v) && v > 0;
const bad = msg => new PortError("bad-entry", msg);

/** Checks the board key of a call. */
export function needBoard(tenant, board) { needId(tenant, "tenant"); needId(board, "board"); }

/** A write's lease epoch: REQUIRED (every write is fenced), a positive integer. */
export function needWriteEpoch(epoch) { if (!posInt(epoch)) throw bad("a write needs the board's lease epoch (a positive integer)"); }

/** renew / release's lease epoch: required, a positive integer. */
export function needLeaseEpoch(epoch) { if (!posInt(epoch)) throw bad("the lease's epoch is required (a positive integer)"); }

/** A lease ttl in ms: a positive integer, at most MAX_LEASE_TTL_MS. */
export function needTtl(ttlMs) { if (!posInt(ttlMs) || ttlMs > MAX_LEASE_TTL_MS) throw bad(`ttlMs must be a positive integer up to ${MAX_LEASE_TTL_MS}`); }

/** `append`'s non-id arguments. @returns {{ seqs: number[], datas: string[] }} each entry's seq and its JSON text, in order (nothing is written yet). */
export function checkAppend(tenant, board, entries, expectSeq, epoch) {
  needWriteEpoch(epoch);
  if (!Number.isSafeInteger(expectSeq) || expectSeq < 0) throw bad("expectSeq must be a non-negative integer");
  if (!Array.isArray(entries) || !entries.length) throw bad("append needs at least one entry");
  const seqs = [], datas = [];
  entries.forEach((e, i) => {
    if (!e || typeof e !== "object" || e.seq !== expectSeq + 1 + i) throw bad(`entry ${i} must have seq ${expectSeq + 1 + i}`);
    if (e.tenant !== tenant || e.board !== board) throw bad(`entry ${i} belongs to another board`);
    let data;
    try { data = JSON.stringify(e); } catch { data = undefined; }
    if (typeof data !== "string") throw bad(`entry ${i} can't be serialised`);
    seqs.push(e.seq); datas.push(data);
  });
  return { seqs, datas };
}

/** `read`'s arguments. @returns {number} the row count to fetch: min(limit, MAX_READ) */
export function checkRead(fromSeq, limit, maxBytes) {
  if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) throw bad("fromSeq must be a non-negative integer");
  if (!posInt(limit)) throw bad("limit must be a positive integer");
  if (maxBytes !== undefined && !posInt(maxBytes)) throw bad("maxBytes must be a positive integer");
  return Math.min(limit, MAX_READ);
}

/** How many of the next rows (`sizes`: any iterable of chars, ascending; read lazily, stops at the first row that doesn't fit) fit `maxBytes`: always at least one if there is one. */
export function fitBytes(sizes, maxBytes) {
  let sum = 0, fit = 0;
  for (const k of sizes) { if (fit && sum + k > maxBytes) break; sum += k; fit++; }
  return fit;
}

/** `putCheckpoint`'s checkpoint and epoch. */
export function checkCheckpoint(cp, epoch) {
  needWriteEpoch(epoch);
  if (!cp || typeof cp !== "object" || !Number.isSafeInteger(cp.seq) || cp.seq < 0) throw bad("a checkpoint needs a seq");
}

/** `getCheckpoint`'s optional beforeSeq. */
export function checkBeforeSeq(beforeSeq) {
  if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) throw bad("beforeSeq must be a non-negative integer");
}

/** `append`'s optional blob references. @returns {string[]} the distinct hashes ([] when none) */
export function checkBlobRefs(opts) {
  const refs = opts?.blobRefs;
  if (refs === undefined) return [];
  if (!Array.isArray(refs) || !refs.every(isSha1)) throw bad("blobRefs must be an array of lowercase SHA-1 hashes");   // never a cap: an append is never refused over its references
  return [...new Set(refs)].sort();   // a fixed order, so two appends never lock overlapping hashes in opposite orders
}

/** `blobPend`'s hash and ttl. */
export function checkPend(sha1, ttlMs) {
  if (!isSha1(sha1)) throw new PortError("bad-id", "a blob id is a lowercase hex SHA-1");
  if (!posInt(ttlMs) || ttlMs > MAX_PENDING_MS) throw bad(`ttlMs must be a positive integer up to ${MAX_PENDING_MS}`);
}

/**
 * `blobCondemned`'s and `blobClaim`'s numbers and cursor.
 * @param {{ graceMs?: number, claimMs?: number, limit?: number, after?: { tenant: string, sha1: string } | null }} [o]
 * @param {{ claim?: boolean }} [opts]
 */
export function checkReap({ graceMs, claimMs, limit, after } = {}, { claim = false } = {}) {
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw bad("graceMs must be a non-negative integer");
  if (claim) { if (!posInt(claimMs)) throw bad("claimMs must be a positive integer"); return; }
  if (!posInt(limit) || limit > MAX_CONDEMNED_PAGE) throw bad(`limit must be an integer from 1 to ${MAX_CONDEMNED_PAGE}`);
  if (after != null) { needId(after.tenant, "tenant"); if (!isSha1(after.sha1)) throw new PortError("bad-id", "a blob id is a lowercase hex SHA-1"); }
}
