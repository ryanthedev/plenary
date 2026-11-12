// The canvas page's chrome: a driving adapter over the DOM (it calls into the core; it implements no port). Draws the verified
// mock (docs/m2/design), paints through ./paint.js, feeds input to the core session (web/core/session.js), and
// keeps UI preferences in the storage port it is given. Every write goes through session.act/setTool/key; nothing
// here touches the protocol, a transport or sign-in (web/main.js, the composition root, wires those).

import { Editor } from "../../../packages/core/editor.js";
import { parsePanel, serializePanel, applyPanel, panelLayout, dragWidth } from "../../../packages/core/panel.js";
import { isMermaid } from "../../../packages/core/mermaid.js";
import { isLabel } from "../../../packages/core/model.js";
import { parseLibrary } from "../../../packages/core/library.js";
import { paint, imageCache, THEMES, color as safeColor } from "./paint.js";
import { toolsFor, pillFor } from "../../core/roles.js";
import { renderPanel, loadLibrary, saveLibrary, addToLibrary } from "./panel.js";
import { exportSvg, paintPng, loadPictures } from "./export.js";
import { h, $, replace } from "./dom.js";
import { mountCollab } from "./collab/ui.js";
import { hitTest } from "../../../packages/core/geometry.js";

/**
 * Mount the page on index.html's DOM.
 * @param {{ startSession: (o: { mine: string[], onChange: () => void }) => ReturnType<typeof import("../../core/session.js").createSession>,
 *           net: import("../../ports/net.js").Net, board: string, me: { user: string, name: string, role: string | null },
 *           prefs: import("../../ports/storage.js").Storage, theme?: string | null, notice?: string | null,
 *           collab?: (S: object, o: { jumpTo(p: { x: number, y: number }): void }) => object }} o
 *   collab: the root's collab port factory (web/ports/collab.js; production and dev: web/adapters/collab/sync.js over
 *   the session). The collaboration UI (./collab/ui.js) mounts over it: avatars, emotes, cursors, selections, laser,
 *   previews, comment threads. Without it the page has none of that.
 *   startSession: the root's createSession with everything but the page's own bits. prefs: the per-browser store
 *   (local storage; a failing store reads as empty). notice: shown once (sign-in, share link).
 * @returns {{ S: object, ui: object, net: object, setTheme(t: string): void, openDialog(d: string): void, setPanel(op: object): void }}
 */
export function mountApp({ startSession, net, board, me, prefs, theme: theme0 = null, notice = null, collab: collabPort = null }) {
  const get = k => { try { return prefs.get(k); } catch { return null; } };
  const put = (k, v) => { try { prefs.set(k, v); } catch {} };
  const ui = {
    theme: theme0 === "dark" || (theme0 !== "light" && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light",
    panel: parsePanel(get("plenary.panel")), drawer: null, sheet: null, dialog: null, library: loadLibrary(prefs),
    mermaid: { src: "flowchart LR\n  A[Idea] --> B[Spec]\n  B --> C{Review?}\n  C -->|yes| D[Build]\n  C -->|no| B\n  D --> E[Ship]", elbow: true },
    export: { format: "svg", scale: 2, page: "board" },
  };
  const mineKey = `plenary.mine.${board}.${me.user}`;
  let chromeDirty = true;
  const S = startSession({
    mine: (() => { try { const v = JSON.parse(get(mineKey) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } })(),
    onChange: () => { chromeDirty = true; },
  });
  if (!ui.drawer && me.role === "annotator") ui.drawer = "notes";
  net.onFile(file => { S.receiveFiles({ [file.id]: file }); });

  const isPhone = () => matchMedia("(max-width: 640px)").matches;
  const canvas = $("#board"), ink = $("#ink"), ctx = canvas.getContext("2d");
  const allFiles = () => ({ ...S.eds.notes.doc.files, ...S.eds.board.doc.files });

  // ── collaboration (p7-wire): the collab UI over the root's port, presence painted on its own canvas ──
  const overlay = h("canvas.collab-overlay", { "aria-hidden": "true" });
  canvas.after(overlay);
  const jumpTo = p => {
    const B = S.eds.board, { w, h: hh } = B.size, sc = B.view.scale;
    B.view = { ...B.view, x: w / 2 / sc - p.x, y: hh / 2 / sc - p.y }; B.changed(); S.syncView("board"); chromeDirty = true;
  };
  const port = collabPort ? collabPort(S, { jumpTo }) : null;
  const collab = port ? mountCollab({ root: $("#canvas"), canvasOverlay: overlay, port, theme: ui.theme,
    view: { toScreen: p => S.eds.board.toScreen(p), toWorld: p => S.eds.board.toWorld(p), get scale() { return S.eds.board.view.scale; } } }) : null;
  if (collab) collab.showDrawer("comments");
  const worldAt = p => S.eds.board.toWorld(p);
  // What I have selected goes out as presence (latest wins; the outbox paces it).
  let selKey = "";
  function sendSelection() {
    if (!collab) return;
    const stream = S.active, ids = [...S.eds[stream].sel], key = `${stream}|${ids.join(",")}`;
    if (key !== selKey && collab.selection(stream, ids)) selKey = key;
  }
  // Right-click (or the 💬 button): a comment on the element under the pointer, else on that spot.
  function startComment(p) {
    if (!collab) return;
    const w = worldAt(p), n = S.eds.notes, b = S.eds.board;
    const hitN = hitTest(n.doc, w, n.tol()), hitB = hitN ? null : hitTest(b.doc, w, b.tol());
    const el = hitN ?? hitB, on = el ? { stream: hitN ? "notes" : "board", element: isLabel(el) && el.containerId ? el.containerId : el.id } : null;
    collab.startComment(w, on);
  }
  canvas.addEventListener("contextmenu", e => { if (!collab) return; e.preventDefault(); startComment(at(e)); });
  const image = imageCache(allFiles, () => { dirty = true; });
  let dirty = true, seen = -1;

  // ── painting ──
  function draw() {
    const theme = THEMES[ui.theme];
    const items = S.displayList(theme);
    // A picture whose bytes haven't arrived (or never will: v0 sends no files) shows as a dashed box.
    const files = allFiles();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.t === "image" && !files[it.fileId]) {
        const { x, y, w, h: hh } = it;
        items.splice(i, 1, { t: "path", cmds: [["M", x, y], ["L", x + w, y], ["L", x + w, y + hh], ["L", x, y + hh], ["L", x, y]], stroke: theme.dim, width: 1, dash: [5, 4] },
          { t: "text", x: x + 8, y: y + 6, text: "picture (bytes not here yet)", size: 11, color: theme.dim, align: "left", lineHeight: 1.2 });
        i++;
      }
    }
    const { w, h: hh } = S.eds.board.size;
    paint(ctx, items, { width: w, height: hh, dpr: canvas.width / Math.max(1, w), background: theme.bg, image });
    canvas.style.cursor = S.may() || S.tool === "hand" ? S.ed.cursor() ?? "default" : "grab";
    syncText();
  }

  function syncText() {
    const ed = S.textEditor(), box = ed?.textBox();
    if (!box) { if (ink.style.display !== "none") { ink.style.display = "none"; ink.value = ""; } return; }
    Object.assign(ink.style, { display: "block", left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px`, fontSize: `${box.size}px`, textAlign: box.align });
    if (ink.value !== ed.text.value) ink.value = ed.text.value;
    if (document.activeElement !== ink) { ink.focus(); ink.setSelectionRange(ink.value.length, ink.value.length); }
  }
  ink.addEventListener("input", () => S.textEditor()?.setText(ink.value));
  ink.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) { e.preventDefault(); S.textEditor()?.commitText(); canvas.focus(); }
  });
  ink.addEventListener("blur", () => { const ed = S.textEditor(); if (ed?.text) ed.commitText(); });

  new ResizeObserver(() => {
    const r = $("#canvas").getBoundingClientRect(), dpr = devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    S.setSize(r.width, r.height); dirty = true; chromeDirty = true;
  }).observe($("#canvas"));

  // ── input ──
  const KEYS = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", Backspace: "backspace", Delete: "delete", Escape: "escape", Enter: "enter", " ": "space", PageUp: "pageup", PageDown: "pagedown", Tab: "tab" };
  const keyName = e => KEYS[e.key] ?? (/^Digit\d$/.test(e.code) ? e.code.slice(5) : e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase());
  const mods = e => ({ shift: e.shiftKey, alt: e.altKey, cmd: e.metaKey, ctrl: e.ctrlKey });
  const BUTTONS = ["left", "middle", "right"];
  const at = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  let last = { t: 0, x: 0, y: 0, n: 0 }, clicks = 1, space = false;
  const countClick = e => { const p = at(e), now = performance.now(); const n = now - last.t < 400 && Math.hypot(p.x - last.x, p.y - last.y) < 6 ? last.n + 1 : 1; last = { t: now, ...p, n }; return n; };
  const pmods = e => ({ ...mods(e), button: BUTTONS[e.button] ?? "left", clickCount: clicks, space });

  // Touch: one finger draws (or pans with the Hand); two fingers pinch-zoom and pan.
  const touches = new Map();
  let pinch = null;
  canvas.addEventListener("pointerdown", e => {
    canvas.focus(); canvas.setPointerCapture(e.pointerId); e.preventDefault();
    touches.set(e.pointerId, at(e));
    if (touches.size === 2) {
      if (S.gesture) S.pointerUp(at(e), {});
      const [a, b] = [...touches.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), scale: S.eds.board.view.scale, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      return;
    }
    if (touches.size > 2 || pinch) return;
    if (ui.sheet) { ui.sheet = null; chromeDirty = true; }
    clicks = Math.max(e.detail || 0, countClick(e));
    if (S.tool === "image") { openPicker(); return; }
    S.pointerDown(at(e), pmods(e));
    if (collab && S.tool === "laser" && e.button === 0) collab.laser(worldAt(at(e)));
  });
  canvas.addEventListener("pointermove", e => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, at(e));
    if (pinch && touches.size === 2) {
      const [a, b] = [...touches.values()], d = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      S.wheel({ x: pinch.mid.x - mid.x, y: pinch.mid.y - mid.y }, mid, {}); pinch.mid = mid;
      S.zoomAt(Math.max(0.1, Math.min(8, pinch.scale * d / Math.max(1, pinch.d))), mid);
      return;
    }
    if (!pinch) S.pointerMove(at(e), pmods(e));
    if (collab && !pinch) {
      const w = worldAt(at(e));
      collab.pointer(w);
      if (S.tool === "laser" && S.gesture && (e.buttons & 1)) collab.laser(w);
    }
  });
  const up = e => {
    touches.delete(e.pointerId);
    if (pinch) { if (touches.size === 0) pinch = null; return; }
    S.pointerUp(at(e), pmods(e)); chromeDirty = true;
    sendSelection();
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) { const s = S.eds.board.view.scale * Math.exp(-e.deltaY * 0.01); S.zoomAt(Math.max(0.1, Math.min(8, s)), at(e)); }
    else S.wheel({ x: e.deltaX, y: e.deltaY }, at(e), mods(e));
    chromeDirty = true;
  }, { passive: false });
  canvas.addEventListener("dblclick", e => e.preventDefault());

  document.addEventListener("keydown", e => {
    const t = e.target;
    if (t !== canvas && t !== document.body && t !== document.documentElement) return;   // inputs, dialogs keep their keys
    if (e.key === " ") space = true;
    const k = keyName(e), m = mods(e);
    if ((m.cmd || m.ctrl) && m.shift && k === "e") { e.preventDefault(); if (S.role === "presenter") openDialog("export"); return; }
    if (!m.cmd && !m.ctrl && !m.alt && k === "i" && S.role === "presenter") { setPanel({ type: "open" }); return; }
    if (S.key(k, m)) { e.preventDefault(); chromeDirty = true; }
  });
  document.addEventListener("keyup", e => { if (e.key === " ") space = false; });

  // Clipboard: the browser's own events (so paste runs once), images included.
  const onCanvas = () => [canvas, document.body, document.documentElement].includes(document.activeElement);
  document.addEventListener("copy", e => { if (!onCanvas()) return; const t = S.copy(); if (t) { e.clipboardData.setData("text/plain", t); e.preventDefault(); } });
  document.addEventListener("cut", e => { if (!onCanvas() || !S.may()) return; const t = S.cut(); if (t) { e.clipboardData.setData("text/plain", t); e.preventDefault(); } });
  document.addEventListener("paste", e => {
    if (!onCanvas()) return;
    e.preventDefault();
    if (!S.may()) return toast("View only: nothing is pasted");
    const files = [...(e.clipboardData?.files ?? [])].filter(f => f.type.startsWith("image/"));
    if (files.length) return files.forEach(f => addPicture(f));
    const text = e.clipboardData?.getData("text/plain");
    if (text) { S.paste(text); chromeDirty = true; }
  });

  // Pictures and libraries: drop, paste, the Image tool's picker.
  const RASTER = /^image\/(png|jpeg|gif|webp)$/;
  async function addPicture(file, at) {
    if (!S.may()) return;
    if (!RASTER.test(file.type)) return toast("Pictures: PNG, JPEG, GIF or WebP");
    if (file.size > 10 * 1024 * 1024) return toast("Pictures are limited to 10 MB");
    const buf = await file.arrayBuffer();
    const id = [...new Uint8Array(await crypto.subtle.digest("SHA-1", buf))].map(b => b.toString(16).padStart(2, "0")).join("");
    const dataURL = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
    const img = await new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = dataURL; });
    if (!img) return toast("That picture couldn't be read");
    const f = { id, mimeType: file.type, dataURL, width: img.naturalWidth, height: img.naturalHeight };
    if (S.addPicture(f, at)) net.put(f);          // SEAM(v1 Blobs): signed upload; today the tab relay
    chromeDirty = true;
  }
  async function addLibraryFile(file) {
    try { const items = parseLibrary(await file.text()); if (!items.length) return toast("No library items in that file"); setLibrary(addToLibrary(ui.library, items)); toast(`Library: ${items.length} added`); }
    catch { toast("That isn't an .excalidrawlib file"); }
  }
  function takeFiles(files, at) {
    for (const f of files) { if (/\.excalidrawlib$/i.test(f.name)) addLibraryFile(f); else addPicture(f, at); }
  }
  const picker = $("#picker");
  function openPicker() { if (S.may()) picker.click(); }
  picker.addEventListener("change", () => { takeFiles([...picker.files]); picker.value = ""; if (S.tool === "image") S.setTool("select"); });
  $("#canvas").addEventListener("dragover", e => { e.preventDefault(); });
  $("#canvas").addEventListener("drop", e => {
    e.preventDefault();
    if (!S.may()) return toast("View only: nothing is added");
    takeFiles([...(e.dataTransfer?.files ?? [])], S.eds.board.toWorld(at(e)));
  });

  // ── chrome ──
  let toastTimer = 0;
  function toast(text, ms = 1800) {
    const el = $("#toast"); el.textContent = text; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }
  const setPanel = op => { const n = applyPanel(ui.panel, op); if (n !== ui.panel) { ui.panel = n; put("plenary.panel", serializePanel(n)); } chromeDirty = true; };
  function setLibrary(items) { ui.library = items; saveLibrary(prefs, items); chromeDirty = true; }
  const setTheme = t => { ui.theme = t; document.documentElement.dataset.theme = t; dirty = true; chromeDirty = true; collab?.setTheme(t); };
  function openDialog(d) { ui.dialog = d; ui.sheet = null; chromeDirty = true; }
  const keyLabel = t => (t.keys?.length ? t.keys.map(k => k.toUpperCase()).join(" ") : "");

  function toolButton(t, extra = "") {
    const disabled = t.id !== "hand" && !S.may();
    return h(`button.tb${S.tool === t.id ? ".on" : ""}${extra}`, { title: `${t.name}${keyLabel(t) ? " — " + keyLabel(t) : ""}`, disabled, "data-tool": t.id,
      onclick: () => { if (t.id === "image") { S.setTool("image"); openPicker(); } else S.setTool(t.id); canvas.focus(); chromeDirty = true; } },
    h("span.ic", {}, t.icon), t.keys?.[0] ? h("span.k", {}, t.keys[0].toUpperCase()) : null);
  }

  function topbar() {
    const role = S.role, tools = toolsFor(role), may = S.may();
    const core = tools.filter(t => !["image", "note", "highlighter"].includes(t.id)), extras = tools.filter(t => ["image", "note", "highlighter"].includes(t.id));
    const pill = pillFor({ status: S.status, online: S.online, pending: S.pending, role: S.effective, readOnly: S.readOnly, congested: S.congested });
    const notesCount = S.eds.notes.doc.live().filter(e => !isLabel(e)).length;
    return [
      h("div.tools.desk-only", {}, core.map(t => toolButton(t)), extras.length ? h("span.sep") : null, extras.map(t => toolButton(t, ".new")),
        role !== "viewer" ? [h("span.sep"),
          h("button.tb" + (S.toolLock() ? ".on" : ""), { title: "Keep the tool after drawing (Q)", disabled: !may, onclick: () => { S.toggleLock(); chromeDirty = true; } }, h("span.ic", {}, S.toolLock() ? "🔒" : "🔓"), h("span.k", {}, "Q")),
          h("button.tb", { title: "Undo (⌘Z)", disabled: !may, onclick: () => { S.act(S.active, e => e.undo()); } }, h("span.ic", {}, "↶")),
          h("button.tb", { title: "Redo (⌘⇧Z)", disabled: !may, onclick: () => { S.act(S.active, e => e.redo()); } }, h("span.ic", {}, "↷"))] : null),
      h("span.board-name", {}, board, net.kind === "ws" ? null : [" ", h("small", {}, "· dev room")]),
      h("span.spacer"),
      role === "presenter" ? [
        h("button.btn.ghost.desk-only", { title: "Insert a Mermaid flowchart", disabled: !may, onclick: () => openDialog("mermaid") }, "◇→"),
        h("button.btn.ghost.desk-only", { title: "Export SVG / PNG (⌘⇧E)", onclick: () => openDialog("export") }, "⤓")] : null,
      h("button.btn.ghost.desk-only", { title: "Notes", onclick: () => { ui.drawer = ui.drawer ? null : "notes"; chromeDirty = true; } }, "❏ Notes ", h("span.dim", {}, String(notesCount))),
      collab ? h("button.btn.ghost.desk-only", { title: "Comments (or right-click the board)", onclick: () => { ui.drawer = ui.drawer === "comments" ? null : "comments"; chromeDirty = true; } }, "💬") : null,
      // Who's here (`here`): the collab UI's live avatar row, kept across rebuilds (a node, moved, never rebuilt here).
      collab ? collab.parts.avatars : h("div.avatars", {},
        h("span.stack", {}, h("span.av.live", { style: { background: "var(--u-me)" }, title: `${me.name} (you)` }, me.name.slice(0, 2).toUpperCase()))),
      h(`span.pill.${pill.cls}`, { title: pillTitle(pill.cls) }, h("span.dot"), pill.text, pill.sub ? h("span.sub", {}, ` · ${pill.sub}`) : null),
      role !== "viewer" ? h("button.tb.desk-only" + (ui.panel.open ? ".on" : ""), { title: "Side panel (I)", onclick: () => setPanel({ type: "open" }) }, h("span.ic", {}, "◧"), h("span.k", {}, "I")) : null,
      h("button.tb" + (role === "viewer" ? "" : ".theme-btn"), { title: "Light / dark", onclick: () => setTheme(ui.theme === "dark" ? "light" : "dark") }, h("span.ic", {}, ui.theme === "dark" ? "☀" : "☾")),
    ];
  }
  function pillTitle(cls) {
    if (S.effective === "viewer" && cls !== "readonly") return "No live connection. The live view is paused until it's back.";
    return {
      connected: "Connected: every edit is acknowledged by the board's room.",
      reconnecting: "Connecting or catching up. Edits not yet acknowledged are kept and resent with the same ids.",
      offline: S.status === "limited" ? "This board is open in too many of your tabs. Close one, then press Retry." : "No connection. Unacknowledged edits stay in this tab and are resent on reconnect; closing the tab loses them.",
      readonly: S.readOnly ? "The server gave this session a lower role (welcome.role): nothing you do is sent." : "You're watching: viewers change nothing on the board.",
    }[cls];
  }

  function hud() {
    const B = S.eds.board, fs = B.frames(), i = fs.findIndex(f => f.id === B.frameAt), may = S.may();
    const bl = [
      h("div.grp" + (S.role === "viewer" ? ".desk-only" : ""), {}, h("button.tb", { title: "Previous frame (PgUp)", onclick: () => S.stepFrame(-1) }, "‹"), h("span.pct", {}, fs.length ? `${i < 0 ? "–" : i + 1} / ${fs.length}` : "0 / 0"), h("button.tb", { title: "Next frame (PgDn)", onclick: () => S.stepFrame(1) }, "›")),
      h("div.grp.desk-only", {}, h("button.tb", { title: "Zoom out (⌘-)", onclick: () => S.zoomAt(B.view.scale / 1.2) }, "−"), h("span.pct", {}, `${Math.round(B.view.scale * 100)}%`),
        h("button.tb", { title: "Zoom in (⌘=)", onclick: () => S.zoomAt(B.view.scale * 1.2) }, "+"), h("button.tb", { title: "Fit everything (⇧1)", onclick: () => S.fit() }, "⤢")),
      S.role !== "viewer" ? h("div.grp.phone-only", {}, h("button.tb", { title: "Fit everything", onclick: () => S.fit() }, "⤢")) : null,
      S.role !== "viewer" ? h("div.grp.phone-only", {}, h("button.tb", { disabled: !may, title: "Undo", onclick: () => S.act(S.active, e => e.undo()) }, "↶"), h("button.tb", { disabled: !may, title: "Redo", onclick: () => S.act(S.active, e => e.redo()) }, "↷")) : null,
    ];
    // The emote bar and the phones' one emote button: the collab UI's live nodes (moved in once, then kept).
    replace($("#hudBL"), bl);
    if (collab) {
      if (collab.parts.emotes.parentNode !== $("#hudBC")) replace($("#hudBC"), collab.parts.emotes);
      if (collab.parts.emoteButton.parentNode !== $("#hudBR")) replace($("#hudBR"), collab.parts.emoteButton);
    }
  }

  function timeline() {
    const el = $("#timeline"), B = S.eds.board;
    el.hidden = S.role !== "presenter";
    if (el.hidden) return;
    const dur = B.duration(), t = B.time() ?? 0, pct = Math.min(100, (t / dur) * 100);
    const marks = [...new Set(B.doc.live().map(e => e.customData?.anim?.start).filter(Number.isFinite))].map(s => h("div.mark", { style: { left: `${(s / dur) * 100}%` } }));
    const track = h("div.track", { title: "Click to scrub", onclick: e => { const r = e.currentTarget.getBoundingClientRect(); B.play = null; B.scrub = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur; B.changed(); chromeDirty = true; } },
      h("div.fill", { style: { width: `${pct}%` } }), marks, h("div.head", { style: { left: `${pct}%` } }));
    replace(el, h("button.c", { title: "Play / pause (⇧Space)", onclick: () => { B.playToggle(); chromeDirty = true; } }, B.play ? "❚❚" : "▶"),
      h("button.c", { title: "Back to editing (Esc)", onclick: () => { B.stopPlay(); chromeDirty = true; } }, "■"), track, h("span.t", {}, `${(t / 1000).toFixed(1)}s / ${(dur / 1000).toFixed(1)}s`));
  }

  // The notes stream as a list: text, author (you, or unknown until v1's noteAuthor), jump / edit / delete.
  function notesList() {
    const N = S.eds.notes, may = S.may();
    const notes = N.doc.live().filter(e => !isLabel(e)).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
    const label = e => (e.type === "text" ? e.text : N.doc.labelOf(e)?.text) || { freedraw: "Highlight / drawing", image: "Picture", arrow: "Arrow", line: "Line" }[e.type] || "Note";
    const rows = notes.slice(0, 200).map(e => {
      const mine = S.isMine(e.id), canChange = may && mine;
      const jump = () => { N.fit([e]); S.syncView("notes"); chromeDirty = true; };
      return h("div.note-row", {}, h("span.sw", { style: { background: safeColor(e.backgroundColor !== "transparent" ? e.backgroundColor : e.strokeColor), width: "10px", height: "10px" } }),
        h("div.txt", {}, h("div", {}, label(e)),
          h("div.meta", {}, h("span", { style: { fontWeight: 600 } }, S.mine.has(e.id) ? "You" : "—"), e.type === "freedraw" ? h("span", {}, "highlight") : null),
          h("div.acts", {}, h("button", { onclick: jump }, "jump to"),
            may && S.effective !== "viewer" ? (canChange ? [
              h("button", { onclick: () => { jump(); S.act("notes", n => { n.select([e.id]); n.beginText(e, { x: e.x, y: e.y }); }); } }, "edit"),
              h("button", { onclick: () => S.act("notes", n => n.deleteIds([e.id])) }, "delete")] : h("span.lock", {}, "🔒 someone else's")) : null)));
    });
    const compose = !may || S.effective === "viewer"
      ? h("div.hint.compose", {}, S.role === "viewer" ? "Viewers read notes; only annotators and presenters add them." : "Read-only: you can't add or change notes.")
      : h("div.compose", {}, h("textarea.field", { placeholder: "Write a note… it lands at the center of your view", rows: 2, onkeydown: e => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const v = e.currentTarget.value.trim(); if (!v) return; const b = S.eds.board; S.placeNote(b.toWorld({ x: b.size.w / 2, y: b.size.h / 2 }), v); e.currentTarget.value = ""; chromeDirty = true; }
      } }));
    return [h("div.notes-list", {}, rows.length ? rows : h("div.hint", { style: { padding: "6px 8px" } }, "No notes yet."), notes.length > 200 ? h("div.hint", {}, `${notes.length - 200} more`) : null), compose];
  }
  function drawerBody(which) {
    // Comment threads: the collab UI's drawer (its own Notes/Comments header is hidden here; ours switches).
    if (which === "comments") { if (!collab) return [h("div.notes-list", {}, h("div.hint", { style: { padding: "8px" } }, "No comments here."))]; collab.showDrawer("comments"); return [collab.parts.drawer]; }
    return notesList();
  }
  function drawerTabs(key) {
    const which = ui[key] || "notes";
    return h("span.seg", {}, h("button" + (which === "notes" ? ".on" : ""), { onclick: () => { ui[key] = "notes"; chromeDirty = true; } }, "Notes"),
      h("button" + (which === "comments" ? ".on" : ""), { onclick: () => { ui[key] = "comments"; chromeDirty = true; } }, "Comments"));
  }

  const T = id => toolsFor("presenter").find(t => t.id === id);
  function dock() {
    const may = S.may(), role = S.role;
    const btn = (ic, label, on, onclick, disabled = false) => h("button.tb" + (on ? ".on" : ""), { onclick, disabled }, h("span.ic", {}, ic), label);
    const sheet = id => () => { ui.sheet = ui.sheet === id ? null : id; chromeDirty = true; };
    const tool = id => btn(T(id).icon, T(id).name, S.tool === id, () => { if (id === "image") openPicker(); S.setTool(id); chromeDirty = true; }, !may);
    let items;
    if (role === "presenter") items = [...["select", "freedraw", "rectangle", "text"].map(tool), btn("⋯", "More", ui.sheet === "tools", sheet("tools")), btn("◧", "Style", ui.sheet === "panel", sheet("panel")), btn("❏", "Notes", ui.sheet === "notes", sheet("notes")), btn("💬", "Comments", ui.sheet === "comments", sheet("comments"))];
    else if (role === "annotator") items = [...["select", "note", "highlighter", "freedraw"].map(tool), btn("⋯", "More", ui.sheet === "tools", sheet("tools")), btn("◧", "Style", ui.sheet === "panel", sheet("panel")), btn("❏", "Notes", ui.sheet === "notes", sheet("notes"))];
    else items = [btn("‹", "Prev", false, () => S.stepFrame(-1)), btn("⤢", "Fit", false, () => S.fit()), btn("›", "Next", false, () => S.stepFrame(1)), btn("❏", "Notes", ui.sheet === "notes", sheet("notes")), btn("💬", "Comments", ui.sheet === "comments", sheet("comments"))];
    replace($("#dock"), items);
  }
  function sheetView() {
    const el = $("#sheet");
    if (!ui.sheet || !isPhone()) { el.hidden = true; el.replaceChildren(); return; }
    el.hidden = false;
    let body;
    if (ui.sheet === "tools") {
      // Every write here passes S.setTool / S.may: read-only greys and refuses it (p6-mockv round 2, MEDIUM).
      const may = S.may();
      body = h("div.tool-grid", {}, toolsFor(S.role).map(t => h("button.tb" + (S.tool === t.id ? ".on" : ""), { disabled: t.id !== "hand" && !may, onclick: () => { if (t.id === "image") openPicker(); S.setTool(t.id); ui.sheet = null; chromeDirty = true; } }, h("span.ic", {}, t.icon), t.name)),
        S.role === "presenter" ? [h("button.tb", { disabled: !may, onclick: () => openDialog("mermaid") }, h("span.ic", {}, "◇→"), "Mermaid"), h("button.tb", { onclick: () => openDialog("export") }, h("span.ic", {}, "⤓"), "Export")] : null,
        S.role !== "viewer" ? h("button.tb" + (S.toolLock() ? ".on" : ""), { disabled: !may, onclick: () => { S.toggleLock(); chromeDirty = true; } }, h("span.ic", {}, S.toolLock() ? "🔒" : "🔓"), "Lock tool") : null,
        h("button.tb", { onclick: () => setTheme(ui.theme === "dark" ? "light" : "dark") }, h("span.ic", {}, ui.theme === "dark" ? "☀" : "☾"), ui.theme === "dark" ? "Light" : "Dark"));
    } else if (ui.sheet === "panel") body = h("div.scroll", {}, panelNodes(true));
    else body = [h("div.tabs", { style: { justifyContent: "center" } }, drawerTabs("sheet")), h("div.scroll", {}, drawerBody(ui.sheet))];
    replace(el, h("div.grab", { onclick: () => { ui.sheet = null; chromeDirty = true; } }), body);
  }
  const panelNodes = (inSheet = false) => renderPanel(null, { session: S, state: ui.panel, h, inSheet, library: ui.library, setLibrary, setState: setPanel, onChange: () => { chromeDirty = true; } });

  // Mermaid preview: import into a scratch Editor (never bound to the room) and paint it small.
  function mermaidPreview(cv) {
    const x = cv.getContext("2d"), theme = THEMES[ui.theme], scratch = new Editor();
    scratch.setSize(cv.width, cv.height);
    try { if (!isMermaid(ui.mermaid.src)) throw new Error("Not a Mermaid flowchart (start with flowchart or graph)"); scratch.importMermaid(ui.mermaid.src, undefined, { elbow: ui.mermaid.elbow }); scratch.fit(undefined, 12); scratch.select([]); }
    catch (e) { paint(x, [], { width: cv.width, height: cv.height, background: theme.bg }); x.fillStyle = theme.dim; x.font = "12px system-ui"; x.fillText(String(e.message ?? e).slice(0, 60), 10, 20); return false; }
    paint(x, scratch.displayList(theme), { width: cv.width, height: cv.height, background: theme.bg });
    return true;
  }
  function exportPreview(cv) {
    const { page, scale } = ui.export;
    const tmp = document.createElement("canvas");
    paintPng(S.eds.board.doc, tmp, { page, theme: ui.theme, scale: 1, loadImage: image });
    cv.width = tmp.width; cv.height = tmp.height; cv.getContext("2d").drawImage(tmp, 0, 0);
    return scale;
  }
  async function download() {
    const { format, scale, page } = ui.export, doc = S.eds.board.doc, name = `${board}.${format}`;
    let blob;
    if (format === "svg") blob = new Blob([exportSvg(doc, { page, theme: ui.theme, scale })], { type: "image/svg+xml" });
    else { const cv = paintPng(doc, document.createElement("canvas"), { page, theme: ui.theme, scale, loadImage: await loadPictures(doc.files) }); blob = await new Promise(r => cv.toBlob(r, "image/png")); }
    const a = h("a", { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function dialogs() {
    const d = $("#dialogs"), may = S.may();
    if (document.activeElement?.closest?.("#dialogs") && d.firstChild) return;   // don't rebuild under the cursor
    const close = () => { ui.dialog = null; chromeDirty = true; canvas.focus(); };
    const chip = (t, on, onclick) => h("button.c" + (on ? ".on" : ""), { onclick }, t);
    if (ui.dialog === "mermaid" && S.role === "presenter") {
      const cv = h("canvas", { width: 300, height: 180 });
      const ta = h("textarea.code", { spellcheck: false, value: ui.mermaid.src, oninput: e => { ui.mermaid.src = e.target.value; mermaidPreview(cv); }, onkeydown: e => e.stopPropagation() });
      replace(d, h("div.dialog-veil", { onclick: e => { if (e.target === e.currentTarget) close(); } }, h("div.dialog", { role: "dialog", "aria-label": "Insert a Mermaid flowchart" },
        h("h2", {}, "◇→ Insert a Mermaid flowchart", h("span.spacer"), h("button.tb", { onclick: close, title: "Close" }, "✕")),
        h("div.dbody", {}, h("div.cols", {}, ta, h("div.preview", {}, cv)),
          h("div.row", {}, h("span.lab", {}, "Arrows"), h("span.opts", {}, chip("╱ straight", !ui.mermaid.elbow, () => { ui.mermaid.elbow = false; ui.dialog = "mermaid"; d.replaceChildren(); chromeDirty = true; }), chip("┐ elbow", ui.mermaid.elbow, () => { ui.mermaid.elbow = true; d.replaceChildren(); chromeDirty = true; }))),
          h("div.hint", {}, "Flowcharts only (graph / flowchart, TD TB BT LR RL, subgraphs become frames). Pasting Mermaid text on the board does the same.")),
        h("footer", {}, h("button.btn", { onclick: close }, "Cancel"), h("button.btn.primary", { disabled: !may, onclick: () => {
          let err = null;
          S.act("board", e => { try { e.importMermaid(ui.mermaid.src, undefined, { elbow: ui.mermaid.elbow }); } catch (x) { err = x; } });
          if (err) toast(String(err.message ?? err)); else close();
        } }, "Insert as shapes")))));
      mermaidPreview(cv);
    } else if (ui.dialog === "export" && S.role === "presenter") {
      const cv = h("canvas"), x = ui.export, set = (k, v) => { x[k] = v; d.replaceChildren(); chromeDirty = true; };
      replace(d, h("div.dialog-veil", { onclick: e => { if (e.target === e.currentTarget) close(); } }, h("div.dialog", { style: { width: "min(520px,100%)" }, role: "dialog", "aria-label": "Export the board" },
        h("h2", {}, "⤓ Export the board", h("span.spacer"), h("button.tb", { onclick: close, title: "Close" }, "✕")),
        h("div.dbody", {}, h("div.preview", { style: { minHeight: "120px" } }, cv),
          h("div.row", {}, h("span.lab", {}, "Format"), h("span.opts", {}, chip("SVG", x.format === "svg", () => set("format", "svg")), chip("PNG", x.format === "png", () => set("format", "png")))),
          h("div.row", {}, h("span.lab", {}, "Scale"), h("span.opts", {}, chip("1×", x.scale === 1, () => set("scale", 1)), chip("2×", x.scale === 2, () => set("scale", 2)))),
          h("div.row", {}, h("span.lab", {}, "Page"), h("span.opts", {}, chip("board color", x.page === "board", () => set("page", "board")), chip("white", x.page === "white", () => set("page", "white")))),
          h("div.hint", {}, "The board stream only, cropped to what's drawn, 32 units of padding. Notes, selection, cursors and comments never show.")),
        h("footer", {}, h("button.btn", { onclick: close }, "Cancel"), h("button.btn.primary", { onclick: () => { download(); close(); } }, "Download")))));
      exportPreview(cv);
    } else d.replaceChildren();
  }

  function banners() {
    const out = [], viewer = S.effective === "viewer", st = S.status;
    if (st === "stopped") out.push(h("div.banner", {}, `⚠ This app is older than the board's room and has stopped: reload to update it.${S.pending ? ` Reloading loses ${S.pending} edits not yet acknowledged.` : ""} `, h("button.btn", { onclick: () => location.reload() }, "Reload")));
    else if (st === "refused") out.push(h("div.banner", {}, "⚠ The room refused this sign-in (token or board). ", h("button.btn", { onclick: () => S.reconnect() }, "Retry")));
    else if (!S.online) out.push(h("div.banner", {}, viewer ? "⚠ You're offline. The live view is paused until you reconnect." : (S.pending ? `⚠ You're offline. ${S.pending} ${S.pending === 1 ? "edit waits" : "edits wait"} in this tab and send when you reconnect. Closing the tab loses them.` : "⚠ You're offline. Nothing is waiting to send; edits you make now are kept in this tab until you reconnect."), " ", h("button.btn", { onclick: () => S.reconnect() }, "Retry now")));
    else if (st !== "live") out.push(h("div.banner", {}, viewer ? "⟳ Connecting… the live view is paused." : `⟳ Connecting… ${S.pending ? `${S.pending} edits waiting. ` : ""}Keep working: they're sent with the same ids when the room is back.`));
    else if (S.readOnly) out.push(h("div.banner", {}, "👁 Read-only: the server gave this session a lower role. Ask the board's owner for edit access."));
    if (st === "limited") out.push(h("div.banner", {}, `⚠ This board is open in too many of your tabs (${S.limited ?? "the room's limit"}). Close one, then `, h("button.btn", { onclick: () => S.reconnect() }, "Retry")));
    // Settings changes the room refused (stale-setting: someone changed the same setting first). Retry when ready.
    for (const r of S.settingsRefused) {
      const what = r.keys.join(", ") || "a setting";
      out.push(h("div.banner", {}, r.code === "stale-setting" ? `⚠ Your change to ${what} was not saved: someone changed it first. ` : `⚠ Your change to ${what} was refused (${r.code}). `,
        r.ready ? h("button.btn", { onclick: () => { S.retrySetting(r.stream, r.i); chromeDirty = true; } }, "Apply mine again") : h("span.dim", {}, "Waiting for their change… "),
        " ", h("button.btn", { onclick: () => { S.dismissSetting(r.stream, r.i); chromeDirty = true; } }, "Keep theirs")));
    }
    return out;
  }

  let chromeAt = 0, chromeKey = "", chromeHeld = false;
  document.addEventListener("pointerdown", e => { if (e.target !== canvas) chromeHeld = true; }, true);
  addEventListener("pointerup", () => { chromeHeld = false; }, true);
  addEventListener("pointercancel", () => { chromeHeld = false; }, true);
  function chrome() {
    const now = performance.now();
    const key = [S.version(), S.status, S.pending, S.role, S.effective, S.tool, S.online, S.congested, JSON.stringify(S.settingsRefused.map(r => [r.stream, r.i, r.ready])), ui.theme, isPhone(), JSON.stringify(ui.panel), ui.drawer, ui.sheet, ui.dialog, ui.library.length, S.toolLock(), JSON.stringify(ui.export), ui.mermaid.elbow].join("|");
    if (!chromeDirty && key === chromeKey) return;
    if (chromeHeld) return;                                   // a press on the chrome: don't swap the button under it
    if ((S.gesture || !chromeDirty) && now - chromeAt < 250) return;   // mid-drag, playback, incoming ops: a few times a second          // mid-drag: refresh a few times a second at most
    chromeDirty = false; chromeKey = key; chromeAt = now;
    document.body.classList.toggle("stale", S.status !== "live");
    replace($("#topbar"), topbar());
    // Don't rebuild a panel or drawer the person is typing in.
    const busy = el => el.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    const panel = $("#panel"), lay = panelLayout(ui.panel, $(".main").getBoundingClientRect().width);
    panel.hidden = S.role === "viewer" || !lay.show;
    if (!panel.hidden && !busy(panel)) {
      panel.style.width = `${lay.width}px`;
      const edge = h("div.edge", { title: "Drag to resize (180–520 px)", onpointerdown: e => {
        e.preventDefault(); const sw = ui.panel.width, sx = e.clientX;
        const mv = ev => setPanel({ type: "width", width: dragWidth(sw, sx, ev.clientX) }), end = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", end); };
        addEventListener("pointermove", mv); addEventListener("pointerup", end);
      } });
      const top = panel.scrollTop;
      replace(panel, edge, panelNodes());
      panel.classList.toggle("ro", !S.may());
      panel.scrollTop = top;
    }
    const drawer = $("#drawer");
    drawer.hidden = !ui.drawer;
    if (ui.drawer && !busy(drawer)) replace(drawer, h("header", {}, h("h3", {}, "Annotations"), drawerTabs("drawer"), h("button.tb", { title: "Close", onclick: () => { ui.drawer = null; chromeDirty = true; } }, "✕")), drawerBody(ui.drawer));
    $("#veil").hidden = S.online;
    replace($("#overlays"), banners());
    timeline(); hud(); dock(); sheetView(); dialogs();
  }

  // ── loop ──
  addEventListener("online", () => { S.online = true; chromeDirty = true; });
  addEventListener("offline", () => { S.online = false; chromeDirty = true; });
  matchMedia("(max-width: 640px)").addEventListener("change", () => { chromeDirty = true; });
  setTheme(ui.theme);
  let savedMine = 0, layoutKey = "";
  (function frame() {
    const live = S.eds.board.needsTick() || S.eds.notes.needsTick();
    if (dirty || live || seen !== S.version()) { dirty = false; draw(); seen = S.version(); if (live) chromeDirty = chromeDirty || !!S.eds.board.play; }
    // My selection as presence, whatever changed it (a click, Escape, select-all, a tool switch): no ghost selections.
    sendSelection();
    // Pins and the popover follow the view and the elements they anchor to.
    if (collab) { const v = S.eds.board.view, k = `${v.x}|${v.y}|${v.scale}|${S.version()}`; if (k !== layoutKey) { layoutKey = k; collab.layout(); } }
    const f = S.takeFlash(); if (f) toast(f);
    chrome();
    if (S.mine.size !== savedMine) { savedMine = S.mine.size; put(mineKey, JSON.stringify([...S.mine].slice(-5000))); }
    requestAnimationFrame(frame);
  })();
  // First catch-up done: show everything once.
  const fitOnce = setInterval(() => { if (S.status === "live") { clearInterval(fitOnce); if (S.eds.board.doc.live().length || S.eds.notes.doc.live().length) S.fit(); } }, 50);

  if (notice) toast(notice, 6000);
  return { S, ui, net, collab, port, setTheme, openDialog, setPanel, startComment };
}
