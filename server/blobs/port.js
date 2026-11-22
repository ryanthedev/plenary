// The Blobs port (PROTOCOL.md § Blobs): what every Blobs adapter (disk.js, s3.js) checks before storing.
//   put(tenant, sha1, bytes)   idempotent; refuses > 10 MB (images) / > 50 MB (videos), a hash mismatch, and anything that isn't PNG/JPEG/GIF/WebP/MP4/WebM/QuickTime
//   get(tenant, sha1)          bytes, or null
// Shared port pieces, no adapter code: adapters never import each other (docs/m2/OFFICE.md "Architecture").

import { isSha1, PortError } from "../ids.js";

export const MAX_BLOB_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BLOB_BYTES = 50 * 1024 * 1024;

export const BLOB_MIME = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

const MP4_BRANDS = new Set([
  "isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso8",
  "mp41", "mp42", "mp71", "mmp4", "avc1", "M4V ", "m4v ", "dash",
  "msdh", "msix", "MSNV", "XAVC", "f4v ", "3gp4", "3gp5", "3gp6", "3g2a",
]);

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

/** "mp4" | "webm" | "mov" | null, from the container header bytes. */
export function videoKind(b) {
  if (!(b instanceof Uint8Array) || b.length < 12) return null;
  const at = (i, ...sig) => sig.every((x, k) => b[i + k] === x);
  // WebM / EBML header: 0x1A 0x45 0xDF 0xA3
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return "webm";
  // ISO Base Media File Format: bytes 4..7 = "ftyp", bytes 8..11 = major brand
  if (at(4, 0x66, 0x74, 0x79, 0x70)) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === "qt  ") return "mov";
    if (MP4_BRANDS.has(brand)) return "mp4";
  }
  return null;
}

/** Image or video kind, or null. */
export function blobKind(b) {
  return imageKind(b) ?? videoKind(b);
}

/**
 * Parse a single HTTP byte-range header per RFC 9110 §14.1.2.
 * Returns:
 * - `null` when absent or syntactically invalid (e.g. `bytes=5-2` where start > end): caller serves 200 full body.
 * - `{ unsatisfiable: true }` when `start >= totalBytes`: caller serves 416.
 * - `{ start, end }` (inclusive) when satisfiable: caller serves 206.
 */
export function parseByteRange(rangeHeader, totalBytes) {
  if (typeof rangeHeader !== "string" || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  const rm = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
  if (!rm) return null;
  const start = Number(rm[1]);
  if (!Number.isSafeInteger(start) || start < 0) return null;
  if (rm[2] !== "") {
    const rawEnd = Number(rm[2]);
    if (!Number.isSafeInteger(rawEnd) || start > rawEnd) return null; // RFC 9110: invalid range-spec is ignored (200)
    if (start >= totalBytes) return { unsatisfiable: true };
    return { start, end: Math.min(rawEnd, totalBytes - 1) };
  }
  if (start >= totalBytes) return { unsatisfiable: true };
  return { start, end: totalBytes - 1 };
}

const sha1Hex = bytes => new Bun.CryptoHasher("sha1").update(bytes).digest("hex");

/**
 * The checks every Blobs adapter runs before storing (disk.js, s3.js): size, hash, image/video type.
 * @returns {Uint8Array} the bytes as a Uint8Array
 */
export function checkBlob(sha1, bytes) {
  if (!isSha1(sha1)) throw new PortError("bad-id", "a blob id is a lowercase hex SHA-1");
  const b = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null;
  if (!b) throw new PortError("bad-entry", "blob bytes must be a Uint8Array");
  if (!b.byteLength) throw new PortError("bad-entry", "an empty blob");
  const vKind = videoKind(b);
  const maxBytes = vKind ? MAX_VIDEO_BLOB_BYTES : MAX_BLOB_BYTES;
  if (b.byteLength > maxBytes) throw new PortError("too-large", `a blob is limited to ${maxBytes} bytes`);
  if (sha1Hex(b) !== sha1) throw new PortError("hash-mismatch", "the bytes don't match the SHA-1");
  if (!vKind && !imageKind(b)) throw new PortError("not-image", "only PNG, JPEG, GIF, WebP, MP4, WebM and QuickTime are stored");
  return b;
}
