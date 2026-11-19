// Spaces and Groups: their pages, the New board / New space pickers, create, rename and general access (PROTOCOL.md § Spaces and
// Groups, #48). Core: depends on the Registry port, `tenancy` and the Home service, imports no adapter; the HTTP routes only translate.
//
// Every check is a PERMISSION read from the resolver's answer at the scope the request names (`tenancy.effective`), never a role name.
// Names are access: a Space or Group the person cannot open is never named, and an id that does not exist, one in another Unit and one
// that is hidden all answer alike (a read: `not-found`; a write: `forbidden`).

import { AdminError } from "../admin/boards.js";
import { resolveAccess } from "./resolver.js";
import { ROLES } from "./util.js";
import { homeService } from "./home.js";

/** @typedef {import("./idp-port.js").Identity} Identity */

/** What one read shows at most, and the work each does (PROTOCOL.md § Spaces and Groups, Bounds). */
export const LIMITS = Object.freeze({ spaces: 100, groups: 50, groupSpaces: 100 });
/** Freshness fan-out: pages of `boardsIn` announced inline; a larger scope's rest waits for the timed re-check (≤ 60 s). */
export const ANNOUNCE = Object.freeze({ pages: 20, page: 500, par: 50, inflight: 8 });
/** The general-access roles a Space or Group may carry: the ladder below `owner` (null = only people added). */
export const GENERAL_ROLES = Object.freeze(ROLES.filter(r => r !== "owner"));

const refused = () => new AdminError("forbidden", "not allowed");
const missing = () => new AdminError("not-found", "not found");
const bad = m => new AdminError("bad-request", m);
const NO_GRANTS = { unit: [], group: [], space: [], board: [] };

/** A trimmed name of 1-200 chars. */
function nameOf(v, what = "name") {
  const n = typeof v === "string" ? v.trim() : "";
  if (!n || n.length > 200 || n.includes("\0")) throw bad(`bad ${what}`);
  return n;
}
/** A board title: trimmed, 0-200 chars (a board may be untitled). */
function titleOf(v) {
  const n = typeof v === "string" ? v.trim() : null;
  if (n === null || n.length > 200 || n.includes("\0")) throw bad("bad title");
  return n;
}
/** A general-access value: a ladder role below owner, or null. */
function generalOf(v) {
  if (v !== null && !GENERAL_ROLES.includes(v)) throw bad("bad general");
  return v;
}
const idOf = v => (typeof v === "string" && /^[\w-]{1,64}$/.test(v) ? v : null);

/**
 * @param {{ registry: import("./registry-port.js").Registry, tenancy: ReturnType<typeof import("./tenancy.js").tenancy>,
 *   home?: ReturnType<typeof homeService>, announce?: (tenant: string, board: string) => Promise<void>|void, now?: () => number,
 *   log?: { warn(msg: string, f?: object): void } }} deps
 *   announce: tells every live connection on a board to re-check its role (the `.grants` message; main.js gives the bus's). Best effort.
 */
export function spaceService({ registry, tenancy, home = null, announce = async () => {}, now = Date.now, log = { warn() {} } }) {
  home ??= homeService({ registry, tenancy, now });
  const may = (a, p) => a.permissions.has(p);
  /** The shape every page and picker names a Space in. `group` only when the person can open that Group. */
  const spaceView = (s, group) => ({ id: s.id, name: s.name, personal: s.kind === "personal", general: s.generalRole ?? null, group: group ? { id: group.id, name: group.name } : null });

  /** The caller's Unit, or null (a guest, or a domain with no Unit). */
  const unitOf = identity => tenancy.tenantOf(identity);
  /**
   * The Space or Group `id` in the caller's Unit with the caller's access to it, or null. The SAME two reads happen whatever the id (fine,
   * unknown, in another Unit or hidden), so a refusal can't be told from another by how much work it did (PROTOCOL.md § Spaces and Groups).
   */
  async function scopeOf(identity, unit, type, id) {
    if (!idOf(id)) return null;
    const [row, access] = await Promise.all([type === "space" ? registry.space(id) : registry.group(id), tenancy.effective(identity, { type, id })]);
    return row && unit && row.tenant === unit.id ? { row, access } : null;
  }

  /** What general access alone gives, from the rows in hand (no read): enough to say yes; a "no" needs the full answer. */
  const general = (unit, identity, space, group, t) => resolveAccess({ ctx: { tenant: unit, board: null, space, group, scoped: NO_GRANTS, roles: [], teams: {} } }, identity, t);
  /** The single rule for "may create a board here" (picker and POST /boards both): the resolver's answer holds `board.create`. */
  const createsBoards = a => may(a, "board.create");
  const opens = a => a.ladder != null;

  /**
   * Announcements (they run after the response; `settled()` waits for them). One pass per scope at a time: a change that arrives while a pass
   * runs only marks the scope dirty and gets exactly ONE more pass after it (a burst of N changes costs at most 2 passes, and the last pass
   * starts after the last write, so the final state is always announced). At most ANNOUNCE.inflight scopes run at once; beyond that the
   * change is logged and left to the gateways' timed re-check (60 s at most).
   */
  const running = new Map();                      // scope key -> { dirty, done }
  function announceLater(unit, scope) {
    const key = `${scope.type}\n${scope.id}`, cur = running.get(key);
    if (cur) { cur.dirty = true; return; }
    if (running.size >= ANNOUNCE.inflight) { try { log.warn("grants announcement skipped: too many in flight; the timed re-check covers it", { scope: scope.type }); } catch {} return; }
    const st = { dirty: false, done: null };
    st.done = (async () => { do { st.dirty = false; await announceScope(unit, scope); } while (st.dirty); })().catch(() => {}).finally(() => running.delete(key));
    running.set(key, st);
  }
  /** The announcement itself (never rejects). */
  async function announceScope(unit, scope) {
    let after = null, pages = 0, sent = 0;
    try {
      do {
        const p = await registry.boardsIn(scope, { after, limit: ANNOUNCE.page });
        for (let i = 0; i < p.ids.length; i += ANNOUNCE.par) await Promise.all(p.ids.slice(i, i + ANNOUNCE.par).map(async b => { try { await announce(unit.id, b); sent++; } catch (err) { try { log.warn("grants announcement failed", { board: b, err }); } catch {} } }));
        after = p.next;
        if (after != null && ++pages >= ANNOUNCE.pages) { log.warn("grants announcement stopped at its bound; the timed re-check covers the rest", { scope: scope.type, sent }); break; }
      } while (after != null);
    } catch (err) { try { log.warn("grants announcement failed", { scope: scope.type, err }); } catch {} }
  }

  /** The Spaces the person can open and `board.create` in (their personal space first), for the picker. One batch read settles every candidate. */
  async function creatableSpaces(identity, unit) {
    const personal = await registry.ensurePersonalSpace(unit.id, identity.user);
    const all = opens(await tenancy.effective(identity, { type: "unit", id: unit.id }));   // a Unit-level role covers everything inside
    const cand = await registry.spaceCandidates(unit.id, { user: identity.user, all, limit: LIMITS.spaces });
    const groups = new Map(cand.groups.map(g => [g.id, g]));
    const t = now();
    const out = [], pending = [];
    for (const s of cand.spaces) {
      if (s.id === personal.id) continue;
      const fast = general(unit, identity, s, s.group ? groups.get(s.group) ?? null : null, t);
      if (opens(fast) && createsBoards(fast)) out.push(s); else pending.push(s);
    }
    const got = await tenancy.effectiveMany(identity, pending.map(s => ({ type: "space", id: s.id })));
    for (const s of pending) { const a = got.get("space\n" + s.id); if (a && opens(a) && createsBoards(a)) out.push(s); }
    // A Group is named only if the person can open it.
    const named = new Map(), askGroups = [];
    for (const g of new Set(out.map(s => s.group).filter(id => id && groups.has(id)))) {
      if (opens(general(unit, identity, null, groups.get(g), t))) named.set(g, groups.get(g)); else askGroups.push(g);
    }
    const gotG = await tenancy.effectiveMany(identity, askGroups.map(id => ({ type: "group", id })));
    for (const id of askGroups) if (opens(gotG.get("group\n" + id) ?? { ladder: null })) named.set(id, groups.get(id));
    out.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.id < b.id ? -1 : 1));
    return { spaces: [spaceView(personal, null), ...out.map(s => spaceView(s, s.group ? named.get(s.group) : null))], more: cand.next != null };
  }

  /** The Groups the person can open and `space.create` in. */
  async function creatableGroups(identity, unit) {
    const unitAccess = await tenancy.effective(identity, { type: "unit", id: unit.id });
    const cand = await registry.groupCandidates(unit.id, { user: identity.user, all: opens(unitAccess), limit: LIMITS.groups + 1 });
    const t = now(), out = [], pending = [];
    for (const g of cand.slice(0, LIMITS.groups)) {
      const fast = general(unit, identity, null, g, t);
      if (opens(fast) && may(fast, "space.create")) out.push(g); else pending.push(g);
    }
    const got = await tenancy.effectiveMany(identity, pending.map(g => ({ type: "group", id: g.id })));
    for (const g of pending) { const a = got.get("group\n" + g.id); if (a && opens(a) && may(a, "space.create")) out.push(g); }
    out.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.id < b.id ? -1 : 1));
    return { root: may(unitAccess, "space.create"), groups: out.map(g => ({ id: g.id, name: g.name })), more: cand.length > LIMITS.groups };
  }

  return {
    /**
     * POST /boards: a board in `space` (needs `board.create` there) or, with none, in the caller's personal space (always allowed).
     * The caller becomes its owner. `memberRole` absent = inherit the Space (null).
     * @param {Identity} identity @param {{ title?: string, space?: string|null, memberRole?: string|null }} o
     */
    async createBoard(identity, { title = "", space = null, memberRole } = {}) {
      const t = titleOf(title);
      if (memberRole !== undefined && memberRole !== null && (!ROLES.includes(memberRole) || memberRole === "owner")) throw bad("bad memberRole");
      if (space !== null && !idOf(space)) throw bad("bad space");
      const unit = await unitOf(identity);
      if (!unit) throw refused();
      let target;
      if (space === null) target = (await registry.ensurePersonalSpace(unit.id, identity.user)).id;
      else {
        const sc = await scopeOf(identity, unit, "space", space);
        // Nobody writes into another member's personal space, an admin included (it is private until its owner shares from it).
        if (!sc || !createsBoards(sc.access) || (sc.row.kind === "personal" && sc.row.owner !== identity.user)) throw refused();
        target = sc.row.id;
      }
      const board = await registry.createBoard({ tenant: unit.id, title: t, space: target, ...(memberRole !== undefined ? { memberRole } : {}) });
      // createBoard takes no creator: the owner grant is a second call. Retry once; if it still fails, report the failure WITH the board id.
      let last;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await registry.setGrant(board.id, identity.user, "owner"); return board; }
        catch (err) { last = err; }
      }
      throw new AdminError("owner-grant-failed", `board ${board.id} was created but its owner grant failed`, { board: board.id, cause: last });
    },

    /** GET /spaces?can=board.create. @param {Identity} identity */
    async boardPicker(identity) {
      const unit = await unitOf(identity);
      if (!unit) throw refused();
      return creatableSpaces(identity, unit);
    },

    /** GET /groups?can=space.create. @param {Identity} identity */
    async spacePicker(identity) {
      const unit = await unitOf(identity);
      if (!unit) throw refused();
      return creatableGroups(identity, unit);
    },

    /**
     * POST /spaces: a Space at the Unit root (`space.create` there) or in a Group (`space.create` at the Group). The caller becomes its owner.
     * @param {Identity} identity @param {{ name: string, group?: string|null, general?: string|null }} o
     */
    async createSpace(identity, { name, group = null, general: gen = "viewer" } = {}) {
      const n = nameOf(name);
      if (group !== null && !idOf(group)) throw bad("bad group");
      generalOf(gen);
      const unit = await unitOf(identity);
      if (!unit) throw refused();
      let g = null, access;
      if (group === null) access = await tenancy.effective(identity, { type: "unit", id: unit.id });
      else {
        const sc = await scopeOf(identity, unit, "group", group);
        if (!sc) throw refused();
        ({ row: g, access } = sc);
      }
      if (!may(access, "space.create")) throw refused();
      const s = await registry.createSpace({ tenant: unit.id, name: n, group: g?.id ?? null, generalRole: gen, owner: identity.user });
      return spaceView(s, g && opens(access) ? g : null);
    },

    /** GET /spaces/:id. Hidden, unknown and other-Unit ids are one `not-found`. @param {Identity} identity @param {string} id */
    async spacePage(identity, id) {
      const unit = await unitOf(identity);
      const sc = await scopeOf(identity, unit, "space", id);
      if (!sc || !opens(sc.access)) throw missing();
      const { row: sp, access: a } = sc;
      const group = sp.group ? await registry.group(sp.group) : null;
      const groupOpens = group ? opens(await tenancy.effective(identity, { type: "group", id: group.id })) : false;
      const list = await home.spaceBoards(identity, sp.id, { can: true });
      const manage = sp.kind !== "personal" && may(a, "members.manage");
      return { space: spaceView(sp, groupOpens ? group : null), can: { createBoard: createsBoards(a), rename: manage, general: manage }, boards: list.results, more: list.more };
    },

    /** GET /groups/:id: its Spaces (all of them open to anyone who opens the Group), 100 a page. */
    async groupPage(identity, id, after = null) {
      const unit = await unitOf(identity);
      const sc = await scopeOf(identity, unit, "group", id);
      if (!sc || !opens(sc.access)) throw missing();
      const { row: g, access: a } = sc;
      if (after !== null && !idOf(after)) throw bad("bad cursor");
      const page = await registry.spacesIn(g.id, { after, limit: LIMITS.groupSpaces });
      const spaces = page.spaces.map(s => ({ id: s.id, name: s.name, general: s.generalRole ?? null }))
        .sort((x, y) => (x.name.toLowerCase() < y.name.toLowerCase() ? -1 : x.name.toLowerCase() > y.name.toLowerCase() ? 1 : x.id < y.id ? -1 : 1));
      return { group: { id: g.id, name: g.name, general: g.generalRole ?? null }, can: { createSpace: may(a, "space.create"), rename: may(a, "members.manage"), general: may(a, "members.manage") }, spaces, next: page.next };
    },

    /**
     * PATCH /spaces/:id and /groups/:id: rename and/or change general access; needs `members.manage` there. A personal space refuses both
     * (its name and privacy are its owner's own). A general-access change tells every board it reaches.
     * @param {Identity} identity @param {"space"|"group"} type @param {string} id @param {{ name?: string, general?: string|null }} patch
     */
    async update(identity, type, id, patch) {
      if (patch.name === undefined && patch.general === undefined) throw bad("nothing to change");
      const name = patch.name !== undefined ? nameOf(patch.name) : undefined;
      const gen = patch.general !== undefined ? generalOf(patch.general) : undefined;
      const unit = await unitOf(identity);
      const sc = await scopeOf(identity, unit, type, id);
      if (!sc || !may(sc.access, "members.manage")) throw refused();
      if (sc.row.kind === "personal") throw refused();      // its name and privacy are its owner's own; the same 403 as any refusal, so nothing says which Space is personal
      const out = await registry.updateScope({ type, id: sc.row.id }, { ...(name !== undefined ? { name } : {}), ...(gen !== undefined ? { generalRole: gen } : {}) });
      if (gen !== undefined) announceLater(unit, { type, id: sc.row.id });
      // Names are access: someone who may manage a scope without opening it (a Unit admin, while admin board content is off) learns only what they
      // just sent, never the name they did not set.
      if (!opens(sc.access)) return { id: out.id, ...(name !== undefined ? { name } : {}), ...(gen !== undefined ? { general: gen } : {}) };
      if (type === "group") return { id: out.id, name: out.name, general: out.generalRole ?? null };
      const g = out.group ? await registry.group(out.group) : null;
      return spaceView(out, g && opens(await tenancy.effective(identity, { type: "group", id: g.id })) ? g : null);
    },

    /**
     * POST /groups: a Group at the Unit root; needs `group.create` there. The creator becomes its owner. General access defaults to none.
     * @param {Identity} identity @param {{ name: string, general?: string|null }} o
     */
    async createGroup(identity, { name, general: gen = null } = {}) {
      const n = nameOf(name);
      generalOf(gen);
      const unit = await unitOf(identity);
      if (!unit || !may(await tenancy.effective(identity, { type: "unit", id: unit.id }), "group.create")) throw refused();
      const g = await registry.createGroup({ tenant: unit.id, name: n, generalRole: gen, owner: identity.user });
      return { id: g.id, name: g.name, general: g.generalRole ?? null };
    },

    /** Wait for the announcements started by earlier changes (tests; a shutdown). */
    settled: () => Promise.all([...running.values()].map(s => s.done)).then(() => {}),

    /** PATCH /boards/:board: a new title; needs `board.edit` or `members.manage` on the board. Not access, so nothing is announced. */
    async renameBoard(identity, id, title) {
      const t = titleOf(title);
      const a = idOf(id) ? await tenancy.effective(identity, id, { uniform: true }) : null;
      if (!a || !(may(a, "board.edit") || may(a, "members.manage"))) throw refused();
      return registry.rename({ type: "board", id }, t);
    },
  };
}
