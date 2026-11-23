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

describe("Word-Style Two-Bar Contextual Ribbon DOM integration", () => {
  test("two-bar structure: tabs and chevron live in Bar 1 (#topbar), no separate middle tab bar in #panel, and Bar 2 collapses to 1-bar mode", () => {
    const { S, step } = setup();
    const topbar = page.byId.topbar;
    const panel = page.byId.panel;

    // Bar 1 (#topbar) holds the Word-style ribbon tabs and collapse/expand chevron; #panel has NO .tabs bar
    const tablist = find(topbar, e => e.attrs?.role === "tablist" && e.attrs?.["aria-label"] === "Inspector sections");
    expect(tablist).toBeDefined();
    expect(find(panel, e => e.classList?.contains?.("tabs"))).toBeUndefined();
    expect(find(panel, e => e.attrs?.["data-ribbon-toggle"] === "1")).toBeUndefined();

    // Collapsed on first load with nothing selected (1-bar mode)
    expect(panel.attrs["data-ribbon-expanded"]).toBe("false");
    const toggle = () => find(topbar, e => e.attrs?.["data-ribbon-toggle"] === "1");
    expect(toggle()?.textContent).toBe("⌄");

    // Only the active tab's .sec is non-hidden; all other .sec have data-ribbon-hidden="true"
    const secs = findAll(panel, e => e.classList?.contains?.("sec"));
    expect(secs.length).toBeGreaterThan(1);
    const visibleSecs = secs.filter(s => s.attrs["data-ribbon-hidden"] !== "true");
    expect(visibleSecs.length).toBe(1);
    expect(visibleSecs[0].attrs["data-sec"]).toBe("properties");

    // Selecting a shape auto-expands Bar 2 (2-bar mode) and highlights Properties tab in Bar 1
    drawShape(S, "rectangle", 100, 100);
    step(20);
    expect(panel.attrs["data-ribbon-expanded"]).toBe("true");
    expect(toggle()?.textContent).toBe("⌃");
    const propTab = find(topbar, e => e.attrs?.role === "tab" && e.attrs?.["data-tab"] === "properties");
    expect(propTab?.classList.contains("on")).toBe(true);

    // Deselecting auto-collapses back to 1-bar mode
    S.act("board", e => e.select([]));
    step(20);
    expect(panel.attrs["data-ribbon-expanded"]).toBe("false");
    expect(toggle()?.textContent).toBe("⌄");
  });

  test("Bar 2 renders Word-style .ribbon-group columns with multi-row .ribbon-group-rows and centered .ribbon-group-label footers", () => {
    const { S, step } = setup();
    const topbar = page.byId.topbar;
    const panel = page.byId.panel;

    // Select a rectangle -> Properties tab groups: Colors, Line, Shape, Text, Effects, Metadata, Actions, More
    drawShape(S, "rectangle", 100, 100);
    step(20);
    const propsSec = find(panel, e => e.attrs?.["data-sec"] === "properties");
    const propGroups = findAll(propsSec, e => e.classList?.contains?.("ribbon-group"));
    const propLabels = propGroups.map(g => find(g, e => e.classList?.contains?.("ribbon-group-label"))?.textContent);
    expect(propLabels).toEqual(["Colors", "Line", "Shape", "Text", "Effects", "Metadata", "Actions", "More"]);

    // Each group has .ribbon-group-rows container; Line group has 3 stacked rows (Width, Style, Sketch)
    const lineGroup = propGroups.find(g => g.attrs?.["data-ribbon-group"] === "line");
    const lineRows = find(lineGroup, e => e.classList?.contains?.("ribbon-group-rows"));
    expect(lineRows).toBeDefined();
    expect(findAll(lineRows, e => e.classList?.contains?.("ribbon-row")).length).toBe(3);

    // Switch to Arrange tab -> Word-style groups (Order, Group, Rotate; plus Align & Distribute with >=2 shapes)
    drawShape(S, "ellipse", 240, 100);
    S.act("board", e => e.select(e.doc.live().map(x => x.id)));
    step(20);
    find(topbar, e => e.attrs?.role === "tab" && e.attrs?.["data-tab"] === "arrange").click();
    step(20);
    const arrangeSec = find(panel, e => e.attrs?.["data-sec"] === "arrange" && e.attrs?.["data-ribbon-hidden"] !== "true");
    const arrangeLabels = findAll(arrangeSec, e => e.classList?.contains?.("ribbon-group"))
      .map(g => find(g, e => e.classList?.contains?.("ribbon-group-label"))?.textContent);
    expect(arrangeLabels).toEqual(["Align", "Distribute", "Order", "Group", "Rotate"]);

    // Switch to Layers tab -> dedicated vertical floating bar (sticky header, vertical Z-order list, bottom actions)
    expect(panel.attrs["data-ribbon-layout"]).toBe("horizontal");
    find(topbar, e => e.attrs?.role === "tab" && e.attrs?.["data-tab"] === "layers").click();
    step(20);
    expect(panel.attrs["data-ribbon-layout"]).toBe("vertical");
    const layersSec = find(panel, e => e.attrs?.["data-sec"] === "layers" && e.attrs?.["data-ribbon-hidden"] !== "true");
    expect(layersSec).toBeDefined();
    expect(find(layersSec, e => e.classList?.contains?.("layers-bar-head"))).toBeDefined();
    expect(find(layersSec, e => e.classList?.contains?.("layers-bar-count"))?.textContent).toBe("1");
    expect(find(layersSec, e => e.attrs?.["data-fk"] === "layers:add")).toBeDefined();
    expect(find(layersSec, e => e.attrs?.["data-fk"] === "layers:close")).toBeDefined();
    const layersList = find(layersSec, e => e.classList?.contains?.("layers-bar-list") && e.attrs?.role === "list");
    expect(layersList).toBeDefined();
    expect(findAll(layersList, e => e.classList?.contains?.("layer-row")).length).toBe(1);
    const layersFoot = find(layersSec, e => e.classList?.contains?.("layers-bar-foot"));
    expect(layersFoot).toBeDefined();
    expect(find(layersFoot, e => e.attrs?.["data-fk"] === "layers:move-up")?.disabled).toBe(true);
    expect(find(layersFoot, e => e.attrs?.["data-fk"] === "layers:move-down")?.disabled).toBe(true);
    expect(find(layersFoot, e => e.attrs?.["data-fk"] === "layers:move-sel")?.disabled).toBe(false);
    expect(find(layersFoot, e => e.attrs?.["data-fk"] === "layers:delete")?.disabled).toBe(true);

    // Switch to Library tab -> dedicated vertical floating bar (sticky header, items/empty body, icon pack footer)
    find(topbar, e => e.attrs?.role === "tab" && e.attrs?.["data-tab"] === "library").click();
    step(20);
    expect(panel.attrs["data-ribbon-layout"]).toBe("vertical");
    const libSec = find(panel, e => e.attrs?.["data-sec"] === "library" && e.attrs?.["data-ribbon-hidden"] !== "true");
    expect(libSec).toBeDefined();
    expect(find(libSec, e => e.classList?.contains?.("library-bar-head"))).toBeDefined();
    expect(find(libSec, e => e.classList?.contains?.("library-bar-count"))?.textContent).toBe("0");
    expect(find(libSec, e => e.attrs?.["data-fk"] === "lib:save")).toBeDefined();
    expect(find(libSec, e => e.attrs?.["data-fk"] === "library:close")).toBeDefined();
    expect(find(libSec, e => e.classList?.contains?.("library-bar-list"))).toBeDefined();
    expect(find(libSec, e => e.classList?.contains?.("library-bar-foot"))).toBeDefined();
    expect(find(libSec, e => e.attrs?.["data-fk"] === "lib:pack:kubernetes")).toBeDefined();
    expect(find(libSec, e => e.attrs?.["data-fk"] === "lib:pack:cloud")).toBeDefined();

    // Draw a frame and switch to Frames tab -> dedicated vertical floating bar
    drawShape(S, "frame", 360, 100);
    step(20);
    find(topbar, e => e.attrs?.role === "tab" && e.attrs?.["data-tab"] === "frames").click();
    step(20);
    expect(panel.attrs["data-ribbon-layout"]).toBe("vertical");
    const framesSec = find(panel, e => e.attrs?.["data-sec"] === "frames" && e.attrs?.["data-ribbon-hidden"] !== "true");
    expect(framesSec).toBeDefined();
    expect(find(framesSec, e => e.classList?.contains?.("frames-bar-head"))).toBeDefined();
    expect(find(framesSec, e => e.classList?.contains?.("frames-bar-count"))?.textContent).toBe("1");
    expect(find(framesSec, e => e.attrs?.["data-fk"] === "frames:close")).toBeDefined();
    const framesList = find(framesSec, e => e.classList?.contains?.("frames-bar-list") && e.attrs?.role === "list");
    expect(framesList).toBeDefined();
    expect(findAll(framesList, e => e.classList?.contains?.("frame-row")).length).toBe(1);
    const framesFoot = find(framesSec, e => e.classList?.contains?.("frames-bar-foot"));
    expect(framesFoot).toBeDefined();
    expect(find(framesFoot, e => e.attrs?.["data-fk"] === "frames:prev")).toBeDefined();
    expect(find(framesFoot, e => e.attrs?.["data-fk"] === "frames:next")).toBeDefined();
    expect(find(framesFoot, e => e.attrs?.["data-fk"] === "frames:fit")).toBeDefined();

    // Switching back to Properties returns seamlessly to horizontal Word-style ribbon
    find(topbar, e => e.attrs?.role === "tab" && e.attrs?.["data-tab"] === "properties").click();
    step(20);
    expect(panel.attrs["data-ribbon-layout"]).toBe("horizontal");
  });

  test("escape hatches: clicking active expanded tab collapses, clicking another tab expands, and toggle button works", () => {
    const { S, step } = setup();
    const topbar = page.byId.topbar;
    const panel = page.byId.panel;

    drawShape(S, "rectangle", 120, 120);
    step(20);
    expect(panel.attrs["data-ribbon-expanded"]).toBe("true");

    // Clicking the already-active expanded tab (Properties) in Bar 1 collapses Bar 2
    const propTab = () => find(topbar, e => e.attrs?.role === "tab" && e.attrs?.["data-tab"] === "properties");
    propTab().click();
    step(20);
    expect(panel.attrs["data-ribbon-expanded"]).toBe("false");

    // Clicking Layers tab in Bar 1 expands Bar 2 to Layers (vertical layout)
    const layersTab = () => find(topbar, e => e.attrs?.role === "tab" && e.attrs?.["data-tab"] === "layers");
    layersTab().click();
    step(20);
    expect(panel.attrs["data-ribbon-expanded"]).toBe("true");
    expect(panel.attrs["data-ribbon-layout"]).toBe("vertical");
    expect(find(panel, e => e.attrs?.["data-sec"] === "layers" && e.attrs?.["data-ribbon-hidden"] !== "true")).toBeDefined();

    // Adding a layer in the vertical bar updates the count badge and enables move-down & delete
    find(panel, e => e.attrs?.["data-fk"] === "layers:add").click();
    step(20);
    expect(find(panel, e => e.classList?.contains?.("layers-bar-count"))?.textContent).toBe("2");
    expect(find(panel, e => e.attrs?.["data-fk"] === "layers:move-down")?.disabled).toBe(false);
    expect(find(panel, e => e.attrs?.["data-fk"] === "layers:delete")?.disabled).toBe(false);

    // Clicking the close button in the vertical Layers header collapses the bar
    find(panel, e => e.attrs?.["data-fk"] === "layers:close").click();
    step(20);
    expect(panel.attrs["data-ribbon-expanded"]).toBe("false");

    // Re-open Layers via tab, then test Bar 1 toggle button focus preservation
    layersTab().click();
    step(20);
    expect(panel.attrs["data-ribbon-expanded"]).toBe("true");
    expect(panel.attrs["data-ribbon-layout"]).toBe("vertical");

    // Clicking the collapse toggle button in Bar 1 collapses it and preserves focus
    const toggle = () => find(topbar, e => e.attrs?.["data-ribbon-toggle"] === "1");
    toggle().focus();
    toggle().click();
    step(20);
    expect(panel.attrs["data-ribbon-expanded"]).toBe("false");
    expect(page.doc.activeElement).toBe(toggle());

    // Clicking the expand toggle button expands it again (back to vertical Layers)
    toggle().click();
    step(20);
    expect(panel.attrs["data-ribbon-expanded"]).toBe("true");
    expect(panel.attrs["data-ribbon-layout"]).toBe("vertical");
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
