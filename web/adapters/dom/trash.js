// Trash over the DOM, rendering web/core/trash.js's models: the Trash page (a list with a Restore button per row) and the "This board is in Trash" notice a board's URL shows once the board has refused the visit.
// Rules this file keeps: names and titles are other people's words (textContent only); every control is a real button or link (keyboard); a Restore button names its row
// ("Restore Roadmap") so a screen reader reads it in a list; outcomes go through the page's polite live region (`announce`), never colour alone; focus is placed on purpose (the next row
// after a restore, the heading when the notice appears).

import { h, replace } from "./dom.js";
import { announce } from "./focus.js";
import { shell, message } from "./spaces.js";
import { daysText, fromText, groupText, EMPTY } from "../../core/trash.js";

const NOTES = { forbidden: "You can't see the Trash.", "signed-out": "You are signed out. Sign in again to see the Trash." };

/**
 * The Trash page: what the person may restore, where each board was, who deleted it and how many days are left.
 * @param {{ root: HTMLElement, model: ReturnType<typeof import("../../core/trash.js").createTrashModel>, hrefs: { home: string }, signIn?: { href: string, text?: string }|null }} o
 * @returns {{ destroy(): void }}
 */
export function mountTrashPage({ root, model, hrefs, signIn = null }) {
  const S = model.state;
  const { status, main } = shell(root, hrefs);
  let h1 = null, after = null;
  const buttons = new Map();
  const row = item => {
    const board = item.type === "board", title = board ? item.title || "Untitled" : item.name;
    const where = board ? fromText(item.from) : [groupText(item.group), item.boards ? `${item.boards} board${item.boards === 1 ? "" : "s"} went with it` : "no boards in it"].filter(Boolean).join(" · ");
    const btn = h("button.btn", { type: "button", "aria-label": `Restore ${board ? "" : "Space "}${title}`, "aria-disabled": S.busy === item.id ? "true" : null, "data-fk": `restore:${item.id}`,
      onclick: e => { if (e.currentTarget.getAttribute("aria-disabled") === "true") { e.preventDefault?.(); return; } model.restore(item); } }, S.busy === item.id ? "Restoring…" : "Restore");
    buttons.set(item.id, btn);
    return h("li.card.trash-row", {},
      h("div.card-open", {}, h("span.t", {}, board ? title : [title, " ", h("span.badge", {}, "Space")]), h("span.p", {}, board ? `Was in ${where}` : where || "A Space"),
        h("span.p", {}, `${item.by ? `Deleted by ${item.by.name}` : "Deleted"} · ${daysText(item.daysLeft)}`)),
      h("span.card-menu", {}, btn));
  };
  function render() {
    status.textContent = S.notice ?? ""; status.hidden = !S.notice;
    buttons.clear();
    if (S.status === "loading") return replace(main, h("p.muted", {}, "Loading…"));
    if (S.status === "error") return replace(main, message("Could not load the Trash.", "The server did not answer. Check your connection and try again."), h("button.btn", { type: "button", onclick: () => model.load() }, "Try again"));
    if (S.status === "signed-out") return replace(main, message("You are signed out.", NOTES["signed-out"]), signIn ? h("a.btn.primary", { href: signIn.href }, signIn.text ?? "Sign in") : null);
    if (S.status === "forbidden") return replace(main, message("The Trash is not available.", NOTES.forbidden), h("a.btn", { href: hrefs.home }, "Back to Home"));
    h1 = h("h1", { id: "page-title", tabindex: "-1" }, "Trash");
    replace(main, h("nav.crumbs", { "aria-label": "Breadcrumb" }, h("a", { href: hrefs.home }, "Home"), " /"), h("div.sp-head", {}, h1),
      h("p.sub-h", {}, "Boards stay here for 30 days. Restore brings back its access, invites and links."),
      S.items.length ? h("ul.cards", { "aria-label": "Trash" }, S.items.map(row)) : message(EMPTY.title, EMPTY.detail),
      S.more ? h("p.muted", {}, "More items are in the Trash than are listed here.") : null);
    if (after) { const f = after; after = null; f(); }
  }
  const unsub = model.subscribe(() => {
    const was = S.said;
    if (S.said) { announce(S.said); S.said = null; }
    if (S.notice && was === S.notice) status.focus?.();
    if (was && !S.notice) after = () => { const n = S.next; ((n && buttons.get(n.id)) ?? h1)?.focus?.(); };
    render();
  });
  render();
  return { destroy() { unsub(); root.replaceChildren(); } };
}

/**
 * The notice a board's URL shows when the board is in Trash: "This board is in Trash", when it will be deleted, who deleted it and where it was (for those who may restore), and Restore for them.
 * It covers the page like the sign-in gate, takes focus on its heading, and says itself once.
 * @param {{ host: HTMLElement, model: ReturnType<typeof import("../../core/trash.js").createNoticeModel>, homeHref: string, onRestored?(): void }} o
 * @returns {{ destroy(): void, el: HTMLElement }}
 */
export function mountTrashNotice({ host, model, homeHref, onRestored = () => {} }) {
  const S = model.state;
  const el = h("div.signin-gate.trash-gate", { id: "trash-gate", role: "region", "aria-label": "Board in Trash" });
  let shown = false, h1 = null;
  function render() {
    if (S.status !== "ready" && S.status !== "restored") { el.remove(); shown = false; return; }
    const n = S.notice;
    const viaSpace = n.via && n.via.space && n.via.canRestore ? n.via.space : null;
    const can = n.canRestore || !!viaSpace;
    h1 = h("h1", { tabindex: "-1" }, S.status === "restored" ? "Board restored" : "This board is in Trash");
    const lines = [];
    if (S.status === "restored") lines.push(h("p", {}, S.message));
    else {
      lines.push(h("p", {}, `${n.board.title || "Untitled"}: ${daysText(n.daysLeft)} before it is deleted for good.`));
      if (n.by) lines.push(h("p", {}, `Deleted by ${n.by.name}${n.from ? ` from ${fromText(n.from)}` : ""}.`));
      if (n.via) lines.push(h("p", {}, n.via.space ? `It went to Trash with its Space, ${n.via.space.name}.` : "It went to Trash with its Space."));
      if (!can) lines.push(h("p", {}, "Ask someone who can restore it. Its access, invites and links come back with it."));
      else if (n.into && !viaSpace) lines.push(h("p", {}, `Its Space is in Trash too, so Restore puts it in your personal space. Its access, invites and links come back with it.`));
      else lines.push(h("p", {}, viaSpace && !n.canRestore ? `Restoring brings back ${viaSpace.name} and its boards, with their access, invites and links.` : "Restoring brings back its access, invites and links."));
    }
    const acts = S.status === "restored"
      ? [h("button.btn.primary", { type: "button", onclick: () => onRestored() }, "Open the board")]
      : [can ? h("button.btn.primary", { type: "button", "aria-disabled": S.busy ? "true" : null, onclick: e => { if (e.currentTarget.getAttribute("aria-disabled") !== "true") model.restore(); } }, S.busy ? "Restoring…" : viaSpace && !n.canRestore ? `Restore ${viaSpace.name}` : "Restore") : null,
        h("a.btn", { href: homeHref }, "Back to Home")];
    const box = h("div", {}, h1, ...lines, S.message && S.status !== "restored" ? h("p", { role: "alert" }, S.message) : null, h("div.gate-links", {}, ...acts.filter(Boolean)));
    el.replaceChildren(box);
    if (!el.parentNode) host.append(el);
    if (!shown) { shown = true; h1.focus?.(); announce(`${h1.textContent}. ${lines[0].textContent}`); }
    else if (S.status === "restored") { h1.focus?.(); announce(S.message); }
  }
  model.subscribe(render);
  return { el, destroy() { el.remove(); } };
}
