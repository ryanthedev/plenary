// The Home screen's state, with no DOM: what to show (sections, empty states, the sidebar), search with a debounce and
// a stale-answer guard, and optimistic stars. The page (web/adapters/dom/home.js) renders `model.state` and calls the
// actions; the data comes through the Home port (web/ports/home.js). Time and timers come from the clock port.
// Copy follows design/orgs/JOURNEY.md §5; the visual pass is a later issue (#56).

/** @typedef {import("../ports/home.js").HomePort} HomePort */
/** @typedef {import("../ports/home.js").HomeData} HomeData */
/** @typedef {import("../ports/home.js").Card} Card */

export const SEARCH_DEBOUNCE_MS = 250;
export const SEARCH_MAX = 100;
/** Sidebar and main-area views. "home" shows Recent and Starred; "starred" and "shared" show that one list in full. */
export const VIEWS = Object.freeze(["home", "starred", "shared"]);

/** "Product / Design" for a card's path. */
export const pathText = path => (path ?? []).map(p => p.name).join(" / ");

/** "just now", "10 min ago", "2 h ago", "yesterday", "3 d ago", "2 mo ago", "1 y ago"; `at` and `now` in ms. */
export function whenText(at, now) {
  if (!Number.isFinite(at)) return "";
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172_800) return "yesterday";
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)} d ago`;
  return s < 365 * 86_400 ? `${Math.floor(s / (30 * 86_400))} mo ago` : `${Math.floor(s / (365 * 86_400))} y ago`;
}

/** Search text the server will accept: trimmed, 1-100 chars; else null (no request is made). */
export const cleanQuery = q => { const t = typeof q === "string" ? q.trim() : ""; return t && t.length <= SEARCH_MAX ? t : null; };

/**
 * The empty-state copy (JOURNEY §5) for a view with nothing in it. `guest` Home: "Nothing is shared with you yet."
 * @param {HomeData} data @param {"home"|"starred"|"shared"} view
 */
export function emptyText(data, view) {
  if (data.guest) return { title: "Nothing is shared with you yet.", detail: "Open the link you were sent." };
  if (view === "starred") return { title: "Star a board (☆) to keep it here.", detail: "" };
  if (view === "shared") return { title: "Boards people share with you directly show up here.", detail: "" };
  return { title: "Welcome to Plenary.", detail: "Start a board, or join a Space your team already uses." };
}

/**
 * @param {{ api: HomePort, clock: import("../ports/clock.js").Clock, debounceMs?: number }} o
 */
export function createHomeModel({ api, clock, debounceMs = SEARCH_DEBOUNCE_MS }) {
  /** @type {{ status: "loading"|"ready"|"error"|"signed-out", error: string|null, data: HomeData|null, view: string,
   *   query: string, search: { status: "idle"|"loading"|"ready"|"error", q: string, results: Card[], more: boolean },
   *   notice: string|null }} */
  const state = { status: "loading", error: null, data: null, view: "home", query: "", search: { status: "idle", q: "", results: [], more: false }, notice: null };
  const subs = new Set();
  const emit = () => { for (const f of [...subs]) f(state); };
  let seq = 0, timer = null;

  const lists = () => [state.data?.recent, state.data?.starred, state.data?.owned, state.data?.shared, state.search.results].filter(Boolean);
  const cards = id => lists().flat().filter(c => c.id === id);

  async function load() {
    state.status = "loading"; state.error = null; emit();
    const r = await api.load();
    if ("home" in r) { state.data = r.home; state.status = "ready"; }
    else if (r.error === "auth") { state.status = "signed-out"; state.error = "auth"; }
    else { state.status = state.data ? "ready" : "error"; state.error = r.error; if (state.data) state.notice = "Could not refresh Home."; }
    emit();
  }

  function runSearch(q) {
    const mine = ++seq;
    state.search = { status: "loading", q, results: state.search.q === q ? state.search.results : [], more: false }; emit();
    api.search(q).then(r => {
      if (mine !== seq) return;                         // a newer query (or a clear) took over: this answer is stale
      if ("results" in r) state.search = { status: "ready", q, results: r.results, more: r.more };
      else if (r.error === "auth") { state.status = "signed-out"; state.error = "auth"; state.search = { status: "idle", q: "", results: [], more: false }; }
      else state.search = { status: "error", q, results: [], more: false };
      emit();
    });
  }

  return {
    state,
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
    load,
    /** Which list the main area shows. */
    setView(view) { if (VIEWS.includes(view)) { state.view = view; emit(); } },
    /** The search box's text: debounced; an empty or too-long text clears the search at once. */
    setQuery(text) {
      state.query = String(text ?? "");
      clock.clear(timer); timer = null;
      const q = cleanQuery(state.query);
      if (q === null) { seq++; state.search = { status: "idle", q: "", results: [], more: false }; emit(); return; }
      emit();
      timer = clock.set(() => { timer = null; runSearch(q); }, debounceMs);
    },
    /** Star or un-star a board now (optimistic), and put it back if the server says no. @returns {Promise<boolean>} */
    async toggleStar(id) {
      if (state.data?.guest) return false;                            // guests have no Starred (the server refuses too)
      const was = cards(id).some(c => c.starred) || !!state.data?.starred.some(c => c.id === id), on = !was;
      const set = v => { for (const c of cards(id)) c.starred = v; };
      set(on);
      if (state.data) {
        const known = cards(id)[0];
        if (!on) state.data.starred = state.data.starred.filter(c => c.id !== id);
        else if (known && !state.data.starred.some(c => c.id === id)) state.data.starred = [{ ...known, starred: true, at: clock.now() }, ...state.data.starred];
      }
      emit();
      const r = await api.star(id, on);
      if ("ok" in r) return true;
      if (r.error === "auth") { state.status = "signed-out"; state.error = "auth"; }
      else { state.notice = r.error === "forbidden" ? "You can't star that board." : "Could not change the star."; await load(); return false; }
      emit();
      return false;
    },
    /** Say something in the status line (the page's own notices). */
    notify(text) { state.notice = text; emit(); },
    dismissNotice() { state.notice = null; emit(); },
    /** What the main area shows now: `{ kind: "search" | "view", title, cards, more, empty }`. */
    main() {
      const d = state.data;
      if (!d) return null;
      if (cleanQuery(state.query) !== null) {
        const s = state.search;
        return { kind: "search", title: `Results for “${cleanQuery(state.query)}”`, status: s.status, cards: s.results, more: s.more,
          empty: { title: `No boards or Spaces match "${cleanQuery(state.query)}".`, detail: "You only see what you can open." } };
      }
      if (state.view === "starred") return { kind: "view", title: "Starred", cards: d.starred, more: false, empty: emptyText(d, "starred") };
      if (state.view === "shared") return { kind: "view", title: "Shared with me", cards: d.shared, more: false, empty: emptyText(d, "shared") };
      return { kind: "view", title: "Home", sections: d.guest ? [{ title: "Recent", cards: d.recent }, { title: "Your boards", cards: d.owned }, { title: "Shared with me", cards: d.shared }]
          : [{ title: "Recent", cards: d.recent }, { title: "Starred", cards: d.starred }, ...(d.unit?.personal ? [{ title: "Shared with me", cards: d.shared }] : [])],
        cards: [], more: false, empty: emptyText(d, "home") };
    },
  };
}
