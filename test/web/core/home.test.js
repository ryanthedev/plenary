// web/core/home.js: the Home screen's state without a DOM, on the virtual clock and a fake Home port.
import { test, expect } from "bun:test";
import { createHomeModel, pathText, whenText, cleanQuery, emptyText, SEARCH_DEBOUNCE_MS } from "../../../web/core/home.js";
import { virtualClock } from "../../../web/adapters/clock/virtual.js";

const card = (id, o = {}) => ({ id, title: id.toUpperCase(), role: "editor", path: [{ type: "space", id: "s1", name: "Design" }], starred: false, ...o });
const data = (o = {}) => ({ guest: false, user: { user: "dev:ada", name: "ada" }, unit: { id: "t1", kind: "company" }, recent: [card("a"), card("b")], starred: [card("b", { starred: true })], owned: [], shared: [card("c")],
  tree: { groups: [], spaces: [], other: { boards: [], more: false }, more: false }, limits: { recent: 12 }, ...o });
function fakeApi(over = {}) {
  const calls = { load: 0, search: [], star: [] }, pending = [];
  return {
    calls, pending,
    load: async () => { calls.load++; return over.load ? over.load() : { home: structuredClone(data()) }; },
    search: q => { calls.search.push(q); return new Promise(res => pending.push({ q, res })); },
    star: async (id, on) => { calls.star.push([id, on]); return over.star ? over.star(id, on) : { ok: true }; },
  };
}
const setup = o => { const clock = virtualClock({ t0: 1_000_000 }), api = fakeApi(o); return { clock, api, m: createHomeModel({ api, clock }) }; };
const tick = () => new Promise(r => setTimeout(r, 0));

test("pure helpers: path, relative time, query, empty copy", () => {
  expect(pathText([{ name: "Product" }, { name: "Design" }])).toBe("Product / Design");
  expect(pathText(undefined)).toBe("");
  const now = 10_000_000_000;
  expect([0, 30e3, 10 * 60e3, 2 * 3600e3, 30 * 3600e3, 3 * 86400e3, 70 * 86400e3, 800 * 86400e3].map(d => whenText(now - d, now)))
    .toEqual(["just now", "just now", "10 min ago", "2 h ago", "yesterday", "3 d ago", "2 mo ago", "2 y ago"]);
  expect(whenText(undefined, now)).toBe("");
  expect([cleanQuery("  hi "), cleanQuery("   "), cleanQuery("x".repeat(101)), cleanQuery(null)]).toEqual(["hi", null, null, null]);
  expect(emptyText({ guest: true }, "home").title).toBe("Nothing is shared with you yet.");
  expect(emptyText({ guest: false }, "home").title).toBe("Welcome to Plenary.");
});

test("load: loading, then ready; a failure with no data is an error and a retry works; 401 is signed-out", async () => {
  let n = 0;
  const { m, api } = setup({ load: () => (++n === 1 ? { error: "unavailable" } : n === 2 ? { error: "auth" } : { home: data() }) });
  const seen = []; m.subscribe(s => seen.push(s.status));
  expect(m.state.status).toBe("loading");
  await m.load(); expect([m.state.status, m.state.error]).toEqual(["error", "unavailable"]);
  await m.load(); expect([m.state.status, m.state.error]).toEqual(["signed-out", "auth"]);
  await m.load(); expect([m.state.status, m.state.error]).toEqual(["ready", null]);
  expect(seen).toEqual(["loading", "error", "loading", "signed-out", "loading", "ready"]);
  expect(api.calls.load).toBe(3);
});

test("a failed refresh keeps what is shown and says so", async () => {
  let fail = false;
  const { m } = setup({ load: () => (fail ? { error: "network" } : { home: data() }) });
  await m.load(); fail = true; await m.load();
  expect([m.state.status, m.state.data.recent.length, m.state.notice]).toEqual(["ready", 2, "Could not refresh Home."]);
});

test("main(): Home shows Recent and Starred, a guest only Shared with me, other views one list, empty states by view", async () => {
  const { m } = setup();
  await m.load();
  expect(m.main().sections.map(s => [s.title, s.cards.map(c => c.id)])).toEqual([["Recent", ["a", "b"]], ["Starred", ["b"]]]);
  m.setView("starred"); expect(m.main()).toMatchObject({ title: "Starred", cards: [{ id: "b" }] });
  m.setView("shared"); expect(m.main()).toMatchObject({ title: "Shared with me", cards: [{ id: "c" }] });
  m.setView("nope"); expect(m.state.view).toBe("shared");
  const g = setup({ load: () => ({ home: data({ guest: true, unit: null, recent: [card("r")], starred: [], owned: [card("o")], tree: null }) }) });
  await g.m.load();
  expect(g.m.main().sections.map(s => s.title)).toEqual(["Recent", "Your boards", "Shared with me"]);
  expect(await g.m.toggleStar("r")).toBe(false);                    // guests have no Starred: nothing is asked of the server
  expect(g.api.calls.star).toEqual([]);
  expect(g.m.main().empty.title).toBe("Nothing is shared with you yet.");
  expect(emptyText({ guest: false }, "starred").title).toBe("Star a board (☆) to keep it here.");
  expect(emptyText({ guest: false }, "shared").title).toBe("Boards people share with you directly show up here.");
});

test("search: debounced, one request for a burst of typing, trimmed; clearing cancels the pending request and ignores a late answer", async () => {
  const { m, api, clock } = setup();
  await m.load();
  m.setQuery("d"); clock.advance(100); m.setQuery("de"); clock.advance(100); m.setQuery(" des "); clock.advance(SEARCH_DEBOUNCE_MS - 1);
  expect(api.calls.search).toEqual([]);
  clock.advance(1);
  expect(api.calls.search).toEqual(["des"]);
  expect(m.state.search.status).toBe("loading");
  m.setQuery("");                                                          // cleared while in flight
  expect(m.state.search.status).toBe("idle");
  api.pending[0].res({ q: "des", results: [card("z")], more: false });
  await tick();
  expect(m.state.search).toEqual({ status: "idle", q: "", results: [], more: false });   // the late answer didn't come back
  expect(m.main().kind).toBe("view");
});

test("search: a stale answer never overwrites a newer one; an error and 'more' show", async () => {
  const { m, api, clock } = setup();
  await m.load();
  m.setQuery("one"); clock.advance(SEARCH_DEBOUNCE_MS);
  m.setQuery("two"); clock.advance(SEARCH_DEBOUNCE_MS);
  expect(api.calls.search).toEqual(["one", "two"]);
  api.pending[1].res({ q: "two", results: [card("t")], more: true }); await tick();
  api.pending[0].res({ q: "one", results: [card("o")], more: false }); await tick();
  expect(m.main()).toMatchObject({ kind: "search", status: "ready", more: true, cards: [{ id: "t" }] });
  m.setQuery("three"); clock.advance(SEARCH_DEBOUNCE_MS);
  api.pending[2].res({ error: "unavailable" }); await tick();
  expect(m.main()).toMatchObject({ kind: "search", status: "error", cards: [] });
  m.setQuery("x".repeat(101));                                             // too long: no request, search cleared
  clock.advance(1000);
  expect(api.calls.search.length).toBe(3);
});

test("search: 401 signs the page out", async () => {
  const { m, api, clock } = setup();
  await m.load(); m.setQuery("a"); clock.advance(SEARCH_DEBOUNCE_MS);
  api.pending[0].res({ error: "auth" }); await tick();
  expect([m.state.status, m.state.error]).toEqual(["signed-out", "auth"]);
});

test("toggleStar: optimistic on every list, joins Starred, and is undone (by a reload) when the server says no", async () => {
  const { m, api } = setup();
  await m.load();
  const p = m.toggleStar("a");
  expect(m.state.data.recent[0].starred).toBe(true);                      // before the server answered
  expect(m.state.data.starred.map(c => c.id)).toEqual(["a", "b"]);
  expect(await p).toBe(true);
  expect(api.calls.star).toEqual([["a", true]]);
  expect(await m.toggleStar("b")).toBe(true);                             // un-star: leaves Starred, flag off everywhere
  expect(m.state.data.starred.map(c => c.id)).toEqual(["a"]);
  expect(m.state.data.recent.find(c => c.id === "b").starred).toBe(false);
  expect(api.calls.star[1]).toEqual(["b", false]);

  const bad = setup({ star: () => ({ error: "forbidden" }) });
  await bad.m.load();
  expect(await bad.m.toggleStar("a")).toBe(false);
  expect(bad.m.state.notice).toBe("You can't star that board.");
  expect(bad.m.state.data.recent[0].starred).toBe(false);                 // reloaded from the server's truth
  expect(bad.api.calls.load).toBe(2);
});

test("notices can be set and dismissed", async () => {
  const { m } = setup(); await m.load();
  m.notify("hi"); expect(m.state.notice).toBe("hi");
  m.dismissNotice(); expect(m.state.notice).toBe(null);
});

test("search with no hits uses the JOURNEY copy", async () => {
  const { m, api, clock } = setup();
  await m.load(); m.setQuery("zzz"); clock.advance(SEARCH_DEBOUNCE_MS);
  api.pending[0].res({ q: "zzz", results: [], more: false }); await tick();
  expect(m.main().empty).toEqual({ title: 'No boards or Spaces match "zzz".', detail: "You only see what you can open." });
});
