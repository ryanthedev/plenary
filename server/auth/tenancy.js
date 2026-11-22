// Role resolution: who may do what on a board. Read live from the Registry on every call, so an expired or
// revoked invite or link stops working on the next role() (i.e. the next hello). `tenancy` never caches; the
// optional cache over it, `roleCache`, is at the end of this file (p5-load).
//
// The rule itself is server/auth/resolver.js (sources, order, union; PROTOCOL.md § Tenancy "Resolution"). In short, a
// user's access to a board is the UNION of: their own grant on it; Team grants on it; grants on its Space and that
// Space's Group (their own, and their Teams'); "everyone in the Unit" on the board (`memberRole`), its Space and
// Group, for members of the Unit's Workspace domains; a live invite to the user's verified email; a live share link
// they redeemed; and their Unit role (admin, member, or one granted on the Unit). The live room needs one ladder
// role (viewer..owner): `role` is the highest ladder role any source gives; every management permission lives in
// `access(...).permissions` and the admin layer checks those, never role names. There is no deny.
// Nothing else counts: a user from another domain, or another tenant, gets access only by grant, invite or link
// on that very board. An unknown board and a board with no role both give null (no existence leak).
//
// One rule, two ways to fetch (p5-load): `role` reads one user's rows (a hello); `rolesFor` reads a board's rows
// once for many users (the gateway's timed re-check), so a pass costs O(1) Registry queries per board plus
// ceil(users / USE_CHUNK) link-use queries (or one per user where the Registry has no `linkUsesFor`). Both feed
// the same pure `combine`, so they can't disagree (test/auth/role-cache.test.js checks it on random registries).

import { higher, capTo, normEmail, verifiedEmail, isTenantAdminRecord, INVITE_ROLES } from "./util.js";
import { resolveAccess, teamIndex, movedContext, mayMove } from "./resolver.js";
import { HOME } from "./registry-port.js";

/** @typedef {import("./registry-port.js").Registry} Registry */
/** @typedef {import("./registry-port.js").Role} Role */
/** @typedef {import("./registry-port.js").Board} Board */
/** @typedef {import("./registry-port.js").Tenant} Tenant */
/** @typedef {import("./registry-port.js").Invite} Invite */
/** @typedef {import("./registry-port.js").Link} Link */
/** @typedef {import("./idp-port.js").Identity} Identity */
/** @typedef {{ role: Role|null, share: boolean, move: boolean, until: number }} Resolved  `move`: the `move` permission (a Unit member's only, resolver.js; the welcome's `can.move`); `share`: does the identity hold `members.manage` on the board (the Share button, PROTOCOL.md § Share dialog); `until`: the soonest `expiresAt` among the live invites and links consulted (Infinity if none); the answer may change then without any message */

/** Users per `linkUsesFor` call (SQL bind limits; a 100k pass is 100 queries, not one 100k-parameter one). */
export const USE_CHUNK = 1000;

/**
 * The key `rolesFor` answers by: what a role reads (user; email, for invites; domain, for membership). The gateway's
 * re-check pass groups connections by exactly this key and looks its answers up with it.
 * @param {{ user: string, email?: string|null, domain?: string|null }} id
 */
export const identityKey = id => `${id.user}\n${id.email ?? ""}\n${id.domain ?? ""}${id.emailVerified === false ? "\n0" : ""}`;

const live = (x, t) => x && !x.revoked && (x.expiresAt == null || t < x.expiresAt);
const nothing = () => ({ ladder: null, permissions: new Set(), sources: [], until: Infinity });
const NO_TEAMS = new Set();
const okIdentity = id => !!id && typeof id.user === "string";

/**
 * Applies personal-org email membership (`reg_tenant_members`) and personal-org admin `memberRole` on top of
 * `resolveAccess` without touching Workspace domain membership, RBAC, or personal-space privacy rules.
 */
function applyPersonalOrgMember(a, ctx, members, identity) {
  const board = ctx?.board, tenant = ctx?.tenant;
  if (!board || board.trashedAt != null || ctx.space?.trashedAt != null || !board.memberRole || !tenant) return a;
  if (ctx.space?.kind === "personal" && ctx.space.owner !== identity.user) return a;
  if (ctx.removed?.includes(identity.user)) return a;
  if (tenant.domain !== null && (!members || (members instanceof Set ? !members.size : !members.length))) return a;
  const vEmail = verifiedEmail(identity);
  const isEmailMember = Boolean(vEmail && members && (members instanceof Set ? members.has(vEmail) : members.includes(vEmail)));
  const isPersonalAdmin = tenant.domain === null && isTenantAdminRecord(tenant, identity);
  if (!isEmailMember && !isPersonalAdmin) return a;
  const granted = capTo(board.memberRole, INVITE_ROLES);
  const bumped = higher(a.ladder, granted);
  if (bumped === a.ladder && a.permissions.has("board.view") && (bumped !== "editor" || a.permissions.has("board.edit"))) return a;
  const permissions = new Set(a.permissions);
  permissions.add("board.view");
  if (bumped === "editor") permissions.add("board.edit");
  return { ...a, ladder: bumped, permissions };
}

/**
 * The room-role rule, pure: `resolveAccess` (server/auth/resolver.js), reduced to the ladder role and `until`.
 * `invites`: this board's invites to the identity's email; `links`: the link records of the identity's uses (any
 * board; only this board's count); `members`: optional org member emails (Set or string[]) for email-based org
 * membership (`reg_tenant_members`). Every stored role is capped there: unknown roles count for nothing; invites and
 * general access stay below owner; links stay within LINK_ROLES.
 * @param {{ ctx: import("./registry-port.js").AccessContext, grant: Role|null, invites: Invite[], links: (Link|null)[], members?: Set<string>|string[]|null }} rows
 * @param {Identity} identity @param {number} t
 * @returns {Resolved}
 */
export function combine(rows, identity, t) {
  const a = applyPersonalOrgMember(resolveAccess(rows, identity, t), rows.ctx, rows.members ?? null, identity);
  return { role: a.ladder ?? null, share: a.permissions.has("members.manage"), move: mayMove(a), until: a.until };
}

/**
 * @param {{ registry: Registry, now?: () => number, recordUntil?: (record: object) => number }} deps
 *   recordUntil: for a cache over this tenancy (roleCache): until when a link record `resolve` read may be relied on
 *   (its memo's end). `resolve`'s `until` is capped by it, so an answer never outlives the records it was built from.
 */
export function tenancy({ registry, now = Date.now, recordUntil = () => Infinity }) {
  /** One user's access to a board: ladder role, permissions, sources. @returns {Promise<import("./resolver.js").Access>} */
  async function accessOn(identity, boardId, { uniform = false } = {}) {
    if (!okIdentity(identity) || typeof boardId !== "string") return nothing();
    const ctx = await registry.accessContext({ type: "board", id: boardId }, { users: [identity.user] });
    if (!ctx?.board) {
      // `uniform`: an admin route that must not tell an unknown board from a hidden one by how much it reads does the same reads and drops them.
      if (uniform) { await registry.grant(boardId, identity.user); if (identity.email) await registry.invitesFor(boardId, identity.email); await registry.linkUses(boardId, identity.user); }
      return nothing();
    }
    const t = now();
    const grant = await registry.grant(ctx.board.id, identity.user);
    const invites = identity.email && identity.emailVerified !== false ? await registry.invitesFor(ctx.board.id, identity.email) : [];
    const links = [];
    for (const id of await registry.linkUses(ctx.board.id, identity.user)) links.push(await registry.link(id));
    let members = null;
    if (ctx.board.memberRole && ctx.tenant?.domain === null && !ctx.removed?.includes(identity.user)) {
      const vEmail = verifiedEmail(identity);
      if (vEmail && !isTenantAdminRecord(ctx.tenant, identity)) {
        if (typeof registry.isTenantMember === "function") {
          if (await registry.isTenantMember(ctx.board.tenant, vEmail)) members = [vEmail];
        } else if (typeof registry.tenantMembers === "function") {
          members = await registry.tenantMembers(ctx.board.tenant);
        }
      }
    }
    const a = applyPersonalOrgMember(resolveAccess({ ctx, grant, invites, links }, identity, t), ctx, members, identity);
    // Links can change (revokeLink): cap by every link record read.
    for (const l of links) if (l) a.until = Math.min(a.until, recordUntil(l));
    return a;
  }
  /** One user's role with the time it may change by itself. @returns {Promise<Resolved>} */
  async function resolve(identity, boardId) {
    const a = await accessOn(identity, boardId);
    return { role: a.ladder, share: a.permissions.has("members.manage"), move: mayMove(a), until: a.until };
  }

  /**
   * Many identities' roles on one board, from the board's rows read once. Keyed by `identityKey` (user, email,
   * domain: what a role reads), so two identities of one user (tabs signed in with different emails or domains) get
   * their own answers (p5-loadv finding 2). `ctx`: the board's context when the caller already read it; `target` (a move's dry run): the destination Space's context, and
   * each entry then also carries the full `before` and `after` Access of the same rows with the board in that Space. @returns {Promise<Map<string, Resolved & { identity: Identity }>>}
   * one entry per distinct requested identity key
   */
  async function resolveMany(boardId, identities, { ctx: given = null, target = null } = {}) {
    const ids = new Map();
    for (const id of identities ?? []) if (okIdentity(id)) { const k = identityKey(id); if (!ids.has(k)) ids.set(k, id); }
    const out = new Map();
    const none = () => { for (const [k, id] of ids) out.set(k, { role: null, share: false, move: false, until: Infinity, identity: id }); return out; };
    if (typeof boardId !== "string" || !ids.size) return none();
    const users = [...new Set([...ids.values()].map(id => id.user))];
    const ctx = given ?? await registry.accessContext({ type: "board", id: boardId }, { users, fresh: true });   // a pass reads everything fresh
    if (!ctx?.board) return none();
    const shaped = target ? movedContext(ctx, target) : null;   // a move's dry run: the same rows under the destination's Space (`target`: the destination Space's context, PROTOCOL.md § Move board)
    const teamsOf = teamIndex(ctx), teamsAfter = shaped ? teamIndex(shaped) : null;   // user → Teams, once per pass (never a scan per identity)
    const board = ctx.board;
    const t = now();
    const all = [...ids.values()];
    const grants = new Map((await registry.grants(board.id)).map(g => [g.user, g.role]));
    /** @type {Map<string, Invite[]>} normalized email → invites */
    const invitesBy = new Map();
    if (all.some(id => id.email && id.emailVerified !== false)) for (const i of await registry.invites(board.id)) {
      const e = normEmail(i.email);
      if (!invitesBy.has(e)) invitesBy.set(e, []);
      invitesBy.get(e).push(i);
    }
    /** @type {Map<string, string[]>} user → link ids used on this board */
    let uses = new Map();
    // link uses are per user, whatever the email or domain: `users` (above) is the distinct set
    if (typeof registry.linkUsesFor === "function") {
      for (let i = 0; i < users.length; i += USE_CHUNK) {
        const chunk = users.slice(i, i + USE_CHUNK), want = new Set(chunk);
        for (const [u, ls] of await registry.linkUsesFor(board.id, chunk)) if (want.has(u)) uses.set(u, ls);
      }
    } else for (const u of users) uses.set(u, await registry.linkUses(board.id, u));
    let linkById = new Map();
    for (const ls of uses.values()) if (ls.length) { linkById = new Map((await registry.links(board.id)).map(l => [l.id, l])); break; }
    let members = null;
    if (board.memberRole && ctx.tenant?.domain === null && typeof registry.tenantMembers === "function") {
      const needsMembers = all.some(id => {
        const vEmail = verifiedEmail(id);
        if (!vEmail) return false;
        if (isTenantAdminRecord(ctx.tenant, id)) return false;
        return true;
      });
      if (needsMembers) members = new Set(await registry.tenantMembers(board.tenant));
    }
    for (const [k, id] of ids) {
      const invites = id.email && id.emailVerified !== false ? invitesBy.get(normEmail(id.email)) ?? [] : [];
      const links = (uses.get(id.user) ?? []).map(l => linkById.get(l) ?? null);
      const rows = { ctx, grant: grants.get(id.user) ?? null, invites, links, teams: teamsOf.get(id.user) ?? NO_TEAMS, members };
      out.set(k, { ...combine(rows, id, t), identity: id,
        ...(shaped ? {
          before: applyPersonalOrgMember(resolveAccess(rows, id, t), ctx, members, id),
          after: applyPersonalOrgMember(resolveAccess({ ...rows, ctx: shaped, teams: teamsAfter.get(id.user) ?? NO_TEAMS }, id, t), shaped, members, id),
        } : {}) });
    }
    return out;
  }

  /**
   * Every tenant this identity belongs to: Workspace domain tenant, personal tenants where the identity is an admin,
   * and any tenant where the identity's verified email is in `reg_tenant_members`. Deduplicated by tenant id, excluding
   * any tenant where the identity was offboarded (`memberState.removed`).
   * @returns {Promise<Tenant[]>}
   */
  async function tenantsFor(identity) {
    if (!okIdentity(identity)) return [];
    const seen = new Map();
    const add = t => { if (t && !seen.has(t.id)) seen.set(t.id, t); };
    if (identity.domain) add(await registry.tenantByDomain(identity.domain));
    const vEmail = verifiedEmail(identity);
    if (typeof registry.tenantsForAdmin === "function") {
      for (const t of await registry.tenantsForAdmin(identity.user, vEmail)) {
        if (isTenantAdminRecord(t, identity)) add(t);
      }
    } else if (typeof registry.listPersonalTenants === "function") {
      for (const t of await registry.listPersonalTenants()) {
        if (isTenantAdminRecord(t, identity)) add(t);
      }
    }
    if (vEmail && typeof registry.tenantsForMember === "function") {
      for (const t of await registry.tenantsForMember(vEmail)) add(t);
    }
    const out = [];
    for (const t of seen.values()) {
      if (!(await registry.memberState?.(t.id, identity.user))?.removed) out.push(t);
    }
    return out;
  }

  return {
    /** @returns {Promise<Role|null>} */
    async role(identity, boardId) { return (await resolve(identity, boardId)).role; },
    /** A hello's whole answer from the one read: `{ role, share, move }` (`share` = `members.manage` on the board, `move` = the `move` permission, from the same Access as the role). */
    async access(identity, boardId) { const r = await resolve(identity, boardId); return { role: r.role, share: r.share, move: r.move }; },
    resolve,
    resolveMany,
    /**
     * The effective access of `identity` on a scope: `{ ladder, permissions, sources, until }` (resolver.js). `scope` is a
     * board id, or `{ type: "board"|"space"|"group"|"unit", id }`. What the admin layer asks ("may this user board.create
     * in this Space?") and what the UI asks ("why can't I edit?"): permissions, never role names.
     */
    async effective(identity, scope, o = {}) {
      if (typeof scope === "string") return accessOn(identity, scope, o);
      if (!okIdentity(identity) || !scope || typeof scope.id !== "string") return nothing();
      if (scope.type === "board") return accessOn(identity, scope.id, o);
      const ctx = await registry.accessContext(scope, { users: [identity.user] });
      return ctx ? resolveAccess({ ctx }, identity, now()) : nothing();
    },
    /**
     * The effective access of MANY identities at one scope: one `accessContext` for a Unit, Group or Space (at most 50 identities), one `accessOn` each for a board. A Map user → Access.
     * The same pure `resolveAccess` as `effective`.
     * @param {{ type: "unit"|"group"|"space"|"board", id: string }} scope @param {Identity[]} identities
     */
    async effectiveAmong(scope, identities) {
      const out = new Map(), ids = (identities ?? []).filter(okIdentity).slice(0, 50);
      if (!ids.length || !scope || typeof scope.id !== "string") return out;
      if (scope.type === "board") { for (const id of ids) out.set(id.user, await accessOn(id, scope.id)); return out; }
      const ctx = await registry.accessContext(scope, { users: ids.map(i => i.user) });
      const t = now(), teams = ctx ? teamIndex(ctx) : null;
      for (const id of ids) out.set(id.user, ctx ? resolveAccess({ ctx, teams: teams.get(id.user) ?? NO_TEAMS }, id, t) : nothing());
      return out;
    },
    /**
     * `effective` for many Unit, Group or Space scopes from ONE batch read (`registry.accessContexts`), at most HOME.batch.
     * @param {{ type: "unit"|"group"|"space", id: string }[]} scopes @returns {Promise<Map<string, import("./resolver.js").Access>>} keyed `type + "\n" + id`; an unknown scope answers `nothing`
     */
    async effectiveMany(identity, scopes) {
      const out = new Map();
      if (!okIdentity(identity) || !Array.isArray(scopes) || !scopes.length) return out;
      const got = await registry.accessContexts(scopes, { users: [identity.user] });
      const t = now();
      for (const [k, ctx] of got) out.set(k, ctx ? resolveAccess({ ctx }, identity, t) : nothing());
      return out;
    },
    /**
     * One user's access to many boards (PROTOCOL.md § Home, "Boards I can open"): `registry.boardRows` reads every board-scope
     * row for the whole batch (a fixed number of statements), plus ONE `accessContext` per distinct Space among them (every board has one), then the same pure `resolveAccess` as `effective`, so it can't
     * disagree with it. From the context it already holds, each distinct Space's and Group's OWN access is resolved too (no further reads), so a caller can tell a board it
     * may open apart from the Space and Group above it that it may not (their names must not leak). At most HOME.batch ids; unknown
     * boards are absent. `spaceOpen` / `groupOpen`: may the identity open boards in that Space / Group (false when there is none).
     * @returns {Promise<Map<string, { access: import("./resolver.js").Access, grant: Role|null, board: Board, space: object|null, group: object|null, spaceOpen: boolean, groupOpen: boolean }>>}
     */
    async accessMany(identity, boardIds) {
      const out = new Map();
      if (!okIdentity(identity) || !Array.isArray(boardIds) || !boardIds.length) return out;
      const rows = await registry.boardRows(boardIds.slice(0, HOME.batch), { user: identity.user, email: identity.email ?? null });
      const scopeOf = b => ({ type: "space", id: b.space });
      const keyOf = sc => sc.type + "\n" + sc.id;
      const scopes = new Map();
      for (const r of rows.values()) scopes.set(keyOf(scopeOf(r.board)), scopeOf(r.board));
      // ONE batch read for every distinct Space among the boards (TECH-DEBT row 35: it was one read per Space).
      const got = await registry.accessContexts([...scopes.values()], { users: [identity.user] });
      const ctxs = got;
      const t = now();
      const own = new Map();   // "space:<id>" / "group:<id>" → may the identity open boards there (from the context already read)
      const opens = (k, ctx) => { if (!own.has(k)) { const a = resolveAccess({ ctx }, identity, t); own.set(k, (a.ladder ?? a.trashed?.ladder ?? null) != null); } return own.get(k); };   // a Space or Group in Trash: could they open it before (the Trash list names where a board was)
      const personalMembers = new Map();
      const vEmail = verifiedEmail(identity);
      for (const [id, r] of rows) {
        const base = ctxs.get(keyOf(scopeOf(r.board)));
        if (!base) continue;
        const teams = { ...base.teams };
        for (const g of r.teamGrants) if (g.subject.type === "team" && !(g.subject.id in teams)) teams[g.subject.id] = r.myTeams.includes(g.subject.id) ? [identity.user] : [];
        const ctx = { ...base, board: r.board, scoped: { ...base.scoped, board: r.teamGrants }, teams };
        let members = null;
        if (r.board.memberRole && base.tenant?.domain === null && !base.removed?.includes(identity.user) && vEmail && !isTenantAdminRecord(base.tenant, identity)) {
          if (!personalMembers.has(r.board.tenant)) {
            let m = null;
            if (typeof registry.isTenantMember === "function") {
              if (await registry.isTenantMember(r.board.tenant, vEmail)) m = [vEmail];
            } else if (typeof registry.tenantMembers === "function") {
              m = await registry.tenantMembers(r.board.tenant);
            }
            personalMembers.set(r.board.tenant, m);
          }
          members = personalMembers.get(r.board.tenant);
        }
        const access = applyPersonalOrgMember(resolveAccess({ ctx, grant: r.grant, invites: r.invites, links: r.links }, identity, t), ctx, members, identity);
        const spaceOpen = !!base.space && opens("space\n" + base.space.id, { ...base, board: null });
        const groupOpen = !!base.group && opens("group\n" + base.group.id, { ...base, board: null, space: null });
        out.set(id, { access, grant: r.grant, board: r.board, space: base.space, group: base.group, spaceOpen, groupOpen });
      }
      return out;
    },
    /** @returns {Promise<Map<string, Role|null>>} identityKey(identity) → role, one entry per distinct requested identity */
    async rolesFor(boardId, identities) {
      const m = await resolveMany(boardId, identities);
      return new Map([...m].map(([k, r]) => [k, r.role]));
    },

    /**
     * A signed-in user opened a share link. Records the use and returns `{ board }`, or null for an unknown,
     * expired or revoked link (all the same answer). The role itself is re-read from the link on every role().
     */
    async redeemLink(identity, linkId) {
      if (!identity || typeof identity.user !== "string" || typeof linkId !== "string") return null;
      const l = await registry.link(linkId);
      if (!live(l, now())) return null;
      // A board in Trash cannot be joined (PROTOCOL.md § Trash and restore): the Registry refuses the use in the same atomic step (code "in-trash"), answered like an unknown link, nothing recorded.
      try { await registry.addLinkUse(l.id, identity.user); } catch (e) { if (e?.code === "in-trash") return null; throw e; }
      return { board: l.board };
    },

    tenantsFor,

    /** The primary tenant an identity belongs to (Workspace domain, personal org admin, or personal org member); else null. */
    async tenantOf(identity) {
      if (!okIdentity(identity)) return null;
      if (identity.domain) {
        const t = await registry.tenantByDomain(identity.domain);
        // A person the Unit removed has no Unit (PROTOCOL.md § Leaver offboarding): a guest to every route. One primary-key read per request.
        return t && (await registry.memberState?.(t.id, identity.user))?.removed ? null : t;
      }
      const list = await tenantsFor(identity);
      for (const t of list) {
        if (!(await registry.memberState?.(t.id, identity.user))?.removed) return t;
      }
      return null;
    },
  };
}

const tenancyOver = (registry, now, recordUntil) => tenancy({ registry, now, recordUntil });

// ---- roleCache: a role cache over `tenancy` (p5-load; p-audit F8). Depends only on the Registry port. ----
//
// What it caches, per process (one gateway node):
//   - roles per (board, identityKey): user, email and domain, the key the gateway's re-check groups by (a role
//     depends on all three). Only a role (never null: a refusal is always read fresh). An entry lives until the
//     soonest of: `ttlMs` after the read began; the soonest `expiresAt` of any live invite or link it depended on
//     (time-based loss sends no message); and the end of the memo of every link record it was built from (p5-load2v
//     MEDIUM 0: a joiner of an in-flight link read counts from that read's start), so with linkTtlMs ≤ ttlMs no
//     entry rests on link data more than ttlMs old. Bounded by `maxEntries` (oldest dropped first).
//   - board records for 10 min (board.memberRole, moveBoard, and deleteBoard announce `{ board }` on `grants` and
//     `invalidate(board)` drops the board record, chain, roles, and links), the board's chain (Space, Group, tenant)
//     for ttlMs (below), and link records by id for 30 s (a link changes only by revokeLink, which announces on
//     `grants`). `live()` is evaluated on every use, so a memoized link still expires on time. Lookups of the same
//     record share one read, unless an invalidation came between.
//
// Consistency (the one rule that matters: a revoke is never hidden longer than without the cache):
//   - `invalidate(board)` (a `grants` message `{ board }`, and the gateway releasing its watch of a board) drops
//     the board's roles, board/tenant records, and link records; `invalidate(board, user)` drops every identity of one
//     user. The gateway calls it synchronously in its `grants` subscriber, BEFORE bumping its hello generation and before
//     its re-check pass.
//   - A read in flight across an invalidation never fills the cache (stamps per board and per (board, user), so a
//     stream of per-user invalidations doesn't starve the rest of the board).
//   - The timed re-check calls `invalidate(board)`, then `rolesFor` (always fresh, written through) per chunk of its
//     users: the board ends the pass holding only what the pass read. So a lost `grants` message (the bus is
//     at-most-once) is caught by the next timed pass exactly as without the cache, and no stale entry outlives it.
// Errors are never cached: a Registry failure propagates (the gateway answers `unavailable`).

/**
 * @param {{ registry: Registry, now?: () => number, ttlMs?: number, recordTtlMs?: number, linkTtlMs?: number, maxEntries?: number, maxRecords?: number }} o
 *   ttlMs: a role entry's longest life, counted from when the oldest changeable data it rests on was read (default
 *     30 s; keep it ≤ the gateway's 60 s re-check, see the report). An entry built from a memoized link record ends no
 *     later than that record's memo (p5-load2v MEDIUM 0), so with linkTtlMs ≤ ttlMs a role is never served from data
 *     more than ttlMs old;
 *   recordTtlMs: board records (default 10 min, above the 60 s pass, so a pass reads them from memory). `moveBoard`
 *     (#53), `updateBoard` changing `memberRole`, and `deleteBoard` announce `{ board }` and `invalidate(board)` drops
 *     the board record with the roles, links and the chain. Trash (#54) changes `trashedAt`/`trashedWith`: this
 *     10-minute record never supplies them (the resolver reads the board row from the CHAIN below), and
 *     `trashBoard`/`restoreBoard` announce `{ board }` (main.js), which drops the chain;
 *   the CHAIN of a board (its board row, Space, Group and tenant records, `registry.accessContext`'s `chain`; the board row and Space carry `trashedAt`): kept for `ttlMs` per
 *     board, so a hello after the first reads only the volatile parts (grants, roles, Team members) in the one
 *     statement. `invalidate(board)` drops it, and a read in flight across an invalidation never fills it. What it holds
 *     can change (a Space moved, a general access edited, a domain or admin added): such a write must announce every
 *     board it reaches (PROTOCOL.md § Organization, "Freshness"), and the timed pass reads the chain fresh (`fresh`)
 *     anyway, so it is never older than ttlMs (30 s): if a Trash or Restore announcement is lost, a hello can see the old state for up to that long, and the next timed pass closes or admits it. A tenant's `admins` and `domains` only ever grow, so a stale chain can only
 *     delay a gain, never hide a revoke;
 *   A role gaining or losing a content-tier permission (#88) changes what every Unit-scope holder resolves on every board: the role edit announces the Unit (roles.js) and the announcement drops these entries like any grant change;
 *   linkTtlMs: link records (default 30 s; a link changes by revokeLink, which announces `{ board }` and drops them).
 */
const STAMP_MAX = 10_000;

export function roleCache({ registry, now = Date.now, ttlMs = 30_000, recordTtlMs = 600_000, linkTtlMs = 30_000, maxEntries = 200_000, maxRecords = 100_000 }) {
  if (!registry) throw new Error("roleCache: registry is required");
  const stats = { hits: 0, misses: 0, fills: 0, discarded: 0, recordHits: 0, recordMisses: 0 };

  // ---- invalidation stamps: a read that began at clock c0 may fill only if nothing it covers was stamped after c0 ----
  let clock = 0, reading = 0;
  /** @type {Map<string, number>} */ const boardStamp = new Map();
  /** @type {Map<string, number>} */ const userStamp = new Map();
  const ukey = (board, user) => board + "\n" + user;
  /** @type {Map<string, number>} user -> stamp of the last `forgetUser` (a person removed from a Unit: every board at once) */ const personStamp = new Map();
  const stale = (board, user, c0) => (boardStamp.get(board) ?? 0) > c0 || (userStamp.get(ukey(board, user)) ?? 0) > c0 || (personStamp.get(user) ?? 0) > c0;
  const endRead = () => { if (--reading === 0) { boardStamp.clear(); userStamp.clear(); personStamp.clear(); } };   // no read in flight: stamps can't matter

  // ---- records: board, link (by id) ----
  /** @type {Map<string, { value: any, until: number, board: string|null }>} */ const records = new Map();
  /** @type {Map<string, { p: Promise<any>, c0: number }>} in-flight record reads, with the clock they began at */ const recordReads = new Map();
  /** @type {Map<string, Set<string>>} board → its memoized link keys */ const linksOf = new Map();
  const dropLinks = board => { for (const k of linksOf.get(board) ?? []) records.delete(k); linksOf.delete(board); };
  function memo(kind, fetch) {
    return async id => {
      const k = kind + ":" + id, t = now(), hit = records.get(k);
      if (hit && hit.until > t) { stats.recordHits++; return mark(kind, structuredClone(hit.value), hit.until); }
      stats.recordMisses++;
      // Join a read in flight only if nothing was invalidated since it began: a reader that starts after an
      // invalidation must not be handed a record read before it (it would pass its own stamp check with old data).
      const flight = recordReads.get(k);
      let p = flight && flight.c0 === clock ? flight.p : null, from = p ? flight.t : t;
      if (!p) {
        const c0 = clock;
        reading++;
        p = fetch(id).then(v => {
          const board = kind === "link" ? v?.board ?? null : kind === "board" ? id : null;
          // null is not memoized (a board/link created later must be found); a record whose board was invalidated meanwhile neither
          if (v && !(board && (boardStamp.get(board) ?? 0) > c0)) {
            if (records.size >= maxRecords) { const [ok, ov] = records.entries().next().value; records.delete(ok); if (ov.board) linksOf.get(ov.board)?.delete(ok); }
            const linkBoard = kind === "link" ? board : null;
            records.set(k, { value: v, until: t + ttlOf(kind), board: linkBoard });
            if (linkBoard) { if (!linksOf.has(linkBoard)) linksOf.set(linkBoard, new Set()); linksOf.get(linkBoard).add(k); }
          }
          return v;
        }).finally(() => { if (recordReads.get(k)?.p === p) recordReads.delete(k); endRead(); });
        recordReads.set(k, { p, c0, t });
      }
      const v = await p;
      return v ? mark(kind, structuredClone(v), from + ttlOf(kind)) : v;
    };
  }
  const ttlOf = kind => (kind === "link" ? linkTtlMs : recordTtlMs);
  /** @type {WeakMap<object, number>} a link record handed to tenancy → the end of the memo it came from */
  const linkUntil = new WeakMap();
  const mark = (kind, v, until) => { if (kind === "link") linkUntil.set(v, until); return v; };
  const board = memo("board", id => registry.board(id));
  // ---- chains: a board's Space, Group and tenant records, handed back to the Registry so a hello reads only the volatile rows ----
  /** @type {Map<string, { chain: import("./registry-port.js").Chain, until: number }>} oldest first */ const chains = new Map();
  async function accessContext(scope, o = {}) {
    if (scope?.type !== "board" || typeof scope.id !== "string") return registry.accessContext(scope, o);
    const k = scope.id, t = now(), hit = chains.get(k), c0 = clock;
    const held = !o.fresh && hit && hit.until > t ? hit.chain : undefined;
    reading++;
    try {
      const ctx = await registry.accessContext(scope, { users: o.users, ...(held ? { chain: held } : {}) });
      if (ctx?.board && !held && (boardStamp.get(k) ?? 0) <= c0) {
        chains.delete(k);
        if (chains.size >= maxRecords) chains.delete(chains.keys().next().value);
        chains.set(k, { chain: { tenant: ctx.tenant, board: ctx.board, space: ctx.space, group: ctx.group }, until: t + ttlMs });
      }
      return ctx;
    } finally { endRead(); }
  }
  const view = { ...registry, board, link: memo("link", id => registry.link(id)), accessContext };
  const tenancy = tenancyOver(view, now, l => linkUntil.get(l) ?? Infinity);

  // ---- roles ----
  // Entries are keyed by board + identityKey (user, email, domain), as the gateway groups connections, so two
  // identities of one user each have their own entry. Indexed by board and by (board, user) for invalidation.
  // Stamps stay per (board, user): coarser than per identity, so never staler.
  /** @type {Map<string, { board: string, user: string, role: Role, share: boolean, move: boolean, until: number }>} insertion order = age */
  const entries = new Map();
  /** @type {Map<string, Set<string>>} board → its entry keys */ const byBoard = new Map();
  /** @type {Map<string, Set<string>>} board + user → its entry keys (one per identity) */ const byUser = new Map();
  const ekey = (b, identity) => b + "\n" + identityKey(identity);
  const index = (m, k, v) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(v); };
  const unindex = (m, k, v) => { const s = m.get(k); if (s) { s.delete(v); if (!s.size) m.delete(k); } };
  function remove(k) {
    const e = entries.get(k);
    if (!e) return;
    entries.delete(k); unindex(byBoard, e.board, k); unindex(byUser, ukey(e.board, e.user), k);
  }
  function put(b, identity, role, until, share = false, move = false) {
    const k = ekey(b, identity);
    remove(k);
    if (entries.size >= maxEntries) remove(entries.keys().next().value);
    entries.set(k, { board: b, user: identity.user, role, share, move, until });
    index(byBoard, b, k); index(byUser, ukey(b, identity.user), k);
  }
  function dropBoard(b) {
    for (const k of [...(byBoard.get(b) ?? [])]) remove(k);
    const tid = records.get("board:" + b)?.value?.tenant;
    records.delete("board:" + b);
    if (tid) records.delete("tenant:" + tid);
  }

  return {
    /** A role for a hello: cached, or read and cached. @returns {Promise<Role|null>} */
    async role(identity, boardId) { return (await this.access(identity, boardId)).role; },
    /** A hello's answer, cached the same way: `{ role, share }`. */
    async access(identity, boardId) {
      if (!identity || typeof identity.user !== "string" || typeof boardId !== "string") return { role: null, share: false, move: false };
      const k = ekey(boardId, identity), t0 = now(), e = entries.get(k);
      if (e && e.until > t0) { stats.hits++; return { role: e.role, share: e.share, move: e.move }; }
      if (e) remove(k);
      stats.misses++;
      const c0 = clock;
      reading++;
      let r;
      try { r = await tenancy.resolve(identity, boardId); }
      finally {
        // fill (before endRead clears the stamps)
        if (r && r.role != null) {
          if (stale(boardId, identity.user, c0)) stats.discarded++;
          else { const until = Math.min(t0 + ttlMs, r.until); if (until > now()) { put(boardId, identity, r.role, until, r.share, r.move); stats.fills++; } }
        }
        endRead();
      }
      return { role: r.role, share: r.share, move: r.move };
    },

    /**
     * Fresh roles for many users on one board: never served from the cache, and written through for exactly these
     * users (null answers evict). The gateway's timed pass calls `invalidate(board)` once, then `rolesFor` per chunk
     * of users, so the board ends the pass holding only what this pass read. @returns {Promise<Map<string, Role|null>>}
     */
    async rolesFor(boardId, identities) {
      const c0 = clock, t0 = now();
      reading++;
      let m;
      try { m = await tenancy.resolveMany(boardId, identities); }
      finally {
        if (m) {
          const boardMoved = (boardStamp.get(boardId) ?? 0) > c0, others = reading > 1;
          // `moved` for every identity first (stamps below must not mark this call's own other identities moved)
          const rows = [...m.values()].map(r => ({ r, uk: ukey(boardId, r.identity.user) }));
          for (const x of rows) x.moved = boardMoved || (userStamp.get(x.uk) ?? 0) > c0;
          for (const { r, uk, moved } of rows) {
            remove(ekey(boardId, r.identity));
            // a hello's read in flight began before this one ended: it must not overwrite this fresher answer
            if (others) { if (userStamp.size < STAMP_MAX) userStamp.set(uk, ++clock); else boardStamp.set(boardId, ++clock); }
            if (r.role == null || moved) continue;
            const until = Math.min(t0 + ttlMs, r.until);
            if (until > now()) put(boardId, r.identity, r.role, until, r.share, r.move);
          }
        }
        endRead();
      }
      return new Map([...m].map(([k, r]) => [k, r.role]));
    },

    /** Drop a board's cached roles, board/tenant records, link records and chain, or one user's role. Synchronous; call it before re-reading. */
    invalidate(boardId, user) {
      if (typeof boardId !== "string") return;
      if (typeof user === "string") {
        const k = ukey(boardId, user);
        for (const ek of [...(byUser.get(k) ?? [])]) remove(ek);   // every identity of the user
        // While reads are in flight, stamp the user; past STAMP_MAX user stamps (a redemption wave on a slow
        // Registry), stamp the whole board instead: coarser (more discarded fills), never staler, and bounded.
        if (reading) { if (userStamp.size < STAMP_MAX) userStamp.set(k, ++clock); else boardStamp.set(boardId, ++clock); }
        else clock++;
        return;
      }
      dropBoard(boardId); dropLinks(boardId); chains.delete(boardId); records.delete("board:" + boardId);   // a move changes the board's Space (PROTOCOL.md § Move board)
      if (reading) boardStamp.set(boardId, ++clock); else clock++;   // clock moves either way: no read joins across it
    },

    /**
     * Drop every cached role of one user on every board, now (a removal from a Unit, #55): a hello after it reads fresh, and a read in flight across it never fills. Synchronous.
     * Cost O(entries), paid once per removal; the other nodes learn from the Unit-wide revocation they receive.
     */
    forgetUser(user) {
      if (typeof user !== "string") return;
      for (const [k, e] of [...entries]) if (e.user === user) remove(k);
      if (reading) personStamp.set(user, ++clock); else clock++;
    },

    /** The board record, memoized until `invalidate(boardId)` drops it or `recordTtlMs` elapses. */
    board,
    stats: () => ({ ...stats, entries: entries.size, records: records.size }),
  };
}
