// The purge of Trash (PROTOCOL.md § Trash and restore, "Purge"). Core: depends on the Registry and Store ports and an injected Clock, nothing else; main.js wires a timer to `sweep()`.
//
// Order, per board (every step idempotent, so a crash at any point leaves a claimed row that `trashDue` still lists and the next pass, on any node, resumes):
//   1. claim    `purgeClaim`: one conditional write; from here a Restore is refused, so nothing restorable is ever deleted.
//   2. content  `Store.purgeBoard`: the log, checkpoints and lease. (Blobs are tenant-wide and shared by the Unit's other boards: not deleted, see the protocol.)
//   3. rows     `Registry.purgeBoard`: grants, invites, links and the rest, then the board.
// A Space: claim (which claims the boards that went with it), purge those boards, then `purgeSpace` once none references it.
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

  /** One item's steps; a failure is logged and leaves the claimed row for the next pass. @returns {Promise<boolean>} done */
  async function purgeBoard(b) {
    try {
      await store.purgeBoard(b.tenant, b.id);
      return await registry.purgeBoard(b.id);
    } catch (err) { warn("trash purge of a board failed; the next pass resumes it", { board: b.id, err }); return false; }
  }

  async function pass(before) {
    let due = await registry.trashDue({ before, limit });
    // Spaces first: claiming one claims the boards that went with it, so they show in the next read as due.
    let claimedSpaces = 0;
    for (const s of due.spaces) {
      try { if (await registry.purgeClaim({ type: "space", id: s.id, before })) claimedSpaces++; } catch (err) { warn("trash claim of a Space failed", { space: s.id, err }); }
    }
    if (claimedSpaces) due = { boards: (await registry.trashDue({ before, limit })).boards, spaces: due.spaces };
    const out = { boards: 0, spaces: 0, failed: 0, full: due.boards.length >= limit || due.spaces.length >= limit };
    for (const b of due.boards) {
      let claimed = false;
      try { claimed = await registry.purgeClaim({ type: "board", id: b.id, before }); } catch (err) { warn("trash claim of a board failed", { board: b.id, err }); }
      if (!claimed) { out.failed++; continue; }
      if (await purgeBoard(b)) out.boards++; else out.failed++;
    }
    for (const s of due.spaces) {
      try { if (await registry.purgeSpace(s.id)) out.spaces++; } catch (err) { warn("trash purge of a Space failed; the next pass resumes it", { space: s.id, err }); out.failed++; }
    }
    return out;
  }

  return {
    /**
     * One sweep: everything in Trash since `now() - ttl` or earlier, in up to `passes` reads. Never rejects; a sweep already running is joined, not doubled.
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
            // Stop at the first pass that handled nothing new (a failing item would repeat forever) or did not fill a page.
            if (!o.full || o.boards + o.spaces === 0) break;
            if (i === passes - 1) total.more = true;
          }
        } catch (err) { warn("trash sweep failed", { err }); total.failed++; }
        finally { running = null; }
        return total;
      })();
    },
  };
}
