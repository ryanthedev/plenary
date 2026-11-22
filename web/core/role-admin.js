// The Roles screen as state with no DOM (web/adapters/dom/roles.js renders it; the data comes through web/ports/roles.js). The server decides
// every permission: which permissions a person may tick (`matrix.tickable`), which board steps (`matrix.ladders`), where a permission means
// anything (`matrix.permissions[].scopes`), and when an edit reaches many people (a 409 `confirm-required`). The model only asks, shows and
// refuses nonsense early. Copy follows design/orgs/JOURNEY.md J9.

import { errorText as baseError, NAME_MAX } from "./spaces.js";
import { CONTENT_LABEL } from "./explain.js";

/** @typedef {import("../ports/roles.js").RoleView} RoleView */

/** What each permission is called on the screen (its id is shown beside it as code). */
export const PERM_LABEL = {
  "board.view": "View boards", "board.comment": "Comment", "board.annotate": "Annotate", "board.edit": "Edit",
  "board.create": "Create boards", "space.create": "Create Spaces", "group.create": "Create Groups", "members.manage": "Manage who has access",
  move: "Move boards out", delete: "Delete and restore", transfer: "Transfer ownership", "roles.manage": "Manage roles", "team.manage": "Manage teams",
};
/** The content tier (Unit level only): who may open boards beyond their own access. Said plainly, because it is the sensitive part of a role. */
Object.assign(PERM_LABEL, CONTENT_LABEL);
export const PERM_HELP = {
  "content.shared": "Open and edit any board in any shared Space, as its owner. Not personal spaces.",
  "content.personal": "Open, move out, trash, restore and hand over boards in other people's personal spaces. Needs a reason: it reads private work.",
};
export const permLabel = id => PERM_LABEL[id] ?? id;
export const SCOPE_LABEL = { unit: "Organization", group: "Group", space: "Space", board: "Board" };
export const LADDER_LABEL = { viewer: "Viewer", commenter: "Commenter", annotator: "Annotator", editor: "Editor" };
const MSG = {
  "too-large": limit => `This organization has the most custom roles it can (${limit}). Delete one first.`,
  "in-use": () => "That role is still in use. Remove it from those places first.",
  "confirm-required": () => "This change reaches many people. Confirm it to save.",
};
/** Where a role means anything: "Organization to Board", "Board", or null (a role with no permission at any scope). */
export function rangeText(role) {
  const at = Object.keys(SCOPE_LABEL).filter(s => (role.scopes?.[s] ?? []).length > 0);
  return !at.length ? null : at.length === 1 ? SCOPE_LABEL[at[0]] : `${SCOPE_LABEL[at[0]]} to ${SCOPE_LABEL[at.at(-1)]}`;
}
/** "Used in 4 places", "Used in 100+ places", "Not used yet", or the member role's reach; null for a built-in. */
export function usedText(role) {
  const u = role.used;
  if (!u) return null;
  if ("members" in u) return `Everyone in the organization (${u.members}${u.capped ? "+" : ""} ${u.members === 1 && !u.capped ? "person" : "people"})`;
  if (u.places === 0) return "Not used yet";
  return `Used in ${u.places}${u.capped ? "+" : ""} ${u.places === 1 && !u.capped ? "place" : "places"}`;
}
/** The sentence of the many-people confirmation. `impact`: { places, people, capped }. */
export function impactText(role, impact) {
  const plus = impact.capped ? "+" : "";
  const who = `${impact.people}${plus} ${impact.people === 1 && !impact.capped ? "person" : "people"}`;
  return role.kind === "member" ? `This change reaches everyone in the organization (${who}).`
    : `This change reaches about ${who} in ${impact.places}${plus} ${impact.places === 1 && !impact.capped ? "place" : "places"}.`;
}
/** The sentence for a failed call. */
export const failText = (r, limits) => (r?.code && MSG[r.code] ? MSG[r.code](limits?.custom) : r?.error === "forbidden" ? "You can't change that role. It may give more than you hold yourself." : baseError(r?.error));

const same = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const keyer = newKey => { let key = null; return { reset() { key = null; }, get() { return newKey ? (key ??= newKey()) : null; } }; };

/**
 * @param {{ api: import("../ports/roles.js").RolesPort, newKey?: (() => string)|null }} o   `newKey`: the root's source of Idempotency-Keys (core reads no global); none = creates go without a key
 */
export function createRolesModel({ api, newKey = null }) {
  const state = { status: "loading", error: null, notice: null, busy: false, said: null, page: null, selected: null, draft: null, confirm: null };
  const S = state, subs = new Set(), kk = keyer(newKey);
  const emit = () => { for (const f of [...subs]) f(S); };
  const roleOf = id => S.page?.roles.find(r => r.id === id) ?? null;
  /** The role the detail shows: the new draft's source, or the selected one. */
  const current = () => (S.draft?.isNew ? null : roleOf(S.selected));
  const fresh = r => ({ isNew: false, id: r.id, name: r.name, ladder: r.ladder, permissions: [...r.permissions], base: r.base ?? null });
  const startDraft = r => { S.draft = r.editable ? fresh(r) : null; S.confirm = null; };
  const dirty = () => {
    const d = S.draft;
    if (!d) return false;
    if (d.isNew) return true;
    const r = roleOf(d.id);
    return !!r && (d.name !== r.name || d.ladder !== r.ladder || !same(d.permissions, r.permissions));
  };
  /** Run a write: busy, then the failure text, or `apply`. @returns {Promise<{ ok: boolean, r: object }>} */
  async function act(run, apply, said) {
    if (S.busy) return { ok: false, r: null };
    S.busy = true; S.notice = null; S.said = null; emit();
    const r = await run();
    S.busy = false;
    if (r.error) {
      if (r.error === "auth") S.status = "signed-out"; else S.notice = failText(r, S.page?.limits);
      emit();
      return { ok: false, r };
    }
    apply(r);
    if (said) S.said = typeof said === "function" ? said(r) : said;
    emit();
    return { ok: true, r };
  }
  const commit = role => {
    const i = S.page.roles.findIndex(x => x.id === role.id);
    if (i >= 0) S.page.roles[i] = role; else S.page.roles.push(role);
    // Built-ins and the member role keep the server's order; only the custom roles are sorted (by name, as the server lists them).
    const key = r => [r.name.toLowerCase(), r.id];
    const cmp = (a, b) => { const [x, y] = [key(a), key(b)]; return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : 1; };
    S.page.roles = [...S.page.roles.filter(r => r.kind !== "custom"), ...S.page.roles.filter(r => r.kind === "custom").sort(cmp)];
  };

  return {
    state, emit, subscribe(f) { subs.add(f); return () => subs.delete(f); }, dismissNotice() { S.notice = null; emit(); },
    current, dirty, roleOf,

    async load() {
      S.error = null; if (!S.page) S.status = "loading"; emit();
      const r = await api.roles();
      if (r.error) {
        if (r.error === "auth") S.status = "signed-out";
        else if (r.error === "notfound" || r.error === "forbidden") { S.status = "notfound"; S.page = null; }
        else { S.error = r.error; if (S.page) S.notice = "Could not refresh this page."; else S.status = "error"; }
      } else {
        S.page = r.page; S.status = "ready";
        if (!roleOf(S.selected)) S.selected = (r.page.roles.find(x => x.kind === "custom") ?? r.page.roles.find(x => x.kind === "member") ?? r.page.roles[0])?.id ?? null;
        const cur = roleOf(S.selected);
        if (cur && !S.draft) startDraft(cur);
      }
      emit();
    },

    /** Open a role. Unsaved edits to the one being left are dropped (and said so). */
    select(id) {
      const r = roleOf(id);
      if (!r || S.busy) return false;
      const lost = dirty();
      S.selected = id; S.notice = null; S.said = lost ? `Unsaved changes to ${S.draft?.isNew ? "the new role" : "the previous role"} were dropped` : null; kk.reset();
      startDraft(r);
      emit();
      return true;
    },

    /** Start an unsaved copy of a role (any role, built-in or custom). Only what the person may tick is carried over. */
    duplicate(id) {
      const r = roleOf(id);
      if (!r || S.busy) return false;
      const M = S.page.matrix, allowed = M.ladders;
      const ladder = allowed.includes(r.ladder) ? r.ladder : r.ladder ? allowed.at(-1) ?? "viewer" : allowed[0] ?? "viewer";   // a step the person cannot give becomes the highest they can; no step (admin, member) the lowest
      const perms = r.permissions.filter(p => M.tickable.includes(p));
      const name = `${r.name} copy`.slice(0, NAME_MAX);
      kk.reset();
      S.draft = { isNew: true, id: null, name, ladder, permissions: perms, base: id };
      S.confirm = null;
      S.said = `Copy of ${r.name} started. It is not saved yet.${perms.length < r.permissions.length ? " Permissions you do not hold were left out." : ""}`;
      emit();
      return true;
    },
    /** Typing: updates the draft only (no redraw, so the input keeps its caret); the page reads `dirty()` itself. */
    setName(v) { if (S.draft) S.draft.name = String(v ?? "").slice(0, NAME_MAX + 50); },
    setLadder(v) { if (S.draft && S.page.matrix.ladders.includes(v) && S.draft.ladder !== v) { S.draft.ladder = v; emit(); } },
    /** Tick or untick a management permission: only one the server lists as tickable, and only in a role that can be edited. */
    toggle(id) {
      const d = S.draft;
      if (!d || !S.page.matrix.tickable.includes(id) || (current()?.kind === "member" && id.startsWith("content."))) return false;   // the Unit member role carries no content tier
      d.permissions = d.permissions.includes(id) ? d.permissions.filter(p => p !== id) : [...d.permissions, id];
      emit();
      return true;
    },
    /** Drop the unsaved edits (or the unsaved copy). */
    discard() {
      const r = roleOf(S.selected);
      if (S.draft?.isNew) kk.reset();
      if (r) startDraft(r); else S.draft = null;
      S.confirm = null; S.notice = null; S.said = "Changes discarded";
      emit();
    },

    /** Save the draft: a create for a copy, else a patch of what changed. A many-people edit stops at a confirmation (`state.confirm`). */
    async save({ confirm = false } = {}) {
      const d = S.draft;
      if (!d || S.busy) return false;
      const name = d.name.trim();
      if (!name) { S.notice = "Give the role a name."; emit(); return false; }
      if (name.length > NAME_MAX) { S.notice = `Names are at most ${NAME_MAX} characters.`; emit(); return false; }
      if (d.isNew) {
        let k = null;
        try { k = kk.get(); } catch { S.notice = "Could not start that. Reload the page and try again."; emit(); return false; }
        const { ok } = await act(() => api.createRole({ name, ...(d.base ? { base: d.base } : {}), boardRole: d.ladder, permissions: d.permissions, ...(k ? { key: k } : {}) }),
          r => { kk.reset(); commit(r.role); S.selected = r.role.id; startDraft(r.role); }, r => `Created role ${r.role.name}`);
        return ok;
      }
      const r0 = roleOf(d.id);
      if (!r0) return false;
      const patch = {};
      if (r0.kind !== "member" && name !== r0.name) patch.name = name;
      if (r0.kind !== "member" && d.ladder !== r0.ladder) patch.boardRole = d.ladder;
      if (!same(d.permissions, r0.permissions)) patch.permissions = d.permissions;
      if (!Object.keys(patch).length) { S.said = "Nothing to save"; emit(); return true; }
      const { ok, r } = await act(() => api.updateRole(d.id, { ...patch, ...(confirm ? { confirm: true } : {}) }),
        res => { S.confirm = null; commit(res.role); startDraft(res.role); }, res => `Saved ${res.role.name}`);
      if (!ok && r?.code === "confirm-required") { S.confirm = { impact: r.impact }; S.notice = null; emit(); }
      return ok;
    },
    async confirmSave() { return this.save({ confirm: true }); },
    cancelConfirm() { S.confirm = null; emit(); },

    /** Delete the selected custom role. The server refuses while anything holds it: the count comes back in the sentence. */
    async remove() {
      const r = current();
      if (!r || r.kind !== "custom") return false;
      const { ok, r: res } = await act(() => api.removeRole(r.id), () => {
        const i = S.page.roles.findIndex(x => x.id === r.id);
        S.page.roles = S.page.roles.filter(x => x.id !== r.id);
        const next = S.page.roles[Math.min(i, S.page.roles.length - 1)];
        S.selected = next?.id ?? null; S.draft = null; S.confirm = null;
        if (next) startDraft(next);
      }, `Deleted role ${r.name}`);
      if (!ok && res?.code === "in-use") { S.notice = `${r.name} is used in ${res.used.places}${res.used.capped ? "+" : ""} ${res.used.places === 1 && !res.used.capped ? "place" : "places"}. Remove it from those places first.`; emit(); }
      return ok;
    },

    /** The matrix rows for what is on screen (the draft when there is one, else the role): where each permission is held, from the server's scopes. */
    rows() {
      const M = S.page?.matrix;
      const d = S.draft, r = current();
      const src = d ?? r;
      if (!M || !src) return [];
      const editable = !!d;
      return M.permissions.map(p => {
        const ticked = p.group === "content" ? !!M.content[src.ladder]?.includes(p.id) : src.permissions.includes(p.id);
        return {
          id: p.id, group: p.group, label: permLabel(p.id), ...(PERM_HELP[p.id] ? { help: PERM_HELP[p.id] } : {}), ticked,
          tickable: p.group !== "content" && editable && M.tickable.includes(p.id) && !(r?.kind === "member" && p.group === "content-tier"),
          ...(p.group === "content-tier" && editable && !(M.tickable.includes(p.id) && r?.kind !== "member") ? { reason: r?.kind === "member" ? "The Unit member role never carries this." : "Only someone who holds this can grant it." } : {}),
          cells: M.scopes.map(s => ({ scope: s, state: !p.scopes.includes(s) ? "na" : ticked ? "yes" : "no" })),
        };
      });
    },
  };
}
