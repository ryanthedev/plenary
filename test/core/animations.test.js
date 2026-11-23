import { describe, test, expect } from "bun:test";
import {
  EASE,
  EASING_META,
  EASING_NAMES,
  canonicalEasing,
  ease,
  PRESETS,
  PRESET_NAMES,
  PRESET_CATEGORIES,
  PRESET_META,
  presetsByCategory,
  animState,
  PLAYBACK_SPEEDS,
  timelineEnd,
  formatTime,
  stepTimeline,
  scrubTime,
  timelineSpans,
  effectiveAnimTime,
} from "../../packages/core/anim.js";
import { Doc } from "../../packages/core/doc.js";
import { Editor } from "../../packages/core/editor.js";
import { paintScene } from "../../packages/core/render.js";

const makeEl = (anim, extra = {}) => ({
  id: "e1",
  type: "rectangle",
  x: 100,
  y: 100,
  width: 120,
  height: 80,
  angle: 0,
  strokeColor: "#18181b",
  backgroundColor: "#ffffff",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 0,
  opacity: 100,
  seed: 1,
  customData: anim ? { anim } : {},
  ...extra,
});

describe("easing curves", () => {
  test("all canonical easings start at 0, end at 1, and handle clamping/fallback", () => {
    for (const name of EASING_NAMES) {
      expect(ease(name, 0)).toBe(0);
      expect(ease(name, 1)).toBe(1);
      expect(ease(name, -0.5)).toBe(0);
      expect(ease(name, 1.8)).toBe(1);
      expect(ease(name, NaN)).toBe(0);
      expect(Number.isFinite(ease(name, 0.5))).toBe(true);
    }
    // Unknown easing falls back to ease-out
    expect(ease("nonexistent-curve", 0.5)).toBeCloseTo(ease("ease-out", 0.5), 6);
    expect(ease(undefined, 0.25)).toBeCloseTo(ease("ease-out", 0.25), 6);
  });

  test("legacy aliases match canonical curves identically", () => {
    for (const [legacy, canon] of [["in", "ease-in"], ["out", "ease-out"], ["inout", "ease-in-out"], ["back", "back-out"], ["overshoot", "back-out"]]) {
      expect(canonicalEasing(legacy)).toBe(canon);
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        expect(ease(legacy, t)).toBeCloseTo(ease(canon, t), 10);
        expect(EASE[legacy](t)).toBeCloseTo(EASE[canon](t), 10);
      }
    }
  });

  test("monotonicity & bounds for standard curves and overshoot/spring characteristics", () => {
    // Linear, ease-in, ease-out, ease-in-out are strictly non-decreasing in [0, 1]
    for (const name of ["linear", "ease-in", "ease-out", "ease-in-out"]) {
      let prev = -1;
      for (let i = 0; i <= 20; i++) {
        const v = ease(name, i / 20);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        prev = v;
      }
    }
    expect(ease("linear", 0.5)).toBeCloseTo(0.5, 6);
    expect(ease("ease-in", 0.5)).toBeLessThan(0.5);
    expect(ease("ease-out", 0.5)).toBeGreaterThan(0.5);
    expect(ease("ease-in-out", 0.5)).toBeCloseTo(0.5, 6);

    // Bounce stays within [0, 1] and exhibits local rebound
    const bounceSamples = Array.from({ length: 41 }, (_, i) => ease("bounce", i / 40));
    for (const v of bounceSamples) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(bounceSamples.some((v, i) => i > 0 && v < bounceSamples[i - 1])).toBe(true);

    // Back-out and spring overshoot > 1 before settling to 1
    const maxOf = name => Math.max(...Array.from({ length: 50 }, (_, i) => ease(name, i / 50)));
    expect(maxOf("back-out")).toBeGreaterThan(1.05);
    expect(maxOf("spring")).toBeGreaterThan(1.05);
    expect(EASING_META.map(m => m.id)).toEqual(EASING_NAMES);
  });
});

describe("preset library & metadata", () => {
  test("backward compatibility: all original presets remain available", () => {
    for (const name of ["fade", "rise", "slide", "pop", "draw", "pulse", "out"]) {
      expect(PRESETS[name]).toBeDefined();
      expect(PRESET_NAMES).toContain(name);
    }
  });

  test("presetsByCategory groups all non-legacy presets across the 4 categories", () => {
    const groups = presetsByCategory();
    expect(groups.map(g => g.id)).toEqual(PRESET_CATEGORIES.map(c => c.id));
    for (const g of groups) {
      expect(g.presets.length).toBeGreaterThan(0);
      for (const p of g.presets) {
        expect(p.category).toBe(g.id);
        expect(p.legacy).toBe(false);
        expect(p.duration).toBeGreaterThan(0);
        expect(EASE[p.easing]).toBeDefined();
      }
    }
    expect(PRESET_META.length).toBe(PRESET_NAMES.length);
  });
});

describe("animState across entrance, emphasis, path, and exit presets", () => {
  const entrancePresets = ["fade", "rise", "slide", "slide-up", "slide-down", "slide-left", "slide-right", "pop", "scale", "bounce-in", "zoom-in", "flip-in"];
  const emphasisPresets = ["pulse", "wiggle", "shake", "float", "highlight"];
  const exitPresets = ["out", "fade-out", "scale-out", "slide-out"];

  test("returns null for un-animated elements or unknown presets", () => {
    expect(animState(makeEl(null), 500)).toBeNull();
    expect(animState(makeEl({ preset: "does-not-exist", start: 0, duration: 500 }), 250)).toBeNull();
  });

  test("entrance presets: hidden before start, progressing at mid, settled at/after end", () => {
    for (const preset of entrancePresets) {
      const el = makeEl({ preset, start: 200, duration: 600 });
      const before = animState(el, 0);
      const atStart = animState(el, 200);
      const mid = animState(el, 500);
      const atEnd = animState(el, 800);
      const after = animState(el, 1400);

      expect(before.opacity).toBe(0);
      expect(atStart.opacity).toBe(0);
      expect(mid.opacity).toBeGreaterThan(0);
      expect(mid.opacity).toBeLessThanOrEqual(1);
      expect(atEnd.opacity).toBe(1);
      expect(after.opacity).toBe(1);
      expect(atEnd.dx).toBeCloseTo(0, 6);
      expect(atEnd.dy).toBeCloseTo(0, 6);
      expect(atEnd.scale).toBeCloseTo(1, 6);
      expect(atEnd.scaleX).toBeCloseTo(1, 6);
      expect(atEnd.scaleY).toBeCloseTo(1, 6);
    }
    // Directional sanity checks
    expect(animState(makeEl({ preset: "slide-up", start: 0, duration: 400 }), 0).dy).toBeGreaterThan(0);
    expect(animState(makeEl({ preset: "slide-down", start: 0, duration: 400 }), 0).dy).toBeLessThan(0);
    expect(animState(makeEl({ preset: "slide-left", start: 0, duration: 400 }), 0).dx).toBeGreaterThan(0);
    expect(animState(makeEl({ preset: "slide-right", start: 0, duration: 400 }), 0).dx).toBeLessThan(0);
    expect(animState(makeEl({ preset: "flip-in", start: 0, duration: 400 }), 0).scaleX).toBeLessThan(0.2);
  });

  test("emphasis presets: at rest before start, repeat whole cycles inside clip window when looping, stop cleanly at clip end, and respect loop:false", () => {
    for (const preset of emphasisPresets) {
      const el = makeEl({ preset, start: 100, duration: 800 });
      const before = animState(el, 0);
      expect(before.opacity).toBe(1);
      expect(before.scale).toBeCloseTo(1, 6);
      expect(before.dx).toBeCloseTo(0, 6);
      expect(before.dy).toBeCloseTo(0, 6);
      expect(before.rotate).toBeCloseTo(0, 6);
      expect(before.glow).toBeCloseTo(0, 6);

      // Bounded to clip window: stops cleanly at rest once t >= start + duration
      const after = animState(el, 100 + 800 + 250);
      expect(after.opacity).toBe(1);
      expect(after.scale).toBeCloseTo(1, 6);
      expect(after.dx).toBeCloseTo(0, 6);
      expect(after.dy).toBeCloseTo(0, 6);
      expect(after.rotate).toBeCloseTo(0, 6);
      expect(after.glow).toBeCloseTo(0, 6);
    }

    // Stretching a looping emphasis clip repeats whole cycles at the preset's cadence inside [start, start + dur]
    const multiPulse = makeEl({ preset: "pulse", start: 100, duration: 1800 }); // 3 x 600ms cycles
    const c1 = animState(multiPulse, 100 + 300);  // mid cycle 1
    const c2 = animState(multiPulse, 100 + 900);  // mid cycle 2
    const c3 = animState(multiPulse, 100 + 1500); // mid cycle 3
    expect(c1.scale).toBeGreaterThan(1.05);
    expect(c2.scale).toBeCloseTo(c1.scale, 6);
    expect(c3.scale).toBeCloseTo(c1.scale, 6);
    expect(animState(multiPulse, 100 + 1800).scale).toBeCloseTo(1, 6);
    expect(animState(multiPulse, 100 + 2400).scale).toBeCloseTo(1, 6);

    expect(animState(makeEl({ preset: "pulse", start: 0, duration: 800 }), 400).scale).toBeGreaterThan(1.05);
    expect(Math.abs(animState(makeEl({ preset: "wiggle", start: 0, duration: 800 }), 100).rotate)).toBeGreaterThan(0.05);
    expect(Math.abs(animState(makeEl({ preset: "shake", start: 0, duration: 600 }), 50).dx)).toBeGreaterThan(2);
    expect(animState(makeEl({ preset: "float", start: 0, duration: 1000 }), 500).dy).toBeLessThan(-5);
    expect(animState(makeEl({ preset: "highlight", start: 0, duration: 1000 }), 500).glow).toBeGreaterThan(0.8);

    // Explicit loop: false stretches a single cycle across the entire duration and settles after end
    const noLoop = makeEl({ preset: "pulse", start: 0, duration: 1800, loop: false });
    expect(animState(noLoop, 900).scale).toBeGreaterThan(1.05);
    expect(animState(noLoop, 1800).scale).toBeCloseTo(1, 6);
    expect(animState(noLoop, 2200).scale).toBeCloseTo(1, 6);
  });

  test("path-draw preset progresses cleanly from 0 to 1", () => {
    const el = makeEl({ preset: "draw", start: 100, duration: 800 });
    expect(animState(el, 0).progress).toBe(0);
    expect(animState(el, 100).progress).toBe(0);
    const mid = animState(el, 500);
    expect(mid.progress).toBeCloseTo(0.5, 4);
    expect(animState(el, 900).progress).toBe(1);
    expect(animState(el, 1500).progress).toBe(1);
  });

  test("exit presets stay visible before start and reach opacity 0 at/after end", () => {
    for (const preset of exitPresets) {
      const el = makeEl({ preset, start: 200, duration: 500 });
      expect(animState(el, 0).opacity).toBe(1);
      expect(animState(el, 200).opacity).toBe(1);
      const mid = animState(el, 450);
      expect(mid.opacity).toBeGreaterThan(0);
      expect(mid.opacity).toBeLessThan(1);
      expect(animState(el, 700).opacity).toBe(0);
      expect(animState(el, 1200).opacity).toBe(0);
    }
    expect(animState(makeEl({ preset: "scale-out", start: 0, duration: 400 }), 400).scale).toBeCloseTo(0.5, 4);
    expect(animState(makeEl({ preset: "slide-out", start: 0, duration: 400 }), 400).dy).toBeCloseTo(40, 4);
  });

  test("keyframes interpolation remains backward-compatible", () => {
    const el = makeEl({ keys: [{ t: 0, opacity: 0, dx: -20 }, { t: 500, opacity: 1, dx: 0, easing: "linear" }] });
    expect(animState(el, 0).opacity).toBe(0);
    expect(animState(el, 250).opacity).toBeCloseTo(0.5, 5);
    expect(animState(el, 250).dx).toBeCloseTo(-10, 5);
    expect(animState(el, 900).opacity).toBe(1);
  });
});

describe("render.js integration with new animation outputs", () => {
  const theme = { fg: "#18181B", bg: "#F8F7F4", accent: "#3B48E8", dim: "#625F57" };
  const view = { x: 0, y: 0, scale: 1 };

  test("highlight emits glow halo path, flip-in scales X, fade-out hides at end, freedraw hides at progress 0", () => {
    const doc = new Doc({
      elements: [
        makeEl({ preset: "highlight", start: 0, duration: 1000 }, { id: "h1" }),
        makeEl({ preset: "flip-in", start: 0, duration: 1000 }, { id: "f1" }),
        makeEl({ preset: "fade-out", start: 0, duration: 500 }, { id: "x1" }),
        makeEl({ preset: "draw", start: 500, duration: 500 }, { id: "d1", type: "freedraw", points: [[0, 0], [50, 0], [100, 50]] }),
      ],
    });
    const atMid = paintScene(doc, view, theme, { time: 500 });
    expect(atMid.some(it => it.id === "h1:glow" && it.stroke === theme.accent)).toBe(true);
    expect(atMid.some(it => it.id === "x1")).toBe(false);   // fade-out finished at 500ms
    expect(atMid.some(it => it.id === "d1")).toBe(false);   // freedraw progress === 0 at 500ms

    const atDrawMid = paintScene(doc, view, theme, { time: 750 });
    expect(atDrawMid.some(it => it.id === "d1")).toBe(true);
  });
});

describe("timeline math & Editor playback controls", () => {
  test("timelineEnd, formatTime, scrubTime, stepTimeline, timelineSpans, effectiveAnimTime", () => {
    const els = [
      makeEl({ preset: "fade", start: 0, duration: 600 }, { id: "a" }),
      makeEl({ preset: "draw", start: 300, duration: 800 }, { id: "b" }),
      makeEl({ preset: "fade", start: 0, duration: 600 }, { id: "lbl", type: "text", containerId: "a", text: "Hi" }),
    ];
    expect(timelineEnd(els)).toBe(1100);
    expect(timelineEnd([])).toBe(0);

    expect(formatTime(0)).toBe("00:00.0");
    expect(formatTime(650)).toBe("00:00.6");
    expect(formatTime(1500)).toBe("00:01.5");
    expect(formatTime(65_200)).toBe("01:05.2");
    expect(formatTime(-100)).toBe("00:00.0");

    expect(scrubTime(0, 2000)).toBe(0);
    expect(scrubTime(0.5, 2000)).toBe(1000);
    expect(scrubTime(1.5, 2000)).toBe(2000);
    expect(scrubTime(-0.2, 2000)).toBe(0);

    // Speed scaling & ending without loop
    expect(PLAYBACK_SPEEDS).toEqual([0.5, 1, 1.5, 2]);
    expect(stepTimeline({ from: 0, elapsedMs: 500, duration: 1000, speed: 1, loop: false })).toEqual({ time: 500, ended: false });
    expect(stepTimeline({ from: 0, elapsedMs: 500, duration: 1000, speed: 2, loop: false })).toEqual({ time: 1000, ended: false });
    expect(stepTimeline({ from: 0, elapsedMs: 500, duration: 1000, speed: 0.5, loop: false })).toEqual({ time: 250, ended: false });
    expect(stepTimeline({ from: 0, elapsedMs: 1500, duration: 1000, speed: 1, loop: false })).toEqual({ time: null, ended: true });

    // Looping wraps cleanly modulo duration
    expect(stepTimeline({ from: 800, elapsedMs: 500, duration: 1000, speed: 1, loop: true })).toEqual({ time: 300, ended: false });
    expect(stepTimeline({ from: 0, elapsedMs: 1200, duration: 1000, speed: 2, loop: true })).toEqual({ time: 400, ended: false });

    // timelineSpans skips bound labels and sorts by start
    const spans = timelineSpans(els);
    expect(spans.map(s => s.id)).toEqual(["a", "b"]);
    expect(spans[0].category).toBe("entrance");
    expect(spans[1].category).toBe("path");

    // Reduced motion helper
    expect(effectiveAnimTime(null, 1000, true)).toBeNull();
    expect(effectiveAnimTime(200, 1000, false)).toBe(200);
    expect(effectiveAnimTime(200, 1000, true)).toBe(1000);
  });

  test("Editor animate, updateAnimation, clearAnimation, speed rebase, loop, seek, and step", () => {
    let now = 1000;
    const ed = new Editor({ scene: { elements: [makeEl(null, { id: "r1" })] }, clock: () => now });
    ed.select(["r1"]);
    ed.animate("zoom-in", { easing: "spring", start: 100 });
    expect(ed.doc.get("r1").customData.anim).toEqual({ preset: "zoom-in", start: 100, duration: 600, easing: "spring" });

    ed.updateAnimation({ easing: "bounce", duration: 900, start: 200, loop: true });
    expect(ed.doc.get("r1").customData.anim).toEqual({ preset: "zoom-in", start: 200, duration: 900, easing: "bounce", loop: true });
    expect(ed.duration()).toBe(1100);

    // Playback with speed rebase & loop
    ed.setPlayLoop(true);
    ed.playToggle();
    now += 300;
    expect(ed.time()).toBe(300);
    ed.setPlaySpeed(2);       // rebases from 300ms
    expect(ed.time()).toBe(300);
    now += 200;               // +400ms scaled -> 700ms
    expect(ed.time()).toBe(700);
    now += 500;               // +1000ms scaled -> 1700 % 1100 = 600ms
    expect(ed.time()).toBe(600);

    ed.stepToStart();
    expect(ed.play).toBeNull();
    expect(ed.time()).toBe(0);
    ed.stepToEnd();
    expect(ed.time()).toBe(1100);
    ed.seekTo(450);
    expect(ed.time()).toBe(450);

    ed.restartPlay();
    expect(ed.play).toBeTruthy();
    expect(ed.time()).toBe(0);

    ed.clearAnimation();
    expect(ed.doc.get("r1").customData.anim).toBeUndefined();
  });

  test("M1 & L2: legacy out/pulse defaults, keyframe unknown easing fallback, and empty/unknown timelineEnd", () => {
    // Legacy `out` uses `out` easing and 600ms default duration
    const outEl = makeEl({ preset: "out", start: 0 });
    expect(animState(outEl, 300).opacity).toBeCloseTo(1 - ease("out", 0.5), 6);
    expect(animState(outEl, 600).opacity).toBe(0);

    // Legacy `pulse` uses `out` easing and 600ms default duration
    const pulseEl = makeEl({ preset: "pulse", start: 0 });
    expect(timelineEnd([pulseEl])).toBe(600);
    // At t=150 (k=0.25), e = ease("out", 0.25) = 0.4375 < 0.5 -> scale = lerp(1, 1.12, 0.875)
    expect(animState(pulseEl, 150).scale).toBeCloseTo(1 + 0.12 * (ease("out", 0.25) * 2), 6);

    // Keyframes with unknown easing fall back to ease-in-out
    const kfEl = makeEl({ keys: [{ t: 0, dx: 0 }, { t: 400, dx: 100, easing: "nonexistent" }] });
    expect(animState(kfEl, 100).dx).toBeCloseTo(100 * ease("ease-in-out", 0.25), 6);

    // L2: empty keys or unknown preset contribute 0 to timelineEnd
    expect(timelineEnd([makeEl({ keys: [] }), makeEl({ preset: "bogus", start: 100 })])).toBe(0);
  });

  test("M2: prototype-safe lookups reject Object.prototype keys without crashing", () => {
    for (const bad of ["valueOf", "__proto__", "toString", "constructor", "hasOwnProperty"]) {
      expect(animState(makeEl({ preset: bad, start: 0, duration: 500 }), 250)).toBeNull();
      const s = animState(makeEl({ preset: "fade", start: 0, duration: 500, easing: bad }), 250);
      expect(s.opacity).toBeCloseTo(ease("ease-out", 0.5), 6);
      expect(timelineEnd([makeEl({ preset: bad, start: 100 })])).toBe(0);
      expect(timelineSpans([makeEl({ preset: bad, start: 100 })])).toEqual([]);
    }
    const ed = new Editor({ scene: { elements: [makeEl(null, { id: "r1" })] } });
    ed.select(["r1"]);
    ed.animate("toString");
    expect(ed.doc.get("r1").customData.anim).toBeUndefined();
    ed.animate("fade", { easing: "valueOf" });
    expect(ed.doc.get("r1").customData.anim.easing).toBeUndefined();
  });

  test("M3: text, bound labels, and images do not double-rotate under rotational animations", () => {
    const theme = { fg: "#18181B", bg: "#F8F7F4", accent: "#3B48E8", dim: "#625F57" };
    const view = { x: 0, y: 0, scale: 1 };
    const wiggleAnim = { preset: "wiggle", start: 0, duration: 800 };
    const doc = new Doc({
      elements: [
        makeEl(wiggleAnim, { id: "t1", type: "text", x: 100, y: 100, width: 80, height: 24, text: "Hello", fontSize: 20, fontFamily: 1, lineHeight: 1.25 }),
        makeEl(wiggleAnim, { id: "img1", type: "image", x: 200, y: 100, width: 100, height: 80, fileId: "f1" }),
      ],
      files: { f1: { mimeType: "image/png", dataURL: "data:image/png;base64,AA==" } },
    });
    const atPeak = paintScene(doc, view, theme, { time: 100 });
    const tItem = atPeak.find(it => it.id === "t1");
    const iItem = atPeak.find(it => it.id === "img1");
    const expectedRot = animState(doc.get("t1"), 100).rotate;
    expect(Math.abs(expectedRot)).toBeGreaterThan(0.05);
    // Position/box are unrotated (QNoRot) and rotation is carried once via `angle`
    expect(tItem.x).toBe(100);
    expect(tItem.y).toBe(100);
    expect(tItem.angle).toBeCloseTo(expectedRot, 6);
    expect(iItem.x).toBe(200);
    expect(iItem.y).toBe(100);
    expect(iItem.w).toBe(100);
    expect(iItem.h).toBe(80);
    expect(iItem.angle).toBeCloseTo(expectedRot, 6);
  });

  test("M5 & M6: Editor reducedMotion settles displayList, and setPlaySpeed at playback end does not restart from 0", () => {
    const theme = { fg: "#18181B", bg: "#F8F7F4", accent: "#3B48E8", dim: "#625F57" };
    let now = 0;
    const ed = new Editor({
      scene: { elements: [makeEl({ preset: "fade", start: 0, duration: 600 }, { id: "r1" })] },
      clock: () => now,
    });
    ed.seekTo(0);
    // Normal mode at t=0: opacity is 0 -> element omitted from displayList
    expect(ed.displayList(theme).some(it => it.id === "r1")).toBe(false);
    // Reduced motion settles to timeline end -> element is visible at full opacity
    ed.setReducedMotion(true);
    expect(ed.displayList(theme).some(it => it.id === "r1" && it.opacity === 1)).toBe(true);

    // M6: setPlaySpeed when playback has already exceeded duration + holdMs must not restart from 0
    ed.setReducedMotion(false);
    ed.playToggle();
    expect(ed.play).toBeTruthy();
    now = 5000; // well past 600 + 400ms hold
    ed.setPlaySpeed(2);
    expect(ed.play).toBeNull();
    expect(ed.playSpeed).toBe(2);
  });

  test("#109: explicit user Play animates smoothly even when prefers-reduced-motion is active, while passive/ambient play still settles", () => {
    const theme = { fg: "#18181B", bg: "#F8F7F4", accent: "#3B48E8", dim: "#625F57" };
    let now = 0;
    const ed = new Editor({
      scene: { elements: [makeEl({ preset: "fade", start: 0, duration: 600 }, { id: "r1" })] },
      clock: () => now,
    });
    ed.setReducedMotion(true);

    // effectiveAnimTime allows explicitPlay while settling passive playback
    expect(effectiveAnimTime(150, 600, true, false)).toBe(600);
    expect(effectiveAnimTime(150, 600, true, true)).toBe(150);

    // Ambient / non-explicit play still settles to timeline end under reducedMotion
    ed.playToggle({ explicit: false });
    expect(ed.needsTick()).toBe(true);
    expect(ed.displayList(theme).find(it => it.id === "r1")?.opacity).toBe(1);
    ed.stopPlay();

    // Explicit user-initiated Play advances smoothly across ticks even with reducedMotion: true
    ed.playToggle();
    expect(ed.play?.explicit).toBe(true);
    expect(ed.needsTick()).toBe(true);
    expect(ed.displayList(theme).some(it => it.id === "r1")).toBe(false); // t=0: opacity 0

    now = 300;
    const vBefore = ed.version;
    ed.tick();
    expect(ed.version).toBeGreaterThan(vBefore);
    const midItem = ed.displayList(theme).find(it => it.id === "r1");
    expect(midItem).toBeDefined();
    expect(midItem.opacity).toBeCloseTo(0.75, 5);

    // Pausing mid-play under reducedMotion must hold the paused frame (0.75) instead of jumping to end (1.0)
    ed.playToggle();
    expect(ed.play).toBeNull();
    expect(ed.scrub).toBe(300);
    expect(ed.displayList(theme).find(it => it.id === "r1")?.opacity).toBeCloseTo(0.75, 5);

    // Explicit interactive scrub under reducedMotion renders the scrubbed frame, and stopPlay clears userTimeline
    ed.seekTo(150, { explicit: true });
    expect(ed.displayList(theme).find(it => it.id === "r1")?.opacity).toBeCloseTo(ease("ease-out", 0.25), 5);
    ed.playToggle(); // resume from 150ms

    // Speed change preserves explicit playback under reducedMotion
    ed.setPlaySpeed(2);
    expect(ed.play?.explicit).toBe(true);
    now = 525; // 150 + 225*2 = 600ms -> settled at opacity 1
    expect(ed.displayList(theme).find(it => it.id === "r1")?.opacity).toBe(1);

    // Playback completion bumps version even if time() is called outside tick()
    now = 1200; // past duration + holdMs
    const vPreEnd = ed.version;
    expect(ed.time()).toBeNull();
    expect(ed.play).toBeNull();
    expect(ed.needsTick()).toBe(false);
    expect(ed.version).toBeGreaterThan(vPreEnd);

    // restartPlay also sets explicit: true
    ed.restartPlay();
    expect(ed.play?.explicit).toBe(true);
    expect(ed.displayList(theme).some(it => it.id === "r1")).toBe(false);
  });

  test("#117: dissolve-in, dissolve-out, and wipe-right/left/down/up presets emit smooth opacity & clip rects", () => {
    // Dissolve In & Dissolve Out
    const din = makeEl({ preset: "dissolve-in", start: 100, duration: 700 });
    expect(animState(din, 100).opacity).toBe(0);
    expect(animState(din, 450).opacity).toBeCloseTo(0.5, 4);
    expect(animState(din, 800).opacity).toBe(1);
    expect(animState(din, 800).scale).toBeCloseTo(1, 6);

    const dout = makeEl({ preset: "dissolve-out", start: 0, duration: 700 });
    expect(animState(dout, 0).opacity).toBe(1);
    expect(animState(dout, 350).opacity).toBeCloseTo(0.5, 4);
    expect(animState(dout, 700).opacity).toBe(0);

    // Wipe presets: directional normalized clip rects
    const wr = makeEl({ preset: "wipe-right", start: 0, duration: 600 });
    expect(animState(wr, 0)).toMatchObject({ opacity: 0, clip: { x: 0, y: 0, w: 0, h: 1 } });
    expect(animState(wr, 300)).toMatchObject({ opacity: 1, clip: { x: 0, y: 0, w: 0.5, h: 1 } });
    expect(animState(wr, 600)).toMatchObject({ opacity: 1, clip: { x: 0, y: 0, w: 1, h: 1 } });

    const wl = makeEl({ preset: "wipe-left", start: 0, duration: 600 });
    expect(animState(wl, 300).clip).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });

    const wd = makeEl({ preset: "wipe-down", start: 0, duration: 600 });
    expect(animState(wd, 300).clip).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });

    const wu = makeEl({ preset: "wipe-up", start: 0, duration: 600 });
    expect(animState(wu, 300).clip).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });

    // Overshooting easing (spring) still clamps clip strictly inside [0, 1]
    const wSpring = makeEl({ preset: "wipe-right", start: 0, duration: 600, easing: "spring" });
    for (let t = 0; t <= 600; t += 30) {
      const c = animState(wSpring, t).clip;
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.w).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(1 + 1e-9);
    }

    // render.js wires screen-space clip rect mid-wipe, omits element at t=0, omits clip when fully revealed
    const theme = { fg: "#18181B", bg: "#F8F7F4", accent: "#3B48E8", dim: "#625F57" };
    const view = { x: 0, y: 0, scale: 1 };
    const imgDoc = new Doc({
      elements: [
        makeEl({ preset: "wipe-right", start: 0, duration: 600 }, { id: "im1", type: "image", x: 100, y: 50, width: 200, height: 100, fileId: "f1" }),
      ],
      files: { f1: { mimeType: "image/png", dataURL: "data:image/png;base64,AA==" } },
    });
    expect(paintScene(imgDoc, view, theme, { time: 0 }).length).toBe(0);
    const midItems = paintScene(imgDoc, view, theme, { time: 300 });
    expect(midItems.length).toBe(1);
    expect(midItems[0].clip).toEqual({ x: 100, y: 50, w: 100, h: 100 });
    const endItems = paintScene(imgDoc, view, theme, { time: 600 });
    expect(endItems.length).toBe(1);
    expect(endItems[0].clip).toBeUndefined();

    // Opus review regression: bound label wipes in lockstep with its container shape's box
    const labelDoc = new Doc({
      elements: [
        makeEl({ preset: "wipe-right", start: 0, duration: 600 }, { id: "box1", x: 100, y: 100, width: 400, height: 100 }),
        makeEl({ preset: "wipe-right", start: 0, duration: 600 }, { id: "lbl1", type: "text", containerId: "box1", x: 250, y: 140, width: 80, height: 20, text: "Hello", fontSize: 20, fontFamily: 1, lineHeight: 1.25 }),
      ],
    });
    const wipeItems = paintScene(labelDoc, view, theme, { time: 300 });
    const boxItem = wipeItems.find(it => it.id === "box1");
    const lblItem = wipeItems.find(it => it.id === "lbl1");
    expect(boxItem?.clip).toBeDefined();
    expect(lblItem?.clip).toEqual(boxItem.clip);
  });
});
