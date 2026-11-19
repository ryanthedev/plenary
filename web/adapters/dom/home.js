// The Home page: a driving adapter over the DOM that renders web/core/home.js's model (Recent, Starred, Shared with me,
// the Group/Space tree, search). Part of the dom group; the composition root (web/main.js) mounts it when someone is signed in with no
// board in the link. All text goes in through textContent (titles and names are other people's words). Keyboard: "/"
// focuses search, Escape clears it, every card is a link plus a star button. Visuals are intentionally plain: #56 restyles.

import { h, replace } from "./dom.js";
import { pathText, whenText } from "../../core/home.js";

/**
 * @param {{ root: HTMLElement, model: ReturnType<typeof import("../../core/home.js").createHomeModel>, clock: import("../../ports/clock.js").Clock,
 *   boardHref: (id: string) => string, homeHref?: string, signIn?: { href: string, text?: string } | null }} o
 * @returns {{ destroy(): void }}
 */
export function mountHome({ root, model, clock, boardHref, homeHref = "./", signIn = null }) {
  const S = model.state;
  const status = h("div.home-status", { role: "status", "aria-live": "polite" });
  const search = h("input.home-search", { type: "search", placeholder: "Search boards and Spaces", "aria-label": "Search boards and Spaces", autocomplete: "off", maxlength: "100", spellcheck: "false",
    oninput: e => model.setQuery(e.target.value),
    onkeydown: e => { if (e.key === "Escape" && search.value) { search.value = ""; model.setQuery(""); e.preventDefault(); } } });
  const side = h("nav.home-side", { "aria-label": "Home navigation" });
  const main = h("main.home-main", { id: "home-main", tabindex: "-1" });
  const who = h("span.home-who");
  const top = h("header.home-top", {},
    h("a.logo", { href: homeHref, "aria-label": "Plenary home" }, "Plenary"),
    h("div.home-searchbox", { role: "search" }, search, h("kbd", { "aria-hidden": "true" }, "/ or ⌘K")),
    h("span.spacer"), who);
  const home = h("div.home", { id: "home" }, top, status, h("div.home-body", {}, side, main));
  root.replaceChildren(home);

  const guest = () => !!S.data?.guest;
  const newBoard = () => h("button.btn.primary", { type: "button", onclick: () => model.notify("New board is coming soon: boards are made by an admin for now.") }, "＋ New board");
  const navBtn = (view, label, count) => h("button.nav", { type: "button", "aria-current": S.view === view && !S.query.trim() && !S.space ? "page" : null,
    onclick: () => { search.value = ""; model.setQuery(""); model.setView(view); } }, label, count != null ? h("span.n", {}, String(count)) : null);

  function star(c) {
    return h("button.star", { type: "button", "aria-pressed": c.starred ? "true" : "false", "aria-label": `${c.starred ? "Unstar" : "Star"} ${c.title || "Untitled"}`,
      title: c.starred ? "Unstar" : "Star", onclick: () => model.toggleStar(c.id) }, c.starred ? "★" : "☆");
  }
  function card(c) {
    const when = c.at != null ? whenText(c.at, clock.now()) : "";
    const where = pathText(c.path);
    return h("li.card", {},
      h("a.card-open", { href: boardHref(c.id) }, h("span.t", {}, c.title || "Untitled"), h("span.p", {}, [where, c.role, when].filter(Boolean).join(" · "))),
      guest() ? null : star(c));
  }
  const cardList = (cards, label) => h("ul.cards", { "aria-label": label }, cards.map(card));
  const empty = e => h("div.home-empty", {}, h("h2", {}, e.title), e.detail ? h("p", {}, e.detail) : null);

  function renderSide() {
    const d = S.data;
    if (!d) return replace(side);
    // A Space opens its own list (by id, through the server), not a text search for its name.
    const node = s => h("button.nav.sub", { type: "button", title: `Boards in ${s.name}`, "aria-label": `Boards in ${s.name}`, "aria-current": S.space?.id === s.id ? "page" : null,
      onclick: () => { search.value = ""; model.showSpace(s.id, s.name); } }, s.personal ? "◐ " : "▢ ", s.name);
    const t = d.tree;
    replace(side, d.guest ? null : newBoard(), navBtn("home", "Home"), d.guest ? null : navBtn("starred", "Starred", d.starred.length), navBtn("shared", "Shared with me", d.shared.length),
      t && h("div.tree", { role: "group", "aria-label": "Groups and Spaces" },
        t.groups.map(g => h("div.grp", {}, h("h4", {}, g.name), g.spaces.map(node))),
        t.spaces.length ? h("div.grp", {}, h("h4", {}, "Not in a group"), t.spaces.map(node)) : null,
        t.other.boards.length ? h("div.grp", {}, h("h4", {}, "Other boards"), t.other.boards.map(b => h("a.nav.sub", { href: boardHref(b.id) }, b.title || "Untitled"))) : null,
        t.more || t.other.more ? h("p.muted", {}, "Some Spaces or boards are not listed. Use search.") : null));
  }

  function renderMain() {
    if (S.status === "loading" && !S.data) return replace(main, h("p.muted", {}, "Loading…"));
    if (S.status === "error") return replace(main, empty({ title: "Could not load Home.", detail: "The server did not answer. Check your connection and try again." }), h("button.btn", { type: "button", onclick: () => model.load() }, "Try again"));
    if (S.status === "signed-out") return replace(main, empty({ title: "You are signed out.", detail: "Sign in again to see your boards." }),
      signIn ? h("a.btn.primary", { href: signIn.href }, signIn.text ?? "Sign in") : null);
    const m = model.main();
    if (!m) return replace(main);
    if (m.kind === "search" || m.kind === "space") {
      return replace(main, h("h1", {}, m.title), m.status === "loading" && !m.cards.length ? h("p.muted", {}, "Searching…")
        : m.status === "error" ? empty({ title: m.kind === "space" ? "Could not load this Space." : "Search failed.", detail: "Try again in a moment." })
          : m.cards.length ? cardList(m.cards, "Search results") : empty(m.empty),
      m.more ? h("p.muted", {}, m.kind === "space" ? "More boards are in this Space. Use search." : "More boards match. Narrow the search.") : null);
    }
    if (m.sections) {
      const shown = m.sections.filter(s => s.cards.length);
      return replace(main, h("h1", {}, m.title), shown.length ? shown.map(s => h("section", { "aria-label": s.title }, h("h2.sec", {}, s.title), cardList(s.cards, s.title))) : empty(m.empty));
    }
    return replace(main, h("h1", {}, m.title), m.cards.length ? cardList(m.cards, m.title) : empty(m.empty));
  }

  function render() {
    renderSide();
    renderMain();
    who.textContent = S.data ? S.data.user.name : "";
    status.textContent = S.notice ?? "";
    status.hidden = !S.notice;
    if (S.notice) status.append(" ", h("button.btn.ghost", { type: "button", onclick: () => model.dismissNotice() }, "Dismiss"));
  }
  const unsub = model.subscribe(render);
  const onKey = e => {
    const typing = /^(input|textarea|select)$/i.test(e.target?.tagName ?? "") || e.target?.isContentEditable;
    if ((e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing) || ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey) && !e.altKey)) { e.preventDefault(); search.focus(); }
  };
  document.addEventListener("keydown", onKey);
  render();
  return { destroy() { unsub(); document.removeEventListener("keydown", onKey); root.replaceChildren(); } };
}
