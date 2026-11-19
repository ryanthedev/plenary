// The Home screen's read side (PROTOCOL.md § Home): Recent, Starred, Shared with me, the Group/Space tree and search, each
// holding only boards the person can open NOW (the resolver's answer, never a stored list). Core: depends on the Registry
// port and `tenancy` (accessMany / effective), imports no adapter.
//
// Shape of every list: a candidate query that is bounded in the Registry (HOME caps), then ONE batch access check
// (`tenancy.accessMany`), then cards. Nothing here loops the boards of a Unit.

import { HOME } from "./registry-port.js";

/** @typedef {import("./idp-port.js").Identity} Identity */
/** @typedef {{ type: "group"|"space"|"other", id?: string, name: string }} PathPart */
/** @typedef {{ id: string, title: string, role: string, path: PathPart[], starred: boolean, at?: number }} Card */

/** What one Home read shows at most (also sent to the page as `limits`). */
export const LIMITS = Object.freeze({ recent: 12, starred: 50, shared: 50, search: 20, spaces: 200, other: 20 });
/** How many candidate rows each list reads before the access filter (a few may be dropped: unopenable, or a stale row). */
const SCAN = Object.freeze({ recent: 30, starred: 60, shared: 60, searchPages: 2 });
/**
 * The pseudo-group for boards filed in no Space (every board made before Spaces). One place to change when a later migration
 * moves them into a legacy Space: drop this and `other` in the tree (PROTOCOL.md § Home).
 */
export const OTHER = Object.freeze({ type: "other", name: "Other boards" });
const BATCH_PAR = 8;

const byTitle = (a, b) => (a.title.toLowerCase() < b.title.toLowerCase() ? -1 : a.title.toLowerCase() > b.title.toLowerCase() ? 1 : a.id < b.id ? -1 : 1);

/**
 * @param {{ registry: import("./registry-port.js").Registry, tenancy: ReturnType<typeof import("./tenancy.js").tenancy> }} deps
 */
export function homeService({ registry, tenancy }) {
  const card = (found, extra = {}) => {
    const { access, board, space, group } = found;
    const path = space ? [...(group ? [{ type: "group", id: group.id, name: group.name }] : []), { type: "space", id: space.id, name: space.name }] : [OTHER];
    return { id: board.id, title: board.title, role: access.ladder, path, starred: false, ...extra };
  };
  const openable = f => !!f && f.access.ladder != null;

  /** Cards for `ids` in the given order, dropping what the person can't open; starred flags filled in one query. */
  async function cards(identity, entries) {
    const found = await tenancy.accessMany(identity, [...new Set(entries.map(e => e.id))]);
    const out = entries.filter(e => openable(found.get(e.id))).map(e => card(found.get(e.id), e.at != null ? { at: e.at } : {}));
    if (out.length) {
      const stars = new Set(await registry.starredAmong(identity.user, out.map(c => c.id)));
      for (const c of out) c.starred = stars.has(c.id);
    }
    return out;
  }

  /** The cards of boards shared with the person (a board-scope source other than ownership), by title. */
  async function sharedCards(identity) {
    const ids = await registry.sharedBoards(identity.user, identity.email ?? null, { limit: SCAN.shared });
    return (await cards(identity, ids.map(id => ({ id })))).sort(byTitle);
  }

  /** The tree: the Groups and Spaces the person can open boards in, and the unfiled boards they can open. */
  async function tree(identity, unit) {
    const [groups, spaces] = await Promise.all([registry.groups(unit.id), registry.spaces(unit.id)]);
    const room = spaces.slice(0, LIMITS.spaces);
    const seen = async (type, rows) => {
      const ok = [];
      for (let i = 0; i < rows.length; i += BATCH_PAR)
        ok.push(...await Promise.all(rows.slice(i, i + BATCH_PAR).map(async r => ((await tenancy.effective(identity, { type, id: r.id })).ladder != null ? r : null))));
      return ok.filter(Boolean);
    };
    const visible = await seen("space", room);
    const asNode = s => ({ id: s.id, name: s.name, personal: s.kind === "personal" });
    const withSpaces = new Set(visible.filter(s => s.group).map(s => s.group));
    const emptyGroups = groups.filter(g => !withSpaces.has(g.id));
    const open = new Set((await seen("group", emptyGroups)).map(g => g.id));
    const shown = groups.filter(g => withSpaces.has(g.id) || open.has(g.id));
    const otherIds = await registry.searchBoards(unit.id, { unfiled: true, limit: 100 });
    const found = await tenancy.accessMany(identity, otherIds.ids);
    const other = otherIds.ids.filter(id => openable(found.get(id))).map(id => ({ id, title: found.get(id).board.title })).sort(byTitle);
    return {
      groups: shown.map(g => ({ id: g.id, name: g.name, spaces: visible.filter(s => s.group === g.id).map(asNode) })),
      spaces: visible.filter(s => !s.group).map(asNode),
      other: { boards: other.slice(0, LIMITS.other), more: other.length > LIMITS.other || otherIds.next != null },
      more: spaces.length > room.length,
    };
  }

  return {
    /** GET /home. @param {Identity} identity */
    async home(identity) {
      const unit = await tenancy.tenantOf(identity);
      const base = { guest: !unit, user: { user: identity.user, name: identity.name ?? identity.email ?? identity.user }, unit: unit ? { id: unit.id, kind: unit.kind } : null, limits: LIMITS };
      if (!unit) return { ...base, recent: [], starred: [], shared: (await sharedCards(identity)).slice(0, LIMITS.shared), tree: null };
      const [rec, star, shared, theTree] = await Promise.all([
        registry.recents(identity.user, { limit: SCAN.recent }),
        registry.starred(identity.user, { limit: SCAN.starred }),
        sharedCards(identity),
        tree(identity, unit),
      ]);
      const mine = await cards(identity, [...rec.map(r => ({ id: r.board, at: r.at })), ...star.map(r => ({ id: r.board, at: r.at }))]);
      // `cards` keeps duplicates apart by position: rebuild each list from its own rows.
      const byId = new Map(); for (const c of mine) if (!byId.has(c.id)) byId.set(c.id, c);
      const pick = rows => rows.filter(r => byId.has(r.board)).map(r => ({ ...byId.get(r.board), at: r.at }));
      return { ...base, recent: pick(rec).slice(0, LIMITS.recent), starred: pick(star).slice(0, LIMITS.starred), shared: shared.slice(0, LIMITS.shared), tree: theTree };
    },

    /**
     * GET /home/search. `q` is already validated (trimmed, 1-100 chars). Members: boards of their Unit whose title or Space name
     * contains q; everyone: matching titles among Shared with me.
     */
    async search(identity, q) {
      const unit = await tenancy.tenantOf(identity);
      const needle = q.toLowerCase(), results = [], seen = new Set();
      let more = false;
      if (unit) {
        let after = null;
        for (let page = 0; page < SCAN.searchPages && results.length < LIMITS.search; page++) {
          const r = await registry.searchBoards(unit.id, { q, after, limit: 100 });
          for (const c of await cards(identity, r.ids.map(id => ({ id })))) if (results.length < LIMITS.search && !seen.has(c.id)) { seen.add(c.id); results.push(c); }
          after = r.next;
          if (after == null) break;
          if (page === SCAN.searchPages - 1 || results.length >= LIMITS.search) more = true;
        }
      }
      for (const c of await sharedCards(identity)) {
        if (!c.title.toLowerCase().includes(needle) || seen.has(c.id)) continue;
        if (results.length >= LIMITS.search) { more = true; break; }
        seen.add(c.id); results.push(c);
      }
      return { q, results, more };
    },

    /** PUT /home/stars/:board. @returns {Promise<boolean>} false = the person has no role on it (or it doesn't exist): nothing was written */
    async star(identity, board, on) {
      if (!on) { await registry.setStarred(identity.user, board, false); return true; }
      const found = (await tenancy.accessMany(identity, [board])).get(board);
      if (!openable(found)) return false;
      await registry.setStarred(identity.user, board, true);
      return true;
    },
  };
}

/**
 * Recent, written by the server (PROTOCOL.md § Home): `opened(user, board)` for each welcomed connection. Best effort: a user's
 * reopening of one board within `windowMs` writes once, and a failed write is logged and dropped (a lost row only costs a
 * place in Recent). The map of recent writes is bounded.
 * @param {{ registry: Pick<import("./registry-port.js").Registry, "markOpened">, now?: () => number, windowMs?: number, max?: number, log?: { warn(msg: string, f?: object): void } }} o
 */
export function recentRecorder({ registry, now = Date.now, windowMs = 60_000, max = 10_000, log }) {
  /** @type {Map<string, number>} */ const last = new Map();
  return function opened(user, board) {
    if (typeof user !== "string" || typeof board !== "string") return;
    const k = user + "\n" + board, t = now(), prev = last.get(k);
    if (prev !== undefined && t - prev < windowMs) return;
    last.delete(k);
    if (last.size >= max) last.delete(last.keys().next().value);   // oldest first (a Map keeps insertion order)
    last.set(k, t);
    Promise.resolve().then(() => registry.markOpened(user, board)).catch(err => { last.delete(k); log?.warn("recent write failed", { board, err }); });
  };
}
