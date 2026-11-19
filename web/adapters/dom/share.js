// The Share dialog over the DOM, rendering web/core/share.js's model: invite by email (guests tagged), link access, the read-only "who else has access" rows, and revoke.
//
// Rules this file keeps: a real modal (openDialog: role="dialog", aria-modal, labelled by its heading, focus moves in, Tab stays inside, Escape closes, focus returns to
// the opener); names, emails and titles are other people's words (textContent only); every control has a label; the guest tag is visible text tied to the email field
// (aria-describedby); every outcome is visible in the status line AND said in the polite live region, and focus moves to that line after a change (the control that was
// used may be gone); nothing is only a hover title; one column that works at 390 px. The link address is a capability: it is shown only here, to a manager.

import { h, replace } from "./dom.js";
import { announce } from "./focus.js";
import { openDialog } from "./dialogs.js";
import { INVITE_EXPIRY, LINK_EXPIRY, roleName, expiryText } from "../../core/share.js";
import { HIDDEN_ABOVE } from "../../core/access.js";

let seq = 0;
const NOTES = {
  forbidden: "Only people who manage who has access to this board can share it. Ask one of its owners.",
  notfound: "This board is not available to you.", "signed-out": "You are signed out. Sign in again to share this board.",
};

/** Copy text to the clipboard; false when the browser refuses (the caller then selects it for the person). */
async function copyToClipboard(text) {
  try { await globalThis.navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/**
 * @param {{ host: HTMLElement, model: ReturnType<typeof import("../../core/share.js").createShareModel>, opener?: { focus?: () => void }|null, accessHref?: string|null, copy?: (text: string) => Promise<boolean>, now?: () => number }} o
 */
export function openShare({ host, model, opener = null, accessHref = null, copy = copyToClipboard, now = Date.now }) {
  const S = model.state, id = ++seq;
  // One announcement: the text is visible here and said once through the page's live region (announce); this line is not itself a live region, so it is not read twice.
  const status = h("p.share-status", { tabindex: "-1", "data-fk": "share-status" });
  const email = h("input.field", { type: "email", "aria-label": "Email address", "aria-describedby": `share-guest-${id}`, autocomplete: "off", maxlength: "320", placeholder: "name@company.com", "data-fk": "share-email",
    oninput: e => model.set("email", e.target.value) });
  const guest = h("p.from", { id: `share-guest-${id}` });
  const roleSel = h("select.field", { "aria-label": "Role for the invite", onchange: e => model.set("role", e.target.value) });
  const daysSel = h("select.field", { "aria-label": "Invite expires", onchange: e => model.set("inviteDays", e.target.value === "never" ? null : Number(e.target.value)) },
    INVITE_EXPIRY.map(([label, d]) => h("option", { value: d ?? "never", selected: d === S.form.inviteDays }, label)));
  const inviteBtn = h("button.btn.primary", { type: "submit", "data-fk": "share-invite" }, "Invite");
  const sent = h("div.share-sent", { hidden: true });
  const invites = h("ul.rows", { "aria-label": "Invites" });
  const linkRole = h("select.field", { "aria-label": "Role for the link", onchange: e => model.set("linkRole", e.target.value) });
  const linkDays = h("select.field", { "aria-label": "Link expires", onchange: e => model.set("linkDays", e.target.value === "never" ? null : Number(e.target.value)) },
    LINK_EXPIRY.map(([label, d]) => h("option", { value: d ?? "never", selected: d === S.form.linkDays }, label)));
  const linkBtn = h("button.btn", { type: "button", "data-fk": "share-link", onclick: async () => { if (await model.makeLink()) status.focus?.(); } }, "Create link");
  const links = h("ul.rows", { "aria-label": "Share links" });
  const onBoard = h("ul.rows", { "aria-label": "People added to this board" });
  const inherited = h("ul.rows", { "aria-label": "Who else has access" });
  const accessNote = h("p.from", {});
  const boardHead = h("h3", {}, "On this board"), inheritedHead = h("h3", {}, "Who else has access · inherited");
  const boardLine = h("p.muted", { "aria-label": "Board" });
  const content = h("div.share-body", {}, boardLine,
    h("div.l", {}, h("h3", {}, "Invite people"),
      h("div.row", {}, email, roleSel, daysSel, inviteBtn), guest, sent, invites),
    h("div.l", {}, h("h3", {}, "Link access"), h("p.from", {}, "Anyone with the link signs in with Google first, then gets this role on this board only."),
      h("div.row", {}, linkRole, linkDays, linkBtn), links),
    h("div.l", {}, boardHead, onBoard, inheritedHead, inherited, accessNote));
  const note = h("p", {}, "Loading…");
  const slot = h("div", {});                       // the form joins the dialog only once the server has said this person may share (so Tab never meets an unreachable control)
  const done = h("button.btn.primary", { type: "button", onclick: () => d.close() }, "Done");
  const d = openDialog({ host, title: "Share this board", opener, onSubmit: async () => { if (await model.invite()) status.focus?.(); else if (S.notice) email.focus?.(); },
    body: [note, status, slot], footer: [done] });
  done.focus?.();                                  // while loading the Done button is the only control: focus is inside the dialog from the first moment
  let built = false;

  const option = (value, label, selected) => h("option", { value, selected }, label);
  const li = (label, ...kids) => h("li.row", { "aria-label": label }, ...kids);
  const copyRow = (what, text) => {
    const box = h("input.field.share-url", { type: "text", readonly: true, value: text, "aria-label": `${what} address`, onfocus: e => e.target.select?.() });
    const b = h("button.btn", { type: "button", onclick: async () => { const ok = await copy(text); if (!ok) box.select?.(); status.textContent = ok ? `${what} address copied.` : `Could not copy. The ${what.toLowerCase()} address is selected: copy it yourself.`; announce(status.textContent); } }, `Copy ${what.toLowerCase()}`);
    return [box, b];
  };

  function paint() {
    if (S.status !== "ready") {
      replace(slot); note.hidden = false;
      note.textContent = S.status === "loading" ? "Loading…" : NOTES[S.status] ?? S.notice ?? "Could not load sharing for this board. Close this and try again.";
      if (S.status !== "loading" && !S.said) announce(note.textContent);
      return;
    }
    const V = S.view;
    note.hidden = true; if (!content.parentNode) slot.append(content);
    if (!built) {
      built = true;
      boardLine.textContent = V.board.title || "Untitled board";
      const at = globalThis.document?.activeElement;
      if (!at || at === done || !d.dialog.contains?.(at)) queueMicrotask(() => email.focus?.());   // focus was parked on Done while loading: the first field is where the person starts
      replace(roleSel, V.limits.inviteRoles.map(r => option(r, roleName(r), r === S.form.role)));
      replace(linkRole, V.limits.linkRoles.map(r => option(r, roleName(r), r === S.form.linkRole)));
    }
    const g = model.guestOf();
    guest.textContent = g === true ? "Guest · outside your organization. Guests can be given up to Editor on this board only; they sign in with that Google account."
      : g === false ? "In your organization." : `Invites expire after the time you pick. Nothing is emailed: after you invite, copy the board address and send it yourself.`;
    guest.className = "from" + (g === true ? " guest" : "");
    const none = !V.limits.inviteRoles.length;     // a role with no board content (members.manage only) may give none: nothing to offer
    inviteBtn.setAttribute("aria-disabled", S.busy || none ? "true" : "false");
    if (none) guest.textContent = "Your role gives no board access of its own, so you cannot invite people or make links here.";
    linkBtn.setAttribute("aria-disabled", S.busy || !V.limits.linkRoles.length ? "true" : "false");

    if (S.sent) {
      sent.hidden = false;
      replace(sent, h("p", {}, `Send ${S.sent.email} this address${S.sent.guest ? " (a guest: they sign in with that Google account)" : ""}. Nothing is emailed.`), ...copyRow("Board", model.boardUrl()));
    } else { sent.hidden = true; replace(sent); }

    replace(invites, V.invites.map(i => li(`Invite for ${i.email}`,
      h("span.who", {}, i.email, i.guest ? h("span.badge.guest", {}, "Guest") : null), h("span.from", {}, ` ${roleName(i.role)} · invite pending · ${expiryText(i.expiresAt, now())}`),
      h("button.btn.ghost", { type: "button", "aria-label": `Revoke invite for ${i.email}`, "aria-disabled": S.busy ? "true" : "false", onclick: async () => { if (!S.busy && await model.revokeInvite(i.id)) status.focus?.(); } }, "Revoke"))));
    if (!V.invites.length) replace(invites, h("li.muted", {}, "No pending invites."));
    replace(links, V.links.map(l => li(`${roleName(l.role)} link`,
      h("span.who", {}, `${roleName(l.role)} link`), h("span.from", {}, ` ${expiryText(l.expiresAt, now())}`), ...copyRow("Link", model.linkUrl(l)),
      h("button.btn.ghost", { type: "button", "aria-label": `Revoke ${roleName(l.role)} link, ${expiryText(l.expiresAt, now())}`, "aria-disabled": S.busy ? "true" : "false", onclick: async () => { if (!S.busy && await model.revokeLink(l.id)) status.focus?.(); } }, "Revoke"))));
    if (!V.links.length) replace(links, h("li.muted", {}, "No share links. Nobody is using one."));
    const rows = model.accessRows(), part = k => rows.filter(r => r.group === k);
    const row = r => li(`${r.name}, ${r.role}, ${r.from}`, h("span.who", {}, r.name), h("span.from", {}, ` ${r.role} · ${r.from}`));
    replace(onBoard, part("board").map(row)); replace(inherited, part("inherited").map(row));
    boardHead.hidden = onBoard.childNodes.length === 0; inheritedHead.hidden = inherited.childNodes.length === 0;
    accessNote.replaceChildren(...(S.pageStatus === "ok"
      ? [accessHref ? h("a", { href: accessHref }, "Change who has access on the Access page") : "Change who has access on the Access page", " (people and teams are managed there)."]
      : ["The list of everyone with access is not available to you, because you are outside this organization. Invites and links above still work."]));
    if (S.page?.hiddenAbove) accessNote.append(" ", HIDDEN_ABOVE);
    if (V.more) accessNote.append(" Only the newest 200 invites and links are listed.");
  }

  model.subscribe(() => {
    paint();
    if (S.busy) { status.textContent = "Working…"; return; }
    if (S.said) { status.textContent = S.said; announce(S.said); S.said = null; }
  });
  paint();
  model.load();
  return d;
}
