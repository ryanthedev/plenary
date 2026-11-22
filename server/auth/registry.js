// The in-memory Registry adapter (tests, single-process dev), including the board organization. The port (typedefs, `mint`, `RegistryError`, the
// last-owner and failure rules) is server/auth/registry-port.js; this adapter passes test/auth/registry-contract.js.

import { normEmail, capTo, higher, ROLES, INVITE_ROLES, LINK_ROLES } from "./util.js";
import { batchScopes, mint, RegistryError, KINDS, domainList, orgDefaults, MEMBER_ROLE_ID, DEFAULT_MEMBER_PERMS, pageLimit, HOME, IDEM, idemErr, idemOf, smallLimit, searchQuery, asciiFold, TEAMS, TRASH, likeOf, profileText, ROLE_LIMITS, capOf, isCustomRoleId, ASK, askLimited, askScope, askRole, askLive, askWait, askLimits } from "./registry-port.js";

/**
 * @typedef {import("./registry-port.js").Registry} Registry
 * @typedef {import("./registry-port.js").Role} Role
 * @typedef {import("./registry-port.js").Tenant} Tenant
 * @typedef {import("./registry-port.js").Board} Board
 * @typedef {import("./registry-port.js").Invite} Invite
 * @typedef {import("./registry-port.js").Link} Link
 * @typedef {import("./registry-port.js").AuditEvent} AuditEvent
 * @typedef {import("./registry-port.js").Group} Group
 * @typedef {import("./registry-port.js").Space} Space
 * @typedef {import("./registry-port.js").Team} Team
 * @typedef {import("./registry-port.js").CustomRole} CustomRole
 */

const cmpBoard = (a, b) => (b.createdAt !== a.createdAt ? b.createdAt - a.createdAt : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const parseCursor = before => {
  if (before == null || before === "") return null;
  if (typeof before !== "string") return "invalid";
  const m = /^(\d+):(\d+)$/.exec(before);
  return m ? { at: Number(m[1]), id: Number(m[2]) } : "invalid";
};

/**
 * An in-memory Registry (tests, single-process dev). Returns copies, so callers can't mutate its state.
 * @returns {Registry}
 */
export function memoryRegistry({ now = Date.now } = {}) {
  /** @type {Map<string, Tenant>} */ const tenants = new Map();
  /** @type {Map<string, string>} */ const byDomain = new Map();
  /** @type {Map<string, Set<string>>} tenant id → lower-cased member emails */ const tenantMembersMap = new Map();
  /** @type {Map<string, Board>} */ const boards = new Map();
  /** @type {Map<string, Map<string, Role>>} */ const grants = new Map();
  /** @type {Map<string, Invite>} */ const invites = new Map();
  /** @type {Map<string, Link>} */ const links = new Map();
  /** @type {Map<string, Set<string>>} key board + "\n" + user → link ids */ const uses = new Map();
  /** @type {AuditEvent[]} */ const audits = [];
  let auditSeq = 0;
  /** @type {Map<string, Group>} */ const groups = new Map();
  /** @type {Map<string, Space>} */ const spaces = new Map();
  /** @type {Map<string, Team>} */ const teams = new Map();
  /** @type {Map<string, Set<string>>} team → members */ const members = new Map();
  /** @type {Map<string, Map<string, { user: string, name: string|null, email: string|null }>>} tenant → user → directory row (`removedAt`/`removedBy`: PROTOCOL.md § Leaver offboarding) */ const directory = new Map();
  /** @type {Map<string, Map<string, string>>} "type\nid" → ("type\nid" of the subject → role) */ const scoped = new Map();
  /** @type {Map<string, Map<string, CustomRole>>} tenant → id → role */ const roles = new Map();
  /** @type {Map<string, Map<string, number>>} user → board → opened at (Recent) */ const recent = new Map();
  /** @type {Map<string, Map<string, number>>} user → board → starred at */ const stars = new Map();
  /** @type {Map<string, { fp: string, ref: string, at: number }>} user + "\n" + key → fingerprint and the id it made (Idempotent creates) */ const idem = new Map();
  /** @type {Map<string, import("./registry-port.js").AccessRequest>} "type\nid\nuser" → the person's one request at a scope (Access requests, #51) */ const requests = new Map();
  /** @type {Set<string>} "b\nid" / "s\nid": rows claimed for purge (restore is refused from then on) */ const claimed = new Set();
  let idemCalls = 0;
  const idemLive = (e, t) => e && t - e.at < IDEM.ttlMs;
  /** A keyed create's first step: rejects (nothing written yet) when a live row holds the key. Returns the validated key, or null. */
  const idemEnter = o => {
    const i = idemOf(o);
    if (!i) return null;
    const t = now(), e = idem.get(i.user + "\n" + i.key);
    if (++idemCalls % IDEM.every === 0) { let n = 0; for (const [x, v] of idem) if (!idemLive(v, t) && n++ < IDEM.prune) idem.delete(x); }
    if (idemLive(e, t)) throw e.fp !== i.fp ? idemErr.mismatch() : idemErr.replay(e.ref);
    return i;
  };
  /** A keyed create's last step (synchronous with the write: one atomic step in a JS process). */
  const idemPut = (i, ref) => { if (i) idem.set(i.user + "\n" + i.key, { fp: i.fp, ref, at: now() }); };
  const newest = m => [...(m ?? [])].map(([board, at]) => ({ board, at })).sort((a, b) => b.at - a.at || (a.board < b.board ? 1 : -1));
  /** A directory row as callers see it: its profile and whether the Unit removed the person. */
  const publicRow = r => ({ user: r.user, name: r.name, email: r.email, removed: r.removedAt != null });
  const copy = x => (x ? structuredClone(x) : null);
  const fresh = (map, f) => { let id; do id = f(); while (map.has(id)); return id; };
  const cmpTenant = (a, b) => (a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  /** Owner grants on a Group or Space that guard it: a user's, or a Team's while the Team has a member. @returns {string[]} subject keys */
  const countedOwners = (type, id) => [...(scoped.get(sk(type, id)) ?? [])]
    .filter(([k, role]) => role === "owner" && (k.startsWith("user\n") || (members.get(k.slice(5))?.size ?? 0) > 0)).map(([k]) => k);
  /** Rejects (nothing written) when `user` is a person the Unit has removed (PROTOCOL.md § Leaver offboarding). */
  const noRemoved = (tenant, user) => { if (user != null && directory.get(tenant)?.get(String(user))?.removedAt != null) throw new RegistryError("removed", "registry: the member was removed from the Unit"); };
  /**
   * Does `user` solely own this Group or Space? They hold an owner grant (their own, or a Team's they are in), and no other counted owner would be left once they go: no other
   * person owner, and no Team owner with a member besides them (PROTOCOL.md § Leaver offboarding).
   */
  const soleOwner = (type, id, user) => {
    const owners = [...(scoped.get(sk(type, id)) ?? [])].filter(([, role]) => role === "owner").map(([k]) => k);
    const mine = owners.some(k => k === sk("user", user) || (k.startsWith("team\n") && members.get(k.slice(5))?.has(user)));
    const others = owners.some(k => (k.startsWith("user\n") && k !== sk("user", user)) || (k.startsWith("team\n") && [...(members.get(k.slice(5)) ?? [])].some(u => u !== user)));
    return mine && !others;
  };
  /** What `user` solely owns in a Unit: their personal space, and every Group or Space whose only counted owner they are (trashed ones too). One page, by "<type>\n<id>". */
  const aloneOf = (tenant, user, after, n) => {
    const all = [];
    for (const [type, map] of [["group", groups], ["space", spaces]]) for (const row of map.values()) {
      if (row.tenant !== tenant) continue;
      const personal = type === "space" && row.kind === "personal" && row.owner === user;
      if (personal || soleOwner(type, row.id, user)) all.push({ type, id: row.id, personal });
    }
    all.sort((x, y) => (x.type + "\n" + x.id < y.type + "\n" + y.id ? -1 : 1));
    const rest = after == null ? all : all.filter(x => x.type + "\n" + x.id > after), page = rest.slice(0, n);
    return { items: page, next: rest.length > n ? page[n - 1].type + "\n" + page[n - 1].id : null };
  };
  const need = (ok, what) => { if (!ok) throw new Error(`registry: no such ${what}`); };
  const sk = (a, b) => a + "\n" + b;
  /** Is the scope key ("type\nid") one of this Unit's? A scoped grant carries no tenant: its scope says whose it is. */
  const ownScope = (k, tenant) => { const i = k.indexOf("\n"); return scopeTenant(k.slice(0, i), k.slice(i + 1)) === tenant; };
  const putScoped = (type, id, st, sid, role) => {
    const k = sk(type, id);
    if (!scoped.has(k)) scoped.set(k, new Map());
    if (role == null) scoped.get(k).delete(sk(st, sid)); else scoped.get(k).set(sk(st, sid), role);
  };
  /** The tenant a scope belongs to, or undefined if it doesn't exist. */
  const scopeTenant = (type, id) => (type === "unit" ? tenants.get(id) : type === "group" ? groups.get(id) : type === "space" ? spaces.get(id) : boards.get(id))?.[type === "unit" ? "id" : "tenant"];

  return {
    async close() {},
    async createTenant({ name = null, domain, domains = [], kind = "company", admins = [] }) {
      const ds = domainList(domain, domains);
      if (!KINDS.includes(kind)) throw new Error("registry: bad unit kind");
      if (ds.some(d => byDomain.has(d))) throw new Error("registry: domain already has a tenant");
      const trimmedName = typeof name === "string" ? name.trim() : "";
      const n = trimmedName || ds[0] || "Personal Workspace";
      const t = { id: fresh(tenants, mint.tenant), name: n, domain: ds[0] ?? null, domains: ds, kind, admins: [...admins], createdAt: now() };
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
    async listPersonalTenants() {
      return [...tenants.values()]
        .filter(t => t.domain === null)
        .sort(cmpTenant)
        .map(copy);
    },
    async tenantAdminsAmong(users) { const all = new Set([...tenants.values()].flatMap(t => t.admins)); return [...new Set(users.map(String))].filter(u => all.has(u)); },
    async addTenantAdmin(tenant, user) {
      const t = tenants.get(tenant);
      if (!t) throw new Error("registry: no such tenant");
      if (!t.admins.includes(user)) t.admins.push(user);
    },
    async addTenantMember(tenant, email) {
      if (typeof tenant !== "string" || !tenants.has(tenant)) throw new Error("registry: no such tenant");
      const e = normEmail(email);
      if (!e) throw new Error("registry: bad email");
      if (!tenantMembersMap.has(tenant)) tenantMembersMap.set(tenant, new Set());
      const s = tenantMembersMap.get(tenant);
      const added = !s.has(e);
      s.add(e);
      return { added };
    },
    async removeTenantMember(tenant, email) {
      if (typeof tenant !== "string") return false;
      const e = normEmail(email);
      if (!e) return false;
      const s = tenantMembersMap.get(tenant);
      if (!s) return false;
      return s.delete(e);
    },
    async isTenantMember(tenant, email) {
      if (typeof tenant !== "string") return false;
      const e = normEmail(email);
      if (!e) return false;
      return Boolean(tenantMembersMap.get(tenant)?.has(e));
    },
    async tenantMembers(tenant) {
      if (typeof tenant !== "string") return [];
      const s = tenantMembersMap.get(tenant);
      return s ? [...s].sort() : [];
    },
    async tenantsForMember(email) {
      const e = normEmail(email);
      if (!e) return [];
      const out = [];
      for (const [tid, s] of tenantMembersMap) {
        if (s.has(e)) {
          const t = tenants.get(tid);
          if (t) out.push(t);
        }
      }
      return out.sort(cmpTenant).map(copy);
    },
    async tenantsForAdmin(user, email = null) {
      if (typeof user !== "string" || !user) return [];
      const e = normEmail(email);
      const emailKey = e ? "email:" + e : null;
      const out = [];
      for (const t of tenants.values()) {
        if (t.admins.includes(user) || (emailKey && t.admins.includes(emailKey))) out.push(t);
      }
      return out.sort(cmpTenant).map(copy);
    },

    async createBoard({ tenant, title = "", memberRole, space, owner, idem: key }) {
      if (!tenants.has(tenant)) throw new Error("registry: no such tenant");
      if (spaces.get(space)?.tenant !== tenant || spaces.get(space).trashedAt != null) throw new Error("registry: no such space");
      const k = idemEnter(key);
      const b = { id: fresh(boards, mint.board), tenant, title: String(title), memberRole: memberRole === undefined ? null : memberRole, space, createdAt: now(), trashedAt: null, trashedBy: null, trashedWith: null };
      boards.set(b.id, b);
      if (owner != null) grants.set(b.id, new Map([[String(owner), "owner"]]));
      idemPut(k, b.id);
      return copy(b);
    },
    async updateBoard(id, patch = {}) {
      const hasTitle = patch != null && patch.title !== undefined;
      const hasRole = patch != null && patch.memberRole !== undefined;
      let nextTitle;
      if (hasTitle) {
        if (typeof patch.title !== "string") throw new Error("registry: bad title");
        nextTitle = patch.title.trim().slice(0, 200);
      }
      let nextMemberRole;
      if (hasRole) {
        if (patch.memberRole === null || patch.memberRole === "none") nextMemberRole = null;
        else if (typeof patch.memberRole === "string" && INVITE_ROLES.includes(patch.memberRole)) nextMemberRole = patch.memberRole;
        else throw new Error("registry: bad memberRole");
      }
      if (typeof id !== "string") return null;
      const b = boards.get(id);
      if (!b) return null;
      if (hasTitle) b.title = nextTitle;
      if (hasRole) b.memberRole = nextMemberRole;
      return copy(b);
    },
    async deleteBoard(id) {
      if (typeof id !== "string" || !boards.has(id)) return false;
      boards.delete(id);
      grants.delete(id);
      scoped.delete(sk("board", id));
      for (const [iid, inv] of invites) if (inv.board === id) invites.delete(iid);
      for (const [lid, lnk] of links) if (lnk.board === id) links.delete(lid);
      const prefix = id + "\n";
      for (const k of [...uses.keys()]) if (k.startsWith(prefix)) uses.delete(k);
      for (const m of [recent, stars]) for (const x of m.values()) x.delete(id);
      for (const k of [...requests.keys()]) if (k.startsWith("board\n" + id + "\n")) requests.delete(k);
      claimed.delete("b\n" + id);
      return true;
    },
    async board(id) { return copy(boards.get(id)); },
    async listBoards(tenant) {
      if (typeof tenant !== "string") return [];
      return [...boards.values()].filter(b => b.tenant === tenant && b.trashedAt == null).sort(cmpBoard).map(copy);
    },
    async listBoardsFor(tenant, user, { email = null, isMember = true, at } = {}) {
      if (typeof tenant !== "string" || typeof user !== "string") return [];
      const t = Number.isFinite(at) ? at : now();
      const e = normEmail(email);
      const out = [];
      for (const b of [...boards.values()].filter(x => x.tenant === tenant && x.trashedAt == null).sort(cmpBoard)) {
        let r = capTo(grants.get(b.id)?.get(user) ?? null, ROLES);
        if (e) {
          for (const i of invites.values())
            if (i.board === b.id && i.email === e && !i.revoked && (i.expiresAt == null || t < i.expiresAt))
              r = higher(r, capTo(i.role, INVITE_ROLES));
        }
        for (const lid of uses.get(b.id + "\n" + user) ?? []) {
          const l = links.get(lid);
          if (l && l.board === b.id && !l.revoked && (l.expiresAt == null || t < l.expiresAt))
            r = higher(r, capTo(l.role, LINK_ROLES));
        }
        if (isMember && b.memberRole) r = higher(r, capTo(b.memberRole, INVITE_ROLES));
        if (r != null) out.push({ ...copy(b), role: r });
      }
      return out;
    },
    async boardsForUser(user, email = null, { at } = {}) {
      if (typeof user !== "string" || !user) return [];
      const t = Number.isFinite(at) ? at : now();
      const e = normEmail(email);
      /** @type {Map<string, Role>} */
      const rolesByBoard = new Map();
      const bump = (bid, role) => {
        if (!role) return;
        rolesByBoard.set(bid, higher(rolesByBoard.get(bid) ?? null, role));
      };
      for (const [bid, g] of grants) {
        const r = capTo(g.get(user) ?? null, ROLES);
        if (r) bump(bid, r);
      }
      if (e) {
        for (const i of invites.values()) {
          if (i.email === e && !i.revoked && (i.expiresAt == null || t < i.expiresAt))
            bump(i.board, capTo(i.role, INVITE_ROLES));
        }
      }
      for (const [k, lids] of uses) {
        const sep = k.indexOf("\n");
        if (sep < 0 || k.slice(sep + 1) !== user) continue;
        const bid = k.slice(0, sep);
        for (const lid of lids) {
          const l = links.get(lid);
          if (l && l.board === bid && !l.revoked && (l.expiresAt == null || t < l.expiresAt))
            bump(bid, capTo(l.role, LINK_ROLES));
        }
      }
      const out = [];
      for (const [bid, role] of rolesByBoard) {
        const b = boards.get(bid);
        if (b && b.trashedAt == null && role) out.push({ ...copy(b), role });
      }
      return out.sort(cmpBoard);
    },
    async moveBoard({ board, from, to, idem: key }) {
      const b = boards.get(board);
      if (!b) throw new Error("registry: no such board");
      if (typeof from !== "string") throw new Error("registry: no such space");   // `from` names the board's current Space (no unfiled boards)
      if (spaces.get(to)?.tenant !== b.tenant || spaces.get(to).trashedAt != null) throw new Error("registry: no such space");
      if (b.trashedAt != null) throw new RegistryError("in-trash", "the board is in Trash");
      const k = idemEnter(key);
      const moved = b.space !== to;
      if (moved) {
        if (b.space !== from) throw new RegistryError("moved", "the board is no longer in that Space");
        b.space = to;
      }
      idemPut(k, b.id + (moved ? ":moved" : ":noop"));
      return { board: copy(b), moved };
    },

    // ---- Trash (PROTOCOL.md § Trash and restore): every step is synchronous after its key check, so one atomic step in a JS process ----
    async trashBoard({ board, from, by, idem: key }) {
      const b = boards.get(board);
      if (!b) throw new Error("registry: no such board");
      if (typeof from !== "string" || !from) throw new Error("registry: no such space");
      if (typeof by !== "string" || !by) throw new Error("registry: bad user");
      const k = idemEnter(key);
      const trashed = b.trashedAt == null;
      if (trashed) {
        if (b.space !== from) throw new RegistryError("moved", "the board is no longer in that Space");
        Object.assign(b, { trashedAt: now(), trashedBy: by, trashedWith: null });
      }
      idemPut(k, b.id + (trashed ? ":trashed" : ":noop"));
      return { board: copy(b), trashed };
    },
    async restoreBoard({ board, idem: key, into = null }) {
      const b = boards.get(board);
      if (!b) throw new Error("registry: no such board");
      const k = idemEnter(key), restored = b.trashedAt != null;
      if (restored) {
        if (claimed.has("b\n" + b.id)) throw new RegistryError("purged", "the board is being deleted for good");
        if (b.trashedWith != null) throw new RegistryError("with-space", "the board went to Trash with its Space: restore the Space");
        if (spaces.get(b.space)?.trashedAt != null) {
          if (into == null) throw new RegistryError("space-in-trash", "the board's Space is in Trash: restore the Space first");
          const sp = spaces.get(into);
          if (sp?.tenant !== b.tenant || sp.trashedAt != null) throw new Error("registry: no such space");
          b.space = into;
        }
        Object.assign(b, { trashedAt: null, trashedBy: null, trashedWith: null });
      }
      idemPut(k, b.id + (restored ? ":restored" : ":noop"));
      return { board: copy(b), restored };
    },
    async trashSpace({ space, by, idem: key }) {
      const s = spaces.get(space);
      if (!s) throw new Error("registry: no such space");
      if (typeof by !== "string" || !by) throw new Error("registry: bad user");
      if (s.kind === "personal") throw new RegistryError("personal", "a personal space is never trashed");
      const k = idemEnter(key), trashed = s.trashedAt == null;
      let n = 0;
      if (trashed) {
        const at = now();
        Object.assign(s, { trashedAt: at, trashedBy: by });
        for (const b of boards.values()) if (b.space === s.id && b.trashedAt == null) { Object.assign(b, { trashedAt: at, trashedBy: by, trashedWith: s.id }); n++; }
      }
      idemPut(k, s.id + (trashed ? ":trashed:" + n : ":noop"));
      return { space: copy(s), trashed, boards: n };
    },
    async restoreSpace({ space, idem: key }) {
      const s = spaces.get(space);
      if (!s) throw new Error("registry: no such space");
      const k = idemEnter(key), restored = s.trashedAt != null;
      let n = 0;
      if (restored) {
        if (claimed.has("s\n" + s.id) || [...boards.values()].some(b => b.trashedWith === s.id && claimed.has("b\n" + b.id))) throw new RegistryError("purged", "the Space is being deleted for good");
        Object.assign(s, { trashedAt: null, trashedBy: null });
        for (const b of boards.values()) if (b.trashedWith === s.id) { Object.assign(b, { trashedAt: null, trashedBy: null, trashedWith: null }); n++; }
      }
      idemPut(k, s.id + (restored ? ":restored:" + n : ":noop"));
      return { space: copy(s), restored, boards: n };
    },
    async trashedBoards(tenant, { after = null, limit } = {}) {
      after = orgDefaults.cursor(after, "id");
      const n = smallLimit(limit, TRASH.page.default, TRASH.page.max);
      const rest = [...boards.values()].filter(b => b.tenant === tenant && b.trashedAt != null && b.trashedWith == null && !claimed.has("b\n" + b.id) && (after == null || b.id > after)).sort((a, b) => (a.id < b.id ? -1 : 1));
      return { boards: rest.slice(0, n).map(copy), next: rest.length > n ? rest[n - 1].id : null };
    },
    async trashedSpaces(tenant, { after = null, limit } = {}) {
      after = orgDefaults.cursor(after, "id");
      const n = smallLimit(limit, TRASH.page.default, TRASH.page.max);
      const rest = [...spaces.values()].filter(s => s.tenant === tenant && s.trashedAt != null && !claimed.has("s\n" + s.id) && (after == null || s.id > after)).sort((a, b) => (a.id < b.id ? -1 : 1));
      const size = id => Math.min([...boards.values()].filter(b => b.trashedWith === id).length, TRASH.sizeCap + 1);
      return { spaces: rest.slice(0, n).map(s => ({ ...copy(s), boards: size(s.id) })), next: rest.length > n ? rest[n - 1].id : null };
    },
    async trashDue({ before, limit, claimed: want, after } = {}) {
      if (!Number.isFinite(before)) throw new Error("registry: bad time");
      const n = smallLimit(limit, TRASH.due.default, TRASH.due.max);
      const byId = (a, b) => (a.id < b.id ? -1 : 1), oldest = (a, b) => a.trashedAt - b.trashedAt || byId(a, b);
      if (want === false) {   // due and unclaimed; a board that went with its Space follows its Space's claim
        const pick = (m, c) => [...m.values()].filter(x => x.trashedAt != null && x.trashedAt <= before && x.trashedWith == null && !claimed.has(c + "\n" + x.id)).sort(oldest).slice(0, n).map(copy);
        return { boards: pick(boards, "b"), spaces: pick(spaces, "s") };
      }
      if (want === true) {   // claimed, by id after the cursor: a stuck row cannot hold the head of the line
        const pick = (m, c, cur) => [...m.values()].filter(x => x.trashedAt != null && claimed.has(c + "\n" + x.id) && (cur == null || x.id > cur)).sort(byId).slice(0, n).map(copy);
        return { boards: pick(boards, "b", after?.board), spaces: pick(spaces, "s", after?.space) };
      }
      const due = (row, c) => row.trashedAt != null && (row.trashedAt <= before || claimed.has(c + "\n" + row.id));
      return { boards: [...boards.values()].filter(b => due(b, "b")).sort(oldest).slice(0, n).map(copy), spaces: [...spaces.values()].filter(s => due(s, "s")).sort(oldest).slice(0, n).map(copy) };
    },
    async purgeClaim({ type, id, before }) {
      if ((type !== "board" && type !== "space") || !Number.isFinite(before)) throw new Error("registry: bad purge");
      const row = (type === "board" ? boards : spaces).get(id), c = type === "board" ? "b" : "s";
      if (!row || row.trashedAt == null || !(row.trashedAt <= before || claimed.has(c + "\n" + id))) return false;
      if (type === "board" && row.trashedWith != null && !claimed.has("b\n" + id)) return false;   // a board that went with its Space is claimed only with it
      claimed.add(c + "\n" + id);
      if (type === "space") for (const b of boards.values()) if (b.trashedWith === id) claimed.add("b\n" + b.id);
      return true;
    },
    async purgeBoard(board) {
      const b = boards.get(board);
      if (!b) return true;
      if (!claimed.has("b\n" + board) || b.trashedAt == null) return false;
      grants.delete(board); scoped.delete(sk("board", board));
      for (const [id, i] of invites) if (i.board === board) invites.delete(id);
      for (const [id, l] of links) if (l.board === board) links.delete(id);
      for (const k of [...uses.keys()]) if (k.startsWith(board + "\n")) uses.delete(k);
      for (const m of [recent, stars]) for (const x of m.values()) x.delete(board);
      for (const k of [...requests.keys()]) if (k.startsWith("board\n" + board + "\n")) requests.delete(k);
      boards.delete(board); claimed.delete("b\n" + board);
      return true;
    },
    async purgeSpace(space) {
      const s = spaces.get(space);
      if (!s) return true;
      if (!claimed.has("s\n" + space) || [...boards.values()].some(b => b.space === space)) return false;
      scoped.delete(sk("space", space));
      for (const k of [...requests.keys()]) if (k.startsWith("space\n" + space + "\n")) requests.delete(k);
      spaces.delete(space); claimed.delete("s\n" + space);
      return true;
    },

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

    async createInvite({ board, email, role, expiresAt = null, by, idem: key }) {
      if (!boards.has(board)) throw new Error("registry: no such board");
      const k = idemEnter(key);
      const i = { id: fresh(invites, mint.invite), board, email: normEmail(email), role, expiresAt, revoked: false, by, createdAt: now() };
      invites.set(i.id, i);
      idemPut(k, i.id);
      return copy(i);
    },
    async invite(id) { return copy(invites.get(id)); },
    async invites(board) { return [...invites.values()].filter(i => i.board === board).map(copy); },
    async invitesFor(board, email) {
      const e = normEmail(email);
      return [...invites.values()].filter(i => i.board === board && i.email === e).map(copy);
    },
    async revokeInvite(id) { const i = invites.get(id); if (!i) return false; i.revoked = true; return true; },

    async createLink({ board, role, expiresAt = null, by, idem: key }) {
      if (!boards.has(board)) throw new Error("registry: no such board");
      const k = idemEnter(key);
      const l = { id: fresh(links, mint.link), board, role, expiresAt, revoked: false, by, createdAt: now() };
      links.set(l.id, l);
      idemPut(k, l.id);
      return copy(l);
    },
    async link(id) { return copy(links.get(id)); },
    async links(board) { return [...links.values()].filter(l => l.board === board).map(copy); },
    async revokeLink(id) { const l = links.get(id); if (!l) return false; l.revoked = true; return true; },

    async addLinkUse(link, user) {
      const l = links.get(link);
      if (!l) throw new Error("registry: no such link");
      if (boards.get(l.board)?.trashedAt != null) throw new RegistryError("in-trash", "the board is in Trash");
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

    async appendAudit({ tenant, board = null, actor, action, target = null, detail = null, at }) {
      if (typeof tenant !== "string" || !tenants.has(tenant)) throw new Error("registry: no such tenant");
      const rec = {
        id: ++auditSeq,
        tenant,
        board: board == null ? null : String(board),
        actor: String(actor),
        action: String(action),
        target: target == null ? null : String(target),
        detail: detail == null ? null : JSON.parse(JSON.stringify(detail)),
        at: Number.isFinite(at) ? Math.floor(at) : now(),
      };
      audits.push(rec);
      return copy(rec);
    },
    async listAudit({ tenant, board = null, limit = 50, before = null } = {}) {
      if (typeof tenant !== "string") return { events: [], nextBefore: null };
      if (board != null && typeof board !== "string") return { events: [], nextBefore: null };
      const cur = parseCursor(before);
      if (cur === "invalid") return { events: [], nextBefore: null };
      const cap = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)));
      const filtered = audits.filter(a =>
        a.tenant === tenant
        && (board == null || a.board === board)
        && (!cur || a.at < cur.at || (a.at === cur.at && a.id < cur.id)),
      ).sort((a, b) => (b.at !== a.at ? b.at - a.at : b.id - a.id));
      const hasMore = filtered.length > cap;
      const events = (hasMore ? filtered.slice(0, cap) : filtered).map(copy);
      const last = events[events.length - 1];
      return { events, nextBefore: hasMore ? `${last.at}:${last.id}` : null };
    },

    // ---- organization: Groups, Spaces, Teams, scoped grants, roles ----
    async createGroup({ tenant, name, generalRole = null, owner, idem: key }) {
      need(tenants.has(tenant), "tenant");
      noRemoved(tenant, owner);
      const k = idemEnter(key);
      const g = { id: fresh(groups, mint.group), tenant, name: orgDefaults.name(name), generalRole, createdAt: now() };
      groups.set(g.id, g);
      if (owner != null) putScoped("group", g.id, "user", String(owner), "owner");
      idemPut(k, g.id);
      return copy(g);
    },
    async group(id) { return copy(groups.get(id)); },
    async groups(tenant) { return [...groups.values()].filter(g => g.tenant === tenant).map(copy); },

    async createSpace({ tenant, name, group = null, generalRole = "viewer", owner, idem: key }) {
      need(tenants.has(tenant), "tenant");
      if (group != null) need(groups.get(group)?.tenant === tenant, "group");
      noRemoved(tenant, owner);
      const k = idemEnter(key);
      const sp = { id: fresh(spaces, mint.space), tenant, group, name: orgDefaults.name(name), kind: "shared", owner: null, generalRole, createdAt: now(), trashedAt: null, trashedBy: null, archivedAt: null };
      spaces.set(sp.id, sp);
      if (owner != null) putScoped("space", sp.id, "user", String(owner), "owner");
      idemPut(k, sp.id);
      return copy(sp);
    },
    async space(id) { return copy(spaces.get(id)); },
    async spaces(tenant) { return [...spaces.values()].filter(s => s.tenant === tenant && s.trashedAt == null).map(copy); },
    async spacesIn(group, { after = null, limit } = {}) {
      after = orgDefaults.cursor(after, "id");
      const n = pageLimit(limit), rest = [...spaces.values()].filter(s => s.group === group && s.trashedAt == null && (after == null || s.id > after)).sort((a, b) => (a.id < b.id ? -1 : 1));
      return { spaces: rest.slice(0, n).map(copy), next: rest.length > n ? rest[n - 1].id : null };
    },
    async rename(scope, name) {
      const { type, id } = orgDefaults.renamable(scope, ["board", "space", "group"]);
      const row = (type === "board" ? boards : type === "space" ? spaces : groups).get(id);
      need(row, type);
      if (type === "board") row.title = orgDefaults.title(name); else row.name = orgDefaults.name(name);
      return copy(row);
    },
    async updateScope(scope, patch) {
      const { type, id } = orgDefaults.renamable(scope, ["space", "group"]);
      const v = orgDefaults.patch(patch), row = (type === "space" ? spaces : groups).get(id);
      need(row, type);
      if (v.name !== undefined) row.name = v.name;
      if (v.generalRole !== undefined) row.generalRole = v.generalRole;
      return copy(row);
    },
    async personalSpace(tenant, user) { const sp = [...spaces.values()].find(s => s.tenant === tenant && s.owner === String(user)); return sp ? copy(sp) : null; },
    async ensurePersonalSpace(tenant, user) {
      need(tenants.has(tenant), "tenant");
      user = String(user);
      noRemoved(tenant, user);
      let sp = [...spaces.values()].find(s => s.tenant === tenant && s.owner === user);
      if (!sp) {
        sp = { id: fresh(spaces, mint.space), tenant, group: null, name: orgDefaults.personalName(user), kind: "personal", owner: user, generalRole: null, createdAt: now(), trashedAt: null, trashedBy: null, archivedAt: null };
        spaces.set(sp.id, sp);
        putScoped("space", sp.id, "user", user, "owner");
      }
      return copy(sp);
    },

    async createTeam({ tenant, name, idem: key }) {
      need(tenants.has(tenant), "tenant");
      const k = idemEnter(key);
      const tm = { id: fresh(teams, mint.team), tenant, name: orgDefaults.name(name), createdAt: now() };
      teams.set(tm.id, tm); members.set(tm.id, new Set());
      idemPut(k, tm.id);
      return copy(tm);
    },
    async team(id) { return copy(teams.get(id)); },
    async teams(tenant) { return [...teams.values()].filter(t => t.tenant === tenant).map(copy); },
    async setTeamMember(team, user, member) {
      need(teams.has(team), "team");
      const set = members.get(team), u = String(user);
      if (member) { noRemoved(teams.get(team).tenant, u); set.add(u); return; }
      // Removing the last member of a Team that is the only counted owner of a Group or Space would leave it ownerless.
      if (set.size === 1 && set.has(u)) for (const [k, g] of scoped) {
        const [type, ...id] = k.split("\n");
        if ((type === "group" || type === "space") && g.get(sk("team", team)) === "owner") {
          const counted = countedOwners(type, id.join("\n"));
          if (counted.length <= 1) throw new RegistryError("last-owner", `a ${type} keeps at least one owner`);
        }
      }
      set.delete(u);
    },
    async teamMembers(team) { return [...(members.get(team) ?? [])]; },
    async renameTeam(team, name) {
      const tm = teams.get(team);
      need(tm, "team");
      tm.name = orgDefaults.name(name);
      return copy(tm);
    },
    async deleteTeam(team) {
      need(teams.has(team), "team");
      // Check and write with no await in between: atomic in one JS process.
      if ((members.get(team)?.size ?? 0) > 0) for (const [k, g] of scoped) {
        const [type, ...id] = k.split("\n");
        if ((type === "group" || type === "space") && g.get(sk("team", team)) === "owner" && countedOwners(type, id.join("\n")).length <= 1)
          throw new RegistryError("last-owner", `a ${type} keeps at least one owner`);
      }
      for (const [k, g] of scoped) { g.delete(sk("team", team)); if (!g.size) scoped.delete(k); }
      members.delete(team); teams.delete(team);
    },
    async teamsPage(tenant, { after = null, limit, q = null } = {}) {
      const cur = orgDefaults.cursor(after, "id"), n = smallLimit(limit, TEAMS.page.default, TEAMS.page.max), like = likeOf(q), term = like && asciiFold(q.trim());
      const all = [...teams.values()].filter(t => t.tenant === tenant && (cur == null || t.id > cur) && (term == null || asciiFold(t.name).includes(term))).sort((a, b) => (a.id < b.id ? -1 : 1));
      const page = all.slice(0, n);
      return { teams: page.map(t => ({ ...copy(t), size: Math.min(members.get(t.id)?.size ?? 0, TEAMS.sizeCap + 1) })), next: all.length > n ? page[n - 1].id : null };
    },
    async teamsAmong(tenant, ids) {
      return [...new Set((ids ?? []).slice(0, TEAMS.among))].map(i => teams.get(i)).filter(t => t?.tenant === tenant).sort((a, b) => (a.id < b.id ? -1 : 1))
        .map(t => ({ ...copy(t), size: Math.min(members.get(t.id)?.size ?? 0, TEAMS.sizeCap + 1) }));
    },
    async teamMembersPage(team, { after = null, limit } = {}) {
      const cur = orgDefaults.cursor(after, "id"), n = smallLimit(limit, TEAMS.page.default, TEAMS.page.max);
      const all = [...(members.get(team) ?? [])].filter(u => cur == null || u > cur).sort();
      return { users: all.slice(0, n), next: all.length > n ? all[n - 1] : null };
    },
    async scopedGrant(scope, subject) {
      const { type, id } = orgDefaults.scope(scope), sub = orgDefaults.subject(subject);
      return scoped.get(sk(type, id))?.get(sk(sub.type, sub.id)) ?? null;
    },
    async scopedGrantsPage(scope, { after = null, limit } = {}) {
      const { type, id } = orgDefaults.scope(scope), cur = orgDefaults.cursor(after, "subject"), n = smallLimit(limit, TEAMS.page.default, TEAMS.page.max);
      const all = [...(scoped.get(sk(type, id)) ?? [])].filter(([k]) => cur == null || k > cur).sort(([a], [b]) => (a < b ? -1 : 1));
      const rows = all.slice(0, n).map(([k, role]) => { const [t, ...i] = k.split("\n"); return { subject: { type: t, id: i.join("\n") }, role }; });
      return { grants: rows, next: all.length > n ? all[n - 1][0] : null };
    },
    async touchMember(tenant, { user, name = null, email = null }) {
      need(tenants.has(tenant), "tenant");
      if (typeof user !== "string" || !user || user.includes("\0")) throw new Error("registry: bad user");
      const row = { user, name: profileText(name, 200), email: profileText(email, 320) };
      const m = directory.get(tenant) ?? new Map(); directory.set(tenant, m);
      const cur = m.get(user);
      if (!cur) m.set(user, row); else if (cur.name !== row.name || cur.email !== row.email) m.set(user, { ...cur, ...row });
    },
    async membersAmong(tenant, users) {
      const m = directory.get(tenant);
      return [...new Set((users ?? []).slice(0, TEAMS.among))].map(u => m?.get(u)).filter(Boolean).map(publicRow);
    },
    async findMembers(tenant, { q = null, limit } = {}) {
      const like = likeOf(q), term = like && asciiFold(q.trim()), n = smallLimit(limit, TEAMS.find.default, TEAMS.find.max);
      const hit = r => term == null || [r.name ?? "", r.email ?? "", r.user].some(x => asciiFold(x).includes(term));
      return [...(directory.get(tenant)?.values() ?? [])].filter(r => r.removedAt == null && hit(r)).sort((a, b) => ((a.name ?? a.user) + "\n" + a.user < (b.name ?? b.user) + "\n" + b.user ? -1 : 1)).slice(0, n).map(publicRow);
    },

    async setScopedGrant({ scope, subject, role }) {
      const { type, id } = orgDefaults.scope(scope), sub = orgDefaults.subject(subject), r = orgDefaults.grantRole(role);
      need(scopeTenant(type, id) != null, "scope");
      if (isCustomRoleId(r) && !roles.get(scopeTenant(type, id))?.has(r)) throw new RegistryError("no-role", "no such custom role in this Unit");
      if (sub.type === "user" && r != null) noRemoved(scopeTenant(type, id), sub.id);
      if (sub.type === "team") need(teams.get(sub.id)?.tenant === scopeTenant(type, id), "team");
      if (type === "board" && sub.type === "user") throw new Error("registry: a user's grant on a board is setGrant");
      const g = scoped.get(sk(type, id));
      // Check and write with no await in between: atomic in one JS process.
      if ((type === "group" || type === "space") && g?.get(sk(sub.type, sub.id)) === "owner" && r !== "owner") {
        const counted = countedOwners(type, id), me = sk(sub.type, sub.id);
        if (counted.includes(me) && counted.length <= 1) throw new RegistryError("last-owner", `a ${type} keeps at least one owner`);
      }
      putScoped(type, id, sub.type, sub.id, r);
    },
    async scopedGrants(scope) {
      const { type, id } = orgDefaults.scope(scope);
      return [...(scoped.get(sk(type, id)) ?? [])].map(([k, role]) => { const [t, ...i] = k.split("\n"); return { subject: { type: t, id: i.join("\n") }, role }; });
    },

    async createRole({ tenant, name, base = null, boardRole, permissions = [], max, idem: key }) {
      need(tenants.has(tenant), "tenant");
      const m = roles.get(tenant) ?? new Map(); roles.set(tenant, m);
      const k = idemEnter(key);
      if (max !== undefined && [...m.keys()].filter(i => i !== MEMBER_ROLE_ID).length >= max) throw new RegistryError("limit", "the Unit has the most custom roles it can");
      const r = { id: fresh(m, mint.role), tenant, name: orgDefaults.name(name), base, boardRole, permissions: [...permissions], createdAt: now() };
      m.set(r.id, r);
      idemPut(k, r.id);
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
    async deleteRole(tenant, id) {
      if (id === MEMBER_ROLE_ID) throw new Error("registry: bad role");
      need(roles.get(tenant)?.has(id), "role");
      for (const [sc, g] of scoped) for (const role of g.values()) if (role === id && ownScope(sc, tenant)) throw new RegistryError("in-use", "a grant still holds this role");
      roles.get(tenant).delete(id);
    },
    async roleUsage(tenant, ids, { cap } = {}) {
      if (typeof tenant !== "string" || (ids ?? []).includes(MEMBER_ROLE_ID)) throw new Error("registry: bad role");
      const c = capOf(cap, ROLE_LIMITS.usageCap), want = new Map([...new Set(ids ?? [])].slice(0, ROLE_LIMITS.custom + 1).map(i => [i, { places: 0, users: 0, teams: [] }])), seen = new Map([...want.keys()].map(i => [i, new Set()]));
      for (const [sc, g] of scoped) for (const [k, role] of g) {
        const u = want.get(role);
        if (!u || !ownScope(sc, tenant)) continue;
        if (u.places <= c) u.places++;
        if (k.startsWith("user\n")) { if (u.users <= c && !seen.get(role).has(k)) { seen.get(role).add(k); u.users++; } } else if (u.teams.length < ROLE_LIMITS.teamIds && !u.teams.includes(k.slice(5))) u.teams.push(k.slice(5));
      }
      for (const u of want.values()) u.teams.sort();
      return want;
    },
    async memberCount(tenant, { cap } = {}) { return Math.min(directory.get(tenant)?.size ?? 0, capOf(cap, ROLE_LIMITS.memberCap) + 1); },
    async role(tenant, id) { return copy(roles.get(tenant)?.get(id)); },
    async roles(tenant) { return [...(roles.get(tenant)?.values() ?? [])].map(copy); },

    async accessContext(scope, { users, chain } = {}) {
      const { type, id } = orgDefaults.scope(scope);
      const board = chain ? chain.board : type === "board" ? boards.get(id) : null;
      const space = chain ? chain.space : type === "space" ? spaces.get(id) : board?.space ? spaces.get(board.space) : null;
      const group = chain ? chain.group : type === "group" ? groups.get(id) : space?.group ? groups.get(space.group) : null;
      const tenant = chain ? chain.tenant : tenants.get(type === "unit" ? id : (board ?? space ?? group)?.tenant);
      if (!tenant || (type !== "unit" && !(board ?? space ?? group))) return null;
      const list = (t, i) => (i == null ? [] : [...(scoped.get(sk(t, i)) ?? [])].map(([k, role]) => { const [st, ...si] = k.split("\n"); return { subject: { type: st, id: si.join("\n") }, role }; }));
      const sc = { unit: list("unit", tenant.id), group: list("group", group?.id), space: list("space", space?.id), board: list("board", board?.id) };
      const teamIds = new Set(Object.values(sc).flat().filter(g => g.subject.type === "team").map(g => g.subject.id));
      const want = users ? new Set(users) : null;
      const inTeam = t => [...(members.get(t) ?? [])].filter(u => !want || want.has(u));
      const dir = directory.get(tenant.id);
      return copy({ tenant, board: board ?? null, space: space ?? null, group: group ?? null, scoped: sc,
        roles: [...(roles.get(tenant.id)?.values() ?? [])], teams: Object.fromEntries([...teamIds].map(t => [t, inTeam(t)])),
        removed: users ? [...new Set(users)].filter(u => dir?.get(u)?.removedAt != null).sort() : [] });
    },

    async accessContexts(scopes, { users } = {}) {
      const out = new Map();
      for (const sc of batchScopes(scopes)) out.set(sc.type + "\n" + sc.id, await this.accessContext(sc, { users }));
      return out;
    },

    // ---- Access requests (PROTOCOL.md § Access explanation and requests) ----
    async requestAccess({ tenant, scope, user, role, idem: key, limits, supersede }) {
      const lim = askLimits(limits);
      const sc = askScope(scope), r = askRole(role);
      need(typeof user === "string" && user && !user.includes("\0"), "member");
      const i = idemEnter(key);                      // the key first: a retried success replays even when a limit has since been reached
      need(typeof tenant === "string" && scopeTenant(sc.type, sc.id) === tenant, "scope");
      const t = now(), k = sk(sc.type, sk(sc.id, user));
      let pruned = 0;
      for (const [x, v] of requests) if (t - (v.closedAt ?? v.at) >= ASK.ttlMs && pruned++ < ASK.prune) requests.delete(x);
      const cur = askLive(requests.get(k), t);
      if (cur?.state === "pending" && !(supersede === true && cur.role !== r)) { idemPut(i, cur.id); return copy(cur); }
      if (cur && cur.state !== "pending") throw askLimited(askWait(cur, t));
      const mine = [...requests.values()].filter(v => v.user === user && v.tenant === tenant && t - v.at < ASK.windowMs && !(v.scope.type === sc.type && v.scope.id === sc.id));   // the row being replaced counts once, as the new ask
      if (mine.length >= lim.perUser) throw askLimited(Math.min(...mine.map(v => v.at)) + ASK.windowMs - t);
      if ([...requests.values()].filter(v => v.scope.type === sc.type && v.scope.id === sc.id && v.state === "pending" && v.user !== user).length >= lim.scopePending) throw askLimited(null);
      const ids = new Set([...requests.values()].map(v => v.id));
      let id;
      while (!id || ids.has(id)) id = mint.request();
      const row = { id, tenant, scope: sc, user, role: r, state: "pending", at: t, closedAt: null };
      requests.set(k, row);
      idemPut(i, row.id);
      return copy(row);
    },
    async accessRequest(scope, user) { return copy(askLive(requests.get(sk(scope.type, sk(scope.id, user))), now())); },
    async accessRequests(scope, { limit } = {}) {
      const sc = askScope(scope), t = now();
      return [...requests.values()].filter(v => v.scope.type === sc.type && v.scope.id === sc.id && v.state === "pending" && t - v.at < ASK.ttlMs)
        .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1)).slice(0, smallLimit(limit, ASK.page.default, ASK.page.max)).map(copy);
    },
    async closeAccessRequest(scope, user, state) {
      const sc = askScope(scope), k = sk(sc.type, sk(sc.id, user)), v = requests.get(k);
      if (state !== "dismissed" && state !== "granted") throw new Error("registry: bad state");
      if (!v) return false;
      const t = now(), was = v.state === "pending" && t - v.at < ASK.ttlMs;
      if (state === "granted") { v.state = "granted"; v.closedAt = t; } else if (was) { v.state = "dismissed"; v.closedAt = t; }
      return was;
    },
    async grantHolders(scope, rolesIn, { limit } = {}) {
      const sc = orgDefaults.scope(scope), want = new Set(rolesIn ?? []);
      return [...(scoped.get(sk(sc.type, sc.id)) ?? [])].filter(([, role]) => want.has(role))
        .map(([k, role]) => { const [st, ...si] = k.split("\n"); return { subject: { type: st, id: si.join("\n") }, role }; })
        .sort((a, b) => (a.subject.type + "\n" + a.subject.id < b.subject.type + "\n" + b.subject.id ? -1 : 1)).slice(0, smallLimit(limit, ASK.holders, ASK.holders));
    },

    // ---- Idempotent creates (PROTOCOL.md) ----
    async idemGet(o) {
      const i = idemOf(o);
      if (!i) throw new Error("registry: bad idempotency key");
      const e = idem.get(i.user + "\n" + i.key);
      return !idemLive(e, now()) ? { state: "none" } : e.fp !== i.fp ? { state: "mismatch" } : { state: "done", ref: e.ref };
    },
    /** The stored rows (tests). */ idemSize: () => idem.size,

    // ---- Home (PROTOCOL.md § Home) ----
    async markOpened(user, board) {
      if (!boards.has(board)) throw new Error("registry: no such board");
      if (!recent.has(user)) recent.set(user, new Map());
      const m = recent.get(user);
      m.set(board, now());
      for (const r of newest(m).slice(HOME.recentKeep)) m.delete(r.board);
    },
    async recents(user, { limit } = {}) { return newest(recent.get(user)).slice(0, smallLimit(limit, 12, HOME.recentKeep)); },
    async setStarred(user, board, on) {
      if (!on) { stars.get(user)?.delete(board); return; }
      if (!boards.has(board)) throw new Error("registry: no such board");
      if (!stars.has(user)) stars.set(user, new Map());
      if (!stars.get(user).has(board)) stars.get(user).set(board, now());
    },
    async starred(user, { limit } = {}) { return newest(stars.get(user)).slice(0, smallLimit(limit, 50, HOME.starScan)); },
    async starredAmong(user, ids) { const m = stars.get(user); return [...new Set(ids.slice(0, HOME.batch))].filter(b => m?.has(b)); },
    async sharedBoards(user, email, { limit } = {}) {
      const e = email ? normEmail(email) : null, out = new Set();
      const myTeams = [...members].filter(([, m]) => m.has(user)).map(([t]) => sk("team", t));
      for (const [b, g] of grants) if (g.has(user)) out.add(b);
      for (const [k, g] of scoped) if (k.startsWith("board\n") && myTeams.some(t => g.has(t))) out.add(k.slice(6));
      for (const i of invites.values()) if (e && i.email === e && !i.revoked) out.add(i.board);
      for (const [k, ls] of uses) if (k.endsWith("\n" + user) && ls.size) out.add(k.slice(0, k.length - user.length - 1));
      return [...out].filter(b => boards.has(b) && boards.get(b).trashedAt == null).sort().slice(0, smallLimit(limit, HOME.sharedScan, HOME.sharedScan));
    },
    async searchBoards(tenant, { q, after = null, scan } = {}) {
      after = orgDefaults.cursor(after, "id");
      const term = q == null ? null : asciiFold(searchQuery(q)), cap = smallLimit(scan, HOME.searchScan.default, HOME.searchScan.max);
      const hit = b => term == null || asciiFold(b.title).includes(term) || asciiFold(spaces.get(b.space)?.name ?? "").includes(term);
      const window = [...boards.values()].filter(b => b.tenant === tenant && b.trashedAt == null && (after == null || b.id > after)).map(b => b.id).sort().slice(0, cap + 1);
      const scanned = window.slice(0, cap);
      return { ids: scanned.filter(id => hit(boards.get(id))), next: window.length > cap ? scanned[cap - 1] : null };   // `next`: the Unit goes on past the window, whatever matched
    },
    async spaceCandidates(tenant, { user, all = false, personal = false, after = null, limit } = {}) {
      after = orgDefaults.cursor(after, "id");
      const n = smallLimit(limit, HOME.candidates.spaces.default, HOME.candidates.spaces.max);
      const mine = [sk("user", user), ...[...members].filter(([, m]) => m.has(user)).map(([t]) => sk("team", t))];
      const granted = (type, id) => { const g = scoped.get(sk(type, id)); return !!g && mine.some(k => g.has(k)); };
      const rows = [...spaces.values()].filter(sp => sp.tenant === tenant && sp.trashedAt == null && (after == null || sp.id > after) && (!personal || sp.kind === "personal")
        && (all || sp.generalRole != null || sp.owner === user || granted("space", sp.id)
          || (sp.group != null && (groups.get(sp.group)?.generalRole != null || granted("group", sp.group))))).sort((a, b) => (a.id < b.id ? -1 : 1));
      const page = rows.slice(0, n), gs = [...new Set(page.map(sp => sp.group).filter(Boolean))].map(g => groups.get(g)).filter(Boolean);
      return copy({ spaces: page, groups: gs, next: rows.length > n ? page[n - 1].id : null });
    },
    async groupCandidates(tenant, { user, all = false, limit } = {}) {
      const n = smallLimit(limit, HOME.candidates.groups.default, HOME.candidates.groups.max);
      const mine = [sk("user", user), ...[...members].filter(([, m]) => m.has(user)).map(([t]) => sk("team", t))];
      const granted = id => { const g = scoped.get(sk("group", id)); return !!g && mine.some(k => g.has(k)); };
      return copy([...groups.values()].filter(g => g.tenant === tenant && (all || g.generalRole != null || granted(g.id))).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, n));
    },
    async boardRows(ids, { user, email = null } = {}) {
      const out = new Map(), e = email ? normEmail(email) : null;
      for (const id of [...new Set(ids)].slice(0, HOME.batch)) {
        const board = boards.get(id);
        if (!board) continue;
        const teamGrants = [...(scoped.get(sk("board", id)) ?? [])].map(([k, role]) => { const [type, ...i] = k.split("\n"); return { subject: { type, id: i.join("\n") }, role }; });
        const myTeams = teamGrants.filter(g => g.subject.type === "team" && members.get(g.subject.id)?.has(user)).map(g => g.subject.id);
        const useIds = [...(uses.get(id + "\n" + user) ?? [])];
        out.set(id, copy({ board, grant: grants.get(id)?.get(user) ?? null, teamGrants, myTeams,
          invites: [...invites.values()].filter(i => e && i.board === id && i.email === e && !i.revoked),
          links: useIds.map(l => links.get(l)).filter(Boolean) }));
      }
      return out;
    },

    async boardsIn(scope, { after = null, limit, withTrashed = false } = {}) {
      const { type, id } = orgDefaults.scope(scope);
      after = orgDefaults.cursor(after, "id");
      if (type === "board") return { ids: [], next: null };
      const spaceIds = new Set([...spaces.values()].filter(sp => (type === "space" ? sp.id === id : type === "group" ? sp.group === id : false)).map(sp => sp.id));
      const all = [...boards.values()].filter(b => (withTrashed || b.trashedAt == null) && (type === "unit" ? b.tenant === id : spaceIds.has(b.space))).map(b => b.id).sort();
      const n = pageLimit(limit), rest = after == null ? all : all.filter(x => x > after), ids = rest.slice(0, n);
      return { ids, next: rest.length > n ? ids[n - 1] : null };
    },
    // ---- Leaver offboarding (PROTOCOL.md § Leaver offboarding). Every method below checks and writes with no await in between: atomic in one JS process. ----
    async memberState(tenant, user) {
      const r = directory.get(tenant)?.get(String(user));
      return r ? { user: r.user, name: r.name, email: r.email, removed: r.removedAt != null, removedAt: r.removedAt ?? null, removedBy: r.removedBy ?? null } : null;
    },
    async ownedAlone(tenant, user, { after = null, limit } = {}) {
      return aloneOf(tenant, String(user), orgDefaults.cursor(after, "scope"), smallLimit(limit, TEAMS.page.default, TEAMS.page.max));
    },
    async reassignOwner({ scope, from, to, name, idem: key }) {
      const sc = orgDefaults.renamable(scope, ["space", "group"]);
      const row = (sc.type === "space" ? spaces : groups).get(sc.id);
      need(row, sc.type);
      from = String(from); to = String(to);
      const dir = directory.get(row.tenant);
      if (from === to || !dir?.has(to) || dir.get(to).removedAt != null) throw new RegistryError("bad-recipient", "registry: the recipient is not a live member of the Unit");
      if (sc.type === "space" && row.kind === "personal") throw new RegistryError("personal", "registry: a personal space is handed over only by removeMember");
      const k = idemEnter(key);
      const done = soleOwner(sc.type, sc.id, from);
      if (done) {
        putScoped(sc.type, sc.id, "user", to, "owner");
        putScoped(sc.type, sc.id, "user", from, null);
      }
      idemPut(k, sc.id + (done ? ":reassigned" : ":noop"));
      return { done };
    },
    async removeMember({ tenant, user, by, handover, idem: key }) {
      need(tenants.has(tenant), "tenant");
      user = String(user);
      const row = directory.get(tenant)?.get(user);
      if (!row) throw new Error("registry: no such member");
      const k = idemEnter(key);
      if (row.removedAt != null) { idemPut(k, user + ":noop"); return { removed: false, grants: 0, scopedGrants: 0, teams: 0, invites: 0, handedOver: false }; }
      const adm = tenants.get(tenant).admins;
      if (adm.includes(user) || (row.email && adm.includes("email:" + normEmail(row.email)))) throw new RegistryError("is-admin", "registry: a Unit admin cannot be removed");
      // The personal space goes WITH the removal (never alone): `handover: { to, name }` makes it an archived Space owned by `to`, in this same step.
      const personal = [...spaces.values()].find(s => s.tenant === tenant && s.kind === "personal" && s.owner === user);
      let to = null;
      if (personal && handover) {
        to = String(handover.to);
        const rd = directory.get(tenant)?.get(to);
        if (to === user || !rd || rd.removedAt != null) throw new RegistryError("bad-recipient", "registry: the recipient is not a live member of the Unit");
      }
      if (aloneOf(tenant, user, null, 5).items.some(i => !(to && i.id === personal.id))) throw new RegistryError("still-owns", "registry: the member still solely owns something");
      if (to) {
        putScoped("space", personal.id, "user", to, "owner");
        Object.assign(personal, { kind: "shared", owner: null, archivedAt: now(), name: orgDefaults.name(handover.name ?? personal.name) });
      }
      // Invites addressed to the leaver's own email on this Unit's boards go with their grants (invites and links they CREATED stay).
      let inv = 0;
      const mail = row.email ? normEmail(row.email) : null;
      if (mail) for (const i of invites.values()) if (!i.revoked && boards.get(i.board)?.tenant === tenant && normEmail(i.email) === mail) { i.revoked = true; inv++; }
      let g = 0, sg = 0, t = 0;
      for (const [b, m] of grants) if (boards.get(b)?.tenant === tenant && m.delete(user)) g++;
      for (const [sk0, m] of scoped) if (ownScope(sk0, tenant) && m.delete(sk("user", user))) sg++;
      for (const [team, set] of members) if (teams.get(team)?.tenant === tenant && set.delete(user)) t++;
      for (const [rk, v] of [...requests]) if (v.tenant === tenant && v.user === user) requests.delete(rk);
      Object.assign(row, { removedAt: now(), removedBy: String(by) });
      idemPut(k, user + ":removed");
      return { removed: true, grants: g, scopedGrants: sg, teams: t, invites: inv, handedOver: !!to };
    },

    async personalScopesOf(subject, { limit = 50 } = {}) {
      const sub = orgDefaults.subject(subject), me = sk(sub.type, sub.id), n = Math.min(Math.max(Number.isSafeInteger(limit) ? limit : 50, 1), 50);
      const personal = (type, id) => spaces.get(type === "space" ? id : type === "board" ? boards.get(id)?.space : null)?.kind === "personal";
      const all = [...scoped].filter(([, g]) => g.has(me)).map(([k, g]) => { const [type, ...i] = k.split("\n"); return { type, id: i.join("\n"), role: g.get(me) }; })
        .filter(x => personal(x.type, x.id)).sort((x, y) => (x.type + "\n" + x.id < y.type + "\n" + y.id ? -1 : 1));
      return { scopes: all.slice(0, n), more: all.length > n };
    },

    async scopesOf(subject, { after = null, limit } = {}) {
      const sub = orgDefaults.subject(subject), me = sk(sub.type, sub.id);
      after = orgDefaults.cursor(after, "scope");
      const all = [...scoped].filter(([, g]) => g.has(me)).map(([k, g]) => { const [type, ...i] = k.split("\n"); return { type, id: i.join("\n"), role: g.get(me) }; })
        .sort((x, y) => (x.type + "\n" + x.id < y.type + "\n" + y.id ? -1 : 1));
      const cur = s => s.type + "\n" + s.id, n = pageLimit(limit), rest = after == null ? all : all.filter(x => cur(x) > after), page = rest.slice(0, n);
      return { scopes: page, next: rest.length > n ? cur(page[n - 1]) : null };
    },
  };
}
