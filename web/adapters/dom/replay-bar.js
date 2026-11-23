// @ts-check
// Read-only History Replay scrubber bar DOM adapter (Issue #17).
//
// Mounts a self-contained scrubber bar with a read-only banner, Play/Pause,
// speed selector (0.5x, 1x, 2x, 4x), Prev/Next op stepping, range slider,
// timestamp + author readout, and Exit Replay button (Escape exits).

import { replayStateAt, replaySummary, stepReplay } from "../../../packages/core/replay.js";
import { h } from "./dom.js";

export const REPLAY_BANNER_TEXT = "History Replay (read-only — live board unaffected)";
export const REPLAY_SPEEDS = Object.freeze([0.5, 1, 2, 4]);
const DEFAULT_BASE_INTERVAL_MS = 500;

/**
 * Format an epoch millisecond timestamp for display in the replay readout.
 * @param {number} ts
 * @returns {string}
 */
export function formatReplayTimestamp(ts) {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "--:--:--";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss} UTC`;
}

/**
 * @typedef {object} MountReplayBarOptions
 * @property {HTMLElement} host
 * @property {import("../../../packages/core/replay.js").ReplaySession} session
 * @property {(state: import("../../../packages/core/replay.js").ReplaySnapshot) => void} [onState]
 * @property {() => void} [onExit]
 * @property {number} [initialSeq]
 * @property {number} [baseIntervalMs]
 * @property {Document} [doc]
 * @property {(fn: () => void, ms: number) => any} [setTimer]
 * @property {(id: any) => void} [clearTimer]
 */

/**
 * Mount the read-only History Replay scrubber bar into `host`.
 *
 * @param {MountReplayBarOptions} opts
 */
export function mountReplayBar({
  host,
  session,
  onState = () => {},
  onExit = () => {},
  initialSeq,
  baseIntervalMs = DEFAULT_BASE_INTERVAL_MS,
  doc = globalThis.document,
  setTimer = (fn, ms) => globalThis.setInterval(fn, ms),
  clearTimer = id => globalThis.clearInterval(id),
}) {
  const summary = replaySummary(session);
  const startSeq = typeof initialSeq === "number" && Number.isFinite(initialSeq)
    ? initialSeq
    : summary.endSeq;

  let currentState = replayStateAt(session, startSeq);
  let playing = false;
  let speed = 1;
  /** @type {any} */
  let timerId = null;
  let destroyed = false;
  let exited = false;

  const banner = h(
    "div.replay-banner",
    { role: "status", "aria-live": "polite" },
    REPLAY_BANNER_TEXT,
  );

  const playBtn = /** @type {HTMLButtonElement} */ (h(
    "button.replay-btn.replay-play",
    {
      type: "button",
      "aria-label": "Play replay",
      title: "Play",
      onclick: () => {
        if (playing) pause();
        else play();
      },
    },
    "Play",
  ));

  const prevBtn = /** @type {HTMLButtonElement} */ (h(
    "button.replay-btn.replay-prev",
    {
      type: "button",
      "aria-label": "Previous operation",
      title: "Previous op",
      onclick: () => {
        pause();
        step(-1);
      },
    },
    "Prev",
  ));

  const nextBtn = /** @type {HTMLButtonElement} */ (h(
    "button.replay-btn.replay-next",
    {
      type: "button",
      "aria-label": "Next operation",
      title: "Next op",
      onclick: () => {
        pause();
        step(1);
      },
    },
    "Next",
  ));

  const speedSelect = /** @type {HTMLSelectElement} */ (h(
    "select.replay-speed",
    {
      "aria-label": "Replay speed",
      title: "Playback speed",
      onchange: () => {
        setSpeed(Number(speedSelect.value));
      },
    },
    ...REPLAY_SPEEDS.map(s => h("option", { value: String(s) }, `${s}x`)),
  ));
  speedSelect.value = String(speed);

  const maxIdx = Math.max(0, summary.count - 1);
  const scrubber = /** @type {HTMLInputElement} */ (h(
    "input.replay-scrubber",
    {
      type: "range",
      min: "0",
      max: String(maxIdx),
      step: "1",
      value: String(Math.max(0, currentState.index)),
      "aria-label": "Scrub board history",
      oninput: () => {
        pause();
        const idx = Math.max(0, Math.min(maxIdx, Math.trunc(Number(scrubber.value) || 0)));
        if (summary.count > 0) {
          applyState(replayStateAt(session, session.entries[idx].seq));
        }
      },
      onchange: () => {
        pause();
        const idx = Math.max(0, Math.min(maxIdx, Math.trunc(Number(scrubber.value) || 0)));
        if (summary.count > 0) {
          applyState(replayStateAt(session, session.entries[idx].seq));
        }
      },
    },
  ));

  const timeReadout = h("span.replay-time", {});
  const authorReadout = h("span.replay-author", {});
  const posReadout = h("span.replay-pos", {});
  const meta = h("div.replay-meta", {}, posReadout, " · ", timeReadout, " · ", authorReadout);

  const exitBtn = /** @type {HTMLButtonElement} */ (h(
    "button.replay-btn.replay-exit",
    {
      type: "button",
      "aria-label": "Exit Replay",
      title: "Exit Replay (Escape)",
      onclick: () => exit(),
    },
    "Exit Replay",
  ));

  const controls = h(
    "div.replay-controls",
    {},
    playBtn,
    prevBtn,
    nextBtn,
    speedSelect,
    scrubber,
    meta,
    exitBtn,
  );

  const root = h(
    "section.replay-bar",
    {
      role: "region",
      "aria-label": "History Replay",
      "data-replay-bar": "true",
    },
    banner,
    controls,
  );

  function syncUI() {
    const empty = summary.count === 0;
    const atStart = empty || currentState.index <= 0;
    const atEnd = empty || currentState.index >= summary.count - 1;

    playBtn.textContent = playing ? "Pause" : "Play";
    playBtn.setAttribute("aria-label", playing ? "Pause replay" : "Play replay");
    playBtn.setAttribute("title", playing ? "Pause" : "Play");
    playBtn.disabled = empty;

    prevBtn.disabled = atStart;
    nextBtn.disabled = atEnd;
    scrubber.disabled = empty;
    scrubber.value = String(Math.max(0, currentState.index));
    scrubber.setAttribute("aria-valuetext", empty
      ? "No history"
      : `Op ${currentState.index + 1} of ${currentState.total}, seq ${currentState.seq}`);

    posReadout.textContent = empty
      ? "Op 0 / 0"
      : `Op ${currentState.index + 1} / ${currentState.total} (seq ${currentState.seq})`;
    timeReadout.textContent = formatReplayTimestamp(currentState.ts);
    authorReadout.textContent = currentState.user ?? "Unknown";
  }

  /**
   * @param {import("../../../packages/core/replay.js").ReplaySnapshot} next
   */
  function applyState(next) {
    currentState = next;
    syncUI();
    onState(currentState);
  }

  function stopTimer() {
    if (timerId !== null) {
      clearTimer(timerId);
      timerId = null;
    }
  }

  function startTimer() {
    stopTimer();
    const delay = Math.max(16, Math.round(baseIntervalMs / speed));
    timerId = setTimer(() => {
      if (destroyed || !playing) {
        stopTimer();
        return;
      }
      if (summary.count === 0 || currentState.index >= summary.count - 1) {
        pause();
        return;
      }
      const next = stepReplay(session, currentState.seq, 1);
      applyState(next);
      if (next.index >= summary.count - 1) {
        pause();
      }
    }, delay);
  }

  function play() {
    if (destroyed || summary.count === 0) return;
    if (currentState.index >= summary.count - 1) {
      applyState(replayStateAt(session, summary.startSeq));
    }
    playing = true;
    syncUI();
    startTimer();
  }

  function pause() {
    if (!playing && timerId === null) return;
    playing = false;
    stopTimer();
    syncUI();
  }

  /**
   * @param {number} nextSpeed
   */
  function setSpeed(nextSpeed) {
    if (!REPLAY_SPEEDS.includes(nextSpeed)) return;
    speed = nextSpeed;
    speedSelect.value = String(speed);
    if (playing) startTimer();
  }

  /**
   * @param {number} seq
   */
  function seekToSeq(seq) {
    if (destroyed) return;
    pause();
    applyState(replayStateAt(session, seq));
  }

  /**
   * @param {number} delta
   */
  function step(delta) {
    if (destroyed || summary.count === 0) return;
    const next = stepReplay(session, currentState.seq, delta);
    applyState(next);
  }

  /**
   * @param {KeyboardEvent} e
   */
  function onKeyDown(e) {
    if (destroyed) return;
    if (e.key === "Escape") {
      e.preventDefault?.();
      exit();
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    playing = false;
    stopTimer();
    doc?.removeEventListener?.("keydown", onKeyDown);
    root.remove?.();
  }

  function exit() {
    if (exited) return;
    exited = true;
    destroy();
    onExit();
  }

  doc?.addEventListener?.("keydown", onKeyDown);
  host.append(root);
  syncUI();
  onState(currentState);

  return {
    el: root,
    destroy,
    exit,
    play,
    pause,
    isPlaying: () => playing,
    setSpeed,
    getSpeed: () => speed,
    seekToSeq,
    step,
    getState: () => currentState,
  };
}
