// @ts-check
// Pure Slide / Frame Reader Mode state & gesture math (ZERO browser globals).
// - Default mode: "canvas" unless a presenter is actively presenting or the user toggled Reader for that board.
// - Horizontal swipe recognition with a 24-32px left/right edge-exclusion zone so swipes don't fight iOS Safari edge-back.
// - Focus mode viewport coverage math (>90% canvas).

export const EDGE_EXCLUSION_MIN_PX = 24;
export const EDGE_EXCLUSION_MAX_PX = 32;
export const DEFAULT_EDGE_EXCLUSION_PX = 28;

export const SWIPE_DISTANCE_PX = 48;
export const SWIPE_VELOCITY_PX_MS = 0.3;
export const SWIPE_AXIS_RATIO = 1.2;
export const FOCUS_CANVAS_RATIO_MIN = 0.9;

/**
 * @typedef {"canvas" | "slides"} ReaderMode
 */

/**
 * @typedef {{
 *   id: string,
 *   name?: string,
 *   title?: string,
 *   x?: number,
 *   y?: number,
 *   width?: number,
 *   height?: number,
 * }} SlideFrame
 */

/**
 * @typedef {{
 *   mode: ReaderMode,
 *   frames: SlideFrame[],
 *   index: number,
 *   focusMode: boolean,
 *   indexOpen: boolean,
 *   boardOverride: ReaderMode | null,
 * }} SlideReaderState
 */

/**
 * @typedef {{
 *   active: boolean,
 *   ignoredByEdge: boolean,
 *   startX: number,
 *   startY: number,
 *   startT: number,
 *   lastX: number,
 *   lastY: number,
 *   lastT: number,
 *   dx: number,
 *   dy: number,
 *   lockedAxis: "x" | "y" | null,
 * }} SwipeState
 */

/**
 * Clamp edge-exclusion width to the safe [24, 32] px band.
 * @param {number} [edgePx]
 * @returns {number}
 */
export function clampEdgeExclusionPx(edgePx = DEFAULT_EDGE_EXCLUSION_PX) {
  if (!Number.isFinite(edgePx)) return DEFAULT_EDGE_EXCLUSION_PX;
  return Math.min(EDGE_EXCLUSION_MAX_PX, Math.max(EDGE_EXCLUSION_MIN_PX, edgePx));
}

/**
 * Return true if `x` falls inside the left or right iOS Safari edge-back exclusion zone.
 * @param {number} x
 * @param {number} viewportWidth
 * @param {number} [edgePx]
 * @returns {boolean}
 */
export function isInEdgeExclusionZone(x, viewportWidth, edgePx = DEFAULT_EDGE_EXCLUSION_PX) {
  if (!Number.isFinite(x) || !Number.isFinite(viewportWidth) || viewportWidth <= 0) return false;
  const band = clampEdgeExclusionPx(edgePx);
  return x <= band || x >= viewportWidth - band;
}

/**
 * Resolve the initial mobile view mode.
 * Defaults to "canvas" unless:
 * - the user previously toggled "slides" for this board (`savedBoardMode === "slides"`), or
 * - a presenter is actively presenting (`hasActivePresenter === true`) and the user hasn't explicitly forced "canvas".
 * @param {{
 *   hasActivePresenter?: boolean,
 *   savedBoardMode?: ReaderMode | null,
 *   hasFrames?: boolean,
 * }} [opts]
 * @returns {ReaderMode}
 */
export function resolveInitialMode({
  hasActivePresenter = false,
  savedBoardMode = null,
  hasFrames = true,
} = {}) {
  if (savedBoardMode === "slides") return hasFrames ? "slides" : "canvas";
  if (savedBoardMode === "canvas") return "canvas";
  if (hasActivePresenter && hasFrames) return "slides";
  return "canvas";
}

/**
 * Clamp a slide index into valid bounds for `frames`.
 * @param {number} index
 * @param {number} count
 * @returns {number}
 */
export function clampSlideIndex(index, count) {
  if (count <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(count - 1, Math.trunc(index)));
}

/**
 * Human-readable label for a slide frame.
 * @param {SlideFrame | null | undefined} frame
 * @param {number} index
 * @returns {string}
 */
export function slideTitle(frame, index) {
  const raw = String(frame?.name ?? frame?.title ?? "").trim();
  return raw || `Frame ${index + 1}`;
}

/**
 * Create the initial pure Slide Reader state.
 * @param {{
 *   frames?: SlideFrame[],
 *   activeFrameId?: string | null,
 *   hasActivePresenter?: boolean,
 *   savedBoardMode?: ReaderMode | null,
 * }} [opts]
 * @returns {SlideReaderState}
 */
export function createSlideReaderState({
  frames = [],
  activeFrameId = null,
  hasActivePresenter = false,
  savedBoardMode = null,
} = {}) {
  const list = Array.isArray(frames) ? frames.filter(Boolean) : [];
  const foundIdx = activeFrameId ? list.findIndex(f => f.id === activeFrameId) : -1;
  const index = foundIdx >= 0 ? foundIdx : 0;
  const mode = resolveInitialMode({
    hasActivePresenter,
    savedBoardMode,
    hasFrames: list.length > 0,
  });
  return {
    mode,
    frames: list,
    index,
    focusMode: false,
    indexOpen: false,
    boardOverride: savedBoardMode === "canvas" || savedBoardMode === "slides" ? savedBoardMode : null,
  };
}

/**
 * Update the frame list while preserving the currently viewed frame id when possible.
 * @param {SlideReaderState} state
 * @param {SlideFrame[]} frames
 * @param {string | null} [activeFrameId]
 * @returns {SlideReaderState}
 */
export function withFrames(state, frames, activeFrameId = null) {
  const list = Array.isArray(frames) ? frames.filter(Boolean) : [];
  const currentId = activeFrameId ?? state.frames[state.index]?.id ?? null;
  const foundIdx = currentId ? list.findIndex(f => f.id === currentId) : -1;
  const index = foundIdx >= 0 ? foundIdx : clampSlideIndex(state.index, list.length);
  return {
    ...state,
    frames: list,
    index,
    mode: list.length === 0 ? "canvas" : state.mode,
    focusMode: list.length === 0 ? false : state.focusMode,
  };
}

/**
 * Switch view mode ("canvas" | "slides"), recording an explicit per-board override.
 * @param {SlideReaderState} state
 * @param {ReaderMode} mode
 * @param {{ recordOverride?: boolean }} [opts]
 * @returns {SlideReaderState}
 */
export function setReaderMode(state, mode, { recordOverride = true } = {}) {
  const nextMode = mode === "slides" && state.frames.length > 0 ? "slides" : "canvas";
  return {
    ...state,
    mode: nextMode,
    focusMode: nextMode === "slides" ? state.focusMode : false,
    indexOpen: nextMode === "slides" ? state.indexOpen : false,
    boardOverride: recordOverride ? nextMode : state.boardOverride,
  };
}

/**
 * Toggle between "canvas" and "slides".
 * @param {SlideReaderState} state
 * @returns {SlideReaderState}
 */
export function toggleReaderMode(state) {
  return setReaderMode(state, state.mode === "slides" ? "canvas" : "slides");
}

/**
 * Advance to the next slide (clamped).
 * @param {SlideReaderState} state
 * @returns {SlideReaderState}
 */
export function nextSlide(state) {
  if (state.frames.length === 0) return state;
  const index = clampSlideIndex(state.index + 1, state.frames.length);
  if (index === state.index) return state;
  return { ...state, index };
}

/**
 * Go to the previous slide (clamped).
 * @param {SlideReaderState} state
 * @returns {SlideReaderState}
 */
export function prevSlide(state) {
  if (state.frames.length === 0) return state;
  const index = clampSlideIndex(state.index - 1, state.frames.length);
  if (index === state.index) return state;
  return { ...state, index };
}

/**
 * Jump to a slide by numeric index or frame id.
 * @param {SlideReaderState} state
 * @param {number | string} target
 * @returns {SlideReaderState}
 */
export function goToSlide(state, target) {
  if (state.frames.length === 0) return state;
  const idx = typeof target === "string"
    ? state.frames.findIndex(f => f.id === target)
    : clampSlideIndex(target, state.frames.length);
  if (idx < 0) return state;
  return { ...state, index: idx };
}

/**
 * Set or toggle tap-to-hide Focus mode (only active in "slides" mode).
 * @param {SlideReaderState} state
 * @param {boolean} [on]
 * @returns {SlideReaderState}
 */
export function setFocusMode(state, on = !state.focusMode) {
  if (state.mode !== "slides") return { ...state, focusMode: false };
  const next = Boolean(on);
  return {
    ...state,
    focusMode: next,
    indexOpen: next ? false : state.indexOpen,
  };
}

/**
 * Open or close the 2-column Slide Index sheet.
 * @param {SlideReaderState} state
 * @param {boolean} open
 * @returns {SlideReaderState}
 */
export function setSlideIndexOpen(state, open) {
  const next = Boolean(open) && state.frames.length > 0;
  return {
    ...state,
    indexOpen: next,
    focusMode: next ? false : state.focusMode,
  };
}

/**
 * Screen-reader announcement string for the current slide.
 * @param {SlideReaderState} state
 * @returns {string}
 */
export function slideAnnouncement(state) {
  if (!state.frames.length) return "No frames on this board";
  const frame = state.frames[state.index];
  return `Slide ${state.index + 1} of ${state.frames.length}: ${slideTitle(frame, state.index)}`;
}

/**
 * Compute the fraction of viewport height available to the canvas.
 * In Focus mode, top/bottom slide chrome is hidden so coverage is > 0.90 (typically 1.0).
 * @param {{
 *   viewportHeight: number,
 *   topChromeHeight?: number,
 *   bottomChromeHeight?: number,
 *   focusMode?: boolean,
 *   focusChromeHeight?: number,
 * }} opts
 * @returns {number}
 */
export function canvasViewportCoverage({
  viewportHeight,
  topChromeHeight = 48,
  bottomChromeHeight = 56,
  focusMode = false,
  focusChromeHeight = 0,
}) {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 0;
  const usedChrome = focusMode
    ? Math.max(0, focusChromeHeight)
    : Math.max(0, topChromeHeight) + Math.max(0, bottomChromeHeight);
  const visible = Math.max(0, viewportHeight - usedChrome);
  return Math.min(1, visible / viewportHeight);
}

/**
 * Begin a touch swipe gesture in Slides mode.
 * Gestures originating inside the 24–32px left/right edge-exclusion zone are marked `ignoredByEdge: true`.
 * @param {{
 *   x: number,
 *   y: number,
 *   t?: number,
 *   viewportWidth: number,
 *   edgePx?: number,
 * }} opts
 * @returns {SwipeState}
 */
export function startSwipe({ x, y, t = 0, viewportWidth, edgePx = DEFAULT_EDGE_EXCLUSION_PX }) {
  const ignoredByEdge = isInEdgeExclusionZone(x, viewportWidth, edgePx);
  return {
    active: !ignoredByEdge,
    ignoredByEdge,
    startX: x,
    startY: y,
    startT: t,
    lastX: x,
    lastY: y,
    lastT: t,
    dx: 0,
    dy: 0,
    lockedAxis: null,
  };
}

/**
 * Update an in-progress swipe gesture.
 * @param {SwipeState} swipe
 * @param {{ x: number, y: number, t?: number, axisRatio?: number }} opts
 * @returns {SwipeState}
 */
export function moveSwipe(swipe, { x, y, t = swipe.lastT, axisRatio = SWIPE_AXIS_RATIO }) {
  if (!swipe || !swipe.active || swipe.ignoredByEdge) return swipe;
  const dx = x - swipe.startX;
  const dy = y - swipe.startY;
  let lockedAxis = swipe.lockedAxis;
  if (!lockedAxis && (Math.abs(dx) >= 8 || Math.abs(dy) >= 8)) {
    lockedAxis = Math.abs(dx) >= Math.abs(dy) * axisRatio ? "x" : "y";
  }
  return {
    ...swipe,
    lastX: x,
    lastY: y,
    lastT: t,
    dx,
    dy,
    lockedAxis,
  };
}

/**
 * Complete a swipe gesture and decide whether to navigate slides.
 * Swiping left (`dx < 0`) -> "next"; swiping right (`dx > 0`) -> "prev".
 * @param {SwipeState | null} swipe
 * @param {{
 *   x?: number,
 *   y?: number,
 *   t?: number,
 *   minDistancePx?: number,
 *   minVelocity?: number,
 *   axisRatio?: number,
 * }} [opts]
 * @returns {{ action: "next" | "prev" | "none", ignoredByEdge: boolean, dx: number, dy: number }}
 */
export function endSwipe(swipe, {
  x,
  y,
  t,
  minDistancePx = SWIPE_DISTANCE_PX,
  minVelocity = SWIPE_VELOCITY_PX_MS,
  axisRatio = SWIPE_AXIS_RATIO,
} = {}) {
  if (!swipe) return { action: "none", ignoredByEdge: false, dx: 0, dy: 0 };
  if (swipe.ignoredByEdge || !swipe.active) {
    return { action: "none", ignoredByEdge: Boolean(swipe.ignoredByEdge), dx: 0, dy: 0 };
  }
  const endX = x ?? swipe.lastX;
  const endY = y ?? swipe.lastY;
  const endT = t ?? swipe.lastT;
  const dx = endX - swipe.startX;
  const dy = endY - swipe.startY;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);

  if (swipe.lockedAxis === "y" || absX < absY * axisRatio) {
    return { action: "none", ignoredByEdge: false, dx, dy };
  }

  const dt = Math.max(1, endT - swipe.startT);
  const velocity = absX / dt;
  const enoughTravel = absX >= minDistancePx || (absX >= 24 && velocity >= minVelocity);
  if (!enoughTravel) {
    return { action: "none", ignoredByEdge: false, dx, dy };
  }
  return {
    action: dx < 0 ? "next" : "prev",
    ignoredByEdge: false,
    dx,
    dy,
  };
}
