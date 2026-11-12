// Role resolution: who may do what on a board. Read live from the Registry on every call, so an expired or
// revoked invite or link stops working on the next role() (i.e. the next hello). `tenancy` never caches; the
// optional cache over it, `roleCache`, is at the end of this file (p5-load).
//
// A user's role on a board is the HIGHEST of:
//   - an explicit per-board grant (the creator gets `owner`);
//   - a live invite to the user's verified email for that board;
//   - a live share link for that board that this user has redeemed (redeemLink);
//   - the board's `memberRole` (default `viewer`), if the user's Workspace domain (`hd`) is the board tenant's.
// A grant lower than memberRole does not demote a Workspace member (highest wins).
// Nothing else counts: a user from another domain, or another tenant, gets a role only by grant, invite or link
// on that very board. An unknown board and a board with no role both give null (no existence leak).
//
// One rule, two ways to fetch (p5-load): `role` reads one user's rows (a hello); `rolesFor` reads a board's rows
// once for many users (the gateway's timed re-check), so a pass costs O(1) Registry queries per board plus
// ceil(users / USE_CHUNK) link-use queries (or one per user where the Registry has no `linkUsesFor`). Both feed
// the same pure `combine`, so they can't disagree (test/auth/role-cache.test.js checks it on random registries).

import { higher, capTo, normEmail, ROLES, LINK_ROLES, INVITE_ROLES } from "./util.js";

/** @typedef {import("./registry-port.js").Registry} Registry */
/** @typedef {import("./registry-port.js").Role} Role */
/** @typedef {import("./registry-port.js").Board} Board */
/** @typedef {import("./registry-port.js").Tenant} Tenant */
/** @typedef {import("./registry-port.js").Invite} Invite */
/** @typedef {import("./registry-port.js").Link} Link */
/** @typedef {import("./idp-port.js").Identity} Identity */
/** @typedef {{ role: Role|null, until: number }} Resolved  `until`: the soonest `expiresAt` among the live invites and links consulted (Infinity if none); the answer may change then without any message */

/** Users per `linkUsesFor` call (SQL bind limits; a 100k pass is 100 queries, not one 100k-parameter one). */
export const USE_CHUNK = 1000;

const live = (x, t) => x && !x.revoked && (x.expiresAt == null || t < x.expiresAt);
const okIdentity = id => !!id && typeof id.user === "string";

/**
 * The rule itself, pure. `invites`: this board's invites to the identity's email; `links`: the link records of the
 * identity's uses (any board; only this board's count). Every stored role is capped: unknown roles count for
 * nothing; invites and memberRole stay below owner; links stay within LINK_ROLES.
 * @param {{ board: Board, tenant: Tenant|null, grant: Role|null, invites: Invite[], links: (Link|null)[] }} rows
 * @param {Identity} identity @param {number} t
 * @returns {Resolved}
 */
export function combine({ board, tenant, grant, invites, links }, identity, t) {
  let r = capTo(grant, ROLES), until = Infinity;
  const dep = x => { if (x.expiresAt != null && x.expiresAt < until) until = x.expiresAt; };
  for (const i of invites) if (live(i, t)) { r = higher(r, capTo(i.role, INVITE_ROLES)); dep(i); }
  for (const l of links) if (l && l.board === board.id && live(l, t)) { r = higher(r, capTo(l.role, LINK_ROLES)); dep(l); }
  if (identity.domain && board.memberRole && tenant?.domain && tenant.domain === identity.domain) r = higher(r, capTo(board.memberRole, INVITE_ROLES));
  return { role: r ?? null, until };
}

/** @param {{ registry: Registry, now?: () => number }} deps */
export function tenancy({ registry, now = Date.now }) {
  /** One user's role with the time it may change by itself. @returns {Promise<Resolved>} */
  async function resolve(identity, boardId) {
    if (!okIdentity(identity) || typeof boardId !== "string") return { role: null, until: Infinity };
    const board = await registry.board(boardId);
    if (!board) return { role: null, until: Infinity };
    const t = now();
    const grant = await registry.grant(board.id, identity.user);
    const invites = identity.email ? await registry.invitesFor(board.id, identity.email) : [];
    const links = [];
    for (const id of await registry.linkUses(board.id, identity.user)) links.push(await registry.link(id));
    const tenant = identity.domain && board.memberRole ? await registry.tenant(board.tenant) : null;
    return combine({ board, tenant, grant, invites, links }, identity, t);
  }

  /**
   * Many users' roles on one board, from the board's rows read once. Identities are keyed by `user` (the first
   * identity of a user wins). @returns {Promise<Map<string, Resolved>>} every requested user present
   */
  async function resolveMany(boardId, identities) {
    const ids = new Map();
    for (const id of identities ?? []) if (okIdentity(id) && !ids.has(id.user)) ids.set(id.user, id);
    const out = new Map();
    const none = () => { for (const u of ids.keys()) out.set(u, { role: null, until: Infinity }); return out; };
    if (typeof boardId !== "string" || !ids.size) return none();
    const board = await registry.board(boardId);
    if (!board) return none();
    const t = now();
    const all = [...ids.values()];
    const grants = new Map((await registry.grants(board.id)).map(g => [g.user, g.role]));
    /** @type {Map<string, Invite[]>} normalized email → invites */
    const invitesBy = new Map();
    if (all.some(id => id.email)) for (const i of await registry.invites(board.id)) {
      const e = normEmail(i.email);
      if (!invitesBy.has(e)) invitesBy.set(e, []);
      invitesBy.get(e).push(i);
    }
    /** @type {Map<string, string[]>} user → link ids used on this board */
    let uses = new Map();
    if (typeof registry.linkUsesFor === "function") {
      for (let i = 0; i < all.length; i += USE_CHUNK) {
        const got = await registry.linkUsesFor(board.id, all.slice(i, i + USE_CHUNK).map(id => id.user));
        for (const [u, ls] of got) if (ids.has(u)) uses.set(u, ls);
      }
    } else for (const id of all) uses.set(id.user, await registry.linkUses(board.id, id.user));
    let linkById = new Map();
    for (const ls of uses.values()) if (ls.length) { linkById = new Map((await registry.links(board.id)).map(l => [l.id, l])); break; }
    const tenant = board.memberRole && all.some(id => id.domain) ? await registry.tenant(board.tenant) : null;
    for (const id of all) {
      const invites = id.email ? invitesBy.get(normEmail(id.email)) ?? [] : [];
      const links = (uses.get(id.user) ?? []).map(l => linkById.get(l) ?? null);
      out.set(id.user, combine({ board, tenant, grant: grants.get(id.user) ?? null, invites, links }, id, t));
    }
    return out;
  }

  return {
    /** @returns {Promise<Role|null>} */
    async role(identity, boardId) { return (await resolve(identity, boardId)).role; },
    resolve,
    resolveMany,
    /** @returns {Promise<Map<string, Role|null>>} user → role, one entry per distinct requested user */
    async rolesFor(boardId, identities) {
      const m = await resolveMany(boardId, identities);
      return new Map([...m].map(([u, r]) => [u, r.role]));
    },

    /**
     * A signed-in user opened a share link. Records the use and returns `{ board }`, or null for an unknown,
     * expired or revoked link (all the same answer). The role itself is re-read from the link on every role().
     */
    async redeemLink(identity, linkId) {
      if (!identity || typeof identity.user !== "string" || typeof linkId !== "string") return null;
      const l = await registry.link(linkId);
      if (!live(l, now())) return null;
      await registry.addLinkUse(l.id, identity.user);
      return { board: l.board };
    },

    /** The tenant an identity belongs to by Workspace domain, or null (no `hd` = guest only). */
    async tenantOf(identity) {
      return identity?.domain ? registry.tenantByDomain(identity.domain) : null;
    },
  };
}

const tenancyOver = (registry, now) => tenancy({ registry, now });

// ---- roleCache: a role cache over `tenancy` (p5-load; p-audit F8). Depends only on the Registry port. ----
//
// What it caches, per process (one gateway node):
//   - roles per (board, user), for hellos. Only a role (never null: a refusal is always read fresh), keyed also by
//     the identity's email and domain (a role depends on both). An entry lives until the soonest of: `ttlMs`
//     after the read began, and the soonest `expiresAt` of any live invite or link it depended on (time-based loss
//     sends no message). Bounded by `maxEntries` (oldest dropped first).
//   - the records the port can't change once written: board and tenant (memberRole and domain have no update
//     method), and link records by id (a link changes only by revokeLink, which announces on `grants`). `live()` is
//     evaluated on every use, so a memoized link still expires on time. Lookups of the same record share one read.
//
// Consistency (the one rule that matters: a revoke is never hidden longer than without the cache):
//   - `invalidate(board)` (a `grants` message `{ board }`, and the gateway releasing its watch of a board) drops
//     the board's roles and link records; `invalidate(board, user)` drops one user's role. The gateway calls it
//     synchronously in its `grants` subscriber, BEFORE bumping its hello generation and before its re-check pass.
//   - A read in flight across an invalidation never fills the cache (stamps per board and per (board, user), so a
//     stream of per-user invalidations doesn't starve the rest of the board).
//   - The timed re-check calls `invalidate(board)`, then `rolesFor` (always fresh, written through) per chunk of its
//     users: the board ends the pass holding only what the pass read. So a lost `grants` message (the bus is
//     at-most-once) is caught by the next timed pass exactly as without the cache, and no stale entry outlives it.
// Errors are never cached: a Registry failure propagates (the gateway answers `unavailable`).

/**
 * @param {{ registry: Registry, now?: () => number, ttlMs?: number, recordTtlMs?: number, maxEntries?: number, maxRecords?: number }} o
 *   ttlMs: a role entry's longest life (default 30 s; keep it ≤ the gateway's 60 s re-check, see the report);
 *   recordTtlMs: board / tenant / link records (default 60 s).
 */
const STAMP_MAX = 10_000;

export function roleCache({ registry, now = Date.now, ttlMs = 30_000, recordTtlMs = 60_000, maxEntries = 200_000, maxRecords = 100_000 }) {
  if (!registry) throw new Error("roleCache: registry is required");
  const stats = { hits: 0, misses: 0, fills: 0, discarded: 0, recordHits: 0, recordMisses: 0 };

  // ---- invalidation stamps: a read that began at clock c0 may fill only if nothing it covers was stamped after c0 ----
  let clock = 0, reading = 0;
  /** @type {Map<string, number>} */ const boardStamp = new Map();
  /** @type {Map<string, number>} */ const userStamp = new Map();
  const ukey = (board, user) => board + "\n" + user;
  const stale = (board, user, c0) => (boardStamp.get(board) ?? 0) > c0 || (userStamp.get(ukey(board, user)) ?? 0) > c0;
  const endRead = () => { if (--reading === 0) { boardStamp.clear(); userStamp.clear(); } };   // no read in flight: stamps can't matter

  // ---- records: board, tenant, link (by id) ----
  /** @type {Map<string, { value: any, until: number, board: string|null }>} */ const records = new Map();
  /** @type {Map<string, { p: Promise<any>, c0: number }>} in-flight record reads, with the clock they began at */ const recordReads = new Map();
  /** @type {Map<string, Set<string>>} board → its memoized link keys */ const linksOf = new Map();
  const dropLinks = board => { for (const k of linksOf.get(board) ?? []) records.delete(k); linksOf.delete(board); };
  function memo(kind, fetch) {
    return async id => {
      const k = kind + ":" + id, t = now(), hit = records.get(k);
      if (hit && hit.until > t) { stats.recordHits++; return structuredClone(hit.value); }
      stats.recordMisses++;
      // Join a read in flight only if nothing was invalidated since it began: a reader that starts after an
      // invalidation must not be handed a record read before it (it would pass its own stamp check with old data).
      const flight = recordReads.get(k);
      let p = flight && flight.c0 === clock ? flight.p : null;
      if (!p) {
        const c0 = clock;
        reading++;
        p = fetch(id).then(v => {
          const board = kind === "link" ? v?.board ?? null : null;
          // null is not memoized (a link created later must be found); a link whose board was invalidated meanwhile neither
          if (v && !(board && (boardStamp.get(board) ?? 0) > c0)) {
            if (records.size >= maxRecords) { const [ok, ov] = records.entries().next().value; records.delete(ok); if (ov.board) linksOf.get(ov.board)?.delete(ok); }
            records.set(k, { value: v, until: t + recordTtlMs, board });
            if (board) { if (!linksOf.has(board)) linksOf.set(board, new Set()); linksOf.get(board).add(k); }
          }
          return v;
        }).finally(() => { if (recordReads.get(k)?.p === p) recordReads.delete(k); endRead(); });
        recordReads.set(k, { p, c0 });
      }
      const v = await p;
      return v ? structuredClone(v) : v;
    };
  }
  const board = memo("board", id => registry.board(id));
  const view = { ...registry, board, tenant: memo("tenant", id => registry.tenant(id)), link: memo("link", id => registry.link(id)) };
  const tenancy = tenancyOver(view, now);

  // ---- roles ----
  /** @type {Map<string, { board: string, user: string, role: Role, email: string|null, domain: string|null, until: number }>} insertion order = age */
  const entries = new Map();
  /** @type {Map<string, Set<string>>} board → its entry keys */ const byBoard = new Map();
  function put(b, user, identity, role, until) {
    const k = ukey(b, user);
    entries.delete(k);
    if (entries.size >= maxEntries) { const [ok, oe] = entries.entries().next().value; entries.delete(ok); byBoard.get(oe.board)?.delete(ok); }
    entries.set(k, { board: b, user, role, email: identity.email ?? null, domain: identity.domain ?? null, until });
    if (!byBoard.has(b)) byBoard.set(b, new Set());
    byBoard.get(b).add(k);
  }
  function dropBoard(b) { for (const k of byBoard.get(b) ?? []) entries.delete(k); byBoard.delete(b); }

  return {
    /** A role for a hello: cached, or read and cached. @returns {Promise<Role|null>} */
    async role(identity, boardId) {
      if (!identity || typeof identity.user !== "string" || typeof boardId !== "string") return null;
      const k = ukey(boardId, identity.user), t0 = now(), e = entries.get(k);
      if (e && e.until > t0 && e.email === (identity.email ?? null) && e.domain === (identity.domain ?? null)) { stats.hits++; return e.role; }
      if (e) { entries.delete(k); byBoard.get(boardId)?.delete(k); }
      stats.misses++;
      const c0 = clock;
      reading++;
      let r;
      try { r = await tenancy.resolve(identity, boardId); }
      finally {
        // fill (before endRead clears the stamps)
        if (r && r.role != null) {
          if (stale(boardId, identity.user, c0)) stats.discarded++;
          else { const until = Math.min(t0 + ttlMs, r.until); if (until > now()) { put(boardId, identity.user, identity, r.role, until); stats.fills++; } }
        }
        endRead();
      }
      return r.role;
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
          const byUser = new Map();
          for (const id of identities ?? []) if (id && typeof id.user === "string" && !byUser.has(id.user)) byUser.set(id.user, id);
          for (const [user, r] of m) {
            const k = ukey(boardId, user), moved = boardMoved || (userStamp.get(k) ?? 0) > c0;
            if (entries.delete(k)) byBoard.get(boardId)?.delete(k);
            // a hello's read in flight began before this one ended: it must not overwrite this fresher answer
            if (others) { if (userStamp.size < STAMP_MAX) userStamp.set(k, ++clock); else boardStamp.set(boardId, ++clock); }   // boardMoved was read above
            if (r.role == null || moved) continue;
            const until = Math.min(t0 + ttlMs, r.until);
            if (until > now()) put(boardId, user, byUser.get(user), r.role, until);
          }
        }
        endRead();
      }
      return new Map([...m].map(([u, r]) => [u, r.role]));
    },

    /** Drop a board's cached roles and link records, or one user's role. Synchronous; call it before re-reading. */
    invalidate(boardId, user) {
      if (typeof boardId !== "string") return;
      if (typeof user === "string") {
        const k = ukey(boardId, user);
        if (entries.delete(k)) byBoard.get(boardId)?.delete(k);
        // While reads are in flight, stamp the user; past STAMP_MAX user stamps (a redemption wave on a slow
        // Registry), stamp the whole board instead: coarser (more discarded fills), never staler, and bounded.
        if (reading) { if (userStamp.size < STAMP_MAX) userStamp.set(k, ++clock); else boardStamp.set(boardId, ++clock); }
        else clock++;
        return;
      }
      dropBoard(boardId); dropLinks(boardId);
      if (reading) boardStamp.set(boardId, ++clock); else clock++;   // clock moves either way: no read joins across it
    },

    /** The board record, memoized (the gateway's own hello lookup may use it: board records never change). */
    board,
    stats: () => ({ ...stats, entries: entries.size, records: records.size }),
  };
}
