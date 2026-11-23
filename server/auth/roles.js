// @ts-check
// Roles (PROTOCOL.md § Roles, #50). Core: depends on the Registry port and `tenancy`, imports no adapter; the HTTP routes only translate.
// Every decision is the PERMISSION `roles.manage` read from the resolver's answer at the Unit root (`tenancy.effective`), never a role name.
//
// What it owns: the Roles screen's read (built-in, member and custom roles, the permission matrix, "used in N places"), create / edit / delete of a
// custom role (and the Unit member role's management permissions), the no-escalation rule, the many-people confirmation, and the announcement a
// role edit owes the gateways (handed to the scheduler in spaces.js through `announce`; it never holds a queue of its own).

import { AdminError } from "../admin/boards.js";
import { isUnitAdmin } from "./resolver.js";
import { INVITE_ROLES, ROLES } from "./util.js";
import { isTierRole, roleDef, roleProblem, contentPerms, ALLOWED_AT, CONTENT_PERMS, MGMT_PERMS, TIER_PERMS, TIER_ROLES, ROLE_PERMS, MEMBER_ROLE_ID, DEFAULT_MEMBER_PERMS, SCOPES } from "./permissions.js";
import { ROLE_LIMITS } from "./registry-port.js";
import { LADDER_NAMES, LADDER_SUMMARY, idOf, nameOf, mgmtOf } from "./access.js";
import { BUILTIN_UNIT_NAMES } from "./explain.js";

/** What one call does at most, and when an edit is "many" (PROTOCOL.md § Roles, Bounds). */
export const LIMITS = Object.freeze({ ...ROLE_LIMITS, many: Object.freeze({ places: 10, people: 50 }) });

const refused = () => new AdminError("forbidden", "not allowed");
const missing = () => new AdminError("not-found", "not found");
const bad = m => new AdminError("bad-request", m);
const NO_ROLE = "r-none00000000";               // looked up when the id is not usable, so the Registry work is the same whatever the id
const same = (a, b) => a.length === b.length && a.every(x => b.includes(x));

/**
 * @param {{ registry: import("./registry-port.js").Registry, tenancy: ReturnType<typeof import("./tenancy.js").tenancy>,
 *   announce?: (unit: { id: string }, scope: { type: string, id: string }, o?: { revoke?: boolean }) => void }} deps
 *   announce: hands a change to the announcement scheduler (spaceService.announceChange).
 */
export function rolesService({ registry, tenancy, announce = () => {} }) {
  const unitScope = unit => ({ type: "unit", id: unit.id });

  /** The caller's Unit and their access to it (the SAME reads whatever the request), or null when there is no Unit. */
  async function standing(identity) {
    const unit = await tenancy.tenantOf(identity);
    return unit ? { unit, access: await tenancy.effective(identity, unitScope(unit)), admin: isUnitAdmin(unit, identity) } : null;
  }
  /** A write: the caller holds `roles.manage` at the Unit, else the one ordinary refusal. */
  async function gate(identity) {
    const st = await standing(identity);
    if (!st || !st.access.permissions.has("roles.manage")) throw refused();
    return st;
  }

  // ---- what a role is ----
  const storedMap = list => new Map(list.map(r => [r.id, r]));
  /** The member role as stored, or what it is until an admin edits it. */
  const memberOf = roles => roles.get(MEMBER_ROLE_ID) ?? { id: MEMBER_ROLE_ID, name: "Organization member", base: null, boardRole: null, permissions: [...DEFAULT_MEMBER_PERMS] };
  /** The permissions `role` gives AT THE UNIT (ladder content plus management), the measure of "may the caller hold this". */
  const unitPerms = (role, roles) => roleDef(role, "unit", roles)?.permissions ?? new Set();
  /** The Unit-wide admin capability: editing the Unit member role changes what EVERY member may do, so it is held to it (the one place tiered admin levels, #88, map to). */
  const unitWide = st => st.admin;
  /** No escalation: the caller holds every permission (a Unit admin is exempt from the management ones, never from the content tier: only a holder passes `content.*` on, #88). */
  const within = (st, perms) => [...perms].every(p => st.access.permissions.has(p) || (st.admin && !TIER_PERMS.includes(p)));
  const scopesOf = (id, roles) => Object.fromEntries(SCOPES.map(t => [t, [...(roleDef(id, /** @type {import("./permissions.js").ScopeType} */ (t), roles)?.permissions ?? [])]]));
  const allMgmt = id => mgmtOf({ permissions: new Set(SCOPES.flatMap(t => [...(roleDef(id, /** @type {import("./permissions.js").ScopeType} */ (t), new Map())?.permissions ?? [])])) });

  /** One role as the screen shows it. `used`: `{ places, capped }` (custom), `{ members, capped }` (member), or null (built-in). */
  function view(role, roles, used = null, st = null) {
    if (ROLES.includes(role)) return { id: role, name: LADDER_NAMES[role], kind: "builtin", editable: false, summary: LADDER_SUMMARY[role], ladder: role, permissions: allMgmt(role), scopes: scopesOf(role, roles), used: null };
    if (role === "admin") return { id: "admin", name: "Organization admin", kind: "builtin", editable: false, summary: "Manages the organization: every management permission, no board content", ladder: null, permissions: [...MGMT_PERMS], scopes: scopesOf("admin", roles), used: null };
    if (isTierRole(role)) return { id: role, name: BUILTIN_UNIT_NAMES[role], kind: "builtin", editable: false, used, summary: TIER_ROLES[role].includes("content.personal") ? "Opens every board in the organization, including other people's personal spaces" : "Opens every board in every shared Space (not personal spaces)", ladder: null, permissions: [...TIER_ROLES[role]], scopes: scopesOf(role, roles) };
    if (role === MEMBER_ROLE_ID) {
      const m = memberOf(roles);
      return { id: MEMBER_ROLE_ID, name: "Organization member", kind: "member", editable: !!st && unitWide(st), summary: "What everyone in the organization gets", ladder: null, permissions: m.permissions.filter(p => MGMT_PERMS.includes(p)), scopes: scopesOf(MEMBER_ROLE_ID, roles), used };
    }
    const c = roles.get(role);
    const mgmt = c.permissions.filter(p => MGMT_PERMS.includes(p)).length, tier = c.permissions.filter(p => TIER_PERMS.includes(p)).length;
    return { id: c.id, name: c.name, kind: "custom", editable: !!st && within(st, unitPerms(c.id, roles)), summary: `${LADDER_NAMES[c.boardRole] ?? "No"} board access${mgmt ? `, plus ${mgmt} management permission${mgmt === 1 ? "" : "s"}` : ""}${tier ? `, plus ${c.permissions.filter(p => TIER_PERMS.includes(p)).map(p => (p === "content.shared" ? "opening shared boards" : "opening personal spaces")).join(" and ")}` : ""}`, ...(c.base ? { base: c.base } : {}), ladder: c.boardRole, permissions: c.permissions.filter(p => ROLE_PERMS.includes(p)), scopes: scopesOf(c.id, roles), used };
  }
  const placesUsed = u => ({ places: Math.min(u.places, ROLE_LIMITS.usageCap), capped: u.places > ROLE_LIMITS.usageCap });
  const membersUsed = n => ({ members: Math.min(n, ROLE_LIMITS.memberCap), capped: n > ROLE_LIMITS.memberCap });

  /** The matrix: where each permission means anything (from ALLOWED_AT), and what THIS caller may tick. */
  function matrix(st) {
    const own = st.access.permissions;
    return {
      scopes: SCOPES,
      permissions: [...CONTENT_PERMS.map(id => ({ id, group: "content", scopes: SCOPES })), ...MGMT_PERMS.map(id => ({ id, group: "management", scopes: SCOPES.filter(s => ALLOWED_AT[s].includes(id)) })), ...TIER_PERMS.map(id => ({ id, group: "content-tier", scopes: ["unit"] }))],
      content: Object.fromEntries(INVITE_ROLES.map(l => [l, contentPerms(l)])),   // what each board step includes, so the screen needs no ladder rule of its own
      ladders: INVITE_ROLES.filter(l => st.admin || contentPerms(l).every(p => own.has(p))),
      tickable: ROLE_PERMS.filter(p => own.has(p) || (st.admin && !TIER_PERMS.includes(p))),
    };
  }

  /** How many places and people hold a custom role / how many people the member role reaches. Bounded: PROTOCOL.md § Roles. */
  async function impactOf(unit, id) {
    const cap = ROLE_LIMITS.usageCap;
    if (id === MEMBER_ROLE_ID) { const n = await registry.memberCount(unit.id, { cap: ROLE_LIMITS.memberCap }); return { places: 0, people: Math.min(n, ROLE_LIMITS.memberCap), capped: n > ROLE_LIMITS.memberCap }; }
    const u = (await registry.roleUsage(unit.id, [id], { cap })).get(id) ?? { places: 0, users: 0, teams: [] };
    const sizes = u.teams.length ? await registry.teamsAmong(unit.id, u.teams) : [];
    const people = Math.min(u.users, cap) + sizes.reduce((n, t) => n + t.size, 0);
    return { places: Math.min(u.places, cap), people, capped: u.places > cap || u.users > cap || u.teams.length >= ROLE_LIMITS.teamIds };
  }
  /** Many: past either limit; a capped people count that reached the limit (the member role's "50+", counted to 50) is past it. */
  const isMany = i => i.places > LIMITS.many.places || i.people > LIMITS.many.people || (i.capped && i.people >= LIMITS.many.people);

  /** A write's target: the stored custom role (or the member role) with the same Registry reads whatever the id. */
  async function target(unit, id) {
    const ok = idOf(id) ? id : NO_ROLE;
    const [row, list] = await Promise.all([registry.role(unit.id, ok === MEMBER_ROLE_ID ? NO_ROLE : ok), registry.roles(unit.id)]);
    const roles = storedMap(list);
    if (id === MEMBER_ROLE_ID) return { id, row: memberOf(roles), roles, member: true };
    return row ? { id: row.id, row, roles, member: false } : { id: null, row: null, roles, member: false };
  }

  /** The permissions a role would hold at the Unit once `candidate` replaces it. */
  const unitPermsOf = (candidate, roles) => unitPerms(candidate.id, new Map([...roles, [candidate.id, candidate]]));

  function fields(b, member) {
    const out = {};
    if (b.name !== undefined) { if (member) throw bad("the Unit member role keeps its name"); out.name = nameOf(b.name); }
    if (b.boardRole !== undefined) { if (member && b.boardRole !== null) throw bad("the Unit member role carries no board content"); out.boardRole = b.boardRole; }
    if (b.permissions !== undefined) out.permissions = b.permissions;
    return out;
  }

  /** The view a write answers with. */
  async function answer(st, t, roles, impact = null) {
    const { unit } = st;
    if (t.member) return view(MEMBER_ROLE_ID, roles, membersUsed(impact ? impact.people : await registry.memberCount(unit.id, { cap: ROLE_LIMITS.memberCap })), st);
    const used = impact ? { places: impact.places, capped: impact.capped } : placesUsed((await registry.roleUsage(unit.id, [t.id])).get(t.id));
    return view(t.id, roles, used, st);
  }

  return {
    /** GET /roles. A caller without `roles.manage` (a guest, a member) gets the one `not-found`. */
    async list(identity) {
      const st = await standing(identity);
      if (!st || !st.access.permissions.has("roles.manage")) throw missing();
      const [list, members] = await Promise.all([registry.roles(st.unit.id), registry.memberCount(st.unit.id, { cap: ROLE_LIMITS.memberCap })]);
      const roles = storedMap(list);
      const custom = list.filter(r => r.id !== MEMBER_ROLE_ID).sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.id < b.id ? -1 : 1));
      const usage = custom.length ? await registry.roleUsage(st.unit.id, custom.map(r => r.id), { cap: ROLE_LIMITS.usageCap }) : new Map();
      // Who holds the content tier is visible, read-only, to every Unit admin: the built-in tier roles carry a "used in N places" count like a custom role (#88; the people are on the Unit access page).
      const tierUsage = await registry.roleUsage(st.unit.id, Object.keys(TIER_ROLES), { cap: ROLE_LIMITS.usageCap });
      return {
        roles: [...ROLES.map(r => view(r, roles)), view("admin", roles), ...Object.keys(TIER_ROLES).map(r => view(r, roles, placesUsed(tierUsage.get(r) ?? { places: 0 }))), view(MEMBER_ROLE_ID, roles, membersUsed(members), st), ...custom.map(r => view(r.id, roles, placesUsed(usage.get(r.id) ?? { places: 0 }), st))],
        matrix: matrix(st), can: { admin: st.admin }, limits: { custom: LIMITS.custom, many: LIMITS.many },
      };
    },

    /** The one role as a replay or a write answers it (re-authorized: `roles.manage` now). `not-found` when it is gone. */
    async read(identity, id) {
      const st = await gate(identity), t = await target(st.unit, id);
      if (!t.row || t.member) throw missing();
      if (!within(st, unitPerms(t.id, t.roles))) throw refused();            // a replay holds the create's own limit: no escalation, as now
      const u = (await registry.roleUsage(st.unit.id, [t.id])).get(t.id);
      return view(t.id, t.roles, placesUsed(u), st);
    },

    /** POST /roles: a new custom role. `base` = the id it was duplicated from (display only). @returns {Promise<object>} the RoleView */
    async create(identity, b, idem) {
      const st = await gate(identity);
      const name = nameOf(b.name);
      const cand = { id: "new", name, boardRole: b.boardRole ?? null, permissions: b.permissions ?? [] };
      const why = roleProblem(cand);
      if (why) throw bad(why);
      const roles = storedMap(await registry.roles(st.unit.id));
      let base = null;
      if (b.base != null) {
        if (isTierRole(b.base) && !within(st, TIER_ROLES[b.base])) throw refused();      // a copy of a tier role is held to the tier too: no label of a role the caller could not hold
        if (typeof b.base !== "string" || !(ROLES.includes(b.base) || b.base === "admin" || isTierRole(b.base) || b.base === MEMBER_ROLE_ID || (roles.has(b.base) && b.base !== MEMBER_ROLE_ID))) throw bad("bad base");
        base = b.base;
      }
      if (!within(st, unitPermsOf(cand, roles))) throw refused();
      let made;
      try { made = await registry.createRole({ tenant: st.unit.id, name, base, boardRole: cand.boardRole, permissions: cand.permissions, max: LIMITS.custom, idem }); }
      catch (err) { if (err?.code === "limit") throw new AdminError("too-large", "the Unit has the most custom roles it can"); throw err; }
      return view(made.id, storedMap([...roles.values(), made]), placesUsed({ places: 0 }), st);
    },

    /**
     * PATCH /roles/:id: a custom role's name, board step and permissions, or the member role's permissions. Checked in this order: `roles.manage`,
     * the role exists in this Unit and may be edited, the body, no escalation (the role now AND as it would become), then the many-people
     * confirmation, then the write, then the announcement.
     */
    async update(identity, id, b) {
      const st = await gate(identity), { unit } = st;
      const t = await target(unit, id);
      if (!t.row || (t.member && !unitWide(st))) throw refused();            // unknown, another Unit's, a built-in, or the member role without the Unit-wide capability: one answer
      const patch = fields(b, t.member);
      const cand = { ...t.row, ...patch };
      const why = roleProblem(cand, { member: t.member });
      if (why) throw bad(why);
      const before = unitPerms(t.id, t.roles), after = unitPermsOf(cand, t.roles);
      if (!within(st, before) || !within(st, after)) throw refused();
      const material = (patch.permissions !== undefined && !same(patch.permissions, t.row.permissions)) || (patch.boardRole !== undefined && patch.boardRole !== t.row.boardRole);
      const rename = patch.name !== undefined && patch.name !== t.row.name;
      let impact = null;
      if (material) {
        impact = await impactOf(unit, t.id);
        if (isMany(impact) && b.confirm !== true) throw new AdminError("confirm-required", "this change reaches many people", { data: { impact } });
      }
      if (!material && !rename) return answer(st, t, t.roles);
      let out;
      try { out = await registry.updateRole(unit.id, t.id, patch); }
      catch (err) {
        if (!t.member && !(await registry.role(unit.id, t.id))) throw refused();    // deleted between the check and the write: the ordinary refusal
        throw err;
      }
      if (material && (t.member || impact.places > 0)) announce(unit, unitScope(unit), { revoke: ![...before].every(p => after.has(p)) });   // anything but a pure widening
      return answer(st, { ...t, row: out }, new Map([...t.roles, [out.id, out]]), impact);
    },

    /** DELETE /roles/:id: a custom role nobody holds. 409 `in-use` (with a count) while any grant holds it. */
    async remove(identity, id) {
      const st = await gate(identity), { unit } = st;
      const t = await target(unit, id);
      if (t.member) throw bad("the Unit member role cannot be deleted");
      if (!t.row) throw refused();
      if (!within(st, unitPerms(t.id, t.roles))) throw refused();
      try { await registry.deleteRole(unit.id, t.id); }
      catch (err) {
        if (err?.code === "in-use") {
          const u = (await registry.roleUsage(unit.id, [t.id])).get(t.id);
          throw new AdminError("in-use", "the role is in use", { data: { places: Math.min(u.places, ROLE_LIMITS.usageCap), capped: u.places > ROLE_LIMITS.usageCap } });
        }
        if (!(await registry.role(unit.id, t.id))) throw refused();         // gone already (a racing delete)
        throw err;
      }
    },
  };
}
