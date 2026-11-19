// The permission resolver (PROTOCOL.md § Tenancy, "Resolution"). Pure: every row it reads is handed in, so one rule
// serves a hello (one user) and a re-check pass (many) and can't disagree with itself.
//
// Access to a target (a board, or a Space, Group or the Unit itself) is the UNION of what every source grants; for the
// board ladder that means highest wins. There are no deny rules, so nothing subtracts. Every source is reported, in
// this order (the order only orders the report; a union has no precedence):
//
//   1. direct   the user's own grant on the board (`grants`), then on its Space, its Group (scoped grants)
//   2. team     a Team the user is in, granted on the same scopes, scope by scope (so each scope: direct, then team)
//   3. general  "everyone in the Unit" on the board (`memberRole`), the Space and the Group, for Unit members only
//   4. invite   a live invite to the user's authoritative email (board scope, capped below owner)
//   5. link     a live share link the user redeemed (board scope, within LINK_ROLES)
//   6. unit     Unit admin (`tenant.admins`), then roles granted on the Unit (the user's, then their Teams'), then the
//               Unit member role for members
//
// WHO COUNTS AS INSIDE. A *member* is an identity whose Workspace domain (`hd`) is one of the tenant's domains: only
// members get general access and the Unit member role. *Inside* = a member, or a Unit admin named by user id (the
// operator vouches for them, and it is what lets a Unit with no domain, such as a dev tenant, have a Space owner). Only
// the inside are on Spaces, Groups, the Unit and Teams: for anyone else the resolver skips every Space, Group and Unit
// grant and every Team source, so a guest holds only board-scope sources (a direct grant, an invite or a link), however
// the Registry's rows came to name them. The Registry can't tell a guest (membership is read from `hd` at sign-in, not
// stored), so this read-time rule is the enforcement.
//
// PERMISSIONS ARE CLIPPED WHERE ASKED. A role held at a scope covers what is inside it, but a permission only means
// something at some targets (ALLOWED_AT): every source's permissions are cut to the target asked about, so a Unit admin
// asked about a board has no `roles.manage`. The Unit member role's management permissions (`space.create`) apply only
// when the target is the Unit itself: creating a Space in a Group needs a role on that Group.
// `admin` and `member` are not grantable roles: admin comes only from `tenant.admins`, member only from membership.

import { capTo, higher, normEmail, LINK_ROLES, INVITE_ROLES } from "./util.js";
import { roleDef, MEMBER_ROLE_ID, UNIT_ROLES, CONTENT_PERMS, ALLOWED_AT } from "./permissions.js";

/** @typedef {import("./registry-port.js").Role} Role */
/** @typedef {import("./registry-port.js").AccessContext} AccessContext */
/** @typedef {import("./permissions.js").ScopeType} ScopeType */
/**
 * One reason a user has some access.
 * @typedef {{ kind: "direct"|"team"|"general"|"invite"|"link"|"unit", scope: { type: ScopeType, id: string },
 *   role: string, team?: string, permissions: string[], ladder: Role|null }} Source
 * @typedef {{ ladder: Role|null, permissions: Set<string>, sources: Source[], until: number }} Access
 */

const live = (x, t) => x && !x.revoked && (x.expiresAt == null || t < x.expiresAt);

/** Is this identity a Unit member (its Workspace domain belongs to the tenant)? */
export const isUnitMember = (tenant, identity) => !!(identity?.domain && tenant?.domains?.includes(identity.domain));

/** user → the Teams they are in, from a context's `teams` (one pass; build it once per pass, not per identity). @returns {Map<string, Set<string>>} */
export function teamIndex(ctx) {
  const m = new Map();
  for (const [team, users] of Object.entries(ctx.teams ?? {})) for (const u of users) { if (!m.has(u)) m.set(u, new Set()); m.get(u).add(team); }
  return m;
}

/**
 * Is this identity an admin of the tenant? An admin is named by user id (google:<sub>, dev:<name>) or, before their
 * first sign-in, by `email:<addr>`; an email entry matches only a Google caller whose email is that address AND who is a
 * Unit member (a guest from another domain holding that address elsewhere never becomes admin). An `email:` entry is
 * never matched as a user id.
 */
export function isUnitAdmin(tenant, identity) {
  if (!tenant || typeof identity?.user !== "string") return false;
  if (!identity.user.startsWith("email:") && tenant.admins.includes(identity.user)) return true;
  if (!identity.user.startsWith("google:")) return false;
  const email = normEmail(identity.email);
  return !!email && isUnitMember(tenant, identity) && tenant.admins.includes("email:" + email);
}

/**
 * @param {{ ctx: AccessContext, grant?: Role|null, invites?: object[], links?: (object|null)[], teams?: Set<string> }} rows
 *   ctx: the registry's view of the target's scope chain (registry.accessContext); the target is the innermost scope in
 *   it. grant/invites/links: the board-scope rows of this user (direct grant, invites to their email, link records of
 *   their uses); ignored off a board. teams: this user's Teams (from `teamIndex`), computed from ctx if absent.
 * @param {{ user: string, email?: string|null, domain?: string|null }} identity
 * @param {number} t
 * @param {{ adminBoardContent?: boolean }} [opts]  see roleDef. Default false: a Unit admin has every management
 *   permission but no board content unless granted (today's behaviour: a tenant admin enters no room without a role).
 * @returns {Access}
 */
export function resolveAccess({ ctx, grant = null, invites = [], links = [], teams }, identity, t, opts = {}) {
  const { tenant, board, space, group } = ctx;
  const roles = new Map((ctx.roles ?? []).map(r => [r.id, r]));
  const member = isUnitMember(tenant, identity), admin = isUnitAdmin(tenant, identity);
  const inside = member || admin;
  const myTeams = inside ? teams ?? teamIndex(ctx).get(identity.user) ?? new Set() : new Set();
  const target = board ? "board" : space ? "space" : group ? "group" : "unit";
  const visible = new Set([...CONTENT_PERMS, ...ALLOWED_AT[target]]), contentOnly = new Set(CONTENT_PERMS);
  /** The scope chain from the target outward, without the Unit. */
  const chain = [board && { type: "board", id: board.id }, space && { type: "space", id: space.id }, group && { type: "group", id: group.id }].filter(Boolean);
  const unit = tenant ? { type: "unit", id: tenant.id } : null;
  /** @type {Source[]} */ const sources = [];
  let until = Infinity;
  const add = (kind, scope, role, team) => {
    const def = roleDef(role, scope.type, roles, opts);
    if (!def) return;
    const keep = role === MEMBER_ROLE_ID && target !== "unit" ? contentOnly : visible;   // the member role's management permissions are the Unit's own
    sources.push({ kind, scope, role, ...(team ? { team } : {}), permissions: [...def.permissions].filter(p => keep.has(p)), ladder: def.ladder });
  };
  /** Grants on a Space, Group or the Unit, or a Team's grant anywhere, count only for the inside; and never the Unit roles `admin` and `member`. */
  const grantsOn = scope => {
    if (!inside) return;
    const all = (ctx.scoped?.[scope.type] ?? []).filter(g => !UNIT_ROLES.includes(g.role));
    for (const g of all) if (g.subject.type === "user" && g.subject.id === identity.user) add("direct", scope, g.role);
    for (const g of all) if (g.subject.type === "team" && myTeams.has(g.subject.id)) add("team", scope, g.role, g.subject.id);
  };
  // 1, 2: scope by scope, board first. The board's own direct grant is board scope: a guest may hold it.
  for (const scope of chain) {
    if (scope.type === "board") add("direct", scope, grant);
    grantsOn(scope);
  }
  // 3: general access, for Unit members. Never owner.
  if (member) {
    if (board) add("general", chain[0], capTo(board.memberRole, INVITE_ROLES));
    if (space) add("general", { type: "space", id: space.id }, capTo(space.generalRole, INVITE_ROLES));
    if (group) add("general", { type: "group", id: group.id }, capTo(group.generalRole, INVITE_ROLES));
  }
  // 4, 5: invites and links are board-scope
  if (board) {
    const bs = chain[0];
    for (const i of invites) if (live(i, t)) {
      add("invite", bs, capTo(i.role, INVITE_ROLES));
      if (i.expiresAt != null && i.expiresAt < until) until = i.expiresAt;
    }
    for (const l of links) if (l && l.board === board.id && live(l, t)) {
      add("link", bs, capTo(l.role, LINK_ROLES));
      if (l.expiresAt != null && l.expiresAt < until) until = l.expiresAt;
    }
  }
  // 6: the Unit
  if (unit) {
    if (admin) add("unit", unit, "admin");
    grantsOn(unit);
    if (member) add("unit", unit, MEMBER_ROLE_ID);
  }
  const permissions = new Set(sources.flatMap(s => s.permissions));
  const ladder = sources.reduce((r, s) => higher(r, s.ladder), /** @type {Role|null} */ (null));
  return { ladder, permissions, sources, until };
}
