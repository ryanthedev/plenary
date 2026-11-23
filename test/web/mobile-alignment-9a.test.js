// Wave 9A — Mobile Selection Action Sheet, Long-Press, Frame/View Stepper & Mobile Rename Sheet
import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { syncCollabPort } from "../../web/adapters/collab/sync.js";
import { mountApp } from "../../web/adapters/dom/app.js";
import { hasActiveOverlay } from "../../web/adapters/dom/a11y.js";
import { createLongPressTracker, buildMobileSelectionActions, LONG_PRESS_MS, LONG_PRESS_TOLERANCE_PX } from "../../web/adapters/dom/mobile-sheets.js";
import { makeElement, BASE_LAYER } from "../../packages/core/model.js";
import { addView } from "../../packages/core/views.js";
import { installPage, stub, fireWin, restoreGlobals } from "./stub-page.js";

afterAll(restoreGlobals);

const USERS = {
  "t-ada": { user: "ada", role: "owner" },
  "t-cy": { user: "cy", role: "annotator" },
  "t-vi": { user: "vi", role: "viewer" },
};

function makeStubClock() {
  let now = 1000, nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    mono: () => now,
    random: () => 0.5,
    set(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + Math.max(0, ms) });
      return id;
    },
    clear(id) { timers.delete(id); },
    advance(ms) {
      const target = now + ms;
      while (true) {
        let soonest = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (!soonest || t.at < soonest.at)) soonest = { id, ...t };
        }
        if (!soonest) break;
        now = soonest.at;
        timers.delete(soonest.id);
        soonest.fn();
      }
      now = target;
    },
  };
}

function makeHistory() {
  const stack = [null];
  let idx = 0;
  return {
    get state() { return stack[idx]; },
    pushState(state) {
      stack.splice(idx + 1);
      stack.push(state);
      idx = stack.length - 1;
    },
    replaceState(state) {
      stack[idx] = state;
    },
    back() {
      if (idx > 0) idx--;
    },
    depth: () => idx,
    stack: () => [...stack],
  };
}

function setupPhone({
  board = "b-z7r15i5cc4rk28d9",
  token = "t-ada",
  boardTitle = "Sprint Board",
  renameBoard = null,
  collab = false,
  versions = null,
  narrow = true,
  history = makeHistory(),
  clipboard = null,
} = {}) {
  const page = installPage();
  page.media.set("(max-width: 1023px)", { matches: true, listeners: [] });
  page.media.set("(max-width: 640px)", { matches: narrow, listeners: [] });
  page.media.set("(pointer: coarse)", { matches: true, listeners: [] });
  globalThis.history = history;
  globalThis.location = /** @type {any} */ ({ origin: "https://plenary.test", pathname: "/", search: `?board=${board}`, hash: "" });
  if (clipboard) globalThis.navigator = /** @type {any} */ ({ clipboard });

  const net = localRoom({ board, users: USERS, clock: true });
  const app = mountApp({
    startSession: ({ mine, onChange }) => createSession({
      join: () => net.join(),
      token,
      board,
      client: USERS[token].user,
      user: USERS[token].user,
      mine,
      onChange,
      clock: net.clock,
    }),
    net: { kind: "ws", put() {}, onFile() {} },
    board,
    boardTitle,
    renameBoard,
    versions,
    me: { user: USERS[token].user, name: USERS[token].user, role: null },
    prefs: memoryStore(),
    theme: "light",
    clock: net.clock,
    collab: collab ? (S, o) => syncCollabPort(S, { name: "Ada", frame: fn => net.clock.set(fn, 16), ...o }) : null,
  });

  const step = (n = 1, dt = 300) => {
    for (let i = 0; i < n; i++) {
      while (net.step());
      net.advance(dt);
      while (net.step());
      const q = stub.frames;
      stub.frames = [];
      for (const fn of q) fn();
    }
  };
  step(3);
  return { page, net, app, S: app.S, step, history };
}

const find = (root, pred) => root.all().find(pred);
const findAll = (root, pred) => root.all().filter(pred);
const flush = () => new Promise(r => setTimeout(r, 0));

describe("createLongPressTracker (450ms, < 8px movement, pinch/up/cancel)", () => {
  test("fires after 450ms for single-finger touch within 8px tolerance", () => {
    const clock = makeStubClock();
    const fired = [];
    const lp = createLongPressTracker({ clock, onLongPress: info => fired.push(info) });

    lp.onPointerDown({ pointerType: "touch", pointerId: 1, button: 0, isPrimary: true }, { x: 100, y: 100 });
    expect(lp.isArmed()).toBe(true);

    // Move 7px (< 8px): stays armed
    lp.onPointerMove({ pointerType: "touch", pointerId: 1 }, { x: 105, y: 104 });
    expect(lp.isArmed()).toBe(true);

    clock.advance(LONG_PRESS_MS - 1);
    expect(fired.length).toBe(0);

    clock.advance(1);
    expect(fired.length).toBe(1);
    expect(fired[0]).toEqual({ point: { x: 100, y: 100 }, pointerId: 1 });
    expect(lp.isArmed()).toBe(false);
  });

  test("cancels immediately on movement >= 8px", () => {
    const clock = makeStubClock();
    const fired = [];
    const lp = createLongPressTracker({ clock, onLongPress: info => fired.push(info) });

    lp.onPointerDown({ pointerType: "touch", pointerId: 1, button: 0 }, { x: 50, y: 50 });
    lp.onPointerMove({ pointerType: "touch", pointerId: 1 }, { x: 50 + LONG_PRESS_TOLERANCE_PX, y: 50 });
    expect(lp.isArmed()).toBe(false);

    clock.advance(600);
    expect(fired.length).toBe(0);
  });

  test("cancels immediately on multi-touch pinch, pointerup, or pointercancel", () => {
    const clock = makeStubClock();
    const fired = [];
    const lp = createLongPressTracker({ clock, onLongPress: info => fired.push(info) });

    // Multi-touch pinch
    lp.onPointerDown({ pointerType: "touch", pointerId: 1, button: 0 }, { x: 40, y: 40 });
    lp.onPointerDown({ pointerType: "touch", pointerId: 2, button: 0 }, { x: 120, y: 40 });
    expect(lp.isArmed()).toBe(false);
    clock.advance(600);
    expect(fired.length).toBe(0);
    lp.onPointerUp({ pointerType: "touch", pointerId: 1 });
    lp.onPointerUp({ pointerType: "touch", pointerId: 2 });

    // Early pointerup
    lp.onPointerDown({ pointerType: "touch", pointerId: 3, button: 0 }, { x: 40, y: 40 });
    clock.advance(200);
    lp.onPointerUp({ pointerType: "touch", pointerId: 3 });
    expect(lp.isArmed()).toBe(false);
    clock.advance(400);
    expect(fired.length).toBe(0);

    // pointercancel
    lp.onPointerDown({ pointerType: "touch", pointerId: 4, button: 0 }, { x: 40, y: 40 });
    lp.onPointerCancel({ pointerType: "touch", pointerId: 4 });
    expect(lp.isArmed()).toBe(false);
    clock.advance(600);
    expect(fired.length).toBe(0);

    // Ignores mouse
    lp.onPointerDown({ pointerType: "mouse", pointerId: 5, button: 0 }, { x: 40, y: 40 });
    expect(lp.isArmed()).toBe(false);
  });
});

describe("buildMobileSelectionActions (context-aware & role-gated)", () => {
  const noop = () => {};
  const actions = {
    duplicate: noop, del: noop, copyLink: noop, group: noop, ungroup: noop,
    reorder: noop, toggleLock: noop, tidy: noop, spliceImage: noop, addComment: noop,
  };

  test("multi-selection of unlocked shapes includes Group and Tidy; grouped includes Ungroup", () => {
    const items = buildMobileSelectionActions({
      canWrite: true,
      canComment: true,
      selected: [
        { id: "a", type: "rectangle", locked: false, groupIds: [] },
        { id: "b", type: "ellipse", locked: false, groupIds: ["g1"] },
      ],
      actions,
    });
    const ids = items.map(i => i.id);
    expect(ids).toEqual(["duplicate", "delete", "group", "ungroup", "tidy", "bring-front", "send-back", "lock", "copy-link", "comment"]);
  });

  test("single unlocked image includes Splice 2x1 and Splice 2x2; locked image omits them and shows Unlock", () => {
    const unlocked = buildMobileSelectionActions({
      canWrite: true,
      canComment: false,
      selected: [{ id: "img1", type: "image", locked: false }],
      actions,
    });
    expect(unlocked.map(i => i.id)).toContain("splice-2x1");
    expect(unlocked.map(i => i.id)).toContain("splice-2x2");
    expect(unlocked.find(i => i.id === "lock")?.label).toBe("Lock");

    const locked = buildMobileSelectionActions({
      canWrite: true,
      canComment: false,
      selected: [{ id: "img1", type: "image", locked: true }],
      actions,
    });
    expect(locked.map(i => i.id)).not.toContain("splice-2x1");
    expect(locked.map(i => i.id)).not.toContain("splice-2x2");
    expect(locked.find(i => i.id === "lock")?.label).toBe("Unlock");
  });

  test("viewer (canWrite: false) only sees Copy link and Add Comment (if permitted)", () => {
    const withComment = buildMobileSelectionActions({
      canWrite: false,
      canComment: true,
      selected: [{ id: "f1", type: "frame", locked: false }],
      actions,
    });
    expect(withComment.map(i => i.id)).toEqual(["copy-link", "comment"]);
    expect(withComment[0].label).toBe("Copy link to frame");

    const noComment = buildMobileSelectionActions({
      canWrite: false,
      canComment: false,
      selected: [{ id: "r1", type: "rectangle", locked: false }],
      actions,
    });
    expect(noComment.map(i => i.id)).toEqual(["copy-link"]);
  });
});

describe("Wave 9A Mounted Phone Integration", () => {
  test("tapping .phone-sel-pill opens Selection Action Sheet wired to a11y stack + history + actions", async () => {
    const copied = [];
    const { page, app, S, step, history } = setupPhone({
      collab: true,
      clipboard: { writeText: async t => { copied.push(t); } },
    });

    // Add 2 rectangles and select both
    S.act("board", ed => {
      ed.transact(tx => {
        tx.add(makeElement("rectangle", { id: "r1", x: 10, y: 10, width: 80, height: 60 }));
        tx.add(makeElement("rectangle", { id: "r2", x: 200, y: 40, width: 80, height: 60 }));
        return true;
      });
      ed.select(["r1", "r2"]);
    });
    step(2);

    const pill = find(page.byId.hudBL, e => e.classList.contains("phone-sel-pill"));
    expect(pill).toBeTruthy();
    const moreBtn = find(pill, e => e.getAttribute("data-action") === "actions");
    expect(moreBtn).toBeTruthy();

    moreBtn.click();
    step(2);

    expect(app.ui.sheet).toBe("actions");
    expect(page.byId.sheet.hidden).toBe(false);
    expect(page.byId.sheet.getAttribute("role")).toBe("dialog");
    expect(hasActiveOverlay(page.doc)).toBe(true);
    expect(history.state).toEqual({ plenarySheet: "actions" });

    const actionIds = findAll(page.byId.sheet, e => e.hasAttribute("data-sheet-action")).map(e => e.getAttribute("data-sheet-action"));
    expect(actionIds).toContain("duplicate");
    expect(actionIds).toContain("delete");
    expect(actionIds).toContain("group");
    expect(actionIds).toContain("tidy");
    expect(actionIds).toContain("bring-front");
    expect(actionIds).toContain("send-back");
    expect(actionIds).toContain("lock");
    expect(actionIds).toContain("copy-link");
    expect(actionIds).toContain("comment");

    // Trigger Copy link
    find(page.byId.sheet, e => e.getAttribute("data-sheet-action") === "copy-link").click();
    await flush();
    step(2);
    expect(app.ui.sheet).toBeNull();
    expect(copied.length).toBe(1);
    expect(copied[0]).toContain("#el=");

    // Re-open via pill and dismiss via iOS back-swipe popstate
    find(page.byId.hudBL, e => e.getAttribute("data-action") === "actions").click();
    step(2);
    expect(app.ui.sheet).toBe("actions");
    fireWin("popstate");
    step(2);
    expect(app.ui.sheet).toBeNull();
    expect(page.byId.sheet.hidden).toBe(true);
    expect(hasActiveOverlay(page.doc)).toBe(false);
  });

  test("450ms single-finger long-press on canvas element opens Selection Action Sheet (and respects viewer role gating)", () => {
    const { page, app, S, net, step } = setupPhone({ token: "t-vi", collab: true });
    // Owner Ada adds a filled rectangle on the board; viewer receives it via room sync
    const ada = createSession({
      join: () => net.join(), token: "t-ada", board: "b-z7r15i5cc4rk28d9",
      client: "ada-seed", user: "ada", mine: [], onChange() {}, clock: net.clock,
    });
    step(2);
    ada.act("board", ed => {
      ed.transact(tx => {
        tx.add(makeElement("rectangle", { id: "box1", x: 100, y: 100, width: 120, height: 80, backgroundColor: "#ffffff" }));
        return true;
      });
    });
    step(3);

    const screenPt = S.eds.board.toScreen({ x: 160, y: 140 });
    const canvas = page.byId.board;
    canvas.fire("pointerdown", { pointerType: "touch", pointerId: 11, button: 0, isPrimary: true, clientX: screenPt.x, clientY: screenPt.y });
    net.advance(460);
    step(2);

    expect(app.ui.sheet).toBe("actions");
    const actionIds = findAll(page.byId.sheet, e => e.hasAttribute("data-sheet-action")).map(e => e.getAttribute("data-sheet-action"));
    // Viewer only sees Copy link & Add Comment — never write actions
    expect(actionIds).toEqual(["copy-link", "comment"]);
  });

  test("annotator long-pressing own note sees write actions; other's note sees only Copy link", () => {
    const { page, app, S, net, step } = setupPhone({ token: "t-cy", collab: false });
    // Owner Ada adds a note on the notes stream; Cy receives it as someone else's note
    const ada = createSession({
      join: () => net.join(), token: "t-ada", board: "b-z7r15i5cc4rk28d9",
      client: "ada-seed", user: "ada", mine: [], onChange() {}, clock: net.clock,
    });
    step(2);
    ada.act("notes", ed => {
      ed.transact(tx => {
        tx.add(makeElement("rectangle", { id: "other-note", x: 240, y: 40, width: 100, height: 80, backgroundColor: "#fff3bf" }));
        return true;
      });
    });
    // Create Cy's own note via S.act so it's tracked in S.mine
    S.act("notes", ed => {
      ed.transact(tx => {
        tx.add(makeElement("rectangle", { id: "my-note", x: 40, y: 40, width: 100, height: 80, backgroundColor: "#fff3bf" }));
        return true;
      });
    });
    step(3);

    const canvas = page.byId.board;
    const pOther = S.eds.board.toScreen({ x: 290, y: 80 });
    canvas.fire("pointerdown", { pointerType: "touch", pointerId: 21, button: 0, isPrimary: true, clientX: pOther.x, clientY: pOther.y });
    net.advance(460);
    step(2);
    expect(app.ui.sheet).toBe("actions");
    expect(findAll(page.byId.sheet, e => e.hasAttribute("data-sheet-action")).map(e => e.getAttribute("data-sheet-action"))).toEqual(["copy-link"]);

    // Dismiss and long-press own note
    canvas.fire("pointerup", { pointerType: "touch", pointerId: 21, clientX: pOther.x, clientY: pOther.y });
    find(page.doc.body, e => e.classList.contains("sheet-backdrop")).click();
    step(2);

    const pMine = S.eds.board.toScreen({ x: 90, y: 80 });
    canvas.fire("pointerdown", { pointerType: "touch", pointerId: 22, button: 0, isPrimary: true, clientX: pMine.x, clientY: pMine.y });
    net.advance(460);
    step(2);
    expect(app.ui.sheet).toBe("actions");
    const mineActions = findAll(page.byId.sheet, e => e.hasAttribute("data-sheet-action")).map(e => e.getAttribute("data-sheet-action"));
    expect(mineActions).toContain("duplicate");
    expect(mineActions).toContain("delete");
    expect(mineActions).toContain("copy-link");
  });

  test("Mobile Frame / View Stepper pill renders on phone when frames exist, steps frames, opens Views picker, and shows Show all reset", () => {
    const { page, S, step } = setupPhone();

    // No frames/views initially -> no stepper pill
    expect(find(page.byId.hudBL, e => e.classList.contains("phone-stepper-pill"))).toBeFalsy();

    // Add 2 named frames
    S.act("board", ed => {
      ed.transact(tx => {
        tx.add(makeElement("frame", { id: "f1", name: "Overview", x: 0, y: 0, width: 300, height: 200 }));
        tx.add(makeElement("frame", { id: "f2", name: "Auth Flow", x: 400, y: 0, width: 300, height: 200 }));
        return true;
      });
    });
    step(2);

    const stepper = find(page.byId.hudBL, e => e.classList.contains("phone-stepper-pill"));
    expect(stepper).toBeTruthy();

    // Step next -> 1 / 2 · Overview, then 2 / 2 · Auth Flow
    find(stepper, e => e.getAttribute("data-stepper") === "next").click();
    step(2);
    expect(find(page.byId.hudBL, e => e.classList.contains("phone-stepper-label")).textContent).toBe("1 / 2 · Overview");

    find(page.byId.hudBL, e => e.getAttribute("data-stepper") === "next").click();
    step(2);
    expect(find(page.byId.hudBL, e => e.classList.contains("phone-stepper-label")).textContent).toBe("2 / 2 · Auth Flow");

    // Tapping center label opens Views/Frames picker
    find(page.byId.hudBL, e => e.classList.contains("phone-stepper-label")).click();
    step(2);
    expect(find(page.doc.body, e => e.classList.contains("views-modal"))).toBeTruthy();

    // Close views modal via Escape
    page.doc.fire("keydown", { key: "Escape" });
    step(2);
    expect(find(page.doc.body, e => e.classList.contains("views-modal"))).toBeFalsy();

    // Activate a saved view filter -> "Show all" reset button appears right beside stepper
    S.act("board", ed => {
      const apiLayer = ed.addLayer("API");
      ed.setAppState({ views: addView(ed.doc, { id: "v1", name: "Backend View", visibleLayers: [apiLayer.id], frameId: "f2" }) });
    }, { settings: true });
    step(2);
    // Open views picker and click the saved view
    find(page.byId.hudBL, e => e.classList.contains("phone-stepper-label")).click();
    step(2);
    const viewBtn = find(page.doc.body, e => e.classList.contains("views-row-btn") && e.textContent.includes("Backend View"));
    expect(viewBtn).toBeTruthy();
    viewBtn.click();
    step(2);

    const showAllBtn = find(page.byId.hudBL, e => e.classList.contains("phone-show-all"));
    expect(showAllBtn).toBeTruthy();
    expect(showAllBtn.textContent).toBe("Show all");
    expect(find(page.byId.hudBL, e => e.classList.contains("phone-stepper-label")).textContent).toBe("1 / 1 · Backend View");

    // 1-tap reset clears the local filter
    showAllBtn.click();
    step(2);
    expect(find(page.byId.hudBL, e => e.classList.contains("phone-show-all"))).toBeFalsy();
  });

  test("narrow viewport (<= 640px) tapping board title opens Mobile Rename Board sheet with 16px input instead of inline input", async () => {
    const renamed = [];
    const { page, app, step } = setupPhone({
      boardTitle: "Old Board",
      narrow: true,
      renameBoard: async title => {
        renamed.push(title);
        return { board: { id: "b-z7r15i5cc4rk28d9", title } };
      },
    });

    const titleBtn = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.classList.contains("board-name"));
    expect(titleBtn).toBeTruthy();
    titleBtn.click();
    step(2);

    // Must NOT open cramped inline topbar input
    expect(find(page.byId.topbar, e => e.tagName === "INPUT")).toBeFalsy();
    // Must open bottom Rename board sheet
    expect(app.ui.sheet).toBe("rename");
    expect(page.byId.sheet.hidden).toBe(false);
    expect(page.byId.sheet.getAttribute("aria-label")).toBe("Rename board");

    const input = find(page.byId.sheet, e => e.tagName === "INPUT" && e.classList.contains("mobile-rename-input"));
    expect(input).toBeTruthy();
    expect(input.value).toBe("Old Board");
    expect(input.style.fontSize).toBe("16px");
    expect(page.doc.activeElement).toBe(input);

    // Save button commits rename and closes sheet
    input.value = "New Mobile Name";
    find(page.byId.sheet, e => e.getAttribute("data-action") === "rename-save").click();
    step(2);
    await flush();
    step(2);

    expect(renamed).toEqual(["New Mobile Name"]);
    expect(app.ui.sheet).toBeNull();
    expect(page.doc.title).toBe("New Mobile Name — Plenary");
    expect(find(page.byId.topbar, e => e.classList.contains("board-name")).textContent).toBe("New Mobile Name");
  });

  test("Selection Action Sheet refreshes live state when a remote peer locks or deletes the target element", () => {
    const { page, app, S, net, step } = setupPhone();
    const peer = createSession({
      join: () => net.join(), token: "t-ada", board: "b-z7r15i5cc4rk28d9",
      client: "ada-peer", user: "ada", mine: [], onChange() {}, clock: net.clock,
    });
    step(2);
    S.act("board", ed => {
      ed.transact(tx => {
        tx.add(makeElement("rectangle", { id: "live1", x: 10, y: 10, width: 80, height: 60, backgroundColor: "#ffffff" }));
        return true;
      });
      ed.select(["live1"]);
    });
    step(3);

    find(page.byId.hudBL, e => e.getAttribute("data-action") === "actions").click();
    step(2);
    expect(app.ui.sheet).toBe("actions");
    expect(find(page.byId.sheet, e => e.getAttribute("data-sheet-action") === "lock").getAttribute("aria-label")).toBe("Lock");

    // Remote peer locks live1 -> sheet rebuilds from live doc and flips Lock -> Unlock
    peer.act("board", ed => {
      ed.select(["live1"]);
      ed.toggleLock();
    });
    step(3);
    expect(find(page.byId.sheet, e => e.getAttribute("data-sheet-action") === "lock").getAttribute("aria-label")).toBe("Unlock");

    // Remote peer deletes live1 -> sheet closes cleanly
    peer.act("board", ed => {
      ed.deleteIds(["live1"]);
    });
    step(3);
    expect(app.ui.sheet).toBeNull();
    expect(page.byId.sheet.hidden).toBe(true);
  });

  test("switching from Tools sheet to Rename sheet focuses the rename input", () => {
    const { page, app, step } = setupPhone({
      boardTitle: "Focus Check",
      narrow: true,
      renameBoard: async t => ({ board: { id: "b-z7r15i5cc4rk28d9", title: t } }),
    });
    find(page.byId.dock, e => e.hasAttribute("data-dock-more")).click();
    step(2);
    expect(app.ui.sheet).toBe("tools");

    find(page.byId.sheet, e => e.getAttribute("aria-label") === "Rename board").click();
    step(2);
    expect(app.ui.sheet).toBe("rename");
    const input = find(page.byId.sheet, e => e.classList.contains("mobile-rename-input"));
    expect(input).toBeTruthy();
    expect(page.doc.activeElement).toBe(input);
  });

  test("Mobile Tools sheet exposes Embed / URL, Version history, Import, Theme, Grid, and Rename board", () => {
    const versionsPort = {
      list: async () => [],
      get: async () => null,
      create: async () => ({ id: "v1" }),
      remove: async () => ({ ok: true }),
    };
    const { page, step } = setupPhone({
      versions: versionsPort,
      renameBoard: async t => ({ board: { id: "b-z7r15i5cc4rk28d9", title: t } }),
    });

    const moreBtn = find(page.byId.dock, e => e.hasAttribute("data-dock-more"));
    moreBtn.click();
    step(2);

    const btns = findAll(page.byId.sheet, e => e.tagName === "BUTTON");
    const labels = btns.map(b => b.getAttribute("aria-label") || b.textContent.trim());
    expect(labels).toContain("Embed URL");
    expect(labels).toContain("Version history");
    expect(labels).toContain("Import .excalidraw");
    expect(labels).toContain("Toggle color theme");
    expect(labels).toContain("Toggle grid");
    expect(labels).toContain("Rename board");
  });

  test("style.css presents views, versions, and settings dialogs as full-width bottom sheets on <= 640px", () => {
    const css = readFileSync(join(import.meta.dir, "../../web/style.css"), "utf8");
    const media640 = css.slice(css.indexOf("@media (max-width: 640px)"));
    expect(media640).toContain(".views-dialog");
    expect(media640).toContain(".versions-dialog");
    expect(media640).toContain(".settings-dialog");
    expect(media640).toContain("100dvh");
    expect(media640).toContain("env(safe-area-inset-bottom)");
    expect(media640).toContain("max(16px, 1rem)");
    expect(css).toContain(".sheet-action-row");
    expect(css).toContain(".phone-stepper-pill");
    expect(css).toContain(".mobile-rename-input");
  });
});
