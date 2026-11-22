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

  // ── Emphasis ──
  pulse:        { label: "Pulse",       category: "emphasis", duration: 600,  easing: "out",         from: { scale: 1 }, mid: { scale: 1.12 }, to: { scale: 1 }, loop: true },
  wiggle:       { label: "Wiggle",      category: "emphasis", duration: 600,  easing: "linear",      fn: e => ({ rotate: Math.sin(e * Math.PI * 4) * 0.14 }), loop: true },
  shake:        { label: "Shake",       category: "emphasis", duration: 500,  easing: "linear",      fn: e => ({ dx: Math.sin(e * Math.PI * 6) * 8 }), loop: true },
  float:        { label: "Float",       category: "emphasis", duration: 1400, easing: "ease-in-out", from: { dy: 0 }, mid: { dy: -10 }, to: { dy: 0 }, loop: true },
  highlight:    { label: "Highlight",   category: "emphasis", duration: 900,  easing: "ease-in-out", from: { scale: 1, glow: 0 }, mid: { scale: 1.05, glow: 1 }, to: { scale: 1, glow: 0 }, loop: true },

  // ── Path ──
  draw:         { label: "Draw",        category: "path",     duration: 800,  easing: "ease-in-out", from: { progress: 0 }, to: { progress: 1 } },

  // ── Exit ──
  out:          { label: "Fade Out",    category: "exit",     duration: 600,  easing: "out",         from: { opacity: 1 }, to: { opacity: 0 }, legacy: true },
  "fade-out":   { label: "Fade Out",    category: "exit",     duration: 600,  easing: "ease-in",     from: { opacity: 1 }, to: { opacity: 0 } },
  "scale-out":  { label: "Scale Out",   category: "exit",     duration: 550,  easing: "ease-in",     from: { opacity: 1, scale: 1 }, to: { opacity: 0, scale: 0.5 } },
  "slide-out":  { label: "Slide Out",   category: "exit",     duration: 600,  easing: "ease-in",     from: { opacity: 1, dy: 0 }, to: { opacity: 0, dy: 40 } },
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
  const start = anim.start ?? 0, dur = Math.max(1, anim.duration ?? 600);
  let k = (t - start) / dur;
  const loop = anim.loop ?? p.loop ?? false;
  if (loop) k = k < 0 ? 0 : k % 1;
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

/** Pure playback step: advances from `from` by `elapsedMs * speed`, wrapping on `loop` or ending after `holdMs`. */
export function stepTimeline({ from = 0, elapsedMs = 0, duration = 1, speed = 1, loop = false, holdMs = 400 } = {}) {
  const dur = Math.max(1, Number.isFinite(duration) ? duration : 1);
  const spd = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const dt = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0) * spd;
  const raw = Math.max(0, Number.isFinite(from) ? from : 0) + dt;
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

/** Respect prefers-reduced-motion: when reducedMotion is true during passive playback, settle to timeline end. */
export function effectiveAnimTime(time, duration, reducedMotion = false) {
  if (time == null) return null;
  if (reducedMotion) return Math.max(0, Number.isFinite(duration) ? duration : 0);
  return time;
}
