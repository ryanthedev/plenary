// Regression tests for Wave 10 Enterprise Wiring (#33):
// Presenter "Lock audience edits" / "Unlock audience edits" toggle in Board Menu (Collaborate),
// appState.herdr.moderation.locked synchronization, mutedUsers preservation, toast feedback,
// and topbar "Locked" indicator badge.
import { describe, test, expect, afterAll } from "bun:test";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { syncCollabPort } from "../../web/adapters/collab/sync.js";
import { mountApp } from "../../web/adapters/dom/app.js";
import { installPage, stub, restoreGlobals } from "./stub-page.js";

afterAll(restoreGlobals);

const USERS = {
  "t-ada": { user: "ada", role: "owner" },
  "t-cy": { user: "cy", role: "annotator" },
  "t-vi": { user: "vi", role: "viewer" },
};

function setup({ token = "t-ada", collab = true, sharedNet = null, board = "b-mod-1" } = {}) {
  const page = installPage();
  const net = sharedNet ?? localRoom({ board, users: USERS, clock: true });
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
    me: { user: USERS[token].user, name: USERS[token].user, role: null },
    prefs: memoryStore(),
    theme: "light",
    clock: net.clock,
    collab: collab ? (S, o) => syncCollabPort(S, { name: USERS[token].user, frame: fn => net.clock.set(fn, 16), ...o }) : null,
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

describe("#33 Presenter Lock Audience Edits toggle & topbar indicator", () => {
  test("presenter can lock and unlock audience edits from Board Menu -> Collaborate, preserving mutedUsers and updating topbar badge + toast", () => {
    const { page, S, step } = setup({ token: "t-ada" });

    // Seed an existing muted user to verify toggling lock preserves mutedUsers
    S.act("board", e => e.setAppState({ moderation: { locked: false, mutedUsers: ["cy"] } }), { settings: true });
    step(2);

    // Initially unlocked: no topbar Locked badge
    expect(find(page.byId.topbar, e => e.attrs?.["data-audience-locked"] === "1")).toBeFalsy();

    // Open Board Menu -> Collaborate -> click "Lock audience edits"
    const more = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "More");
    expect(more).toBeTruthy();
    more.click();
    const menu = find(page.byId.topbar, e => e.attrs.role === "menu" && e.classList.contains("board-menu"));
    const collabGroup = findAll(menu, e => e.attrs.role === "group").find(g => g.attrs["aria-label"] === "Collaborate");
    expect(collabGroup).toBeTruthy();

    const lockBtn = find(collabGroup, e => e.attrs.role === "menuitem" && e.attrs["aria-label"] === "Lock audience edits");
    expect(lockBtn).toBeTruthy();
    lockBtn.click();
    step(3);

    // appState.herdr.moderation.locked is now true, mutedUsers preserved
    expect(S.eds.board.doc.appState?.herdr?.moderation).toEqual({ locked: true, mutedUsers: ["cy"] });
    expect(page.byId.toast.textContent).toContain("Audience edits locked");

    // Compact "Locked" indicator badge appears in topbar
    const badge = find(page.byId.topbar, e => e.attrs?.["data-audience-locked"] === "1");
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain("Locked");

    // Re-open menu: item now offers "Unlock audience edits"
    const more2 = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "More");
    more2.click();
    const menu2 = find(page.byId.topbar, e => e.attrs.role === "menu" && e.classList.contains("board-menu"));
    const unlockBtn = find(menu2, e => e.attrs.role === "menuitem" && e.attrs["aria-label"] === "Unlock audience edits");
    expect(unlockBtn).toBeTruthy();
    unlockBtn.click();
    step(3);

    // Unlocked again: mutedUsers still preserved, badge removed, toast shown
    expect(S.eds.board.doc.appState?.herdr?.moderation).toEqual({ locked: false, mutedUsers: ["cy"] });
    expect(page.byId.toast.textContent).toContain("Audience edits unlocked");
    expect(find(page.byId.topbar, e => e.attrs?.["data-audience-locked"] === "1")).toBeFalsy();
  });

  test("annotator does not see the Lock audience edits toggle, and sees the topbar Locked badge when a presenter locks the board", () => {
    const net = localRoom({ board: "b-mod-2", users: USERS, clock: true });
    const presenter = createSession({
      join: () => net.join(),
      token: "t-ada",
      board: "b-mod-2",
      client: "ada",
      user: "ada",
      clock: net.clock,
    });
    const { page, step } = setup({ token: "t-cy", sharedNet: net, board: "b-mod-2" });

    // Annotator menu does not have Lock audience edits
    const more = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "More");
    more.click();
    const menu = find(page.byId.topbar, e => e.attrs.role === "menu" && e.classList.contains("board-menu"));
    expect(find(menu, e => /audience edits/i.test(e.attrs?.["aria-label"] ?? ""))).toBeFalsy();
    expect(find(page.byId.topbar, e => e.attrs?.["data-audience-locked"] === "1")).toBeFalsy();

    // Presenter locks the board remotely -> annotator topbar rebuilds and shows "Locked" badge
    presenter.act("board", e => e.setAppState({ moderation: { locked: true, mutedUsers: [] } }), { settings: true });
    step(20);
    const badge = find(page.byId.topbar, e => e.attrs?.["data-audience-locked"] === "1");
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain("Locked");
  });
});
