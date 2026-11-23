import { describe, test, expect } from "bun:test";
import { makeElement, isVideo, isMedia, isBoxy } from "../../packages/core/model.js";
import { Doc } from "../../packages/core/doc.js";
import { bbox, bounds, normalize, hits, hitTest, bindable, bindTargetAt, portsOf, resolvedPoints } from "../../packages/core/geometry.js";
import { spatialIndex } from "../../packages/core/spatial.js";
import { paintScene, planBatches } from "../../packages/core/render.js";
import { exportScene, paintedBox, LIGHT } from "../../packages/core/export.js";
import { Editor } from "../../packages/core/editor.js";
import { itemFromElements } from "../../packages/core/library.js";
import { opProblem } from "../../packages/protocol/envelope.js";
import { videoKind, blobKind, checkBlob, parseByteRange, MAX_BLOB_BYTES, MAX_VIDEO_BLOB_BYTES } from "../../server/ports/blobs.js";

const SHA1 = "a".repeat(40);
const sha1Hex = bytes => new Bun.CryptoHasher("sha1").update(bytes).digest("hex");

function fakeMp4(size = 64) {
  const b = new Uint8Array(Math.max(12, size));
  b.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0); // ftyp isom
  return b;
}
function fakeWebm(size = 64) {
  const b = new Uint8Array(Math.max(12, size));
  b.set([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81], 0);
  return b;
}
function fakeMov(size = 64) {
  const b = new Uint8Array(Math.max(12, size));
  b.set([0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20], 0); // ftyp qt
  return b;
}

describe("core model: video elements", () => {
  test("makeElement('video') sets expected defaults and predicates", () => {
    const v = makeElement("video", { fileId: SHA1, x: 10, y: 20, width: 320, height: 180 });
    expect(v.type).toBe("video");
    expect(v.fileId).toBe(SHA1);
    expect(v.mimeType).toBe("video/mp4");
    expect(v.status).toBe("saved");
    expect(v.posterDataUrl).toBeNull();
    expect(v.loop).toBe(false);
    expect(v.muted).toBe(true);
    expect(v.autoplay).toBe(false);
    expect(v.scale).toEqual([1, 1]);
    expect(isVideo(v)).toBe(true);
    expect(isMedia(v)).toBe(true);
    expect(isBoxy(v)).toBe(true);
  });
});

describe("core geometry & spatial index: video elements", () => {
  test("bbox, bounds (rotated), normalize, hits, hitTest, spatialIndex, and bindable", () => {
    const v = makeElement("video", { fileId: SHA1, x: 100, y: 50, width: -200, height: -100 });
    normalize(v);
    expect(v.x).toBe(-100);
    expect(v.y).toBe(-50);
    expect(v.width).toBe(200);
    expect(v.height).toBe(100);
    expect(bbox(v)).toEqual({ x: -100, y: -50, w: 200, h: 100 });

    v.angle = Math.PI / 2;
    const rb = bounds(v);
    expect(Math.round(rb.w)).toBe(100);
    expect(Math.round(rb.h)).toBe(200);

    v.angle = 0;
    const doc = new Doc({ elements: [v], files: {} });
    expect(hits(doc, v, { x: 0, y: 0 }, 4)).toBe(true);
    expect(hits(doc, v, { x: 500, y: 500 }, 4)).toBe(false);
    expect(hitTest(doc, { x: 0, y: 0 })?.id).toBe(v.id);
    expect(spatialIndex(doc).queryPoint(0, 0, 5).map(e => e.id)).toContain(v.id);

    expect(bindable(v)).toBe(true);
    expect(bindTargetAt(doc, { x: 0, y: 0 })?.id).toBe(v.id);
    expect(portsOf(v).length).toBe(4);

    // Arrow bound to video resolves onto its outline
    const arrow = makeElement("arrow", {
      x: 200, y: 0, points: [[0, 0], [-150, 0]],
      endBinding: { elementId: v.id, gap: 6 },
    });
    doc.apply({ elements: [arrow] });
    const pts = resolvedPoints(doc, arrow);
    expect(pts[1][0]).toBeCloseTo(106, 1); // right edge (100) + gap (6)
  });
});

describe("core render & export: video elements", () => {
  test("paintScene emits a video display item with status pending vs saved and planBatches preserves it", () => {
    const v = makeElement("video", { fileId: SHA1, x: 20, y: 30, width: 320, height: 180, posterDataUrl: "data:image/png;base64,AA==" });
    const doc = new Doc({ elements: [v], files: {} });
    const pendingItems = paintScene(doc, { x: 0, y: 0, scale: 1 }, LIGHT);
    expect(pendingItems.length).toBe(1);
    expect(pendingItems[0]).toMatchObject({
      t: "video",
      id: v.id,
      fileId: SHA1,
      mimeType: "video/mp4",
      posterDataUrl: "data:image/png;base64,AA==",
      status: "pending",
      x: 20, y: 30, w: 320, h: 180,
    });

    doc.apply({ files: { [SHA1]: { id: SHA1, mimeType: "video/mp4", url: "blob:http://localhost/test", created: 1 } } });
    const savedItems = paintScene(doc, { x: 0, y: 0, scale: 1 }, LIGHT);
    expect(savedItems[0].status).toBe("saved");

    const { layers } = planBatches(savedItems, () => "k");
    expect(layers.length).toBe(1);
    expect(layers[0].img.t).toBe("video");

    const pb = paintedBox(doc, LIGHT);
    expect(pb).toEqual({ x: 20, y: 30, w: 320, h: 180 });
    const exp = exportScene(doc, LIGHT, { padding: 10 });
    expect(exp.width).toBe(340);
    expect(exp.height).toBe(200);
  });
});

describe("core Editor & library: video lifecycle and H3 byte stripping", () => {
  test("addVideo, select, aspect-locked resize, copy/paste strips bytes, library strips bytes, and undo/redo", () => {
    const ed = new Editor();
    ed.setSize(1000, 800);
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const id = ed.addVideo({ id: SHA1, mimeType: "video/mp4", bytes, width: 640, height: 360 });
    const el = ed.doc.get(id);
    expect(el?.type).toBe("video");
    expect(ed.sel.has(id)).toBe(true);
    expect(ed.keepAspect({ shift: false })).toBe(true);
    expect(ed.keepAspect({ shift: true })).toBe(false);

    // H3: copy() strips raw bytes/url from video file entries
    const clip = ed.copy();
    const parsed = JSON.parse(clip);
    expect(parsed.files[SHA1]).toEqual({ id: SHA1, mimeType: "video/mp4" });
    expect(parsed.files[SHA1].bytes).toBeUndefined();

    // H3: library itemFromElements() strips raw bytes/url from video file entries
    const libItem = itemFromElements([el], { files: ed.doc.files });
    expect(libItem.files[SHA1]).toEqual({ id: SHA1, mimeType: "video/mp4" });
    expect(libItem.files[SHA1].bytes).toBeUndefined();

    ed.paste(clip);
    expect(ed.doc.live().filter(e => e.type === "video").length).toBe(2);

    ed.undo();
    expect(ed.doc.live().filter(e => e.type === "video").length).toBe(1);
    ed.redo();
    expect(ed.doc.live().filter(e => e.type === "video").length).toBe(2);
  });
});

describe("protocol envelope: video validation (H4)", () => {
  const wrap = el => ({ stream: "board", id: "c1:1", sentAt: 0, op: { elements: [el] } });

  test("accepts valid video element and rejects malformed mimeType / posterDataUrl / flags", () => {
    const good = makeElement("video", {
      fileId: SHA1,
      mimeType: "video/webm",
      posterDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      loop: true,
      muted: true,
      autoplay: false,
    });
    expect(opProblem(wrap(good))).toBeNull();
    expect(opProblem(wrap({ ...good, mimeType: "video/mp4" }))).toBeNull();
    expect(opProblem(wrap({ ...good, mimeType: "video/quicktime" }))).toBeNull();
    expect(opProblem(wrap({ ...good, posterDataUrl: null }))).toBeNull();

    expect(opProblem(wrap({ ...good, fileId: "not-a-sha1" }))?.code).toBe("bad-op");
    expect(opProblem(wrap({ ...good, loop: "yes" }))?.code).toBe("bad-op");
    expect(opProblem(wrap({ ...good, muted: 1 }))?.code).toBe("bad-op");
    expect(opProblem(wrap({ ...good, autoplay: "true" }))?.code).toBe("bad-op");

    // H4: strict mimeType allowlist
    expect(opProblem(wrap({ ...good, mimeType: 123 }))?.code).toBe("bad-op");
    expect(opProblem(wrap({ ...good, mimeType: "video/avi" }))?.code).toBe("bad-op");
    expect(opProblem(wrap({ ...good, mimeType: "text/html" }))?.code).toBe("bad-op");

    // H4: strict posterDataUrl validation (rejects https:, javascript:, svg, >64KB)
    expect(opProblem(wrap({ ...good, posterDataUrl: 42 }))?.code).toBe("bad-op");
    expect(opProblem(wrap({ ...good, posterDataUrl: "https://evil.example/tracker.png" }))?.code).toBe("bad-op");
    expect(opProblem(wrap({ ...good, posterDataUrl: "javascript:alert(1)" }))?.code).toBe("bad-op");
    expect(opProblem(wrap({ ...good, posterDataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }))?.code).toBe("bad-op");
    const hugePoster = "data:image/png;base64," + "A".repeat(65536);
    expect(opProblem(wrap({ ...good, posterDataUrl: hugePoster }))?.code).toBe("bad-op");
  });
});

describe("server blobs: video magic bytes, expanded MP4 brands, size limits, and RFC 9110 Range (M7/L13)", () => {
  test("detects MP4 (including expanded brands), WebM, QuickTime and enforces video vs non-video limits", () => {
    const mp4 = fakeMp4(128);
    const webm = fakeWebm(128);
    const mov = fakeMov(128);
    expect(videoKind(mp4)).toBe("mp4");
    expect(videoKind(webm)).toBe("webm");
    expect(videoKind(mov)).toBe("mov");
    expect(blobKind(mp4)).toBe("mp4");
    expect(blobKind(webm)).toBe("webm");
    expect(blobKind(mov)).toBe("mov");

    // L13: expanded MP4 brands
    for (const brand of ["iso8", "mp71", "MSNV", "XAVC", "3g2a", "mmp4"]) {
      const b = fakeMp4(64);
      for (let i = 0; i < 4; i++) b[8 + i] = brand.charCodeAt(i);
      expect(videoKind(b)).toBe("mp4");
    }

    expect(() => checkBlob(sha1Hex(mp4), mp4)).not.toThrow();
    expect(() => checkBlob(sha1Hex(webm), webm)).not.toThrow();
    expect(() => checkBlob(sha1Hex(mov), mov)).not.toThrow();

    // Video larger than image limit (10 MB) but <= 50 MB is accepted
    const medMp4 = fakeMp4(MAX_BLOB_BYTES + 1024);
    expect(() => checkBlob(sha1Hex(medMp4), medMp4)).not.toThrow();

    // Non-video larger than 10 MB is rejected as too-large
    const hugeRaw = new Uint8Array(MAX_BLOB_BYTES + 1);
    expect(() => checkBlob(SHA1, hugeRaw)).toThrow(/limited/);

    // Video larger than 50 MB is rejected as too-large
    const hugeMp4 = fakeMp4(MAX_VIDEO_BLOB_BYTES + 1);
    expect(() => checkBlob(SHA1, hugeMp4)).toThrow(/limited/);
  });

  test("parseByteRange follows RFC 9110 §14.1.2 (206, 416, invalid start>end ignored as 200)", () => {
    expect(parseByteRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange("bytes=50-999", 100)).toEqual({ start: 50, end: 99 });
    expect(parseByteRange("bytes=100-", 100)).toEqual({ unsatisfiable: true });
    expect(parseByteRange("bytes=100-200", 100)).toEqual({ unsatisfiable: true });
    // Syntactically invalid (start > end) must be ignored (return null → 200 full body), NOT 416
    expect(parseByteRange("bytes=5-2", 100)).toBeNull();
    expect(parseByteRange("items=0-5", 100)).toBeNull();
    expect(parseByteRange(null, 100)).toBeNull();
  });
});
