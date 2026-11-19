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

import { needId, PortError } from "../ids.js";

/** The most entries one `read` returns, whatever `limit` asks. */
export const MAX_READ = 10_000;
/** `read`'s default `limit`. */
export const DEFAULT_READ_LIMIT = 1000;
/** The longest lease (ms): a holder that dies with a longer one would block its board for that long. */
export const MAX_LEASE_TTL_MS = 10 * 60_000;
/** The method names of the Store port, in declaration order (test/server/adapter-surface.test.js checks every adapter has exactly these, plus the adapter-only ones). */
export const STORE_METHODS = Object.freeze(["append", "read", "lastSeq", "putCheckpoint", "getCheckpoint", "openEpoch", "epoch", "acquire", "renew", "release", "lease", "close"]);

/**
 * @typedef {{ epoch: number, expiresAt: number }} StoreLease  what acquire / renew grant; `expiresAt` is on the Store's clock
 * @typedef {{ holder: null | string, epoch: number, expiresAt: null | number, live: boolean, remainingMs: number }} LeaseRecord
 *   holder null = nobody holds it (released, or a single-node openEpoch); `live` = held and not expired; `remainingMs` = ms
 *   until expiry on the Store's clock, measured there (0 unless live).
 * @typedef {object[] & { bytes: number[] }} EntryPage  entries ascending by seq; `bytes[i]` = entry i's stored length in chars
 *
 * @typedef {{
 *   append(tenant: string, board: string, entries: object[], expectSeq: number, epoch: number): Promise<void>,
 *     // Writes every entry or none. entries[i].seq must be expectSeq + 1 + i and entries[i].tenant / .board must match. At
 *     // least one entry. epoch: REQUIRED positive integer, the lease epoch the writer holds. Errors: bad-id, bad-entry,
 *     // fenced, conflict. Resolves once durable.
 *   read(tenant: string, board: string, fromSeq?: number, limit?: number, maxBytes?: number): Promise<EntryPage>,
 *     // Entries with seq >= fromSeq (default 1), ascending, at most min(limit, MAX_READ) (default DEFAULT_READ_LIMIT). With
 *     // maxBytes the page also stops once it holds about that much stored text, and always holds >= 1 entry if any
 *     // qualifies. fromSeq: integer >= 0; limit, maxBytes: positive integers (else bad-entry). [] when none.
 *   lastSeq(tenant: string, board: string): Promise<number>,   // the board's last seq; 0 = empty
 *   putCheckpoint(tenant: string, board: string, cp: object, epoch: number): Promise<void>,
 *     // Stored under cp.seq (integer >= 0, else bad-entry). The highest seq wins, never the last write; a second write of one
 *     // seq is ignored; all but the newest KEEP are pruned. epoch as in append (fenced). May reject "unavailable" when it is
 *     // overtaken mid-write by a newer checkpoint; nothing of it stays visible.
 *   getCheckpoint(tenant: string, board: string, beforeSeq?: number): Promise<null | object>,
 *     // The checkpoint with the highest seq, or the highest below beforeSeq (integer >= 0), so a caller steps back past a bad
 *     // one. A header whose parts are gone is skipped (onSkip hook), never returned. null = none.
 *   openEpoch(tenant: string, board: string): Promise<number>,
 *     // Durable atomic increment of the board's epoch (1 on the first call), kept in its lease record. Takes the board with no
 *     // lease (holder cleared), so any lease holder is fenced off. Single node.
 *   epoch(tenant: string, board: string): Promise<number>,   // the board's epoch; 0 = no room was ever built
 *   acquire(tenant: string, board: string, holder: string, ttlMs: number): Promise<null | StoreLease>,
 *     // The lease if free, expired (Store clock) or already `holder`'s; every success bumps the epoch (a new incarnation).
 *     // null = held by another. ttlMs: positive integer <= MAX_LEASE_TTL_MS. Rejects "unavailable" if the lease row can't be
 *     // locked in time (another session holds it): retry.
 *   renew(tenant: string, board: string, holder: string, epoch: number, ttlMs: number): Promise<null | StoreLease>,
 *     // Extends to now + ttlMs, only as `holder` at `epoch` (even if it lapsed and nobody took it); else null. epoch required.
 *   release(tenant: string, board: string, holder: string, epoch: number): Promise<void>,   // as `holder` at `epoch` only, else a no-op; the epoch stays
 *   lease(tenant: string, board: string): Promise<null | LeaseRecord>,   // null = no room was ever built
 *   close(): Promise<void>,   // idempotent; every later call rejects "closed"
 * }} Store
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
