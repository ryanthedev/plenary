// @ts-check
// Mobile Phase 3 (#96) & Phase 4 (#97) test suite:
// - #96: Home Org Drawer, sticky Recent|Starred|Shared tabs, full-width board cards with 44px star + bottom-sheet actions,
//        + New board FAB, Share & Move mobile bottom sheets (1-tap Copy board link / navigator.share),
//        and Admin/RBAC single-column mobile cards (roles, offboard, access, trash) at 360x667 & 390x844.
// - #97: Pure priority-collapse meeting bar (zero browser globals), <= 20% viewport chrome across
//        360x667 & 375x667 portrait & landscape, #top-stack/#meeting-bar/#context-bar, Shared Timer sheet,
//        Voting (Canvas-Tap + Vote as List + ranked results), Anonymous pre-send cue,
//        and Audience Q&A & Live Polls full-height sheet (< 3-tap poll/Q&A/dot-vote flows).

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installPage, restoreGlobals, E } from "./stub-page.js";
import { virtualClock } from "../../web/adapters/clock/virtual.js";
import { createHomeModel } from "../../web/core/home.js";
import { createShareModel } from "../../web/core/share.js";
import { createMoveModel } from "../../web/core/move.js";
import { createRolesModel } from "../../web/core/role-admin.js";
import { createOffboardModel } from "../../web/core/offboard.js";
import { createAccessModel } from "../../web/core/access.js";
import { createTrashModel } from "../../web/core/trash.js";
import { mountHome } from "../../web/adapters/dom/home.js";
import { openShare } from "../../web/adapters/dom/share.js";
import { openMove } from "../../web/adapters/dom/move.js";
import { mountRolesPage } from "../../web/adapters/dom/roles.js";
import { mountOffboardPage } from "../../web/adapters/dom/offboard.js";
import { mountAccessPage } from "../../web/adapters/dom/access.js";
import { mountTrashPage } from "../../web/adapters/dom/trash.js";
import {
  computeMeetingBarLayout,
  formatTimerClock,
  rankVotingResults,
  sortQaQuestions,
  computePollTallies,
  anonymousCueText,
  MAX_CHROME_RATIO,
} from "../../web/core/mobile/meeting-bar.js";
import { mountMobileMeetingBar } from "../../web/adapters/dom/mobile/meeting-bar.js";

const ROOT = join(import.meta.dir, "..", "..");
const CSS_PATH = join(ROOT, "web", "styles", "mobile-phase3-4.css");

const flush = () => new Promise(r => setTimeout(r, 0));

/** Helper to find elements in stub-page trees. */
const allOf = (root, pred) => root.all().filter(pred);
const firstOf = (root, pred) => root.all().find(pred) ?? null;

function setViewportMedia(width) {
  globalThis.matchMedia = q => {
    const m = /max-width:\s*(\d+)px/.exec(q);
    const matches = m ? width <= Number(m[1]) : false;
    return { matches, addEventListener() {}, removeEventListener() {} };
  };
}

function makeHomeData({ guest = false } = {}) {
  const board1 = { id: "b1", title: "Q4 Architecture", path: [{ id: "s1", name: "Engineering" }], role: "owner", at: 1_700_000_000_000, starred: false, can: { move: true } };
  const board2 = { id: "b2", title: "Design Review", path: [{ id: "s2", name: "Design" }], role: "editor", at: 1_700_000_005_000, starred: true, can: { move: false } };
  return {
    guest,
    user: { id: "u1", name: "Ada Lovelace" },
    unit: { id: "org1", name: "Acme Studio", personal: false, isAdmin: true },
    can: { createGroup: true, manageAccess: true, manageRoles: true },
    recent: [board1, board2],
    starred: guest ? [] : [board2],
    shared: [board2],
    tree: {
      groups: [{ id: "g1", name: "Product", spaces: [{ id: "s1", name: "Engineering", personal: false }] }],
      spaces: [{ id: "s2", name: "Design", personal: false }],
      more: false,
    },
  };
}

afterAll(() => restoreGlobals());

describe("Issue #96 — Mobile Home, Share, Move & Admin/RBAC cards", () => {
  beforeEach(() => {
    installPage();
    setViewportMedia(360);
  });

  test("360x667 & 390x844 Home: Org Navigation Drawer, sticky Recent|Starred|Shared tabs, 44px card actions sheet, and + New board FAB", async () => {
    for (const width of [360, 390]) {
      setViewportMedia(width);
      const root = new E("div");
      document.body.append(root);
      const clock = virtualClock({ t0: 1_700_000_010_000 });
      let data = makeHomeData();
      let starCalls = [];
      let newBoardOpened = 0;
      const api = {
        async load() { return { home: structuredClone(data) }; },
        async star(id, on) {
          starCalls.push([id, on]);
          for (const list of [data.recent, data.shared]) for (const b of list) if (b.id === id) b.starred = on;
          data.starred = data.recent.filter(b => b.starred);
          return { ok: true };
        },
        async search(q) { return { q, results: [], more: false }; },
      };
      const model = createHomeModel({ api, clock });
      await model.load();

      let copied = [];
      globalThis.navigator = /** @type {any} */ ({ clipboard: { writeText: async t => { copied.push(t); } } });

      const mounted = mountHome({
        root,
        model,
        clock,
        boardHref: id => `?board=${id}`,
        spaceHref: id => `?space=${id}`,
        groupHref: id => `?group=${id}`,
        dialogs: {
          newBoard: () => { newBoardOpened++; return { close() {} }; },
          newSpace: () => ({ close() {} }),
          newGroup: () => ({ close() {} }),
        },
      });

      // 1. Org Navigation Drawer toggle (☰) opens & closes cleanly, Escape returns focus
      const toggle = firstOf(root, e => e.getAttribute("data-mobile-drawer-toggle") === "true");
      const side = firstOf(root, e => e.getAttribute("id") === "home-side");
      expect(toggle).not.toBeNull();
      expect(toggle.textContent).toBe("☰");
      expect(side.getAttribute("data-drawer-open")).toBe("false");

      toggle.click();
      expect(side.getAttribute("data-drawer-open")).toBe("true");
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(firstOf(side, e => e.getAttribute("data-drawer-org-badge") === "true")).not.toBeNull();
      const drawerFoot = firstOf(side, e => e.getAttribute("data-drawer-footer") === "true");
      expect(drawerFoot).not.toBeNull();
      expect(firstOf(drawerFoot, e => e.getAttribute("data-drawer-action") === "help")).not.toBeNull();
      expect(firstOf(drawerFoot, e => e.getAttribute("data-drawer-action") === "theme")).not.toBeNull();

      document.fire("keydown", { key: "Escape" });
      expect(side.getAttribute("data-drawer-open")).toBe("false");
      expect(document.activeElement).toBe(toggle);

      // 2. Sticky Recent | Starred | Shared tabs
      const tabs = allOf(root, e => e.getAttribute("role") === "tab");
      expect(tabs.map(t => t.getAttribute("data-mobile-tab"))).toEqual(["home", "starred", "shared"]);
      expect(tabs[0].getAttribute("aria-selected")).toBe("true");

      tabs[1].click();
      expect(model.state.view).toBe("starred");
      const updatedTabs = allOf(root, e => e.getAttribute("role") === "tab");
      expect(updatedTabs[1].getAttribute("aria-selected")).toBe("true");

      updatedTabs[2].click();
      expect(model.state.view).toBe("shared");

      updatedTabs[0].click();
      expect(model.state.view).toBe("home");

      // 3. Full-width board card: star button + mobile bottom-sheet actions
      const starBtn = firstOf(root, e => e.classList.contains("star"));
      expect(starBtn).not.toBeNull();
      const cardActionsBtn = firstOf(root, e => e.getAttribute("data-mobile-card-actions") === "b1");
      expect(cardActionsBtn).not.toBeNull();
      cardActionsBtn.click();

      const sheet = firstOf(root, e => e.getAttribute("data-mobile-board-sheet") === "b1");
      expect(sheet).not.toBeNull();
      expect(sheet.getAttribute("role")).toBe("dialog");
      expect(sheet.getAttribute("aria-modal")).toBe("true");

      const copyAction = firstOf(sheet, e => e.getAttribute("data-card-sheet-action") === "copy-link");
      expect(copyAction).not.toBeNull();
      copyAction.click();
      await flush();
      expect(copied.length).toBe(1);
      expect(copied[0]).toContain("?board=b1");
      expect(firstOf(root, e => e.getAttribute("data-mobile-board-sheet") === "b1")).toBeNull();

      // 4. Bottom-right + New board FAB
      const fab = firstOf(root, e => e.getAttribute("data-mobile-fab") === "new-board");
      expect(fab).not.toBeNull();
      fab.click();
      expect(newBoardOpened).toBe(1);

      mounted.destroy();
    }
  });

  test("Share mobile bottom sheet: full-width sheet class + 1-tap Copy board link & navigator.share", async () => {
    const host = new E("div");
    document.body.append(host);
    const shareApi = {
      async view() {
        return {
          view: {
            board: { id: "b1", title: "Roadmap" },
            unit: { domains: ["acme.test"] },
            limits: { inviteRoles: ["editor", "viewer"], linkRoles: ["viewer"], inviteTtlMs: 30 * 86_400_000 },
            invites: [],
            links: [],
            more: false,
          },
        };
      },
    };
    const model = createShareModel({
      share: /** @type {any} */ (shareApi),
      board: "b1",
      urls: {
        board: "https://plenary.test/?board=b1",
        link: id => `https://plenary.test/?link=${id}`,
      },
    });

    const copied = [];
    const shared = [];
    const dlg = openShare({
      host,
      model,
      copy: async text => { copied.push(text); return true; },
      share: async data => { shared.push(data); },
    });
    await flush();

    // Sheet mode classes & grabber present
    expect(dlg.dialog.classList.contains("sp-sheet-dialog")).toBe(true);
    expect(dlg.el.classList.contains("sp-sheet-veil")).toBe(true);
    expect(firstOf(dlg.dialog, e => e.classList.contains("sheet-grabber"))).not.toBeNull();

    // 1-tap Copy board link at top of sheet
    const quickCopy = firstOf(dlg.dialog, e => e.getAttribute("data-fk") === "share-quick-copy");
    expect(quickCopy).not.toBeNull();
    quickCopy.click();
    await flush();
    expect(copied).toEqual(["https://plenary.test/?board=b1"]);

    // 1-tap navigator.share at top of sheet
    const quickShare = firstOf(dlg.dialog, e => e.getAttribute("data-fk") === "share-quick-native");
    expect(quickShare).not.toBeNull();
    quickShare.click();
    await flush();
    expect(shared).toEqual([{ title: "Roadmap", url: "https://plenary.test/?board=b1" }]);

    dlg.close();
  });

  test("Move mobile bottom sheet uses sp-sheet-dialog mode", async () => {
    const host = new E("div");
    document.body.append(host);
    const moveApi = {
      async options() {
        return {
          options: {
            board: { id: "b1", title: "Roadmap" },
            from: { id: "s0", name: "General", personal: false },
            destinations: [{ id: "s1", name: "Engineering", personal: false, general: "viewer", group: null }],
            more: false,
          },
        };
      },
      async preview() { return { diff: { gains: [], keeps: [], loses: [], invites: 0, links: 0, hidden: false, more: false } }; },
      async move() { return { result: { moved: true } }; },
    };
    const model = createMoveModel({ move: /** @type {any} */ (moveApi), board: "b1" });
    const dlg = openMove({ host, model, onMoved() {} });
    await flush();

    expect(dlg.dialog.classList.contains("sp-sheet-dialog")).toBe(true);
    expect(dlg.el.classList.contains("sp-sheet-veil")).toBe(true);
    expect(firstOf(dlg.dialog, e => e.classList.contains("sheet-grabber"))).not.toBeNull();
    dlg.close();
  });

  test("Admin & RBAC: Roles and Offboard collapse table.matrix into single-column mobile cards below 640px", async () => {
    // Roles page at 360px
    setViewportMedia(360);
    const rolesRoot = new E("div");
    document.body.append(rolesRoot);
    const rolesApi = {
      async roles() {
        return {
          page: {
            roles: [
              {
                id: "r-custom",
                name: "Facilitator",
                kind: "custom",
                editable: true,
                ladder: "editor",
                permissions: ["members.manage"],
                scopes: { unit: ["members.manage"], group: [], space: ["members.manage"], board: ["board.edit"] },
                summary: "Runs sessions",
                used: { places: 2, capped: false },
              },
            ],
            matrix: {
              scopes: ["unit", "space", "board"],
              ladders: ["viewer", "editor"],
              permissions: [
                { id: "board.edit", group: "content", scopes: ["board"] },
                { id: "members.manage", group: "management", scopes: ["unit", "space"] },
              ],
              content: { editor: ["board.edit"], viewer: [] },
              tickable: ["members.manage"],
            },
            can: { admin: true },
            limits: { custom: 20, many: { places: 5, people: 20 } },
          },
        };
      },
    };
    const rolesModel = createRolesModel({ api: /** @type {any} */ (rolesApi) });
    const rolesPage = mountRolesPage({ root: rolesRoot, model: rolesModel, hrefs: { home: "./" } });
    await rolesModel.load();
    await flush();

    // Mobile cards rendered instead of wide table.matrix
    expect(firstOf(rolesRoot, e => e.getAttribute("data-mobile-cards") === "roles")).not.toBeNull();
    expect(firstOf(rolesRoot, e => e.tagName === "TABLE")).toBeNull();
    const permCheckbox = firstOf(rolesRoot, e => e.getAttribute("data-fk") === "perm:members.manage");
    expect(permCheckbox).not.toBeNull();
    expect(firstOf(rolesRoot, e => e.classList.contains("mobile-touch-row"))).not.toBeNull();
    rolesPage.destroy();

    // Offboard page at 390px
    setViewportMedia(390);
    const offRoot = new E("div");
    document.body.append(offRoot);
    const offApi = {
      async people() { return { people: [{ id: "u2", name: "Bob" }] }; },
      async list() {
        return {
          page: {
            member: { id: "u1", name: "Grace", email: "grace@acme.test", removed: false },
            defaults: { recipient: { id: "u2", name: "Bob" }, reason: "manager" },
            items: [{ type: "space", id: "s1", name: "Design", boards: 4, personal: false, archived: false, trashed: false, can: { reassign: true } }],
            canRemove: false,
            blocked: null,
            next: null,
          },
        };
      },
    };
    const offModel = createOffboardModel({ api: /** @type {any} */ (offApi) });
    const offPage = mountOffboardPage({ root: offRoot, model: offModel, hrefs: { home: "./" } });
    await offModel.open("u1");
    await flush();

    expect(firstOf(offRoot, e => e.getAttribute("data-mobile-cards") === "offboard")).not.toBeNull();
    expect(firstOf(offRoot, e => e.tagName === "TABLE")).toBeNull();
    const select = firstOf(offRoot, e => e.tagName === "SELECT" && e.classList.contains("mobile-touch-row"));
    expect(select).not.toBeNull();
    expect(select.getAttribute("aria-label")).toBe("New owner of Design");
    offPage.destroy();

    // Access & Trash pages render single-column lists cleanly at 360px
    setViewportMedia(360);
    const trashRoot = new E("div");
    document.body.append(trashRoot);
    const trashModel = createTrashModel({
      api: /** @type {any} */ ({
        async list() {
          return {
            list: {
              items: [{ type: "board", id: "b9", title: "Old Plan", from: { space: { id: "s1", name: "Eng", personal: false }, group: null }, by: { id: "u1", name: "Ada" }, trashedAt: 0, expiresAt: 0, daysLeft: 12 }],
              more: false,
            },
          };
        },
      }),
    });
    const trashPage = mountTrashPage({ root: trashRoot, model: trashModel, hrefs: { home: "./" } });
    await trashModel.load();
    await flush();
    expect(firstOf(trashRoot, e => e.classList.contains("trash-row"))).not.toBeNull();
    trashPage.destroy();

    const accessRoot = new E("div");
    document.body.append(accessRoot);
    const accessModel = createAccessModel({
      api: /** @type {any} */ ({
        async access() {
          return {
            page: {
              scope: { type: "space", id: "s1", name: "Eng" },
              can: { manage: false },
              roles: [],
              rows: [{ subject: { type: "user", id: "u1", name: "Ada", email: "ada@acme.test" }, role: "owner", roleName: "Owner", via: "direct", can: {} }],
              inherited: [],
              general: [],
              next: null,
            },
          };
        },
      }),
      type: "space",
      id: "s1",
    });
    const accessPage = mountAccessPage({
      root: accessRoot,
      model: accessModel,
      api: /** @type {any} */ ({ async directory() { return { people: [], teams: [] }; } }),
      hrefs: { home: "./", space: id => `?space=${id}`, group: id => `?group=${id}`, board: id => `?board=${id}`, access: (t, id) => `?access=${t}:${id}` },
    });
    await accessModel.load();
    await flush();
    expect(firstOf(accessRoot, e => e.classList.contains("row"))).not.toBeNull();
    accessPage.destroy();
  });
});

describe("Issue #97 — Unified Meeting Bar & Epic #79 Mobile Experiences", () => {
  beforeEach(() => {
    installPage();
    setViewportMedia(360);
  });

  const FULL_MEETING_STATE = {
    active: true,
    role: "editor",
    displayName: "Ada",
    following: true,
    presenterName: "Grace Hopper",
    slideIndex: 2,
    slideCount: 10,
    timer: { status: "running", remainingMs: 185_000, durationMs: 300_000 },
    anonymous: true,
    qa: {
      open: true,
      count: 2,
      unread: 1,
      items: [
        { id: "q1", text: "Will this ship in Q4?", author: "Bob", anonymous: false, upvotes: 3, upvoted: false, answered: false, createdAt: 1 },
        { id: "q2", text: "What about offline mode?", author: "Anonymous", anonymous: true, upvotes: 7, upvoted: false, answered: false, createdAt: 2 },
      ],
    },
    polls: {
      open: true,
      activeCount: 1,
      voted: false,
      items: [
        {
          id: "p1",
          question: "Which layout should we prioritize?",
          closed: false,
          selectedOptionId: null,
          options: [
            { id: "o1", label: "Compact meeting bar", votes: 4 },
            { id: "o2", label: "Full-height Q&A sheet", votes: 2 },
          ],
        },
      ],
    },
    voting: {
      active: true,
      mode: "canvas",
      remainingDots: 3,
      totalDots: 5,
      phase: "voting",
      candidates: [
        { id: "c1", label: "Offline sync", votes: 5, mine: 1 },
        { id: "c2", label: "Mobile voting list", votes: 8, mine: 1 },
        { id: "c3", label: "Shared timer", votes: 2, mine: 0 },
      ],
    },
    canStop: true,
  };

  test("Pure priority-collapse & <= 20% chrome budget at 360x667, 375x667 portrait & landscape", () => {
    const viewports = [
      { name: "360x667 portrait", width: 360, height: 667, orientation: /** @type {const} */ ("portrait") },
      { name: "375x667 portrait", width: 375, height: 667, orientation: /** @type {const} */ ("portrait") },
      { name: "667x360 landscape", width: 667, height: 360, orientation: /** @type {const} */ ("landscape") },
      { name: "667x375 landscape", width: 667, height: 375, orientation: /** @type {const} */ ("landscape") },
    ];

    for (const vp of viewports) {
      const layout = computeMeetingBarLayout(FULL_MEETING_STATE, vp);
      expect(layout.withinBudget).toBe(true);
      expect(layout.chromeRatio).toBeLessThanOrEqual(MAX_CHROME_RATIO);
      expect(layout.orientation).toBe(vp.orientation);
      // Stop is always pinned visible
      expect(layout.visible.some(i => i.id === "stop")).toBe(true);
      // Follow (highest priority active) is visible
      expect(layout.visible.some(i => i.id === "follow")).toBe(true);
      // Every one of the 8 items is accounted for across visible + overflow
      const allIds = [...layout.visible, ...layout.overflow].map(i => i.id).sort();
      expect(allIds).toEqual(["anon", "follow", "polls", "qa", "slides", "stop", "timer", "voting"]);
      // Portrait 360px collapses lower-priority items into overflow; landscape 667px fits more
      if (vp.width <= 375) {
        expect(layout.overflow.length).toBeGreaterThan(0);
        expect(layout.showContextBar).toBe(true);
      } else {
        // Landscape suppresses #context-bar to stay <= 20% height (72px / 360px = 20%)
        expect(layout.showContextBar).toBe(false);
        expect(layout.heights.total).toBeLessThanOrEqual(Math.floor(vp.height * MAX_CHROME_RATIO));
      }
    }
  });

  test("Pure helpers: formatTimerClock, rankVotingResults, sortQaQuestions, computePollTallies, anonymousCueText", () => {
    expect(formatTimerClock(185_000)).toBe("03:05");
    expect(formatTimerClock(-12_000)).toBe("-00:12");

    const ranked = rankVotingResults(FULL_MEETING_STATE.voting.candidates);
    expect(ranked.map(r => [r.id, r.rank])).toEqual([["c2", 1], ["c1", 2], ["c3", 3]]);

    const sortedQa = sortQaQuestions(FULL_MEETING_STATE.qa.items);
    expect(sortedQa.map(q => q.id)).toEqual(["q2", "q1"]);

    const tally = computePollTallies(FULL_MEETING_STATE.polls.items[0]);
    expect(tally.totalVotes).toBe(6);
    expect(tally.options[0].pct).toBe(67);
    expect(tally.options[0].leading).toBe(true);

    expect(anonymousCueText(true, "Ada").anonymous).toBe(true);
    expect(anonymousCueText(false, "Ada").detail).toContain("Ada");
  });

  test("DOM #top-stack/#meeting-bar/#context-bar + Shared Timer sheet & viewer gating", () => {
    const host = new E("div");
    document.body.append(host);
    const events = [];
    const bar = mountMobileMeetingBar({
      host,
      state: FULL_MEETING_STATE,
      viewport: { width: 360, height: 667 },
      handlers: {
        onTimerStart: ms => events.push(["start", ms]),
        onTimerPause: () => events.push(["pause"]),
        onTimerAddMinute: () => events.push(["add-min"]),
        onTimerReset: () => events.push(["reset"]),
      },
    });

    expect(bar.el.getAttribute("id")).toBe("top-stack");
    expect(bar.meetingBar.getAttribute("id")).toBe("meeting-bar");
    expect(bar.contextBar.getAttribute("id")).toBe("context-bar");
    expect(bar.contextBar.hidden).toBe(false);

    // Tap Timer pill (1 tap) -> Timer sheet opens
    const timerPill = firstOf(bar.meetingBar, e => e.getAttribute("data-meeting-item") === "timer");
    expect(timerPill).not.toBeNull();
    timerPill.click();

    expect(bar.sheetEl.hidden).toBe(false);
    expect(firstOf(bar.sheetEl, e => e.getAttribute("data-sheet-kind") === "timer")).not.toBeNull();

    // Pause, +1m, Preset 5m, Reset
    firstOf(bar.sheetEl, e => e.getAttribute("data-timer-action") === "pause").click();
    firstOf(bar.sheetEl, e => e.getAttribute("data-timer-action") === "add-min").click();
    firstOf(bar.sheetEl, e => e.getAttribute("data-timer-preset") === "300000").click();
    firstOf(bar.sheetEl, e => e.getAttribute("data-timer-action") === "reset").click();
    expect(events).toEqual([["pause"], ["add-min"], ["start", 300_000], ["reset"]]);

    // Viewer sees read-only timer sheet (no start/pause controls)
    bar.update({ role: "viewer" });
    expect(firstOf(bar.sheetEl, e => e.getAttribute("data-timer-action") != null)).toBeNull();

    bar.destroy();
  });

  test("Dot Voting < 3-tap flow: Canvas-Tap -> Vote as List toggle -> cast vote -> ranked results", () => {
    const host = new E("div");
    document.body.append(host);
    const votes = [];
    const modes = [];
    const bar = mountMobileMeetingBar({
      host,
      state: structuredClone(FULL_MEETING_STATE),
      viewport: { width: 360, height: 667 },
      handlers: {
        onVoteModeChange: m => modes.push(m),
        onVoteCast: (id, delta) => votes.push([id, delta]),
      },
    });

    // Tap 1: Context bar "Vote as List" button opens voting sheet directly in list mode!
    const ctxToggle = firstOf(bar.contextBar, e => e.getAttribute("data-context-action") === "toggle-vote-mode");
    expect(ctxToggle).not.toBeNull();
    expect(ctxToggle.textContent).toBe("Vote as List");
    ctxToggle.click();
    expect(modes).toEqual(["list"]);

    // Tap 2: Cast a dot vote on candidate c1 (2 taps total — strictly < 3 taps!)
    const incC1 = firstOf(bar.sheetEl, e => e.getAttribute("data-vote-inc") === "c1");
    expect(incC1).not.toBeNull();
    incC1.click();
    expect(votes).toEqual([["c1", 1]]);
    expect(firstOf(bar.sheetEl, e => e.getAttribute("data-remaining-dots") === "2")).not.toBeNull();

    // Switch to Results tab and verify ranked order (#1 c2: 8, #2 c1: 6, #3 c3: 2)
    firstOf(bar.sheetEl, e => e.getAttribute("data-vote-mode") === "results").click();
    const resultRows = allOf(bar.sheetEl, e => e.classList.contains("voting-result-row"));
    expect(resultRows.map(r => r.getAttribute("data-candidate"))).toEqual(["c2", "c1", "c3"]);
    expect(resultRows[0].getAttribute("data-rank")).toBe("1");

    bar.destroy();
  });

  test("Audience Q&A & Live Polls full-height sheet: < 3-tap poll vote, < 3-tap Q&A upvote, and anonymous pre-send cue", () => {
    const host = new E("div");
    document.body.append(host);
    const pollVotes = [];
    const qaUpvotes = [];
    const qaSubmitted = [];

    // Use state where Polls & Q&A are directly visible in #meeting-bar (no overflow needed)
    const state = {
      active: true,
      role: "viewer",
      displayName: "Ada",
      anonymous: true,
      polls: structuredClone(FULL_MEETING_STATE.polls),
      qa: structuredClone(FULL_MEETING_STATE.qa),
    };

    const bar = mountMobileMeetingBar({
      host,
      state,
      viewport: { width: 375, height: 667 },
      handlers: {
        onPollVote: (pid, oid) => pollVotes.push([pid, oid]),
        onQaUpvote: qid => qaUpvotes.push(qid),
        onQaSubmit: (text, anon) => qaSubmitted.push([text, anon]),
      },
    });

    // < 3-tap Poll vote flow: Tap 1 = Polls pill, Tap 2 = Poll option (2 taps total!)
    const pollsPill = firstOf(bar.meetingBar, e => e.getAttribute("data-meeting-item") === "polls");
    expect(pollsPill).not.toBeNull();
    pollsPill.click();
    expect(bar.sheetEl.classList.contains("is-full-height")).toBe(true);
    // Anonymous pre-send cue is visible before voting
    expect(firstOf(bar.sheetEl, e => e.getAttribute("data-anon-cue") === "anonymous")).not.toBeNull();

    const pollOpt = firstOf(bar.sheetEl, e => e.getAttribute("data-poll-option") === "o1");
    expect(pollOpt).not.toBeNull();
    pollOpt.click();
    expect(pollVotes).toEqual([["p1", "o1"]]);
    expect(firstOf(bar.sheetEl, e => e.getAttribute("data-poll-option") === "o1").getAttribute("aria-pressed")).toBe("true");
    bar.closeSheet();

    // < 3-tap Q&A upvote flow: Tap 1 = Q&A pill, Tap 2 = Upvote button (2 taps total!)
    const qaPill = firstOf(bar.meetingBar, e => e.getAttribute("data-meeting-item") === "qa");
    expect(qaPill).not.toBeNull();
    qaPill.click();
    const upvoteBtn = firstOf(bar.sheetEl, e => e.getAttribute("data-qa-upvote") === "q2");
    expect(upvoteBtn).not.toBeNull();
    upvoteBtn.click();
    expect(qaUpvotes).toEqual(["q2"]);
    expect(firstOf(bar.sheetEl, e => e.getAttribute("data-qa-upvote") === "q2").getAttribute("aria-pressed")).toBe("true");

    // Anonymous pre-send cue visible in Q&A compose bar, submitting sends anonymous=true
    expect(firstOf(bar.sheetEl, e => e.getAttribute("data-anon-cue") === "anonymous")).not.toBeNull();
    const qaInput = firstOf(bar.sheetEl, e => e.classList.contains("qa-compose-input"));
    qaInput.value = "Can we export slides?";
    qaInput.fire("input", { target: { value: "Can we export slides?" } });
    const qaForm = firstOf(bar.sheetEl, e => e.tagName === "FORM");
    qaForm.fire("submit");
    expect(qaSubmitted).toEqual([["Can we export slides?", true]]);

    bar.destroy();
  });

  test("CSS contract: 48px poll buttons, 44x44px Q&A upvote & star targets, 640px breakpoint, 16px inputs", () => {
    const css = readFileSync(CSS_PATH, "utf8");
    expect(css).toContain("@media (max-width: 640px)");
    expect(css).toMatch(/\.poll-option-btn\s*\{[^}]*min-height:\s*48px/s);
    expect(css).toMatch(/\.qa-upvote-btn\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s);
    expect(css).toMatch(/\.home-page \.card \.star,\s*\.home-page \.card \.card-mobile-actions\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s);
    expect(css).toMatch(/\.mobile-touch-row\s*\{[^}]*min-height:\s*44px/s);
    expect(css).toMatch(/\.qa-compose-input\s*\{[^}]*font-size:\s*16px/s);
    // Phase 1 Mobile Chrome Diet & Drawer Vertical Column Contract
    expect(css).toMatch(/\.home-page \.home-top \.home-searchbox\s*\{[^}]*flex:\s*1 0 100%/s);
    expect(css).toMatch(/\.home-page \.home-nav-group,[\s\S]*?\.home-page \.home-admin-list\s*\{[^}]*flex-direction:\s*column[^}]*align-items:\s*stretch[^}]*overflow-x:\s*visible/s);
    expect(css).toMatch(/\.home-page \.home-side \.nav,\s*\.home-page \.home-side \.nav\.sub\s*\{[^}]*width:\s*100%[^}]*min-height:\s*44px/s);
    expect(css).toMatch(/table\.matrix\s*\{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.home-page \.card \.card-mobile-actions\s*\{[^}]*position:\s*absolute/s);
  });
});
