// #119 Boards Home redesign & customer journeys: template starter strip, calm sidebar IA with compact Spaces + actions,
// collapsible Workspace Admin section, rich visual board cards with non-wrapping timestamps, and static/CSS invariants.
import { test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeElement, installDom, textOf, byClass } from "./collab/fake-dom.js";
import { mountHome, PENDING_TEMPLATE_KEY, consumePendingTemplate } from "../../web/adapters/dom/home.js";
import { createDialogs } from "../../web/adapters/dom/dialogs.js";
import { createHomeModel } from "../../web/core/home.js";
import { virtualClock } from "../../web/adapters/clock/virtual.js";
import { staticSite } from "../../server/adapters/driving/static.js";

const card = (id, o = {}) => ({
  id,
  title: id.toUpperCase(),
  role: "editor",
  path: [{ type: "group", name: "Product" }, { type: "space", name: "Design" }],
  starred: false,
  ...o,
});

const BASE_DATA = {
  guest: false,
  user: { user: "dev:ada", name: "ada" },
  unit: { id: "t-1", kind: "company", name: "Acme", personal: true, isAdmin: true },
  limits: {},
  can: { createGroup: true, manageAccess: true, manageRoles: true },
  recent: [card("a", { role: "owner", at: 1_000_000 - 28 * 60_000 })],
  starred: [card("b", { starred: true, role: "viewer" })],
  owned: [],
  shared: [card("c", { role: "commenter" })],
  tree: {
    groups: [{ id: "g-1", name: "Product", spaces: [{ id: "s-1", name: "Design", personal: false }] }],
    spaces: [{ id: "s-2", name: "ada's space", personal: true }],
    more: false,
  },
};

afterEach(() => {
  delete globalThis.document;
  delete globalThis.Node;
  delete globalThis.sessionStorage;
});

async function setup(data = BASE_DATA, extra = {}) {
  const dom = installDom();
  const root = dom.root;
  globalThis.document.addEventListener = () => {};
  globalThis.document.removeEventListener = () => {};
  globalThis.Node = Object.getPrototypeOf(FakeElement);
  const clock = virtualClock({ t0: 1_000_000 });
  const api = {
    load: async () => ({ home: structuredClone(data) }),
    search: async q => ({ q, results: [], more: false }),
    star: async () => ({ ok: true }),
  };
  const model = createHomeModel({ api, clock });
  const dialogCalls = [];
  const dialogs = extra.dialogs ?? {
    newBoard: o => { dialogCalls.push(["board", o?.opener]); return null; },
    newSpace: o => { dialogCalls.push(["space", o?.opener]); return null; },
    newGroup: o => { dialogCalls.push(["group", o?.opener]); return null; },
  };
  const mounted = mountHome({
    root,
    model,
    clock,
    dialogs,
    boardHref: id => `?board=${id}`,
    spaceHref: id => `?space=${id}`,
    groupHref: id => `?group=${id}`,
    ...extra,
  });
  await model.load();
  return { root, model, clock, dialogCalls, mounted };
}

test("#119 template strip: renders 5 rich templates on Home, opens New board with prefilled title and stores pending templateId via real createDialogs, hides for guests and other views", async () => {
  const dom = installDom();
  const root = dom.root;
  globalThis.document.addEventListener = () => {};
  globalThis.document.removeEventListener = () => {};
  globalThis.Node = Object.getPrototypeOf(FakeElement);
  const store = new Map();
  globalThis.sessionStorage = /** @type {any} */ ({
    getItem: k => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  });
  const clock = virtualClock({ t0: 1_000_000 });
  const created = [];
  const spacesApi = {
    boardSpaces: async () => ({ spaces: [{ id: "s-me", name: "ada's space", personal: true, general: null, group: null }], more: false }),
    createBoard: async body => { created.push(body); return { board: { id: "b-tpl" } }; },
  };
  const navigated = [];
  const dialogs = createDialogs({
    host: root,
    api: /** @type {any} */ (spacesApi),
    hrefs: { board: id => `?board=${id}`, space: id => `?space=${id}`, group: id => `?group=${id}` },
    go: href => navigated.push(href),
    newKey: () => "tpl-key-1",
  });
  const api = {
    load: async () => ({ home: structuredClone(BASE_DATA) }),
    search: async q => ({ q, results: [], more: false }),
    star: async () => ({ ok: true }),
  };
  const model = createHomeModel({ api, clock });
  mountHome({
    root,
    model,
    clock,
    dialogs,
    boardHref: id => `?board=${id}`,
    spaceHref: id => `?space=${id}`,
    groupHref: id => `?group=${id}`,
  });
  await model.load();

  const strip = root.find(e => e.getAttribute("data-home-templates") === "true");
  expect(strip).toBeTruthy();
  const tpls = strip.findAll(e => e.hasClass("home-tpl-card"));
  expect(tpls.map(e => e.getAttribute("data-template"))).toEqual([
    "blank",
    "plenary-tour",
    "architecture",
    "presentation",
    "retro",
  ]);
  expect(tpls.map(e => textOf(e.find(x => x.hasClass("home-tpl-title"))))).toEqual([
    "Blank Board",
    "Plenary Interactive Tour",
    "System Architecture",
    "Presentation Deck",
    "Team Retro",
  ]);

  // Clicking System Architecture opens New board dialog with pre-filled title, records pending templateId, and submits cleanly
  tpls[2].click();
  await new Promise(r => setTimeout(r, 0));
  expect(JSON.parse(store.get(PENDING_TEMPLATE_KEY))).toEqual({ templateId: "architecture", createdAt: 1_000_000 });
  const dlg = root.find(e => e.getAttribute("role") === "dialog");
  expect(dlg).toBeTruthy();
  const titleInput = dlg.find(e => e.tagName === "INPUT" && e.getAttribute("aria-label") === "Title");
  expect(titleInput.value).toBe("System Architecture");
  dlg.find(e => e.tagName === "FORM").dispatch("submit");
  await new Promise(r => setTimeout(r, 0));
  expect(created).toEqual([{ title: "System Architecture", key: "tpl-key-1" }]);
  expect(navigated).toEqual(["?board=b-tpl"]);
  expect(consumePendingTemplate(globalThis.sessionStorage, 1_005_000)).toBe("architecture");
  expect(consumePendingTemplate(globalThis.sessionStorage, 1_005_000)).toBeNull();

  // Cancelling a template dialog clears the pending template seed immediately
  tpls[1].click();
  await new Promise(r => setTimeout(r, 0));
  expect(store.has(PENDING_TEMPLATE_KEY)).toBe(true);
  const cancelBtn = root.find(e => e.getAttribute("role") === "dialog").findAll(e => e.tagName === "BUTTON").find(b => textOf(b) === "Cancel");
  cancelBtn.click();
  expect(store.has(PENDING_TEMPLATE_KEY)).toBe(false);

  // Clicking Blank Board leaves pending template clear
  tpls[0].click();
  await new Promise(r => setTimeout(r, 0));
  expect(store.get(PENDING_TEMPLATE_KEY)).toBeUndefined();

  // Switching to Starred hides the template strip
  root.find(e => e.getAttribute("data-fk") === "nav:starred").click();
  expect(root.find(e => e.getAttribute("data-home-templates") === "true")).toBeUndefined();

  // Guests never see the template strip
  const guestSetup = await setup({ ...BASE_DATA, guest: true, unit: null, tree: null, can: {} });
  expect(guestSetup.root.find(e => e.getAttribute("data-home-templates") === "true")).toBeUndefined();
});

test("#119 sidebar IA: single primary + New board, compact + Space/Group buttons beside Spaces header, single Workspace Admin footer link hidden for non-admins even with Teams & Trash", async () => {
  // Regular member with production Teams & Trash links but no admin capabilities: Workspace Admin footer link is omitted completely
  const plain = await setup(
    { ...BASE_DATA, unit: { id: "t-1", kind: "company", name: "Acme", personal: false, isAdmin: false }, can: { createGroup: false, manageAccess: false, manageRoles: false } },
    { teamsHref: "?admin=teams", trashHref: "?trash=1", adminHref: "?admin=people" },
  );
  const plainSide = plain.root.find(e => e.hasClass("home-side"));
  expect(plainSide.find(e => e.getAttribute("data-home-admin") === "true")).toBeUndefined();
  expect(plainSide.findAll(e => e.hasClass("home-new-board")).length).toBe(1);
  const dailyLinks = plainSide.find(e => e.hasClass("home-nav-group")).findAll(e => e.tagName === "A").map(textOf);
  expect(dailyLinks).toEqual(["Teams", "Trash"]);
  const spacesHead = plainSide.find(e => e.hasClass("home-side-head"));
  expect(textOf(spacesHead.find(e => e.hasClass("home-side-label")))).toBe("Spaces");
  expect(spacesHead.findAll(e => e.hasClass("home-side-add")).map(textOf)).toEqual(["＋ New space"]);

  // Admin user: single Workspace Admin link in sidebar footer replaces the old 5-item details accordion
  const adm = await setup(BASE_DATA, {
    teamsHref: "?admin=teams",
    trashHref: "?trash=1",
    adminHref: "?admin=people",
  });
  const admSide = adm.root.find(e => e.hasClass("home-side"));
  const admFooter = admSide.find(e => e.getAttribute("data-home-admin") === "true");
  expect(admFooter).toBeTruthy();
  expect(admSide.find(e => e.tagName === "DETAILS")).toBeUndefined();
  const admLink = admFooter.find(e => e.tagName === "A");
  expect(admLink).toBeTruthy();
  expect(admLink.getAttribute("href")).toBe("?admin=people");
  expect(textOf(admLink)).toBe("Workspace Admin");
});

test("#119 rich visual board cards: preview header, role pill, title tooltip, and non-wrapping timestamp span without altering card-open text", async () => {
  const { root } = await setup();
  expect(root.find(e => e.hasClass("home-page"))).toBeTruthy();
  const firstCard = byClass(root, "card")[0];
  const preview = firstCard.find(e => e.hasClass("card-preview"));
  expect(preview).toBeTruthy();
  expect(preview.getAttribute("aria-hidden")).toBe("true");
  expect(textOf(preview)).toBe("");

  const roleBadge = firstCard.find(e => e.hasClass("card-role"));
  expect(roleBadge).toBeTruthy();
  expect(roleBadge.getAttribute("aria-hidden")).toBe("true");
  expect(textOf(roleBadge)).toBe("owner");
  expect(roleBadge.hasClass("card-role-owner")).toBe(true);

  const titleEl = firstCard.find(e => e.hasClass("t"));
  expect(titleEl.getAttribute("title")).toBe("A");

  const whenSpan = firstCard.find(e => e.hasClass("card-when"));
  expect(whenSpan).toBeTruthy();
  expect(textOf(whenSpan)).toBe("28 min ago");

  // Link text remains clean with zero duplication
  expect(textOf(firstCard.find(e => e.hasClass("card-open")))).toBe("AProduct / Design · owner · 28 min ago");
});

test("#119 static serving & CSS invariants: home.css is served, scoped to .home-page, timestamps nowrap, mobile targets >= 44px and 16px inputs", async () => {
  const repo = join(import.meta.dir, "../..");
  const site = staticSite();
  expect(site.files.has("/home.css")).toBe(true);
  const res = await site.handle(new Request("http://x/home.css"));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/css");

  const css = readFileSync(join(repo, "web/home.css"), "utf8");
  expect(css).toContain(".home-page .card-when");
  expect(css).not.toMatch(/^\.home\s/m);
  expect(css).toContain("white-space: nowrap");
  expect(css).toContain("env(safe-area-inset-top)");
  expect(css).toContain("env(safe-area-inset-bottom)");
  expect(css).toContain("font-size: 16px");
  expect(css).toContain("min-height: 44px");
  expect(css).toContain("min-width: 44px");
});
