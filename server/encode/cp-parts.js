// How a big checkpoint is stored as parts (PROTOCOL.md § Recovery, "Checkpoint parts"). Pure helpers shared by the Store
// adapters (server/store/sqlite.js, postgres.js); this folder is adapter-only support (test/architecture.test.js).
//
// A checkpoint's JSON text longer than one part is cut into parts of at most `PART_CHARS` chars. Each part is its own
// row (table checkpoint_parts: tenant, board, seq, wid, n, data), written in its own fenced transaction. The checkpoint
// becomes visible only when its HEADER row is inserted into the checkpoints table under its seq: the header is the
// text `\u0001cp-parts 1 <wid> <parts> <chars>`, which no JSON text can start with (a checkpoint is an object, so an old
// single-row checkpoint starts with `{`). `wid` is one write attempt's random id, so two writers of one seq never share
// part rows. A checkpoint of one part or less is still one row of plain JSON (the format before parts).

/** Most chars in one part: one synchronous SQLite insert of this size (fsync included) stays near 10 ms. */
export const PART_CHARS = 1 << 20;
const MARK = "\u0001cp-parts 1 ";

/**
 * Cuts `text` into parts of at most `size` chars, never between the halves of a surrogate pair (SQLite stores UTF-8, and
 * a lone half would not survive the round trip).
 * @returns {string[]}
 */
export function splitParts(text, size = PART_CHARS) {
  const out = [];
  for (let at = 0; at < text.length;) {
    let end = Math.min(text.length, at + size);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff && end - 1 > at) end--;   // the next char is its low half
    out.push(text.slice(at, end)); at = end;
  }
  return out;
}

/** The header text for a checkpoint written as `parts` parts (`chars` chars in all) under write id `wid`. */
export const headerOf = (wid, parts, chars) => `${MARK}${wid} ${parts} ${chars}`;

/** @returns {null | { wid: string, parts: number, chars: number }} null: `data` is a plain (single-row) checkpoint */
export function parseHeader(data) {
  if (typeof data !== "string" || !data.startsWith(MARK)) return null;
  const [wid, parts, chars] = data.slice(MARK.length).split(" ");
  return { wid, parts: Number(parts), chars: Number(chars) };
}

/**
 * The part groups nobody can read: not named by any header and not newer than the newest header (a newer one may be a
 * write still in flight; it is judged when a later header lands). Pure: callers delete what it returns.
 * @param {{ seq: number, data: string }[]} headers  every row of the checkpoints table for one board
 * @param {{ seq: number, wid: string }[]} groups    every distinct (seq, wid) of its parts
 */
export function orphanGroups(headers, groups) {
  const used = new Set(), newest = headers.reduce((m, h) => Math.max(m, Number(h.seq)), -1);
  for (const h of headers) { const p = parseHeader(h.data); if (p) used.add(`${Number(h.seq)}/${p.wid}`); }
  return groups.filter(g => Number(g.seq) <= newest && !used.has(`${Number(g.seq)}/${g.wid}`));
}
