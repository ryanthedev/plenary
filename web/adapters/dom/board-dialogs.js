// @ts-check
/**
 * @module web/adapters/dom/board-dialogs
 * Presenter board dialogs rendered inside `#dialogs`: Insert Mermaid flowchart, Embed URL,
 * and Export (SVG / PNG / PDF print / `.excalidraw`) along with live canvas previews and download.
 * Extracted from `app.js` with injected state/focus/clock/dialog-container dependencies.
 */

import { Editor } from "../../../packages/core/editor.js";
import { isMermaid } from "../../../packages/core/mermaid.js";
import { listNamedFrames } from "../../../packages/core/views.js";
import { parseEmbedUrl } from "../../../packages/core/embed.js";
import { paint, THEMES } from "./paint.js";
import { exportSvg, exportExcalidraw, paintPng, loadPictures, buildPrintHtml } from "./export.js";
import { h, replace } from "./dom.js";
import { icon } from "./icons.js";
import { trapFocus } from "./a11y.js";
import { captureFocus } from "./focus.js";

/**
 * Create the `#dialogs` controller for `"mermaid"`, `"embed"`, and `"export"`.
 * @param {{
 *   S: any,
 *   ui: any,
 *   board: string,
 *   canvas: HTMLElement,
 *   image: ReturnType<typeof import("./paint.js").imageCache>,
 *   clock: import("../../ports/clock.js").Clock,
 *   toast: (text: string, ms?: number) => void,
 *   displayBoardTitle: () => string,
 *   getDialogsContainer: () => HTMLElement,
 *   getChromeRoots: () => HTMLElement[],
 *   isShareOpen: () => boolean,
 *   getOpener: () => any,
 *   clearOpener: () => void,
 *   restoreOpener: (saved: any, fallback?: any) => void,
 *   setPendingFocus: (held: any) => void,
 *   onDirty: () => void,
 *   doc?: Document | null,
 * }} deps
 */
export function createBoardDialogs({
  S,
  ui,
  board,
  canvas,
  image,
  clock,
  toast,
  displayBoardTitle,
  getDialogsContainer,
  getChromeRoots,
  isShareOpen,
  getOpener,
  clearOpener,
  restoreOpener,
  setPendingFocus,
  onDirty,
  doc = null,
}) {
  const docRef = () => doc ?? globalThis.document;
  let dialogTrap = null;
  let dialogRebuilding = false;

  /**
   * Render a small Mermaid preview into `cv` using an isolated scratch `Editor`.
   * @param {HTMLCanvasElement} cv
   * @returns {boolean}
   */
  function mermaidPreview(cv) {
    const x = cv.getContext("2d"), theme = THEMES[ui.theme], scratch = new Editor();
    scratch.setSize(cv.width, cv.height);
    try {
      if (!isMermaid(ui.mermaid.src)) throw new Error("Not a Mermaid flowchart (start with flowchart or graph)");
      scratch.importMermaid(ui.mermaid.src, undefined, { elbow: ui.mermaid.elbow });
      scratch.fit(undefined, 12, { animate: false });
      scratch.select([]);
    } catch (e) {
      paint(x, [], { width: cv.width, height: cv.height, background: theme.bg });
      x.fillStyle = theme.dim;
      x.font = "12px system-ui";
      x.fillText(String(e.message ?? e).slice(0, 60), 10, 20);
      return false;
    }
    paint(x, scratch.displayList(theme), { width: cv.width, height: cv.height, background: theme.bg });
    return true;
  }

  /**
   * Paint a 1× preview of the current export selection (board or frame) into `cv`.
   * @param {HTMLCanvasElement} cv
   * @returns {number}
   */
  function exportPreview(cv) {
    const { page, scale, frameId } = ui.export;
    const frames = listNamedFrames(S.eds.board.doc);
    const activeFrameId = frameId && frames.some(f => f.id === frameId) ? frameId : undefined;
    const tmp = docRef().createElement("canvas");
    paintPng(S.eds.board.doc, tmp, { page, theme: ui.theme, scale: 1, loadImage: image, ...(activeFrameId ? { frameId: activeFrameId } : {}) });
    cv.width = tmp.width;
    cv.height = tmp.height;
    cv.getContext("2d").drawImage(tmp, 0, 0);
    return scale;
  }

  /**
   * Download the board (or selected frame) in the chosen export format (`svg`, `png`, `pdf`, `excalidraw`).
   * @returns {Promise<void>}
   */
  async function download() {
    const { format, scale, page, frameId: rawFrameId } = ui.export, docModel = S.eds.board.doc;
    const frames = listNamedFrames(docModel);
    const activeFrame = rawFrameId ? (frames.find(f => f.id === rawFrameId) ?? null) : null;
    const frameId = activeFrame?.id;
    const d = docRef();
    if (format === "pdf") {
      const title = activeFrame ? `${displayBoardTitle()} — ${activeFrame.name}` : displayBoardTitle();
      const html = buildPrintHtml(docModel, { theme: ui.theme, page, frameIds: frameId ? [frameId] : null, title });
      // Read `open` dynamically at invocation time so test stubs and popups work without init-time capture.
      const opener = globalThis.window?.open ?? globalThis.open;
      const win = typeof opener === "function" ? opener.call(globalThis.window ?? globalThis, "", "_blank") : null;
      if (win && win.document && typeof win.document.write === "function") {
        try { win.opener = null; } catch {}
        win.document.open?.();
        win.document.write(html);
        win.document.close?.();
        win.focus?.();
        if (typeof win.print === "function") clock.set(() => { try { win.print(); } catch {} }, 150);
      } else {
        const blob = new Blob([html], { type: "text/html;charset=utf-8" });
        const a = h("a", { href: URL.createObjectURL(blob), download: `${board}${frameId ? `-${frameId}` : ""}-print.html` });
        d.body.append(a); a.click(); a.remove();
        clock.set(() => URL.revokeObjectURL(a.href), 5000);
        toast("Popup blocked — downloaded printable HTML");
      }
      return;
    }
    const name = `${board}${frameId && format !== "excalidraw" ? `-${frameId}` : ""}.${format}`;
    let blob;
    if (format === "excalidraw") blob = new Blob([exportExcalidraw(docModel, { page, theme: ui.theme })], { type: "application/vnd.excalidraw+json" });
    else if (format === "svg") blob = new Blob([exportSvg(docModel, { page, theme: ui.theme, scale, ...(frameId ? { frameId } : {}) })], { type: "image/svg+xml" });
    else {
      const cv = paintPng(docModel, d.createElement("canvas"), { page, theme: ui.theme, scale, loadImage: await loadPictures(docModel.files), ...(frameId ? { frameId } : {}) });
      blob = await new Promise(r => cv.toBlob(r, "image/png"));
    }
    const a = h("a", { href: URL.createObjectURL(blob), download: name });
    d.body.append(a); a.click(); a.remove();
    clock.set(() => URL.revokeObjectURL(a.href), 5000);
  }

  // Why: A dialog control that changes what the dialog shows (e.g. a format chip) clears `d.replaceChildren()`
  // so `render()` bypasses its `d.firstChild` typing guard while restoring chip focus via `pendingFocus`.
  function rebuildDialog(d) {
    setPendingFocus(captureFocus(getChromeRoots()));
    dialogRebuilding = true;
    d.replaceChildren();
    onDirty();
  }

  function releaseTrap() {
    dialogTrap?.deactivate({ restoreFocus: false });
    dialogTrap = null;
  }

  /**
   * Deactivate any active `#dialogs` focus trap and clear `#dialogs` synchronously, marking chrome dirty.
   * Why: external callers (e.g. `dismissOverlays()`) cannot wait for the next rAF `chrome()` pass
   * because `chrome()` short-circuits on a quiet board, leaving orphaned DOM wedging `hasOpenDialog()`.
   */
  function deactivate() {
    const hadTrap = Boolean(dialogTrap);
    releaseTrap();
    const d = getDialogsContainer();
    const hadDom = Boolean(d?.childNodes?.length);
    if (d && hadDom) {
      const docEl = docRef();
      const active = /** @type {any} */ (docEl?.activeElement);
      if (active && d.contains?.(active)) {
        active.blur?.();
      }
      d.replaceChildren();
    }
    if (hadTrap || hadDom) onDirty();
  }

  /** Reconcile `#dialogs` DOM and focus trap with `ui.dialog`. */
  function render() {
    if (isShareOpen()) return;
    const d = getDialogsContainer(), may = S.may();
    if (docRef()?.activeElement?.closest?.("#dialogs") && d.firstChild) return; // don't rebuild under the cursor
    const close = () => {
      ui.dialog = null;
      const opener = getOpener();
      clearOpener();
      deactivate();
      onDirty();
      restoreOpener(opener, canvas);
    };
    const chip = (t, on, onclick) => h("button.c" + (on ? ".on" : ""), { "aria-pressed": String(Boolean(on)), onclick }, t);
    const rebuilding = dialogRebuilding;
    dialogRebuilding = false;
    if (ui.dialog === "mermaid" && S.role === "presenter") {
      releaseTrap();
      const cv = h("canvas", { width: 300, height: 180 });
      const ta = h("textarea.code", { spellcheck: false, "aria-label": "Mermaid flowchart source", value: ui.mermaid.src, oninput: e => { ui.mermaid.src = e.target.value; mermaidPreview(cv); }, onkeydown: e => { if (e.key === "Escape") { e.preventDefault?.(); close(); return; } e.stopPropagation(); } });
      const dlg = h("div.dialog", { role: "dialog", "aria-modal": "true", "aria-labelledby": "mermaid-dialog-title", "aria-label": "Insert a Mermaid flowchart", tabindex: "-1" },
        h("h2", { id: "mermaid-dialog-title" }, icon("mermaid", { size: 17 }), " Insert a Mermaid flowchart", h("span.spacer"), h("button.tb", { onclick: close, title: "Close", "aria-label": "Close" }, icon("close", { size: 16 }))),
        h("div.dbody", {}, h("div.cols", {}, ta, h("div.preview", {}, cv)),
          h("div.row", {}, h("span.lab", {}, "Arrows"), h("span.opts", {}, chip("straight", !ui.mermaid.elbow, () => { ui.mermaid.elbow = false; ui.dialog = "mermaid"; rebuildDialog(d); }), chip("elbow", ui.mermaid.elbow, () => { ui.mermaid.elbow = true; rebuildDialog(d); }))),
          h("div.hint", {}, "Flowcharts only (graph / flowchart, TD TB BT LR RL, subgraphs become frames). Pasting Mermaid text on the board does the same.")),
        h("footer", {}, h("button.btn", { onclick: close }, "Cancel"), h("button.btn.primary", { disabled: !may, onclick: () => {
          let err = null;
          S.act("board", e => { try { e.importMermaid(ui.mermaid.src, undefined, { elbow: ui.mermaid.elbow }); } catch (x) { err = x; } });
          if (err) toast(String(err.message ?? err)); else close();
        } }, "Insert as shapes")));
      replace(d, h("div.dialog-veil", { onclick: e => { if (e.target === e.currentTarget) close(); }, onkeydown: e => dialogTrap?.handleKeyDown(e) }, dlg));
      dialogTrap = trapFocus(dlg, { onEscape: close, returnFocusTo: getOpener()?.el ?? canvas, focusOnActivate: !rebuilding });
      mermaidPreview(cv);
    } else if (ui.dialog === "embed" && S.role === "presenter") {
      releaseTrap();
      const errEl = h("div.hint", { role: "alert", hidden: !ui.embed.error, style: { color: "var(--danger, #e03131)" } }, ui.embed.error);
      const setErr = msg => { ui.embed.error = msg; errEl.textContent = msg; errEl.hidden = !msg; };
      const submitEmbed = () => {
        if (!S.may()) return;
        const parsed = parseEmbedUrl(ui.embed.url);
        if (!parsed) {
          setErr("Enter a valid YouTube, video (.mp4/.webm/.mov), or image (.png/.jpg/.webp/.gif) HTTPS URL.");
          urlInput.focus?.();
          return;
        }
        const ok = S.act("board", e => e.addEmbed(parsed));
        if (!ok) return;
        ui.embed.url = "";
        ui.embed.error = "";
        close();
      };
      const urlInput = h("input.field", {
        type: "url",
        "aria-label": "Embed URL",
        placeholder: "https://youtube.com/watch?v=… or direct .mp4 / .png URL",
        value: ui.embed.url,
        style: { width: "100%" },
        oninput: e => { ui.embed.url = e.target.value; if (ui.embed.error) setErr(""); },
        onkeydown: e => {
          if (e.key === "Escape") { e.preventDefault?.(); close(); return; }
          if (e.key === "Enter") { e.preventDefault?.(); submitEmbed(); return; }
          e.stopPropagation();
        },
      });
      const pasteBtn = h("button.btn", {
        type: "button",
        "data-action": "embed-paste",
        "aria-label": "Paste URL from clipboard",
        onclick: async () => {
          const clip = globalThis.navigator?.clipboard;
          if (typeof clip?.readText !== "function") {
            setErr("Clipboard unavailable — paste directly into the URL field.");
            urlInput.focus?.();
            return;
          }
          try {
            const text = (await clip.readText())?.trim() ?? "";
            if (!text) {
              setErr("Clipboard is empty.");
              urlInput.focus?.();
              return;
            }
            ui.embed.url = text;
            urlInput.value = text;
            setErr("");
            urlInput.focus?.();
          } catch {
            setErr("Clipboard access was denied — paste directly into the URL field.");
            urlInput.focus?.();
          }
        },
      }, icon("paste", { size: 15 }), " Paste from clipboard");
      const dlg = h("div.dialog", { style: { width: "min(480px,100%)" }, role: "dialog", "aria-modal": "true", "aria-labelledby": "embed-dialog-title", "aria-label": "Embed URL", tabindex: "-1" },
        h("h2", { id: "embed-dialog-title" }, icon("play", { size: 17 }), " Embed URL", h("span.spacer"), h("button.tb", { onclick: close, title: "Close", "aria-label": "Close" }, icon("close", { size: 16 }))),
        h("div.dbody", {},
          h("div.row", { style: { flexDirection: "column", alignItems: "stretch", gap: "8px" } },
            urlInput,
            h("div", { style: { display: "flex", gap: "8px" } }, pasteBtn)),
          errEl,
          h("div.hint", {}, "Supports YouTube links, direct video (.mp4, .webm, .mov), and image (.png, .jpg, .webp, .gif) HTTPS URLs. Click Play on the card to activate.")),
        h("footer", {},
          h("button.btn", { onclick: close }, "Cancel"),
          h("button.btn.primary", { disabled: !may, "data-action": "embed-submit", onclick: submitEmbed }, "Embed")));
      replace(d, h("div.dialog-veil", { onclick: e => { if (e.target === e.currentTarget) close(); }, onkeydown: e => dialogTrap?.handleKeyDown(e) }, dlg));
      dialogTrap = trapFocus(dlg, { onEscape: close, returnFocusTo: getOpener()?.el ?? canvas, initialFocus: urlInput, focusOnActivate: !rebuilding });
    } else if (ui.dialog === "export" && S.role === "presenter") {
      releaseTrap();
      const cv = h("canvas"), x = ui.export, set = (k, v) => { x[k] = v; rebuildDialog(d); };
      const frames = listNamedFrames(S.eds.board.doc);
      if (x.frameId && !frames.some(f => f.id === x.frameId)) x.frameId = null;
      const scopeSelect = frames.length && x.format !== "excalidraw"
        ? h("select.field", {
          "aria-label": "Export scope",
          value: x.frameId ?? "",
          onchange: e => set("frameId", e.target.value || null),
        },
        h("option", { value: "", selected: !x.frameId }, x.format === "pdf" ? `Whole board (${frames.length} frames)` : "Whole board"),
        frames.map(f => h("option", { value: f.id, selected: x.frameId === f.id }, f.name)))
        : null;
      const dlg = h("div.dialog", { style: { width: "min(520px,100%)" }, role: "dialog", "aria-modal": "true", "aria-labelledby": "export-dialog-title", "aria-label": "Export the board", tabindex: "-1" },
        h("h2", { id: "export-dialog-title" }, icon("export", { size: 17 }), " Export the board", h("span.spacer"), h("button.tb", { onclick: close, title: "Close", "aria-label": "Close" }, icon("close", { size: 16 }))),
        h("div.dbody", {}, h("div.preview", { style: { minHeight: "120px" } }, cv),
          h("div.row", {}, h("span.lab", {}, "Format"), h("span.opts", {},
            chip("SVG", x.format === "svg", () => set("format", "svg")),
            chip("PNG", x.format === "png", () => set("format", "png")),
            chip("PDF / Print", x.format === "pdf", () => set("format", "pdf")),
            chip(".excalidraw", x.format === "excalidraw", () => set("format", "excalidraw")))),
          scopeSelect ? h("div.row", {}, h("span.lab", {}, "Scope"), scopeSelect) : null,
          (x.format === "svg" || x.format === "png") ? h("div.row", {}, h("span.lab", {}, "Scale"), h("span.opts", {}, chip("1×", x.scale === 1, () => set("scale", 1)), chip("2×", x.scale === 2, () => set("scale", 2)))) : null,
          h("div.row", {}, h("span.lab", {}, "Page"), h("span.opts", {}, chip("board color", x.page === "board", () => set("page", "board")), chip("white", x.page === "white", () => set("page", "white")))),
          h("div.hint", {}, x.format === "excalidraw"
            ? "Excalidraw v2 JSON with embedded images. Opens directly in excalidraw.com or Plenary."
            : x.format === "pdf"
              ? "Opens a print-ready landscape document (one page per frame) for Print or Save as PDF."
              : x.frameId
                ? "Cropped tightly to the selected frame. Notes, selection, cursors and comments never show."
                : "The board stream only, cropped to what's drawn, 32 units of padding. Notes, selection, cursors and comments never show.")),
        h("footer", {}, h("button.btn", { onclick: close }, "Cancel"), h("button.btn.primary", { onclick: () => { download(); close(); } }, x.format === "pdf" ? "Print / Save PDF" : "Download")));
      replace(d, h("div.dialog-veil", { onclick: e => { if (e.target === e.currentTarget) close(); }, onkeydown: e => dialogTrap?.handleKeyDown(e) }, dlg));
      dialogTrap = trapFocus(dlg, { onEscape: close, returnFocusTo: getOpener()?.el ?? canvas, focusOnActivate: !rebuilding });
      exportPreview(cv);
    } else {
      releaseTrap();
      ui.dialog = null;
      d.replaceChildren();
    }
  }

  return {
    render,
    deactivate,
    mermaidPreview,
    exportPreview,
    download,
  };
}
