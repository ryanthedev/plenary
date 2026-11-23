// @ts-check
// Multi-swimlane movie timeline scrubber & compact playback bar adapter (DOM):
// - Transport controls: step start/end, play/pause, stop, Next cue, mm:ss.t readout, speed, loop
// - Authoring toolbar: + Animate, + Cue, Cascade, Align, Tracks (N) expand/collapse
// - Compact Clip Inspector in expanded header (preset grouped dropdown + easing)
// - Expanded NLE Multi-Swimlane Drawer (> 640px; stays compact single-bar on <= 640px phones):
//   - Time ruler with rulerTicks(), click/drag scrub, draggable ◆ cue pause markers
//   - Horizontal swimlane rows per animated element from timelineTracks(doc)
//   - Left track header: ↑/↓ reorder, shape badge + label (select & focus), preset select, remove ×
//   - Right track lane: tick grid + colored draggable clip bar (move + left/right edge resize with snapTrackTime)
//   - Full-height vertical playhead needle updated in place at 60fps (zero DOM rebuilds)
// Pure math lives in packages/core/anim.js.

import {
  PLAYBACK_SPEEDS,
  PRESETS,
  EASING_META,
  MIN_CLIP_DURATION,
  formatTime,
  scrubTime,
  timelineTracks,
  snapTrackTime,
  rulerTicks,
  cuesOf,
  presetsByCategory,
  canonicalEasing,
  getPreset,
} from "../../../packages/core/anim.js";
import { isLabel } from "../../../packages/core/model.js";
import { icon } from "./icons.js";

/** Detect user's OS/browser prefers-reduced-motion preference safely (works in stub DOMs too). */
export function prefersReducedMotion() {
  try {
    return typeof matchMedia === "function" && !!matchMedia("(prefers-reduced-motion: reduce)")?.matches;
  } catch {
    return false;
  }
}

/** Resolve safe timeline duration in ms including any cue markers placed beyond the last clip. */
function effectiveDuration(board, dur) {
  const cues = board?.doc ? cuesOf(board.doc) : [];
  const maxCueAt = cues.length ? cues[cues.length - 1].at : 0;
  return Math.max(1, Number.isFinite(dur) ? dur : 0, maxCueAt);
}

/** Update playhead, fill bar, full-height needle, and mm:ss.t readout in place every frame without rebuilding DOM. */
export function updateTimelineInPlace(tl, board, dur) {
  if (!tl.fill && !tl.needle) return;
  const safeDur = effectiveDuration(board, dur);
  const t = Math.max(0, Math.min(safeDur, board.time() ?? 0));
  const pct = Math.min(100, (t / safeDur) * 100);
  const sig = `${pct.toFixed(3)}|${Math.floor(t / 100)}|${Math.floor(safeDur / 100)}`;
  if (sig === tl.sig) return;
  tl.sig = sig;
  if (tl.fill) tl.fill.style.width = `${pct}%`;
  if (tl.head) tl.head.style.left = `${pct}%`;
  if (tl.needle) tl.needle.style.left = `${pct}%`;
  if (tl.text) tl.text.textContent = `${formatTime(t)} / ${formatTime(safeDur)}`;
  tl.track?.setAttribute?.("aria-valuenow", String(Math.round(t)));
}

/** Map element type to an icon key in icons.js. */
function shapeIconName(type) {
  if (type === "rectangle" || type === "diamond" || type === "ellipse" || type === "arrow" || type === "line" || type === "freedraw" || type === "text" || type === "frame" || type === "image") {
    return type;
  }
  return "rectangle";
}

/** Build grouped `<optgroup>` preset options for a `<select>`. */
function buildPresetOptions(h, currentPreset) {
  const groups = presetsByCategory();
  const nodes = groups.map(g =>
    h("optgroup", { label: g.label },
      g.presets.map(p => h("option", { value: p.id, selected: currentPreset === p.id }, p.label))));
  // Preserve legacy preset if currently assigned on the element.
  if (currentPreset && currentPreset !== "keyframes" && Object.hasOwn(PRESETS, currentPreset) && PRESETS[currentPreset].legacy) {
    nodes.unshift(h("option", { value: currentPreset, selected: true }, PRESETS[currentPreset].label));
  }
  if (currentPreset === "keyframes") {
    nodes.unshift(h("option", { value: "keyframes", selected: true }, "Keyframes"));
  }
  return nodes;
}

/**
 * Build the timeline footer (compact bar or expanded multi-swimlane NLE drawer) into `el`.
 * @param {HTMLElement} el
 * @param {{
 *   board: any,
 *   dur: number,
 *   marks: number[],
 *   spans: any[],
 *   tracks?: any[],
 *   cues?: Array<{ id: string, at: number, label: string }>,
 *   tl: any,
 *   h: Function,
 *   replace: Function,
 *   onChange: Function,
 *   onSeek?: Function,
 *   reducedMotion?: boolean,
 *   expanded?: boolean,
 *   compactOnly?: boolean,
 *   showAuthoring?: boolean,
 *   canEdit?: boolean,
 *   act?: (fn: (ed: any) => any) => any,
 *   actSettings?: (fn: (ed: any) => any) => any,
 *   onToggleExpand?: (next: boolean) => void,
 *   onFocusElement?: (id: string) => void,
 * }} ctx
 */
export function buildTimeline(el, ctx) {
  const { board: B, dur, marks: starts, spans = [], tl, h, replace, onChange } = ctx;
  const tracks = ctx.tracks ?? timelineTracks(B.doc);
  const cues = ctx.cues ?? cuesOf(B.doc);
  const canEdit = ctx.canEdit ?? !B.readOnly;
  const act = ctx.act ?? (fn => fn(B));
  const actSettings = ctx.actSettings ?? (fn => fn(B));
  const compactOnly = Boolean(ctx.compactOnly);
  const isExpanded = Boolean(ctx.expanded && !compactOnly);
  const showAuthoring = Boolean(ctx.showAuthoring || isExpanded);
  const reduced = ctx.reducedMotion ?? prefersReducedMotion();
  const maxCueAt = cues.length ? cues[cues.length - 1].at : 0;
  const naturalDur = Math.max(Number.isFinite(dur) ? dur : 0, maxCueAt);
  const safeDur = Math.max(1, naturalDur);
  const rulerDur = naturalDur > 0 ? safeDur : 3000;
  const onSeek = ctx.onSeek ?? (() => updateTimelineInPlace(tl, B, safeDur));

  el.classList?.toggle?.("tl-expanded", isExpanded);
  el.setAttribute?.("data-expanded", isExpanded ? "true" : "false");

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

  const scrubAtClientX = (trackEl, clientX, targetDur = safeDur) => {
    const r = trackEl.getBoundingClientRect();
    const ratio = r.width > 0 ? (clientX - r.left) / r.width : 0;
    B.seekTo(scrubTime(ratio, targetDur), { explicit: true });
    onSeek();
  };

  const makeScrubberHandlers = (targetDur, checkSpan) => {
    let dragging = false;
    const onPointerDown = e => {
      if (e.button != null && e.button !== 0) return;
      if (checkSpan) {
        const sp = findSpan(e.target);
        if (sp) {
          e.stopPropagation?.();
          B.select([sp.id]);
          B.seekTo(sp.start, { explicit: true });
          onSeek();
          onChange();
          return;
        }
      }
      e.preventDefault?.();
      dragging = true;
      const trackEl = e.currentTarget;
      if (e.pointerId != null) {
        try { trackEl.setPointerCapture?.(e.pointerId); } catch {}
      }
      scrubAtClientX(trackEl, e.clientX, targetDur);
    };
    const onPointerMove = e => {
      if (!dragging) return;
      e.preventDefault?.();
      scrubAtClientX(e.currentTarget, e.clientX, targetDur);
    };
    const onPointerUp = e => {
      if (!dragging) return;
      dragging = false;
      if (e.pointerId != null) {
        try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch {}
      }
    };
    const onKeyDown = e => {
      const step = e.shiftKey ? 500 : 100;
      const cur = B.time() ?? 0;
      if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); B.seekTo(cur - step, { explicit: true }); onSeek(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); B.seekTo(cur + step, { explicit: true }); onSeek(); }
      else if (e.key === "Home") { e.preventDefault(); e.stopPropagation(); B.stepToStart({ explicit: true }); onSeek(); }
      else if (e.key === "End") { e.preventDefault(); e.stopPropagation(); B.stepToEnd({ explicit: true }); onSeek(); }
      else if (e.key === " " || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); B.playToggle(); onChange(); }
    };
    return { onPointerDown, onPointerMove, onPointerUp, onKeyDown };
  };

  // The head, fill, needle, track and time are kept and moved in place every frame while playing or scrubbing.
  tl.fill = h("div.fill");
  tl.head = h("div.head");
  tl.needle = null;
  tl.text = h("span.t");
  tl.sig = "";

  const compactHandlers = makeScrubberHandlers(safeDur, true);
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

  const compactTrack = h("div.track", {
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
      scrubAtClientX(e.currentTarget, e.clientX, safeDur);
    },
    onpointerdown: compactHandlers.onPointerDown,
    onpointermove: compactHandlers.onPointerMove,
    onpointerup: compactHandlers.onPointerUp,
    onpointercancel: compactHandlers.onPointerUp,
    onlostpointercapture: compactHandlers.onPointerUp,
    onkeydown: compactHandlers.onKeyDown,
  }, tl.fill, spanNodes, markNodes, tl.head);

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
    type: "button",
    title: B.playLoop ? "Loop: on" : "Loop: off",
    "aria-label": "Toggle loop",
    "aria-pressed": B.playLoop ? "true" : "false",
    "data-loop": B.playLoop ? "on" : "off",
    onclick: () => { B.setPlayLoop(!B.playLoop); onChange(); },
  }, icon("repeat", { size: 14 }));

  const nextCueBtn = cues.length > 0
    ? h("button.c.tl-next-cue", {
      type: "button",
      title: "Play to next cue marker",
      "aria-label": "Next cue",
      "data-action": "next-cue",
      onclick: () => { B.playToNextCue({ explicit: true }); onChange(); },
    }, "Next cue →")
    : null;

  const selNonLabels = B.selected().filter(e => e && !isLabel(e));
  const hasSelection = selNonLabels.length > 0;
  const selTrack = selNonLabels.length === 1 ? tracks.find(tr => tr.id === selNonLabels[0].id) ?? null : null;

  const authoringControls = showAuthoring && canEdit
    ? h("div.tl-authoring", {},
      h("button.c.tl-btn-add", {
        type: "button",
        title: hasSelection ? "Add selected element to timeline" : "Select a shape on the canvas first",
        "aria-label": "Add animation",
        "data-action": "add-animate",
        disabled: !hasSelection,
        onclick: () => {
          act(ed => ed.animate("fade"));
          onChange();
        },
      }, "+ Animate"),
      h("button.c.tl-btn-cue", {
        type: "button",
        title: "Drop a pause cue marker at current playhead",
        "aria-label": "Add cue",
        "data-action": "add-cue",
        onclick: () => {
          const at = Math.max(0, Math.round(B.time() ?? 0));
          actSettings(ed => ed.addCueAt(at, `Cue ${cues.length + 1}`));
          onChange();
        },
      }, "+ Cue"),
      h("button.c.tl-btn-cascade", {
        type: "button",
        title: "Sequence all tracks back-to-back in lane order",
        "aria-label": "Cascade tracks",
        "data-action": "cascade",
        disabled: tracks.length < 2,
        onclick: () => {
          act(ed => ed.cascadeAnimTracks());
          onChange();
        },
      }, "Cascade"),
      h("button.c.tl-btn-align", {
        type: "button",
        title: "Align all tracks to current playhead",
        "aria-label": "Align tracks",
        "data-action": "align",
        disabled: tracks.length < 2,
        onclick: () => {
          const at = Math.max(0, Math.round(B.time() ?? 0));
          act(ed => ed.alignAnimTracks(undefined, at));
          onChange();
        },
      }, "Align"))
    : null;

  // Compact Clip Inspector for the selected animated element in Animate / expanded mode.
  const clipInspector = isExpanded && selTrack && selTrack.preset !== "keyframes"
    ? (() => {
      const presetMeta = getPreset(selTrack.preset);
      const curEasing = canonicalEasing(selTrack.easing ?? presetMeta?.easing ?? "ease-out");
      return h("div.tl-clip-inspector", { "data-clip-inspector": selTrack.id },
        h("span.tl-ci-name", { title: selTrack.label }, selTrack.label),
        h("select.tl-ci-sel", {
          "aria-label": "Clip preset",
          "data-clip-inspector-field": "preset",
          disabled: !canEdit,
          value: selTrack.preset,
          onchange: e => {
            act(ed => ed.setAnimTiming(selTrack.id, { preset: e.currentTarget.value }));
            onChange();
          },
          onkeydown: k => k.stopPropagation(),
        }, buildPresetOptions(h, selTrack.preset)),
        h("select.tl-ci-sel", {
          "aria-label": "Clip easing",
          "data-clip-inspector-field": "easing",
          disabled: !canEdit,
          value: curEasing,
          onchange: e => {
            act(ed => ed.setAnimTiming(selTrack.id, { easing: e.currentTarget.value }));
            onChange();
          },
          onkeydown: k => k.stopPropagation(),
        }, EASING_META.map(ea => h("option", { value: ea.id, selected: curEasing === ea.id }, ea.label))));
    })()
    : null;

  const tracksToggleBtn = !compactOnly && ctx.onToggleExpand
    ? h("button.c.tl-tracks-toggle" + (isExpanded ? ".on" : ""), {
      type: "button",
      title: isExpanded ? "Collapse multi-track timeline" : "Expand multi-track timeline",
      "aria-label": `Tracks (${tracks.length})`,
      "aria-expanded": String(isExpanded),
      "data-action": "toggle-tracks",
      onclick: () => { ctx.onToggleExpand?.(!isExpanded); },
    }, `Tracks (${tracks.length}) ${isExpanded ? "⌄" : "⌃"}`)
    : null;

  const rmBadge = reduced
    ? h("span.tl-rm", { title: "Reduced motion preference detected (tap Play to animate)" }, "Reduced motion")
    : null;

  const transportControls = h("div.tl-controls", {},
    h("button.c", {
      type: "button",
      title: "Step to start",
      "aria-label": "Step to start",
      "data-action": "step-start",
      onclick: () => { B.stepToStart(); onSeek(); },
    }, icon("skipBack", { size: 13 })),
    h("button.c", {
      type: "button",
      title: "Play / pause (⇧Space)",
      "aria-label": B.play ? "Pause" : "Play",
      "data-state": B.play ? "playing" : "paused",
      onclick: () => { B.playToggle(); onChange(); },
    }, icon(B.play ? "pause" : "play", { size: 14 })),
    h("button.c", {
      type: "button",
      title: "Step to end",
      "aria-label": "Step to end",
      "data-action": "step-end",
      onclick: () => { B.stepToEnd(); onSeek(); },
    }, icon("skipForward", { size: 13 })),
    h("button.c", {
      type: "button",
      title: "Back to editing (Esc)",
      "aria-label": "Stop",
      onclick: () => { B.stopPlay(); onChange(); },
    }, icon("stop", { size: 14 })),
    nextCueBtn);

  if (!isExpanded) {
    tl.track = compactTrack;
    replace(
      el,
      transportControls,
      compactTrack,
      tl.text,
      loopBtn,
      speedSel,
      authoringControls,
      tracksToggleBtn,
      rmBadge,
    );
    updateTimelineInPlace(tl, B, safeDur);
    if (restoreFocus === "track") compactTrack.focus?.();
    else if (restoreFocus === "speed") speedSel.focus?.();
    return;
  }

  // ── Expanded Multi-Swimlane NLE Drawer ──
  const ticks = rulerTicks(rulerDur);
  const majorTicks = ticks.filter(tk => tk.major);
  const rulerHandlers = makeScrubberHandlers(rulerDur, false);

  const cueNodes = cues.map(cue => {
    const leftPct = Math.min(100, (cue.at / rulerDur) * 100);
    let cueDragging = false;
    let cueMoved = false;
    let cueStartX = 0;
    let cueFinalAt = cue.at;

    const otherCueEdges = tracks.flatMap(tr => [tr.start, tr.end]);
    const markerEl = h("div.tl-cue-marker", {
      "data-cue-id": cue.id,
      "data-cue-at": String(cue.at),
      title: `${cue.label || "Cue"} (${formatTime(cue.at)}) — drag to move, click to jump`,
      style: { left: `${leftPct}%` },
      onpointerdown: e => {
        if (e.button != null && e.button !== 0) return;
        if (e.target?.getAttribute?.("data-delete-cue") || e.target?.closest?.(".tl-cue-del")) return;
        e.stopPropagation?.();
        e.preventDefault?.();
        if (!canEdit) {
          B.seekTo(cue.at, { explicit: true });
          onSeek();
          return;
        }
        cueDragging = true;
        cueMoved = false;
        cueStartX = e.clientX;
        cueFinalAt = cue.at;
        if (e.pointerId != null) {
          try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {}
        }
      },
      onpointermove: e => {
        if (!cueDragging) return;
        e.stopPropagation?.();
        e.preventDefault?.();
        const dx = e.clientX - cueStartX;
        if (Math.abs(dx) > 2) cueMoved = true;
        const rulerEl = markerEl.parentNode;
        const rect = rulerEl?.getBoundingClientRect?.() ?? { width: 200 };
        const deltaMs = (dx / Math.max(1, rect.width)) * rulerDur;
        cueFinalAt = snapTrackTime(cue.at + deltaMs, otherCueEdges, { free: Boolean(e.altKey) });
        const pct = Math.min(100, (cueFinalAt / rulerDur) * 100);
        markerEl.style.left = `${pct}%`;
      },
      onpointerup: e => {
        if (!cueDragging) return;
        cueDragging = false;
        e.stopPropagation?.();
        if (e.pointerId != null) {
          try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch {}
        }
        if (cueMoved && cueFinalAt !== cue.at) {
          actSettings(ed => ed.moveCue(cue.id, cueFinalAt));
          onChange();
        } else {
          B.seekTo(cue.at, { explicit: true });
          onSeek();
        }
      },
      onpointercancel: e => {
        if (!cueDragging) return;
        cueDragging = false;
        cueMoved = false;
        cueFinalAt = cue.at;
        markerEl.style.left = `${leftPct}%`;
        if (e.pointerId != null) {
          try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch {}
        }
      },
      onclick: e => {
        e.stopPropagation?.();
        if (e.target?.getAttribute?.("data-delete-cue") || e.target?.closest?.(".tl-cue-del")) return;
        B.seekTo(cue.at, { explicit: true });
        onSeek();
      },
    },
    h("span.tl-cue-diamond", { "aria-hidden": "true" }, "◆"),
    canEdit
      ? h("button.tl-cue-del", {
        type: "button",
        title: "Delete cue",
        "aria-label": `Delete ${cue.label || "cue"}`,
        "data-delete-cue": cue.id,
        onclick: ev => {
          ev.stopPropagation?.();
          actSettings(ed => ed.deleteCue(cue.id));
          onChange();
        },
      }, "×")
      : null);
    return markerEl;
  });

  const rulerEl = h("div.tl-ruler", {
    role: "slider",
    tabIndex: 0,
    "aria-label": "Timeline scrubber",
    "aria-valuemin": "0",
    "aria-valuemax": String(Math.round(rulerDur)),
    "aria-valuenow": String(Math.round(B.time() ?? 0)),
    title: "Click or drag to scrub",
    onclick: e => {
      if (e.target?.closest?.(".tl-cue-marker")) return;
      scrubAtClientX(e.currentTarget, e.clientX, rulerDur);
    },
    onpointerdown: rulerHandlers.onPointerDown,
    onpointermove: rulerHandlers.onPointerMove,
    onpointerup: rulerHandlers.onPointerUp,
    onpointercancel: rulerHandlers.onPointerUp,
    onlostpointercapture: rulerHandlers.onPointerUp,
    onkeydown: rulerHandlers.onKeyDown,
  },
  ticks.map(tk => h("div.tl-tick" + (tk.major ? ".major" : ""), {
    style: { left: `${Math.min(100, (tk.at / rulerDur) * 100)}%` },
  }, tk.label ? h("span.tl-tick-lab", {}, tk.label) : null)),
  cueNodes);

  tl.track = rulerEl;
  tl.fill = null;
  tl.head = null;
  tl.needle = h("div.tl-needle", { "aria-hidden": "true" });

  const laneRows = tracks.map((tr, idx) => {
    const selected = B.sel.has(tr.id);
    const leftPct = Math.min(100, (tr.start / rulerDur) * 100);
    const widthPct = Math.max(2, Math.min(100 - leftPct, (tr.duration / rulerDur) * 100));
    const isKeyframes = tr.preset === "keyframes";

    const otherEdges = [
      ...tracks.filter(o => o.id !== tr.id).flatMap(o => [o.start, o.end]),
      ...cues.map(c => c.at),
    ];

    let clipEl;
    let laneTrackEl;
    let dragMode = null; // "move" | "resize-left" | "resize-right"
    let dragStartX = 0;
    let dragMoved = false;
    let dragStart = tr.start;
    let dragDur = tr.duration;
    const origEnd = tr.start + tr.duration;

    const startClipDrag = (mode, e) => {
      if (e.button != null && e.button !== 0) return;
      e.stopPropagation?.();
      e.preventDefault?.();
      if (!canEdit || isKeyframes) {
        B.select([tr.id]);
        B.seekTo(tr.start, { explicit: true });
        onSeek();
        onChange();
        return;
      }
      dragMode = mode;
      dragStartX = e.clientX;
      dragMoved = false;
      dragStart = tr.start;
      dragDur = tr.duration;
      if (e.pointerId != null) {
        try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {}
      }
    };

    const moveClipDrag = e => {
      if (!dragMode) return;
      e.stopPropagation?.();
      e.preventDefault?.();
      const dx = e.clientX - dragStartX;
      if (Math.abs(dx) > 2) dragMoved = true;
      const rect = laneTrackEl?.getBoundingClientRect?.() ?? { width: 200 };
      const deltaMs = (dx / Math.max(1, rect.width)) * rulerDur;
      const free = Boolean(e.altKey);

      if (dragMode === "move") {
        dragStart = snapTrackTime(tr.start + deltaMs, otherEdges, { free });
        dragDur = tr.duration;
      } else if (dragMode === "resize-left") {
        const rawStart = Math.min(origEnd - MIN_CLIP_DURATION, Math.max(0, tr.start + deltaMs));
        const snapped = snapTrackTime(rawStart, otherEdges, { free });
        dragStart = Math.min(origEnd - MIN_CLIP_DURATION, Math.max(0, snapped));
        dragDur = Math.max(MIN_CLIP_DURATION, origEnd - dragStart);
      } else if (dragMode === "resize-right") {
        const rawEnd = Math.max(tr.start + MIN_CLIP_DURATION, origEnd + deltaMs);
        const snappedEnd = snapTrackTime(rawEnd, otherEdges, { free });
        dragStart = tr.start;
        dragDur = Math.max(MIN_CLIP_DURATION, snappedEnd - tr.start);
      }

      if (clipEl) {
        const nextLeft = Math.min(100, (dragStart / rulerDur) * 100);
        const nextWidth = Math.max(2, Math.min(100 - nextLeft, (dragDur / rulerDur) * 100));
        clipEl.style.left = `${nextLeft}%`;
        clipEl.style.width = `${nextWidth}%`;
      }
    };

    const endClipDrag = e => {
      if (!dragMode) return;
      const mode = dragMode;
      dragMode = null;
      e.stopPropagation?.();
      if (e.pointerId != null) {
        try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch {}
      }
      if (dragMoved && (dragStart !== tr.start || dragDur !== tr.duration)) {
        if (mode === "move") act(ed => ed.setAnimTiming(tr.id, { start: dragStart }));
        else if (mode === "resize-left") act(ed => ed.setAnimTiming(tr.id, { start: dragStart, duration: dragDur }));
        else if (mode === "resize-right") act(ed => ed.setAnimTiming(tr.id, { duration: dragDur }));
        onChange();
      } else {
        B.select([tr.id]);
        B.seekTo(tr.start, { explicit: true });
        onSeek();
        onChange();
      }
    };

    const cancelClipDrag = e => {
      if (!dragMode) return;
      dragMode = null;
      dragMoved = false;
      dragStart = tr.start;
      dragDur = tr.duration;
      e.stopPropagation?.();
      if (e.pointerId != null) {
        try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch {}
      }
      if (clipEl) {
        clipEl.style.left = `${leftPct}%`;
        clipEl.style.width = `${widthPct}%`;
      }
    };

    const leftHandle = h("div.tl-clip-handle.left", {
      "data-clip-handle": "left",
      "data-clip-id": tr.id,
      title: "Drag to adjust start time",
      onpointerdown: e => startClipDrag("resize-left", e),
      onpointermove: moveClipDrag,
      onpointerup: endClipDrag,
      onpointercancel: cancelClipDrag,
      onlostpointercapture: cancelClipDrag,
    });

    const rightHandle = h("div.tl-clip-handle.right", {
      "data-clip-handle": "right",
      "data-clip-id": tr.id,
      title: "Drag to adjust duration",
      onpointerdown: e => startClipDrag("resize-right", e),
      onpointermove: moveClipDrag,
      onpointerup: endClipDrag,
      onpointercancel: cancelClipDrag,
      onlostpointercapture: cancelClipDrag,
    });

    const presetLabel = Object.hasOwn(PRESETS, tr.preset) ? PRESETS[tr.preset].label : tr.preset;
    clipEl = h(`div.tl-clip.cat-${tr.category}${selected ? ".on" : ""}`, {
      "data-clip-id": tr.id,
      "data-anim-id": tr.id,
      title: `${tr.label} · ${presetLabel} (${formatTime(tr.start)}–${formatTime(tr.end)}) — drag to move, Alt for free drag`,
      style: { left: `${leftPct}%`, width: `${widthPct}%` },
      onpointerdown: e => startClipDrag("move", e),
      onpointermove: moveClipDrag,
      onpointerup: endClipDrag,
      onpointercancel: cancelClipDrag,
      onlostpointercapture: cancelClipDrag,
    },
    leftHandle,
    h("span.tl-clip-lab", {}, `${presetLabel} · ${(tr.duration / 1000).toFixed(1)}s`),
    rightHandle);

    const gridLines = majorTicks.map(tk => h("div.tl-grid-line", {
      "aria-hidden": "true",
      style: { left: `${Math.min(100, (tk.at / rulerDur) * 100)}%` },
    }));

    laneTrackEl = h("div.tl-lane-track", { "data-lane-track": tr.id }, gridLines, clipEl);

    const laneHead = h("div.tl-lane-head", {},
      h("div.tl-lane-reorder", {},
        h("button.tl-lane-btn", {
          type: "button",
          title: "Move track up",
          "aria-label": `Move ${tr.label} up`,
          "data-track-move": "up",
          "data-track-id": tr.id,
          disabled: !canEdit || idx === 0,
          onclick: () => { act(ed => ed.reorderAnimTracks(idx, idx - 1)); onChange(); },
        }, "↑"),
        h("button.tl-lane-btn", {
          type: "button",
          title: "Move track down",
          "aria-label": `Move ${tr.label} down`,
          "data-track-move": "down",
          "data-track-id": tr.id,
          disabled: !canEdit || idx === tracks.length - 1,
          onclick: () => { act(ed => ed.reorderAnimTracks(idx, idx + 1)); onChange(); },
        }, "↓")),
      h("button.tl-lane-label", {
        type: "button",
        title: `Select & focus ${tr.label}`,
        "data-track-select": tr.id,
        onclick: () => {
          B.select([tr.id]);
          ctx.onFocusElement?.(tr.id);
          onChange();
        },
      }, h("span.tl-lane-ic", {}, icon(shapeIconName(tr.type), { size: 12 })), h("span.tl-lane-name", {}, tr.label)),
      h("select.tl-lane-preset", {
        "aria-label": `Preset for ${tr.label}`,
        "data-track-preset": tr.id,
        disabled: !canEdit || isKeyframes,
        value: tr.preset,
        onchange: e => {
          act(ed => ed.setAnimTiming(tr.id, { preset: e.currentTarget.value }));
          onChange();
        },
        onkeydown: k => k.stopPropagation(),
      }, buildPresetOptions(h, tr.preset)),
      h("button.tl-lane-del", {
        type: "button",
        title: `Remove animation from ${tr.label}`,
        "aria-label": `Remove ${tr.label} animation`,
        "data-track-remove": tr.id,
        disabled: !canEdit,
        onclick: () => {
          act(ed => { ed.select([tr.id]); ed.clearAnimation(); });
          onChange();
        },
      }, "×"));

    return h("div.tl-lane-row" + (selected ? ".selected" : ""), { "data-track-id": tr.id }, laneHead, laneTrackEl);
  });

  const nleDrawer = h("div.tl-nle", { "data-nle": "1" },
    h("div.tl-ruler-row", {},
      h("div.tl-ruler-gutter", {},
        h("span.tl-gutter-title", {}, tracks.length ? `${tracks.length} track${tracks.length === 1 ? "" : "s"}` : "No tracks")),
      rulerEl),
    h("div.tl-lanes-body", {},
      laneRows.length
        ? laneRows
        : h("div.tl-empty", {}, "Select a shape on the canvas and click + Animate to add a swimlane.")),
    h("div.tl-playhead-overlay", { "aria-hidden": "true" }, tl.needle));

  const headerBar = h("div.tl-header", {},
    transportControls,
    tl.text,
    loopBtn,
    speedSel,
    authoringControls,
    clipInspector,
    h("span.spacer"),
    tracksToggleBtn,
    rmBadge);

  replace(el, headerBar, nleDrawer);
  updateTimelineInPlace(tl, B, safeDur);

  if (restoreFocus === "track") rulerEl.focus?.();
  else if (restoreFocus === "speed") speedSel.focus?.();
}
