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
  const cfg = { label, items };                 // read at open time, so a re-render can update them without a new button
  const button = h("button.btn.ghost.more", { type: "button", "aria-label": label, "aria-haspopup": "menu", "aria-expanded": "false", onclick: () => (menu ? close(true) : open()) }, "⋯");
  const wrap = h("span.menu-wrap", {}, button);
  let menu = null;
  const buttons = () => [...menu.children];   // an HTMLCollection has no indexOf
  const onDoc = e => { if (menu && !wrap.contains?.(e.target)) close(false); };
  function open() {
    menu = h("div.menu", { role: "menu", "aria-label": cfg.label, onkeydown: e => {
      const list = buttons(), i = list.indexOf(globalThis.document?.activeElement);
      if (e.key === "Escape") { e.preventDefault?.(); close(true); }
      else if (e.key === "ArrowDown") { e.preventDefault?.(); list[(i + 1) % list.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault?.(); list[(i <= 0 ? list.length : i) - 1].focus(); }
      else if (e.key === "Home") { e.preventDefault?.(); list[0].focus(); }
      else if (e.key === "End") { e.preventDefault?.(); list.at(-1).focus(); }
      else if (e.key === "Tab") close(false);
    } }, cfg.items.filter(i => i && !i.hidden).map(i => (i.href ? h("a", { role: "menuitem", href: i.href, tabindex: "-1" }, i.text) : h("button", { type: "button", role: "menuitem", onclick: () => { close(false); i.onSelect(button); } }, i.text))));
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
  return { el: wrap, button, close: () => close(false), update: n => { cfg.label = n.label; cfg.items = n.items; button.setAttribute("aria-label", n.label); } };
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

/**
 * Keeps controls alive across renders and focus where it was. `keep(key, make)` hands back the same element every render (so a click that
 * began on it before a re-render still lands, and an open menu stays open); `mark(el, key)` labels what may hold focus. `around(fn)` runs a
 * render and puts focus back on the marked element that had it (a rebuilt link or the moved button), so a Tab-out of a rename that saved
 * never drops focus to the body.
 */
function keeper() {
  const kept = new Map(), marks = new Map(); let used = new Set();
  const fk = () => globalThis.document?.activeElement?.getAttribute?.("data-fk") ?? null;
  return {
    keep(key, make) { let v = kept.get(key); if (!v) kept.set(key, v = make()); used.add(key); return v; },
    mark(el, key) { el.setAttribute("data-fk", key); marks.set(key, el); return el; },
    around(fn) {
      const had = fk(), prev = globalThis.document?.activeElement ?? null; used = new Set(); marks.clear();
      fn();
      for (const k of [...kept.keys()]) if (!used.has(k)) kept.delete(k);
      if (had) marks.get(had)?.focus?.();
      else if (prev?.isConnected && globalThis.document?.activeElement !== prev) prev.focus?.();       // an unmarked element that was moved (an open menu's item)     // a no-op when it still holds focus; the caller's own end-of-edit focus runs after this
    },
  };
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
  const title = {}, cardEdits = new Map(), after = afterRender(), links = new Map(), keys = keeper();
  let h1 = null, shown = null, spaceId = null;
  /** End an edit and put focus somewhere sensible: the title, or the card's own link. */
  const end = (to) => { editing = null; after.set(to); render(); };
  const focusTitle = () => h1?.focus?.();

  function card(c) {
    const where = [c.role].filter(Boolean).join(" · ");
    const menuCfg = { label: `More for ${c.title || "Untitled"}`, items: [
      { text: "Open", href: hrefs.board(c.id) },
      { text: "Rename", hidden: !c.can?.rename, onSelect: () => { editing = { type: "board", id: c.id }; render(); } },
    ] };
    const menu = keys.keep(`card-menu:${c.id}`, () => overflowMenu(menuCfg));
    menu.update(menuCfg);
    keys.mark(menu.button, `card-menu:${c.id}`);
    const focusCard = () => links.get(c.id)?.focus?.();
    const input = inlineEditor({ editing: editing?.type === "board" && editing.id === c.id, session: cardEdits.get(c.id) ?? (cardEdits.set(c.id, {}), cardEdits.get(c.id)), text: c.title, label: "Board title",
      onSave: (v, moved) => model.renameBoard(c.id, v).then(ok => { if (ok) end(moved ? null : focusCard); else render(); }), onCancel: () => end(focusCard) });
    const link = input ? null : h("a.card-open", { href: hrefs.board(c.id) }, h("span.t", {}, c.title || "Untitled"), h("span.p", {}, where));
    if (link) { links.set(c.id, link); keys.mark(link, `card-link:${c.id}`); }
    return h("li.card", {}, input ? h("div.card-open", {}, input, h("span.p", {}, "Enter to save, Escape to cancel")) : link, h("span.card-menu", {}, menu.el));
  }

  function render() {
    showNotice(status, model);
    if (gate(S, main, () => model.load(), signIn)) return;
    // Only the in-flight flag changed (a rename is saving): nothing to rebuild, so a control the person just moved to keeps focus and
    // a click that began on it still lands.
    const sig = editing ? `${editing.type}:${editing.id ?? ""}` : "";
    if (S.busy && shown && shown.page === S.page && shown.sig === sig) return;
    shown = { page: S.page, sig };
    keys.around(draw);
    after.run();
  }
  function draw() {
    links.clear();
    for (const id of [...cardEdits.keys()]) if (editing?.type !== "board" || editing.id !== id) cardEdits.delete(id);   // one edit session per card, only while that card is being edited
    const p = S.page, sp = p.space;
    const crumbs = h("nav.crumbs", { "aria-label": "Breadcrumb" }, h("a", { href: hrefs.home }, "Home"), " / ",
      sp.group ? [h("a", { href: hrefs.group(sp.group.id) }, sp.group.name), " / "] : null);
    spaceId = sp.id;
    const newBoard = keys.mark(keys.keep(`new-board:${p.can.createBoard}`, () => h("button.btn.primary", { type: "button", disabled: !p.can.createBoard, "aria-disabled": p.can.createBoard ? null : "true",
      title: p.can.createBoard ? null : "You can't add boards here", onclick: e => dialogs.newBoard({ opener: e.currentTarget, space: spaceId }) }, "＋ New board")), "new-board");
    const menuCfg = { label: "Space options", items: [
      { text: "Rename", hidden: !p.can.rename, onSelect: () => { editing = { type: "title" }; render(); } },
      { text: "General access…", hidden: !p.can.general, onSelect: b => dialogs.general({ opener: b, current: sp.general, onSave: r => model.setGeneral(r) }) },
    ] };
    const menu = p.can.rename || p.can.general ? keys.keep("space-options", () => overflowMenu(menuCfg)) : null;
    if (menu) { menu.update(menuCfg); keys.mark(menu.button, "space-options"); }
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
  const title = {}, after = afterRender(), keys = keeper();
  let h1 = null, shown = null, groupId = null, moreBtn = null;
  const end = (moved = false) => { editing = false; after.set(moved ? null : () => h1?.focus?.()); render(); };

  function render() {
    showNotice(status, model);
    if (gate(S, main, () => model.load(), signIn)) return;
    // Only the in-flight flag changed: update the one control that shows it, rebuild nothing (focus and clicks stay where they are).
    if (S.busy && shown && shown.page === S.page && shown.editing === editing) { if (moreBtn) moreBtn.disabled = true; return; }
    shown = { page: S.page, editing };
    keys.around(draw);
    after.run();
  }
  function draw() {
    const p = S.page, g = p.group;
    groupId = g.id;
    const newSpace = p.can.createSpace ? keys.mark(keys.keep("new-space", () => h("button.btn.primary", { type: "button", onclick: e => dialogs.newSpace({ opener: e.currentTarget, group: groupId }) }, "＋ New space")), "new-space") : null;
    const menuCfg = { label: "Group options", items: [
      { text: "Rename", hidden: !p.can.rename, onSelect: () => { editing = true; render(); } },
      { text: "General access…", hidden: !p.can.general, onSelect: b => dialogs.general({ opener: b, current: g.general, onSave: r => model.setGeneral(r) }) },
    ] };
    const menu = p.can.rename || p.can.general ? keys.keep("group-options", () => overflowMenu(menuCfg)) : null;
    if (menu) { menu.update(menuCfg); keys.mark(menu.button, "group-options"); }
    const input = inlineEditor({ editing, session: title, text: g.name, label: "Group name",
      onSave: (v, moved) => model.rename(v).then(ok => { if (ok) end(moved); else render(); }), onCancel: end });
    h1 = h("h1", { id: "page-title", tabindex: "-1" }, input ?? g.name);
    const head = h("div.sp-head", {}, h1, h("span.badge", {}, "Group"), h("span.spacer"), newSpace, menu?.el);
    const empty = groupEmpty(p, g.name);
    replace(main, h("nav.crumbs", { "aria-label": "Breadcrumb" }, h("a", { href: hrefs.home }, "Home"), " /"), head, h("p.sub-h", {}, generalText(g.general)),
      p.spaces.length ? h("ul.cards", { "aria-label": `Spaces in ${g.name}` }, p.spaces.map(s => h("li.card", {},
        h("a.card-open", { href: hrefs.space(s.id) }, h("span.t", {}, s.name), h("span.p", {}, generalText(s.general))))))
        : message(empty.title, empty.detail),
      (moreBtn = p.next ? keys.mark(h("button.btn", { type: "button", disabled: S.busy, onclick: () => model.loadMore() }, "Show more Spaces"), "show-more") : null));
  }
  const unsub = model.subscribe(render);
  render();
  return { destroy() { unsub(); root.replaceChildren(); } };
}
