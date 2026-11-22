// UI & multi-user isolation tests for Named Jump-to-Frame, Local Solo Layer & Named Presentation Views (#115).
import { test, expect, afterAll } from "bun:test";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { mountApp } from "../../web/adapters/dom/app.js";
import { hasActiveOverlay } from "../../web/adapters/dom/a11y.js";
import { viewsOf } from "../../packages/core/views.js";
import { makeElement, BASE_LAYER } from "../../packages/core/model.js";
import { installPage as install, stub, restoreGlobals } from "./stub-page.js";

let page;
const installPage = () => (page = install());
afterAll(restoreGlobals);

const USERS = {
  "t-ada": { user: "ada", role: "owner" },
  "t-bo": { user: "bo", role: "editor" },
  "t-vi": { user: "vi", role: "viewer" },
};

function setup({ token = "t-ada", role = null } = {}) {
  installPage();
  const net = localRoom({ users: USERS, clock: true });
  const bo = createSession({ join: () => net.join(), token: "t-bo", board: "b1", client: "bo", user: "bo", clock: net.clock });
  bo.setSize(1200, 800);
  const app = mountApp({
    startSession: ({ mine, onChange }) => createSession({
      join: () => net.join(),
      token,
      board: "b1",
      client: USERS[token].user,
      user: USERS[token].user,
      mine,
      onChange,
      clock: net.clock,
    }),
    net: { kind: "local", put() {}, onFile() {} },
    board: "b1",
    me: { user: USERS[token].user, name: "Ada", role },
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
  return { net, app, S: app.S, bo, step };
}

const find = (root, pred) => root.all().find(pred);
const findAll = (root, pred) => root.all().filter(pred);

function seedMultiLayerBoard(session) {
  session.act("board", e => {
    e.addLayer("Auth Overlay");
    e.addLayer("Failover Path");
  }, { settings: true });
  const layers = session.eds.board.doc.layers;
  const authId = layers.find(l => l.name === "Auth Overlay").id;
  const failId = layers.find(l => l.name === "Failover Path").id;

  let netFrameId = "", authFrameId = "", baseElId = "", authElId = "", failElId = "";
  session.act("board", e => {
    e.activeLayer = BASE_LAYER;
    [netFrameId, authFrameId, baseElId] = e.insertElements([
      makeElement("frame", { x: 0, y: 0, width: 600, height: 400, name: "Base Network" }),
      makeElement("frame", { x: 800, y: 0, width: 600, height: 400, name: "Auth Gateway" }),
      makeElement("rectangle", { x: 50, y: 50, width: 100, height: 60 }),
    ]);
    e.activeLayer = authId;
    [authElId] = e.insertElements([
      makeElement("rectangle", { x: 850, y: 50, width: 100, height: 60 }),
    ]);
    e.activeLayer = failId;
    [failElId] = e.insertElements([
      makeElement("rectangle", { x: 850, y: 150, width: 100, height: 60 }),
    ]);
    e.select([]);
  });
  return { baseId: BASE_LAYER, authId, failId, netFrameId, authFrameId, baseElId, authElId, failElId };
}

test("Solo Layer is strictly viewer-local: NEVER mutates appState.layers, sends 0 ops, and never hides layers for collaborators", () => {
  const { S, bo, step } = setup();
  const { authId, baseElId, authElId } = seedMultiLayerBoard(bo);
  step(20);

  const sharedBefore = JSON.stringify(S.eds.board.doc.appState.herdr.layers);
  const boVisibleBefore = bo.eds.board.doc.visible().map(e => e.id);
  const sentBefore = S.sent;

  // Click Solo on Auth Overlay in the Layers panel
  const soloBtn = find(page.byId.panel, e => e.attrs?.["data-solo-layer"] === authId);
  expect(soloBtn).toBeTruthy();
  soloBtn.click();
  step(3);

  // Ada sees ONLY Auth Overlay elements
  expect(S.eds.board.doc.visible().map(e => e.id)).toEqual([authElId]);
  // Shared appState.layers is 100% UNCHANGED and ZERO ops were sent!
  expect(JSON.stringify(S.eds.board.doc.appState.herdr.layers)).toBe(sharedBefore);
  expect(S.sent).toBe(sentBefore);
  // Collaborator Bo is 100% UNAFFECTED!
  expect(bo.eds.board.doc.visible().map(e => e.id)).toEqual(boVisibleBefore);
  expect(JSON.stringify(bo.eds.board.doc.appState.herdr.layers)).toBe(sharedBefore);

  // "Show all layers" reset pill appears in BOTH panel and HUD
  const panelReset = find(page.byId.panel, e => e.attrs?.["data-action"] === "reset-local-layers");
  const hudReset = find(page.byId.hudBL, e => e.attrs?.["data-action"] === "reset-local-layers");
  expect(panelReset).toBeTruthy();
  expect(hudReset).toBeTruthy();

  // Clicking reset pill restores full board visibility with 0 ops sent
  hudReset.click();
  step(3);
  expect(S.eds.board.doc.visible().map(e => e.id)).toContain(baseElId);
  expect(S.eds.board.doc.visible().map(e => e.id)).toContain(authElId);
  expect(S.sent).toBe(sentBefore);
  expect(find(page.byId.hudBL, e => e.attrs?.["data-action"] === "reset-local-layers")).toBeUndefined();
});

test("⌘J Quick Navigator: search, arrow-key + Enter jump to frame, overlay stack & Escape focus restore", () => {
  const { S, bo, step } = setup();
  const { authFrameId } = seedMultiLayerBoard(bo);
  step(5);

  // Focus the topbar Views pill and open via ⌘J
  const pill = find(page.byId.topbar, e => e.attrs?.["data-views-open"] === "1");
  expect(pill).toBeTruthy();
  pill.focus();

  page.doc.fire("keydown", { key: "j", metaKey: true, target: pill });
  step(2);

  expect(hasActiveOverlay(page.doc)).toBe(true);
  const modal = find(page.doc.body, e => e.classList?.contains("views-modal"));
  expect(modal).toBeTruthy();

  // Search filters frames case-insensitively
  const search = find(modal, e => e.classList?.contains("views-search"));
  expect(search).toBeTruthy();
  expect(page.doc.activeElement).toBe(search);

  search.value = "auth";
  search.fire("input");
  const frameItems = findAll(modal, e => e.attrs?.["data-views-item"]?.startsWith("frame:"));
  expect(frameItems.length).toBe(1);
  expect(frameItems[0].attrs["data-views-item"]).toBe(`frame:${authFrameId}`);

  // Enter activates the matching frame, closes modal, glides camera to authFrameId, and restores focus to live topbar pill
  search.fire("keydown", { key: "Enter" });
  step(2);
  expect(hasActiveOverlay(page.doc)).toBe(false);
  expect(S.eds.board.frameAt).toBe(authFrameId);
  expect(page.doc.activeElement?.attrs?.["data-views-open"]).toBe("1");
  expect(page.byId.topbar.contains(page.doc.activeElement)).toBe(true);

  // Reopen via live pill click and close via Escape on overlay stack
  const livePill = find(page.byId.topbar, e => e.attrs?.["data-views-open"] === "1");
  livePill.click();
  step(2);
  expect(hasActiveOverlay(page.doc)).toBe(true);
  page.doc.fire("keydown", { key: "Escape" });
  step(2);
  expect(hasActiveOverlay(page.doc)).toBe(false);
  expect(page.doc.activeElement).toBe(livePill);
  expect(page.byId.topbar.contains(livePill)).toBe(true);
});

test("Named Presentation Views: save via ⌘J modal to shared appState.herdr.views, sync to collaborator, and step with [ / ] locally", () => {
  const { S, bo, step } = setup();
  const { authId, failId, netFrameId, authFrameId, baseElId, authElId, failElId } = seedMultiLayerBoard(bo);
  step(20);

  const saveViaModal = name => {
    page.doc.fire("keydown", { key: "j", metaKey: true });
    step(2);
    const modal = find(page.doc.body, e => e.classList?.contains("views-modal"));
    const input = find(modal, e => e.classList?.contains("views-save-input"));
    const saveBtn = find(modal, e => e.attrs?.["data-action"] === "save-view");
    input.value = name;
    saveBtn.click();
    step(3);
    page.doc.fire("keydown", { key: "Escape" });
    step(2);
  };

  // Save View 1: Auth Gateway + Auth Overlay soloed
  S.goToFrame(authFrameId, { animate: false });
  find(page.byId.panel, e => e.attrs?.["data-solo-layer"] === authId).click();
  step(2);
  saveViaModal("Auth Scene");

  // Save View 2: jump to Base Network via ⌘J (works even while another layer is soloed!) + Failover Path soloed
  page.doc.fire("keydown", { key: "j", metaKey: true });
  step(2);
  find(page.doc.body, e => e.attrs?.["data-views-item"] === `frame:${netFrameId}`).click();
  step(2);
  find(page.byId.panel, e => e.attrs?.["data-solo-layer"] === failId).click();
  step(2);
  saveViaModal("Failover Scene");

  // Both views persisted cleanly with 0 settings refusals and synced to Bo!
  expect(S.settingsRefused).toEqual([]);
  expect(viewsOf(S.eds.board.doc).map(v => v.name)).toEqual(["Auth Scene", "Failover Scene"]);
  expect(viewsOf(bo.eds.board.doc).map(v => v.name)).toEqual(["Auth Scene", "Failover Scene"]);

  // Reset Ada's local view via HUD button, then step with ] and [ (no shapes selected)
  find(page.byId.hudBL, e => e.attrs?.["data-action"] === "reset-local-layers").click();
  step(2);
  const sentBefore = S.sent;
  const sharedLayersBefore = JSON.stringify(S.eds.board.doc.appState.herdr.layers);

  page.doc.fire("keydown", { key: "]" });
  step(3);
  expect(S.eds.board.frameAt).toBe(authFrameId);
  expect(S.eds.board.doc.visible().map(e => e.id)).toEqual([authElId]);

  page.doc.fire("keydown", { key: "]" });
  step(3);
  expect(S.eds.board.frameAt).toBe(netFrameId);
  expect(S.eds.board.doc.visible().map(e => e.id)).toEqual([failElId]);

  page.doc.fire("keydown", { key: "[" });
  step(3);
  expect(S.eds.board.frameAt).toBe(authFrameId);
  expect(S.eds.board.doc.visible().map(e => e.id)).toEqual([authElId]);

  // Stepping Views sent ZERO ops and NEVER mutated shared layers!
  expect(S.sent).toBe(sentBefore);
  expect(JSON.stringify(S.eds.board.doc.appState.herdr.layers)).toBe(sharedLayersBefore);
  expect(bo.eds.board.doc.visible().map(e => e.id)).toContain(baseElId);
});

test("Viewers can open ⌘J, jump to frames, and switch Named Views locally with 0 ops, while save/delete are hidden", () => {
  const { S, bo, step } = setup({ token: "t-vi", role: "viewer" });
  const { authId, authFrameId, authElId } = seedMultiLayerBoard(bo);
  bo.act("board", e => e.setAppState({
    views: [{ id: "v-auth", name: "Auth Only", frameId: authFrameId, visibleLayers: [authId] }],
  }), { settings: true });
  step(5);

  expect(S.role).toBe("viewer");
  const sentBefore = S.sent;

  // Open ⌘J as viewer
  page.doc.fire("keydown", { key: "j", metaKey: true });
  step(2);
  const modal = find(page.doc.body, e => e.classList?.contains("views-modal"));
  expect(modal).toBeTruthy();
  expect(find(modal, e => e.attrs?.["data-action"] === "save-view")).toBeUndefined();
  expect(find(modal, e => e.attrs?.["data-delete-view"])).toBeUndefined();

  // Click the saved view as viewer
  const viewBtn = find(modal, e => e.attrs?.["data-views-item"] === "view:v-auth");
  expect(viewBtn).toBeTruthy();
  viewBtn.click();
  step(3);

  expect(S.eds.board.frameAt).toBe(authFrameId);
  expect(S.eds.board.doc.visible().map(e => e.id)).toEqual([authElId]);
  expect(S.sent).toBe(sentBefore);
  expect(S.blocked).toBe(0);
});

test("Opus review regressions: drawing while soloed lands on soloed layer, HUD/PgDn frames work under solo, combobox aria-activedescendant & modal focus stay intact", () => {
  const { S, bo, step } = setup();
  const { authId, netFrameId, authFrameId } = seedMultiLayerBoard(bo);
  step(20);

  // Solo Auth Overlay: activeLayer switches to authId so drawing lands on the visible layer!
  find(page.byId.panel, e => e.attrs?.["data-solo-layer"] === authId).click();
  step(2);
  expect(S.eds.board.activeLayer).toBe(authId);

  // Draw a rectangle while soloed: it lands on authId and is immediately visible
  S.setTool("rectangle");
  S.pointerDown({ x: 100, y: 100 });
  S.pointerMove({ x: 180, y: 160 });
  S.pointerUp({ x: 180, y: 160 });
  step(2);
  const drawn = S.eds.board.doc.visible().find(e => e.type === "rectangle" && e.customData?.layer === authId && e.width >= 60);
  expect(drawn).toBeTruthy();

  // HUD frame counter and PgDn still work while soloed!
  const hudFrameCounter = () => find(page.byId.hudBL, e => e.className === "pct" && / \/ /.test(e.textContent)).textContent;
  expect(hudFrameCounter()).toBe("– / 2");
  page.doc.fire("keydown", { key: "PageDown" });
  step(2);
  expect(S.eds.board.frameAt).toBe(netFrameId);
  expect(hudFrameCounter()).toBe("1 / 2");
  find(page.byId.hudBL, e => e.attrs?.title === "Next frame (PgDn)").click();
  step(2);
  expect(S.eds.board.frameAt).toBe(authFrameId);
  expect(hudFrameCounter()).toBe("2 / 2");

  // Open ⌘J: combobox aria-activedescendant updates on ArrowDown, and "Show all layers" keeps focus inside modal
  const pill = find(page.byId.topbar, e => e.attrs?.["data-views-open"] === "1");
  pill.focus();
  pill.click();
  step(2);
  const modal = find(page.doc.body, e => e.classList?.contains("views-modal"));
  const search = find(modal, e => e.classList?.contains("views-search"));
  expect(search.attrs.role).toBe("combobox");
  const firstOpt = search.attrs["aria-activedescendant"];
  expect(firstOpt).toBe("views-opt-0");
  search.fire("keydown", { key: "ArrowDown" });
  expect(search.attrs["aria-activedescendant"]).toBe("views-opt-1");

  // Click "Show all layers" inside modal: focus stays inside modal (moves to searchInput), never drops to body
  const resetBtn = find(modal, e => e.attrs?.["data-action"] === "reset-local-layers");
  expect(resetBtn).toBeTruthy();
  resetBtn.click();
  expect(modal.contains(page.doc.activeElement)).toBe(true);

  // ⌘J from inside search input closes modal and restores focus to the live connected topbar pill (even after topbar rebuilt on reset)
  search.fire("keydown", { key: "j", metaKey: true });
  step(2);
  expect(hasActiveOverlay(page.doc)).toBe(false);
  expect(page.doc.activeElement?.attrs?.["data-views-open"]).toBe("1");
  expect(page.byId.topbar.contains(page.doc.activeElement)).toBe(true);
});
