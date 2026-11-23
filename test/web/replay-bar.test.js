import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { installPage, restoreGlobals, E } from "./stub-page.js";
import { Doc } from "../../packages/core/doc.js";
import { makeElement, emptyScene, clone } from "../../packages/core/model.js";
import { createReplaySession } from "../../packages/core/replay.js";
import {
  mountReplayBar,
  REPLAY_BANNER_TEXT,
  REPLAY_SPEEDS,
} from "../../web/adapters/dom/replay-bar.js";

function sampleEntries() {
  const r1 = makeElement("rectangle", { id: "r1", x: 10, y: 10, version: 1, versionNonce: 1 });
  const r2 = makeElement("rectangle", { id: "r2", x: 100, y: 20, version: 1, versionNonce: 2 });
  const r1Moved = { ...clone(r1), x: 250, version: 2, versionNonce: 3 };
  return [
    { seq: 1, ts: Date.UTC(2026, 0, 15, 10, 0, 1), user: "Alice", op: { elements: [r1] } },
    { seq: 2, ts: Date.UTC(2026, 0, 15, 10, 0, 5), user: "Bob", op: { elements: [r2] } },
    { seq: 3, ts: Date.UTC(2026, 0, 15, 10, 0, 9), user: "Alice", op: { elements: [r1Moved] } },
  ];
}

function findByClass(root, cls) {
  return root.all().find(el => el.classList?.contains(cls)) ?? null;
}

describe("web/adapters/dom/replay-bar.js", () => {
  let page;

  beforeEach(() => {
    page = installPage();
  });

  afterEach(() => {
    restoreGlobals();
  });

  test("renders read-only banner, controls, speed selector, scrubber, readout, and Exit button", () => {
    const host = new E("div");
    const session = createReplaySession(sampleEntries());
    const states = [];

    const bar = mountReplayBar({
      host,
      session,
      onState: s => states.push(s),
      onExit: () => {},
    });

    const banner = findByClass(bar.el, "replay-banner");
    const playBtn = findByClass(bar.el, "replay-play");
    const prevBtn = findByClass(bar.el, "replay-prev");
    const nextBtn = findByClass(bar.el, "replay-next");
    const speedSel = findByClass(bar.el, "replay-speed");
    const scrubber = findByClass(bar.el, "replay-scrubber");
    const timeEl = findByClass(bar.el, "replay-time");
    const authorEl = findByClass(bar.el, "replay-author");
    const exitBtn = findByClass(bar.el, "replay-exit");

    expect(banner?.textContent).toBe(REPLAY_BANNER_TEXT);
    expect(banner?.textContent).toBe("History Replay (read-only — live board unaffected)");
    expect(playBtn?.textContent).toBe("Play");
    expect(prevBtn?.disabled).toBe(false);
    expect(nextBtn?.disabled).toBe(true); // mounted at endSeq
    expect(speedSel?.children.map(o => o.textContent)).toEqual(REPLAY_SPEEDS.map(s => `${s}x`));
    expect(scrubber?.getAttribute("type")).toBe("range");
    expect(scrubber?.value).toBe("2");
    expect(timeEl?.textContent).toBe("10:00:09 UTC");
    expect(authorEl?.textContent).toBe("Alice");
    expect(exitBtn?.textContent).toBe("Exit Replay");
    expect(states.length).toBe(1);
    expect(states[0].seq).toBe(3);

    bar.destroy();
  });

  test("Prev/Next buttons and range scrubber step through history and update readout", () => {
    const host = new E("div");
    const session = createReplaySession(sampleEntries());
    const states = [];

    const bar = mountReplayBar({
      host,
      session,
      initialSeq: 1,
      onState: s => states.push(s),
      onExit: () => {},
    });

    const prevBtn = findByClass(bar.el, "replay-prev");
    const nextBtn = findByClass(bar.el, "replay-next");
    const scrubber = findByClass(bar.el, "replay-scrubber");
    const authorEl = findByClass(bar.el, "replay-author");
    const timeEl = findByClass(bar.el, "replay-time");

    expect(prevBtn.disabled).toBe(true);
    expect(nextBtn.disabled).toBe(false);
    expect(bar.getState().seq).toBe(1);

    // Click Next -> seq 2 (Bob)
    nextBtn.click();
    expect(bar.getState().seq).toBe(2);
    expect(authorEl.textContent).toBe("Bob");
    expect(timeEl.textContent).toBe("10:00:05 UTC");
    expect(prevBtn.disabled).toBe(false);
    expect(nextBtn.disabled).toBe(false);

    // Click Next -> seq 3 (Alice, end)
    nextBtn.click();
    expect(bar.getState().seq).toBe(3);
    expect(nextBtn.disabled).toBe(true);

    // Click Prev -> seq 2
    prevBtn.click();
    expect(bar.getState().seq).toBe(2);

    // Scrub slider directly to index 0 -> seq 1
    scrubber.value = "0";
    scrubber.fire("input");
    expect(bar.getState().seq).toBe(1);
    expect(authorEl.textContent).toBe("Alice");
    expect(prevBtn.disabled).toBe(true);
    expect(states.map(s => s.seq)).toEqual([1, 2, 3, 2, 1]);

    bar.destroy();
  });

  test("Play/Pause steps through ops at selected speed and auto-pauses at end", () => {
    const host = new E("div");
    const session = createReplaySession(sampleEntries());
    const scheduled = [];
    let cleared = 0;

    const bar = mountReplayBar({
      host,
      session,
      initialSeq: 1,
      baseIntervalMs: 400,
      setTimer: (fn, ms) => {
        const id = scheduled.length + 1;
        scheduled.push({ id, fn, ms, active: true });
        return id;
      },
      clearTimer: id => {
        cleared++;
        const entry = scheduled.find(t => t.id === id);
        if (entry) entry.active = false;
      },
    });

    const playBtn = findByClass(bar.el, "replay-play");
    const speedSel = findByClass(bar.el, "replay-speed");

    // Start playing at 1x -> 400ms
    playBtn.click();
    expect(bar.isPlaying()).toBe(true);
    expect(playBtn.textContent).toBe("Pause");
    expect(scheduled[0].ms).toBe(400);

    // Switch speed to 2x while playing -> reschedules at 200ms
    speedSel.value = "2";
    speedSel.fire("change");
    expect(bar.getSpeed()).toBe(2);
    expect(scheduled[1].ms).toBe(200);
    expect(cleared).toBeGreaterThanOrEqual(1);

    // Tick 1 -> seq 2
    scheduled[1].fn();
    expect(bar.getState().seq).toBe(2);
    expect(bar.isPlaying()).toBe(true);

    // Tick 2 -> seq 3 (end) -> auto-pauses
    scheduled[1].fn();
    expect(bar.getState().seq).toBe(3);
    expect(bar.isPlaying()).toBe(false);
    expect(playBtn.textContent).toBe("Play");

    // Clicking Play at endSeq restarts from startSeq (seq 1)
    playBtn.click();
    expect(bar.isPlaying()).toBe(true);
    expect(bar.getState().seq).toBe(1);

    // Clicking Pause stops playback
    playBtn.click();
    expect(bar.isPlaying()).toBe(false);

    bar.destroy();
  });

  test("Exit Replay button and Escape key clean up and invoke onExit once", () => {
    const host = new E("div");
    const session = createReplaySession(sampleEntries());
    let exitCount = 0;

    const bar1 = mountReplayBar({
      host,
      session,
      onExit: () => { exitCount++; },
    });
    expect(host.children.length).toBe(1);

    const exitBtn = findByClass(bar1.el, "replay-exit");
    exitBtn.click();
    expect(exitCount).toBe(1);
    expect(host.children.length).toBe(0);

    // Escape key also exits
    let escExits = 0;
    const bar2 = mountReplayBar({
      host,
      session,
      onExit: () => { escExits++; },
    });
    expect(host.children.length).toBe(1);

    page.doc.fire("keydown", { key: "Escape" });
    expect(escExits).toBe(1);
    expect(host.children.length).toBe(0);

    // Second Escape after exit does nothing
    page.doc.fire("keydown", { key: "Escape" });
    expect(escExits).toBe(1);
    bar2.destroy();
  });

  test("scrubbing never mutates live Doc and handles empty history safely", () => {
    const liveDoc = new Doc(emptyScene());
    liveDoc.apply({ elements: [makeElement("rectangle", { id: "live-1", x: 50, version: 1, versionNonce: 1 })] });
    const revBefore = liveDoc.rev;
    const sceneBefore = clone(liveDoc.toScene());

    const host = new E("div");
    const session = createReplaySession(sampleEntries(), { baseSnapshot: liveDoc });
    const bar = mountReplayBar({ host, session, initialSeq: 1 });

    bar.step(1);
    bar.step(1);
    bar.seekToSeq(1);
    expect(liveDoc.rev).toBe(revBefore);
    expect(liveDoc.toScene()).toEqual(sceneBefore);
    bar.destroy();

    // Empty session
    const emptyBar = mountReplayBar({ host, session: createReplaySession([]) });
    expect(findByClass(emptyBar.el, "replay-play").disabled).toBe(true);
    expect(findByClass(emptyBar.el, "replay-prev").disabled).toBe(true);
    expect(findByClass(emptyBar.el, "replay-next").disabled).toBe(true);
    expect(findByClass(emptyBar.el, "replay-scrubber").disabled).toBe(true);
    emptyBar.destroy();
  });
});
