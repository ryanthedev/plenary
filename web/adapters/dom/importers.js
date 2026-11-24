// @ts-check
/**
 * @module web/adapters/dom/importers
 * Media and diagram import pipelines for the canvas page: raster images, videos (with metadata probe),
 * Excalidraw v2 JSON / clipboard scenes (re-hashing embedded images to SHA-1), Draw.io XML, and
 * `.excalidrawlib` shape libraries. Extracted from `app.js` with injected session/net/clock/library ports.
 */

import { isLabel } from "../../../packages/core/model.js";
import { parseLibrary } from "../../../packages/core/library.js";
import { parseExcalidraw, MAX_EXCALIDRAW_INPUT_BYTES } from "../../../packages/core/excalidraw.js";
import { isDrawio, parseDrawio, MAX_DRAWIO_BYTES } from "../../../packages/core/drawio.js";
import { addToLibrary } from "./panel.js";

export const RASTER = /^image\/(png|jpeg|gif|webp)$/;
export const VIDEO_MIME = /^video\/(mp4|webm|quicktime)$/;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Decode a base64 `data:` URL payload into raw bytes (`null` if malformed).
 * @param {string} dataURL
 * @returns {Uint8Array | null}
 */
export function decodeDataUrlBytes(dataURL) {
  if (typeof dataURL !== "string") return null;
  const comma = dataURL.indexOf(",");
  if (comma < 0) return null;
  const b64 = dataURL.slice(comma + 1).replace(/\s+/g, "");
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Create the board's file, clipboard-text, image, video, and library importers.
 * @param {{
 *   S: any,
 *   net: import("../../ports/net.js").Net,
 *   clock: import("../../ports/clock.js").Clock,
 *   toast: (text: string, ms?: number) => void,
 *   getLibrary: () => any[],
 *   setLibrary: (items: any[]) => void,
 *   onDirty: () => void,
 *   doc?: Document | null,
 * }} deps
 */
export function createImporters({ S, net, clock, toast, getLibrary, setLibrary, onDirty, doc = null }) {
  const docRef = () => doc ?? globalThis.document;

  /**
   * Import a raster image file (PNG/JPEG/GIF/WebP <= 10 MB), content-addressed by SHA-1.
   * @param {File | Blob} file
   * @param {{ x: number, y: number }} [at]
   */
  async function addPicture(file, at) {
    if (!S.may()) return;
    if (!RASTER.test(file.type)) return toast("Pictures: PNG, JPEG, GIF or WebP");
    if (file.size > MAX_IMAGE_BYTES) return toast("Pictures are limited to 10 MB");
    const buf = await file.arrayBuffer();
    const id = [...new Uint8Array(await crypto.subtle.digest("SHA-1", buf))].map(b => b.toString(16).padStart(2, "0")).join("");
    const dataURL = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(null); r.readAsDataURL(file); });
    if (!dataURL) return toast("That picture couldn't be read");
    const img = await new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = dataURL; });
    if (!img) return toast("That picture couldn't be read");
    // Re-check write permission after async FileReader/Image decode in case the session changed.
    if (!S.may()) return;
    const f = { id, mimeType: file.type, dataURL, width: img.naturalWidth, height: img.naturalHeight };
    if (typeof net.uploadBlob === "function") {
      try { await S.uploadBlob(id, new Uint8Array(buf), file.type); }
      catch { return toast("Picture upload failed"); }
      if (!S.may()) return;
      S.addPicture(f, at);
    } else if (S.addPicture(f, at)) {
      net.put(f); // upload through a signed URL (wsNet), or the dev tab relay
    }
    onDirty();
  }

  /**
   * Probe intrinsic video dimensions with a virtual-clock timeout fallback (`480x270`).
   * @param {string} url
   * @returns {Promise<{ width: number, height: number }>}
   */
  async function probeVideoMeta(url) {
    return new Promise(res => {
      const d = docRef();
      if (typeof d?.createElement !== "function") return res({ width: 480, height: 270 });
      const v = d.createElement("video");
      let settled = false;
      const done = meta => { if (settled) return; settled = true; try { v.removeAttribute?.("src"); v.src = ""; } catch {} res(meta); };
      // Use the injected clock port rather than setTimeout so tests remain deterministic.
      const timer = clock.set(() => done({ width: 480, height: 270 }), 3000);
      v.preload = "metadata";
      v.muted = true;
      v.playsInline = true;
      v.onloadedmetadata = () => { clock.clear(timer); done({ width: v.videoWidth || 480, height: v.videoHeight || 270 }); };
      v.onerror = () => { clock.clear(timer); done({ width: 480, height: 270 }); };
      v.src = url;
    });
  }

  /**
   * Import an MP4/WebM/QuickTime video (<= 50 MB), content-addressed by SHA-1.
   * @param {File | Blob} file
   * @param {{ x: number, y: number }} [at]
   */
  async function addVideoFile(file, at) {
    if (!S.may()) return;
    if (!VIDEO_MIME.test(file.type)) return toast("Videos: MP4, WebM or QuickTime");
    if (file.size > MAX_VIDEO_BYTES) return toast("Videos are limited to 50 MB");
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const id = [...new Uint8Array(await crypto.subtle.digest("SHA-1", buf))].map(b => b.toString(16).padStart(2, "0")).join("");
    let meta = { width: 480, height: 270 };
    if (typeof URL?.createObjectURL === "function") {
      const probeUrl = URL.createObjectURL(file);
      try { meta = await probeVideoMeta(probeUrl); }
      finally { try { URL.revokeObjectURL?.(probeUrl); } catch {} }
    }
    if (!S.may()) return;
    const f = { id, mimeType: file.type, bytes, width: meta.width, height: meta.height };
    if (typeof net.uploadBlob === "function") {
      try { await S.uploadBlob(id, bytes, file.type); }
      catch { return toast("Video upload failed"); }
      if (!S.may()) return;
      S.addVideo(f, at);
    } else if (S.addVideo(f, at)) {
      net.put(/** @type {any} */ (f)); // local / shared-worker tab relay
    }
    onDirty();
  }

  /**
   * Re-hash Excalidraw embedded `dataURL` blobs to SHA-1 IDs and upload raster blobs before scene insertion.
   * @param {Record<string, any>} files
   * @returns {Promise<{ fileIdMap: Map<string, string>, files: Record<string, any> }>}
   */
  async function prepareExcalidrawFiles(files) {
    const fileIdMap = new Map();
    const outFiles = {};
    for (const [origId, entry] of Object.entries(files ?? {})) {
      if (!entry || typeof entry.dataURL !== "string") {
        if (entry && entry.mimeType) outFiles[origId] = entry;
        continue;
      }
      const bytes = decodeDataUrlBytes(entry.dataURL);
      if (!bytes || !bytes.length || bytes.length > MAX_IMAGE_BYTES) continue;
      const sha1 = [...new Uint8Array(await crypto.subtle.digest("SHA-1", /** @type {BufferSource} */ (bytes)))].map(b => b.toString(16).padStart(2, "0")).join("");
      fileIdMap.set(origId, sha1);
      const next = { id: sha1, mimeType: entry.mimeType || "image/png", dataURL: entry.dataURL, created: entry.created ?? clock.now() };
      outFiles[sha1] = next;
      if (RASTER.test(next.mimeType)) {
        if (typeof net.uploadBlob === "function") {
          await S.uploadBlob(sha1, bytes, next.mimeType);
        } else {
          net.put?.(next);
        }
      }
    }
    return { fileIdMap, files: outFiles };
  }

  /**
   * Insert a parsed Excalidraw scene into the active writable stream.
   * @param {any} parsed
   * @param {{ at?: any, label?: string | null, fitIfNeeded?: boolean, silent?: boolean }} [opts]
   * @returns {Promise<boolean>}
   */
  async function importExcalidrawParsed(parsed, { at, label = null, fitIfNeeded = false, silent = false } = {}) {
    if (!S.may()) return false;
    if (!parsed.ok) {
      if (!silent) toast("That isn't a valid .excalidraw file");
      return false;
    }
    if (!parsed.elements.length) {
      if (!silent) toast("No elements in that .excalidraw file");
      return false;
    }
    const hasImageData = Object.values(parsed.files).some(f => typeof f?.dataURL === "string");
    let fileIdMap = null, files = parsed.files;
    if (hasImageData) {
      try {
        const prepared = await prepareExcalidrawFiles(parsed.files);
        fileIdMap = prepared.fileIdMap;
        files = prepared.files;
      } catch {
        toast("Import failed: picture upload failed");
        return false;
      }
      if (!S.may()) return false;
    }
    const stream = S.role === "presenter" ? S.active : "notes";
    let ids = [];
    S.act(stream, ed => {
      // Why: `dropNonSha1` guarantees only content-addressed blobs are stored on board elements.
      ids = ed.importExcalidraw({ ...parsed, files }, at, { fileIdMap, fitIfNeeded, dropNonSha1: true });
    });
    onDirty();
    if (!silent && ids.length) {
      const n = parsed.elements.filter(e => !isLabel(e)).length || ids.length;
      const from = label ? ` from ${label}` : "";
      toast(`Imported ${n} element${n === 1 ? "" : "s"}${from}`);
    }
    return ids.length > 0;
  }

  /**
   * Paste plain text, Mermaid source, or Excalidraw clipboard/scene JSON at `at`.
   * @param {string} text
   * @param {{ x: number, y: number }} [at]
   * @returns {boolean | Promise<boolean>}
   */
  function pasteText(text, at) {
    if (!S.may()) return false;
    // Cheap string pre-check avoids double-parsing JSON on clipboard paste.
    if (typeof text === "string" && text.length <= MAX_EXCALIDRAW_INPUT_BYTES && text.trimStart().startsWith("{") && text.includes('"excalidraw')) {
      const parsed = parseExcalidraw(text, { now: clock.now() });
      if (parsed.ok) {
        const hasImageData = Object.values(parsed.files).some(f => typeof f?.dataURL === "string");
        if (hasImageData) return importExcalidrawParsed(parsed, { at, fitIfNeeded: false, silent: true });
        if (parsed.elements.length) {
          const stream = S.role === "presenter" ? S.active : "notes";
          S.act(stream, ed => ed.importExcalidraw(parsed, at, { fitIfNeeded: false, dropNonSha1: true }));
          onDirty();
          return true;
        }
        return false;
      }
    }
    S.paste(text, at);
    onDirty();
    return true;
  }

  /**
   * Read and import a `.excalidraw` / `.json` file.
   * @param {File} file
   * @param {{ x: number, y: number }} [at]
   */
  async function addExcalidrawFile(file, at) {
    if (!S.may()) return;
    if (file.size > MAX_EXCALIDRAW_INPUT_BYTES) return toast("That .excalidraw file is too large (max 50 MB)");
    try {
      const text = await file.text();
      const parsed = parseExcalidraw(text, { now: clock.now() });
      await importExcalidrawParsed(parsed, { at, label: file.name || "Excalidraw", fitIfNeeded: !at, silent: false });
    } catch {
      toast("That isn't a valid .excalidraw file");
    }
  }

  /**
   * Read and import a `.drawio` / `.xml` diagram file.
   * @param {File} file
   * @param {{ x: number, y: number }} [at]
   * @returns {Promise<boolean>}
   */
  async function addDrawioFile(file, at) {
    if (!S.may()) return false;
    if (file.size > MAX_DRAWIO_BYTES) { toast("That .drawio file is too large (max 10 MB)"); return false; }
    try {
      const text = await file.text();
      if (!isDrawio(text)) { toast("That isn't a valid .drawio file"); return false; }
      const parsed = parseDrawio(text, { now: clock.now() });
      if (!parsed.ok) { toast(parsed.error || "That isn't a valid .drawio file"); return false; }
      if (!parsed.elements.length) { toast("No elements in that .drawio file"); return false; }
      if (!S.may()) return false;
      const stream = S.role === "presenter" ? S.active : "notes";
      let ids = [];
      S.act(stream, ed => {
        ids = ed.insertElements(parsed.elements, {}, at);
      });
      onDirty();
      if (ids.length) {
        const n = parsed.elements.filter(e => !isLabel(e)).length || ids.length;
        const from = file.name ? ` from ${file.name}` : "";
        toast(`Imported ${n} element${n === 1 ? "" : "s"}${from}`);
        return true;
      }
      return false;
    } catch {
      toast("That isn't a valid .drawio file");
      return false;
    }
  }

  /**
   * Read and merge a `.excalidrawlib` file into the persisted browser library.
   * @param {File} file
   */
  async function addLibraryFile(file) {
    try {
      const items = parseLibrary(await file.text());
      if (!items.length) return toast("No library items in that file");
      setLibrary(addToLibrary(getLibrary(), items));
      toast(`Library: ${items.length} added`);
    } catch {
      toast("That isn't an .excalidrawlib file");
    }
  }

  /**
   * Route dropped or picked files to the matching importer by extension or MIME type.
   * @param {Iterable<File>} files
   * @param {{ x: number, y: number }} [at]
   */
  function takeFiles(files, at) {
    for (const f of files) {
      if (/\.(drawio|xml)$/i.test(f.name)) addDrawioFile(f, at);
      else if (/\.(excalidraw|json)$/i.test(f.name)) addExcalidrawFile(f, at);
      else if (/\.excalidrawlib$/i.test(f.name)) addLibraryFile(f);
      else if (f.type?.startsWith("video/")) addVideoFile(f, at);
      else addPicture(f, at);
    }
  }

  return {
    addPicture,
    probeVideoMeta,
    addVideoFile,
    prepareExcalidrawFiles,
    importExcalidrawParsed,
    pasteText,
    addExcalidrawFile,
    addDrawioFile,
    addLibraryFile,
    takeFiles,
  };
}
