// The Home page: a driving adapter over the DOM that renders web/core/home.js's model (Recent, Starred, Shared with me,
// the Group/Space tree, search). Part of the dom group; the composition root (web/main.js) mounts it when someone is signed in with no
// board in the link. All text goes in through textContent (titles and names are other people's words). Keyboard: "/"
// focuses search, Escape clears it, every card is a link plus a star button. Visuals are intentionally plain: #56 restyles.

import { h, replace } from "./dom.js";
import { keeper } from "./focus.js";
import { pathText, whenText } from "../../core/home.js";

/**
 * @param {{ root: HTMLElement, model: ReturnType<typeof import("../../core/home.js").createHomeModel>, clock: import("../../ports/clock.js").Clock,
 *   boardHref: (id: string) => string, spaceHref: (id: string) => string, groupHref: (id: string) => string,
 *   dialogs: Pick<ReturnType<typeof import("./dialogs.js").createDialogs>, "newBoard"|"newSpace"|"newGroup">, homeHref?: string, signIn?: { href: string, text?: string } | null }} o
 * @returns {{ destroy(): void }}
 */
export function mountHome({ root, model, clock, boardHref, spaceHref, groupHref, teamsHref = null, unitAccessHref = null, dialogs, homeHref = "./", signIn = null }) {
  const S = model.state, keys = keeper(), mark = keys.mark;
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
  // Every control that can hold focus is marked with a stable key, so a redraw (a star toggled, a view picked, a load, a notice) puts focus back.
  const newBoard = () => mark(h("button.btn.primary", { type: "button", onclick: e => dialogs.newBoard({ opener: e.currentTarget }) }, "＋ New board"), "new-board");
  const newSpace = () => mark(h("button.btn", { type: "button", onclick: e => dialogs.newSpace({ opener: e.currentTarget }) }, "＋ New space"), "new-space");
  const newGroup = () => (S.data?.can?.createGroup ? mark(h("button.btn", { type: "button", onclick: e => dialogs.newGroup({ opener: e.currentTarget }) }, "＋ New group"), "new-group") : null);
  const navBtn = (view, label, count) => mark(h("button.nav", { type: "button", "aria-current": S.view === view && !S.query.trim() ? "page" : null,
    onclick: () => { search.value = ""; model.setQuery(""); model.setView(view); } }, label, count != null ? h("span.n", {}, String(count)) : null), `nav:${view}`);

  function star(c, sec) {
    return mark(h("button.star", { type: "button", "aria-pressed": c.starred ? "true" : "false", "aria-label": `${c.starred ? "Unstar" : "Star"} ${c.title || "Untitled"}`,
      title: c.starred ? "Unstar" : "Star", onclick: () => model.toggleStar(c.id) }, c.starred ? "★" : "☆"), `star:${sec}:${c.id}`);
  }
  function card(c, sec) {
    const when = c.at != null ? whenText(c.at, clock.now()) : "";
    const where = pathText(c.path);
    return h("li.card", {},
      mark(h("a.card-open", { href: boardHref(c.id) }, h("span.t", {}, c.title || "Untitled"), h("span.p", {}, [where, c.role, when].filter(Boolean).join(" · "))), `card:${sec}:${c.id}`),
      guest() ? null : star(c, sec));
  }
  const cardList = (cards, label) => h("ul.cards", { "aria-label": label }, cards.map(c => card(c, label)));
  const empty = e => h("div.home-empty", {}, h("h2", {}, e.title), e.detail ? h("p", {}, e.detail) : null);

  function renderSide() {
    const d = S.data;
    if (!d) return replace(side);
    // A Space opens its own page (?space=<id>), a Group its (?group=<id>).
    const node = s => mark(h("a.nav.sub", { href: spaceHref(s.id), title: `Open ${s.name}`, "aria-label": `Open ${s.name}` }, s.personal ? "◐ " : "▢ ", s.name), `space:${s.id}`);
    const t = d.tree;
    const orgLinks = d.guest ? [] : [teamsHref ? mark(h("a.nav", { href: teamsHref }, "Teams"), "link:teams") : null,
      unitAccessHref && d.unit && d.can?.manageAccess ? mark(h("a.nav", { href: unitAccessHref(d.unit.id) }, "Organization access"), "link:unit-access") : null];
    replace(side, d.guest ? null : newBoard(), d.guest ? null : newSpace(), newGroup(), navBtn("home", "Home"), d.guest ? null : navBtn("starred", "Starred", d.starred.length), navBtn("shared", "Shared with me", d.shared.length), orgLinks,
      t && h("div.tree", { role: "group", "aria-label": "Groups and Spaces" },
        t.groups.map(g => h("div.grp", {}, h("h4", {}, mark(h("a", { href: groupHref(g.id) }, g.name), `group:${g.id}`)), g.spaces.map(node))),
        t.spaces.length ? h("div.grp", {}, h("h4", {}, "Not in a group"), t.spaces.map(node)) : null,
        t.other.boards.length ? h("div.grp", {}, h("h4", {}, "Other boards"), t.other.boards.map(b => mark(h("a.nav.sub", { href: boardHref(b.id) }, b.title || "Untitled"), `other:${b.id}`))) : null,
        t.more || t.other.more ? h("p.muted", {}, "Some Spaces or boards are not listed. Use search.") : null));
  }

  function renderMain() {
    if (S.status === "loading" && !S.data) return replace(main, h("p.muted", {}, "Loading…"));
    if (S.status === "error") return replace(main, empty({ title: "Could not load Home.", detail: "The server did not answer. Check your connection and try again." }), mark(h("button.btn", { type: "button", onclick: () => model.load() }, "Try again"), "retry"));
    if (S.status === "signed-out") return replace(main, empty({ title: "You are signed out.", detail: "Sign in again to see your boards." }),
      signIn ? h("a.btn.primary", { href: signIn.href }, signIn.text ?? "Sign in") : null);
    const m = model.main();
    if (!m) return replace(main);
    if (m.kind === "search") {
      return replace(main, mark(h("h1", { tabindex: "-1" }, m.title), "heading"), m.status === "loading" && !m.cards.length ? h("p.muted", {}, "Searching…")
        : m.status === "error" ? empty({ title: "Search failed.", detail: "Try again in a moment." })
          : m.cards.length ? cardList(m.cards, "Search results") : empty(m.empty),
      m.more ? h("p.muted", {}, "More boards match. Narrow the search.") : null);
    }
    if (m.sections) {
      const shown = m.sections.filter(s => s.cards.length);
      return replace(main, mark(h("h1", { tabindex: "-1" }, m.title), "heading"), shown.length ? shown.map(s => h("section", { "aria-label": s.title }, h("h2.sec", {}, s.title), cardList(s.cards, s.title))) : empty(m.empty));
    }
    return replace(main, mark(h("h1", { tabindex: "-1" }, m.title), "heading"), m.cards.length ? cardList(m.cards, m.title) : empty(m.empty));
  }

  function render() { keys.around(draw); }
  function draw() {
    renderSide();
    renderMain();
    who.textContent = S.data ? S.data.user.name : "";
    status.textContent = S.notice ?? "";
    status.hidden = !S.notice;
    if (S.notice) status.append(" ", mark(h("button.btn.ghost", { type: "button", onclick: () => model.dismissNotice() }, "Dismiss"), "dismiss"));
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
