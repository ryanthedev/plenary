// The Registry port on SQLite (PROTOCOL.md § Registry): tenants, boards, grants, invites, share links, link uses.
// Same contract and semantics as platform's in-memory adapter (server/auth/registry.js); method names are stable.
//
// Durable = WAL + synchronous=FULL (+ fullfsync on macOS), like server/store/sqlite.js: a resolved write survives a
// process crash and power loss. Every write runs in BEGIN IMMEDIATE, so the write lock is taken before any read the
// write depends on; two handles (two processes) on one file are serialised by SQLite itself.
//
// Last owner: `setGrant` reads the board's owners and writes in one IMMEDIATE transaction, so two concurrent
// demotions of a board's only two owners can't both pass; the second throws code "last-owner" and changes nothing.
//
// Lookups never throw on bad input: a garbage id resolves to null / [] (PROTOCOL.md § Auth: null = `auth`, a throw =
// `unavailable`). Only an infrastructure failure (or a closed registry) throws.
//
// SQL is kept plain so it ports to Postgres (phase 4): no rowid ordering, no INSERT OR IGNORE, no column named
// `user`; insertion order is an explicit `n` column (Postgres: BIGSERIAL / identity), upserts use ON CONFLICT.

import { Database } from "bun:sqlite";
import { mint } from "../auth/registry-port.js";
import { normEmail, capTo, higher, ROLES, INVITE_ROLES, LINK_ROLES } from "../auth/util.js";

/** Thrown by `setGrant` when the change would leave a board with no owner. Match on `err.code`. */
export class SqlRegistryError extends Error {
  /** @param {"last-owner"} code */
  constructor(code, message) { super(message); this.name = "RegistryError"; this.code = code; }
}

const str = v => typeof v === "string";
const parseCursor = before => {
  if (before == null || before === "") return null;
  if (typeof before !== "string") return "invalid";
  const m = /^(\d+):(\d+)$/.exec(before);
  return m ? { at: Number(m[1]), id: Number(m[2]) } : "invalid";
};

/**
 * Runs `f`, retrying while SQLite reports BUSY/LOCKED, with a short growing backoff (5 ms doubling, at most 100 ms,
 * plus jitter), until `deadline` (ms since epoch); then throws the last error. Only for start-up statements that
 * SQLite may refuse without consulting the busy handler. Blocks (start-up is synchronous).
 *
 * A hard cap: before each attempt `busy_timeout` is set to what is left of the budget, so a statement that waits in
 * SQLite's busy handler can't run past the deadline either, and no sleep runs past it. `f` always runs at least once.
 * The caller restores its own busy_timeout afterwards.
 */
function onBusyRetry(db, deadline, f) {
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    db.run(`PRAGMA busy_timeout=${Math.max(0, deadline - Date.now())}`);
    try { return f(); }
    catch (err) {
      const busy = typeof err?.code === "string" && (err.code.startsWith("SQLITE_BUSY") || err.code.startsWith("SQLITE_LOCKED"));
      const left = deadline - Date.now();
      if (!busy || left <= 0) throw err;
      Bun.sleepSync(Math.min(left, delay + Math.floor(Math.random() * delay)));
    }
  }
}

/**
 * @param {{ path: string, now?: () => number, fullfsync?: boolean, busyTimeoutMs?: number }} o
 *   `path` is a file (":memory:" for throwaway use).
 * @returns {import("../auth/registry-port.js").Registry & { close(): Promise<void>, pragmas(): object }}
 */
export function sqliteRegistry({ path, now = Date.now, fullfsync = true, busyTimeoutMs = 5000 }) {
  const db = new Database(path, { create: true, strict: true });
  let open = true;
  const wait = Math.max(0, Math.floor(busyTimeoutMs));
  db.run(`PRAGMA busy_timeout=${wait}`);
  // Several processes opening one brand-new file at once (N nodes or bootstrap scripts): switching to WAL needs an
  // exclusive lock, and SQLite returns BUSY for it without calling the busy handler, so busy_timeout alone doesn't
  // help (reproduced: ~1 in 10 of 12 simultaneous opens failed at this pragma). So: skip the switch once the file
  // already reads WAL (it is persistent), and retry it, and the first schema transaction, with a short backoff
  // until the same busy_timeout budget runs out, in total (onBusyRetry caps each attempt's busy wait at what is
  // left). Every later statement waits through the busy handler as usual, with the full busy_timeout again.
  const deadline = Date.now() + wait;
  onBusyRetry(db, deadline, () => {
    if (db.query("PRAGMA journal_mode").get()?.journal_mode !== "wal") db.run("PRAGMA journal_mode=WAL");
  });
  db.run("PRAGMA synchronous=FULL");
  db.run(`PRAGMA fullfsync=${fullfsync ? "ON" : "OFF"}`);
  db.run(`PRAGMA checkpoint_fullfsync=${fullfsync ? "ON" : "OFF"}`);
  db.run("PRAGMA foreign_keys=ON");

  onBusyRetry(db, deadline, () => db.transaction(() => {
    db.run(`CREATE TABLE IF NOT EXISTS reg_tenants (
      id TEXT PRIMARY KEY, name TEXT, domain TEXT UNIQUE, created_at INTEGER NOT NULL)`);
    const tenantCols = db.query("PRAGMA table_info(reg_tenants)").all();
    if (!tenantCols.some(c => c.name === "name")) db.run("ALTER TABLE reg_tenants ADD COLUMN name TEXT");
    db.run(`CREATE TABLE IF NOT EXISTS reg_tenant_admins (
      tenant TEXT NOT NULL REFERENCES reg_tenants(id), member TEXT NOT NULL, n INTEGER NOT NULL,
      PRIMARY KEY (tenant, member))`);
    db.run("CREATE INDEX IF NOT EXISTS reg_tenant_admins_member ON reg_tenant_admins (member)");
    db.run(`CREATE TABLE IF NOT EXISTS reg_tenant_members (
      tenant TEXT NOT NULL REFERENCES reg_tenants(id) ON DELETE CASCADE, email TEXT NOT NULL, added_at INTEGER NOT NULL,
      PRIMARY KEY (tenant, email))`);
    db.run("CREATE INDEX IF NOT EXISTS reg_tenant_members_email ON reg_tenant_members (email)");
    db.run(`CREATE TABLE IF NOT EXISTS reg_boards (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES reg_tenants(id), title TEXT NOT NULL,
      member_role TEXT, created_at INTEGER NOT NULL)`);
    db.run("CREATE INDEX IF NOT EXISTS reg_boards_tenant ON reg_boards (tenant, created_at DESC, id ASC)");
    db.run(`CREATE TABLE IF NOT EXISTS reg_grants (
      board TEXT NOT NULL REFERENCES reg_boards(id), member TEXT NOT NULL, role TEXT NOT NULL, n INTEGER NOT NULL,
      PRIMARY KEY (board, member))`);
    db.run("CREATE INDEX IF NOT EXISTS reg_grants_member ON reg_grants (member)");
    db.run(`CREATE TABLE IF NOT EXISTS reg_invites (
      n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, board TEXT NOT NULL REFERENCES reg_boards(id),
      email TEXT NOT NULL, role TEXT NOT NULL, expires_at INTEGER, revoked INTEGER NOT NULL, by_user TEXT,
      created_at INTEGER NOT NULL)`);
    db.run("CREATE INDEX IF NOT EXISTS reg_invites_board ON reg_invites (board, email)");
    db.run("CREATE INDEX IF NOT EXISTS reg_invites_email ON reg_invites (email)");
    db.run(`CREATE TABLE IF NOT EXISTS reg_links (
      n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, board TEXT NOT NULL REFERENCES reg_boards(id),
      role TEXT NOT NULL, expires_at INTEGER, revoked INTEGER NOT NULL, by_user TEXT, created_at INTEGER NOT NULL)`);
    db.run("CREATE INDEX IF NOT EXISTS reg_links_board ON reg_links (board)");
    db.run(`CREATE TABLE IF NOT EXISTS reg_link_uses (
      board TEXT NOT NULL, member TEXT NOT NULL, link TEXT NOT NULL REFERENCES reg_links(id), n INTEGER NOT NULL,
      PRIMARY KEY (board, member, link))`);
    db.run("CREATE INDEX IF NOT EXISTS reg_link_uses_member ON reg_link_uses (member)");
    db.run(`CREATE TABLE IF NOT EXISTS reg_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL REFERENCES reg_tenants(id), board TEXT,
      actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, at INTEGER NOT NULL)`);
    db.run("CREATE INDEX IF NOT EXISTS reg_audit_tenant ON reg_audit (tenant, at DESC, id DESC)");
    db.run("CREATE INDEX IF NOT EXISTS reg_audit_board ON reg_audit (tenant, board, at DESC, id DESC)");
  }).immediate());
  db.run(`PRAGMA busy_timeout=${wait}`);                     // start-up spent part of it; runtime gets the whole budget

  const q = {
    tenant: db.query("SELECT id, name, domain, created_at FROM reg_tenants WHERE id = ?"),
    tenantByDomain: db.query("SELECT id, name, domain, created_at FROM reg_tenants WHERE domain = ?"),
    personalTenants: db.query("SELECT id, name, domain, created_at FROM reg_tenants WHERE domain IS NULL ORDER BY created_at ASC, id ASC"),
    tenantExists: db.query("SELECT 1 AS x FROM reg_tenants WHERE id = ?"),
    insTenant: db.query("INSERT INTO reg_tenants (id, name, domain, created_at) VALUES (?, ?, ?, ?)"),
    admins: db.query("SELECT member FROM reg_tenant_admins WHERE tenant = ? ORDER BY n"),
    adminN: db.query("SELECT coalesce(max(n), 0) + 1 AS n FROM reg_tenant_admins WHERE tenant = ?"),
    insAdmin: db.query("INSERT INTO reg_tenant_admins (tenant, member, n) VALUES (?, ?, ?) ON CONFLICT (tenant, member) DO NOTHING"),
    insMember: db.query("INSERT INTO reg_tenant_members (tenant, email, added_at) VALUES (?, ?, ?) ON CONFLICT (tenant, email) DO NOTHING"),
    delMember: db.query("DELETE FROM reg_tenant_members WHERE tenant = ? AND email = ?"),
    members: db.query("SELECT email FROM reg_tenant_members WHERE tenant = ? ORDER BY email ASC"),
    isMember: db.query("SELECT 1 AS x FROM reg_tenant_members WHERE tenant = ? AND email = ?"),
    tenantsForMember: db.query("SELECT t.id, t.name, t.domain, t.created_at FROM reg_tenant_members m JOIN reg_tenants t ON t.id = m.tenant WHERE m.email = ? ORDER BY t.created_at ASC, t.id ASC"),
    tenantsForAdmin1: db.query("SELECT DISTINCT t.id, t.name, t.domain, t.created_at FROM reg_tenant_admins a JOIN reg_tenants t ON t.id = a.tenant WHERE a.member = ? ORDER BY t.created_at ASC, t.id ASC"),
    tenantsForAdmin2: db.query("SELECT DISTINCT t.id, t.name, t.domain, t.created_at FROM reg_tenant_admins a JOIN reg_tenants t ON t.id = a.tenant WHERE a.member IN (?, ?) ORDER BY t.created_at ASC, t.id ASC"),
    grantsForUserAll: db.query("SELECT b.id, b.tenant, b.title, b.member_role, b.created_at, g.role FROM reg_grants g JOIN reg_boards b ON b.id = g.board WHERE g.member = ?"),
    invitesForEmailAll: db.query("SELECT b.id, b.tenant, b.title, b.member_role, b.created_at, i.role, i.expires_at, i.revoked FROM reg_invites i JOIN reg_boards b ON b.id = i.board WHERE i.email = ?"),
    linksForUserAll: db.query("SELECT b.id, b.tenant, b.title, b.member_role, b.created_at, l.role, l.expires_at, l.revoked FROM reg_link_uses u JOIN reg_links l ON l.id = u.link JOIN reg_boards b ON b.id = l.board WHERE u.member = ?"),

    board: db.query("SELECT id, tenant, title, member_role, created_at FROM reg_boards WHERE id = ?"),
    boardsByTenant: db.query("SELECT id, tenant, title, member_role, created_at FROM reg_boards WHERE tenant = ? ORDER BY created_at DESC, id ASC"),
    boardExists: db.query("SELECT 1 AS x FROM reg_boards WHERE id = ?"),
    insBoard: db.query("INSERT INTO reg_boards (id, tenant, title, member_role, created_at) VALUES (?, ?, ?, ?, ?)"),
    updBoard: db.query("UPDATE reg_boards SET title = ?, member_role = ? WHERE id = ?"),
    delBoardUses: db.query("DELETE FROM reg_link_uses WHERE board = ? OR link IN (SELECT id FROM reg_links WHERE board = ?)"),
    delBoardLinks: db.query("DELETE FROM reg_links WHERE board = ?"),
    delBoardInvites: db.query("DELETE FROM reg_invites WHERE board = ?"),
    delBoardGrants: db.query("DELETE FROM reg_grants WHERE board = ?"),
    delBoard: db.query("DELETE FROM reg_boards WHERE id = ?"),

    grant: db.query("SELECT role FROM reg_grants WHERE board = ? AND member = ?"),
    grants: db.query("SELECT member, role FROM reg_grants WHERE board = ? ORDER BY n"),
    grantsForUserInTenant: db.query("SELECT g.board, g.role FROM reg_grants g JOIN reg_boards b ON b.id = g.board WHERE b.tenant = ? AND g.member = ?"),
    owners: db.query("SELECT count(*) AS c FROM reg_grants WHERE board = ? AND role = 'owner'"),
    grantN: db.query("SELECT coalesce(max(n), 0) + 1 AS n FROM reg_grants WHERE board = ?"),
    upGrant: db.query(`INSERT INTO reg_grants (board, member, role, n) VALUES (?, ?, ?, ?)
      ON CONFLICT (board, member) DO UPDATE SET role = excluded.role`),
    delGrant: db.query("DELETE FROM reg_grants WHERE board = ? AND member = ?"),

    invite: db.query("SELECT * FROM reg_invites WHERE id = ?"),
    invites: db.query("SELECT * FROM reg_invites WHERE board = ? ORDER BY n"),
    invitesFor: db.query("SELECT * FROM reg_invites WHERE board = ? AND email = ? ORDER BY n"),
    invitesForEmailInTenant: db.query("SELECT i.board, i.role, i.expires_at, i.revoked FROM reg_invites i JOIN reg_boards b ON b.id = i.board WHERE b.tenant = ? AND i.email = ?"),
    insInvite: db.query(`INSERT INTO reg_invites (id, board, email, role, expires_at, revoked, by_user, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)`),
    revokeInvite: db.query("UPDATE reg_invites SET revoked = 1 WHERE id = ?"),

    link: db.query("SELECT * FROM reg_links WHERE id = ?"),
    links: db.query("SELECT * FROM reg_links WHERE board = ? ORDER BY n"),
    linksForUserInTenant: db.query("SELECT l.board, l.role, l.expires_at, l.revoked FROM reg_link_uses u JOIN reg_links l ON l.id = u.link JOIN reg_boards b ON b.id = l.board WHERE b.tenant = ? AND u.member = ?"),
    insLink: db.query(`INSERT INTO reg_links (id, board, role, expires_at, revoked, by_user, created_at)
      VALUES (?, ?, ?, ?, 0, ?, ?)`),
    revokeLink: db.query("UPDATE reg_links SET revoked = 1 WHERE id = ?"),

    useN: db.query("SELECT coalesce(max(n), 0) + 1 AS n FROM reg_link_uses WHERE board = ? AND member = ?"),
    insUse: db.query("INSERT INTO reg_link_uses (board, member, link, n) VALUES (?, ?, ?, ?) ON CONFLICT (board, member, link) DO NOTHING"),
    uses: db.query("SELECT link FROM reg_link_uses WHERE board = ? AND member = ? ORDER BY n"),
    usesFor: db.query("SELECT member, link FROM reg_link_uses WHERE board = ? AND member IN (SELECT value FROM json_each(?)) ORDER BY member, n"),

    insAudit: db.query(`INSERT INTO reg_audit (tenant, board, actor, action, target, detail, at)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, tenant, board, actor, action, target, detail, at`),
    auditTenant: db.query("SELECT id, tenant, board, actor, action, target, detail, at FROM reg_audit WHERE tenant = ? ORDER BY at DESC, id DESC LIMIT ?"),
    auditTenantBefore: db.query("SELECT id, tenant, board, actor, action, target, detail, at FROM reg_audit WHERE tenant = ? AND (at < ? OR (at = ? AND id < ?)) ORDER BY at DESC, id DESC LIMIT ?"),
    auditBoard: db.query("SELECT id, tenant, board, actor, action, target, detail, at FROM reg_audit WHERE tenant = ? AND board = ? ORDER BY at DESC, id DESC LIMIT ?"),
    auditBoardBefore: db.query("SELECT id, tenant, board, actor, action, target, detail, at FROM reg_audit WHERE tenant = ? AND board = ? AND (at < ? OR (at = ? AND id < ?)) ORDER BY at DESC, id DESC LIMIT ?"),
  };

  const ready = () => { if (!open) throw new Error("registry: closed"); };
  /** A fresh server-minted id: retried on the (astronomically rare) collision. */
  const fresh = (f, exists) => { let id; do id = f(); while (exists(id)); return id; };

  const rowTenant = r => r && { id: r.id, name: r.name ?? r.domain ?? "Personal Workspace", domain: r.domain, admins: q.admins.all(r.id).map(a => a.member), createdAt: r.created_at };
  const rowBoard = r => r && { id: r.id, tenant: r.tenant, title: r.title, memberRole: r.member_role, createdAt: r.created_at };
  const rowInvite = r => r && { id: r.id, board: r.board, email: r.email, role: r.role, expiresAt: r.expires_at, revoked: !!r.revoked, by: r.by_user, createdAt: r.created_at };
  const rowLink = r => r && { id: r.id, board: r.board, role: r.role, expiresAt: r.expires_at, revoked: !!r.revoked, by: r.by_user, createdAt: r.created_at };
  const rowAudit = r => r && { id: r.id, tenant: r.tenant, board: r.board, actor: r.actor, action: r.action, target: r.target, detail: r.detail == null ? null : JSON.parse(r.detail), at: r.at };
  // undefined → null (bun:sqlite refuses undefined bindings); everything else as given.
  const nz = v => (v === undefined ? null : v);

  const createTenantTx = db.transaction((name, domain, admins, createdAt) => {
    if (domain && q.tenantByDomain.get(domain)) throw new Error("registry: domain already has a tenant");
    const id = fresh(mint.tenant, i => !!q.tenantExists.get(i));
    q.insTenant.run(id, name, domain, createdAt);
    for (const a of admins) q.insAdmin.run(id, a, q.adminN.get(id).n);
    return rowTenant(q.tenant.get(id));
  });

  const addAdminTx = db.transaction((tenant, user) => {
    if (!q.tenantExists.get(tenant)) throw new Error("registry: no such tenant");
    q.insAdmin.run(tenant, user, q.adminN.get(tenant).n);
  });

  const addMemberTx = db.transaction((tenant, email, addedAt) => {
    if (!q.tenantExists.get(tenant)) throw new Error("registry: no such tenant");
    return { added: q.insMember.run(tenant, email, addedAt).changes > 0 };
  });

  const createBoardTx = db.transaction((tenant, title, memberRole, createdAt) => {
    if (!q.tenantExists.get(tenant)) throw new Error("registry: no such tenant");
    const id = fresh(mint.board, i => !!q.boardExists.get(i));
    q.insBoard.run(id, tenant, title, memberRole, createdAt);
    return rowBoard(q.board.get(id));
  });

  const updateBoardTx = db.transaction((id, hasTitle, nextTitle, hasRole, nextMemberRole) => {
    const cur = q.board.get(id);
    if (!cur) return null;
    const t = hasTitle ? nextTitle : cur.title;
    const r = hasRole ? nextMemberRole : cur.member_role;
    q.updBoard.run(t, r, id);
    return rowBoard(q.board.get(id));
  });

  const deleteBoardTx = db.transaction(id => {
    if (!q.boardExists.get(id)) return false;
    q.delBoardUses.run(id, id);
    q.delBoardLinks.run(id);
    q.delBoardInvites.run(id);
    q.delBoardGrants.run(id);
    return q.delBoard.run(id).changes > 0;
  });

  // The last-owner check and the write share one IMMEDIATE transaction (the write lock is held from the first read).
  const setGrantTx = db.transaction((board, user, role) => {
    if (!q.boardExists.get(board)) throw new Error("registry: no such board");
    const cur = q.grant.get(board, user)?.role ?? null;
    if (cur === "owner" && role !== "owner" && q.owners.get(board).c <= 1)
      throw new SqlRegistryError("last-owner", "a board keeps at least one owner");
    if (role == null) q.delGrant.run(board, user);
    else q.upGrant.run(board, user, role, q.grantN.get(board).n);
  });

  const createInviteTx = db.transaction((board, email, role, expiresAt, by, createdAt) => {
    if (!q.boardExists.get(board)) throw new Error("registry: no such board");
    const id = fresh(mint.invite, i => !!q.invite.get(i));
    q.insInvite.run(id, board, email, role, expiresAt, by, createdAt);
    return rowInvite(q.invite.get(id));
  });

  const createLinkTx = db.transaction((board, role, expiresAt, by, createdAt) => {
    if (!q.boardExists.get(board)) throw new Error("registry: no such board");
    const id = fresh(mint.link, i => !!q.link.get(i));
    q.insLink.run(id, board, role, expiresAt, by, createdAt);
    return rowLink(q.link.get(id));
  });

  const addUseTx = db.transaction((link, user) => {
    const l = q.link.get(link);
    if (!l) throw new Error("registry: no such link");
    q.insUse.run(l.board, user, link, q.useN.get(l.board, user).n);
  });

  const appendAuditTx = db.transaction((tenant, board, actor, action, target, detail, at) => {
    if (!q.tenantExists.get(tenant)) throw new Error("registry: no such tenant");
    return rowAudit(q.insAudit.get(tenant, board, actor, action, target, detail, at));
  });

  return {
    async createTenant({ name = null, domain, admins = [] }) {
      ready();
      const d = domain ? String(domain).toLowerCase() : null;
      const trimmedName = typeof name === "string" ? name.trim() : "";
      const n = trimmedName || d || "Personal Workspace";
      return createTenantTx.immediate(n, d, [...admins].map(String), now());
    },
    async tenant(id) { ready(); return str(id) ? rowTenant(q.tenant.get(id)) ?? null : null; },
    async tenantByDomain(domain) {
      ready();
      return str(domain) && domain ? rowTenant(q.tenantByDomain.get(domain.toLowerCase())) ?? null : null;
    },
    async listPersonalTenants() {
      ready();
      return q.personalTenants.all().map(rowTenant);
    },
    async addTenantAdmin(tenant, user) {
      ready();
      if (!str(tenant)) throw new Error("registry: no such tenant");
      addAdminTx.immediate(tenant, String(user));
    },
    async addTenantMember(tenant, email) {
      ready();
      if (!str(tenant)) throw new Error("registry: no such tenant");
      const e = normEmail(email);
      if (!e) throw new Error("registry: bad email");
      return addMemberTx.immediate(tenant, e, now());
    },
    async removeTenantMember(tenant, email) {
      ready();
      const e = normEmail(email);
      return str(tenant) && e ? q.delMember.run(tenant, e).changes > 0 : false;
    },
    async isTenantMember(tenant, email) {
      ready();
      const e = normEmail(email);
      return Boolean(str(tenant) && e && q.isMember.get(tenant, e));
    },
    async tenantMembers(tenant) {
      ready();
      return str(tenant) ? q.members.all(tenant).map(r => r.email) : [];
    },
    async tenantsForMember(email) {
      ready();
      const e = normEmail(email);
      return e ? q.tenantsForMember.all(e).map(rowTenant) : [];
    },
    async tenantsForAdmin(user, email = null) {
      ready();
      if (!str(user) || !user) return [];
      const e = normEmail(email);
      const rows = e ? q.tenantsForAdmin2.all(user, "email:" + e) : q.tenantsForAdmin1.all(user);
      return rows.map(rowTenant);
    },

    async createBoard({ tenant, title = "", memberRole = "viewer" }) {
      ready();
      if (!str(tenant)) throw new Error("registry: no such tenant");
      return createBoardTx.immediate(tenant, String(title), nz(memberRole), now());
    },
    async updateBoard(id, patch = {}) {
      ready();
      const hasTitle = patch != null && patch.title !== undefined;
      const hasRole = patch != null && patch.memberRole !== undefined;
      let nextTitle = null;
      if (hasTitle) {
        if (typeof patch.title !== "string") throw new Error("registry: bad title");
        nextTitle = patch.title.trim().slice(0, 200);
      }
      let nextMemberRole = null;
      if (hasRole) {
        if (patch.memberRole === null || patch.memberRole === "none") nextMemberRole = null;
        else if (typeof patch.memberRole === "string" && INVITE_ROLES.includes(patch.memberRole)) nextMemberRole = patch.memberRole;
        else throw new Error("registry: bad memberRole");
      }
      if (!str(id)) return null;
      return updateBoardTx.immediate(id, hasTitle, nextTitle, hasRole, nextMemberRole);
    },
    async deleteBoard(id) {
      ready();
      if (!str(id)) return false;
      return deleteBoardTx.immediate(id);
    },
    async board(id) { ready(); return str(id) ? rowBoard(q.board.get(id)) ?? null : null; },
    async listBoards(tenant) {
      ready();
      return str(tenant) ? q.boardsByTenant.all(tenant).map(rowBoard) : [];
    },
    async listBoardsFor(tenant, user, { email = null, isMember = true, at } = {}) {
      ready();
      if (!str(tenant) || !str(user)) return [];
      const boards = q.boardsByTenant.all(tenant).map(rowBoard);
      if (!boards.length) return [];
      const t = Number.isFinite(at) ? at : now();
      const grantsBy = new Map(q.grantsForUserInTenant.all(tenant, user).map(r => [r.board, r.role]));
      const linksBy = new Map();
      for (const r of q.linksForUserInTenant.all(tenant, user)) {
        if (!linksBy.has(r.board)) linksBy.set(r.board, []);
        linksBy.get(r.board).push(r);
      }
      const invitesBy = new Map();
      const e = normEmail(email);
      if (e) {
        for (const r of q.invitesForEmailInTenant.all(tenant, e)) {
          if (!invitesBy.has(r.board)) invitesBy.set(r.board, []);
          invitesBy.get(r.board).push(r);
        }
      }
      const out = [];
      for (const b of boards) {
        let r = capTo(grantsBy.get(b.id) ?? null, ROLES);
        for (const i of invitesBy.get(b.id) ?? [])
          if (!i.revoked && (i.expires_at == null || t < i.expires_at)) r = higher(r, capTo(i.role, INVITE_ROLES));
        for (const l of linksBy.get(b.id) ?? [])
          if (!l.revoked && (l.expires_at == null || t < l.expires_at)) r = higher(r, capTo(l.role, LINK_ROLES));
        if (isMember && b.memberRole) r = higher(r, capTo(b.memberRole, INVITE_ROLES));
        if (r != null) out.push({ ...b, role: r });
      }
      return out;
    },
    async boardsForUser(user, email = null, { at } = {}) {
      ready();
      if (!str(user) || !user) return [];
      const t = Number.isFinite(at) ? at : now();
      const e = normEmail(email);
      const byId = new Map();
      const bump = (row, role) => {
        if (!role) return;
        const cur = byId.get(row.id);
        if (!cur) byId.set(row.id, { ...rowBoard(row), role });
        else cur.role = higher(cur.role, role);
      };
      for (const r of q.grantsForUserAll.all(user)) bump(r, capTo(r.role, ROLES));
      if (e) {
        for (const r of q.invitesForEmailAll.all(e)) {
          if (!r.revoked && (r.expires_at == null || t < r.expires_at)) bump(r, capTo(r.role, INVITE_ROLES));
        }
      }
      for (const r of q.linksForUserAll.all(user)) {
        if (!r.revoked && (r.expires_at == null || t < r.expires_at)) bump(r, capTo(r.role, LINK_ROLES));
      }
      return [...byId.values()].sort((a, b) => (b.createdAt !== a.createdAt ? b.createdAt - a.createdAt : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },

    async setGrant(board, user, role) {
      ready();
      if (!str(board)) throw new Error("registry: no such board");
      setGrantTx.immediate(board, String(user), nz(role));
    },
    async grant(board, user) {
      ready();
      return str(board) && str(user) ? q.grant.get(board, user)?.role ?? null : null;
    },
    async grants(board) {
      ready();
      return str(board) ? q.grants.all(board).map(r => ({ user: r.member, role: r.role })) : [];
    },

    async createInvite({ board, email, role, expiresAt = null, by }) {
      ready();
      if (!str(board)) throw new Error("registry: no such board");
      return createInviteTx.immediate(board, normEmail(email), role, nz(expiresAt), nz(by), now());
    },
    async invite(id) { ready(); return str(id) ? rowInvite(q.invite.get(id)) ?? null : null; },
    async invites(board) { ready(); return str(board) ? q.invites.all(board).map(rowInvite) : []; },
    async invitesFor(board, email) {
      ready();
      const e = normEmail(email);
      return str(board) && e != null ? q.invitesFor.all(board, e).map(rowInvite) : [];
    },
    async revokeInvite(id) { ready(); return str(id) ? q.revokeInvite.run(id).changes > 0 : false; },

    async createLink({ board, role, expiresAt = null, by }) {
      ready();
      if (!str(board)) throw new Error("registry: no such board");
      return createLinkTx.immediate(board, role, nz(expiresAt), nz(by), now());
    },
    async link(id) { ready(); return str(id) ? rowLink(q.link.get(id)) ?? null : null; },
    async links(board) { ready(); return str(board) ? q.links.all(board).map(rowLink) : []; },
    async revokeLink(id) { ready(); return str(id) ? q.revokeLink.run(id).changes > 0 : false; },

    async addLinkUse(link, user) {
      ready();
      if (!str(link)) throw new Error("registry: no such link");
      addUseTx.immediate(link, String(user));
    },
    async linkUses(board, user) {
      ready();
      return str(board) && str(user) ? q.uses.all(board, user).map(r => r.link) : [];
    },
    // The optional batch (registry-port.js): one query, the users bound as one JSON array.
    async linkUsesFor(board, users) {
      ready();
      const out = new Map();
      const us = (users ?? []).filter(str);
      if (!str(board) || !us.length) return out;
      for (const r of q.usesFor.all(board, JSON.stringify(us))) { if (!out.has(r.member)) out.set(r.member, []); out.get(r.member).push(r.link); }
      return out;
    },

    async appendAudit({ tenant, board = null, actor, action, target = null, detail = null, at }) {
      ready();
      if (!str(tenant)) throw new Error("registry: no such tenant");
      const ts = Number.isFinite(at) ? Math.floor(at) : now();
      return appendAuditTx.immediate(
        tenant,
        board == null ? null : String(board),
        String(actor),
        String(action),
        target == null ? null : String(target),
        detail == null ? null : JSON.stringify(detail),
        ts,
      );
    },
    async listAudit({ tenant, board = null, limit = 50, before = null } = {}) {
      ready();
      if (!str(tenant)) return { events: [], nextBefore: null };
      if (board != null && !str(board)) return { events: [], nextBefore: null };
      const cur = parseCursor(before);
      if (cur === "invalid") return { events: [], nextBefore: null };
      const cap = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)));
      const rows = board == null
        ? (cur ? q.auditTenantBefore.all(tenant, cur.at, cur.at, cur.id, cap + 1) : q.auditTenant.all(tenant, cap + 1))
        : (cur ? q.auditBoardBefore.all(tenant, board, cur.at, cur.at, cur.id, cap + 1) : q.auditBoard.all(tenant, board, cap + 1));
      const hasMore = rows.length > cap;
      const events = (hasMore ? rows.slice(0, cap) : rows).map(rowAudit);
      const last = events[events.length - 1];
      return { events, nextBefore: hasMore ? `${last.at}:${last.id}` : null };
    },

    /** What the registry was opened with, read back from SQLite (for /health and tests). */
    pragmas() {
      const one = name => Object.values(db.query(`PRAGMA ${name}`).get())[0];
      return { journal_mode: one("journal_mode"), synchronous: one("synchronous"), fullfsync: one("fullfsync"), busy_timeout: one("busy_timeout") };
    },

    async close() { if (!open) return; open = false; db.close(); },
  };
}

/** The name the p3-registry brief used. */
export const createSqliteRegistry = sqliteRegistry;
