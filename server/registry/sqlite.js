// The Registry port on SQLite (PROTOCOL.md § Registry): tenants (Units), boards, grants, invites, share links, link uses, and
// the board organization (Groups, Spaces, Teams, scoped grants, roles, `accessContext`). Start-up only ever ADDS tables
// (CREATE TABLE IF NOT EXISTS), so opening a database from before the organization is the whole migration, and re-running it is a no-op.
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
import { batchScopes, mint, KINDS, domainList, orgDefaults, MEMBER_ROLE_ID, DEFAULT_MEMBER_PERMS, pageLimit, HOME, smallLimit, searchQuery, asciiFold } from "../auth/registry-port.js";
import { normEmail } from "../auth/util.js";

/** Thrown by `setGrant` when the change would leave a board with no owner. Match on `err.code`. */
export class SqlRegistryError extends Error {
  /** @param {"last-owner"} code */
  constructor(code, message) { super(message); this.name = "RegistryError"; this.code = code; }
}

const str = v => typeof v === "string";

/**
 * Runs `f`, retrying while SQLite reports BUSY/LOCKED, with a short growing backoff (5 ms doubling, at most 100 ms,
 * plus jitter), until `deadline` (ms since epoch); then throws the last error. Only for start-up statements that
 * SQLite may refuse without consulting the busy handler. Blocks (start-up is synchronous).
 *
 * A hard cap: before each attempt `busy_timeout` is set to what is left of the budget, so a statement that waits in
 * SQLite's busy handler can't run past the deadline either, and no sleep runs past it. `f` always runs at least once.
 * The caller restores its own busy_timeout afterwards.
 */
function onBusyRetry(db, deadline, f, clock = Date.now, onAttempt) {
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    const budget = Math.max(0, deadline - clock());
    onAttempt?.(budget);
    db.run(`PRAGMA busy_timeout=${budget}`);
    try { return f(); }
    catch (err) {
      const busy = typeof err?.code === "string" && (err.code.startsWith("SQLITE_BUSY") || err.code.startsWith("SQLITE_LOCKED"));
      const left = deadline - clock();
      if (!busy || left <= 0) throw err;
      Bun.sleepSync(Math.min(left, delay + Math.floor(Math.random() * delay)));
    }
  }
}

/**
 * @param {{ path: string, now?: () => number, fullfsync?: boolean, busyTimeoutMs?: number,
 *   busy?: { clock?: () => number, onAttempt?: (budgetMs: number) => void } }} o
 *   `path` is a file (":memory:" for throwaway use). `busy` (tests): the clock the start-up budget is read on
 *   (default Date.now) and a hook told the busy_timeout each start-up attempt was given.
 * @returns {import("../auth/registry-port.js").Registry & { close(): Promise<void>, pragmas(): object }}
 */
export function sqliteRegistry({ path, now = Date.now, fullfsync = true, busyTimeoutMs = 5000, busy = {} }) {
  const { clock = Date.now, onAttempt } = busy;
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
  const deadline = clock() + wait;
  onBusyRetry(db, deadline, () => {
    if (db.query("PRAGMA journal_mode").get()?.journal_mode !== "wal") db.run("PRAGMA journal_mode=WAL");
  }, clock, onAttempt);
  db.run("PRAGMA synchronous=FULL");
  db.run(`PRAGMA fullfsync=${fullfsync ? "ON" : "OFF"}`);
  db.run(`PRAGMA checkpoint_fullfsync=${fullfsync ? "ON" : "OFF"}`);
  db.run("PRAGMA foreign_keys=ON");

  onBusyRetry(db, deadline, () => db.transaction(() => {
    db.run(`CREATE TABLE IF NOT EXISTS reg_tenants (
      id TEXT PRIMARY KEY, domain TEXT UNIQUE, created_at INTEGER NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS reg_tenant_admins (
      tenant TEXT NOT NULL REFERENCES reg_tenants(id), member TEXT NOT NULL, n INTEGER NOT NULL,
      PRIMARY KEY (tenant, member))`);
    db.run(`CREATE TABLE IF NOT EXISTS reg_boards (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES reg_tenants(id), title TEXT NOT NULL,
      member_role TEXT, created_at INTEGER NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS reg_grants (
      board TEXT NOT NULL REFERENCES reg_boards(id), member TEXT NOT NULL, role TEXT NOT NULL, n INTEGER NOT NULL,
      PRIMARY KEY (board, member))`);
    db.run(`CREATE TABLE IF NOT EXISTS reg_invites (
      n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, board TEXT NOT NULL REFERENCES reg_boards(id),
      email TEXT NOT NULL, role TEXT NOT NULL, expires_at INTEGER, revoked INTEGER NOT NULL, by_user TEXT,
      created_at INTEGER NOT NULL)`);
    db.run("CREATE INDEX IF NOT EXISTS reg_tenant_admins_member ON reg_tenant_admins (member)");
    db.run("CREATE INDEX IF NOT EXISTS reg_invites_board ON reg_invites (board, email)");
    db.run(`CREATE TABLE IF NOT EXISTS reg_links (
      n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, board TEXT NOT NULL REFERENCES reg_boards(id),
      role TEXT NOT NULL, expires_at INTEGER, revoked INTEGER NOT NULL, by_user TEXT, created_at INTEGER NOT NULL)`);
    db.run("CREATE INDEX IF NOT EXISTS reg_links_board ON reg_links (board)");
    db.run(`CREATE TABLE IF NOT EXISTS reg_link_uses (
      board TEXT NOT NULL, member TEXT NOT NULL, link TEXT NOT NULL REFERENCES reg_links(id), n INTEGER NOT NULL,
      PRIMARY KEY (board, member, link))`);
    // Board organization (additive: new tables only, so a database from before it opens unchanged; every statement is
    // IF NOT EXISTS, so re-running start-up is a no-op). Existing boards stay unfiled (no reg_board_spaces row), existing
    // tenants read as kind "company" with their one domain, and nothing about anyone's access changes.
    db.run("CREATE TABLE IF NOT EXISTS reg_tenant_meta (tenant TEXT PRIMARY KEY REFERENCES reg_tenants(id), kind TEXT NOT NULL)");
    db.run(`CREATE TABLE IF NOT EXISTS reg_tenant_domains (
      domain TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES reg_tenants(id), n INTEGER NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS reg_groups (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES reg_tenants(id), name TEXT NOT NULL, general_role TEXT, created_at INTEGER NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS reg_spaces (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES reg_tenants(id), grp TEXT REFERENCES reg_groups(id), name TEXT NOT NULL,
      kind TEXT NOT NULL, owner_user TEXT, general_role TEXT, created_at INTEGER NOT NULL, UNIQUE (tenant, owner_user))`);
    db.run(`CREATE TABLE IF NOT EXISTS reg_board_spaces (
      board TEXT PRIMARY KEY REFERENCES reg_boards(id), space TEXT NOT NULL REFERENCES reg_spaces(id))`);
    db.run(`CREATE TABLE IF NOT EXISTS reg_teams (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES reg_tenants(id), name TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS reg_team_members (
      team TEXT NOT NULL REFERENCES reg_teams(id), member TEXT NOT NULL, PRIMARY KEY (team, member))`);
    db.run(`CREATE TABLE IF NOT EXISTS reg_scope_grants (
      scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, subject_type TEXT NOT NULL, subject TEXT NOT NULL, role TEXT NOT NULL, n INTEGER NOT NULL,
      PRIMARY KEY (scope_type, scope_id, subject_type, subject))`);
    db.run(`CREATE TABLE IF NOT EXISTS reg_roles (
      tenant TEXT NOT NULL REFERENCES reg_tenants(id), id TEXT NOT NULL, name TEXT NOT NULL, base TEXT, board_role TEXT,
      permissions TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (tenant, id))`);
    // Home (PROTOCOL.md § Home): Recent and Starred, one row per (member, board). Additive like the rest.
    db.run(`CREATE TABLE IF NOT EXISTS reg_recents (
      member TEXT NOT NULL, board TEXT NOT NULL REFERENCES reg_boards(id), opened_at INTEGER NOT NULL, PRIMARY KEY (member, board))`);
    db.run(`CREATE TABLE IF NOT EXISTS reg_stars (
      member TEXT NOT NULL, board TEXT NOT NULL REFERENCES reg_boards(id), at INTEGER NOT NULL, PRIMARY KEY (member, board))`);
    db.run("CREATE INDEX IF NOT EXISTS reg_recents_member ON reg_recents (member, opened_at DESC, board DESC)");
    db.run("CREATE INDEX IF NOT EXISTS reg_stars_member ON reg_stars (member, at DESC, board DESC)");
    db.run("CREATE INDEX IF NOT EXISTS reg_grants_member ON reg_grants (member)");
    db.run("CREATE INDEX IF NOT EXISTS reg_boards_tenant ON reg_boards (tenant, id)");
    db.run("CREATE INDEX IF NOT EXISTS reg_invites_email ON reg_invites (email)");
    db.run("CREATE INDEX IF NOT EXISTS reg_link_uses_member ON reg_link_uses (member, board)");
    db.run("CREATE INDEX IF NOT EXISTS reg_scope_grants_subject ON reg_scope_grants (subject_type, subject, scope_type)");
    db.run("CREATE INDEX IF NOT EXISTS reg_team_members_member ON reg_team_members (member)");
    db.run("CREATE INDEX IF NOT EXISTS reg_spaces_tenant ON reg_spaces (tenant)");
    db.run("CREATE INDEX IF NOT EXISTS reg_spaces_grp ON reg_spaces (grp, id)");
    db.run("CREATE INDEX IF NOT EXISTS reg_groups_tenant ON reg_groups (tenant)");
    db.run("CREATE INDEX IF NOT EXISTS reg_teams_tenant ON reg_teams (tenant)");
  }).immediate(), clock, onAttempt);
  db.run(`PRAGMA busy_timeout=${wait}`);                     // start-up spent part of it; runtime gets the whole budget

  const q = {
    tenant: db.query("SELECT id, domain, created_at FROM reg_tenants WHERE id = ?"),
    tenantByDomain: db.query(`SELECT id, domain, created_at FROM reg_tenants WHERE domain = ?1
      UNION ALL SELECT t.id, t.domain, t.created_at FROM reg_tenant_domains d JOIN reg_tenants t ON t.id = d.tenant WHERE d.domain = ?1`),
    tenantExists: db.query("SELECT 1 AS x FROM reg_tenants WHERE id = ?"),
    insTenant: db.query("INSERT INTO reg_tenants (id, domain, created_at) VALUES (?, ?, ?)"),
    admins: db.query("SELECT member FROM reg_tenant_admins WHERE tenant = ? ORDER BY n"),
    adminsAmong: db.query("SELECT DISTINCT member FROM reg_tenant_admins WHERE member IN (SELECT value FROM json_each(?))"),
    adminN: db.query("SELECT coalesce(max(n), 0) + 1 AS n FROM reg_tenant_admins WHERE tenant = ?"),
    insAdmin: db.query("INSERT INTO reg_tenant_admins (tenant, member, n) VALUES (?, ?, ?) ON CONFLICT (tenant, member) DO NOTHING"),

    tenantKind: db.query("SELECT kind FROM reg_tenant_meta WHERE tenant = ?"),
    insKind: db.query("INSERT INTO reg_tenant_meta (tenant, kind) VALUES (?, ?)"),
    extraDomains: db.query("SELECT domain FROM reg_tenant_domains WHERE tenant = ? ORDER BY n"),
    extraDomainOwner: db.query("SELECT tenant FROM reg_tenant_domains WHERE domain = ?"),
    extraDomainN: db.query("SELECT coalesce(max(n), 0) + 1 AS n FROM reg_tenant_domains WHERE tenant = ?"),
    insDomain: db.query("INSERT INTO reg_tenant_domains (domain, tenant, n) VALUES (?, ?, ?)"),
    setPrimary: db.query("UPDATE reg_tenants SET domain = ? WHERE id = ? AND domain IS NULL"),

    board: db.query("SELECT id, tenant, title, member_role, created_at, (SELECT space FROM reg_board_spaces WHERE board = reg_boards.id) AS space FROM reg_boards WHERE id = ?"),
    insBoardSpace: db.query("INSERT INTO reg_board_spaces (board, space) VALUES (?, ?)"),

    group: db.query("SELECT * FROM reg_groups WHERE id = ?"),
    groups: db.query("SELECT * FROM reg_groups WHERE tenant = ? ORDER BY created_at, id"),
    insGroup: db.query("INSERT INTO reg_groups (id, tenant, name, general_role, created_at) VALUES (?, ?, ?, ?, ?)"),
    space: db.query("SELECT * FROM reg_spaces WHERE id = ?"),
    spaces: db.query("SELECT * FROM reg_spaces WHERE tenant = ? ORDER BY created_at, id"),
    spacesIn: db.query("SELECT * FROM reg_spaces WHERE grp = ?1 AND (?2 IS NULL OR id > ?2) ORDER BY id LIMIT ?3"),
    renameBoard: db.query("UPDATE reg_boards SET title = ?2 WHERE id = ?1"),
    renameSpace: db.query("UPDATE reg_spaces SET name = ?2 WHERE id = ?1"),
    renameGroup: db.query("UPDATE reg_groups SET name = ?2 WHERE id = ?1"),
    patchSpace: db.query("UPDATE reg_spaces SET name = CASE WHEN ?2 = 1 THEN ?3 ELSE name END, general_role = CASE WHEN ?4 = 1 THEN ?5 ELSE general_role END WHERE id = ?1"),
    patchGroup: db.query("UPDATE reg_groups SET name = CASE WHEN ?2 = 1 THEN ?3 ELSE name END, general_role = CASE WHEN ?4 = 1 THEN ?5 ELSE general_role END WHERE id = ?1"),
    personal: db.query("SELECT * FROM reg_spaces WHERE tenant = ? AND owner_user = ?"),
    insSpace: db.query("INSERT INTO reg_spaces (id, tenant, grp, name, kind, owner_user, general_role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    team: db.query("SELECT * FROM reg_teams WHERE id = ?"),
    teams: db.query("SELECT * FROM reg_teams WHERE tenant = ? ORDER BY created_at, id"),
    insTeam: db.query("INSERT INTO reg_teams (id, tenant, name, created_at) VALUES (?, ?, ?, ?)"),
    insMember: db.query("INSERT INTO reg_team_members (team, member) VALUES (?, ?) ON CONFLICT (team, member) DO NOTHING"),
    delMember: db.query("DELETE FROM reg_team_members WHERE team = ? AND member = ?"),
    members: db.query("SELECT member FROM reg_team_members WHERE team = ? ORDER BY member"),
    membersOf: db.query("SELECT team, member FROM reg_team_members WHERE team IN (SELECT value FROM json_each(?1)) AND (?2 IS NULL OR member IN (SELECT value FROM json_each(?2))) ORDER BY team, member"),
    sgrants: db.query("SELECT subject_type, subject, role FROM reg_scope_grants WHERE scope_type = ? AND scope_id = ? ORDER BY n"),
    sgrant: db.query("SELECT role FROM reg_scope_grants WHERE scope_type = ? AND scope_id = ? AND subject_type = ? AND subject = ?"),
    // Owners that guard a Group or Space: a user's, or a Team's while the Team has a member.
    sowners: db.query(`SELECT subject_type, subject FROM reg_scope_grants g WHERE scope_type = ? AND scope_id = ? AND role = 'owner'
      AND (subject_type = 'user' OR EXISTS (SELECT 1 FROM reg_team_members m WHERE m.team = g.subject))`),
    teamOwned: db.query("SELECT scope_type, scope_id FROM reg_scope_grants WHERE subject_type = 'team' AND subject = ? AND role = 'owner' AND scope_type IN ('group', 'space')"),
    teamSize: db.query("SELECT count(*) AS c FROM reg_team_members WHERE team = ?"),
    teamHas: db.query("SELECT 1 AS x FROM reg_team_members WHERE team = ? AND member = ?"),
    boardsInUnit: db.query("SELECT id FROM reg_boards WHERE tenant = ?1 AND (?2 IS NULL OR id > ?2) ORDER BY id LIMIT ?3"),
    boardsInSpace: db.query("SELECT board AS id FROM reg_board_spaces WHERE space = ?1 AND (?2 IS NULL OR board > ?2) ORDER BY board LIMIT ?3"),
    boardsInGroup: db.query("SELECT bs.board AS id FROM reg_board_spaces bs JOIN reg_spaces s ON s.id = bs.space WHERE s.grp = ?1 AND (?2 IS NULL OR bs.board > ?2) ORDER BY bs.board LIMIT ?3"),
    scopesOf: db.query(`SELECT scope_type, scope_id, role FROM reg_scope_grants WHERE subject_type = ?1 AND subject = ?2
      AND (?3 IS NULL OR (scope_type || char(10) || scope_id) > ?3) ORDER BY scope_type, scope_id LIMIT ?4`),
    sgrantN: db.query("SELECT coalesce(max(n), 0) + 1 AS n FROM reg_scope_grants WHERE scope_type = ? AND scope_id = ?"),
    upSgrant: db.query(`INSERT INTO reg_scope_grants (scope_type, scope_id, subject_type, subject, role, n) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (scope_type, scope_id, subject_type, subject) DO UPDATE SET role = excluded.role`),
    delSgrant: db.query("DELETE FROM reg_scope_grants WHERE scope_type = ? AND scope_id = ? AND subject_type = ? AND subject = ?"),
    role: db.query("SELECT * FROM reg_roles WHERE tenant = ? AND id = ?"),
    roles: db.query("SELECT * FROM reg_roles WHERE tenant = ? ORDER BY created_at, id"),
    insRole: db.query("INSERT INTO reg_roles (tenant, id, name, base, board_role, permissions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    upRole: db.query("UPDATE reg_roles SET name = ?, board_role = ?, permissions = ? WHERE tenant = ? AND id = ?"),
    upRecent: db.query(`INSERT INTO reg_recents (member, board, opened_at) VALUES (?1, ?2, ?3)
      ON CONFLICT (member, board) DO UPDATE SET opened_at = excluded.opened_at`),
    pruneRecent: db.query(`DELETE FROM reg_recents WHERE member = ?1 AND board IN
      (SELECT board FROM reg_recents WHERE member = ?1 ORDER BY opened_at DESC, board DESC LIMIT -1 OFFSET ?2)`),
    recents: db.query("SELECT board, opened_at AS at FROM reg_recents WHERE member = ? ORDER BY opened_at DESC, board DESC LIMIT ?"),
    upStar: db.query("INSERT INTO reg_stars (member, board, at) VALUES (?, ?, ?) ON CONFLICT (member, board) DO NOTHING"),
    delStar: db.query("DELETE FROM reg_stars WHERE member = ? AND board = ?"),
    stars: db.query("SELECT board, at FROM reg_stars WHERE member = ? ORDER BY at DESC, board DESC LIMIT ?"),
    starsAmong: db.query("SELECT board FROM reg_stars WHERE member = ? AND board IN (SELECT value FROM json_each(?))"),
    shared: db.query(`SELECT board FROM (
        SELECT board FROM reg_grants WHERE member = ?1
        UNION SELECT g.scope_id AS board FROM reg_team_members m CROSS JOIN reg_scope_grants g INDEXED BY reg_scope_grants_subject ON g.subject_type = 'team' AND g.subject = m.team AND g.scope_type = 'board'
          WHERE m.member = ?1
        UNION SELECT board FROM reg_invites WHERE ?2 IS NOT NULL AND email = ?2 AND revoked = 0
        UNION SELECT board FROM reg_link_uses WHERE member = ?1) ORDER BY board LIMIT ?3`),
    search: db.query(`SELECT w.id FROM (SELECT id, title FROM reg_boards WHERE tenant = ?1 AND (?2 IS NULL OR id > ?2) ORDER BY id LIMIT ?5) w
      LEFT JOIN reg_board_spaces bs ON bs.board = w.id LEFT JOIN reg_spaces s ON s.id = bs.space
      WHERE (?3 IS NULL OR w.title LIKE ?3 ESCAPE '\\' OR (?4 = 0 AND s.name LIKE ?3 ESCAPE '\\')) AND (?4 = 0 OR bs.board IS NULL)
      ORDER BY w.id`),
    searchEdge: db.query("SELECT id FROM reg_boards WHERE tenant = ?1 AND (?2 IS NULL OR id > ?2) ORDER BY id LIMIT 2 OFFSET ?3"),
    spaceCand: db.query(`SELECT s.* FROM reg_spaces s WHERE s.tenant = ?1 AND (?2 IS NULL OR s.id > ?2) AND (?4 = 1
        OR s.general_role IS NOT NULL OR s.owner_user = ?3
        OR EXISTS (SELECT 1 FROM reg_scope_grants g WHERE g.scope_type = 'space' AND g.scope_id = s.id AND ((g.subject_type = 'user' AND g.subject = ?3)
          OR (g.subject_type = 'team' AND g.subject IN (SELECT team FROM reg_team_members WHERE member = ?3))))
        OR s.grp IN (SELECT id FROM reg_groups WHERE tenant = ?1 AND general_role IS NOT NULL)
        OR EXISTS (SELECT 1 FROM reg_scope_grants g WHERE g.scope_type = 'group' AND g.scope_id = s.grp AND ((g.subject_type = 'user' AND g.subject = ?3)
          OR (g.subject_type = 'team' AND g.subject IN (SELECT team FROM reg_team_members WHERE member = ?3)))))
      ORDER BY s.id LIMIT ?5`),
    groupsByIds: db.query("SELECT * FROM reg_groups WHERE id IN (SELECT value FROM json_each(?))"),
    groupCand: db.query(`SELECT gr.* FROM reg_groups gr WHERE gr.tenant = ?1 AND (?3 = 1 OR gr.general_role IS NOT NULL
        OR EXISTS (SELECT 1 FROM reg_scope_grants g WHERE g.scope_type = 'group' AND g.scope_id = gr.id AND ((g.subject_type = 'user' AND g.subject = ?2)
          OR (g.subject_type = 'team' AND g.subject IN (SELECT team FROM reg_team_members WHERE member = ?2))))) ORDER BY gr.id LIMIT ?4`),
    rowsBoards: db.query(`SELECT id, tenant, title, member_role, created_at, (SELECT space FROM reg_board_spaces WHERE board = reg_boards.id) AS space
      FROM reg_boards WHERE id IN (SELECT value FROM json_each(?))`),
    rowsGrants: db.query("SELECT board, role FROM reg_grants WHERE member = ? AND board IN (SELECT value FROM json_each(?))"),
    rowsTeamGrants: db.query(`SELECT scope_id, subject_type, subject, role FROM reg_scope_grants WHERE scope_type = 'board'
      AND scope_id IN (SELECT value FROM json_each(?)) ORDER BY n`),
    rowsMyTeams: db.query("SELECT team FROM reg_team_members WHERE member = ? AND team IN (SELECT value FROM json_each(?))"),
    rowsInvites: db.query(`SELECT * FROM reg_invites WHERE ?1 IS NOT NULL AND email = ?1 AND revoked = 0 AND board IN (SELECT value FROM json_each(?2)) ORDER BY n`),
    rowsUses: db.query("SELECT board, link FROM reg_link_uses WHERE member = ? AND board IN (SELECT value FROM json_each(?)) ORDER BY n"),
    rowsLinks: db.query(`SELECT l.* FROM reg_link_uses u JOIN reg_links l ON l.id = u.link
      WHERE u.member = ? AND u.board IN (SELECT value FROM json_each(?)) ORDER BY u.n`),
    boardExists: db.query("SELECT 1 AS x FROM reg_boards WHERE id = ?"),
    insBoard: db.query("INSERT INTO reg_boards (id, tenant, title, member_role, created_at) VALUES (?, ?, ?, ?, ?)"),

    grant: db.query("SELECT role FROM reg_grants WHERE board = ? AND member = ?"),
    grants: db.query("SELECT member, role FROM reg_grants WHERE board = ? ORDER BY n"),
    owners: db.query("SELECT count(*) AS c FROM reg_grants WHERE board = ? AND role = 'owner'"),
    grantN: db.query("SELECT coalesce(max(n), 0) + 1 AS n FROM reg_grants WHERE board = ?"),
    upGrant: db.query(`INSERT INTO reg_grants (board, member, role, n) VALUES (?, ?, ?, ?)
      ON CONFLICT (board, member) DO UPDATE SET role = excluded.role`),
    delGrant: db.query("DELETE FROM reg_grants WHERE board = ? AND member = ?"),

    invite: db.query("SELECT * FROM reg_invites WHERE id = ?"),
    invites: db.query("SELECT * FROM reg_invites WHERE board = ? ORDER BY n"),
    invitesFor: db.query("SELECT * FROM reg_invites WHERE board = ? AND email = ? ORDER BY n"),
    insInvite: db.query(`INSERT INTO reg_invites (id, board, email, role, expires_at, revoked, by_user, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)`),
    revokeInvite: db.query("UPDATE reg_invites SET revoked = 1 WHERE id = ?"),

    link: db.query("SELECT * FROM reg_links WHERE id = ?"),
    links: db.query("SELECT * FROM reg_links WHERE board = ? ORDER BY n"),
    insLink: db.query(`INSERT INTO reg_links (id, board, role, expires_at, revoked, by_user, created_at)
      VALUES (?, ?, ?, ?, 0, ?, ?)`),
    revokeLink: db.query("UPDATE reg_links SET revoked = 1 WHERE id = ?"),

    useN: db.query("SELECT coalesce(max(n), 0) + 1 AS n FROM reg_link_uses WHERE board = ? AND member = ?"),
    insUse: db.query("INSERT INTO reg_link_uses (board, member, link, n) VALUES (?, ?, ?, ?) ON CONFLICT (board, member, link) DO NOTHING"),
    uses: db.query("SELECT link FROM reg_link_uses WHERE board = ? AND member = ? ORDER BY n"),
    usesFor: db.query("SELECT member, link FROM reg_link_uses WHERE board = ? AND member IN (SELECT value FROM json_each(?)) ORDER BY member, n"),
  };

  const ready = () => { if (!open) throw new Error("registry: closed"); };
  /** A fresh server-minted id: retried on the (astronomically rare) collision. */
  const fresh = (f, exists) => { let id; do id = f(); while (exists(id)); return id; };

  const rowTenant = r => r && {
    id: r.id, domain: r.domain, domains: [...(r.domain ? [r.domain] : []), ...q.extraDomains.all(r.id).map(d => d.domain)],
    kind: q.tenantKind.get(r.id)?.kind ?? "company", admins: q.admins.all(r.id).map(a => a.member), createdAt: r.created_at };
  const rowBoard = r => r && { id: r.id, tenant: r.tenant, title: r.title, memberRole: r.member_role, space: r.space ?? null, createdAt: r.created_at };
  const rowGroup = r => r && { id: r.id, tenant: r.tenant, name: r.name, generalRole: r.general_role, createdAt: r.created_at };
  const rowSpace = r => r && { id: r.id, tenant: r.tenant, group: r.grp, name: r.name, kind: r.kind, owner: r.owner_user, generalRole: r.general_role, createdAt: r.created_at };
  const rowTeam = r => r && { id: r.id, tenant: r.tenant, name: r.name, createdAt: r.created_at };
  const rowRole = r => r && { id: r.id, tenant: r.tenant, name: r.name, base: r.base, boardRole: r.board_role, permissions: JSON.parse(r.permissions), createdAt: r.created_at };
  const rowSg = r => ({ subject: { type: r.subject_type, id: r.subject }, role: r.role });
  const rowInvite = r => r && { id: r.id, board: r.board, email: r.email, role: r.role, expiresAt: r.expires_at, revoked: !!r.revoked, by: r.by_user, createdAt: r.created_at };
  const rowLink = r => r && { id: r.id, board: r.board, role: r.role, expiresAt: r.expires_at, revoked: !!r.revoked, by: r.by_user, createdAt: r.created_at };
  // undefined → null (bun:sqlite refuses undefined bindings); everything else as given.
  const nz = v => (v === undefined ? null : v);

  /** The tenant that owns `domain` (primary or extra), or undefined. */
  const domainOwner = d => q.tenantByDomain.get(d)?.id;
  const createTenantTx = db.transaction((ds, kind, admins, createdAt) => {
    if (ds.some(domainOwner)) throw new Error("registry: domain already has a tenant");
    const id = fresh(mint.tenant, i => !!q.tenantExists.get(i));
    q.insTenant.run(id, ds[0] ?? null, createdAt);
    q.insKind.run(id, kind);
    ds.slice(1).forEach(d => q.insDomain.run(d, id, q.extraDomainN.get(id).n));
    for (const a of admins) q.insAdmin.run(id, a, q.adminN.get(id).n);
    return rowTenant(q.tenant.get(id));
  });
  const addDomainTx = db.transaction((tenant, d) => {
    if (!q.tenantExists.get(tenant)) throw new Error("registry: no such tenant");
    const owner = domainOwner(d);
    if (owner && owner !== tenant) throw new Error("registry: domain already has a tenant");
    if (owner) return;
    if (q.setPrimary.run(d, tenant).changes === 0) q.insDomain.run(d, tenant, q.extraDomainN.get(tenant).n);
  });

  const addAdminTx = db.transaction((tenant, user) => {
    if (!q.tenantExists.get(tenant)) throw new Error("registry: no such tenant");
    q.insAdmin.run(tenant, user, q.adminN.get(tenant).n);
  });

  const createBoardTx = db.transaction((tenant, title, memberRole, space, createdAt) => {
    if (!q.tenantExists.get(tenant)) throw new Error("registry: no such tenant");
    if (space != null && q.space.get(space)?.tenant !== tenant) throw new Error("registry: no such space");
    const id = fresh(mint.board, i => !!q.boardExists.get(i));
    q.insBoard.run(id, tenant, title, memberRole === undefined ? (space != null ? null : "viewer") : memberRole, createdAt);
    if (space != null) q.insBoardSpace.run(id, space);
    return rowBoard(q.board.get(id));
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

  // ---- organization ----
  const needRow = (ok, what) => { if (!ok) throw new Error(`registry: no such ${what}`); };
  const putSg = (type, id, st, sid, role) => {
    if (role == null) q.delSgrant.run(type, id, st, sid);
    else q.upSgrant.run(type, id, st, sid, role, q.sgrantN.get(type, id).n);
  };
  const scopeTenant = (type, id) => (type === "unit" ? q.tenantExists.get(id) && id : type === "group" ? q.group.get(id)?.tenant
    : type === "space" ? q.space.get(id)?.tenant : q.board.get(id)?.tenant);
  const createGroupTx = db.transaction((tenant, name, generalRole, owner, createdAt) => {
    needRow(q.tenantExists.get(tenant), "tenant");
    const id = fresh(mint.group, i => !!q.group.get(i));
    q.insGroup.run(id, tenant, name, generalRole, createdAt);
    if (owner != null) putSg("group", id, "user", owner, "owner");
    return rowGroup(q.group.get(id));
  });
  const createSpaceTx = db.transaction((tenant, name, group, generalRole, owner, createdAt) => {
    needRow(q.tenantExists.get(tenant), "tenant");
    if (group != null) needRow(q.group.get(group)?.tenant === tenant, "group");
    const id = fresh(mint.space, i => !!q.space.get(i));
    q.insSpace.run(id, tenant, group, name, "shared", null, generalRole, createdAt);
    if (owner != null) putSg("space", id, "user", owner, "owner");
    return rowSpace(q.space.get(id));
  });
  const personalTx = db.transaction((tenant, user, createdAt) => {
    needRow(q.tenantExists.get(tenant), "tenant");
    const have = q.personal.get(tenant, user);
    if (have) return rowSpace(have);
    const id = fresh(mint.space, i => !!q.space.get(i));
    q.insSpace.run(id, tenant, null, orgDefaults.personalName(user), "personal", user, null, createdAt);
    putSg("space", id, "user", user, "owner");
    return rowSpace(q.space.get(id));
  });
  const createTeamTx = db.transaction((tenant, name, createdAt) => {
    needRow(q.tenantExists.get(tenant), "tenant");
    const id = fresh(mint.team, i => !!q.team.get(i));
    q.insTeam.run(id, tenant, name, createdAt);
    return rowTeam(q.team.get(id));
  });
  const setMemberTx = db.transaction((team, user, member) => {
    needRow(q.team.get(team), "team");
    if (!member && q.teamSize.get(team).c === 1 && q.teamHas.get(team, user)) {
      // Removing the last member of a Team that is the only counted owner of a Group or Space would leave it ownerless.
      for (const o of q.teamOwned.all(team)) if (q.sowners.all(o.scope_type, o.scope_id).length <= 1)
        throw new SqlRegistryError("last-owner", `a ${o.scope_type} keeps at least one owner`);
    }
    (member ? q.insMember : q.delMember).run(team, user);
  });
  const setSgrantTx = db.transaction((type, id, st, sid, role) => {
    const tenant = scopeTenant(type, id);
    needRow(tenant, "scope");
    if (st === "team") needRow(q.team.get(sid)?.tenant === tenant, "team");
    if (type === "board" && st === "user") throw new Error("registry: a user's grant on a board is setGrant");
    const cur = q.sgrant.get(type, id, st, sid)?.role ?? null;
    if ((type === "group" || type === "space") && cur === "owner" && role !== "owner") {
      const counted = q.sowners.all(type, id);
      if (counted.some(o => o.subject_type === st && o.subject === sid) && counted.length <= 1)
        throw new SqlRegistryError("last-owner", `a ${type} keeps at least one owner`);
    }
    putSg(type, id, st, sid, role);
  });
  const createRoleTx = db.transaction((tenant, name, base, boardRole, perms, createdAt) => {
    needRow(q.tenantExists.get(tenant), "tenant");
    const id = fresh(mint.role, i => !!q.role.get(tenant, i));
    q.insRole.run(tenant, id, name, base, boardRole, JSON.stringify(perms), createdAt);
    return rowRole(q.role.get(tenant, id));
  });
  const updateRoleTx = db.transaction((tenant, id, patch, createdAt) => {
    needRow(q.tenantExists.get(tenant), "tenant");
    let r = q.role.get(tenant, id);
    if (!r) {
      needRow(id === MEMBER_ROLE_ID, "role");
      q.insRole.run(tenant, id, "Unit member", null, null, JSON.stringify(DEFAULT_MEMBER_PERMS), createdAt);
      r = q.role.get(tenant, id);
    }
    q.upRole.run(patch.name !== undefined ? orgDefaults.name(patch.name) : r.name, patch.boardRole !== undefined ? patch.boardRole : r.board_role,
      JSON.stringify(patch.permissions !== undefined ? patch.permissions : JSON.parse(r.permissions)), tenant, id);
    return rowRole(q.role.get(tenant, id));
  });
  // One snapshot read of a scope's whole chain: a fixed number of statements however many grants, Teams or members.
  // `chain` (already read by the caller) skips the chain statements; `users` limits Team members to those users.
  const contextTx = db.transaction((type, id, users, held) => {
    const board = held ? held.board : type === "board" ? rowBoard(q.board.get(id)) : null;
    const space = held ? held.space : type === "space" ? rowSpace(q.space.get(id)) : board?.space ? rowSpace(q.space.get(board.space)) : null;
    const group = held ? held.group : type === "group" ? rowGroup(q.group.get(id)) : space?.group ? rowGroup(q.group.get(space.group)) : null;
    const owner = board ?? space ?? group;
    const tenant = held ? held.tenant : rowTenant(q.tenant.get(type === "unit" ? id : owner?.tenant));
    if (!tenant || (type !== "unit" && !owner)) return null;
    const sg = (t, i) => (i == null ? [] : q.sgrants.all(t, i).map(rowSg));
    const scoped = { unit: sg("unit", tenant.id), group: sg("group", group?.id), space: sg("space", space?.id), board: sg("board", board?.id) };
    const teamIds = [...new Set(Object.values(scoped).flat().filter(g => g.subject.type === "team").map(g => g.subject.id))];
    const teams = Object.fromEntries(teamIds.map(t => [t, []]));
    if (teamIds.length) for (const m of q.membersOf.all(JSON.stringify(teamIds), users ? JSON.stringify(users) : null)) teams[m.team].push(m.member);
    return { tenant, board, space, group, scoped, roles: q.roles.all(tenant.id).map(rowRole), teams };
  });

  /** `accessContexts`: every scope's context from ONE transaction (one snapshot). */
  const contextsTx = db.transaction((list, users) => list.map(sc => [sc.type + "\n" + sc.id, contextTx(sc.type, sc.id, users, null)]));

  return {
    async createTenant({ domain, domains = [], kind = "company", admins = [] }) {
      ready();
      if (!KINDS.includes(kind)) throw new Error("registry: bad unit kind");
      return createTenantTx.immediate(domainList(domain, domains), kind, [...admins].map(String), now());
    },
    async addTenantDomain(tenant, domain) {
      ready();
      const d = domainList(domain)[0];
      if (!str(tenant)) throw new Error("registry: no such tenant");
      if (!d) throw new Error("registry: bad domain");
      addDomainTx.immediate(tenant, d);
    },
    async tenant(id) { ready(); return str(id) ? rowTenant(q.tenant.get(id)) ?? null : null; },
    async tenantByDomain(domain) {
      ready();
      return str(domain) && domain ? rowTenant(q.tenantByDomain.get(domain.toLowerCase())) ?? null : null;   // the UNION ALL yields ≤ 1 row: a domain has one tenant
    },
    async tenantAdminsAmong(users) { ready(); return q.adminsAmong.all(JSON.stringify(users.filter(str))).map(r => r.member); },
    async addTenantAdmin(tenant, user) {
      ready();
      if (!str(tenant)) throw new Error("registry: no such tenant");
      addAdminTx.immediate(tenant, String(user));
    },

    async createBoard({ tenant, title = "", memberRole, space }) {
      ready();
      if (!str(tenant)) throw new Error("registry: no such tenant");
      if (space != null && !str(space)) throw new Error("registry: no such space");
      return createBoardTx.immediate(tenant, String(title), memberRole === undefined ? undefined : nz(memberRole), nz(space), now());
    },
    async board(id) { ready(); return str(id) ? rowBoard(q.board.get(id)) ?? null : null; },

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

    // ---- organization (PROTOCOL.md § Registry, "Organization") ----
    async createGroup({ tenant, name, generalRole = null, owner }) {
      ready();
      if (!str(tenant)) throw new Error("registry: no such tenant");
      return createGroupTx.immediate(tenant, orgDefaults.name(name), nz(generalRole), owner == null ? null : String(owner), now());
    },
    async group(id) { ready(); return str(id) ? rowGroup(q.group.get(id)) ?? null : null; },
    async groups(tenant) { ready(); return str(tenant) ? q.groups.all(tenant).map(rowGroup) : []; },
    async createSpace({ tenant, name, group = null, generalRole = "viewer", owner }) {
      ready();
      if (!str(tenant)) throw new Error("registry: no such tenant");
      if (group != null && !str(group)) throw new Error("registry: no such group");
      return createSpaceTx.immediate(tenant, orgDefaults.name(name), nz(group), nz(generalRole), owner == null ? null : String(owner), now());
    },
    async space(id) { ready(); return str(id) ? rowSpace(q.space.get(id)) ?? null : null; },
    async spaces(tenant) { ready(); return str(tenant) ? q.spaces.all(tenant).map(rowSpace) : []; },
    async spacesIn(group, { after = null, limit } = {}) {
      ready();
      const n = pageLimit(limit), cur = orgDefaults.cursor(after, "id");
      const rows = str(group) ? q.spacesIn.all(group, cur, n + 1).map(rowSpace) : [];
      return { spaces: rows.slice(0, n), next: rows.length > n ? rows[n - 1].id : null };
    },
    async rename(scope, name) {
      ready();
      const { type, id } = orgDefaults.renamable(scope, ["board", "space", "group"]);
      const v = type === "board" ? orgDefaults.title(name) : orgDefaults.name(name);
      const [up, get, row] = type === "board" ? [q.renameBoard, q.board, rowBoard] : type === "space" ? [q.renameSpace, q.space, rowSpace] : [q.renameGroup, q.group, rowGroup];
      if (up.run(id, v).changes === 0) throw new Error(`registry: no such ${type}`);
      return row(get.get(id));
    },
    async updateScope(scope, patch) {
      ready();
      const { type, id } = orgDefaults.renamable(scope, ["space", "group"]), v = orgDefaults.patch(patch);
      const [up, get, row] = type === "space" ? [q.patchSpace, q.space, rowSpace] : [q.patchGroup, q.group, rowGroup];
      if (up.run(id, v.name !== undefined ? 1 : 0, v.name ?? null, v.generalRole !== undefined ? 1 : 0, v.generalRole ?? null).changes === 0) throw new Error(`registry: no such ${type}`);
      return row(get.get(id));
    },
    async ensurePersonalSpace(tenant, user) {
      ready();
      if (!str(tenant)) throw new Error("registry: no such tenant");
      // Read first: Home calls this on every load, and the write lock (BEGIN IMMEDIATE) is taken only when the row is missing.
      const had = rowSpace(q.personal.get(tenant, String(user)));
      return had ?? personalTx.immediate(tenant, String(user), now());
    },
    async createTeam({ tenant, name }) {
      ready();
      if (!str(tenant)) throw new Error("registry: no such tenant");
      return createTeamTx.immediate(tenant, orgDefaults.name(name), now());
    },
    async team(id) { ready(); return str(id) ? rowTeam(q.team.get(id)) ?? null : null; },
    async teams(tenant) { ready(); return str(tenant) ? q.teams.all(tenant).map(rowTeam) : []; },
    async setTeamMember(team, user, member) {
      ready();
      if (!str(team)) throw new Error("registry: no such team");
      setMemberTx.immediate(team, String(user), !!member);
    },
    async teamMembers(team) { ready(); return str(team) ? q.members.all(team).map(r => r.member) : []; },
    async setScopedGrant({ scope, subject, role }) {
      ready();
      const { type, id } = orgDefaults.scope(scope), sub = orgDefaults.subject(subject);
      setSgrantTx.immediate(type, id, sub.type, sub.id, orgDefaults.grantRole(role));
    },
    async scopedGrants(scope) {
      ready();
      const { type, id } = orgDefaults.scope(scope);
      return q.sgrants.all(type, id).map(rowSg);
    },
    async createRole({ tenant, name, base = null, boardRole, permissions = [] }) {
      ready();
      if (!str(tenant)) throw new Error("registry: no such tenant");
      return createRoleTx.immediate(tenant, orgDefaults.name(name), nz(base), nz(boardRole), [...permissions], now());
    },
    async updateRole(tenant, id, patch) {
      ready();
      if (!str(tenant) || !str(id)) throw new Error("registry: no such role");
      return updateRoleTx.immediate(tenant, id, patch ?? {}, now());
    },
    async role(tenant, id) { ready(); return str(tenant) && str(id) ? rowRole(q.role.get(tenant, id)) ?? null : null; },
    async roles(tenant) { ready(); return str(tenant) ? q.roles.all(tenant).map(rowRole) : []; },
    async accessContext(scope, { users, chain } = {}) {
      ready();
      const { type, id } = orgDefaults.scope(scope);
      return contextTx(type, id, users ? users.filter(str) : null, chain ?? null);
    },
    async accessContexts(scopes, { users } = {}) {
      ready();
      const list = batchScopes(scopes), us = users ? users.filter(str) : null;
      return new Map(contextsTx(list, us));
    },
    // ---- Home (PROTOCOL.md § Home) ----
    async markOpened(user, board) {
      ready();
      if (!str(user) || !str(board) || !q.boardExists.get(board)) throw new Error("registry: no such board");
      db.transaction(() => { q.upRecent.run(user, board, now()); q.pruneRecent.run(user, HOME.recentKeep); }).immediate();
    },
    async recents(user, { limit } = {}) {
      ready();
      return str(user) ? q.recents.all(user, smallLimit(limit, 12, HOME.recentKeep)) : [];
    },
    async setStarred(user, board, on) {
      ready();
      if (!on) { if (str(user) && str(board)) q.delStar.run(user, board); return; }
      if (!str(user) || !str(board) || !q.boardExists.get(board)) throw new Error("registry: no such board");
      q.upStar.run(user, board, now());
    },
    async starred(user, { limit } = {}) {
      ready();
      return str(user) ? q.stars.all(user, smallLimit(limit, 50, HOME.starScan)) : [];
    },
    async starredAmong(user, ids) {
      ready();
      const bs = [...new Set((ids ?? []).filter(str))].slice(0, HOME.batch);
      return str(user) && bs.length ? q.starsAmong.all(user, JSON.stringify(bs)).map(r => r.board) : [];
    },
    async sharedBoards(user, email, { limit } = {}) {
      ready();
      return str(user) ? q.shared.all(user, email ? normEmail(email) : null, smallLimit(limit, HOME.sharedScan, HOME.sharedScan)).map(r => r.board) : [];
    },
    async searchBoards(tenant, { q: term, unfiled = false, after = null, scan } = {}) {
      ready();
      const cur = orgDefaults.cursor(after, "id"), cap = smallLimit(scan, HOME.searchScan.default, HOME.searchScan.max);
      const like = term == null ? null : "%" + asciiFold(searchQuery(term)).replace(/[\\%_]/g, "\\$&") + "%";
      if (!str(tenant)) return { ids: [], next: null };
      const ids = q.search.all(tenant, cur, like, unfiled ? 1 : 0, cap).map(r => r.id);
      const edge = q.searchEdge.all(tenant, cur, cap - 1);          // [last board examined, one more] when the Unit goes on past the window
      return { ids, next: edge.length === 2 ? edge[0].id : null };
    },
    async spaceCandidates(tenant, { user, all = false, after = null, limit } = {}) {
      ready();
      const cur = orgDefaults.cursor(after, "id"), n = smallLimit(limit, HOME.candidates.spaces.default, HOME.candidates.spaces.max);
      if (!str(tenant) || !str(user)) return { spaces: [], groups: [], next: null };
      const rows = q.spaceCand.all(tenant, cur, user, all ? 1 : 0, n + 1), page = rows.slice(0, n);
      const gids = [...new Set(page.map(r => r.grp).filter(Boolean))];
      return { spaces: page.map(rowSpace), groups: gids.length ? q.groupsByIds.all(JSON.stringify(gids)).map(rowGroup) : [], next: rows.length > n ? page[n - 1].id : null };
    },
    async groupCandidates(tenant, { user, all = false, limit } = {}) {
      ready();
      return str(tenant) && str(user) ? q.groupCand.all(tenant, user, all ? 1 : 0, smallLimit(limit, HOME.candidates.groups.default, HOME.candidates.groups.max)).map(rowGroup) : [];
    },
    async boardRows(ids, { user, email = null } = {}) {
      ready();
      const out = new Map(), bs = [...new Set((ids ?? []).filter(str))].slice(0, HOME.batch);
      if (!bs.length || !str(user)) return out;
      const j = JSON.stringify(bs), e = email ? normEmail(email) : null;
      const grants = new Map(q.rowsGrants.all(user, j).map(r => [r.board, r.role]));
      const tg = new Map(), invs = new Map(), lks = new Map();
      const tgRows = q.rowsTeamGrants.all(j);
      for (const r of tgRows) { if (!tg.has(r.scope_id)) tg.set(r.scope_id, []); tg.get(r.scope_id).push({ subject: { type: r.subject_type, id: r.subject }, role: r.role }); }
      const teamIds = [...new Set(tgRows.filter(r => r.subject_type === "team").map(r => r.subject))];
      const mine = new Set(teamIds.length ? q.rowsMyTeams.all(user, JSON.stringify(teamIds)).map(r => r.team) : []);
      for (const r of q.rowsInvites.all(e, j)) { if (!invs.has(r.board)) invs.set(r.board, []); invs.get(r.board).push(rowInvite(r)); }
      const useBoards = q.rowsUses.all(user, j);
      const linkRows = new Map(q.rowsLinks.all(user, j).map(r => [r.id, rowLink(r)]));
      for (const u of useBoards) { if (!lks.has(u.board)) lks.set(u.board, []); const l = linkRows.get(u.link); if (l) lks.get(u.board).push(l); }
      for (const r of q.rowsBoards.all(j)) {
        const teamGrants = tg.get(r.id) ?? [];
        out.set(r.id, { board: rowBoard(r), grant: grants.get(r.id) ?? null, teamGrants,
          myTeams: teamGrants.filter(g => g.subject.type === "team" && mine.has(g.subject.id)).map(g => g.subject.id),
          invites: invs.get(r.id) ?? [], links: lks.get(r.id) ?? [] });
      }
      return out;
    },
    async boardsIn(scope, { after = null, limit } = {}) {
      ready();
      const { type, id } = orgDefaults.scope(scope), n = pageLimit(limit), cur = orgDefaults.cursor(after, "id");
      const q1 = type === "unit" ? q.boardsInUnit : type === "group" ? q.boardsInGroup : type === "space" ? q.boardsInSpace : null;
      const ids = q1 ? q1.all(id, cur, n + 1).map(r => r.id) : [];
      return { ids: ids.slice(0, n), next: ids.length > n ? ids[n - 1] : null };
    },
    async scopesOf(subject, { after = null, limit } = {}) {
      ready();
      const sub = orgDefaults.subject(subject), n = pageLimit(limit);
      const rows = q.scopesOf.all(sub.type, sub.id, orgDefaults.cursor(after, "scope"), n + 1).map(r => ({ type: r.scope_type, id: r.scope_id, role: r.role }));
      const scopes = rows.slice(0, n);
      return { scopes, next: rows.length > n ? scopes[n - 1].type + "\n" + scopes[n - 1].id : null };
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
