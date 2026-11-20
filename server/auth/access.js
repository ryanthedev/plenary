// Teams and access (PROTOCOL.md § Teams and access, #49). Core: depends on the Registry port and `tenancy`, imports no adapter; the HTTP
// routes only translate. Every decision is a PERMISSION read from the resolver's answer at the scope the request names (`tenancy.effective`),
// never a role name. Names are access: an id the caller may not use (unknown, another Unit's, hidden) is one answer and the same Registry work.
//
// What it owns: Teams (create, rename, delete, members), the access page of a scope (who holds what, through what) and the grant writes
// behind its one role picker, the people/Team search the picker uses, and the announcements each change owes the gateways (handed to the
// scheduler in spaces.js through `announce`; it never holds a queue of its own).

import { AdminError, knownOnBoard } from "../admin/boards.js";
import { isUnitAdmin } from "./resolver.js";
import { ROLES } from "./util.js";
import { roleDef, MGMT_PERMS, UNIT_ROLES, withinLadder } from "./permissions.js";
import { TEAMS } from "./registry-port.js";
import { LADDER_NAMES, roleLabel as labelOf, explainService, askRolesFor } from "./explain.js";

/** What one read shows at most, and the work each does (PROTOCOL.md § Teams and access, Bounds). */
export const LIMITS = Object.freeze({ teams: TEAMS.page.default, rows: 50, inherited: 20, boardPeople: 200, search: 8, admins: 100, scopes: 5000, teamScopes: 50, scopePage: 500, backlog: 2000, addPages: 20, retries: 3 });
const TYPES = ["unit", "group", "space", "board"];
export { LADDER_NAMES };
export const LADDER_SUMMARY = {
  viewer: "Can view", commenter: "Can view and comment", annotator: "Can view, comment and annotate", editor: "Can edit, and create boards and Spaces where that applies",
  owner: "Everything an editor can do, plus manage who has access, move, delete and transfer",
};

const refused = () => new AdminError("forbidden", "not allowed");
const missing = () => new AdminError("not-found", "not found");
const bad = m => new AdminError("bad-request", m);
export const idOf = v => (typeof v === "string" && /^[\w-]{1,64}$/.test(v) ? v : null);
const userIdOf = v => (typeof v === "string" && v.length > 0 && v.length <= 200 && !v.includes("\0") && !v.includes("\n") ? v : null);
export const nameOf = v => { const n = typeof v === "string" ? v.trim() : ""; if (!n || n.length > 200 || n.includes("\0")) throw bad("bad name"); return n; };
const queryOf = v => { if (v == null) return null; if (typeof v !== "string" || v.length > 100 || v.includes("\0")) throw bad("bad query"); return v.trim() || null; };
const cursorOf = (v, kind) => {
  if (v == null) return null;
  const ok = typeof v === "string" && v.length > 0 && v.length <= 600 && !v.includes("\0") && (kind === "id" ? !v.includes("\n") : /^(user|team)\n./.test(v));
  if (!ok) throw bad("bad cursor");
  return v;
};
/** "google:123" / "dev:ada" → the part a person would read, for a user with no directory entry. */
const plainName = id => String(id).replace(/^[a-z]+:/, "");
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const mgmtOf = def => [...def.permissions].filter(p => MGMT_PERMS.includes(p));

/**
 * The definition of `role` at `type` if the caller may hand it out there, else null. Valid there (roleDef), never `admin` or `member`, its management
 * permissions a subset of the caller's own at that scope and its board role no higher than the caller's own (no escalation, `withinLadder`), and, at a board, `owner` only for a Unit admin (today's rule).
 */
export function grantable(access, role, type, roles, admin) {
  if (role === "admin" || role === "member") return null;
  const def = roleDef(role, type, roles);
  if (!def || !mgmtOf(def).every(p => access.permissions.has(p)) || !withinLadder(access.ladder, def.ladder, admin)) return null;   // management permissions a subset of the caller's, and no more board role than they hold (a Unit admin is exempt)
  if (type === "board" && role === "owner" && !admin) return null;
  return def;
}

/**
 * @param {{ registry: import("./registry-port.js").Registry, tenancy: ReturnType<typeof import("./tenancy.js").tenancy>,
 *   announce?: (unit: { id: string }, scope: { type: string, id: string }, o?: { revoke?: boolean }) => void,
 *   backlog?: () => number, settled?: () => Promise<void>, log?: { warn(msg: string, f?: object): void } }} deps
 *   announce: hands a change to the announcement scheduler (spaceService.announceChange); backlog / settled: its load, so a long walk waits instead of piling up.
 */
export function accessService({ registry, tenancy, now = Date.now, explainer = explainService({ registry, now }), announce = () => {}, backlog = () => 0, settled = async () => {}, log = { warn() {} } }) {
  const may = (a, p) => a.permissions.has(p);
  const opens = a => a.ladder != null;
  const warn = (msg, f) => { try { log.warn(msg, f); } catch {} };
  const unitOf = identity => tenancy.tenantOf(identity);
  const teamView = t => ({ id: t.id, name: t.name, size: t.size ?? 0 });
  const walks = new Set();
  const track = p => { walks.add(p); p.then(() => walks.delete(p), () => walks.delete(p)); };

  /** The Team and the caller's access to the Unit: the SAME two reads whatever the id. Null for an unknown or another Unit's Team. */
  async function teamOf(identity, unit, id) {
    if (!unit) return null;
    const ok = idOf(id);
    const [row, access] = await Promise.all([ok ? registry.team(ok) : null, tenancy.effective(identity, { type: "unit", id: unit.id })]);
    return row && row.tenant === unit.id ? { row, access } : { row: null, access };
  }
  /** A Team write: the Team exists in the caller's Unit and the caller holds `team.manage` there, else the one ordinary refusal. */
  async function managedTeam(identity, id) {
    const unit = await unitOf(identity);
    const t = await teamOf(identity, unit, id);
    if (!t?.row || !may(t.access, "team.manage")) throw refused();
    return { unit, team: t.row };
  }

  /**
   * Announce what a Team's membership or deletion changes: every scope it holds a grant on, paged. Never throws. A revocation waits for the
   * scheduler's backlog to fall instead of being dropped; an addition stops after LIMITS.addPages (the timed re-check, 60 s at most, covers the rest).
   */
  async function walkTeam(unit, team, { revoke }) {
    let after = null, pages = 0;
    try {
      do {
        while (backlog() > LIMITS.backlog) await settled();
        let p;
        for (let i = 0; ; i++) {
          try { p = await registry.scopesOf({ type: "team", id: team }, { after, limit: LIMITS.scopePage }); break; }
          catch (err) { if (i + 1 >= LIMITS.retries) throw err; await sleep(50 * (i + 1)); }
        }
        for (const sc of p.scopes) announce(unit, { type: sc.type, id: sc.id }, { revoke });
        after = p.next;
        if (after != null && !revoke && ++pages >= LIMITS.addPages) { warn("team announcement stopped at its bound; the timed re-check covers the rest", { team }); break; }
      } while (after != null);
    } catch (err) { warn("team announcement failed; the timed re-check covers it", { team, err }); }
  }
  const walkLater = (unit, team, o) => track(walkTeam(unit, team, o));

  /** The scopes a Team holds grants on (for a delete), at most LIMITS.scopes; null when there are more. */
  async function scopesOfTeam(team) {
    const out = []; let after = null;
    do {
      const p = await registry.scopesOf({ type: "team", id: team }, { after, limit: LIMITS.scopePage });
      out.push(...p.scopes.map(s => ({ type: s.type, id: s.id })));
      if (out.length > LIMITS.scopes) return null;
      after = p.next;
    } while (after != null);
    return out;
  }

  /**
   * Adding a person to a Team grants them every grant the Team holds, and removing one revokes them (so does deleting the Team): the caller must be able
   * to do each of those as a direct grant (`members.manage` at the scope and the role grantable by them there, the same `touchable` rule), or `team.manage`
   * would be a back door to roles the caller cannot give. A Unit admin passes. Bounded: at most LIMITS.teamScopes scopes are read and checked; a Team that
   * holds more, or any scope the caller falls short on, is the ordinary refusal for a non-admin.
   * ADDING a member is the one change that widens access: a Unit admin's pass does not reach a personal space or a board in one (they are its owner's, PROTOCOL.md § Organization), so for those scopes the admin needs
   * `members.manage` from the resolver like anyone (a manage-only admin has none there). Removing never widens, and offboarding relies on it: an admin always may. A Team too large to check is refused for adding.
   */
  async function mayChangeTeam(identity, unit, team, { adding = false } = {}) {
    const admin = isUnitAdmin(unit, identity);
    if (admin && !adding) return true;
    const p = await registry.scopesOf({ type: "team", id: team }, { limit: LIMITS.teamScopes + 1 });
    if (admin) {
      if (p.scopes.length > LIMITS.teamScopes) return false;
      for (const sc of p.scopes) {
        const space = sc.type === "space" ? await registry.space(sc.id) : sc.type === "board" ? await registry.space((await registry.board(sc.id))?.space) : null;
        if (space?.kind !== "personal") continue;
        const access = await tenancy.effective(identity, sc.type === "board" ? sc.id : { type: sc.type, id: sc.id }, { uniform: true });
        if (!may(access, "members.manage")) return false;
      }
      return true;
    }
    if (p.scopes.length > LIMITS.teamScopes) return false;
    if (!p.scopes.length) return true;
    const roles = new Map((await registry.roles(unit.id)).map(r => [r.id, r]));
    const containers = p.scopes.filter(s => s.type !== "board");
    const got = containers.length ? await tenancy.effectiveMany(identity, containers.map(s => ({ type: s.type, id: s.id }))) : new Map();
    const subject = { type: "team", id: team };
    for (const sc of p.scopes) {
      if (!validAt(sc.role, sc.type, roles)) continue;                          // a stale role counts for nothing: nothing to give or take
      const access = sc.type === "board" ? await tenancy.effective(identity, sc.id, { uniform: true }) : got.get(sc.type + "\n" + sc.id);
      if (!access || !may(access, "members.manage") || !touchable(access, sc.role, sc.type, roles, false, subject, identity)) return false;
    }
    return true;
  }

  /** Is `user` a person the Unit knows: in its directory, or one of its admins named by id (the operator vouches for them)? */
  async function isKnownPerson(unit, user) {
    const row = (await registry.membersAmong(unit.id, [user]))[0];
    if (row?.removed) return false;
    if (unit.admins?.includes(user) && !user.startsWith("email:")) return true;     // an `email:` entry is an admin not yet seen: not a person with an id
    return !!row;   // a person the Unit removed is not offered (PROTOCOL.md § Leaver offboarding)
  }

  // ---- naming rows ----
  const roleLabel = labelOf;
  const summaryOf = (role, def, roles) => {
    if (LADDER_SUMMARY[role]) return LADDER_SUMMARY[role];
    const m = mgmtOf(def), c = roles.get(role);
    return `Custom role: ${c?.boardRole ? "board content up to " + c.boardRole : "no board content"}${m.length ? "; " + m.join(", ") : ""}`;
  };
  /** Subjects → views, from the directory and Teams in as few reads as it takes (chunks of the Registry's batch size). */
  async function named(unit, subjects) {
    const users = [...new Set(subjects.filter(s => s.type === "user").map(s => s.id))], teams = [...new Set(subjects.filter(s => s.type === "team").map(s => s.id))];
    const byUser = new Map(), byTeam = new Map();
    for (let i = 0; i < users.length; i += TEAMS.among) for (const m of await registry.membersAmong(unit.id, users.slice(i, i + TEAMS.among))) byUser.set(m.user, m);
    for (let i = 0; i < teams.length; i += TEAMS.among) for (const t of await registry.teamsAmong(unit.id, teams.slice(i, i + TEAMS.among))) byTeam.set(t.id, t);
    return s => (s.type === "team"
      ? { type: "team", id: s.id, name: byTeam.get(s.id)?.name ?? "Unknown team", size: byTeam.get(s.id)?.size ?? 0 }
      : { type: "user", id: s.id, name: byUser.get(s.id)?.name ?? plainName(s.id), email: byUser.get(s.id)?.email ?? null });
  }

  // ---- who may grant what ----
  /**
   * May the caller alter or clear an existing grant of `role` held by `subject` at `type`? A role valid nowhere is stale and any manager may clear it;
   * else it must be grantable by the caller. At a board a person's `owner` grant is changed only by a Unit admin or by its holder (today's rule).
   */
  function touchable(access, role, type, roles, admin, subject, identity) {
    if (!validAt(role, type, roles)) return true;
    if (type === "board" && subject.type === "user" && role === "owner" && !admin) return subject.id === identity.user;
    return !!grantable(access, role, type, roles, admin);
  }
  const validAt = (role, type, roles) => role !== "admin" && role !== "member" && roleDef(role, type, roles) != null;

  /**
   * The scope row and the caller's access to it: the SAME two reads whatever the id, so a refusal can't be told from another by how much work it did.
   * @returns {Promise<{ row: object, access: import("./resolver.js").Access, type: string }|null>}
   */
  async function scopeOf(identity, unit, type, id) {
    if (!TYPES.includes(type) || !idOf(id)) return null;
    const [row, access] = type === "board"
      ? await Promise.all([registry.board(id), tenancy.effective(identity, id, { uniform: true })])
      : await Promise.all([type === "unit" ? registry.tenant(id) : type === "group" ? registry.group(id) : registry.space(id), tenancy.effective(identity, { type, id })]);
    const tenant = type === "unit" ? row?.id : row?.tenant;
    return row && unit && tenant === unit.id ? { row, access, type } : null;
  }
  /** A personal space's access is its owner's own. */
  const isPersonal = sc => sc.type === "space" && sc.row.kind === "personal";
  const manages = sc => !isPersonal(sc) && may(sc.access, "members.manage");

  /** Whether `access` already holds every permission of `role` at a `type` scope (what an ask for it could add is nothing). */
  const reaches = (access, role, type, roles) => { const want = roleDef(role, type, roles); return !!access && !!want && [...want.permissions].every(p => access.permissions.has(p)); };

  /**
   * The pending requests at a scope, requesters named (only a `members.manage` holder is ever handed these). A request whose person already REACHES the role asked for (a Team
   * they are in, a grant at a containing Group) is hidden, never written to: a read must not race another manager's dismissal or record a grant that may be revoked later. The
   * hidden row stays pending (and counts toward scopePending) until the grant route closes it, a new ask supersedes it, or its ttl prunes it. One batch of access reads
   * for the page's at most LIMITS.rows requesters.
   */
  async function requestsOf(unit, scope, roles) {
    const list = await registry.accessRequests(scope, { limit: LIMITS.rows });
    if (!list.length) return [];
    const label = await named(unit, list.map(r => ({ type: "user", id: r.user })));
    // Every directory row is a Unit member (only members are recorded), so they stand as members of the Unit's first domain.
    const ids = list.map(r => ({ user: r.user, email: label({ type: "user", id: r.user }).email, domain: unit.domains?.[0] ?? null }));
    const got = await tenancy.effectiveAmong(scope, ids);
    return list.filter(r => !reaches(got.get(r.user), r.role, scope.type, roles))
      .map(r => ({ user: label({ type: "user", id: r.user }), role: r.role, roleName: roleLabel(r.role, roles), at: r.at }));
  }
  /** The roles the caller may ask for at a scope (none: they may not ask: personal space, the Unit, nothing to open, already a manager). */
  const askable = (sc, roles) => (sc.type !== "unit" && opens(sc.access) && !manages(sc) && !isPersonal(sc) ? askRolesFor(sc.access, sc.type, roles) : []);
  const requestRow = (r, roleList) => ({ role: r.role, roleName: labelOf(r.role, new Map(roleList.map(x => [x.id, x]))), at: r.at, state: r.state });

  return {
    // ================= Teams =================

    /** GET /teams. @param {import("./idp-port.js").Identity} identity @param {{ after?: string|null, q?: string|null }} o */
    async listTeams(identity, { after = null, q = null } = {}) {
      const cur = cursorOf(after, "id"), term = queryOf(q);
      const unit = await unitOf(identity);
      if (!unit) throw refused();
      const [page, access] = await Promise.all([registry.teamsPage(unit.id, { after: cur, limit: LIMITS.teams, q: term }), tenancy.effective(identity, { type: "unit", id: unit.id })]);
      return { teams: page.teams.map(teamView), next: page.next, can: { create: may(access, "team.manage") } };
    },

    /** @param {import("./idp-port.js").Identity} identity @param {{ name: string }} o @param {import("./registry-port.js").Idem} [idem] the Idempotency-Key of a keyed create */
    async createTeam(identity, { name }, idem) {
      const n = nameOf(name);
      const unit = await unitOf(identity);
      if (!unit || !may(await tenancy.effective(identity, { type: "unit", id: unit.id }), "team.manage")) throw refused();
      return teamView(await registry.createTeam({ tenant: unit.id, name: n, idem }));
    },

    /** The replay of a keyed `POST /teams` (PROTOCOL.md "Idempotent creates"): authorized AGAIN as the create was, then the Team read fresh. */
    async replayTeam(identity, id) {
      const unit = await unitOf(identity);
      if (!unit || !may(await tenancy.effective(identity, { type: "unit", id: unit.id }), "team.manage")) throw refused();
      const t = typeof id === "string" ? await registry.team(id) : null;
      if (!t || t.tenant !== unit.id) throw refused();
      return teamView({ ...t, size: (await registry.teamsAmong(unit.id, [id]))[0]?.size ?? 0 });
    },

    /** GET /teams/:id: the Team and one page of its members. */
    async teamPage(identity, id, after = null) {
      const cur = cursorOf(after, "id");
      const unit = await unitOf(identity);
      const t = await teamOf(identity, unit, id);
      if (!t?.row) throw missing();
      const [page, size] = await Promise.all([registry.teamMembersPage(t.row.id, { after: cur, limit: LIMITS.rows }), registry.teamsAmong(unit.id, [t.row.id])]);
      const dir = new Map((await registry.membersAmong(unit.id, page.users)).map(m => [m.user, m]));
      const members = page.users.map(u => ({ user: u, name: dir.get(u)?.name ?? plainName(u), email: dir.get(u)?.email ?? null }));
      return { team: teamView({ ...t.row, size: size[0]?.size ?? 0 }), can: { manage: may(t.access, "team.manage") }, members, next: page.next };
    },

    async renameTeam(identity, id, name) {
      const n = nameOf(name);
      const { team } = await managedTeam(identity, id);
      return teamView({ ...(await registry.renameTeam(team.id, n)), size: (await registry.teamsAmong(team.tenant, [team.id]))[0]?.size ?? 0 });
    },

    /** DELETE /teams/:id: collects the scopes it holds, deletes atomically, then announces each as a revocation. */
    async deleteTeam(identity, id) {
      const { unit, team } = await managedTeam(identity, id);
      if (!(await mayChangeTeam(identity, unit, team.id))) throw refused();
      const scopes = await scopesOfTeam(team.id);
      if (!scopes) throw new AdminError("too-large", "the team holds grants on too many scopes; remove some first");
      try { await registry.deleteTeam(team.id); }
      catch (err) {
        if (err?.code === "last-owner") throw new AdminError("last-owner", "a Group or Space keeps at least one owner");
        if (!(await registry.team(team.id))) return;     // gone already (a racing delete): the request's wish is met
        throw err;
      }
      track((async () => {
        for (const sc of scopes) { while (backlog() > LIMITS.backlog) await settled(); announce(unit, sc, { revoke: true }); }
      })().catch(err => warn("team announcement failed; the timed re-check covers it", { team: team.id, err })));
    },

    /** PUT / DELETE /teams/:id/members/:user (idempotent). */
    async setMember(identity, id, user, member) {
      const u = userIdOf(user);
      if (!u) throw bad("bad user");
      const { unit, team } = await managedTeam(identity, id);
      if (!(await mayChangeTeam(identity, unit, team.id, { adding: member === true }))) throw refused();
      if (member && !(await isKnownPerson(unit, u))) throw new AdminError("unknown-person", "that person is not a member of this Unit");
      try { await registry.setTeamMember(team.id, u, member); }
      catch (err) {
        if (err?.code === "last-owner") throw new AdminError("last-owner", "a Group or Space keeps at least one owner");
        throw err;
      }
      walkLater(unit, team.id, { revoke: !member });
    },

    /** GET /directory?q=: the picker's search over the caller's Unit. */
    async directory(identity, { q = null } = {}) {
      const term = queryOf(q);
      const unit = await unitOf(identity);
      if (!unit) throw refused();
      const [people, teams] = await Promise.all([registry.findMembers(unit.id, { q: term, limit: LIMITS.search }), registry.teamsPage(unit.id, { q: term, limit: LIMITS.search })]);
      return { people: people.map(m => ({ user: m.user, name: m.name ?? plainName(m.user), email: m.email })), teams: teams.teams.map(teamView) };
    },

    // ================= Access at a scope =================

    /** GET /access/:type/:id. Hidden, unknown and other-Unit ids are one `not-found`. */
    async accessPage(identity, type, id, after = null) {
      const cur = cursorOf(after, "subject");
      const unit = await unitOf(identity);
      const sc = await scopeOf(identity, unit, type, id);
      if (!sc || !(opens(sc.access) || may(sc.access, "members.manage"))) throw missing();
      const { row, access } = sc;
      const admin = isUnitAdmin(unit, identity), manage = manages(sc);
      const scope = { type, id: row.id };
      const canSee = opens(access);
      const [page, roleList, people, unitPage] = await Promise.all([
        registry.scopedGrantsPage(scope, { after: cur, limit: LIMITS.rows }),
        registry.roles(unit.id),
        type === "board" && cur === null ? registry.grants(row.id) : [],
        type !== "unit" ? registry.scopedGrantsPage({ type: "unit", id: unit.id }, { limit: LIMITS.rows }) : null,
      ]);
      const roles = new Map(roleList.map(r => [r.id, r]));
      // Access that comes from the Unit itself: its admins, the grants on it whose role carries board content here, and the Unit member role's board role.
      const orgAdmins = type !== "unit" ? (unit.admins ?? []).filter(a => !a.startsWith("email:")) : [];
      const unitGrants = unitPage ? unitPage.grants.filter(g => !UNIT_ROLES.includes(g.role) && roleDef(g.role, type, roles)?.ladder != null) : [];
      const memberLadder = type !== "unit" ? roleDef("member", "unit", roles)?.ladder ?? null : null;

      // The containers above, for the inherited rows and the general-access rows: only the ones the caller can open (names are access).
      const above = [];
      let hiddenAbove = false;      // access comes from a container the caller can't open: a boolean only (no name, no count)
      if (type === "board" || type === "space") {
        const space = type === "board" ? await registry.space(row.space) : row;
        const group = type === "space" ? (row.group ? await registry.group(row.group) : null) : space?.group ? await registry.group(space.group) : null;
        const cands = type === "board" ? [space && { type: "space", row: space }, group && { type: "group", row: group }] : [group && { type: "group", row: group }];
        const list = cands.filter(Boolean);
        const got = await tenancy.effectiveMany(identity, list.map(c => ({ type: c.type, id: c.row.id })));
        const closed = [];
        for (const c of list) { if (opens(got.get(c.type + "\n" + c.row.id) ?? { ladder: null })) above.push(c); else closed.push(c); }
        // The same containers that were left out above: does one of them hold access (a grant, or general access) that therefore does not show?
        for (const c of closed) if (c.row.generalRole || (await registry.scopedGrantsPage({ type: c.type, id: c.row.id }, { limit: 1 })).grants.length) { hiddenAbove = true; break; }
      }
      const inheritedPages = await Promise.all(above.map(c => registry.scopedGrantsPage({ type: c.type, id: c.row.id }, { limit: LIMITS.inherited })));

      const userRows = people.slice().sort((a, b) => (a.user < b.user ? -1 : 1)).slice(0, LIMITS.boardPeople).map(g => ({ subject: { type: "user", id: g.user }, role: g.role }));
      const rawRows = [...page.grants.filter(g => type !== "board" || g.subject.type === "team"), ...userRows];
      // A board lists its direct people on the first page; the page's own rows are Team grants there (a person's board grant lives in `grants`).
      const adminList = type === "unit" ? (unit.admins ?? []).filter(a => !a.startsWith("email:")).slice(0, LIMITS.admins).map(a => ({ type: "user", id: a })) : [];
      const label = named(unit, [...rawRows.map(r => r.subject), ...inheritedPages.flatMap(p => p.grants.map(g => g.subject)), ...adminList, ...unitGrants.map(g => g.subject), ...orgAdmins.slice(0, LIMITS.inherited).map(a => ({ type: "user", id: a }))]);
      const nameOfSubject = await label;
      const canTouch = (role, g) => manage && touchable(access, role, type, roles, admin, g, identity);
      const toRow = (g, extra = {}) => ({ subject: nameOfSubject(g.subject), role: g.role, roleName: roleLabel(g.role, roles), via: g.subject.type === "team" ? "team" : "direct", ...extra });
      const rows = rawRows.map(g => toRow(g, { can: { change: canTouch(g.role, g.subject), remove: canTouch(g.role, g.subject) } }));
      const inherited = above.flatMap((c, i) => inheritedPages[i].grants.map(g => ({ scope: { type: c.type, id: c.row.id, name: c.row.name }, subject: nameOfSubject(g.subject), role: g.role, roleName: roleLabel(g.role, roles), via: "inherited" })));
      for (const g of unitGrants) inherited.push({ scope: { type: "unit", id: unit.id }, subject: nameOfSubject(g.subject), role: g.role, roleName: roleLabel(g.role, roles), via: "inherited" });
      const general = [];
      if (canSee) {
        if (type === "board" && row.memberRole) general.push({ scope: { type, id: row.id, name: row.title }, role: row.memberRole });
        else if ((type === "space" || type === "group") && row.generalRole) general.push({ scope: { type, id: row.id, name: row.name }, role: row.generalRole });
      }
      for (const c of above) if (c.row.generalRole) general.push({ scope: { type: c.type, id: c.row.id, name: c.row.name }, role: c.row.generalRole });
      if (memberLadder) general.push({ scope: { type: "unit", id: unit.id }, role: memberLadder });
      const [why, requests] = await Promise.all([
        explainer.explain(identity, { type, row, access, unit, manage, personal: isPersonal(sc) }),
        manage && type !== "unit" ? requestsOf(unit, scope, roles) : [],
      ]);

      // The picker: only roles valid here that the caller may hand out.
      const options = [...ROLES.filter(r => type !== "unit"), ...[...roles.values()].filter(r => r.id !== "member").sort((a, b) => a.name.localeCompare(b.name)).map(r => r.id)];
      const pick = [];
      for (const r of manage ? options : []) {
        const def = grantable(access, r, type, roles, admin);
        if (def) pick.push({ id: r, name: roleLabel(r, roles), custom: !LADDER_NAMES[r], summary: summaryOf(r, def, roles), ladder: def.ladder, people: !(type === "board" && !LADDER_NAMES[r]) });
      }
      const name = type === "board" ? row.title : type === "unit" ? undefined : row.name;
      return {
        scope: { type, id: row.id, ...(canSee && name !== undefined ? { name } : {}), ...(isPersonal(sc) ? { personal: true } : {}) },
        can: { manage },
        ...(hiddenAbove ? { hiddenAbove: true } : {}),
        general,
        ...(type === "unit" ? { admins: adminList.map(a => { const v = nameOfSubject(a); return { user: v.id, name: v.name, email: v.email }; }) } : {}),
        ...(type !== "unit" ? { organization: { admins: orgAdmins.slice(0, LIMITS.inherited).map(a => { const v = nameOfSubject({ type: "user", id: a }); return { user: v.id, name: v.name }; }), more: orgAdmins.length > LIMITS.inherited || unitPage.next != null, memberRole: memberLadder } } : {}),
        ...why, ...(manage && type !== "unit" ? { requests } : {}),
        rows, next: page.next, inherited, roles: pick,
      };
    },

    /**
     * PUT (role) / DELETE (role null) /access/:type/:id/grants/:subjectType/:subject. Idempotent. Returns the row after a put, null after a delete.
     * @param {import("./idp-port.js").Identity} identity
     */
    async setGrant(identity, type, id, subjectType, subjectId, role) {
      if (subjectType !== "user" && subjectType !== "team") throw bad("bad subject");
      const sid = subjectType === "user" ? userIdOf(subjectId) : idOf(subjectId);
      if (!sid) throw bad("bad subject");
      if (role !== null && (typeof role !== "string" || !role || role.length > 64)) throw bad("bad role");
      const unit = await unitOf(identity);
      const sc = await scopeOf(identity, unit, type, id);
      if (!sc || !manages(sc)) throw refused();
      const { row, access } = sc, scope = { type, id: row.id }, sub = { type: subjectType, id: sid };
      const admin = isUnitAdmin(unit, identity);
      const roles = new Map((await registry.roles(unit.id)).map(r => [r.id, r]));
      const personBoard = type === "board" && subjectType === "user";
      const cur = personBoard ? await registry.grant(row.id, sid) : await registry.scopedGrant(scope, sub);
      const touch = r => touchable(access, r, type, roles, admin, sub, identity);

      if (role === null) {
        if (cur == null) return null;
        if (!touch(cur)) throw refused();
      } else {
        if (!validAt(role, type, roles) || (personBoard && !ROLES.includes(role))) throw new AdminError("bad-role", "that role does not apply here");
        const def = grantable(access, role, type, roles, admin);
        if (!def) throw refused();
        if (cur === role) return { ...(await rowOf(unit, sub, role, roles, type, access, admin, identity)) };
        if (cur != null && !touch(cur)) throw refused();
        // A change to an existing grant needs no directory row. A NEW person grant above a board needs one; on a board, the shared rule of the old route (guests hold board scope).
        if (subjectType === "user") { if (cur == null && !(await (personBoard ? knownOnBoard(registry, row, sid) : isKnownPerson(unit, sid)))) throw new AdminError("unknown-person", "that person is not a member of this Unit"); }
        else if (!(await registry.teamsAmong(unit.id, [sid])).length) throw refused();
      }
      try {
        if (personBoard) await registry.setGrant(row.id, sid, role);
        else await registry.setScopedGrant({ scope, subject: sub, role });
      } catch (err) {
        if (err?.code === "last-owner") throw new AdminError("last-owner", `a ${type} keeps at least one owner`);
        if (err?.code === "no-role") throw new AdminError("bad-role", "that role does not apply here");   // deleted since it was read
        throw err;
      }
      // A change that reduces access is a revocation: anything but a pure widening (the new role holds every permission the old one did).
      const before = cur == null ? null : roleDef(cur, type, roles), after = role == null ? null : roleDef(role, type, roles);
      const revoke = before != null && (after == null || [...before.permissions].some(p => !after.permissions.has(p)));
      announce(unit, scope, { revoke });
      // The person now holds the access they may have asked for: their request is done (best effort; a leftover only shows a stale row to managers until it expires).
      if (role !== null && subjectType === "user") await registry.closeAccessRequest(scope, sid, "granted").catch(err => warn("could not close an access request", { err }));
      return role === null ? null : rowOf(unit, sub, role, roles, type, access, admin, identity);
    },

    // ================= Access requests (#51) =================

    /**
     * GET /boards/:board/explain: the explanation for anyone who can open the board, a guest included (their sources are board-scope only, so nothing else is
     * named, no owners, no Ask). The same `effective(..., { uniform: true })` as every other board route; an unknown or hidden board is one `not-found`.
     */
    async boardExplain(identity, boardId) {
      const unit = await unitOf(identity), id = idOf(boardId);
      const [row, access] = await Promise.all([id ? registry.board(id) : null, tenancy.effective(identity, id ?? "", { uniform: true })]);
      if (!row || !opens(access)) throw missing();
      const own = unit && row.tenant === unit.id ? unit : null;
      return explainer.explain(identity, { type: "board", row, access, unit: own, manage: !!own && may(access, "members.manage") });
    },


    /**
     * POST /access/:type/:id/requests: the caller asks the scope's owners for `role`. Refused (the one 403, after the same reads) unless they are a Unit member who can open
     * a Space, Group or board that is not a personal space, do not already manage it, and the role is one they may ask for.
     * @param {import("./idp-port.js").Identity} identity @param {import("./registry-port.js").Idem} [idem]
     */
    async requestAccess(identity, type, id, role, idem) {
      if (typeof role !== "string" || !role || role.length > 64) throw bad("bad role");
      const unit = await unitOf(identity);
      const sc = await scopeOf(identity, unit, type, id);
      const roleList = unit ? await registry.roles(unit.id) : [];      // read whatever the answer, so a refusal costs what a success does
      const may_ = sc ? askable(sc, new Map(roleList.map(r => [r.id, r]))) : [];
      if (!may_.length) throw refused();
      if (!may_.some(r => r.id === role)) throw new AdminError("bad-role", "that role cannot be asked for here");
      // A pending ask whose role the caller already reaches (a grant landed since) is stale: the new ask replaces it instead of returning it.
      const roleMap = new Map(roleList.map(r => [r.id, r]));
      const open = await registry.accessRequest({ type, id: sc.row.id }, identity.user);
      const supersede = open?.state === "pending" && open.role !== role && reaches(sc.access, open.role, type, roleMap);
      let r;
      try { r = await registry.requestAccess({ tenant: unit.id, scope: { type, id: sc.row.id }, user: identity.user, role, idem, supersede }); }
      catch (err) {
        if (err?.code === "rate-limited") throw new AdminError("rate-limited", "too many requests", { data: { retryAfter: err.retryAfterMs == null ? null : Math.max(1, Math.ceil(err.retryAfterMs / 1000)) } });
        throw err;
      }
      return requestRow(r, await registry.roles(unit.id));
    },
    /** The replay of a keyed `POST .../requests`: authorized AGAIN as the create was, then the caller's request read fresh. */
    async replayRequest(identity, type, id, ref) {
      const unit = await unitOf(identity);
      const sc = await scopeOf(identity, unit, type, id);
      if (!sc || type === "unit" || !opens(sc.access) || manages(sc) || isPersonal(sc)) throw refused();
      const r = await registry.accessRequest({ type, id: sc.row.id }, identity.user);
      if (!r) throw refused();
      if (r.id !== ref) throw new AdminError("superseded", "that request was replaced by a later one");   // the key's request is not the open one any more: never answer with the newer

      return requestRow(r, await registry.roles(unit.id));
    },

    /** DELETE /access/:type/:id/requests/:user: a manager dismisses a request (it stays as dismissed, holding the cooldown). Idempotent. */
    async dismissRequest(identity, type, id, user) {
      const u = userIdOf(user);
      if (!u) throw bad("bad user");
      const unit = await unitOf(identity);
      const sc = await scopeOf(identity, unit, type, id);
      if (!sc || type === "unit" || !manages(sc)) throw refused();
      await registry.closeAccessRequest({ type, id: sc.row.id }, u, "dismissed");
    },

    /** Wait for the walks over Teams' scopes (tests; a shutdown). */
    async settled() { while (walks.size) await Promise.allSettled([...walks]); },
  };

  /** The row a successful put answers with. */
  async function rowOf(unit, sub, role, roles, type, access, admin, identity) {
    const label = await named(unit, [sub]);
    const can = touchable(access, role, type, roles, admin, sub, identity);
    return { subject: label(sub), role, roleName: roleLabel(role, roles), via: sub.type === "team" ? "team" : "direct", can: { change: can, remove: can } };
  }
}
