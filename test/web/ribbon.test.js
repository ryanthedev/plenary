// Contextual Auto-Ribbon with Escape Hatch: pure core tests + mounted DOM tests.
import { describe, test, expect, afterAll } from "bun:test";
import { ALL_PROP_KEYS, contextualPropKeys, shouldExpandRibbon } from "../../web/core/ribbon.js";
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
  "t-vi": { user: "vi", role: "viewer" },
};

function setup({ token = "t-ada" } = {}) {
  installPage();
  const net = localRoom({ board: "b-ribbon", users: USERS, clock: true });
  const app = mountApp({
    startSession: ({ mine, onChange }) =>
      createSession({
        join: () => net.join(),
        token,
        board: "b-ribbon",
        client: USERS[token].user,
        user: USERS[token].user,
        mine,
        onChange,
        clock: net.clock,
      }),
    net: { kind: "local", put() {}, onFile() {} },
    board: "b-ribbon",
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

function drawShape(s, tool, x, y) {
  s.setTool(tool);
  s.pointerDown({ x, y });
  s.pointerMove({ x: x + 80, y: y + 50 });
  s.pointerUp({ x: x + 80, y: y + 50 });
}

describe("web/core/ribbon (pure)", () => {
  test("contextualPropKeys filters by selection type, tool, and showAll escape hatch", () => {
    // Text-only selection
    expect(contextualPropKeys({ selectionTypes: ["text"], tool: "select", showAll: false })).toEqual([
      "strokeColor",
      "opacity",
      "fontFamily",
      "fontSize",
    ]);

    // Arrow or line selection
    for (const type of ["arrow", "line"]) {
      const keys = contextualPropKeys({ selectionTypes: [type], tool: "select", showAll: false });
      expect(keys).toEqual(["strokeColor", "strokeWidth", "strokeStyle", "roughness", "opacity", "arrow", "heads", "bends"]);
    }

    // Arrow/line tool active with nothing selected
    expect(contextualPropKeys({ selectionTypes: [], tool: "arrow", showAll: false })).toContain("arrow");
    expect(contextualPropKeys({ selectionTypes: [], tool: "line", showAll: false })).toContain("heads");

    // Rectangle / shape / empty selection hides arrow controls
    for (const types of [["rectangle"], ["ellipse"], ["diamond"], ["frame"], []]) {
      const keys = contextualPropKeys({ selectionTypes: types, tool: "select", showAll: false });
      expect(keys).toContain("strokeColor");
      expect(keys).toContain("backgroundColor");
      expect(keys).toContain("fillStyle");
      expect(keys).toContain("roundness");
      expect(keys).toContain("effects");
      expect(keys).toContain("meta");
      expect(keys).not.toContain("arrow");
      expect(keys).not.toContain("heads");
      expect(keys).not.toContain("bends");
    }

    // Mixed selection (rectangle + arrow) includes both shape & arrow controls
    const mixed = contextualPropKeys({ selectionTypes: ["rectangle", "arrow"], tool: "select", showAll: false });
    expect(mixed).toContain("backgroundColor");
    expect(mixed).toContain("arrow");

    // Escape hatch: showAll returns every property group
    expect(contextualPropKeys({ selectionTypes: ["text"], tool: "select", showAll: true })).toEqual([...ALL_PROP_KEYS]);
    expect(contextualPropKeys({ selectionTypes: ["rectangle"], tool: "select", showAll: true })).toEqual([...ALL_PROP_KEYS]);
  });

  test("shouldExpandRibbon auto-expands on selection, auto-collapses on deselect, and honors escape hatches", () => {
    // Nothing selected, not pinned, properties tab -> collapsed
    expect(shouldExpandRibbon({ selectionCount: 0, pinnedOpen: false, manualCollapsed: false, activeTab: "properties" })).toBe(false);

    // Selecting a shape -> auto-expands
    expect(shouldExpandRibbon({ selectionCount: 1, pinnedOpen: false, manualCollapsed: false, activeTab: "properties" })).toBe(true);

    // User explicitly collapsed for this selection -> stays collapsed
    expect(shouldExpandRibbon({ selectionCount: 1, pinnedOpen: false, manualCollapsed: true, activeTab: "properties" })).toBe(false);

    // User pinned open (clicked tab or expand button) -> expanded even with nothing selected
    expect(shouldExpandRibbon({ selectionCount: 0, pinnedOpen: true, manualCollapsed: false, activeTab: "properties" })).toBe(true);

    // Non-properties tab -> expanded unless manually collapsed
    expect(shouldExpandRibbon({ selectionCount: 0, pinnedOpen: false, manualCollapsed: false, activeTab: "layers" })).toBe(true);
    expect(shouldExpandRibbon({ selectionCount: 0, pinnedOpen: false, manualCollapsed: true, activeTab: "layers" })).toBe(false);
  });
});

describe("Contextual Auto-Ribbon DOM integration", () => {
  test("collapsed by default with only 1 non-hidden active section; auto-expands on shape selection and auto-collapses on deselect", () => {
    const { S, step } = setup();
    const panel = page.byId.panel;

    // Collapsed on first load with nothing selected
    expect(panel.attrs["data-ribbon-expanded"]).toBe("false");
    const toggle = () => find(panel, e => e.attrs?.["data-ribbon-toggle"] === "1");
    expect(toggle()?.textContent).toBe("⌄");

    // Squish fix: in stack mode, only the active tab's .sec is visible; all other .sec have data-ribbon-hidden="true"
    const secs = findAll(panel, e => e.classList?.contains?.("sec"));
    expect(secs.length).toBeGreaterThan(1);
    const visibleSecs = secs.filter(s => s.attrs["data-ribbon-hidden"] !== "true");
    expect(visibleSecs.length).toBe(1);
    expect(visibleSecs[0].attrs["data-sec"]).toBe("properties");

    // Selecting a shape auto-expands the ribbon
    drawShape(S, "rectangle", 100, 100);
    step(20);
    expect(panel.attrs["data-ribbon-expanded"]).toBe("true");
    expect(toggle()?.textContent).toBe("⌃");

    // Deselecting auto-collapses back to the slim tab bar
    S.act("board", e => e.select([]));
    step(20);
    expect(panel.attrs["data-ribbon-expanded"]).toBe("false");
    expect(toggle()?.textContent).toBe("⌄");
  });

  test("escape hatches: clicking active expanded tab collapses, clicking another tab expands, and toggle button works", () => {
    const { S, step } = setup();
    const panel = page.byId.panel;

    drawShape(S, "rectangle", 120, 120);
    step(20);
    expect(panel.attrs["data-ribbon-expanded"]).toBe("true");

    // Clicking the already-active expanded tab (Properties) collapses the ribbon
    const propTab = () => find(panel, e => e.attrs?.role === "tab" && e.attrs?.["data-tab"] === "properties");
    propTab().click();
    step(20);
    expect(panel.attrs["data-ribbon-expanded"]).toBe("false");

    // Clicking Layers tab expands the ribbon to Layers
    const layersTab = () => find(panel, e => e.attrs?.role === "tab" && e.attrs?.["data-tab"] === "layers");
    layersTab().click();
    step(20);
    expect(panel.attrs["data-ribbon-expanded"]).toBe("true");
    expect(find(panel, e => e.attrs?.["data-sec"] === "layers" && e.attrs?.["data-ribbon-hidden"] !== "true")).toBeDefined();

    // Clicking the collapse toggle button collapses it
    find(panel, e => e.attrs?.["data-ribbon-toggle"] === "1").click();
    step(20);
    expect(panel.attrs["data-ribbon-expanded"]).toBe("false");

    // Clicking the expand toggle button expands it again
    find(panel, e => e.attrs?.["data-ribbon-toggle"] === "1").click();
    step(20);
    expect(panel.attrs["data-ribbon-expanded"]).toBe("true");
  });

  test("contextual filtering hides irrelevant controls and 'All ⋯' escape hatch reveals them", () => {
    const { S, step } = setup();
    const panel = page.byId.panel;

    // Draw a rectangle -> arrow controls hidden, 'All ⋯' pill present
    drawShape(S, "rectangle", 100, 100);
    step(20);
    const propsSec = () => find(panel, e => e.attrs?.["data-sec"] === "properties");
    expect(find(propsSec(), e => e.textContent === "+ bend")).toBeUndefined();
    const allBtn = () => find(propsSec(), e => e.attrs?.["data-ribbon-all"] === "1");
    expect(allBtn()?.textContent).toBe("All ⋯");

    // Click 'All ⋯' -> arrow controls appear and pill flips to 'Contextual'
    allBtn().click();
    step(20);
    expect(find(propsSec(), e => e.textContent === "+ bend")).toBeDefined();
    expect(allBtn()?.textContent).toBe("Contextual");

    // Click 'Contextual' -> arrow controls hidden again
    allBtn().click();
    step(20);
    expect(find(propsSec(), e => e.textContent === "+ bend")).toBeUndefined();

    // Draw an arrow -> arrow controls appear, Fill pill hidden
    drawShape(S, "arrow", 250, 120);
    step(20);
    expect(find(propsSec(), e => e.textContent === "+ bend")).toBeDefined();
    expect(find(propsSec(), e => e.attrs?.["data-color-popover"] === "backgroundColor")).toBeUndefined();
  });

  test("compact Stroke/Fill popover pills open swatches + custom color picker, update color, and dismiss on Escape or outside click", () => {
    const { S, step } = setup();
    const panel = page.byId.panel;

    drawShape(S, "rectangle", 100, 100);
    step(20);
    const rectId = S.eds.board.selected()[0].id;

    // Compact trigger pills rendered instead of 16 inline swatches
    const strokePill = () => find(panel, e => e.attrs?.["data-color-popover"] === "strokeColor");
    const fillPill = () => find(panel, e => e.attrs?.["data-color-popover"] === "backgroundColor");
    expect(strokePill()).toBeDefined();
    expect(fillPill()).toBeDefined();
    expect(find(panel, e => e.attrs?.["data-color-popover-panel"])).toBeUndefined();

    // Click Stroke pill -> opens popover with quick swatches + custom color picker
    strokePill().click();
    step(20);
    const pop = () => find(panel, e => e.attrs?.["data-color-popover-panel"] === "strokeColor");
    expect(pop()).toBeDefined();
    const swatches = findAll(pop(), e => e.tagName === "BUTTON" && e.classList.contains("sw"));
    expect(swatches.length).toBeGreaterThanOrEqual(6);
    expect(find(pop(), e => e.attrs?.["data-component"] === "color-picker")).toBeDefined();

    // Clicking a swatch updates the element's strokeColor
    const targetSwatch = swatches.find(sw => sw.attrs["aria-label"] === "#e03131") ?? swatches[1];
    const expectedColor = targetSwatch.attrs["aria-label"];
    targetSwatch.click();
    step(20);
    expect(S.eds.board.doc.get(rectId).strokeColor).toBe(expectedColor);

    // Pressing Escape dismisses the popover
    page.doc.fire("keydown", { key: "Escape" });
    step(20);
    expect(find(panel, e => e.attrs?.["data-color-popover-panel"])).toBeUndefined();

    // Open Fill pill, then outside click dismisses it
    fillPill().click();
    step(20);
    expect(find(panel, e => e.attrs?.["data-color-popover-panel"] === "backgroundColor")).toBeDefined();
    page.doc.fire("click", { target: page.board });
    step(20);
    expect(find(panel, e => e.attrs?.["data-color-popover-panel"])).toBeUndefined();
  });
});
