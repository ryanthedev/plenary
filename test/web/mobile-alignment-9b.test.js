// Wave 9B regression tests: Desktop-only Keybindings gating on coarse-pointer phone viewports (<= 768px),
// mobile-friendly Views & Versions sheets (data-mobile-sheet="1", 44px touch targets, 16px inputs, ARIA labels,
// 1-tap Show all layers & quick Solo), and mobile Style/Inspector sheet controls (Arrange, Effects, Icon Packs).
import { describe, test, expect, afterAll } from "bun:test";
import { installPage, restoreGlobals } from "./stub-page.js";
import { sanitizeSettings } from "../../web/core/settings.js";
import { createSettingsDialog, isPhoneTouchViewport } from "../../web/adapters/dom/settings-dialog.js";
import { createViewsMenu } from "../../web/adapters/dom/views-menu.js";
import { createVersionsDialog } from "../../web/adapters/dom/versions-dialog.js";
import { renderPanel } from "../../web/adapters/dom/panel.js";
import { h } from "../../web/adapters/dom/dom.js";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { makeElement } from "../../packages/core/model.js";
import { defaultPanel } from "../../packages/core/panel.js";

afterAll(restoreGlobals);

const find = (root, pred) => root.all().find(pred);
const findAll = (root, pred) => root.all().filter(pred);
const flushMicrotasks = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function makeWin(matchesPhone) {
  return {
    matchMedia: q => ({
      matches: q === "(pointer: coarse) and (max-width: 768px)" ? matchesPhone : false,
    }),
  };
}

describe("Wave 9B: isPhoneTouchViewport helper", () => {
  test("returns true only when coarse-pointer <= 768px matches, and safely guards missing/throwing matchMedia", () => {
    expect(isPhoneTouchViewport(makeWin(true))).toBe(true);
    expect(isPhoneTouchViewport(makeWin(false))).toBe(false);
    expect(isPhoneTouchViewport({})).toBe(false);
    expect(isPhoneTouchViewport(null)).toBe(false);
    expect(isPhoneTouchViewport({ matchMedia() { throw new Error("boom"); } })).toBe(false);
  });
});

describe("Wave 9B: Desktop-only Keybindings gating in settings-dialog.js", () => {
  test("hides Keybindings tab & Alt+1..9 binds on phone touch viewports (<= 768px) while keeping 44px/16px Preferences", () => {
    const page = installPage();
    let cur = sanitizeSettings(null);
    const dlg = createSettingsDialog({
      host: page.doc.body,
      doc: page.doc,
      win: makeWin(true),
      getSettings: () => cur,
      getTargets: () => ({ frames: [{ id: "f1", name: "Intro" }], views: [] }),
      onChange: next => { cur = next; },
      onReset: () => { cur = sanitizeSettings(null); return cur; },
    });

    // Even if explicitly opened with tab: "keybindings", phone touch viewport stays on Preferences
    const modal = dlg.open({ tab: "keybindings" });
    expect(modal.attrs["data-mobile-sheet"]).toBe("1");
    expect(modal.attrs["data-phone-touch"]).toBe("1");
    expect(modal.textContent).not.toContain("Settings & keybindings");

    // Keybindings tab and panel are completely hidden/absent
    const tabsHost = find(modal, e => e.classList.contains("settings-tabs"));
    expect(tabsHost.hidden).toBe(true);
    expect(find(modal, e => e.attrs["data-settings-tab"] === "keybindings")).toBeUndefined();
    expect(find(modal, e => e.attrs["data-frame-bind-slot"])).toBeUndefined();
    expect(find(modal, e => e.classList.contains("settings-search"))).toBeUndefined();

    // Preferences controls (Theme, Grid, Stroke style) are rendered with >= 44px targets & >= 16px font
    const darkChip = find(modal, e => e.attrs["data-pref-theme"] === "dark");
    const gridSwitch = find(modal, e => e.attrs["data-pref-grid"] === "1");
    const cleanChip = find(modal, e => e.attrs["data-pref-rough"] === "0");
    const resetBtn = find(modal, e => e.attrs["data-action"] === "reset-settings");
    const doneBtn = find(modal, e => e.attrs["data-action"] === "close-settings");
    expect(darkChip).toBeTruthy();
    expect(gridSwitch).toBeTruthy();
    expect(cleanChip).toBeTruthy();

    for (const ctrl of [darkChip, gridSwitch, cleanChip, resetBtn, doneBtn]) {
      expect(ctrl.attrs["aria-label"]).toBeTruthy();
      expect(parseFloat(ctrl.style.minHeight)).toBeGreaterThanOrEqual(44);
      expect(parseFloat(ctrl.style.fontSize)).toBeGreaterThanOrEqual(16);
    }

    // Interacting with Preferences works cleanly
    darkChip.click();
    expect(cur.defaultTheme).toBe("dark");
    find(modal, e => e.attrs["data-pref-grid"] === "1").click();
    expect(cur.gridDefault).toBe(true);
    find(modal, e => e.attrs["data-pref-rough"] === "0").click();
    expect(cur.roughDefault).toBe(0);

    dlg.close();
  });

  test("keeps full Preferences + Keybindings tabs on desktop / fine-pointer viewports and adapts on refresh()", () => {
    const page = installPage();
    let phoneMode = false;
    let cur = sanitizeSettings(null);
    const dlg = createSettingsDialog({
      host: page.doc.body,
      doc: page.doc,
      win: { matchMedia: q => ({ matches: q === "(pointer: coarse) and (max-width: 768px)" ? phoneMode : false }) },
      getSettings: () => cur,
      getTargets: () => ({ frames: [{ id: "f1", name: "Overview" }], views: [] }),
      onChange: next => { cur = next; },
      onReset: () => { cur = sanitizeSettings(null); return cur; },
    });

    const modal = dlg.open({ tab: "keybindings" });
    expect(modal.attrs["data-mobile-sheet"]).toBe("1");
    expect(modal.attrs["data-phone-touch"]).toBeUndefined();
    const tabsHost = find(modal, e => e.classList.contains("settings-tabs"));
    expect(tabsHost.hidden).toBe(false);
    expect(find(modal, e => e.attrs["data-settings-tab"] === "preferences")).toBeTruthy();
    expect(find(modal, e => e.attrs["data-settings-tab"] === "keybindings")).toBeTruthy();
    expect(find(modal, e => e.attrs["data-frame-bind-slot"] === "Alt+1")).toBeTruthy();

    // Transitioning to phone viewport via refresh() collapses Keybindings back to Preferences
    phoneMode = true;
    dlg.refresh();
    expect(tabsHost.hidden).toBe(true);
    expect(find(modal, e => e.attrs["data-settings-tab"] === "keybindings")).toBeUndefined();
    expect(find(modal, e => e.attrs["data-pref-theme"] === "dark")).toBeTruthy();

    dlg.close();
  });
});

describe("Wave 9B: Mobile-friendly Views & Versions sheets", () => {
  test("views-menu.js renders data-mobile-sheet, 16px inputs, 44px targets, ARIA labels, 1-tap Show all layers, and quick Solo", () => {
    const page = installPage();
    let soloId = null;
    let resetCount = 0;
    let savedName = null;
    let deletedId = null;
    let stepped = 0;

    const menu = createViewsMenu({
      host: page.doc.body,
      doc: page.doc,
      win: makeWin(true),
      getState: () => ({
        frames: [
          { id: "f1", name: "Architecture", rawName: "Architecture", index: 0, layerId: "layer-arch", bounds: { x: 0, y: 0, w: 600, h: 400 } },
        ],
        views: [
          { id: "v1", name: "Auth Flow", frameId: "f1", visibleLayers: ["layer-arch"] },
          { id: "v2", name: "Data Flow", frameId: null, visibleLayers: null },
        ],
        activeFrameId: "f1",
        localView: {
          active: Boolean(soloId),
          mode: soloId ? "solo" : "board",
          soloLayerId: soloId,
          activeViewId: null,
          activeViewName: null,
          layers: [
            { id: "base", name: "Base", visible: true, locked: false, effectiveVisible: !soloId || soloId === "base", solo: soloId === "base" },
            { id: "layer-arch", name: "Arch", visible: true, locked: false, effectiveVisible: !soloId || soloId === "layer-arch", solo: soloId === "layer-arch" },
          ],
          visibleIds: new Set(soloId ? [soloId] : ["base", "layer-arch"]),
          filter: soloId ? id => id === soloId : null,
        },
        canSave: true,
      }),
      onJumpFrame: () => {},
      onSelectView: () => {},
      onStepView: d => { stepped += d; },
      onSaveView: name => { savedName = name; },
      onDeleteView: id => { deletedId = id; },
      onResetLocalView: () => { soloId = null; resetCount++; },
      onSoloLayer: id => { soloId = soloId === id ? null : id; },
    });

    menu.open();
    const modal = find(page.doc.body, e => e.classList.contains("views-modal"));
    expect(modal).toBeTruthy();
    expect(modal.attrs["data-mobile-sheet"]).toBe("1");
    expect(modal.attrs["data-phone-touch"]).toBe("1");
    // Desktop keyboard badge ⌘J is hidden on phone touch viewport
    expect(find(modal, e => e.classList.contains("views-kbd"))).toBeUndefined();

    // Inputs use 16px-safe sizing and 44px touch height
    const search = find(modal, e => e.classList.contains("views-search"));
    const saveInput = find(modal, e => e.classList.contains("views-save-input"));
    expect(parseFloat(search.style.fontSize)).toBeGreaterThanOrEqual(16);
    expect(parseFloat(search.style.minHeight)).toBeGreaterThanOrEqual(44);
    expect(parseFloat(saveInput.style.fontSize)).toBeGreaterThanOrEqual(16);
    expect(parseFloat(saveInput.style.minHeight)).toBeGreaterThanOrEqual(44);

    // Interactive buttons have clean ARIA labels & >= 44px min-height
    const saveBtn = find(modal, e => e.attrs["data-action"] === "save-view");
    const prevBtn = find(modal, e => e.attrs["data-step-view"] === "-1");
    const nextBtn = find(modal, e => e.attrs["data-step-view"] === "1");
    const delBtn = find(modal, e => e.attrs["data-delete-view"] === "v1");
    const closeBtn = find(modal, e => e.attrs["aria-label"] === "Close views navigator");
    const soloChip = find(modal, e => e.classList.contains("views-solo-chip") && e.attrs["data-solo-layer"] === "layer-arch");
    const listbox = find(modal, e => e.attrs.role === "listbox");

    // Quick Solo controls live outside role="listbox" so WAI-ARIA combobox/listbox semantics stay pure
    expect(listbox.contains(soloChip)).toBe(false);
    expect(find(listbox, e => e.attrs["data-action"] === "solo-layer")).toBeUndefined();

    for (const btn of [saveBtn, prevBtn, nextBtn, delBtn, closeBtn, soloChip]) {
      expect(btn).toBeTruthy();
      expect(btn.attrs["aria-label"]).toBeTruthy();
      expect(parseFloat(btn.style.minHeight)).toBeGreaterThanOrEqual(44);
    }

    // Quick Solo triggers onSoloLayer and surfaces 1-tap "Show all layers" button
    expect(find(modal, e => e.attrs["data-action"] === "reset-local-layers")).toBeUndefined();
    soloChip.click();
    expect(soloId).toBe("layer-arch");
    const showAllBtn = find(modal, e => e.attrs["data-action"] === "reset-local-layers");
    expect(showAllBtn).toBeTruthy();
    expect(showAllBtn.attrs["aria-label"]).toBe("Show all layers");
    expect(parseFloat(showAllBtn.style.minHeight)).toBeGreaterThanOrEqual(44);

    // 1-tap "Show all layers" clears local solo filter
    showAllBtn.click();
    expect(resetCount).toBe(1);
    expect(soloId).toBeNull();
    expect(find(modal, e => e.attrs["data-action"] === "reset-local-layers")).toBeUndefined();

    // Step, save, and delete actions still work cleanly
    nextBtn.click();
    expect(stepped).toBe(1);
    saveInput.value = "Mobile Scene";
    saveBtn.click();
    expect(savedName).toBe("Mobile Scene");
    find(modal, e => e.attrs["data-delete-view"] === "v1").click();
    expect(deletedId).toBe("v1");

    menu.close();
  });

  test("versions-dialog.js renders data-mobile-sheet, 16px snapshot input, 44px buttons, and ARIA labels on phone", async () => {
    const page = installPage();
    let list = [
      { id: "v1", label: "Initial Draft", createdBy: "ada", createdByName: "Ada", createdAt: 1_700_000_000_000, elementCount: 4 },
    ];
    let restored = null;
    const versions = {
      async list() { return { versions: list }; },
      async create(_b, { label }) {
        const v = { id: "v2", label, createdBy: "ada", createdByName: "Ada", createdAt: 1_700_000_005_000, elementCount: 5 };
        list = [v, ...list];
        return { version: v };
      },
      async get(_b, id) {
        const hit = list.find(x => x.id === id);
        return hit ? { version: { ...hit, snapshot: { elements: [], appState: {}, files: {} } } } : { error: "notfound" };
      },
      async remove(_b, id) {
        list = list.filter(x => x.id !== id);
        return { ok: true };
      },
    };

    const dlg = createVersionsDialog({
      host: page.doc.body,
      doc: page.doc,
      win: makeWin(true),
      board: "b1",
      versions,
      clock: { now: () => 1_700_000_010_000 },
      canWrite: () => true,
      getSnapshot: () => ({ elements: [], appState: {}, files: {} }),
      onRestore: v => { restored = v.id; return true; },
    });

    dlg.open();
    await flushMicrotasks();

    const modal = find(page.doc.body, e => e.classList.contains("versions-modal"));
    expect(modal).toBeTruthy();
    expect(modal.attrs["data-mobile-sheet"]).toBe("1");
    expect(modal.attrs["data-phone-touch"]).toBe("1");

    const input = find(modal, e => e.attrs["data-version-label"] === "1");
    expect(input.classList.contains("field")).toBe(true);
    expect(parseFloat(input.style.fontSize)).toBeGreaterThanOrEqual(16);
    expect(parseFloat(input.style.minHeight)).toBeGreaterThanOrEqual(44);

    const saveBtn = find(modal, e => e.attrs["data-action"] === "save-version");
    const restoreBtn = find(modal, e => e.attrs["data-action"] === "restore-version");
    const deleteBtn = find(modal, e => e.attrs["data-action"] === "delete-version");
    const closeFooterBtn = find(modal, e => e.attrs["data-action"] === "close-versions");

    for (const btn of [saveBtn, restoreBtn, deleteBtn, closeFooterBtn]) {
      expect(btn).toBeTruthy();
      expect(btn.attrs["aria-label"]).toBeTruthy();
      expect(parseFloat(btn.style.minHeight)).toBeGreaterThanOrEqual(44);
    }

    // Restore works cleanly on phone
    restoreBtn.click();
    await flushMicrotasks();
    expect(restored).toBe("v1");
    expect(dlg.isOpen()).toBe(false);
  });
});

describe("Wave 9B: Mobile-friendly Inspector controls in panel.js", () => {
  function setupSessionWithRects() {
    const page = installPage();
    const net = localRoom({ board: "p9b", users: { "t-ada": { user: "ada", role: "owner" } }, clock: true });
    const S = createSession({ join: () => net.join(), token: "t-ada", board: "p9b", client: "ada", user: "ada", clock: net.clock });
    while (net.step());
    S.setSize(375, 667);
    let ids = [];
    S.act("board", e => {
      ids = e.insertElements([
        makeElement("rectangle", { x: 20, y: 20, width: 60, height: 40 }),
        makeElement("rectangle", { x: 140, y: 50, width: 60, height: 40 }),
        makeElement("rectangle", { x: 260, y: 30, width: 60, height: 40 }),
      ]);
      e.select(ids);
    });
    while (net.step());
    return { page, S, ids };
  }

  test("Arrange (Align/Distribute/Tidy), Effects (Blend/Clip selects), and Icon Packs render mobile-safe inside sheet", () => {
    const { S } = setupSessionWithRects();
    let library = [];
    let state = { ...defaultPanel(), mode: "tabs", tab: "properties" };
    const mount = () => {
      const container = h("div.sheet-body");
      container.append(...renderPanel(null, {
        session: S,
        state,
        h,
        inSheet: true,
        win: makeWin(true),
        library,
        setLibrary: next => { library = next; },
        setState: op => { if (op.type === "tab") state = { ...state, tab: op.id }; },
        onChange: () => {},
      }));
      return container;
    };

    // 1) Properties tab -> Effects selects
    const propsRoot = mount();
    const tabList = find(propsRoot, e => e.attrs.role === "tablist");
    expect(tabList).toBeTruthy();
    const blendSel = find(propsRoot, e => e.attrs["data-effect"] === "blendMode");
    const clipSel = find(propsRoot, e => e.attrs["data-effect"] === "clipShape");
    expect(blendSel).toBeTruthy();
    expect(clipSel).toBeTruthy();
    for (const sel of [blendSel, clipSel]) {
      expect(sel.classList.contains("field")).toBe(true);
      expect(sel.attrs["aria-label"]).toBeTruthy();
      expect(parseFloat(sel.style.fontSize)).toBeGreaterThanOrEqual(16);
      expect(parseFloat(sel.style.minHeight)).toBeGreaterThanOrEqual(44);
      expect(sel.style.maxWidth).toBe("100%");
    }

    // 2) Arrange tab -> Align (6), Distribute (2), Tidy (1)
    state = { ...state, tab: "arrange" };
    const arrangeRoot = mount();
    const arrangeBtns = [
      ...findAll(arrangeRoot, e => Boolean(e.attrs["data-align"])),
      ...findAll(arrangeRoot, e => Boolean(e.attrs["data-distribute"])),
      find(arrangeRoot, e => e.attrs["data-action"] === "tidy"),
    ];
    expect(arrangeBtns.length).toBe(9);
    for (const btn of arrangeBtns) {
      expect(btn).toBeTruthy();
      expect(btn.attrs["aria-label"]).toBeTruthy();
      expect(parseFloat(btn.style.minHeight)).toBeGreaterThanOrEqual(44);
      expect(parseFloat(btn.style.minWidth)).toBeGreaterThanOrEqual(44);
      expect(btn.style.maxWidth).toBe("100%");
    }

    // 3) Library tab -> Kubernetes & Cloud Icon Packs
    state = { ...state, tab: "library" };
    const libRoot = mount();
    const k8sBtn = find(libRoot, e => e.attrs["data-icon-pack"] === "kubernetes");
    const cloudBtn = find(libRoot, e => e.attrs["data-icon-pack"] === "cloud");
    for (const btn of [k8sBtn, cloudBtn]) {
      expect(btn).toBeTruthy();
      expect(btn.attrs["aria-label"]).toBeTruthy();
      expect(parseFloat(btn.style.minHeight)).toBeGreaterThanOrEqual(44);
      expect(parseFloat(btn.style.minWidth)).toBeGreaterThanOrEqual(44);
      expect(btn.style.maxWidth).toBe("100%");
    }
    k8sBtn.click();
    expect(library.length).toBeGreaterThan(0);
    const countAfterK8s = library.length;
    const libRoot2 = mount();
    find(libRoot2, e => e.attrs["data-icon-pack"] === "cloud").click();
    expect(library.length).toBeGreaterThan(countAfterK8s);
  });
});
