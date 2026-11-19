// The access explanation as the pages show it (PROTOCOL.md § Access explanation and requests, #51), with no DOM: the shape the server answers is checked once here
// (`normalizeExplain`, used by every adapter that carries it), the sentences are built here, and the Ask for access flow is a small model. The server decides
// everything (`mine`, `needs`, `ask`); this file only words it. Copy follows design/orgs/JOURNEY.md J10.

const ID_RE = /^[\w-]{1,64}$/;
const isId = v => typeof v === "string" && ID_RE.test(v);
const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const list = (v, max, f) => (Array.isArray(v) ? v.slice(0, max).map(f).filter(Boolean) : []);
const SCOPES = ["unit", "group", "space", "board"];
const KINDS = ["direct", "team", "general", "invite", "link", "unit"];

const scopeRef = s => (s && typeof s === "object" && SCOPES.includes(s.type) && isId(s.id) ? { type: s.type, id: s.id, ...(typeof s.name === "string" ? { name: str(s.name) } : {}) } : null);
const source = s => {
  const scope = scopeRef(s?.scope);
  if (!scope || !KINDS.includes(s.kind) || typeof s.role !== "string") return null;
  return { kind: s.kind, scope, role: str(s.role, 64), roleName: str(s.roleName, 64), ladder: typeof s.ladder === "string" ? str(s.ladder, 32) : null, strongest: s.strongest === true,
    ...(s.team && isId(s.team.id) ? { team: { id: s.team.id, ...(typeof s.team.name === "string" ? { name: str(s.team.name) } : {}) } } : {}) };
};
const roleOpt = o => (o && typeof o === "object" && typeof o.id === "string" && o.id.length <= 64 ? { id: o.id, name: str(o.name, 64) } : null);

/** @typedef {{ role: { id: string, name: string }|null, sources: { kind: string, scope: { type: string, id: string, name?: string }, role: string, roleName: string, ladder: string|null, strongest: boolean, team?: { id: string, name?: string } }[] }} Mine */
/** @typedef {{ mine: Mine, guest: boolean, needs: Record<string, { role: string, roleName: string, held: boolean }|null>, owners: { type: string, id: string, name: string }[], ask: { can: boolean, roles: { id: string, name: string }[], pending: { role: string, roleName: string, at: number }|null, retryAfterMs: number|null } }} Explain */

/** The `{ mine, needs, owners, ask }` of a page or of GET /boards/:board/explain, checked and capped; null when it is not that shape. @returns {Explain|null} */
export function normalizeExplain(b) {
  if (!b || typeof b !== "object" || !b.mine || typeof b.mine !== "object" || !Array.isArray(b.mine.sources)) return null;
  const role = b.mine.role && typeof b.mine.role.id === "string" ? { id: str(b.mine.role.id, 32), name: str(b.mine.role.name, 64) } : null;
  const needs = {};
  for (const [k, v] of Object.entries(b.needs && typeof b.needs === "object" ? b.needs : {}).slice(0, 8)) needs[str(k, 32)] = v && typeof v.role === "string" ? { role: str(v.role, 32), roleName: str(v.roleName, 64), held: v.held === true } : null;
  const a = b.ask && typeof b.ask === "object" ? b.ask : {};
  const pending = a.pending && typeof a.pending.role === "string" && Number.isFinite(a.pending.at) ? { role: str(a.pending.role, 64), roleName: str(a.pending.roleName, 64), at: a.pending.at } : null;
  return {
    mine: { role, sources: list(b.mine.sources, 20, source) }, needs,
    owners: list(b.owners, 10, o => (o && (o.type === "user" || o.type === "team") && typeof o.id === "string" && o.id.length <= 200 ? { type: o.type, id: o.id, name: str(o.name) } : null)),
    guest: b.guest === true,
    ask: { can: a.can === true, roles: list(a.roles, 6, roleOpt), pending, retryAfterMs: Number.isFinite(a.retryAfterMs) ? Math.max(0, a.retryAfterMs) : null },
  };
}
/** One request of an Access page's `requests` list (managers only). */
export const normalizeRequest = r => (r && typeof r === "object" && r.user && typeof r.user.id === "string" && r.user.id.length <= 200 && typeof r.role === "string" && Number.isFinite(r.at)
  ? { user: { id: r.user.id, name: str(r.user.name), email: typeof r.user.email === "string" ? str(r.user.email, 320) : null }, role: str(r.role, 64), roleName: str(r.roleName, 64), at: r.at } : null);

const NOUN = { unit: "organization", group: "Group", space: "Space", board: "board" };
/** Where a source is set, in a sentence: "Space Platform", "Group Engineering", "this board", "your organization". */
export function scopeText(scope, here = null) {
  if (here && scope.type === here.type && scope.id === here.id) return `this ${NOUN[scope.type]}`;
  if (scope.type === "unit") return "your organization";
  return `${NOUN[scope.type]}${scope.name ? " " + scope.name : ""}`;
}
/** One source as a phrase after the role: "via the Infra team on Space Platform", "via Everyone on Group Engineering", "added directly on this Space", "through an invite", "through a share link", "as an organization admin". */
export function sourceText(s, here = null) {
  const at = here && s.scope.type === here.type && s.scope.id === here.id;     // a source set on the page's own scope needs no "on ..."
  const on = at ? "" : ` on ${scopeText(s.scope, here)}`;
  if (s.kind === "team") return `via the ${s.team?.name ?? "a"} team${on}`;
  if (s.kind === "general") return s.scope.type === "unit" ? "via everyone in the organization" : `via everyone in the organization${on}`;
  if (s.kind === "invite") return "through an invite";
  if (s.kind === "link") return "through a share link";
  if (s.kind === "unit") return s.role === "admin" ? "as an organization admin" : s.role === "member" ? "as an organization member" : `through a role${on || " here"}`;
  return at ? "added directly" : `added directly${on}`;
}
/** The strongest sources (the ones that reach the top role). */
export const strongestOf = mine => mine.sources.filter(s => s.strongest);

/** The one-line explanation (canvas pill, tooltips): "Commenter via Space Platform · Infra team". */
export function pillLine(mine) {
  if (!mine.role) return "No board access of your own";
  const via = strongestOf(mine).map(s => (s.kind === "team" ? `${scopeText(s.scope)} · ${s.team?.name ?? "a"} team` : s.kind === "general" ? `${scopeText(s.scope)} · everyone` : s.kind === "invite" ? "invite" : s.kind === "link" ? "share link" : s.kind === "unit" ? "organization" : scopeText(s.scope)));
  return via.length ? `${mine.role.name} via ${via.join(" and ")}` : mine.role.name;
}

/** "a Viewer", "an Editor". */
export const withArticle = name => `${/^[AEIOU]/i.test(name) ? "an" : "a"} ${name}`;
/** "Owners: Priya, Tom."; with none named: an organization admin (a member), or whoever shared the board (a guest has no organization to ask). */
export const ownersText = (owners, guest = false) => (owners.length ? `Owners: ${owners.map(o => o.name).join(", ")}.` : guest ? "Ask whoever shared this with you." : "Ask an organization admin.");
/** The role a held access comes from, named: "the Content editor role", "the organization's Member member role" (the strongest source). */
export const holderText = mine => { const s = strongestOf(mine)[0]; return !s ? null : s.kind === "unit" ? `the organization's ${s.roleName} role` : `the ${s.roleName} role`; };
/**
 * What the control needs, against what the caller has: "Creating boards needs Editor." or, when their role is already that high, why it is not enough.
 * @param {{ role: string, roleName: string, held: boolean }} need
 */
export const needText = (need, what, mine) => (need.held ? `${what} needs the built-in ${need.roleName} role. Your ${mine.role?.name ?? need.roleName} access comes from ${holderText(mine) ? holderText(mine) + ", which" : "a role that"} does not allow ${what.toLowerCase()}.` : `${what} needs ${need.roleName}.`);
/**
 * The why-card of a disabled control: [headline, what is needed, who to ask]. `what`: the thing the control does ("Creating boards"), `permission`: the key the server listed in `needs`.
 * @param {Explain} why @param {{ type: string, id: string }} here @param {string} what @param {string} permission @param {string|null} [hereName] the scope's name, for "in Platform"
 */
export function whyLines(why, here, what, permission, hereName = null) {
  const m = why.mine;
  const name = m.role?.name ?? "member";
  const strong = strongestOf(m);
  const where = hereName ? `in ${hereName}` : "here";
  const lines = [m.role ? `You're ${withArticle(name)} ${where}${strong.length ? ", " + strong.map(s => sourceText(s, here)).join(" and ") : ""}.` : `You have no board access of your own ${where}.`];
  const need = why.needs[permission];
  if (need) lines.push(needText(need, what, m));
  lines.push(ownersText(why.owners, why.guest));
  return lines;
}

const ASK_MSG = {
  limited: "You've asked too many times.", forbidden: "You can't ask for access here.", notfound: "That is not available to you.", auth: "You are signed out. Sign in again.",
  network: "No answer from the server. Try again.", unavailable: "The server did not answer. Trying again is safe.", invalid: "That role can't be asked for here.",
};
/** "in 3 hours", "in 20 minutes": when a refused ask may be repeated. */
export function waitText(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const m = Math.ceil(ms / 60_000);
  return m >= 120 ? `in ${Math.ceil(m / 60)} hours` : m >= 60 ? "in about an hour" : `in ${Math.max(1, m)} minute${m === 1 ? "" : "s"}`;
}

/**
 * Ask for access at one scope: the role to ask for, one Idempotency-Key per submit (kept for its retries, so a retry after a lost answer is the same request), and the
 * result as state. `api.ask(type, id, role, key)` resolves `{ request }` or `{ error, retryAfter? }` (web/ports/access.js). `said` is the sentence for screen readers.
 * @param {{ api: { ask(type: string, id: string, role: string, key?: string|null): Promise<any> }, type: string, id: string, why: Explain, newKey?: (() => string)|null, onChange?: () => void }} o
 */
export function createAskModel({ api, type, id, why, newKey = null, onChange = () => {} }) {
  const state = { status: why.ask.pending ? "sent" : "idle", role: why.ask.roles.at(-1)?.id ?? why.ask.roles[0]?.id ?? null, message: null, said: null, pending: why.ask.pending, retryAfterMs: why.ask.retryAfterMs };
  let key = null;
  const done = () => onChange(state);
  return {
    state,
    /** The wait the server named has passed: the button may be used again. */
    clearLimit() { if (state.status === "sent" || state.status === "busy") return; state.status = "idle"; state.retryAfterMs = null; state.message = null; state.said = null; done(); },
    choose(role) { if (role !== state.role) { state.role = role; key = null; } },
    /** @returns {Promise<boolean>} */
    async submit() {
      if (state.status === "busy" || state.status === "sent" || !state.role) return false;
      state.status = "busy"; state.message = null; state.said = null; done();
      let k = null;
      try { k = newKey ? (key ??= newKey()) : null; } catch { k = null; }
      const r = await api.ask(type, id, state.role, k);
      if (r.error) {
        state.status = r.error === "limited" ? "limited" : "error";
        state.retryAfterMs = r.error === "limited" && Number.isFinite(r.retryAfter) ? r.retryAfter * 1000 : state.retryAfterMs;
        state.message = r.error === "limited" ? `${ASK_MSG.limited} Try again ${state.retryAfterMs ? waitText(state.retryAfterMs) : "later"}.` : ASK_MSG[r.error] ?? ASK_MSG.unavailable;
        state.said = state.message;
        done();
        return false;
      }
      key = null;
      state.status = "sent"; state.pending = { role: r.request.role, roleName: r.request.roleName, at: r.request.at };
      state.said = `Request sent. The owners will see it on this Space's Access page.`.replace("this Space's", type === "board" ? "this board's" : type === "group" ? "this Group's" : "this Space's");
      done();
      return true;
    },
  };
}
