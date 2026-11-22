// Tests for Issue #113 (Friendly Board Title in Canvas Header Pill & document.title)
// and Issue #110 (Grouped Board Menu UX: Board / View / Collaborate + desktop/mobile parity).
import { describe, test, expect, afterAll } from "bun:test";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { syncCollabPort } from "../../web/adapters/collab/sync.js";
import { mountApp, isRawBoardId, formatBoardTitle, formatDocumentTitle } from "../../web/adapters/dom/app.js";
import { installPage, stub, restoreGlobals } from "./stub-page.js";

afterAll(restoreGlobals);

const USERS = {
  "t-ada": { user: "ada", role: "owner" },
  "t-bo": { user: "bo", role: "editor" },
  "t-cy": { user: "cy", role: "annotator" },
  "t-vi": { user: "vi", role: "viewer" },
};

function setup({
  board = "b-z7r15i5cc4rk28d9",
  token = "t-ada",
  boardTitle = null,
  getBoardTitle = null,
  renameBoard = null,
  admin = null,
  collab = false,
  phone = false,
} = {}) {
  const page = installPage();
  if (phone) {
    for (const q of ["(max-width: 640px)", "(max-width: 1023px)"]) {
      page.media.set(q, { matches: true, listeners: [] });
    }
  }
  const net = localRoom({ board, users: USERS, clock: true });
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
    net: { kind: "ws", put() {}, onFile() {} },
    board,
    boardTitle,
    getBoardTitle,
    renameBoard,
    admin,
    me: { user: USERS[token].user, name: "Ada", role: null },
    prefs: memoryStore(),
    theme: "light",
    clock: net.clock,
    collab: collab ? (S, o) => syncCollabPort(S, { name: "Ada", frame: fn => net.clock.set(fn, 16), ...o }) : null,
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

const find = (root, pred) => root.all().find(pred);
const findAll = (root, pred) => root.all().filter(pred);
const flush = () => new Promise(r => setTimeout(r, 0));

describe("#113 Friendly Board Title", () => {
  test("isRawBoardId and formatBoardTitle hide raw board IDs and keep friendly titles", () => {
    expect(isRawBoardId("b-z7r15i5cc4rk28d9")).toBe(true);
    expect(isRawBoardId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isRawBoardId("demo")).toBe(false);
    expect(isRawBoardId("b1")).toBe(false);
    expect(isRawBoardId("sprint-plan")).toBe(false);

    expect(formatBoardTitle("b-z7r15i5cc4rk28d9", null)).toBe("Untitled board");
    expect(formatBoardTitle("b-z7r15i5cc4rk28d9", "   ")).toBe("Untitled board");
    expect(formatBoardTitle("b-z7r15i5cc4rk28d9", "Q4 Architecture")).toBe("Q4 Architecture");
    expect(formatBoardTitle("b-z7r15i5cc4rk28d9", "  Design\u202EReview\n")).toBe("DesignReview");
    expect(formatBoardTitle("demo", null)).toBe("demo");
    expect(formatDocumentTitle("Q4 Architecture")).toBe("Q4 Architecture — Plenary");
    expect(formatDocumentTitle("")).toBe("Untitled board — Plenary");
  });

  test("raw board ID without title displays 'Untitled board' in header pill and document.title", () => {
    const { page } = setup({ board: "b-z7r15i5cc4rk28d9" });
    const pill = find(page.byId.topbar, e => e.classList.contains("board-name"));
    expect(pill).toBeTruthy();
    expect(pill.textContent).toBe("Untitled board");
    expect(pill.textContent).not.toContain("b-z7r15i5cc4rk28d9");
    expect(page.doc.title).toBe("Untitled board — Plenary");
  });

  test("resolves friendly title asynchronously from getBoardTitle and updates header pill + document.title", async () => {
    const { page, step } = setup({
      board: "b-z7r15i5cc4rk28d9",
      getBoardTitle: async () => ({ title: "Roadmap 2026", canRename: true }),
      renameBoard: async title => ({ board: { id: "b-z7r15i5cc4rk28d9", title } }),
    });
    await flush();
    step(2);
    const pill = find(page.byId.topbar, e => e.classList.contains("board-name"));
    expect(pill.textContent).toBe("Roadmap 2026");
    expect(page.doc.title).toBe("Roadmap 2026 — Plenary");
    expect(pill.tagName).toBe("BUTTON");
  });

  test("owner/editor can click header pill to rename inline (Enter saves, Escape cancels)", async () => {
    const calls = [];
    const { page, step } = setup({
      board: "b-z7r15i5cc4rk28d9",
      boardTitle: "Initial Plan",
      renameBoard: async title => {
        calls.push(title);
        return { board: { id: "b-z7r15i5cc4rk28d9", title } };
      },
    });

    // Click to enter inline rename mode
    const btn = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.classList.contains("board-name"));
    expect(btn).toBeTruthy();
    expect(btn.textContent).toBe("Initial Plan");
    btn.click();
    step(2);

    let input = find(page.byId.topbar, e => e.tagName === "INPUT" && e.classList.contains("board-name-input"));
    expect(input).toBeTruthy();
    expect(input.value).toBe("Initial Plan");
    expect(page.doc.activeElement).toBe(input);

    // Escape cancels without calling renameBoard
    input.value = "Should Not Save";
    input.fire("keydown", { key: "Escape" });
    step(2);
    expect(calls).toEqual([]);
    expect(find(page.byId.topbar, e => e.classList.contains("board-name")).textContent).toBe("Initial Plan");
    expect(page.doc.title).toBe("Initial Plan — Plenary");

    // Click again and press Enter to save
    find(page.byId.topbar, e => e.tagName === "BUTTON" && e.classList.contains("board-name")).click();
    step(2);
    input = find(page.byId.topbar, e => e.tagName === "INPUT" && e.classList.contains("board-name-input"));
    input.value = "  Final Architecture  ";
    input.fire("keydown", { key: "Enter" });
    step(2);
    await flush();
    step(2);

    expect(calls).toEqual(["Final Architecture"]);
    const savedBtn = find(page.byId.topbar, e => e.classList.contains("board-name"));
    expect(savedBtn.textContent).toBe("Final Architecture");
    expect(page.doc.title).toBe("Final Architecture — Plenary");
    expect(page.doc.activeElement).toBe(savedBtn);
  });

  test("inline rename reverts title and shows toast when server rejects", async () => {
    const { page, step } = setup({
      board: "b-z7r15i5cc4rk28d9",
      boardTitle: "Stable Name",
      renameBoard: async () => ({ error: "forbidden" }),
    });

    find(page.byId.topbar, e => e.tagName === "BUTTON" && e.classList.contains("board-name")).click();
    step(2);
    const input = find(page.byId.topbar, e => e.tagName === "INPUT" && e.classList.contains("board-name-input"));
    input.value = "Rejected Name";
    input.fire("keydown", { key: "Enter" });
    step(2);
    // Optimistically updated
    expect(page.doc.title).toBe("Rejected Name — Plenary");
    await flush();
    step(2);
    // Reverted on error
    expect(page.doc.title).toBe("Stable Name — Plenary");
    expect(find(page.byId.topbar, e => e.classList.contains("board-name")).textContent).toBe("Stable Name");
    expect(page.byId.toast.textContent).toContain("Couldn't rename board");
  });

  test("viewer sees friendly title as non-editable span (cannot inline rename)", () => {
    const { page } = setup({
      board: "b-z7r15i5cc4rk28d9",
      token: "t-vi",
      boardTitle: "Readonly Deck",
      renameBoard: async () => ({ board: { id: "b-z7r15i5cc4rk28d9", title: "x" } }),
    });
    const pill = find(page.byId.topbar, e => e.classList.contains("board-name"));
    expect(pill.tagName).toBe("SPAN");
    expect(pill.textContent).toBe("Readonly Deck");
    expect(page.doc.title).toBe("Readonly Deck — Plenary");
  });
});

describe("#110 Board Menu UX (Board / View / Collaborate)", () => {
  test("Board menu groups actions under Board, View, and Collaborate sections", () => {
    const { page, S, step } = setup({
      board: "b-z7r15i5cc4rk28d9",
      boardTitle: "System Map",
      collab: true,
      renameBoard: async t => ({ board: { id: "b-z7r15i5cc4rk28d9", title: t } }),
    });
    const more = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "More");
    expect(more).toBeTruthy();
    more.click();

    const menu = find(page.byId.topbar, e => e.attrs.role === "menu" && e.classList.contains("board-menu"));
    expect(menu).toBeTruthy();
    const groups = findAll(menu, e => e.attrs.role === "group");
    expect(groups.map(g => g.attrs["aria-label"])).toEqual(["Board", "View", "Collaborate"]);

    const labelsIn = g => findAll(g, e => e.attrs.role === "menuitem").map(e => e.attrs["aria-label"]);
    expect(labelsIn(groups[0])).toEqual(["Rename board", "Export", "Import .excalidraw", "Mermaid"]);
    expect(labelsIn(groups[1])).toEqual(["Jump to frame or view", "Light / dark", "Toggle grid", "Side panel"]);
    expect(labelsIn(groups[2])).toEqual(["Notes", "Comments"]);

    // Toggle grid from View section updates board appState.herdr.grid
    expect(S.eds.board.grid).toBe(0);
    const gridBtn = find(menu, e => e.attrs["aria-label"] === "Toggle grid");
    gridBtn.click();
    step(2);
    expect(S.eds.board.grid).toBe(20);
  });

  test("mobile Tools/Board sheet has parity controls (Rename, Import, Grid, Export, Mermaid, Theme)", () => {
    const { page, step } = setup({
      board: "b-z7r15i5cc4rk28d9",
      boardTitle: "Mobile Map",
      phone: true,
      renameBoard: async t => ({ board: { id: "b-z7r15i5cc4rk28d9", title: t } }),
    });
    const moreBtn = find(page.byId.dock, e => e.hasAttribute("data-dock-more"));
    moreBtn.click();
    step(2);
    const sheetBtns = findAll(page.byId.sheet, e => e.tagName === "BUTTON");
    const labels = sheetBtns.map(b => b.getAttribute("aria-label") || b.textContent.trim());
    expect(labels).toContain("Rename board");
    expect(labels).toContain("Import .excalidraw");
    expect(labels).toContain("Toggle grid");
    expect(labels).toContain("Export");
    expect(labels).toContain("Mermaid");
  });
});
