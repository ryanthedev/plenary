// The in-memory Registry adapter (tests, single-process dev), including the board organization. The port (typedefs, `mint`, `RegistryError`, the
// last-owner and failure rules) is server/auth/registry-port.js; this adapter passes test/auth/registry-contract.js.

import { normEmail } from "./util.js";
import { mint, RegistryError, KINDS, domainList, orgDefaults, MEMBER_ROLE_ID, DEFAULT_MEMBER_PERMS } from "./registry-port.js";

/**
 * @typedef {import("./registry-port.js").Registry} Registry
 * @typedef {import("./registry-port.js").Role} Role
 * @typedef {import("./registry-port.js").Tenant} Tenant
 * @typedef {import("./registry-port.js").Board} Board
 * @typedef {import("./registry-port.js").Invite} Invite
 * @typedef {import("./registry-port.js").Link} Link
 * @typedef {import("./registry-port.js").Group} Group
 * @typedef {import("./registry-port.js").Space} Space
 * @typedef {import("./registry-port.js").Team} Team
 * @typedef {import("./registry-port.js").CustomRole} CustomRole
 */

/**
 * An in-memory Registry (tests, single-process dev). Returns copies, so callers can't mutate its state.
 * @returns {Registry}
 */
export function memoryRegistry({ now = Date.now } = {}) {
  /** @type {Map<string, Tenant>} */ const tenants = new Map();
  /** @type {Map<string, string>} */ const byDomain = new Map();
  /** @type {Map<string, Board>} */ const boards = new Map();
  /** @type {Map<string, Map<string, Role>>} */ const grants = new Map();
  /** @type {Map<string, Invite>} */ const invites = new Map();
  /** @type {Map<string, Link>} */ const links = new Map();
  /** @type {Map<string, Set<string>>} key board + "\n" + user → link ids */ const uses = new Map();
  /** @type {Map<string, Group>} */ const groups = new Map();
  /** @type {Map<string, Space>} */ const spaces = new Map();
  /** @type {Map<string, Team>} */ const teams = new Map();
  /** @type {Map<string, Set<string>>} team → members */ const members = new Map();
  /** @type {Map<string, Map<string, string>>} "type\nid" → ("type\nid" of the subject → role) */ const scoped = new Map();
  /** @type {Map<string, Map<string, CustomRole>>} tenant → id → role */ const roles = new Map();
  const copy = x => (x ? structuredClone(x) : null);
  const fresh = (map, f) => { let id; do id = f(); while (map.has(id)); return id; };

  const need = (ok, what) => { if (!ok) throw new Error(`registry: no such ${what}`); };
  const sk = (a, b) => a + "\n" + b;
  const putScoped = (type, id, st, sid, role) => {
    const k = sk(type, id);
    if (!scoped.has(k)) scoped.set(k, new Map());
    if (role == null) scoped.get(k).delete(sk(st, sid)); else scoped.get(k).set(sk(st, sid), role);
  };
  /** The tenant a scope belongs to, or undefined if it doesn't exist. */
  const scopeTenant = (type, id) => (type === "unit" ? tenants.get(id) : type === "group" ? groups.get(id) : type === "space" ? spaces.get(id) : boards.get(id))?.[type === "unit" ? "id" : "tenant"];

  return {
    async createTenant({ domain, domains = [], kind = "company", admins = [] }) {
      const ds = domainList(domain, domains);
      if (!KINDS.includes(kind)) throw new Error("registry: bad unit kind");
      if (ds.some(d => byDomain.has(d))) throw new Error("registry: domain already has a tenant");
      const t = { id: fresh(tenants, mint.tenant), domain: ds[0] ?? null, domains: ds, kind, admins: [...admins], createdAt: now() };
      tenants.set(t.id, t);
      for (const d of ds) byDomain.set(d, t.id);
      return copy(t);
    },
    async addTenantDomain(tenant, domain) {
      const t = tenants.get(tenant), d = typeof domain === "string" ? domain.trim().toLowerCase() : "";
      if (!t) throw new Error("registry: no such tenant");
      if (!d) throw new Error("registry: bad domain");
      if (byDomain.has(d) && byDomain.get(d) !== tenant) throw new Error("registry: domain already has a tenant");
      if (!t.domains.includes(d)) { t.domains.push(d); t.domain ??= d; byDomain.set(d, tenant); }
    },
    async tenant(id) { return copy(tenants.get(id)); },
    async tenantByDomain(domain) {
      const id = typeof domain === "string" ? byDomain.get(domain.toLowerCase()) : undefined;
      return id ? copy(tenants.get(id)) : null;
    },
    async tenantAdminsAmong(users) { const all = new Set([...tenants.values()].flatMap(t => t.admins)); return [...new Set(users.map(String))].filter(u => all.has(u)); },
    async addTenantAdmin(tenant, user) {
      const t = tenants.get(tenant);
      if (!t) throw new Error("registry: no such tenant");
      if (!t.admins.includes(user)) t.admins.push(user);
    },

    async createBoard({ tenant, title = "", memberRole, space }) {
      if (!tenants.has(tenant)) throw new Error("registry: no such tenant");
      if (space != null && spaces.get(space)?.tenant !== tenant) throw new Error("registry: no such space");
      const b = { id: fresh(boards, mint.board), tenant, title: String(title), memberRole: memberRole === undefined ? (space != null ? null : "viewer") : memberRole, space: space ?? null, createdAt: now() };
      boards.set(b.id, b);
      return copy(b);
    },
    async board(id) { return copy(boards.get(id)); },

    async setGrant(board, user, role) {
      if (!boards.has(board)) throw new Error("registry: no such board");
      if (!grants.has(board)) grants.set(board, new Map());
      const g = grants.get(board);
      // Check and write with no await in between: atomic in one JS process.
      if (g.get(user) === "owner" && role !== "owner" && [...g.values()].filter(r => r === "owner").length <= 1)
        throw new RegistryError("last-owner", "a board keeps at least one owner");
      if (role == null) g.delete(user); else g.set(user, role);
    },
    async grant(board, user) { return grants.get(board)?.get(user) ?? null; },
    async grants(board) { return [...(grants.get(board) ?? [])].map(([user, role]) => ({ user, role })); },

    async createInvite({ board, email, role, expiresAt = null, by }) {
      if (!boards.has(board)) throw new Error("registry: no such board");
      const i = { id: fresh(invites, mint.invite), board, email: normEmail(email), role, expiresAt, revoked: false, by, createdAt: now() };
      invites.set(i.id, i);
      return copy(i);
    },
    async invite(id) { return copy(invites.get(id)); },
    async invites(board) { return [...invites.values()].filter(i => i.board === board).map(copy); },
    async invitesFor(board, email) {
      const e = normEmail(email);
      return [...invites.values()].filter(i => i.board === board && i.email === e).map(copy);
    },
    async revokeInvite(id) { const i = invites.get(id); if (!i) return false; i.revoked = true; return true; },

    async createLink({ board, role, expiresAt = null, by }) {
      if (!boards.has(board)) throw new Error("registry: no such board");
      const l = { id: fresh(links, mint.link), board, role, expiresAt, revoked: false, by, createdAt: now() };
      links.set(l.id, l);
      return copy(l);
    },
    async link(id) { return copy(links.get(id)); },
    async links(board) { return [...links.values()].filter(l => l.board === board).map(copy); },
    async revokeLink(id) { const l = links.get(id); if (!l) return false; l.revoked = true; return true; },

    async addLinkUse(link, user) {
      const l = links.get(link);
      if (!l) throw new Error("registry: no such link");
      const k = l.board + "\n" + user;
      if (!uses.has(k)) uses.set(k, new Set());
      uses.get(k).add(link);
    },
    async linkUses(board, user) { return [...(uses.get(board + "\n" + user) ?? [])]; },
    async linkUsesFor(board, users) {
      const out = new Map();
      for (const u of users ?? []) { const s = uses.get(board + "\n" + u); if (s?.size) out.set(u, [...s]); }
      return out;
    },

    // ---- organization: Groups, Spaces, Teams, scoped grants, roles ----
    async createGroup({ tenant, name, generalRole = null, owner }) {
      need(tenants.has(tenant), "tenant");
      const g = { id: fresh(groups, mint.group), tenant, name: orgDefaults.name(name), generalRole, createdAt: now() };
      groups.set(g.id, g);
      if (owner != null) putScoped("group", g.id, "user", String(owner), "owner");
      return copy(g);
    },
    async group(id) { return copy(groups.get(id)); },
    async groups(tenant) { return [...groups.values()].filter(g => g.tenant === tenant).map(copy); },

    async createSpace({ tenant, name, group = null, generalRole = "viewer", owner }) {
      need(tenants.has(tenant), "tenant");
      if (group != null) need(groups.get(group)?.tenant === tenant, "group");
      const sp = { id: fresh(spaces, mint.space), tenant, group, name: orgDefaults.name(name), kind: "shared", owner: null, generalRole, createdAt: now() };
      spaces.set(sp.id, sp);
      if (owner != null) putScoped("space", sp.id, "user", String(owner), "owner");
      return copy(sp);
    },
    async space(id) { return copy(spaces.get(id)); },
    async spaces(tenant) { return [...spaces.values()].filter(s => s.tenant === tenant).map(copy); },
    async ensurePersonalSpace(tenant, user) {
      need(tenants.has(tenant), "tenant");
      user = String(user);
      let sp = [...spaces.values()].find(s => s.tenant === tenant && s.owner === user);
      if (!sp) {
        sp = { id: fresh(spaces, mint.space), tenant, group: null, name: orgDefaults.personalName(user), kind: "personal", owner: user, generalRole: null, createdAt: now() };
        spaces.set(sp.id, sp);
        putScoped("space", sp.id, "user", user, "owner");
      }
      return copy(sp);
    },

    async createTeam({ tenant, name }) {
      need(tenants.has(tenant), "tenant");
      const tm = { id: fresh(teams, mint.team), tenant, name: orgDefaults.name(name), createdAt: now() };
      teams.set(tm.id, tm); members.set(tm.id, new Set());
      return copy(tm);
    },
    async team(id) { return copy(teams.get(id)); },
    async teams(tenant) { return [...teams.values()].filter(t => t.tenant === tenant).map(copy); },
    async setTeamMember(team, user, member) {
      need(teams.has(team), "team");
      if (member) members.get(team).add(String(user)); else members.get(team).delete(String(user));
    },
    async teamMembers(team) { return [...(members.get(team) ?? [])]; },

    async setScopedGrant({ scope, subject, role }) {
      const { type, id } = orgDefaults.scope(scope), sub = orgDefaults.subject(subject), r = orgDefaults.grantRole(role);
      need(scopeTenant(type, id) != null, "scope");
      if (sub.type === "team") need(teams.get(sub.id)?.tenant === scopeTenant(type, id), "team");
      if (type === "board" && sub.type === "user") throw new Error("registry: a user's grant on a board is setGrant");
      const g = scoped.get(sk(type, id));
      // Check and write with no await in between: atomic in one JS process.
      if ((type === "group" || type === "space") && g?.get(sk(sub.type, sub.id)) === "owner" && r !== "owner" && [...g.values()].filter(x => x === "owner").length <= 1)
        throw new RegistryError("last-owner", `a ${type} keeps at least one owner`);
      putScoped(type, id, sub.type, sub.id, r);
    },
    async scopedGrants(scope) {
      const { type, id } = orgDefaults.scope(scope);
      return [...(scoped.get(sk(type, id)) ?? [])].map(([k, role]) => { const [t, ...i] = k.split("\n"); return { subject: { type: t, id: i.join("\n") }, role }; });
    },

    async createRole({ tenant, name, base = null, boardRole, permissions = [] }) {
      need(tenants.has(tenant), "tenant");
      const m = roles.get(tenant) ?? new Map(); roles.set(tenant, m);
      const r = { id: fresh(m, mint.role), tenant, name: orgDefaults.name(name), base, boardRole, permissions: [...permissions], createdAt: now() };
      m.set(r.id, r);
      return copy(r);
    },
    async updateRole(tenant, id, patch) {
      need(tenants.has(tenant), "tenant");
      const m = roles.get(tenant) ?? new Map(); roles.set(tenant, m);
      let r = m.get(id);
      if (!r) {
        need(id === MEMBER_ROLE_ID, "role");
        r = { id, tenant, name: "Unit member", base: null, boardRole: null, permissions: [...DEFAULT_MEMBER_PERMS], createdAt: now() };
        m.set(id, r);
      }
      if (patch.name !== undefined) r.name = orgDefaults.name(patch.name);
      if (patch.boardRole !== undefined) r.boardRole = patch.boardRole;
      if (patch.permissions !== undefined) r.permissions = [...patch.permissions];
      return copy(r);
    },
    async role(tenant, id) { return copy(roles.get(tenant)?.get(id)); },
    async roles(tenant) { return [...(roles.get(tenant)?.values() ?? [])].map(copy); },

    async accessContext(scope) {
      const { type, id } = orgDefaults.scope(scope);
      const board = type === "board" ? boards.get(id) : null;
      const space = type === "space" ? spaces.get(id) : board?.space ? spaces.get(board.space) : null;
      const group = type === "group" ? groups.get(id) : space?.group ? groups.get(space.group) : null;
      const tenant = tenants.get(type === "unit" ? id : (board ?? space ?? group)?.tenant);
      if (!tenant || (type !== "unit" && !(board ?? space ?? group))) return null;
      const list = (t, i) => (i == null ? [] : [...(scoped.get(sk(t, i)) ?? [])].map(([k, role]) => { const [st, ...si] = k.split("\n"); return { subject: { type: st, id: si.join("\n") }, role }; }));
      const sc = { unit: list("unit", tenant.id), group: list("group", group?.id), space: list("space", space?.id), board: list("board", board?.id) };
      const teamIds = new Set(Object.values(sc).flat().filter(g => g.subject.type === "team").map(g => g.subject.id));
      return copy({ tenant, board: board ?? null, space: space ?? null, group: group ?? null, scoped: sc,
        roles: [...(roles.get(tenant.id)?.values() ?? [])], teams: Object.fromEntries([...teamIds].map(t => [t, [...(members.get(t) ?? [])]])) });
    },
  };
}
