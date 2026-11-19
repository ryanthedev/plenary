// The Registry port (PROTOCOL.md § Registry): tenants, the board registry (`Registry.board(id)`; the Store has no
// board lookup), per-board grants, invites and share links. No adapter code here: adapters are server/auth/registry.js
// (memory) and server/registry/{sqlite,postgres}.js (engine). Every adapter passes test/auth/registry-contract.js.
// Method names are STABLE. Adapter-only extras (never called by core): sqlite `pragmas()`, postgres `settings()`, `readSettings()`,
// `idemPrune()`, `gate()` (main.js reads it for the log), `idemSize()` (tests; every adapter has it); test/server/adapter-surface.test.js pins the surface of every adapter.
//
// Last owner: `setGrant` refuses to remove or demote a board's last `owner` grant, throwing an error whose
// `code` is "last-owner" (match on the code, not the class: other adapters throw their own). The check and the
// write are one atomic step (in one JS process: no await between them; in SQL: one transaction or a conditional
// write), and a refused call changes nothing. Caller rules (who may grant what) live in server/admin/boards.js.
//
// Idempotent creates (PROTOCOL.md "Idempotent creates"): `createBoard`, `createGroup`, `createSpace`, `createTeam`, `createInvite` and `createLink` take an
// optional `idem: { user, key, fp }` and write the key's row in the SAME atomic step as the object (one transaction), so a key and its object exist
// together or not at all. A live row (younger than IDEM.ttlMs) makes the create reject, changing nothing: `idemErr.replay(ref)` (code "idem-replay", `ref` =
// the stored object id) for the same `fp`, `idemErr.mismatch()` (code "idem-mismatch") for another. `idemGet(idem)` is the read-only form.
//
// Failure semantics (what a second adapter must honour): a lookup of something absent resolves to null / [] /
// false; a write against a missing tenant / board / link rejects; an infrastructure failure (database down,
// timeout) REJECTS, never resolves to null, because callers turn null into a refusal ("no role") and a rejection
// into `unavailable` (server/auth/port.js, http.js). Reads return copies the caller may mutate freely.
// Consistency: reads see every write acknowledged before them (read-your-writes and no stale replica reads), so a
// revoked grant, invite or link stops working on the very next role().
//
// Batch (p5-load, OPTIONAL): `linkUsesFor(board, users)` answers `linkUses(board, u)` for every u in `users` in one
// round trip: a Map with an entry for each requested user that has at least one use on that board (absent = []),
// each list in the order `linkUses` gives. Callers pass at most 1000 users per call (tenancy.js USE_CHUNK), so a
// SQL adapter can bind them as one array parameter. An adapter without it is still a Registry: tenancy.js falls
// back to one `linkUses` per user. test/auth/registry-contract.js checks it when the adapter passes { batch: true }.
//
// Board organization (PROTOCOL.md § Tenancy, "Organization"): a tenant is a Unit (a `kind` and one or more domains);
// it holds Groups, Spaces (in a Group or at the root; a member's personal Space is a Space with an `owner`), Teams
// (named sets of members), custom roles, and scoped grants (a role for a user or Team on a Unit, Group, Space or board;
// a user's own grant on a board stays in `grants`). A board lives in at most one Space (`board.space`; null = filed
// nowhere: the dev board, or one a script made without a Space). `accessContext` is the one read the resolver needs for
// a scope's whole chain (board, Space, Group, Unit) so a hello costs one call, not one per table.
//
// Last owner, again: `setScopedGrant` on a Group or Space refuses to remove or demote its last `owner` grant (a user's
// or a Team's), code "last-owner", atomically like `setGrant`. Unit admins (tenant admins) are the backstop and
// are not counted. Role strings are stored as given (the admin layer validates them with server/auth/permissions.js;
// the resolver ignores a role that is not valid where it is held).
//
// accessContexts(scopes, { users }) is the same read for up to HOME.batch Unit, Group or Space scopes at once (the Home lists and the pickers have
// many Spaces to check): one statement on Postgres, one transaction on SQLite, so a page of N boards over M Spaces costs a fixed number of
// statements, not M reads. Its answer for each scope equals `accessContext`'s (test/auth/registry-contract.js).
//
// accessContext(scope, { users, chain }): `users` (user ids, at most a few thousand) limits `teams` to those users'
// memberships, so a hello reads one user's and a re-check pass reads its own users', never a whole Team. `chain` is a
// Chain the caller already holds for this scope (a cache's); the adapter then skips reading it (and returns it as given),
// reading only the volatile parts (grants, roles, Team memberships). One call, a fixed number of statements, one
// consistent snapshot (Postgres: one statement).
//
// boardsIn / scopesOf exist so that a change to a Space's, Group's or Unit's grants (or to a Team's membership) can be
// announced for every board it reaches, which the port otherwise couldn't list (PROTOCOL.md § Organization, "Freshness").
// Both page by an opaque cursor (`after` = the previous page's `next`, `next` = null at the end), `limit` defaults to 500
// and is capped at 1000, and each page is one bounded statement. A MALFORMED cursor (not a string a page returned, so
// not an id for boardsIn nor "<type>\n<id>" for scopesOf) is refused: the call rejects with "registry: bad cursor".
// An unknown but well-formed one is just a position; it never restarts the listing.
//
// Last owner for Groups and Spaces counts a Team owner only while the Team has at least one member (an empty Team
// guards nothing), and `setTeamMember` refuses to remove the last member of a Team that is the only counted owner of
// a Group or Space (code "last-owner").
//
// Every method is async. Ids are server-minted over [a-z0-9-] (no ".", "*", ">"), never a domain name, so they
// are safe in bus subjects (PROTOCOL.md § Bus). Mint them with `mint` below, so every adapter shares the format.

import { randomId } from "./util.js";

/** The method names of the Registry port (the typedef below, in order; `batch` ones included). test/server/adapter-surface.test.js checks every adapter against it. */
export const REGISTRY_METHODS = Object.freeze([
  "createTenant", "addTenantDomain", "tenant", "tenantByDomain", "addTenantAdmin", "tenantAdminsAmong",
  "createBoard", "createGroup", "group", "groups", "createSpace", "space",
  "spaces", "ensurePersonalSpace", "createTeam", "renameTeam", "deleteTeam", "teamsPage",
  "teamsAmong", "teamMembersPage", "scopedGrant", "scopedGrantsPage", "touchMember", "membersAmong",
  "findMembers", "team", "teams", "setTeamMember", "teamMembers", "setScopedGrant",
  "rename", "updateScope", "spacesIn", "scopedGrants", "createRole", "deleteRole",
  "roleUsage", "memberCount", "updateRole", "role", "roles", "accessContexts",
  "accessContext", "boardsIn", "scopesOf", "board", "setGrant", "grant",
  "grants", "createInvite", "invite", "invites", "invitesFor", "revokeInvite",
  "createLink", "link", "links", "revokeLink", "addLinkUse", "linkUses",
  "idemGet", "markOpened", "recents", "setStarred", "starred", "starredAmong",
  "sharedBoards", "searchBoards", "spaceCandidates", "groupCandidates", "requestAccess", "accessRequest",
  "accessRequests", "closeAccessRequest", "grantHolders", "boardRows", "close",
]);

/**
 * The one error class every Registry adapter throws for a refused call; match on `err.code`, never the class.
 * Codes: "last-owner" (setGrant, setScopedGrant, setTeamMember), "no-role", "limit", "in-use" (custom roles), "corrupt" (a stored row breaks an invariant, e.g. a tenant with no kind row), "idem-replay" /
 * "idem-mismatch" (see `idemErr`), "rate-limited" (requestAccess); the Postgres adapter adds "lock-timeout", "statement-timeout",
 * "overloaded", "queue-timeout", "client-timeout" (a timeout REJECTS, never resolves to null).
 */
export class RegistryError extends Error {
  /** @param {string} code @param {string} message @param {ErrorOptions} [options] */
  constructor(code, message, options) { super(message, options); this.name = "RegistryError"; this.code = code; }
}

/** Tenant ids: "t-" + 12 of [a-z0-9]; Group "g-", Space "s-", Team "tm-", custom role "r-", each + 12. Board ids: "b-" + 16. Invite ids: "i-" + 16. Link ids: 26 (≈ 134 bits). */
export const mint = {
  tenant: () => "t-" + randomId(12),
  group: () => "g-" + randomId(12),
  space: () => "s-" + randomId(12),
  team: () => "tm-" + randomId(12),
  role: () => "r-" + randomId(12),
  board: () => "b-" + randomId(16),
  invite: () => "i-" + randomId(16),
  link: () => randomId(26),
  request: () => "ar-" + randomId(12),
};

/**
 * @typedef {"owner"|"editor"|"annotator"|"commenter"|"viewer"} Role
 * @typedef {"company"|"enterprise"} UnitKind
 * @typedef {{ id: string, domain: string|null, domains: string[], kind: UnitKind, admins: string[], createdAt: number }} Tenant   `domain`: the first domain (null if none); `domains`: every domain the Unit owns, `domain` first
 * @typedef {{ id: string, tenant: string, title: string, memberRole: Role|null, space: string|null, createdAt: number }} Board
 * @typedef {{ id: string, tenant: string, name: string, generalRole: Role|null, createdAt: number }} Group
 * @typedef {{ id: string, tenant: string, group: string|null, name: string, kind: "shared"|"personal", owner: string|null, generalRole: Role|null, createdAt: number }} Space
 * @typedef {{ id: string, tenant: string, name: string, createdAt: number }} Team
 * @typedef {{ id: string, tenant: string, name: string, base: string|null, boardRole: Role|null, permissions: string[], createdAt: number }} CustomRole
 * @typedef {{ type: "unit"|"group"|"space"|"board", id: string }} ScopeRef   a Unit's id is its tenant id
 * @typedef {{ type: "user"|"team", id: string }} Subject
 * @typedef {{ subject: Subject, role: string }} ScopedGrant
 * @typedef {{ tenant: Tenant, board: Board|null, space: Space|null, group: Group|null }} Chain   the scope's stable records (a roleCache may keep them for a while and hand them back)
 * @typedef {{ tenant: Tenant, board: Board|null, space: Space|null, group: Group|null,
 *   scoped: { unit: ScopedGrant[], group: ScopedGrant[], space: ScopedGrant[], board: ScopedGrant[] },
 *   roles: CustomRole[], teams: Record<string, string[]> }} AccessContext   `scoped`: the grants on each scope of the chain (a board's are Team grants only; user grants on a board are `grants`); `roles`: the Unit's stored roles; `teams`: for each Team that appears in `scoped`, its members (only those named in `users`, when given)
 * @typedef {{ board: Board, grant: Role|null, teamGrants: ScopedGrant[], myTeams: string[], invites: Invite[], links: Link[] }} BoardRows   `teamGrants`: Team grants on the board; `myTeams`: those of the user's Teams that appear in `teamGrants`; `invites`: non-revoked, to the user's email; `links`: the link records of the user's uses on this board
 * @typedef {{ id: string, tenant: string, scope: ScopeRef, user: string, role: string, state: "pending"|"dismissed"|"granted", at: number, closedAt: number|null }} AccessRequest
 * @typedef {{ id: string, board: string, email: string, role: Role, expiresAt: number|null, revoked: boolean, by: string, createdAt: number }} Invite
 * @typedef {{ id: string, board: string, role: Role, expiresAt: number|null, revoked: boolean, by: string, createdAt: number }} Link
 *
 * @typedef {{
 *   createTenant(o: { domain: string|null, domains?: string[], kind?: UnitKind, admins?: string[] }): Promise<Tenant>,   // kind default "company"; `domain` + `domains` (all lower-cased, de-duplicated) are the Unit's domains; a domain has one tenant
 *   addTenantDomain(tenant: string, domain: string): Promise<void>,   // rejects a domain another tenant owns; idempotent for its own
 *   tenant(id: string): Promise<Tenant|null>,
 *   tenantByDomain(domain: string): Promise<Tenant|null>,
 *   addTenantAdmin(tenant: string, user: string): Promise<void>,
 *   tenantAdminsAmong(users: string[], o?: { timeoutMs?: number }): Promise<string[]>,   // those of `users` who are an admin of ANY tenant (the dev sign-in menu never offers one)
 *   createBoard(o: { tenant: string, title?: string, memberRole?: Role|null, space?: string, owner?: string, idem?: Idem }): Promise<Board>,   // `owner` gets an owner grant in the same step; without `space`: unfiled, memberRole default "viewer" (as always); with `space` (same tenant): memberRole default null = inherit the Space
 *   createGroup(o: { tenant: string, name: string, generalRole?: Role|null, owner?: string, idem?: Idem }): Promise<Group>,   // generalRole default null; `owner` gets an owner grant in the same step
 *   group(id: string): Promise<Group|null>,
 *   groups(tenant: string): Promise<Group[]>,
 *   createSpace(o: { tenant: string, name: string, group?: string|null, generalRole?: Role|null, owner?: string, idem?: Idem }): Promise<Space>,   // generalRole default "viewer"; null = only people added
 *   space(id: string): Promise<Space|null>,
 *   spaces(tenant: string): Promise<Space[]>,
 *   ensurePersonalSpace(tenant: string, user: string): Promise<Space>,   // idempotent, one per (tenant, user); private (generalRole null), the user is its owner
 *   createTeam(o: { tenant: string, name: string, idem?: Idem }): Promise<Team>,
 *   renameTeam(team: string, name: string): Promise<Team>,   // trimmed 1-200; rejects an unknown Team
 *   deleteTeam(team: string): Promise<void>,   // removes the Team, its members and EVERY grant it holds, atomically; code "last-owner" (nothing changes) when it is the only counted owner of a Group or Space; rejects an unknown Team
 *   teamsPage(tenant: string, o?: { after?: string|null, limit?: number, q?: string|null }): Promise<{ teams: (Team & { size: number })[], next: string|null }>,   // by id, one bounded page (default 50, cap 200); `q`: ASCII-folded substring of the name; `size` = members, counted to at most TEAM_SIZE_CAP + 1 (a Team of 100k costs one index probe of 1001 rows)
 *   teamsAmong(tenant: string, ids: string[]): Promise<(Team & { size: number })[]>,   // those of `ids` (at most 200) that are Teams of this tenant, with `size` as in teamsPage, by id
 *   teamMembersPage(team: string, o?: { after?: string|null, limit?: number }): Promise<{ users: string[], next: string|null }>,   // by user id (default 50, cap 200)
 *   scopedGrant(scope: ScopeRef, subject: Subject): Promise<string|null>,   // one grant's role (null = none): the single-row read a grant change compares against
 *   scopedGrantsPage(scope: ScopeRef, o?: { after?: string|null, limit?: number }): Promise<{ grants: ScopedGrant[], next: string|null }>,   // by subject ("user"/"team" then id; cursor "<type>\n<id>"), default 50, cap 200
 *   touchMember(tenant: string, o: { user: string, name?: string|null, email?: string|null }): Promise<void>,   // the member directory: records a Unit member seen at sign-in (the code exchange) or on Home; writes only when the row is new or its name/email changed
 *   membersAmong(tenant: string, users: string[]): Promise<{ user: string, name: string|null, email: string|null }[]>,   // those of `users` (at most 200) in the Unit's directory
 *   findMembers(tenant: string, o?: { q?: string|null, limit?: number }): Promise<{ user: string, name: string|null, email: string|null }[]>,   // directory search by ASCII-folded substring of name, email or user id; by name then id; default 20, cap 50
 *   team(id: string): Promise<Team|null>,
 *   teams(tenant: string): Promise<Team[]>,
 *   setTeamMember(team: string, user: string, member: boolean): Promise<void>,
 *   teamMembers(team: string): Promise<string[]>,
 *   setScopedGrant(o: { scope: ScopeRef, subject: Subject, role: string|null }): Promise<void>,   // rejects a user subject on a board (use setGrant) and a Team of another tenant; Group/Space: code "last-owner"; a role shaped like a custom role id ("r-…") must exist in the scope's Unit, checked inside the write that stores it (code "no-role"), so a grant cannot land on a role deleted a moment before and a delete cannot pass while such a write is in flight
 *   rename(scope: { type: "board"|"space"|"group", id: string }, name: string): Promise<Board|Space|Group>,   // a board's title (trimmed, 0-200 chars) or a Space's / Group's name (trimmed, 1-200); rejects an unknown scope, nothing else changes
 *   updateScope(scope: { type: "space"|"group", id: string }, patch: { name?: string, generalRole?: string|null }): Promise<Space|Group>,   // rename and/or change general access in ONE atomic step (null = only people added); at least one field; rejects an unknown scope; nothing else changes
 *   spacesIn(group: string, o?: { after?: string|null, limit?: number }): Promise<{ spaces: Space[], next: string|null }>,   // a Group's Spaces, by id, one bounded page (default 500, cap 1000); an unknown Group lists none
 *   scopedGrants(scope: ScopeRef): Promise<ScopedGrant[]>,
 *   createRole(o: { tenant: string, name: string, base?: string|null, boardRole: Role, permissions?: string[], max?: number, idem?: Idem }): Promise<CustomRole>,   // `max`: rejects code "limit" (atomically) when the Unit already has `max` custom roles (the "member" override is not counted)
 *   deleteRole(tenant: string, id: string): Promise<void>,   // ONE atomic step: rejects code "in-use" while any scoped grant OF THIS UNIT holds the role; never the "member" role (rejects "registry: bad role"); an unknown id rejects "registry: no such role"
 *   roleUsage(tenant: string, ids: string[], o?: { cap?: number }): Promise<Map<string, { places: number, users: number, teams: string[] }>>,   // per id (at most ROLE_LIMITS.custom + 1), THIS Unit's grants only (a scoped grant has no tenant column: its scope's row, a Unit, Group, Space or board of the tenant, says whose it is; another Unit's grant holding the same role string never counts): scoped-grant rows holding it counted to cap + 1, DISTINCT user subjects counted to cap + 1 (one person holding the role in twelve places is one), and up to ROLE_LIMITS.teamIds Team ids (by id); an index probe each, never a scan; the "member" id is refused ("registry: bad role"): it is not grantable and its id is shared by every Unit
 *   memberCount(tenant: string, o?: { cap?: number }): Promise<number>,   // the Unit's directory rows, counted to cap + 1 (default cap ROLE_LIMITS.memberCap)
 *   updateRole(tenant: string, id: string, patch: { name?: string, boardRole?: Role|null, permissions?: string[] }): Promise<CustomRole>,   // id "member" (the editable Unit member role) is created on first update; rejects an unknown id
 *   role(tenant: string, id: string): Promise<CustomRole|null>,
 *   roles(tenant: string): Promise<CustomRole[]>,
 *   accessContexts(scopes: ScopeRef[], o?: { users?: string[] }): Promise<Map<string, AccessContext|null>>,   // `accessContext` for many Unit, Group or Space scopes (at most HOME.batch, else rejects) in ONE step; keys are `type + "\n" + id`, null for an unknown scope
 *   accessContext(scope: ScopeRef, o?: { users?: string[], chain?: Chain }): Promise<AccessContext|null>,   // null for an unknown scope; see "accessContext" below
 *   boardsIn(scope: ScopeRef, o?: { after?: string|null, limit?: number }): Promise<{ ids: string[], next: string|null }>,   // board ids in a Unit, Group or Space, by id, one bounded page
 *   scopesOf(subject: Subject, o?: { after?: string|null, limit?: number }): Promise<{ scopes: (ScopeRef & { role: string })[], next: string|null }>,   // the scopes a user or Team holds a grant on (not boards: a board's own user grants are `grants`)
 *   board(id: string): Promise<Board|null>,
 *   setGrant(board: string, user: string, role: Role|null): Promise<void>,   // rejects code "last-owner" (atomic)
 *   grant(board: string, user: string): Promise<Role|null>,
 *   grants(board: string): Promise<{ user: string, role: Role }[]>,
 *   createInvite(o: { board: string, email: string, role: Role, expiresAt?: number|null, by: string, idem?: Idem }): Promise<Invite>,
 *   invite(id: string): Promise<Invite|null>,
 *   invites(board: string): Promise<Invite[]>,
 *   invitesFor(board: string, email: string): Promise<Invite[]>,
 *   revokeInvite(id: string): Promise<boolean>,
 *   createLink(o: { board: string, role: Role, expiresAt?: number|null, by: string, idem?: Idem }): Promise<Link>,
 *   link(id: string): Promise<Link|null>,
 *   links(board: string): Promise<Link[]>,
 *   revokeLink(id: string): Promise<boolean>,
 *   addLinkUse(link: string, user: string): Promise<void>,
 *   linkUses(board: string, user: string): Promise<string[]>,
 *   linkUsesFor?(board: string, users: string[]): Promise<Map<string, string[]>>,   // OPTIONAL batch (below)
 *   idemGet(idem: Idem): Promise<{ state: "none" } | { state: "done", ref: string } | { state: "mismatch" }>,   // read-only: is there a live row for (user, key), and for this fingerprint
 *   markOpened(user: string, board: string): Promise<void>,   // Home (PROTOCOL.md § Home): Recent. Upserts (user, board) at now(); keeps the user's newest RECENT_KEEP rows; rejects an unknown board
 *   recents(user: string, o?: { limit?: number }): Promise<{ board: string, at: number }[]>,   // newest first; limit default 12, at most RECENT_KEEP
 *   setStarred(user: string, board: string, on: boolean): Promise<void>,   // idempotent; rejects an unknown board when starring; un-starring never rejects
 *   starred(user: string, o?: { limit?: number }): Promise<{ board: string, at: number }[]>,   // newest star first; limit default 50, at most STAR_SCAN
 *   starredAmong(user: string, boards: string[]): Promise<string[]>,   // those of `boards` (at most BATCH) the user starred
 *   sharedBoards(user: string, email: string|null, o?: { limit?: number }): Promise<string[]>,   // boards the user reaches through a source on the board itself (owner grants included): a direct grant, a grant to a Team the user is in, a non-revoked invite to `email`, a redeemed link; by id, at most SHARED_SCAN. Whether the board's Space is openable is the caller's business (Home)
 *   searchBoards(tenant: string, o?: { q?: string, unfiled?: boolean, after?: string|null, scan?: number }): Promise<{ ids: string[], next: string|null }>,   // board ids in a Unit whose title or Space's name contains q (ASCII case-folding only, LIKE characters literal; `unfiled`: boards in no Space, q then matches the title). By id. A page examines the next `scan` boards (default 1000, at most 5000) and returns EVERY match among them; `next` is set only when the Unit goes on past that window, never because of how many matched (a caller that hides some matches must not learn their number from `next`)
 *   spaceCandidates(tenant: string, o: { user: string, all?: boolean, after?: string|null, limit?: number }): Promise<{ spaces: Space[], groups: Group[], next: string|null }>,   // the Unit's Spaces the user COULD open, by id (a superset; the resolver decides): general access set, the user's personal space, a grant to the user or one of their Teams on the Space or its Group, a Group with general access; `all` = every Space (the user holds a Unit-level role). `groups`: the Groups of the returned Spaces. Limit default 100, at most 200
 *   groupCandidates(tenant: string, o: { user: string, all?: boolean, limit?: number }): Promise<Group[]>,   // Groups the user could open, by id, at most `limit` (default 50, at most 100): general access set, or a grant to the user or a Team of theirs, or `all`
 *   requestAccess(o: { tenant: string, scope: ScopeRef, user: string, role: string, idem?: Idem, limits?: { perUser?: number, scopePending?: number }, supersede?: boolean }): Promise<AccessRequest>,   // Access requests (#51): ONE atomic step (the key first, then the scope's existence in the tenant, the person's own row, the cooldown, the limits, the write); an open request is returned as it is, unless `supersede` is true and it asks a different role than `role` (the caller's access already reaches the old one): then it is replaced (a NEW id, so an older key never replays the newer request) and the scope count leaves the replaced row out; rejects code "rate-limited" with `retryAfterMs` (null: no wait helps)
 *   accessRequest(scope: ScopeRef, user: string): Promise<AccessRequest|null>,   // the person's row at the scope (pending, or dismissed and still in its cooldown), null once expired
 *   accessRequests(scope: ScopeRef, o?: { limit?: number }): Promise<AccessRequest[]>,   // the PENDING ones, newest first (default 50, at most 200), none older than ASK.ttlMs
 *   closeAccessRequest(scope: ScopeRef, user: string, state: "dismissed"|"granted"): Promise<boolean>,   // both keep the row and stamp `closedAt`: "dismissed" holds the cooldown (counted from `closedAt`), "granted" only the per-person count (a granted row is never returned and never blocks); true when a row was pending
 *   grantHolders(scope: ScopeRef, roles: string[], o?: { limit?: number }): Promise<ScopedGrant[]>,   // the scoped grants AT the scope whose role is one of `roles`, by subject, at most `limit` (default and cap ASK.holders)
 *   boardRows(boards: string[], o: { user: string, email?: string|null }): Promise<Map<string, BoardRows>>,   // the board-scope rows the resolver reads for one user over at most BATCH boards, in a fixed number of statements; unknown ids are absent
 *   close(): Promise<void>,   // idempotent; the memory adapter has nothing to release and resolves at once
 * }} Registry
 */

/**
 * Access requests (PROTOCOL.md § Access explanation and requests): the limits every adapter applies inside `requestAccess`'s one atomic step.
 * cooldownMs: a dismissed request blocks a new one this long from when it was made; perUser per windowMs: requests one person may make across all scopes;
 * scopePending: pending requests one scope holds; ttlMs: a request older than this is ignored and pruned (pruned `prune` at a time); holders: most `grantHolders` returns.
 */
export const ASK = Object.freeze({ cooldownMs: 24 * 3600_000, windowMs: 24 * 3600_000, perUser: 20, scopePending: 200, ttlMs: 30 * 24 * 3600_000, prune: 100, holders: 20, page: { default: 50, max: 200 } });
/** The refusal of `requestAccess`: code "rate-limited", `retryAfterMs` = when it may succeed (null: not before something else changes). */
export const askLimited = retryAfterMs => Object.assign(new RegistryError("rate-limited", "registry: access requests are rate limited"), { retryAfterMs });
/** The scope types a request names, and the validated shape of one (every adapter agrees). */
export const ASK_SCOPES = ["group", "space", "board"];
export const askScope = s => { const sc = orgDefaults.scope(s); if (!ASK_SCOPES.includes(sc.type)) fail("scope"); return sc; };
export const askRole = r => { if (typeof r !== "string" || !r || r.length > 64 || r.includes("\0")) fail("role"); return r; };
/** The pending request an adapter returns for one at `at`, pending and not expired, else a dismissed one in its cooldown; null when it no longer matters. */
export const askLive = (row, t) => {
  if (!row || row.state === "granted") return null;
  const base = row.state === "dismissed" ? row.closedAt ?? row.at : row.at;     // a dismissal's cooldown and expiry run from the dismissal, not from the ask
  return t - base >= ASK.ttlMs || (row.state === "dismissed" && t - base >= ASK.cooldownMs) ? null : row;
};
/** When a dismissed row may be asked again, as a wait in ms. */
export const askWait = (row, t) => (row.closedAt ?? row.at) + ASK.cooldownMs - t;
/** The limits of one `requestAccess`: the defaults, which a caller's `limits` can only lower (tests). */
export const askLimits = o => {
  const lower = (v, d) => (Number.isInteger(v) && v >= 0 ? Math.min(v, d) : d);
  return { perUser: lower(o?.perUser, ASK.perUser), scopePending: lower(o?.scopePending, ASK.scopePending) };
};

/** Home (PROTOCOL.md § Home): rows kept per user in Recent, rows a starred / shared read may return, and the most boards one `boardRows` / `starredAmong` call takes. */
/** Idempotent creates (PROTOCOL.md): a key row is kept `ttlMs`; expired rows are pruned `prune` at a time, every `every`-th keyed create. */
export const IDEM = Object.freeze({ ttlMs: 24 * 3600_000, prune: 500, every: 64 });
/** @typedef {{ user: string, key: string, fp: string }} Idem  The Idempotency-Key of a create: its user, the key, the SHA-256 fingerprint of the request. */
/** The two rejections of a keyed create that met a live row. Match on `code`, not the class. */
export const idemErr = {
  replay: ref => Object.assign(new RegistryError("idem-replay", "registry: idempotent replay"), { ref }),
  mismatch: () => new RegistryError("idem-mismatch", "registry: idempotency key reused"),
};
/** `idem` as the adapters take it (the key's format is http.js's to enforce): absent = null; else three non-empty strings, or "registry: bad idempotency key". */
export const idemOf = idem => {
  if (idem == null) return null;
  const { user, key, fp } = idem;
  for (const v of [user, key, fp]) if (typeof v !== "string" || !v) throw new Error("registry: bad idempotency key");
  return { user, key, fp };
};
export const HOME = { recentKeep: 50, starScan: 200, sharedScan: 200, batch: 200, searchScan: { default: 1000, max: 5000 }, candidates: { spaces: { default: 100, max: 200 }, groups: { default: 50, max: 100 } } };
/** The scopes of `accessContexts`: distinct Unit, Group or Space refs, at most HOME.batch. @returns {{ type: string, id: string }[]} */
export function batchScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length > HOME.batch) throw new Error("registry: bad scopes");
  const seen = new Map();
  for (const sc of scopes) {
    const { type, id } = orgDefaults.scope(sc);
    if (type === "board") throw new Error("registry: bad scopes");
    seen.set(type + "\n" + id, { type, id });
  }
  return [...seen.values()];
}
/** A small read's limit: default `d`, at least 1, at most `max`. */
export const smallLimit = (n, d, max) => Math.min(max, Math.max(1, Math.floor(Number(n) || d)));
/** ASCII case folding, the only folding search does (every adapter agrees: PROTOCOL.md § Home). */
export const asciiFold = t => String(t).replace(/[A-Z]/g, c => c.toLowerCase());
/** The `q` of `searchBoards`: a string, trimmed, 1-100 chars; else "registry: bad query". */
export const searchQuery = q => { const t = typeof q === "string" ? q.trim() : ""; if (!t || t.length > 100 || t.includes("\0")) throw new Error("registry: bad query"); return t; };

/** Teams (PROTOCOL.md § Teams and access): page sizes of the Team and grant listings, the directory search, and the cap a Team's `size` is counted to. */
export const TEAMS = { page: { default: 50, max: 200 }, find: { default: 20, max: 50 }, sizeCap: 1000, among: 200 };
/** The `q` of a Team or directory search: null/empty = no filter; else trimmed, at most 100 chars, no NUL. Returns the LIKE pattern (ASCII-folded, wildcards literal) or null. */
export function likeOf(q) {
  if (q == null) return null;
  const t = typeof q === "string" ? q.trim() : null;
  if (t === null || t.length > 100 || t.includes("\0")) fail("query");
  return t ? "%" + asciiFold(t).replace(/[\\%_]/g, "\\$&") + "%" : null;
}
/** The fields a directory row carries: a short string or null. */
export const profileText = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Page size for `boardsIn` / `scopesOf`: default and cap. */
export const PAGE = { default: 500, max: 1000 };
/** A page limit as the adapters apply it. */
export const pageLimit = n => Math.min(PAGE.max, Math.max(1, Math.floor(Number(n) || PAGE.default)));

/** Roles (PROTOCOL.md § Roles): custom roles per Unit, the cap usage is counted to, the Team ids `roleUsage` returns, the cap of `memberCount`. */
export const ROLE_LIMITS = { custom: 50, usageCap: 100, teamIds: 50, memberCap: 50 };
/** A role string shaped like a custom role id (`mint.role`): a scoped grant holding one needs that role to exist in the scope's Unit (`setScopedGrant`, code "no-role"). */
export const isCustomRoleId = r => typeof r === "string" && r.startsWith("r-");
/** A usage / count cap: a whole number from 1 to 1000, default `d`. */
export const capOf = (n, d) => Math.min(1000, Math.max(1, Math.floor(Number(n) || d)));

/** The kinds a Unit may carry (a label; Units never nest). */
export const KINDS = ["company", "enterprise"];
/** Scope types, outermost first. A Unit's scope id is its tenant id. */
export const SCOPES = ["unit", "group", "space", "board"];
/** The Unit's editable "member" role (stored under this id in the Unit's roles) and what it grants until an admin edits it. */
export const MEMBER_ROLE_ID = "member";
export const DEFAULT_MEMBER_PERMS = ["space.create"];

const fail = what => { throw new Error(`registry: bad ${what}`); };

/** Input rules every adapter applies to the organization calls, so memory, SQLite and Postgres refuse the same inputs the same way. */
export const orgDefaults = {
  /** A display name: a string, trimmed, 1-200 chars. */
  name(v) {
    const n = typeof v === "string" ? v.trim() : "";
    if (!n || n.length > 200) fail("name");
    return n;
  },
  /** A board title: a string, trimmed, 0-200 chars (a board may be untitled), no NUL. */
  title(v) {
    const n = typeof v === "string" ? v.trim() : "";
    if (typeof v !== "string" || n.length > 200 || n.includes("\0")) fail("title");
    return n;
  },
  /** The patch of `updateScope`: `{ name?, generalRole? }` with at least one field, each validated like create. */
  patch(p) {
    if (!p || typeof p !== "object" || (p.name === undefined && p.generalRole === undefined)) fail("patch");
    return { name: p.name === undefined ? undefined : orgDefaults.name(p.name), generalRole: p.generalRole === undefined ? undefined : orgDefaults.grantRole(p.generalRole) };
  },
  /** The scope a `rename` / `updateScope` names: one of `types`. */
  renamable(s, types) {
    if (!s || !types.includes(s.type) || typeof s.id !== "string" || !s.id || s.id.includes("\0")) fail("scope");
    return { type: s.type, id: s.id };
  },
  /** The name of a member's personal Space until they rename it. */
  personalName: user => `${String(user).replace(/^[a-z]+:/, "")}'s space`,
  /** @returns {import("./registry-port.js").ScopeRef} */
  scope(s) {
    if (!s || !SCOPES.includes(s.type) || typeof s.id !== "string" || !s.id || s.id.includes("\0")) fail("scope");
    return { type: s.type, id: s.id };
  },
  /** @returns {import("./registry-port.js").Subject} */
  subject(s) {
    if (!s || (s.type !== "user" && s.type !== "team") || typeof s.id !== "string" || !s.id || s.id.includes("\0")) fail("subject");
    return { type: s.type, id: s.id };
  },
  /**
   * A page cursor (`after` of boardsIn / scopesOf) as an adapter applies it: null/undefined = the first page; otherwise it
   * must be what a previous page's `next` was (boardsIn: a board id; scopesOf: "<type>\n<id>"), else it is REFUSED with
   * "registry: bad cursor" rather than silently restarting from the beginning (a caller looping on `next` would never end).
   * An unknown but well-formed cursor is just a position.
   * @param {"id"|"scope"|"subject"} kind
   */
  cursor(after, kind) {
    if (after == null) return null;
    const ok = typeof after === "string" && after.length > 0 && after.length <= 600 && !after.includes("\0")
      && (kind === "id" ? !after.includes("\n") : (kind === "subject" ? /^(user|team)\n./ : /^(unit|group|space|board)\n./).test(after));
    if (!ok) fail("cursor");
    return after;
  },
  /** A role string for a scoped grant (validity at the scope is the admin layer's and the resolver's business), or null to remove. */
  grantRole(r) {
    if (r == null) return null;
    if (typeof r !== "string" || !r || r.length > 64 || r.includes("\0")) fail("role");
    return r;
  },
};

/** The Unit's domains: `domain` then `domains`, lower-cased, trimmed, de-duplicated, empties dropped. */
export function domainList(domain, domains = []) {
  const out = [];
  for (const d of [domain, ...domains]) {
    const x = typeof d === "string" ? d.trim().toLowerCase() : "";
    if (x && !out.includes(x)) out.push(x);
  }
  return out;
}

