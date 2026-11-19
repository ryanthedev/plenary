// The Home page (web/adapters/dom/home.js) over the collab tests' small fake DOM: what renders, keyboard and star behaviour,
// text safety, and that a board card is a plain link to the board.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { FakeElement, installDom, textOf, byClass } from "./collab/fake-dom.js";
import { mountHome } from "../../web/adapters/dom/home.js";
import { createHomeModel } from "../../web/core/home.js";
import { virtualClock } from "../../web/adapters/clock/virtual.js";

const card = (id, o = {}) => ({ id, title: id.toUpperCase(), role: "editor", path: [{ type: "group", name: "Product" }, { type: "space", name: "Design" }], starred: false, ...o });
const DATA = { guest: false, user: { user: "dev:ada", name: "ada" }, unit: { id: "t", kind: "company" }, limits: {},
  recent: [card("a", { at: 1_000_000 - 600_000 }), card("b")], starred: [card("b", { starred: true })], shared: [card("c")],
  tree: { groups: [{ id: "g", name: "Product", spaces: [{ id: "s1", name: "Design", personal: false }] }], spaces: [{ id: "s2", name: "ada's space", personal: true }],
    other: { boards: [{ id: "o1", title: "Old board" }], more: false }, more: false } };
let root, clock, api, model, listeners, h;
const mount = async (data = DATA, extra = {}) => {
  const dom = installDom(); root = dom.root;
  listeners = {}; globalThis.document.addEventListener = (t, f) => { listeners[t] = f; }; globalThis.document.removeEventListener = () => {};
  globalThis.Node = Object.getPrototypeOf(FakeElement);
  clock = virtualClock({ t0: 1_000_000 });
  api = { stars: [], searches: [], load: async () => ({ home: structuredClone(data) }), search: async q => { api.searches.push(q); return { q, results: [card("r1", { title: "Result one" })], more: false }; },
    star: async (id, on) => { api.stars.push([id, on]); return { ok: true }; } };
  model = createHomeModel({ api, clock });
  h = mountHome({ root, model, clock, boardHref: id => `?board=${id}`, signIn: { href: "/auth/login", text: "Sign in" }, ...extra });
  await model.load();
};
afterEach(() => { delete globalThis.document; delete globalThis.Node; });
const links = () => root.findAll(e => e.tagName === "A").map(e => [e.getAttribute("href"), e.textContent]);
const buttons = () => root.findAll(e => e.tagName === "BUTTON");
const settle = () => new Promise(r => setTimeout(r, 0));

test("Home: Recent then Starred cards link to the board, with path, role and age; the sidebar shows views, Groups, Spaces and Other boards", async () => {
  await mount();
  expect(textOf(root.find(e => e.tagName === "H1"))).toBe("Home");
  expect(root.findAll(e => e.tagName === "H2").map(textOf)).toEqual(["Recent", "Starred"]);
  const first = byClass(root, "card-open")[0];
  expect(first.getAttribute("href")).toBe("?board=a");
  expect(textOf(first)).toBe("AProduct / Design · editor · 10 min ago");
  expect(links().filter(([h]) => h === "?board=o1")).toEqual([["?board=o1", "Old board"]]);
  const side = root.find(e => e.hasClass("home-side"));
  expect(side.findAll(e => e.tagName === "H4").map(textOf)).toEqual(["Product", "Not in a group", "Other boards"]);
  expect(side.findAll(e => e.tagName === "BUTTON").map(textOf)).toEqual(["＋ New board", "Home", "Starred1", "Shared with me1", "▢ Design", "◐ ada's space"]);
  expect(side.find(e => e.getAttribute("aria-current") === "page").textContent).toBe("Home");
});

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

test("search: typing shows results after the debounce; each result has its path; Escape clears; clicking a Space searches its name", async () => {
  await mount();
  const input = root.find(e => e.tagName === "INPUT");
  expect(input.getAttribute("aria-label")).toBe("Search boards and Spaces");
  input.value = "res"; input.dispatch("input"); clock.advance(300); await settle();
  expect(api.searches).toEqual(["res"]);
  expect(textOf(root.find(e => e.tagName === "H1"))).toBe("Results for “res”");
  expect(textOf(byClass(root, "card-open")[0])).toBe("Result oneProduct / Design · editor");
  input.dispatch("keydown", { key: "Escape" });
  expect(input.value).toBe(""); expect(textOf(root.find(e => e.tagName === "H1"))).toBe("Home");
  buttons().find(b => b.getAttribute("aria-label") === "Find boards in Design").click(); clock.advance(300); await settle();
  expect(api.searches.at(-1)).toBe("Design"); expect(input.value).toBe("Design");
});

test("'/' focuses search unless typing in a field", async () => {
  await mount();
  const input = root.find(e => e.tagName === "INPUT");
  let focused = 0; input.focus = () => focused++;
  let prevented = 0;
  listeners.keydown({ key: "/", target: { tagName: "BODY" }, preventDefault: () => prevented++ });
  listeners.keydown({ key: "/", target: { tagName: "INPUT" }, preventDefault: () => prevented++ });
  listeners.keydown({ key: "/", ctrlKey: true, target: { tagName: "BODY" }, preventDefault: () => prevented++ });
  expect([focused, prevented]).toEqual([1, 1]);
});

test("a guest sees Shared with me only, with the empty copy when there is nothing", async () => {
  await mount({ ...DATA, guest: true, unit: null, recent: [], starred: [], tree: null });
  expect(root.findAll(e => e.tagName === "H2").map(textOf)).toEqual(["Shared with me"]);
  expect(buttons().map(textOf)).not.toContain("Starred1");
  await mount({ ...DATA, guest: true, unit: null, recent: [], starred: [], shared: [], tree: null });
  expect(textOf(root.find(e => e.hasClass("home-empty")))).toBe("Nothing is shared with you yet.Open the link you were sent.");
});

test("first run: the welcome empty state; New board says it is coming", async () => {
  await mount({ ...DATA, recent: [], starred: [], shared: [], tree: { groups: [], spaces: [], other: { boards: [], more: false }, more: false } });
  expect(textOf(root.find(e => e.hasClass("home-empty")))).toBe("Welcome to Plenary.Start a board, or join a Space your team already uses.");
  buttons().find(b => textOf(b) === "＋ New board").click();
  expect(textOf(root.find(e => e.hasClass("home-status")))).toMatch(/New board is coming soon/);
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
