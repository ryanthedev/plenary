// Phase 2 Gate: Frame-rate-independent presence interpolation, laser/emote decay, and zero-idle-rAF settle.
import { describe, test, expect } from "bun:test";
import {
  createPresence,
  SMOOTH_TAU_MS,
  SETTLE_EPSILON,
  LASER_FADE_MS,
  FLOAT_MS,
} from "../../web/core/collab/presence-model.js";
import { PRESENCE_SILENCE_MS } from "../../web/core/collab/limits.js";
import { mountCollab } from "../../web/adapters/dom/collab/ui.js";
import { createFakePort } from "../../web/adapters/collab/fake.js";
import { fakeClock } from "./collab/clock.js";
import { installDom, FakeElement } from "./collab/fake-dom.js";

function makeCanvas(w = 800, h = 600) {
  const c = new FakeElement("canvas");
  c.clientWidth = w; c.clientHeight = h; c.width = 0; c.height = 0;
  const ctx = {
    save() {}, restore() {}, setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    closePath() {}, stroke() {}, fill() {}, strokeRect() {}, rect() {}, roundRect() {}, arc() {},
    translate() {}, setLineDash() {}, fillText() {}, measureText: t => ({ width: String(t).length * 7 }),
  };
  c.getContext = () => ctx;
  return c;
}

const HERE = {
  writers: [
    { user: "maya", name: "Maya", role: "owner" },
    { user: "dev", name: "Dev K.", role: "editor" },
  ],
  writerCount: 2,
  viewers: 0,
};

function makeModel(opts = {}) {
  const c = fakeClock();
  const p = createPresence({
    now: c.now,
    me: { user: "me", client: "me-1" },
    role: "editor",
    ...opts,
  });
  p.here(HERE);
  return { c, p };
}

describe("M3 presence smoothing (presence-model.js)", () => {
  test("first cursor snaps immediately; subsequent updates separate target from smoothed display", () => {
    const { p } = makeModel();
    p.ingest([{ user: "maya", client: "m1", k: "cursor", x: 10, y: 20 }]);
    let v = p.view();
    expect(v.cursors[0]).toMatchObject({ x: 10, y: 20, targetX: 10, targetY: 20 });
    expect(p.needsFrame).toBe(false);
    expect(v.needsFrame).toBe(false);

    // Move target: display stays at (10, 20) until stepped
    p.ingest([{ user: "maya", client: "m1", k: "cursor", x: 110, y: 220 }]);
    v = p.view();
    expect(v.cursors[0]).toMatchObject({ x: 10, y: 20, targetX: 110, targetY: 220 });
    expect(p.needsFrame).toBe(true);
    expect(v.needsFrame).toBe(true);
  });

  test("exponential convergence follows 1 - exp(-dt / tau) and is frame-rate independent (60 vs 120 fps)", () => {
    const a = makeModel();
    const b = makeModel();
    const init = [{ user: "maya", client: "m1", k: "cursor", x: 0, y: 0 }];
    const move = [{ user: "maya", client: "m1", k: "cursor", x: 200, y: 100 }];
    a.p.ingest(init); a.p.ingest(move);
    b.p.ingest(init); b.p.ingest(move);

    // Single step of tauMs moves exactly 1 - 1/e of the distance
    const c = makeModel();
    c.p.ingest(init); c.p.ingest(move);
    c.p.step(SMOOTH_TAU_MS);
    const expectedAlpha = 1 - Math.exp(-1);
    expect(c.p.view().cursors[0].x).toBeCloseTo(200 * expectedAlpha, 9);
    expect(c.p.view().cursors[0].y).toBeCloseTo(100 * expectedAlpha, 9);

    // 60 fps (6 * 16 ms = 96 ms) vs 120 fps (12 * 8 ms = 96 ms) produce identical positions
    for (let i = 0; i < 6; i++) a.p.step(16);
    for (let i = 0; i < 12; i++) b.p.step(8);

    const ca = a.p.view().cursors[0];
    const cb = b.p.view().cursors[0];
    const expectedTotal = 1 - Math.exp(-96 / SMOOTH_TAU_MS);
    expect(ca.x).toBeCloseTo(200 * expectedTotal, 9);
    expect(ca.y).toBeCloseTo(100 * expectedTotal, 9);
    expect(cb.x).toBeCloseTo(ca.x, 9);
    expect(cb.y).toBeCloseTo(ca.y, 9);
  });

  test("settle-to-idle: snaps within < 0.25 px and reports needsFrame === false", () => {
    const { p } = makeModel();
    p.ingest([{ user: "maya", client: "m1", k: "cursor", x: 0, y: 0 }]);
    p.ingest([{ user: "maya", client: "m1", k: "cursor", x: 100, y: 50 }]);
    expect(p.needsFrame).toBe(true);

    let frames = 0;
    while (p.needsFrame && frames < 100) {
      p.step(16);
      frames++;
    }
    expect(frames).toBeGreaterThan(5);
    expect(frames).toBeLessThan(60);
    expect(p.needsFrame).toBe(false);
    const cur = p.view().cursors[0];
    expect(cur.x).toBe(100);
    expect(cur.y).toBe(50);
    expect(p.view().needsFrame).toBe(false);
  });

  test("zoom-aware settle threshold respects screen px at higher scale", () => {
    const { p } = makeModel();
    p.ingest([{ user: "maya", client: "m1", k: "cursor", x: 0, y: 0 }]);
    // 0.1 world units is < 0.25 at scale 1, but 0.4 screen px at scale 4
    p.ingest([{ user: "maya", client: "m1", k: "cursor", x: 0.1, y: 0 }]);
    expect(p.step(0, { scale: 4 })).toBe(true);
    expect(p.needsFrame).toBe(true);
    // Stepping settles it within < 0.25 screen px
    p.step(200, { scale: 4 });
    expect(p.needsFrame).toBe(false);
    expect(p.view().cursors[0].x).toBe(0.1);
  });

  test("preview position and size interpolate smoothly and settle to idle", () => {
    const { p } = makeModel();
    const el0 = { id: "r1", type: "rectangle", x: 0, y: 0, width: 40, height: 20 };
    const el1 = { id: "r1", type: "rectangle", x: 100, y: 50, width: 140, height: 70 };
    p.setPreviews([{ el: el0, user: "maya", client: "m1", stream: "board" }]);
    expect(p.needsFrame).toBe(false);
    expect(p.view().previews[0].el).toMatchObject({ x: 0, y: 0, width: 40, height: 20 });

    p.setPreviews([{ el: el1, user: "maya", client: "m1", stream: "board" }]);
    expect(p.needsFrame).toBe(true);

    p.step(SMOOTH_TAU_MS);
    const alpha = 1 - Math.exp(-1);
    const mid = p.view().previews[0].el;
    expect(mid.x).toBeCloseTo(100 * alpha, 9);
    expect(mid.y).toBeCloseTo(50 * alpha, 9);
    expect(mid.width).toBeCloseTo(40 + 100 * alpha, 9);
    expect(mid.height).toBeCloseTo(20 + 50 * alpha, 9);

    for (let i = 0; i < 40 && p.needsFrame; i++) p.step(16);
    expect(p.needsFrame).toBe(false);
    expect(p.view().previews[0].el).toMatchObject({ x: 100, y: 50, width: 140, height: 70 });
  });

  test("laser alpha decays smoothly over LASER_FADE_MS and needsFrame becomes false on expiry", () => {
    const { c, p } = makeModel();
    p.ingest([{ user: "maya", client: "m1", k: "laser", pts: [[0, 0, 100], [50, 50, 200]] }]);
    expect(p.needsFrame).toBe(true);

    const a0 = p.view().lasers[0].pts[1].alpha;
    expect(a0).toBeCloseTo(1, 5);

    c.advance(LASER_FADE_MS / 2);
    const aMid = p.view().lasers[0].pts[1].alpha;
    expect(aMid).toBeCloseTo(0.5, 5);
    expect(aMid).toBeLessThan(a0);
    expect(p.needsFrame).toBe(true);

    c.advance(LASER_FADE_MS / 2);
    expect(p.view().lasers).toEqual([]);
    expect(p.needsFrame).toBe(false);
  });

  test("floating emote particles rise and fade over FLOAT_MS and clear needsFrame on expiry", () => {
    const { c, p } = makeModel();
    p.ingest([{ user: "maya", client: "m1", k: "emote", e: "🎉" }]);
    expect(p.needsFrame).toBe(true);

    const fStart = p.view().floaters[0];
    expect(fStart.progress).toBeCloseTo(0, 5);
    expect(fStart.yOffset).toBeCloseTo(0, 5);

    c.advance(FLOAT_MS * 0.15);
    const fPeak = p.view().floaters[0];
    expect(fPeak.alpha).toBeCloseTo(1, 5);
    expect(fPeak.yOffset).toBeLessThan(0);

    c.advance(FLOAT_MS * 0.5);
    const fLate = p.view().floaters[0];
    expect(fLate.alpha).toBeGreaterThan(0);
    expect(fLate.alpha).toBeLessThan(fPeak.alpha);
    expect(fLate.yOffset).toBeLessThan(fPeak.yOffset);
    expect(p.needsFrame).toBe(true);

    c.advance(FLOAT_MS);
    expect(p.view().floaters).toEqual([]);
    expect(p.needsFrame).toBe(false);
  });

  test("mountCollab overlay rAF loop stops completely when settled (zero idle battery drain)", () => {
    installDom();
    const clock = fakeClock();
    const port = createFakePort({ role: "editor", me: { user: "me", name: "Me", client: "me-1" } });
    const root = new FakeElement("div");
    const overlay = makeCanvas(800, 600);
    const view = { toScreen: p => ({ x: p.x, y: p.y }), toWorld: p => ({ x: p.x, y: p.y }), scale: 1 };

    let rafQueue = [];
    let rafCalls = 0;
    const frame = fn => { rafCalls++; rafQueue.push(fn); return rafCalls; };
    const flushFrame = (dtMs = 16) => {
      clock.advance(dtMs);
      const q = rafQueue; rafQueue = [];
      for (const fn of q) fn();
    };

    const collab = mountCollab({ root, canvasOverlay: overlay, port, view, clock, frame });
    // Initial mount paints once and stops (idle)
    flushFrame(16);
    expect(rafQueue.length).toBe(0);

    // Peer appears and moves cursor: rAF runs while interpolating, then stops when settled
    port.here(HERE);
    port.presence([{ user: "maya", client: "m1", k: "cursor", x: 0, y: 0 }]);
    flushFrame(16);
    expect(rafQueue.length).toBe(0); // first cursor snapped immediately

    port.presence([{ user: "maya", client: "m1", k: "cursor", x: 100, y: 0 }]);
    expect(rafQueue.length).toBe(1);

    let steps = 0;
    while (rafQueue.length > 0 && steps < 100) {
      flushFrame(16);
      steps++;
    }
    expect(steps).toBeGreaterThan(3);
    expect(steps).toBeLessThan(60);
    expect(rafQueue.length).toBe(0);
    expect(collab.presence.needsFrame).toBe(false);

    // Idle 1s ticks must not request any rAF frames while settled
    const callsWhenSettled = rafCalls;
    clock.advance(5000);
    expect(rafCalls).toBe(callsWhenSettled);
    expect(rafQueue.length).toBe(0);

    collab.destroy();
  });

  test("expired peer preview is cleared on tick while idle rAF remains 0", () => {
    installDom();
    const clock = fakeClock();
    const port = createFakePort({ role: "editor", me: { user: "me", name: "Me", client: "me-1" } });
    const root = new FakeElement("div");
    const overlay = makeCanvas(800, 600);
    const view = { toScreen: p => ({ x: p.x, y: p.y }), toWorld: p => ({ x: p.x, y: p.y }), scale: 1 };

    let livePreviews = [{ el: { id: "p1", type: "rectangle", x: 10, y: 20, width: 50, height: 30 }, user: "maya", client: "m1" }];
    port.previews = stream => (stream === "board" ? livePreviews : []);

    let rafQueue = [];
    let rafCalls = 0;
    const frame = fn => { rafCalls++; rafQueue.push(fn); return rafCalls; };
    const flushFrame = (dtMs = 16) => {
      clock.advance(dtMs);
      const q = rafQueue; rafQueue = [];
      for (const fn of q) fn();
    };

    const collab = mountCollab({ root, canvasOverlay: overlay, port, view, clock, frame });
    port.here(HERE);
    flushFrame(16);
    expect(collab.presence.view().previews.length).toBe(1);
    expect(rafQueue.length).toBe(0);

    // Idle 1s ticks while preview is stationary request 0 rAFs
    const callsBeforeIdle = rafCalls;
    clock.advance(2000);
    expect(rafCalls).toBe(callsBeforeIdle);
    expect(rafQueue.length).toBe(0);

    // Preview expires in Replica (port.previews returns []): next 1s tick schedules exactly 1 repaint to clear it
    livePreviews = [];
    clock.advance(1000);
    expect(rafCalls).toBe(callsBeforeIdle + 1);
    expect(rafQueue.length).toBe(1);
    flushFrame(16);
    expect(collab.presence.view().previews).toEqual([]);
    expect(rafQueue.length).toBe(0);

    // Subsequent idle ticks request 0 rAFs
    const callsAfterClear = rafCalls;
    clock.advance(3000);
    expect(rafCalls).toBe(callsAfterClear);

    collab.destroy();
  });

  test("prune() removes previews belonging to silent expired peers", () => {
    const { c, p } = makeModel();
    p.ingest([
      { user: "maya", client: "m1", k: "preview", stream: "board", elements: [{ id: "e1", x: 10, y: 20, width: 30, height: 40 }] },
    ]);
    expect(p.view().previews.length).toBe(1);
    c.advance(PRESENCE_SILENCE_MS);
    expect(p.prune()).toBe(true);
    expect(p.view().previews).toEqual([]);
  });

  test("SETTLE_EPSILON and SMOOTH_TAU_MS match plan targets", () => {
    expect(SMOOTH_TAU_MS).toBe(45);
    expect(SETTLE_EPSILON).toBe(0.25);
  });
});
