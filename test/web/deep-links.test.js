// Tests for Issue #22: Deep Links to a Specific Frame, Element, or View
// + Context Menu "Copy link to selection" / "Copy link to frame".
import { describe, test, expect, afterAll } from "bun:test";
import { parseDeepLink, buildDeepLink } from "../../web/core/settings.js";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { mountApp } from "../../web/adapters/dom/app.js";
import { makeElement, BASE_LAYER } from "../../packages/core/model.js";
import { addView } from "../../packages/core/views.js";
import { installPage, stub, fireWin, restoreGlobals } from "./stub-page.js";

const origLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const origNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function setMockLocation({ origin = "https://plenary.test", pathname = "/board", search = "", hash = "" } = {}) {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    writable: true,
    value: { origin, pathname, search, hash },
  });
}

function setMockClipboard(writes) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      clipboard: {
        writeText: async text => { writes.push(text); },
      },
    },
  });
}

afterAll(() => {
  restoreGlobals();
  if (origLocation) Object.defineProperty(globalThis, "location", origLocation);
  else delete globalThis.location;
  if (origNavigator) Object.defineProperty(globalThis, "navigator", origNavigator);
  else delete globalThis.navigator;
});

describe("#22 parseDeepLink & buildDeepLink (sanitization & URL handling)", () => {
  test("parses #frame=, #el=, #view= and query equivalents, preferring hash over query", () => {
    expect(parseDeepLink({ hash: "#frame=f-123", search: "" })).toEqual({ kind: "frame", id: "f-123" });
    expect(parseDeepLink({ hash: "#el=el_abc-1", search: "" })).toEqual({ kind: "el", id: "el_abc-1" });
    expect(parseDeepLink({ hash: "#view=v.01", search: "" })).toEqual({ kind: "view", id: "v.01" });
    expect(parseDeepLink({ hash: "", search: "?board=b1&frame=f-9" })).toEqual({ kind: "frame", id: "f-9" });
    expect(parseDeepLink({ hash: "", search: "?board=b1&el=e-9" })).toEqual({ kind: "el", id: "e-9" });
    expect(parseDeepLink({ hash: "", search: "?board=b1&view=v-9" })).toEqual({ kind: "view", id: "v-9" });
    // Hash takes precedence over query
    expect(parseDeepLink({ hash: "#el=from-hash", search: "?frame=from-query" })).toEqual({ kind: "el", id: "from-hash" });
  });

  test("ignores OAuth #code= fragments and rejects unsafe/malformed IDs", () => {
    expect(parseDeepLink({ hash: "#code=secret1234567890", search: "" })).toBeNull();
    expect(parseDeepLink({ hash: "#el=<script>alert(1)</script>", search: "" })).toBeNull();
    expect(parseDeepLink({ hash: "#frame=a%20b", search: "" })).toBeNull();
    expect(parseDeepLink({ hash: "#el=%E0%A4%A", search: "" })).toBeNull();
    expect(parseDeepLink({ hash: `#el=${"a".repeat(200)}`, search: "" })).toBeNull();
    expect(parseDeepLink(null)).toBeNull();
  });

  test("buildDeepLink formats clean URLs, strips stale deep-link query params, and preserves query fallback when ?board= is present", () => {
    expect(buildDeepLink({ origin: "https://plenary.test", pathname: "/b/1", search: "", kind: "el", id: "el-42" }))
      .toBe("https://plenary.test/b/1#el=el-42");
    expect(buildDeepLink({ origin: "https://plenary.test", pathname: "/", search: "?board=b1&el=old", kind: "frame", id: "fr-7" }))
      .toBe("https://plenary.test/?board=b1&frame=fr-7#frame=fr-7");
    // Even if sign-in strips the hash from a copied `?board=b1&frame=fr-7#frame=fr-7` URL, parseDeepLink still resolves it
    const copied = buildDeepLink({ origin: "https://plenary.test", pathname: "/", search: "?board=b1", kind: "el", id: "el-99" });
    const parsedUrl = new URL(copied);
    expect(parseDeepLink({ hash: "", search: parsedUrl.search })).toEqual({ kind: "el", id: "el-99" });
    expect(buildDeepLink({ origin: "https://plenary.test", pathname: "/", search: "", kind: "el", id: "bad id!" }))
      .toBeNull();
  });
});

describe("#22 Deep Links on Board Load, hashchange, and Context Menu Copy Link", () => {
  const USERS = {
    "t-ada": { user: "ada", role: "owner" },
    "t-bo": { user: "bo", role: "editor" },
    "t-vi": { user: "vi", role: "viewer" },
  };

  function setup({ token = "t-ada", hash = "", search = "" } = {}) {
    setMockLocation({ origin: "https://plenary.test", pathname: "/app", search, hash });
    const page = installPage();
    const net = localRoom({ board: "dl-board", users: USERS, clock: true });

    // Seed the board via a peer before mounting so content is ready on sync!
    const peer = createSession({ join: () => net.join(), token: "t-bo", board: "dl-board", client: "bo", user: "bo", clock: net.clock });
    peer.setSize(1200, 800);
    while (net.step());

    peer.act("board", e => { e.addLayer("Overlay"); }, { settings: true });
    const overlayId = peer.eds.board.doc.layers.find(l => l.name === "Overlay").id;
    let f1 = "", f2 = "", el1 = "", el2 = "";
    peer.act("board", e => {
      e.activeLayer = BASE_LAYER;
      [f1, f2, el1] = e.insertElements([
        makeElement("frame", { x: 0, y: 0, width: 500, height: 350, name: "Intro" }),
        makeElement("frame", { x: 2000, y: 0, width: 500, height: 350, name: "Architecture" }),
        makeElement("rectangle", { x: 2100, y: 100, width: 120, height: 80 }),
      ]);
      e.activeLayer = overlayId;
      [el2] = e.insertElements([
        makeElement("rectangle", { x: 100, y: 100, width: 100, height: 60 }),
      ]);
      e.select([]);
    });
    const savedView = { id: "view-arch", name: "Arch View", frameId: f2, visibleLayers: [BASE_LAYER] };
    peer.act("board", e => e.setAppState({ views: addView(e.doc, savedView) }), { settings: true });
    while (net.step());

    // Allow callers to pass a function `(ids) => ({ hash, search })` to test true fresh-load deep links!
    const initLoc = typeof hash === "function" ? hash({ f1, f2, el1, el2, viewId: savedView.id }) : { hash, search };
    setMockLocation({ origin: "https://plenary.test", pathname: "/app", search: initLoc.search ?? search, hash: initLoc.hash ?? "" });

    const app = mountApp({
      startSession: ({ mine, onChange }) => createSession({
        join: () => net.join(),
        token,
        board: "dl-board",
        client: USERS[token].user,
        user: USERS[token].user,
        mine,
        onChange,
        clock: net.clock,
      }),
      net: { kind: "local", put() {}, onFile() {} },
      board: "dl-board",
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
    step(4);
    return { page, net, app, S: app.S, step, ids: { f1, f2, el1, el2, viewId: savedView.id, overlayId } };
  }

  const find = (root, pred) => root.all().find(pred);

  test("#frame=<id> on fresh board load and hashchange fits camera to that frame", () => {
    const { S, ids } = setup({ hash: ({ f2 }) => ({ hash: `#frame=${f2}` }) });
    expect(S.eds.board.frameAt).toBe(ids.f2);

    // Subsequent hashchange switches to f1
    setMockLocation({ origin: "https://plenary.test", pathname: "/app", search: "", hash: `#frame=${ids.f1}` });
    fireWin("hashchange");
    expect(S.eds.board.frameAt).toBe(ids.f1);
  });

  test("?el=<id> on fresh board load and #el=<id> hashchange fit and select the target element", () => {
    const { S, ids } = setup({ hash: ({ el1 }) => ({ search: `?board=dl-board&el=${el1}`, hash: "" }) });
    expect(S.eds.board.sel.has(ids.el1)).toBe(true);

    setMockLocation({ origin: "https://plenary.test", pathname: "/app", search: "", hash: `#el=${ids.el2}` });
    fireWin("hashchange");
    expect(S.eds.board.sel.has(ids.el2)).toBe(true);
  });

  test("#view=<id> activates Named Presentation View locally and fits its frame without mutating shared layers", () => {
    const { S, ids, step } = setup();
    const sharedBefore = JSON.stringify(S.eds.board.doc.appState.herdr.layers);
    const sentBefore = S.sent;

    setMockLocation({ origin: "https://plenary.test", pathname: "/app", search: "", hash: `#view=${ids.viewId}` });
    fireWin("hashchange");
    step(2);

    expect(S.eds.board.frameAt).toBe(ids.f2);
    // Overlay layer element el2 is filtered out locally
    expect(S.eds.board.doc.visible().some(e => e.id === ids.el2)).toBe(false);
    expect(S.eds.board.doc.visible().some(e => e.id === ids.el1)).toBe(true);
    expect(JSON.stringify(S.eds.board.doc.appState.herdr.layers)).toBe(sharedBefore);
    expect(S.sent).toBe(sentBefore);
  });

  test("initial load with ?view= resolves deep link once synced", () => {
    const { S, app, ids } = setup({ search: "?view=view-arch" });
    expect(app.ui.localView.activeViewId).toBe(ids.viewId);
    expect(S.eds.board.frameAt).toBe(ids.f2);
  });

  test("context menu 'Copy link to selection' and 'Copy link to frame' copy URLs and show toast", async () => {
    const writes = [];
    setMockClipboard(writes);
    const { page, S, ids, step } = setup();

    // Right-click element el1 -> "Copy link to selection"
    const el1Obj = S.eds.board.doc.get(ids.el1);
    const pEl = S.eds.board.toScreen({ x: el1Obj.x, y: el1Obj.y + 10 });
    page.board.fire("contextmenu", { clientX: pEl.x, clientY: pEl.y, button: 2 });
    let menu = find(page.doc.body, e => e.classList?.contains("ctx-menu"));
    let copyBtn = find(menu, e => e.attrs["data-ctx-id"] === "copy-link");
    expect(copyBtn).toBeTruthy();
    expect(copyBtn.textContent).toContain("Copy link to selection");
    copyBtn.click();
    await Promise.resolve();
    expect(writes[0]).toBe(`https://plenary.test/app#el=${ids.el1}`);
    expect(page.byId.toast.textContent).toContain("Copied link to selection");

    // Right-click frame f1 -> "Copy link to frame"
    S.eds.board.select([ids.f1]);
    step(1);
    const f1Obj = S.eds.board.doc.get(ids.f1);
    const pFr = S.eds.board.toScreen({ x: f1Obj.x, y: f1Obj.y + 10 });
    page.board.fire("contextmenu", { clientX: pFr.x, clientY: pFr.y, button: 2 });
    menu = find(page.doc.body, e => e.classList?.contains("ctx-menu"));
    copyBtn = find(menu, e => e.attrs["data-ctx-id"] === "copy-link");
    expect(copyBtn).toBeTruthy();
    expect(copyBtn.textContent).toContain("Copy link to frame");
    copyBtn.click();
    await Promise.resolve();
    expect(writes[1]).toBe(`https://plenary.test/app#frame=${ids.f1}`);
    expect(page.byId.toast.textContent).toContain("Copied link to frame");
  });
});
