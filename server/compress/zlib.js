// @ts-check
// Catch-up compression adapter (PROTOCOL.md § Joining, "Compressed catch-up"): one zlib stream per shared catch-up frame.
// The feed calls it once per snapshot or chunk text and keeps the result, so a thousand joiners pay for one deflate.
// Runs on libuv's thread pool (async), never on the event loop: a 100 MB snapshot must not stall every socket.
import { deflate } from "node:zlib";
import { promisify } from "node:util";

const deflateAsync = promisify(deflate);

/**
 * @param {{ minBytes?: number, minGain?: number, level?: number }} [o]
 *   minBytes: a frame below this goes as it is (a zlib header and a binary frame cost more than they save).
 *   minGain: the result must be at most this fraction of the input, else the frame goes as it is (already dense).
 * @returns {(data: string | Uint8Array) => Promise<Uint8Array | null>} the zlib (RFC 1950) bytes of `data`, or null for "not worth it"
 */
export function zlibDeflate({ minBytes = 4096, minGain = 0.9, level = 6 } = {}) {
  return async data => {
    const raw = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    if (raw.byteLength < minBytes) return null;
    const z = await deflateAsync(raw, { level });
    return z.byteLength <= raw.byteLength * minGain ? z : null;
  };
}
