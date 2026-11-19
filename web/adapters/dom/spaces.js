// The Space page and the Group page (driving adapter over the DOM): a board grid / a Space grid, rename in place, an overflow menu, and the
// New board / New space actions (dialogs: ./dialogs.js). Renders web/core/spaces.js's page model. Names and titles are other people's words:
// they go in through textContent only. Every control is a real button or link (keyboard), menus follow the ARIA menu pattern, and the
// layout is one column that works at 390 and 1280 px. Visuals are plain on purpose (#56 restyles); structure follows design/orgs/mock.html.

import { h, replace } from "./dom.js";
import { generalText, spaceEmpty, groupEmpty } from "../../core/spaces.js";

/**
 * An overflow menu: a button that opens a `role="menu"`. Arrow keys move, Enter/Space choose, Escape closes and returns focus to the
 * button, a click elsewhere closes. @returns {{ el: HTMLElement, button: HTMLElement }}
 */
export function overflowMenu({ label, items }) {
  const button = h("button.btn.ghost.more", { type: "button", "aria-label": label, "aria-haspopup": "menu", "aria-expanded": "false", onclick: () => (menu ? close(true) : open()) }, "⋯");
  const wrap = h("span.menu-wrap", {}, button);
  let menu = null;
  const buttons = () => [...menu.children];   // an HTMLCollection has no indexOf
  const onDoc = e => { if (menu && !wrap.contains?.(e.target)) close(false); };
  function open() {
    menu = h("div.menu", { role: "menu", "aria-label": label, onkeydown: e => {
      const list = buttons(), i = list.indexOf(globalThis.document?.activeElement);
      if (e.key === "Escape") { e.preventDefault?.(); close(true); }
      else if (e.key === "ArrowDown") { e.preventDefault?.(); list[(i + 1) % list.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault?.(); list[(i <= 0 ? list.length : i) - 1].focus(); }
      else if (e.key === "Home") { e.preventDefault?.(); list[0].focus(); }
      else if (e.key === "End") { e.preventDefault?.(); list.at(-1).focus(); }
      else if (e.key === "Tab") close(false);
    } }, items.filter(i => i && !i.hidden).map(i => (i.href ? h("a", { role: "menuitem", href: i.href, tabindex: "-1" }, i.text) : h("button", { type: "button", role: "menuitem", onclick: () => { close(false); i.onSelect(button); } }, i.text))));
    wrap.append(menu);
    button.setAttribute("aria-expanded", "true");
    globalThis.document?.addEventListener?.("click", onDoc);
    buttons()[0]?.focus?.();
  }
  function close(refocus) {
    if (!menu) return;
    menu.remove(); menu = null;
    button.setAttribute("aria-expanded", "false");
    globalThis.document?.removeEventListener?.("click", onDoc);
    if (refocus) button.focus?.();
  }
  return { el: wrap, button, close: () => close(false) };
}

/** Focus an input and select its text once it is in the page (so typing replaces the old title). */
const focusSelect = el => { globalThis.queueMicrotask?.(() => { el.focus?.(); el.select?.(); }); return el; };

/** The page chrome shared by both pages. */
function shell(root, hrefs) {
  const status = h("div.home-status", { role: "status", "aria-live": "polite", hidden: true });
  const main = h("main.home-main.sp-main", { id: "home-main", tabindex: "-1" });
  root.replaceChildren(h("div.home.sp-page", {},
    h("header.home-top", {}, h("a.logo", { href: hrefs.home, "aria-label": "Plenary home" }, "Plenary"), h("span.spacer")), status, main));
  return { status, main };
}
function showNotice(status, model) {
  const S = model.state;
  status.textContent = S.notice ?? "";
  status.hidden = !S.notice;
  if (S.notice) status.append(" ", h("button.btn.ghost", { type: "button", onclick: () => model.dismissNotice() }, "Dismiss"));
}
const message = (title, detail) => h("div.home-empty", {}, h("h2", {}, title), detail ? h("p", {}, detail) : null);
const gate = (S, main, retry, signIn) => {
  if (S.status === "loading" && !S.page) { replace(main, h("p.muted", {}, "Loading…")); return true; }
  if (S.status === "notfound") { replace(main, message("This page is not available.", "It may not exist, or you may not have access to it."), h("a.btn", { href: "./" }, "Back to Home")); return true; }
  if (S.status === "signed-out") { replace(main, message("You are signed out.", "Sign in again to see this page."), signIn ? h("a.btn.primary", { href: signIn.href }, signIn.text ?? "Sign in") : null); return true; }
  if (S.status === "error") { replace(main, message("Could not load this page.", "The server did not answer. Check your connection and try again."), h("button.btn", { type: "button", onclick: retry }, "Try again")); return true; }
  return false;
};

/**
 * An inline editor (rename in place) for a title or a card. The input lives in `session.el` for the whole edit: a re-render while the save is
 * in flight (the model announces `busy`) must not rebuild it, or the old input's removal fires a blur that would save the OLD text over the
 * new name, and the typed text would flash back to the old title. The blur only saves while the input is still the session's; Enter and
 * blur save, Escape cancels, and a refused save leaves it open to retry. If it had focus when the page re-rendered, it gets it back.
 * Without `editing` the session is cleared. @returns {HTMLElement | null} the input (null when not editing)
 */
function inlineEditor({ editing, session, text, label, onSave, onCancel }) {
  if (!editing) { session.el = null; return null; }
  if (session.el) {
    const el = session.el, had = globalThis.document?.activeElement === el;
    if (had) globalThis.queueMicrotask?.(() => el.focus?.());
    return el;
  }
  let done = false;
  // `moved`: the save came from a blur whose focus went to another element (the person clicked elsewhere): the page must not pull it back.
  const finish = (save, el, moved = false) => {
    if (done || session.el !== el) return;
    done = true;
    Promise.resolve(save ? onSave(el.value, moved) : onCancel()).finally(() => { done = false; });
  };
  const el = h("input.field.rename", { type: "text", value: text, maxlength: "200", "aria-label": label, onkeydown: e => {
    if (e.key === "Enter") { e.preventDefault?.(); finish(true, e.currentTarget); }
    else if (e.key === "Escape") { e.preventDefault?.(); e.stopPropagation?.(); finish(false, e.currentTarget); }
  }, onblur: e => finish(true, e.currentTarget, !!e.relatedTarget) });
  session.el = el;
  globalThis.queueMicrotask?.(() => { el.focus?.(); el.select?.(); });
  return el;
}

/** What to focus once the next render is in the page (a rename ended: the title, or the card's link). */
const afterRender = () => { let fn = null; return { set: f => { fn = f; }, run: () => { const f = fn; fn = null; f?.(); } }; };

/**
 * @param {{ root: HTMLElement, model: ReturnType<typeof import("../../core/spaces.js").createPageModel>, dialogs: ReturnType<typeof import("./dialogs.js").createDialogs>,
 *   hrefs: { home: string, board(id: string): string, space(id: string): string, group(id: string): string },
 *   signIn?: { href: string, text?: string } | null }} o
 * @returns {{ destroy(): void }}
 */
export function mountSpacePage({ root, model, dialogs, hrefs, signIn = null }) {
  const S = model.state;
  const { status, main } = shell(root, hrefs);
  /** @type {null | { type: "title" } | { type: "board", id: string }} */
  let editing = null;
  const title = {}, cardEdits = new Map(), after = afterRender(), links = new Map();
  let h1 = null;
  /** End an edit and put focus somewhere sensible: the title, or the card's own link. */
  const end = (to) => { editing = null; after.set(to); render(); };
  const focusTitle = () => h1?.focus?.();

  function card(c) {
    const where = [c.role].filter(Boolean).join(" · ");
    const menu = overflowMenu({ label: `More for ${c.title || "Untitled"}`, items: [
      { text: "Open", href: hrefs.board(c.id) },
      { text: "Rename", hidden: !c.can?.rename, onSelect: () => { editing = { type: "board", id: c.id }; render(); } },
    ] });
    const focusCard = () => links.get(c.id)?.focus?.();
    const input = inlineEditor({ editing: editing?.type === "board" && editing.id === c.id, session: cardEdits.get(c.id) ?? (cardEdits.set(c.id, {}), cardEdits.get(c.id)), text: c.title, label: "Board title",
      onSave: (v, moved) => model.renameBoard(c.id, v).then(ok => { if (ok) end(moved ? null : focusCard); else render(); }), onCancel: () => end(focusCard) });
    const link = input ? null : h("a.card-open", { href: hrefs.board(c.id) }, h("span.t", {}, c.title || "Untitled"), h("span.p", {}, where));
    if (link) links.set(c.id, link);
    return h("li.card", {}, input ? h("div.card-open", {}, input, h("span.p", {}, "Enter to save, Escape to cancel")) : link, h("span.card-menu", {}, menu.el));
  }

  function render() {
    showNotice(status, model);
    if (gate(S, main, () => model.load(), signIn)) return;
    links.clear();
    for (const id of [...cardEdits.keys()]) if (editing?.type !== "board" || editing.id !== id) cardEdits.delete(id);   // one edit session per card, only while that card is being edited
    const p = S.page, sp = p.space;
    const crumbs = h("nav.crumbs", { "aria-label": "Breadcrumb" }, h("a", { href: hrefs.home }, "Home"), " / ",
      sp.group ? [h("a", { href: hrefs.group(sp.group.id) }, sp.group.name), " / "] : null);
    const newBoard = h("button.btn.primary", { type: "button", disabled: !p.can.createBoard, "aria-disabled": p.can.createBoard ? null : "true",
      title: p.can.createBoard ? null : "You can't add boards here", onclick: e => dialogs.newBoard({ opener: e.currentTarget, space: sp.id }) }, "＋ New board");
    const menu = p.can.rename || p.can.general ? overflowMenu({ label: "Space options", items: [
      { text: "Rename", hidden: !p.can.rename, onSelect: () => { editing = { type: "title" }; render(); } },
      { text: "General access…", hidden: !p.can.general, onSelect: b => dialogs.general({ opener: b, current: sp.general, onSave: r => model.setGeneral(r) }) },
    ] }) : null;
    const input = inlineEditor({ editing: editing?.type === "title", session: title, text: sp.name, label: "Space name",
      onSave: (v, moved) => model.rename(v).then(ok => { if (ok) end(moved ? null : focusTitle); else render(); }), onCancel: () => end(focusTitle) });
    h1 = h("h1", { id: "page-title", tabindex: "-1" }, input ?? sp.name);
    const head = h("div.sp-head", {}, h1,
      h("span.badge", {}, sp.personal ? "Personal · only you" : "Space"), h("span.spacer"), newBoard, menu?.el);
    const sub = h("p.sub-h", {}, sp.personal ? "Only you can see what's here until you share it." : generalText(sp.general));
    const empty = spaceEmpty(p);
    replace(main, crumbs, head, sub,
      p.boards.length ? h("ul.cards", { "aria-label": `Boards in ${sp.name}` }, p.boards.map(c => card(c))) : message(empty.title, empty.detail),
      p.more ? h("p.muted", {}, "More boards are in this Space. Use search on Home to find them.") : null);
    after.run();
  }
  const unsub = model.subscribe(render);
  render();
  return { destroy() { unsub(); root.replaceChildren(); } };
}

/** The Group page: its Spaces as tiles, New space, rename in place, overflow menu. */
export function mountGroupPage({ root, model, dialogs, hrefs, signIn = null }) {
  const S = model.state;
  const { status, main } = shell(root, hrefs);
  let editing = false;
  const title = {}, after = afterRender();
  let h1 = null;
  const end = (moved = false) => { editing = false; after.set(moved ? null : () => h1?.focus?.()); render(); };

  function render() {
    showNotice(status, model);
    if (gate(S, main, () => model.load(), signIn)) return;
    const p = S.page, g = p.group;
    const newSpace = p.can.createSpace ? h("button.btn.primary", { type: "button", onclick: e => dialogs.newSpace({ opener: e.currentTarget, group: g.id }) }, "＋ New space") : null;
    const menu = p.can.rename || p.can.general ? overflowMenu({ label: "Group options", items: [
      { text: "Rename", hidden: !p.can.rename, onSelect: () => { editing = true; render(); } },
      { text: "General access…", hidden: !p.can.general, onSelect: b => dialogs.general({ opener: b, current: g.general, onSave: r => model.setGeneral(r) }) },
    ] }) : null;
    const input = inlineEditor({ editing, session: title, text: g.name, label: "Group name",
      onSave: (v, moved) => model.rename(v).then(ok => { if (ok) end(moved); else render(); }), onCancel: end });
    h1 = h("h1", { id: "page-title", tabindex: "-1" }, input ?? g.name);
    const head = h("div.sp-head", {}, h1, h("span.badge", {}, "Group"), h("span.spacer"), newSpace, menu?.el);
    const empty = groupEmpty(p, g.name);
    replace(main, h("nav.crumbs", { "aria-label": "Breadcrumb" }, h("a", { href: hrefs.home }, "Home"), " /"), head, h("p.sub-h", {}, generalText(g.general)),
      p.spaces.length ? h("ul.cards", { "aria-label": `Spaces in ${g.name}` }, p.spaces.map(s => h("li.card", {},
        h("a.card-open", { href: hrefs.space(s.id) }, h("span.t", {}, s.name), h("span.p", {}, generalText(s.general))))))
        : message(empty.title, empty.detail),
      p.next ? h("button.btn", { type: "button", disabled: S.busy, onclick: () => model.loadMore() }, "Show more Spaces") : null);
    after.run();
  }
  const unsub = model.subscribe(render);
  render();
  return { destroy() { unsub(); root.replaceChildren(); } };
}
