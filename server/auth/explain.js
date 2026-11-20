// Access explanation (PROTOCOL.md § Access explanation and requests, #51). Core: depends on the Registry port and the resolver's own types, imports no adapter.
//
// ONE SOURCE OF TRUTH. Every answer here is built from the `Access` that `tenancy.effective` returned for the request in hand (the object the same handler used
// for `can.*`): its `sources` are the reasons, its `permissions` the answer. Nothing here resolves access a second time, and "what would be needed" comes from
// `roleDef` (permissions.js), never from a role name written down here. The pure helpers are exported for tests; `explainService` adds the few reads that name things.

import { roleDef } from "./permissions.js";
import { ROLES, rank } from "./util.js";
import { askWait } from "./registry-port.js";

export const LADDER_NAMES = { viewer: "Viewer", commenter: "Commenter", annotator: "Annotator", editor: "Editor", owner: "Owner" };
/** The name a role is shown by: a ladder name, "Admin"/"Member" (Unit roles), or a custom role's own name. */
export const BUILTIN_UNIT_NAMES = { admin: "Admin", member: "Member", "content-admin": "Unit content admin", "content-admin-personal": "Unit content admin (incl. personal spaces)" };
export const roleLabel = (role, roles) => LADDER_NAMES[role] ?? BUILTIN_UNIT_NAMES[role] ?? roles.get(role)?.name ?? String(role);

/** The permission whose absence a disabled control explains, per scope type: New board in a Space, New space in a Group, editing a board. */
export const KEY_PERMISSION = { space: "board.create", group: "space.create", board: "board.edit" };
/** The lowest BUILT-IN ladder role that holds the scope's key permission there, or null (none does; a custom role may). */
const needRole = (type, roles) => { const p = KEY_PERMISSION[type]; return p ? ROLES.find(r => roleDef(r, type, roles)?.permissions.has(p)) ?? null : null; };
/**
 * What would be needed, against what the caller HAS: `{ [permission]: { role, roleName, held } | null }`. `held` is true when the caller's ladder role is already at or above `role`
 * yet their `access.permissions` lack the key permission (their role gives board content but not this: the Unit member role with board role editor, a custom role with no
 * management permissions), so the sentence must not say "needs Editor" to someone who is an Editor.
 * @param {import("./resolver.js").Access} [access] omitted: what the permission needs, whoever asks
 */
export function needsOf(type, roles, access = null) {
  const p = KEY_PERMISSION[type];
  if (!p) return {};
  const role = needRole(type, roles);
  if (!role) return { [p]: null };
  return { [p]: { role, roleName: LADDER_NAMES[role], held: !!access && !access.permissions.has(p) && rank(access.ladder) >= rank(role) } };
}

/**
 * `mine`: the caller's own access as the resolver derived it. `strongest` marks every source that reaches the top ladder step (ties all marked); none when the union has no board content.
 * @param {import("./resolver.js").Access} access
 * @param {{ roles: Map<string, object>, scopeName?: (s: { type: string, id: string }) => string|undefined, teamName?: (id: string) => string|undefined }} o
 */
export function mineOf(access, { roles, scopeName = () => undefined, teamName = () => undefined }) {
  const top = access.ladder;
  return {
    role: top ? { id: top, name: LADDER_NAMES[top] } : null,
    sources: access.sources.map(s => {
      const name = scopeName(s.scope), team = s.team ? teamName(s.team) : undefined;
      return {
        kind: s.kind, scope: { type: s.scope.type, id: s.scope.id, ...(name !== undefined ? { name } : {}) }, role: s.role, roleName: roleLabel(s.role, roles), ladder: s.ladder, ...(s.content ? { content: s.content } : {}),
        ...(s.team ? { team: { id: s.team, ...(team !== undefined ? { name: team } : {}) } } : {}), strongest: top != null && s.ladder === top,
      };
    }),
  };
}

/**
 * The roles a person may ask for: the built-in ones above their own up to `editor` (never `owner`), plus the role the key permission needs when they lack that permission
 * though their ladder role is at or above it (`needs.held`). ONE function for the explanation's `ask.roles` and the route's check, so they cannot differ.
 */
export function askRolesFor(access, type, roles) {
  const out = new Set(ROLES.slice(rank(access.ladder) + 1, ROLES.indexOf("owner")));
  const p = KEY_PERMISSION[type], need = needRole(type, roles);
  if (p && need && need !== "owner" && !access.permissions.has(p)) out.add(need);
  return ROLES.filter(r => out.has(r)).map(id => ({ id, name: LADDER_NAMES[id] }));
}

/**
 * @param {{ registry: import("./registry-port.js").Registry, now?: () => number }} deps
 */
export function explainService({ registry, now = Date.now }) {
  const TYPES = { space: "space", group: "group" };

  /** Who may grant here, by name: holders of `members.manage` at the scope and at the containers the caller holds a source through. At most 10 people or Teams. */
  async function ownersOf(unitId, type, row, access, roles) {
    // Sources come only from the target's own chain, so the containers the caller holds a source through are exactly the ones to look at.
    const through = new Set(access.sources.map(s => s.scope.type + "\n" + s.scope.id));
    const chain = [{ type, id: row.id }, ...[...through].map(k => k.split("\n")).filter(([t, i]) => (t === "space" || t === "group") && !(t === type && i === row.id)).map(([t, i]) => ({ type: t, id: i }))];
    const out = [];
    for (const sc of chain) {
      const ids = ["owner", ...[...roles.values()].filter(r => roleDef(r.id, sc.type, roles)?.permissions.has("members.manage")).map(r => r.id)];
      const held = await registry.grantHolders(sc, ids, { limit: 10 });
      if (sc.type === "board") for (const g of (await registry.grants(sc.id)).filter(g => g.role === "owner").slice(0, 10)) held.push({ subject: { type: "user", id: g.user }, role: "owner" });
      for (const g of held) if (!out.some(o => o.type === g.subject.type && o.id === g.subject.id)) out.push({ type: g.subject.type, id: g.subject.id });
      if (out.length >= 10) break;
    }
    const subjects = out.slice(0, 10);
    const users = subjects.filter(s => s.type === "user").map(s => s.id), teams = subjects.filter(s => s.type === "team").map(s => s.id);
    const [people, groups] = await Promise.all([users.length ? registry.membersAmong(unitId, users) : [], teams.length ? registry.teamsAmong(unitId, teams) : []]);
    const byUser = new Map(people.map(m => [m.user, m])), byTeam = new Map(groups.map(t => [t.id, t]));
    return subjects.map(s => (s.type === "team"
      ? { type: "team", id: s.id, name: byTeam.get(s.id)?.name ?? "Unknown team" }
      : { type: "user", id: s.id, name: byUser.get(s.id)?.name ?? String(s.id).replace(/^[a-z]+:/, "") }));
  }

  return {
    /**
     * `{ mine, needs, owners, ask }` for a scope the caller can open, from the Access the handler already holds.
     * @param {import("./idp-port.js").Identity} identity
     * @param {{ type: "unit"|"group"|"space"|"board", row: object, access: import("./resolver.js").Access, unit: { id: string }|null, manage?: boolean, personal?: boolean }} o
     *   unit: the caller's own Unit when it is the scope's (null for a guest: they get their own sources only, no owners, no Ask).
     */
    async explain(identity, { type, row, access, unit, manage = false, personal = false }) {
      const tenant = type === "unit" ? row.id : row.tenant;
      const roles = new Map((await registry.roles(tenant)).map(r => [r.id, r]));
      const scopeNames = new Map([[type + "\n" + row.id, type === "board" ? row.title : type === "unit" ? undefined : row.name]]);
      const teamIds = [...new Set(access.sources.filter(s => s.team).map(s => s.team))];
      // The containers the caller holds a source through are named (they hold a role there). Guests hold board sources only, so nothing else is read for them.
      const wanted = new Map();
      for (const s of access.sources) if (TYPES[s.scope.type] && !scopeNames.has(s.scope.type + "\n" + s.scope.id)) wanted.set(s.scope.type + "\n" + s.scope.id, s.scope);
      await Promise.all([
        ...[...wanted.values()].map(async sc => {
          const r = sc.type === "space" ? await registry.space(sc.id) : await registry.group(sc.id);
          if (r && r.tenant === tenant) scopeNames.set(sc.type + "\n" + sc.id, r.name);
        }),
      ]);
      const teams = teamIds.length ? new Map((await registry.teamsAmong(tenant, teamIds)).map(t => [t.id, t.name])) : new Map();
      const mine = mineOf(access, { roles, scopeName: s => scopeNames.get(s.type + "\n" + s.id), teamName: id => teams.get(id) });
      const needs = needsOf(type, roles, access);
      const askRoles = unit && !personal && !manage && access.ladder != null && (type === "space" || type === "group" || type === "board") ? askRolesFor(access, type, roles) : [];
      const ask = { can: askRoles.length > 0, roles: askRoles, pending: null, retryAfterMs: null };
      let owners = [];
      if (unit && !personal) {
        const [o, req] = await Promise.all([ownersOf(unit.id, type, row, access, roles), ask.can ? registry.accessRequest({ type, id: row.id }, identity.user) : null]);
        owners = o;
        if (req?.state === "pending") ask.pending = { role: req.role, roleName: roleLabel(req.role, roles), at: req.at };
        else if (req) ask.retryAfterMs = Math.max(0, askWait(req, now()));
      }
      return { mine, needs, owners, ask, guest: !unit };
    },
  };
}
