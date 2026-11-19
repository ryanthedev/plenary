// The HTTP face of blob access (PROTOCOL.md § Blobs): `GET|PUT /blobs/<token>`. A driving adapter: it reads the
// request, calls server/blob-access.js and turns its answer into a status. The token is the only credential.
//   PUT  the token is checked first; needs Content-Length (no chunked bodies): 400 bad-length · 413 over the cap, refused before any body is read
//        and again while reading · then the service's answer (201 stored, 200 already there, 415, 422, 507, 503, 401)
//   GET  200 bytes with the sniffed type, nosniff, no-store; 404 not-found
// Anything else on /blobs/ is 404 (an unknown path) or 405 (a verb the route doesn't have).

import { MAX_BLOB_BYTES } from "./blobs/port.js";

const STATUS = { "bad-token": 401, "wrong-verb": 405, "bad-length": 400, "too-large": 413, "not-image": 415, "hash-mismatch": 422, quota: 507, "not-found": 404, unavailable: 503 };
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const fail = code => json(STATUS[code] ?? 500, { error: code }, code === "wrong-verb" ? { allow: "GET, PUT" } : {});

/** Read a body of at most `max` bytes, or null (over it, or the stream failed). */
async function readCapped(req, max) {
  const out = new Uint8Array(Math.min(max, Number(req.headers.get("content-length")) || 0));
  let at = 0;
  try {
    for await (const chunk of req.body ?? []) {
      if (at + chunk.byteLength > out.length) return null;
      out.set(chunk, at); at += chunk.byteLength;
    }
  } catch { return null; }
  return at === out.length ? out : null;
}

/** @param {{ access: ReturnType<typeof import("./blob-access.js").blobAccess>, log?: object }} o */
export function blobRoutes({ access }) {
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
        const bytes = await readCapped(req, len);
        if (!bytes) return fail("bad-length");
        const r = await access.put(token, bytes);
        return r.ok ? json(r.created ? 201 : 200, { ok: true }) : fail(r.code);
      }
      return fail("wrong-verb");
    },
  };
}
