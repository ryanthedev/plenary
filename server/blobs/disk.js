// The Blobs port on local disk (PROTOCOL.md § Blobs), for a single node.
//   put(tenant, sha1, bytes)   idempotent; refuses > 10 MB (images) / > 50 MB (videos), a hash mismatch, and anything that isn't PNG/JPEG/GIF/WebP/MP4/WebM/QuickTime
//   get(tenant, sha1)          bytes, or null
// A blob lives at <dir>/<tenant>/<first 2 hex>/<sha1>. Both ids are validated before they touch a path, so there is
// no traversal and one tenant can't name another's file. Writes go to a temp file, are fsynced, then hard-linked
// under the blob's name (which never replaces: the first bytes for a hash are kept), and the folder is fsynced:
// a crash never leaves a half-written file under a blob's name, and a put that resolved survives power loss.
// SEAM(p3): the per-tenant quota (§ Limits, default 10 GB) is not enforced here yet; it comes with the signed-URL
// routes, which are the only way bytes arrive.

import { mkdir, open, link, unlink, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { needId, isSha1, PortError } from "../ids.js";

import { checkBlob } from "./port.js";

// The port's shared checks live in ./port.js; re-exported for callers that import them from here (tests).
export { MAX_BLOB_BYTES, MAX_VIDEO_BLOB_BYTES, BLOB_MIME, imageKind, videoKind, blobKind, checkBlob } from "./port.js";

/** @param {{ dir: string }} o — the root directory; created on first put. */
export function diskBlobs({ dir }) {
  if (typeof dir !== "string" || !dir) throw new TypeError("diskBlobs needs a dir");
  let n = 0;
  const place = (tenant, sha1) => {
    needId(tenant, "tenant");
    if (!isSha1(sha1)) throw new PortError("bad-id", "a blob id is a lowercase hex SHA-1");
    const folder = join(dir, tenant, sha1.slice(0, 2));
    return { folder, file: join(folder, sha1) };
  };
  // fsync the directory, so the new name itself is on disk (best effort where a platform can't open a directory).
  const syncDir = async folder => { let dh; try { dh = await open(folder, "r"); await dh.sync(); } catch { /* not supported here */ } finally { await dh?.close().catch(() => {}); } };
  const exists = async file => { try { return (await stat(file)).isFile(); } catch { return false; } };

  return {
    async put(tenant, sha1, bytes) {
      const { folder, file } = place(tenant, sha1);
      const b = checkBlob(sha1, bytes);
      if (await exists(file)) return;          // same hash = same bytes: nothing to do
      await mkdir(folder, { recursive: true });
      const tmp = join(folder, `.tmp-${process.pid}-${Date.now().toString(36)}-${++n}`);
      let fh;
      try {
        fh = await open(tmp, "wx", 0o600);
        await fh.writeFile(b);
        await fh.sync();
        await fh.close(); fh = null;
        // link() fails if the name exists, so two puts racing on one hash keep the first; rename() would replace it.
        try { await link(tmp, file); } catch (err) { if (err?.code !== "EEXIST") throw err; }
        await syncDir(folder);
      } catch (err) {
        if (fh) await fh.close().catch(() => {});
        throw err;
      } finally { await unlink(tmp).catch(() => {}); }
    },

    /** @returns {Promise<Uint8Array | null>} */
    async get(tenant, sha1) {
      const { file } = place(tenant, sha1);
      try { const buf = await readFile(file); return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength); }
      catch (err) { if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null; throw err; }
    },
  };
}
