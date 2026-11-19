// The blob reaper (PROTOCOL.md § Blobs, "References and purge"): deletes the bytes of hashes no board references any more.
// Core: it knows the Store port (the condemned index), the Blobs port (delete), an injected Clock and a Log, nothing else;
// main.js wires a timer to `sweep()` on every gateway node.
//
// Per condemned hash, in this order (every step safe to repeat, so a crash anywhere costs one retry):
//   1. claim    `Store.blobClaim`: a conditional write that succeeds only if the hash has been condemned for `graceMs`, nobody holds
//               it, and it is STILL unreferenced (pending references included). While it is live, a PUT URL for the hash is refused.
//   2. delete   `Blobs.delete`: idempotent, so two nodes that both got here (a claim that lapsed) do no harm.
//   3. finish   `Store.blobReaped`: drops the condemnation. false = a reference arrived while the delete ran (the residual race in the
//               protocol): logged as an error, never silent.
// Starvation: the condemned list is read after a cursor kept here across sweeps (as trash-sweep.js does), so an item that keeps
// failing is retried in turn and never holds the head; a sweep also stops at `budgetMs` on the injected Clock.
// A sweep never rejects: a failing item or a broken Store is logged and left for the next one.

import { BLOB_GRACE_MS } from "./blobs/port.js";
import { URL_TTL_MS } from "./blob-access.js";

/**
 * @typedef {{ now(): number }} Clock
 * @typedef {{ deleted: number, failed: number, raced: number, more: boolean }} ReapResult
 */

/**
 * @param {{ store: Pick<import("./store/port.js").Store, "blobCondemned"|"blobClaim"|"blobReaped"|"blobPrune">,
 *   blobs: Pick<import("./blobs/port.js").Blobs, "delete">, clock?: Clock, log?: { warn(msg: string, f?: object): void, error?(msg: string, f?: object): void },
 *   graceMs?: number, claimMs?: number, limit?: number, budgetMs?: number, pruneLimit?: number,
 *   onDeleted?: (tenant: string) => void }} deps
 *   graceMs: how long a hash stays condemned (must exceed the signed URL's life). claimMs: how long a claim holds before another node may retry.
 *   limit: items read per page; budgetMs: the most one sweep works (on `clock`); onDeleted(tenant): told after each delete (the quota recount).
 */
export function blobReaper({ store, blobs, clock = { now: Date.now }, log = { warn() {} }, graceMs = BLOB_GRACE_MS, claimMs = 120_000, limit = 100, budgetMs = 30_000, pruneLimit = 1000, onDeleted }) {
  if (!(graceMs > URL_TTL_MS)) throw new RangeError(`blobReaper: graceMs must exceed the signed URL's life (${URL_TTL_MS} ms)`);
  const say = (level, msg, f) => { try { (log[level] ?? log.warn).call(log, msg, f); } catch { /* a broken log never stops a delete */ } };
  let running = null;
  /** Where the next page resumes (null = from the start). Lost on restart, which only re-reads from the start. */
  let cursor = null;

  /** One hash. @returns {Promise<"deleted"|"skipped"|"raced"|"failed">} */
  async function reap({ tenant, sha1 }) {
    try {
      if (!(await store.blobClaim(tenant, sha1, { graceMs, claimMs }))) return "skipped";   // referenced again, pending, or another node has it
      await blobs.delete(tenant, sha1);
      const clean = await store.blobReaped(tenant, sha1);
      try { onDeleted?.(tenant); } catch (err) { say("warn", "blob reaper: quota recount failed", { tenant, err }); }
      if (!clean) { say("error", "blob reaped under a new reference: a board references a picture whose bytes are gone; it must be uploaded again", { tenant, sha1 }); return "raced"; }
      return "deleted";
    } catch (err) { say("warn", "blob reap failed; a later sweep retries it", { tenant, sha1, err }); return "failed"; }
  }

  return {
    /** One sweep. Never rejects; a sweep already running is joined, not doubled. @returns {Promise<ReapResult>} */
    sweep() {
      return running ??= (async () => {
        const out = { deleted: 0, failed: 0, raced: 0, more: false };
        try {
          const start = clock.now();
          await store.blobPrune(pruneLimit).catch(err => say("warn", "blob reaper: pruning pending references failed", { err }));
          for (;;) {
            const page = await store.blobCondemned({ graceMs, after: cursor, limit });
            for (const item of page) {
              const r = await reap(item);
              if (r === "deleted") out.deleted++; else if (r === "failed") out.failed++; else if (r === "raced") { out.deleted++; out.raced++; }
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
