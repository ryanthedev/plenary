// @ts-check
// Slide / Frame Reader Mode DOM adapter (part of the dom adapter group).
// - 1-tap Canvas <-> Slides toggle
// - Defaults to Canvas unless a presenter is actively presenting or the user toggled Reader for that board
// - 24-32px left/right edge-exclusion zone so horizontal swipes don't fight iOS Safari edge-back
// - Always-visible Prev/Next + 2-column Slide Index bottom sheet
// - Tap-to-hide Focus mode (>90% canvas)
// - Polite aria-live announcements on slide, mode, and focus changes.

import { h, replace } from "../dom.js";
import { icon } from "../icons.js";
import { announce } from "../focus.js";
import { createBottomSheet } from "./sheet.js";
import {
  DEFAULT_EDGE_EXCLUSION_PX,
  createSlideReaderState,
  withFrames,
  setReaderMode,
  toggleReaderMode,
  nextSlide,
  prevSlide,
  goToSlide,
  setFocusMode,
  setSlideIndexOpen,
  slideTitle,
  slideAnnouncement,
  canvasViewportCoverage,
  startSwipe,
  moveSwipe,
  endSwipe,
} from "../../../core/mobile/slides.js";

const PREF_PREFIX = "plenary.mobile.reader.";

/**
 * @param {any} prefs
 * @param {string | null | undefined} boardId
 * @returns {"canvas" | "slides" | null}
 */
function readBoardModePref(prefs, boardId) {
  if (!prefs || !boardId) return null;
  try {
    const raw = typeof prefs.get === "function" ? prefs.get(`${PREF_PREFIX}${boardId}`) : null;
    return raw === "canvas" || raw === "slides" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * @param {any} prefs
 * @param {string | null | undefined} boardId
 * @param {"canvas" | "slides"} mode
 */
function writeBoardModePref(prefs, boardId, mode) {
  if (!prefs || !boardId || typeof prefs.set !== "function") return;
  try {
    prefs.set(`${PREF_PREFIX}${boardId}`, mode);
  } catch {
    // ignore storage errors
  }
}

/**
 * Create the Mobile Slide / Frame Reader controller.
 *
 * @param {{
 *   host: HTMLElement,
 *   sheetHost?: HTMLElement,
 *   viewportEl?: HTMLElement | null,
 *   boardId?: string | null,
 *   frames?: import("../../../core/mobile/slides.js").SlideFrame[],
 *   activeFrameId?: string | null,
 *   hasActivePresenter?: boolean,
 *   prefs?: { get?: (k: string) => any, set?: (k: string, v: any) => void } | null,
 *   edgeExclusionPx?: number,
 *   onJumpToFrame?: (frame: import("../../../core/mobile/slides.js").SlideFrame, index: number) => void,
 *   onModeChange?: (mode: "canvas" | "slides") => void,
 *   onFocusChange?: (focusMode: boolean) => void,
 *   doc?: Document | null,
 *   win?: any,
 * }} opts
 */
export function createSlideReader({
  host,
  sheetHost = host,
  viewportEl = null,
  boardId = null,
  frames = [],
  activeFrameId = null,
  hasActivePresenter = false,
  prefs = null,
  edgeExclusionPx = DEFAULT_EDGE_EXCLUSION_PX,
  onJumpToFrame = null,
  onModeChange = null,
  onFocusChange = null,
  doc = globalThis.document ?? null,
  win = globalThis.window ?? globalThis,
}) {
  const savedBoardMode = readBoardModePref(prefs, boardId);
  let state = createSlideReaderState({
    frames,
    activeFrameId,
    hasActivePresenter,
    savedBoardMode,
  });

  /** @type {import("../../../core/mobile/slides.js").SwipeState | null} */
  let swipe = null;
  let activePointerId = /** @type {number | null} */ (null);
  let destroyed = false;

  // Dedicated polite live region for deterministic screen-reader announcements
  const liveEl = h("div.mp2-sr-only", {
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true",
    "data-live": "slides",
  });

  function say(text) {
    liveEl.textContent = "";
    liveEl.textContent = text;
    announce(text);
    return text;
  }

  // ── 1-tap Canvas <-> Slides toggle ──
  const canvasBtn = h("button.mp2-mode-btn", {
    type: "button",
    "data-mode": "canvas",
    "aria-pressed": String(state.mode === "canvas"),
    onclick: () => setMode("canvas"),
  }, "Canvas");

  const slidesBtn = h("button.mp2-mode-btn", {
    type: "button",
    "data-mode": "slides",
    "aria-pressed": String(state.mode === "slides"),
    onclick: () => setMode("slides"),
  }, "Slides");

  const toggleEl = h("div.mp2-mode-toggle", {
    role: "group",
    "aria-label": "View mode",
    "data-reader-toggle": "",
  }, canvasBtn, slidesBtn);

  // ── Slides top pill & Focus toggle ──
  const slideTitleEl = h("span.mp2-slide-title", {});
  const focusBtn = h("button.mp2-slides-focus-btn", {
    type: "button",
    "aria-label": "Enter focus mode",
    "aria-pressed": "false",
    "data-slide-action": "focus",
    onclick: () => toggleFocusMode(),
  }, icon("fit", { size: 18 }));

  const topChromeEl = h("div.mp2-slides-top", { "data-slides-top": "" },
    slideTitleEl,
    focusBtn);

  // ── Always-visible Prev / Slide Index / Next bar ──
  const prevBtn = h("button.mp2-slide-nav-btn", {
    type: "button",
    "aria-label": "Previous slide",
    "data-slide-action": "prev",
    onclick: () => prev(),
  }, icon("chevronLeft", { size: 18 }), h("span", {}, "Prev"));

  const indexBtn = h("button.mp2-slide-index-btn", {
    type: "button",
    "aria-label": "Open slide index",
    "aria-haspopup": "dialog",
    "data-slide-action": "index",
    onclick: () => openIndex(),
  }, "0 / 0");

  const nextBtn = h("button.mp2-slide-nav-btn", {
    type: "button",
    "aria-label": "Next slide",
    "data-slide-action": "next",
    onclick: () => next(),
  }, h("span", {}, "Next"), icon("chevronRight", { size: 18 }));

  const navEl = h("nav.mp2-slides-nav", {
    "aria-label": "Slide navigation",
    "data-slides-nav": "",
  }, prevBtn, indexBtn, nextBtn);

  // Subtle floating exit button shown only in Focus mode
  const exitFocusBtn = h("button.mp2-exit-focus-btn", {
    type: "button",
    hidden: true,
    "aria-label": "Show slide controls",
    "data-slide-action": "exit-focus",
    onclick: () => setFocus(false),
  }, "Controls");

  const chromeEl = h("div.mp2-slides-chrome", {
    hidden: state.mode !== "slides",
    "data-slides-chrome": "",
  }, topChromeEl, navEl);

  const el = h("div.mp2-slide-reader", {
    "data-mode": state.mode,
    "data-focus-mode": String(state.focusMode),
  }, toggleEl, chromeEl, exitFocusBtn, liveEl);

  host.append(el);

  // ── 2-column Slide Index bottom sheet ──
  const indexGrid = h("div.mp2-slide-index-grid", {
    role: "list",
    "aria-label": "Slide index",
    "data-columns": "2",
  });

  const indexSheet = createBottomSheet({
    host: sheetHost,
    title: "Slides",
    subtitle: `${state.frames.length} frames`,
    kind: "slide-index",
    initialDetent: "half",
    allowDetents: ["half", "full"],
    body: indexGrid,
    doc,
    win,
    onClose: () => {
      if (state.indexOpen) {
        state = setSlideIndexOpen(state, false);
        render();
      }
    },
  });

  function renderIndexGrid() {
    indexSheet.setTitle("Slides", `${state.frames.length} ${state.frames.length === 1 ? "frame" : "frames"}`);
    const cards = state.frames.map((frame, i) => {
      const current = i === state.index;
      const label = slideTitle(frame, i);
      return h("button.mp2-slide-card" + (current ? ".current" : ""), {
        type: "button",
        role: "listitem",
        "data-slide-index": String(i),
        "data-frame-id": frame.id,
        "aria-current": current ? "true" : null,
        "aria-label": `Slide ${i + 1} of ${state.frames.length}: ${label}`,
        onclick: () => {
          goTo(i);
          closeIndex();
        },
      },
      h("span.mp2-slide-card-num", {}, String(i + 1)),
      h("span.mp2-slide-card-title", {}, label));
    });
    replace(indexGrid, cards);
  }

  function render() {
    const isSlides = state.mode === "slides";
    const total = state.frames.length;
    const current = state.frames[state.index] ?? null;

    el.setAttribute("data-mode", state.mode);
    el.setAttribute("data-focus-mode", String(state.focusMode));
    el.classList.toggle("mp2-focus-mode", isSlides && state.focusMode);

    canvasBtn.setAttribute("aria-pressed", String(!isSlides));
    canvasBtn.classList.toggle("active", !isSlides);
    slidesBtn.setAttribute("aria-pressed", String(isSlides));
    slidesBtn.classList.toggle("active", isSlides);
    slidesBtn.disabled = total === 0;

    chromeEl.hidden = !isSlides || state.focusMode;
    exitFocusBtn.hidden = !(isSlides && state.focusMode);

    focusBtn.setAttribute("aria-pressed", String(state.focusMode));
    focusBtn.setAttribute("aria-label", state.focusMode ? "Exit focus mode" : "Enter focus mode");

    slideTitleEl.textContent = current ? slideTitle(current, state.index) : "No frames";
    indexBtn.textContent = total > 0 ? `${state.index + 1} / ${total}` : "0 / 0";
    indexBtn.setAttribute("aria-label", total > 0 ? `Slide ${state.index + 1} of ${total}. Open slide index` : "No slides");
    indexBtn.disabled = total === 0;

    prevBtn.disabled = !isSlides || total === 0 || state.index <= 0;
    nextBtn.disabled = !isSlides || total === 0 || state.index >= total - 1;

    if (state.indexOpen) renderIndexGrid();
  }

  function emitJump() {
    const frame = state.frames[state.index];
    if (frame) onJumpToFrame?.(frame, state.index);
  }

  /** @param {"canvas" | "slides"} mode */
  function setMode(mode, { persist = true, silent = false } = {}) {
    const prevMode = state.mode;
    const prevFocus = state.focusMode;
    state = setReaderMode(state, mode, { recordOverride: persist });
    if (persist) writeBoardModePref(prefs, boardId, state.mode);
    if (state.mode !== "slides" && indexSheet.isOpen()) indexSheet.close("mode-change");
    render();
    if (prevMode !== state.mode) {
      onModeChange?.(state.mode);
      if (state.mode === "slides") emitJump();
      if (!silent) {
        say(state.mode === "slides" ? `Slides reader mode. ${slideAnnouncement(state)}` : "Canvas mode");
      }
    }
    if (prevFocus !== state.focusMode) onFocusChange?.(state.focusMode);
    return state.mode;
  }

  function toggleMode() {
    const next = toggleReaderMode(state).mode;
    return setMode(next);
  }

  function next() {
    if (state.mode !== "slides") return false;
    const before = state.index;
    state = nextSlide(state);
    if (state.index === before) return false;
    render();
    emitJump();
    say(slideAnnouncement(state));
    return true;
  }

  function prev() {
    if (state.mode !== "slides") return false;
    const before = state.index;
    state = prevSlide(state);
    if (state.index === before) return false;
    render();
    emitJump();
    say(slideAnnouncement(state));
    return true;
  }

  /** @param {number | string} target */
  function goTo(target) {
    const before = state.index;
    state = goToSlide(state, target);
    if (state.index === before && state.frames.length > 0) {
      emitJump();
      return false;
    }
    render();
    emitJump();
    say(slideAnnouncement(state));
    return true;
  }

  function openIndex() {
    if (state.frames.length === 0) return;
    state = setSlideIndexOpen(state, true);
    renderIndexGrid();
    render();
    indexSheet.open({ detent: "half", returnFocusTo: indexBtn });
  }

  function closeIndex() {
    if (!state.indexOpen && !indexSheet.isOpen()) return;
    state = setSlideIndexOpen(state, false);
    indexSheet.close("select");
    render();
  }

  /** @param {boolean} [on] */
  function setFocus(on) {
    const prevFocus = state.focusMode;
    state = setFocusMode(state, on);
    if (state.focusMode && indexSheet.isOpen()) indexSheet.close("focus-mode");
    render();
    if (prevFocus !== state.focusMode) {
      onFocusChange?.(state.focusMode);
      say(state.focusMode ? "Focus mode on. Tap canvas to show controls." : "Focus mode off.");
    }
    return state.focusMode;
  }

  function toggleFocusMode() {
    return setFocus(!state.focusMode);
  }

  /** @param {import("../../../core/mobile/slides.js").SlideFrame[]} nextFrames */
  function setFrames(nextFrames, nextActiveFrameId = null) {
    state = withFrames(state, nextFrames, nextActiveFrameId);
    render();
  }

  /** @param {boolean} active */
  function setActivePresenter(active) {
    if (active && state.boardOverride === null && state.frames.length > 0 && state.mode === "canvas") {
      setMode("slides", { persist: false });
    }
  }

  // ── Viewport swipe & tap-to-hide Focus mode handlers ──
  function viewportWidth() {
    const rectW = viewportEl?.getBoundingClientRect?.()?.width;
    if (typeof rectW === "number" && rectW > 0) return rectW;
    if (typeof win?.innerWidth === "number" && win.innerWidth > 0) return win.innerWidth;
    return 375;
  }

  function viewportHeight() {
    const rectH = viewportEl?.getBoundingClientRect?.()?.height;
    if (typeof rectH === "number" && rectH > 0) return rectH;
    if (typeof win?.innerHeight === "number" && win.innerHeight > 0) return win.innerHeight;
    return 667;
  }

  /** @param {{ x: number, y: number, t?: number, viewportWidth?: number }} info */
  function handleSwipeStart(info) {
    if (state.mode !== "slides") {
      swipe = null;
      return { active: false, ignoredByEdge: false };
    }
    swipe = startSwipe({
      x: info.x,
      y: info.y,
      t: info.t ?? 0,
      viewportWidth: info.viewportWidth ?? viewportWidth(),
      edgePx: edgeExclusionPx,
    });
    return { active: swipe.active, ignoredByEdge: swipe.ignoredByEdge };
  }

  /** @param {{ x: number, y: number, t?: number }} info */
  function handleSwipeMove(info) {
    if (!swipe) return;
    swipe = moveSwipe(swipe, info);
  }

  /** @param {{ x?: number, y?: number, t?: number }} [info] */
  function handleSwipeEnd(info = {}) {
    const cur = swipe;
    swipe = null;
    if (!cur) return { action: "none", ignoredByEdge: false, tapped: false };
    if (cur.ignoredByEdge) return { action: "none", ignoredByEdge: true, tapped: false };

    const result = endSwipe(cur, info);
    if (result.action === "next") {
      next();
      return { ...result, tapped: false };
    }
    if (result.action === "prev") {
      prev();
      return { ...result, tapped: false };
    }

    // Minimal movement -> tap-to-hide Focus mode
    if (Math.hypot(result.dx, result.dy) < 10 && state.mode === "slides") {
      toggleFocusMode();
      return { action: "none", ignoredByEdge: false, tapped: true };
    }
    return { ...result, tapped: false };
  }

  const onPointerDown = e => {
    if (state.mode !== "slides") return;
    if (e.pointerType && e.pointerType !== "touch" && e.pointerType !== "pen") return;
    activePointerId = typeof e.pointerId === "number" ? e.pointerId : 0;
    handleSwipeStart({
      x: typeof e.clientX === "number" ? e.clientX : 0,
      y: typeof e.clientY === "number" ? e.clientY : 0,
      t: typeof e.timeStamp === "number" ? e.timeStamp : 0,
    });
  };

  const onPointerMove = e => {
    if (!swipe || activePointerId === null) return;
    const pid = typeof e.pointerId === "number" ? e.pointerId : 0;
    if (pid !== activePointerId) return;
    handleSwipeMove({
      x: typeof e.clientX === "number" ? e.clientX : swipe.lastX,
      y: typeof e.clientY === "number" ? e.clientY : swipe.lastY,
      t: typeof e.timeStamp === "number" ? e.timeStamp : swipe.lastT,
    });
  };

  const onPointerUp = e => {
    if (activePointerId === null) return;
    const pid = typeof e.pointerId === "number" ? e.pointerId : 0;
    if (pid !== activePointerId) return;
    activePointerId = null;
    handleSwipeEnd({
      x: typeof e.clientX === "number" ? e.clientX : undefined,
      y: typeof e.clientY === "number" ? e.clientY : undefined,
      t: typeof e.timeStamp === "number" ? e.timeStamp : undefined,
    });
  };

  const onPointerCancel = () => {
    activePointerId = null;
    swipe = null;
  };

  const onKeyDown = e => {
    if (state.mode !== "slides" || state.indexOpen) return;
    if (e.key === "ArrowRight" || e.key === "PageDown") {
      e.preventDefault?.();
      next();
    } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
      e.preventDefault?.();
      prev();
    } else if (e.key === "Home") {
      e.preventDefault?.();
      goTo(0);
    } else if (e.key === "End") {
      e.preventDefault?.();
      goTo(state.frames.length - 1);
    }
  };

  if (viewportEl && typeof viewportEl.addEventListener === "function") {
    viewportEl.addEventListener("pointerdown", onPointerDown);
    viewportEl.addEventListener("pointermove", onPointerMove);
    viewportEl.addEventListener("pointerup", onPointerUp);
    viewportEl.addEventListener("pointercancel", onPointerCancel);
  }
  el.addEventListener("keydown", onKeyDown);

  render();

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (viewportEl && typeof viewportEl.removeEventListener === "function") {
      viewportEl.removeEventListener("pointerdown", onPointerDown);
      viewportEl.removeEventListener("pointermove", onPointerMove);
      viewportEl.removeEventListener("pointerup", onPointerUp);
      viewportEl.removeEventListener("pointercancel", onPointerCancel);
    }
    el.removeEventListener("keydown", onKeyDown);
    indexSheet.destroy();
    el.remove();
  }

  return {
    el,
    toggleEl,
    navEl,
    indexSheet,
    liveEl,
    getState: () => ({ ...state }),
    getCanvasCoverage: () => canvasViewportCoverage({
      viewportHeight: viewportHeight(),
      focusMode: state.focusMode,
    }),
    setFrames,
    setActivePresenter,
    setMode,
    toggleMode,
    next,
    prev,
    goTo,
    openIndex,
    closeIndex,
    toggleFocusMode,
    setFocusMode: setFocus,
    handleSwipeStart,
    handleSwipeMove,
    handleSwipeEnd,
    destroy,
  };
}
