// Spaces and Groups: their pages, the New board / New space pickers, create, rename and general access (PROTOCOL.md § Spaces and
// Groups, #48). Core: depends on the Registry port, `tenancy` and the Home service, imports no adapter; the HTTP routes only translate.
//
// Every check is a PERMISSION read from the resolver's answer at the scope the request names (`tenancy.effective`), never a role name.
// Names are access: a Space or Group the person cannot open is never named, and an id that does not exist, one in another Unit and one
// that is hidden all answer alike (a read: `not-found`; a write: `forbidden`).

import { AdminError } from "../admin/boards.js";
import { resolveAccess, ladderExempt, ownLadder } from "./resolver.js";
import { ROLES, rank } from "./util.js";
import { homeService } from "./home.js";
import { explainService } from "./explain.js";

/** @typedef {import("./idp-port.js").Identity} Identity */

/** What one read shows at most, and the work each does (PROTOCOL.md § Spaces and Groups, Bounds). */
export const LIMITS = Object.freeze({ spaces: 100, groups: 50, groupSpaces: 100 });
/** Freshness fan-out: pages of `boardsIn` announced inline; a larger scope's rest waits for the timed re-check (≤ 60 s). */
/** General-access roles from least to most access (null = only people added). */
const RANK = [null, "viewer", "commenter", "annotator", "editor"];
export const ANNOUNCE = Object.freeze({ pages: 20, page: 500, par: 50, inflight: 8, perTenant: 4, repasses: 3, queue: 10_000 });
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
export function spaceService({ registry, tenancy, home = null, announce = async () => {}, now = Date.now, explainer = explainService({ registry, now }), log = { warn() {} } }) {
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
   * Announcements: after a change to what everyone in a scope gets, tell every board it reaches, off the request path.
   *  - One pass per scope at a time. A change that arrives while the scope's pass runs marks it dirty and gets another pass; the final dirty
   *    check and the removal from `running` happen in ONE synchronous continuation (no await between), so no change can land in a gap and be lost.
   *  - A scope runs at most ANNOUNCE.repasses passes back to back, then yields its slot and goes to the back of the queue.
   *  - At most ANNOUNCE.inflight scopes run at once and ANNOUNCE.perTenant of one Unit, so one Unit's burst never starves another's.
   *  - Scopes over the cap WAIT in a queue (deduped by scope) and start as slots free; none is dropped (past ANNOUNCE.queue a non-revocation is
   *    logged and left to the gateways' timed re-check, 60 s at most).
   *  - A change that reduces access (a revocation) goes to the front of the queue and has its own budget: up to twice the global cap and
   *    twice the per-Unit limit, so one Unit's flood of revocations can't starve another Unit's. It is never dropped. Its priority lasts for
   *    the pass that follows the change only.
   */
  const running = new Map();                      // scope key -> entry (a pass is in progress)
  const queue = [];                               // ordinary entries waiting for a slot, oldest first
  const revQueue = [];                            // revocations waiting for a slot, oldest first (drained before `queue`)
  let closing = false;
  const perTenant = new Map();                    // Unit id -> running count of ordinary scopes
  const perTenantRev = new Map();                 // Unit id -> running count of scopes that took a revocation slot
  let waiters = [];
  const idle = () => { if (!running.size && !queue.length && !revQueue.length) { const w = waiters; waiters = []; for (const f of w) f(); } };
  const canStart = e => (e.revoke ? running.size < ANNOUNCE.inflight * 2 && (perTenantRev.get(e.unit.id) ?? 0) < ANNOUNCE.perTenant * 2
    : running.size < ANNOUNCE.inflight && (perTenant.get(e.unit.id) ?? 0) < ANNOUNCE.perTenant);
  const bump = (m, id, d) => { const n = (m.get(id) ?? 0) + d; if (n > 0) m.set(id, n); else m.delete(id); };
  function pump() {
    while (!closing) {
      let q = revQueue, i = q.findIndex(canStart);
      if (i < 0) { q = queue; i = q.findIndex(canStart); }
      if (i < 0) break;
      const [e] = q.splice(i, 1);
      running.set(e.key, e);
      e.slotRev = e.revoke;                       // the slot's class is fixed when it starts
      bump(e.slotRev ? perTenantRev : perTenant, e.unit.id, 1);
      run(e);
    }
    idle();
  }
  async function run(e) {
    try {
      let n = 0;
      // `revoke` is cleared as each pass starts: a revoking change that lands DURING the pass sets it again (its re-pass keeps priority),
      // while an ordinary change after a revoking pass does not inherit it.
      do { e.dirty = false; e.revoke = false; await announceScope(e.unit, e.scope); } while (e.dirty && ++n < ANNOUNCE.repasses);
    } finally {
      // Same continuation as the last `e.dirty` read: nothing can set it between the check and the removal.
      running.delete(e.key);
      bump(e.slotRev ? perTenantRev : perTenant, e.unit.id, -1);
      if (e.dirty && !closing) { e.dirty = false; (e.revoke ? revQueue : queue).push(e); }       // it used its passes: back of its queue
      pump();
    }
  }
  /** @param {{ id: string }} unit @param {{ type: string, id: string }} scope @param {{ revoke?: boolean }} [o] revoke: the change reduces access */
  function announceLater(unit, scope, { revoke = false } = {}) {
    if (closing) return;
    const key = `${scope.type}\n${scope.id}`, cur = running.get(key);
    if (cur) { cur.dirty = true; cur.revoke ||= revoke; return; }
    const at = queue.findIndex(e => e.key === key);
    if (at >= 0) {
      const e = queue[at];
      if (revoke) { e.revoke = true; queue.splice(at, 1); revQueue.push(e); pump(); }     // joins the revocations, behind the older ones
      return;
    }
    if (revQueue.some(e => e.key === key)) return;
    if (!revoke && queue.length >= ANNOUNCE.queue) { try { log.warn("grants announcement queue is full; the timed re-check covers it", { scope: scope.type }); } catch {} return; }
    const e = { key, unit, scope, dirty: false, revoke };
    (revoke ? revQueue : queue).push(e);
    pump();
  }
  /** The announcement itself (never rejects). */
  async function announceScope(unit, scope) {
    let after = null, pages = 0, sent = 0;
    try {
      if (scope.type === "board") { await announce(unit.id, scope.id); return; }    // a board scope is that one board (boardsIn lists none for it)
      do {
        if (closing) break;
        const p = await registry.boardsIn(scope, { after, limit: ANNOUNCE.page, withTrashed: true });   // trashed boards too: a Space going to Trash must reach its open sockets
        for (let i = 0; i < p.ids.length && !closing; i += ANNOUNCE.par) await Promise.all(p.ids.slice(i, i + ANNOUNCE.par).map(async b => { try { await announce(unit.id, b); sent++; } catch (err) { try { log.warn("grants announcement failed", { board: b, err }); } catch {} } }));
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

  /** The `space.create` check of POST /spaces, at the Group or the Unit root: `{ g, access }` or `forbidden`. Shared with the replay of a keyed create. */
  async function spaceCreateAccess(identity, unit, group) {
    let g = null, access;
    if (group === null) access = await tenancy.effective(identity, { type: "unit", id: unit.id });
    else {
      const sc = await scopeOf(identity, unit, "group", group);
      if (!sc) throw refused();
      ({ row: g, access } = sc);
    }
    if (!may(access, "space.create")) throw refused();
    return { g, access };
  }
  /** The `board.create` check of POST /boards at a Space (personal ones are their owner's alone). Shared with the replay of a keyed create. */
  const boardCreateAccess = async (identity, unit, space) => {
    const sc = await scopeOf(identity, unit, "space", space);
    if (!sc || !createsBoards(sc.access) || (sc.row.kind === "personal" && sc.row.owner !== identity.user)) throw refused();
    return sc;
  };

  return {
    /**
     * Replays of keyed creates (PROTOCOL.md "Idempotent creates"): the key's stored answer is only a reference, and a repeat is
     * authorized AGAIN, as the create was, for the caller as they are now; then the object is read fresh. A revoked caller gets the
     * ordinary `forbidden`, never the stored answer.
     * @param {Identity} identity @param {string} id
     */
    async replayBoard(identity, id) {
      const unit = await unitOf(identity), b = unit && idOf(id) ? await registry.board(id) : null;
      if (!unit || !b || b.tenant !== unit.id || !b.space) throw refused();
      await boardCreateAccess(identity, unit, b.space);
      return b;
    },
    async replaySpace(identity, id) {
      const unit = await unitOf(identity), s = unit && idOf(id) ? await registry.space(id) : null;
      if (!unit || !s || s.tenant !== unit.id) throw refused();
      const { g, access } = await spaceCreateAccess(identity, unit, s.group ?? null);
      return spaceView(s, g && opens(access) ? g : null);
    },
    async replayGroup(identity, id) {
      const unit = await unitOf(identity), g = unit && idOf(id) ? await registry.group(id) : null;
      if (!unit || !g || g.tenant !== unit.id || !may(await tenancy.effective(identity, { type: "unit", id: unit.id }), "group.create")) throw refused();
      return { id: g.id, name: g.name, general: g.generalRole ?? null };
    },

    /**
     * POST /boards: a board in `space` (needs `board.create` there) or, with none, in the caller's personal space (always allowed).
     * The caller becomes its owner. `memberRole` absent = inherit the Space (null).
     * @param {Identity} identity @param {{ title?: string, space?: string|null, memberRole?: string|null }} o @param {import("./registry-port.js").Idem} [idem] the Idempotency-Key of a keyed create
     */
    async createBoard(identity, { title = "", space = null, memberRole } = {}, idem) {
      const t = titleOf(title);
      if (memberRole !== undefined && memberRole !== null && (!ROLES.includes(memberRole) || memberRole === "owner")) throw bad("bad memberRole");
      if (space !== null && !idOf(space)) throw bad("bad space");
      const unit = await unitOf(identity);
      if (!unit) throw refused();
      let target;
      if (space === null) target = (await registry.ensurePersonalSpace(unit.id, identity.user)).id;
      else {
        // Nobody writes into another member's personal space, an admin included (it is private until its owner shares from it).
        target = (await boardCreateAccess(identity, unit, space)).row.id;
      }
      // The board, its owner grant and the idempotency key (if any) are one Registry step: no ownerless board, no key without its board.
      return registry.createBoard({ tenant: unit.id, title: t, space: target, owner: identity.user, idem, ...(memberRole !== undefined ? { memberRole } : {}) });
    },

    /**
     * The Space `id` of `unit` when the caller may put a board there (they open it and hold `board.create`; never another member's personal space), with their access to it; else
     * null. The one rule of POST /boards and of a move's destination (PROTOCOL.md § Move board). @param {Identity} identity @param {{ id: string }} unit @param {unknown} id
     */
    async createTarget(identity, unit, id) {
      try { return await boardCreateAccess(identity, unit, id); } catch (e) { if (e?.code === "forbidden") return null; throw e; }
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
    async createSpace(identity, { name, group = null, general: gen = "viewer" } = {}, idem) {
      const n = nameOf(name);
      if (group !== null && !idOf(group)) throw bad("bad group");
      generalOf(gen);
      const unit = await unitOf(identity);
      if (!unit) throw refused();
      const { g, access } = await spaceCreateAccess(identity, unit, group);
      const s = await registry.createSpace({ tenant: unit.id, name: n, group: g?.id ?? null, generalRole: gen, owner: identity.user, idem });
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
      const can = { createBoard: createsBoards(a), rename: manage, general: manage, trash: sp.kind !== "personal" && may(a, "delete") };   // `trash`: Move to Trash (PROTOCOL.md § Trash and restore)
      // Why a control is off, from the SAME Access that decided `can` (PROTOCOL.md § Access explanation and requests); only for a caller who cannot create boards here.
      const why = can.createBoard || sp.kind === "personal" ? null : await explainer.explain(identity, { type: "space", row: sp, access: a, unit, manage });
      return { space: spaceView(sp, groupOpens ? group : null), can, ...(why ? { why } : {}), boards: list.results, more: list.more };
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
     * PATCH /spaces/:id and /groups/:id: rename and/or change general access; needs `members.manage` there, and widening general access needs a board role at least that high (without the content tier) or the tier. A personal space refuses both
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
      // General access gives every member a board role: widening it hands out a role, so no more than the caller holds without the content tier (a holder of it is exempt); narrowing never needs it (#88).
      if (gen != null && rank(gen) > rank(sc.row.generalRole ?? null) && rank(gen) > rank(ownLadder(sc.access)) && !ladderExempt(sc.access)) throw refused();
      const out = await registry.updateScope({ type, id: sc.row.id }, { ...(name !== undefined ? { name } : {}), ...(gen !== undefined ? { generalRole: gen } : {}) });
      if (gen !== undefined) announceLater(unit, { type, id: sc.row.id }, { revoke: RANK.indexOf(gen) < RANK.indexOf(sc.row.generalRole ?? null) });
      // Names are access: someone who may manage a scope without opening it (a manage-only Unit admin) learns only what they
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
    async createGroup(identity, { name, general: gen = null } = {}, idem) {
      const n = nameOf(name);
      generalOf(gen);
      const unit = await unitOf(identity);
      if (!unit || !may(await tenancy.effective(identity, { type: "unit", id: unit.id }), "group.create")) throw refused();
      const g = await registry.createGroup({ tenant: unit.id, name: n, generalRole: gen, owner: identity.user, idem });
      return { id: g.id, name: g.name, general: g.generalRole ?? null };
    },

    /** Wait for the announcements started by earlier changes (tests; a shutdown). */
    settled: () => (running.size || queue.length || revQueue.length ? new Promise(res => { waiters.push(res); }) : Promise.resolve()),

    /** Shutdown: stop starting announcements and forget the queued ones (the gateways' timed re-check covers them). Running passes finish. */
    close() { closing = true; queue.length = 0; revQueue.length = 0; idle(); },

    /** Scopes running or waiting to be announced (a caller that feeds many scopes waits while this is high). */
    backlog: () => running.size + queue.length + revQueue.length,

    /** Announce a change to what everyone in a scope gets (update() does this itself; exposed for the composition root and tests). */
    announceChange: (unit, scope, o) => announceLater(unit, scope, o),

    /** PATCH /boards/:board: a new title; needs `board.edit` or `members.manage` on the board. Not access, so nothing is announced. */
    async renameBoard(identity, id, title) {
      const t = titleOf(title);
      const a = idOf(id) ? await tenancy.effective(identity, id, { uniform: true }) : null;
      if (!a || !(may(a, "board.edit") || may(a, "members.manage"))) throw refused();
      return registry.rename({ type: "board", id }, t);
    },
  };
}
