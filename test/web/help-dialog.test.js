// @ts-check
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { saveSettings } from "../../web/core/settings.js";
import { hasActiveOverlay } from "../../web/adapters/dom/a11y.js";
import { icon } from "../../web/adapters/dom/icons.js";
import {
  createHelpDialog,
  openHelpDialog,
  closeHelpDialog,
  toggleHelpDialog,
  isHelpDialogOpen,
} from "../../web/adapters/dom/help-dialog.js";
import { mountApp } from "../../web/adapters/dom/app.js";
import { mountHome } from "../../web/adapters/dom/home.js";
import { createHomeModel } from "../../web/core/home.js";
import { virtualClock } from "../../web/adapters/clock/virtual.js";
import { installPage, stub, restoreGlobals } from "./stub-page.js";
import { FakeElement, installDom, textOf } from "./collab/fake-dom.js";

const ROOT = join(import.meta.dir, "..", "..");

afterEach(() => {
  restoreGlobals();
});

function installFakeDomEnv({ withBody = true } = {}) {
  const dom = installDom();
  const docListeners = new Map();
  const doc = /** @type {any} */ (globalThis.document);
  doc.activeElement = null;
  if (withBody) {
    doc.body = new FakeElement("body");
    doc.body.isConnected = true;
  }
  doc.addEventListener = (type, fn) => {
    if (!docListeners.has(type)) docListeners.set(type, []);
    docListeners.get(type).push(fn);
  };
  doc.removeEventListener = (type, fn) => {
    const arr = docListeners.get(type);
    if (!arr) return;
    docListeners.set(type, arr.filter(f => f !== fn));
  };
  doc.fire = (type, ev = {}) => {
    const e = {
      target: doc.activeElement ?? doc.body ?? dom.root,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...ev,
    };
    for (const fn of [...(docListeners.get(type) ?? [])]) fn(e);
    return e;
  };
  globalThis.Node = Object.getPrototypeOf(FakeElement);
  // Make FakeElement.focus() update document.activeElement
  const origFocus = FakeElement.prototype.focus;
  FakeElement.prototype.focus = function () {
    doc.activeElement = this;
    return origFocus.call(this);
  };
  return { dom, doc, restoreFocusHook: () => { FakeElement.prototype.focus = origFocus; } };
}

function setupBoard({ token = "t-ada", phone = false, seedSettings = null } = {}) {
  const page = installPage();
  if (phone) {
    for (const q of ["(max-width: 640px)", "(max-width: 1023px)"]) {
      page.media.set(q, { matches: true, listeners: [] });
    }
  }
  const prefs = memoryStore();
  if (seedSettings) saveSettings(prefs, seedSettings);
  const USERS = {
    "t-ada": { user: "ada", role: "owner" },
    "t-vi": { user: "vi", role: "viewer" },
  };
  const net = localRoom({ board: "b-help", users: USERS, clock: true });
  const app = mountApp({
    startSession: ({ mine, onChange }) => createSession({
      join: () => net.join(),
      token,
      board: "b-help",
      client: USERS[token].user,
      user: USERS[token].user,
      mine,
      onChange,
      clock: net.clock,
    }),
    net: { kind: "local", put() {}, onFile() {} },
    board: "b-help",
    me: { user: USERS[token].user, name: USERS[token].user, role: null },
    prefs,
    theme: "light",
    clock: net.clock,
  });
  const step = (n = 2) => {
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
  return { page, app, S: app.S, step };
}

const find = (root, pred) => root.all().find(pred);
const findAll = (root, pred) => root.all().filter(pred);

describe("help icon & help-dialog unit behavior", () => {
  test("icons.js provides a crisp 24x24 help SVG icon", () => {
    const { doc, restoreFocusHook } = installFakeDomEnv();
    try {
      const svg = icon("help", { size: 20 });
      expect(svg.getAttribute("data-icon")).toBe("help");
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg.getAttribute("width")).toBe("20");
      expect(svg.getAttribute("height")).toBe("20");
      expect(svg.children.length).toBe(3);
    } finally {
      restoreFocusHook();
      delete globalThis.document;
      delete globalThis.Node;
    }
  });

  test("openHelpDialog mounts accessible modal, renders all 5 sections, supports category filter, and restores focus", () => {
    const { doc, restoreFocusHook } = installFakeDomEnv({ withBody: true });
    try {
      const opener = doc.createElement("button");
      opener.isConnected = true;
      doc.body.append(opener);
      opener.focus();

      const dialog = openHelpDialog({ opener, doc });
      expect(dialog).toBeTruthy();
      expect(isHelpDialogOpen(doc)).toBe(true);
      expect(hasActiveOverlay(doc)).toBe(true);

      expect(dialog.getAttribute("role")).toBe("dialog");
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(dialog.getAttribute("aria-labelledby")).toBe("help-dialog-title");
      expect(dialog.getAttribute("data-mobile-sheet")).toBe("1");
      expect(dialog.getAttribute("tabindex")).toBe("-1");

      const closeBtn = dialog.find(e => e.getAttribute("aria-label") === "Close help");
      const doneBtn = dialog.find(e => e.getAttribute("aria-label") === "Done");
      expect(closeBtn).toBeTruthy();
      expect(doneBtn).toBeTruthy();
      expect(doc.activeElement).toBe(closeBtn);

      const txt = textOf(dialog);
      // 1. Drawing tools & inserts
      for (const word of ["Drawing tools", "Select", "Hand", "Rectangle", "Diamond", "Ellipse", "Arrow", "Line", "Pen", "Text", "Eraser", "Frame", "Laser", "Sticky note", "Highlighter", "Photo & Video", "Mermaid", "Swimlane", "Table", "Embed URL", "Shape Library", ".excalidraw", ".drawio", ".excalidrawlib"]) {
        expect(txt).toContain(word);
      }
      // 2. Keyboard shortcuts
      for (const word of ["Keyboard shortcuts", "Home search (Home page)", "Jump to frame / view", "Undo", "Redo", "⌘C", "⌘X", "⌘V", "⌘D", "Space", "⇧Space"]) {
        expect(txt).toContain(word);
      }
      // 3. Touch & trackpad gestures
      for (const word of ["Touch & trackpad gestures", "Pinch zoom & pan", "Two-finger scroll pan", "Two-finger tap", "Three-finger tap", "Long-press", "Apple Pencil", "300ms", "Swipe-down bottom sheet"]) {
        expect(txt).toContain(word);
      }
      // 4. Layers, frames & views (Local Solo Layer must NOT show <kbd>S</kbd>, since S cycles stroke style)
      for (const word of ["Layers, frames & views", "Shared Layers", "Local Solo Layer", "Layers · S btn", "Frames as pages", "Saved Views", "Draw · Animate · Present"]) {
        expect(txt).toContain(word);
      }
      const soloRow = dialog.find(e => e.hasClass("help-row") && textOf(e).includes("Local Solo Layer"));
      expect(soloRow).toBeTruthy();
      expect(soloRow.findAll(e => e.tagName === "KBD").some(k => textOf(k).trim() === "S")).toBe(false);
      // 5. Roles
      for (const word of ["Roles", "Owner", "Editor", "Annotator", "Commenter", "Viewer", "Presenter UI", "Annotator UI", "Viewer canvas UI"]) {
        expect(txt).toContain(word);
      }

      // Filter nav narrows down to a single section, preserves DOM node & keyboard focus, then switches back to All
      const allNav = dialog.find(e => e.getAttribute("data-help-nav") === "all");
      const rolesNav = dialog.find(e => e.getAttribute("data-help-nav") === "roles");
      rolesNav.focus();
      expect(doc.activeElement).toBe(rolesNav);
      rolesNav.click();
      expect(dialog.findAll(e => e.hasClass("help-section")).length).toBe(1);
      expect(dialog.find(e => e.getAttribute("data-help-section") === "roles")).toBeTruthy();
      expect(dialog.find(e => e.getAttribute("data-help-nav") === "roles")).toBe(rolesNav);
      expect(rolesNav.parentNode).toBeTruthy();
      expect(doc.activeElement).toBe(rolesNav);
      expect(doc.activeElement.getAttribute("data-help-nav")).toBe("roles");
      expect(rolesNav.hasClass("on")).toBe(true);
      expect(rolesNav.getAttribute("aria-pressed")).toBe("true");
      expect(allNav.hasClass("on")).toBe(false);
      expect(allNav.getAttribute("aria-pressed")).toBe("false");

      allNav.focus();
      allNav.click();
      expect(dialog.findAll(e => e.hasClass("help-section")).length).toBe(5);
      expect(doc.activeElement).toBe(allNav);
      expect(allNav.hasClass("on")).toBe(true);
      expect(allNav.getAttribute("aria-pressed")).toBe("true");
      expect(rolesNav.hasClass("on")).toBe(false);
      expect(rolesNav.getAttribute("aria-pressed")).toBe("false");

      // Escape closes and restores focus to opener
      doc.fire("keydown", { key: "Escape" });
      expect(isHelpDialogOpen(doc)).toBe(false);
      expect(hasActiveOverlay(doc)).toBe(false);
      expect(doc.activeElement).toBe(opener);

      // Toggle opens and closes via backdrop click
      toggleHelpDialog({ opener, doc });
      expect(isHelpDialogOpen(doc)).toBe(true);
      const veil = doc.body.find(e => e.hasClass("help-veil"));
      veil.dispatch("click", { target: veil, currentTarget: veil });
      expect(isHelpDialogOpen(doc)).toBe(false);
      expect(doc.activeElement).toBe(opener);

      // Done button also closes & restores focus
      openHelpDialog({ opener, doc });
      dialog.parentNode && expect(isHelpDialogOpen(doc)).toBe(true);
      doc.body.find(e => e.getAttribute("data-action") === "done-help").click();
      expect(isHelpDialogOpen(doc)).toBe(false);
      expect(doc.activeElement).toBe(opener);
    } finally {
      restoreFocusHook();
      delete globalThis.document;
      delete globalThis.Node;
    }
  });

  test("reads live effectiveKeybinds(userSettings) including custom combos, Unbound, and frameBinds", () => {
    const { doc, restoreFocusHook } = installFakeDomEnv({ withBody: true });
    try {
      const dialog = openHelpDialog({
        doc,
        userSettings: {
          keybinds: {
            "tool.rectangle": "Mod+B",
            "tool.laser": "",
            "action.views": "Mod+K",
          },
          frameBinds: {
            "Alt+1": "frame:intro-1",
          },
        },
      });
      const txt = textOf(dialog);
      expect(txt).toContain("⌘B");
      expect(txt).toContain("Unbound");
      expect(txt).toContain("⌘K");
      expect(txt).toContain("frame:intro-1");
      expect(txt).toContain("⌥1");
      closeHelpDialog({ doc, restoreFocus: false });
    } finally {
      restoreFocusHook();
      delete globalThis.document;
      delete globalThis.Node;
    }
  });

  test("per-document WeakMap tracks separate documents and prunes detached modals", () => {
    const { doc: doc1, restoreFocusHook } = installFakeDomEnv({ withBody: true });
    try {
      const doc2 = /** @type {any} */ ({
        body: new FakeElement("body"),
        activeElement: null,
        createElement: doc1.createElement,
        createTextNode: doc1.createTextNode,
        addEventListener() {},
        removeEventListener() {},
      });
      doc2.body.isConnected = true;

      const d1 = openHelpDialog({ doc: doc1 });
      expect(isHelpDialogOpen(doc1)).toBe(true);
      expect(isHelpDialogOpen(doc2)).toBe(false);

      // Detach d1's veil externally without calling closeHelpDialog
      const veil1 = d1.parentNode;
      veil1.isConnected = false;
      veil1.remove();
      expect(isHelpDialogOpen(doc1)).toBe(false);
      expect(hasActiveOverlay(doc1)).toBe(false);

      // Disconnected opener should not receive focus on close
      const staleOpener = doc1.createElement("button");
      let focusedCount = 0;
      staleOpener.focus = () => { focusedCount++; };
      staleOpener.isConnected = false;
      openHelpDialog({ doc: doc1, opener: staleOpener });
      closeHelpDialog({ doc: doc1, restoreFocus: true });
      expect(focusedCount).toBe(0);
    } finally {
      restoreFocusHook();
      delete globalThis.document;
      delete globalThis.Node;
    }
  });
});

describe("Board triggers & guards (web/adapters/dom/app.js)", () => {
  test("? opens and toggles Help modal closed without hasOpenDialog deadlock and restores focus", () => {
    const { page, step } = setupBoard({
      seedSettings: { keybinds: { "action.views": "Mod+K", "tool.laser": "" } },
    });
    const canvas = page.board;
    canvas.focus();

    page.doc.fire("keydown", { key: "?", shiftKey: true, target: canvas });
    expect(isHelpDialogOpen(page.doc)).toBe(true);
    expect(hasActiveOverlay(page.doc)).toBe(true);

    const dialog = find(page.doc.body, e => e.classList.contains("help-modal"));
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain("⌘K");
    expect(dialog.textContent).toContain("Unbound");

    // Second ? toggles closed (even though hasOpenDialog() and inDialog(activeElement) are true)
    page.doc.fire("keydown", { key: "?", shiftKey: true, target: page.doc.activeElement });
    expect(isHelpDialogOpen(page.doc)).toBe(false);
    expect(page.doc.activeElement).toBe(canvas);
    step(1);
  });

  test("? does NOT trigger inside inputs, textareas, selects, contentEditable, or when another dialog is open", () => {
    const { page, app, step } = setupBoard();

    for (const tag of ["input", "textarea", "select"]) {
      const el = page.doc.createElement(tag);
      page.doc.body.append(el);
      page.doc.fire("keydown", { key: "?", shiftKey: true, target: el });
      expect(isHelpDialogOpen(page.doc)).toBe(false);
      el.remove();
    }

    const ce = page.doc.createElement("div");
    ce.setAttribute("contenteditable", "true");
    const ceChild = page.doc.createElement("span");
    ce.append(ceChild);
    page.doc.body.append(ce);
    page.doc.fire("keydown", { key: "?", shiftKey: true, target: ceChild });
    expect(isHelpDialogOpen(page.doc)).toBe(false);
    ce.remove();

    // Another dialog open (e.g. Export)
    app.openDialog("export");
    step(1);
    page.doc.fire("keydown", { key: "?", shiftKey: true, target: page.board });
    expect(isHelpDialogOpen(page.doc)).toBe(false);
  });

  test("Escape closes Help modal in Present mode without exiting Present mode", () => {
    const { page, app, step } = setupBoard();
    const presentBtn = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.getAttribute("data-mode") === "present");
    expect(presentBtn).toBeTruthy();
    presentBtn.click();
    step(1);
    expect(app.ui.workspaceMode).toBe("present");

    page.doc.fire("keydown", { key: "?", shiftKey: true, target: page.board });
    expect(isHelpDialogOpen(page.doc)).toBe(true);

    // First Escape closes Help only
    page.doc.fire("keydown", { key: "Escape", target: page.doc.activeElement });
    expect(isHelpDialogOpen(page.doc)).toBe(false);
    expect(app.ui.workspaceMode).toBe("present");

    // Second Escape exits Present mode
    page.doc.fire("keydown", { key: "Escape", target: page.board });
    expect(app.ui.workspaceMode).toBe("draw");
  });

  test("Board View menu and mobile Tools sheet both open Help modal (including for Viewers)", () => {
    // Desktop menu (Viewer role)
    const desktop = setupBoard({ token: "t-vi" });
    const more = find(desktop.page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "More");
    more.click();
    const helpItem = find(desktop.page.byId.topbar, e => e.attrs.role === "menuitem" && e.attrs["aria-label"] === "Help & shortcuts");
    expect(helpItem).toBeTruthy();
    helpItem.click();
    expect(isHelpDialogOpen(desktop.page.doc)).toBe(true);
    closeHelpDialog({ doc: desktop.page.doc, restoreFocus: false });

    // Mobile Tools sheet
    const mobile = setupBoard({ phone: true });
    const dockMore = find(mobile.page.byId.dock, e => e.hasAttribute("data-dock-more"));
    dockMore.click();
    mobile.step(2);
    const sheetHelp = find(mobile.page.byId.sheet, e => e.tagName === "BUTTON" && e.getAttribute("aria-label") === "Help & shortcuts");
    expect(sheetHelp).toBeTruthy();
    sheetHelp.click();
    expect(mobile.app.ui.sheet).toBeNull();
    expect(isHelpDialogOpen(mobile.page.doc)).toBe(true);
    closeHelpDialog({ doc: mobile.page.doc, restoreFocus: false });
  });
});

describe("Home triggers & guards (web/adapters/dom/home.js)", () => {
  async function setupHome() {
    const { dom, doc, restoreFocusHook } = installFakeDomEnv({ withBody: true });
    const clock = virtualClock({ t0: 1_000_000 });
    const data = {
      guest: false,
      user: { user: "dev:ada", name: "Ada" },
      unit: { id: "u1", kind: "org", name: "Acme" },
      limits: {},
      recent: [],
      starred: [],
      owned: [],
      shared: [],
      tree: { groups: [], spaces: [], more: false },
    };
    const api = {
      load: async () => ({ home: structuredClone(data) }),
      search: async q => ({ q, results: [], more: false }),
      star: async () => ({ ok: true }),
    };
    const model = createHomeModel({ api, clock });
    const dialogs = { newBoard: () => null, newSpace: () => null, newGroup: () => null };
    const mounted = mountHome({
      root: dom.root,
      model,
      clock,
      dialogs,
      boardHref: id => `?board=${id}`,
      spaceHref: id => `?space=${id}`,
      groupHref: id => `?group=${id}`,
      onLogout: () => {},
    });
    await model.load();
    return { dom, doc, mounted, restoreFocusHook };
  }

  test("Home header Help button sits beside theme toggle before who, opens Help, toggles via ?, respects typing guards, and cleans up on destroy", async () => {
    const { dom, doc, mounted, restoreFocusHook } = await setupHome();
    try {
      const top = dom.root.find(e => e.hasClass("home-top"));
      const helpBtn = top.find(e => e.getAttribute("data-action") === "open-help");
      const themeBtn = top.find(e => e.getAttribute("data-action") === "toggle-theme");
      const who = top.find(e => e.hasClass("home-who"));
      const logoutBtn = top.find(e => e.getAttribute("data-action") === "logout");

      expect(helpBtn).toBeTruthy();
      expect(helpBtn.getAttribute("aria-label")).toBe("Help & shortcuts");
      expect(top.childNodes.indexOf(helpBtn)).toBeLessThan(top.childNodes.indexOf(who));
      expect(top.childNodes.indexOf(themeBtn)).toBeLessThan(top.childNodes.indexOf(who));
      expect(top.childNodes.indexOf(logoutBtn)).toBe(top.childNodes.indexOf(who) + 1);

      // Click Help button -> opens modal & focuses Close help, Escape restores focus to helpBtn
      helpBtn.click();
      expect(isHelpDialogOpen(doc)).toBe(true);
      doc.fire("keydown", { key: "Escape" });
      expect(isHelpDialogOpen(doc)).toBe(false);
      expect(doc.activeElement).toBe(helpBtn);

      // ? does NOT fire while typing in search input or contentEditable
      const search = dom.root.find(e => e.hasClass("home-search"));
      doc.fire("keydown", { key: "?", shiftKey: true, target: search });
      expect(isHelpDialogOpen(doc)).toBe(false);

      const ce = doc.createElement("div");
      ce.setAttribute("contenteditable", "true");
      doc.fire("keydown", { key: "?", shiftKey: true, target: ce });
      expect(isHelpDialogOpen(doc)).toBe(false);

      // ? opens and second ? toggles closed
      doc.fire("keydown", { key: "?", shiftKey: true, target: doc.body });
      expect(isHelpDialogOpen(doc)).toBe(true);
      doc.fire("keydown", { key: "?", shiftKey: true, target: doc.activeElement });
      expect(isHelpDialogOpen(doc)).toBe(false);

      // destroy() closes any open Help modal
      helpBtn.click();
      expect(isHelpDialogOpen(doc)).toBe(true);
      mounted.destroy();
      expect(isHelpDialogOpen(doc)).toBe(false);
    } finally {
      restoreFocusHook();
      delete globalThis.document;
      delete globalThis.Node;
    }
  });
});

describe("Help modal Light & Dark CSS invariants", () => {
  test("style.css styles .help-veil, .help-modal, and mobile <= 640px sheet using theme tokens without duplicate :root blocks", () => {
    const styleCss = readFileSync(join(ROOT, "web/style.css"), "utf8");
    expect(styleCss.match(/:root\s*\{/g)?.length ?? 0).toBe(1);
    expect(styleCss.match(/:root\[data-theme="dark"\]\s*\{/g)?.length ?? 0).toBe(1);

    expect(styleCss).toContain(".help-veil { position: fixed; inset: 0; z-index: 1220; }");
    expect(styleCss).toContain(".help-modal");
    expect(styleCss).toContain(".help-kbd");
    expect(styleCss).toContain(".help-role-card");

    const media640 = styleCss.slice(styleCss.indexOf("@media (max-width: 640px)"));
    expect(media640).toContain(".help-veil");
    expect(media640).toContain(".help-dialog");
    expect(media640).toContain(".help-modal");
  });

  test("home.css styles .home-page .home-top .home-help-btn with zero hardcoded hex or rgb colors", () => {
    const homeCss = readFileSync(join(ROOT, "web/home.css"), "utf8");
    expect(homeCss).toContain(".home-page .home-top .home-help-btn");
    const homeCssNoComments = homeCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(homeCssNoComments).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(homeCssNoComments).not.toMatch(/\brgba?\(/);
  });
});
