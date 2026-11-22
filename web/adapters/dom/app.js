// The canvas page's chrome: a driving adapter over the DOM (it calls into the core; it implements no port). Draws the verified
// mock (docs/m2/design), paints through ./paint.js, feeds input to the core session (web/core/session.js), and
// keeps UI preferences in the storage port it is given. Every write goes through session.act/setTool/key; nothing
// here touches the protocol, a transport or sign-in (web/main.js, the composition root, wires those).

import { Editor } from "../../../packages/core/editor.js";
import { parsePanel, serializePanel, applyPanel, panelLayout, dragWidth } from "../../../packages/core/panel.js";
import { isMermaid } from "../../../packages/core/mermaid.js";
import { isLabel } from "../../../packages/core/model.js";
import { parseLibrary } from "../../../packages/core/library.js";
import { paint, imageCache, THEMES, color as safeColor, cappedDpr } from "./paint.js";
import { toolsFor, pillFor, pillTitleFor, connectionBanner, expiryNotice, shouldProbe, RESUME_PROBE_MS } from "../../core/roles.js";

/** The resume probe's jitter window (ms) for a page role (uiRole: presenter | annotator | viewer; null = not known yet). */
export const PROBE_JITTER_MS = Object.freeze({ presenter: 2000, other: 15_000 });
export const probeJitterMs = role => (role === "presenter" ? PROBE_JITTER_MS.presenter : PROBE_JITTER_MS.other);
import { renderPanel, loadLibrary, saveLibrary, addToLibrary, propsModel } from "./panel.js";
import { exportSvg, paintPng, loadPictures } from "./export.js";
import { h, $, replace } from "./dom.js";
import { mountShareDialog } from "./admin.js";
import { mountCollab } from "./collab/ui.js";
import { collabFrame } from "./collab/frame.js";
import { hitTest } from "../../../packages/core/geometry.js";

/**
 * Mount the page on index.html's DOM.
 * @param {{ startSession: (o: { mine: string[], onChange: () => void }) => ReturnType<typeof import("../../core/session.js").createSession>,
 *           net: import("../../ports/net.js").Net, board: string, me: { user: string, name: string, role: string | null },
 *           prefs: import("../../ports/storage.js").Storage, theme?: string | null, notice?: string | null,
 *           collab?: (S: object, o: { jumpTo(p: { x: number, y: number, scale?: number }): void }) => object,
 *           clock: import("../../ports/clock.js").Clock, expAt?: number | null,
 *           relogin?: { href: string, go(): void } | null }} o
 *   collab: the root's collab port factory (web/ports/collab.js; production and dev: web/adapters/collab/sync.js over
 *   the session). The collaboration UI (./collab/ui.js) mounts over it: avatars, emotes, cursors, selections, laser,
 *   previews, comment threads. Without it the page has none of that.
 *   startSession: the root's createSession with everything but the page's own bits. prefs: the per-browser store
 *   (local storage; a failing store reads as empty). notice: shown once (sign-in, share link).
 *   clock: the root's clock port (banner countdowns, the hidden-tab timer, the collab UI). expAt: when the sign-in
 *   ends (ms on the clock's now() scale), null when unknown: the page warns EXPIRY_WARN_MS before it. relogin: where
 *   a refused or expiring page signs in again (href shown, go() remembers the board and leaves); null = no link (dev).
 * @returns {{ S: object, ui: object, net: object, setTheme(t: string): void, openDialog(d: string): void, setPanel(op: object): void }}
 */
export function mountApp({ startSession, net, board, me, prefs, theme: theme0 = null, notice = null, collab: collabPort = null, clock, expAt = null, relogin = null, admin = null }) {
  if (!clock || typeof clock.now !== "function" || typeof clock.mono !== "function") throw new Error("mountApp: the clock port is required");
  const get = k => { try { return prefs.get(k); } catch { return null; } };
  const put = (k, v) => { try { prefs.set(k, v); } catch {} };
  const ui = {
    theme: theme0 === "dark" || (theme0 !== "light" && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light",
    panel: parsePanel(get("plenary.panel")), drawer: null, sheet: null, dialog: null, library: loadLibrary(prefs),
    mermaid: { src: "flowchart LR\n  A[Idea] --> B[Spec]\n  B --> C{Review?}\n  C -->|yes| D[Build]\n  C -->|no| B\n  D --> E[Ship]", elbow: true },
    export: { format: "svg", scale: 2, page: "board" },
  };
  // The notes this person made on this board, kept per user (p8-one-linkv L8): the key follows the user the room says
  // this tab is (welcome.user), so after a same-tab switch to another user the emptied set never overwrites the old
  // user's stored one. Before the first welcome it is the sign-in's user.
  const mineKeyOf = user => `plenary.mine.${board}.${user}`;
  const mineKey = mineKeyOf(me.user);
  let chromeDirty = true;
  const S = startSession({
    mine: (() => { try { const v = JSON.parse(get(mineKey) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } })(),
    onChange: () => { chromeDirty = true; },
  });
  if (!ui.drawer && me.role === "annotator") ui.drawer = "notes";
  net.onFile(file => { S.receiveFiles({ [file.id]: file }); });

  const isPhone = () => matchMedia("(max-width: 640px)").matches;
  const isCoarse = () => matchMedia("(pointer: coarse)").matches;
  // Sync Chrome-on-iOS / WKWebView visual viewport (dynamic toolbar & software keyboard) to CSS custom properties.
  const vv = globalThis.visualViewport;
  const syncVisualViewport = () => {
    const root = document.documentElement?.style;
    if (!root) return;
    if (vv && Number.isFinite(vv.height) && vv.height > 0) {
      root.setProperty("--vv-height", `${Math.round(vv.height)}px`);
      root.setProperty("--vv-top", `${Math.max(0, Math.round(vv.offsetTop || 0))}px`);
    } else {
      root.setProperty("--vv-height", "100dvh");
      root.setProperty("--vv-top", "0px");
    }
  };
  syncVisualViewport();
  if (vv && typeof vv.addEventListener === "function") {
    vv.addEventListener("resize", syncVisualViewport);
    vv.addEventListener("scroll", syncVisualViewport);
  }
  const canvas = $("#board"), ink = $("#ink"), ctx = canvas.getContext("2d");
  const allFiles = () => ({ ...S.eds.notes.doc.files, ...S.eds.board.doc.files });

  // ── collaboration (p7-wire): the collab UI over the root's port, presence painted on its own canvas ──
  const overlay = h("canvas.collab-overlay", { "aria-hidden": "true" });
  canvas.after(overlay);
  // Centre the board on a world point; `scale` (optional: a cluster click zooms in) is clamped to the page's zoom
  // limits, and the centre is worked out at the new scale.
  const ZOOM_MIN = 0.1, ZOOM_MAX = 8;
  const jumpTo = (p, { animate = true } = {}) => {
    const B = S.eds.board, { w, h: hh } = B.size;
    const sc = Number.isFinite(p.scale) && p.scale > 0 ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, p.scale)) : B.view.scale;
    const target = { scale: sc, x: w / 2 / sc - p.x, y: hh / 2 / sc - p.y };
    S.eds.notes.cancelCamera();
    if (animate && p.animate !== false) B.animateViewTo(target);
    else { B.cancelCamera(); B.view = { ...B.view, ...target }; B.changed(); S.syncView("board"); }
    chromeDirty = true;
  };
  const port = collabPort ? collabPort(S, { jumpTo }) : null;
  // The clock port (C-6) and the frame scheduler.
  const collab = port ? mountCollab({ root: $("#canvas"), canvasOverlay: overlay, port, theme: ui.theme, clock, frame: fn => requestAnimationFrame(fn),
    view: { toScreen: p => S.eds.board.toScreen(p), toWorld: p => S.eds.board.toWorld(p), get scale() { return S.eds.board.view.scale; }, maxScale: ZOOM_MAX },
    // A cluster that can't zoom apart lists its threads in the comments drawer (the phone's sheet): show it.
    onList: which => { if (isPhone()) ui.sheet = which; else ui.drawer = which; chromeDirty = true; } }) : null;
  if (collab) collab.showDrawer("comments");
  const worldAt = p => S.eds.board.toWorld(p);
  // Selection presence and pin layout, once per frame (./collab/frame.js).
  const collabTick = collab ? collabFrame(S, collab) : () => {};
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
    const fontSize = isCoarse() ? Math.max(16, box.size) : box.size;
    Object.assign(ink.style, { display: "block", left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px`, fontSize: `${fontSize}px`, textAlign: box.align });
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
    const r = $("#canvas").getBoundingClientRect(), dpr = cappedDpr(r.width, r.height, devicePixelRatio || 1);
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
  const countClick = e => { const p = at(e), now = clock.mono(); const n = now - last.t < 400 && Math.hypot(p.x - last.x, p.y - last.y) < 6 ? last.n + 1 : 1; last = { t: now, ...p, n }; return n; };
  const pmods = (e, base = e) => ({
    ...mods(base),
    button: BUTTONS[e.button ?? base.button] ?? "left",
    clickCount: clicks,
    space,
    pointerId: e.pointerId ?? base.pointerId ?? 0,
    pointerType: e.pointerType || base.pointerType || "mouse",
    isPrimary: typeof e.isPrimary === "boolean" ? e.isPrimary : (typeof base.isPrimary === "boolean" ? base.isPrimary : undefined),
    pressure: typeof e.pressure === "number" && Number.isFinite(e.pressure) ? e.pressure : undefined,
  });

  // Pointer input: core Editor owns multi-touch (pinch-zoom/pan, 2/3-finger tap undo/redo, palm rejection).
  canvas.addEventListener("pointerdown", e => {
    canvas.focus(); canvas.setPointerCapture?.(e.pointerId); e.preventDefault();
    if (ui.sheet) { ui.sheet = null; chromeDirty = true; }
    clicks = Math.max(e.detail || 0, countClick(e));
    if (S.tool === "image") { openPicker(); return; }
    const p = at(e);
    S.pointerDown(p, pmods(e));
    if (collab && S.tool === "laser" && e.button === 0 && S.ed.pointers.size <= 1) collab.laser(worldAt(p));
  });
  canvas.addEventListener("pointermove", e => {
    const highRate = S.gesture && (S.tool === "freedraw" || S.tool === "highlighter" || S.tool === "laser");
    const coalesced = highRate && typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : null;
    if (coalesced && coalesced.length > 0) {
      for (const ce of coalesced) {
        const cp = at(ce);
        S.pointerMove(cp, pmods(ce, e));
        if (collab && S.tool === "laser" && S.gesture && (ce.buttons & 1) && S.ed.pointers.size <= 1) collab.laser(worldAt(cp));
      }
      if (collab && S.ed.pointers.size <= 1) collab.pointer(worldAt(at(e)));
      return;
    }
    const p = at(e);
    S.pointerMove(p, pmods(e));
    if (collab && S.ed.pointers.size <= 1) {
      const w = worldAt(p);
      collab.pointer(w);
      if (S.tool === "laser" && S.gesture && (e.buttons & 1)) collab.laser(w);
    }
  });
  canvas.addEventListener("pointerup", e => {
    S.pointerUp(at(e), pmods(e)); chromeDirty = true;
    collabTick();
  });
  canvas.addEventListener("pointercancel", e => {
    S.pointerCancel(at(e), pmods(e)); chromeDirty = true;
    collabTick();
  });
  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) { const s = S.eds.board.view.scale * Math.exp(-e.deltaY * 0.01); S.zoomAt(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, s)), at(e)); }
    else S.wheel({ x: e.deltaX, y: e.deltaY }, at(e), mods(e));
    // No chromeDirty (C-2): the zoom % is updated in place; nothing else the chrome shows moves with the view.
  }, { passive: false });
  canvas.addEventListener("dblclick", e => e.preventDefault());
  // Prevent WebKit page-zoom gestures on the board canvas (Chrome/Safari on iOS).
  const stopGesture = e => { e.preventDefault(); };
  for (const t of ["gesturestart", "gesturechange", "gestureend"]) {
    canvas.addEventListener(t, stopGesture, { passive: false });
    $("#canvas").addEventListener(t, stopGesture, { passive: false });
  }

  const tagOf = el => (typeof el?.tagName === "string" ? el.tagName.toUpperCase() : "");
  const attrOf = (el, name) => (typeof el?.getAttribute === "function" ? el.getAttribute(name) : el?.attrs?.[name] ?? null);
  const hasClass = (el, cls) => (typeof el?.classList?.contains === "function" ? el.classList.contains(cls) : false);
  const matchUp = (el, pred) => {
    for (let x = el; x; x = x.parentNode ?? null) if (pred(x)) return true;
    return false;
  };
  const isContentEditableAttr = el => {
    const v = attrOf(el, "contenteditable");
    return v != null && v.toLowerCase() !== "false";
  };
  const isEditable = el => matchUp(el, x =>
    /^(INPUT|TEXTAREA|SELECT)$/.test(tagOf(x)) || x.isContentEditable === true || isContentEditableAttr(x)
  );
  const inDialog = el => matchUp(el, x =>
    hasClass(x, "dialog") || hasClass(x, "dialog-veil") || attrOf(x, "role") === "dialog" || tagOf(x) === "DIALOG"
  );
  const isInteractive = el => matchUp(el, x =>
    /^(BUTTON|A|SUMMARY)$/.test(tagOf(x)) || attrOf(x, "role") === "button"
  );

  const hasOpenDialog = () => Boolean($("#dialogs")?.childNodes?.length);

  document.addEventListener("keydown", e => {
    const t = e.target;
    if (hasOpenDialog() || isEditable(t) || inDialog(t)) return;   // inputs, dialogs keep their keys
    if (isInteractive(t) && (e.key === "Enter" || e.key === " " || e.code === "Space")) return;   // let focused buttons/links activate
    if (e.key === " " || e.code === "Space") space = true;
    const k = keyName(e), m = mods(e);
    if ((m.cmd || m.ctrl) && m.shift && k === "e") { e.preventDefault(); e.stopPropagation?.(); if (S.role === "presenter") openDialog("export"); return; }
    if (!m.cmd && !m.ctrl && !m.alt && k === "i" && S.role === "presenter") { e.preventDefault(); e.stopPropagation?.(); setPanel({ type: "open" }); return; }
    if (S.key(k, m)) { e.preventDefault(); e.stopPropagation?.(); chromeDirty = true; }
  });
  document.addEventListener("keyup", e => { if (e.key === " " || e.code === "Space") space = false; });

  // Clipboard: the browser's own events (so paste runs once), images included.
  const hasSelection = () => Boolean(globalThis.getSelection?.()?.toString());
  const onCanvas = (e, { checkSelection = false } = {}) => {
    const t = e?.target ?? document.activeElement;
    if (hasOpenDialog() || isEditable(t) || inDialog(t)) return false;
    if (document.activeElement && (isEditable(document.activeElement) || inDialog(document.activeElement))) return false;
    if (checkSelection && document.activeElement !== canvas && hasSelection()) return false;
    return true;
  };
  document.addEventListener("copy", e => { if (!onCanvas(e, { checkSelection: true })) return; const t = S.copy(); if (t) { e.clipboardData.setData("text/plain", t); e.preventDefault(); } });
  document.addEventListener("cut", e => { if (!onCanvas(e, { checkSelection: true }) || !S.may()) return; const t = S.cut(); if (t) { e.clipboardData.setData("text/plain", t); e.preventDefault(); } });
  document.addEventListener("paste", e => {
    if (!onCanvas(e)) return;
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
    if (typeof net.uploadBlob === "function") {
      try { await S.uploadBlob(id, new Uint8Array(buf), file.type); }
      catch { return toast("Picture upload failed"); }
      S.addPicture(f, at);
    } else if (S.addPicture(f, at)) {
      net.put(f);          // local / shared-worker tab relay
    }
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
  // What the chrome shows from the boards, computed once per Doc revision (Doc.rev bumps on every applied change,
  // local or the room's; never on a pan or zoom), so a frame never scans every element (C-2, C-8).
  const perRev = fn => { let d = null, r = -1, v; return doc => (doc === d && doc.rev === r ? v : ((d = doc), (r = doc.rev), (v = fn(doc)))); };
  const notesInfo = perRev(doc => {
    const labels = new Map(), notes = [];
    for (const e of doc.live()) { if (!isLabel(e)) notes.push(e); else if (e.containerId && !labels.has(e.containerId)) labels.set(e.containerId, e); }
    notes.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
    return { notes, labels };
  });
  const boardInfo = perRev(() => {
    const B = S.eds.board, live = B.doc.live();
    const counts = {};
    for (const e of live) if (!isLabel(e)) { const l = e.customData?.layer ?? ""; counts[l] = (counts[l] ?? 0) + 1; }
    const frames = B.frames();
    const marks = [...new Set(live.map(e => e.customData?.anim?.start).filter(Number.isFinite))];
    return { frames, framesSig: JSON.stringify(frames.map(f => [f.id, f.name ?? ""])), marks, dur: B.duration(), counts: JSON.stringify(counts) };
  });
  const notesCount = () => notesInfo(S.eds.notes.doc).notes.length;
  // Updated in place every frame (cheap compares), never by a rebuild: the zoom % and the connection pill.
  const zoomPct = h("span.pct");
  const tl = { fill: null, head: null, text: null, sig: "" };
  function timelineInPlace() {
    if (!tl.fill || S.role !== "presenter") return;
    const B = S.eds.board, { dur } = boardInfo(B.doc), t = B.time() ?? 0, pct = Math.min(100, (t / dur) * 100);
    const sig = `${pct}|${t}`;
    if (sig === tl.sig) return;
    tl.sig = sig;
    tl.fill.style.width = `${pct}%`; tl.head.style.left = `${pct}%`;
    tl.text.textContent = `${(t / 1000).toFixed(1)}s / ${(dur / 1000).toFixed(1)}s`;
  }
  // The pill: a click while not live reconnects now (the user's own click skips the resume jitter, C-4 / p8-tidy).
  const pillEl = h("span.pill", { onclick: () => { if (S.status !== "live" && shouldProbe({ status: S.status, gesture: S.gesture })) reconnectNow(); } });
  let pillSig = "";
  function inPlace() {
    timelineInPlace();
    const z = `${Math.round(S.eds.board.view.scale * 100)}%`;
    if (zoomPct.textContent !== z) zoomPct.textContent = z;
    const pill = pillFor({ status: S.status, online: S.online, pending: S.pending, role: S.effective, readOnly: S.readOnly, congested: S.congested });
    const sig = JSON.stringify([pill, pillTitle(pill.cls)]);
    if (sig === pillSig) return;
    pillSig = sig;
    pillEl.className = `pill ${pill.cls}`; pillEl.title = pillTitle(pill.cls);
    replace(pillEl, h("span.dot"), pill.text, pill.sub ? h("span.sub", {}, ` · ${pill.sub}`) : null);
  }
  let toastTimer = null;
  function toast(text, ms = 1800) {
    const el = $("#toast"); el.textContent = text; el.hidden = false;
    if (toastTimer != null) clock.clear(toastTimer);
    toastTimer = clock.set(() => { toastTimer = null; el.hidden = true; }, ms);
  }
  const setPanel = op => { const n = applyPanel(ui.panel, op); if (n !== ui.panel) { ui.panel = n; put("plenary.panel", serializePanel(n)); } chromeDirty = true; };
  function setLibrary(items) { ui.library = items; saveLibrary(prefs, items); chromeDirty = true; }
  const THEME_COLORS = { light: "#f6f6f8", dark: "#18181b" };
  const setTheme = t => {
    ui.theme = t;
    document.documentElement.dataset.theme = t;
    const meta = document.querySelector?.('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", THEME_COLORS[t] ?? THEME_COLORS.light);
    dirty = true;
    chromeDirty = true;
    collab?.setTheme(t);
  };
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
      h("button.btn.ghost.desk-only", { title: "Notes", onclick: () => { ui.drawer = ui.drawer ? null : "notes"; chromeDirty = true; } }, "❏ Notes ", h("span.dim", {}, String(notesCount()))),
      collab ? h("button.btn.ghost.desk-only", { title: "Comments (or right-click the board)", onclick: () => { ui.drawer = ui.drawer === "comments" ? null : "comments"; chromeDirty = true; } }, "💬") : null,
      // Who's here (`here`): the collab UI's live avatar row, kept across rebuilds (a node, moved, never rebuilt here).
      collab ? collab.parts.avatars : h("div.avatars", {},
        h("span.stack", {}, h("span.av.live", { style: { background: "var(--u-me)" }, title: `${me.name} (you)` }, me.name.slice(0, 2).toUpperCase()))),
      pillEl,                                                   // the pill: one node, updated in place (inPlace)
      role !== "viewer" ? h("button.tb.desk-only" + (ui.panel.open ? ".on" : ""), { title: "Side panel (I)", onclick: () => setPanel({ type: "open" }) }, h("span.ic", {}, "◧"), h("span.k", {}, "I")) : null,
      h("button.tb.theme-btn", { title: "Light / dark", onclick: () => setTheme(ui.theme === "dark" ? "light" : "dark") }, h("span.ic", {}, ui.theme === "dark" ? "☀" : "☾")),
      h("button.tb.phone-only.overflow-btn", { title: "More", "aria-label": "More options", onclick: () => { ui.sheet = ui.sheet === "tools" ? null : "tools"; chromeDirty = true; } }, h("span.ic", {}, "⋯")),
    ];
  }
  const pillTitle = cls => pillTitleFor({ cls, status: S.status, viewer: S.effective === "viewer", readOnly: S.readOnly });

  function hud() {
    const B = S.eds.board, fs = boardInfo(B.doc).frames, i = fs.findIndex(f => f.id === B.frameAt), may = S.may();
    const bl = [
      h("div.grp" + (S.role === "viewer" ? ".desk-only" : ""), {}, h("button.tb", { title: "Previous frame (PgUp)", onclick: () => S.stepFrame(-1) }, "‹"), h("span.pct", {}, fs.length ? `${i < 0 ? "–" : i + 1} / ${fs.length}` : "0 / 0"), h("button.tb", { title: "Next frame (PgDn)", onclick: () => S.stepFrame(1) }, "›")),
      h("div.grp.desk-only", {}, h("button.tb", { title: "Zoom out (⌘-)", onclick: () => S.zoomAt(B.view.scale / 1.2) }, "−"), zoomPct,
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
    const { dur, marks: starts } = boardInfo(B.doc);
    const marks = starts.map(s => h("div.mark", { style: { left: `${(s / dur) * 100}%` } }));
    // The head, fill and time are kept and moved in place every frame while playing (inPlace).
    tl.fill = h("div.fill"); tl.head = h("div.head"); tl.text = h("span.t"); tl.sig = "";
    const track = h("div.track", { title: "Click to scrub", onclick: e => { const r = e.currentTarget.getBoundingClientRect(); B.play = null; B.scrub = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur; B.changed(); chromeDirty = true; } },
      tl.fill, marks, tl.head);
    replace(el, h("button.c", { title: "Play / pause (⇧Space)", onclick: () => { B.playToggle(); chromeDirty = true; } }, B.play ? "❚❚" : "▶"),
      h("button.c", { title: "Back to editing (Esc)", onclick: () => { B.stopPlay(); chromeDirty = true; } }, "■"), track, tl.text);
    timelineInPlace();
  }

  // The notes stream as a list: text, author (you, or unknown until v1's noteAuthor), jump / edit / delete.
  function notesList() {
    const N = S.eds.notes, may = S.may();
    const { notes, labels } = notesInfo(N.doc);
    const label = e => (e.type === "text" ? e.text : labels.get(e.id)?.text) || { freedraw: "Highlight / drawing", image: "Picture", arrow: "Arrow", line: "Line" }[e.type] || "Note";
    const rows = notes.slice(0, 200).map(e => {
      const mine = S.isMine(e.id), canChange = may && mine;
      const jump = () => { S.eds.board.cancelCamera(); N.fit([e]); S.syncView("notes"); chromeDirty = true; };
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
  const SHEET_DISMISS_PX = 72, SHEET_FLICK_VY = 0.55;
  function sheetHandle(el) {
    let drag = null, suppressClick = false;
    const reset = () => { drag = null; el.classList.remove("dragging"); el.style.transform = ""; };
    const handle = h("div.sheet-handle", { role: "button", "aria-label": "Dismiss sheet", title: "Drag down or tap to close" }, h("div.grab"));
    handle.addEventListener("pointerdown", e => {
      if (e.button && e.button !== 0) return;
      handle.setPointerCapture?.(e.pointerId);
      drag = { id: e.pointerId ?? 0, startY: e.clientY ?? 0, lastY: e.clientY ?? 0, lastT: clock.mono(), dy: 0, vy: 0, moved: false };
      suppressClick = false;
      el.classList.add("dragging");
      el.style.transform = "translateY(0px)";
    });
    handle.addEventListener("pointermove", e => {
      if (!drag || (e.pointerId != null && e.pointerId !== drag.id)) return;
      const y = e.clientY ?? drag.lastY;
      const dy = Math.max(0, y - drag.startY);
      const now = clock.mono(), dt = Math.max(1, now - drag.lastT);
      drag.vy = (y - drag.lastY) / dt;
      drag.lastY = y; drag.lastT = now; drag.dy = dy;
      if (dy > 4) drag.moved = true;
      el.style.transform = `translateY(${Math.round(dy)}px)`;
    });
    handle.addEventListener("pointerup", e => {
      if (!drag || (e.pointerId != null && e.pointerId !== drag.id)) return;
      const { dy, vy, moved } = drag;
      reset();
      if (moved) suppressClick = true;
      if (dy > SHEET_DISMISS_PX || (dy > 24 && vy > SHEET_FLICK_VY)) { ui.sheet = null; chromeDirty = true; }
    });
    handle.addEventListener("pointercancel", e => {
      if (!drag || (e.pointerId != null && e.pointerId !== drag.id)) return;
      if (drag.moved) suppressClick = true;
      reset();
    });
    handle.addEventListener("click", () => {
      if (suppressClick) { suppressClick = false; return; }
      ui.sheet = null; chromeDirty = true;
    });
    return handle;
  }
  function sheetView() {
    const el = $("#sheet");
    el.classList.remove("dragging");
    el.style.transform = "";
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
    replace(el, sheetHandle(el), body);
  }
  const panelNodes = (inSheet = false) => renderPanel(null, { session: S, state: ui.panel, h, inSheet, library: ui.library, setLibrary, setState: setPanel, onChange: () => { chromeDirty = true; } });

  // Mermaid preview: import into a scratch Editor (never bound to the room) and paint it small.
  function mermaidPreview(cv) {
    const x = cv.getContext("2d"), theme = THEMES[ui.theme], scratch = new Editor();
    scratch.setSize(cv.width, cv.height);
    try { if (!isMermaid(ui.mermaid.src)) throw new Error("Not a Mermaid flowchart (start with flowchart or graph)"); scratch.importMermaid(ui.mermaid.src, undefined, { elbow: ui.mermaid.elbow }); scratch.fit(undefined, 12, { animate: false }); scratch.select([]); }
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
    clock.set(() => URL.revokeObjectURL(a.href), 5000);
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
    } else { ui.dialog = null; d.replaceChildren(); }
  }

  // Sign in again (C-9): a link (so it reads as one and opens in a new tab if asked), whose click remembers this
  // board and leaves through the root's relogin.go(). The link carries nothing but its fixed path.
  const reloginLink = () => h("a.btn.primary", { href: relogin.href, onclick: e => { if (e.button || e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); relogin.go(); } }, "Sign in again");
  // The cap's countdown in whole seconds, on the clock port (C-17: nextTryAt is the clock's now(), so is this).
  const nextTryIn = () => { const n = S.limitedNextTry; return n == null ? null : Math.max(0, n - clock.now()); };
  const expiry = () => expiryNotice({ expAt, now: clock.now() });
  function banners() {
    const out = [];
    const b = connectionBanner({ status: S.status, online: S.online, viewer: S.effective === "viewer", pending: S.pending, readOnly: S.readOnly,
      limited: S.limited, nextTryIn: nextTryIn(), relogin: !!relogin });
    if (b) out.push(h("div.banner", {}, b.text,
      b.relogin ? [reloginLink(), " "] : null,
      b.action === "reload" ? h("button.btn", { onclick: () => location.reload() }, "Reload")
        : b.action === "retry" ? h("button.btn", { onclick: reconnectNow }, S.status === "limited" ? "Retry now" : S.online ? "Retry" : "Retry now") : null));
    // Before the sign-in ends (or once it has, while the link still holds): warn, with the way out. Not when the
    // refused banner already offers it.
    const x = S.status === "refused" ? null : expiry();
    if (x) out.push(h("div.banner.expiry", {}, x.text, relogin ? reloginLink() : "Reload the page after signing in again."));
    // Settings changes the room refused (stale-setting: someone changed the same setting first). Retry when ready.
    for (const r of S.settingsRefused) {
      const what = r.keys.join(", ") || "a setting";
      out.push(h("div.banner", {}, r.code === "stale-setting" ? `⚠ Your change to ${what} was not saved: someone changed it first. ` : `⚠ Your change to ${what} was refused (${r.code}). `,
        r.ready ? h("button.btn", { onclick: () => { S.retrySetting(r.stream, r.i); chromeDirty = true; } }, "Apply mine again") : h("span.dim", {}, "Waiting for their change… "),
        " ", h("button.btn", { onclick: () => { S.dismissSetting(r.stream, r.i); chromeDirty = true; } }, "Keep theirs")));
    }
    return out;
  }

  // The chrome is a set of parts, each rebuilt only when what it shows changes (C-2, C-8). Two triggers:
  //   chromeDirty  a local action (click, key, tool, resize, a session event): every part rebuilds, at once.
  //   a part key   what that part shows, computed at most every CHROME_MS while anything moved (S.version(), the
  //                connection): incoming ops, a pan or a zoom leave every key alone, so nothing rebuilds.
  // Keys read per-revision memos (notesInfo, boardInfo), never a scan per frame. ui.rebuilds counts rebuilds per part.
  const CHROME_MS = 250;
  const rebuilds = ui.rebuilds = { topbar: 0, panel: 0, drawer: 0, timeline: 0, hud: 0, overlays: 0, dock: 0, sheet: 0, dialogs: 0 };
  let chromeAt = -Infinity, gateKey = "", chromeHeld = false;
  document.addEventListener("pointerdown", e => { if (e.target !== canvas) chromeHeld = true; }, true);
  addEventListener("pointerup", () => { chromeHeld = false; }, true);
  addEventListener("pointercancel", () => { chromeHeld = false; }, true);
  // Don't rebuild a panel or drawer the person is typing in.
  const busy = el => el.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName);
  // What every part depends on from the page and the session (a change rebuilds them all, as chromeDirty does).
  const envKey = () => [S.role, S.effective, S.readOnly, S.may(), S.tool, S.active, S.toolLock(), ui.theme, isPhone(), JSON.stringify(ui.panel), ui.drawer, ui.sheet, ui.dialog, ui.library.length].join("|");
  const notesRowsKey = () => {
    const { notes, labels } = notesInfo(S.eds.notes.doc);
    return JSON.stringify([notes.length, S.mine.size, notes.slice(0, 200).map(e => [e.id, e.text ?? labels.get(e.id)?.text ?? "", e.backgroundColor, e.strokeColor, S.isMine(e.id)])]);
  };
  // The side panel shows the active Editor's style and selection (propsModel), the board's frames, layers and their
  // counts, the active layer, the playback chip and the library (panel.js renderPanel).
  const panelKey = () => {
    const B = S.eds.board, ed = S.eds[S.role === "annotator" ? "notes" : S.active], bi = boardInfo(B.doc);
    return JSON.stringify([propsModel(ed), B.sel.size > 0, S.eds.notes.sel.size > 0, B.selected()[0]?.customData?.anim?.preset ?? null,
      bi.framesSig, B.frameAt, !!B.play, B.doc.layers, bi.counts, B.activeLayer]);
  };
  const parts = {
    topbar: { key: () => notesCount(), build: () => replace($("#topbar"), topbar()) },
    panel: { key: () => (S.role === "viewer" || !ui.panel.open ? "" : panelKey()), build: buildPanel },
    drawer: { key: () => (ui.drawer === "notes" ? notesRowsKey() : ""), build: buildDrawer },
    timeline: { key: () => { const B = S.eds.board, bi = boardInfo(B.doc), t = B.time(); return S.role !== "presenter" ? "" : JSON.stringify([bi.marks, bi.dur, !!B.play, B.play ? null : t]); }, build: timeline },
    hud: { key: () => JSON.stringify([boardInfo(S.eds.board.doc).framesSig, S.eds.board.frameAt]), build: hud },
    overlays: { key: () => JSON.stringify([S.status, S.online, S.pending, S.limited, nextTryIn() == null ? null : Math.ceil(nextTryIn() / 1000), S.settingsRefused.map(r => [r.stream, r.i, r.ready, r.code, r.keys]), expiry()?.bucket ?? null]), build: () => replace($("#overlays"), banners()) },
    dock: { key: () => "", build: dock },
    sheet: { key: () => (!ui.sheet || !isPhone() ? "" : ui.sheet === "panel" ? panelKey() : ui.sheet === "tools" ? "" : notesRowsKey()), build: sheetView },
    dialogs: { key: () => (ui.dialog === "export" ? `${S.eds.board.doc.rev}|${JSON.stringify(ui.export)}` : `${ui.mermaid.elbow}`), build: dialogs },
  };
  const keys = {};
  function buildPanel() {
    const panel = $("#panel"), lay = panelLayout(ui.panel, $(".main").getBoundingClientRect().width);
    panel.hidden = S.role === "viewer" || !lay.show;
    if (panel.hidden) return true;
    if (busy(panel)) return false;
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
    return true;
  }
  function buildDrawer() {
    const drawer = $("#drawer");
    drawer.hidden = !ui.drawer;
    if (!ui.drawer) return true;
    if (busy(drawer)) return false;
    replace(drawer, h("header", {}, h("h3", {}, "Annotations"), drawerTabs("drawer"), h("button.tb", { title: "Close", onclick: () => { ui.drawer = null; chromeDirty = true; } }, "✕")), drawerBody(ui.drawer));
    return true;
  }
  function chrome() {
    inPlace();
    document.body.classList.toggle("stale", S.status !== "live");
    $("#veil").hidden = S.online;
    const now = clock.mono();
    // Countdowns (the cap's retry, the sign-in's expiry) tick once a second; playback every frame (its key buckets it).
    const ticking = expAt != null || S.limitedNextTry != null ? Math.floor(clock.now() / 1000) : "";
    const gate = [S.version(), S.status, S.pending, S.online, S.congested, S.limited, S.limitedNextTry, ticking, S.eds.board.play ? now : ""].join("|");
    if (!chromeDirty && gate === gateKey) return;
    if (chromeHeld) return;                                   // a press on the chrome: don't swap the button under it
    if ((S.gesture || !chromeDirty) && now - chromeAt < CHROME_MS) return;   // mid-drag, playback, incoming ops: a few times a second at most
    const env = envKey(), force = chromeDirty || env !== keys.env;
    chromeDirty = false; gateKey = gate; chromeAt = now; keys.env = env;
    for (const [name, part] of Object.entries(parts)) {
      const k = part.key();
      if (!force && k === keys[name]) continue;
      if (part.build() === false) { keys[name] = undefined; continue; }   // busy: try again later
      keys[name] = k; rebuilds[name]++;
    }
  }

  // ── loop ──
  // Link liveness, page side (C-4). Back online, or back to the front after RESUME_PROBE_MS hidden: the link may have
  // died without a close (Wi-Fi switch, sleep, a NAT timeout) and nothing else would notice while the board is quiet,
  // so reconnect (the session handle's only lever; the hello's `since` keeps it a small catch-up). Both are jittered
  // (clock.random): a whole office's network coming back, or a whole all-hands switching back to the board at once,
  // must not arrive as one wave of hellos. The window follows the role (manager, p8-tidy): editors (presenters) are
  // few and need < 150 ms, so 0–2 s; annotators and viewers are the 100k, so 0–15 s (100k over 15 s is about 6.7k
  // hellos/s, versus 50k/s over 2 s). A role not known yet takes the wide window. The user's own click (Retry, the
  // pill) skips the jitter and cancels a probe still waiting. Gateway hello admission (engine) is the backstop.
  // The idle-link watchdog itself is sync.js's (J3, after engine's heartbeat E-1).
  // A tab coming back skips the reconnect when the room spoke within HEARD_MS (presence, here, emotes, records: any
  // room event): its link is alive, and on a busy all-hands that is every tab, so a mass return sends no hellos.
  const HEARD_MS = 10_000, PROBE_COALESCE_MS = 1000;
  let probeTimer = null, hiddenAt = null, heard = null, lastProbe = null;
  // A probe remembers two counts when armed and stands down at fire time if either moved: messages heard from the room
  // (S.onHeard: welcome, here, presence, … never a local action, p8-tidyv R2-L1), so the link is alive (H3); and hellos
  // the link sent (any reconnect: backoff, pill, Retry), so a hello is already out and waiting for its welcome
  // (R2-M2). Replacing either would send a second hello for one return, doubling a return wave.
  let heardN = 0;
  S.onHeard(() => { heard = { mono: clock.mono(), wall: clock.now() }; heardN++; });
  const since = t => Math.max(clock.mono() - t.mono, clock.now() - t.wall);
  const cancelProbe = () => { if (probeTimer != null) { clock.clear(probeTimer); probeTimer = null; } };
  // The user's own reconnect (Retry, the pill). One at a time (p8-tidyv L1): a second click while it is in flight does
  // nothing. In flight until the link's status next changes, or USER_RECONNECT_MS at most.
  const USER_RECONNECT_MS = 5000;
  let userReconnect = null;
  const endUserReconnect = () => { if (userReconnect != null) { clock.clear(userReconnect); userReconnect = null; } };
  S.onStatus(() => { endUserReconnect(); });
  function reconnectNow() {
    if (userReconnect != null) return;
    cancelProbe(); S.reconnect(); chromeDirty = true;
    userReconnect = clock.set(() => { userReconnect = null; }, USER_RECONNECT_MS);
  }
  const probe = () => {
    if (probeTimer != null) return;
    if (lastProbe && since(lastProbe) < PROBE_COALESCE_MS) return;
    const armed = heardN, armedHellos = S.connection.hellos;
    probeTimer = clock.set(() => {
      probeTimer = null;
      if (heardN !== armed) return;                        // heard since armed: the link is alive (H3)
      if (S.connection.hellos !== armedHellos) return;     // a hello went out since armed: wait for it (R2-M2)
      if (shouldProbe({ status: S.status, gesture: S.gesture })) {
        lastProbe = { mono: clock.mono(), wall: clock.now() };
        S.reconnect();
      }
    }, clock.random() * probeJitterMs(S.roleSeen ? S.effective : null));
  };
  addEventListener("online", () => { S.online = true; chromeDirty = true; probe(); });
  addEventListener("offline", () => { S.online = false; chromeDirty = true; });
  addEventListener("pageshow", e => {
    if (!e?.persisted) return;
    hiddenAt = null;
    if (heard && since(heard) <= HEARD_MS) return;
    probe();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { hiddenAt = { mono: clock.mono(), wall: clock.now() }; return; }
    const was = hiddenAt; hiddenAt = null;
    // Either clock: mono may not advance through a laptop's sleep on every platform; a false positive costs one reconnect.
    if (was && since(was) > RESUME_PROBE_MS && !(heard && since(heard) <= HEARD_MS)) probe();
  });
  matchMedia("(max-width: 640px)").addEventListener("change", () => { chromeDirty = true; });
  setTheme(ui.theme);
  let savedMine = 0, fitted = false, mineUser = me.user;
  function saveMine() {
    const u = S.connection.lastUser;
    if (u != null && u !== mineUser) {
      // Another user on this tab: the session has forgotten the old user's notes (S.mine reads the room's user), so
      // start from what is stored under the new user's key; the old user's key is never written again.
      mineUser = u;
      try { const v = JSON.parse(get(mineKeyOf(u)) ?? "[]"); if (Array.isArray(v)) for (const id of v) if (typeof id === "string") S.mine.add(id); } catch {}
      savedMine = S.mine.size; return;
    }
    if (S.mine.size !== savedMine) { savedMine = S.mine.size; put(mineKeyOf(mineUser), JSON.stringify([...S.mine].slice(-5000))); }
  }
  // First catch-up done: show everything once.
  function fitOnce() { if (fitted || S.status !== "live") return; fitted = true; if (S.eds.board.doc.live().length || S.eds.notes.doc.live().length) S.fit({ animate: false }); }
  let lastFrameAt = clock.mono();
  (function frame() {
    const nowAt = clock.mono(), dt = Math.max(0, Math.min(100, nowAt - lastFrameAt));
    lastFrameAt = nowAt;
    if (dt > 0) {
      if (S.eds.board.hasCameraMotion()) { S.eds.board.stepCamera(dt); S.eds.notes.view = { ...S.eds.board.view }; dirty = true; }
      else if (S.eds.notes.hasCameraMotion()) { S.eds.notes.stepCamera(dt); S.eds.board.view = { ...S.eds.notes.view }; dirty = true; }
    }
    const live = S.eds.board.needsTick() || S.eds.notes.needsTick();
    if (dirty || live || seen !== S.version()) { dirty = false; draw(); seen = S.version(); }
    collabTick();
    fitOnce();
    const f = S.takeFlash(); if (f) toast(f);
    chrome();
    saveMine();
    requestAnimationFrame(frame);
  })();

  let activeShare = null;
  function openShare() {
    if (!admin) return null;
    activeShare?.destroy();
    activeShare = mountShareDialog({
      root: $("#dialogs"),
      board,
      boardTitle: board,
      role: S.effective ?? me.role ?? "viewer",
      isAdmin: S.effective === "owner",
      admin,
      origin: globalThis.location?.origin ?? "",
      onClose: () => { activeShare = null; canvas.focus(); },
    });
    return activeShare;
  }
  if (notice) toast(notice, 6000);
  return { S, ui, net, collab, port, setTheme, openDialog, openShare, setPanel, startComment };
}
