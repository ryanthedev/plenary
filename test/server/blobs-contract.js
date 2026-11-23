// The Blobs port's contract (PROTOCOL.md § Blobs), as tests any adapter must pass: disk.js and s3.js.
// blobsContract(label, makeBlobs) registers the tests; makeBlobs() returns a fresh Blobs (or a promise of one).
// Every test uses its own tenant ids, so adapters that share one store across tests (one bucket) stay isolated.
// Adapter-specific checks (file layout, object keys) live in that adapter's own test file.
import { test, expect } from "bun:test";
import { MAX_BLOB_BYTES } from "../../server/adapters/driven/blobs/disk.js";
import { fakePng, sha1 } from "./helpers.js";

const code = async p => { try { await p; return "resolved"; } catch (e) { return e.code ?? `threw ${e.message}`; } };
let n = 0;
const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
/** A fresh tenant id. */
export const freshTenant = () => `t-${run}-${++n}`;

/**
 * @param {string} label
 * @param {() => any} makeBlobs
 * @param {{ skip?: boolean }} [o]
 */
export function blobsContract(label, makeBlobs, { skip = false } = {}) {
  const t = skip ? test.skip : test;

  t(`${label}: put then get returns the bytes; put is idempotent; a missing blob is null`, async () => {
    const blobs = await makeBlobs(), ta = freshTenant();
    const bytes = fakePng(300, 7), h = sha1(bytes);
    expect(await blobs.get(ta, h)).toBe(null);
    await blobs.put(ta, h, bytes);
    await blobs.put(ta, h, bytes);
    const back = await blobs.get(ta, h);
    expect(back).toBeInstanceOf(Uint8Array);
    expect(back).toEqual(bytes);
  });

  t(`${label}: a hash mismatch is refused and nothing is stored`, async () => {
    const blobs = await makeBlobs(), ta = freshTenant();
    const bytes = fakePng(100, 1), other = sha1(fakePng(100, 2));
    expect(await code(blobs.put(ta, other, bytes))).toBe("hash-mismatch");
    expect(await blobs.get(ta, other)).toBe(null);
  });

  t(`${label}: the 10 MB cap`, async () => {
    const blobs = await makeBlobs(), ta = freshTenant();
    const big = fakePng(MAX_BLOB_BYTES + 1, 3);
    expect(await code(blobs.put(ta, sha1(big), big))).toBe("too-large");
    expect(await blobs.get(ta, sha1(big))).toBe(null);
    const edge = fakePng(MAX_BLOB_BYTES, 4), h = sha1(edge);
    await blobs.put(ta, h, edge);
    const back = await blobs.get(ta, h);
    expect(back.byteLength).toBe(MAX_BLOB_BYTES);
    expect(sha1(back)).toBe(h);
  }, 30000);

  t(`${label}: tenants are isolated`, async () => {
    const blobs = await makeBlobs(), ta = freshTenant(), tb = freshTenant();
    const bytes = fakePng(80, 5), h = sha1(bytes);
    await blobs.put(ta, h, bytes);
    expect(await blobs.get(tb, h)).toBe(null);
    await blobs.put(tb, h, bytes);
    expect(await blobs.get(tb, h)).toEqual(bytes);
  });

  t(`${label}: bad tenant ids and bad hashes are refused with bad-id`, async () => {
    const blobs = await makeBlobs(), ta = freshTenant();
    const bytes = fakePng(80, 6), h = sha1(bytes);
    for (const bad of ["..", "../x", "a/b", "", ".", "t.a", "T-A", "a\0b", "*", ">", null, 5, "x".repeat(65)]) {
      expect(await code(blobs.put(bad, h, bytes))).toBe("bad-id");
      expect(await code(blobs.get(bad, h))).toBe("bad-id");
    }
    for (const s of ["../outside", "..", "", h.toUpperCase(), h.slice(1), h + "0", "g".repeat(40), `../../${"a".repeat(34)}`, `${ta}/${h}`, null]) {
      expect(await code(blobs.put(ta, s, bytes))).toBe("bad-id");
      expect(await code(blobs.get(ta, s))).toBe("bad-id");
    }
    // A bad id wins over bad bytes: the id is checked first.
    expect(await code(blobs.put("../x", h, new Uint8Array(0)))).toBe("bad-id");
  });

  t(`${label}: only PNG, JPEG, GIF and WebP; SVG, text and empty bytes are refused`, async () => {
    const blobs = await makeBlobs(), ta = freshTenant();
    const enc = s => new TextEncoder().encode(s);
    for (const b of [enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), enc("just some text, long enough"), new Uint8Array(0)]) {
      expect(["not-image", "bad-entry"]).toContain(await code(blobs.put(ta, sha1(b), b)));
      expect(await blobs.get(ta, sha1(b))).toBe(null);
    }
    for (const head of [[0xff, 0xd8, 0xff, 0xe0], [...enc("GIF89a")], [...enc("RIFF"), 0, 0, 0, 0, ...enc("WEBP")]]) {
      const b = new Uint8Array(64).fill(9); b.set(head);
      await blobs.put(ta, sha1(b), b);
      expect(await blobs.get(ta, sha1(b))).toEqual(b);
    }
  });

  t(`${label}: puts of one hash at once all resolve and leave the bytes`, async () => {
    const blobs = await makeBlobs(), ta = freshTenant();
    const bytes = fakePng(5000, 9), h = sha1(bytes);
    await Promise.all(Array.from({ length: 8 }, () => blobs.put(ta, h, bytes)));
    expect(await blobs.get(ta, h)).toEqual(bytes);
  });

  t(`${label}: put answers true when it stored the blob and false when the tenant already had it`, async () => {
    const blobs = await makeBlobs(), ta = freshTenant(), tb = freshTenant();
    const bytes = fakePng(150, 11), h = sha1(bytes);
    expect(await blobs.put(ta, h, bytes)).toBe(true);
    expect(await blobs.put(ta, h, bytes)).toBe(false);
    expect(await blobs.put(tb, h, bytes)).toBe(true);        // another tenant's copy is its own
  });

  t(`${label}: usage is the bytes the tenant's blobs take: 0 when empty, once per blob, per tenant, ids checked`, async () => {
    const blobs = await makeBlobs(), ta = freshTenant(), tb = freshTenant();
    expect(await blobs.usage(ta)).toBe(0);
    const a = fakePng(150, 12), b = fakePng(333, 13), c = fakePng(77, 14);
    await blobs.put(ta, sha1(a), a); await blobs.put(ta, sha1(b), b); await blobs.put(ta, sha1(b), b);
    await blobs.put(tb, sha1(c), c);
    expect(await blobs.usage(ta)).toBe(150 + 333);
    expect(await blobs.usage(tb)).toBe(77);
    for (const bad of ["..", "a/b", "", null]) expect(await code(blobs.usage(bad))).toBe("bad-id");
  });

  t(`${label}: delete removes the blob and its bytes from usage, is idempotent, and touches nothing else (another hash, another tenant)`, async () => {
    const blobs = await makeBlobs(), ta = freshTenant(), tb = freshTenant();
    const a = fakePng(200, 21), b = fakePng(300, 22), ha = sha1(a), hb = sha1(b);
    await blobs.put(ta, ha, a); await blobs.put(ta, hb, b); await blobs.put(tb, ha, a);
    expect(await blobs.delete(ta, ha)).toBeUndefined();
    expect(await blobs.get(ta, ha)).toBe(null);
    expect(await blobs.usage(ta)).toBe(300);
    expect(await blobs.get(ta, hb)).toEqual(b);                 // the neighbour hash
    expect(await blobs.get(tb, ha)).toEqual(a);                 // the same hash in another tenant
    await blobs.delete(ta, ha);                                 // again: nothing there is not an error
    await blobs.delete(ta, sha1(fakePng(50, 23)));              // never stored
    expect(await blobs.put(ta, ha, a)).toBe(true);              // and it can be stored again
    expect(await blobs.get(ta, ha)).toEqual(a);
  });

  t(`${label}: delete checks its ids like put and get`, async () => {
    const blobs = await makeBlobs(), ta = freshTenant(), h = sha1(fakePng(80, 24));
    for (const bad of ["..", "../x", "a/b", "", null, "T-A"]) expect(await code(blobs.delete(bad, h))).toBe("bad-id");
    for (const s of ["../outside", "..", "", h.toUpperCase(), h.slice(1), `${ta}/${h}`, null]) expect(await code(blobs.delete(ta, s))).toBe("bad-id");
  });

  t(`${label}: quarantine takes the blob out of reach and out of usage without destroying it; restore puts it back byte for byte; both are idempotent`, async () => {
    const blobs = await makeBlobs(), ta = freshTenant(), tb = freshTenant();
    const a = fakePng(200, 41), b = fakePng(300, 42), ha = sha1(a), hb = sha1(b);
    await blobs.put(ta, ha, a); await blobs.put(ta, hb, b); await blobs.put(tb, ha, a);
    await blobs.quarantine(ta, ha);
    expect(await blobs.get(ta, ha)).toBe(null);
    expect(await blobs.usage(ta)).toBe(500);                   // still counted: the bytes are kept (and a usage read mid-reap must not miss them)
    expect(await blobs.usage(tb)).toBe(200);                   // another tenant's folder is its own
    expect(await blobs.get(ta, hb)).toEqual(b); expect(await blobs.get(tb, ha)).toEqual(a);   // neighbours untouched
    await blobs.quarantine(ta, ha);                            // again: nothing live to move is not an error
    await blobs.quarantine(ta, sha1(fakePng(50, 43)));         // never stored
    expect(await blobs.usage(ta)).toBe(500);
    await blobs.delete(ta, ha); await blobs.put(ta, ha, a); await blobs.quarantine(ta, ha);   // gone for good, then stored and quarantined afresh
    await blobs.restore(ta, ha);
    expect(await blobs.get(ta, ha)).toEqual(a);
    expect(await blobs.usage(ta)).toBe(500);
    await blobs.restore(ta, ha);                               // again: nothing quarantined
    await blobs.restore(ta, sha1(fakePng(50, 44)));
    expect(await blobs.get(ta, ha)).toEqual(a);
  });

  t(`${label}: a blob stored again while quarantined is the live one: restore keeps it and drops the quarantined copy; delete removes both for good`, async () => {
    const blobs = await makeBlobs(), ta = freshTenant();
    const a = fakePng(210, 45), ha = sha1(a);
    await blobs.put(ta, ha, a);
    await blobs.quarantine(ta, ha);
    expect(await blobs.put(ta, ha, a)).toBe(true);             // stored afresh: the quarantine is not "had it"
    await blobs.restore(ta, ha);
    expect(await blobs.get(ta, ha)).toEqual(a);
    expect(await blobs.usage(ta)).toBe(210);                   // one copy
    await blobs.restore(ta, ha);                               // the quarantined copy is gone: still one
    await blobs.quarantine(ta, ha);
    await blobs.delete(ta, ha);                                // for good, the quarantined copy too
    await blobs.restore(ta, ha);
    expect(await blobs.get(ta, ha)).toBe(null);
    expect(await blobs.usage(ta)).toBe(0);
  });

  t(`${label}: quarantine and restore check their ids like put and get`, async () => {
    const blobs = await makeBlobs(), ta = freshTenant(), h = sha1(fakePng(80, 46));
    for (const f of ["quarantine", "restore"]) {
      for (const bad of ["..", "a/b", "", null, "T-A", ".quarantine"]) expect(await code(blobs[f](bad, h))).toBe("bad-id");
      for (const x of ["../outside", "", h.toUpperCase(), `${ta}/${h}`, null]) expect(await code(blobs[f](ta, x))).toBe("bad-id");
    }
  });
}
