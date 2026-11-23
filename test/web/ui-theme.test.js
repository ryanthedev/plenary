// Light & Dark mode support across Plenary's management UI (Home + Workspace Admin pages + Sign-in gate).
// Covers theme initialization (persisted preference, prefers-color-scheme fallback, URL override),
// live toggling on Home & Workspace Admin headers with persistence sync, and dark-mode CSS token invariants.
import { test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeElement, installDom } from "./collab/fake-dom.js";
import { initTheme, THEME_COLORS } from "../../web/adapters/dom/theme.js";
import { mountHome } from "../../web/adapters/dom/home.js";
import { mountRolesPage } from "../../web/adapters/dom/roles.js";
import { mountTeamsPage, mountAccessPage } from "../../web/adapters/dom/access.js";
import { mountTrashPage } from "../../web/adapters/dom/trash.js";
import { mountOffboardPage } from "../../web/adapters/dom/offboard.js";
import { createHomeModel } from "../../web/core/home.js";
import { createRolesModel } from "../../web/core/role-admin.js";
import { createTeamsModel, createAccessModel } from "../../web/core/access.js";
import { createTrashModel } from "../../web/core/trash.js";
import { createOffboardModel } from "../../web/core/offboard.js";
import { loadSettings, saveSettings, SETTINGS_KEY } from "../../web/core/settings.js";
import { virtualClock } from "../../web/adapters/clock/virtual.js";

function memoryPrefs(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get: k => (map.has(k) ? map.get(k) : null),
    set: (k, v) => { map.set(k, String(v)); },
    remove: k => { map.delete(k); },
  };
}

function setupThemeDom() {
  const dom = installDom();
  const meta = new FakeElement("meta");
  meta.setAttribute("name", "theme-color");
  meta.setAttribute("content", THEME_COLORS.light);
  const docEl = new FakeElement("html");
  docEl.dataset = { theme: "light" };
  globalThis.document.documentElement = /** @type {any} */ (docEl);
  globalThis.document.querySelector = sel => (sel === 'meta[name="theme-color"]' ? /** @type {any} */ (meta) : null);
  globalThis.document.addEventListener = () => {};
  globalThis.document.removeEventListener = () => {};
  globalThis.Node = Object.getPrototypeOf(FakeElement);
  return { root: dom.root, docEl, meta };
}

afterEach(() => {
  delete globalThis.document;
  delete globalThis.Node;
});

test("initTheme: respects persisted preference, prefers-color-scheme fallback, and URL override", () => {
  const { docEl, meta } = setupThemeDom();

  // 1. Default auto + prefersDark = true -> dark
  const prefs1 = memoryPrefs();
  const ctrl1 = initTheme({ prefs: prefs1, prefersDark: () => true });
  expect(ctrl1.getTheme()).toBe("dark");
  expect(docEl.dataset.theme).toBe("dark");
  expect(meta.getAttribute("content")).toBe(THEME_COLORS.dark);
  // Initializing does not clobber defaultTheme="auto"
  expect(loadSettings(prefs1).defaultTheme).toBe("auto");

  // 2. Persisted "light" wins over prefersDark = true
  saveSettings(prefs1, { defaultTheme: "light" });
  const ctrl2 = initTheme({ prefs: prefs1, prefersDark: () => true });
  expect(ctrl2.getTheme()).toBe("light");
  expect(docEl.dataset.theme).toBe("light");
  expect(meta.getAttribute("content")).toBe(THEME_COLORS.light);

  // 3. Explicit URL ?theme=dark overrides persisted "light" without overwriting storage
  const ctrl3 = initTheme({ prefs: prefs1, urlTheme: "dark", prefersDark: () => false });
  expect(ctrl3.getTheme()).toBe("dark");
  expect(docEl.dataset.theme).toBe("dark");
  expect(meta.getAttribute("content")).toBe(THEME_COLORS.dark);
  expect(loadSettings(prefs1).defaultTheme).toBe("light");
});

test("Home header theme toggle flips light <-> dark, updates DOM + meta, and persists for canvas/next load", async () => {
  const { root, docEl, meta } = setupThemeDom();
  const prefs = memoryPrefs();
  const themeCtrl = initTheme({ prefs, prefersDark: () => false });
  const clock = virtualClock({ t0: 1_000_000 });
  const api = {
    load: async () => ({
      home: {
        guest: false,
        user: { user: "dev:ada", name: "Ada" },
        unit: { id: "u1", kind: "org", name: "Acme", isAdmin: true },
        limits: {},
        can: {},
        recent: [],
        starred: [],
        owned: [],
        shared: [],
        tree: { groups: [], spaces: [], more: false },
      },
    }),
    search: async q => ({ q, results: [], more: false }),
    star: async () => ({ ok: true }),
  };
  const model = createHomeModel({ api, clock });
  const dialogs = { newBoard: () => null, newSpace: () => null, newGroup: () => null };
  const mounted = mountHome({
    root,
    model,
    clock,
    dialogs,
    themeCtrl,
    boardHref: id => `?board=${id}`,
    spaceHref: id => `?space=${id}`,
    groupHref: id => `?group=${id}`,
    onLogout: () => {},
  });
  await model.load();

  const toggle = root.find(e => e.tagName === "BUTTON" && e.getAttribute("data-action") === "toggle-theme");
  expect(toggle).toBeDefined();
  expect(toggle.getAttribute("aria-label")).toBe("Switch to dark mode");
  expect(toggle.getAttribute("aria-pressed")).toBe("false");

  // Click -> dark
  toggle.click();
  expect(docEl.dataset.theme).toBe("dark");
  expect(meta.getAttribute("content")).toBe(THEME_COLORS.dark);
  expect(toggle.getAttribute("aria-label")).toBe("Switch to light mode");
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(JSON.parse(prefs.get(SETTINGS_KEY)).defaultTheme).toBe("dark");

  // Next page load (or canvas editor) initializes in dark mode from the exact same prefs
  const nextLoad = initTheme({ prefs, prefersDark: () => false });
  expect(nextLoad.getTheme()).toBe("dark");

  // Click again -> light
  toggle.click();
  expect(docEl.dataset.theme).toBe("light");
  expect(meta.getAttribute("content")).toBe(THEME_COLORS.light);
  expect(toggle.getAttribute("aria-label")).toBe("Switch to dark mode");
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(loadSettings(prefs).defaultTheme).toBe("light");

  mounted.destroy();
});

test("Workspace Admin pages (Roles, Teams, Access, Trash, Offboard) all render a working header theme toggle", () => {
  const { root, docEl, meta } = setupThemeDom();
  const prefs = memoryPrefs();
  const themeCtrl = initTheme({ prefs, prefersDark: () => false });
  const hrefs = { home: "./", board: id => `?board=${id}`, space: id => `?space=${id}`, group: id => `?group=${id}`, team: id => `?team=${id}`, teams: "?teams=1", roles: "?roles=1", access: (t, id) => `?access=${t}:${id}` };

  const pages = [
    ["Roles", () => mountRolesPage({ root, model: createRolesModel({ api: /** @type {any} */ ({ list: async () => ({ roles: [], matrix: { scopes: [], ladders: [], permissions: [] } }) }) }), hrefs, themeCtrl })],
    ["Teams", () => mountTeamsPage({ root, model: createTeamsModel({ api: /** @type {any} */ ({ teams: async () => ({ teams: [], can: { create: false }, next: null }) }) }), hrefs, themeCtrl })],
    ["Access", () => mountAccessPage({ root, model: createAccessModel({ api: /** @type {any} */ ({ scope: async () => ({}) }), type: "unit", id: "u1" }), api: /** @type {any} */ ({}), hrefs, themeCtrl })],
    ["Trash", () => mountTrashPage({ root, model: createTrashModel({ api: /** @type {any} */ ({ list: async () => ({ items: [] }) }) }), hrefs, themeCtrl })],
    ["Offboard", () => mountOffboardPage({ root, model: createOffboardModel({ api: /** @type {any} */ ({}) }), hrefs, themeCtrl })],
  ];

  for (const [, mount] of pages) {
    const view = mount();
    const toggle = root.find(e => e.tagName === "BUTTON" && e.getAttribute("data-action") === "toggle-theme");
    expect(toggle).toBeDefined();
    const before = docEl.dataset.theme;
    toggle.click();
    const expected = before === "dark" ? "light" : "dark";
    expect(docEl.dataset.theme).toBe(expected);
    expect(meta.getAttribute("content")).toBe(THEME_COLORS[expected]);
    expect(loadSettings(prefs).defaultTheme).toBe(expected);
    expect(toggle.getAttribute("aria-pressed")).toBe(expected === "dark" ? "true" : "false");
    view.destroy();
  }
});

test("Dark-mode CSS token coverage on Home, Workspace Admin, and Sign-in surfaces", () => {
  const rootDir = join(import.meta.dir, "..", "..");
  const styleCss = readFileSync(join(rootDir, "web/style.css"), "utf8");
  const homeCss = readFileSync(join(rootDir, "web/home.css"), "utf8");

  // Obsidian Studio dark theme block defines full semantic palette
  const darkBlockMatch = styleCss.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/);
  expect(darkBlockMatch).toBeTruthy();
  const darkBlock = darkBlockMatch[1];
  for (const token of [
    "--canvas-bg:",
    "--surface:",
    "--surface-subtle:",
    "--surface-hover:",
    "--border:",
    "--fg:",
    "--fg-muted:",
    "--fg-dim:",
    "--accent:",
    "--bad-fg:",
    "--veil:",
    "color-scheme: dark;",
  ]) {
    expect(darkBlock).toContain(token);
  }

  // web/home.css has zero hardcoded hex/rgb colors outside comments (strictly CSS custom properties)
  const homeCssNoComments = homeCss.replace(/\/\*[\s\S]*?\*\//g, "");
  expect(homeCssNoComments).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(homeCssNoComments).not.toMatch(/\brgba?\(/);

  // Management header theme toggle styling exists
  expect(styleCss).toContain(".home-top .theme-toggle");
  expect(styleCss).toContain(".btn.btn-danger { background: var(--bad); color: var(--bad-fg");
});
