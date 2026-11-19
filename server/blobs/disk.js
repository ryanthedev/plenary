// The Blobs port on local disk (PROTOCOL.md § Blobs), for a single node.
//   put(tenant, sha1, bytes)   idempotent; refuses > 10 MB, a hash mismatch, and anything that isn't a PNG/JPEG/GIF/WebP;
//                              true when it stored the blob, false when the tenant already had it
//   get(tenant, sha1)          bytes, or null
//   quarantine / restore / delete   rename the file to <dir>/.quarantine/<tenant>/<sha1> and back (one atomic rename each), or unlink it and its quarantined copy
//   usage(tenant)              the bytes the tenant's blobs take, quarantined ones included (a walk of its folders; the quota's starting point)
// A blob lives at <dir>/<tenant>/<first 2 hex>/<sha1>. Both ids are validated before they touch a path, so there is
// no traversal and one tenant can't name another's file. Writes go to a temp file, are fsynced, then hard-linked
// under the blob's name (which never replaces: the first bytes for a hash are kept), and the folder is fsynced:
// a crash never leaves a half-written file under a blob's name, and a put that resolved survives power loss.
// The per-tenant quota is enforced above the port (server/blob-access.js), from usage() and put()'s answer.

import { mkdir, open, link, unlink, rename, readFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { needId, isSha1, PortError } from "../ids.js";

import { checkBlob, QUARANTINE } from "./port.js";

// The port's shared checks live in ./port.js; re-exported for callers that import them from here (tests).
export { MAX_BLOB_BYTES, imageKind, checkBlob } from "./port.js";

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
  const held = (tenant, sha1) => { place(tenant, sha1); const qfolder = join(dir, QUARANTINE, tenant); return { qfolder, qfile: join(qfolder, sha1) }; };
  const gone = err => err?.code === "ENOENT" || err?.code === "ENOTDIR";
  // fsync the directory, so the new name itself is on disk (best effort where a platform can't open a directory).
  const syncDir = async folder => { let dh; try { dh = await open(folder, "r"); await dh.sync(); } catch { /* not supported here */ } finally { await dh?.close().catch(() => {}); } };
  const exists = async file => { try { return (await stat(file)).isFile(); } catch { return false; } };

  return {
    async put(tenant, sha1, bytes) {
      const { folder, file } = place(tenant, sha1);
      const b = checkBlob(sha1, bytes);
      if (await exists(file)) return false;    // same hash = same bytes: nothing to do
      await mkdir(folder, { recursive: true });
      const tmp = join(folder, `.tmp-${process.pid}-${Date.now().toString(36)}-${++n}`);
      let fh;
      try {
        fh = await open(tmp, "wx", 0o600);
        await fh.writeFile(b);
        await fh.sync();
        await fh.close(); fh = null;
        // link() fails if the name exists, so two puts racing on one hash keep the first; rename() would replace it.
        let stored = true;
        try { await link(tmp, file); } catch (err) { if (err?.code !== "EEXIST") throw err; stored = false; }
        await syncDir(folder);
        return stored;
      } catch (err) {
        if (fh) await fh.close().catch(() => {});
        throw err;
      } finally { await unlink(tmp).catch(() => {}); }
    },

    /** @returns {Promise<number>} bytes of the tenant's stored blobs (temp files of puts in flight are not counted) */
    async usage(tenant) {
      needId(tenant, "tenant");
      let total = 0;
      const list = async d => { try { return await readdir(d, { withFileTypes: true }); } catch (err) { if (err?.code === "ENOENT") return []; throw err; } };
      for (const shard of await list(join(dir, tenant)))
        if (shard.isDirectory()) for (const f of await list(join(dir, tenant, shard.name)))
          if (f.isFile() && isSha1(f.name)) total += (await stat(join(dir, tenant, shard.name, f.name)).catch(() => null))?.size ?? 0;
      // Quarantined blobs still take the space (and may come back): a count taken mid-reap must not miss them.
      for (const f of await list(join(dir, QUARANTINE, tenant)))
        if (f.isFile() && isSha1(f.name)) total += (await stat(join(dir, QUARANTINE, tenant, f.name)).catch(() => null))?.size ?? 0;
      return total;
    },

    /** Moves the blob out of reach (one rename: never half there); idempotent. @returns {Promise<void>} */
    async quarantine(tenant, sha1) {
      const { folder, file } = place(tenant, sha1), { qfolder, qfile } = held(tenant, sha1);
      await mkdir(qfolder, { recursive: true });
      try { await rename(file, qfile); } catch (err) { if (gone(err)) return; throw err; }
      await syncDir(folder); await syncDir(qfolder);
    },

    /** Puts a quarantined blob back unless the tenant has it again; idempotent. @returns {Promise<void>} */
    async restore(tenant, sha1) {
      const { folder, file } = place(tenant, sha1), { qfolder, qfile } = held(tenant, sha1);
      if (!(await exists(qfile))) return;
      await mkdir(folder, { recursive: true });
      try { await link(qfile, file); } catch (err) { if (err?.code !== "EEXIST") { if (gone(err)) return; throw err; } }   // link never replaces: a new put of the same hash stays
      await syncDir(folder);
      await unlink(qfile).catch(err => { if (!gone(err)) throw err; });
      await syncDir(qfolder);
    },

    /** Removes the blob and its quarantined copy for good; idempotent. @returns {Promise<void>} */
    async delete(tenant, sha1) {
      const { folder, file } = place(tenant, sha1), { qfolder, qfile } = held(tenant, sha1);
      for (const [f, d] of [[qfile, qfolder], [file, folder]])
        try { await unlink(f); await syncDir(d); } catch (err) { if (!gone(err)) throw err; }
    },

    /** @returns {Promise<Uint8Array | null>} */
    async get(tenant, sha1) {
      const { file } = place(tenant, sha1);
      try { const buf = await readFile(file); return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength); }
      catch (err) { if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null; throw err; }
    },
  };
}
