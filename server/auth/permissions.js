// Permissions and roles (PROTOCOL.md § Tenancy, "Permissions"). Pure data and functions; no I/O. The server checks
// PERMISSIONS, never role names: `roleDef` turns any role held at a scope into the permissions it grants there plus
// the board-content ladder role it gives the live room. The room only ever sees that one ladder role.
//
// Scopes, outermost first: unit (tenant) > group > space > board. A role held on a container covers everything inside
// it, so the permissions it grants are clipped to what makes sense AT the scope where it is held (ALLOWED_AT).

import { ROLES, INVITE_ROLES, rank } from "./util.js";
import { SCOPES, MEMBER_ROLE_ID, DEFAULT_MEMBER_PERMS } from "./registry-port.js";

/** @typedef {"unit"|"group"|"space"|"board"} ScopeType */
/** @typedef {{ id: string, tenant: string, name: string, base: string|null, boardRole: string|null, permissions: string[], createdAt: number }} CustomRole */

export { SCOPES };

/** Board-content permissions: the live room's ladder, one step each. */
export const CONTENT_PERMS = ["board.view", "board.comment", "board.annotate", "board.edit"];
/** Management permissions: what the admin layer checks. */
export const MGMT_PERMS = ["board.create", "space.create", "group.create", "members.manage", "move", "delete", "transfer", "roles.manage", "team.manage"];
export const PERMISSIONS = [...CONTENT_PERMS, ...MGMT_PERMS];

/** The content permissions of each ladder role (owner has all four; ownership itself is the ladder role `owner`). */
const CONTENT_OF = { viewer: 1, commenter: 2, annotator: 3, editor: 4, owner: 4 };
export const contentPerms = ladder => CONTENT_PERMS.slice(0, CONTENT_OF[ladder] ?? 0);

/** Which management permissions mean something at each scope; a role holding others there gets them dropped. */
export const ALLOWED_AT = {
  unit: MGMT_PERMS,
  group: MGMT_PERMS.filter(p => p !== "roles.manage" && p !== "group.create" && p !== "team.manage"),
  space: MGMT_PERMS.filter(p => p !== "roles.manage" && p !== "space.create" && p !== "group.create" && p !== "team.manage"),
  board: ["members.manage", "move", "delete", "transfer"],
};

/** Built-in ladder roles' management permissions (before clipping). Fixed: not editable. */
const LADDER_MGMT = {
  owner: ["board.create", "space.create", "members.manage", "move", "delete", "transfer"],
  editor: ["board.create", "space.create"],
};
/** Unit roles. `admin` is fixed; `member` (id "member") is what every Unit member gets and an admin may edit. */
export const UNIT_ROLES = ["admin", "member"];
export { MEMBER_ROLE_ID, DEFAULT_MEMBER_PERMS };

/**
 * What `role`, held at `scope`, grants: `{ permissions: Set, ladder }` (`ladder` = the room role, or null), or null for a
 * role that isn't valid there (unknown, or a Unit role below the Unit). Nothing stored is trusted as-is.
 * @param {string} role  a ladder name, "admin", "member", or a custom role id
 * @param {ScopeType} scope
 * @param {Map<string, CustomRole>} [roles]  the Unit's stored roles by id (custom roles, and the "member" override)
 * @param {{ adminBoardContent?: boolean }} [o]  adminBoardContent: whether Unit admin carries board content (view..edit, ladder owner)
 */
export function roleDef(role, scope, roles = new Map(), { adminBoardContent = false } = {}) {
  const at = ALLOWED_AT[scope];
  if (!at || typeof role !== "string") return null;
  const clip = list => list.filter(p => at.includes(p));
  if (role === "admin") return scope === "unit"
    ? { permissions: new Set([...(adminBoardContent ? CONTENT_PERMS : []), ...MGMT_PERMS]), ladder: adminBoardContent ? "owner" : null }
    : null;
  if (role === MEMBER_ROLE_ID) {
    if (scope !== "unit") return null;
    const o = roles.get(MEMBER_ROLE_ID);
    const mgmt = o ? o.permissions : DEFAULT_MEMBER_PERMS;
    const ladder = o ? ladderOf(o.boardRole) : null;
    return { permissions: new Set([...contentPerms(ladder), ...clip(mgmt.filter(p => MGMT_PERMS.includes(p)))]), ladder };
  }
  if (ROLES.includes(role)) {
    if (scope === "unit") return null;
    return { permissions: new Set([...contentPerms(role), ...clip(LADDER_MGMT[role] ?? [])]), ladder: role };
  }
  const c = roles.get(role);
  if (!c) return null;
  const ladder = ladderOf(c.boardRole);
  return { permissions: new Set([...contentPerms(ladder), ...clip(c.permissions.filter(p => MGMT_PERMS.includes(p)))]), ladder };
}

/**
 * No board-ladder escalation (PROTOCOL.md § Share dialog, "Nobody gives more than they hold"): may someone whose own effective board role at a scope is `own` hand out
 * a role that gives board role `given`? At most their own (`given` null gives no board content: always fine). A Unit admin is exempt: the caller passes `admin`, the
 * Unit-wide permission check (`isUnitAdmin`), never a role name. One helper for the grant route, invites and links.
 * @param {string|null} own @param {string|null} given @param {boolean} [admin]
 */
export const withinLadder = (own, given, admin = false) => admin || given == null || rank(given) <= rank(own);

/** A custom role's board-content role: one of viewer..editor (never owner), else null. */
const ladderOf = r => (INVITE_ROLES.includes(r) ? r : null);

/**
 * Checks a custom role (or the "member" override) before it is stored; null when fine, else why not. Adapters store
 * what they are given: this is the admin layer's gate (and `roleDef` re-caps whatever it reads).
 * @param {{ boardRole: string|null, permissions: string[] }} r
 * @param {{ member?: boolean }} [o]  the Unit member role may carry no board content
 */
export function roleProblem(r, { member = false } = {}) {
  if (!r || typeof r !== "object") return "bad role";
  if (r.boardRole == null ? !member : !INVITE_ROLES.includes(r.boardRole)) return "a role carries exactly one board role: viewer, commenter, annotator or editor";
  if (!Array.isArray(r.permissions) || r.permissions.some(p => !MGMT_PERMS.includes(p)) || new Set(r.permissions).size !== r.permissions.length)
    return "permissions must be distinct management permissions: " + MGMT_PERMS.join(", ");
  return null;
}

export { rank };
