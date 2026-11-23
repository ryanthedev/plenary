// @ts-check
// The leaver screen (driving adapter over the DOM), rendering web/core/offboard.js: find a person, see what they solely own, pick who takes each item (the default is the manager, else you),
// review exactly what moves where in a confirm dialog, apply it one item at a time, then remove the person. Plain on purpose (#56 restyles).
//
// Rules this file keeps: names are other people's words (textContent only); every control is a real button, link, input or select; the table has a caption and column headers; each
// recipient picker is a labelled native <select>; `aria-disabled`, never `disabled`; changes are said in the polite live region (announce()); the confirm step is a real modal
// (openDialog: role="dialog", aria-modal, labelled by its heading, focus moves in and stays inside, Escape and Cancel close it and focus returns to the button that opened it);
// no meaning is carried by colour alone.

import { h, replace } from "./dom.js";
import { announce, captureFocus, restoreFocus } from "./focus.js";
import { openDialog } from "./dialogs.js";
import { shell, showNotice, message } from "./spaces.js";
import { act, setOff, speak } from "./access.js";
import { isMobileCardViewport, renderOffboardCards } from "./mobile/admin-cards.js";
import { itemLabel, planLine, removeLines } from "../../core/offboard.js";

/**
 * @param {{ root: HTMLElement, model: ReturnType<typeof import("../../core/offboard.js").createOffboardModel>, hrefs: { home: string }, signIn?: { href: string, text?: string } | null, start?: string|null, mobileCards?: boolean | null, themeCtrl?: import("./theme.js").ThemeController | null }} o
 *   start: a person to open at once (`?offboard=<user id>`)
 */
export function mountOffboardPage({ root, model, hrefs, signIn = null, start = null, mobileCards = null, themeCtrl = null }) {
  const S = model.state;
  const { status, main, destroyTheme } = shell(root, hrefs, { themeCtrl });
  let dlg = null, reviewBtn = null, removeBtn = null, h1 = null, focusTo = null;
  /** The control with this `data-fk` in the CURRENT page (a redraw replaces every node, so a held reference points at a detached one), else the heading. */
  const keeper = k => (typeof main.querySelector === "function" ? main.querySelector(`[data-fk="${k}"]`) : main.find(e => e.getAttribute?.("data-fk") === k)) ?? h1;
  /** An opener the dialog focuses when it closes: resolved THEN (after the redraws the apply made), never a node held from before. */
  const openerOf = k => ({ focus: () => keeper(k)?.focus?.() });

  const searchBox = (label, run, results, pick, id, into) => {
    const input = h("input.field", { type: "search", id, "data-fk": `find:${id}`, maxlength: "100", autocomplete: "off", "aria-label": label, value: S.query[into] ?? "" });
    const form = h("form", { role: "search", "aria-label": label, onsubmit: e => { e.preventDefault?.(); run(input.value); } }, input, h("button.btn", { type: "submit" }, "Search"));
    const list = results.length ? h("ul.matches", { "aria-label": `${label}: matches` }, results.map(p => h("li", {}, h("button.btn.ghost", { type: "button", "data-fk": `match:${id}:${p.id}`, onclick: () => { focusTo = id === "offboard-owner" ? `find:${id}` : "heading"; pick(p); } }, p.name)))) : null;
    return h("div", {}, form, S.searching ? h("p.muted", {}, "Searching…") : list);
  };

  function row(i) {
    const to = model.recipientOf(i), res = S.results.get(model.itemKey(i)), people = model.people(), may = i.can.reassign || i.can.handover === true, fk = "pick:" + model.itemKey(i).replace("\n", ":");
    const sel = h("select.field", { "data-fk": fk, "aria-label": `New owner of ${i.name}`, "aria-disabled": may && !S.busy ? "false" : "true",
      onchange: e => { const p = people.find(x => x.id === e.target.value); if (p && may && !S.busy) { focusTo = fk; model.choose(i, p); } else e.target.value = to.id; } },
      people.map(p => h("option", { value: p.id, selected: p.id === to.id }, p.id === S.defaults.recipient.id ? `${p.name} (${S.defaults.reason === "manager" ? "their manager" : "you"})` : p.name)));
    return h("tr", {}, h("th", { scope: "row" }, itemLabel(i), " ", h("span.badge", {}, i.type === "group" ? "Area" : i.personal ? "Personal space" : "Space"), i.trashed ? h("span.badge.badge-danger", {}, " In Trash") : null),
      h("td", { "data-label": "New owner" }, may ? sel : h("span.muted", {}, i.can.why ?? "You can't hand this on.")),
      h("td", { "data-label": "Status" }, res ? h("span", { role: res.ok ? null : "alert" }, res.ok ? "Done. " : "Not done. ", res.text) : i.can.reassign ? "Not yet" : i.can.handover ? "Goes with the removal" : "Skipped"));
  }

  function draw() {
    if (S.status === "loading") return replace(main, h("p.muted", {}, "Loading…"));
    if (S.status === "signed-out") return replace(main, message("You are signed out.", "Sign in again to continue."), signIn ? h("a.btn.primary", { href: signIn.href }, signIn.text ?? "Sign in") : null);
    if (S.status === "forbidden") return replace(main, message("This is not available.", "Only people who manage members can offboard someone."), h("a.btn", { href: hrefs.home }, "Back to Home"));
    if (S.status === "notfound") return replace(main, message("This person is not available.", "They may never have signed in to this organization."), h("a.btn", { href: hrefs.home }, "Back to Home"));
    if (S.status === "error") return replace(main, message("Could not load this page.", S.notice ?? "The server did not answer."), h("a.btn", { href: hrefs.home }, "Back to Home"));
    h1 = h("h1", { id: "page-title", tabindex: "-1", "data-fk": "heading" }, "Offboard a member");
    const crumbs = h("nav.crumbs", { "aria-label": "Breadcrumb" }, h("a", { href: hrefs.home }, "Home"), " /");
    const finder = searchBox("Find a person", q => model.search(q), S.found, p => model.open(p.id), "offboard-find", "found");
    if (!S.member) return replace(main, crumbs, h("div.sp-head", {}, h1), h("p.sub-h", {}, "Reassign what they solely own, then remove them. Nothing moves until you confirm."), finder);
    const m = S.member, d = S.defaults, n = S.items.length, can = model.actionable().length, qualifies = can > 0 || model.handedOver() !== null;
    const itemsView = isMobileCardViewport(mobileCards)
      ? renderOffboardCards({
        memberName: m.name,
        items: S.items,
        model,
        busy: S.busy,
        defaults: d,
        results: S.results,
        itemLabel,
        onChoose: (item, person, fk) => { focusTo = fk; model.choose(item, person); },
      })
      : h("div.matrix-scroll", { role: "region", "aria-label": `What ${m.name} solely owns`, tabindex: "0" },
        h("table.matrix", {}, h("caption", {}, `What ${m.name} solely owns`),
          h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Item"), h("th", { scope: "col" }, "New owner"), h("th", { scope: "col" }, "Status"))), h("tbody", {}, S.items.map(row))));
    reviewBtn = act({ class: "primary", "data-fk": "review" }, "Review and reassign…", () => { dlg = null; if (model.openConfirm("items")) openConfirm(openerOf("review")); }, () => S.busy || !can);
    removeBtn = act({ class: "btn-danger-ghost", "data-fk": "remove" }, `Remove ${m.name}…`, () => { if (model.openConfirm("remove")) openConfirm(openerOf("remove")); }, () => S.busy || !S.canRemove);
    setOff(reviewBtn, S.busy || !can); setOff(removeBtn, S.busy || !S.canRemove);
    replace(main, crumbs, h("div.sp-head", {}, h1, h("span", { class: `badge${m.removed ? " badge-danger" : " badge-accent"}` }, m.removed ? "Removed" : "Member")),
      h("p", {}, `${m.name}${m.email ? ` (${m.email})` : ""}.`, qualifies ? ` Each item goes to ${d.recipient.name} (${d.reason === "manager" ? "their manager" : "you, as no manager is known"}) unless you pick someone else in its row.` : " You can't hand on any of their items."),
      m.removed ? h("p", {}, `${m.name} has been removed from the organization.`) : null,
      S.blocked === "admin" ? h("p", { role: "status" }, `${m.name} is an organization admin and can't be removed here.`) : null,
      n ? [h("h2", {}, "Items"), itemsView, S.next ? h("button.btn", { type: "button", onclick: () => model.more() }, "Show more") : null,
        h("h2", {}, "Another new owner"), h("p.muted", {}, "Search for a person to offer them in every row's list."), searchBox("Find a new owner", q => model.search(q, "foundOwner"), S.foundOwner, p => model.addKnown(p), "offboard-owner", "foundOwner")]
        : !m.removed && !S.blocked ? message(`${m.name} solely owns nothing.`, "They can be removed now.") : null,
      h("div.pick-row", {}, n ? reviewBtn : null, !m.removed && !S.blocked ? removeBtn : null));
  }

  /** The confirm step: a plain list of exactly what happens. */
  function openConfirm(opener) {
    const m = S.member, remove = S.confirm === "remove";
    const hand = model.handedOver();
    const lines = remove ? [...removeLines(m.name), ...(hand ? [planLine(hand, model.recipientOf(hand))] : [])] : model.actionable().map(i => planLine(i, model.recipientOf(i)));
    const skipped = remove ? [] : S.items.filter(i => !i.can.reassign && !i.personal);
    const progress = h("p", { role: "status", "aria-live": "polite" });
    const go = h("button.btn.primary", { type: "submit" }, remove ? `Remove ${m.name}` : "Reassign");
    const cancel = h("button.btn", { type: "button", onclick: () => d.close() }, "Cancel");
    const d = openDialog({ host: root, title: remove ? `Remove ${m.name}?` : `Reassign what ${m.name} solely owns?`, opener,
      body: [h("ul", { "aria-label": remove ? "What removing does" : "What moves where" }, lines.map(t => h("li", {}, t))),
        skipped.length ? h("p", {}, `Not included, needs an organization admin: ${skipped.map(i => i.name).join(", ")}.`) : null,
        remove ? null : h("p", {}, "Items are reassigned one at a time. Boards, their addresses and guests' access stay."), progress],
      footer: [cancel, go],
      onClose: () => { if (S.confirm) model.closeConfirm(); },
      onSubmit: async () => { if (S.busy) return; (remove ? await model.remove() : await model.apply()); d.close(); } });
    dlg = d; dlg.progress = progress;
  }

  function render() {
    showNotice(status, model);
    const note = S.notice && !S.said;
    const held = captureFocus([main]);                                            // a redraw replaces every node: focus goes back to the control with the same data-fk
    speak(S, () => { draw(); });
    restoreFocus(held);
    if (dlg?.progress) dlg.progress.textContent = S.progress ?? "";
    if (!S.confirm && dlg) { dlg = null; }
    if (focusTo && S.status === "ready" && !S.confirm && !S.busy) { const k = focusTo; focusTo = null; keeper(k)?.focus?.(); }
    if (note) status.focus?.();
  }
  const unsub = model.subscribe(render);
  render();
  if (start) model.open(start);
  return { destroy() { destroyTheme(); unsub(); root.replaceChildren(); } };
}
