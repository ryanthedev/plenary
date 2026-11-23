// @ts-check
// The Registry port on SQLite (PROTOCOL.md § Registry): tenants (Units), boards, grants, invites, share links, link uses, and
// the board organization (Groups, Spaces, Teams, scoped grants, roles, `accessContext`). Start-up only ever ADDS tables
// (CREATE TABLE IF NOT EXISTS); a file from an older shape is refused (code "old-format"), never migrated.
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
import { RegistryError, batchScopes, mint, KINDS, domainList, orgDefaults, MEMBER_ROLE_ID, DEFAULT_MEMBER_PERMS, pageLimit, HOME, IDEM, idemErr, idemOf, smallLimit, searchQuery, asciiFold, TEAMS, TRASH, BOARD_VERSIONS, likeOf, profileText, ROLE_LIMITS, capOf, isCustomRoleId, ASK, askLimited, askScope, askRole, askLive, askWait, askLimits } from "../../../ports/registry.js";
import { normEmail, capTo, higher, ROLES, INVITE_ROLES, LINK_ROLES } from "../../../core/auth/util.js";
import { assertShapes, onBusyRetry } from "../../support/sqlite/schema.js";

/** An old-format store is refused at start-up (never read silently, never ALTERed). */
const oldFormat = msg => Object.assign(new Error(msg), { code: "old-format" });
/** A tenant row always has its kind row (createTenant writes both in one step): a missing one is a corrupt store, never a silent default. */
const needKind = (kind, id, absent = false) => { if (!absent && typeof kind !== "string") throw new RegistryError("corrupt", `tenant ${id} has no kind row`); return kind ?? null; };
const str = v => typeof v === "string";
const parseCursor = before => {
  if (before == null || before === "") return null;
  if (typeof before !== "string") return "invalid";
  const m = /^(\d+):(\d+)$/.exec(before);
  return m ? { at: Number(m[1]), id: Number(m[2]) } : "invalid";
};

/**
 * @param {{ path: string, now?: () => number, fullfsync?: boolean, busyTimeoutMs?: number,
 *   busy?: { clock?: () => number, onAttempt?: (budgetMs: number) => void } }} opts
 *   `path` is a file (":memory:" for throwaway use). `busy` (tests): the clock the start-up budget is read on
 *   (default Date.now) and a hook told the busy_timeout each start-up attempt was given.
 * @returns {import("../../../ports/registry.js").Registry & { close(): Promise<void>, pragmas(): object }}
 */
export function sqliteRegistry(opts) {
  const db = new Database(opts.path, { create: true, strict: true });
  try { return build(db, opts); }
  catch (err) { try { db.close(); } catch {} throw err; }   // a failed start-up (a busy file, an old-format table) never leaks the handle
}

/** The Registry's tables and indexes. Run on the file (all IF NOT EXISTS) and on a scratch database, whose table shapes the file's must match. */
const createSchema = d => {
    d.run(`CREATE TABLE IF NOT EXISTS reg_tenants (
      id TEXT PRIMARY KEY, name TEXT, domain TEXT UNIQUE, created_at INTEGER NOT NULL)`);
    d.run(`CREATE TABLE IF NOT EXISTS reg_tenant_admins (
      tenant TEXT NOT NULL REFERENCES reg_tenants(id), member TEXT NOT NULL, n INTEGER NOT NULL,
      PRIMARY KEY (tenant, member))`);
    d.run(`CREATE TABLE IF NOT EXISTS reg_tenant_members (
      tenant TEXT NOT NULL REFERENCES reg_tenants(id) ON DELETE CASCADE, email TEXT NOT NULL, added_at INTEGER NOT NULL,
      PRIMARY KEY (tenant, email))`);
    d.run("CREATE INDEX IF NOT EXISTS reg_tenant_members_email ON reg_tenant_members (email)");
    d.run(`CREATE TABLE IF NOT EXISTS reg_boards (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES reg_tenants(id), title TEXT NOT NULL,
      member_role TEXT, created_at INTEGER NOT NULL,
      trashed_at INTEGER, trashed_by TEXT, trashed_with TEXT, purging INTEGER NOT NULL DEFAULT 0)`);
    d.run(`CREATE TABLE IF NOT EXISTS reg_grants (
      board TEXT NOT NULL REFERENCES reg_boards(id), member TEXT NOT NULL, role TEXT NOT NULL, n INTEGER NOT NULL,
      PRIMARY KEY (board, member))`);
    d.run(`CREATE TABLE IF NOT EXISTS reg_invites (
      n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, board TEXT NOT NULL REFERENCES reg_boards(id),
      email TEXT NOT NULL, role TEXT NOT NULL, expires_at INTEGER, revoked INTEGER NOT NULL, by_user TEXT,
      created_at INTEGER NOT NULL)`);
    d.run("CREATE INDEX IF NOT EXISTS reg_tenant_admins_member ON reg_tenant_admins (member)");
    d.run("CREATE INDEX IF NOT EXISTS reg_invites_board ON reg_invites (board, email)");
    d.run(`CREATE TABLE IF NOT EXISTS reg_links (
      n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, board TEXT NOT NULL REFERENCES reg_boards(id),
      role TEXT NOT NULL, expires_at INTEGER, revoked INTEGER NOT NULL, by_user TEXT, created_at INTEGER NOT NULL,
      passcode_hash TEXT, no_download INTEGER NOT NULL DEFAULT 0)`);
    d.run("CREATE INDEX IF NOT EXISTS reg_links_board ON reg_links (board)");
    d.run(`CREATE TABLE IF NOT EXISTS reg_link_uses (
      board TEXT NOT NULL, member TEXT NOT NULL, link TEXT NOT NULL REFERENCES reg_links(id), n INTEGER NOT NULL,
      PRIMARY KEY (board, member, link))`);
    // Board organization (every board has exactly one reg_board_spaces row; every statement is IF NOT EXISTS, so re-running start-up is a no-op).
    d.run("CREATE TABLE IF NOT EXISTS reg_tenant_meta (tenant TEXT PRIMARY KEY REFERENCES reg_tenants(id), kind TEXT NOT NULL)");
    d.run(`CREATE TABLE IF NOT EXISTS reg_tenant_domains (
      domain TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES reg_tenants(id), n INTEGER NOT NULL)`);
    d.run(`CREATE TABLE IF NOT EXISTS reg_groups (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES reg_tenants(id), name TEXT NOT NULL, general_role TEXT, created_at INTEGER NOT NULL)`);
    d.run(`CREATE TABLE IF NOT EXISTS reg_spaces (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES reg_tenants(id), grp TEXT REFERENCES reg_groups(id), name TEXT NOT NULL,
      kind TEXT NOT NULL, owner_user TEXT, general_role TEXT, created_at INTEGER NOT NULL,
      trashed_at INTEGER, trashed_by TEXT, purging INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, UNIQUE (tenant, owner_user))`);
    d.run(`CREATE TABLE IF NOT EXISTS reg_board_spaces (
      board TEXT PRIMARY KEY REFERENCES reg_boards(id), space TEXT NOT NULL REFERENCES reg_spaces(id))`);
    d.run(`CREATE TABLE IF NOT EXISTS reg_teams (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES reg_tenants(id), name TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    d.run(`CREATE TABLE IF NOT EXISTS reg_team_members (
      team TEXT NOT NULL REFERENCES reg_teams(id), member TEXT NOT NULL, PRIMARY KEY (team, member))`);
    d.run(`CREATE TABLE IF NOT EXISTS reg_members (
      tenant TEXT NOT NULL REFERENCES reg_tenants(id), member TEXT NOT NULL, name TEXT, email TEXT, removed_at INTEGER, removed_by TEXT, PRIMARY KEY (tenant, member))`);
    d.run(`CREATE TABLE IF NOT EXISTS reg_scope_grants (
      scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, subject_type TEXT NOT NULL, subject TEXT NOT NULL, role TEXT NOT NULL, n INTEGER NOT NULL,
      PRIMARY KEY (scope_type, scope_id, subject_type, subject))`);
    d.run(`CREATE TABLE IF NOT EXISTS reg_roles (
      tenant TEXT NOT NULL REFERENCES reg_tenants(id), id TEXT NOT NULL, name TEXT NOT NULL, base TEXT, board_role TEXT,
      permissions TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (tenant, id))`);
    // Access requests (PROTOCOL.md § Access explanation and requests): one row per (scope, member); a dismissed row stays until its cooldown ends.
    d.run(`CREATE TABLE IF NOT EXISTS reg_access_requests (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES reg_tenants(id), scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, member TEXT NOT NULL,
      role TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL, closed_at INTEGER, UNIQUE (scope_type, scope_id, member))`);
    d.run("CREATE INDEX IF NOT EXISTS reg_access_requests_member ON reg_access_requests (tenant, member, at)");
    d.run("CREATE INDEX IF NOT EXISTS reg_access_requests_scope ON reg_access_requests (scope_type, scope_id, state, at DESC)");
    // Home (PROTOCOL.md § Home): Recent and Starred, one row per (member, board).
    d.run(`CREATE TABLE IF NOT EXISTS reg_recents (
      member TEXT NOT NULL, board TEXT NOT NULL REFERENCES reg_boards(id), opened_at INTEGER NOT NULL, PRIMARY KEY (member, board))`);
    d.run(`CREATE TABLE IF NOT EXISTS reg_stars (
      member TEXT NOT NULL, board TEXT NOT NULL REFERENCES reg_boards(id), at INTEGER NOT NULL, PRIMARY KEY (member, board))`);
    // Idempotent creates (PROTOCOL.md): one row per (member, key), written in the create's own transaction; `ref` is the id it made.
    d.run(`CREATE TABLE IF NOT EXISTS reg_idempotency (
      member TEXT NOT NULL, k TEXT NOT NULL, fp TEXT NOT NULL, ref TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (member, k))`);
    d.run("CREATE INDEX IF NOT EXISTS reg_idempotency_at ON reg_idempotency (at)");
    d.run("CREATE INDEX IF NOT EXISTS reg_recents_member ON reg_recents (member, opened_at DESC, board DESC)");
    d.run("CREATE INDEX IF NOT EXISTS reg_stars_member ON reg_stars (member, at DESC, board DESC)");
    d.run("CREATE INDEX IF NOT EXISTS reg_grants_member ON reg_grants (member)");
    d.run("CREATE INDEX IF NOT EXISTS reg_boards_tenant ON reg_boards (tenant, id)");
    d.run("CREATE INDEX IF NOT EXISTS reg_boards_trash ON reg_boards (trashed_at) WHERE trashed_at IS NOT NULL");
    d.run("CREATE INDEX IF NOT EXISTS reg_boards_purging ON reg_boards (id) WHERE purging = 1");
    d.run("CREATE INDEX IF NOT EXISTS reg_spaces_purging ON reg_spaces (id) WHERE purging = 1");
    d.run("CREATE INDEX IF NOT EXISTS reg_boards_trashed_with ON reg_boards (trashed_with) WHERE trashed_with IS NOT NULL");
    d.run("CREATE INDEX IF NOT EXISTS reg_board_spaces_space ON reg_board_spaces (space, board)");
    d.run("CREATE INDEX IF NOT EXISTS reg_spaces_trash ON reg_spaces (trashed_at) WHERE trashed_at IS NOT NULL");
    d.run("CREATE INDEX IF NOT EXISTS reg_invites_email ON reg_invites (email)");
    d.run("CREATE INDEX IF NOT EXISTS reg_link_uses_member ON reg_link_uses (member, board)");
    d.run("CREATE INDEX IF NOT EXISTS reg_scope_grants_role ON reg_scope_grants (role, subject_type, subject)");
    d.run("CREATE INDEX IF NOT EXISTS reg_scope_grants_subject ON reg_scope_grants (subject_type, subject, scope_type)");
    d.run("CREATE INDEX IF NOT EXISTS reg_team_members_member ON reg_team_members (member)");
    d.run("CREATE INDEX IF NOT EXISTS reg_spaces_tenant ON reg_spaces (tenant)");
    d.run("CREATE INDEX IF NOT EXISTS reg_spaces_grp ON reg_spaces (grp, id)");
    d.run("CREATE INDEX IF NOT EXISTS reg_groups_tenant ON reg_groups (tenant)");
    d.run("CREATE INDEX IF NOT EXISTS reg_teams_tenant ON reg_teams (tenant)");
    d.run(`CREATE TABLE IF NOT EXISTS reg_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL REFERENCES reg_tenants(id), board TEXT,
      actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, at INTEGER NOT NULL)`);
    d.run("CREATE INDEX IF NOT EXISTS reg_audit_tenant ON reg_audit (tenant, at DESC, id DESC)");
    d.run("CREATE INDEX IF NOT EXISTS reg_audit_board ON reg_audit (tenant, board, at DESC, id DESC)");
    d.run(`CREATE TABLE IF NOT EXISTS reg_board_versions (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES reg_tenants(id), board_id TEXT NOT NULL REFERENCES reg_boards(id) ON DELETE CASCADE,
      label TEXT NOT NULL, created_by TEXT NOT NULL, created_by_name TEXT, created_at INTEGER NOT NULL, element_count INTEGER NOT NULL, snapshot_json TEXT NOT NULL)`);
    d.run("CREATE INDEX IF NOT EXISTS reg_board_versions_board ON reg_board_versions (tenant_id, board_id, created_at DESC, id DESC)");
};

/**
 * @param {import("bun:sqlite").Database} db
 * @param {{ path: string, now?: () => number, fullfsync?: boolean, busyTimeoutMs?: number, busy?: { clock?: () => number, onAttempt?: (budgetMs: number) => void } }} opts
 */
function build(db, { path, now = Date.now, fullfsync = true, busyTimeoutMs = 5000, busy = {} }) {
  const { clock = Date.now, onAttempt } = busy;
  let open = true;
  const wait = Math.max(0, Math.floor(busyTimeoutMs));
  db.run(`PRAGMA busy_timeout=${wait}`);
  // Before any write to the file (no WAL switch, no CREATE): an old-format file is refused as it was found.
  const has = t => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  if (has("reg_boards") && !has("reg_spaces"))   // from before the organization: boards, no Spaces
    throw oldFormat("sqlite registry: the file has reg_boards but no reg_spaces: it is from an older version. Reset the store (delete the file)");
  if (has("reg_boards") && (!has("reg_board_spaces") || db.query("SELECT 1 AS x FROM reg_boards b WHERE NOT EXISTS (SELECT 1 FROM reg_board_spaces s WHERE s.board = b.id) LIMIT 1").get()))   // a board in no Space (pre-#90)
    throw oldFormat("sqlite registry: the file holds a board that is in no Space: it is from an older version. Reset the store (delete the file)");
  // Additive migration for existing origin/main DBs (adds reg_tenants.name, reg_tenant_members, reg_audit safely under onBusyRetry).
  const deadline = clock() + wait;
  if (has("reg_tenants") && has("reg_spaces")) {
    onBusyRetry(db, deadline, () => db.transaction(() => {
      if (!db.query("PRAGMA table_info(reg_tenants)").all().some(c => c.name === "name")) {
        try { db.run("ALTER TABLE reg_tenants ADD COLUMN name TEXT"); }
        catch (err) { if (!String(err?.message ?? "").includes("duplicate column")) throw err; }
      }
      if (!has("reg_tenant_members")) {
        db.run("CREATE TABLE IF NOT EXISTS reg_tenant_members (tenant TEXT NOT NULL REFERENCES reg_tenants(id) ON DELETE CASCADE, email TEXT NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY (tenant, email))");
        db.run("CREATE INDEX IF NOT EXISTS reg_tenant_members_email ON reg_tenant_members (email)");
      }
      if (!has("reg_audit")) {
        db.run(`CREATE TABLE IF NOT EXISTS reg_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL REFERENCES reg_tenants(id), board TEXT,
          actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, at INTEGER NOT NULL)`);
        db.run("CREATE INDEX IF NOT EXISTS reg_audit_tenant ON reg_audit (tenant, at DESC, id DESC)");
        db.run("CREATE INDEX IF NOT EXISTS reg_audit_board ON reg_audit (tenant, board, at DESC, id DESC)");
      }
      if (!has("reg_board_versions")) {
        db.run(`CREATE TABLE IF NOT EXISTS reg_board_versions (
          id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES reg_tenants(id), board_id TEXT NOT NULL REFERENCES reg_boards(id) ON DELETE CASCADE,
          label TEXT NOT NULL, created_by TEXT NOT NULL, created_by_name TEXT, created_at INTEGER NOT NULL, element_count INTEGER NOT NULL, snapshot_json TEXT NOT NULL)`);
        db.run("CREATE INDEX IF NOT EXISTS reg_board_versions_board ON reg_board_versions (tenant_id, board_id, created_at DESC, id DESC)");
      }
      if (has("reg_links")) {
        const linkCols = db.query("PRAGMA table_info(reg_links)").all();
        if (!linkCols.some(c => c.name === "passcode_hash")) {
          try { db.run("ALTER TABLE reg_links ADD COLUMN passcode_hash TEXT"); }
          catch (err) { if (!String(err?.message ?? "").includes("duplicate column")) throw err; }
        }
        if (!linkCols.some(c => c.name === "no_download")) {
          try { db.run("ALTER TABLE reg_links ADD COLUMN no_download INTEGER NOT NULL DEFAULT 0"); }
          catch (err) { if (!String(err?.message ?? "").includes("duplicate column")) throw err; }
        }
      }
    }).immediate(), clock, onAttempt);
  }
  assertShapes(db, createSchema, "sqlite registry");
  // Several processes opening one brand-new file at once (N nodes or bootstrap scripts): switching to WAL needs an
  // exclusive lock, and SQLite returns BUSY for it without calling the busy handler, so busy_timeout alone doesn't
  // help (reproduced: ~1 in 10 of 12 simultaneous opens failed at this pragma). So: skip the switch once the file
  // already reads WAL (it is persistent), and retry it, and the first schema transaction, with a short backoff
  // until the same busy_timeout budget runs out, in total (onBusyRetry caps each attempt's busy wait at what is
  // left). Every later statement waits through the busy handler as usual, with the full busy_timeout again.
  onBusyRetry(db, deadline, () => {
    if (db.query("PRAGMA journal_mode").get()?.journal_mode !== "wal") db.run("PRAGMA journal_mode=WAL");
  }, clock, onAttempt);
  db.run("PRAGMA synchronous=FULL");
  db.run(`PRAGMA fullfsync=${fullfsync ? "ON" : "OFF"}`);
  db.run(`PRAGMA checkpoint_fullfsync=${fullfsync ? "ON" : "OFF"}`);
  db.run("PRAGMA foreign_keys=ON");

  onBusyRetry(db, deadline, () => db.transaction(() => {
    createSchema(db);
  }).immediate(), clock, onAttempt);
  db.run(`PRAGMA busy_timeout=${wait}`);                     // start-up spent part of it; runtime gets the whole budget

  let idemCalls = 0;
  // A grant row `g` of the tenant ?3: a scoped grant has no tenant column, its scope's row says whose it is (a shared id such as "member" must never count another Unit's).
  const OWN_GRANT = `CASE g.scope_type WHEN 'unit' THEN g.scope_id = ?3 WHEN 'group' THEN EXISTS (SELECT 1 FROM reg_groups x WHERE x.id = g.scope_id AND x.tenant = ?3)
    WHEN 'space' THEN EXISTS (SELECT 1 FROM reg_spaces x WHERE x.id = g.scope_id AND x.tenant = ?3) ELSE EXISTS (SELECT 1 FROM reg_boards x WHERE x.id = g.scope_id AND x.tenant = ?3) END`;
  const q = {
    tenant: db.query("SELECT id, name, domain, created_at FROM reg_tenants WHERE id = ?"),
    tenantByDomain: db.query(`SELECT id, name, domain, created_at FROM reg_tenants WHERE domain = ?1
      UNION ALL SELECT t.id, t.name, t.domain, t.created_at FROM reg_tenant_domains d JOIN reg_tenants t ON t.id = d.tenant WHERE d.domain = ?1`),
    personalTenants: db.query("SELECT id, name, domain, created_at FROM reg_tenants WHERE domain IS NULL ORDER BY created_at ASC, id ASC"),
    tenantExists: db.query("SELECT 1 AS x FROM reg_tenants WHERE id = ?"),
    insTenant: db.query("INSERT INTO reg_tenants (id, name, domain, created_at) VALUES (?, ?, ?, ?)"),
    admins: db.query("SELECT member FROM reg_tenant_admins WHERE tenant = ? ORDER BY n"),
    adminsAmong: db.query("SELECT DISTINCT member FROM reg_tenant_admins WHERE member IN (SELECT value FROM json_each(?))"),
    adminN: db.query("SELECT coalesce(max(n), 0) + 1 AS n FROM reg_tenant_admins WHERE tenant = ?"),
    insAdmin: db.query("INSERT INTO reg_tenant_admins (tenant, member, n) VALUES (?, ?, ?) ON CONFLICT (tenant, member) DO NOTHING"),
    insTenantMember: db.query("INSERT INTO reg_tenant_members (tenant, email, added_at) VALUES (?, ?, ?) ON CONFLICT (tenant, email) DO NOTHING"),
    delTenantMember: db.query("DELETE FROM reg_tenant_members WHERE tenant = ? AND email = ?"),
    listTenantMembers: db.query("SELECT email FROM reg_tenant_members WHERE tenant = ? ORDER BY email ASC"),
    isTenantMember: db.query("SELECT 1 AS x FROM reg_tenant_members WHERE tenant = ? AND email = ?"),
    tenantsForMember: db.query("SELECT t.id, t.name, t.domain, t.created_at FROM reg_tenant_members m JOIN reg_tenants t ON t.id = m.tenant WHERE m.email = ? ORDER BY t.created_at ASC, t.id ASC"),
    tenantsForAdmin1: db.query("SELECT DISTINCT t.id, t.name, t.domain, t.created_at FROM reg_tenant_admins a JOIN reg_tenants t ON t.id = a.tenant WHERE a.member = ? ORDER BY t.created_at ASC, t.id ASC"),
    tenantsForAdmin2: db.query("SELECT DISTINCT t.id, t.name, t.domain, t.created_at FROM reg_tenant_admins a JOIN reg_tenants t ON t.id = a.tenant WHERE a.member IN (?, ?) ORDER BY t.created_at ASC, t.id ASC"),
    grantsForUserAll: db.query("SELECT b.id, b.tenant, b.title, b.member_role, b.created_at, b.trashed_at, b.trashed_by, b.trashed_with, (SELECT space FROM reg_board_spaces WHERE board = b.id) AS space, g.role FROM reg_grants g JOIN reg_boards b ON b.id = g.board WHERE g.member = ? AND b.trashed_at IS NULL"),
    invitesForEmailAll: db.query("SELECT b.id, b.tenant, b.title, b.member_role, b.created_at, b.trashed_at, b.trashed_by, b.trashed_with, (SELECT space FROM reg_board_spaces WHERE board = b.id) AS space, i.role, i.expires_at, i.revoked FROM reg_invites i JOIN reg_boards b ON b.id = i.board WHERE i.email = ? AND b.trashed_at IS NULL"),
    linksForUserAll: db.query("SELECT b.id, b.tenant, b.title, b.member_role, b.created_at, b.trashed_at, b.trashed_by, b.trashed_with, (SELECT space FROM reg_board_spaces WHERE board = b.id) AS space, l.role, l.expires_at, l.revoked FROM reg_link_uses u JOIN reg_links l ON l.id = u.link JOIN reg_boards b ON b.id = l.board WHERE u.member = ? AND b.trashed_at IS NULL"),

    tenantKind: db.query("SELECT kind FROM reg_tenant_meta WHERE tenant = ?"),
    insKind: db.query("INSERT INTO reg_tenant_meta (tenant, kind) VALUES (?, ?)"),
    extraDomains: db.query("SELECT domain FROM reg_tenant_domains WHERE tenant = ? ORDER BY n"),
    extraDomainOwner: db.query("SELECT tenant FROM reg_tenant_domains WHERE domain = ?"),
    extraDomainN: db.query("SELECT coalesce(max(n), 0) + 1 AS n FROM reg_tenant_domains WHERE tenant = ?"),
    insDomain: db.query("INSERT INTO reg_tenant_domains (domain, tenant, n) VALUES (?, ?, ?)"),
    setPrimary: db.query("UPDATE reg_tenants SET domain = ? WHERE id = ? AND domain IS NULL"),

    board: db.query("SELECT id, tenant, title, member_role, created_at, trashed_at, trashed_by, trashed_with, purging, (SELECT space FROM reg_board_spaces WHERE board = reg_boards.id) AS space FROM reg_boards WHERE id = ?"),
    boardsByTenant: db.query("SELECT id, tenant, title, member_role, created_at, trashed_at, trashed_by, trashed_with, purging, (SELECT space FROM reg_board_spaces WHERE board = reg_boards.id) AS space FROM reg_boards WHERE tenant = ? AND trashed_at IS NULL ORDER BY created_at DESC, id ASC"),
    insBoardSpace: db.query("INSERT INTO reg_board_spaces (board, space) VALUES (?, ?)"),
    putBoardSpace: db.query("UPDATE reg_board_spaces SET space = ?2 WHERE board = ?1"),

    group: db.query("SELECT * FROM reg_groups WHERE id = ?"),
    groups: db.query("SELECT * FROM reg_groups WHERE tenant = ? ORDER BY created_at, id"),
    insGroup: db.query("INSERT INTO reg_groups (id, tenant, name, general_role, created_at) VALUES (?, ?, ?, ?, ?)"),
    space: db.query("SELECT * FROM reg_spaces WHERE id = ?"),
    spaces: db.query("SELECT * FROM reg_spaces WHERE tenant = ? AND trashed_at IS NULL ORDER BY created_at, id"),
    spacesIn: db.query("SELECT * FROM reg_spaces WHERE grp = ?1 AND trashed_at IS NULL AND (?2 IS NULL OR id > ?2) ORDER BY id LIMIT ?3"),
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
    teamsPage: db.query(`SELECT t.id, t.tenant, t.name, t.created_at, (SELECT count(*) FROM (SELECT 1 FROM reg_team_members m WHERE m.team = t.id LIMIT ${TEAMS.sizeCap + 1})) AS size
      FROM reg_teams t WHERE t.tenant = ?1 AND (?2 IS NULL OR t.id > ?2) AND (?3 IS NULL OR t.name LIKE ?3 ESCAPE '\\') ORDER BY t.id LIMIT ?4`),
    teamsAmong: db.query(`SELECT t.id, t.tenant, t.name, t.created_at, (SELECT count(*) FROM (SELECT 1 FROM reg_team_members m WHERE m.team = t.id LIMIT ${TEAMS.sizeCap + 1})) AS size
      FROM reg_teams t WHERE t.tenant = ? AND t.id IN (SELECT value FROM json_each(?)) ORDER BY t.id`),
    membersPage: db.query("SELECT member FROM reg_team_members WHERE team = ? AND (?2 IS NULL OR member > ?2) ORDER BY member LIMIT ?3"),
    sgrantsPage: db.query(`SELECT subject_type, subject, role FROM reg_scope_grants WHERE scope_type = ?1 AND scope_id = ?2
      AND (?3 IS NULL OR subject_type || char(10) || subject > ?3) ORDER BY subject_type, subject LIMIT ?4`),
    delTeamGrants: db.query("DELETE FROM reg_scope_grants WHERE subject_type = 'team' AND subject = ?"),
    delTeamMembers: db.query("DELETE FROM reg_team_members WHERE team = ?"),
    delTeam: db.query("DELETE FROM reg_teams WHERE id = ?"),
    renTeam: db.query("UPDATE reg_teams SET name = ? WHERE id = ?"),
    dirGet: db.query("SELECT member AS user, name, email, removed_at, removed_by FROM reg_members WHERE tenant = ? AND member = ?"),
    dirPut: db.query("INSERT INTO reg_members (tenant, member, name, email) VALUES (?, ?, ?, ?) ON CONFLICT (tenant, member) DO UPDATE SET name = excluded.name, email = excluded.email"),
    dirAmong: db.query("SELECT member AS user, name, email, removed_at IS NOT NULL AS removed FROM reg_members WHERE tenant = ? AND member IN (SELECT value FROM json_each(?))"),
    removedAmong: db.query("SELECT member FROM reg_members WHERE tenant = ? AND removed_at IS NOT NULL AND member IN (SELECT value FROM json_each(?)) ORDER BY member"),
    dirFind: db.query(`SELECT member AS user, name, email FROM reg_members WHERE tenant = ?1 AND removed_at IS NULL AND (?2 IS NULL OR name LIKE ?2 ESCAPE '\\' OR email LIKE ?2 ESCAPE '\\' OR member LIKE ?2 ESCAPE '\\')
      ORDER BY coalesce(name, member), member LIMIT ?3`),
    sowners: db.query(`SELECT subject_type, subject FROM reg_scope_grants g WHERE scope_type = ? AND scope_id = ? AND role = 'owner'
      AND (subject_type = 'user' OR EXISTS (SELECT 1 FROM reg_team_members m WHERE m.team = g.subject))`),
    teamOwned: db.query("SELECT scope_type, scope_id FROM reg_scope_grants WHERE subject_type = 'team' AND subject = ? AND role = 'owner' AND scope_type IN ('group', 'space')"),
    teamSize: db.query("SELECT count(*) AS c FROM reg_team_members WHERE team = ?"),
    teamHas: db.query("SELECT 1 AS x FROM reg_team_members WHERE team = ? AND member = ?"),
    // ?4 = 1: boards in Trash are listed too (an announcement reaches them).
    boardsInUnit: db.query("SELECT id FROM reg_boards WHERE tenant = ?1 AND (?4 = 1 OR trashed_at IS NULL) AND (?2 IS NULL OR id > ?2) ORDER BY id LIMIT ?3"),
    boardsInSpace: db.query("SELECT bs.board AS id FROM reg_board_spaces bs JOIN reg_boards b ON b.id = bs.board WHERE bs.space = ?1 AND (?4 = 1 OR b.trashed_at IS NULL) AND (?2 IS NULL OR bs.board > ?2) ORDER BY bs.board LIMIT ?3"),
    boardsInGroup: db.query("SELECT bs.board AS id FROM reg_board_spaces bs JOIN reg_spaces s ON s.id = bs.space JOIN reg_boards b ON b.id = bs.board WHERE s.grp = ?1 AND (?4 = 1 OR b.trashed_at IS NULL) AND (?2 IS NULL OR bs.board > ?2) ORDER BY bs.board LIMIT ?3"),
    // ?1 type, ?2 id, ?3 limit: the team's/user's grants on a personal space or a board in one.
    personalScopesOf: db.query(`SELECT g.scope_type, g.scope_id, g.role FROM reg_scope_grants g WHERE g.subject_type = ?1 AND g.subject = ?2 AND (
      (g.scope_type = 'space' AND EXISTS (SELECT 1 FROM reg_spaces s WHERE s.id = g.scope_id AND s.kind = 'personal'))
      OR (g.scope_type = 'board' AND EXISTS (SELECT 1 FROM reg_board_spaces bs JOIN reg_spaces s ON s.id = bs.space WHERE bs.board = g.scope_id AND s.kind = 'personal'))) ORDER BY g.scope_type, g.scope_id LIMIT ?3`),
    scopesOf: db.query(`SELECT scope_type, scope_id, role FROM reg_scope_grants WHERE subject_type = ?1 AND subject = ?2
      AND (?3 IS NULL OR (scope_type || char(10) || scope_id) > ?3) ORDER BY scope_type, scope_id LIMIT ?4`),
    // Leaver offboarding (PROTOCOL.md § Leaver offboarding). ?1 tenant, ?2 user, ?3 cursor "<type>\n<id>", ?4 limit. A candidate is a Group or Space the user owns (their own grant, or a Team's they are in) or their personal space;
    // it is solely theirs when no other person owner and no Team owner with a member besides them remains.
    ownedAlone: db.query(`WITH c(t, i) AS (
        SELECT scope_type, scope_id FROM reg_scope_grants WHERE subject_type = 'user' AND subject = ?2 AND role = 'owner' AND scope_type IN ('group', 'space')
        UNION SELECT g.scope_type, g.scope_id FROM reg_team_members m JOIN reg_scope_grants g ON g.subject_type = 'team' AND g.subject = m.team AND g.role = 'owner' AND g.scope_type IN ('group', 'space') WHERE m.member = ?2
        UNION SELECT 'space', id FROM reg_spaces WHERE tenant = ?1 AND owner_user = ?2)
      SELECT c.t AS type, c.i AS id, (c.t = 'space' AND EXISTS (SELECT 1 FROM reg_spaces p WHERE p.id = c.i AND p.owner_user = ?2)) AS personal FROM c
      WHERE (CASE c.t WHEN 'space' THEN (SELECT tenant FROM reg_spaces WHERE id = c.i) ELSE (SELECT tenant FROM reg_groups WHERE id = c.i) END) = ?1
        AND (?3 IS NULL OR (c.t || char(10) || c.i) > ?3)
        AND ((c.t = 'space' AND EXISTS (SELECT 1 FROM reg_spaces p WHERE p.id = c.i AND p.owner_user = ?2)) OR NOT EXISTS (SELECT 1 FROM reg_scope_grants o WHERE o.scope_type = c.t AND o.scope_id = c.i AND o.role = 'owner'
        AND ((o.subject_type = 'user' AND o.subject <> ?2) OR (o.subject_type = 'team' AND EXISTS (SELECT 1 FROM reg_team_members x WHERE x.team = o.subject AND x.member <> ?2)))))
      ORDER BY c.t, c.i LIMIT ?4`),
    soleOne: db.query(`WITH c(t, i) AS (SELECT ?1, ?2) SELECT 1 AS x FROM c WHERE EXISTS (SELECT 1 FROM reg_scope_grants g WHERE g.scope_type = c.t AND g.scope_id = c.i AND g.role = 'owner'
        AND ((g.subject_type = 'user' AND g.subject = ?3) OR (g.subject_type = 'team' AND EXISTS (SELECT 1 FROM reg_team_members m WHERE m.team = g.subject AND m.member = ?3))))
      AND NOT EXISTS (SELECT 1 FROM reg_scope_grants o WHERE o.scope_type = c.t AND o.scope_id = c.i AND o.role = 'owner'
        AND ((o.subject_type = 'user' AND o.subject <> ?3) OR (o.subject_type = 'team' AND EXISTS (SELECT 1 FROM reg_team_members x WHERE x.team = o.subject AND x.member <> ?3))))`),
    revokeInvitesTo: db.query("UPDATE reg_invites SET revoked = 1 WHERE revoked = 0 AND lower(trim(email)) = lower(trim(?1)) AND board IN (SELECT id FROM reg_boards WHERE tenant = ?2)"),
    archiveSpace: db.query("UPDATE reg_spaces SET kind = 'shared', owner_user = NULL, archived_at = ?2, name = ?3 WHERE id = ?1"),
    isAdmin: db.query("SELECT 1 AS x FROM reg_tenant_admins WHERE tenant = ?1 AND (member = ?2 OR (?3 IS NOT NULL AND member = 'email:' || lower(trim(?3))))"),
    markRemoved: db.query("UPDATE reg_members SET removed_at = ?3, removed_by = ?4 WHERE tenant = ?1 AND member = ?2 AND removed_at IS NULL"),
    delUserGrants: db.query("DELETE FROM reg_grants WHERE member = ?1 AND board IN (SELECT id FROM reg_boards WHERE tenant = ?2)"),
    delUserScoped: db.query(`DELETE FROM reg_scope_grants WHERE subject_type = 'user' AND subject = ?1 AND ((scope_type = 'unit' AND scope_id = ?2)
      OR (scope_type = 'group' AND scope_id IN (SELECT id FROM reg_groups WHERE tenant = ?2)) OR (scope_type = 'space' AND scope_id IN (SELECT id FROM reg_spaces WHERE tenant = ?2)))`),
    delUserTeams: db.query("DELETE FROM reg_team_members WHERE member = ?1 AND team IN (SELECT id FROM reg_teams WHERE tenant = ?2)"),
    delUserAsks: db.query("DELETE FROM reg_access_requests WHERE tenant = ?1 AND member = ?2"),
    sgrantN: db.query("SELECT coalesce(max(n), 0) + 1 AS n FROM reg_scope_grants WHERE scope_type = ? AND scope_id = ?"),
    upSgrant: db.query(`INSERT INTO reg_scope_grants (scope_type, scope_id, subject_type, subject, role, n) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (scope_type, scope_id, subject_type, subject) DO UPDATE SET role = excluded.role`),
    delSgrant: db.query("DELETE FROM reg_scope_grants WHERE scope_type = ? AND scope_id = ? AND subject_type = ? AND subject = ?"),
    role: db.query("SELECT * FROM reg_roles WHERE tenant = ? AND id = ?"),
    roles: db.query("SELECT * FROM reg_roles WHERE tenant = ? ORDER BY created_at, id"),
    roleCount: db.query("SELECT count(*) AS n FROM reg_roles WHERE tenant = ? AND id <> 'member'"),
    delRole: db.query("DELETE FROM reg_roles WHERE tenant = ? AND id = ?"),
    roleHeld: db.query(`SELECT 1 AS x FROM reg_scope_grants g WHERE g.role = ?1 AND ${OWN_GRANT} LIMIT ?2`),
    // One statement per role: places and distinct people counted to the cap + 1, and the Team ids (comma-joined; ids hold no comma).
    roleUse: db.query(`SELECT (SELECT count(*) FROM (SELECT 1 FROM reg_scope_grants g WHERE g.role = ?1 AND ${OWN_GRANT} LIMIT ?2)) AS places,
      (SELECT count(*) FROM (SELECT DISTINCT g.subject FROM reg_scope_grants g WHERE g.role = ?1 AND g.subject_type = 'user' AND ${OWN_GRANT} LIMIT ?2)) AS users,
      (SELECT group_concat(subject, ',') FROM (SELECT DISTINCT g.subject FROM reg_scope_grants g WHERE g.role = ?1 AND g.subject_type = 'team' AND ${OWN_GRANT} ORDER BY g.subject LIMIT ?4)) AS teams`),
    memberN: db.query("SELECT count(*) AS n FROM (SELECT 1 FROM reg_members WHERE tenant = ?1 LIMIT ?2)"),
    insRole: db.query("INSERT INTO reg_roles (tenant, id, name, base, board_role, permissions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    upRole: db.query("UPDATE reg_roles SET name = ?, board_role = ?, permissions = ? WHERE tenant = ? AND id = ?"),
    askGet: db.query("SELECT * FROM reg_access_requests WHERE scope_type = ? AND scope_id = ? AND member = ?"),
    askUp: db.query(`INSERT INTO reg_access_requests (id, tenant, scope_type, scope_id, member, role, state, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)
      ON CONFLICT (scope_type, scope_id, member) DO UPDATE SET id = excluded.id, role = excluded.role, state = 'pending', at = excluded.at, closed_at = NULL`),
    askUser: db.query("SELECT count(*) AS n, min(at) AS first FROM reg_access_requests WHERE tenant = ?1 AND member = ?2 AND at > ?3 AND NOT (scope_type = ?4 AND scope_id = ?5)"),
    askScopeN: db.query("SELECT count(*) AS n FROM reg_access_requests WHERE scope_type = ? AND scope_id = ? AND state = 'pending' AND at > ? AND member <> ?"),
    askList: db.query("SELECT * FROM reg_access_requests WHERE scope_type = ? AND scope_id = ? AND state = 'pending' AND at > ? ORDER BY at DESC, id DESC LIMIT ?"),
    askPrune: db.query("DELETE FROM reg_access_requests WHERE rowid IN (SELECT rowid FROM reg_access_requests WHERE COALESCE(closed_at, at) <= ?1 LIMIT ?2)"),
    askClose: db.query("UPDATE reg_access_requests SET state = ?1, closed_at = ?2 WHERE scope_type = ?3 AND scope_id = ?4 AND member = ?5"),
    holders: db.query(`SELECT subject_type, subject, role FROM reg_scope_grants WHERE scope_type = ?1 AND scope_id = ?2
      AND role IN (SELECT value FROM json_each(?3)) ORDER BY subject_type, subject LIMIT ?4`),
    upRecent: db.query(`INSERT INTO reg_recents (member, board, opened_at) VALUES (?1, ?2, ?3)
      ON CONFLICT (member, board) DO UPDATE SET opened_at = excluded.opened_at`),
    pruneRecent: db.query(`DELETE FROM reg_recents WHERE member = ?1 AND board IN
      (SELECT board FROM reg_recents WHERE member = ?1 ORDER BY opened_at DESC, board DESC LIMIT -1 OFFSET ?2)`),
    recents: db.query("SELECT board, opened_at AS at FROM reg_recents WHERE member = ? ORDER BY opened_at DESC, board DESC LIMIT ?"),
    idemGet: db.query("SELECT fp, ref, at FROM reg_idempotency WHERE member = ? AND k = ?"),
    idemCount: db.query("SELECT count(*) AS n FROM reg_idempotency"),
    idemPut: db.query("INSERT OR REPLACE INTO reg_idempotency (member, k, fp, ref, at) VALUES (?, ?, ?, ?, ?)"),
    idemPrune: db.query("DELETE FROM reg_idempotency WHERE rowid IN (SELECT rowid FROM reg_idempotency WHERE at <= ?1 LIMIT ?2)"),
    upStar: db.query("INSERT INTO reg_stars (member, board, at) VALUES (?, ?, ?) ON CONFLICT (member, board) DO NOTHING"),
    delStar: db.query("DELETE FROM reg_stars WHERE member = ? AND board = ?"),
    stars: db.query("SELECT board, at FROM reg_stars WHERE member = ? ORDER BY at DESC, board DESC LIMIT ?"),
    starsAmong: db.query("SELECT board FROM reg_stars WHERE member = ? AND board IN (SELECT value FROM json_each(?))"),
    shared: db.query(`SELECT board FROM (
        SELECT board FROM reg_grants WHERE member = ?1
        UNION SELECT g.scope_id AS board FROM reg_team_members m CROSS JOIN reg_scope_grants g INDEXED BY reg_scope_grants_subject ON g.subject_type = 'team' AND g.subject = m.team AND g.scope_type = 'board'
          WHERE m.member = ?1
        UNION SELECT board FROM reg_invites WHERE ?2 IS NOT NULL AND email = ?2 AND revoked = 0
        UNION SELECT board FROM reg_link_uses WHERE member = ?1) WHERE NOT EXISTS (SELECT 1 FROM reg_boards x WHERE x.id = board AND x.trashed_at IS NOT NULL) ORDER BY board LIMIT ?3`),
    search: db.query(`SELECT w.id FROM (SELECT id, title FROM reg_boards WHERE tenant = ?1 AND trashed_at IS NULL AND (?2 IS NULL OR id > ?2) ORDER BY id LIMIT ?4) w
      JOIN reg_board_spaces bs ON bs.board = w.id JOIN reg_spaces s ON s.id = bs.space
      WHERE ?3 IS NULL OR w.title LIKE ?3 ESCAPE '\\' OR s.name LIKE ?3 ESCAPE '\\'
      ORDER BY w.id`),
    searchEdge: db.query("SELECT id FROM reg_boards WHERE tenant = ?1 AND trashed_at IS NULL AND (?2 IS NULL OR id > ?2) ORDER BY id LIMIT 2 OFFSET ?3"),
    spaceCand: db.query(`SELECT s.* FROM reg_spaces s WHERE s.tenant = ?1 AND s.trashed_at IS NULL AND (?2 IS NULL OR s.id > ?2) AND (?6 = 0 OR s.kind = 'personal') AND (?4 = 1
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
    rowsBoards: db.query(`SELECT id, tenant, title, member_role, created_at, trashed_at, trashed_by, trashed_with, purging, (SELECT space FROM reg_board_spaces WHERE board = reg_boards.id) AS space
      FROM reg_boards WHERE id IN (SELECT value FROM json_each(?))`),
    rowsGrants: db.query("SELECT board, role FROM reg_grants WHERE member = ? AND board IN (SELECT value FROM json_each(?))"),
    rowsTeamGrants: db.query(`SELECT scope_id, subject_type, subject, role FROM reg_scope_grants WHERE scope_type = 'board'
      AND scope_id IN (SELECT value FROM json_each(?)) ORDER BY n`),
    rowsMyTeams: db.query("SELECT team FROM reg_team_members WHERE member = ? AND team IN (SELECT value FROM json_each(?))"),
    rowsInvites: db.query(`SELECT * FROM reg_invites WHERE ?1 IS NOT NULL AND email = ?1 AND revoked = 0 AND board IN (SELECT value FROM json_each(?2)) ORDER BY n`),
    rowsUses: db.query("SELECT board, link FROM reg_link_uses WHERE member = ? AND board IN (SELECT value FROM json_each(?)) ORDER BY n"),
    rowsLinks: db.query(`SELECT l.* FROM reg_link_uses u JOIN reg_links l ON l.id = u.link
      WHERE u.member = ? AND u.board IN (SELECT value FROM json_each(?)) ORDER BY u.n`),
    // Trash (PROTOCOL.md § Trash and restore)
    trashBoard: db.query("UPDATE reg_boards SET trashed_at = ?2, trashed_by = ?3, trashed_with = NULL WHERE id = ?1 AND trashed_at IS NULL"),
    trashSpace: db.query("UPDATE reg_spaces SET trashed_at = ?2, trashed_by = ?3 WHERE id = ?1 AND trashed_at IS NULL"),
    trashSpaceBoards: db.query("UPDATE reg_boards SET trashed_at = ?2, trashed_by = ?3, trashed_with = ?1 WHERE trashed_at IS NULL AND id IN (SELECT board FROM reg_board_spaces WHERE space = ?1)"),
    restoreBoard: db.query("UPDATE reg_boards SET trashed_at = NULL, trashed_by = NULL, trashed_with = NULL, purging = 0 WHERE id = ?1"),
    restoreSpace: db.query("UPDATE reg_spaces SET trashed_at = NULL, trashed_by = NULL WHERE id = ?1"),
    restoreSpaceBoards: db.query("UPDATE reg_boards SET trashed_at = NULL, trashed_by = NULL, trashed_with = NULL, purging = 0 WHERE trashed_with = ?1"),
    spaceBoardsClaimed: db.query("SELECT 1 AS x FROM reg_boards WHERE trashed_with = ? AND purging = 1 LIMIT 1"),
    trashedBoards: db.query("SELECT id, tenant, title, member_role, created_at, trashed_at, trashed_by, trashed_with, purging, (SELECT space FROM reg_board_spaces WHERE board = reg_boards.id) AS space FROM reg_boards WHERE tenant = ?1 AND trashed_at IS NOT NULL AND trashed_with IS NULL AND purging = 0 AND (?2 IS NULL OR id > ?2) ORDER BY id LIMIT ?3"),
    trashedSpaces: db.query(`SELECT s.*, (SELECT count(*) FROM (SELECT 1 FROM reg_boards b WHERE b.trashed_with = s.id LIMIT ?4)) AS boards FROM reg_spaces s
      WHERE s.tenant = ?1 AND s.trashed_at IS NOT NULL AND s.purging = 0 AND (?2 IS NULL OR s.id > ?2) ORDER BY s.id LIMIT ?3`),
    dueBoards: db.query("SELECT id, tenant, title, member_role, created_at, trashed_at, trashed_by, trashed_with, purging, (SELECT space FROM reg_board_spaces WHERE board = reg_boards.id) AS space FROM reg_boards WHERE trashed_at IS NOT NULL AND (trashed_at <= ?1 OR purging = 1) ORDER BY trashed_at, id LIMIT ?2"),
    dueSpaces: db.query("SELECT * FROM reg_spaces WHERE trashed_at IS NOT NULL AND (trashed_at <= ?1 OR purging = 1) ORDER BY trashed_at, id LIMIT ?2"),
    unclaimedBoards: db.query("SELECT id, tenant, title, member_role, created_at, trashed_at, trashed_by, trashed_with, purging, (SELECT space FROM reg_board_spaces WHERE board = reg_boards.id) AS space FROM reg_boards WHERE trashed_at IS NOT NULL AND purging = 0 AND trashed_with IS NULL AND trashed_at <= ?1 ORDER BY trashed_at, id LIMIT ?2"),
    unclaimedSpaces: db.query("SELECT * FROM reg_spaces WHERE trashed_at IS NOT NULL AND purging = 0 AND trashed_at <= ?1 ORDER BY trashed_at, id LIMIT ?2"),
    claimedBoards: db.query("SELECT id, tenant, title, member_role, created_at, trashed_at, trashed_by, trashed_with, purging, (SELECT space FROM reg_board_spaces WHERE board = reg_boards.id) AS space FROM reg_boards WHERE purging = 1 AND trashed_at IS NOT NULL AND (?2 IS NULL OR id > ?2) ORDER BY id LIMIT ?1"),
    claimedSpaces: db.query("SELECT * FROM reg_spaces WHERE purging = 1 AND trashed_at IS NOT NULL AND (?2 IS NULL OR id > ?2) ORDER BY id LIMIT ?1"),
    claimBoard: db.query("UPDATE reg_boards SET purging = 1 WHERE id = ?1 AND trashed_at IS NOT NULL AND (trashed_with IS NULL OR purging = 1) AND (purging = 1 OR trashed_at <= ?2)"),
    claimSpace: db.query("UPDATE reg_spaces SET purging = 1 WHERE id = ?1 AND trashed_at IS NOT NULL AND (purging = 1 OR trashed_at <= ?2)"),
    claimSpaceBoards: db.query("UPDATE reg_boards SET purging = 1 WHERE trashed_with = ?1"),
    spaceHasBoards: db.query("SELECT 1 AS x FROM reg_board_spaces WHERE space = ? LIMIT 1"),
    purgeGrants: db.query("DELETE FROM reg_grants WHERE board = ?"),
    purgeScoped: db.query("DELETE FROM reg_scope_grants WHERE scope_type = ?1 AND scope_id = ?2"),
    purgeInvites: db.query("DELETE FROM reg_invites WHERE board = ?"),
    purgeUses: db.query("DELETE FROM reg_link_uses WHERE board = ?"),
    purgeLinks: db.query("DELETE FROM reg_links WHERE board = ?"),
    purgeRecents: db.query("DELETE FROM reg_recents WHERE board = ?"),
    purgeStars: db.query("DELETE FROM reg_stars WHERE board = ?"),
    purgeAsks: db.query("DELETE FROM reg_access_requests WHERE scope_type = ?1 AND scope_id = ?2"),
    purgeVersions: db.query("DELETE FROM reg_board_versions WHERE board_id = ?"),
    purgeBoardSpace: db.query("DELETE FROM reg_board_spaces WHERE board = ?"),
    versionExists: db.query("SELECT 1 AS x FROM reg_board_versions WHERE id = ?"),
    versionCount: db.query("SELECT count(*) AS n FROM reg_board_versions WHERE tenant_id = ? AND board_id = ?"),
    insVersion: db.query("INSERT INTO reg_board_versions (id, tenant_id, board_id, label, created_by, created_by_name, created_at, element_count, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
    listVersions: db.query("SELECT id, tenant_id, board_id, label, created_by, created_by_name, created_at, element_count FROM reg_board_versions WHERE tenant_id = ? AND board_id = ? ORDER BY created_at DESC, id DESC LIMIT ?"),
    getVersion: db.query("SELECT id, tenant_id, board_id, label, created_by, created_by_name, created_at, element_count, snapshot_json FROM reg_board_versions WHERE id = ? AND tenant_id = ? AND board_id = ?"),
    delVersion: db.query("DELETE FROM reg_board_versions WHERE id = ? AND tenant_id = ? AND board_id = ?"),
    purgeBoardRow: db.query("DELETE FROM reg_boards WHERE id = ?"),
    purgeSpaceRow: db.query("DELETE FROM reg_spaces WHERE id = ?"),
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
    linkPasscodeHash: db.query("SELECT passcode_hash FROM reg_links WHERE id = ?"),
    links: db.query("SELECT * FROM reg_links WHERE board = ? ORDER BY n"),
    linksForUserInTenant: db.query("SELECT l.board, l.role, l.expires_at, l.revoked FROM reg_link_uses u JOIN reg_links l ON l.id = u.link JOIN reg_boards b ON b.id = l.board WHERE b.tenant = ? AND u.member = ?"),
    insLink: db.query(`INSERT INTO reg_links (id, board, role, expires_at, revoked, by_user, created_at, passcode_hash, no_download)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`),
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

  const rowTenant = (r, absent = false) => r && {
    id: r.id, name: r.name ?? r.domain ?? "Personal Workspace", domain: r.domain, domains: [...(r.domain ? [r.domain] : []), ...q.extraDomains.all(r.id).map(d => d.domain)],
    kind: needKind(q.tenantKind.get(r.id)?.kind, r.id, absent),   // the look-up always runs (uniform statement count); `absent` = uniformTenant's placeholder row, never returned
    admins: q.admins.all(r.id).map(a => a.member), createdAt: r.created_at };
  const rowBoard = r => r && { id: r.id, tenant: r.tenant, title: r.title, memberRole: r.member_role, space: r.space, createdAt: r.created_at, trashedAt: r.trashed_at, trashedBy: r.trashed_by, trashedWith: r.trashed_with };
  const rowGroup = r => r && { id: r.id, tenant: r.tenant, name: r.name, generalRole: r.general_role, createdAt: r.created_at };
  const rowSpace = r => r && { id: r.id, tenant: r.tenant, group: r.grp, name: r.name, kind: r.kind, owner: r.owner_user, generalRole: r.general_role, createdAt: r.created_at, trashedAt: r.trashed_at, trashedBy: r.trashed_by, archivedAt: r.archived_at ?? null };
  const rowTeam = r => r && { id: r.id, tenant: r.tenant, name: r.name, createdAt: r.created_at };
  const rowRole = r => r && { id: r.id, tenant: r.tenant, name: r.name, base: r.base, boardRole: r.board_role, permissions: JSON.parse(r.permissions), createdAt: r.created_at };
  const rowSg = r => ({ subject: { type: r.subject_type, id: r.subject }, role: r.role });
  const rowInvite = r => r && { id: r.id, board: r.board, email: r.email, role: r.role, expiresAt: r.expires_at, revoked: !!r.revoked, by: r.by_user, createdAt: r.created_at };
  const rowLink = r => r && { id: r.id, board: r.board, role: r.role, expiresAt: r.expires_at, revoked: !!r.revoked, by: r.by_user, createdAt: r.created_at, hasPasscode: Boolean(r.passcode_hash), noDownload: Boolean(r.no_download) };
  const rowAudit = r => r && { id: r.id, tenant: r.tenant, board: r.board, actor: r.actor, action: r.action, target: r.target, detail: r.detail == null ? null : JSON.parse(r.detail), at: r.at };
  // undefined → null (bun:sqlite refuses undefined bindings); everything else as given.
  const nz = v => (v === undefined ? null : v);

  /** The tenant that owns `domain` (primary or extra), or undefined. */
  const domainOwner = d => q.tenantByDomain.get(d)?.id;
  const createTenantTx = db.transaction((name, ds, kind, admins, createdAt) => {
    if (ds.some(domainOwner)) throw new Error("registry: domain already has a tenant");
    const id = fresh(mint.tenant, i => !!q.tenantExists.get(i));
    q.insTenant.run(id, name, ds[0] ?? null, createdAt);
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

  const addMemberTx = db.transaction((tenant, email, addedAt) => {
    if (!q.tenantExists.get(tenant)) throw new Error("registry: no such tenant");
    return { added: q.insTenantMember.run(tenant, email, addedAt).changes > 0 };
  });

  // Idempotent creates: both run INSIDE the create's transaction (a throw rolls the whole create back), so the row and the object commit together.
  /** Rejects when a live row holds the key: the same fingerprint replays, another is a mismatch. */
  const idemEnter = (idem, t) => {
    if (!idem) return;
    if (++idemCalls % IDEM.every === 0) q.idemPrune.run(t - IDEM.ttlMs, IDEM.prune);
    const e = q.idemGet.get(idem.user, idem.key);
    if (e && t - e.at < IDEM.ttlMs) throw e.fp !== idem.fp ? idemErr.mismatch() : idemErr.replay(e.ref);
  };
  const idemPut = (idem, ref, t) => { if (idem) q.idemPut.run(idem.user, idem.key, idem.fp, ref, t); };

  const rowAsk = r => r && { id: r.id, tenant: r.tenant, scope: { type: r.scope_type, id: r.scope_id }, user: r.member, role: r.role, state: r.state, at: r.at, closedAt: r.closed_at ?? null };
  // One IMMEDIATE transaction: the key, the scope, the person's row, the cooldown and both limits are read and the row written under one write lock.
  const requestTx = db.transaction((tenant, sc, user, role, idem, t, lim, supersede) => {
    idemEnter(idem, t);
    needRow(scopeTenant(sc.type, sc.id) === tenant, "scope");
    q.askPrune.run(t - ASK.ttlMs, ASK.prune);
    const cur = askLive(rowAsk(q.askGet.get(sc.type, sc.id, user)), t);
    if (cur?.state === "pending" && !(supersede === true && cur.role !== role)) { idemPut(idem, cur.id, t); return cur; }
    if (cur && cur.state !== "pending") throw askLimited(askWait(cur, t));
    const mine = q.askUser.get(tenant, user, t - ASK.windowMs, sc.type, sc.id);
    if (mine.n >= lim.perUser) throw askLimited(mine.first + ASK.windowMs - t);
    if (q.askScopeN.get(sc.type, sc.id, t - ASK.ttlMs, user).n >= lim.scopePending) throw askLimited(null);
    const id = fresh(mint.request, i => !!db.query("SELECT 1 AS x FROM reg_access_requests WHERE id = ?").get(i));
    q.askUp.run(id, tenant, sc.type, sc.id, user, role, t);
    idemPut(idem, id, t);
    return rowAsk(q.askGet.get(sc.type, sc.id, user));
  });
  const closeAskTx = db.transaction((sc, user, state, t) => {
    const was = askLive(rowAsk(q.askGet.get(sc.type, sc.id, user)), t)?.state === "pending";
    if (state === "granted") q.askClose.run("granted", t, sc.type, sc.id, user); else if (was) q.askClose.run("dismissed", t, sc.type, sc.id, user);
    return was;
  });

  const createBoardTx = db.transaction((tenant, title, memberRole, space, owner, idem, createdAt) => {
    if (!q.tenantExists.get(tenant)) throw new Error("registry: no such tenant");
    { const sp = q.space.get(space); if (sp?.tenant !== tenant || sp.trashed_at != null) throw new Error("registry: no such space"); }
    idemEnter(idem, createdAt);
    const id = fresh(mint.board, i => !!q.boardExists.get(i));
    q.insBoard.run(id, tenant, title, memberRole === undefined ? null : memberRole, createdAt);
    q.insBoardSpace.run(id, space);
    if (owner != null) q.upGrant.run(id, owner, "owner", q.grantN.get(id).n);
    idemPut(idem, id, createdAt);
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
    q.purgeScoped.run("board", id);
    q.purgeRecents.run(id);
    q.purgeStars.run(id);
    q.purgeAsks.run("board", id);
    q.purgeVersions.run(id);
    q.purgeBoardSpace.run(id);
    return q.delBoard.run(id).changes > 0;
  });

  // The compare-and-set of the board's Space, with the key row, in one IMMEDIATE transaction (the write lock is held from the first read).
  const moveBoardTx = db.transaction((board, from, to, idem, at) => {
    const b = q.board.get(board);
    if (!b) throw new Error("registry: no such board");
    { const sp = q.space.get(to); if (sp?.tenant !== b.tenant || sp.trashed_at != null) throw new Error("registry: no such space"); }
    if (b.trashed_at != null) throw new RegistryError("in-trash", "the board is in Trash");
    idemEnter(idem, at);
    const moved = b.space !== to;
    if (moved) {
      if (b.space !== from) throw new RegistryError("moved", "the board is no longer in that Space");
      q.putBoardSpace.run(board, to);
    }
    idemPut(idem, board + (moved ? ":moved" : ":noop"), at);
    return { board: rowBoard(q.board.get(board)), moved };
  });

  // Trash: each is ONE IMMEDIATE transaction (the key row, the compare-and-set and the marks commit together).
  const trashBoardTx = db.transaction((board, from, by, idem, at) => {
    const b = q.board.get(board);
    if (!b) throw new Error("registry: no such board");
    idemEnter(idem, at);
    const trashed = b.trashed_at == null;
    if (trashed) {
      if (b.space !== from) throw new RegistryError("moved", "the board is no longer in that Space");
      q.trashBoard.run(board, at, by);
    }
    idemPut(idem, board + (trashed ? ":trashed" : ":noop"), at);
    return { board: rowBoard(q.board.get(board)), trashed };
  });
  const restoreBoardTx = db.transaction((board, idem, into, at) => {
    const b = q.board.get(board);
    if (!b) throw new Error("registry: no such board");
    idemEnter(idem, at);
    const restored = b.trashed_at != null;
    if (restored) {
      if (b.purging) throw new RegistryError("purged", "the board is being deleted for good");
      if (b.trashed_with != null) throw new RegistryError("with-space", "the board went to Trash with its Space: restore the Space");
      if (q.space.get(b.space)?.trashed_at != null) {
        // The Space is in Trash: a destination chosen by the caller (PROTOCOL.md § Trash and restore) takes the board; without one the restore is refused.
        if (into == null) throw new RegistryError("space-in-trash", "the board's Space is in Trash: restore the Space first");
        const sp = q.space.get(into);
        if (sp?.tenant !== b.tenant || sp.trashed_at != null) throw new Error("registry: no such space");
        q.putBoardSpace.run(board, into);
      }
      q.restoreBoard.run(board);
    }
    idemPut(idem, board + (restored ? ":restored" : ":noop"), at);
    return { board: rowBoard(q.board.get(board)), restored };
  });
  const trashSpaceTx = db.transaction((space, by, idem, at) => {
    const s = q.space.get(space);
    if (!s) throw new Error("registry: no such space");
    if (s.kind === "personal") throw new RegistryError("personal", "a personal space is never trashed");
    idemEnter(idem, at);
    const trashed = s.trashed_at == null;
    let boards = 0;
    if (trashed) { q.trashSpace.run(space, at, by); boards = q.trashSpaceBoards.run(space, at, by).changes; }
    idemPut(idem, space + (trashed ? ":trashed:" + boards : ":noop"), at);
    return { space: rowSpace(q.space.get(space)), trashed, boards };
  });
  const restoreSpaceTx = db.transaction((space, idem, at) => {
    const s = q.space.get(space);
    if (!s) throw new Error("registry: no such space");
    idemEnter(idem, at);
    const restored = s.trashed_at != null;
    let boards = 0;
    if (restored) {
      if (s.purging || q.spaceBoardsClaimed.get(space)) throw new RegistryError("purged", "the Space is being deleted for good");
      q.restoreSpace.run(space); boards = q.restoreSpaceBoards.run(space).changes;
    }
    idemPut(idem, space + (restored ? ":restored:" + boards : ":noop"), at);
    return { space: rowSpace(q.space.get(space)), restored, boards };
  });
  const claimTx = db.transaction((type, id, before) => {
    if (type === "board") return q.claimBoard.run(id, before).changes > 0;
    if (q.claimSpace.run(id, before).changes === 0) return false;
    q.claimSpaceBoards.run(id);
    return true;
  });
  const purgeBoardTx = db.transaction(board => {
    const b = q.board.get(board);
    if (!b) return true;
    if (!b.purging || b.trashed_at == null) return false;
    q.purgeGrants.run(board); q.purgeScoped.run("board", board); q.purgeInvites.run(board); q.purgeUses.run(board); q.purgeLinks.run(board);
    q.purgeRecents.run(board); q.purgeStars.run(board); q.purgeAsks.run("board", board); q.purgeVersions.run(board); q.purgeBoardSpace.run(board); q.purgeBoardRow.run(board);
    return true;
  });
  const purgeSpaceTx = db.transaction(space => {
    const s = q.space.get(space);
    if (!s) return true;
    if (!s.purging || q.spaceHasBoards.get(space)) return false;
    q.purgeScoped.run("space", space); q.purgeAsks.run("space", space); q.purgeSpaceRow.run(space);
    return true;
  });

  // The last-owner check and the write share one IMMEDIATE transaction (the write lock is held from the first read).
  const setGrantTx = db.transaction((board, user, role) => {
    if (!q.boardExists.get(board)) throw new Error("registry: no such board");
    const cur = q.grant.get(board, user)?.role ?? null;
    if (cur === "owner" && role !== "owner" && q.owners.get(board).c <= 1)
      throw new RegistryError("last-owner", "a board keeps at least one owner");
    if (role == null) q.delGrant.run(board, user);
    else q.upGrant.run(board, user, role, q.grantN.get(board).n);
  });

  const createInviteTx = db.transaction((board, email, role, expiresAt, by, idem, createdAt) => {
    if (!q.boardExists.get(board)) throw new Error("registry: no such board");
    idemEnter(idem, createdAt);
    const id = fresh(mint.invite, i => !!q.invite.get(i));
    q.insInvite.run(id, board, email, role, expiresAt, by, createdAt);
    idemPut(idem, id, createdAt);
    return rowInvite(q.invite.get(id));
  });

  const createLinkTx = db.transaction((board, role, expiresAt, by, idem, createdAt, passcodeHash, noDownload) => {
    if (!q.boardExists.get(board)) throw new Error("registry: no such board");
    idemEnter(idem, createdAt);
    const id = fresh(mint.link, i => !!q.link.get(i));
    q.insLink.run(id, board, role, expiresAt, by, createdAt, passcodeHash, noDownload);
    idemPut(idem, id, createdAt);
    return rowLink(q.link.get(id));
  });

  const addUseTx = db.transaction((link, user) => {
    const l = q.link.get(link);
    if (!l) throw new Error("registry: no such link");
    if (q.board.get(l.board)?.trashed_at != null) throw new RegistryError("in-trash", "the board is in Trash");   // atomic with the use: no read for the caller, no race with a trash
    q.insUse.run(l.board, user, link, q.useN.get(l.board, user).n);
  });

  const appendAuditTx = db.transaction((tenant, board, actor, action, target, detail, at) => {
    if (!q.tenantExists.get(tenant)) throw new Error("registry: no such tenant");
    return rowAudit(q.insAudit.get(tenant, board, actor, action, target, detail, at));
  });

  const rowVersionMeta = r => r && {
    id: r.id,
    tenantId: r.tenant_id,
    boardId: r.board_id,
    label: r.label,
    createdBy: r.created_by,
    createdByName: r.created_by_name ?? null,
    createdAt: r.created_at,
    elementCount: r.element_count,
  };
  const rowVersion = r => r && { ...rowVersionMeta(r), snapshotJson: r.snapshot_json };

  const createVersionTx = db.transaction((tenantId, boardId, label, createdBy, createdByName, elementCount, snapshotJson, maxPerBoard, createdAt) => {
    const b = q.board.get(boardId);
    if (!b || b.tenant !== tenantId) throw new Error("registry: no such board");
    if (b.trashed_at != null) throw new RegistryError("in-trash", "the board is in Trash");
    if (q.versionCount.get(tenantId, boardId).n >= maxPerBoard) throw new RegistryError("limit", "registry: board version limit reached");
    let id = mint.version();
    while (q.versionExists.get(id)) id = mint.version();
    q.insVersion.run(id, tenantId, boardId, label, createdBy, createdByName, createdAt, elementCount, snapshotJson);
    return { id, tenantId, boardId, label, createdBy, createdByName, createdAt, elementCount };
  });

  // ---- organization ----
  const needRow = (ok, what) => { if (!ok) throw new Error(`registry: no such ${what}`); };
  const putSg = (type, id, st, sid, role) => {
    if (role == null) q.delSgrant.run(type, id, st, sid);
    else q.upSgrant.run(type, id, st, sid, role, q.sgrantN.get(type, id).n);
  };
  const scopeTenant = (type, id) => (type === "unit" ? q.tenantExists.get(id) && id : type === "group" ? q.group.get(id)?.tenant
    : type === "space" ? q.space.get(id)?.tenant : q.board.get(id)?.tenant);
  const noRemoved = (tenant, user) => { if (user != null && q.dirGet.get(tenant, String(user))?.removed_at != null) throw new RegistryError("removed", "registry: the member was removed from the Unit"); };
  const createGroupTx = db.transaction((tenant, name, generalRole, owner, idem, createdAt) => {
    needRow(q.tenantExists.get(tenant), "tenant");
    noRemoved(tenant, owner);
    idemEnter(idem, createdAt);
    const id = fresh(mint.group, i => !!q.group.get(i));
    q.insGroup.run(id, tenant, name, generalRole, createdAt);
    if (owner != null) putSg("group", id, "user", owner, "owner");
    idemPut(idem, id, createdAt);
    return rowGroup(q.group.get(id));
  });
  const createSpaceTx = db.transaction((tenant, name, group, generalRole, owner, idem, createdAt) => {
    needRow(q.tenantExists.get(tenant), "tenant");
    if (group != null) needRow(q.group.get(group)?.tenant === tenant, "group");
    noRemoved(tenant, owner);
    idemEnter(idem, createdAt);
    const id = fresh(mint.space, i => !!q.space.get(i));
    q.insSpace.run(id, tenant, group, name, "shared", null, generalRole, createdAt);
    if (owner != null) putSg("space", id, "user", owner, "owner");
    idemPut(idem, id, createdAt);
    return rowSpace(q.space.get(id));
  });
  const personalTx = db.transaction((tenant, user, desiredName, createdAt) => {
    needRow(q.tenantExists.get(tenant), "tenant");
    const have = q.personal.get(tenant, user);
    if (have) {
      if (orgDefaults.isNumericPersonalName(have.name, user) && have.name !== desiredName) {
        noRemoved(tenant, user);
        q.patchSpace.run(have.id, 1, desiredName, 0, null);
        return rowSpace(q.space.get(have.id));
      }
      return rowSpace(have);
    }
    noRemoved(tenant, user);
    const id = fresh(mint.space, i => !!q.space.get(i));
    q.insSpace.run(id, tenant, null, desiredName, "personal", user, null, createdAt);
    putSg("space", id, "user", user, "owner");
    return rowSpace(q.space.get(id));
  });
  const createTeamTx = db.transaction((tenant, name, idem, createdAt) => {
    needRow(q.tenantExists.get(tenant), "tenant");
    idemEnter(idem, createdAt);
    const id = fresh(mint.team, i => !!q.team.get(i));
    q.insTeam.run(id, tenant, name, createdAt);
    idemPut(idem, id, createdAt);
    return rowTeam(q.team.get(id));
  });
  const setMemberTx = db.transaction((team, user, member) => {
    needRow(q.team.get(team), "team");
    if (member) noRemoved(q.team.get(team).tenant, user);
    if (!member && q.teamSize.get(team).c === 1 && q.teamHas.get(team, user)) {
      // Removing the last member of a Team that is the only counted owner of a Group or Space would leave it ownerless.
      for (const o of q.teamOwned.all(team)) if (q.sowners.all(o.scope_type, o.scope_id).length <= 1)
        throw new RegistryError("last-owner", `a ${o.scope_type} keeps at least one owner`);
    }
    (member ? q.insMember : q.delMember).run(team, user);
  });
  const deleteTeamTx = db.transaction(team => {
    needRow(q.team.get(team), "team");
    // An empty Team guards nothing (it is not counted), so only a Team with members can be the last counted owner.
    if (q.teamSize.get(team).c > 0) for (const o of q.teamOwned.all(team)) if (q.sowners.all(o.scope_type, o.scope_id).length <= 1)
      throw new RegistryError("last-owner", `a ${o.scope_type} keeps at least one owner`);
    q.delTeamGrants.run(team); q.delTeamMembers.run(team); q.delTeam.run(team);
  });
  const touchTx = db.transaction((tenant, user, name, email) => {
    const cur = q.dirGet.get(tenant, user);
    if (!cur || cur.name !== name || cur.email !== email) q.dirPut.run(tenant, user, name, email);
  });
  const setSgrantTx = db.transaction((type, id, st, sid, role) => {
    const tenant = scopeTenant(type, id);
    needRow(tenant, "scope");
    if (isCustomRoleId(role) && !q.role.get(tenant, role)) throw new RegistryError("no-role", "no such custom role in this Unit");
    if (st === "team") needRow(q.team.get(sid)?.tenant === tenant, "team");
    if (st === "user" && role != null) noRemoved(tenant, sid);
    if (type === "board" && st === "user") throw new Error("registry: a user's grant on a board is setGrant");
    const cur = q.sgrant.get(type, id, st, sid)?.role ?? null;
    if ((type === "group" || type === "space") && cur === "owner" && role !== "owner") {
      const counted = q.sowners.all(type, id);
      if (counted.some(o => o.subject_type === st && o.subject === sid) && counted.length <= 1)
        throw new RegistryError("last-owner", `a ${type} keeps at least one owner`);
    }
    putSg(type, id, st, sid, role);
  });
  // ---- Leaver offboarding: both are one IMMEDIATE transaction (the write lock from the first read), the key row inside it. ----
  const reassignTx = db.transaction((sc, from, to, name, idem, at) => {
    const row = sc.type === "space" ? q.space.get(sc.id) : q.group.get(sc.id);
    needRow(row, sc.type);
    if (sc.type === "space" && row.kind === "personal") throw new RegistryError("personal", "registry: a personal space is handed over only by removeMember");
    const dir = q.dirGet.get(row.tenant, to);
    if (from === to || !dir || dir.removed_at != null) throw new RegistryError("bad-recipient", "registry: the recipient is not a live member of the Unit");
    idemEnter(idem, at);
    const done = !!q.soleOne.get(sc.type, sc.id, from);
    if (done) {
      putSg(sc.type, sc.id, "user", to, "owner");
      putSg(sc.type, sc.id, "user", from, null);
    }
    idemPut(idem, sc.id + (done ? ":reassigned" : ":noop"), at);
    return { done };
  });
  const removeTx = db.transaction((tenant, user, by, handover, idem, at) => {
    needRow(q.tenantExists.get(tenant), "tenant");
    const cur = q.dirGet.get(tenant, user);
    needRow(cur, "member");
    idemEnter(idem, at);
    if (cur.removed_at != null) { idemPut(idem, user + ":noop", at); return { removed: false, grants: 0, scopedGrants: 0, teams: 0, invites: 0, handedOver: false }; }
    if (q.isAdmin.get(tenant, user, cur.email ?? null)) throw new RegistryError("is-admin", "registry: a Unit admin cannot be removed");
    // The personal space goes WITH the removal (never alone): `handover: { to, name }` makes it an archived Space owned by `to`, in this same transaction.
    const personal = q.personal.get(tenant, user);
    let to = null;
    if (personal && handover) {
      to = String(handover.to);
      const rd = q.dirGet.get(tenant, to);
      if (to === user || !rd || rd.removed_at != null) throw new RegistryError("bad-recipient", "registry: the recipient is not a live member of the Unit");
      putSg("space", personal.id, "user", to, "owner");
      q.archiveSpace.run(personal.id, at, handover.name ?? personal.name);
    }
    if (q.ownedAlone.all(tenant, user, null, 1).length) throw new RegistryError("still-owns", "registry: the member still solely owns something");   // a throw rolls the handover back too
    const invites = cur.email ? q.revokeInvitesTo.run(cur.email, tenant).changes : 0;   // invites addressed to the leaver go with their grants; ones they CREATED stay
    const out = { removed: true, grants: q.delUserGrants.run(user, tenant).changes, scopedGrants: q.delUserScoped.run(user, tenant).changes, teams: q.delUserTeams.run(user, tenant).changes, invites, handedOver: !!to };
    q.delUserAsks.run(tenant, user);
    q.markRemoved.run(tenant, user, at, by);
    idemPut(idem, user + ":removed", at);
    return out;
  });
  const createRoleTx = db.transaction((tenant, name, base, boardRole, perms, createdAt, max, idem) => {
    needRow(q.tenantExists.get(tenant), "tenant");
    idemEnter(idem, createdAt);
    if (max !== undefined && q.roleCount.get(tenant).n >= max) throw new RegistryError("limit", "the Unit has the most custom roles it can");
    const id = fresh(mint.role, i => !!q.role.get(tenant, i));
    q.insRole.run(tenant, id, name, base, boardRole, JSON.stringify(perms), createdAt);
    idemPut(idem, id, createdAt);
    return rowRole(q.role.get(tenant, id));
  });
  const deleteRoleTx = db.transaction((tenant, id) => {
    needRow(q.role.get(tenant, id), "role");
    if (q.roleHeld.get(id, 1, tenant)) throw new RegistryError("in-use", "a grant still holds this role");
    q.delRole.run(tenant, id);
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
  /** `rowTenant`, but its three look-ups run even when the row is missing (no-match id), so the statement count doesn't depend on existence. */
  const uniformTenant = r => { const t = rowTenant(r ?? { id: "", name: null, domain: null, created_at: 0 }, !r); return r ? t : null; };
  // The SAME statements run whether or not the scope exists (no-match parameters stand in for a missing row), so a refusal's cost can't
  // tell an unknown id from a hidden one (PROTOCOL.md § Spaces and Groups, "the same Registry work").
  const contextTx = db.transaction((type, id, users, held) => {
    const board = held ? held.board : type === "board" ? rowBoard(q.board.get(id)) : null;
    const space = held ? held.space : rowSpace(q.space.get(type === "space" ? id : board?.space ?? ""));
    const group = held ? held.group : type === "group" ? rowGroup(q.group.get(id)) : rowGroup(q.group.get(space?.group ?? ""));
    const owner = board ?? space ?? group;
    const tenant = held ? held.tenant : uniformTenant(q.tenant.get(type === "unit" ? id : owner?.tenant ?? ""));
    const sg = (t, i) => q.sgrants.all(t, i ?? "").map(rowSg);
    const scoped = { unit: sg("unit", tenant?.id), group: sg("group", group?.id), space: sg("space", space?.id), board: sg("board", board?.id) };
    const teamIds = [...new Set(Object.values(scoped).flat().filter(g => g.subject.type === "team").map(g => g.subject.id))];
    const teams = Object.fromEntries(teamIds.map(t => [t, []]));
    for (const m of q.membersOf.all(JSON.stringify(teamIds), users ? JSON.stringify(users) : null)) teams[m.team].push(m.member);
    const roles = q.roles.all(tenant?.id ?? "").map(rowRole);
    const removed = q.removedAmong.all(tenant?.id ?? "", users ? JSON.stringify(users) : "[]").map(r => r.member);   // the same statement whatever exists
    if (!tenant || (type !== "unit" && !owner)) return null;
    return { tenant, board, space, group, scoped, roles, teams, removed };
  });

  /** `accessContexts`: every scope's context from ONE transaction (one snapshot). */
  const contextsTx = db.transaction((list, users) => list.map(sc => [sc.type + "\n" + sc.id, contextTx(sc.type, sc.id, users, null)]));

  /** @type {import("../../../ports/registry.js").Registry & { close(): Promise<void>, pragmas(): object, idemSize(): number }} */
  const api = {
    async createTenant({ name = null, domain, domains = [], kind = "company", admins = [] }) {
      ready();
      if (!KINDS.includes(kind)) throw new Error("registry: bad unit kind");
      const ds = domainList(domain, domains);
      const trimmedName = typeof name === "string" ? name.trim() : "";
      const n = trimmedName || ds[0] || "Personal Workspace";
      return createTenantTx.immediate(n, ds, kind, [...admins].map(String), now());
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
    async listPersonalTenants() {
      ready();
      return q.personalTenants.all().map(r => rowTenant(r));
    },
    async tenantAdminsAmong(users) { ready(); return q.adminsAmong.all(JSON.stringify(users.filter(str))).map(r => r.member); },
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
      return str(tenant) && e ? q.delTenantMember.run(tenant, e).changes > 0 : false;
    },
    async isTenantMember(tenant, email) {
      ready();
      const e = normEmail(email);
      return Boolean(str(tenant) && e && q.isTenantMember.get(tenant, e));
    },
    async tenantMembers(tenant) {
      ready();
      return str(tenant) ? q.listTenantMembers.all(tenant).map(r => r.email) : [];
    },
    async tenantsForMember(email) {
      ready();
      const e = normEmail(email);
      return e ? q.tenantsForMember.all(e).map(r => rowTenant(r)) : [];
    },
    async tenantsForAdmin(user, email = null) {
      ready();
      if (!str(user) || !user) return [];
      const e = normEmail(email);
      const rows = e ? q.tenantsForAdmin2.all(user, "email:" + e) : q.tenantsForAdmin1.all(user);
      return rows.map(r => rowTenant(r));
    },

    async createBoard({ tenant, title = "", memberRole, space, owner, idem }) {
      ready();
      if (!str(tenant)) throw new Error("registry: no such tenant");
      if (!str(space)) throw new Error("registry: no such space");
      return createBoardTx.immediate(tenant, String(title), memberRole === undefined ? undefined : nz(memberRole), space, owner == null ? null : String(owner), idemOf(idem), now());
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
    async moveBoard({ board, from, to, idem }) {
      ready();
      if (!str(board)) throw new Error("registry: no such board");
      if (!str(from) || !str(to)) throw new Error("registry: no such space");
      return moveBoardTx.immediate(board, from, to, idemOf(idem), now());
    },

    async trashBoard({ board, from, by, idem }) {
      ready();
      if (!str(board)) throw new Error("registry: no such board");
      if (!str(from) || !from) throw new Error("registry: no such space");
      if (!str(by) || !by) throw new Error("registry: bad user");
      return trashBoardTx.immediate(board, from, by, idemOf(idem), now());
    },
    async restoreBoard({ board, idem, into = null }) {
      ready();
      if (!str(board) || (into != null && !str(into))) throw new Error("registry: no such board");
      return restoreBoardTx.immediate(board, idemOf(idem), into, now());
    },
    async trashSpace({ space, by, idem }) {
      ready();
      if (!str(space)) throw new Error("registry: no such space");
      if (!str(by) || !by) throw new Error("registry: bad user");
      return trashSpaceTx.immediate(space, by, idemOf(idem), now());
    },
    async restoreSpace({ space, idem }) {
      ready();
      if (!str(space)) throw new Error("registry: no such space");
      return restoreSpaceTx.immediate(space, idemOf(idem), now());
    },
    async trashedBoards(tenant, { after = null, limit } = {}) {
      ready();
      const cur = orgDefaults.cursor(after, "id"), n = smallLimit(limit, TRASH.page.default, TRASH.page.max);
      const rows = str(tenant) ? q.trashedBoards.all(tenant, cur, n + 1).map(rowBoard) : [];
      return { boards: rows.slice(0, n), next: rows.length > n ? rows[n - 1].id : null };
    },
    async trashedSpaces(tenant, { after = null, limit } = {}) {
      ready();
      const cur = orgDefaults.cursor(after, "id"), n = smallLimit(limit, TRASH.page.default, TRASH.page.max);
      const rows = str(tenant) ? q.trashedSpaces.all(tenant, cur, n + 1, TRASH.sizeCap + 1).map(r => ({ ...rowSpace(r), boards: r.boards })) : [];
      return { spaces: rows.slice(0, n), next: rows.length > n ? rows[n - 1].id : null };
    },
    async trashDue({ before, limit, claimed, after } = /** @type {any} */ ({})) {
      ready();
      if (!Number.isFinite(before)) throw new Error("registry: bad time");
      const n = smallLimit(limit, TRASH.due.default, TRASH.due.max);
      if (claimed === false) return { boards: q.unclaimedBoards.all(before, n).map(rowBoard), spaces: q.unclaimedSpaces.all(before, n).map(rowSpace) };
      if (claimed === true) return { boards: q.claimedBoards.all(n, after?.board ?? null).map(rowBoard), spaces: q.claimedSpaces.all(n, after?.space ?? null).map(rowSpace) };
      return { boards: q.dueBoards.all(before, n).map(rowBoard), spaces: q.dueSpaces.all(before, n).map(rowSpace) };
    },
    async purgeClaim({ type, id, before }) {
      ready();
      if ((type !== "board" && type !== "space") || !Number.isFinite(before) || !str(id)) throw new Error("registry: bad purge");
      return claimTx.immediate(type, id, before);
    },
    async purgeBoard(board) { ready(); return str(board) ? purgeBoardTx.immediate(board) : true; },
    async purgeSpace(space) { ready(); return str(space) ? purgeSpaceTx.immediate(space) : true; },

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

    async createInvite({ board, email, role, expiresAt = null, by, idem }) {
      ready();
      if (!str(board)) throw new Error("registry: no such board");
      return createInviteTx.immediate(board, normEmail(email), role, nz(expiresAt), nz(by), idemOf(idem), now());
    },
    async invite(id) { ready(); return str(id) ? rowInvite(q.invite.get(id)) ?? null : null; },
    async invites(board) { ready(); return str(board) ? q.invites.all(board).map(rowInvite) : []; },
    async invitesFor(board, email) {
      ready();
      const e = normEmail(email);
      return str(board) && e != null ? q.invitesFor.all(board, e).map(rowInvite) : [];
    },
    async revokeInvite(id) { ready(); return str(id) ? q.revokeInvite.run(id).changes > 0 : false; },

    async createLink({ board, role, expiresAt = null, passcodeHash = null, noDownload = false, by, idem }) {
      ready();
      if (!str(board)) throw new Error("registry: no such board");
      const hash = typeof passcodeHash === "string" && passcodeHash.length > 0 ? passcodeHash : null;
      return createLinkTx.immediate(board, role, nz(expiresAt), nz(by), idemOf(idem), now(), hash, noDownload ? 1 : 0);
    },
    async link(id) { ready(); return str(id) ? rowLink(q.link.get(id)) ?? null : null; },
    async linkPasscodeHash(id) { ready(); return str(id) ? (q.linkPasscodeHash.get(id)?.passcode_hash ?? null) : null; },
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
    async listAudit({ tenant, board = null, limit = 50, before = null } = /** @type {any} */ ({})) {
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

    async createBoardVersion({ tenantId, boardId, label, createdBy, createdByName = null, elementCount = 0, snapshotJson, maxPerBoard = BOARD_VERSIONS.maxPerBoard, at }) {
      ready();
      if (!str(tenantId) || !str(boardId)) throw new Error("registry: no such board");
      const cap = Number.isInteger(maxPerBoard) && maxPerBoard > 0 ? maxPerBoard : BOARD_VERSIONS.maxPerBoard;
      const ts = Number.isFinite(at) ? Math.floor(at) : now();
      const ec = Number.isSafeInteger(elementCount) && elementCount >= 0 ? elementCount : 0;
      return createVersionTx.immediate(tenantId, boardId, String(label), String(createdBy), createdByName == null ? null : String(createdByName), ec, String(snapshotJson), cap, ts);
    },
    async listBoardVersions({ tenantId, boardId, limit = BOARD_VERSIONS.maxPerBoard } = /** @type {any} */ ({})) {
      ready();
      if (!str(tenantId) || !str(boardId)) return [];
      const cap = Math.min(BOARD_VERSIONS.maxPerBoard, Math.max(1, Math.floor(Number(limit) || BOARD_VERSIONS.maxPerBoard)));
      return q.listVersions.all(tenantId, boardId, cap).map(rowVersionMeta);
    },
    async getBoardVersion({ tenantId, boardId, versionId } = /** @type {any} */ ({})) {
      ready();
      if (!str(tenantId) || !str(boardId) || !str(versionId)) return null;
      return rowVersion(q.getVersion.get(versionId, tenantId, boardId)) ?? null;
    },
    async deleteBoardVersion({ tenantId, boardId, versionId } = /** @type {any} */ ({})) {
      ready();
      if (!str(tenantId) || !str(boardId) || !str(versionId)) return false;
      return db.transaction(() => q.delVersion.run(versionId, tenantId, boardId).changes > 0).immediate();
    },

    // ---- organization (PROTOCOL.md § Registry, "Organization") ----
    async createGroup({ tenant, name, generalRole = null, owner, idem }) {
      ready();
      if (!str(tenant)) throw new Error("registry: no such tenant");
      return createGroupTx.immediate(tenant, orgDefaults.name(name), nz(generalRole), owner == null ? null : String(owner), idemOf(idem), now());
    },
    async group(id) { ready(); return str(id) ? rowGroup(q.group.get(id)) ?? null : null; },
    async groups(tenant) { ready(); return str(tenant) ? q.groups.all(tenant).map(rowGroup) : []; },
    async createSpace({ tenant, name, group = null, generalRole = "viewer", owner, idem }) {
      ready();
      if (!str(tenant)) throw new Error("registry: no such tenant");
      if (group != null && !str(group)) throw new Error("registry: no such group");
      return createSpaceTx.immediate(tenant, orgDefaults.name(name), nz(group), nz(generalRole), owner == null ? null : String(owner), idemOf(idem), now());
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
    async personalSpace(tenant, user) { ready(); return str(tenant) ? rowSpace(q.personal.get(tenant, String(user))) ?? null : null; },
    async ensurePersonalSpace(tenant, user, opts) {
      ready();
      if (!str(tenant)) throw new Error("registry: no such tenant");
      const u = String(user), desired = orgDefaults.personalName(u, opts);
      // Read first: Home calls this on every load, and the write lock (BEGIN IMMEDIATE) is taken only when the row is missing or needs a numeric-name repair.
      const had = rowSpace(q.personal.get(tenant, u));
      if (had && (!orgDefaults.isNumericPersonalName(had.name, u) || had.name === desired)) return had;
      return personalTx.immediate(tenant, u, desired, now());
    },
    async createTeam({ tenant, name, idem }) {
      ready();
      if (!str(tenant)) throw new Error("registry: no such tenant");
      return createTeamTx.immediate(tenant, orgDefaults.name(name), idemOf(idem), now());
    },
    async team(id) { ready(); return str(id) ? rowTeam(q.team.get(id)) ?? null : null; },
    async teams(tenant) { ready(); return str(tenant) ? q.teams.all(tenant).map(rowTeam) : []; },
    async setTeamMember(team, user, member) {
      ready();
      if (!str(team)) throw new Error("registry: no such team");
      setMemberTx.immediate(team, String(user), !!member);
    },
    async teamMembers(team) { ready(); return str(team) ? q.members.all(team).map(r => r.member) : []; },
    async renameTeam(team, name) {
      ready();
      const n = orgDefaults.name(name);
      if (!str(team) || !q.team.get(team)) throw new Error("registry: no such team");
      q.renTeam.run(n, team);
      return rowTeam(q.team.get(team));
    },
    async deleteTeam(team) {
      ready();
      if (!str(team)) throw new Error("registry: no such team");
      deleteTeamTx.immediate(team);
    },
    async teamsPage(tenant, { after = null, limit, q: term = null } = {}) {
      ready();
      const cur = orgDefaults.cursor(after, "id"), n = smallLimit(limit, TEAMS.page.default, TEAMS.page.max), like = likeOf(term);
      if (!str(tenant)) return { teams: [], next: null };
      const rows = q.teamsPage.all(tenant, cur, like, n + 1), page = rows.slice(0, n);
      return { teams: page.map(r => ({ ...rowTeam(r), size: r.size })), next: rows.length > n ? page[n - 1].id : null };
    },
    async teamsAmong(tenant, ids) {
      ready();
      const is = [...new Set((ids ?? []).filter(str))].slice(0, TEAMS.among);
      return str(tenant) && is.length ? q.teamsAmong.all(tenant, JSON.stringify(is)).map(r => ({ ...rowTeam(r), size: r.size })) : [];
    },
    async teamMembersPage(team, { after = null, limit } = {}) {
      ready();
      const cur = orgDefaults.cursor(after, "id"), n = smallLimit(limit, TEAMS.page.default, TEAMS.page.max);
      if (!str(team)) return { users: [], next: null };
      const rows = q.membersPage.all(team, cur, n + 1).map(r => r.member), page = rows.slice(0, n);
      return { users: page, next: rows.length > n ? page[n - 1] : null };
    },
    async scopedGrant(scope, subject) {
      ready();
      const { type, id } = orgDefaults.scope(scope), sub = orgDefaults.subject(subject);
      return q.sgrant.get(type, id, sub.type, sub.id)?.role ?? null;
    },
    async scopedGrantsPage(scope, { after = null, limit } = {}) {
      ready();
      const { type, id } = orgDefaults.scope(scope), cur = orgDefaults.cursor(after, "subject"), n = smallLimit(limit, TEAMS.page.default, TEAMS.page.max);
      const rows = q.sgrantsPage.all(type, id, cur, n + 1), page = rows.slice(0, n);
      return { grants: page.map(rowSg), next: rows.length > n ? page[n - 1].subject_type + "\n" + page[n - 1].subject : null };
    },
    async touchMember(tenant, { user, name = null, email = null }) {
      ready();
      if (!str(tenant) || !q.tenantExists.get(tenant)) throw new Error("registry: no such tenant");
      if (!str(user) || !user) throw new Error("registry: bad user");
      const nm = profileText(name, 200), em = profileText(email, 320), cur = q.dirGet.get(tenant, user);
      // Read first: Home calls this on every load, and the write lock (BEGIN IMMEDIATE) is taken only when the row is new or changed.
      if (!cur || cur.name !== nm || cur.email !== em) touchTx.immediate(tenant, user, nm, em);
    },
    async membersAmong(tenant, users) {
      ready();
      const us = [...new Set((users ?? []).filter(str))].slice(0, TEAMS.among);
      return str(tenant) && us.length ? q.dirAmong.all(tenant, JSON.stringify(us)).map(r => ({ ...r, removed: !!r.removed })) : [];
    },
    async findMembers(tenant, { q: term = null, limit } = {}) {
      ready();
      const like = likeOf(term), n = smallLimit(limit, TEAMS.find.default, TEAMS.find.max);
      return str(tenant) ? q.dirFind.all(tenant, like, n) : [];
    },
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
    async createRole({ tenant, name, base = null, boardRole, permissions = [], max, idem }) {
      ready();
      if (!str(tenant)) throw new Error("registry: no such tenant");
      return createRoleTx.immediate(tenant, orgDefaults.name(name), nz(base), nz(boardRole), [...permissions], now(), max, idemOf(idem));
    },
    async updateRole(tenant, id, patch) {
      ready();
      if (!str(tenant) || !str(id)) throw new Error("registry: no such role");
      return updateRoleTx.immediate(tenant, id, patch ?? {}, now());
    },
    async deleteRole(tenant, id) {
      ready();
      if (id === MEMBER_ROLE_ID) throw new Error("registry: bad role");
      if (!str(tenant) || !str(id)) throw new Error("registry: no such role");
      deleteRoleTx.immediate(tenant, id);
    },
    async roleUsage(tenant, ids, { cap } = {}) {
      ready();
      if (!str(tenant) || (ids ?? []).includes(MEMBER_ROLE_ID)) throw new Error("registry: bad role");
      const c = capOf(cap, ROLE_LIMITS.usageCap), out = new Map();
      for (const id of [...new Set((ids ?? []).filter(str))].slice(0, ROLE_LIMITS.custom + 1))
      { const u = q.roleUse.get(id, c + 1, tenant, ROLE_LIMITS.teamIds); out.set(id, { places: u.places, users: u.users, teams: u.teams ? u.teams.split(",").sort() : [] }); }
      return out;
    },
    async memberCount(tenant, { cap } = {}) { ready(); return str(tenant) ? q.memberN.get(tenant, capOf(cap, ROLE_LIMITS.memberCap) + 1).n : 0; },
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
    // ---- Access requests (PROTOCOL.md § Access explanation and requests) ----
    async requestAccess({ tenant, scope, user, role, idem, limits, supersede }) {
      ready();
      const sc = askScope(scope), r = askRole(role);
      if (!str(tenant) || !str(user) || !user || user.includes("\0")) throw new Error("registry: no such scope");
      return requestTx.immediate(tenant, sc, user, r, idemOf(idem), now(), askLimits(limits), supersede);
    },
    async accessRequest(scope, user) {
      ready();
      const sc = orgDefaults.scope(scope);
      return str(user) ? askLive(rowAsk(q.askGet.get(sc.type, sc.id, user)), now()) : null;
    },
    async accessRequests(scope, { limit } = {}) {
      ready();
      const sc = askScope(scope);
      return q.askList.all(sc.type, sc.id, now() - ASK.ttlMs, smallLimit(limit, ASK.page.default, ASK.page.max)).map(rowAsk);
    },
    async closeAccessRequest(scope, user, state) {
      ready();
      const sc = askScope(scope);
      if (state !== "dismissed" && state !== "granted") throw new Error("registry: bad state");
      return str(user) ? closeAskTx.immediate(sc, user, state, now()) : false;
    },
    async grantHolders(scope, roles, { limit } = {}) {
      ready();
      const sc = orgDefaults.scope(scope), want = [...new Set((roles ?? []).filter(str))].slice(0, 100);
      return want.length ? q.holders.all(sc.type, sc.id, JSON.stringify(want), smallLimit(limit, ASK.holders, ASK.holders)).map(rowSg) : [];
    },

    // ---- Idempotent creates (PROTOCOL.md) ----
    async idemGet(o) {
      ready();
      const i = idemOf(o);
      if (!i) throw new Error("registry: bad idempotency key");
      const e = q.idemGet.get(i.user, i.key);
      return !e || now() - e.at >= IDEM.ttlMs ? { state: "none" } : e.fp !== i.fp ? { state: "mismatch" } : { state: "done", ref: e.ref };
    },
    /** The stored rows (tests). */ idemSize: () => q.idemCount.get().n,

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
    async searchBoards(tenant, { q: term, after = null, scan } = {}) {
      ready();
      const cur = orgDefaults.cursor(after, "id"), cap = smallLimit(scan, HOME.searchScan.default, HOME.searchScan.max);
      const like = term == null ? null : "%" + asciiFold(searchQuery(term)).replace(/[\\%_]/g, "\\$&") + "%";
      if (!str(tenant)) return { ids: [], next: null };
      const ids = q.search.all(tenant, cur, like, cap).map(r => r.id);
      const edge = q.searchEdge.all(tenant, cur, cap - 1);          // [last board examined, one more] when the Unit goes on past the window
      return { ids, next: edge.length === 2 ? edge[0].id : null };
    },
    async spaceCandidates(tenant, { user, all = false, personal = false, after = null, limit } = /** @type {any} */ ({})) {
      ready();
      const cur = orgDefaults.cursor(after, "id"), n = smallLimit(limit, HOME.candidates.spaces.default, HOME.candidates.spaces.max);
      if (!str(tenant) || !str(user)) return { spaces: [], groups: [], next: null };
      const rows = q.spaceCand.all(tenant, cur, user, all ? 1 : 0, n + 1, personal ? 1 : 0), page = rows.slice(0, n);
      const gids = [...new Set(page.map(r => r.grp).filter(Boolean))];
      return { spaces: page.map(rowSpace), groups: gids.length ? q.groupsByIds.all(JSON.stringify(gids)).map(rowGroup) : [], next: rows.length > n ? page[n - 1].id : null };
    },
    async groupCandidates(tenant, { user, all = false, limit } = /** @type {any} */ ({})) {
      ready();
      return str(tenant) && str(user) ? q.groupCand.all(tenant, user, all ? 1 : 0, smallLimit(limit, HOME.candidates.groups.default, HOME.candidates.groups.max)).map(rowGroup) : [];
    },
    async boardRows(ids, { user, email = null } = /** @type {any} */ ({})) {
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
    async boardsIn(scope, { after = null, limit, withTrashed = false } = {}) {
      ready();
      const { type, id } = orgDefaults.scope(scope), n = pageLimit(limit), cur = orgDefaults.cursor(after, "id");
      const q1 = type === "unit" ? q.boardsInUnit : type === "group" ? q.boardsInGroup : type === "space" ? q.boardsInSpace : null;
      const ids = q1 ? q1.all(id, cur, n + 1, withTrashed ? 1 : 0).map(r => r.id) : [];
      return { ids: ids.slice(0, n), next: ids.length > n ? ids[n - 1] : null };
    },
    async memberState(tenant, user) {
      ready();
      const r = str(tenant) && str(user) ? q.dirGet.get(tenant, user) : null;
      return r ? { user: r.user, name: r.name, email: r.email, removed: r.removed_at != null, removedAt: r.removed_at ?? null, removedBy: r.removed_by ?? null } : null;
    },
    async ownedAlone(tenant, user, { after = null, limit } = {}) {
      ready();
      const cur = orgDefaults.cursor(after, "scope"), n = smallLimit(limit, TEAMS.page.default, TEAMS.page.max);
      if (!str(tenant) || !str(user)) return { items: [], next: null };
      const rows = q.ownedAlone.all(tenant, user, cur, n + 1).map(r => ({ type: r.type, id: r.id, personal: !!r.personal })), page = rows.slice(0, n);
      return { items: page, next: rows.length > n ? page[n - 1].type + "\n" + page[n - 1].id : null };
    },
    async reassignOwner({ scope, from, to, name, idem }) {
      ready();
      const sc = orgDefaults.renamable(scope, ["space", "group"]);
      if (!str(from) || !str(to)) throw new Error("registry: no such member");
      return reassignTx.immediate(sc, from, to, name == null ? null : orgDefaults.name(name), idemOf(idem), now());
    },
    async removeMember({ tenant, user, by, handover, idem }) {
      ready();
      if (!str(tenant)) throw new Error("registry: no such tenant");
      if (!str(user) || !str(by)) throw new Error("registry: no such member");
      return removeTx.immediate(tenant, user, by, handover?.to == null ? null : { to: handover.to, name: handover.name == null ? null : orgDefaults.name(handover.name) }, idemOf(idem), now());
    },
    async personalScopesOf(subject, { limit = 50 } = {}) {
      ready();
      const sub = orgDefaults.subject(subject), n = Math.min(Math.max(Number.isSafeInteger(limit) ? limit : 50, 1), 50);
      const rows = q.personalScopesOf.all(sub.type, sub.id, n + 1).map(r => ({ type: r.scope_type, id: r.scope_id, role: r.role }));
      return { scopes: rows.slice(0, n), more: rows.length > n };
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
  return api;
}

/** The name the p3-registry brief used. */
export const createSqliteRegistry = sqliteRegistry;
