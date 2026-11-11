// The Registry port: tenants, the board registry, per-board grants, invites and share links. Platform-local for
// now (Store has `board(id)` but no create call and no home for the rest); the engine will back it with SQLite /
// Postgres and PROTOCOL.md will name it. Method names here are STABLE: the engine builds against them.
//
// Every method is async. Ids are server-minted over [a-z0-9-] (no ".", "*", ">"), never a domain name, so they
// are safe in bus subjects (PROTOCOL.md § Bus).

import { randomId, normEmail } from "./util.js";

/**
 * @typedef {"owner"|"editor"|"annotator"|"commenter"|"viewer"} Role
 * @typedef {{ id: string, domain: string|null, admins: string[], createdAt: number }} Tenant
 * @typedef {{ id: string, tenant: string, title: string, memberRole: Role|null, createdAt: number }} Board
 * @typedef {{ id: string, board: string, email: string, role: Role, expiresAt: number|null, revoked: boolean, by: string, createdAt: number }} Invite
 * @typedef {{ id: string, board: string, role: Role, expiresAt: number|null, revoked: boolean, by: string, createdAt: number }} Link
 *
 * @typedef {{
 *   createTenant(o: { domain: string|null, admins?: string[] }): Promise<Tenant>,
 *   tenant(id: string): Promise<Tenant|null>,
 *   tenantByDomain(domain: string): Promise<Tenant|null>,
 *   addTenantAdmin(tenant: string, user: string): Promise<void>,
 *   createBoard(o: { tenant: string, title?: string, memberRole?: Role|null }): Promise<Board>,
 *   board(id: string): Promise<Board|null>,
 *   setGrant(board: string, user: string, role: Role|null): Promise<void>,
 *   grant(board: string, user: string): Promise<Role|null>,
 *   grants(board: string): Promise<{ user: string, role: Role }[]>,
 *   createInvite(o: { board: string, email: string, role: Role, expiresAt?: number|null, by: string }): Promise<Invite>,
 *   invite(id: string): Promise<Invite|null>,
 *   invites(board: string): Promise<Invite[]>,
 *   invitesFor(board: string, email: string): Promise<Invite[]>,
 *   revokeInvite(id: string): Promise<boolean>,
 *   createLink(o: { board: string, role: Role, expiresAt?: number|null, by: string }): Promise<Link>,
 *   link(id: string): Promise<Link|null>,
 *   links(board: string): Promise<Link[]>,
 *   revokeLink(id: string): Promise<boolean>,
 *   addLinkUse(link: string, user: string): Promise<void>,
 *   linkUses(board: string, user: string): Promise<string[]>,
 * }} Registry
 */

/** Tenant ids: "t-" + 12 of [a-z0-9]. Board ids: "b-" + 16. Invite ids: "i-" + 16. Link ids: 26 (≈ 134 bits). */
export const mint = {
  tenant: () => "t-" + randomId(12),
  board: () => "b-" + randomId(16),
  invite: () => "i-" + randomId(16),
  link: () => randomId(26),
};

/** An in-memory Registry (tests, single-process dev). Returns copies, so callers can't mutate its state. */
export function memoryRegistry({ now = Date.now } = {}) {
  /** @type {Map<string, Tenant>} */ const tenants = new Map();
  /** @type {Map<string, string>} */ const byDomain = new Map();
  /** @type {Map<string, Board>} */ const boards = new Map();
  /** @type {Map<string, Map<string, Role>>} */ const grants = new Map();
  /** @type {Map<string, Invite>} */ const invites = new Map();
  /** @type {Map<string, Link>} */ const links = new Map();
  /** @type {Map<string, Set<string>>} key board + "\n" + user → link ids */ const uses = new Map();
  const copy = x => (x ? structuredClone(x) : null);
  const fresh = (map, f) => { let id; do id = f(); while (map.has(id)); return id; };

  return {
    async createTenant({ domain, admins = [] }) {
      const d = domain ? domain.toLowerCase() : null;
      if (d && byDomain.has(d)) throw new Error("registry: domain already has a tenant");
      const t = { id: fresh(tenants, mint.tenant), domain: d, admins: [...admins], createdAt: now() };
      tenants.set(t.id, t);
      if (d) byDomain.set(d, t.id);
      return copy(t);
    },
    async tenant(id) { return copy(tenants.get(id)); },
    async tenantByDomain(domain) {
      const id = typeof domain === "string" ? byDomain.get(domain.toLowerCase()) : undefined;
      return id ? copy(tenants.get(id)) : null;
    },
    async addTenantAdmin(tenant, user) {
      const t = tenants.get(tenant);
      if (!t) throw new Error("registry: no such tenant");
      if (!t.admins.includes(user)) t.admins.push(user);
    },

    async createBoard({ tenant, title = "", memberRole = "viewer" }) {
      if (!tenants.has(tenant)) throw new Error("registry: no such tenant");
      const b = { id: fresh(boards, mint.board), tenant, title: String(title), memberRole, createdAt: now() };
      boards.set(b.id, b);
      return copy(b);
    },
    async board(id) { return copy(boards.get(id)); },

    async setGrant(board, user, role) {
      if (!boards.has(board)) throw new Error("registry: no such board");
      if (!grants.has(board)) grants.set(board, new Map());
      if (role == null) grants.get(board).delete(user); else grants.get(board).set(user, role);
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
  };
}
