// The HTTP face of blob access (PROTOCOL.md § Blobs): `GET|PUT /blobs/<token>`. A driving adapter: it reads the
// request, calls server/blob-access.js and turns its answer into a status. The token is the only credential.
//   PUT  the token is checked first; needs Content-Length (no chunked bodies): 400 bad-length · 413 over the cap, refused before any body is read
//        409 a second PUT on one token in flight · 503 busy past maxPuts bodies on this node or maxPutsPerUser for one user
//        408 the whole body didn't arrive within bodyDeadlineMs; the body is read as it arrives, never pre-allocated · then the service's answer (201 stored, 200 already there, 415, 422, 507, 503, 401)
//   GET  200 bytes with the sniffed type, nosniff, no-store; 404 not-found
// Anything else on /blobs/ is 404 (an unknown path) or 405 (a verb the route doesn't have).

import { MAX_BLOB_BYTES } from "./blobs/port.js";

const STATUS = { "bad-token": 401, "wrong-verb": 405, "bad-length": 400, "too-large": 413, "not-image": 415, "hash-mismatch": 422, quota: 507, "not-found": 404, unavailable: 503 };
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const fail = code => json(STATUS[code] ?? 500, { error: code }, code === "wrong-verb" ? { allow: "GET, PUT" } : {});

/**
 * Read a body of exactly `len` bytes, or null (more or fewer arrived, the stream failed, or `expired()` came true: the
 * reader is cancelled). The memory grows with what has arrived, never with the Content-Length a client claims.
 */
async function readExactly(req, len, signal) {
  const chunks = [];
  let got = 0;
  const reader = req.body?.getReader();
  if (!reader) return null;
  const stop = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
      if (got > len) { stop(); return null; }
      chunks.push(value);
    }
  } catch { return null; } finally { signal.removeEventListener("abort", stop); }
  if (signal.aborted || got !== len) return null;
  const out = new Uint8Array(len);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

export const MAX_CONCURRENT_PUTS = 8, MAX_PUTS_PER_USER = 2, BODY_DEADLINE_MS = 120_000;
const busy = () => json(503, { error: "busy" }, { "retry-after": "2" });

/**
 * @param {{ access: ReturnType<typeof import("./blob-access.js").blobAccess>, maxPuts?: number, maxPutsPerUser?: number,
 *           bodyDeadlineMs?: number, timers?: { set(fn: () => void, ms: number): any, clear(h: any): void } }} o
 *   maxPuts: PUT bodies being read or stored at once on this node (each can hold 10 MB); maxPutsPerUser: the same for one
 *   account (tenant and user from the verified token, across all its boards), so one account's slow uploads can't take every slot. Past either, 503
 *   `busy` (a client retries). One token has one PUT in flight: a second gets 409 `in-flight`. bodyDeadlineMs: the whole
 *   body must arrive within it, however slowly it drips (408 `timeout`, retryable); the idle timeout can't see a drip.
 *   timers: where the deadline runs (default the globals; tests pass a virtual one).
 */
export function blobRoutes({ access, maxPuts = MAX_CONCURRENT_PUTS, maxPutsPerUser = MAX_PUTS_PER_USER, bodyDeadlineMs = BODY_DEADLINE_MS, timers = { set: (f, ms) => setTimeout(f, ms), clear: h => clearTimeout(h) } }) {
  let puts = 0;
  const byUser = new Map(), tokens = new Set();
  return {
    /** @returns {Promise<Response | undefined>} undefined when the path isn't ours. */
    async handle(req, url) {
      if (!url.pathname.startsWith("/blobs/")) return undefined;
      const token = url.pathname.slice("/blobs/".length);
      if (!token || token.includes("/")) return json(404, { error: "not-found" });
      if (req.method === "GET") {
        const r = await access.get(token);
        if (!r.ok) return fail(r.code);
        return new Response(r.bytes, { status: 200, headers: { "content-type": r.type, "content-length": String(r.bytes.byteLength), "x-content-type-options": "nosniff", "cache-control": "no-store", "content-security-policy": "default-src 'none'; sandbox" } });
      }
      if (req.method === "PUT") {
        const v = await access.verify(token, "PUT");     // before a byte of body is read: no token, no upload
        if (!v.ok) return fail(v.code);
        const raw = req.headers.get("content-length");
        if (!raw || !/^\d{1,12}$/.test(raw) || req.headers.has("transfer-encoding")) return fail("bad-length");
        const len = Number(raw);
        if (!len) return fail("bad-length");
        if (len > MAX_BLOB_BYTES) return fail("too-large");
        // One account, however many boards it spreads over; a token with no user (not minted by a gateway today) shares one tight bucket per tenant.
        const who = v.user === null ? `${v.tenant}/` : `${v.tenant}/${v.user}`, cap = v.user === null ? 1 : maxPutsPerUser;
        if (tokens.has(token)) return json(409, { error: "in-flight" });
        if (puts >= maxPuts || (byUser.get(who) ?? 0) >= cap) return busy();
        puts++; byUser.set(who, (byUser.get(who) ?? 0) + 1); tokens.add(token);
        const ctl = new AbortController(), timer = timers.set(() => ctl.abort(), bodyDeadlineMs);
        try {
          const bytes = await readExactly(req, len, ctl.signal);
          if (!bytes) return ctl.signal.aborted ? json(408, { error: "timeout" }) : fail("bad-length");
          const r = await access.put(token, bytes);
          return r.ok ? json(r.created ? 201 : 200, { ok: true }) : fail(r.code);
        } finally {
          timers.clear(timer); puts--; tokens.delete(token);
          const n = (byUser.get(who) ?? 1) - 1; if (n > 0) byUser.set(who, n); else byUser.delete(who);
        }
      }
      return fail("wrong-verb");
    },
  };
}
