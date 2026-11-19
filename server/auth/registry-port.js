// The Registry port (PROTOCOL.md § Registry): tenants, the board registry (`Registry.board(id)`; the Store has no
// board lookup), per-board grants, invites and share links. No adapter code here: adapters are server/auth/registry.js
// (memory) and server/registry/{sqlite,postgres}.js (engine). Every adapter passes test/auth/registry-contract.js.
// Method names are STABLE.
//
// Last owner: `setGrant` refuses to remove or demote a board's last `owner` grant, throwing an error whose
// `code` is "last-owner" (match on the code, not the class: other adapters throw their own). The check and the
// write are one atomic step (in one JS process: no await between them; in SQL: one transaction or a conditional
// write), and a refused call changes nothing. Caller rules (who may grant what) live in server/admin/boards.js.
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
// nowhere, which is every board made before Spaces existed). `accessContext` is the one read the resolver needs for
// a scope's whole chain (board, Space, Group, Unit) so a hello costs one call, not one per table.
//
// Last owner, again: `setScopedGrant` on a Group or Space refuses to remove or demote its last `owner` grant (a user's
// or a Team's), code "last-owner", atomically like `setGrant`. Unit admins (tenant admins) are the backstop and
// are not counted. Role strings are stored as given (the admin layer validates them with server/auth/permissions.js;
// the resolver ignores a role that is not valid where it is held).
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

/** Thrown by `setGrant` when the change would leave a board with no owner. Match on `err.code === "last-owner"`. */
export class RegistryError extends Error {
  /** @param {"last-owner"} code */
  constructor(code, message) { super(message); this.name = "RegistryError"; this.code = code; }
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
 *   createBoard(o: { tenant: string, title?: string, memberRole?: Role|null, space?: string }): Promise<Board>,   // without `space`: unfiled, memberRole default "viewer" (as always); with `space` (same tenant): memberRole default null = inherit the Space
 *   createGroup(o: { tenant: string, name: string, generalRole?: Role|null, owner?: string }): Promise<Group>,   // generalRole default null; `owner` gets an owner grant in the same step
 *   group(id: string): Promise<Group|null>,
 *   groups(tenant: string): Promise<Group[]>,
 *   createSpace(o: { tenant: string, name: string, group?: string|null, generalRole?: Role|null, owner?: string }): Promise<Space>,   // generalRole default "viewer"; null = only people added
 *   space(id: string): Promise<Space|null>,
 *   spaces(tenant: string): Promise<Space[]>,
 *   ensurePersonalSpace(tenant: string, user: string): Promise<Space>,   // idempotent, one per (tenant, user); private (generalRole null), the user is its owner
 *   createTeam(o: { tenant: string, name: string }): Promise<Team>,
 *   team(id: string): Promise<Team|null>,
 *   teams(tenant: string): Promise<Team[]>,
 *   setTeamMember(team: string, user: string, member: boolean): Promise<void>,
 *   teamMembers(team: string): Promise<string[]>,
 *   setScopedGrant(o: { scope: ScopeRef, subject: Subject, role: string|null }): Promise<void>,   // rejects a user subject on a board (use setGrant) and a Team of another tenant; Group/Space: code "last-owner"
 *   scopedGrants(scope: ScopeRef): Promise<ScopedGrant[]>,
 *   createRole(o: { tenant: string, name: string, base?: string|null, boardRole: Role, permissions?: string[] }): Promise<CustomRole>,
 *   updateRole(tenant: string, id: string, patch: { name?: string, boardRole?: Role|null, permissions?: string[] }): Promise<CustomRole>,   // id "member" (the editable Unit member role) is created on first update; rejects an unknown id
 *   role(tenant: string, id: string): Promise<CustomRole|null>,
 *   roles(tenant: string): Promise<CustomRole[]>,
 *   accessContext(scope: ScopeRef, o?: { users?: string[], chain?: Chain }): Promise<AccessContext|null>,   // null for an unknown scope; see "accessContext" below
 *   boardsIn(scope: ScopeRef, o?: { after?: string|null, limit?: number }): Promise<{ ids: string[], next: string|null }>,   // board ids in a Unit, Group or Space, by id, one bounded page
 *   scopesOf(subject: Subject, o?: { after?: string|null, limit?: number }): Promise<{ scopes: (ScopeRef & { role: string })[], next: string|null }>,   // the scopes a user or Team holds a grant on (not boards: a board's own user grants are `grants`)
 *   board(id: string): Promise<Board|null>,
 *   setGrant(board: string, user: string, role: Role|null): Promise<void>,   // rejects code "last-owner" (atomic)
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
 *   linkUsesFor?(board: string, users: string[]): Promise<Map<string, string[]>>,   // OPTIONAL batch (below)
 * }} Registry
 */

/** Page size for `boardsIn` / `scopesOf`: default and cap. */
export const PAGE = { default: 500, max: 1000 };
/** A page limit as the adapters apply it. */
export const pageLimit = n => Math.min(PAGE.max, Math.max(1, Math.floor(Number(n) || PAGE.default)));

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
   * @param {"id"|"scope"} kind
   */
  cursor(after, kind) {
    if (after == null) return null;
    const ok = typeof after === "string" && after.length > 0 && after.length <= 600 && !after.includes("\0")
      && (kind === "id" ? !after.includes("\n") : /^(unit|group|space|board)\n./.test(after));
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

