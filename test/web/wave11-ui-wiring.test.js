// Focused UI wiring tests for Wave 11:
// - #5 Fit Frame to Children (canvas context menu) & Insert Swimlane (Board Menu + mobile sheet)
// - #6 Insert Table (Board Menu + mobile sheet) & Shape Metadata Inspector (Owner, Service, Runbook URL + https: link safety)
import { describe, test, expect, afterAll } from "bun:test";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { mountApp } from "../../web/adapters/dom/app.js";
import { parseLinkCardUrl } from "../../packages/core/link-card.js";
import { parseEmbedUrl } from "../../packages/core/embed.js";
import { installPage, stub, restoreGlobals } from "./stub-page.js";

afterAll(restoreGlobals);

const USERS = {
  "t-ada": { user: "ada", role: "owner" },
  "t-cy": { user: "cy", role: "annotator" },
  "t-vi": { user: "vi", role: "viewer" },
};

function setup({ token = "t-ada", phone = false } = {}) {
  const page = installPage();
  if (phone) {
    for (const q of ["(max-width: 640px)", "(max-width: 1023px)"]) {
      page.media.set(q, { matches: true, listeners: [] });
    }
  }
  const net = localRoom({ board: "w11-board", users: USERS, clock: true });
  const app = mountApp({
    startSession: ({ mine, onChange }) => createSession({
      join: () => net.join(),
      token,
      board: "w11-board",
      client: USERS[token].user,
      user: USERS[token].user,
      mine,
      onChange,
      clock: net.clock,
    }),
    net: { kind: "local", put() {}, onFile() {} },
    board: "w11-board",
    me: { user: USERS[token].user, name: token === "t-ada" ? "Ada" : "User", role: null },
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
  return { page, net, app, S: app.S, step };
}

function drawTool(S, tool, x, y, w = 120, h = 80) {
  S.setTool(tool);
  S.pointerDown({ x, y });
  S.pointerMove({ x: x + w, y: y + h });
  S.pointerUp({ x: x + w, y: y + h });
}

const find = (root, pred) => root.all().find(pred);
const findAll = (root, pred) => root.all().filter(pred);
const openMenuAt = (page, x, y) => page.board.fire("contextmenu", { clientX: x, clientY: y, button: 2 });
const activeMenu = page => find(page.doc.body, e => e.classList.contains("ctx-menu"));
const menuItem = (menu, id) => find(menu, e => e.attrs["data-ctx-id"] === id);

describe("Wave 11 UI Wiring", () => {
  test("#5 Fit to children appears for single writable unlocked frame, toasts when empty, and resizes around children", () => {
    const { page, S, step } = setup();

    // Draw an oversized empty frame
    drawTool(S, "frame", 100, 100, 400, 300);
    step(2);
    const frame = S.eds.board.doc.live().find(e => e.type === "frame");
    expect(frame).toBeTruthy();

    // Right-clicking the frame border opens context menu with "Fit to children"
    const frameEdge = S.eds.board.toScreen({ x: frame.x, y: frame.y + 40 });
    openMenuAt(page, frameEdge.x, frameEdge.y);
    const menu1 = activeMenu(page);
    expect(menu1).toBeTruthy();
    const fitItem = menuItem(menu1, "fit-to-children");
    expect(fitItem).toBeTruthy();
    expect(fitItem.textContent).toContain("Fit to children");

    // Clicking "Fit to children" on an empty frame shows toast and leaves bounds intact
    const origW = frame.width;
    const origH = frame.height;
    fitItem.click();
    step(2);
    expect(page.byId.toast.textContent).toContain("no children");
    expect(S.eds.board.doc.get(frame.id).width).toBe(origW);
    expect(S.eds.board.doc.get(frame.id).height).toBe(origH);

    // Draw a child rectangle inside the frame
    drawTool(S, "rectangle", 160, 160, 80, 60);
    step(2);
    const child = S.eds.board.doc.live().find(e => e.type === "rectangle");
    expect(child).toBeTruthy();
    // Ensure child is parented to frame
    if (child.frameId !== frame.id) {
      S.act("board", ed => {
        ed.transact(tx => {
          const c = tx.get(child.id);
          if (c) c.frameId = frame.id;
          return true;
        });
      });
      step(2);
    }

    // Right-clicking the rectangle itself does NOT show Fit to children
    const rectEdge = S.eds.board.toScreen({ x: child.x, y: child.y + 20 });
    openMenuAt(page, rectEdge.x, rectEdge.y);
    expect(menuItem(activeMenu(page), "fit-to-children")).toBeUndefined();

    // Right-clicking the frame again and clicking Fit to children shrinks it neatly around the child
    openMenuAt(page, frameEdge.x, frameEdge.y);
    menuItem(activeMenu(page), "fit-to-children").click();
    step(2);
    const fitted = S.eds.board.doc.get(frame.id);
    expect(fitted.width).toBeLessThan(origW);
    expect(fitted.height).toBeLessThan(origH);
    expect(fitted.x).toBeLessThan(child.x);
    expect(fitted.y).toBeLessThan(child.y);
    expect(fitted.x + fitted.width).toBeGreaterThan(child.x + child.width);
    expect(fitted.y + fitted.height).toBeGreaterThan(child.y + child.height);
    expect(page.byId.toast.textContent).toContain("Fitted frame to children");

    // Locked frame hides Fit to children
    S.act("board", ed => {
      ed.select([frame.id]);
      ed.toggleLock();
    });
    step(2);
    const lockedEdge = S.eds.board.toScreen({ x: fitted.x, y: fitted.y + 20 });
    openMenuAt(page, lockedEdge.x, lockedEdge.y);
    expect(menuItem(activeMenu(page), "fit-to-children")).toBeUndefined();

    // Unlocked frame on a locked layer also hides Fit to children
    S.act("board", ed => {
      ed.select([frame.id]);
      ed.toggleLock();
    });
    S.act("board", ed => ed.updateLayer(ed.activeLayer, { locked: true }), { settings: true });
    step(2);
    openMenuAt(page, lockedEdge.x, lockedEdge.y);
    expect(menuItem(activeMenu(page), "fit-to-children")).toBeUndefined();
  });

  test("#5 Insert swimlane in Board Menu creates 3 centered swimlane frames for presenter and is hidden for viewer", () => {
    const { page, S, step } = setup();
    const more = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "More");
    more.click();
    const menu = find(page.byId.topbar, e => e.attrs.role === "menu" && e.classList.contains("board-menu"));
    const btn = find(menu, e => e.attrs.role === "menuitem" && e.attrs["aria-label"] === "Insert swimlane");
    expect(btn).toBeTruthy();

    btn.click();
    step(2);

    const frames = S.eds.board.doc.live().filter(e => e.type === "frame");
    expect(frames.length).toBe(3);
    expect(frames.map(f => f.name)).toEqual(["Swimlane — Lane 1", "Swimlane — Lane 2", "Swimlane — Lane 3"]);
    // Centered around viewport center
    const center = S.eds.board.toWorld({ x: S.eds.board.size.w / 2, y: S.eds.board.size.h / 2 });
    const minX = Math.min(...frames.map(f => f.x));
    const maxX = Math.max(...frames.map(f => f.x + f.width));
    const minY = Math.min(...frames.map(f => f.y));
    const maxY = Math.max(...frames.map(f => f.y + f.height));
    expect(Math.abs((minX + maxX) / 2 - center.x)).toBeLessThan(2);
    expect(Math.abs((minY + maxY) / 2 - center.y)).toBeLessThan(2);
    expect(page.byId.toast.textContent).toContain("Inserted swimlane");

    // Viewer does not see Insert swimlane
    const viewer = setup({ token: "t-vi" });
    const vMore = find(viewer.page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "More");
    vMore.click();
    const vMenu = find(viewer.page.byId.topbar, e => e.attrs.role === "menu" && e.classList.contains("board-menu"));
    expect(find(vMenu, e => e.attrs["aria-label"] === "Insert swimlane")).toBeUndefined();
  });

  test("#6 Insert table in Board Menu creates a grouped 3x3 table centered in the viewport", () => {
    const { page, S, step } = setup();
    const more = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "More");
    more.click();
    const menu = find(page.byId.topbar, e => e.attrs.role === "menu" && e.classList.contains("board-menu"));
    const btn = find(menu, e => e.attrs.role === "menuitem" && e.attrs["aria-label"] === "Insert table");
    expect(btn).toBeTruthy();

    btn.click();
    step(2);

    const live = S.eds.board.doc.live();
    const rects = live.filter(e => e.type === "rectangle" && e.customData?.table);
    const labels = live.filter(e => e.type === "text" && e.containerId);
    expect(rects.length).toBe(9);
    expect(labels.length).toBe(9);
    // All cells share a single groupId
    const groupId = rects[0].groupIds?.[0];
    expect(typeof groupId).toBe("string");
    expect(rects.every(r => r.groupIds?.includes(groupId))).toBe(true);
    // Centered in viewport
    const center = S.eds.board.toWorld({ x: S.eds.board.size.w / 2, y: S.eds.board.size.h / 2 });
    const minX = Math.min(...rects.map(r => r.x));
    const maxX = Math.max(...rects.map(r => r.x + r.width));
    const minY = Math.min(...rects.map(r => r.y));
    const maxY = Math.max(...rects.map(r => r.y + r.height));
    expect(Math.abs((minX + maxX) / 2 - center.x)).toBeLessThan(2);
    expect(Math.abs((minY + maxY) / 2 - center.y)).toBeLessThan(2);
    expect(page.byId.toast.textContent).toContain("Inserted table");
  });

  test("#6 Metadata inspector edits Owner/Service/Runbook URL, enforces https: link safety, and hides on link cards & embeds", () => {
    const { page, S, step } = setup();
    drawTool(S, "rectangle", 100, 100, 120, 80);
    step(2);
    const rect = S.eds.board.doc.live().find(e => e.type === "rectangle");
    expect(rect).toBeTruthy();

    // Select single rectangle -> Metadata section appears
    S.act("board", ed => ed.select([rect.id]));
    step(20);
    const metaSec = find(page.byId.panel, e => e.attrs["data-meta-section"] === "1");
    expect(metaSec).toBeTruthy();

    const ownerIn = find(metaSec, e => e.attrs["data-meta"] === "owner");
    const serviceIn = find(metaSec, e => e.attrs["data-meta"] === "service");
    const runbookIn = find(metaSec, e => e.attrs["data-meta"] === "runbookUrl");
    expect(ownerIn).toBeTruthy();
    expect(serviceIn).toBeTruthy();
    expect(runbookIn).toBeTruthy();
    expect(find(metaSec, e => e.attrs["data-meta-link"] === "runbook")).toBeUndefined();

    // Commit valid Owner, Service, and https: Runbook URL on Enter
    ownerIn.value = "  Platform SRE  ";
    serviceIn.value = "billing-api";
    runbookIn.value = "https://runbooks.example.com/billing#alerts";
    runbookIn.fire("keydown", { key: "Enter" });
    step(20);

    const saved = S.eds.board.doc.get(rect.id);
    expect(saved.customData?.meta).toEqual({
      owner: "Platform SRE",
      service: "billing-api",
      runbookUrl: "https://runbooks.example.com/billing#alerts",
    });

    // Safe Open runbook ↗ link renders with target="_blank" and rel="noopener noreferrer"
    const metaSec2 = find(page.byId.panel, e => e.attrs["data-meta-section"] === "1");
    const link = find(metaSec2, e => e.attrs["data-meta-link"] === "runbook");
    expect(link).toBeTruthy();
    expect(link.tagName).toBe("A");
    expect(link.attrs.href).toBe("https://runbooks.example.com/billing#alerts");
    expect(link.attrs.target).toBe("_blank");
    expect(link.attrs.rel).toBe("noopener noreferrer");
    expect(link.textContent).toContain("Open runbook");

    // Unsafe javascript: URL is rejected on blur and preserves existing valid metadata
    const runbookIn2 = find(metaSec2, e => e.attrs["data-meta"] === "runbookUrl");
    runbookIn2.value = "javascript:alert(1)";
    runbookIn2.fire("blur");
    step(4);
    const errEl = find(metaSec2, e => e.attrs["data-meta-error"] === "1");
    expect(errEl.hidden).toBe(false);
    expect(errEl.textContent).toContain("https://");
    expect(S.eds.board.doc.get(rect.id).customData?.meta?.runbookUrl).toBe("https://runbooks.example.com/billing#alerts");

    // Non-https http:// URL is also rejected
    runbookIn2.value = "http://insecure.example.com/runbook";
    runbookIn2.fire("keydown", { key: "Enter" });
    step(4);
    expect(errEl.hidden).toBe(false);
    expect(S.eds.board.doc.get(rect.id).customData?.meta?.runbookUrl).toBe("https://runbooks.example.com/billing#alerts");

    // Clearing all fields removes el.customData.meta cleanly
    find(metaSec2, e => e.attrs["data-meta"] === "owner").value = "";
    find(metaSec2, e => e.attrs["data-meta"] === "service").value = "";
    runbookIn2.value = "";
    runbookIn2.fire("blur");
    step(20);
    expect(S.eds.board.doc.get(rect.id).customData?.meta).toBeUndefined();

    // Link card hides Metadata section
    const card = parseLinkCardUrl("https://github.com/org/repo/issues/42");
    expect(card).toBeTruthy();
    let cardId;
    S.act("board", ed => { cardId = ed.addLinkCard(card, { x: 400, y: 150 }); });
    step(20);
    S.act("board", ed => ed.select([cardId]));
    step(20);
    expect(find(page.byId.panel, e => e.attrs["data-meta-section"] === "1")).toBeUndefined();

    // Embed card hides Metadata section
    const embed = parseEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(embed).toBeTruthy();
    let embedId;
    S.act("board", ed => { embedId = ed.addEmbed(embed, { x: 500, y: 300 }); });
    step(20);
    S.act("board", ed => ed.select([embedId]));
    step(20);
    expect(find(page.byId.panel, e => e.attrs["data-meta-section"] === "1")).toBeUndefined();

    // Multi-selection hides Metadata section
    drawTool(S, "frame", 600, 100, 200, 140);
    step(2);
    const frame = S.eds.board.doc.live().find(e => e.type === "frame");
    S.act("board", ed => ed.select([rect.id, frame.id]));
    step(20);
    expect(find(page.byId.panel, e => e.attrs["data-meta-section"] === "1")).toBeUndefined();

    // Single frame shows Metadata section
    S.act("board", ed => ed.select([frame.id]));
    step(20);
    expect(find(page.byId.panel, e => e.attrs["data-meta-section"] === "1")).toBeTruthy();
  });

  test("#6 Mobile Style sheet renders 16px-safe Metadata inputs (>= 44px touch target)", () => {
    const { page, S, step } = setup({ phone: true });
    drawTool(S, "rectangle", 100, 100, 120, 80);
    step(2);
    const rect = S.eds.board.doc.live().find(e => e.type === "rectangle");
    S.act("board", ed => ed.select([rect.id]));
    step(2);

    // Open mobile Style sheet
    const styleBtn = find(page.byId.dock, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "Style");
    expect(styleBtn).toBeTruthy();
    styleBtn.click();
    step(4);

    const metaSec = find(page.byId.sheet, e => e.attrs["data-meta-section"] === "1");
    expect(metaSec).toBeTruthy();
    const inputs = findAll(metaSec, e => e.tagName === "INPUT");
    expect(inputs.length).toBe(3);
    for (const inp of inputs) {
      expect(inp.classList.contains("field")).toBe(true);
      expect(inp.style.fontSize).toBe("16px");
      expect(inp.style.minHeight).toBe("44px");
    }

    // Focusing an input in the mobile Style sheet prevents a concurrent update from wiping uncommitted text
    const ownerIn = find(metaSec, e => e.attrs["data-meta"] === "owner");
    ownerIn.focus();
    ownerIn.value = "Draft Owner";
    // Simulate a concurrent metadata edit to another field (`service`) while user is typing `owner`
    S.act("board", ed => {
      ed.transact(tx => {
        const cur = tx.get(rect.id);
        if (cur) cur.customData = { ...(cur.customData ?? {}), meta: { service: "payments-api" } };
        return true;
      });
    });
    step(20);
    // Input node and draft text are preserved across redraws
    expect(page.doc.activeElement).toBe(ownerIn);
    expect(ownerIn.value).toBe("Draft Owner");
    // Committing owner merges against latest doc state and preserves collaborator's service field
    ownerIn.fire("keydown", { key: "Enter" });
    step(4);
    expect(S.eds.board.doc.get(rect.id).customData?.meta).toEqual({
      owner: "Draft Owner",
      service: "payments-api",
    });

    // Mobile tools sheet can insert swimlane and table directly
    const moreBtn = find(page.byId.dock, e => e.hasAttribute("data-dock-more"));
    moreBtn.click();
    step(4);
    const swimBtn = find(page.byId.sheet, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "Insert swimlane");
    expect(swimBtn).toBeTruthy();
    swimBtn.click();
    step(4);
    expect(S.eds.board.doc.live().filter(e => e.type === "frame").length).toBe(3);

    moreBtn.click();
    step(4);
    const tblBtn = find(page.byId.sheet, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "Insert table");
    expect(tblBtn).toBeTruthy();
    tblBtn.click();
    step(4);
    expect(S.eds.board.doc.live().filter(e => e.type === "rectangle" && e.customData?.table).length).toBe(9);
  });
});
