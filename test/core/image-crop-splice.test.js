// Issue #117 Phase 1: Non-destructive image crop & splice/split (shared fileId, single undoable tx).
import { describe, test, expect } from "bun:test";
import { Editor } from "../../packages/core/editor.js";
import { Doc } from "../../packages/core/doc.js";
import { paintScene } from "../../packages/core/render.js";
import { LIGHT } from "../../packages/core/export.js";
import { importExcalidrawPayload } from "../../packages/core/excalidraw.js";
import { opProblem } from "../../packages/protocol/envelope.js";

const SHA1 = "a".repeat(40);
const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

function makeEditorWithImage(opts = {}) {
  const ops = [];
  const ed = new Editor({ onOp: op => ops.push(op) });
  ed.setSize(1000, 800);
  const id = ed.addImage(
    { id: SHA1, mimeType: "image/png", dataURL: DATA_URL, width: 400, height: 200 },
    { x: 300, y: 200 },
  );
  if (opts.angle) {
    ed.transact(tx => { tx.get(id).angle = opts.angle; });
  }
  ops.length = 0;
  return { ed, id, ops };
}

describe("editor.setImageCrop", () => {
  test("sets, updates, clears crop with undo/redo and emits crop in render.js display list", () => {
    const { ed, id } = makeEditorWithImage();
    const ok = ed.setImageCrop(id, { x: 50, y: 25, width: 200, height: 100, naturalWidth: 400, naturalHeight: 200 });
    expect(ok).toBe(true);
    expect(ed.doc.get(id).crop).toEqual({ x: 50, y: 25, width: 200, height: 100, naturalWidth: 400, naturalHeight: 200 });

    const items = paintScene(ed.doc, { x: 0, y: 0, scale: 1 }, LIGHT);
    const imgItem = items.find(it => it.id === id);
    expect(imgItem?.t).toBe("image");
    expect(imgItem?.crop).toEqual({ x: 50, y: 25, width: 200, height: 100, naturalWidth: 400, naturalHeight: 200 });

    // Clearing crop with null restores full image
    expect(ed.setImageCrop(id, null)).toBe(true);
    expect(ed.doc.get(id).crop).toBeNull();

    // Undo restores previous crop
    ed.undo();
    expect(ed.doc.get(id).crop).toEqual({ x: 50, y: 25, width: 200, height: 100, naturalWidth: 400, naturalHeight: 200 });
    // Undo again clears crop
    ed.undo();
    expect(ed.doc.get(id).crop).toBeNull();
  });

  test("clamps out-of-bounds crop dimensions and rejects invalid inputs or readOnly mode", () => {
    const { ed, id } = makeEditorWithImage();
    expect(ed.setImageCrop(id, { x: 300, y: 150, width: 500, height: 500, naturalWidth: 400, naturalHeight: 200 })).toBe(true);
    expect(ed.doc.get(id).crop).toEqual({ x: 300, y: 150, width: 100, height: 50, naturalWidth: 400, naturalHeight: 200 });

    expect(ed.setImageCrop(id, { x: -1, y: 0, width: 10, height: 10 })).toBe(false);
    expect(ed.setImageCrop(id, { x: 0, y: 0, width: 0, height: 10 })).toBe(false);
    expect(ed.setImageCrop(id, { x: 400, y: 0, width: 10, height: 10, naturalWidth: 400, naturalHeight: 200 })).toBe(false);
    expect(ed.setImageCrop("nonexistent", { x: 0, y: 0, width: 10, height: 10 })).toBe(false);

    ed.readOnly = true;
    expect(ed.setImageCrop(id, null)).toBe(false);
  });
});

describe("editor.spliceImage", () => {
  test("splits an image into cols x rows sharing the exact same fileId in a single undoable transaction", () => {
    const { ed, id, ops } = makeEditorWithImage();
    const orig = ed.doc.get(id);
    const origX = orig.x, origY = orig.y, origW = orig.width, origH = orig.height;
    const filesBefore = Object.keys(ed.doc.files);

    const ids = ed.spliceImage(id, { cols: 2, rows: 2, gap: 12 });
    expect(ids.length).toBe(4);
    expect(ed.doc.get(id)).toBeNull(); // original marked deleted
    expect(ed.doc.live().length).toBe(4);
    expect(Object.keys(ed.doc.files)).toEqual(filesBefore); // zero extra files!
    expect(ops.length).toBe(1); // single transaction op!
    expect(ops[0].files).toBeUndefined(); // zero extra file upload!
    expect(opProblem({ t: "op", stream: "board", id: "c1:1", sentAt: 0, op: ops[0] })).toBeNull();

    const tiles = ids.map(tid => ed.doc.get(tid));
    for (const tile of tiles) {
      expect(tile.type).toBe("image");
      expect(tile.fileId).toBe(SHA1);
      expect(tile.width).toBeCloseTo(origW / 2, 6);
      expect(tile.height).toBeCloseTo(origH / 2, 6);
      expect(tile.groupIds).toEqual([]);
      expect(ed.sel.has(tile.id)).toBe(true);
    }

    // Check grid geometry & gap spacing
    expect(tiles[1].x - (tiles[0].x + tiles[0].width)).toBeCloseTo(12, 6);
    expect(tiles[2].y - (tiles[0].y + tiles[0].height)).toBeCloseTo(12, 6);
    expect(tiles[0].x).toBeCloseTo(origX - 6, 6);
    expect(tiles[0].y).toBeCloseTo(origY - 6, 6);

    // Check exact sub-crops cover all 4 quadrants
    expect(tiles[0].crop).toEqual({ x: 0, y: 0, width: origW / 2, height: origH / 2, naturalWidth: origW, naturalHeight: origH });
    expect(tiles[1].crop).toEqual({ x: origW / 2, y: 0, width: origW / 2, height: origH / 2, naturalWidth: origW, naturalHeight: origH });
    expect(tiles[2].crop).toEqual({ x: 0, y: origH / 2, width: origW / 2, height: origH / 2, naturalWidth: origW, naturalHeight: origH });
    expect(tiles[3].crop).toEqual({ x: origW / 2, y: origH / 2, width: origW / 2, height: origH / 2, naturalWidth: origW, naturalHeight: origH });

    // Single undo restores the original image and deletes all 4 tiles
    ed.undo();
    expect(ed.doc.live().length).toBe(1);
    expect(ed.doc.get(id)).not.toBeNull();
    // Redo restores the 4 spliced tiles
    ed.redo();
    expect(ed.doc.live().length).toBe(4);
    expect(ed.doc.get(id)).toBeNull();
  });

  test("Opus review regression: scaled-down large image preserves true natural pixels in setImageCrop and spliceImage", () => {
    const ed = new Editor();
    ed.setSize(1000, 800);
    // 4000x3000 image gets scaled down on canvas to fit 60% of 1000x800 (600x450)
    const id = ed.addImage({ id: SHA1, mimeType: "image/png", dataURL: DATA_URL, width: 4000, height: 3000 }, { x: 500, y: 400 });
    expect(ed.doc.files[SHA1].width).toBe(4000);
    expect(ed.doc.files[SHA1].height).toBe(3000);
    expect(ed.doc.get(id).width).toBeLessThan(1000);

    // setImageCrop without explicit naturalWidth/naturalHeight uses stored natural 4000x3000
    expect(ed.setImageCrop(id, { x: 0, y: 0, width: 2000, height: 1500 })).toBe(true);
    expect(ed.doc.get(id).crop).toEqual({ x: 0, y: 0, width: 2000, height: 1500, naturalWidth: 4000, naturalHeight: 3000 });

    // Clear crop and splice 2x2 -> tile crops are in true source pixels (4000x3000), not display units
    ed.setImageCrop(id, null);
    const ids = ed.spliceImage(id, { cols: 2, rows: 2, gap: 10 });
    expect(ids.length).toBe(4);
    expect(ed.doc.get(ids[0]).crop).toEqual({ x: 0, y: 0, width: 2000, height: 1500, naturalWidth: 4000, naturalHeight: 3000 });
    expect(ed.doc.get(ids[3]).crop).toEqual({ x: 2000, y: 1500, width: 2000, height: 1500, naturalWidth: 4000, naturalHeight: 3000 });
  });

  test("splicing an already-cropped image subdivides within the active crop rect", () => {
    const { ed, id } = makeEditorWithImage();
    ed.setImageCrop(id, { x: 100, y: 50, width: 200, height: 100, naturalWidth: 400, naturalHeight: 200 });
    const ids = ed.spliceImage(id, { cols: 2, rows: 1, gap: 0 });
    expect(ids.length).toBe(2);
    const [left, right] = ids.map(tid => ed.doc.get(tid));
    expect(left.crop).toEqual({ x: 100, y: 50, width: 100, height: 100, naturalWidth: 400, naturalHeight: 200 });
    expect(right.crop).toEqual({ x: 200, y: 50, width: 100, height: 100, naturalWidth: 400, naturalHeight: 200 });
  });

  test("splicing a rotated image preserves rotation angle on each tile", () => {
    const { ed, id } = makeEditorWithImage({ angle: Math.PI / 2 });
    const ids = ed.spliceImage(id, { cols: 2, rows: 1, gap: 10 });
    expect(ids.length).toBe(2);
    const [a, b] = ids.map(tid => ed.doc.get(tid));
    expect(a.angle).toBeCloseTo(Math.PI / 2, 6);
    expect(b.angle).toBeCloseTo(Math.PI / 2, 6);
    // At 90° rotation, horizontal tiles stack vertically
    expect(a.x).toBeCloseTo(b.x, 4);
    expect(b.y).toBeGreaterThan(a.y);
  });

  test("Excalidraw v2 imported image with crop renders with exact crop in paintScene", () => {
    const payload = {
      type: "excalidraw",
      version: 2,
      elements: [{
        id: "ex-img",
        type: "image",
        x: 10, y: 20, width: 150, height: 100,
        fileId: SHA1,
        status: "saved",
        scale: [1, 1],
        crop: { x: 50, y: 40, width: 300, height: 200, naturalWidth: 600, naturalHeight: 400 },
      }],
      files: { [SHA1]: { id: SHA1, mimeType: "image/png", dataURL: DATA_URL, created: 1 } },
    };
    const res = importExcalidrawPayload(payload, { remapIds: false });
    expect(res.ok).toBe(true);
    const doc = new Doc({ elements: res.elements, files: res.files });
    const items = paintScene(doc, { x: 0, y: 0, scale: 1 }, LIGHT);
    expect(items.length).toBe(1);
    expect(items[0].crop).toEqual({ x: 50, y: 40, width: 300, height: 200, naturalWidth: 600, naturalHeight: 400 });
  });
});
