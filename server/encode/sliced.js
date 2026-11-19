// JSON.stringify for a value too big to encode in one go: the same text, produced in slices with the event loop handed
// back between them (`yieldNow`: one setImmediate turn by default), so encoding a checkpoint of tens of MB never blocks every other board on the host.
// Adapter-side by design: the room hands over a plain object (the Store port is unchanged); how it becomes bytes is the
// adapter's business. Shared adapter support (server/encode/ is in the architecture test's SUPPORT_DIRS), so the Store adapters
// use it without importing each other or the core. Only data JSON.stringify would treat plainly is expected (no toJSON, no cycles): a checkpoint.

/** Containers below this depth are walked; deeper ones are leaves, stringified whole (cp > streams > board > elements > one element).
 *  Under a `records` key the limit is RECORDS_EXTRA deeper: a thread (cp > records > threads > thread) holds up to 500 comments,
 *  which would be one piece of several MB; walked, each comment is its own piece. */
const WALK_DEPTH = 4, RECORDS_EXTRA = 2;
/** Chars encoded between two chances to yield (about a millisecond of stringify). */
const SLICE_CHARS = 256 * 1024;

/**
 * @param {unknown} value
 * @param {{ yieldNow?: () => Promise<void>, sliceChars?: number }} [o] yieldNow: awaited every `sliceChars` encoded chars
 * @returns {Promise<string | undefined>} exactly what JSON.stringify(value) returns
 */
export async function encodeSliced(value, { yieldNow = () => new Promise(r => setImmediate(r)), sliceChars = SLICE_CHARS } = {}) {
  let out = "", pending = 0;
  const emit = async text => { out += text; pending += text.length; if (pending >= sliceChars) { pending = 0; await yieldNow(); } };
  const container = (v, depth, limit) => v !== null && typeof v === "object" && typeof v.toJSON !== "function" && depth < limit;
  const walk = async (v, depth, limit) => {   // v is a container (see above)
    if (Array.isArray(v)) {
      await emit("[");
      for (let i = 0; i < v.length; i++) {
        if (i) await emit(",");
        if (container(v[i], depth + 1, limit)) await walk(v[i], depth + 1, limit); else await emit(JSON.stringify(v[i]) ?? "null");
      }
      return emit("]");
    }
    await emit("{");
    let first = true;
    for (const k of Object.keys(v)) {
      const x = v[k], key = (first ? "" : ",") + JSON.stringify(k) + ":";
      const lim = limit + (depth === 0 && k === "records" ? RECORDS_EXTRA : 0);
      if (container(x, depth + 1, lim)) { await emit(key); await walk(x, depth + 1, lim); }
      else { const s = JSON.stringify(x); if (s === undefined) continue; await emit(key + s); }   // undefined, functions and symbols leave no trace
      first = false;
    }
    return emit("}");
  };
  if (!container(value, 0, WALK_DEPTH)) return JSON.stringify(value);
  await walk(value, 0, WALK_DEPTH);
  return out;
}
