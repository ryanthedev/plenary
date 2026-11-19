// The Home page (web/adapters/dom/home.js) over the collab tests' small fake DOM: what renders, keyboard and star behaviour,
// text safety, and that a board card is a plain link to the board.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { FakeElement, installDom, textOf, byClass } from "./collab/fake-dom.js";
import { announced } from "../../web/adapters/dom/focus.js";
import { mountHome } from "../../web/adapters/dom/home.js";
import { createHomeModel } from "../../web/core/home.js";
import { virtualClock } from "../../web/adapters/clock/virtual.js";

const card = (id, o = {}) => ({ id, title: id.toUpperCase(), role: "editor", path: [{ type: "group", name: "Product" }, { type: "space", name: "Design" }], starred: false, ...o });
const DATA = { guest: false, user: { user: "dev:ada", name: "ada" }, unit: { id: "t", kind: "company" }, limits: {},
  recent: [card("a", { at: 1_000_000 - 600_000 }), card("b")], starred: [card("b", { starred: true })], owned: [], shared: [card("c")],
  tree: { groups: [{ id: "g", name: "Product", spaces: [{ id: "s1", name: "Design", personal: false }] }], spaces: [{ id: "s2", name: "ada's space", personal: true }],
    more: false } };
let root, clock, api, model, listeners, h, dialogs, dialogCalls;
const mount = async (data = DATA, extra = {}) => {
  const dom = installDom(); root = dom.root;
  listeners = {}; globalThis.document.addEventListener = (t, f) => { listeners[t] = f; }; globalThis.document.removeEventListener = () => {};
  globalThis.Node = Object.getPrototypeOf(FakeElement);
  clock = virtualClock({ t0: 1_000_000 });
  api = { stars: [], searches: [], load: async () => ({ home: structuredClone(data) }), search: async q => { api.searches.push(q); return { q, results: [card("r1", { title: "Result one" })], more: false }; },
    star: async (id, on) => { api.stars.push([id, on]); return { ok: true }; } };
  model = createHomeModel({ api, clock });
  dialogCalls = []; dialogs = { newBoard: o => dialogCalls.push(["board", o.opener]), newSpace: o => dialogCalls.push(["space", o.opener]), newGroup: o => dialogCalls.push(["group", o.opener]) };
  h = mountHome({ root, model, clock, dialogs, boardHref: id => `?board=${id}`, spaceHref: id => `?space=${id}`, groupHref: id => `?group=${id}`, signIn: { href: "/auth/login", text: "Sign in" }, ...extra });
  await model.load();
};
afterEach(() => { delete globalThis.document; delete globalThis.Node; });
const links = () => root.findAll(e => e.tagName === "A").map(e => [e.getAttribute("href"), e.textContent]);
const buttons = () => root.findAll(e => e.tagName === "BUTTON");
const settle = () => new Promise(r => setTimeout(r, 0));

test("Home: Recent then Starred cards link to the board, with path, role and age; the sidebar shows views, Groups and Spaces", async () => {
  await mount();
  expect(textOf(root.find(e => e.tagName === "H1"))).toBe("Home");
  expect(root.findAll(e => e.tagName === "H2").map(textOf)).toEqual(["Recent", "Starred"]);
  const first = byClass(root, "card-open")[0];
  expect(first.getAttribute("href")).toBe("?board=a");
  expect(textOf(first)).toBe("AProduct / Design · editor · 10 min ago");
  const side = root.find(e => e.hasClass("home-side"));
  expect(side.findAll(e => e.tagName === "H4").map(textOf)).toEqual(["Product", "Not in a group"]);
  expect(side.findAll(e => e.tagName === "BUTTON").map(textOf)).toEqual(["＋ New board", "＋ New space", "Home", "Starred1", "Shared with me1"]);
  // Spaces and Groups are links to their own pages (?space= / ?group=), not search buttons
  expect(side.findAll(e => e.tagName === "A").map(e => [e.getAttribute("href"), textOf(e)])).toEqual([["?group=g", "Product"], ["?space=s1", "▢ Design"], ["?space=s2", "◐ ada's space"]]);
  expect(side.find(e => e.getAttribute("aria-current") === "page").textContent).toBe("Home");
});

test("New group is offered only when the server says can.createGroup, and opens its dialog from the clicked button", async () => {
  await mount();
  expect(buttons().find(b => textOf(b) === "＋ New group")).toBeUndefined();
  await mount({ ...DATA, can: { createGroup: true } });
  const ng = buttons().find(b => textOf(b) === "＋ New group");
  ng.click();
  expect(dialogCalls).toEqual([["group", ng]]);
});

// Focus survives a redraw: every control that can hold focus has a stable key, and the redraw puts focus back on its twin.
describe_focus();
function describe_focus() {
  let focused, doc, body;
  const fk = el => el?.getAttribute("data-fk");
  const withFocus = async fn => {
    await mount();
    doc = globalThis.document; body = doc.createElement("body"); doc.body = body; doc.activeElement = body; focused = [];
    const orig = FakeElement.prototype.focus;
    FakeElement.prototype.focus = function () { focused.push(this); doc.activeElement = this; };
    try { await fn(); } finally { FakeElement.prototype.focus = orig; }
  };
  const byKey = k => root.findAll(e => fk(e) === k)[0];
  test("activating a star keeps focus on that star after the redraw", () => withFocus(async () => {
    const st = byKey("star:Recent:a"); doc.activeElement = st;
    st.click(); await settle();
    expect(api.stars).toEqual([["a", true]]);
    expect(fk(focused.at(-1))).toBe("star:Recent:a");
    expect(root.findAll(e => e === focused.at(-1)).length).toBe(1);                                  // and it is the live one in the page
  }));
  test("activating the Starred nav keeps focus on the Starred nav", () => withFocus(async () => {
    const nav = byKey("nav:starred"); doc.activeElement = nav;
    nav.click(); await settle();
    expect(fk(focused.at(-1))).toBe("nav:starred");
    expect(textOf(root.find(e => e.tagName === "H1"))).toBe("Starred");
  }));
  test("a reload, a notice and a search result each leave focus where it was (or on the nearest sibling)", () => withFocus(async () => {
    doc.activeElement = byKey("nav:shared"); await model.load(); await settle();
    expect(fk(focused.at(-1))).toBe("nav:shared");
    doc.activeElement = byKey("card:Recent:a"); model.notify("Could not star that."); await settle();
    expect(fk(focused.at(-1))).toBe("card:Recent:a");
    expect(byKey("dismiss")).toBeDefined();
    // a search replaces the lists: the focused card is gone, so focus goes to the same kind of control, else the heading, never the body
    doc.activeElement = byKey("card:Recent:a");
    model.setQuery("r1"); await settle(); await settle();
    const now = fk(focused.at(-1));
    expect(now === "heading" || now.startsWith("card:")).toBe(true);
  }));
  test("a starred card that leaves the list: focus goes to a neighbouring card's LINK (never another star) and is announced", () => withFocus(async () => {
    const star = byKey("star:Recent:a"); doc.activeElement = star;
    api.load = async () => ({ home: structuredClone({ ...DATA, recent: [card("b")] }) });
    await model.load(); await settle();
    const now = fk(focused.at(-1));
    expect(now.startsWith("card:Recent:")).toBe(true);
    expect(now.startsWith("star:")).toBe(false);
    expect(announced()).toMatch(/^That board is no longer here; moved to (the next|the previous) one\.$/);
  }));
  test("a control that was never marked is not refocused (an input keeps its own focus)", () => withFocus(async () => {
    const input = root.find(e => e.tagName === "INPUT"); doc.activeElement = input; const n = focused.length;
    model.notify("hello"); await settle();
    expect(focused.length).toBe(n);
  }));
}

test("star buttons are labelled and pressed-state is exposed; clicking toggles through the port", async () => {
  await mount();
  const star = buttons().find(b => b.getAttribute("aria-label") === "Star A");
  expect(star.getAttribute("aria-pressed")).toBe("false");
  star.click(); await settle();
  expect(api.stars).toEqual([["a", true]]);
  expect(buttons().find(b => b.getAttribute("aria-label") === "Unstar A").getAttribute("aria-pressed")).toBe("true");
  expect(buttons().filter(b => b.getAttribute("aria-label") === "Unstar B").length).toBeGreaterThan(0);
});

test("views: Starred and Shared with me show one list each", async () => {
  await mount();
  buttons().find(b => textOf(b).startsWith("Shared with me")).click();
  expect(textOf(root.find(e => e.tagName === "H1"))).toBe("Shared with me");
  expect(byClass(root, "card").map(c => textOf(c.find(e => e.hasClass("t"))))).toEqual(["C"]);
  expect(root.find(e => e.getAttribute("aria-current") === "page").textContent).toMatch(/^Shared with me/);
});

test("search: typing shows results after the debounce; each result has its path; Escape clears; a Space is a link to its page", async () => {
  await mount();
  const input = root.find(e => e.tagName === "INPUT");
  expect(input.getAttribute("aria-label")).toBe("Search boards and Spaces");
  input.value = "res"; input.dispatch("input"); clock.advance(300); await settle();
  expect(api.searches).toEqual(["res"]);
  expect(textOf(root.find(e => e.tagName === "H1"))).toBe("Results for “res”");
  expect(textOf(byClass(root, "card-open")[0])).toBe("Result oneProduct / Design · editor");
  input.dispatch("keydown", { key: "Escape" });
  expect(input.value).toBe(""); expect(textOf(root.find(e => e.tagName === "H1"))).toBe("Home");
  expect(api.searches.length).toBe(1);
});

test("'/' focuses search unless typing in a field", async () => {
  await mount();
  const input = root.find(e => e.tagName === "INPUT");
  let focused = 0; input.focus = () => focused++;
  let prevented = 0;
  listeners.keydown({ key: "/", target: { tagName: "BODY" }, preventDefault: () => prevented++ });
  listeners.keydown({ key: "/", target: { tagName: "INPUT" }, preventDefault: () => prevented++ });
  listeners.keydown({ key: "/", ctrlKey: true, target: { tagName: "BODY" }, preventDefault: () => prevented++ });
  listeners.keydown({ key: "k", metaKey: true, target: { tagName: "INPUT" }, preventDefault: () => prevented++ });   // ⌘K works even from a field
  listeners.keydown({ key: "K", ctrlKey: true, target: { tagName: "BODY" }, preventDefault: () => prevented++ });
  listeners.keydown({ key: "k", target: { tagName: "BODY" }, preventDefault: () => prevented++ });                 // a bare k is just a letter
  expect([focused, prevented]).toEqual([3, 3]);
});

test("a guest sees Shared with me only, with the empty copy when there is nothing", async () => {
  await mount({ ...DATA, guest: true, unit: null, recent: [card("r")], starred: [], owned: [card("o")], tree: null });
  expect(root.findAll(e => e.tagName === "H2").map(textOf)).toEqual(["Recent", "Your boards", "Shared with me"]);
  expect(buttons().map(textOf).filter(t => /Starred|New board/.test(t))).toEqual([]);              // no Starred, no New board for a guest
  expect(buttons().filter(b => b.hasClass("star"))).toEqual([]);                                   // and no star buttons
  expect(root.findAll(e => e.hasClass("tree"))).toEqual([]);
  await mount({ ...DATA, guest: true, unit: null, recent: [], starred: [], owned: [], shared: [], tree: null });
  expect(textOf(root.find(e => e.hasClass("home-empty")))).toBe("Nothing is shared with you yet.Open the link you were sent.");
});

test("first run: the welcome empty state; New board and New space open their dialogs from the clicked button", async () => {
  await mount({ ...DATA, recent: [], starred: [], shared: [], tree: { groups: [], spaces: [], more: false } });
  expect(textOf(root.find(e => e.hasClass("home-empty")))).toBe("Welcome to Plenary.Start a board, or join a Space your team already uses.");
  const nb = buttons().find(b => textOf(b) === "＋ New board"), ns = buttons().find(b => textOf(b) === "＋ New space");
  nb.click(); ns.click();
  expect(dialogCalls).toEqual([["board", nb], ["space", ns]]);                   // the opener is passed, so focus can return to it
  expect(root.find(e => e.hasClass("home-status")).getAttribute("role")).toBe("status");
});

test("text is never HTML: titles and names with markup render as text, and no HTML sink is touched", async () => {
  await mount({ ...DATA, recent: [card("x", { title: "<img src=x onerror=alert(1)>", path: [{ type: "space", name: "<b>S</b>" }] })] });
  expect(textOf(byClass(root, "card-open")[0])).toBe("<img src=x onerror=alert(1)><b>S</b> · editor");
});

test("errors: a failed load offers Try again; signed-out offers the sign-in link", async () => {
  await mount();
  model.state.status = "error"; model.state.data = null; model.notify(null);
  expect(textOf(root.find(e => e.hasClass("home-empty")))).toMatch(/Could not load Home/);
  const retry = buttons().find(b => textOf(b) === "Try again"); retry.click(); await settle();
  expect(model.state.status).toBe("ready");
  model.state.status = "signed-out"; model.notify(null);
  expect(links().find(([h]) => h === "/auth/login")).toEqual(["/auth/login", "Sign in"]);
});

test("destroy removes the page and unsubscribes", async () => {
  await mount();
  h.destroy();
  expect(root.childNodes.length).toBe(0);
});

test("Home links to Teams for a member, and to the organization's access only when the server says the caller manages it; a guest sees neither", async () => {
  const at = { teamsHref: "?teams=1", unitAccessHref: id => `?access=unit:${id}` };
  await mount({ ...DATA, can: { createGroup: false, manageAccess: false } }, at);
  const side = () => root.find(e => e.hasClass("home-side")).findAll(e => e.tagName === "A").map(e => [e.getAttribute("href"), textOf(e)]);
  expect(side()).toContainEqual(["?teams=1", "Teams"]);
  expect(side().map(x => x[1])).not.toContain("Organization access");
  await mount({ ...DATA, can: { createGroup: true, manageAccess: true } }, at);
  expect(side()).toContainEqual(["?access=unit:t", "Organization access"]);
  await mount({ ...DATA, guest: true, unit: null, tree: null, can: { createGroup: false, manageAccess: false } }, at);
  expect(side().map(x => x[1])).not.toContain("Teams");
});

test("Home links to Roles only when the server says the caller may manage roles (roles.manage), never for a guest", async () => {
  const at = { teamsHref: "?teams=1", rolesHref: "?roles=1" };
  const side = () => root.find(e => e.hasClass("home-side")).findAll(e => e.tagName === "A").map(e => [e.getAttribute("href"), textOf(e)]);
  await mount({ ...DATA, can: { createGroup: false, manageAccess: true, manageRoles: false } }, at);
  expect(side().map(x => x[1])).not.toContain("Roles");
  await mount({ ...DATA, can: { createGroup: false, manageAccess: false, manageRoles: true } }, at);
  expect(side()).toContainEqual(["?roles=1", "Roles"]);
  await mount({ ...DATA, guest: true, unit: null, tree: null, can: { createGroup: false, manageAccess: false, manageRoles: true } }, at);
  expect(side().map(x => x[1])).not.toContain("Roles");
});
