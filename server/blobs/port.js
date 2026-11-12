// The Blobs port (PROTOCOL.md § Blobs): what every Blobs adapter (disk.js, s3.js) checks before storing.
//   put(tenant, sha1, bytes)   idempotent; refuses > 10 MB, a hash mismatch, and anything that isn't a PNG/JPEG/GIF/WebP
//   get(tenant, sha1)          bytes, or null
// Shared port pieces, no adapter code: adapters never import each other (docs/m2/OFFICE.md "Architecture").

import { isSha1, PortError } from "../ids.js";

export const MAX_BLOB_BYTES = 10 * 1024 * 1024;

/** "png" | "jpeg" | "gif" | "webp" | null, from the first bytes. SVG (and everything else) is null. */
export function imageKind(b) {
  if (!(b instanceof Uint8Array) || b.length < 12) return null;
  const at = (i, ...sig) => sig.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  return null;
}

const sha1Hex = bytes => new Bun.CryptoHasher("sha1").update(bytes).digest("hex");

/**
 * The checks every Blobs adapter runs before storing (disk.js, s3.js): size, hash, image type.
 * @returns {Uint8Array} the bytes as a Uint8Array
 */
export function checkBlob(sha1, bytes) {
  if (!isSha1(sha1)) throw new PortError("bad-id", "a blob id is a lowercase hex SHA-1");
  const b = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null;
  if (!b) throw new PortError("bad-entry", "blob bytes must be a Uint8Array");
  if (b.byteLength > MAX_BLOB_BYTES) throw new PortError("too-large", `a blob is limited to ${MAX_BLOB_BYTES} bytes`);
  if (!b.byteLength) throw new PortError("bad-entry", "an empty blob");
  if (sha1Hex(b) !== sha1) throw new PortError("hash-mismatch", "the bytes don't match the SHA-1");
  if (!imageKind(b)) throw new PortError("not-image", "only PNG, JPEG, GIF and WebP are stored");
  return b;
}
