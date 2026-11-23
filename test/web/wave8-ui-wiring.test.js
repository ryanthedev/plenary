// Focused UI wiring tests for Wave 8:
// - #3 Align, Distribute & Tidy UI (Inspector panel + Canvas context menu)
// - #117 Blend Modes & Clipping Masks UI (Inspector panel Effects section)
// - #19 Version History Modal (list, save snapshot, restore, delete, viewer read-only, a11y overlay stack)
// - #21 .drawio Drag-Drop & File Import
// - #2 1-Click Cloud & Kubernetes Icon Packs (idempotent install + insert)
import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { hasActiveOverlay } from "../../web/adapters/dom/a11y.js";
import { mountApp } from "../../web/adapters/dom/app.js";
import { BLEND_MODES, CLIP_SHAPES } from "../../packages/core/effects.js";
import { getIconPack } from "../../packages/core/icon-packs.js";
import { installPage, stub, restoreGlobals } from "./stub-page.js";

afterAll(restoreGlobals);

const USERS = {
  "t-ada": { user: "ada", role: "owner" },
  "t-vi": { user: "vi", role: "viewer" },
};

const SAMPLE_DRAWIO = `<mxfile host="app.diagrams.net">
  <diagram id="d1" name="Architecture">
    <mxGraphModel>
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="2" value="API" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="40" y="40" width="120" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="3" value="DB" style="ellipse;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="260" y="40" width="100" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="4" value="" style="endArrow=classic;html=1;" edge="1" parent="1" source="2" target="3">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

function makeFakeVersions(initial = []) {
  /** @type {any[]} */
  let store = initial.map(v => ({ ...v }));
  let seq = 100;
  return {
    store: () => store,
    async list(_board) {
      return {
        versions: store.map(({ snapshot: _s, ...meta }) => meta),
      };
    },
    async create(_board, { label, snapshot }) {
      const id = `v-${++seq}`;
      const liveCount = Array.isArray(snapshot?.elements)
        ? snapshot.elements.filter(e => e && !e.isDeleted).length
        : 0;
      const entry = {
        id,
        label,
        createdBy: "ada",
        createdByName: "Ada",
        createdAt: 1_700_000_000_000 + seq * 1000,
        elementCount: liveCount,
        snapshot: JSON.parse(JSON.stringify(snapshot)),
      };
      store.unshift(entry);
      const { snapshot: _s, ...meta } = entry;
      return { version: meta };
    },
    async get(_board, versionId) {
      const hit = store.find(v => v.id === versionId);
      if (!hit) return { error: "notfound" };
      return { version: JSON.parse(JSON.stringify(hit)) };
    },
    async remove(_board, versionId) {
      const before = store.length;
      store = store.filter(v => v.id !== versionId);
      if (store.length === before) return { error: "notfound" };
      return { ok: true };
    },
  };
}

function setup({ token = "t-ada", versions = null } = {}) {
  const page = installPage();
  const net = localRoom({ board: "w8-board", users: USERS, clock: true });
  const app = mountApp({
    startSession: ({ mine, onChange }) => createSession({
      join: () => net.join(),
      token,
      board: "w8-board",
      client: USERS[token].user,
      user: USERS[token].user,
      mine,
      onChange,
      clock: net.clock,
    }),
    net: { kind: "local", put() {}, onFile() {} },
    board: "w8-board",
    me: { user: USERS[token].user, name: token === "t-ada" ? "Ada" : "Vi", role: null },
    prefs: memoryStore(),
    theme: "light",
    clock: net.clock,
    versions,
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
const flushMicrotasks = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

describe("Wave 8 Final UI Wiring", () => {
  test("#3 Inspector Align, Distribute & Tidy controls and Context Menu Tidy selection", () => {
    const { page, S, step } = setup();
    drawRect(S, 100, 100, 80, 60);
    drawRect(S, 260, 140, 80, 60);
    drawRect(S, 500, 115, 80, 60);
    step(2);

    const els = S.eds.board.doc.live().filter(e => e.type === "rectangle");
    expect(els.length).toBe(3);

    // 1 selected: Align / Distribute / Tidy controls are hidden
    S.act("board", e => e.select([els[0].id]));
    step(20);
    expect(find(page.byId.panel, e => e.attrs["data-align"] === "left")).toBeUndefined();
    expect(find(page.byId.panel, e => e.attrs["data-action"] === "tidy")).toBeUndefined();
    expect(find(page.byId.panel, e => e.attrs["data-distribute"] === "h")).toBeUndefined();

    // 2 selected: Align (6 modes) + Tidy shown; Distribute hidden
    S.act("board", e => e.select([els[0].id, els[1].id]));
    step(20);
    const alignBtns = findAll(page.byId.panel, e => Boolean(e.attrs["data-align"]));
    expect(alignBtns.map(b => b.attrs["data-align"])).toEqual(["left", "hcenter", "right", "top", "vcenter", "bottom"]);
    expect(find(page.byId.panel, e => e.attrs["data-action"] === "tidy")).toBeTruthy();
    expect(find(page.byId.panel, e => e.attrs["data-distribute"] === "h")).toBeUndefined();

    // Clicking Align Top aligns both to the same y
    find(page.byId.panel, e => e.attrs["data-align"] === "top").click();
    step(20);
    expect(S.eds.board.doc.get(els[0].id).y).toBe(S.eds.board.doc.get(els[1].id).y);

    // 3 selected: Distribute Horizontal & Vertical appear
    S.act("board", e => e.select(els.map(x => x.id)));
    step(20);
    const distH = find(page.byId.panel, e => e.attrs["data-distribute"] === "h");
    const distV = find(page.byId.panel, e => e.attrs["data-distribute"] === "v");
    expect(distH).toBeTruthy();
    expect(distV).toBeTruthy();

    // Clicking Distribute Horizontal equalizes horizontal gaps
    distH.click();
    step(2);
    const afterDist = els.map(e => S.eds.board.doc.get(e.id)).sort((a, b) => a.x - b.x);
    const gap1 = afterDist[1].x - (afterDist[0].x + afterDist[0].width);
    const gap2 = afterDist[2].x - (afterDist[1].x + afterDist[1].width);
    expect(Math.abs(gap1 - gap2)).toBeLessThan(1);

    // Context menu shows "Tidy selection" when >= 2 unlocked elements are selected
    const p = S.eds.board.toScreen({ x: afterDist[0].x + 10, y: afterDist[0].y + 10 });
    page.board.fire("contextmenu", { clientX: p.x, clientY: p.y, button: 2 });
    const menu = find(page.doc.body, e => e.classList.contains("ctx-menu"));
    const tidyItem = find(menu, e => e.attrs["data-ctx-id"] === "tidy");
    expect(tidyItem).toBeTruthy();
    expect(tidyItem.textContent).toContain("Tidy selection");
    tidyItem.click();
    step(2);
    // After tidy, all 3 elements sit on the same neat row with uniform 24px gap
    const tidied = els.map(e => S.eds.board.doc.get(e.id)).sort((a, b) => a.x - b.x);
    expect(tidied[0].y).toBe(tidied[1].y);
    expect(tidied[1].y).toBe(tidied[2].y);
    expect(Math.round(tidied[1].x - (tidied[0].x + tidied[0].width))).toBe(24);

    // Locking 2 of the 3 leaves only 1 unlocked → "Tidy selection" is omitted from context menu
    S.act("board", ed => ed.transact(tx => {
      tx.get(els[0].id).locked = true;
      tx.get(els[1].id).locked = true;
    }));
    step(2);
    const p2 = S.eds.board.toScreen({ x: tidied[0].x + 10, y: tidied[0].y + 10 });
    page.board.fire("contextmenu", { clientX: p2.x, clientY: p2.y, button: 2 });
    const menu2 = find(page.doc.body, e => e.classList.contains("ctx-menu"));
    expect(find(menu2, e => e.attrs["data-ctx-id"] === "tidy")).toBeUndefined();
  });

  test("#117 Inspector Effects section updates validated blendMode and clipShape via S.act", () => {
    const { page, S, step } = setup();
    // No selection: Effects section hidden
    expect(find(page.byId.panel, e => e.attrs["data-effects"] === "1")).toBeUndefined();

    drawRect(S, 120, 120, 100, 80);
    step(2);
    const el = S.eds.board.doc.live().find(e => e.type === "rectangle");
    const origLayer = el.customData.layer;
    const origZ = el.customData.z;

    const blendSel = find(page.byId.panel, e => e.attrs["data-effect"] === "blendMode");
    const clipSel = find(page.byId.panel, e => e.attrs["data-effect"] === "clipShape");
    expect(blendSel).toBeTruthy();
    expect(clipSel).toBeTruthy();
    expect(findAll(blendSel, e => e.tagName === "OPTION").map(o => o.value)).toEqual([...BLEND_MODES]);
    expect(findAll(clipSel, e => e.tagName === "OPTION").map(o => o.value)).toEqual([...CLIP_SHAPES]);

    // Change blend mode to multiply
    blendSel.value = "multiply";
    blendSel.fire("change");
    step(2);
    let updated = S.eds.board.doc.get(el.id);
    expect(updated.customData.effects).toEqual({ blendMode: "multiply", clipShape: "none" });
    expect(updated.customData.layer).toBe(origLayer);
    expect(updated.customData.z).toBe(origZ);

    // Change mask / clip shape to ellipse
    const clipSel2 = find(page.byId.panel, e => e.attrs["data-effect"] === "clipShape");
    clipSel2.value = "ellipse";
    clipSel2.fire("change");
    step(2);
    updated = S.eds.board.doc.get(el.id);
    expect(updated.customData.effects).toEqual({ blendMode: "multiply", clipShape: "ellipse" });
  });

  test("#19 Version History modal: list, save snapshot, restore elements + herdr, delete, and viewer read-only", async () => {
    const versions = makeFakeVersions();
    const { page, S, step } = setup({ versions });

    // Board menu contains "Version history…"
    const vhMenuBtn = find(page.byId.topbar, e => e.attrs.role === "menuitem" && e.attrs["aria-label"] === "Version history");
    expect(vhMenuBtn).toBeTruthy();
    expect(vhMenuBtn.textContent).toContain("Version history");

    // Draw initial shape + enable grid, then open Version History and save snapshot "v1"
    drawRect(S, 100, 100, 90, 70);
    S.act("board", ed => ed.setAppState({ grid: 20 }), { settings: true });
    step(2);
    const rect1Id = S.eds.board.doc.live().find(e => e.type === "rectangle").id;

    vhMenuBtn.click();
    await flushMicrotasks();
    expect(hasActiveOverlay(page.doc)).toBe(true);
    const modal = find(page.doc.body, e => e.classList.contains("versions-modal"));
    expect(modal).toBeTruthy();

    const labelInput = find(modal, e => e.attrs["data-version-label"] === "1");
    const saveBtn = find(modal, e => e.attrs["data-action"] === "save-version");
    expect(labelInput).toBeTruthy();
    expect(saveBtn).toBeTruthy();

    labelInput.value = "Milestone v1";
    labelInput.fire("input");
    saveBtn.click();
    await flushMicrotasks();
    step(2);

    expect(versions.store().length).toBe(1);
    expect(modal.textContent).toContain("Milestone v1");
    expect(modal.textContent).toContain("Ada");
    expect(modal.textContent).toContain("1 element");
    expect(page.byId.toast.textContent).toContain("Saved version: Milestone v1");

    // Close via Escape
    page.doc.fire("keydown", { key: "Escape" });
    expect(hasActiveOverlay(page.doc)).toBe(false);
    expect(find(page.doc.body, e => e.classList.contains("versions-modal"))).toBeUndefined();

    // Mutate board: add a second rect and turn grid off
    drawRect(S, 320, 220, 80, 60);
    S.act("board", ed => ed.setAppState({ grid: 0 }), { settings: true });
    step(2);
    expect(S.eds.board.doc.live().length).toBe(2);
    expect(S.eds.board.grid).toBe(0);

    // Re-open modal and click Restore on "Milestone v1"
    find(page.byId.topbar, e => e.attrs.role === "menuitem" && e.attrs["aria-label"] === "Version history").click();
    await flushMicrotasks();
    const modal2 = find(page.doc.body, e => e.classList.contains("versions-modal"));
    const restoreBtn = find(modal2, e => e.attrs["data-action"] === "restore-version");
    expect(restoreBtn).toBeTruthy();
    restoreBtn.click();
    await flushMicrotasks();
    step(2);

    // Board restored to 1 element (rect1Id) and grid=20, with toast
    expect(S.eds.board.doc.live().map(e => e.id)).toEqual([rect1Id]);
    expect(S.eds.board.grid).toBe(20);
    expect(page.byId.toast.textContent).toContain("Restored version: Milestone v1");

    // Re-open and Delete "Milestone v1"
    find(page.byId.topbar, e => e.attrs.role === "menuitem" && e.attrs["aria-label"] === "Version history").click();
    await flushMicrotasks();
    const modal3 = find(page.doc.body, e => e.classList.contains("versions-modal"));
    const deleteBtn = find(modal3, e => e.attrs["data-action"] === "delete-version");
    expect(deleteBtn).toBeTruthy();
    deleteBtn.click();
    await flushMicrotasks();
    step(2);
    expect(versions.store().length).toBe(0);
    expect(page.byId.toast.textContent).toContain("Deleted version: Milestone v1");
    page.doc.fire("keydown", { key: "Escape" });

    // Viewer role sees versions list but no Save / Restore / Delete buttons
    const vViewer = makeFakeVersions([{
      id: "v-1",
      label: "Published v1",
      createdBy: "ada",
      createdByName: "Ada",
      createdAt: 1_700_000_000_000,
      elementCount: 3,
      snapshot: { elements: [], appState: {}, files: {} },
    }]);
    const viewerRig = setup({ token: "t-vi", versions: vViewer });
    const viewerBtn = find(viewerRig.page.byId.topbar, e => e.attrs.role === "menuitem" && e.attrs["aria-label"] === "Version history");
    expect(viewerBtn).toBeTruthy();
    viewerBtn.click();
    await flushMicrotasks();
    const vModal = find(viewerRig.page.doc.body, e => e.classList.contains("versions-modal"));
    expect(vModal.textContent).toContain("Published v1");
    expect(find(vModal, e => e.attrs["data-action"] === "save-version")).toBeUndefined();
    expect(find(vModal, e => e.attrs["data-action"] === "restore-version")).toBeUndefined();
    expect(find(vModal, e => e.attrs["data-action"] === "delete-version")).toBeUndefined();
  });

  test("#19 Version History hardening: close/reopen race, malformed layers rejection, and clearing omitted grid on restore", async () => {
    let resolveDeferredGet;
    const deferredGet = new Promise(res => { resolveDeferredGet = res; });
    const versions = makeFakeVersions([
      {
        id: "v-slow",
        label: "Slow snapshot",
        createdBy: "ada",
        createdByName: "Ada",
        createdAt: 1_700_000_000_000,
        elementCount: 0,
        snapshot: { elements: [], appState: {}, files: {} },
      },
      {
        id: "v-bad",
        label: "Malformed layers",
        createdBy: "ada",
        createdByName: "Ada",
        createdAt: 1_700_000_001_000,
        elementCount: 0,
        snapshot: { elements: [], appState: { herdr: { layers: [null] } }, files: {} },
      },
      {
        id: "v-no-grid",
        label: "Before grid",
        createdBy: "ada",
        createdByName: "Ada",
        createdAt: 1_700_000_002_000,
        elementCount: 0,
        snapshot: { elements: [], appState: { herdr: {} }, files: {} },
      },
    ]);
    const origGet = versions.get.bind(versions);
    versions.get = async (board, id) => (id === "v-slow" ? deferredGet : origGet(board, id));

    const { page, S, step } = setup({ versions });
    drawRect(S, 100, 100, 80, 60);
    S.act("board", ed => ed.setAppState({ grid: 20 }), { settings: true });
    step(2);
    expect(S.eds.board.doc.live().length).toBe(1);
    expect(S.eds.board.grid).toBe(20);

    // 1. Start restore on v-slow, close dialog, reopen dialog, then resolve v-slow: must NOT apply!
    find(page.byId.topbar, e => e.attrs.role === "menuitem" && e.attrs["aria-label"] === "Version history").click();
    await flushMicrotasks();
    let modal = find(page.doc.body, e => e.classList.contains("versions-modal"));
    find(modal, e => e.attrs["data-action"] === "restore-version" && e.attrs["data-version-id"] === "v-slow").click();
    page.doc.fire("keydown", { key: "Escape" });
    find(page.byId.topbar, e => e.attrs.role === "menuitem" && e.attrs["aria-label"] === "Version history").click();
    await flushMicrotasks();
    resolveDeferredGet({
      version: {
        id: "v-slow",
        label: "Slow snapshot",
        createdBy: "ada",
        createdByName: "Ada",
        createdAt: 1_700_000_000_000,
        elementCount: 0,
        snapshot: { elements: [], appState: {}, files: {} },
      },
    });
    await flushMicrotasks();
    step(2);
    expect(S.eds.board.doc.live().length).toBe(1);

    // 2. Malformed snapshot (layers: [null]) is rejected cleanly without corrupting board
    modal = find(page.doc.body, e => e.classList.contains("versions-modal"));
    find(modal, e => e.attrs["data-action"] === "restore-version" && e.attrs["data-version-id"] === "v-bad").click();
    await flushMicrotasks();
    step(2);
    expect(S.eds.board.doc.live().length).toBe(1);
    expect(S.eds.board.doc.layers.every(l => l && typeof l.id === "string")).toBe(true);
    expect(modal.textContent).toContain("Couldn't restore that snapshot.");

    // 3. Restoring a snapshot that omits `grid` resets grid back to 0
    find(modal, e => e.attrs["data-action"] === "restore-version" && e.attrs["data-version-id"] === "v-no-grid").click();
    await flushMicrotasks();
    step(2);
    expect(S.eds.board.doc.live().length).toBe(0);
    expect(S.eds.board.grid).toBe(0);
  });

  test("#21 .drawio file picker accept attribute and drag-and-drop import with toast", async () => {
    const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
    expect(html).toMatch(/id="picker"[^>]*accept="[^"]*\.drawio[^"]*\.xml/);
    expect(html).toMatch(/id="picker"[^>]*accept="[^"]*\.excalidraw[^"]*\.json/);

    const { page, S, step } = setup();
    const fakeFile = {
      name: "service-mesh.drawio",
      size: SAMPLE_DRAWIO.length,
      type: "application/xml",
      async text() { return SAMPLE_DRAWIO; },
    };

    // Drag-and-drop .drawio onto #canvas
    page.byId.canvas.fire("drop", {
      clientX: 400,
      clientY: 300,
      dataTransfer: { files: [fakeFile] },
    });
    await flushMicrotasks();
    step(2);

    const live = S.eds.board.doc.live();
    expect(live.length).toBeGreaterThanOrEqual(3);
    expect(page.byId.toast.textContent).toMatch(/^Imported \d+ elements? from service-mesh\.drawio$/);

    // Picker change with .xml file also imports drawio
    const beforeCount = live.length;
    page.byId.picker.files = [{
      name: "diagram.xml",
      size: SAMPLE_DRAWIO.length,
      type: "text/xml",
      async text() { return SAMPLE_DRAWIO; },
    }];
    page.byId.picker.fire("change");
    await flushMicrotasks();
    step(2);

    expect(S.eds.board.doc.live().length).toBeGreaterThan(beforeCount);
    expect(page.byId.toast.textContent).toMatch(/^Imported \d+ elements? from diagram\.xml$/);
  });

  test("#2 1-click Kubernetes and Cloud icon pack install in Library without duplicates", () => {
    const { page, app, S, step } = setup();
    const k8sBtn = find(page.byId.panel, e => e.attrs["data-icon-pack"] === "kubernetes");
    const cloudBtn = find(page.byId.panel, e => e.attrs["data-icon-pack"] === "cloud");
    expect(k8sBtn).toBeTruthy();
    expect(cloudBtn).toBeTruthy();
    expect(k8sBtn.textContent).toContain("Kubernetes pack");
    expect(cloudBtn.textContent).toContain("Cloud pack");

    const k8sCount = getIconPack("kubernetes").icons.length;
    const cloudCount = getIconPack("cloud").icons.length;

    // Install Kubernetes pack
    k8sBtn.click();
    step(2);
    expect(app.ui.library.length).toBe(k8sCount);

    // Clicking again does NOT duplicate items
    find(page.byId.panel, e => e.attrs["data-icon-pack"] === "kubernetes").click();
    step(2);
    expect(app.ui.library.length).toBe(k8sCount);

    // Install Cloud pack
    find(page.byId.panel, e => e.attrs["data-icon-pack"] === "cloud").click();
    step(2);
    expect(app.ui.library.length).toBe(k8sCount + cloudCount);

    // Clicking Cloud pack again does NOT duplicate items
    find(page.byId.panel, e => e.attrs["data-icon-pack"] === "cloud").click();
    step(2);
    expect(app.ui.library.length).toBe(k8sCount + cloudCount);

    // Clicking an installed icon inserts it onto the board
    const podItem = find(page.byId.panel, e => e.classList.contains("item") && e.textContent.includes("Pod"));
    expect(podItem).toBeTruthy();
    podItem.click();
    step(2);
    expect(S.eds.board.doc.live().length).toBeGreaterThan(0);
  });
});
