// Wave 13B: 3-Mode Canvas HUD (Draw · Animate · Present) + Multi-Swimlane Movie Timeline Scrubber integration tests.
import { describe, test, expect, afterAll } from "bun:test";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { mountApp } from "../../web/adapters/dom/app.js";
import { installPage as install, stub, restoreGlobals } from "./stub-page.js";

let page;
const installPage = () => (page = install());
afterAll(restoreGlobals);

const USERS = {
  "t-ada": { user: "ada", role: "owner" },
  "t-cy": { user: "cy", role: "annotator" },
  "t-vi": { user: "vi", role: "viewer" },
};

function setup({ token = "t-ada", narrowPhone = false } = {}) {
  installPage();
  if (narrowPhone) {
    const m640 = page.media.get("(max-width: 640px)") ?? { matches: false, listeners: [] };
    m640.matches = true;
    page.media.set("(max-width: 640px)", m640);
    const m1023 = page.media.get("(max-width: 1023px)") ?? { matches: false, listeners: [] };
    m1023.matches = true;
    page.media.set("(max-width: 1023px)", m1023);
  }
  const net = localRoom({ board: "b-hud", users: USERS, clock: true });
  const app = mountApp({
    startSession: ({ mine, onChange }) =>
      createSession({
        join: () => net.join(),
        token,
        board: "b-hud",
        client: USERS[token].user,
        user: USERS[token].user,
        mine,
        onChange,
        clock: net.clock,
      }),
    net: { kind: "local", put() {}, onFile() {} },
    board: "b-hud",
    me: { user: USERS[token].user, name: "Ada", role: null },
    prefs: memoryStore(),
    theme: "light",
    clock: net.clock,
  });
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      while (net.step());
      net.advance(16);
      while (net.step());
      const q = stub.frames;
      stub.frames = [];
      for (const fn of q) fn();
    }
  };
  step(3);
  return { net, app, S: app.S, step };
}

const find = (root, pred) => root.all().find(pred);
const findAll = (root, pred) => root.all().filter(pred);

function drawRect(s, x, y) {
  s.setTool("rectangle");
  s.pointerDown({ x, y });
  s.pointerMove({ x: x + 80, y: y + 50 });
  s.pointerUp({ x: x + 80, y: y + 50 });
}

function drawFrame(s, x, y) {
  s.setTool("frame");
  s.pointerDown({ x, y });
  s.pointerMove({ x: x + 200, y: y + 140 });
  s.pointerUp({ x: x + 200, y: y + 140 });
  s.setTool("select");
}

describe("Wave 13B: 3-Mode Canvas HUD (Draw · Animate · Present)", () => {
  test("presenter sees 3-mode switcher; viewers and annotators do not", () => {
    const p = setup({ token: "t-ada" });
    const switcher = find(page.byId.topbar, e => e.attrs?.role === "tablist" && e.attrs?.["data-workspace-mode"] === "draw");
    expect(switcher).toBeDefined();
    expect(findAll(switcher, e => e.attrs?.role === "tab").map(e => e.attrs?.["data-mode"])).toEqual(["draw", "animate", "present"]);
    expect(p.app.ui.workspaceMode).toBe("draw");

    // Viewer: no 3-mode switcher
    setup({ token: "t-vi" });
    expect(find(page.byId.topbar, e => e.attrs?.["data-workspace-mode"])).toBeUndefined();

    // Annotator: no 3-mode switcher
    setup({ token: "t-cy" });
    expect(find(page.byId.topbar, e => e.attrs?.["data-workspace-mode"])).toBeUndefined();
  });

  test("Draw mode keeps Inspector clean (no 4 mystery header icons, no giant Animate section) and hides timeline until animated", () => {
    const { S, step } = setup();
    expect(find(page.byId.panel, e => e.classList?.contains?.("panel-head"))).toBeUndefined();
    expect(find(page.byId.panel, e => e.attrs?.["data-sec"] === "animate")).toBeUndefined();
    expect(find(page.byId.topbar, e => e.classList?.contains?.("tool-rail"))).toBeDefined();
    expect(page.byId.timeline.hidden).toBe(true);

    // Once a shape is animated, Draw mode shows ONLY the sleek collapsed playback bar
    drawRect(S, 100, 100);
    step(2);
    S.act("board", e => e.animate("fade"));
    step(20);
    expect(page.byId.timeline.hidden).toBe(false);
    expect(page.byId.timeline.attrs["data-expanded"]).toBe("false");
    expect(find(page.byId.timeline, e => e.attrs?.["data-nle"] === "1")).toBeUndefined();
  });

  test("Animate mode hides drawing tool rail/dock, opens expanded multi-swimlane NLE drawer, and supports phone compact fallback", () => {
    const { S, app, step } = setup();
    drawRect(S, 100, 100);
    step(2);
    S.act("board", e => e.animate("fade"));
    step(10);

    const animTab = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs?.["data-mode"] === "animate");
    animTab.click();
    step(20);

    expect(app.ui.workspaceMode).toBe("animate");
    expect(page.doc.body.attrs["data-workspace-mode"]).toBe("animate");
    expect(find(page.byId.topbar, e => e.classList?.contains?.("tool-rail"))).toBeUndefined();
    expect(page.byId.dock.hidden).toBe(true);
    expect(page.byId.timeline.hidden).toBe(false);
    expect(page.byId.timeline.attrs["data-expanded"]).toBe("true");
    expect(find(page.byId.timeline, e => e.attrs?.["data-nle"] === "1")).toBeDefined();
    expect(findAll(page.byId.timeline, e => e.classList?.contains?.("tl-lane-row")).length).toBe(1);
    expect(find(page.byId.panel, e => e.attrs?.["data-sec"] === "animate")).toBeDefined();

    // Phone (< 640px): compact mode trigger opens popover, Animate stays playback/step-only (no authoring buttons)
    const mobile = setup({ narrowPhone: true });
    drawRect(mobile.S, 60, 60);
    mobile.step(2);
    mobile.S.act("board", e => e.animate("fade"));
    mobile.step(10);
    const modeTrigger = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs?.["data-mode-trigger"] === "1");
    expect(modeTrigger).toBeDefined();
    expect(modeTrigger.attrs["aria-expanded"]).toBe("false");
    modeTrigger.click();
    expect(modeTrigger.attrs["aria-expanded"]).toBe("true");
    find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs?.["data-mode"] === "animate").click();
    mobile.step(20);
    expect(mobile.app.ui.workspaceMode).toBe("animate");
    expect(page.byId.timeline.hidden).toBe(false);
    expect(page.byId.timeline.attrs["data-expanded"]).toBe("false");
    expect(find(page.byId.timeline, e => e.attrs?.["data-nle"] === "1")).toBeUndefined();
    expect(find(page.byId.timeline, e => e.classList?.contains?.("tl-authoring"))).toBeUndefined();
    expect(find(page.byId.timeline, e => e.attrs?.["data-action"] === "add-animate")).toBeUndefined();
    expect(find(page.byId.timeline, e => e.attrs?.["data-action"] === "add-cue")).toBeUndefined();
    expect(find(page.byId.timeline, e => e.attrs?.["data-action"] === "cascade")).toBeUndefined();
    expect(find(page.byId.timeline, e => e.attrs?.["data-action"] === "align")).toBeUndefined();
    // Present mode on narrow phone has single-row compact Next label & all controls
    find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs?.["data-mode"] === "present").click();
    mobile.step(20);
    const mobileBar = find(page.byId.hudBC, e => e.attrs?.["data-presenter-bar"] === "1");
    expect(mobileBar).toBeDefined();
    expect(find(mobileBar, e => e.classList?.contains?.("present-lab-short"))?.textContent).toBe("Next");
  });

  test("Present mode hides dock/panel/timeline, shows Presenter Bar with Next Cue / Laser / Lock Audience / Views, and Escape exits back to Draw", () => {
    const { S, app, step } = setup();
    drawFrame(S, 50, 50);
    drawRect(S, 80, 80);
    step(2);
    S.act("board", e => e.animate("fade"));
    S.act("board", e => e.addCueAt(300, "Step 1"), { settings: true });
    step(20);

    // Switch to Present mode
    find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs?.["data-mode"] === "present").click();
    step(20);

    expect(app.ui.workspaceMode).toBe("present");
    expect(page.byId.panel.hidden).toBe(true);
    expect(page.byId.drawer.hidden).toBe(true);
    expect(page.byId.timeline.hidden).toBe(true);
    expect(page.byId.dock.hidden).toBe(true);
    expect(find(page.byId.topbar, e => e.classList?.contains?.("tool-rail"))).toBeUndefined();

    const bar = find(page.byId.hudBC, e => e.attrs?.["data-presenter-bar"] === "1");
    expect(bar).toBeDefined();

    // Next Cue calls board.playToNextCue()
    const nextBtn = find(bar, e => e.attrs?.["data-present-action"] === "next");
    nextBtn.click();
    step(2);
    expect(S.eds.board.play?.stopAt).toBe(300);

    // Laser toggle
    const laserBtn = find(page.byId.hudBC, e => e.attrs?.["data-present-action"] === "laser");
    laserBtn.click();
    step(20);
    expect(S.tool).toBe("laser");

    // Lock Audience toggle
    const lockBtn = find(page.byId.hudBC, e => e.attrs?.["data-present-action"] === "lock-audience");
    lockBtn.click();
    step(20);
    expect(S.eds.board.doc.appState?.herdr?.moderation?.locked).toBe(true);

    // Escape exits Present mode back to Draw when no modal is open
    page.doc.fire("keydown", { key: "Escape" });
    step(20);
    expect(app.ui.workspaceMode).toBe("draw");
    expect(page.byId.panel.hidden).toBe(false);
    expect(find(page.byId.topbar, e => e.classList?.contains?.("tool-rail"))).toBeDefined();
    expect(find(page.byId.hudBC, e => e.attrs?.["data-presenter-bar"] === "1")).toBeUndefined();
  });

  test("mid-session role downgrade from presenter resets workspaceMode and document attribute back to draw", () => {
    const prev = USERS["t-ada"].role;
    try {
      const { S, app, net, step } = setup({ token: "t-ada" });
      find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs?.["data-mode"] === "present").click();
      step(20);
      expect(app.ui.workspaceMode).toBe("present");
      expect(page.doc.body.attrs["data-workspace-mode"]).toBe("present");

      // Downgrade role to viewer and reconnect
      USERS["t-ada"].role = "viewer";
      S.reconnect();
      step(30);
      net.advance(1000);
      step(30);
      expect(S.effective).toBe("viewer");
      expect(app.ui.workspaceMode).toBe("draw");
      expect(page.doc.body.attrs["data-workspace-mode"]).toBe("draw");
      expect(find(page.byId.hudBC, e => e.attrs?.["data-presenter-bar"] === "1")).toBeUndefined();
    } finally {
      USERS["t-ada"].role = prev;
    }
  });
});
