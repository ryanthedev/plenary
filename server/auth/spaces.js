// Spaces and Groups: their pages, the New board / New space pickers, create, rename and general access (PROTOCOL.md § Spaces and
// Groups, #48). Core: depends on the Registry port, `tenancy` and the Home service, imports no adapter; the HTTP routes only translate.
//
// Every check is a PERMISSION read from the resolver's answer at the scope the request names (`tenancy.effective`), never a role name.
// Names are access: a Space or Group the person cannot open is never named, and an id that does not exist, one in another Unit and one
// that is hidden all answer alike (a read: `not-found`; a write: `forbidden`).

import { AdminError } from "../admin/boards.js";
import { HOME } from "./registry-port.js";
import { resolveAccess } from "./resolver.js";
import { ROLES } from "./util.js";
import { homeService } from "./home.js";

/** @typedef {import("./idp-port.js").Identity} Identity */

/** What one read shows at most, and the work each does (PROTOCOL.md § Spaces and Groups, Bounds). */
export const LIMITS = Object.freeze({ spaces: 100, groups: 50, groupSpaces: 100, grantChecks: 40, groupChecks: 20, par: 8 });
/** Freshness fan-out: pages of `boardsIn` announced inline; a larger scope's rest waits for the timed re-check (≤ 60 s). */
export const ANNOUNCE = Object.freeze({ pages: 20, page: 500, par: 50 });
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
  /** The Space, if it is in the caller's Unit. */
  async function spaceIn(unit, id) {
    const s = idOf(id) ? await registry.space(id) : null;
    return s && s.tenant === unit.id ? s : null;
  }
  async function groupIn(unit, id) {
    const g = idOf(id) ? await registry.group(id) : null;
    return g && g.tenant === unit.id ? g : null;
  }
  /** `fn` over `items`, `par` at a time, in order. */
  async function mapPar(items, fn, par = LIMITS.par) {
    const out = [];
    for (let i = 0; i < items.length; i += par) out.push(...await Promise.all(items.slice(i, i + par).map(fn)));
    return out;
  }
  /** What general access alone gives, from the rows in hand (no read): enough to say yes; a "no" needs the full answer. */
  const general = (unit, identity, space, group, t) => resolveAccess({ ctx: { tenant: unit, board: null, space, group, scoped: NO_GRANTS, roles: [], teams: {} } }, identity, t);
  /** The single rule for "may create a board here" (picker and POST /boards both): the resolver's answer holds `board.create`. */
  const createsBoards = a => may(a, "board.create");
  const opens = a => a.ladder != null;

  /** After a change to what everyone in a scope gets: tell every board it reaches (bounded; the rest waits for the timed re-check). */
  async function announceScope(unit, scope) {
    let after = null, pages = 0, sent = 0;
    try {
      do {
        const p = await registry.boardsIn(scope, { after, limit: ANNOUNCE.page });
        for (let i = 0; i < p.ids.length; i += ANNOUNCE.par) await Promise.all(p.ids.slice(i, i + ANNOUNCE.par).map(async b => { try { await announce(unit.id, b); sent++; } catch (err) { log.warn("grants announcement failed", { board: b, err }); } }));
        after = p.next;
        if (after != null && ++pages >= ANNOUNCE.pages) { log.warn("grants announcement stopped at its bound; the timed re-check covers the rest", { scope: scope.type, sent }); break; }
      } while (after != null);
    } catch (err) { log.warn("grants announcement failed", { scope: scope.type, err }); }
  }

  /** The Spaces the person can open and `board.create` in (their personal space first), for the picker. */
  async function creatableSpaces(identity, unit) {
    const personal = await registry.ensurePersonalSpace(unit.id, identity.user);
    const all = opens(await tenancy.effective(identity, { type: "unit", id: unit.id }));   // a Unit-level role covers everything inside
    const cand = await registry.spaceCandidates(unit.id, { user: identity.user, all, limit: LIMITS.spaces });
    const groups = new Map(cand.groups.map(g => [g.id, g]));
    const t = now();
    let more = cand.next != null, checks = 0;
    const out = [], pending = [];
    for (const s of cand.spaces) {
      if (s.id === personal.id) continue;
      const g = s.group ? groups.get(s.group) ?? null : null;
      const fast = general(unit, identity, s, g, t);
      if (opens(fast) && createsBoards(fast)) out.push(s);
      else if (checks++ < LIMITS.grantChecks) pending.push(s);
      else more = true;
    }
    for (const r of await mapPar(pending, async s => { const a = await tenancy.effective(identity, { type: "space", id: s.id }); return opens(a) && createsBoards(a) ? s : null; })) if (r) out.push(r);
    // A Group is named only if the person can open it.
    const named = new Map();
    let gChecks = 0;
    for (const s of out) if (s.group && groups.has(s.group) && !named.has(s.group)) {
      const g = groups.get(s.group);
      if (opens(general(unit, identity, null, g, t))) named.set(g.id, g);
      else if (gChecks++ < LIMITS.groupChecks) { if (opens(await tenancy.effective(identity, { type: "group", id: g.id }))) named.set(g.id, g); }
      else more = true;
    }
    out.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.id < b.id ? -1 : 1));
    return { spaces: [spaceView(personal, null), ...out.map(s => spaceView(s, s.group ? named.get(s.group) : null))], more };
  }

  /** The Groups the person can open and `space.create` in. */
  async function creatableGroups(identity, unit) {
    const all = opens(await tenancy.effective(identity, { type: "unit", id: unit.id }));
    const root = may(await tenancy.effective(identity, { type: "unit", id: unit.id }), "space.create");
    const cand = await registry.groupCandidates(unit.id, { user: identity.user, all, limit: LIMITS.groups + 1 });
    let more = cand.length > LIMITS.groups, checks = 0;
    const t = now(), out = [], pending = [];
    for (const g of cand.slice(0, LIMITS.groups)) {
      const fast = general(unit, identity, null, g, t);
      if (opens(fast) && may(fast, "space.create")) out.push(g);
      else if (checks++ < LIMITS.groupChecks) pending.push(g);
      else more = true;
    }
    for (const r of await mapPar(pending, async g => { const a = await tenancy.effective(identity, { type: "group", id: g.id }); return opens(a) && may(a, "space.create") ? g : null; })) if (r) out.push(r);
    out.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.id < b.id ? -1 : 1));
    return { root, groups: out.map(g => ({ id: g.id, name: g.name })), more };
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
        const sp = await spaceIn(unit, space);
        if (!sp || !createsBoards(await tenancy.effective(identity, { type: "space", id: sp.id }))) throw refused();
        target = sp.id;
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
        g = await groupIn(unit, group);
        if (!g) throw refused();
        access = await tenancy.effective(identity, { type: "group", id: g.id });
      }
      if (!may(access, "space.create")) throw refused();
      const s = await registry.createSpace({ tenant: unit.id, name: n, group: g?.id ?? null, generalRole: gen, owner: identity.user });
      return spaceView(s, g && opens(access) ? g : null);
    },

    /** GET /spaces/:id. Hidden, unknown and other-Unit ids are one `not-found`. @param {Identity} identity @param {string} id */
    async spacePage(identity, id) {
      const unit = await unitOf(identity);
      const sp = unit ? await spaceIn(unit, id) : null;
      if (!sp) throw missing();
      const a = await tenancy.effective(identity, { type: "space", id: sp.id });
      if (!opens(a)) throw missing();
      const group = sp.group ? await registry.group(sp.group) : null;
      const groupOpens = group ? opens(await tenancy.effective(identity, { type: "group", id: group.id })) : false;
      const list = await home.spaceBoards(identity, sp.id, { can: true });
      const manage = sp.kind !== "personal" && may(a, "members.manage");
      return { space: spaceView(sp, groupOpens ? group : null), can: { createBoard: createsBoards(a), rename: manage, general: manage }, boards: list.results, more: list.more };
    },

    /** GET /groups/:id: its Spaces (all of them open to anyone who opens the Group), 100 a page. */
    async groupPage(identity, id, after = null) {
      const unit = await unitOf(identity);
      const g = unit ? await groupIn(unit, id) : null;
      if (!g) throw missing();
      const a = await tenancy.effective(identity, { type: "group", id: g.id });
      if (!opens(a)) throw missing();
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
      const row = unit ? await (type === "space" ? spaceIn : groupIn)(unit, id) : null;
      if (!row || !may(await tenancy.effective(identity, { type, id: row.id }), "members.manage")) throw refused();
      if (row.kind === "personal") throw bad("a personal space keeps its name and stays private");
      let out = row;
      if (name !== undefined) out = await registry.rename({ type, id: row.id }, name);
      if (gen !== undefined) {
        out = await registry.setGeneralRole({ type, id: row.id }, gen);
        await announceScope(unit, { type, id: row.id });
      }
      if (type === "group") return { id: out.id, name: out.name, general: out.generalRole ?? null };
      const g = out.group ? await registry.group(out.group) : null;
      return spaceView(out, g && opens(await tenancy.effective(identity, { type: "group", id: g.id })) ? g : null);
    },

    /** PATCH /boards/:board: a new title; needs `board.edit` or `members.manage` on the board. Not access, so nothing is announced. */
    async renameBoard(identity, id, title) {
      const t = titleOf(title);
      const a = idOf(id) ? await tenancy.effective(identity, id) : null;
      if (!a || !(may(a, "board.edit") || may(a, "members.manage"))) throw refused();
      return registry.rename({ type: "board", id }, t);
    },
  };
}
