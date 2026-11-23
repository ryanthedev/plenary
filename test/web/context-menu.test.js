// Tests for Issue #114 (Full Canvas Right-Click Context Menu):
// Element / Multi-Selection menu, Empty Canvas menu, Move to Layer submenu,
// viewport-edge clamping, unified a11y overlay stack (Escape, Tab, arrows, outside click, hasActiveOverlay()).
import { describe, test, expect, afterAll } from "bun:test";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { syncCollabPort } from "../../web/adapters/collab/sync.js";
import { hasActiveOverlay } from "../../web/adapters/dom/a11y.js";
import { clampMenuPosition } from "../../web/adapters/dom/context-menu.js";
import { mountApp } from "../../web/adapters/dom/app.js";
import { installPage, stub, restoreGlobals } from "./stub-page.js";

afterAll(restoreGlobals);

const USERS = {
  "t-ada": { user: "ada", role: "owner" },
  "t-cy": { user: "cy", role: "annotator" },
  "t-vi": { user: "vi", role: "viewer" },
};

function setup({ token = "t-ada", collab = true } = {}) {
  const page = installPage();
  const net = localRoom({ board: "ctx-board", users: USERS, clock: true });
  const app = mountApp({
    startSession: ({ mine, onChange }) => createSession({
      join: () => net.join(),
      token,
      board: "ctx-board",
      client: USERS[token].user,
      user: USERS[token].user,
      mine,
      onChange,
      clock: net.clock,
    }),
    net: { kind: "local", put() {}, onFile() {} },
    board: "ctx-board",
    me: { user: USERS[token].user, name: "Ada", role: null },
    prefs: memoryStore(),
    theme: "light",
    clock: net.clock,
    collab: collab ? (S, o) => syncCollabPort(S, { name: "Ada", frame: fn => net.clock.set(fn, 16), ...o }) : null,
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
  return { page, net, app, S: app.S, step };
}

function drawRect(S, x, y, w = 80, h = 60) {
  S.setTool("rectangle");
  S.pointerDown({ x, y });
  S.pointerMove({ x: x + w, y: y + h });
  S.pointerUp({ x: x + w, y: y + h });
}

const find = (root, pred) => root.all().find(pred);
const findAll = (root, pred) => root.all().filter(pred);
const openMenuAt = (page, x, y) => page.board.fire("contextmenu", { clientX: x, clientY: y, button: 2 });
const activeMenu = page => find(page.doc.body, e => e.classList.contains("ctx-menu"));
const menuItem = (menu, id) => find(menu, e => e.attrs["data-ctx-id"] === id);

describe("#114 Canvas Right-Click Context Menu", () => {
  test("clampMenuPosition keeps menu inside viewport edges", () => {
    expect(clampMenuPosition({ x: 100, y: 120, width: 220, height: 300, viewportWidth: 1280, viewportHeight: 800 }))
      .toEqual({ left: 100, top: 120 });
    // Bottom-right corner clamps cleanly with 8px margin
    expect(clampMenuPosition({ x: 1260, y: 780, width: 220, height: 300, viewportWidth: 1280, viewportHeight: 800 }))
      .toEqual({ left: 1052, top: 492 });
    // Negative coordinates clamp to margin
    expect(clampMenuPosition({ x: -20, y: -10, width: 220, height: 300, viewportWidth: 1280, viewportHeight: 800 }))
      .toEqual({ left: 8, top: 8 });
  });

  test("right-clicking empty canvas opens Empty Canvas menu with all actions and overlay stack integration", () => {
    const { page, S, step } = setup({ collab: true });
    expect(hasActiveOverlay(page.doc)).toBe(false);

    const ev = openMenuAt(page, 400, 300);
    expect(ev.defaultPrevented).toBe(true);
    expect(hasActiveOverlay(page.doc)).toBe(true);

    const menu = activeMenu(page);
    expect(menu).toBeTruthy();
    expect(menu.attrs.role).toBe("menu");

    const ids = findAll(menu, e => e.attrs.role === "menuitem").map(e => e.attrs["data-ctx-id"]);
    expect(ids).toEqual(["paste", "select-all", "sticky-note", "comment", "zoom-fit", "zoom-reset"]);

    // Clicking "Add Sticky Note here" creates a note and closes the menu
    menuItem(menu, "sticky-note").click();
    step(2);
    expect(activeMenu(page)).toBeUndefined();
    expect(hasActiveOverlay(page.doc)).toBe(false);
    expect(S.eds.notes.doc.live().length).toBeGreaterThan(0);

    // Reset Zoom (100%)
    S.zoomAt(2);
    expect(S.eds.board.view.scale).toBe(2);
    openMenuAt(page, 50, 50);
    menuItem(activeMenu(page), "zoom-reset").click();
    step(2);
    expect(S.eds.board.view.scale).toBe(1);
  });

  test("right-clicking an element shows Element menu: Duplicate, Lock/Unlock, Arrangement, Delete", () => {
    const { page, S, step } = setup({ collab: true });
    drawRect(S, 100, 100, 100, 80);
    step(2);
    const elId = [...S.eds.board.doc.live()][0].id;
    S.eds.board.select([]);

    // Right-clicking on the unselected shape's border selects it and opens Element menu
    { const r = S.eds.board.doc.live()[0]; const p = S.eds.board.toScreen({ x: r.x, y: r.y + 20 }); openMenuAt(page, p.x, p.y); }
    expect(S.eds.board.sel.has(elId)).toBe(true);

    const menu = activeMenu(page);
    const ids = findAll(menu, e => e.attrs.role === "menuitem").map(e => e.attrs["data-ctx-id"]);
    expect(ids).toEqual([
      "cut", "copy", "paste", "duplicate", "delete",
      "bring-front", "bring-forward", "send-backward", "send-back",
      "lock", "copy-link", "comment",
    ]);

    // Lock toggles element.locked
    expect(menuItem(menu, "lock").textContent).toContain("Lock");
    menuItem(menu, "lock").click();
    step(2);
    expect(S.eds.board.doc.get(elId).locked).toBe(true);

    // Re-open shows Unlock
    { const r = S.eds.board.doc.live()[0]; const p = S.eds.board.toScreen({ x: r.x, y: r.y + 20 }); openMenuAt(page, p.x, p.y); }
    expect(menuItem(activeMenu(page), "lock").textContent).toContain("Unlock");
    menuItem(activeMenu(page), "lock").click();
    step(2);
    expect(S.eds.board.doc.get(elId).locked).toBe(false);

    // Duplicate creates a second shape
    { const r = S.eds.board.doc.live()[0]; const p = S.eds.board.toScreen({ x: r.x, y: r.y + 20 }); openMenuAt(page, p.x, p.y); }
    menuItem(activeMenu(page), "duplicate").click();
    step(2);
    expect(S.eds.board.doc.live().length).toBe(2);

    // Delete removes the selected duplicate
    const dup = S.eds.board.selected()[0];
    const sp = S.eds.board.toScreen({ x: dup.x, y: dup.y + 20 });
    openMenuAt(page, sp.x, sp.y);
    menuItem(activeMenu(page), "delete").click();
    step(2);
    expect(S.eds.board.doc.live().length).toBe(1);
  });

  test("multi-selection shows Group, then Ungroup after grouping; multi-layer shows Move to Layer submenu", () => {
    const { page, S, step } = setup({ collab: false });
    drawRect(S, 100, 100, 80, 60);
    drawRect(S, 240, 100, 80, 60);
    S.act("board", e => e.addLayer("Foreground"), { settings: true });
    step(2);

    const els = S.eds.board.doc.live();
    expect(els.length).toBe(2);
    S.eds.board.select(els.map(e => e.id));

    // Right-click on first selected shape preserves multi-selection
    openMenuAt(page, 130, 120);
    let menu = activeMenu(page);
    expect(menuItem(menu, "group")).toBeTruthy();
    expect(menuItem(menu, "ungroup")).toBeUndefined();
    expect(menuItem(menu, "move-to-layer")).toBeTruthy();

    // Group them
    menuItem(menu, "group").click();
    step(2);
    expect(S.eds.board.doc.get(els[0].id).groupIds.length).toBe(1);

    // Re-open shows Ungroup
    openMenuAt(page, 130, 120);
    menu = activeMenu(page);
    expect(menuItem(menu, "ungroup")).toBeTruthy();

    // Open Move to Layer submenu and move to Foreground layer
    const fgLayer = S.eds.board.doc.layers.find(l => l.name === "Foreground");
    expect(fgLayer).toBeTruthy();
    menuItem(menu, "move-to-layer").click();
    const fgItem = menuItem(menu, `layer:${fgLayer.id}`);
    expect(fgItem).toBeTruthy();
    fgItem.click();
    step(2);
    expect(S.eds.board.doc.get(els[0].id).customData?.layer).toBe(fgLayer.id);

    // Ungroup works
    openMenuAt(page, 130, 120);
    menuItem(activeMenu(page), "ungroup").click();
    step(2);
    expect(S.eds.board.doc.get(els[0].id).groupIds.length).toBe(0);
  });

  test("keyboard navigation (ArrowDown, ArrowUp, Home, End, Escape) and outside click close the menu", () => {
    const { page } = setup({ collab: true });
    openMenuAt(page, 200, 200);
    const menu = activeMenu(page);
    const items = findAll(menu, e => e.attrs.role === "menuitem" && !e.disabled);
    expect(page.doc.activeElement).toBe(items[0]);

    menu.fire("keydown", { key: "ArrowDown" });
    expect(page.doc.activeElement).toBe(items[1]);

    menu.fire("keydown", { key: "End" });
    expect(page.doc.activeElement).toBe(items.at(-1));

    menu.fire("keydown", { key: "Home" });
    expect(page.doc.activeElement).toBe(items[0]);

    menu.fire("keydown", { key: "ArrowUp" });
    expect(page.doc.activeElement).toBe(items.at(-1));

    // Escape closes via unified a11y overlay stack and restores focus to canvas
    page.doc.fire("keydown", { key: "Escape" });
    expect(activeMenu(page)).toBeUndefined();
    expect(hasActiveOverlay(page.doc)).toBe(false);
    expect(page.doc.activeElement).toBe(page.board);

    // Outside click dismisses menu
    openMenuAt(page, 200, 200);
    expect(activeMenu(page)).toBeTruthy();
    page.doc.fire("pointerdown", { target: page.byId.panel });
    expect(activeMenu(page)).toBeUndefined();
    expect(hasActiveOverlay(page.doc)).toBe(false);
  });

  test("viewer role disables write actions in context menu", () => {
    const { page } = setup({ token: "t-vi", collab: true });
    openMenuAt(page, 200, 200);
    const menu = activeMenu(page);
    expect(menuItem(menu, "paste").disabled).toBe(true);
    expect(menuItem(menu, "select-all").disabled).toBe(true);
    expect(menuItem(menu, "sticky-note")).toBeUndefined();
    expect(menuItem(menu, "zoom-fit").disabled).toBe(false);
    expect(menuItem(menu, "zoom-reset").disabled).toBe(false);
  });

  test("annotator right-clicking presenter shape disables write actions and never deletes own notes; header menu closes immediately", () => {
    const { page, net, S, step } = setup({ token: "t-cy", collab: true });
    // Presenter draws a board shape and a note
    const ada = createSession({ join: () => net.join(), token: "t-ada", board: "ctx-board", client: "ada", user: "ada", clock: net.clock });
    ada.setSize(1200, 800);
    step(3);
    drawRect(ada, 100, 100, 100, 80);
    ada.placeNote({ x: 350, y: 150 }, "ada note");
    step(3);

    // Annotator places and selects their own note
    S.placeNote({ x: 500, y: 300 }, "my note");
    step(2);
    const notesBefore = S.eds.notes.doc.live().length;
    expect(notesBefore).toBeGreaterThanOrEqual(2);

    // Open header Board menu first, then right-click presenter's shape: header menu must close immediately
    const more = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "More");
    more.click();
    expect(more.attrs["aria-expanded"]).toBe("true");

    { const r = S.eds.board.doc.live()[0]; const p = S.eds.board.toScreen({ x: r.x, y: r.y + 20 }); openMenuAt(page, p.x, p.y); }
    expect(more.attrs["aria-expanded"]).toBe("false");
    const headerMenu = find(page.byId.topbar, e => e.classList.contains("header-more-menu"));
    expect(headerMenu.hidden).toBe(true);

    // Write actions on presenter's board shape must be disabled for annotator
    const menu = activeMenu(page);
    expect(menuItem(menu, "cut").disabled).toBe(true);
    expect(menuItem(menu, "delete").disabled).toBe(true);
    expect(menuItem(menu, "duplicate").disabled).toBe(true);
    expect(menuItem(menu, "lock").disabled).toBe(true);
    expect(menuItem(menu, "bring-front").disabled).toBe(true);
    expect(S.eds.notes.doc.live().length).toBe(notesBefore);

    // Right-clicking another user's note does not select it and disables write actions
    const adaNote = S.eds.notes.doc.live().find(e => !S.isMine(e.id));
    expect(adaNote).toBeTruthy();
    const sp = S.eds.board.toScreen({ x: adaNote.x + 10, y: adaNote.y + 10 });
    openMenuAt(page, sp.x, sp.y);
    expect(S.eds.notes.sel.has(adaNote.id)).toBe(false);
    expect(menuItem(activeMenu(page), "delete").disabled).toBe(true);
  });

  test("#117 right-clicking a single writable image shows Splice 2×1 and Splice 2×2 and splices into tiles", () => {
    const prevImage = globalThis.Image;
    globalThis.Image = /** @type {any} */ (class { set src(_) {} });
    try {
      const { page, S, step } = setup({ collab: false });
      const file = {
        id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,iVBORw0KGgo=",
        width: 400,
        height: 200,
      };
      let imgId;
      S.act("board", ed => { imgId = ed.addImage(file, { x: 200, y: 200 }); });
      step(2);
      const img = S.eds.board.doc.get(imgId);
      expect(img).toBeTruthy();

      const p = S.eds.board.toScreen({ x: img.x + img.width / 2, y: img.y + img.height / 2 });
      openMenuAt(page, p.x, p.y);
      const menu = activeMenu(page);
      expect(menuItem(menu, "splice-2x1")).toBeTruthy();
      expect(menuItem(menu, "splice-2x2")).toBeTruthy();

      // Splice 2x2 replaces the image with 4 cropped tiles sharing the same fileId
      menuItem(menu, "splice-2x2").click();
      step(2);
      const tiles = S.eds.board.doc.live().filter(e => e.type === "image");
      expect(tiles.length).toBe(4);
      expect(tiles.every(t => t.fileId === file.id && t.crop)).toBe(true);

      // Undo restores original single image, then test Splice 2x1
      S.act("board", ed => ed.undo());
      step(2);
      expect(S.eds.board.doc.live().filter(e => e.type === "image").length).toBe(1);
      const restored = S.eds.board.doc.live().find(e => e.type === "image");
      const p2 = S.eds.board.toScreen({ x: restored.x + restored.width / 2, y: restored.y + restored.height / 2 });
      openMenuAt(page, p2.x, p2.y);
      menuItem(activeMenu(page), "splice-2x1").click();
      step(2);
      expect(S.eds.board.doc.live().filter(e => e.type === "image").length).toBe(2);
    } finally {
      globalThis.Image = prevImage;
    }
  });
});
