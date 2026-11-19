// Teams, the access page of a scope and the people/Team picker, as state with no DOM (web/adapters/dom/access.js renders them; the data comes
// through web/ports/access.js). The server decides every permission (`can.*`, the `roles` it lists): the models only ask, show and refuse
// nonsense early. Copy follows design/orgs/JOURNEY.md (J4, J9, J10).

import { errorText as baseError, NAME_MAX } from "./spaces.js";

/** @typedef {import("../ports/access.js").AccessPort} AccessPort */

const MSG = {
  "last-owner": "It must keep at least one owner. Make someone else an owner first.",
  "too-large": "This team has access in too many places to delete at once. Remove some of its access first.",
  "unknown-person": "That person has not signed in to Plenary yet, so they cannot be added.",
  "bad-role": "That role does not apply here.",
};
/** The sentence for a failed call `{ error, code? }`. */
export const failText = r => MSG[r?.code] ?? baseError(r?.error);

/** "Team of 12", "1000+ members": a Team's size as the list shows it (1001 = more than 1000). */
export const sizeText = n => (n > 1000 ? "1000+ members" : n === 1 ? "1 member" : `${n} members`);
/** What a scope is called in sentences. */
export const SCOPE_NOUN = { unit: "organization", group: "Group", space: "Space", board: "board" };
/** A grant row's "from where" line (JOURNEY J10: name · role · from where). */
export const viaText = row => (row.via === "team" ? "Team" : row.via === "inherited" ? `via ${SCOPE_NOUN[row.scope?.type] ?? "container"} ${row.scope?.name ?? ""}`.trim() : "Added directly");
/** The general-access lines of an access page, e.g. "Everyone in the organization can view (Space Design)". */
export const generalLine = g => `Everyone in the organization: ${g.role} (${SCOPE_NOUN[g.scope.type] ?? g.scope.type}${g.scope.name ? " " + g.scope.name : ""})`;

function base(extra = {}) {
  const state = { status: "loading", error: null, notice: null, busy: false, ...extra };
  const subs = new Set();
  const emit = () => { for (const f of [...subs]) f(state); };
  return { state, emit, subscribe(f) { subs.add(f); return () => subs.delete(f); }, dismissNotice() { state.notice = null; emit(); } };
}
/** A failure of a load: signed out, not found, or an error that keeps what is shown. */
function loadFailed(state, r) {
  if (r.error === "auth") { state.status = "signed-out"; return; }
  if (r.error === "notfound" || r.error === "forbidden") { state.status = "notfound"; state.page = null; return; }
  state.error = r.error;
  if (state.page || state.teams) state.notice = "Could not refresh this page."; else state.status = "error";
}

/**
 * Run a write: marks busy, shows the failure text, refreshes on request. `said` (the sentence for screen readers) lands in `state.said`.
 * @returns {Promise<boolean>}
 */
async function act(m, run, apply, said) {
  const S = m.state;
  if (S.busy) return false;
  S.busy = true; S.notice = null; S.said = null; m.emit();
  const r = await run();
  S.busy = false;
  if (r.error) {
    if (r.error === "auth") S.status = "signed-out"; else S.notice = failText(r);
    m.emit();
    return false;
  }
  apply?.(r);
  if (said) S.said = typeof said === "function" ? said(r) : said;
  m.emit();
  return true;
}

/** The Teams list: paged, searchable, with Create when `can.create`. @param {{ api: AccessPort }} o */
export function createTeamsModel({ api }) {
  const m = base({ teams: null, next: null, can: { create: false }, q: "", said: null });
  const S = m.state;
  let seq = 0;
  const fetchPage = async (after) => api.teams({ after, q: S.q || null });
  return {
    ...m,
    async load(q = S.q) {
      const mine = ++seq;
      S.q = String(q ?? "").trim(); S.error = null; if (!S.teams) S.status = "loading"; m.emit();
      const r = await fetchPage(null);
      if (mine !== seq) return;
      if (r.error) loadFailed(S, r);
      else { S.teams = r.teams; S.next = r.next; S.can = r.can; S.status = "ready"; }
      m.emit();
    },
    async loadMore() {
      if (!S.next || S.busy) return false;
      return act(m, () => fetchPage(S.next), r => { S.teams = [...S.teams, ...r.teams]; S.next = r.next; }, r => `${r.teams.length} more teams`);
    },
    /** @returns {Promise<{ id: string }|null>} the new Team */
    async create(name) {
      const n = String(name ?? "").trim();
      if (!n) { S.notice = "Give the team a name."; m.emit(); return null; }
      if (n.length > NAME_MAX) { S.notice = `Names are at most ${NAME_MAX} characters.`; m.emit(); return null; }
      let made = null;
      const ok = await act(m, () => api.createTeam(n), r => { made = r.team; S.teams = [r.team, ...(S.teams ?? [])]; }, r => `Created team ${r.team.name}`);
      return ok ? made : null;
    },
  };
}

/** One Team: its members (paged), rename, add and remove members, delete. @param {{ api: AccessPort, id: string }} o */
export function createTeamModel({ api, id }) {
  const m = base({ page: null, said: null, deleted: false });
  const S = m.state;
  return {
    ...m, id,
    async load() {
      S.error = null; if (!S.page) S.status = "loading"; m.emit();
      const r = await api.team(id);
      if (r.error) loadFailed(S, r); else { S.page = r.page; S.status = "ready"; }
      m.emit();
    },
    async loadMore() {
      if (!S.page?.next || S.busy) return false;
      return act(m, () => api.team(id, S.page.next), r => { S.page = { ...S.page, members: [...S.page.members, ...r.page.members], next: r.page.next, team: r.page.team }; }, r => `${r.page.members.length} more members`);
    },
    async rename(name) {
      const n = String(name ?? "").trim();
      if (!n || n.length > NAME_MAX) { S.notice = n ? `Names are at most ${NAME_MAX} characters.` : "A name can't be empty."; m.emit(); return false; }
      if (n === S.page.team.name) return true;
      return act(m, () => api.renameTeam(id, n), r => { S.page.team = { ...S.page.team, name: r.team.name }; }, r => `Renamed to ${r.team.name}`);
    },
    /** @param {{ user: string, name: string }} person */
    async addMember(person) {
      if (S.page.members.some(x => x.user === person.user)) { S.said = `${person.name} is already in this team`; m.emit(); return true; }
      return act(m, () => api.setMember(id, person.user, true), () => {
        S.page.members = [...S.page.members, { user: person.user, name: person.name, email: person.email ?? null }].sort((a, b) => (a.user < b.user ? -1 : 1));
        S.page.team = { ...S.page.team, size: S.page.team.size + 1 };
      }, `Added ${person.name} to ${S.page.team.name}`);
    },
    async removeMember(user) {
      const who = S.page.members.find(x => x.user === user);
      if (!who) return true;
      return act(m, () => api.setMember(id, user, false), () => {
        S.page.members = S.page.members.filter(x => x.user !== user);
        S.page.team = { ...S.page.team, size: Math.max(0, S.page.team.size - 1) };
      }, `Removed ${who.name} from ${S.page.team.name}`);
    },
    async remove() { return act(m, () => api.deleteTeam(id), () => { S.deleted = true; }, "Team deleted"); },
  };
}

/**
 * The access page of one scope. `rows` are what is set HERE; `inherited` and `general` are read-only context. Adds and changes go through the one
 * picker (`roles` lists only what the server says the caller may give; `people: false` roles are for Teams only).
 * @param {{ api: AccessPort, type: "unit"|"group"|"space"|"board", id: string }} o
 */
export function createAccessModel({ api, type, id }) {
  const m = base({ page: null, said: null });
  const S = m.state;
  const rowAt = subject => S.page.rows.findIndex(r => r.subject.type === subject.type && r.subject.id === subject.id);
  return {
    ...m, type, id,
    async load() {
      S.error = null; if (!S.page) S.status = "loading"; m.emit();
      const r = await api.access(type, id);
      if (r.error) loadFailed(S, r); else { S.page = r.page; S.status = "ready"; }
      m.emit();
    },
    async loadMore() {
      if (!S.page?.next || S.busy) return false;
      return act(m, () => api.access(type, id, S.page.next), r => { S.page = { ...S.page, rows: [...S.page.rows, ...r.page.rows], next: r.page.next }; }, r => `${r.page.rows.length} more`);
    },
    /** The roles offered for a subject type: people never get a role that is Teams-only. */
    rolesFor: subjectType => (S.page?.roles ?? []).filter(r => subjectType === "team" || r.people),
    /** Add (or change) `subject` to `role`; the server's row replaces ours. @param {{ type: "user"|"team", id: string, name: string }} subject */
    async set(subject, role) {
      const at = rowAt(subject);
      const verb = at >= 0 ? "now" : "added as";
      return act(m, () => api.setGrant(type, id, { type: subject.type, id: subject.id }, role), r => {
        if (at >= 0) S.page.rows[at] = r.row; else S.page.rows = [r.row, ...S.page.rows];
      }, r => `${r.row.subject.name} ${verb} ${r.row.roleName}`);
    },
    async remove(subject) {
      const at = rowAt(subject);
      if (at < 0) return true;
      const name = S.page.rows[at].subject.name;
      return act(m, () => api.removeGrant(type, id, { type: subject.type, id: subject.id }), () => { S.page.rows = S.page.rows.filter((_, i) => i !== at); }, `Removed ${name}`);
    },
  };
}

/**
 * The people/Team search of the picker: `search(q)` asks the directory (the caller's Unit only), the newest answer wins. `teams: false` leaves Teams out (a
 * Team's own member picker). @param {{ api: AccessPort, teams?: boolean }} o
 */
export function createPickerModel({ api, teams = true }) {
  const m = base({ query: "", people: [], teams: [], chosen: null, searched: false });
  const S = m.state;
  let seq = 0;
  return {
    ...m,
    async search(q) {
      const mine = ++seq;
      S.query = String(q ?? "").slice(0, 100); S.status = "loading"; S.error = null; m.emit();
      const r = await api.directory(S.query.trim());
      if (mine !== seq) return;
      if (r.error) { S.status = "error"; S.error = failText(r); S.people = []; S.teams = []; }
      else { S.status = "ready"; S.people = r.people.map(p => ({ type: "user", id: p.user, name: p.name, email: p.email })); S.teams = teams ? r.teams.map(t => ({ type: "team", id: t.id, name: t.name, size: t.size })) : []; }
      S.searched = true;
      if (S.chosen && ![...S.people, ...S.teams].some(x => x.type === S.chosen.type && x.id === S.chosen.id)) S.chosen = null;
      m.emit();
    },
    choose(subject) { S.chosen = subject; m.emit(); },
    clear() { S.chosen = null; m.emit(); },
  };
}
