// @ts-check
// The Blobs port on S3-compatible storage (PROTOCOL.md § Blobs), for a cluster. Same contract as disk.js:
//   put(tenant, sha1, bytes)   idempotent; refuses > 10 MB (images) / > 50 MB (videos), a hash mismatch, and anything that isn't PNG/JPEG/GIF/WebP/MP4/WebM/QuickTime;
//                              true when it stored the blob, false when the tenant already had it
//   get(tenant, sha1)          bytes, or null when there is no such blob (every other failure throws)
//   quarantine / restore / delete   move the object to `.quarantine/<tenant>/<sha1>` (copy through this process, then delete the original: the
//                              copy exists before the original goes) and back, or remove both keys (S3's DELETE answers 204 for an absent key: idempotent)
//   usage(tenant)              the bytes the tenant's objects take, quarantined ones included (a paged ListObjectsV2 of `<tenant>/` and `.quarantine/<tenant>/`)
// A blob is the object `<tenant>/<sha1>` in one bucket. Both ids are validated before they reach a key, so one
// tenant can't name another's object. An S3 PUT is atomic (readers see the whole object or none) and durable once
// it returns, so there is no temp-file dance.
//
// Put checks first (HEAD) and skips an existing blob. Two puts racing on one hash may both write; both passed the
// same SHA-1 check, so the bytes differ only on a real SHA-1 collision (disk.js keeps the first via link(); here the
// last write wins). A conditional PUT (If-None-Match: *) would close that, but MinIO answers it with a bogus 404 on
// a new key (checked 2026-11-11), so it isn't used.
//
// Requests: Bun's S3Client only signs (presign, local, no network); the requests themselves are fetch() calls with
// an AbortSignal, so every call has a deadline (putTimeoutMs, getTimeoutMs) and a store that stops answering is
// aborted and rejected with PortError("timeout"), never left hanging. Any other store or network failure is
// PortError("unavailable") with the S3 code in the message and the original error as `cause`.
//
// Credentials: every setting comes from the caller (S3_* in deploy). Bun's S3Client also reads S3_SESSION_TOKEN and
// AWS_SESSION_TOKEN from the environment the process started with, and nothing turns that off: sessionToken ""
// or null doesn't, and deleting the variable from process.env later doesn't either (checked, Bun 1.4.4). An
// explicit non-empty `sessionToken` from the caller does override it. So: pass `sessionToken` when the store needs
// one; without it, s3Blobs inspects what Bun would actually sign with and refuses to start (PortError
// "bad-config") if a session token would come from the environment.
// The per-tenant quota is enforced above the port (server/blob-access.js), from usage() and put()'s answer.

import { needId, isSha1, PortError } from "../../../core/ids.js";
import { checkBlob, blobKind, BLOB_MIME, MAX_BLOB_BYTES, MAX_VIDEO_BLOB_BYTES, QUARANTINE } from "../../../ports/blobs.js";

export { MAX_BLOB_BYTES, MAX_VIDEO_BLOB_BYTES };

const SIGNED_FOR = 300;    // seconds a presigned request stays valid; each is used at once

/**
 * @param {{ endpoint: string, bucket: string, region: string, accessKeyId: string, secretAccessKey: string,
 *           sessionToken?: string, putTimeoutMs?: number, getTimeoutMs?: number, usageTimeoutMs?: number }} o
 */
export function s3Blobs({ endpoint, bucket, region, accessKeyId, secretAccessKey, sessionToken, putTimeoutMs = 30_000, getTimeoutMs = 10_000, usageTimeoutMs = 60_000 } = /** @type {any} */ ({})) {
  for (const [k, v] of Object.entries({ endpoint, bucket, region, accessKeyId, secretAccessKey }))
    if (typeof v !== "string" || !v) throw new TypeError(`s3Blobs needs ${k}`);
  if (sessionToken !== undefined && (typeof sessionToken !== "string" || !sessionToken)) throw new TypeError("s3Blobs sessionToken must be a non-empty string when given");
  for (const [k, v] of Object.entries({ putTimeoutMs, getTimeoutMs, usageTimeoutMs }))
    if (!Number.isFinite(v) || v <= 0) throw new TypeError(`s3Blobs ${k} must be a positive number`);

  const s3 = new Bun.S3Client({ endpoint, bucket, region, accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) });
  // What Bun will really sign with (presign is local): refuse a session token the caller didn't give.
  if (!sessionToken && new URL(s3.presign("probe", { expiresIn: 1 })).searchParams.has("X-Amz-Security-Token"))
    throw new PortError("bad-config", "S3_SESSION_TOKEN or AWS_SESSION_TOKEN is set in this process's environment and Bun's S3 client would use it; unset it, or pass sessionToken to s3Blobs explicitly");

  const key = (tenant, sha1) => {
    needId(tenant, "tenant");
    if (!isSha1(sha1)) throw new PortError("bad-id", "a blob id is a lowercase hex SHA-1");
    return `${tenant}/${sha1}`;
  };

  const s3Code = async res => { try { return /<Code>([^<]{1,64})<\/Code>/.exec(await res.text())?.[1] ?? null; } catch { return null; } };
  const failed = async (what, res) => new PortError("unavailable", `S3 ${what} failed: ${res.status} ${(await s3Code(res)) ?? ""}`.trim());

  /** fetch with the call's deadline; a timeout or network error becomes a PortError. */
  const call = async (signal, ms, what, url, init = {}) => {
    try { return await fetch(url, { ...init, signal }); }
    catch (err) {
      if (signal.aborted) throw Object.assign(new PortError("timeout", `S3 ${what} took longer than ${ms} ms`), { cause: err });
      throw Object.assign(new PortError("unavailable", `S3 ${what} failed: ${err?.code ?? err?.message ?? err}`), { cause: err });
    }
  };
  /** Runs `fn` and turns an abort that lands while a body is read into a timeout too. */
  const within = async (ms, what, fn) => {
    const signal = AbortSignal.timeout(ms);
    try { return await fn(signal); }
    catch (err) {
      if (err instanceof PortError) throw err;
      if (signal.aborted) throw Object.assign(new PortError("timeout", `S3 ${what} took longer than ${ms} ms`), { cause: err });
      throw Object.assign(new PortError("unavailable", `S3 ${what} failed: ${err?.message ?? err}`), { cause: err });
    }
  };

  const qkey = (tenant, sha1) => `${QUARANTINE}/${key(tenant, sha1)}`;
  /** One object's bytes, or null when the key is missing (a missing bucket or any other failure throws). */
  const readKey = async (signal, k) => {
    const res = await call(signal, getTimeoutMs, "get", s3.presign(k, { expiresIn: SIGNED_FOR }));
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    if (res.status === 404) {
      const c = await s3Code(res);
      if (c === "NoSuchKey") return null;          // only a missing key is "no blob"; a missing bucket is an error
      throw new PortError("unavailable", `S3 get failed: 404 ${c ?? ""}`.trim());
    }
    throw await failed("get", res);
  };
  const writeKey = async (signal, k, bytes) => {
    const res = await call(signal, putTimeoutMs, "put", s3.presign(k, { method: "PUT", expiresIn: SIGNED_FOR }), { method: "PUT", body: bytes, headers: { "content-type": BLOB_MIME[blobKind(bytes)] ?? "application/octet-stream" } });
    if (!res.ok) throw await failed("put", res);
    await res.arrayBuffer();
  };
  const deleteKey = async (signal, k) => {
    const res = await call(signal, putTimeoutMs, "delete", s3.presign(k, { method: "DELETE", expiresIn: SIGNED_FOR }), { method: "DELETE" });
    if (res.status === 404 && (await s3Code(res)) === "NoSuchKey") return;   // a missing bucket is an error, a missing key is done
    if (!res.ok) throw await failed("delete", res);
    await res.arrayBuffer();                       // drain, so the connection is reusable
  };
  /** The longest the reaper's calls (quarantine: a get, a put and a delete under one deadline) may take. */
  const deadlineMs = Math.max(putTimeoutMs, getTimeoutMs);

  return {
    deadlineMs,
    async put(tenant, sha1, bytes) {
      const k = key(tenant, sha1);
      const b = checkBlob(sha1, bytes);
      return within(putTimeoutMs, "put", async signal => {
        const head = await call(signal, putTimeoutMs, "put (HEAD)", s3.presign(k, { method: "HEAD", expiresIn: SIGNED_FOR }), { method: "HEAD" });
        if (head.ok) return false;                  // same hash = same bytes: nothing to do
        if (head.status !== 404) throw await failed("put (HEAD)", head);
        const res = await call(signal, putTimeoutMs, "put", s3.presign(k, { method: "PUT", expiresIn: SIGNED_FOR }),
          { method: "PUT", body: b, headers: { "content-type": BLOB_MIME[blobKind(b)] } });
        if (!res.ok) throw await failed("put", res);
        await res.arrayBuffer();                    // drain, so the connection is reusable
        return true;
      });
    },

    /** @returns {Promise<number>} the summed size of the tenant's objects. List calls can't be aborted (Bun's S3Client), so the deadline abandons one rather than cancels it. */
    async usage(tenant) {
      needId(tenant, "tenant");
      return within(usageTimeoutMs, "usage", async signal => {
        const abandon = p => new Promise((res, rej) => { signal.addEventListener("abort", () => rej(signal.reason), { once: true }); p.then(res, rej); });
        let total = 0;
        for (const prefix of [`${tenant}/`, `${QUARANTINE}/${tenant}/`]) {   // quarantined objects still take the space (and may come back)
          let startAfter;
          for (;;) {
            const page = await abandon(s3.list({ prefix, maxKeys: 1000, ...(startAfter ? { startAfter } : {}) }));
            const keys = page.contents ?? [];
            for (const o of keys) total += Number(o.size) || 0;
            if (!page.isTruncated || !keys.length) break;
            startAfter = keys[keys.length - 1].key;
          }
        }
        return total;
      });
    },

    /** Moves the object out of reach: the bytes are copied to the quarantine key first, then the original is deleted; idempotent. @returns {Promise<void>} */
    async quarantine(tenant, sha1) {
      const k = key(tenant, sha1), q = qkey(tenant, sha1);
      return within(deadlineMs, "quarantine", async signal => {
        const bytes = await readKey(signal, k);
        if (!bytes) return;                         // nothing live (already quarantined or deleted)
        await writeKey(signal, q, bytes);
        await deleteKey(signal, k);
      });
    },

    /** Puts a quarantined object back unless the tenant has it again; idempotent. @returns {Promise<void>} */
    async restore(tenant, sha1) {
      const k = key(tenant, sha1), q = qkey(tenant, sha1);
      return within(deadlineMs, "restore", async signal => {
        const bytes = await readKey(signal, q);
        if (!bytes) return;
        const head = await call(signal, deadlineMs, "restore (HEAD)", s3.presign(k, { method: "HEAD", expiresIn: SIGNED_FOR }), { method: "HEAD" });
        if (!head.ok) { if (head.status !== 404) throw await failed("restore (HEAD)", head); await writeKey(signal, k, bytes); }
        await deleteKey(signal, q);
      });
    },

    /** Removes the object and its quarantined copy; idempotent. @returns {Promise<void>} */
    async delete(tenant, sha1) {
      const k = key(tenant, sha1), q = qkey(tenant, sha1);
      return within(deadlineMs, "delete", async signal => { await deleteKey(signal, q); await deleteKey(signal, k); });
    },

    /** @returns {Promise<Uint8Array | null>} */
    async get(tenant, sha1) {
      const k = key(tenant, sha1);
      return within(getTimeoutMs, "get", signal => readKey(signal, k));
    },
  };
}
