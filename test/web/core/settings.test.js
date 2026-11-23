// Unit & UI tests for Issue #116: Customizable User Settings & Keybindings.
import { describe, test, expect, afterAll } from "bun:test";
import {
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  DEFAULT_KEYBINDS,
  normalizeCombo,
  formatCombo,
  detectKeybindConflict,
  effectiveKeybinds,
  resolveKeybind,
  sanitizeSettings,
  loadSettings,
  saveSettings,
  resetSettings,
  resolveTheme,
} from "../../../web/core/settings.js";
import { memoryStore } from "../../../web/adapters/storage/memory.js";
import { localRoom } from "../../../web/adapters/transport/local.js";
import { createSession } from "../../../web/core/session.js";
import { hasActiveOverlay } from "../../../web/adapters/dom/a11y.js";
import { mountApp } from "../../../web/adapters/dom/app.js";
import { makeElement } from "../../../packages/core/model.js";
import { installPage, stub, restoreGlobals } from "../stub-page.js";

afterAll(restoreGlobals);

describe("#116 web/core/settings.js (pure unit tests)", () => {
  test("normalizeCombo normalizes KeyboardEvent-like objects and combo strings consistently", () => {
    expect(normalizeCombo({ key: "e", metaKey: true, shiftKey: true })).toBe("Mod+Shift+E");
    expect(normalizeCombo({ key: "e", ctrlKey: true, shiftKey: true })).toBe("Mod+Shift+E");
    expect(normalizeCombo("cmd+shift+e")).toBe("Mod+Shift+E");
    expect(normalizeCombo("ctrl+shift+E")).toBe("Mod+Shift+E");
    expect(normalizeCombo("mod+j")).toBe("Mod+J");
    expect(normalizeCombo("v")).toBe("V");
    // macOS Option+1 produces key="¡" with code="Digit1"
    expect(normalizeCombo({ key: "¡", code: "Digit1", altKey: true })).toBe("Alt+1");
    expect(normalizeCombo({ key: "!", code: "Digit1", shiftKey: true })).toBe("Shift+1");
    // Non-QWERTY layouts (AZERTY/Dvorak): letter keys respect typed e.key, not physical e.code
    expect(normalizeCombo({ key: "a", code: "KeyQ" })).toBe("A");
    expect(normalizeCombo({ key: "o", code: "KeyS" })).toBe("O");
    expect(normalizeCombo("alt+1")).toBe("Alt+1");
    expect(normalizeCombo({ key: "PageDown" })).toBe("PageDown");
    expect(normalizeCombo({ key: " ", shiftKey: true })).toBe("Shift+Space");
    // Bare modifiers return empty string
    expect(normalizeCombo({ key: "Shift", shiftKey: true })).toBe("");
    expect(normalizeCombo({ key: "Meta", metaKey: true })).toBe("");
    expect(normalizeCombo({ key: "Alt", altKey: true })).toBe("");
    expect(normalizeCombo({ key: "Control", ctrlKey: true })).toBe("");
    expect(normalizeCombo("")).toBe("");
    expect(normalizeCombo(null)).toBe("");
  });

  test("formatCombo produces readable shortcut labels", () => {
    expect(formatCombo("Mod+Shift+E")).toBe("⌘⇧E");
    expect(formatCombo("Mod+Shift+E", { mac: false })).toBe("Ctrl+Shift+E");
    expect(formatCombo("Alt+1")).toBe("⌥1");
    expect(formatCombo("V")).toBe("V");
    expect(formatCombo("PageDown")).toBe("PgDn");
  });

  test("detectKeybindConflict finds conflicts with default actions, overridden actions, and frameBinds", () => {
    // Conflicts with default Rectangle ("R") when trying to bind Ellipse to "r"
    const c1 = detectKeybindConflict({}, "tool.ellipse", "r");
    expect(c1).toEqual({ kind: "action", action: "tool.rectangle", label: "Rectangle tool", combo: "R" });

    // No conflict when binding an action to its own current key
    expect(detectKeybindConflict({}, "tool.rectangle", "R")).toBeNull();

    // No conflict if Rectangle was rebound away from R
    expect(detectKeybindConflict({ "tool.rectangle": "U" }, "tool.ellipse", "R")).toBeNull();

    // Conflicts with an overridden keybind
    const c2 = detectKeybindConflict({ "tool.rectangle": "U" }, "tool.ellipse", "u");
    expect(c2).toEqual({ kind: "action", action: "tool.rectangle", label: "Rectangle tool", combo: "U" });

    // Conflicts with built-in / reserved shortcuts (Tab, Mod+Z, Mod+C, B)
    expect(detectKeybindConflict({}, "tool.rectangle", "Tab")).toEqual({
      kind: "reserved", label: "Keyboard focus navigation", combo: "Tab", hard: true,
    });
    expect(detectKeybindConflict({}, "tool.rectangle", "Mod+Z")).toEqual({
      kind: "reserved", label: "Undo", combo: "Mod+Z", hard: true,
    });
    expect(detectKeybindConflict({}, "tool.rectangle", "B")).toEqual({
      kind: "reserved", label: "Next fill color", combo: "B", hard: false,
    });

    // Conflicts with a frameBind slot
    const c3 = detectKeybindConflict({}, "action.views", "Alt+1", { frameBinds: { "Alt+1": "frame:f1" } });
    expect(c3).toEqual({ kind: "frame", target: "frame:f1", combo: "Alt+1" });
  });

  test("loadSettings, saveSettings, resetSettings persist via Storage port and survive corrupt/failing storage", () => {
    const store = memoryStore();
    expect(loadSettings(store)).toEqual({
      defaultTheme: "auto",
      gridDefault: false,
      roughDefault: 1,
      keybinds: {},
      frameBinds: {},
    });

    const saved = saveSettings(store, {
      defaultTheme: "dark",
      gridDefault: true,
      roughDefault: 2,
      keybinds: { "tool.rectangle": "u", "action.views": "mod+k" },
      frameBinds: { "alt+1": "frame:intro-1", "alt+2": "view:v-auth" },
    });
    expect(saved.defaultTheme).toBe("dark");
    expect(saved.gridDefault).toBe(true);
    expect(saved.roughDefault).toBe(2);
    expect(saved.keybinds).toEqual({ "tool.rectangle": "U", "action.views": "Mod+K" });
    expect(saved.frameBinds).toEqual({ "Alt+1": "frame:intro-1", "Alt+2": "view:v-auth" });
    expect(store.get(SETTINGS_KEY)).toBeTruthy();

    // Reload from storage
    expect(loadSettings(store)).toEqual(saved);

    // Reset removes stored entry and returns defaults
    const reset = resetSettings(store);
    expect(reset).toEqual({
      defaultTheme: "auto",
      gridDefault: false,
      roughDefault: 1,
      keybinds: {},
      frameBinds: {},
    });
    expect(store.get(SETTINGS_KEY)).toBeNull();

    // Corrupt JSON and throwing storage never throw
    store.set(SETTINGS_KEY, "{not-json");
    expect(loadSettings(store).defaultTheme).toBe("auto");
    const broken = {
      get() { throw new Error("unavailable"); },
      set() { throw new Error("quota"); },
      remove() { throw new Error("unavailable"); },
    };
    expect(loadSettings(broken).roughDefault).toBe(1);
    expect(saveSettings(broken, { defaultTheme: "light" }).defaultTheme).toBe("light");
    expect(resetSettings(broken).defaultTheme).toBe("auto");
  });

  test("sanitizeSettings rejects prototype-pollution keys, non-Alt frameBinds, hard-reserved keybinds, and out-of-range values", () => {
    const dirty = JSON.parse('{"defaultTheme":"bogus","roughDefault":99,"keybinds":{"__proto__":"X","tool.select":"x","tool.rectangle":"Tab","unknown.act":"y"},"frameBinds":{"constructor":"bad","V":"frame:hijack","Alt+1":"frame:ok","Alt+2":"bad value with spaces"}}');
    const clean = sanitizeSettings(dirty);
    expect(clean.defaultTheme).toBe("auto");
    expect(clean.roughDefault).toBe(2);
    expect(clean.keybinds).toEqual({ "tool.select": "X" });
    expect(clean.frameBinds).toEqual({ "Alt+1": "frame:ok" });
    expect(Object.hasOwn(clean.keybinds, "__proto__")).toBe(false);
  });

  test("resolveKeybind resolves custom binds, frameBinds, and suppresses rebound defaults", () => {
    const settings = sanitizeSettings({
      keybinds: { "tool.rectangle": "B" },
      frameBinds: { "Alt+1": "frame:f1" },
    });
    expect(resolveKeybind(settings, { key: "b" })).toEqual({ kind: "action", action: "tool.rectangle", combo: "B" });
    // Old default "R" for rectangle is suppressed as unbound
    expect(resolveKeybind(settings, { key: "r" })).toEqual({ kind: "unbound", action: "tool.rectangle", combo: "R" });
    // Frame bind wins for Alt+1
    expect(resolveKeybind(settings, { key: "¡", code: "Digit1", altKey: true })).toEqual({
      kind: "frameBind",
      combo: "Alt+1",
      target: "frame:f1",
    });
    expect(effectiveKeybinds(settings)["tool.rectangle"]).toBe("B");
    expect(effectiveKeybinds(settings)["tool.select"]).toBe(DEFAULT_KEYBINDS["tool.select"]);
    expect(resolveTheme("auto", true)).toBe("dark");
    expect(resolveTheme("auto", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
  });
});

describe("#116 Settings Dialog & App Keybinding Integration", () => {
  const USERS = { "t-ada": { user: "ada", role: "owner" } };

  function setup({ prefs = memoryStore(), theme = null } = {}) {
    const page = installPage();
    const net = localRoom({ board: "settings-board", users: USERS, clock: true });
    const app = mountApp({
      startSession: ({ mine, onChange }) => createSession({
        join: () => net.join(),
        token: "t-ada",
        board: "settings-board",
        client: "ada",
        user: "ada",
        mine,
        onChange,
        clock: net.clock,
      }),
      net: { kind: "local", put() {}, onFile() {} },
      board: "settings-board",
      me: { user: "ada", name: "Ada", role: null },
      prefs,
      theme,
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
    return { page, net, app, S: app.S, prefs, step };
  }

  const find = (root, pred) => root.all().find(pred);

  test("Board menu opens Settings & keybindings modal on a11y overlay stack, switches tabs, captures custom shortcut, warns on conflict, and resets", () => {
    const { page, S, prefs, step } = setup();

    // Open Board menu -> click "Settings & keybindings…"
    const more = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "More");
    more.click();
    const settingsMenuBtn = find(page.byId.topbar, e => e.attrs["aria-label"] === "Settings & keybindings");
    expect(settingsMenuBtn).toBeTruthy();
    settingsMenuBtn.click();
    step(1);

    expect(hasActiveOverlay(page.doc)).toBe(true);
    const modal = find(page.doc.body, e => e.classList?.contains("settings-modal"));
    expect(modal).toBeTruthy();
    expect(modal.attrs.role).toBe("dialog");
    expect(modal.attrs["aria-modal"]).toBe("true");

    // Preferences tab: switch default theme to Dark and stroke style to Clean (0); focus stays in dialog
    const darkChip = find(modal, e => e.attrs["data-pref-theme"] === "dark");
    expect(darkChip).toBeTruthy();
    darkChip.focus();
    darkChip.click();
    expect(page.doc.documentElement.dataset.theme).toBe("dark");
    expect(page.doc.activeElement?.getAttribute?.("data-pref-theme")).toBe("dark");

    const cleanChip = find(modal, e => e.attrs["data-pref-rough"] === "0");
    cleanChip.click();
    expect(S.eds.board.style.roughness).toBe(0);

    // Switch to Keybindings tab
    const kbTab = find(modal, e => e.attrs["data-settings-tab"] === "keybindings");
    kbTab.click();

    // Capture a conflicting key ("V" is Select) for Rectangle -> inline conflict warning appears
    const rectCapture = find(modal, e => e.attrs["data-capture-action"] === "tool.rectangle");
    expect(rectCapture).toBeTruthy();
    rectCapture.click();
    page.doc.fire("keydown", { key: "v" });
    const conflictAlert = find(modal, e => e.classList?.contains("settings-conflict"));
    expect(conflictAlert).toBeTruthy();
    expect(conflictAlert.attrs.role).toBe("alert");
    expect(conflictAlert.textContent).toContain("Select tool");

    // Cancel conflict, then capture non-conflicting "U" for Rectangle
    find(modal, e => e.attrs["data-action"] === "cancel-conflict").click();
    find(modal, e => e.attrs["data-capture-action"] === "tool.rectangle").click();
    page.doc.fire("keydown", { key: "u" });
    expect(loadSettings(prefs).keybinds["tool.rectangle"]).toBe("U");

    // Close modal via Escape
    page.doc.fire("keydown", { key: "Escape" });
    expect(hasActiveOverlay(page.doc)).toBe(false);

    // Pressing "U" activates Rectangle tool; old default "R" does NOT activate Rectangle
    S.setTool("select");
    page.doc.fire("keydown", { key: "r", target: page.board });
    expect(S.tool).toBe("select");
    page.doc.fire("keydown", { key: "u", target: page.board });
    expect(S.tool).toBe("rectangle");

    // Re-open via Mod+, and click Reset to defaults
    page.doc.fire("keydown", { key: ",", metaKey: true, target: page.board });
    expect(hasActiveOverlay(page.doc)).toBe(true);
    const modal2 = find(page.doc.body, e => e.classList?.contains("settings-modal"));
    find(modal2, e => e.attrs["data-action"] === "reset-settings").click();
    expect(loadSettings(prefs)).toEqual(sanitizeSettings(null));
    expect(S.eds.board.style.roughness).toBe(1);
    page.doc.fire("keydown", { key: "Escape" });
    expect(hasActiveOverlay(page.doc)).toBe(false);
  });

  test("Alt+1 frameBind jumps directly to the bound named frame", () => {
    const prefs = memoryStore();
    const { page, S, step } = setup({ prefs });

    let f1 = "", f2 = "";
    S.act("board", e => {
      [f1, f2] = e.insertElements([
        makeElement("frame", { x: 0, y: 0, width: 500, height: 350, name: "Overview" }),
        makeElement("frame", { x: 1200, y: 0, width: 500, height: 350, name: "Deep Dive" }),
      ]);
      e.select([]);
    });
    step(2);

    // Bind Alt+1 to frame f2 through settings dialog
    page.doc.fire("keydown", { key: ",", metaKey: true, target: page.board });
    const modal = find(page.doc.body, e => e.classList?.contains("settings-modal"));
    find(modal, e => e.attrs["data-settings-tab"] === "keybindings").click();
    const sel = find(modal, e => e.attrs["data-frame-bind-slot"] === "Alt+1");
    expect(sel).toBeTruthy();
    sel.value = `frame:${f2}`;
    sel.fire("change", { target: sel });
    page.doc.fire("keydown", { key: "Escape" });

    // Jump to f1 first, then press Alt+1 (macOS "¡" + Digit1) -> jumps to f2!
    S.eds.board.frameAt = f1;
    page.doc.fire("keydown", { key: "¡", code: "Digit1", altKey: true, target: page.board });
    expect(S.eds.board.frameAt).toBe(f2);
  });
});
