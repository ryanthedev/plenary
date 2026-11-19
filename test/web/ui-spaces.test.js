// The Space page, the Group page and the New board / New space / General access dialogs (web/adapters/dom/spaces.js, dialogs.js) over the
// collab tests' small fake DOM: what renders, keyboard paths (menu, rename in place, dialog focus), text safety, and refusals.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { FakeElement, installDom, textOf, byClass } from "./collab/fake-dom.js";
import { mountSpacePage, mountGroupPage, overflowMenu } from "../../web/adapters/dom/spaces.js";
import { createDialogs, openDialog } from "../../web/adapters/dom/dialogs.js";
import { createPageModel } from "../../web/core/spaces.js";

const hrefs = { home: "./", board: id => `?board=${id}`, space: id => `?space=${id}`, group: id => `?group=${id}` };
const SP = (o = {}) => ({ space: { id: "s-1", name: "Design", personal: false, general: "viewer", group: { id: "g-1", name: "Product" } }, can: { createBoard: true, rename: true, general: true },
  boards: [{ id: "b-1", title: "Roadmap", role: "editor", path: [], starred: false, can: { rename: true } }, { id: "b-2", title: "Locked", role: "viewer", path: [], starred: false, can: { rename: false } }], more: false, ...o });
const GP = (o = {}) => ({ group: { id: "g-1", name: "Product", general: null }, can: { createSpace: true, rename: true, general: false }, spaces: [{ id: "s-1", name: "Design", general: "viewer" }, { id: "s-2", name: "Q4", general: null }], next: null, ...o });
let root, api, calls, closes, focused;
const settle = () => new Promise(r => setTimeout(r, 0));
const buttons = () => root.findAll(e => e.tagName === "BUTTON");
const btn = text => buttons().find(b => textOf(b).trim() === text || b.getAttribute("aria-label") === text);
const key = (el, k, ev = {}) => el.dispatch("keydown", { key: k, ...ev });

beforeEach(() => {
  const dom = installDom(); root = dom.root;
  globalThis.Node = Object.getPrototypeOf(FakeElement);
  globalThis.document.addEventListener = () => {}; globalThis.document.removeEventListener = () => {};
  calls = []; closes = []; focused = [];
  FakeElement.prototype.focus = function () { focused.push(this); };
  api = new Proxy({ pages: { space: SP(), group: GP() } }, { get: (t, name) => t[name] ?? ((...a) => { calls.push([name, ...a]); return Promise.resolve(t.answer?.(name, ...a) ?? { error: "unavailable" }); }) });
  api.answer = (name, ...a) => ({
    space: () => ({ page: structuredClone(api.pages.space) }), group: () => ({ page: structuredClone(api.pages.group) }),
    updateSpace: (id, p) => ({ space: { id, name: p.name ?? api.pages.space.space.name, personal: false, general: "general" in p ? p.general : "viewer", group: null } }),
    updateGroup: (id, p) => ({ group: { id, name: p.name ?? "Product", general: null } }),
    renameBoard: (id, t) => ({ board: { id, title: t } }),
    boardSpaces: () => ({ spaces: [{ id: "s-me", name: "ada's space", personal: true, general: null, group: null }, { id: "s-1", name: "Design", personal: false, general: "viewer", group: { id: "g-1", name: "Product" } }], more: false }),
    spaceGroups: () => ({ root: true, groups: [{ id: "g-1", name: "Product" }], more: false }),
    createGroup: () => ({ group: { id: "g-new", name: "Org" } }), createBoard: () => ({ board: { id: "b-new" } }), createSpace: () => ({ space: { id: "s-new", name: "Q4", personal: false, general: "viewer", group: null } }),
  })[name]?.(...a);
});
afterEach(() => { delete globalThis.document; delete globalThis.Node; });

const dialogsFor = () => createDialogs({ host: root, api, hrefs, go: h => closes.push(h) });
async function spacePage(page = SP()) {
  api.pages.space = page;
  const model = createPageModel({ api, kind: "space", id: "s-1" });
  const m = mountSpacePage({ root, model, dialogs: dialogsFor(), hrefs });
  await model.load();
  return { model, m };
}

test("Space page: crumbs, title, badge, general access, boards as links; New board is enabled", async () => {
  await spacePage();
  expect(root.findAll(e => e.tagName === "A").map(e => [e.getAttribute("href"), textOf(e)])).toEqual([["./", "Plenary"], ["./", "Home"], ["?group=g-1", "Product"], ["?board=b-1", "Roadmapeditor"], ["?board=b-2", "Lockedviewer"]]);
  expect(textOf(root.find(e => e.tagName === "H1"))).toBe("Design");
  expect(textOf(root.find(e => e.hasClass("badge")))).toBe("Space");
  expect(textOf(root.find(e => e.hasClass("sub-h")))).toBe("Everyone can view");
  expect(root.find(e => e.getAttribute("aria-label") === "Breadcrumb")).toBeTruthy();
  const nb = btn("＋ New board");
  expect(nb.disabled).toBe(false);
});

test("a person who can't create sees a disabled New board with a reason, and no Space options", async () => {
  await spacePage(SP({ can: { createBoard: false, rename: false, general: false }, boards: [] }));
  const nb = btn("＋ New board");
  expect([nb.disabled, nb.getAttribute("aria-disabled"), nb.getAttribute("title")]).toEqual([true, "true", "You can't add boards here"]);
  expect(btn("Space options")).toBeUndefined();
  expect(textOf(root.find(e => e.hasClass("home-empty")))).toBe("No boards yet.You can't add boards here; ask an owner to add you as an editor.");
});

test("a personal space: its badge and copy; New board opens the dialog from the clicked button", async () => {
  await spacePage(SP({ space: { id: "s-1", name: "ada's space", personal: true, general: null, group: null }, can: { createBoard: true, rename: false, general: false }, boards: [] }));
  expect(textOf(root.find(e => e.hasClass("badge")))).toBe("Personal · only you");
  expect(textOf(root.find(e => e.hasClass("sub-h")))).toMatch(/^Only you can see/);
  const nb = btn("＋ New board"); nb.click(); await settle();
  const dlg = root.find(e => e.getAttribute("role") === "dialog");
  expect(dlg.getAttribute("aria-modal")).toBe("true");
  expect(textOf(root.find(e => e.getAttribute("id") === dlg.getAttribute("aria-labelledby")))).toBe("New board");
});

test("overflow menu: opens on click with aria-expanded, arrow keys move focus, Escape closes and returns focus to the button", async () => {
  await spacePage();
  const more = btn("Space options");
  expect([more.getAttribute("aria-haspopup"), more.getAttribute("aria-expanded")]).toEqual(["menu", "false"]);
  more.click();
  expect(more.getAttribute("aria-expanded")).toBe("true");
  const menu = root.find(e => e.getAttribute("role") === "menu");
  const items = menu.findAll(e => e.getAttribute("role") === "menuitem");
  expect(items.map(textOf)).toEqual(["Rename", "General access…"]);
  expect(focused.at(-1)).toBe(items[0]);
  globalThis.document.activeElement = items[0]; key(menu, "ArrowDown");
  expect(focused.at(-1)).toBe(items[1]);
  globalThis.document.activeElement = items[1]; key(menu, "ArrowDown");
  expect(focused.at(-1)).toBe(items[0]);                       // wraps
  globalThis.document.activeElement = items[0]; key(menu, "ArrowUp"); expect(focused.at(-1)).toBe(items[1]);
  key(menu, "Escape");
  expect(root.find(e => e.getAttribute("role") === "menu")).toBeUndefined();
  expect([more.getAttribute("aria-expanded"), focused.at(-1)]).toEqual(["false", more]);
});

test("rename in place: the title becomes an input; Enter saves through the port; the new name shows; Escape cancels with no request", async () => {
  await spacePage();
  btn("Space options").click();
  root.findAll(e => e.getAttribute("role") === "menuitem")[0].click();
  const input = root.find(e => e.tagName === "INPUT" && e.getAttribute("aria-label") === "Space name");
  expect(input.value).toBe("Design");
  key(input, "Escape");
  expect(root.find(e => e.getAttribute("aria-label") === "Space name")).toBeUndefined();
  expect(calls.filter(c => c[0] === "updateSpace")).toEqual([]);
  btn("Space options").click(); root.findAll(e => e.getAttribute("role") === "menuitem")[0].click();
  const i2 = root.find(e => e.getAttribute("aria-label") === "Space name");
  i2.value = "Brand"; key(i2, "Enter"); await settle();
  expect(calls.at(-1)).toEqual(["updateSpace", "s-1", { name: "Brand" }]);
  expect(textOf(root.find(e => e.tagName === "H1"))).toBe("Brand");
});

test("the blur of the removed input never saves the old name over the new one; a refused save can be retried with Enter", async () => {
  await spacePage();
  btn("Space options").click(); root.findAll(e => e.getAttribute("role") === "menuitem")[0].click();
  const i = root.find(e => e.getAttribute("aria-label") === "Space name");
  i.value = "Brand"; key(i, "Enter");
  expect(root.find(e => e.getAttribute("aria-label") === "Space name")).toBe(i);     // the same input survives the busy re-render
  await settle();
  i.dispatch("blur");                                                                 // what the browser fires when the input leaves the page
  await settle();
  expect(calls.filter(c => c[0] === "updateSpace")).toEqual([["updateSpace", "s-1", { name: "Brand" }]]);
  expect(textOf(root.find(e => e.tagName === "H1"))).toBe("Brand");
  // refused, then retried
  let refuse = true;
  api.answer = (n, id, p) => (n === "updateSpace" ? (refuse ? { error: "unavailable" } : { space: { id, name: p.name, personal: false, general: "viewer", group: null } }) : undefined);
  btn("Space options").click(); root.findAll(e => e.getAttribute("role") === "menuitem")[0].click();
  const j = root.find(e => e.getAttribute("aria-label") === "Space name");
  j.value = "Again"; key(j, "Enter"); await settle();
  expect(root.find(e => e.getAttribute("aria-label") === "Space name")).toBe(j);
  refuse = false; key(j, "Enter"); await settle();
  expect(textOf(root.find(e => e.tagName === "H1"))).toBe("Again");
});

test("a refused rename keeps editing open and shows why", async () => {
  await spacePage();
  api.answer = (n) => (n === "updateSpace" ? { error: "forbidden" } : undefined);
  btn("Space options").click(); root.findAll(e => e.getAttribute("role") === "menuitem")[0].click();
  const i = root.find(e => e.getAttribute("aria-label") === "Space name");
  i.value = "X"; key(i, "Enter"); await settle();
  expect(textOf(root.find(e => e.hasClass("home-status")))).toMatch(/You can't do that here/);
  expect(root.find(e => e.getAttribute("aria-label") === "Space name")).toBeTruthy();
});

test("a board card: Open is a link; Rename shows only where the server says can.rename; Enter saves, the title updates", async () => {
  await spacePage();
  const menus = root.findAll(e => e.tagName === "BUTTON" && /^More for/.test(e.getAttribute("aria-label") ?? ""));
  expect(menus.map(e => e.getAttribute("aria-label"))).toEqual(["More for Roadmap", "More for Locked"]);
  menus[1].click();
  expect(root.findAll(e => e.getAttribute("role") === "menuitem").map(textOf)).toEqual(["Open"]);          // Locked: no rename
  menus[1].click();
  root.findAll(e => e.tagName === "BUTTON" && /^More for/.test(e.getAttribute("aria-label") ?? ""))[0].click();
  const items = root.findAll(e => e.getAttribute("role") === "menuitem");
  expect(items.map(e => [e.tagName, textOf(e)])).toEqual([["A", "Open"], ["BUTTON", "Rename"]]);
  expect(items[0].getAttribute("href")).toBe("?board=b-1");
  items[1].click();
  const i = root.find(e => e.getAttribute("aria-label") === "Board title");
  i.value = "Plan"; key(i, "Enter"); await settle();
  expect(calls.at(-1)).toEqual(["renameBoard", "b-1", "Plan"]);
  expect(textOf(byClass(root, "card-open")[0])).toMatch(/^Plan/);
});

test("General access opens a labelled dialog that saves through the port and closes", async () => {
  await spacePage();
  btn("Space options").click(); root.findAll(e => e.getAttribute("role") === "menuitem")[1].click();
  const dlg = root.find(e => e.getAttribute("role") === "dialog");
  const sel = dlg.find(e => e.tagName === "SELECT");
  expect(sel.getAttribute("aria-label")).toBe("General access");
  expect(sel.findAll(e => e.tagName === "OPTION").map(textOf)).toEqual(["Everyone can view", "Everyone can comment", "Everyone can annotate", "Everyone can edit", "Only people added"]);
  sel.value = "none";
  dlg.find(e => e.tagName === "FORM").dispatch("submit"); await settle();
  expect(calls.at(-1)).toEqual(["updateSpace", "s-1", { general: null }]);
  expect(root.find(e => e.getAttribute("role") === "dialog")).toBeUndefined();
});

test("a hidden, unknown or forbidden page shows one neutral message with no names; an outage offers retry; signed out offers sign-in", async () => {
  for (const e of ["notfound", "forbidden"]) {
    api.answer = () => ({ error: e });
    const model = createPageModel({ api, kind: "space", id: "s-1" });
    mountSpacePage({ root, model, dialogs: dialogsFor(), hrefs }); await model.load();
    expect(textOf(root.find(x => x.hasClass("home-empty")))).toBe("This page is not available.It may not exist, or you may not have access to it.");
    expect(textOf(root)).not.toMatch(/Design|Product/);
  }
  api.answer = () => ({ error: "network" });
  const m2 = createPageModel({ api, kind: "space", id: "s-1" });
  mountSpacePage({ root, model: m2, dialogs: dialogsFor(), hrefs }); await m2.load();
  expect(textOf(root.find(x => x.hasClass("home-empty")))).toMatch(/Could not load/);
  expect(btn("Try again")).toBeTruthy();
  api.answer = () => ({ error: "auth" });
  const m3 = createPageModel({ api, kind: "space", id: "s-1" });
  mountSpacePage({ root, model: m3, dialogs: dialogsFor(), hrefs, signIn: { href: "/auth/login", text: "Sign in" } }); await m3.load();
  expect(root.find(e => e.tagName === "A" && e.getAttribute("href") === "/auth/login")).toBeTruthy();
});

test("names and titles are text, never HTML", async () => {
  await spacePage(SP({ space: { id: "s-1", name: "<b>x</b>", personal: false, general: "viewer", group: { id: "g-1", name: "<i>g</i>" } }, boards: [{ id: "b-1", title: "<img src=x onerror=alert(1)>", role: "editor", path: [], starred: false, can: { rename: true } }] }));
  expect(textOf(root.find(e => e.tagName === "H1"))).toBe("<b>x</b>");
  expect(textOf(byClass(root, "card-open")[0])).toMatch(/^<img src=x onerror=alert\(1\)>/);
});

test("Group page: Spaces as links, New space opens the dialog preset to this Group, rename in place, Show more pages", async () => {
  api.pages.group = GP({ next: "s-2" });
  const model = createPageModel({ api, kind: "group", id: "g-1" });
  mountGroupPage({ root, model, dialogs: dialogsFor(), hrefs }); await model.load();
  expect(textOf(root.find(e => e.tagName === "H1"))).toBe("Product");
  expect(root.findAll(e => e.hasClass("card-open")).map(e => [e.getAttribute("href"), textOf(e)])).toEqual([["?space=s-1", "DesignEveryone can view"], ["?space=s-2", "Q4Only people added"]]);
  btn("＋ New space").click(); await settle();
  const dlg = root.find(e => e.getAttribute("role") === "dialog");
  expect(textOf(dlg.find(e => e.tagName === "H2"))).toBe("New space");
  expect(dlg.find(e => e.tagName === "SELECT").value).toBe("g-1");
  dlg.find(e => e.getAttribute("aria-label") === "Name").value = "Q5";
  dlg.find(e => e.getAttribute("aria-label") === "Name").dispatch("input", { target: { value: "Q5" } });
  dlg.find(e => e.tagName === "FORM").dispatch("submit"); await settle();
  expect(calls.find(c => c[0] === "createSpace")).toEqual(["createSpace", { name: "Q5", group: "g-1", general: "viewer" }]);
  expect(closes).toEqual(["?space=s-new"]);
  btn("Show more Spaces").click(); await settle();
  expect(calls.some(c => c[0] === "group" && c[2] === "s-2")).toBe(true);
  btn("Group options").click(); root.findAll(e => e.getAttribute("role") === "menuitem")[0].click();
  expect(root.find(e => e.getAttribute("aria-label") === "Group name").value).toBe("Product");
});

test("New group dialog: name and general access, creates and goes to the Group page; refusal shown, dialog stays", async () => {
  const d = dialogsFor().newGroup({ opener: null });
  const dlg = root.find(e => e.getAttribute("role") === "dialog");
  expect(textOf(dlg.find(e => e.tagName === "H2"))).toBe("New group");
  dlg.find(e => e.tagName === "FORM").dispatch("submit"); await settle();
  expect(textOf(dlg.find(e => e.getAttribute("role") === "alert"))).toBe("Give the Group a name.");
  dlg.find(e => e.getAttribute("aria-label") === "Name").dispatch("input", { target: { value: "Org" } });
  dlg.find(e => e.tagName === "FORM").dispatch("submit"); await settle();
  expect(calls.find(c => c[0] === "createGroup")).toEqual(["createGroup", { name: "Org", general: null }]);
  expect(closes).toEqual(["?group=g-new"]);
  expect(root.find(e => e.getAttribute("role") === "dialog")).toBeUndefined();
  expect(d.close).toBeTypeOf("function");
});

test("a Group with no Spaces: the JOURNEY copy; no New space for someone who can't add one", async () => {
  api.pages.group = GP({ spaces: [], can: { createSpace: false, rename: false, general: false } });
  const model = createPageModel({ api, kind: "group", id: "g-1" });
  mountGroupPage({ root, model, dialogs: dialogsFor(), hrefs }); await model.load();
  expect(textOf(root.find(e => e.hasClass("home-empty")))).toBe("No Spaces in Product yet.Group editors can add Spaces here.");
  expect(btn("＋ New space")).toBeUndefined();
});

test("New board dialog: Location lists the picker's Spaces (personal first and checked); Create goes to the new board; errors are announced", async () => {
  const d = dialogsFor(), opener = new FakeElement("button");
  d.newBoard({ opener }); await settle();
  const dlg = root.find(e => e.getAttribute("role") === "dialog");
  const radios = dlg.findAll(e => e.tagName === "INPUT" && e.getAttribute("type") === "radio");
  expect(radios.length).toBe(2);
  expect(textOf(dlg.findAll(e => e.hasClass("opt"))[0])).toMatch(/^◐ ada's space/);
  expect(textOf(dlg.findAll(e => e.hasClass("opt"))[1])).toMatch(/Product \/ Design/);
  expect(textOf(dlg.find(e => e.tagName === "P" && e.hasClass("from")))).toBe("Only you will see it until you share it.");
  const title = dlg.find(e => e.getAttribute("aria-label") === "Title");
  title.dispatch("input", { target: { value: "Offsite ideas" } });
  radios[1].dispatch("change");
  expect(textOf(dlg.find(e => e.tagName === "P" && e.hasClass("from")))).toMatch(/gets the Space's access/);
  api.answer = (n) => (n === "createBoard" ? { error: "forbidden" } : undefined);
  dlg.find(e => e.tagName === "FORM").dispatch("submit"); await settle();
  expect(textOf(dlg.find(e => e.getAttribute("role") === "alert"))).toBe("You can't do that here.");
  expect(closes).toEqual([]);
  api.answer = (n) => (n === "createBoard" ? { board: { id: "b-new" } } : undefined);
  dlg.find(e => e.tagName === "FORM").dispatch("submit"); await settle();
  expect(calls.filter(c => c[0] === "createBoard").at(-1)).toEqual(["createBoard", { title: "Offsite ideas", space: "s-1" }]);
  expect(closes).toEqual(["?board=b-new"]);
  expect(root.find(e => e.getAttribute("role") === "dialog")).toBeUndefined();
  expect(focused.at(-1)).toBe(opener);                                 // focus goes back to what opened it
});

test("dialog: Escape and a backdrop click close it and return focus; Tab wraps inside it; nothing outside is reachable", () => {
  const opener = new FakeElement("button");
  const body = [new FakeElement("input")], ok = new FakeElement("button"), cancel = new FakeElement("button");
  let d = openDialog({ host: root, title: "T", body, footer: [cancel, ok], opener });
  expect(focused.at(-1)).toBe(body[0]);                                // focus moves in
  globalThis.document.activeElement = ok;
  let prevented = 0;
  key(d.el, "Tab", { preventDefault: () => prevented++ });             // last -> first
  expect([prevented, focused.at(-1)]).toEqual([1, body[0]]);
  globalThis.document.activeElement = body[0];
  key(d.el, "Tab", { shiftKey: true, preventDefault: () => prevented++ });   // first -> last
  expect([prevented, focused.at(-1)]).toEqual([2, ok]);
  key(d.el, "Escape", { preventDefault() {} });
  expect([root.find(e => e.getAttribute("role") === "dialog"), focused.at(-1)]).toEqual([undefined, opener]);
  d = openDialog({ host: root, title: "T", body, footer: [ok], opener });
  d.el.dispatch("click", { target: ok });                              // a click inside is not the backdrop
  expect(root.find(e => e.getAttribute("role") === "dialog")).toBeTruthy();
  d.el.dispatch("click");                                              // the backdrop
  expect(root.find(e => e.getAttribute("role") === "dialog")).toBeUndefined();
  d.close();                                                           // closing twice is harmless
});

test("New space dialog: general access radios; Only people added is sent as null; with nowhere to create it says so and can't submit", async () => {
  const d = dialogsFor();
  d.newSpace({}); await settle();
  const dlg = root.find(e => e.getAttribute("role") === "dialog");
  expect(dlg.find(e => e.tagName === "SELECT").findAll(e => e.tagName === "OPTION").map(textOf)).toEqual(["No group (directly in your organization)", "Product"]);
  dlg.find(e => e.getAttribute("aria-label") === "Name").dispatch("input", { target: { value: "Hidden" } });
  dlg.findAll(e => e.getAttribute("type") === "radio")[1].dispatch("change");
  dlg.find(e => e.tagName === "FORM").dispatch("submit"); await settle();
  expect(calls.find(c => c[0] === "createSpace")).toEqual(["createSpace", { name: "Hidden", group: null, general: null }]);
  expect(closes).toEqual(["?space=s-new"]);
  api.answer = (n) => (n === "spaceGroups" ? { root: false, groups: [], more: false } : undefined);
  d.newSpace({}); await settle();
  const dlg2 = root.find(e => e.getAttribute("role") === "dialog");
  expect(textOf(dlg2.find(e => e.getAttribute("role") === "alert"))).toBe("You can't create Spaces here.");
  expect(dlg2.findAll(e => e.tagName === "BUTTON").find(b => textOf(b) === "Create space").disabled).toBe(true);
});

test("overflowMenu alone: items with `hidden` are left out; Tab closes it", () => {
  const m = overflowMenu({ label: "x", items: [{ text: "A", onSelect() {} }, { text: "B", hidden: true, onSelect() {} }] });
  root.append(m.el); m.button.click();
  expect(root.findAll(e => e.getAttribute("role") === "menuitem").map(textOf)).toEqual(["A"]);
  key(root.find(e => e.getAttribute("role") === "menu"), "Tab");
  expect(root.find(e => e.getAttribute("role") === "menu")).toBeUndefined();
});

test("after a rename ends focus lands on the title or the card's link, never the page body; blur on a card editor saves", async () => {
  await spacePage();
  const h1 = () => root.find(e => e.tagName === "H1");
  // title: Escape
  btn("Space options").click(); root.findAll(e => e.getAttribute("role") === "menuitem")[0].click(); await settle();
  expect(focused.at(-1).getAttribute("aria-label")).toBe("Space name");                           // the editor takes focus
  key(root.find(e => e.getAttribute("aria-label") === "Space name"), "Escape");
  expect(focused.at(-1)).toBe(h1());
  // title: Enter
  btn("Space options").click(); root.findAll(e => e.getAttribute("role") === "menuitem")[0].click();
  const i = root.find(e => e.getAttribute("aria-label") === "Space name"); i.value = "Brand"; key(i, "Enter"); await settle();
  expect(focused.at(-1)).toBe(h1());
  // card: Escape, Enter, blur
  const cardMenu = () => root.findAll(e => e.tagName === "BUTTON" && e.getAttribute("aria-label") === "More for Roadmap")[0];
  const open = () => { cardMenu().click(); root.findAll(e => e.getAttribute("role") === "menuitem").find(e => textOf(e) === "Rename").click(); return root.find(e => e.getAttribute("aria-label") === "Board title"); };
  const link = t => root.findAll(e => e.hasClass("card-open") && e.tagName === "A").find(e => textOf(e).startsWith(t));
  let c = open(); key(c, "Escape");
  expect(focused.at(-1)).toBe(link("Roadmap"));
  c = open(); c.value = "Plan"; key(c, "Enter"); await settle();
  expect(calls.at(-1)).toEqual(["renameBoard", "b-1", "Plan"]);
  expect(focused.at(-1)).toBe(link("Plan"));
  expect(root.find(e => e.getAttribute("aria-label") === "Board title")).toBeUndefined();
  const m2 = root.findAll(e => e.tagName === "BUTTON" && e.getAttribute("aria-label") === "More for Plan")[0];
  m2.click(); root.findAll(e => e.getAttribute("role") === "menuitem").find(e => textOf(e) === "Rename").click();
  const d = root.find(e => e.getAttribute("aria-label") === "Board title"); d.value = "Plan B"; d.dispatch("blur"); await settle();      // clicking away saves
  expect(calls.at(-1)).toEqual(["renameBoard", "b-1", "Plan B"]);
  expect(root.find(e => e.getAttribute("aria-label") === "Board title")).toBeUndefined();
});

test("a blur-save that moved focus elsewhere does not pull it back to the title or the card; Enter still does", async () => {
  await spacePage();
  const h1 = () => root.find(e => e.tagName === "H1");
  const edit = () => { btn("Space options").click(); root.findAll(e => e.getAttribute("role") === "menuitem")[0].click(); return root.find(e => e.getAttribute("aria-label") === "Space name"); };
  let i = edit(); i.value = "Away"; const before = focused.filter(f => f.tagName === "H1").length;
  i.dispatch("blur", { relatedTarget: root.find(e => e.tagName === "A") }); await settle();          // the person clicked another control
  expect(calls.at(-1)).toEqual(["updateSpace", "s-1", { name: "Away" }]);
  expect(focused.filter(f => f.tagName === "H1").length).toBe(before);                         // focus was NOT moved to the title
  i = edit(); i.value = "Back"; i.dispatch("blur"); await settle();                    // a blur to nowhere (the body) still lands on the title
  expect(focused.at(-1)).toBe(h1());
  const c = () => root.findAll(e => e.tagName === "BUTTON" && e.getAttribute("aria-label")?.startsWith("More for"))[0];
  c().click(); root.findAll(e => e.getAttribute("role") === "menuitem").find(e => textOf(e) === "Rename").click();
  const d = root.find(e => e.getAttribute("aria-label") === "Board title"); d.value = "Moved"; await settle(); const n = focused.length;
  d.dispatch("blur", { relatedTarget: root.find(e => e.tagName === "A") }); await settle();
  expect(calls.at(-1)[0]).toBe("renameBoard");
  expect(focused.length).toBe(n);
});

test("Tab out of a rename: the save does not rebuild the control focus moved to, and focus is on it (not the body) after the save", async () => {
  await spacePage();
  const document = globalThis.document, body = {}; document.body = body; document.activeElement = body;
  const nb = () => root.findAll(e => e.tagName === "BUTTON" && e.getAttribute("data-fk") === "new-board")[0];
  btn("Space options").click(); root.findAll(e => e.getAttribute("role") === "menuitem")[0].click(); await settle();
  const input = root.find(e => e.getAttribute("aria-label") === "Space name"); input.value = "Tabbed"; document.activeElement = input;
  const target = nb();
  document.activeElement = body; input.dispatch("blur", { relatedTarget: target });                    // the browser fires blur first (focus is nowhere yet) ...
  document.activeElement = target;                                                                      // ... then focus lands on the next control
  expect(nb()).toBe(target);                                                                            // the busy re-render rebuilt nothing: the same element is still there
  await settle();                                                                                       // the save resolved and the page redrew
  expect(textOf(root.find(e => e.tagName === "H1"))).toBe("Tabbed");
  expect(nb()).toBe(target);                                                                            // the very same button, moved not recreated
  expect(focused.at(-1)).toBe(target);                                                                  // and focus was put back on it
});

test("card rename: Tab to that card's ⋯ keeps the button; a mousedown on ⋯ after a title edit still opens its menu", async () => {
  await spacePage();
  const document = globalThis.document, body = {}; document.body = body; document.activeElement = body;
  const more = id => root.findAll(e => e.tagName === "BUTTON" && e.getAttribute("data-fk") === `card-menu:${id}`)[0];
  const first = more("b-1");
  first.click(); root.findAll(e => e.getAttribute("role") === "menuitem").find(e => textOf(e) === "Rename").click(); await settle();
  const c = root.find(e => e.getAttribute("aria-label") === "Board title"); c.value = "Tabbed card";
  document.activeElement = body; c.dispatch("blur", { relatedTarget: first }); document.activeElement = first;
  await settle();
  expect(more("b-1")).toBe(first);
  expect(focused.at(-1)).toBe(first);
  // mouse: title edit, then mousedown on the Space's ⋯ (blur saves) and the click lands on the same button
  btn("Space options").click(); root.findAll(e => e.getAttribute("role") === "menuitem")[0].click(); await settle();
  const i = root.find(e => e.getAttribute("aria-label") === "Space name"); i.value = "Mouse";
  const opts = btn("Space options");
  document.activeElement = body; i.dispatch("blur", { relatedTarget: opts });                           // mousedown blurs the input and starts the save
  opts.click();                                                                                          // the click lands before the save finishes ...
  expect(root.findAll(e => e.getAttribute("role") === "menu").length).toBe(1);
  await settle();                                                                                        // ... and the redraw after the save neither loses it nor closes the menu
  expect(btn("Space options")).toBe(opts);
  expect(root.findAll(e => e.getAttribute("role") === "menu").length).toBe(1);
  expect(textOf(root.find(e => e.tagName === "H1"))).toBe("Mouse");
});

test("the busy re-render keeps the typed text in the card editor (no flash of the old title)", async () => {
  await spacePage();
  let release; api.answer = (n, id, t) => (n === "renameBoard" ? new Promise(r => { release = () => r({ board: { id, title: t } }); }) : undefined);
  root.findAll(e => e.getAttribute("aria-label") === "More for Roadmap")[0].click();
  root.findAll(e => e.getAttribute("role") === "menuitem").find(e => textOf(e) === "Rename").click();
  const i = root.find(e => e.getAttribute("aria-label") === "Board title"); i.value = "Typed"; key(i, "Enter"); await settle();
  const now = root.find(e => e.getAttribute("aria-label") === "Board title");
  expect([now, now.value]).toEqual([i, "Typed"]);
  release(); await settle();
  expect(textOf(root.findAll(e => e.hasClass("card-open"))[0])).toMatch(/^Typed/);
});

test("Group page: a saved rename puts focus on the title", async () => {
  const model = createPageModel({ api, kind: "group", id: "g-1" });
  mountGroupPage({ root, model, dialogs: dialogsFor(), hrefs }); await model.load();
  btn("Group options").click(); root.findAll(e => e.getAttribute("role") === "menuitem")[0].click();
  const i = root.find(e => e.getAttribute("aria-label") === "Group name"); i.value = "Product 2"; key(i, "Enter"); await settle();
  expect(calls.at(-1)).toEqual(["updateGroup", "g-1", { name: "Product 2" }]);
  expect(focused.at(-1)).toBe(root.find(e => e.tagName === "H1"));
});
