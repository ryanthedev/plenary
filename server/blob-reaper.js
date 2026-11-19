// The blob reaper (PROTOCOL.md § Blobs, "References and purge"): deletes the bytes of hashes no board references any more.
// Core: it knows the Store port (the condemned index), the Blobs port (delete), an injected Clock and a Log, nothing else;
// main.js wires a timer to `sweep()` on every gateway node.
//
// Per condemned hash, in this order (every step safe to repeat, so a crash anywhere costs one retry):
//   1. claim       `Store.blobClaim`: a conditional write that succeeds only if the hash has been condemned for `graceMs`, nobody holds it, and it is
//                  STILL unreferenced (pending references included). While it is live, a PUT URL for the hash is refused, and a reference that arrives
//                  marks the condemnation revived instead of ending it (the row, and so the claim, stays).
//   2. quarantine  `Blobs.quarantine`: the bytes move out of reach but are not destroyed.
//   3. settle      `Store.blobReaped`: in one transaction says whether anything references the hash now (a revived mark, a reference, a pending
//                  upload). Yes: the condemnation is dropped and `Blobs.restore` puts the bytes back. No: `Blobs.delete` destroys them, then
//                  `Store.blobReaped(…, { deleted: true })` drops the row (the row stays until then, so a failing delete is retried). A reference
//                  landing at any moment before the verdict never loses the bytes; one landing during the final delete call is counted `raced`, logged
//                  as an error, and healed by the client's re-upload (PROTOCOL.md § Blobs, "References and purge").
// A claim lasts `claimMs`; a node that is slow past half of it after the quarantine does not settle (another node's retry will: a lapsed claim is claimable again
// and its bytes are put back or deleted by that node), and the Blobs adapter's own deadline must be well below it (checked at start).
// Starvation: the condemned list is read after a cursor kept here across sweeps (as trash-sweep.js does), so an item that keeps
// failing is retried in turn and never holds the head; a sweep also stops at `budgetMs` on the injected Clock.
// A sweep never rejects: a failing item or a broken Store is logged and left for the next one.

import { BLOB_GRACE_MS } from "./blobs/port.js";
import { URL_TTL_MS } from "./blob-access.js";

/**
 * @typedef {{ now(): number }} Clock
 * @typedef {{ deleted: number, revived: number, raced: number, failed: number, more: boolean }} ReapResult
 */

/**
 * @param {{ store: Pick<import("./store/port.js").Store, "blobCondemned"|"blobClaim"|"blobReaped"|"blobPrune">,
 *   blobs: Pick<import("./blobs/port.js").Blobs, "quarantine"|"restore"|"delete"> & { deadlineMs?: number }, clock?: Clock, log?: { warn(msg: string, f?: object): void, error?(msg: string, f?: object): void },
 *   graceMs?: number, claimMs?: number, limit?: number, budgetMs?: number, pruneLimit?: number,
 *   onDeleted?: (tenant: string) => void }} deps
 *   graceMs: how long a hash stays condemned (must exceed the signed URL's life). claimMs: how long a claim holds before another node may retry.
 *   limit: items read per page; budgetMs: the most one sweep works (on `clock`); onDeleted(tenant): told after each delete (the quota recount).
 */
export function blobReaper({ store, blobs, clock = { now: Date.now }, log = { warn() {} }, graceMs = BLOB_GRACE_MS, claimMs = 120_000, limit = 100, budgetMs = 30_000, pruneLimit = 1000, onDeleted }) {
  if (!(graceMs > URL_TTL_MS)) throw new RangeError(`blobReaper: graceMs must exceed the signed URL's life (${URL_TTL_MS} ms)`);
  if (!((blobs.deadlineMs ?? 0) < claimMs / 2)) throw new RangeError(`blobReaper: the Blobs deadline (${blobs.deadlineMs} ms) must be below half the claim (${claimMs} ms): a claim must outlive the quarantine and the settle`);
  const say = (level, msg, f) => { try { (log[level] ?? log.warn).call(log, msg, f); } catch { /* a broken log never stops a delete */ } };
  let running = null;
  /** Where the next page resumes (null = from the start). Lost on restart, which only re-reads from the start. */
  let cursor = null;

  /** One hash. @returns {Promise<"deleted"|"revived"|"raced"|"skipped"|"failed">} */
  async function reap({ tenant, sha1 }) {
    try {
      const t0 = clock.now();
      if (!(await store.blobClaim(tenant, sha1, { graceMs, claimMs }))) return "skipped";   // referenced again, pending, or another node has it
      await blobs.quarantine(tenant, sha1);
      if (clock.now() - t0 > claimMs / 2) { say("warn", "blob reap too slow to settle inside its claim; a later sweep finishes it", { tenant, sha1 }); return "failed"; }
      const forGood = await store.blobReaped(tenant, sha1);   // the verdict; the claimed row stays until the delete is done, so a failing delete is retried
      if (forGood) await blobs.delete(tenant, sha1); else await blobs.restore(tenant, sha1);
      const clean = !forGood || await store.blobReaped(tenant, sha1, { deleted: true });
      try { onDeleted?.(tenant); } catch (err) { say("warn", "blob reaper: quota recount failed", { tenant, err }); }
      if (!clean) { say("error", "blob reaped under a new reference: a board references a picture whose bytes are gone; a client that holds it uploads it again", { tenant, sha1 }); return "raced"; }
      return forGood ? "deleted" : "revived";
    } catch (err) { say("warn", "blob reap failed; a later sweep retries it", { tenant, sha1, err }); return "failed"; }
  }

  return {
    /** One sweep. Never rejects; a sweep already running is joined, not doubled. @returns {Promise<ReapResult>} */
    sweep() {
      return running ??= (async () => {
        const out = { deleted: 0, revived: 0, raced: 0, failed: 0, more: false };
        try {
          const start = clock.now();
          // Expired pending references: until a short page or the budget (a big backlog drains, one sweep at a time).
          try { while (clock.now() - start < budgetMs && (await store.blobPrune(pruneLimit)) >= pruneLimit); }
          catch (err) { say("warn", "blob reaper: pruning pending references failed", { err }); }
          for (;;) {
            const page = await store.blobCondemned({ graceMs, after: cursor, limit });
            for (const item of page) {
              const r = await reap(item);
              if (r === "deleted") out.deleted++; else if (r === "failed") out.failed++; else if (r === "revived") out.revived++; else if (r === "raced") { out.deleted++; out.raced++; }
              cursor = item;
              if (clock.now() - start >= budgetMs) { out.more = true; return out; }
            }
            if (page.length < limit) { cursor = null; return out; }   // a short page: wrap, the next sweep starts again from the start
          }
        } catch (err) { say("warn", "blob reaper sweep failed", { err }); out.failed++; }
        finally { running = null; }
        return out;
      })();
    },
  };
}
