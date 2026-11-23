// Focused UI wiring tests for Wave 7:
// - #112 YouTube / Media URL Embeds (editor.paste, Embed URL dialog, embed overlay activation)
// - #25 Auto-seed pending template on new empty board (and skip on non-empty board)
// - #20 Frame scope & Print/PDF in Export dialog
import { describe, test, expect, afterAll } from "bun:test";
import { Editor } from "../../packages/core/editor.js";
import { parseEmbedFromElement } from "../../packages/core/embed.js";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { mountApp } from "../../web/adapters/dom/app.js";
import { PENDING_TEMPLATE_KEY } from "../../web/adapters/dom/home.js";
import { viewsOf, listNamedFrames } from "../../packages/core/views.js";
import { installPage, stub, restoreGlobals } from "./stub-page.js";

afterAll(restoreGlobals);

const USERS = {
  "t-ada": { user: "ada", role: "owner" },
  "t-vi": { user: "vi", role: "viewer" },
};

function setup({ board = "w7-board", token = "t-ada", seedElements = null, pendingTemplate = null } = {}) {
  const page = installPage();
  const prevStorage = globalThis.sessionStorage;
  const sessMap = new Map();
  const mockSessionStorage = {
    getItem: k => (sessMap.has(k) ? sessMap.get(k) : null),
    setItem: (k, v) => { sessMap.set(k, String(v)); },
    removeItem: k => { sessMap.delete(k); },
  };
  globalThis.sessionStorage = mockSessionStorage;
  const net = localRoom({ board, users: USERS, clock: true });
  if (pendingTemplate) {
    mockSessionStorage.setItem(PENDING_TEMPLATE_KEY, JSON.stringify({ templateId: pendingTemplate, createdAt: net.clock.now() }));
  }
  if (seedElements) {
    const pre = createSession({
      join: () => net.join(),
      token: "t-ada",
      board,
      client: "pre",
      user: "ada",
      clock: net.clock,
    });
    while (net.step());
    net.advance(16);
    while (net.step());
    seedElements(pre);
    while (net.step());
    pre.connection.close();
  }
  const app = mountApp({
    startSession: ({ mine, onChange }) => createSession({
      join: () => net.join(),
      token,
      board,
      client: USERS[token].user,
      user: USERS[token].user,
      mine,
      onChange,
      clock: net.clock,
    }),
    net: { kind: "local", put() {}, onFile() {} },
    board,
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
  const cleanup = () => { globalThis.sessionStorage = prevStorage; };
  return { page, net, app, S: app.S, step, mockSessionStorage, cleanup };
}

const find = (root, pred) => root.all().find(pred);
const findAll = (root, pred) => root.all().filter(pred);

describe("#112 YouTube / Media URL Embeds wiring", () => {
  test("Editor.paste auto-creates embed poster cards for YouTube, .mp4, and direct image URLs", () => {
    const ed = new Editor();
    ed.setSize(1000, 700);

    ed.paste("https://youtu.be/dQw4w9WgXcQ?t=42");
    expect(ed.doc.live().length).toBe(1);
    const yt = parseEmbedFromElement(ed.doc.live()[0]);
    expect(yt?.provider).toBe("youtube");
    expect(yt?.videoId).toBe("dQw4w9WgXcQ");
    expect(yt?.startSec).toBe(42);

    ed.paste("https://cdn.example.com/clips/demo.mp4");
    expect(ed.doc.live().length).toBe(2);
    const vid = parseEmbedFromElement(ed.doc.live()[1]);
    expect(vid?.provider).toBe("video");

    ed.paste("https://cdn.example.com/shots/diagram.png");
    expect(ed.doc.live().length).toBe(3);
    const img = parseEmbedFromElement(ed.doc.live()[2]);
    expect(img?.provider).toBe("image");
  });

  test("Embed URL dialog validates, embeds URL, and clicking/double-clicking activates the live overlay", () => {
    const { page, app, S, step, cleanup } = setup({ board: "embed-ui" });
    try {
      app.openDialog("embed");
      step(2);
      const dlg = find(page.byId.dialogs, e => e.attrs.role === "dialog");
      expect(dlg).toBeTruthy();
      expect(dlg.attrs["aria-label"]).toBe("Embed URL");

      const input = find(dlg, e => e.tagName === "INPUT");
      const submit = find(dlg, e => e.attrs["data-action"] === "embed-submit");
      expect(input).toBeTruthy();
      expect(submit).toBeTruthy();

      // Invalid URL shows alert and stays open
      input.value = "javascript:alert(1)";
      input.fire("input", { target: input });
      submit.click();
      const alert = find(dlg, e => e.attrs.role === "alert");
      expect(alert.hidden).toBe(false);
      expect(S.eds.board.doc.live().length).toBe(0);

      // Valid YouTube URL creates embed card and closes dialog
      input.value = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
      input.fire("input", { target: input });
      submit.click();
      step(2);
      expect(page.byId.dialogs.children.length).toBe(0);
      expect(S.eds.board.doc.live().length).toBe(1);
      const el = S.eds.board.doc.live()[0];
      expect(parseEmbedFromElement(el)?.provider).toBe("youtube");

      // Overlay layer is mounted on #canvas with a container for the embed card, ZERO iframe until activated
      const overlayLayer = find(page.byId.canvas, e => e.classList.contains("embed-overlay-layer"));
      expect(overlayLayer).toBeTruthy();
      expect(find(overlayLayer, e => e.tagName === "IFRAME")).toBeUndefined();

      // Double-clicking the embed card on canvas activates the live iframe overlay
      const center = S.eds.board.toScreen({ x: el.x + el.width / 2, y: el.y + el.height / 2 });
      page.board.fire("pointerdown", { clientX: center.x, clientY: center.y, button: 0, detail: 2 });
      step(2);
      const iframe = find(overlayLayer, e => e.tagName === "IFRAME");
      expect(iframe).toBeTruthy();
      expect(iframe.src).toContain("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    } finally {
      cleanup();
    }
  });
});

describe("#25 Auto-seed pending template on new empty board", () => {
  test("auto-seeds layers, views, elements and shows toast when empty board goes live", () => {
    const { page, S, mockSessionStorage, cleanup } = setup({
      board: "tpl-empty",
      pendingTemplate: "presentation",
    });
    try {
      expect(S.eds.board.doc.live().length).toBeGreaterThan(5);
      expect(listNamedFrames(S.eds.board.doc).length).toBe(3);
      expect(viewsOf(S.eds.board.doc).length).toBeGreaterThanOrEqual(3);
      expect(S.eds.board.doc.layers.length).toBe(2);
      expect(mockSessionStorage.getItem(PENDING_TEMPLATE_KEY)).toBeNull();
      expect(page.byId.toast.textContent).toContain("Presentation Deck");
    } finally {
      cleanup();
    }
  });

  test("does NOT overwrite a non-empty board even if a pending template exists", () => {
    const { S, cleanup } = setup({
      board: "tpl-nonempty",
      pendingTemplate: "retro",
      seedElements: pre => {
        pre.setTool("rectangle");
        pre.pointerDown({ x: 100, y: 100 });
        pre.pointerMove({ x: 200, y: 180 });
        pre.pointerUp({ x: 200, y: 180 });
      },
    });
    try {
      expect(S.eds.board.doc.live().length).toBe(1);
      expect(S.eds.board.doc.live()[0].type).toBe("rectangle");
    } finally {
      cleanup();
    }
  });
});

describe("#20 Frame Scope & Print/PDF in Export Dialog", () => {
  test("Export dialog shows Frame Scope selector when frames exist and PDF / Print chip opens print HTML", () => {
    const { page, app, S, step, cleanup } = setup({ board: "exp-frames" });
    const prevOpen = globalThis.open;
    let writtenHtml = "";
    let printed = false;
    globalThis.open = () => ({
      document: {
        open() {},
        write(h) { writtenHtml = h; },
        close() {},
      },
      focus() {},
      print() { printed = true; },
    });
    try {
      // Create two named frames
      S.setTool("frame");
      S.pointerDown({ x: 50, y: 50 });
      S.pointerMove({ x: 350, y: 250 });
      S.pointerUp({ x: 350, y: 250 });
      S.setTool("frame");
      S.pointerDown({ x: 420, y: 50 });
      S.pointerMove({ x: 720, y: 250 });
      S.pointerUp({ x: 720, y: 250 });
      step(2);

      app.openDialog("export");
      step(2);
      const dlg = find(page.byId.dialogs, e => e.attrs.role === "dialog");
      expect(dlg).toBeTruthy();

      const scopeSelect = find(dlg, e => e.tagName === "SELECT" && e.attrs["aria-label"] === "Export scope");
      expect(scopeSelect).toBeTruthy();
      const opts = findAll(scopeSelect, e => e.tagName === "OPTION");
      expect(opts.length).toBe(3); // Whole board + 2 frames

      // Select PDF / Print format chip
      const pdfChip = find(dlg, e => e.tagName === "BUTTON" && e.textContent.trim() === "PDF / Print");
      expect(pdfChip).toBeTruthy();
      pdfChip.click();
      step(2);

      const dlg2 = find(page.byId.dialogs, e => e.attrs.role === "dialog");
      const printBtn = find(dlg2, e => e.tagName === "BUTTON" && e.classList.contains("primary"));
      expect(printBtn.textContent).toContain("Print / Save PDF");
      printBtn.click();
      step(15);

      expect(writtenHtml).toContain("<!doctype html>");
      expect(writtenHtml).toContain("@page");
      expect(writtenHtml).toContain('class="print-page"');
      expect(printed).toBe(true);
    } finally {
      globalThis.open = prevOpen;
      cleanup();
    }
  });
});
