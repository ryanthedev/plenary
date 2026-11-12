// The in-memory Registry adapter (tests, single-process dev). The port (typedefs, `mint`, `RegistryError`, the
// last-owner and failure rules) is server/auth/registry-port.js; this adapter passes test/auth/registry-contract.js.

import { normEmail } from "./util.js";
import { mint, RegistryError } from "./registry-port.js";

/**
 * @typedef {import("./registry-port.js").Registry} Registry
 * @typedef {import("./registry-port.js").Role} Role
 * @typedef {import("./registry-port.js").Tenant} Tenant
 * @typedef {import("./registry-port.js").Board} Board
 * @typedef {import("./registry-port.js").Invite} Invite
 * @typedef {import("./registry-port.js").Link} Link
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
  };
}
