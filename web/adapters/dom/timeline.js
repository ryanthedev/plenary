// @ts-check
// Timeline playback bar adapter (DOM): play/pause, step start/end, smooth pointer + keyboard
// scrubber, per-element span bars & start markers, mm:ss.t readout, loop toggle, playback speed,
// and prefers-reduced-motion awareness. Pure math lives in packages/core/anim.js.

import { PLAYBACK_SPEEDS, formatTime, scrubTime } from "../../../packages/core/anim.js";
import { icon } from "./icons.js";

/** Detect user's OS/browser prefers-reduced-motion preference safely (works in stub DOMs too). */
export function prefersReducedMotion() {
  try {
    return typeof matchMedia === "function" && !!matchMedia("(prefers-reduced-motion: reduce)")?.matches;
  } catch {
    return false;
  }
}

/** Update playhead, fill bar, and mm:ss.t readout in place every frame without rebuilding DOM. */
export function updateTimelineInPlace(tl, board, dur) {
  if (!tl.fill) return;
  const safeDur = Math.max(1, dur);
  const t = Math.max(0, Math.min(safeDur, board.time() ?? 0));
  const pct = Math.min(100, (t / safeDur) * 100);
  const sig = `${pct.toFixed(3)}|${Math.floor(t / 100)}|${Math.floor(safeDur / 100)}`;
  if (sig === tl.sig) return;
  tl.sig = sig;
  tl.fill.style.width = `${pct}%`;
  tl.head.style.left = `${pct}%`;
  tl.text.textContent = `${formatTime(t)} / ${formatTime(safeDur)}`;
  tl.track?.setAttribute?.("aria-valuenow", String(Math.round(t)));
}

/**
 * Build the timeline footer into `el`.
 * @param {HTMLElement} el
 * @param {{ board: any, dur: number, marks: number[], spans: any[], tl: any, h: Function, replace: Function, onChange: Function, onSeek?: Function, reducedMotion?: boolean }} ctx
 */
export function buildTimeline(el, ctx) {
  const { board: B, dur, marks: starts, spans = [], tl, h, replace, onChange } = ctx;
  const onSeek = ctx.onSeek ?? (() => updateTimelineInPlace(tl, B, safeDur));
  const reduced = ctx.reducedMotion ?? prefersReducedMotion();
  const safeDur = Math.max(1, dur);

  // Preserve keyboard focus across structural rebuilds (e.g. pressing Space on the slider).
  const active = typeof document !== "undefined" ? document.activeElement : null;
  let restoreFocus = null;
  if (active && el.contains?.(active)) {
    if (active === tl.track || active.getAttribute?.("role") === "slider") restoreFocus = "track";
    else if (active.className?.includes?.("tl-speed")) restoreFocus = "speed";
  }

  const findSpan = target => {
    const spanEl = target?.closest?.(".span") ?? (target?.getAttribute?.("data-anim-id") ? target : null);
    if (!spanEl) return null;
    const id = spanEl.getAttribute?.("data-anim-id") ?? spanEl.attrs?.["data-anim-id"];
    return spans.find(s => s.id === id) ?? null;
  };

  const scrubAtClientX = (trackEl, clientX) => {
    const r = trackEl.getBoundingClientRect();
    const ratio = r.width > 0 ? (clientX - r.left) / r.width : 0;
    B.seekTo(scrubTime(ratio, safeDur), { explicit: true });
    onSeek();
  };

  let dragging = false;
  const onTrackPointerDown = e => {
    if (e.button != null && e.button !== 0) return;
    const sp = findSpan(e.target);
    if (sp) {
      e.stopPropagation?.();
      B.select([sp.id]);
      B.seekTo(sp.start, { explicit: true });
      onSeek();
      onChange();
      return;
    }
    e.preventDefault?.();
    dragging = true;
    const trackEl = e.currentTarget;
    if (e.pointerId != null) {
      try { trackEl.setPointerCapture?.(e.pointerId); } catch {}
    }
    scrubAtClientX(trackEl, e.clientX);
  };
  const onTrackPointerMove = e => {
    if (!dragging) return;
    e.preventDefault?.();
    scrubAtClientX(e.currentTarget, e.clientX);
  };
  const onTrackPointerUp = e => {
    if (!dragging) return;
    dragging = false;
    if (e.pointerId != null) {
      try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch {}
    }
  };
  const onTrackKeyDown = e => {
    const step = e.shiftKey ? 500 : 100;
    const cur = B.time() ?? 0;
    if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); B.seekTo(cur - step, { explicit: true }); onSeek(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); B.seekTo(cur + step, { explicit: true }); onSeek(); }
    else if (e.key === "Home") { e.preventDefault(); e.stopPropagation(); B.stepToStart({ explicit: true }); onSeek(); }
    else if (e.key === "End") { e.preventDefault(); e.stopPropagation(); B.stepToEnd({ explicit: true }); onSeek(); }
    else if (e.key === " " || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); B.playToggle(); onChange(); }
  };

  const spanNodes = spans.map((sp, idx) => {
    const left = Math.min(100, (sp.start / safeDur) * 100);
    const width = Math.max(1.5, Math.min(100 - left, (sp.duration / safeDur) * 100));
    return h(`div.span.cat-${sp.category}`, {
      "data-anim-id": sp.id,
      title: `#${idx + 1} ${sp.label} (${sp.easing}) · ${formatTime(sp.start)}–${formatTime(sp.end)}`,
      style: { left: `${left}%`, width: `${width}%` },
      onclick: ev => {
        ev.stopPropagation();
        B.select([sp.id]);
        B.seekTo(sp.start, { explicit: true });
        onSeek();
        onChange();
      },
    });
  });

  const markNodes = starts.map(s => h("div.mark", { style: { left: `${Math.min(100, (s / safeDur) * 100)}%` } }));

  // The head, fill, track and time are kept and moved in place every frame while playing or scrubbing.
  tl.fill = h("div.fill");
  tl.head = h("div.head");
  tl.text = h("span.t");
  tl.sig = "";

  const track = h("div.track", {
    role: "slider",
    tabIndex: 0,
    "aria-label": "Timeline scrubber",
    "aria-valuemin": "0",
    "aria-valuemax": String(Math.round(safeDur)),
    "aria-valuenow": String(Math.round(B.time() ?? 0)),
    title: "Click or drag to scrub",
    onclick: e => {
      const sp = findSpan(e.target);
      if (sp) return;
      scrubAtClientX(e.currentTarget, e.clientX);
    },
    onpointerdown: onTrackPointerDown,
    onpointermove: onTrackPointerMove,
    onpointerup: onTrackPointerUp,
    onpointercancel: onTrackPointerUp,
    onlostpointercapture: onTrackPointerUp,
    onkeydown: onTrackKeyDown,
  }, tl.fill, spanNodes, markNodes, tl.head);
  tl.track = track;

  const speedSel = h("select.tl-speed", {
    title: "Playback speed",
    "aria-label": "Playback speed",
    value: String(B.playSpeed ?? 1),
    onchange: e => {
      B.setPlaySpeed(Number(e.currentTarget.value));
      onChange();
    },
  }, PLAYBACK_SPEEDS.map(sp => h("option", { value: String(sp), selected: (B.playSpeed ?? 1) === sp }, `${sp}x`)));

  const loopBtn = h("button.c.tl-loop" + (B.playLoop ? ".on" : ""), {
    title: B.playLoop ? "Loop: on" : "Loop: off",
    "aria-label": "Toggle loop",
    "aria-pressed": B.playLoop ? "true" : "false",
    "data-loop": B.playLoop ? "on" : "off",
    onclick: () => { B.setPlayLoop(!B.playLoop); onChange(); },
  }, icon("repeat", { size: 14 }));

  const rmBadge = reduced
    ? h("span.tl-rm", { title: "Reduced motion preference detected (tap Play to animate)" }, "Reduced motion")
    : null;

  replace(
    el,
    h("div.tl-controls", {},
      h("button.c", {
        title: "Play / pause (⇧Space)",
        "aria-label": B.play ? "Pause" : "Play",
        "data-state": B.play ? "playing" : "paused",
        onclick: () => { B.playToggle(); onChange(); },
      }, icon(B.play ? "pause" : "play", { size: 14 })),
      h("button.c", {
        title: "Step to start",
        "aria-label": "Step to start",
        "data-action": "step-start",
        onclick: () => { B.stepToStart(); onSeek(); },
      }, icon("skipBack", { size: 13 })),
      h("button.c", {
        title: "Step to end",
        "aria-label": "Step to end",
        "data-action": "step-end",
        onclick: () => { B.stepToEnd(); onSeek(); },
      }, icon("skipForward", { size: 13 })),
      h("button.c", {
        title: "Back to editing (Esc)",
        "aria-label": "Stop",
        onclick: () => { B.stopPlay(); onChange(); },
      }, icon("stop", { size: 14 }))),
    track,
    tl.text,
    loopBtn,
    speedSel,
    rmBadge,
  );

  updateTimelineInPlace(tl, B, safeDur);

  if (restoreFocus === "track") track.focus?.();
  else if (restoreFocus === "speed") speedSel.focus?.();
}
