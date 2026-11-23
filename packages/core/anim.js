// @ts-check
// Animation: each element may carry customData.anim, played on the board's timeline.
//
//   anim = { preset, start, duration, easing?, loop? }      a preset (below), or
//   anim = { keys: [{ t, dx?, dy?, opacity?, scale?, scaleX?, scaleY?, rotate?, progress?, glow?, easing? }, ...] }   keyframes, t in ms
//
// Elements without anim are simply there. animState(el, t) says how an element
// looks at time t; render.js applies it. Nothing here knows about frames or timers:
// adapters advance `t` however their platform animates.

const clamp01 = t => (Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0);
const hasOwn = (obj, k) => typeof k === "string" && Object.hasOwn(obj, k);

function easeBounce(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const n1 = 7.5625, d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) { const k = t - 1.5 / d1; return n1 * k * k + 0.75; }
  if (t < 2.5 / d1) { const k = t - 2.25 / d1; return n1 * k * k + 0.9375; }
  const k = t - 2.625 / d1;
  return n1 * k * k + 0.984375;
}

function easeSpring(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return 1 - Math.exp(-6 * t) * Math.cos(t * Math.PI * 2.5);
}

function easeBackOut(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const c = 1.70158;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
}

const easeLinear = t => t;
const easeIn = t => t * t;
const easeOut = t => 1 - (1 - t) * (1 - t);
const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Named easing functions (canonical kebab-case + legacy short aliases). */
export const EASE = {
  linear: easeLinear,
  "ease-in": easeIn,
  "ease-out": easeOut,
  "ease-in-out": easeInOut,
  "back-out": easeBackOut,
  overshoot: easeBackOut,
  spring: easeSpring,
  bounce: easeBounce,
  // Legacy short aliases (100% backward-compatible with existing boards)
  in: easeIn,
  out: easeOut,
  inout: easeInOut,
  back: easeBackOut,
};

export const EASING_META = [
  { id: "linear", label: "Linear" },
  { id: "ease-out", label: "Ease Out" },
  { id: "ease-in", label: "Ease In" },
  { id: "ease-in-out", label: "Ease In-Out" },
  { id: "back-out", label: "Back Out" },
  { id: "spring", label: "Spring" },
  { id: "bounce", label: "Bounce" },
];
export const EASING_NAMES = EASING_META.map(e => e.id);

/** Prototype-safe lookup for easing functions. */
export const getEasing = name => (hasOwn(EASE, name) ? EASE[name] : null);

/** Normalize legacy short easing aliases to canonical names for UI display. */
export function canonicalEasing(name) {
  if (name === "in") return "ease-in";
  if (name === "out") return "ease-out";
  if (name === "inout") return "ease-in-out";
  if (name === "back" || name === "overshoot") return "back-out";
  return EASING_NAMES.includes(name) ? name : "ease-out";
}

/** Pure easing evaluator: clamps t to [0, 1] and falls back to `fallback` (default ease-out) for unknown names. */
export function ease(name, t, fallback = "ease-out") {
  const k = clamp01(t);
  const fn = getEasing(name) ?? getEasing(fallback) ?? easeOut;
  return fn(k);
}

export const PRESET_CATEGORIES = [
  { id: "entrance", label: "Entrance" },
  { id: "emphasis", label: "Emphasis" },
  { id: "path", label: "Path" },
  { id: "exit", label: "Exit" },
];

export const PRESETS = {
  // ── Entrance ──
  fade:         { label: "Fade",        category: "entrance", duration: 600, easing: "ease-out",    from: { opacity: 0 }, to: { opacity: 1 } },
  rise:         { label: "Rise",        category: "entrance", duration: 600, easing: "ease-out",    from: { opacity: 0, dy: 30 }, to: { opacity: 1, dy: 0 }, legacy: true },
  slide:        { label: "Slide",       category: "entrance", duration: 600, easing: "ease-out",    from: { opacity: 0, dx: -60 }, to: { opacity: 1, dx: 0 }, legacy: true },
  "slide-up":   { label: "Slide Up",    category: "entrance", duration: 600, easing: "ease-out",    from: { opacity: 0, dy: 48 }, to: { opacity: 1, dy: 0 } },
  "slide-down": { label: "Slide Down",  category: "entrance", duration: 600, easing: "ease-out",    from: { opacity: 0, dy: -48 }, to: { opacity: 1, dy: 0 } },
  "slide-left": { label: "Slide Left",  category: "entrance", duration: 600, easing: "ease-out",    from: { opacity: 0, dx: 60 }, to: { opacity: 1, dx: 0 } },
  "slide-right":{ label: "Slide Right", category: "entrance", duration: 600, easing: "ease-out",    from: { opacity: 0, dx: -60 }, to: { opacity: 1, dx: 0 } },
  pop:          { label: "Pop",         category: "entrance", duration: 550, easing: "back-out",    from: { opacity: 0, scale: 0.6 }, to: { opacity: 1, scale: 1 } },
  scale:        { label: "Scale",       category: "entrance", duration: 550, easing: "ease-out",    from: { opacity: 0, scale: 0.75 }, to: { opacity: 1, scale: 1 } },
  "bounce-in":  { label: "Bounce In",   category: "entrance", duration: 750, easing: "bounce",      from: { opacity: 0, scale: 0.35, dy: -24 }, to: { opacity: 1, scale: 1, dy: 0 } },
  "zoom-in":    { label: "Zoom In",     category: "entrance", duration: 600, easing: "spring",      from: { opacity: 0, scale: 0.2 }, to: { opacity: 1, scale: 1 } },
  "flip-in":    { label: "Flip In",     category: "entrance", duration: 650, easing: "ease-out",    from: { opacity: 0, scaleX: 0.05 }, to: { opacity: 1, scaleX: 1 } },
  "dissolve-in":{ label: "Dissolve In", category: "entrance", duration: 700, easing: "ease-in-out", from: { opacity: 0, scale: 0.985 }, to: { opacity: 1, scale: 1 } },
  "wipe-right": { label: "Wipe Right",  category: "entrance", duration: 650, easing: "ease-in-out", fn: e => { const c = clamp01(e); return { opacity: c > 0 ? 1 : 0, clip: { x: 0, y: 0, w: c, h: 1 } }; } },
  "wipe-left":  { label: "Wipe Left",   category: "entrance", duration: 650, easing: "ease-in-out", fn: e => { const c = clamp01(e); return { opacity: c > 0 ? 1 : 0, clip: { x: 1 - c, y: 0, w: c, h: 1 } }; } },
  "wipe-down":  { label: "Wipe Down",   category: "entrance", duration: 650, easing: "ease-in-out", fn: e => { const c = clamp01(e); return { opacity: c > 0 ? 1 : 0, clip: { x: 0, y: 0, w: 1, h: c } }; } },
  "wipe-up":    { label: "Wipe Up",     category: "entrance", duration: 650, easing: "ease-in-out", fn: e => { const c = clamp01(e); return { opacity: c > 0 ? 1 : 0, clip: { x: 0, y: 1 - c, w: 1, h: c } }; } },

  // ── Emphasis ──
  pulse:        { label: "Pulse",       category: "emphasis", duration: 600,  easing: "out",         from: { scale: 1 }, mid: { scale: 1.12 }, to: { scale: 1 }, loop: true },
  wiggle:       { label: "Wiggle",      category: "emphasis", duration: 600,  easing: "linear",      fn: e => ({ rotate: Math.sin(e * Math.PI * 4) * 0.14 }), loop: true },
  shake:        { label: "Shake",       category: "emphasis", duration: 500,  easing: "linear",      fn: e => ({ dx: Math.sin(e * Math.PI * 6) * 8 }), loop: true },
  float:        { label: "Float",       category: "emphasis", duration: 1400, easing: "ease-in-out", from: { dy: 0 }, mid: { dy: -10 }, to: { dy: 0 }, loop: true },
  highlight:    { label: "Highlight",   category: "emphasis", duration: 900,  easing: "ease-in-out", from: { scale: 1, glow: 0 }, mid: { scale: 1.05, glow: 1 }, to: { scale: 1, glow: 0 }, loop: true },

  // ── Path ──
  draw:         { label: "Draw",        category: "path",     duration: 800,  easing: "ease-in-out", from: { progress: 0 }, to: { progress: 1 } },

  // ── Exit ──
  out:           { label: "Fade Out",     category: "exit",     duration: 600,  easing: "out",         from: { opacity: 1 }, to: { opacity: 0 }, legacy: true },
  "fade-out":    { label: "Fade Out",     category: "exit",     duration: 600,  easing: "ease-in",     from: { opacity: 1 }, to: { opacity: 0 } },
  "dissolve-out":{ label: "Dissolve Out", category: "exit",     duration: 700,  easing: "ease-in-out", from: { opacity: 1, scale: 1 }, to: { opacity: 0, scale: 0.985 } },
  "scale-out":   { label: "Scale Out",    category: "exit",     duration: 550,  easing: "ease-in",     from: { opacity: 1, scale: 1 }, to: { opacity: 0, scale: 0.5 } },
  "slide-out":   { label: "Slide Out",    category: "exit",     duration: 600,  easing: "ease-in",     from: { opacity: 1, dy: 0 }, to: { opacity: 0, dy: 40 } },
};

/** Prototype-safe lookup for preset definitions. */
export const getPreset = name => (hasOwn(PRESETS, name) ? PRESETS[name] : null);

export const PRESET_NAMES = Object.keys(PRESETS);

/** Preset metadata array for UI builders (id, label, category, duration, easing, loop, legacy). */
export const PRESET_META = PRESET_NAMES.map(id => {
  const p = PRESETS[id];
  return {
    id,
    label: p.label,
    category: p.category,
    duration: p.duration ?? 600,
    easing: canonicalEasing(p.easing ?? "ease-out"),
    loop: !!p.loop,
    legacy: !!p.legacy,
  };
});

/** Grouped non-legacy presets for UI selectors (Entrance / Emphasis / Path / Exit). */
export function presetsByCategory() {
  return PRESET_CATEGORIES.map(cat => ({
    ...cat,
    presets: PRESET_META.filter(p => p.category === cat.id && !p.legacy),
  }));
}

const REST = { opacity: 1, dx: 0, dy: 0, scale: 1, scaleX: 1, scaleY: 1, rotate: 0, progress: 1, glow: 0 };

const lerp = (a, b, k) => a + (b - a) * k;
const clampState = o => {
  o.opacity = clamp01(o.opacity);
  o.progress = clamp01(o.progress);
  o.glow = clamp01(o.glow);
  if (o.clip && typeof o.clip === "object") {
    const x = clamp01(o.clip.x);
    const y = clamp01(o.clip.y);
    const w = Math.min(clamp01(o.clip.w), 1 - x);
    const h = Math.min(clamp01(o.clip.h), 1 - y);
    o.clip = { x, y, w, h };
  }
  return o;
};
const mix = (a, b, k) => {
  const o = {};
  for (const key of Object.keys(REST)) o[key] = lerp(a[key] ?? REST[key], b[key] ?? REST[key], k);
  return clampState(o);
};

export function animState(el, t) {
  const anim = el.customData?.anim;
  if (!anim) return null;
  if (Array.isArray(anim.keys) && anim.keys.length) {
    const ks = [...anim.keys].sort((a, b) => a.t - b.t);
    if (t <= ks[0].t) return mix(ks[0], ks[0], 0);
    for (let i = 1; i < ks.length; i++) if (t <= ks[i].t) {
      const k = (t - ks[i - 1].t) / ((ks[i].t - ks[i - 1].t) || 1);
      return mix(ks[i - 1], ks[i], ease(ks[i].easing, k, "ease-in-out"));
    }
    return mix(ks[ks.length - 1], ks[ks.length - 1], 0);
  }
  const p = getPreset(anim.preset);
  if (!p) return null;
  const start = anim.start ?? 0, dur = Math.max(1, anim.duration ?? p.duration ?? 600);
  const loop = anim.loop ?? p.loop ?? false;
  let k;
  if (t <= start) {
    k = 0;
  } else if (t >= start + dur) {
    k = 1;
  } else if (loop) {
    // Repeat whole cycles inside [start, start + dur] at the preset's natural cadence
    // so the clip bar on the timeline is the true active window and ends cleanly at rest.
    const cycles = Math.max(1, Math.round(dur / Math.max(1, p.duration ?? dur)));
    k = (((t - start) / dur) * cycles) % 1;
  } else {
    k = (t - start) / dur;
  }
  k = clamp01(k);
  const e = ease(anim.easing ?? p.easing ?? "ease-out", k, "ease-out");
  if (p.fn) return clampState({ ...REST, ...p.fn(e, k) });
  if (p.mid) {
    return e < 0.5
      ? mix({ ...REST, ...p.from }, { ...REST, ...p.mid }, e * 2)
      : mix({ ...REST, ...p.mid }, { ...REST, ...p.to }, (e - 0.5) * 2);
  }
  return mix({ ...REST, ...p.from }, { ...REST, ...p.to }, e);
}

// ── Timeline helpers (pure) ────────────────────────────────────────────────

export const PLAYBACK_SPEEDS = [0.5, 1, 1.5, 2];
export const MAX_CUES = 50;
export const MAX_CUE_LABEL = 80;
export const MIN_CLIP_DURATION = 100;

const MAX_TRACK_LABEL = 32;
const MAX_CUE_ID_CHARS = 64;
const MAX_TIMELINE_MS = 3_600_000;

// When does the last animation end? (The timeline's natural length.)
export function timelineEnd(elements) {
  let end = 0;
  for (const el of elements) {
    const a = el.customData?.anim; if (!a) continue;
    if (Array.isArray(a.keys)) {
      if (!a.keys.length) continue;
      end = Math.max(end, ...a.keys.map(k => (Number.isFinite(k.t) ? k.t : 0)));
    } else {
      const meta = getPreset(a.preset);
      if (!meta) continue;
      end = Math.max(end, (a.start ?? 0) + (a.duration ?? 600));
    }
  }
  return end;
}

/** Format milliseconds as mm:ss.t (e.g. 00:01.5). */
export function formatTime(ms) {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const totalTenths = Math.floor(safe / 100);
  const tenths = totalTenths % 10;
  const totalSec = Math.floor(totalTenths / 10);
  const sec = totalSec % 60;
  const min = Math.floor(totalSec / 60);
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${tenths}`;
}

/**
 * Pure playback step: advances from `from` by `elapsedMs * speed`, wrapping on `loop`,
 * pausing cleanly at `stopAt` (when finite and > start time), or ending after `holdMs`.
 * Supports both `stepTimeline({ from, elapsedMs, duration, speed, loop, holdMs, stopAt })`
 * and positional `stepTimeline(play, now, dur, { stopAt })`.
 * @param {any} [arg0]
 * @param {number} [now]
 * @param {number} [durArg]
 * @param {{ stopAt?: number | null, holdMs?: number }} [opts]
 * @returns {{ time: number | null, t?: number | null, ended: boolean, pausedAtCue?: boolean }}
 */
export function stepTimeline(arg0 = {}, now, durArg, opts) {
  if (typeof now === "number") {
    const play = arg0 && typeof arg0 === "object" ? arg0 : {};
    const startFrom = Math.max(0, Number.isFinite(play.at) ? play.at : (Number.isFinite(play.from) ? play.from : 0));
    const t0 = Number.isFinite(play.t0) ? play.t0 : now;
    const elapsedMs = Math.max(0, now - t0);
    const dur = Math.max(1, Number.isFinite(durArg) ? durArg : 1);
    const spd = Number.isFinite(play.speed) && play.speed > 0 ? play.speed : 1;
    const loop = !!play.loop;
    const holdMs = Number.isFinite(opts?.holdMs) ? opts.holdMs : 400;
    const stopAt = opts && Number.isFinite(opts.stopAt) ? opts.stopAt : null;
    const raw = startFrom + elapsedMs * spd;
    if (stopAt != null && stopAt > startFrom && raw >= stopAt) {
      return { t: stopAt, time: stopAt, ended: true, pausedAtCue: true };
    }
    if (loop) {
      const t = raw % dur;
      return { t, time: t, ended: false };
    }
    if (raw > dur + holdMs) return { t: null, time: null, ended: true };
    return { t: raw, time: raw, ended: false };
  }
  const { from = 0, elapsedMs = 0, duration = 1, speed = 1, loop = false, holdMs = 400, stopAt = null } = arg0 ?? {};
  const dur = Math.max(1, Number.isFinite(duration) ? duration : 1);
  const spd = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const startFrom = Math.max(0, Number.isFinite(from) ? from : 0);
  const dt = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0) * spd;
  const raw = startFrom + dt;
  if (stopAt != null && Number.isFinite(stopAt) && stopAt > startFrom && raw >= stopAt) {
    return { time: stopAt, ended: true, pausedAtCue: true };
  }
  if (loop) return { time: raw % dur, ended: false };
  if (raw > dur + holdMs) return { time: null, ended: true };
  return { time: raw, ended: false };
}

/** Map a scrubber ratio (0..1) onto [0, duration] in ms. */
export function scrubTime(ratio, duration) {
  const dur = Math.max(0, Number.isFinite(duration) ? duration : 0);
  return Math.round(clamp01(ratio) * dur);
}

/** Extract sorted per-element animation spans for timeline visualization (skips bound labels). */
export function timelineSpans(elements) {
  const out = [];
  for (const el of elements) {
    if (el.type === "text" && el.containerId) continue;
    const a = el.customData?.anim;
    if (!a) continue;
    if (Array.isArray(a.keys)) {
      if (!a.keys.length) continue;
      const ts = a.keys.map(k => k.t).filter(Number.isFinite);
      if (!ts.length) continue;
      const start = Math.min(...ts), end = Math.max(...ts);
      out.push({
        id: el.id,
        type: el.type,
        preset: "keyframes",
        label: "Keyframes",
        category: "emphasis",
        start,
        duration: Math.max(1, end - start),
        end: Math.max(start + 1, end),
        easing: "ease-in-out",
        loop: false,
      });
      continue;
    }
    const meta = getPreset(a.preset);
    if (!meta) continue;
    const start = Math.max(0, a.start ?? 0);
    const duration = Math.max(1, a.duration ?? 600);
    out.push({
      id: el.id,
      type: el.type,
      preset: a.preset,
      label: meta.label,
      category: meta.category,
      start,
      duration,
      end: start + duration,
      easing: canonicalEasing(a.easing ?? meta.easing ?? "ease-out"),
      loop: a.loop ?? meta.loop ?? false,
    });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end || String(a.id).localeCompare(String(b.id)));
  return out;
}

/** Truncate a single-line track label cleanly to <= 32 chars. */
function cleanTrackLabel(raw) {
  if (typeof raw !== "string") return "";
  const single = raw.replace(/\s+/g, " ").trim();
  if (!single) return "";
  if (single.length <= MAX_TRACK_LABEL) return single;
  return single.slice(0, MAX_TRACK_LABEL - 1).trimEnd() + "…";
}

function capitalizeType(type) {
  if (typeof type !== "string" || !type.length) return "Element";
  return type[0].toUpperCase() + type.slice(1);
}

/**
 * Extract live animated elements as multi-swimlane tracks sorted deterministically by
 * `(anim.order ?? Infinity, anim.start, id)`. Skips bound labels and deleted elements.
 * @param {any} doc Doc instance, scene object, or elements array
 */
export function timelineTracks(doc) {
  const elements = Array.isArray(doc)
    ? doc.filter(e => e && !e.isDeleted)
    : (typeof doc?.live === "function"
      ? doc.live()
      : (Array.isArray(doc?.elements) ? doc.elements.filter(e => e && !e.isDeleted) : []));
  const labelByContainer = typeof doc?.labelOf === "function"
    ? null
    : new Map(elements.filter(e => e.type === "text" && e.containerId).map(e => [e.containerId, e]));
  const out = [];
  for (const el of elements) {
    if (!el || el.isDeleted) continue;
    if (el.type === "text" && el.containerId) continue;
    const a = el.customData?.anim;
    if (!a) continue;

    const bound = typeof doc?.labelOf === "function" ? doc.labelOf(el) : labelByContainer?.get(el.id);
    const label = cleanTrackLabel(bound?.text)
      || cleanTrackLabel(el.text)
      || cleanTrackLabel(el.name)
      || cleanTrackLabel(capitalizeType(el.type));
    const order = typeof a.order === "number" && Number.isFinite(a.order) ? a.order : null;
    const cueGroup = typeof a.cueGroup === "string" && a.cueGroup.length ? a.cueGroup : null;

    if (Array.isArray(a.keys)) {
      if (!a.keys.length) continue;
      const ts = a.keys.map(k => k.t).filter(Number.isFinite);
      if (!ts.length) continue;
      const start = Math.max(0, Math.min(...ts));
      const rawEnd = Math.max(...ts);
      const duration = Math.max(1, rawEnd - start);
      out.push({
        id: el.id,
        type: el.type,
        label,
        preset: "keyframes",
        category: "emphasis",
        start,
        duration,
        end: start + duration,
        easing: "ease-in-out",
        loop: false,
        order,
        cueGroup,
      });
      continue;
    }

    const meta = getPreset(a.preset);
    if (!meta) continue;
    const start = Math.max(0, Number.isFinite(a.start) ? a.start : 0);
    const duration = Math.max(1, Number.isFinite(a.duration) ? a.duration : (meta.duration ?? 600));
    out.push({
      id: el.id,
      type: el.type,
      label,
      preset: a.preset,
      category: meta.category,
      start,
      duration,
      end: start + duration,
      easing: canonicalEasing(a.easing ?? meta.easing ?? "ease-out"),
      loop: a.loop ?? meta.loop ?? false,
      order,
      cueGroup,
    });
  }
  out.sort((a, b) => {
    const oa = a.order ?? Infinity;
    const ob = b.order ?? Infinity;
    if (oa !== ob) return oa - ob;
    if (a.start !== b.start) return a.start - b.start;
    return String(a.id).localeCompare(String(b.id));
  });
  return out;
}

/**
 * Snap a timeline timestamp `ms >= 0` to the nearest clip edge or cue marker within `snapTol`,
 * else to `step` ms grid ticks. When `free` is true, clamps `>= 0` and rounds to integer ms.
 * @param {number} ms
 * @param {number[]} [otherEdges]
 * @param {{ step?: number, snapTol?: number, free?: boolean }} [opts]
 */
export function snapTrackTime(ms, otherEdges = [], { step = 100, snapTol = 120, free = false } = {}) {
  const clamped = Math.max(0, Number.isFinite(ms) ? ms : 0);
  if (free) return Math.round(clamped);
  const tol = Number.isFinite(snapTol) && snapTol >= 0 ? snapTol : 120;
  let best = null;
  let bestDist = Infinity;
  if (Array.isArray(otherEdges)) {
    for (const edge of otherEdges) {
      if (typeof edge !== "number" || !Number.isFinite(edge) || edge < 0) continue;
      const d = Math.abs(edge - clamped);
      if (d <= tol && (d < bestDist || (d === bestDist && best != null && edge < best))) {
        best = edge;
        bestDist = d;
      }
    }
  }
  if (best != null) return Math.max(0, Math.round(best));
  const s = Number.isFinite(step) && step > 0 ? step : 100;
  return Math.max(0, Math.round(clamped / s) * s);
}

/**
 * Reorder swimlane tracks by moving `fromIndex` to `toIndex`, returning explicit `0..N-1` `{ id, order }[]`.
 * @param {Array<{ id: string } | string>} tracks
 * @param {number} fromIndex
 * @param {number} toIndex
 */
export function reorderTrackOrder(tracks, fromIndex, toIndex) {
  if (!Array.isArray(tracks) || !tracks.length) return [];
  const ids = tracks.map(t => (typeof t === "string" ? t : t?.id)).filter(id => typeof id === "string");
  if (!ids.length) return [];
  const from = Number.isFinite(fromIndex) ? Math.trunc(fromIndex) : -1;
  if (from < 0 || from >= ids.length) return ids.map((id, order) => ({ id, order }));
  const to = Number.isFinite(toIndex) ? Math.max(0, Math.min(ids.length - 1, Math.trunc(toIndex))) : from;
  const next = [...ids];
  if (from !== to) {
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
  }
  return next.map((id, order) => ({ id, order }));
}

/**
 * Space tracks back-to-back in their current lane order (`start = prevEnd + gap`),
 * returning `{ id, start, order }[]`.
 * @param {Array<{ id: string, start?: number, duration?: number, end?: number }>} tracks
 * @param {{ gap?: number, startAt?: number }} [opts]
 */
export function cascadeTracks(tracks, { gap = 150, startAt = 0 } = {}) {
  if (!Array.isArray(tracks) || !tracks.length) return [];
  const safeGap = Number.isFinite(gap) ? Math.round(gap) : 150;
  let cursor = Math.max(0, Number.isFinite(startAt) ? Math.round(startAt) : 0);
  const out = [];
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (!t || typeof t.id !== "string") continue;
    const start = Math.max(0, cursor);
    const dur = Number.isFinite(t.duration)
      ? Math.max(1, Math.round(t.duration))
      : (Number.isFinite(t.end) && Number.isFinite(t.start) ? Math.max(1, Math.round(t.end - t.start)) : 600);
    out.push({ id: t.id, start, order: out.length });
    cursor = Math.max(0, start + dur + safeGap);
  }
  return out;
}

/**
 * Align tracks to a common start timestamp `Math.max(0, Math.round(atMs))`.
 * @param {Array<{ id: string } | string>} tracks
 * @param {number} [atMs]
 */
export function alignTracks(tracks, atMs = 0) {
  if (!Array.isArray(tracks) || !tracks.length) return [];
  const start = Math.max(0, Number.isFinite(atMs) ? Math.round(atMs) : 0);
  const out = [];
  for (const t of tracks) {
    const id = typeof t === "string" ? t : t?.id;
    if (typeof id === "string") out.push({ id, start });
  }
  return out;
}

function formatRulerLabel(ms) {
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Compute clean `{ at, label, major }[]` tick marks for an NLE time ruler over `[0, totalMs]`
 * (clamped to `MAX_TIMELINE_MS` so tick generation is always strictly bounded).
 * @param {number} totalMs
 */
export function rulerTicks(totalMs) {
  const total = Math.min(MAX_TIMELINE_MS, Math.max(0, Number.isFinite(totalMs) ? Math.ceil(totalMs) : 0));
  if (total === 0) return [{ at: 0, label: "0s", major: true }];
  let majorStep = 500;
  let minorStep = 100;
  if (total <= 3000) {
    majorStep = 500; minorStep = 100;
  } else if (total <= 10_000) {
    majorStep = 1000; minorStep = 500;
  } else if (total <= 25_000) {
    majorStep = 2000; minorStep = 1000;
  } else if (total <= 60_000) {
    majorStep = 5000; minorStep = 1000;
  } else if (total <= 180_000) {
    majorStep = 10_000; minorStep = 5000;
  } else if (total <= 600_000) {
    majorStep = 30_000; minorStep = 10_000;
  } else {
    majorStep = 60_000; minorStep = 30_000;
  }
  const ticks = [];
  for (let at = 0; at <= total; at += minorStep) {
    const major = at % majorStep === 0;
    ticks.push({ at, label: major ? formatRulerLabel(at) : "", major });
  }
  return ticks;
}

/**
 * Pure, sorted, deduplicated cue markers `{ id, at, label }[]` bounded by `MAX_CUES`.
 * @param {any} raw
 * @returns {Array<{ id: string, at: number, label: string }>}
 */
export function normalizeCues(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (typeof item.id !== "string" || item.id.length === 0 || item.id.length > MAX_CUE_ID_CHARS) continue;
    if (seen.has(item.id)) continue;
    if (typeof item.at !== "number" || !Number.isFinite(item.at) || item.at < 0) continue;
    const at = Math.min(MAX_TIMELINE_MS, Math.round(item.at));
    const label = typeof item.label === "string" ? item.label.trim().slice(0, MAX_CUE_LABEL) : "";
    seen.add(item.id);
    out.push({ id: item.id, at, label });
  }
  out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return out.length > MAX_CUES ? out.slice(0, MAX_CUES) : out;
}

/** Extract normalized cue markers from `doc.appState?.herdr?.timeline?.cues`. */
export function cuesOf(doc) {
  return normalizeCues(doc?.appState?.herdr?.timeline?.cues);
}

/** Return the earliest cue marker strictly after `ms`, or `null`. */
export function nextCueAfter(cues, ms) {
  const list = normalizeCues(cues);
  const t = Number.isFinite(ms) ? ms : -Infinity;
  for (const c of list) {
    if (c.at > t) return c;
  }
  return null;
}

/** Return the latest cue marker strictly before `ms`, or `null`. */
export function prevCueBefore(cues, ms) {
  const list = normalizeCues(cues);
  const t = Number.isFinite(ms) ? ms : Infinity;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].at < t) return list[i];
  }
  return null;
}

/** Respect prefers-reduced-motion: settle passive/ambient playback to timeline end, but allow explicit user-initiated Play to animate. */
export function effectiveAnimTime(time, duration, reducedMotion = false, explicitPlay = false) {
  if (time == null) return null;
  if (reducedMotion && !explicitPlay) return Math.max(0, Number.isFinite(duration) ? duration : 0);
  return time;
}
