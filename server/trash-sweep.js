// @ts-check
// The purge of Trash (PROTOCOL.md § Trash and restore, "Purge"). Core: depends on the Registry and Store ports and an injected Clock, nothing else; main.js wires a timer to `sweep()`.
//
// Order, per board (every step idempotent, so a crash at any point leaves a claimed row that `trashDue({ claimed: true })` still lists and the next pass, on any node, resumes):
//   1. claim    `purgeClaim`: one conditional write; from here a Restore is refused, so nothing restorable is ever deleted. A board that went to Trash with its Space is claimed only
//               WITH its Space (the Registry refuses it alone), so a restorable board is never claimed; the sweeper reads only own-clock boards and Spaces as unclaimed work.
//   2. content  `Store.purgeBoard`: the log, checkpoints, lease and blob references; in the same transaction it condemns the hashes nothing else references. The bytes go later,
//               through the blob reaper (server/blob-reaper.js), never here.
//   3. rows     `Registry.purgeBoard`: grants, invites, links and the rest, then the board.
// A Space: claim (which claims the boards that went with it), purge those boards, then `purgeSpace` once none references it.
// Starvation: unclaimed work is read oldest first and each item leaves that list once claimed; claimed rows are read by id after a cursor kept here across sweeps, so a row that keeps failing
// is retried in turn, never at the head of every read.
// Two nodes sweeping at once is safe: the claim is a conditional write and every delete is a no-op the second time.

import { TRASH } from "./auth/registry-port.js";

/**
 * @typedef {{ now(): number }} Clock   the one time source of a sweep (tests advance it; nobody waits 30 days)
 * @typedef {{ boards: number, spaces: number, failed: number, more: boolean }} SweepResult
 */

/**
 * @param {{ registry: Pick<import("./auth/registry-port.js").Registry, "trashDue"|"purgeClaim"|"purgeBoard"|"purgeSpace">,
 *   store: Pick<import("./store/port.js").Store, "purgeBoard">, clock?: Clock, log?: { warn(msg: string, fields?: object): void, info?(msg: string, fields?: object): void },
 *   ttlMs?: number, limit?: number, passes?: number }} deps
 *   limit: boards and Spaces handled per read; passes: reads per sweep (a sweep that fills them reports `more`, the next timer tick goes on).
 */
export function trashSweeper({ registry, store, clock = { now: Date.now }, log = { warn() {} }, ttlMs = TRASH.ttlMs, limit = TRASH.due.default, passes = 10 }) {
  const warn = (msg, fields) => { try { log.warn(msg, fields); } catch { /* a broken log never stops a purge */ } };
  let running = null;
  /** Where the next read of claimed rows resumes (ids; null = from the start). Lost on restart, which only re-reads from the start. */
  let cursor = { board: null, space: null };

  /** One claimed board's steps; a failure is logged and leaves the claimed row for a later pass. @returns {Promise<boolean>} done */
  async function purgeBoard(b) {
    try {
      await store.purgeBoard(b.tenant, b.id);
      return await registry.purgeBoard(b.id);
    } catch (err) { warn("trash purge of a board failed; a later pass resumes it", { board: b.id, err }); return false; }
  }

  /** One pass: claim what is due, then work through a page of claimed rows. */
  async function pass(before) {
    const out = { boards: 0, spaces: 0, failed: 0, claimed: 0, full: false };
    const due = await registry.trashDue({ before, limit, claimed: false });
    out.full = due.boards.length >= limit || due.spaces.length >= limit;
    // Spaces first: claiming one claims the boards that went with it.
    /** @type {(["space", { id: string }[]] | ["board", { id: string }[]])[]} */
    const groups = [["space", due.spaces], ["board", due.boards]];
    for (const [type, rows] of groups) {
      for (const r of rows) {
        try { if (await registry.purgeClaim({ type, id: r.id, before })) out.claimed++; }
        catch (err) { out.failed++; warn(`trash claim of a ${type} failed`, { [type]: r.id, err }); }
      }
    }
    const cl = await registry.trashDue({ before, limit, claimed: true, after: cursor });
    for (const b of cl.boards) { if (await purgeBoard(b)) out.boards++; else out.failed++; }
    for (const s of cl.spaces) {
      try { if (await registry.purgeSpace(s.id)) out.spaces++; }   // false: a board of it is still being purged (counted on its own)
      catch (err) { warn("trash purge of a Space failed; a later pass resumes it", { space: s.id, err }); out.failed++; }
    }
    // A full page moves the cursor on; a short one wraps it, so the next read starts again from the start.
    cursor = { board: cl.boards.length >= limit ? cl.boards.at(-1).id : null, space: cl.spaces.length >= limit ? cl.spaces.at(-1).id : null };
    out.full ||= cl.boards.length >= limit || cl.spaces.length >= limit;
    return out;
  }

  return {
    /**
     * One sweep: everything in Trash since `now() - ttl` or earlier, in up to `passes` passes. Never rejects; a sweep already running is joined, not doubled.
     * @returns {Promise<SweepResult>}
     */
    sweep() {
      return running ??= (async () => {
        const total = { boards: 0, spaces: 0, failed: 0, more: false };
        try {
          const before = clock.now() - ttlMs;
          for (let i = 0; i < passes; i++) {
            const o = await pass(before);
            total.boards += o.boards; total.spaces += o.spaces; total.failed += o.failed;
            // Stop at the first pass that did nothing new (a failing item would repeat forever) or did not fill a page.
            if (!o.full || o.boards + o.spaces + o.claimed === 0) break;
            if (i === passes - 1) total.more = true;
          }
        } catch (err) { warn("trash sweep failed", { err }); total.failed++; }
        finally { running = null; }
        return total;
      })();
    },
  };
}
