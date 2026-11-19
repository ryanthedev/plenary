// The Home screen's read side (PROTOCOL.md § Home): Recent, Starred, Shared with me, the Group/Space tree and search, each
// holding only boards the person can open NOW (the resolver's answer, never a stored list). Core: depends on the Registry
// port and `tenancy` (accessMany / effective), imports no adapter.
//
// Shape of every list: a candidate query that is bounded in the Registry (caps below), then ONE batch access check
// (`tenancy.accessMany`), then cards. Nothing here loops the boards of a Unit.
//
// Names are access too: a card's path names only the Space and Group the person can open boards in; anything above a
// board they reach some other way shows as "Shared with you" (SHARED_PART), and a Space-name search match counts only
// for a Space they can open.

import { asciiFold } from "./registry-port.js";
import { resolveAccess } from "./resolver.js";

/** @typedef {import("./idp-port.js").Identity} Identity */
/** @typedef {{ type: "group"|"space"|"other"|"shared", id?: string, name: string }} PathPart */
/** @typedef {{ id: string, title: string, role: string, path: PathPart[], starred: boolean, at?: number }} Card */

/** What one Home read shows at most (also sent to the page as `limits`). */
export const LIMITS = Object.freeze({ recent: 12, starred: 50, shared: 50, owned: 50, search: 20, spaces: 100, other: 20, space: 50 });
/** How many candidate rows each list reads before the access filter (a few may be dropped: unopenable, or a stale row). */
const SCAN = Object.freeze({ recent: 30, starred: 60, shared: 60, searchPages: 2, searchPage: 100, grantChecks: 40, groupChecks: 20, groupCandidates: 50 });
/**
 * The pseudo-group for boards filed in no Space (every board made before Spaces). One place to change when a later migration
 * moves them into a legacy Space: drop this and `other` in the tree (PROTOCOL.md § Home).
 */
export const OTHER = Object.freeze({ type: "other", name: "Other boards" });
/** What stands in for a Space or Group name the person may not see. */
export const SHARED_PART = Object.freeze({ type: "shared", name: "Shared with you" });
const BATCH_PAR = 8;

const byTitle = (a, b) => (a.title.toLowerCase() < b.title.toLowerCase() ? -1 : a.title.toLowerCase() > b.title.toLowerCase() ? 1 : a.id < b.id ? -1 : 1);

/**
 * @param {{ registry: import("./registry-port.js").Registry, tenancy: ReturnType<typeof import("./tenancy.js").tenancy>, now?: () => number }} deps
 */
export function homeService({ registry, tenancy, now = Date.now }) {
  /** The path a card shows: only what the person can open is named (module comment). */
  const pathOf = (f, unit) => {
    if (!f.space) return unit && f.board.tenant === unit.id ? [OTHER] : [SHARED_PART];
    return [...(f.group && f.groupOpen ? [{ type: "group", id: f.group.id, name: f.group.name }] : []),
      f.spaceOpen ? { type: "space", id: f.space.id, name: f.space.name } : SHARED_PART];
  };
  const openable = f => !!f && f.access.ladder != null;
  const card = (f, unit, extra = {}) => ({ id: f.board.id, title: f.board.title, role: f.access.ladder, path: pathOf(f, unit), starred: false, ...extra });

  /** Cards for `entries` ({ id, at? }) in order, dropping what the person can't open; star flags in one query. `keep(found)` filters further. */
  async function cards(identity, unit, entries, { found: given, keep } = {}) {
    const found = given ?? await tenancy.accessMany(identity, [...new Set(entries.map(e => e.id))]);
    const out = entries.filter(e => openable(found.get(e.id)) && (!keep || keep(found.get(e.id)))).map(e => card(found.get(e.id), unit, e.at != null ? { at: e.at } : {}));
    if (out.length) {
      const stars = new Set(await registry.starredAmong(identity.user, out.map(c => c.id)));
      for (const c of out) c.starred = stars.has(c.id);
    }
    return out;
  }

  /**
   * Boards the person reaches through a source on the board itself (a direct, Team, invite or link grant; Registry.sharedBoards).
   * `owned`: those they hold an owner grant on. `shared`: the rest, except (members) boards the tree already shows: boards in a
   * Space they can open, and boards filed in no Space in their own Unit ("Other boards").
   */
  async function reached(identity, unit) {
    const ids = await registry.sharedBoards(identity.user, identity.email ?? null, { limit: SCAN.shared });
    const found = await tenancy.accessMany(identity, ids);
    const inTree = f => !!unit && (f.spaceOpen || (!f.space && f.board.tenant === unit.id));
    const mine = f => f.grant === "owner";
    const list = (keep) => cards(identity, unit, ids.map(id => ({ id })), { found, keep });
    const owned = unit ? [] : (await list(mine)).sort(byTitle);
    const shared = (await list(f => !inTree(f) && (!!unit || !mine(f)))).sort(byTitle);
    return { owned, shared };
  }

  const asNode = s => ({ id: s.id, name: s.name, personal: s.kind === "personal" });

  /** The tree: the Spaces and Groups the person can open boards in, and the unfiled boards they can open. Every step is bounded (module header, PROTOCOL.md § Home). */
  async function tree(identity, unit) {
    const all = (await tenancy.effective(identity, { type: "unit", id: unit.id })).ladder != null;   // a Unit-level role covers everything inside
    const cand = await registry.spaceCandidates(unit.id, { user: identity.user, all, limit: LIMITS.spaces });
    const groups = new Map(cand.groups.map(g => [g.id, g]));
    const t = now();
    // What general access alone gives, from the rows in hand (no read); anything more needs the resolver's full answer.
    const noGrants = { unit: [], group: [], space: [], board: [] };
    const general = (space, group) => resolveAccess({ ctx: { tenant: unit, board: null, space, group, scoped: noGrants, roles: [], teams: {} } }, identity, t).ladder != null;
    let more = cand.next != null, checks = 0;
    const visible = [], pending = [];
    for (const s of cand.spaces) {
      if (all || general(s, s.group ? groups.get(s.group) ?? null : null)) visible.push(s);
      else if (checks++ < SCAN.grantChecks) pending.push(s);
      else more = true;
    }
    for (let i = 0; i < pending.length; i += BATCH_PAR)
      for (const r of await Promise.all(pending.slice(i, i + BATCH_PAR).map(async s => ((await tenancy.effective(identity, { type: "space", id: s.id })).ladder != null ? s : null)))) if (r) visible.push(r);
    visible.sort((a, b) => (a.id < b.id ? -1 : 1));
    // A Group is named only if the person can open it (its name is access too). Candidates: the Groups of the Spaces above, plus Groups
    // they hold a role on with no open Space in this page. Checks beyond the cap leave a Group unnamed: its open Spaces list at the root.
    const shown = new Map();
    let gChecks = 0;
    const seenGroups = new Map(cand.groups.map(g => [g.id, g]));
    for (const g of await registry.groupCandidates(unit.id, { user: identity.user, all, limit: SCAN.groupCandidates })) if (!seenGroups.has(g.id)) seenGroups.set(g.id, g);
    for (const g of seenGroups.values()) {
      if (all || general(null, g)) shown.set(g.id, g);
      else if (gChecks++ < SCAN.groupChecks) { if ((await tenancy.effective(identity, { type: "group", id: g.id })).ladder != null) shown.set(g.id, g); }
      else more = true;
    }
    const page = await registry.searchBoards(unit.id, { unfiled: true, limit: SCAN.searchPage });
    const found = await tenancy.accessMany(identity, page.ids);
    const other = page.ids.filter(id => openable(found.get(id))).map(id => ({ id, title: found.get(id).board.title })).sort(byTitle);
    return {
      groups: [...shown.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1))
        .map(g => ({ id: g.id, name: g.name, spaces: visible.filter(s => s.group === g.id).map(asNode) })),
      spaces: visible.filter(s => !s.group || !shown.has(s.group)).map(asNode),
      other: { boards: other.slice(0, LIMITS.other), more: other.length > LIMITS.other || page.next != null },
      more,
    };
  }

  return {
    /** GET /home. @param {Identity} identity */
    async home(identity) {
      const unit = await tenancy.tenantOf(identity);
      const base = { guest: !unit, user: { user: identity.user, name: identity.name ?? identity.email ?? identity.user }, unit: unit ? { id: unit.id, kind: unit.kind } : null, limits: LIMITS };
      const [rec, star, { owned, shared }, theTree] = await Promise.all([
        registry.recents(identity.user, { limit: SCAN.recent }),
        unit ? registry.starred(identity.user, { limit: SCAN.starred }) : [],
        reached(identity, unit),
        unit ? tree(identity, unit) : null,
      ]);
      const mine = await cards(identity, unit, [...rec.map(r => ({ id: r.board, at: r.at })), ...star.map(r => ({ id: r.board, at: r.at }))]);
      const byId = new Map(); for (const c of mine) if (!byId.has(c.id)) byId.set(c.id, c);
      const pick = rows => rows.filter(r => byId.has(r.board)).map(r => ({ ...byId.get(r.board), at: r.at }));
      return { ...base, recent: pick(rec).slice(0, LIMITS.recent), starred: pick(star).slice(0, LIMITS.starred),
        owned: owned.slice(0, LIMITS.owned), shared: shared.slice(0, LIMITS.shared), tree: theTree };
    },

    /**
     * GET /home/search. `q` is already validated (trimmed, 1-100 chars). Members: boards of their Unit whose title contains q, or whose
     * Space (which they can open) has a name containing q; everyone: matching titles among the boards reached directly. Work is
     * bounded: at most SCAN.searchPages pages of SCAN.searchPage matches, each examining at most the Registry's `scan` boards;
     * `more` says the search stopped before the end.
     */
    async search(identity, q) {
      const unit = await tenancy.tenantOf(identity);
      const needle = asciiFold(q), results = [], seen = new Set();
      let more = false;
      const add = c => { if (seen.has(c.id)) return; if (results.length >= LIMITS.search) { more = true; return; } seen.add(c.id); results.push(c); };
      if (unit) {
        let after = null;
        for (let page = 0; page < SCAN.searchPages; page++) {
          const r = await registry.searchBoards(unit.id, { q, after, limit: SCAN.searchPage });
          // A Space-name match counts only when the person can open that Space: an unopenable Space's name is not a search key.
          for (const c of await cards(identity, unit, r.ids.map(id => ({ id })), { keep: f => asciiFold(f.board.title).includes(needle) || f.spaceOpen })) add(c);
          after = r.next;
          if (after == null) break;
        }
        if (after != null) more = true;
      }
      const { owned, shared } = await reached(identity, unit);
      for (const c of [...owned, ...shared]) if (asciiFold(c.title).includes(needle)) add(c);
      return { q, results, more };
    },

    /**
     * GET /home/search?space=<id>: the boards of one Space the person can open. `space` is named only when they can open the Space
     * itself (else a board reached another way still lists, under "Shared with you", and the Space stays unnamed).
     */
    async spaceBoards(identity, spaceId) {
      const unit = await tenancy.tenantOf(identity);
      const sp = unit ? await registry.space(spaceId) : null;
      if (!sp || sp.tenant !== unit.id) return { space: null, results: [], more: false };
      const page = await registry.boardsIn({ type: "space", id: sp.id }, { limit: 200 });
      const found = await tenancy.accessMany(identity, page.ids);
      const results = (await cards(identity, unit, page.ids.map(id => ({ id })), { found })).sort(byTitle);
      const named = [...found.values()].some(f => f.spaceOpen);
      return { space: named ? { id: sp.id, name: sp.name } : null, results: results.slice(0, LIMITS.space), more: page.next != null || results.length > LIMITS.space };
    },

    /** PUT /home/stars/:board. Guests have no Starred. @returns {Promise<boolean>} false = refused (guest, no role, or no such board): nothing was written */
    async star(identity, board, on) {
      if (!on) { await registry.setStarred(identity.user, board, false); return true; }
      if (!(await tenancy.tenantOf(identity))) return false;
      const found = (await tenancy.accessMany(identity, [board])).get(board);
      if (!openable(found)) return false;
      await registry.setStarred(identity.user, board, true);
      return true;
    },
  };
}

/**
 * Recent, written by the server (PROTOCOL.md § Home): `opened(user, board)` for each welcomed connection. Best effort and bounded:
 * a user's reopening of one board within `windowMs` writes once; at most `maxInFlight` writes run at once and a welcome that arrives
 * with that many in flight is DROPPED (counted in `stats().dropped`, and not remembered, so the next welcome of that board retries),
 * never queued: a join storm costs the Registry at most `maxInFlight` writes at a time, and a lost row only costs a place in
 * Recent. A failed write is logged and not remembered. The map of recent writes is bounded.
 * @param {{ registry: Pick<import("./registry-port.js").Registry, "markOpened">, now?: () => number, windowMs?: number, max?: number, maxInFlight?: number,
 *   log?: { warn(msg: string, f?: object): void } }} o
 */
export function recentRecorder({ registry, now = Date.now, windowMs = 60_000, max = 10_000, maxInFlight = 16, log }) {
  /** @type {Map<string, number>} */ const last = new Map();
  let inFlight = 0;
  const stats = { written: 0, dropped: 0, failed: 0 };
  /** One warning per `windowMs` for drops, so a storm is one line, not thousands. */
  let warnedAt = -Infinity;
  function opened(user, board) {
    if (typeof user !== "string" || typeof board !== "string") return;
    const k = user + "\n" + board, t = now(), prev = last.get(k);
    if (prev !== undefined && t - prev < windowMs) return;
    if (inFlight >= maxInFlight) {
      stats.dropped++;
      if (t - warnedAt >= windowMs) { warnedAt = t; log?.warn("recent writes dropped: too many in flight", { inFlight, dropped: stats.dropped }); }
      return;
    }
    last.delete(k);
    if (last.size >= max) last.delete(last.keys().next().value);   // oldest first (a Map keeps insertion order)
    last.set(k, t);
    inFlight++;
    Promise.resolve().then(() => registry.markOpened(user, board))
      .then(() => { stats.written++; }, err => { stats.failed++; last.delete(k); log?.warn("recent write failed", { board, err }); })
      .finally(() => { inFlight--; });
  }
  opened.stats = () => ({ ...stats, inFlight });
  return opened;
}
