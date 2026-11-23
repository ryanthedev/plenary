import { describe, test, expect } from "bun:test";
import {
  MAX_CUES,
  MAX_CUE_LABEL,
  MIN_CLIP_DURATION,
  timelineTracks,
  snapTrackTime,
  reorderTrackOrder,
  cascadeTracks,
  alignTracks,
  rulerTicks,
  normalizeCues,
  cuesOf,
  nextCueAfter,
  prevCueBefore,
  stepTimeline,
} from "../../packages/core/anim.js";
import { Doc } from "../../packages/core/doc.js";
import { Editor } from "../../packages/core/editor.js";
import { opProblem } from "../../packages/protocol/envelope.js";

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
  version: 1,
  versionNonce: 1,
  customData: anim ? { anim } : {},
  ...extra,
});

describe("Wave 13A pure multi-swimlane timeline math", () => {
  test("exports bounded constants", () => {
    expect(MAX_CUES).toBe(50);
    expect(MAX_CUE_LABEL).toBe(80);
    expect(MIN_CLIP_DURATION).toBe(100);
  });

  test("timelineTracks sorts deterministically by (order ?? Infinity, start, id) and derives clean labels <= 32 chars", () => {
    const longText = "This is a very long heading label that should definitely be truncated cleanly";
    const doc = new Doc({
      elements: [
        makeEl({ preset: "fade", start: 400, duration: 500 }, { id: "c" }),
        makeEl({ preset: "pop", start: 200, duration: 600, order: 1, cueGroup: "intro" }, { id: "a", type: "ellipse" }),
        makeEl({ preset: "slide-up", start: 600, duration: 400, order: 0 }, { id: "b", type: "frame", name: "  Hero Frame  " }),
        makeEl({ preset: "fade", start: 400, duration: 500 }, { id: "b2", type: "text", text: longText }),
        makeEl({ preset: "fade", start: 400, duration: 500 }, { id: "lbl_c", type: "text", containerId: "c", text: "Bound\n  Card   Title" }),
        makeEl({ preset: "fade", start: 100, duration: 300 }, { id: "dead", isDeleted: true }),
        makeEl({ preset: "nonexistent", start: 0, duration: 300 }, { id: "bad" }),
        makeEl({ keys: [{ t: 150, opacity: 0 }, { t: 750, opacity: 1 }] }, { id: "kf", type: "diamond" }),
      ],
    });

    const tracks = timelineTracks(doc);
    // order: b (0), a (1), then Infinity sorted by start: kf (150), b2 (400), c (400)
    expect(tracks.map(t => t.id)).toEqual(["b", "a", "kf", "b2", "c"]);

    expect(tracks[0]).toMatchObject({
      id: "b",
      type: "frame",
      label: "Hero Frame",
      preset: "slide-up",
      category: "entrance",
      start: 600,
      duration: 400,
      end: 1000,
      easing: "ease-out",
      loop: false,
      order: 0,
      cueGroup: null,
    });

    expect(tracks[1]).toMatchObject({
      id: "a",
      type: "ellipse",
      label: "Ellipse",
      preset: "pop",
      order: 1,
      cueGroup: "intro",
    });

    expect(tracks[2]).toMatchObject({
      id: "kf",
      type: "diamond",
      label: "Diamond",
      preset: "keyframes",
      start: 150,
      duration: 600,
      end: 750,
      order: null,
    });

    expect(tracks[3].label.length).toBeLessThanOrEqual(32);
    expect(tracks[3].label.endsWith("…")).toBe(true);
    expect(tracks[4].label).toBe("Bound Card Title");
  });

  test("snapTrackTime snaps to nearest edge within snapTol, else step ticks, or free integer ms", () => {
    expect(snapTrackTime(-50, [200])).toBe(0);
    expect(snapTrackTime(480, [550, 1200], { step: 100, snapTol: 120 })).toBe(550);
    expect(snapTrackTime(400, [550, 1200], { step: 100, snapTol: 120 })).toBe(400);
    expect(snapTrackTime(360, [1000], { step: 100, snapTol: 120 })).toBe(400);
    // Tie-breaks deterministically to smaller edge
    expect(snapTrackTime(500, [560, 440], { snapTol: 100 })).toBe(440);
    // Free mode ignores edges and step
    expect(snapTrackTime(483.7, [500], { free: true })).toBe(484);
    expect(snapTrackTime(-12.4, [0], { free: true })).toBe(0);
  });

  test("reorderTrackOrder, cascadeTracks, and alignTracks compute pure updates", () => {
    const tracks = [
      { id: "t0", start: 500, duration: 400, end: 900 },
      { id: "t1", start: 0, duration: 300, end: 300 },
      { id: "t2", start: 100, duration: 500, end: 600 },
    ];
    expect(reorderTrackOrder(tracks, 2, 0)).toEqual([
      { id: "t2", order: 0 },
      { id: "t0", order: 1 },
      { id: "t1", order: 2 },
    ]);
    expect(reorderTrackOrder(tracks, 0, 2)).toEqual([
      { id: "t1", order: 0 },
      { id: "t2", order: 1 },
      { id: "t0", order: 2 },
    ]);
    // Input untouched
    expect(tracks.map(t => t.id)).toEqual(["t0", "t1", "t2"]);

    expect(cascadeTracks(tracks)).toEqual([
      { id: "t0", start: 0, order: 0 },
      { id: "t1", start: 550, order: 1 },
      { id: "t2", start: 1000, order: 2 },
    ]);
    expect(cascadeTracks(tracks, { gap: 100, startAt: 200 })).toEqual([
      { id: "t0", start: 200, order: 0 },
      { id: "t1", start: 700, order: 1 },
      { id: "t2", start: 1100, order: 2 },
    ]);

    expect(alignTracks(tracks, 350.6)).toEqual([
      { id: "t0", start: 351 },
      { id: "t1", start: 351 },
      { id: "t2", start: 351 },
    ]);
    expect(alignTracks(tracks, -100)).toEqual([
      { id: "t0", start: 0 },
      { id: "t1", start: 0 },
      { id: "t2", start: 0 },
    ]);
  });

  test("rulerTicks adapts interval to duration and stays bounded for long timelines", () => {
    expect(rulerTicks(0)).toEqual([{ at: 0, label: "0s", major: true }]);

    const short = rulerTicks(2000);
    const shortMajors = short.filter(t => t.major);
    expect(shortMajors.map(t => t.label)).toEqual(["0s", "0.5s", "1s", "1.5s", "2s"]);

    const med = rulerTicks(6000);
    expect(med.filter(t => t.major).map(t => t.label)).toEqual(["0s", "1s", "2s", "3s", "4s", "5s", "6s"]);

    const wide = rulerTicks(20_000);
    expect(wide.filter(t => t.major).slice(0, 4).map(t => t.label)).toEqual(["0s", "2s", "4s", "6s"]);

    const long = rulerTicks(50_000);
    expect(long.filter(t => t.major).slice(0, 4).map(t => t.label)).toEqual(["0s", "5s", "10s", "15s"]);

    const hour = rulerTicks(3_600_000);
    expect(hour.length).toBeLessThan(200);
    expect(hour[0]).toEqual({ at: 0, label: "0s", major: true });
    expect(hour.at(-1).at).toBe(3_600_000);

    // Extreme finite durations clamp cleanly to 1 hour max without huge allocation
    const huge = rulerTicks(1e12);
    expect(huge.length).toBe(hour.length);
    expect(huge.at(-1).at).toBe(3_600_000);
  });
});

describe("Wave 13A cue helpers & stepTimeline stopAt", () => {
  test("normalizeCues, cuesOf, nextCueAfter, prevCueBefore sort, deduplicate, and bound", () => {
    const raw = [
      { id: "c2", at: 1500.4, label: "  Reveal  " },
      { id: "c1", at: 500, label: "A".repeat(120) },
      { id: "c2", at: 9999, label: "Duplicate id ignored" },
      { id: "", at: 100, label: "Bad empty id" },
      { id: "neg", at: -10, label: "Negative" },
      { id: "nan", at: NaN, label: "NaN" },
      null,
    ];
    const cues = normalizeCues(raw);
    expect(cues).toEqual([
      { id: "c1", at: 500, label: "A".repeat(MAX_CUE_LABEL) },
      { id: "c2", at: 1500, label: "Reveal" },
    ]);

    const doc = new Doc({ elements: [], appState: { herdr: { timeline: { duration: 2000, cues: raw } } } });
    expect(cuesOf(doc)).toEqual(cues);

    expect(nextCueAfter(cues, 0)?.id).toBe("c1");
    expect(nextCueAfter(cues, 500)?.id).toBe("c2");
    expect(nextCueAfter(cues, 1500)).toBeNull();

    expect(prevCueBefore(cues, 2000)?.id).toBe("c2");
    expect(prevCueBefore(cues, 1500)?.id).toBe("c1");
    expect(prevCueBefore(cues, 500)).toBeNull();

    // Bounded to MAX_CUES (50)
    const many = Array.from({ length: 70 }, (_, i) => ({ id: `k${i}`, at: i * 100, label: `Cue ${i}` }));
    expect(normalizeCues(many).length).toBe(MAX_CUES);
  });

  test("stepTimeline supports stopAt in both options-object and positional signatures", () => {
    // Options-object signature (existing API + stopAt)
    expect(stepTimeline({ from: 0, elapsedMs: 300, duration: 2000, stopAt: 500 })).toEqual({ time: 300, ended: false });
    expect(stepTimeline({ from: 0, elapsedMs: 500, duration: 2000, stopAt: 500 })).toEqual({ time: 500, ended: true, pausedAtCue: true });
    expect(stepTimeline({ from: 0, elapsedMs: 700, duration: 2000, stopAt: 500, loop: true })).toEqual({ time: 500, ended: true, pausedAtCue: true });
    // stopAt <= from does not immediately pause
    expect(stepTimeline({ from: 500, elapsedMs: 200, duration: 2000, stopAt: 500 })).toEqual({ time: 700, ended: false });

    // Positional signature: stepTimeline(play, now, dur, { stopAt })
    expect(stepTimeline({ at: 0, t0: 1000 }, 1600, 2000, { stopAt: 500 })).toEqual({ t: 500, time: 500, ended: true, pausedAtCue: true });
    expect(stepTimeline({ at: 0, t0: 1000 }, 1250, 2000, { stopAt: 500 })).toEqual({ t: 250, time: 250, ended: false });
  });
});

describe("Wave 13A Editor cues & choreography integration", () => {
  test("addCueAt, moveCue, renameCue, deleteCue emit protocol-valid appState ops and respect bounds", () => {
    const ops = [];
    const ed = new Editor({
      scene: { elements: [makeEl({ preset: "fade", start: 0, duration: 1500 }, { id: "r1" })] },
      onOp: op => ops.push(op),
    });

    const c1 = ed.addCueAt(500, "  Intro  ");
    const c2 = ed.addCueAt(1100, "Deep dive");
    expect(c1).toMatchObject({ at: 500, label: "Intro" });
    expect(c2).toMatchObject({ at: 1100, label: "Deep dive" });
    expect(cuesOf(ed.doc).map(c => c.at)).toEqual([500, 1100]);

    expect(ed.moveCue(c2.id, 300)).toBe(true);
    expect(cuesOf(ed.doc).map(c => c.id)).toEqual([c2.id, c1.id]);

    expect(ed.renameCue(c1.id, "Finale")).toBe(true);
    expect(cuesOf(ed.doc).find(c => c.id === c1.id)?.label).toBe("Finale");

    expect(ed.deleteCue(c2.id)).toBe(true);
    expect(cuesOf(ed.doc).map(c => c.id)).toEqual([c1.id]);

    // Every emitted appState op passes protocol envelope validation
    expect(ops.length).toBe(5);
    for (let i = 0; i < ops.length; i++) {
      const msg = { t: "op", id: `c:${i + 1}`, sentAt: 0, stream: "board", op: { ...ops[i], appBase: { timeline: i } } };
      expect(opProblem(msg)).toBeNull();
    }

    // Bounded at MAX_CUES
    for (let i = 1; i < MAX_CUES; i++) expect(ed.addCueAt(i * 10, `C${i}`)).not.toBeNull();
    expect(cuesOf(ed.doc).length).toBe(MAX_CUES);
    expect(ed.addCueAt(9999, "Overflow")).toBeNull();
  });

  test("playToNextCue & stepToPrevCue step cleanly across cues, hold frames under reducedMotion, and loop from end to first cue", () => {
    let now = 1000;
    const theme = { fg: "#18181B", bg: "#F8F7F4", accent: "#3B48E8", dim: "#625F57" };
    const ed = new Editor({
      scene: {
        elements: [
          makeEl({ preset: "fade", start: 0, duration: 2000 }, { id: "r1" }),
        ],
        appState: {
          herdr: {
            timeline: {
              duration: 2000,
              cues: [
                { id: "q1", at: 500, label: "Point 1" },
                { id: "q2", at: 1200, label: "Point 2" },
              ],
            },
          },
        },
      },
      clock: () => now,
    });
    ed.setReducedMotion(true);

    // 1. Start at 0 -> play to q1 (500ms)
    ed.playToNextCue();
    expect(ed.play).toMatchObject({ from: 0, stopAt: 500, explicit: true });
    now += 250;
    expect(ed.time()).toBe(250);
    now += 400; // crosses 500
    expect(ed.time()).toBe(500);
    expect(ed.play).toBeNull();
    expect(ed.scrub).toBe(500);
    // Holds the cue frame under reducedMotion rather than snapping to end (opacity 1)
    expect(ed.displayList(theme).find(it => it.id === "r1")?.opacity).toBeLessThan(1);

    // 2. From q1 (500) -> play to q2 (1200), rebasing speed mid-flight
    ed.playToNextCue();
    expect(ed.play).toMatchObject({ from: 500, stopAt: 1200 });
    now += 200; // at 700
    ed.setPlaySpeed(2);
    expect(ed.play).toMatchObject({ from: 700, stopAt: 1200 });
    now += 300; // 700 + 600 = 1300 -> clamps to 1200
    expect(ed.time()).toBe(1200);
    expect(ed.play).toBeNull();
    expect(ed.scrub).toBe(1200);

    // 3. From q2 (1200) -> no cue ahead, stops cleanly at timeline end (2000)
    ed.setPlaySpeed(1);
    ed.playToNextCue();
    expect(ed.play).toMatchObject({ from: 1200, stopAt: 2000 });
    now += 900;
    expect(ed.time()).toBe(2000);
    expect(ed.play).toBeNull();
    expect(ed.scrub).toBe(2000);

    // 4. Already at end (2000) -> restarts from 0 to first cue (500)
    ed.playToNextCue();
    expect(ed.play).toMatchObject({ from: 0, stopAt: 500 });
    now += 500;
    expect(ed.time()).toBe(500);

    // 5. stepToPrevCue walks back through cues to 0
    ed.seekTo(1500);
    expect(ed.stepToPrevCue()).toBe(1200);
    expect(ed.time()).toBe(1200);
    expect(ed.stepToPrevCue()).toBe(500);
    expect(ed.time()).toBe(500);
    expect(ed.stepToPrevCue()).toBe(0);
    expect(ed.time()).toBe(0);
  });

  test("reorderAnimTracks, cascadeAnimTracks, alignAnimTracks, setAnimTiming are single-undoable and sync bound labels", () => {
    const ed = new Editor({
      scene: {
        elements: [
          makeEl({ preset: "fade", start: 0, duration: 400 }, { id: "s1" }),
          makeEl({ preset: "fade", start: 0, duration: 400 }, { id: "l1", type: "text", containerId: "s1", text: "One" }),
          makeEl({ preset: "pop", start: 200, duration: 500 }, { id: "s2" }),
          makeEl({ preset: "slide-up", start: 600, duration: 300 }, { id: "s3" }),
        ],
      },
    });

    // Reorder: move s3 (idx 2) to idx 0
    expect(ed.reorderAnimTracks(2, 0)).toBe(true);
    expect(timelineTracks(ed.doc).map(t => t.id)).toEqual(["s3", "s1", "s2"]);
    expect(ed.doc.get("l1").customData.anim.order).toBe(1);

    // Single undo restores original order
    ed.undo();
    expect(timelineTracks(ed.doc).map(t => t.id)).toEqual(["s1", "s2", "s3"]);
    expect(ed.doc.get("l1").customData.anim.order).toBeUndefined();

    // Cascade with gap 100
    expect(ed.cascadeAnimTracks({ gap: 100, startAt: 50 })).toBe(true);
    expect(ed.doc.get("s1").customData.anim).toMatchObject({ start: 50, order: 0 });
    expect(ed.doc.get("l1").customData.anim).toMatchObject({ start: 50, order: 0 });
    expect(ed.doc.get("s2").customData.anim).toMatchObject({ start: 550, order: 1 });
    expect(ed.doc.get("s3").customData.anim).toMatchObject({ start: 1150, order: 2 });

    // Align subset [s1, s3] to 300
    expect(ed.alignAnimTracks(["s1", "s3"], 300)).toBe(true);
    expect(ed.doc.get("s1").customData.anim.start).toBe(300);
    expect(ed.doc.get("l1").customData.anim.start).toBe(300);
    expect(ed.doc.get("s2").customData.anim.start).toBe(550);
    expect(ed.doc.get("s3").customData.anim.start).toBe(300);

    // setAnimTiming updates timing + preset + easing + loop + clamps duration >= MIN_CLIP_DURATION
    expect(ed.setAnimTiming("s1", { start: 120, duration: 20, preset: "zoom-in", easing: "spring", loop: true })).toBe(true);
    expect(ed.doc.get("s1").customData.anim).toMatchObject({
      preset: "zoom-in",
      start: 120,
      duration: MIN_CLIP_DURATION,
      easing: "spring",
      loop: true,
    });
    expect(ed.doc.get("l1").customData.anim).toEqual(ed.doc.get("s1").customData.anim);

    // Single undo reverts setAnimTiming on both shape and bound label
    ed.undo();
    expect(ed.doc.get("s1").customData.anim.start).toBe(300);
    expect(ed.doc.get("l1").customData.anim.start).toBe(300);

    // Locked bound label still stays synchronized with its editable container shape
    ed.doc.get("l1").locked = true;
    expect(ed.setAnimTiming("s1", { start: 420, duration: 9_999_999 })).toBe(true);
    expect(ed.doc.get("s1").customData.anim).toMatchObject({ start: 420, duration: 3_600_000 });
    expect(ed.doc.get("l1").customData.anim).toEqual(ed.doc.get("s1").customData.anim);
  });
});
