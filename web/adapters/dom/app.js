// @ts-check
/**
 * @module web/adapters/dom/app
 * Canvas board DOM adapter: wires the core `Session` (`web/core/session.js`), Canvas2D renderer
 * (`./paint.js`), collaboration overlay (`./collab/ui.js`), inspector ribbon (`./panel.js`),
 * importers (`./importers.js`), board dialogs (`./board-dialogs.js`), and responsive mobile dock/sheets.
 *
 * Every mutation goes through `session.act` / `setTool` / `key`; nothing here touches the
 * wire protocol, transport, or authentication (`web/main.js`, the composition root, wires those).
 */

import { captureFocus, restoreFocus } from "./focus.js";
import { trapFocus, hasActiveOverlay } from "./a11y.js";
import { parsePanel, serializePanel, applyPanel, panelLayout, dragWidth, panelSections } from "../../../packages/core/panel.js";
import { isLabel, layerOf } from "../../../packages/core/model.js";
import { listNamedFrames, viewsOf, addView, deleteView, resolveLocalLayers, captureCurrentView, stepViewIndex } from "../../../packages/core/views.js";
import { parseLinkCardUrl, parseLinkCardFromElement } from "../../../packages/core/link-card.js";
import { parseEmbedFromElement, embedPlayButtonRect } from "../../../packages/core/embed.js";
import { buildTemplateScene, getTemplate } from "../../../packages/core/templates.js";
import { buildTableElements } from "../../../packages/core/metadata.js";
import { paint, imageCache, THEMES, color as safeColor, cappedDpr } from "./paint.js";
import { applyThemeToDom, prefersDarkScheme } from "./theme.js";
import { RASTER, VIDEO_MIME, createImporters } from "./importers.js";
import { createBoardDialogs } from "./board-dialogs.js";
import { restoreVersionSnapshot } from "./version-restore.js";
import { createFocusRestorer } from "./focus-restore.js";
import { toolsFor, pillFor, pillTitleFor, connectionBanner, expiryNotice, shouldProbe, RESUME_PROBE_MS } from "../../core/roles.js";

/**
 * Resume-probe jitter windows (ms) keyed by role class (`presenter` reconnects fast; `other` spreads waves).
 * @type {Readonly<{ presenter: number, other: number }>}
 */
export const PROBE_JITTER_MS = Object.freeze({ presenter: 2000, other: 15_000 });
/**
 * Return the resume-probe jitter window (ms) for `role` (`"presenter"` | `"annotator"` | `"viewer"` | null).
 * @param {string | null | undefined} role
 * @returns {number}
 */
export const probeJitterMs = role => (role === "presenter" ? PROBE_JITTER_MS.presenter : PROBE_JITTER_MS.other);
import { renderPanel, availableFor, loadLibrary, saveLibrary, propsModel } from "./panel.js";
import { shouldExpandRibbon } from "../../core/ribbon.js";
import { h, $, replace } from "./dom.js";
import { mountShareDialog } from "./admin.js";
import { icon } from "./icons.js";
import { buildTimeline, updateTimelineInPlace, prefersReducedMotion } from "./timeline.js";
import { timelineSpans, timelineTracks, cuesOf } from "../../../packages/core/anim.js";
import { cancelActiveSampler } from "./color-picker.js";
import { pillPopover } from "./explain.js";
import { openShare } from "./share.js";
import { createShareModel } from "../../core/share.js";
import { startMove } from "./move.js";
import { probeMove } from "../../core/move.js";
import { mountCollab } from "./collab/ui.js";
import { collabFrame } from "./collab/frame.js";
import { createVideoOverlay } from "./video-overlay.js";
import { createEmbedOverlay } from "./embed-overlay.js";
import { consumePendingTemplate } from "./home.js";
import { createContextMenu, buildCanvasMenuItems } from "./context-menu.js";
import { createLongPressTracker, buildMobileSelectionActions, renderSelectionActionSheet, renderRenameBoardSheet } from "./mobile-sheets.js";
import { createViewsMenu } from "./views-menu.js";
import { createSettingsDialog } from "./settings-dialog.js";
import { createVersionsDialog } from "./versions-dialog.js";
import { openHelpDialog, closeHelpDialog, isHelpDialogOpen } from "./help-dialog.js";
import {
  loadSettings,
  saveSettings,
  resetSettings,
  resolveKeybind,
  resolveTheme,
  effectiveKeybinds,
  formatCombo,
  parseDeepLink,
  buildDeepLink,
} from "../../core/settings.js";
import { hitTest, toLocal } from "../../../packages/core/geometry.js";

const RAW_BOARD_ID_RE = /^(?:b-[a-z0-9]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const CONTROL_BIDI_RE = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/gu;

/**
 * Return true if `id` looks like a raw generated board identifier (e.g. `b-z7r15i5cc4rk28d9`).
 * @param {unknown} id
 * @returns {boolean}
 */
export function isRawBoardId(id) {
  return typeof id === "string" && RAW_BOARD_ID_RE.test(id.trim());
}

/**
 * Resolve the user-facing board title, never showing a raw generated ID when untitled.
 * @param {string | null | undefined} boardId
 * @param {string | null} [customTitle]
 * @returns {string}
 */
export function formatBoardTitle(boardId, customTitle = null) {
  const cleaned = typeof customTitle === "string" ? customTitle.replace(CONTROL_BIDI_RE, "").trim() : "";
  if (cleaned) return cleaned.slice(0, 200);
  if (!boardId || isRawBoardId(boardId)) return "Untitled board";
  return String(boardId);
}

/**
 * Format `document.title` for the active board.
 * @param {string} displayTitle
 * @returns {string}
 */
export function formatDocumentTitle(displayTitle) {
  return `${displayTitle || "Untitled board"} — Plenary`;
}

/**
 * Mount the page on index.html's DOM.
 * @param {{ startSession: (o: { mine: string[], onChange: () => void }) => ReturnType<typeof import("../../core/session.js").createSession>,
 *           net: import("../../ports/net.js").Net, board: string, me: { user: string, name: string, role: string | null },
 *           prefs: import("../../ports/storage.js").Storage, theme?: string | null, notice?: string | null,
 *           collab?: ((S: any, o: { jumpTo(p: { x: number, y: number, scale?: number }): void }) => any) | null,
 *           clock: import("../../ports/clock.js").Clock, expAt?: number | null,
 *           relogin?: { href: string, go(): void } | null, onLogout?: (() => void) | null, admin?: any, homeHref?: string | null,
 *           access?: any, newKey?: (() => string) | null, share?: any, move?: any,
 *           versions?: import("../../ports/versions.js").VersionsPort | null, trashShown?: () => boolean,
 *           boardTitle?: string | null, getBoardTitle?: (() => Promise<any>) | null,
 *           renameBoard?: ((title: string) => Promise<any>) | null }} o
 *   collab: the root's collab port factory (web/ports/collab.js; production and dev: web/adapters/collab/sync.js over
 *   the session). The collaboration UI (./collab/ui.js) mounts over it: avatars, emotes, cursors, selections, laser,
 *   previews, comment threads. Without it the page has none of that.
 *   trashShown: true while the Trash notice stands over the page (the board is in Trash): the refused-sign-in banner is then hidden, since signing in again cannot help.
 *   startSession: the root's createSession with everything but the page's own bits. prefs: the per-browser store
 *   (local storage; a failing store reads as empty). notice: shown once (sign-in, share link).
 *   clock: the root's clock port (banner countdowns, the hidden-tab timer, the collab UI). expAt: when the sign-in
 *   ends (ms on the clock's now() scale), null when unknown: the page warns EXPIRY_WARN_MS before it. relogin: where
 *   a refused or expiring page signs in again (href shown, go() remembers the board and leaves); null = no link (dev).
 *   homeHref: where the top bar's Home link goes (the Home screen); null = no link (dev rooms).
 * @returns {{ S: any, ui: any, net: any, collab: any, port: any, setTheme(t: string): void, openDialog(d: string): void, openShare(): any, setPanel(op: any): void, startComment(p: { x: number, y: number }): void }}
 */
export function mountApp({ startSession, net, board, me, prefs, theme: theme0 = null, notice = null, collab: collabPort = null, clock, expAt = null, relogin = null, onLogout = null, admin = null, homeHref = null, access = null, newKey = null, share = null, move = null, versions = null, trashShown = () => false, boardTitle = null, getBoardTitle = null, renameBoard = null }) {
  if (!clock || typeof clock.now !== "function" || typeof clock.mono !== "function") throw new Error("mountApp: the clock port is required");
  const get = k => { try { return prefs.get(k); } catch { return null; } };
  const put = (k, v) => { try { prefs.set(k, v); } catch {} };
  let userSettings = loadSettings(prefs);
  const initialTheme = theme0 === "dark" || theme0 === "light"
    ? theme0
    : resolveTheme(userSettings.defaultTheme, prefersDarkScheme());
  const ui = {
    theme: initialTheme,
    settings: userSettings,
    workspaceMode: /** @type {"draw" | "animate" | "present"} */ ("draw"),
    modeMenuOpen: false,
    timelineExpanded: false,
    panel: parsePanel(get("plenary.panel")), drawer: null, sheet: null, dialog: null, colorPicker: null, colorPickerState: { h: null, mode: "hex" }, library: loadLibrary(prefs),
    ribbon: { pinnedOpen: false, manualCollapsed: false, showAll: false, lastSelSig: "" },
    localView: { soloLayerId: null, activeViewId: null },
    renamingBoard: false,
    mermaid: { src: "flowchart LR\n  A[Idea] --> B[Spec]\n  B --> C{Review?}\n  C -->|yes| D[Build]\n  C -->|no| B\n  D --> E[Ship]", elbow: true },
    embed: { url: "", error: "" },
    export: { format: "svg", scale: 2, page: "board", frameId: null },
  };
  const syncWorkspaceModeAttr = mode => {
    document.body?.setAttribute?.("data-workspace-mode", mode);
    document.documentElement?.setAttribute?.("data-workspace-mode", mode);
  };
  syncWorkspaceModeAttr(ui.workspaceMode);
  let currentBoardTitle = typeof boardTitle === "string" ? boardTitle.replace(CONTROL_BIDI_RE, "").trim() : null;
  let serverCanRename = null;
  const displayBoardTitle = () => formatBoardTitle(board, currentBoardTitle);
  const syncDocumentTitle = () => {
    try {
      if (document && typeof document === "object") document.title = formatDocumentTitle(displayBoardTitle());
    } catch {}
  };
  syncDocumentTitle();
  const resolveTitle = typeof getBoardTitle === "function"
    ? () => getBoardTitle()
    : (typeof admin?.getBoard === "function" ? () => admin.getBoard(board) : null);
  const doRenameBoard = typeof renameBoard === "function"
    ? t => renameBoard(t)
    : (typeof admin?.renameBoard === "function"
      ? t => admin.renameBoard(board, t)
      : (typeof admin?.updateBoard === "function" ? t => admin.updateBoard(board, { title: t }) : null));
  // The notes this person made on this board, kept per user (p8-one-linkv L8): the key follows the user the room says
  // this tab is (welcome.user), so after a same-tab switch to another user the emptied set never overwrites the old
  // user's stored one. Before the first welcome it is the sign-in's user.
  const mineKeyOf = user => `plenary.mine.${board}.${user}`;
  const mineKey = mineKeyOf(me.user);
  let chromeDirty = true, syncMove = () => {};
  if (move && (typeof move.port?.options !== "function" || typeof move.clock?.mono !== "function")) throw new TypeError("mountApp: move must be { port: MovePort, clock, newKey? }");
  const isNarrowPhone = () => matchMedia("(max-width: 640px)").matches;
  const isPhone = () => isNarrowPhone() || matchMedia("(max-width: 1023px)").matches;
  const isCompactPhone = () => isNarrowPhone() || (isPhone() && matchMedia("(orientation: landscape) and (max-height: 520px)").matches);
  let mobileDefaultToolApplied = false;
  const S = startSession({
    mine: (() => { try { const v = JSON.parse(get(mineKey) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } })(),
    onChange: () => {
      if (!mobileDefaultToolApplied && S.chrome && isPhone()) {
        mobileDefaultToolApplied = true;
        if (S.tool !== "hand") S.setTool("hand");
      }
      chromeDirty = true;
      syncMove();
    },
  });
  S.eds.board.style.roughness = userSettings.roughDefault;
  S.eds.notes.style.roughness = userSettings.roughDefault;
  if (!ui.drawer && me.role === "annotator") ui.drawer = "notes";
  net.onFile(file => { S.receiveFiles({ [file.id]: file }); });
  // A picture that could not be saved for everyone (PROTOCOL.md § Blobs): it shows here, but nobody else will see it.
  const WHY = { quota: "the storage quota is full", forbidden: "you can't upload here", "too-large": "it is over 10 MB", "not-image": "it is not a PNG, JPEG, GIF or WebP", "gave-up": "the server could not be reached (still trying)", busy: "the server is busy (still trying)", limit: "too many uploads at once (still trying)" };
  net.onFail?.(({ code, retrying }) => toast(`The picture ${retrying ? "is not saved for others yet" : "was not saved for others"}: ${WHY[code] ?? code}`, 6000));

  const isCoarse = () => matchMedia("(pointer: coarse)").matches;
  const INK_KEYBOARD_PAD_PX = 24;
  let lastPointerTouch = false;
  let onViewportChange = () => {};
  // Sync Chrome-on-iOS / WKWebView visual viewport (dynamic toolbar & software keyboard) to CSS custom properties.
  const vv = globalThis.visualViewport;
  const syncVisualViewport = () => {
    const root = document.documentElement?.style;
    if (root) {
      if (vv && Number.isFinite(vv.height) && vv.height > 0) {
        root.setProperty("--vv-height", `${Math.round(vv.height)}px`);
        root.setProperty("--vv-top", `${Math.max(0, Math.round(vv.offsetTop || 0))}px`);
      } else {
        root.setProperty("--vv-height", "100dvh");
        root.setProperty("--vv-top", "0px");
      }
    }
    onViewportChange();
  };
  syncVisualViewport();
  if (vv && typeof vv.addEventListener === "function") {
    vv.addEventListener("resize", syncVisualViewport);
    vv.addEventListener("scroll", syncVisualViewport);
  }
  let closeMoreMenu = null;
  let closeMoreMenuNow = () => {};
  let closeModeMenu = null;
  /** @type {(focusTrigger?: boolean) => void} */
  let closeModeMenuNow = () => {};
  document.addEventListener("click", e => {
    closeMoreMenu?.(e);
    closeModeMenu?.(e);
    if (ui.colorPicker && !isPhone()) {
      const inside = matchUp(e.target, x => hasClass(x, "color-popover") || Boolean(attrOf(x, "data-color-popover")));
      if (!inside) { cancelActiveSampler(); ui.colorPicker = null; chromeDirty = true; }
    }
  });
  const canvas = $("#board"), ink = $("#ink"), ctx = canvas.getContext("2d");
  const { captureOpener, restoreOpener, visibleControl } = createFocusRestorer({ isPhone, defaultFallback: canvas });
  const allFiles = () => ({ ...S.eds.notes.doc.files, ...S.eds.board.doc.files });

  // ── collaboration (p7-wire): the collab UI over the root's port, presence painted on its own canvas ──
  const videoOverlay = createVideoOverlay({ root: $("#canvas") });
  const embedOverlay = createEmbedOverlay({ root: $("#canvas") });
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
    onList: which => { if (isPhone()) setSheet(which); else { ui.drawer = which; chromeDirty = true; } } }) : null;
  if (collab) collab.showDrawer("comments");
  const worldAt = p => S.eds.board.toWorld(p);
  // Selection presence and pin layout, once per frame (./collab/frame.js).
  const collabTick = collab ? collabFrame(/** @type {any} */ (S), collab) : () => {};
  // Right-click (or the 💬 button): a comment on the element under the pointer, else on that spot.
  function startComment(p) {
    if (!collab) return;
    const w = worldAt(p), n = S.eds.notes, b = S.eds.board;
    const hitN = hitTest(n.doc, w, n.tol()), hitB = hitN ? null : hitTest(b.doc, w, b.tol());
    const el = hitN ?? hitB, on = el ? { stream: hitN ? "notes" : "board", element: isLabel(el) && el.containerId ? el.containerId : el.id } : null;
    collab.startComment(w, on);
  }
  const contextMenu = createContextMenu({ host: document.body, doc: document });

  // ── Named Jump-to-Frame, Local Solo Layer & Named Presentation Views (#115) ──
  // Local layer visibility (Solo Layer / active View filter) is strictly viewer-local:
  // it applies via Doc.setLocalLayerFilter without EVER mutating shared appState.herdr.layers.
  const resolvedLocalView = () => resolveLocalLayers(S.eds.board.doc.layers, ui.localView, viewsOf(S.eds.board.doc));
  let lastLocalDocRev = -1, lastLocalSolo = null, lastLocalViewId = null, lastLocalActive = false, preLocalActiveLayer = null;
  function syncLocalLayerFilter({ force = false } = {}) {
    const B = S.eds.board;
    if (!force && B.doc.rev === lastLocalDocRev && ui.localView.soloLayerId === lastLocalSolo && ui.localView.activeViewId === lastLocalViewId) return;
    const hadLocal = lastLocalActive || Boolean(lastLocalSolo) || Boolean(lastLocalViewId);
    const hasLocalReq = Boolean(ui.localView.soloLayerId) || Boolean(ui.localView.activeViewId);
    if (!force && !hadLocal && !hasLocalReq) {
      lastLocalDocRev = B.doc.rev;
      return;
    }
    const views = viewsOf(B.doc);
    const resolved = resolveLocalLayers(B.doc.layers, ui.localView, views);
    if (ui.localView.soloLayerId && !resolved.soloLayerId) ui.localView.soloLayerId = null;
    if (ui.localView.activeViewId && !resolved.activeViewId) ui.localView.activeViewId = null;
    B.doc.setLocalLayerFilter(resolved.filter);
    lastLocalDocRev = B.doc.rev;
    lastLocalSolo = ui.localView.soloLayerId;
    lastLocalViewId = ui.localView.activeViewId;
    lastLocalActive = resolved.active;
    if (resolved.filter) {
      // Why: if the local solo/view filter hides the active drawing layer, remember `preLocalActiveLayer`
      // and switch locally so new shapes don't land invisibly, and prune hidden `B.sel` items without
      // ever mutating shared `appState.herdr.layers`.
      if (!resolved.filter(B.activeLayer)) {
        if (preLocalActiveLayer == null) preLocalActiveLayer = B.activeLayer;
        const fallback = resolved.soloLayerId ?? resolved.layers.find(l => l.effectiveVisible)?.id ?? null;
        if (fallback) B.activeLayer = fallback;
      }
      for (const id of [...B.sel]) {
        const el = B.doc.get(id);
        if (el && !resolved.filter(layerOf(el))) B.sel.delete(id);
      }
    } else if (preLocalActiveLayer != null) {
      if (B.doc.layers.some(l => l.id === preLocalActiveLayer)) B.activeLayer = preLocalActiveLayer;
      preLocalActiveLayer = null;
    }
    B.changed();
    dirty = true;
    chromeDirty = true;
    viewsMenu.refresh();
  }
  function toggleSoloLayer(layerId) {
    if (typeof layerId !== "string" || !layerId) return;
    const nextSolo = ui.localView.soloLayerId === layerId ? null : layerId;
    if (nextSolo && !ui.localView.soloLayerId && !ui.localView.activeViewId) preLocalActiveLayer = S.eds.board.activeLayer;
    ui.localView = { soloLayerId: nextSolo, activeViewId: null };
    syncLocalLayerFilter({ force: true });
  }
  function resetLocalView() {
    if (!ui.localView.soloLayerId && !ui.localView.activeViewId) return;
    ui.localView = { soloLayerId: null, activeViewId: null };
    syncLocalLayerFilter({ force: true });
  }
  function jumpToFrame(frameId, opts) {
    const B = S.eds.board;
    const fs = listNamedFrames(B.doc);
    const idx = fs.findIndex(f => f.id === frameId);
    const frame = idx >= 0 ? B.doc.get(frameId) : null;
    if (!frame) return false;
    B.frameAt = frame.id;
    S.eds.notes.cancelCamera();
    B.fit([frame], 24, opts);
    S.syncView("board");
    B.flash = `${fs[idx].rawName || "Frame"} · ${idx + 1} of ${fs.length}`;
    dirty = true;
    chromeDirty = true;
    return true;
  }
  function stepBoardFrame(step, opts) {
    const B = S.eds.board;
    const fs = listNamedFrames(B.doc);
    if (!fs.length) { S.stepFrame(step, opts); return false; }
    const i = fs.findIndex(f => f.id === B.frameAt);
    const next = i < 0 ? (step > 0 ? 0 : fs.length - 1) : (i + step + fs.length) % fs.length;
    return jumpToFrame(fs[next].id, opts);
  }
  function activateView(viewId, opts) {
    const views = viewsOf(S.eds.board.doc);
    const view = views.find(v => v.id === viewId);
    if (!view) return false;
    ui.localView = { soloLayerId: null, activeViewId: view.id };
    syncLocalLayerFilter({ force: true });
    if (view.frameId) jumpToFrame(view.frameId, opts);
    toast(`View: ${view.name}`, 1400);
    return true;
  }
  function stepView(delta, opts) {
    const views = viewsOf(S.eds.board.doc);
    if (!views.length) {
      toast("No saved views yet — press ⌘J to save one");
      return false;
    }
    const next = stepViewIndex(views, ui.localView.activeViewId, delta);
    if (!next) return false;
    return activateView(next.id, opts);
  }
  function saveCurrentView(name = "") {
    if (S.role !== "presenter" || !S.may()) return null;
    const B = S.eds.board;
    const selFrames = B.selected().filter(e => e.type === "frame");
    const frameId = selFrames.length === 1 ? selFrames[0].id : (B.frameAt ?? null);
    const view = captureCurrentView(B.doc, ui.localView, { name, frameId });
    const ok = S.act("board", e => e.setAppState({ views: addView(e.doc, view) }), { settings: true });
    if (!ok) return null;
    ui.localView = { soloLayerId: null, activeViewId: view.id };
    syncLocalLayerFilter({ force: true });
    toast(`Saved view: ${view.name}`, 1600);
    return view;
  }
  function deleteSavedView(viewId) {
    if (S.role !== "presenter" || !S.may()) return false;
    const ok = S.act("board", e => e.setAppState({ views: deleteView(e.doc, viewId) }), { settings: true });
    if (!ok) return false;
    if (ui.localView.activeViewId === viewId) ui.localView = { ...ui.localView, activeViewId: null };
    syncLocalLayerFilter({ force: true });
    return true;
  }
  const viewsMenu = createViewsMenu({
    host: document.body,
    doc: document,
    getState: () => ({
      frames: listNamedFrames(S.eds.board.doc),
      views: viewsOf(S.eds.board.doc),
      activeFrameId: S.eds.board.frameAt ?? null,
      localView: resolvedLocalView(),
      canSave: S.role === "presenter" && S.may(),
    }),
    onJumpFrame: id => { jumpToFrame(id); },
    onSelectView: id => { activateView(id); },
    onStepView: delta => { stepView(delta); },
    onSaveView: name => saveCurrentView(name),
    onDeleteView: id => { deleteSavedView(id); },
    onResetLocalView: () => { resetLocalView(); },
    onSoloLayer: id => { toggleSoloLayer(id); },
    onRestoreFocus: saved => restoreOpener(saved, visibleControl(["[data-views-open]"]) ?? canvas),
    onClose: () => {
      const btn = document.querySelector?.("[data-views-open]");
      btn?.setAttribute?.("aria-expanded", "false");
    },
  });
  function openViewsMenu(opener = null) {
    if (viewsMenu.isOpen()) { viewsMenu.close({ restoreFocus: true }); return; }
    dismissOverlays();
    const savedOpener = captureOpener(opener);
    const btn = document.querySelector?.("[data-views-open]");
    btn?.setAttribute?.("aria-expanded", "true");
    viewsMenu.open({ opener: savedOpener });
  }

  // ── Customizable User Settings & Keybindings (#116) ──
  function applyUserSettings(next, { fromDialog = false } = {}) {
    const prev = userSettings;
    userSettings = saveSettings(prefs, next);
    ui.settings = userSettings;
    if (userSettings.roughDefault !== prev.roughDefault) {
      S.eds.board.style.roughness = userSettings.roughDefault;
      if (!S.penStyle) S.eds.notes.style.roughness = userSettings.roughDefault;
    }
    if (fromDialog && userSettings.defaultTheme !== prev.defaultTheme) {
      setTheme(resolveTheme(userSettings.defaultTheme, prefersDarkScheme()));
    }
    chromeDirty = true;
  }
  const settingsDialog = createSettingsDialog({
    host: document.body,
    doc: document,
    getSettings: () => userSettings,
    getTargets: () => ({
      frames: listNamedFrames(S.eds.board.doc),
      views: viewsOf(S.eds.board.doc),
    }),
    onChange: next => applyUserSettings(next, { fromDialog: true }),
    onReset: () => {
      const prev = userSettings;
      userSettings = resetSettings(prefs);
      ui.settings = userSettings;
      S.eds.board.style.roughness = userSettings.roughDefault;
      if (!S.penStyle) S.eds.notes.style.roughness = userSettings.roughDefault;
      if (userSettings.defaultTheme !== prev.defaultTheme) {
        setTheme(resolveTheme(userSettings.defaultTheme, prefersDarkScheme()));
      }
      chromeDirty = true;
      toast("Settings reset to defaults");
      return userSettings;
    },
    onRestoreFocus: saved => restoreOpener(saved, visibleControl([".header-more", "[data-dock-more]"]) ?? canvas),
  });
  /**
   * @param {any} [opener]
   * @param {"preferences" | "keybindings"} [tab]
   */
  function openSettingsDialog(opener = null, tab = "preferences") {
    if (settingsDialog.isOpen()) { settingsDialog.close({ restoreFocus: true }); return; }
    dismissOverlays();
    const savedOpener = captureOpener(opener);
    settingsDialog.open({ opener: savedOpener, tab });
  }

  // ── Board Version History & Named Snapshots (#19) ──
  const versionsDialog = versions
    ? createVersionsDialog({
      host: document.body,
      doc: document,
      board,
      versions,
      clock,
      canWrite: () => S.role === "presenter" && S.may(),
      getSnapshot: () => S.eds.board.doc.toScene(),
      onRestore: version => restoreVersionSnapshot(version, { S, toast, onDirty: () => { dirty = true; chromeDirty = true; } }),
      onToast: (msg, ms) => toast(msg, ms),
      onRestoreFocus: saved => restoreOpener(saved, visibleControl([".header-more", "[data-dock-more]"]) ?? canvas),
    })
    : null;
  function openVersionsDialog(opener = null) {
    if (!versionsDialog) return;
    if (versionsDialog.isOpen()) { versionsDialog.close({ restoreFocus: true }); return; }
    dismissOverlays();
    const savedOpener = captureOpener(opener);
    versionsDialog.open({ opener: savedOpener });
  }
  function openHelp(opener = null) {
    if (isHelpDialogOpen(document)) {
      closeHelpDialog({ doc: document, restoreFocus: true });
      return;
    }
    dismissOverlays();
    const savedOpener = captureOpener(opener);
    openHelpDialog({
      opener: savedOpener,
      doc: document,
      userSettings,
      onRestoreFocus: saved => restoreOpener(saved, visibleControl([".header-more", "[data-dock-more]"]) ?? canvas),
    });
  }

  // ── Deep Links to Frame / Element / View (#22) ──
  let pendingDeepLink = parseDeepLink(globalThis.location);
  function applyDeepLink(target, { animate = true } = {}) {
    if (!target) return false;
    if (target.kind === "frame") return jumpToFrame(target.id, { animate });
    if (target.kind === "view") return activateView(target.id, { animate });
    if (target.kind === "el") {
      const bEl = S.eds.board.doc.get(target.id);
      const nEl = !bEl || bEl.isDeleted ? S.eds.notes.doc.get(target.id) : null;
      const hit = (bEl && !bEl.isDeleted)
        ? { stream: /** @type {const} */ ("board"), el: bEl }
        : (nEl && !nEl.isDeleted)
          ? { stream: /** @type {const} */ ("notes"), el: nEl }
          : null;
      if (!hit) return false;
      S.eds.notes.cancelCamera();
      S.eds.board.fit([hit.el], 64, { animate });
      S.syncView("board");
      const canSelect = hit.stream === "board"
        ? S.role === "presenter"
        : (S.effective === "presenter" || (S.effective !== "viewer" && S.isMine(hit.el.id)));
      if (canSelect) {
        const ed = S.eds[hit.stream];
        const other = S.eds[hit.stream === "board" ? "notes" : "board"];
        other.select([]);
        if (S.role === "presenter") S.active = hit.stream;
        ed.select(ed.withGroup(hit.el));
      }
      dirty = true;
      chromeDirty = true;
      return true;
    }
    return false;
  }
  function activateFrameBindTarget(target) {
    if (typeof target !== "string" || !target) return false;
    const ok = target.startsWith("view:")
      ? activateView(target.slice(5))
      : target.startsWith("frame:")
        ? jumpToFrame(target.slice(6))
        : (jumpToFrame(target) || activateView(target));
    if (!ok) toast("Bound frame or view not found on this board");
    return ok;
  }
  function pasteAtPoint(worldPoint) {
    if (!S.may()) { toast("View only: nothing is pasted"); return; }
    const clip = globalThis.navigator?.clipboard;
    if (typeof clip?.readText === "function") {
      clip.readText().then(text => {
        if (!S.may()) return;
        if (text) pasteText(text, worldPoint);
        else { S.paste(undefined, worldPoint); chromeDirty = true; }
      }).catch(() => {
        if (!S.may()) return;
        S.paste(undefined, worldPoint);
        chromeDirty = true;
      });
      return;
    }
    S.paste(undefined, worldPoint);
    chromeDirty = true;
  }
  function copyElementDeepLink(selectedList, fallbackEl = null) {
    const els = (selectedList ?? []).filter(el => el && !isLabel(el));
    const primary = els[0] ?? fallbackEl;
    if (!primary) return;
    const isFrame = els.length <= 1 && primary.type === "frame";
    const loc = globalThis.location;
    const url = buildDeepLink({
      origin: loc?.origin ?? "",
      pathname: loc?.pathname ?? "/",
      search: loc?.search ?? "",
      kind: isFrame ? "frame" : "el",
      id: primary.id,
    });
    if (!url) return;
    const clip = globalThis.navigator?.clipboard;
    const label = isFrame ? "Copied link to frame" : "Copied link to selection";
    if (typeof clip?.writeText === "function") {
      Promise.resolve(clip.writeText(url))
        .then(() => toast(label))
        .catch(() => toast("Couldn't copy link"));
    } else {
      toast("Clipboard unavailable");
    }
  }
  function canWriteSelection(stream, els) {
    if (!S.may() || !S.canWriteStream(stream)) return false;
    if (stream === "board") return true;
    if (S.effective === "presenter") return true;
    return els.length > 0 && els.every(el => S.isMine(el.id));
  }
  let actionSheetCtx = null;
  function resolveActionSheetSelection() {
    const stream = actionSheetCtx?.stream ?? (activeStream() === "notes" ? "notes" : "board");
    const ed = S.eds[stream];
    const selected = actionSheetCtx?.selectedIds?.length
      ? actionSheetCtx.selectedIds.map(id => ed.doc.get(id)).filter(e => e && !e.isDeleted && !isLabel(e))
      : (ed ? ed.selected().filter(e => e && !isLabel(e)) : []);
    const hitEl = actionSheetCtx?.hitId ? (ed.doc.get(actionSheetCtx.hitId) ?? selected[0] ?? null) : (selected[0] ?? null);
    return { stream, ed, selected, hitEl };
  }
  function openSelectionActionSheet({ stream = null, selected = null, hitEl = null, point = null, opener = null } = {}) {
    const targetStream = stream ?? (activeStream() === "notes" ? "notes" : "board");
    const ed = S.eds[targetStream];
    const rawList = selected ?? (ed ? ed.selected() : []);
    const els = rawList.filter(el => el && !isLabel(el));
    if (!els.length) return false;
    const canWrite = canWriteSelection(targetStream, els);
    const items = buildMobileSelectionActions({
      canWrite,
      canComment: Boolean(collab),
      selected: els,
      actions: {
        duplicate: () => {}, del: () => {}, copyLink: () => {}, group: () => {}, ungroup: () => {},
        reorder: () => {}, toggleLock: () => {}, tidy: () => {}, spliceImage: () => {}, addComment: () => {},
      },
    });
    if (!items.length) return false;
    actionSheetCtx = {
      stream: targetStream,
      selectedIds: els.map(e => e.id),
      hitId: (hitEl ?? els[0])?.id ?? null,
      point: point ?? null,
    };
    setSheet("actions", { opener });
    return true;
  }
  function hitElementAt(p) {
    const w = worldAt(p);
    const n = S.eds.notes, b = S.eds.board;
    const hitN = hitTest(n.doc, w, n.tol()), hitB = hitN ? null : hitTest(b.doc, w, b.tol());
    const rawHit = hitN ?? hitB;
    const hitStream = hitN ? /** @type {const} */ ("notes") : hitB ? /** @type {const} */ ("board") : null;
    if (!rawHit || !hitStream) return null;
    const ed = S.eds[hitStream];
    const hitEl = isLabel(rawHit) && rawHit.containerId ? (ed.doc.get(rawHit.containerId) ?? rawHit) : rawHit;
    return { hitEl, hitStream, ed };
  }
  const longPress = createLongPressTracker({
    clock,
    onLongPress: ({ point, pointerId }) => {
      if (!isPhone()) return;
      const hit = hitElementAt(point);
      if (!hit) return;
      const { hitEl, hitStream, ed } = hit;
      S.pointerCancel(point, { pointerId, pointerType: "touch", button: "left" });
      const canSelectHit = hitStream === "board"
        ? S.role === "presenter"
        : (S.effective === "presenter" || (S.effective !== "viewer" && S.isMine(hitEl.id)));
      if (canSelectHit && !ed.sel.has(hitEl.id)) {
        const other = S.eds[hitStream === "board" ? "notes" : "board"];
        other.select([]);
        if (S.role === "presenter") S.active = hitStream;
        ed.select(ed.withGroup(hitEl));
      }
      const selectedList = ed.sel.has(hitEl.id) ? ed.selected() : [hitEl];
      openSelectionActionSheet({ stream: hitStream, selected: selectedList, hitEl, point, opener: canvas });
      chromeDirty = true;
    },
  });
  canvas.addEventListener("contextmenu", e => {
    e.preventDefault();
    dismissOverlays();
    const p = at(e);
    const w = worldAt(p);
    const n = S.eds.notes, b = S.eds.board;
    const hitN = hitTest(n.doc, w, n.tol()), hitB = hitN ? null : hitTest(b.doc, w, b.tol());
    const rawHit = hitN ?? hitB;
    const hitStream = hitN ? "notes" : hitB ? "board" : null;
    let hitEl = null;
    let canWriteHit = false;
    if (rawHit && hitStream) {
      const ed = S.eds[hitStream];
      hitEl = isLabel(rawHit) && rawHit.containerId ? (ed.doc.get(rawHit.containerId) ?? rawHit) : rawHit;
      const canEditTarget = hitStream === "board"
        ? S.canWriteStream("board")
        : (S.canWriteStream("notes") && (S.effective === "presenter" || S.isMine(hitEl.id)));
      canWriteHit = canEditTarget;
      const canSelectHit = hitStream === "board"
        ? S.role === "presenter"
        : (S.effective === "presenter" || (S.effective !== "viewer" && S.isMine(hitEl.id)));
      if (canSelectHit && !ed.sel.has(hitEl.id)) {
        const other = S.eds[hitStream === "board" ? "notes" : "board"];
        other.select([]);
        if (S.role === "presenter") S.active = hitStream;
        ed.select(ed.withGroup(hitEl));
        chromeDirty = true;
      }
    }
    const stream = hitStream ?? (activeStream() === "notes" ? "notes" : "board");
    const ed = S.eds[stream];
    const mode = hitEl ? "element" : "canvas";
    const canWrite = mode === "element" ? canWriteHit : S.canWriteStream(stream);
    const copyToSystemClipboard = text => {
      if (!text) return;
      try { globalThis.navigator?.clipboard?.writeText?.(text)?.catch?.(() => {}); } catch {}
    };
    const items = buildCanvasMenuItems({
      mode,
      may: S.may(),
      canWrite,
      canPaste: S.may(),
      canComment: Boolean(collab),
      canAnnotate: S.effective !== "viewer",
      stream,
      selected: hitEl ? (ed.sel.has(hitEl.id) ? ed.selected() : [hitEl]) : [],
      layers: S.eds.board.doc.layers,
      activeLayer: S.eds.board.activeLayer,
      actions: {
        cut: () => {
          if (!canWrite) return;
          const t = S.eds[stream].copy();
          if (t) { S.act(stream, x => x.deleteIds([...x.sel])); copyToSystemClipboard(t); }
          chromeDirty = true;
        },
        copy: () => {
          const t = S.eds[stream].copy();
          copyToSystemClipboard(t);
        },
        pasteHere: () => pasteAtPoint(w),
        duplicate: () => { S.act(stream, x => x.cloneSelection(20, 20)); chromeDirty = true; },
        del: () => { S.act(stream, x => x.deleteIds([...x.sel])); chromeDirty = true; },
        group: () => { S.act(stream, x => x.group()); chromeDirty = true; },
        ungroup: () => { S.act(stream, x => x.ungroup()); chromeDirty = true; },
        tidy: () => { S.act(stream, x => x.tidySelection()); chromeDirty = true; },
        reorder: how => { S.act(stream, x => x.reorder(how)); chromeDirty = true; },
        moveToLayer: layerId => { S.act("board", x => x.moveToLayer(layerId)); chromeDirty = true; },
        toggleLock: () => { S.act(stream, x => x.toggleLock()); chromeDirty = true; },
        fitToChildren: () => {
          const selectedList = hitEl ? (ed.sel.has(hitEl.id) ? ed.selected() : [hitEl]) : [];
          const frames = selectedList.filter(el => el && !isLabel(el) && el.type === "frame" && ed.doc.editable(el));
          if (frames.length !== 1) return;
          const frameId = frames[0].id;
          let editable = false;
          let fitted = false;
          let hasChildren = false;
          const acted = S.act(stream, x => {
            const liveFrame = x.doc.get(frameId);
            if (!liveFrame || !x.doc.editable(liveFrame)) return;
            editable = true;
            hasChildren = x.doc.live().some(c => !isLabel(c) && c.frameId === frameId);
            fitted = Boolean(x.fitContainerToChildren(frameId));
          });
          if (!acted || !editable) return;
          if (fitted) toast("Fitted frame to children", 1600);
          else if (!hasChildren) toast("Frame has no children to fit", 1800);
          else toast("Frame already fits children", 1600);
          chromeDirty = true;
        },
        spliceImage: (cols, rows) => {
          const selectedList = hitEl ? (ed.sel.has(hitEl.id) ? ed.selected() : [hitEl]) : [];
          const imgs = selectedList.filter(el => el && !isLabel(el) && el.type === "image");
          if (imgs.length !== 1) return;
          S.act(stream, x => x.spliceImage(imgs[0].id, { cols, rows }));
          chromeDirty = true;
        },
        copyLink: () => {
          const selectedList = hitEl ? (ed.sel.has(hitEl.id) ? ed.selected() : [hitEl]) : [];
          copyElementDeepLink(selectedList, hitEl);
        },
        addComment: () => startComment(p),
        selectAll: () => { S.key("a", { cmd: true }); chromeDirty = true; },
        addStickyNote: () => { S.placeNote(w); chromeDirty = true; },
        zoomToFit: () => { S.fit(); chromeDirty = true; },
        resetZoom: () => { S.zoomAt(1); chromeDirty = true; },
      },
    });
    const x = typeof e.clientX === "number" ? e.clientX : p.x;
    const y = typeof e.clientY === "number" ? e.clientY : p.y;
    contextMenu.open({ x, y, items, opener: canvas });
  });
  const image = imageCache(allFiles, () => { dirty = true; });
  let dirty = true, seen = -1;

  // ── painting ──
  function draw() {
    syncLocalLayerFilter();
    const theme = THEMES[ui.theme];
    const items = S.displayList(theme);
    // A picture whose bytes haven't arrived is drawn by core as a dashed box (render.js); its bytes are asked for here
    // (the net dedupes, paces and rests; a picture the server doesn't have stays a dashed box).
    for (const [id, stamp] of S.missing()) net.want?.(id, stamp);
    // Pictures that came in with pasted elements or a library item hold their bytes here only (files never travel in ops): put them on the server too.
    for (const f of S.unsavedFiles()) net.put?.(f);
    const { w, h: hh } = S.eds.board.size;
    paint(ctx, items, { width: w, height: hh, dpr: canvas.width / Math.max(1, w), background: theme.bg, image });
    const visibleElements = [...S.eds.board.doc.visible(), ...(S.eds.board.time() == null ? S.eds.notes.doc.visible() : [])];
    const selectedIds = new Set([...S.eds.board.sel, ...S.eds.notes.sel]);
    videoOverlay.sync({
      displayItems: items,
      elements: visibleElements,
      files: allFiles(),
      view: S.eds.board.view,
      viewport: { w, h: hh },
      selectedIds,
      dragging: !!S.gesture,
    });
    embedOverlay.sync({
      elements: visibleElements,
      view: S.eds.board.view,
      viewport: { w, h: hh },
      selectedIds,
      dragging: !!S.gesture,
    });
    canvas.style.cursor = S.may() || S.tool === "hand" ? S.ed.cursor() ?? "default" : "grab";
    syncText();
  }

  function ensureInkVisible({ forceFocused = false } = {}) {
    const curVv = globalThis.visualViewport;
    if (!curVv || !Number.isFinite(curVv.height) || curVv.height <= 0) return;
    if (!isCoarse() && !lastPointerTouch) return;
    const ed = S.textEditor();
    if (!ed || !ed.textBox()) return;
    if (ink.style.display === "none") return;
    if (!forceFocused && document.activeElement !== ink) return;
    const rect = ink.getBoundingClientRect();
    const vvTop = Math.max(0, curVv.offsetTop || 0);
    const visibleBottom = vvTop + curVv.height - INK_KEYBOARD_PAD_PX;
    if (rect.bottom <= visibleBottom) return;
    const overflowPx = rect.bottom - visibleBottom;
    const maxUpPx = Math.max(0, rect.top - (vvTop + 16));
    const shiftPx = Math.min(overflowPx, maxUpPx);
    if (shiftPx <= 1) return;
    const B = S.eds.board;
    const scale = B.view.scale || 1;
    S.eds.notes.cancelCamera();
    B.animateViewTo({ ...B.view, y: B.view.y - shiftPx / scale });
    dirty = true;
  }
  onViewportChange = () => ensureInkVisible();

  function syncText() {
    const ed = S.textEditor(), box = ed?.textBox();
    if (!box) { if (ink.style.display !== "none") { ink.style.display = "none"; ink.value = ""; } return; }
    const wasHidden = ink.style.display === "none" || !ink.style.display;
    const fontSize = isCoarse() ? Math.max(16, box.size) : box.size;
    Object.assign(ink.style, { display: "block", left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px`, fontSize: `${fontSize}px`, textAlign: box.align });
    if (ink.value !== ed.text.value) ink.value = ed.text.value;
    if (document.activeElement !== ink) { ink.focus(); ink.setSelectionRange(ink.value.length, ink.value.length); }
    if (wasHidden) ensureInkVisible({ forceFocused: true });
  }
  ink.addEventListener("input", () => { S.textEditor()?.setText(ink.value); ensureInkVisible(); });
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

  // Strict https:// re-validation right before opening an external link card URL.
  function openSafeLink(rawUrl) {
    const parsed = parseLinkCardUrl(rawUrl);
    if (!parsed) return false;
    const opener = globalThis.window?.open ?? globalThis.open;
    if (typeof opener === "function") opener.call(globalThis.window ?? globalThis, parsed.url, "_blank", "noopener,noreferrer");
    return true;
  }
  function findLinkCardHit(p, { badgeOnly = true } = {}) {
    for (const ed of [S.eds.notes, S.eds.board]) {
      const hit = ed.linkCardAt(p, { badgeOnly });
      if (hit) return hit;
    }
    return null;
  }
  function findEmbedHit(p, { playOnly = true } = {}) {
    for (const ed of [S.eds.notes, S.eds.board]) {
      const w = ed.toWorld(p);
      const hit = hitTest(ed.doc, w, ed.tol());
      if (!hit) continue;
      const embed = parseEmbedFromElement(hit);
      if (!embed) continue;
      if (playOnly) {
        const btn = embedPlayButtonRect(hit);
        if (!btn) continue;
        const loc = hit.angle ? toLocal(hit, w) : w;
        if (loc.x < btn.x || loc.x > btn.x + btn.w || loc.y < btn.y || loc.y > btn.y + btn.h) continue;
      }
      return { el: hit, embed };
    }
    return null;
  }

  // Pointer input: core Editor owns multi-touch (pinch-zoom/pan, 2/3-finger tap undo/redo, palm rejection).
  canvas.addEventListener("pointerdown", e => {
    lastPointerTouch = e.pointerType === "touch";
    canvas.focus(); canvas.setPointerCapture?.(e.pointerId); e.preventDefault();
    if (ui.sheet) setSheet(null, { restore: false });
    if (ui.colorPicker && !isPhone()) { cancelActiveSampler(); ui.colorPicker = null; chromeDirty = true; }
    clicks = Math.max(e.detail || 0, countClick(e));
    if (S.tool === "image") { openPicker(); return; }
    const p = at(e);
    if (e.button === 0 && !space && (S.tool === "select" || S.tool === "hand" || !S.may())) {
      const badgeOnly = !(e.metaKey || e.ctrlKey) && clicks < 2;
      const linkHit = findLinkCardHit(p, { badgeOnly });
      if (linkHit) {
        openSafeLink(linkHit.card.url);
        chromeDirty = true;
        return;
      }
      const embedHit = findEmbedHit(p, { playOnly: clicks < 2 });
      if (embedHit) {
        embedOverlay.activate(embedHit.el.id);
        chromeDirty = true;
        return;
      }
    }
    S.pointerDown(p, pmods(e));
    longPress.onPointerDown(e, p);
    if (collab && S.tool === "laser" && e.button === 0 && S.ed.pointers.size <= 1) collab.laser(worldAt(p));
  });
  canvas.addEventListener("pointermove", e => {
    const highRate = S.gesture && (S.tool === "freedraw" || S.tool === "highlighter" || S.tool === "laser");
    const coalesced = highRate && typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : null;
    if (coalesced && coalesced.length > 0) {
      for (const ce of coalesced) {
        const cp = at(ce);
        longPress.onPointerMove(ce, cp);
        S.pointerMove(cp, pmods(ce, e));
        if (collab && S.tool === "laser" && S.gesture && (ce.buttons & 1) && S.ed.pointers.size <= 1) collab.laser(worldAt(cp));
      }
      if (collab && S.ed.pointers.size <= 1) collab.pointer(worldAt(at(e)));
      return;
    }
    const p = at(e);
    longPress.onPointerMove(e, p);
    S.pointerMove(p, pmods(e));
    if (collab && S.ed.pointers.size <= 1) {
      const w = worldAt(p);
      collab.pointer(w);
      if (S.tool === "laser" && S.gesture && (e.buttons & 1)) collab.laser(w);
    }
  });
  canvas.addEventListener("pointerup", e => {
    longPress.onPointerUp(e);
    S.pointerUp(at(e), pmods(e)); chromeDirty = true;
    collabTick();
  });
  canvas.addEventListener("pointercancel", e => {
    longPress.onPointerCancel(e);
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
    /^(BUTTON|A|SUMMARY)$/.test(tagOf(x)) || attrOf(x, "role") === "button" || attrOf(x, "role") === "slider"
  );
  const isSlider = el => matchUp(el, x => attrOf(x, "role") === "slider");

  // Coexist `#dialogs` (mermaid/embed/export/share) with `document.body`-mounted modals
  // (`help-dialog.js`, `views-menu.js`, `settings-dialog.js`, `versions-dialog.js`, `move.js`) via `a11y.js`.
  const hasOpenDialog = () => Boolean($("#dialogs")?.childNodes?.length) || hasActiveOverlay();

  document.addEventListener("keydown", e => {
    if (e.defaultPrevented) return;
    const t = e.target;
    const k0 = keyName(e), m0 = mods(e);
    const resolved = resolveKeybind(userSettings, e);
    if (resolved?.kind === "action" && resolved.action === "action.views" && viewsMenu.isOpen()) {
      e.preventDefault(); e.stopPropagation?.();
      viewsMenu.close({ restoreFocus: true });
      return;
    }
    if (resolved?.kind === "action" && resolved.action === "action.settings" && settingsDialog.isOpen()) {
      e.preventDefault(); e.stopPropagation?.();
      settingsDialog.close({ restoreFocus: true });
      return;
    }
    // Why: `?` close-toggle runs before `hasOpenDialog()` so an open Help modal can toggle itself
    // closed even though its own `trapFocus` overlay makes `hasOpenDialog()` return `true`.
    if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey && !isEditable(t) && isHelpDialogOpen(document)) {
      e.preventDefault(); e.stopPropagation?.();
      closeHelpDialog({ doc: document, restoreFocus: true });
      return;
    }
    if (hasOpenDialog() || isEditable(t) || inDialog(t) || isSlider(t)) return;   // inputs, dialogs, sliders keep their keys
    if (e.key === "Escape" && ui.colorPicker && !isPhone()) {
      e.preventDefault(); e.stopPropagation?.();
      cancelActiveSampler();
      ui.colorPicker = null;
      chromeDirty = true;
      return;
    }
    if (e.key === "Escape" && ui.modeMenuOpen) {
      e.preventDefault(); e.stopPropagation?.();
      closeModeMenuNow(true);
      return;
    }
    if (e.key === "Escape" && ui.workspaceMode === "present" && !ui.sheet && !ui.moreOpen && !viewsMenu.isOpen() && !settingsDialog.isOpen() && !versionsDialog?.isOpen() && !isHelpDialogOpen(document)) {
      e.preventDefault(); e.stopPropagation?.();
      setWorkspaceMode("draw");
      return;
    }
    if (isInteractive(t) && (e.key === "Enter" || e.key === " " || e.code === "Space")) return;   // let focused buttons/links activate
    if (e.key === " " || e.code === "Space") space = true;
    const k = k0, m = m0;

    if (resolved?.kind === "frameBind") {
      e.preventDefault(); e.stopPropagation?.();
      activateFrameBindTarget(resolved.target);
      return;
    }
    if (resolved?.kind === "action") {
      const act = resolved.action;
      if (act.startsWith("tool.")) {
        const toolId = act.slice(5);
        if (S.setTool(toolId)) { e.preventDefault(); e.stopPropagation?.(); chromeDirty = true; }
        else if (!S.may() && toolId !== "hand") { e.preventDefault(); e.stopPropagation?.(); }
        return;
      }
      if (act === "action.views") { e.preventDefault(); e.stopPropagation?.(); openViewsMenu(); return; }
      if (act === "action.settings") { e.preventDefault(); e.stopPropagation?.(); openSettingsDialog(); return; }
      if (act === "action.export") { e.preventDefault(); e.stopPropagation?.(); if (S.role === "presenter") openDialog("export"); return; }
      if (act === "action.panel") { if (S.role === "presenter") { e.preventDefault(); e.stopPropagation?.(); setPanel({ type: "open" }); } return; }
      if (act === "action.grid") {
        if (S.role === "presenter" && S.may()) {
          e.preventDefault(); e.stopPropagation?.();
          S.act("board", ed => ed.setAppState({ grid: ed.grid ? 0 : 20 }), { settings: true });
          chromeDirty = true;
        }
        return;
      }
      if (act === "action.toolLock") { if (S.may()) { e.preventDefault(); e.stopPropagation?.(); S.toggleLock(); chromeDirty = true; } return; }
      if (act === "action.fit") { e.preventDefault(); e.stopPropagation?.(); S.fit(); chromeDirty = true; return; }
      if (act === "action.zoomReset") { e.preventDefault(); e.stopPropagation?.(); S.zoomAt(1); chromeDirty = true; return; }
      if (act === "action.zoomIn") { e.preventDefault(); e.stopPropagation?.(); S.zoomAt(Math.min(ZOOM_MAX, S.eds.board.view.scale * 1.25)); chromeDirty = true; return; }
      if (act === "action.zoomOut") { e.preventDefault(); e.stopPropagation?.(); S.zoomAt(Math.max(ZOOM_MIN, S.eds.board.view.scale / 1.25)); chromeDirty = true; return; }
      if (act === "action.nextFrame") { e.preventDefault(); e.stopPropagation?.(); stepBoardFrame(1); return; }
      if (act === "action.prevFrame") { e.preventDefault(); e.stopPropagation?.(); stepBoardFrame(-1); return; }
    }
    if (resolved?.kind === "unbound") {
      return;
    }
    if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation?.();
      openHelp();
      return;
    }

    if (!m.cmd && !m.ctrl && !m.alt && !m.shift && (e.key === "[" || e.key === "]")) {
      const hasSel = (activeEditor()?.sel?.size ?? 0) > 0;
      if ((!S.may() || !hasSel) && viewsOf(S.eds.board.doc).length > 0) {
        e.preventDefault(); e.stopPropagation?.();
        stepView(e.key === "]" ? 1 : -1);
        return;
      }
    }
    if (S.key(k, m)) { e.preventDefault(); e.stopPropagation?.(); chromeDirty = true; }
  });
  document.addEventListener("keyup", e => { if (e.key === " " || e.code === "Space") space = false; });

  // Clipboard: the browser's own events (so paste runs once), images included.
  const hasSelection = () => Boolean(globalThis.getSelection?.()?.toString());
  const onCanvas = (e, { checkSelection = false } = {}) => {
    const t = e?.target ?? document.activeElement;
    if (hasOpenDialog() || isEditable(t) || inDialog(t)) return false;
    if (document.activeElement && (isEditable(document.activeElement) || inDialog(document.activeElement))) return false;
    // Why: only let a non-empty browser text selection block copy/cut when focus is outside `#board`
    // (preserving native text copying in the Notes/Comments drawer without blocking canvas copy).
    if (checkSelection && document.activeElement !== canvas && hasSelection()) return false;
    return true;
  };
  document.addEventListener("copy", e => { if (!onCanvas(e, { checkSelection: true })) return; const t = S.copy(); if (t) { e.clipboardData.setData("text/plain", t); e.preventDefault(); } });
  document.addEventListener("cut", e => { if (!onCanvas(e, { checkSelection: true }) || !S.may()) return; const t = S.cut(); if (t) { e.clipboardData.setData("text/plain", t); e.preventDefault(); } });
  document.addEventListener("paste", e => {
    if (!onCanvas(e)) return;
    e.preventDefault();
    if (!S.may()) return toast("View only: nothing is pasted");
    const files = [...(e.clipboardData?.files ?? [])].filter(f => f.type.startsWith("image/") || f.type.startsWith("video/"));
    if (files.length) return files.forEach(f => (f.type.startsWith("video/") ? addVideoFile(f) : addPicture(f)));
    const text = e.clipboardData?.getData("text/plain");
    if (text) { pasteText(text); }
  });

  // Explicit clipboard read for mobile (Chrome on iOS / WKWebView): must be invoked directly from a tap gesture
  // so iOS displays its native Paste confirmation pill and returns ClipboardItem[].
  let pasting = false;
  async function pasteFromClipboard() {
    if (pasting) return false;
    if (!S.may()) { toast("View only: nothing is pasted"); return false; }
    const clip = globalThis.navigator?.clipboard;
    pasting = true;
    try {
      if (typeof clip?.read === "function") {
        let items;
        try {
          items = await clip.read();
        } catch (err) {
          if (err?.name === "NotAllowedError" || err?.name === "SecurityError") toast("Clipboard paste was cancelled");
          else if (err?.name === "NotFoundError" || err?.name === "DataError") toast("Nothing to paste from clipboard");
          else toast("Couldn't read clipboard — try Photo / Video");
          return false;
        }
        if (!S.may()) { toast("View only: nothing is pasted"); return false; }
        const list = Array.isArray(items) ? items : [...(items ?? [])];
        if (!list.length) { toast("Nothing to paste from clipboard"); return false; }
        try {
          let pastedMedia = false;
          for (const item of list) {
            const types = Array.isArray(item?.types) ? item.types : [...(item?.types ?? [])];
            const imgType = types.find(t => RASTER.test(t));
            if (imgType) {
              const blob = await item.getType(imgType);
              if (!blob) continue;
              const pic = RASTER.test(blob.type) ? blob : new Blob([blob], { type: imgType });
              await addPicture(pic);
              pastedMedia = true;
              continue;
            }
            const vidType = types.find(t => VIDEO_MIME.test(t));
            if (vidType) {
              const blob = await item.getType(vidType);
              if (!blob) continue;
              const vid = VIDEO_MIME.test(blob.type) ? blob : new Blob([blob], { type: vidType });
              await addVideoFile(vid);
              pastedMedia = true;
            }
          }
          if (pastedMedia) return true;
          for (const item of list) {
            const types = Array.isArray(item?.types) ? item.types : [...(item?.types ?? [])];
            if (!types.includes("text/plain")) continue;
            const blob = await item.getType("text/plain");
            const text = blob ? await blob.text() : "";
            if (text) {
              if (!S.may()) { toast("View only: nothing is pasted"); return false; }
              await pasteText(text);
              return true;
            }
          }
        } catch (err) {
          if (err?.name === "NotAllowedError" || err?.name === "SecurityError") toast("Clipboard paste was cancelled");
          else toast("Couldn't read clipboard — try Photo / Video");
          return false;
        }
        toast("Nothing to paste from clipboard");
        return false;
      }
      if (typeof clip?.readText === "function") {
        try {
          const text = await clip.readText();
          if (text) {
            if (!S.may()) { toast("View only: nothing is pasted"); return false; }
            await pasteText(text);
            return true;
          }
          toast("Nothing to paste — use Photo / Video for images");
          return false;
        } catch (err) {
          if (err?.name === "NotAllowedError" || err?.name === "SecurityError") toast("Clipboard paste was cancelled");
          else toast("Clipboard unavailable — use Photo / Video for images");
          return false;
        }
      }
      toast("Clipboard unavailable — use Photo / Video for images");
      return false;
    } finally {
      pasting = false;
    }
  }

  // Pictures, videos, diagrams and libraries: drop, paste, the Image tool's picker.
  const { addPicture, addVideoFile, pasteText, takeFiles } = createImporters({
    S,
    net,
    clock,
    toast,
    getLibrary: () => ui.library,
    setLibrary,
    onDirty: () => { chromeDirty = true; },
  });
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
    const frames = listNamedFrames(B.doc);
    const marks = [...new Set(live.map(e => e.customData?.anim?.start).filter(Number.isFinite))];
    const spans = timelineSpans(live);
    const tracks = timelineTracks(B.doc);
    const cues = cuesOf(B.doc);
    const spansSig = JSON.stringify(spans.map(s => [s.id, s.preset, s.start, s.duration, s.easing, s.loop]));
    const tracksSig = JSON.stringify(tracks.map(t => [t.id, t.label, t.preset, t.start, t.duration, t.easing, t.loop, t.order]));
    const cuesSig = JSON.stringify(cues.map(c => [c.id, c.at, c.label]));
    const maxCueAt = cues.length ? cues[cues.length - 1].at : 0;
    return { frames, framesSig: JSON.stringify(frames.map(f => [f.id, f.name ?? ""])), marks, spans, spansSig, tracks, tracksSig, cues, cuesSig, dur: Math.max(B.duration(), maxCueAt), counts: JSON.stringify(counts) };
  });
  const notesCount = () => notesInfo(S.eds.notes.doc).notes.length;
  // Updated in place every frame (cheap compares), never by a rebuild: the zoom % and the connection pill.
  const zoomPct = h("span.pct");
  const tl = { fill: null, head: null, needle: null, text: null, track: null, sig: "" };
  function timelineInPlace() {
    if ((!tl.fill && !tl.needle) || S.role !== "presenter") return;
    const B = S.eds.board, { dur } = boardInfo(B.doc);
    updateTimelineInPlace(tl, B, dur);
  }
  // The pill: a click while not live reconnects now (the user's own click skips the resume jitter, C-4 / p8-tidy).
  // A view-only pill is a button: it opens the explanation of the role (PROTOCOL.md § Access explanation and requests): focusable, Enter and Space, Escape closes and returns focus.
  const pillEl = h("span.pill", { onclick: () => { if (explainable()) { why.toggle(); return; } if (S.status !== "live" && shouldProbe({ status: S.status, gesture: S.gesture })) reconnectNow(); },
    onkeydown: e => { if (explainable() && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); why.toggle(); } } });
  const explainable = () => !!access && pillEl.classList.contains("readonly");
  const why = pillPopover({ pill: pillEl, board, access, newKey, explain: access ? async () => { const r = await access.explainBoard(board); return r.why ? { why: r.why } : { error: r.error }; } : null });
  let pillSig = "";
  function inPlace() {
    timelineInPlace();
    const z = `${Math.round(S.eds.board.view.scale * 100)}%`;
    if (zoomPct.textContent !== z) zoomPct.textContent = z;
    const pill = pillFor({ status: S.status, online: S.online, pending: S.pending, role: S.effective, readOnly: S.readOnly, congested: S.congested });
    const can = !!access && pill.cls === "readonly";
    const title = pillTitle(pill.cls) + (can ? " Press to see why." : "");
    const sig = JSON.stringify([pill, title]);
    if (sig === pillSig) return;
    pillSig = sig;
    pillEl.className = `pill ${pill.cls}`; pillEl.title = title;
    if (can) { pillEl.setAttribute?.("role", "button"); pillEl.setAttribute?.("tabindex", "0"); pillEl.setAttribute?.("aria-haspopup", "dialog"); if (!pillEl.hasAttribute?.("aria-expanded")) pillEl.setAttribute?.("aria-expanded", "false"); }
    else { for (const a of ["role", "tabindex", "aria-haspopup", "aria-expanded"]) pillEl.removeAttribute?.(a); if (why.isOpen()) why.close(false); }
    replace(pillEl, h("span.dot"), pill.text, pill.sub ? h("span.sub", {}, ` · ${pill.sub}`) : null);
  }
  let toastTimer = null;
  function toast(text, ms = 1800) {
    const el = $("#toast");
    el.setAttribute?.("role", "status");
    el.setAttribute?.("aria-live", "polite");
    el.setAttribute?.("aria-atomic", "true");
    el.textContent = text; el.hidden = false;
    if (toastTimer != null) clock.clear(toastTimer);
    toastTimer = clock.set(() => { toastTimer = null; el.hidden = true; }, ms);
  }
  const setPanel = op => { const n = applyPanel(ui.panel, op); if (n !== ui.panel) { ui.panel = n; put("plenary.panel", serializePanel(n)); if (!n.open) cancelActiveSampler(); } chromeDirty = true; };
  function setLibrary(items) { ui.library = items; saveLibrary(prefs, items); chromeDirty = true; }
  const setTheme = t => {
    ui.theme = applyThemeToDom(t);
    dirty = true;
    chromeDirty = true;
    collab?.setTheme(ui.theme);
  };
  let activeShare = null, dialogOpener = null, sheetTrap = null, sheetTrapKind = null, sheetOpener = null, sheetBackdropEl = null, sheetHistoryPushed = false;
  function pushSheetHistory(name) {
    const hist = globalThis.history;
    if (!hist || typeof hist.pushState !== "function") return;
    try {
      if (!sheetHistoryPushed) {
        hist.pushState({ plenarySheet: name }, "");
        sheetHistoryPushed = true;
      } else if (typeof hist.replaceState === "function") {
        hist.replaceState({ plenarySheet: name }, "");
      }
    } catch {}
  }
  function popSheetHistory({ fromPopstate = false } = {}) {
    if (!sheetHistoryPushed) return;
    sheetHistoryPushed = false;
    if (fromPopstate) return;
    const hist = globalThis.history;
    if (!hist || typeof hist.back !== "function") return;
    const hasState = "state" in hist && hist.state !== undefined;
    if (!hasState || hist.state?.plenarySheet) {
      try { hist.back(); } catch {}
    }
  }
  function ensureSheetBackdrop() {
    if (sheetBackdropEl && sheetBackdropEl.parentNode) return sheetBackdropEl;
    const existing = $("#sheetBackdrop");
    if (existing) {
      sheetBackdropEl = existing;
      if (!existing._plenaryBound) {
        existing._plenaryBound = true;
        existing.addEventListener("click", () => setSheet(null));
      }
      return existing;
    }
    const sheetEl = $("#sheet");
    if (!sheetEl?.parentNode) return null;
    const bd = h("div.sheet-backdrop", { id: "sheetBackdrop", "aria-hidden": "true", hidden: true, onclick: () => setSheet(null) });
    sheetEl.parentNode.append(bd);
    sheetBackdropEl = bd;
    return bd;
  }
  function dismissOverlays({ keepSheet = false, keepDialog = false } = {}) {
    contextMenu.close({ restoreFocus: false });
    viewsMenu.close({ restoreFocus: false });
    settingsDialog.close({ restoreFocus: false });
    versionsDialog?.close({ restoreFocus: false });
    closeHelpDialog({ doc: document, restoreFocus: false });
    if (ui.moreOpen) closeMoreMenuNow();
    if (why.isOpen()) why.close(false);
    if (!keepSheet && !isPhone() && ui.colorPicker) {
      cancelActiveSampler();
      ui.colorPicker = null;
    }
    if (!keepSheet && ui.sheet) {
      ui.sheet = null;
      actionSheetCtx = null;
      popSheetHistory();
      sheetTrap?.deactivate({ restoreFocus: false });
      sheetTrap = null;
      sheetTrapKind = null;
      sheetOpener = null;
      const bd = ensureSheetBackdrop();
      if (bd) bd.hidden = true;
    }
    if (!keepDialog) {
      if (activeShare) { activeShare.destroy(); activeShare = null; }
      if (ui.dialog || $("#dialogs")?.childNodes?.length) {
        ui.dialog = null;
        // Why: clear `#dialogs` synchronously and mark `chromeDirty` so an external dismissal
        // never leaves orphaned modal DOM wedging `hasOpenDialog()` when `chrome()` short-circuits.
        boardDialogs.deactivate();
        dialogOpener = null;
        chromeDirty = true;
      }
    }
  }
  function setSheet(next, { opener = null, restore = true, fromPopstate = false } = {}) {
    if (next) {
      dismissOverlays({ keepSheet: true });
      if (!ui.sheet) sheetOpener = captureOpener(opener);
      if (next !== "actions") actionSheetCtx = null;
      ui.sheet = next;
      pushSheetHistory(next);
    } else {
      ui.sheet = null;
      actionSheetCtx = null;
      popSheetHistory({ fromPopstate });
      const prevOpener = sheetOpener;
      sheetOpener = null;
      if (sheetTrap) { sheetTrap.deactivate({ restoreFocus: false }); sheetTrap = null; sheetTrapKind = null; }
      const bd = ensureSheetBackdrop();
      if (bd) bd.hidden = true;
      if (restore) restoreOpener(prevOpener, visibleControl(["[data-dock-more]", ".overflow-btn"]) ?? canvas);
    }
    chromeDirty = true;
  }
  function openDialog(d, opener = null) {
    cancelActiveSampler();
    dismissOverlays({ keepDialog: false });
    if (d === "embed") ui.embed.error = "";
    dialogOpener = captureOpener(opener);
    ui.dialog = d;
    chromeDirty = true;
  }
  const activeStream = () => (S.role === "annotator" ? "notes" : S.active);
  const activeEditor = () => S.eds[activeStream()];
  const undoRedoState = () => {
    const may = S.may(), ed = activeEditor();
    return { canUndo: may && (ed?.undoStack?.length ?? 0) > 0, canRedo: may && (ed?.redoStack?.length ?? 0) > 0 };
  };

  const toolKeyDisp = t => {
    const eff = effectiveKeybinds(userSettings)[`tool.${t.id}`];
    if (eff !== undefined) return eff ? formatCombo(eff) : "";
    return t.keys?.[0] ? t.keys[0].toUpperCase() : "";
  };
  function toolButton(t, extra = "") {
    const disabled = t.id !== "hand" && !S.may();
    const kd = toolKeyDisp(t);
    return h(`button.tb${S.tool === t.id ? ".on" : ""}${extra}`, { title: `${t.name}${kd ? " — " + kd : ""}`, "aria-label": t.name, "aria-pressed": String(S.tool === t.id), disabled, "data-tool": t.id,
      onclick: () => { if (t.id === "image") { S.setTool("image"); openPicker(); } else S.setTool(t.id); canvas.focus(); chromeDirty = true; } },
    h("span.ic", {}, icon(t.id, { size: 18 })), kd ? h("span.k", {}, kd) : null);
  }

  // Share (PROTOCOL.md § Share dialog): offered only when the welcome said `can.share` (members.manage on the board); if that changed mid-session the server answers 403 and the dialog says so.
  // The chrome is rebuilt while the dialog is open, so focus goes back to whichever of the Share button and the More button is shown now, not to the element that opened it.
  const shareOpener = { focus() { const c = /** @type {(HTMLElement | null)[]} */ ([document.querySelector("[data-share-open]"), document.querySelector(".header-more"), document.querySelector("[data-dock-more]")]); (c.find(e => e && e.offsetParent !== null) ?? c.find(Boolean))?.focus?.(); } };
  function openShareDialog() {
    dismissOverlays();
    if (!share) return openAdminShare();
    const loc = globalThis.location, origin = loc?.origin ?? "", boardUrl = `${origin}${loc?.pathname ?? "/"}?board=${encodeURIComponent(board)}`;
    const model = createShareModel({ share, access, board, newKey, now: () => clock.now(), urls: { board: boardUrl, link: id => `${origin}/links/${encodeURIComponent(id)}` } });
    return openShare({ host: document.body, model, opener: shareOpener, accessHref: `${loc?.pathname ?? "/"}?access=board:${encodeURIComponent(board)}`, now: () => clock.now() });
  }

  // Move to… (PROTOCOL.md § Move board, "Where it appears"): offered only when the welcome said `can.move` (no request to find out), unless the move route has since refused this person
  // (`denied`: a 403 or 404 after a move or an Undo; a new welcome that says `can.move` clears it). The Space shown beside the board name is read from that route's `from`, only by a person
  // the welcome let move, once the welcome has come and again after a move or an Undo. A failed read leaves the item in place and the name unshown. `moveGen` drops an outdated answer.
  const moveInfo = { space: null, denied: false };
  let moveGen = 0, moveWelcomed = false, booted = false, moveSeenWelcome = -1;
  const canMove = () => !!move && S.canMove === true && !moveInfo.denied;
  const refreshMove = () => {
    if (!move || S.canMove !== true) return Promise.resolve();
    const mine = ++moveGen;
    return probeMove(move.port, board).then(r => {
      if (mine !== moveGen) return;
      if (r.can === false) moveInfo.denied = true;
      else if (r.can === true) moveInfo.space = r.space;
      chromeDirty = true;
    });
  };
  /** After every session change: a welcome that newly says can.move clears a refusal and reads the Space once. */
  syncMove = () => {
    if (!booted || !move) return;
    // Every welcome that says can.move clears an earlier refusal (a reconnect after a 403 offers Move again) and reads the Space.
    if (S.canMove === true && (!moveWelcomed || S.welcomes !== moveSeenWelcome)) { moveWelcomed = true; moveSeenWelcome = S.welcomes; moveInfo.denied = false; chromeDirty = true; refreshMove(); }
    else if (S.canMove !== true && moveWelcomed) { moveWelcomed = false; moveInfo.space = null; chromeDirty = true; }
  };
  // Escape and Cancel return focus to a control that is on screen at this width (the chrome is rebuilt meanwhile): the Move or Share button, else the More button.
  const moveOpener = { focus() { (visibleControl(["[data-move-open]", ".header-more", "[data-dock-more]"]) ?? canvas)?.focus?.(); } };
  const openMoveDialog = () => { dismissOverlays(); chromeDirty = true; startMove({ host: document.body, move, board, opener: moveOpener, reload: refreshMove, restoreFocus: () => canvas.focus?.() }); };
  booted = true; syncMove();

  let userRenamed = false, renameGen = 0, focusBoardTitleAfterRename = false;
  if (resolveTitle) {
    Promise.resolve().then(resolveTitle).then(res => {
      if (!res || userRenamed) return;
      const t = typeof res === "string"
        ? res
        : (typeof res.title === "string" ? res.title : (typeof res.board?.title === "string" ? res.board.title : null));
      if (typeof res === "object" && typeof res.canRename === "boolean") serverCanRename = res.canRename;
      if (t !== null && !ui.renamingBoard) {
        const cleaned = t.replace(CONTROL_BIDI_RE, "").trim();
        if (cleaned || currentBoardTitle == null) {
          currentBoardTitle = cleaned;
          syncDocumentTitle();
          chromeDirty = true;
        }
      } else if (typeof res === "object" && typeof res.canRename === "boolean") {
        chromeDirty = true;
      }
    }).catch(() => {});
  }

  const canRenameBoard = () => Boolean(doRenameBoard) && S.role === "presenter" && S.may() && serverCanRename !== false;
  function startBoardRename(opener = null) {
    if (!canRenameBoard()) return false;
    if (isNarrowPhone()) {
      setSheet("rename", { opener });
      return true;
    }
    dismissOverlays();
    ui.renamingBoard = true;
    chromeDirty = true;
    return true;
  }
  function commitBoardRename(raw) {
    const cleaned = typeof raw === "string" ? raw.replace(CONTROL_BIDI_RE, "").trim().slice(0, 200) : "";
    ui.renamingBoard = false;
    if (!cleaned || cleaned === (currentBoardTitle ?? "")) {
      chromeDirty = true;
      return;
    }
    const prev = currentBoardTitle;
    const gen = ++renameGen;
    userRenamed = true;
    currentBoardTitle = cleaned;
    syncDocumentTitle();
    chromeDirty = true;
    Promise.resolve().then(() => doRenameBoard?.(cleaned)).then(res => {
      if (gen !== renameGen) return;
      if (res && typeof res === "object" && res.error) {
        currentBoardTitle = prev;
        syncDocumentTitle();
        chromeDirty = true;
        toast("Couldn't rename board");
        return;
      }
      const canonical = typeof res?.board?.title === "string" ? res.board.title.trim()
        : (typeof res?.title === "string" ? res.title.trim() : null);
      if (canonical !== null && canonical !== currentBoardTitle) {
        currentBoardTitle = canonical;
        syncDocumentTitle();
        chromeDirty = true;
      }
    }).catch(() => {
      if (gen !== renameGen) return;
      currentBoardTitle = prev;
      syncDocumentTitle();
      chromeDirty = true;
      toast("Couldn't rename board");
    });
  }
  function openExcalidrawImport() {
    if (!S.may()) return;
    picker.click();
  }
  function insertSwimlane() {
    if (S.role !== "presenter" || !S.may()) return;
    /** @type {string[]} */
    let ids = [];
    const acted = S.act("board", ed => {
      ids = ed.addSwimlane({
        title: "Swimlane",
        lanes: ["Lane 1", "Lane 2", "Lane 3"],
      });
    });
    if (acted && ids.length) {
      toast("Inserted swimlane", 1600);
      chromeDirty = true;
    }
  }
  function insertTable() {
    if (S.role !== "presenter" || !S.may()) return;
    /** @type {string[]} */
    let ids = [];
    const acted = S.act("board", ed => {
      const elements = buildTableElements({
        rows: 3,
        cols: 3,
        layer: ed.activeLayer,
      });
      const center = ed.toWorld({ x: ed.size.w / 2, y: ed.size.h / 2 });
      ids = ed.insertElements(elements, undefined, center);
    });
    if (acted && ids.length) {
      toast("Inserted table", 1600);
      chromeDirty = true;
    }
  }

  const boardModeration = () => {
    const raw = S.eds.board.doc.appState?.herdr?.moderation;
    const locked = raw?.locked === true;
    const mutedUsers = Array.isArray(raw?.mutedUsers)
      ? [...new Set(raw.mutedUsers.filter(u => typeof u === "string" && u.length >= 1 && u.length <= 128))].slice(0, 200)
      : [];
    return { locked, mutedUsers };
  };
  const toggleAudienceLock = () => {
    if (S.role !== "presenter" || !S.may()) return;
    const { locked, mutedUsers } = boardModeration();
    const next = !locked;
    const ok = S.act("board", e => e.setAppState({ moderation: { locked: next, mutedUsers } }), { settings: true });
    if (!ok) return;
    chromeDirty = true;
    toast(next ? "Audience edits locked" : "Audience edits unlocked", 2000);
  };

  /**
   * Switch presenter workspace mode: Draw (default), Animate (movie timeline), or Present (distraction-free).
   * @param {"draw" | "animate" | "present"} mode
   */
  function setWorkspaceMode(mode) {
    if (S.role !== "presenter" || S.effective !== "presenter") return false;
    if (mode !== "draw" && mode !== "animate" && mode !== "present") return false;
    ui.modeMenuOpen = false;
    if (ui.workspaceMode === mode) { closeModeMenuNow(); return true; }
    ui.workspaceMode = mode;
    syncWorkspaceModeAttr(mode);
    if (mode === "animate") {
      ui.timelineExpanded = !isCompactPhone();
    } else if (mode === "draw") {
      ui.timelineExpanded = false;
    } else if (mode === "present") {
      dismissOverlays();
      ui.drawer = null;
      cancelActiveSampler();
    }
    chromeDirty = true;
    dirty = true;
    return true;
  }

  function topbar() {
    const role = S.role, tools = toolsFor(role), may = S.may();
    const { locked: audienceLocked } = boardModeration();
    const core = tools.filter(t => !["image", "note", "highlighter"].includes(t.id)), extras = tools.filter(t => ["image", "note", "highlighter"].includes(t.id));
    const toggleDrawer = type => { ui.drawer = ui.drawer === type ? null : type; chromeDirty = true; };
    const toggleNotes = () => { ui.drawer = ui.drawer ? null : "notes"; chromeDirty = true; };
    const toggleTheme = () => {
      const next = ui.theme === "dark" ? "light" : "dark";
      setTheme(next);
      applyUserSettings({ ...userSettings, defaultTheme: next });
    };
    const toggleGrid = () => { S.act("board", e => e.setAppState({ grid: e.grid ? 0 : 20 }), { settings: true }); chromeDirty = true; };
    const togglePanel = () => setPanel({ type: "open" });
    const toggleExport = () => openDialog("export");
    const gridOn = Boolean(S.eds.board.grid);
    const boardMenuItem = (icName, ariaLabel, visibleLabel, action, { disabled = false, kbd = "", badge = "", on = false } = {}) =>
      h("button.header-extra.btn.ghost.board-menu-item" + (on ? ".on" : ""), {
        type: "button", role: "menuitem", "aria-label": ariaLabel, title: visibleLabel, disabled,
        onclick: () => { setMore(false); action(); },
      },
      h("span.bm-ic", {}, icon(icName, { size: 15 })),
      h("span.bm-lab", {}, visibleLabel),
      badge ? h("span.bm-badge", {}, badge) : null,
      kbd ? h("kbd.bm-kbd", {}, kbd) : null);
    const menuSection = (title, items) => {
      const live = items.filter(Boolean);
      if (!live.length) return null;
      return h("div.bm-section", { role: "group", "aria-label": title },
        h("div.bm-section-head", { "aria-hidden": "true" }, title),
        live);
    };
    const moreOpen = !!ui.moreOpen;
    let menu;
    const menuItems = () => {
      const items = [];
      const visit = node => { for (const child of node?.children ?? []) { if (child.getAttribute("role") === "menuitem" && !child.disabled) items.push(child); else visit(child); } };
      visit(menu);
      return items;
    };
    const setMore = (open, focus = false) => {
      if (open) contextMenu.close({ restoreFocus: false });
      ui.moreOpen = open; more.setAttribute("aria-expanded", String(open)); menu.hidden = !open;
      if (focus) more.focus?.();
      else if (open) menuItems()[0]?.focus?.();
    };
    const more = h("button.tb.header-more", { type: "button", title: "Board menu", "aria-label": "More", "aria-haspopup": "menu", "aria-expanded": String(moreOpen), onclick: () => {
      setMore(!ui.moreOpen);
    }, onkeydown: e => {
      if (e.key === "ArrowDown" && !ui.moreOpen) { e.preventDefault(); setMore(true); }
      else if (e.key === "Escape" && ui.moreOpen) { e.preventDefault(); setMore(false, true); }
    } }, h("span.ic", {}, icon("menu", { size: 17 })), h("span.header-more-label", {}, "Menu"));
    const boardSection = menuSection("Board", [
      canRenameBoard() ? boardMenuItem("edit", "Rename board", "Rename board", () => startBoardRename()) : null,
      role === "presenter" ? boardMenuItem("export", "Export", "Export SVG / PNG / PDF", toggleExport, { kbd: "⌘⇧E" }) : null,
      role === "presenter" ? boardMenuItem("importFile", "Import .excalidraw", "Import .excalidraw", openExcalidrawImport, { disabled: !may }) : null,
      role === "presenter" ? boardMenuItem("mermaid", "Mermaid", "Insert Mermaid", () => openDialog("mermaid"), { disabled: !may }) : null,
      role === "presenter" ? boardMenuItem("frame", "Insert swimlane", "Insert swimlane", insertSwimlane, { disabled: !may }) : null,
      role === "presenter" ? boardMenuItem("grid", "Insert table", "Insert table", insertTable, { disabled: !may }) : null,
      role === "presenter" ? boardMenuItem("play", "Embed URL", "Embed URL…", () => openDialog("embed"), { disabled: !may }) : null,
      versions ? boardMenuItem("history", "Version history", "Version history…", () => openVersionsDialog()) : null,
    ]);
    const effKeys = effectiveKeybinds(userSettings);
    const viewSection = menuSection("View", [
      boardMenuItem("frame", "Jump to frame or view", "Jump to frame / view", () => openViewsMenu(), { kbd: formatCombo(effKeys["action.views"]), badge: viewsOf(S.eds.board.doc).length ? String(viewsOf(S.eds.board.doc).length) : "" }),
      boardMenuItem(ui.theme === "dark" ? "sun" : "moon", "Light / dark", ui.theme === "dark" ? "Light theme" : "Dark theme", toggleTheme),
      role === "presenter" ? boardMenuItem("grid", "Toggle grid", "Snap to grid", toggleGrid, { disabled: !may, kbd: formatCombo(effKeys["action.grid"]), badge: gridOn ? "On" : "", on: gridOn }) : null,
      role !== "viewer" ? boardMenuItem("panel", "Side panel", "Side panel", togglePanel, { kbd: formatCombo(effKeys["action.panel"]), badge: ui.panel.open ? "On" : "", on: ui.panel.open }) : null,
      boardMenuItem("settings", "Settings & keybindings", "Settings & keybindings…", () => openSettingsDialog(), { kbd: formatCombo(effKeys["action.settings"]) }),
      boardMenuItem("help", "Help & shortcuts", "Help & shortcuts…", () => openHelp(), { kbd: "?" }),
    ]);
    const collabSection = menuSection("Collaborate", [
      boardMenuItem("note", "Notes", "Notes", toggleNotes, { badge: String(notesCount()), on: ui.drawer === "notes" }),
      collab ? boardMenuItem("comments", "Comments", "Comments", () => toggleDrawer("comments"), { on: ui.drawer === "comments" }) : null,
      role === "presenter" && may
        ? boardMenuItem(
          audienceLocked ? "unlock" : "lock",
          audienceLocked ? "Unlock audience edits" : "Lock audience edits",
          audienceLocked ? "Unlock audience edits" : "Lock audience edits",
          toggleAudienceLock,
          { badge: audienceLocked ? "On" : "", on: audienceLocked },
        )
        : null,
      share && S.canShare ? boardMenuItem("share", "Share", "Share board", () => openShareDialog()) : (admin ? boardMenuItem("share", "Share", "Share board", () => openAdminShare()) : null),
      canMove() ? boardMenuItem("moveToLayer", "Move to…", "Move to…", openMoveDialog) : null,
    ]);
    const accountSection = onLogout
      ? menuSection("Account", [
        boardMenuItem("logout", "Sign out", "Sign out", () => onLogout()),
      ])
      : null;
    menu = h("div.header-more-menu.board-menu", { role: "menu", "aria-label": "Board menu", hidden: !moreOpen, onkeydown: e => {
      if (e.key === "Escape") { e.preventDefault(); setMore(false, true); }
      else if (e.key === "Tab") setMore(false);
      else {
        const items = menuItems(), i = items.indexOf(document.activeElement);
        let next = null;
        if (e.key === "ArrowDown") next = items[(i + 1) % items.length];
        else if (e.key === "ArrowUp") next = items[(i - 1 + items.length) % items.length];
        else if (e.key === "Home") next = items[0];
        else if (e.key === "End") next = items.at(-1);
        if (next) { e.preventDefault(); next.focus?.(); }
      }
    } }, [boardSection, viewSection, collabSection, accountSection]);
    const actions = h("div.island.top-right.header-actions", {},
      role === "presenter" ? [
        h("button.btn.ghost.desk-only.header-extra", { title: "Insert a Mermaid flowchart", "aria-label": "Insert Mermaid flowchart", disabled: !may, onclick: () => openDialog("mermaid") }, icon("mermaid", { size: 16 })),
        h("button.btn.ghost.desk-only.header-extra", { title: "Export SVG / PNG / .excalidraw (⌘⇧E)", "aria-label": "Export board", onclick: toggleExport }, icon("export", { size: 16 }))] : null,
      h("button.btn.ghost.desk-only.header-extra", { "aria-label": "Notes", "aria-expanded": String(ui.drawer === "notes"), title: "Notes", onclick: toggleNotes }, icon("note", { size: 16 }), "Notes ", h("span.dim", {}, String(notesCount()))),
      collab ? h("button.btn.ghost.desk-only.header-extra", { "aria-label": "Comments", "aria-expanded": String(ui.drawer === "comments"), title: "Comments (or right-click the board)", onclick: () => toggleDrawer("comments") }, icon("comments", { size: 16 })) : null,
      // Who's here (`here`): the collab UI's live avatar row, kept across rebuilds (a node, moved, never rebuilt here).
      collab ? collab.parts.avatars : h("div.avatars", {},
        h("span.stack", {}, h("span.av.live", { style: { background: "var(--u-me)" }, title: `${me.name} (you)` }, me.name.slice(0, 2).toUpperCase()))),
      share && S.canShare
        ? h("button.btn.primary.desk-only.header-extra", { "aria-haspopup": "dialog", "data-share-open": "1", title: "Share this board", "aria-label": "Share board", onclick: () => openShareDialog() }, icon("share", { size: 15 }), "Share")
        : (admin ? h("button.btn.primary.desk-only.header-extra", { "aria-haspopup": "dialog", title: "Share board", "aria-label": "Share board", onclick: () => openAdminShare() }, icon("share", { size: 15 }), "Share") : null),
      canMove() ? h("button.btn.desk-only.header-extra", { "aria-haspopup": "dialog", "aria-label": "Move board to another Space", "data-move-open": "1", title: "Move this board to another Space", onclick: () => openMoveDialog() }, icon("moveToLayer", { size: 15 }), "Move to…") : null,
      pillEl,                                                   // the pill: one node, updated in place (inPlace)
      role !== "viewer" ? h("button.tb.desk-only.header-extra" + (ui.panel.open ? ".on" : ""), { title: "Side panel (I)", "aria-label": "Inspector panel", "aria-expanded": String(ui.panel.open), onclick: togglePanel }, h("span.ic", {}, icon("panel", { size: 17 })), h("span.k", {}, "I")) : null,
      h("button.tb.header-extra" + (role === "viewer" ? "" : ".theme-btn"), { title: "Light / dark", "aria-label": "Toggle color theme", "aria-pressed": String(ui.theme === "dark"), onclick: toggleTheme }, h("span.ic", {}, icon(ui.theme === "dark" ? "sun" : "moon", { size: 17 }))),
      role !== "viewer" ? h("button.tb.phone-only.paste-btn", { title: "Paste from clipboard", "aria-label": "Paste from clipboard", "data-action": "paste", disabled: !may, onclick: () => { pasteFromClipboard(); } }, h("span.ic", {}, icon("paste", { size: 18 }))) : null,
      h("button.tb.phone-only.overflow-btn", { title: "Board menu", "aria-label": "More options", "aria-haspopup": "dialog", "aria-expanded": String(ui.sheet === "tools"), onclick: e => { setSheet(ui.sheet === "tools" ? null : "tools", { opener: e?.currentTarget }); } }, h("span.ic", {}, icon("menu", { size: 18 }))),
      more, menu);
    closeMoreMenu = e => { if (ui.moreOpen && !actions.contains(e.target)) setMore(false); };
    closeMoreMenuNow = () => { if (ui.moreOpen) setMore(false); };
    const brandHref = homeHref || (admin ? "/" : null);
    const titleText = displayBoardTitle();
    let titleNode;
    if (ui.renamingBoard && canRenameBoard()) {
      let cancelled = false;
      const input = h("input.board-name-input", {
        type: "text",
        "aria-label": "Board title",
        maxLength: 200,
        placeholder: "Untitled board",
        value: currentBoardTitle || (isRawBoardId(board) ? "" : board),
        onkeydown: e => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            focusBoardTitleAfterRename = true;
            commitBoardRename(input.value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancelled = true;
            focusBoardTitleAfterRename = true;
            ui.renamingBoard = false;
            chromeDirty = true;
          }
        },
        onblur: () => {
          if (cancelled || !ui.renamingBoard) return;
          commitBoardRename(input.value);
        },
      });
      titleNode = input;
    } else if (canRenameBoard()) {
      titleNode = h("button.board-name.board-name-btn", {
        type: "button",
        title: `${titleText} — click to rename`,
        "aria-label": `Rename board: ${titleText}`,
        onclick: e => startBoardRename(e?.currentTarget ?? null),
      }, titleText, net.kind === "ws" ? null : [" ", h("small", {}, "· dev room")]);
    } else {
      titleNode = h("span.board-name", { title: titleText }, titleText, net.kind === "ws" ? null : [" ", h("small", {}, "· dev room")]);
    }
    const local = resolvedLocalView();
    const viewsCount = viewsOf(S.eds.board.doc).length;
    const viewsPillLabel = local.activeViewName || (local.mode === "solo" ? "Solo" : (viewsCount ? `Views (${viewsCount})` : "Jump"));
    const viewsPill = h("button.btn.ghost.desk-only.views-pill" + (local.active ? ".on" : ""), {
      type: "button",
      "data-views-open": "1",
      "aria-haspopup": "dialog",
      "aria-expanded": String(viewsMenu.isOpen()),
      "aria-label": "Jump to frame or view",
      title: "Jump to frame or view (⌘J)",
      onclick: e => openViewsMenu(e?.currentTarget ?? null),
    }, icon("frame", { size: 14 }), h("span.views-pill-lab", {}, viewsPillLabel), h("kbd.views-pill-kbd", {}, "⌘J"));
    const modeMeta = [
      ["draw", "Draw", "edit", "Draw mode — sketch and edit shapes"],
      ["animate", "Animate", "play", "Animate mode — multi-swimlane movie timeline"],
      ["present", "Present", "fit", "Present mode — distraction-free live walkthrough"],
    ];
    const activeModeMeta = modeMeta.find(([id]) => id === ui.workspaceMode) ?? modeMeta[0];
    let modeSwitcher = null;
    let modeTrigger = null;
    const setModeMenu = (open, focusTrigger = false) => {
      ui.modeMenuOpen = Boolean(open);
      modeSwitcher?.setAttribute?.("data-mode-menu-open", String(ui.modeMenuOpen));
      modeTrigger?.setAttribute?.("aria-expanded", String(ui.modeMenuOpen));
      if (!ui.modeMenuOpen && focusTrigger) modeTrigger?.focus?.();
    };
    if (role === "presenter") {
      modeTrigger = h("button.mode-trigger", {
        type: "button",
        "data-mode-trigger": "1",
        "aria-haspopup": "menu",
        "aria-expanded": String(!!ui.modeMenuOpen),
        "aria-label": `Workspace mode: ${activeModeMeta[1]}`,
        title: `Switch mode (${activeModeMeta[1]})`,
        onclick: () => setModeMenu(!ui.modeMenuOpen),
        onkeydown: e => {
          if (e.key === "Escape" && ui.modeMenuOpen) { e.preventDefault(); setModeMenu(false, true); }
        },
      }, icon(activeModeMeta[2], { size: 13 }), h("span.mode-trigger-lab", {}, activeModeMeta[1]), h("span", { "aria-hidden": "true" }, "▾"));
      const modeTabsEl = h("div.mode-tabs", {},
        modeMeta.map(([id, label, ic, tip]) => h("button.mode-tab" + (ui.workspaceMode === id ? ".on" : ""), {
          type: "button",
          role: "tab",
          "aria-selected": String(ui.workspaceMode === id),
          "data-mode": id,
          title: tip,
          onclick: () => { setModeMenu(false); setWorkspaceMode(/** @type {"draw" | "animate" | "present"} */ (id)); },
        }, icon(ic, { size: 13 }), h("span.mode-tab-lab", {}, label))));
      modeSwitcher = h("div.island.mode-switcher", {
        role: "tablist",
        "aria-label": "Workspace mode",
        "data-workspace-mode": ui.workspaceMode,
        "data-mode-menu-open": String(!!ui.modeMenuOpen),
      }, modeTrigger, modeTabsEl);
      closeModeMenu = e => { if (ui.modeMenuOpen && !modeSwitcher.contains(e.target)) setModeMenu(false); };
      closeModeMenuNow = (focusTrigger = false) => { if (ui.modeMenuOpen) setModeMenu(false, focusTrigger); };
    } else {
      closeModeMenu = null;
      closeModeMenuNow = () => {};
    }
    const showToolRail = role !== "presenter" || ui.workspaceMode === "draw";
    const showRibbonTabs = role !== "viewer" && role !== "annotator" && ui.workspaceMode !== "present" && ui.panel.open;
    const ribbonTabs = (() => {
      if (!showRibbonTabs) return null;
      const secs = panelSections(ui.panel, availableFor(S, ui.workspaceMode));
      const activeTabId = currentActiveTab();
      const expanded = isRibbonExpanded();
      const tabIcon = { properties: "palette", arrange: "group", frames: "frame", animate: "play", layers: "layers", library: "stack" };
      const tabBtns = secs.map(s => {
        const isSel = s.id === activeTabId;
        const isOnTab = isSel && expanded;
        return h("button.ribbon-tab" + (isOnTab ? ".on" : ""), {
          type: "button",
          role: "tab",
          "aria-selected": String(isSel),
          "aria-label": s.title,
          "data-tab": s.id,
          "data-fk": `panel-tab:${s.id}`,
          onclick: () => onRibbonTab(s.id, activeTabId),
        }, icon(tabIcon[s.id] ?? "panel", { size: 13 }), h("span.ribbon-tab-lab", {}, s.title));
      });
      const toggleBtn = h("button.tb.ribbon-toggle", {
        type: "button",
        title: expanded ? "Collapse ribbon" : "Expand ribbon",
        "aria-label": expanded ? "Collapse ribbon" : "Expand ribbon",
        "aria-expanded": String(expanded),
        "data-ribbon-toggle": "1",
        "data-fk": "ribbon:toggle",
        onclick: () => onToggleRibbon(),
      }, icon(expanded ? "chevronUp" : "chevronDown", { size: 14 }), h("span.sr-only", {}, expanded ? "⌃" : "⌄"));
      return h("div.ribbon-tabs.desk-only", {
        role: "tablist",
        "aria-label": "Inspector sections",
        onkeydown: e => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
          const idx = tabBtns.indexOf(document.activeElement);
          if (idx < 0) return;
          e.preventDefault();
          const next = e.key === "ArrowRight" ? tabBtns[(idx + 1) % tabBtns.length]
            : e.key === "ArrowLeft" ? tabBtns[(idx - 1 + tabBtns.length) % tabBtns.length]
            : e.key === "Home" ? tabBtns[0]
            : tabBtns[tabBtns.length - 1];
          next?.focus?.();
        },
      }, tabBtns, toggleBtn);
    })();
    return [
      h("div.island.top-left", {},
        brandHref
          ? h("a.brand-mark", { href: brandHref, title: homeHref ? "Home" : "All boards", "aria-label": homeHref ? "Home" : "All boards", style: { textDecoration: "none" } }, icon("brand", { size: 15 }))
          : h("span.brand-mark", { "aria-hidden": "true" }, icon("brand", { size: 15 })),
        titleNode,
        audienceLocked ? h("span.board-locked-badge", { role: "status", "data-audience-locked": "1", title: "Audience edits are locked by presenter" }, icon("lock", { size: 12 }), " Locked") : null,
        moveInfo.space ? h("span.board-space", { title: "The Space this board is in" }, "in ", moveInfo.space.name) : null,
        viewsPill),
      modeSwitcher,
      ribbonTabs,
      showToolRail
        ? h("div.tools.desk-only.island.tool-rail", { "aria-label": "Drawing tools" }, core.map(t => toolButton(t)), extras.length ? h("span.sep") : null, extras.map(t => toolButton(t, ".new")),
            role !== "viewer" ? [h("span.sep"),
              h("button.tb" + (S.toolLock() ? ".on" : ""), { title: "Keep the tool after drawing (Q)", "aria-label": "Lock tool", "aria-pressed": String(S.toolLock()), disabled: !may, onclick: () => { S.toggleLock(); chromeDirty = true; } }, h("span.ic", {}, icon(S.toolLock() ? "lock" : "unlock", { size: 17 })), h("span.k", {}, "Q")),
              h("button.tb", { title: "Undo (⌘Z)", "aria-label": "Undo", disabled: !may, onclick: () => { S.act(activeStream(), e => e.undo()); } }, h("span.ic", {}, icon("undo", { size: 17 }))),
              h("button.tb", { title: "Redo (⌘⇧Z)", "aria-label": "Redo", disabled: !may, onclick: () => { S.act(activeStream(), e => e.redo()); } }, h("span.ic", {}, icon("redo", { size: 17 })))] : null)
        : null,
      h("span.spacer"),
      actions,
    ];
  }
  const pillTitle = cls => pillTitleFor({ cls, status: S.status, viewer: S.effective === "viewer", readOnly: S.readOnly });

  // Smooth mouse-wheel horizontal scrolling on the top horizontal control ribbon.
  const panelEl = $("#panel");
  if (panelEl && typeof panelEl.addEventListener === "function") {
    panelEl.addEventListener("wheel", e => {
      if (panelEl.getAttribute?.("data-ribbon-layout") === "vertical") return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const scroller = panelEl.querySelector?.('.sec:not([data-ribbon-hidden="true"])') ?? panelEl.querySelector?.(".sec") ?? panelEl;
      if (!scroller || typeof scroller.scrollBy !== "function") return;
      e.preventDefault?.();
      scroller.scrollBy({ left: e.deltaY, behavior: "smooth" });
    }, { passive: false });
  }

  function hud() {
    const B = S.eds.board, bi = boardInfo(B.doc), fs = bi.frames, i = fs.findIndex(f => f.id === B.frameAt), may = S.may();
    if (S.role === "presenter" && ui.workspaceMode === "present") {
      const hasAnimOrCues = bi.tracks.length > 0 || bi.cues.length > 0;
      const savedViews = viewsOf(B.doc);
      const laserOn = S.tool === "laser";
      const { locked: audienceLocked } = boardModeration();
      const stepPrev = () => {
        if (hasAnimOrCues && (B.time() ?? 0) > 0) {
          B.stepToPrevCue({ explicit: true });
          dirty = true;
          chromeDirty = true;
          return;
        }
        if (fs.length > 0) stepBoardFrame(-1);
        else if (savedViews.length > 0) stepView(-1);
        else if (hasAnimOrCues) { B.stepToPrevCue({ explicit: true }); dirty = true; chromeDirty = true; }
      };
      const stepNext = () => {
        if (hasAnimOrCues) {
          B.playToNextCue({ explicit: true });
          dirty = true;
          chromeDirty = true;
          return;
        }
        if (fs.length > 0) stepBoardFrame(1);
        else if (savedViews.length > 0) stepView(1);
      };
      const presenterBar = h("div.island.presenter-bar", { role: "toolbar", "aria-label": "Presenter controls", "data-presenter-bar": "1" },
        h("button.btn.ghost", {
          type: "button",
          "data-present-action": "prev",
          "aria-label": "Previous cue or frame",
          title: hasAnimOrCues ? "Previous cue" : "Previous frame",
          onclick: stepPrev,
        }, icon("chevronLeft", { size: 15 }), h("span.present-lab", {}, "Prev")),
        h("button.btn.primary", {
          type: "button",
          "data-present-action": "next",
          "aria-label": hasAnimOrCues ? "Next cue" : "Next frame",
          title: hasAnimOrCues ? "Play to next cue" : "Next frame or view",
          onclick: stepNext,
        }, h("span.present-lab-long", {}, hasAnimOrCues ? "Next Cue" : "Next Frame"), h("span.present-lab-short", {}, "Next"), icon("chevronRight", { size: 15 })),
        h("span.sep"),
        h("button.btn.ghost", {
          type: "button",
          "data-present-action": "views",
          "data-views-open": "1",
          "aria-haspopup": "dialog",
          "aria-expanded": String(viewsMenu.isOpen()),
          "aria-label": "Views",
          title: "Jump to frame or view (⌘J)",
          onclick: e => openViewsMenu(e?.currentTarget ?? null),
        }, icon("frame", { size: 15 }), h("span.present-lab", {}, "Views")),
        h("button.btn.ghost" + (laserOn ? ".on" : ""), {
          type: "button",
          "data-present-action": "laser",
          "aria-label": "Laser pointer",
          "aria-pressed": String(laserOn),
          title: "Toggle laser pointer",
          onclick: () => { S.setTool(laserOn ? "select" : "laser"); chromeDirty = true; },
        }, icon("laser", { size: 15 }), h("span.present-lab", {}, "Laser")),
        h("button.btn.ghost" + (audienceLocked ? ".on" : ""), {
          type: "button",
          "data-present-action": "lock-audience",
          "aria-label": audienceLocked ? "Unlock audience edits" : "Lock audience edits",
          "aria-pressed": String(audienceLocked),
          disabled: !may,
          title: audienceLocked ? "Unlock audience edits" : "Lock audience edits",
          onclick: toggleAudienceLock,
        }, icon(audienceLocked ? "lock" : "unlock", { size: 15 }), h("span.present-lab", {}, audienceLocked ? "Locked" : "Lock Audience")),
        h("span.sep"),
        h("button.btn.ghost.present-exit", {
          type: "button",
          "data-present-action": "exit",
          "aria-label": "Exit Present",
          title: "Exit Present mode (Esc)",
          onclick: () => setWorkspaceMode("draw"),
        }, icon("close", { size: 14 }), h("span.present-lab", {}, "Exit Present")));
      replace($("#hudBL"), []);
      replace($("#hudBC"), presenterBar);
      replace($("#hudBR"), []);
      return;
    }
    const { canUndo, canRedo } = undoRedoState();
    const ed = activeEditor();
    const sel = ed ? ed.selected().filter(e => !isLabel(e)) : [];
    const selCard = sel.length === 1 ? parseLinkCardFromElement(sel[0]) : null;
    const selColor = sel[0]?.strokeColor ?? "#3B48E8";
    const openCardPill = selCard
      ? h("div.grp.link-card-pill", { "aria-label": "Link card action" },
          h("button.btn.ghost", {
            "data-action": "open-link",
            title: `Open ${selCard.url}`,
            "aria-label": `Open ${selCard.providerName} ${selCard.kind} ${selCard.key}`,
            onclick: () => { openSafeLink(selCard.url); },
          }, `${selCard.providerName} ${selCard.shortKey} ↗`))
      : null;
    const selPill = isPhone() && S.role !== "viewer" && may && sel.length > 0
      ? h("div.grp.phone-only.phone-sel-pill", {
          "aria-label": "Selected shape actions",
          onclick: e => { if (e.target === e.currentTarget) openSelectionActionSheet({ opener: e.currentTarget }); },
        },
          h("button.tb", { title: "Color & Style", "aria-label": "Color", "aria-haspopup": "dialog", "data-action": "color", onclick: e => { ui.colorPicker = "strokeColor"; setSheet("panel", { opener: e?.currentTarget }); } },
            h("span.sel-swatch-dot", { style: { background: safeColor(selColor) } })),
          h("button.tb", { title: "Duplicate", "aria-label": "Duplicate", "data-action": "duplicate", onclick: () => { S.act(activeStream(), e => e.cloneSelection(20, 20)); chromeDirty = true; } },
            h("span.ic", {}, icon("duplicate", { size: 18 }))),
          h("button.tb.danger", { title: "Delete", "aria-label": "Delete", "data-action": "delete", onclick: () => { S.act(activeStream(), e => e.deleteIds([...e.sel])); chromeDirty = true; } },
            h("span.ic", {}, icon("trash", { size: 18 }))),
          h("button.tb", { title: "More actions", "aria-label": "More actions", "aria-haspopup": "dialog", "aria-expanded": String(ui.sheet === "actions"), "data-action": "actions", onclick: e => { openSelectionActionSheet({ opener: e?.currentTarget }); } },
            h("span.ic", {}, icon("more", { size: 18 }))))
      : null;
    const local = resolvedLocalView();
    const savedViews = viewsOf(B.doc);
    const soloLayer = local.soloLayerId ? B.doc.layers.find(l => l.id === local.soloLayerId) : null;
    const localFilterPill = !isPhone() && local.active
      ? h("div.grp.local-filter-pill", { role: "status", "aria-label": "Local layer filter active" },
        h("span.local-filter-text", {}, local.mode === "solo" ? `Solo: ${soloLayer?.name || "Layer"}` : `View: ${local.activeViewName || "Filtered"}`),
        h("button.btn.ghost", {
          type: "button",
          "data-action": "reset-local-layers",
          title: "Clear local layer filter and show all board layers",
          onclick: () => resetLocalView(),
        }, "Show all layers"))
      : null;
    const viewsStepPill = savedViews.length
      ? h("div.grp.desk-only.views-step-pill", { "aria-label": "Presentation views" },
        h("button.tb", { type: "button", title: "Previous view ([)", "aria-label": "Previous view", "data-step-view": "-1", onclick: () => stepView(-1) }, icon("chevronLeft", { size: 15 })),
        h("button.btn.ghost.views-step-label", { type: "button", title: "Jump to frame or view (⌘J)", "aria-label": "Open views navigator", onclick: e => openViewsMenu(e?.currentTarget ?? null) }, local.activeViewName || `Views (${savedViews.length})`),
        h("button.tb", { type: "button", title: "Next view (])", "aria-label": "Next view", "data-step-view": "1", onclick: () => stepView(1) }, icon("chevronRight", { size: 15 })))
      : null;
    const stepViewsMode = Boolean(local.activeViewId) || (fs.length === 0 && savedViews.length > 0);
    const viewIdx = stepViewsMode ? savedViews.findIndex(v => v.id === local.activeViewId) : -1;
    const phoneStepperLabel = stepViewsMode
      ? (viewIdx >= 0 ? `${viewIdx + 1} / ${savedViews.length} · ${local.activeViewName || savedViews[viewIdx].name}` : `Views (${savedViews.length})`)
      : (fs.length ? `${i < 0 ? "–" : i + 1} / ${fs.length}${fs[i]?.name ? ` · ${fs[i].name}` : ""}` : "");
    const phoneStepperPill = isPhone() && (fs.length > 0 || savedViews.length > 0)
      ? h("div.grp.phone-only.phone-stepper-pill", { "aria-label": stepViewsMode ? "Views stepper" : "Frames stepper" },
        h("button.tb", {
          type: "button",
          title: stepViewsMode ? "Previous view" : "Previous frame",
          "aria-label": stepViewsMode ? "Previous view" : "Previous frame",
          "data-stepper": "prev",
          onclick: () => { if (stepViewsMode) stepView(-1); else stepBoardFrame(-1); },
        }, icon("chevronLeft", { size: 16 })),
        h("button.btn.ghost.phone-stepper-label", {
          type: "button",
          "data-action": "open-views",
          "aria-haspopup": "dialog",
          "aria-label": "Open frames and views",
          title: "Open frames and views",
          onclick: e => openViewsMenu(e?.currentTarget ?? null),
        }, phoneStepperLabel),
        h("button.tb", {
          type: "button",
          title: stepViewsMode ? "Next view" : "Next frame",
          "aria-label": stepViewsMode ? "Next view" : "Next frame",
          "data-stepper": "next",
          onclick: () => { if (stepViewsMode) stepView(1); else stepBoardFrame(1); },
        }, icon("chevronRight", { size: 16 })))
      : null;
    const phoneShowAllPill = isPhone() && local.active
      ? h("div.grp.phone-only.phone-show-all-pill", { role: "status", "aria-label": "Local layer filter active" },
        h("button.btn.ghost.phone-show-all", {
          type: "button",
          "data-action": "reset-local-layers",
          "aria-label": "Show all layers",
          title: "Clear local layer filter and show all board layers",
          onclick: () => resetLocalView(),
        }, "Show all"))
      : null;
    const bl = [
      localFilterPill,
      openCardPill,
      selPill,
      viewsStepPill,
      phoneStepperPill,
      phoneShowAllPill,
      h("div.grp.desk-only", {}, h("button.tb", { title: "Previous frame (PgUp)", "aria-label": "Previous frame", onclick: () => stepBoardFrame(-1) }, icon("chevronLeft", { size: 16 })), h("span.pct", {}, fs.length ? `${i < 0 ? "–" : i + 1} / ${fs.length}` : "0 / 0"), h("button.tb", { title: "Next frame (PgDn)", "aria-label": "Next frame", onclick: () => stepBoardFrame(1) }, icon("chevronRight", { size: 16 }))),
      h("div.grp.desk-only", {},
        S.role !== "viewer" ? [
          h("button.tb", { title: "Undo", "aria-label": "Undo", disabled: !canUndo, onclick: () => S.act(activeStream(), e => e.undo()) }, icon("undo", { size: 16 })),
          h("button.tb", { title: "Redo", "aria-label": "Redo", disabled: !canRedo, onclick: () => S.act(activeStream(), e => e.redo()) }, icon("redo", { size: 16 })),
          h("span.sep"),
        ] : null,
        h("button.tb", { title: "Zoom out (⌘-)", "aria-label": "Zoom out", onclick: () => S.zoomAt(B.view.scale / 1.2) }, icon("minus", { size: 16 })), zoomPct,
        h("button.tb", { title: "Zoom in (⌘=)", "aria-label": "Zoom in", onclick: () => S.zoomAt(B.view.scale * 1.2) }, icon("plus", { size: 16 })), h("button.tb", { title: "Fit everything (⇧1)", "aria-label": "Fit everything", onclick: () => S.fit() }, icon("fit", { size: 16 }))),
      S.role !== "viewer" ? h("div.grp.phone-only.phone-undo-pill", { "aria-label": "Undo and Redo" },
        h("button.tb", { disabled: !canUndo, title: "Undo", "aria-label": "Undo", "data-action": "undo", onclick: () => S.act(activeStream(), e => e.undo()) }, h("span.ic", {}, icon("undo", { size: 18 }))),
        h("button.tb", { disabled: !canRedo, title: "Redo", "aria-label": "Redo", "data-action": "redo", onclick: () => S.act(activeStream(), e => e.redo()) }, h("span.ic", {}, icon("redo", { size: 18 })))) : null,
      S.role !== "viewer" ? h("div.grp.phone-only", {}, h("button.tb", { title: "Fit everything", "aria-label": "Fit everything", onclick: () => S.fit() }, h("span.ic", {}, icon("fit", { size: 18 })))) : null,
    ];
    // The emote bar and the phones' one emote button: the collab UI's live nodes (moved in once, then kept).
    replace($("#hudBL"), bl);
    if (collab) {
      if (collab.parts.emotes.parentNode !== $("#hudBC")) replace($("#hudBC"), collab.parts.emotes);
      if (collab.parts.emoteButton.parentNode !== $("#hudBR")) replace($("#hudBR"), collab.parts.emoteButton);
    } else {
      replace($("#hudBC"), []);
      replace($("#hudBR"), []);
    }
  }

  function timeline() {
    const el = $("#timeline"), B = S.eds.board;
    const { dur, marks, spans, tracks, cues } = boardInfo(B.doc);
    const hasAnimOrCues = tracks.length > 0 || cues.length > 0;
    const showTimeline = S.role === "presenter" && (ui.workspaceMode === "animate" || (ui.workspaceMode === "draw" && hasAnimOrCues));
    el.hidden = !showTimeline;
    if (el.hidden) {
      tl.fill = null;
      tl.head = null;
      tl.needle = null;
      return;
    }
    const reduced = prefersReducedMotion();
    B.setReducedMotion(reduced);
    const expanded = ui.workspaceMode === "animate" ? ui.timelineExpanded : false;
    buildTimeline(el, {
      board: B,
      dur,
      marks,
      spans,
      tracks,
      cues,
      tl,
      h,
      replace,
      reducedMotion: reduced,
      expanded,
      compactOnly: false,
      phoneDrawer: isCompactPhone(),
      showAuthoring: ui.workspaceMode === "animate" && !isNarrowPhone(),
      canEdit: S.may(),
      act: fn => S.act("board", fn),
      actSettings: fn => S.act("board", fn, { settings: true }),
      onToggleExpand: next => {
        if (ui.workspaceMode === "draw" && next) {
          setWorkspaceMode("animate");
          return;
        }
        ui.timelineExpanded = Boolean(next);
        chromeDirty = true;
      },
      onFocusElement: id => {
        const target = B.doc.get(id);
        if (target) {
          S.eds.notes.cancelCamera();
          B.fit([target], 80);
          S.syncView("board");
          dirty = true;
        }
      },
      onChange: () => { chromeDirty = true; },
      onSeek: () => { timelineInPlace(); dirty = true; },
    });
  }

  // The notes stream as a list: text, author (you, or "—" for others), jump / edit / delete.
  // The notes drawer's list element (kept so rows can be refreshed while the compose box is being typed in).
  const notesRefs = { list: null };
  function notesList(rowsOnly = false) {
    const N = S.eds.notes, may = S.may();
    const { notes, labels } = notesInfo(N.doc);
    const label = e => (e.type === "text" ? e.text : labels.get(e.id)?.text) || { freedraw: "Highlight / drawing", image: "Picture", arrow: "Arrow", line: "Line" }[e.type] || "Note";
    const rows = notes.slice(0, 200).map(e => {
      const mine = S.isMine(e.id), canChange = may && mine;
      const jump = () => { S.eds.board.cancelCamera(); N.fit([e]); S.syncView("notes"); chromeDirty = true; };
      return h("div.note-row", { role: "listitem", "aria-label": `Note: ${label(e)}, by ${S.mine.has(e.id) ? "you" : "someone else"}`, "data-fk": `note:${e.id}:row`, tabindex: "-1" }, h("span.sw", { style: { background: safeColor(e.backgroundColor !== "transparent" ? e.backgroundColor : e.strokeColor), width: "10px", height: "10px" } }),
        h("div.txt", {}, h("div", {}, label(e)),
          h("div.meta", {}, h("span", { style: { fontWeight: 600 } }, S.mine.has(e.id) ? "You" : "—"), e.type === "freedraw" ? h("span", {}, "highlight") : null),
          h("div.acts", {}, h("button", { "data-fk": `note:${e.id}:jump`, onclick: jump }, "jump to"),
            may && S.effective !== "viewer" ? (canChange ? [
              h("button", { "data-fk": `note:${e.id}:edit`, onclick: () => { jump(); S.act("notes", n => { n.select([e.id]); n.beginText(e, { x: e.x, y: e.y }); }); } }, "edit"),
              h("button", { "data-fk": `note:${e.id}:delete`, onclick: () => S.act("notes", n => n.deleteIds([e.id])) }, "delete")] : h("span.lock", {}, icon("lock", { size: 12 }), " someone else's")) : null)));
    });
    const list = h("div.notes-list", { role: "list", "aria-label": "Notes" }, rows.length ? rows : h("div.hint", { style: { padding: "6px 8px" } }, "No notes yet."), notes.length > 200 ? h("div.hint", {}, `${notes.length - 200} more`) : null);
    if (rowsOnly) return list;
    notesRefs.list = list;
    const compose = !may || S.effective === "viewer"
      ? h("div.hint.compose", {}, S.role === "viewer" ? "Viewers read notes; only annotators and presenters add them." : "Read-only: you can't add or change notes.")
      : h("div.compose", {}, h("textarea.field", { placeholder: "Write a note… it lands at the center of your view", rows: 2, onkeydown: e => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const v = e.currentTarget.value.trim(); if (!v) return; const b = S.eds.board; S.placeNote(b.toWorld({ x: b.size.w / 2, y: b.size.h / 2 }), v); e.currentTarget.value = ""; chromeDirty = true; }
      } }));
    return [list, compose];
  }
  function drawerBody(which) {
    // Comment threads: the collab UI's drawer (its own Notes/Comments header is hidden here; ours switches).
    if (which === "comments") { if (!collab) return [h("div.notes-list", {}, h("div.hint", { style: { padding: "8px" } }, "No comments here."))]; collab.showDrawer("comments"); return [collab.parts.drawer]; }
    return notesList();
  }
  function drawerTabs(key) {
    const which = ui[key] || "notes";
    return h("span.seg", {}, h("button" + (which === "notes" ? ".on" : ""), { "data-fk": `drawer-tab:${key}:notes`, onclick: () => { ui[key] = "notes"; chromeDirty = true; } }, "Notes"),
      h("button" + (which === "comments" ? ".on" : ""), { "data-fk": `drawer-tab:${key}:comments`, onclick: () => { ui[key] = "comments"; chromeDirty = true; } }, "Comments"));
  }

  const T = id => toolsFor("presenter").find(t => t.id === id);
  function dock() {
    const dockEl = $("#dock");
    const may = S.may(), role = S.role;
    dockEl.hidden = role === "presenter" && ui.workspaceMode !== "draw";
    if (dockEl.hidden) { replace(dockEl, []); return; }
    const btn = (icName, label, on, onclick, disabled = false, ariaLabel = label, extra = {}) => h("button.tb" + (on ? ".on" : ""), { onclick, disabled, "aria-label": ariaLabel, title: ariaLabel, ...(label === "More" ? { "data-dock-more": "1" } : {}), ...extra }, h("span.ic", {}, icon(icName, { size: 20 })), label);
    const sheetBtn = (icName, label, id) => btn(icName, label, ui.sheet === id, e => setSheet(ui.sheet === id ? null : id, { opener: e?.currentTarget }), false, label, { "aria-haspopup": "dialog", "aria-expanded": String(ui.sheet === id) });
    const tool = id => btn(id, T(id).name, S.tool === id, () => { if (id === "image") openPicker(); S.setTool(id); chromeDirty = true; }, id !== "hand" && !may, T(id).name, { "aria-pressed": String(S.tool === id) });
    let items;
    if (role === "presenter") {
      const discussBtn = isNarrowPhone()
        ? [btn("comments", "Discuss", ui.sheet === "notes" || ui.sheet === "comments", e => setSheet(ui.sheet === "notes" || ui.sheet === "comments" ? null : "notes", { opener: e?.currentTarget }), false, "Notes and comments", { "aria-haspopup": "dialog", "aria-expanded": String(ui.sheet === "notes" || ui.sheet === "comments"), "data-dock-discuss": "1" })]
        : [sheetBtn("note", "Notes", "notes"), sheetBtn("comments", "Comments", "comments")];
      items = [...["hand", "select", "arrow", "rectangle"].map(id => id === "rectangle" ? btn(id, "Rect", S.tool === id, () => { S.setTool(id); chromeDirty = true; }, !may, T(id).name, { "aria-pressed": String(S.tool === id) }) : tool(id)), sheetBtn("more", "More", "tools"), sheetBtn("panel", "Style", "panel"), ...discussBtn];
    }
    else if (role === "annotator") items = [...["hand", "select", "note", "highlighter", "arrow"].map(tool), sheetBtn("more", "More", "tools"), sheetBtn("panel", "Style", "panel")];
    else items = [btn("chevronLeft", "Prev", false, () => stepBoardFrame(-1)), btn("fit", "Fit", false, () => S.fit()), btn("chevronRight", "Next", false, () => stepBoardFrame(1)), sheetBtn("note", "Notes", "notes"), sheetBtn("comments", "Comments", "comments")];
    replace(dockEl, items);
  }
  const SHEET_DISMISS_PX = 72, SHEET_FLICK_VY = 0.55;
  const SHEET_LABELS = { tools: "More tools", panel: "Style and properties", notes: "Notes", comments: "Comments", actions: "Selection actions", rename: "Rename board" };
  function sheetHandle(el) {
    let drag = null, suppressClick = false;
    const reset = () => { drag = null; el.classList.remove("dragging"); el.style.transform = ""; };
    const handle = h("div.sheet-handle", {
      role: "button",
      tabindex: "0",
      "aria-label": "Dismiss sheet",
      title: "Drag down or tap to close",
      onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault?.(); setSheet(null); } },
    }, h("div.grab"));
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
      if (dy > SHEET_DISMISS_PX || (dy > 24 && vy > SHEET_FLICK_VY)) setSheet(null);
    });
    handle.addEventListener("pointercancel", e => {
      if (!drag || (e.pointerId != null && e.pointerId !== drag.id)) return;
      if (drag.moved) suppressClick = true;
      reset();
    });
    handle.addEventListener("click", () => {
      if (suppressClick) { suppressClick = false; return; }
      setSheet(null);
    });
    const closeBtn = h("button.tb.sheet-close", { type: "button", title: "Close", "aria-label": "Close sheet", onclick: () => setSheet(null) }, icon("close", { size: 16 }));
    return h("div.sheet-head", {}, handle, closeBtn);
  }
  function sheetView() {
    const el = $("#sheet");
    const bd = ensureSheetBackdrop();
    el.classList.remove("dragging");
    el.style.transform = "";
    if (!ui.sheet || !isPhone()) {
      if (isPhone()) cancelActiveSampler();
      if (sheetHistoryPushed) popSheetHistory();
      if (sheetTrap) { sheetTrap.deactivate({ restoreFocus: false }); sheetTrap = null; sheetTrapKind = null; }
      if (bd) bd.hidden = true;
      el.hidden = true;
      el.replaceChildren();
      return;
    }
    if ((ui.sheet === "rename" || ui.sheet === "panel") && busy(el)) return false;
    if (ui.sheet !== "panel") cancelActiveSampler();
    if (bd) bd.hidden = false;
    el.setAttribute?.("role", "dialog");
    el.setAttribute?.("aria-modal", "true");
    el.setAttribute?.("aria-label", SHEET_LABELS[ui.sheet] ?? "Sheet");
    if (el.getAttribute?.("tabindex") === null) el.setAttribute?.("tabindex", "-1");
    el.hidden = false;
    let body;
    let initialFocus = null;
    if (ui.sheet === "tools") {
      // Every write here passes S.setTool / S.may: read-only greys and refuses it (p6-mockv round 2, MEDIUM).
      const may = S.may();
      const quickActions = S.role !== "viewer"
        ? h("div.sheet-actions", {},
            h("button.btn.sheet-action", { disabled: !may, "data-action": "paste", "aria-label": "Paste from clipboard", onclick: () => { pasteFromClipboard().then(ok => { if (ok && ui.sheet === "tools") setSheet(null, { restore: false }); }); } }, icon("paste", { size: 18 }), "Paste"),
            h("button.btn.sheet-action", { disabled: !may, "data-action": "media", "aria-label": "Insert photo or video", onclick: () => { openPicker(); setSheet(null, { restore: false }); } }, icon("image", { size: 18 }), "Photo / Video"))
        : null;
      const gridOn = Boolean(S.eds.board.grid);
      body = h("div.scroll", {}, quickActions, h("div.tool-grid", {}, toolsFor(S.role).map(t => h("button.tb" + (S.tool === t.id ? ".on" : ""), { disabled: t.id !== "hand" && !may, "data-tool": t.id, "aria-label": t.name, "aria-pressed": String(S.tool === t.id), onclick: () => { if (t.id === "image") openPicker(); S.setTool(t.id); setSheet(null, { restore: false }); } }, h("span.ic", {}, icon(t.id, { size: 20 })), t.name)),
        canRenameBoard() ? h("button.tb", { "aria-label": "Rename board", onclick: e => { startBoardRename(e?.currentTarget ?? null); } }, h("span.ic", {}, icon("edit", { size: 20 })), "Rename") : null,
        S.role === "presenter" ? [
          h("button.tb", { disabled: !may, "aria-haspopup": "dialog", onclick: () => openDialog("mermaid") }, h("span.ic", {}, icon("mermaid", { size: 20 })), "Mermaid"),
          h("button.tb", { disabled: !may, "aria-label": "Insert swimlane", title: "Insert swimlane", onclick: () => { insertSwimlane(); setSheet(null, { restore: false }); } }, h("span.ic", {}, icon("frame", { size: 20 })), "Swimlane"),
          h("button.tb", { disabled: !may, "aria-label": "Insert table", title: "Insert table", onclick: () => { insertTable(); setSheet(null, { restore: false }); } }, h("span.ic", {}, icon("grid", { size: 20 })), "Table"),
          h("button.tb", { disabled: !may, "aria-haspopup": "dialog", "aria-label": "Embed URL", title: "Embed / Link URL…", onclick: () => openDialog("embed") }, h("span.ic", {}, icon("play", { size: 20 })), "Embed / URL"),
          h("button.tb", { "aria-haspopup": "dialog", onclick: () => openDialog("export") }, h("span.ic", {}, icon("export", { size: 20 })), "Export"),
          h("button.tb", { disabled: !may, "aria-label": "Import .excalidraw", title: "Import .excalidraw / .drawio", onclick: () => { openExcalidrawImport(); setSheet(null, { restore: false }); } }, h("span.ic", {}, icon("importFile", { size: 20 })), "Import"),
          h("button.tb" + (gridOn ? ".on" : ""), { disabled: !may, "aria-label": "Toggle grid", "aria-pressed": String(gridOn), onclick: () => { S.act("board", e => e.setAppState({ grid: e.grid ? 0 : 20 }), { settings: true }); chromeDirty = true; } }, h("span.ic", {}, icon("grid", { size: 20 })), "Grid"),
        ] : null,
        share && S.canShare
          ? h("button.tb", { "aria-haspopup": "dialog", onclick: () => { setSheet(null, { restore: false }); openShareDialog(); } }, h("span.ic", {}, icon("share", { size: 20 })), "Share")
          : (admin ? h("button.tb", { "aria-haspopup": "dialog", onclick: () => { setSheet(null, { restore: false }); openAdminShare(); } }, h("span.ic", {}, icon("share", { size: 20 })), "Share") : null),
        canMove() ? h("button.tb", { "aria-haspopup": "dialog", onclick: () => openMoveDialog() }, h("span.ic", {}, icon("moveToLayer", { size: 20 })), "Move to…") : null,
        versions ? h("button.tb", { "aria-haspopup": "dialog", "aria-label": "Version history", onclick: () => { setSheet(null, { restore: false }); openVersionsDialog(); } }, h("span.ic", {}, icon("history", { size: 20 })), "Versions") : null,
        h("button.tb", { "aria-haspopup": "dialog", "aria-label": "Jump to frame or view", onclick: () => { setSheet(null, { restore: false }); openViewsMenu(); } }, h("span.ic", {}, icon("frame", { size: 20 })), "Views"),
        h("button.tb", { "aria-haspopup": "dialog", "aria-label": "Settings & keybindings", onclick: () => { setSheet(null, { restore: false }); openSettingsDialog(); } }, h("span.ic", {}, icon("settings", { size: 20 })), "Settings"),
        h("button.tb", { "aria-haspopup": "dialog", "aria-label": "Help & shortcuts", onclick: () => { setSheet(null, { restore: false }); openHelp(); } }, h("span.ic", {}, icon("help", { size: 20 })), "Help"),
        S.role !== "viewer" ? h("button.tb" + (S.toolLock() ? ".on" : ""), { disabled: !may, "aria-pressed": String(S.toolLock()), onclick: () => { S.toggleLock(); chromeDirty = true; } }, h("span.ic", {}, icon(S.toolLock() ? "lock" : "unlock", { size: 20 })), "Lock tool") : null,
        h("button.tb", { "aria-label": "Toggle color theme", title: "Light / dark", "aria-pressed": String(ui.theme === "dark"), onclick: () => { const next = ui.theme === "dark" ? "light" : "dark"; setTheme(next); applyUserSettings({ ...userSettings, defaultTheme: next }); } }, h("span.ic", {}, icon(ui.theme === "dark" ? "sun" : "moon", { size: 20 })), ui.theme === "dark" ? "Light" : "Dark"),
        onLogout ? h("button.tb", { "aria-label": "Sign out", title: "Sign out", "data-action": "logout", onclick: () => { setSheet(null, { restore: false }); onLogout(); } }, h("span.ic", {}, icon("logout", { size: 20 })), "Sign out") : null));
    } else if (ui.sheet === "actions") {
      const { stream: targetStream, selected, hitEl } = resolveActionSheetSelection();
      const canWrite = canWriteSelection(targetStream, selected);
      const commentPoint = actionSheetCtx?.point
        ?? (hitEl ? S.eds.board.toScreen({ x: hitEl.x + (hitEl.width ?? 0) / 2, y: hitEl.y + (hitEl.height ?? 0) / 2 }) : { x: S.eds.board.size.w / 2, y: S.eds.board.size.h / 2 });
      const items = buildMobileSelectionActions({
        canWrite,
        canComment: Boolean(collab),
        selected,
        actions: {
          duplicate: () => { S.act(targetStream, x => x.cloneSelection(20, 20)); chromeDirty = true; },
          del: () => { S.act(targetStream, x => x.deleteIds([...x.sel])); chromeDirty = true; },
          copyLink: () => copyElementDeepLink(selected, hitEl),
          group: () => { S.act(targetStream, x => x.group()); chromeDirty = true; },
          ungroup: () => { S.act(targetStream, x => x.ungroup()); chromeDirty = true; },
          reorder: how => { S.act(targetStream, x => x.reorder(how)); chromeDirty = true; },
          toggleLock: () => { S.act(targetStream, x => x.toggleLock()); chromeDirty = true; },
          tidy: () => { S.act(targetStream, x => x.tidySelection()); chromeDirty = true; },
          spliceImage: (cols, rows) => {
            const imgs = selected.filter(el => el && !isLabel(el) && el.type === "image" && !el.locked);
            if (imgs.length !== 1) return;
            S.act(targetStream, x => x.spliceImage(imgs[0].id, { cols, rows }));
            chromeDirty = true;
          },
          addComment: () => startComment(commentPoint),
        },
      });
      if (!items.length) {
        setSheet(null, { restore: false });
        return;
      }
      body = renderSelectionActionSheet({
        items,
        count: selected.length,
        onRun: item => {
          setSheet(null, { restore: false });
          item.action?.();
        },
      });
    } else if (ui.sheet === "rename") {
      if (!canRenameBoard()) {
        setSheet(null, { restore: false });
        return;
      }
      const renameSheet = renderRenameBoardSheet({
        initialValue: currentBoardTitle || (isRawBoardId(board) ? "" : board),
        onSave: value => {
          commitBoardRename(value);
          setSheet(null);
        },
        onCancel: () => setSheet(null),
      });
      body = renameSheet.root;
      initialFocus = renameSheet.input;
    } else if (ui.sheet === "panel") body = h("div.scroll", {}, panelNodes(true));
    else body = [h("div.tabs", { style: { justifyContent: "center" } }, drawerTabs("sheet")), h("div.scroll", {}, drawerBody(ui.sheet))];
    replace(el, sheetHandle(el), body);
    if (sheetTrap && sheetTrapKind !== ui.sheet) {
      sheetTrap.deactivate({ restoreFocus: false });
      sheetTrap = null;
      sheetTrapKind = null;
    }
    if (!sheetTrap) {
      sheetTrapKind = ui.sheet;
      sheetTrap = trapFocus(el, { onEscape: () => setSheet(null), returnFocusTo: sheetOpener?.el ?? null, initialFocus });
    }
  }
  const selectionInfo = () => {
    const ed = S.eds[S.role === "annotator" ? "notes" : S.active];
    const sel = ed ? ed.selected().filter(e => e && !isLabel(e)) : [];
    return { count: sel.length, sig: sel.map(e => `${e.id}:${e.type}`).sort().join(",") };
  };
  const syncRibbonSelection = () => {
    const { sig } = selectionInfo();
    if (sig !== ui.ribbon.lastSelSig) {
      ui.ribbon.lastSelSig = sig;
      ui.ribbon.manualCollapsed = false;
    }
  };
  const currentActiveTab = () => {
    const secs = panelSections(ui.panel, availableFor(S, ui.workspaceMode));
    if (ui.panel.mode === "tabs") return secs.find(s => s.active)?.id ?? secs[0]?.id ?? "properties";
    return secs.some(s => s.id === ui.panel.tab) ? ui.panel.tab : (secs[0]?.id ?? "properties");
  };
  const isRibbonExpanded = () => {
    if (S.role === "annotator") return true;
    syncRibbonSelection();
    const { count } = selectionInfo();
    return shouldExpandRibbon({
      selectionCount: count,
      pinnedOpen: ui.ribbon.pinnedOpen,
      manualCollapsed: ui.ribbon.manualCollapsed,
      activeTab: currentActiveTab(),
    });
  };
  const onRibbonTab = (id, activeTabId) => {
    const expanded = isRibbonExpanded();
    if (expanded && id === activeTabId) {
      ui.ribbon.pinnedOpen = false;
      ui.ribbon.manualCollapsed = true;
      if (ui.colorPicker) { cancelActiveSampler(); ui.colorPicker = null; }
      chromeDirty = true;
      return;
    }
    ui.ribbon.pinnedOpen = true;
    ui.ribbon.manualCollapsed = false;
    if (ui.colorPicker) { cancelActiveSampler(); ui.colorPicker = null; }
    setPanel({ type: "tab", id });
  };
  const onToggleRibbon = () => {
    const expanded = isRibbonExpanded();
    if (expanded) {
      ui.ribbon.pinnedOpen = false;
      ui.ribbon.manualCollapsed = true;
      if (ui.colorPicker) { cancelActiveSampler(); ui.colorPicker = null; }
    } else {
      ui.ribbon.pinnedOpen = true;
      ui.ribbon.manualCollapsed = false;
    }
    chromeDirty = true;
  };
  const onToggleRibbonAll = () => {
    ui.ribbon.showAll = !ui.ribbon.showAll;
    chromeDirty = true;
  };
  const panelNodes = (inSheet = false) => renderPanel(null, {
    session: S, state: ui.panel, h, inSheet, workspaceMode: ui.workspaceMode, library: ui.library, setLibrary, setState: setPanel,
    prefs, canvas, clock, colorPicker: ui.colorPicker, colorPickerState: ui.colorPickerState,
    setColorPicker: prop => { cancelActiveSampler(); ui.colorPicker = prop; chromeDirty = true; },
    ribbonExpanded: inSheet ? true : isRibbonExpanded(),
    ribbonShowAll: ui.ribbon.showAll,
    onRibbonTab,
    onToggleRibbon,
    onToggleRibbonAll,
    localView: resolvedLocalView(),
    onSoloLayer: toggleSoloLayer,
    onResetLocalView: resetLocalView,
    onJumpFrame: id => { jumpToFrame(id); },
    onStepFrame: delta => { stepBoardFrame(delta); },
    onChange: () => { chromeDirty = true; },
  });

  // `#dialogs` hosts presenter modals (mermaid/embed/export/share) while `document.body` hosts
  // `help-dialog.js`, `views-menu.js`, `settings-dialog.js`, `versions-dialog.js`, and `move.js`;
  // `dismissOverlays()` + `hasOpenDialog()` coordinate both via `a11y.js` without collision.
  const boardDialogs = createBoardDialogs({
    S,
    ui,
    board,
    canvas,
    image,
    clock,
    toast,
    displayBoardTitle,
    getDialogsContainer: () => $("#dialogs"),
    getChromeRoots: () => chromeRoots(),
    isShareOpen: () => Boolean(activeShare),
    getOpener: () => dialogOpener,
    clearOpener: () => { dialogOpener = null; },
    restoreOpener,
    setPendingFocus: held => { pendingFocus = held; },
    onDirty: () => { chromeDirty = true; },
  });
  function dialogs() {
    boardDialogs.render();
  }

  // Sign in again (C-9): a link (so it reads as one and opens in a new tab if asked), whose click remembers this
  // board and leaves through the root's relogin.go(). The link carries nothing but its fixed path.
  const reloginLink = () => h("a.btn.primary", { href: relogin.href, onclick: e => { if (e.button || e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); relogin.go(); } }, "Sign in again");
  // The cap's countdown in whole seconds, on the clock port (C-17: nextTryAt is the clock's now(), so is this).
  const nextTryIn = () => { const n = S.limitedNextTry; return n == null ? null : Math.max(0, n - clock.now()); };
  const expiry = () => expiryNotice({ expAt, now: clock.now() });
  function banners() {
    const out = [];
    const b = S.status === "refused" && trashShown() ? null : connectionBanner({ status: S.status, online: S.online, viewer: S.effective === "viewer", pending: S.pending, readOnly: S.readOnly,
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
  // Why: defer chrome rebuilds between a non-canvas pointerdown and pointerup so `replace()` never
  // detaches the pressed button before its `click` event fires.
  document.addEventListener("pointerdown", e => { if (e.target !== canvas) chromeHeld = true; }, true);
  addEventListener("pointerup", () => { chromeHeld = false; }, true);
  addEventListener("pointercancel", () => { chromeHeld = false; }, true);
  // Don't rebuild a panel or drawer the user is typing in.
  const busy = el => el.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName);
  // What every part depends on from the page and the session (a change rebuilds them all, as chromeDirty does).
  const envKey = () => [S.role, S.effective, S.readOnly, S.may(), S.tool, S.active, S.toolLock(), ui.theme, ui.workspaceMode, ui.timelineExpanded, isPhone(), isNarrowPhone(), isCompactPhone(), JSON.stringify(ui.panel), ui.ribbon.pinnedOpen, ui.ribbon.manualCollapsed, ui.ribbon.showAll, ui.drawer, ui.sheet, ui.dialog, ui.colorPicker, ui.library.length, S.canShare, canMove(), currentBoardTitle ?? "", ui.renamingBoard, serverCanRename, S.eds.board.grid, boardModeration().locked, ui.localView.soloLayerId ?? "", ui.localView.activeViewId ?? ""].join("|");
  const notesRowsKey = () => {
    const { notes, labels } = notesInfo(S.eds.notes.doc);
    return JSON.stringify([notes.length, S.mine.size, notes.slice(0, 200).map(e => [e.id, e.text ?? labels.get(e.id)?.text ?? "", e.backgroundColor, e.strokeColor, S.isMine(e.id)])]);
  };
  // The side panel shows the active Editor's style and selection (propsModel), the board's frames, layers and their
  // counts, the active layer, the playback chip and the library (panel.js renderPanel).
  const panelKey = () => {
    const B = S.eds.board, ed = S.eds[S.role === "annotator" ? "notes" : S.active], bi = boardInfo(B.doc);
    const selList = ed.selected().filter(e => !isLabel(e));
    const selFirst = selList[0] ?? null;
    const selSig = selList.map(e => `${e.id}:${e.type}`).sort().join(",");
    return JSON.stringify([propsModel(ed), B.sel.size > 0, S.eds.notes.sel.size > 0, selSig, selFirst?.id ?? null, selFirst?.type ?? null, Boolean(selFirst?.locked), selFirst?.customData?.meta ?? null, B.selected()[0]?.customData?.anim ?? null,
      bi.spansSig, bi.framesSig, B.frameAt, !!B.play, B.doc.layers, bi.counts, B.activeLayer, ui.colorPicker, ui.ribbon.pinnedOpen, ui.ribbon.manualCollapsed, ui.ribbon.showAll, ui.localView, viewsOf(B.doc)]);
  };
  const hudKey = () => {
    const { canUndo, canRedo } = undoRedoState();
    const ed = activeEditor();
    const sel = ed ? ed.selected().filter(e => !isLabel(e)) : [];
    const selCardUrl = sel.length === 1 ? (parseLinkCardFromElement(sel[0])?.url ?? "") : "";
    const phoneSel = isPhone() ? sel : [];
    return JSON.stringify([boardInfo(S.eds.board.doc).framesSig, S.eds.board.frameAt, canUndo, canRedo, phoneSel.length, phoneSel[0]?.strokeColor ?? "", selCardUrl, ui.localView, viewsOf(S.eds.board.doc)]);
  };
  const buildTopbar = () => {
    const root = $("#topbar"), active = document.activeElement;
    if (ui.renamingBoard && busy(root)) return false;
    const ownsFocus = root.contains(active);
    const identity = ownsFocus && {
      fk: active.getAttribute?.("data-fk"),
      ariaLabel: active.getAttribute?.("aria-label"),
      title: active.getAttribute?.("title"),
      role: active.getAttribute?.("role"),
    };
    replace(root, topbar());
    if (ui.renamingBoard) {
      const inp = /** @type {HTMLInputElement | null} */ (root.querySelector?.("input.board-name-input") ?? root.all?.().find(e => e.tagName === "INPUT" && e.classList?.contains("board-name-input")));
      if (inp) { inp.focus?.(); inp.select?.(); }
      return root;
    }
    if (focusBoardTitleAfterRename) {
      focusBoardTitleAfterRename = false;
      const btn = /** @type {HTMLElement | null} */ (root.querySelector?.(".board-name-btn") ?? root.all?.().find(e => e.classList?.contains("board-name-btn")));
      if (btn) { btn.focus?.(); return root; }
    }
    if (!identity) return root;
    const descendants = [];
    const visit = el => { for (const child of el.children) { descendants.push(child); visit(child); } };
    visit(root);
    const same = descendants.find(el => identity.fk
      ? el.getAttribute?.("data-fk") === identity.fk
      : identity.ariaLabel
        ? el.getAttribute?.("aria-label") === identity.ariaLabel
        : identity.title ? el.getAttribute?.("title") === identity.title : identity.role && el.getAttribute?.("role") === identity.role);
    const closedMenuItem = identity.role === "menuitem" && !ui.moreOpen;
    const fallback = closedMenuItem ? descendants.find(el => el.getAttribute?.("aria-label") === "More") : null;
    (fallback ?? same)?.focus?.();
    return root;
  };
  const ribbonTabsKey = () => {
    if (S.role === "viewer" || S.role === "annotator" || ui.workspaceMode === "present" || !ui.panel.open) return "";
    const secs = panelSections(ui.panel, availableFor(S, ui.workspaceMode));
    return `${secs.map(s => s.id).join(",")}:${currentActiveTab()}:${isRibbonExpanded() ? "1" : "0"}`;
  };
  const parts = {
    topbar: { key: () => `${ui.workspaceMode}:${notesCount()}${S.canShare ? ":share" : ""}${canMove() ? ":move" : ""}:${moveInfo.space?.id ?? ""}:${moveInfo.space?.name ?? ""}:${currentBoardTitle ?? ""}:${ui.renamingBoard ? "1" : "0"}:${S.eds.board.grid}:${boardModeration().locked ? "1" : "0"}:${ui.localView.soloLayerId ?? ""}:${ui.localView.activeViewId ?? ""}:${viewsOf(S.eds.board.doc).length}:${ribbonTabsKey()}`, build: buildTopbar },
    panel: { key: () => (S.role === "viewer" || ui.workspaceMode === "present" || !ui.panel.open ? "" : `${ui.workspaceMode}:${panelKey()}`), build: buildPanel },
    drawer: { key: () => (ui.workspaceMode === "present" ? "" : ui.drawer === "notes" ? notesRowsKey() : ""), build: buildDrawer },
    timeline: { key: () => { const B = S.eds.board, bi = boardInfo(B.doc), t = B.time(); return S.role !== "presenter" || ui.workspaceMode === "present" ? "" : JSON.stringify([ui.workspaceMode, ui.timelineExpanded, isCompactPhone(), bi.marks, bi.spansSig, bi.tracksSig, bi.cuesSig, bi.dur, !!B.play, B.playLoop, B.playSpeed, B.reducedMotion, B.play ? null : t, ui.workspaceMode === "animate" ? [...B.sel].join(",") : ""]); }, build: timeline },
    hud: { key: hudKey, build: hud },
    overlays: { key: () => JSON.stringify([S.status, trashShown(), S.online, S.pending, S.limited, nextTryIn() == null ? null : Math.ceil(nextTryIn() / 1000), S.settingsRefused.map(r => [r.stream, r.i, r.ready, r.code, r.keys]), expiry()?.bucket ?? null]), build: () => replace($("#overlays"), banners()) },
    dock: { key: () => "", build: dock },
    sheet: {
      key: () => {
        if (!ui.sheet || !isPhone()) return "";
        if (ui.sheet === "panel") return panelKey();
        if (ui.sheet === "tools") return `${S.eds.board.grid}|${canRenameBoard()}`;
        if (ui.sheet === "rename") return `rename:${currentBoardTitle ?? ""}`;
        if (ui.sheet === "actions") {
          const { stream: st, selected } = resolveActionSheetSelection();
          const ids = selected.map(e => `${e.id}:${e.locked ? 1 : 0}:${(e.groupIds ?? []).length}:${e.type}`);
          return `actions:${st}:${canWriteSelection(st, selected) ? 1 : 0}:${ids.join(",")}`;
        }
        return notesRowsKey();
      },
      build: sheetView,
    },
    dialogs: { key: () => (ui.dialog === "export" ? `${S.eds.board.doc.rev}|${JSON.stringify(ui.export)}` : ui.dialog === "embed" ? `embed|${ui.embed.error}` : `${ui.mermaid.elbow}`), build: dialogs },
  };
  const keys = {};
  function buildPanel() {
    const panel = $("#panel"), lay = panelLayout(ui.panel, $(".main").getBoundingClientRect().width);
    panel.hidden = S.role === "viewer" || ui.workspaceMode === "present" || !lay.show;
    if (panel.hidden) return true;
    if (busy(panel)) return false;
    syncRibbonSelection();
    const expanded = isRibbonExpanded();
    const activeTab = currentActiveTab();
    if (!expanded && ui.colorPicker && !isPhone()) {
      cancelActiveSampler();
      ui.colorPicker = null;
    }
    const VERTICAL_RIBBON_TABS = new Set(["layers", "frames", "library"]);
    const ribbonLayout = S.role !== "annotator" && expanded && VERTICAL_RIBBON_TABS.has(activeTab) ? "vertical" : "horizontal";
    panel.setAttribute?.("data-ribbon-expanded", String(expanded));
    panel.setAttribute?.("data-ribbon-layout", ribbonLayout);
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
    drawer.hidden = !ui.drawer || ui.workspaceMode === "present";
    if (drawer.hidden) return true;
    if (busy(drawer)) {
      // Typing in the compose box: refresh only the rows (a note just added must show), and leave the box (its text, its focus) alone.
      if (ui.drawer !== "notes" || !notesRefs.list || !drawer.contains(notesRefs.list)) return false;
      notesRefs.list.replaceChildren(...notesList(true).childNodes);
      return true;
    }
    replace(drawer, h("header", {}, h("h3", {}, "Annotations"), drawerTabs("drawer"), h("button.tb", { title: "Close", "aria-label": "Close annotations", onclick: () => { ui.drawer = null; chromeDirty = true; } }, icon("close", { size: 16 }))), drawerBody(ui.drawer));
    return true;
  }
  // Focus across a rebuild of the chrome: wherever it was inside a rebuilt root, it goes back to that control's twin (by label, title, text or position).
  let pendingFocus = null;
  const chromeRoots = () => ["#topbar", "#panel", "#drawer", "#timeline", "#hudBL", "#hudBC", "#hudBR", "#dock", "#sheet", "#dialogs", "#overlays"].map(sel => $(sel)).filter(Boolean);
  function chrome() {
    // Why: if a presenter is demoted mid-session to annotator/viewer, force back to `"draw"` and
    // collapse the authoring timeline so they are never stranded in Present mode without exit controls.
    if ((S.role !== "presenter" || S.effective !== "presenter") && ui.workspaceMode !== "draw") {
      ui.workspaceMode = "draw";
      ui.timelineExpanded = false;
      syncWorkspaceModeAttr("draw");
      chromeDirty = true;
    }
    inPlace();
    document.body.classList.toggle("stale", S.status !== "live");
    $("#veil").hidden = S.online;
    const now = clock.mono();
    // Countdowns (the cap's retry, the sign-in's expiry) tick once a second; playback every frame (its key buckets it).
    const ticking = expAt != null || S.limitedNextTry != null ? Math.floor(clock.now() / 1000) : "";
    const gate = [S.version(), S.status, S.pending, S.online, S.congested, S.limited, S.limitedNextTry, ticking, S.eds.board.play ? now : ""].join("|");
    if (!chromeDirty && gate === gateKey) return;
    if (chromeHeld) return;                                   // a press on the chrome: don't swap the button under it
    // Why: throttle mid-drag and incoming remote-op chrome rebuilds to CHROME_MS (250 ms), while
    // discrete local UI clicks (`chromeDirty && !S.gesture`) bypass throttling for instant feedback.
    if ((S.gesture || !chromeDirty) && now - chromeAt < CHROME_MS) return;
    const env = envKey(), force = chromeDirty || env !== keys.env;
    chromeDirty = false; gateKey = gate; chromeAt = now; keys.env = env;
    const held = pendingFocus ?? captureFocus(chromeRoots());
    pendingFocus = null;
    for (const [name, part] of Object.entries(parts)) {
      const k = part.key();
      if (!force && k === keys[name]) continue;
      if (part.build() === false) { keys[name] = undefined; continue; }   // busy: try again later
      keys[name] = k; rebuilds[name]++;
    }
    restoreFocus(held);
    if (collab && isPhone()) {
      const canvasRect = canvas.getBoundingClientRect();
      const overlays = [$("#sheet"), $("#dock")];
      const inset = overlays.reduce((max, el) => {
        const rect = el.getBoundingClientRect();
        return rect.height > 0 && rect.bottom > canvasRect.top && rect.top < canvasRect.bottom
          ? Math.max(max, canvasRect.bottom - rect.top) : max;
      }, 0);
      collab.setBottomInset(inset);
    } else collab?.setBottomInset(0);
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
  addEventListener("popstate", () => {
    if (ui.sheet) setSheet(null, { fromPopstate: true });
  });
  addEventListener("hashchange", () => {
    const next = parseDeepLink(globalThis.location);
    if (!next) return;
    if (S.status === "live" && S.eds.board.size.w && S.eds.board.size.h) {
      if (!applyDeepLink(next, { animate: true })) {
        toast(`Linked ${next.kind === "el" ? "element" : next.kind} not found`);
      }
    } else {
      pendingDeepLink = next;
    }
  });
  addEventListener("beforeunload", /** @param {BeforeUnloadEvent} e */ e => {
    if (S.pending > 0) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  addEventListener("pageshow", /** @param {PageTransitionEvent} e */ e => {
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
  matchMedia("(max-width: 1023px)").addEventListener("change", () => { chromeDirty = true; });
  matchMedia("(min-width: 1024px) and (max-width: 1279px)").addEventListener("change", e => {
    if (!e.matches && ui.moreOpen) { ui.moreOpen = false; chromeDirty = true; }
  });
  setTheme(ui.theme);
  let savedMine = 0, fitted = false, templateChecked = false, mineUser = me.user;
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
  // Auto-seed a pending template chosen from Home when a brand-new empty board first goes live (#25).
  function maybeSeedTemplate() {
    if (templateChecked || S.status !== "live") return false;
    templateChecked = true;
    if (!S.may() || S.role !== "presenter") return false;
    if (S.eds.board.doc.live().length !== 0) return false;
    const tplId = consumePendingTemplate(null, clock.now());
    if (!tplId || tplId === "blank") return false;
    const scene = buildTemplateScene(tplId);
    if (!scene || !Array.isArray(scene.elements) || !scene.elements.length) return false;
    const herdr = scene.appState?.herdr;
    if (herdr) {
      const patch = {};
      if (Array.isArray(herdr.layers) && herdr.layers.length) patch.layers = herdr.layers;
      if (Array.isArray(herdr.views)) patch.views = herdr.views;
      if (herdr.timeline) patch.timeline = herdr.timeline;
      if (Object.keys(patch).length) S.act("board", ed => ed.setAppState(patch), { settings: true });
    }
    let seeded = false;
    S.act("board", ed => {
      const ok = Boolean(ed.transact(tx => {
        for (const el of scene.elements) tx.add(el);
        return true;
      }, { history: false }));
      if (ok) { ed.fixLayer(); ed.select([]); seeded = true; }
    });
    if (!seeded) return false;
    const frames = listNamedFrames(S.eds.board.doc);
    if (frames.length) {
      jumpToFrame(frames[0].id, { animate: false });
      S.eds.board.flash = null;
    } else {
      S.fit({ animate: false });
    }
    fitted = true;
    const meta = getTemplate(tplId);
    toast(`Loaded template: ${meta?.title ?? tplId}`, 2400);
    chromeDirty = true;
    dirty = true;
    return true;
  }
  // First catch-up done: seed any pending template on an empty board, resolve any deep link, or fit everything once.
  function fitOnce() {
    if (S.status !== "live") return;
    if (!S.eds.board.size.w || !S.eds.board.size.h) return;
    if (maybeSeedTemplate()) return;
    if (pendingDeepLink) {
      const target = pendingDeepLink;
      const hasContent = S.eds.board.doc.live().length || S.eds.notes.doc.live().length || viewsOf(S.eds.board.doc).length;
      if (hasContent && !S.gesture) {
        pendingDeepLink = null;
        fitted = true;
        if (!applyDeepLink(target, { animate: true })) {
          toast(`Linked ${target.kind === "el" ? "element" : target.kind} not found`);
          S.fit({ animate: false });
        }
        return;
      }
    }
    if (fitted) return;
    const hasContent = S.eds.board.doc.live().length || S.eds.notes.doc.live().length;
    if (!hasContent) { fitted = true; return; }
    if (S.gesture) return;
    fitted = true;
    S.fit({ animate: false });
  }
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

  function openAdminShare() {
    if (!admin) return null;
    cancelActiveSampler();
    dismissOverlays();
    const savedOpener = captureOpener();
    activeShare = mountShareDialog({
      root: $("#dialogs"),
      board,
      boardTitle: displayBoardTitle(),
      role: S.effective ?? me.role ?? "viewer",
      isAdmin: S.effective === "owner",
      admin,
      origin: globalThis.location?.origin ?? "",
      onClose: () => {
        activeShare = null;
        chromeDirty = true;
        const active = document.activeElement;
        if (!active || active === document.body || active.isConnected === false) restoreOpener(savedOpener, canvas);
      },
    });
    chromeDirty = true;
    return activeShare;
  }
  if (notice) toast(notice, 6000);
  return { S, ui, net, collab, port, setTheme, openDialog, openShare: openShareDialog, setPanel, startComment };
}
