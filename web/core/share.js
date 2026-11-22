// The Share dialog as state with no DOM (web/adapters/dom/share.js renders it; the data comes through web/ports/share.js and web/ports/access.js).
// The server decides everything: who may open it (`members.manage`: a 403 here is the whole answer), which roles an invite or link may take (`limits`), who is a guest
// (`invite.guest`). The model words it, keeps one Idempotency-Key per submit (reused by its retries), and refuses nonsense early. Copy follows design/orgs/JOURNEY.md J6.
// "Who else has access" is the access page's own rows (one source of truth, PROTOCOL.md § Share dialog); it is read-only here.

import { errorText } from "./spaces.js";
import { viaText, SCOPE_NOUN } from "./access.js";

const DAY = 86_400_000;
/** Expiry choices, [label, days|null]. The first marked default is what the dialog starts on (an invite: 30 days, JOURNEY J6; a link: 7 days). */
export const INVITE_EXPIRY = Object.freeze([["7 days", 7], ["30 days", 30], ["90 days", 90], ["Never", null]]);
export const LINK_EXPIRY = Object.freeze([["1 day", 1], ["7 days", 7], ["30 days", 30], ["Never", null]]);
export const ROLE_NAMES = Object.freeze({ viewer: "Viewer", commenter: "Commenter", annotator: "Annotator", editor: "Editor" });
export const roleName = r => ROLE_NAMES[r] ?? r;

/** The address as the server will compare it (trimmed, lower-cased), or null when it is not an address. */
export const emailOf = v => { const e = typeof v === "string" ? v.trim().toLowerCase() : ""; return e.length <= 320 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null; };
/** Is the address outside the Unit (none of its domains)? null for a half-typed address, or when the caller is outside the Unit (no domain list is sent to them; the server tags each invite). */
export const guestOf = (v, domains) => { const e = emailOf(v); return e && domains ? !domains.some(d => e.endsWith("@" + d)) : null; };
/** "expires in 12 days", "expires today", "never expires". */
export function expiryText(at, now) {
  if (at == null) return "never expires";
  const d = Math.ceil((at - now) / DAY);
  return d <= 0 ? "expires today" : d === 1 ? "expires in 1 day" : `expires in ${d} days`;
}

const MSG = { forbidden: "You can't manage sharing for this board. Ask one of its owners.", invalid: "The server did not accept that. Check the address and the role." };
const failText = r => MSG[r?.error] ?? errorText(r?.error);
const MAYBE = " It may have been created. Trying again unchanged is safe.";
const failCreate = r => (r?.error === "unavailable" ? "The server did not answer in time." + MAYBE : r?.error === "network" ? "No answer from the server." + MAYBE : failText(r));

/**
 * @param {{ share: import("../ports/share.js").SharePort, access?: import("../ports/access.js").AccessPort|null, board: string, urls: { board: string, link(id: string): string }, now?: () => number, newKey?: (() => string)|null }} o
 */
export function createShareModel({ share, access = null, board, urls, now, newKey = null }) {
  const S = {
    status: "loading",            // loading | ready | forbidden | notfound | signed-out | error
    view: null, page: null, pageStatus: "none",   // pageStatus: ok | unavailable (the access page: not for a guest)
    form: { email: "", role: "viewer", inviteDays: 30, linkRole: "viewer", linkDays: 7 },
    busy: false, notice: null, said: null, sent: null,
  };
  const subs = new Set();
  const emit = () => { for (const f of [...subs]) f(S); };
  // One submit = one key AND one body: the server fingerprints the whole body, so a retry after a lost answer must resend the very same `expiresAt` (computed once, here),
  // or it is refused as a reused key. A changed form (another signature) starts over; a success forgets.
  let frozen = null;      // { sig, key, body }
  const freeze = (sig, makeBody) => {
    if (frozen?.sig !== sig) { let key = null; try { key = newKey ? newKey() : null; } catch { key = null; } frozen = { sig, key, body: makeBody() }; }
    return frozen;
  };
  const forget = () => { frozen = null; };
  const expiryOf = days => (days == null ? null : now() + days * DAY);
  const domains = () => S.view?.unit?.domains ?? null;
  const defaultDays = () => Math.round((S.view?.limits.inviteTtlMs ?? 30 * DAY) / DAY);

  /** Run a write once at a time: busy, the failure text, and the sentence for screen readers. @returns {Promise<boolean>} */
  async function act(run, apply, said, failed = failText) {
    if (S.busy) return false;
    S.busy = true; S.notice = null; S.said = null; emit();
    const r = await run();
    S.busy = false;
    if (r.error) {
      if (r.error === "auth") S.status = "signed-out"; else S.notice = failed(r);
      S.said = S.notice; emit();
      return false;
    }
    apply(r);
    S.said = typeof said === "function" ? said(r) : said;
    emit();
    return true;
  }

  return {
    state: S,
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
    domains,
    guestOf: () => guestOf(S.form.email, domains()),
    set(field, value) { S.form[field] = value; emit(); },

    async load() {
      const [v, a] = await Promise.all([share.view(board), access ? access.access("board", board) : Promise.resolve({ error: "notfound" })]);
      if (v.error) { S.status = v.error === "auth" ? "signed-out" : v.error === "forbidden" ? "forbidden" : v.error === "notfound" ? "notfound" : "error"; S.notice = S.status === "error" ? failText(v) : null; emit(); return; }
      S.view = v.view; S.status = "ready";
      S.page = a.page ?? null; S.pageStatus = a.page ? "ok" : "unavailable";
      if (INVITE_EXPIRY.some(([, d]) => d === defaultDays())) S.form.inviteDays = defaultDays();   // the server's own default life (limits.inviteTtlMs)
      if (!S.view.limits.inviteRoles.includes(S.form.role)) S.form.role = S.view.limits.inviteRoles[0] ?? "viewer";
      if (!S.view.limits.linkRoles.includes(S.form.linkRole)) S.form.linkRole = S.view.limits.linkRoles[0] ?? "viewer";
      emit();
    },

    /** Invite by email: role and expiry. @returns {Promise<boolean>} */
    async invite() {
      const email = emailOf(S.form.email);
      if (!email) { S.notice = "Enter a full email address, like kim@partner.io."; S.said = S.notice; emit(); return false; }
      const { role, inviteDays } = S.form;
      if (!S.view.limits.inviteRoles.includes(role)) { S.notice = "You can't give that role here."; S.said = S.notice; emit(); return false; }   // the server would refuse it: say so without a round trip
      const f = freeze(JSON.stringify(["i", email, role, inviteDays]), () => ({ email, role, ...(inviteDays === defaultDays() ? {} : { expiresAt: expiryOf(inviteDays) }) }));   // the server's default life is omitted, so the server's clock sets it
      return act(() => share.invite(board, f.body, f.key),
        r => { forget(); S.view.invites = [r.invite, ...S.view.invites.filter(i => i.id !== r.invite.id)]; S.sent = { email, guest: r.invite.guest, role }; S.form.email = ""; },
        r => `Invite created for ${email}${r.invite.guest ? ", a guest" : ""}. They get ${roleName(role)} on this board. Copy the board address and send it to them.`, failCreate);
    },

    /** A share link with the chosen role and expiry. */
    async makeLink() {
      const { linkRole, linkDays } = S.form;
      if (!S.view.limits.linkRoles.includes(linkRole)) { S.notice = "You can't give that role here."; S.said = S.notice; emit(); return false; }
      const f = freeze(JSON.stringify(["l", linkRole, linkDays]), () => ({ role: linkRole, expiresAt: expiryOf(linkDays) }));
      return act(() => share.link(board, f.body, f.key),
        r => { forget(); S.view.links = [r.link, ...S.view.links.filter(l => l.id !== r.link.id)]; },
        () => `Link created. Anyone with it who signs in gets ${roleName(linkRole)} on this board. Copy it from the list.`, failCreate);
    },

    revokeInvite(id) {
      const i = S.view?.invites.find(x => x.id === id);
      return act(() => share.revokeInvite(board, id), () => { S.view.invites = S.view.invites.filter(x => x.id !== id); if (S.sent?.email === i?.email) S.sent = null; },
        `Invite for ${i?.email ?? "that person"} revoked. Their access ends within about a minute.`);
    },
    revokeLink(id) {
      return act(() => share.revokeLink(board, id), () => { S.view.links = S.view.links.filter(x => x.id !== id); },
        "Link revoked. Anyone using it loses access within about a minute.");
    },

    boardUrl: () => urls.board,
    /** The address to copy: always the page's own origin (what this browser reached; the server's PUBLIC_URL default may be another name), never the server's `url`. */
    linkUrl: l => urls.link(l.id),
    /** The read-only rows: [{ group, name, role, from }]: people added on this board, then what comes from above and from the organization. Names are other people's words: text only. */
    accessRows() {
      const p = S.page;
      if (!p) return [];
      const out = [];
      for (const r of p.rows) out.push({ group: "board", name: r.subject.name || r.subject.id, role: r.roleName || r.role, from: viaText(r) });
      for (const r of p.inherited) out.push({ group: "inherited", name: r.subject.name || r.subject.id, role: r.roleName || r.role, from: viaText(r) });
      for (const g of p.general) out.push({ group: "inherited", name: "Everyone in the organization", role: g.role[0].toUpperCase() + g.role.slice(1), from: `via ${SCOPE_NOUN[g.scope.type] ?? g.scope.type}${g.scope.name ? " " + g.scope.name : ""}` });
      if (p.organization?.admins.length) out.push({ group: "inherited", name: p.organization.admins.map(a => a.name || a.user).join(", ") + (p.organization.more ? " and more" : ""), role: "Admin", from: "organization admins manage access, not content" });
      return out;
    },
  };
}
