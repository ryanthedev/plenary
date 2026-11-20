// Move a board between Spaces (PROTOCOL.md § Move board, #53). Core: depends on the Registry port, `tenancy` and the Space service's destination rule, imports no adapter; the
// HTTP routes only translate.
//
// The access diff is the ENFORCING code's answer, not a second rule: the board's context and the destination's are read once, the context the board would have in the destination is
// built by the resolver's `movedContext`, and `resolveAccess` runs over both (people through `tenancy.resolveMany`, the gateway's own path). Every check is a PERMISSION read from the
// resolver's answer (`move` on the board, `board.create` at the destination), never a role name. Names are access (#51): a person, Team or container the caller may not see is never named.

import { AdminError } from "../admin/boards.js";
import { isUnitAdmin, resolveAccess, movedContext, mayMove } from "./resolver.js";
import { roleDef, withinLadder, UNIT_ROLES } from "./permissions.js";
import { LADDER_NAMES } from "./explain.js";
import { capTo, higher, ROLES, INVITE_ROLES } from "./util.js";
import { HOME, TEAMS } from "./registry-port.js";

/** What one read shows at most: entries per list, people and Teams looked at, destinations offered. */
export const LIMITS = Object.freeze({ entries: 50, people: 100, teams: 100, destinations: 100 });

const refused = () => new AdminError("forbidden", "not allowed");
const bad = m => new AdminError("bad-request", m);
const idOf = v => (typeof v === "string" && /^[\w-]{1,64}$/.test(v) ? v : null);
const plainName = id => String(id).replace(/^[a-z]+:/, "");
const roleView = r => (r ? { id: r, name: LADDER_NAMES[r] ?? r } : null);
const byName = (a, b) => (a.subject.name.toLowerCase() < b.subject.name.toLowerCase() ? -1 : a.subject.name.toLowerCase() > b.subject.name.toLowerCase() ? 1 : (a.subject.id ?? "") < (b.subject.id ?? "") ? -1 : 1);
const opens = a => a?.ladder != null;
const GHOST = "\0ghost";

/**
 * The highest board role the destination gives to ANYONE, the mover included: its Space's and Group's scoped grants and general access (rule 4, "no escalation").
 * The mover's own grants count too: a mover whose board role is below it must not become its owner by moving the board into a Space they own, or into their personal
 * space. Bounded by the mover's own board role before the move, their own role after it can never be higher. Reads every grant, hidden containers included: the answer is a
 * role, never a name.
 * @param {import("./registry-port.js").AccessContext} ctx the destination Space's context
 */
export function givenBy(ctx) {
  const roles = new Map((ctx.roles ?? []).map(r => [r.id, r]));
  let top = null;
  for (const type of ["space", "group"]) {
    const row = ctx[type];
    if (!row) continue;
    for (const g of ctx.scoped?.[type] ?? []) {
      if (UNIT_ROLES.includes(g.role)) continue;
      top = higher(top, roleDef(g.role, type, roles)?.ladder ?? null);
    }
    top = higher(top, capTo(row.generalRole, INVITE_ROLES));
  }
  return top;
}

/**
 * @param {{ registry: import("./registry-port.js").Registry, tenancy: ReturnType<typeof import("./tenancy.js").tenancy>,
 *   spaces: Pick<ReturnType<typeof import("./spaces.js").spaceService>, "createTarget"|"boardPicker">, now?: () => number }} deps
 */
export function moveService({ registry, tenancy, spaces, now = Date.now }) {
  /**
   * The board, the caller's access to it and their Unit, if they may move it (`move` on the board); else `forbidden`. An unknown board, another Unit's board, a guest and a caller
   * with no say are one answer after the same two reads, and no other read happens before it.
   */
  async function mover(identity, boardId) {
    const id = idOf(boardId);
    if (!id) throw refused();                                   // malformed: nothing to read (the id is not an existence oracle)
    const [unit, row, access] = await Promise.all([tenancy.tenantOf(identity), registry.board(id), tenancy.effective(identity, id, { uniform: true })]);
    if (!unit || !row || row.tenant !== unit.id || !mayMove(access)) throw refused();   // the one rule the welcome and the cards use too
    return { unit, row, access, admin: isUnitAdmin(unit, identity) };
  }
  /** Rules 2 to 4 for one destination: its row, the caller's access and its context; else `forbidden`. */
  async function target(identity, m, to) {
    const t = await spaces.createTarget(identity, m.unit, to);
    if (!t) throw refused();
    const ctx = await registry.accessContext({ type: "space", id: t.row.id }, { users: [identity.user] });
    if (!ctx || !withinLadder(m.access.ladder, givenBy(ctx), m.admin)) throw refused();
    return { ...t, ctx };
  }

  /** The Space `id` as the caller may name it: `{ id, name, personal }` when they can open it, else null. */
  async function openSpace(identity, unit, id) {
    if (id == null) return null;
    const [row, access] = await Promise.all([registry.space(id), tenancy.effective(identity, { type: "space", id })]);
    return row && row.tenant === unit.id && opens(access) ? { id: row.id, name: row.name, personal: row.kind === "personal" } : null;
  }

  /**
   * What Undo would be, decided AFTER the write from the board's new place: the Space it came from, if the caller can move the board now (`move` where it is now) and put a board
   * back there (rules 2 to 4, fresh reads), else null. So an offered Undo is one that would succeed now (PROTOCOL.md § Move board, "Undo").
   */
  async function undoNow(identity, boardId, from) {
    try {
      const t = await target(identity, await mover(identity, boardId), from);
      return { space: { id: t.row.id, name: t.row.name, personal: t.row.kind === "personal" } };
    } catch (e) { if (e?.code === "forbidden") return null; throw e; }
  }

  return {
    /**
     * GET /boards/:board/move: the Spaces this board may be moved into (rules 2 to 4 for each), the caller's personal space first, and where it is now (named only if they can open it).
     * @param {import("./idp-port.js").Identity} identity @param {string} boardId
     */
    async options(identity, boardId) {
      const m = await mover(identity, boardId);
      const [picked, from] = await Promise.all([spaces.boardPicker(identity), openSpace(identity, m.unit, m.row.space)]);
      const cand = picked.spaces.filter(s => s.id !== m.row.space).slice(0, HOME.batch);
      // ONE batch read settles rule 4 for every candidate (its own context holds its Space's and Group's grants).
      const ctxs = cand.length ? await registry.accessContexts(cand.map(s => ({ type: "space", id: s.id })), { users: [identity.user] }) : new Map();
      const ok = cand.filter(s => { const c = ctxs.get("space\n" + s.id); return c && withinLadder(m.access.ladder, givenBy(c), m.admin); });
      return { board: { id: m.row.id, title: m.row.title }, from: from ?? { hidden: true }, destinations: ok.slice(0, LIMITS.destinations), more: picked.more || ok.length > LIMITS.destinations };
    },

    /**
     * GET /boards/:board/move/preview?to=: the access diff (module header). Read-only.
     * @param {import("./idp-port.js").Identity} identity @param {string} boardId @param {string} to
     */
    async preview(identity, boardId, to) {
      const m = await mover(identity, boardId);
      const dst = await target(identity, m, to);                     // first: a Space the caller can't open is the one 403, whether or not the board is in it
      if (m.row.space && m.row.space === to) throw bad("the board is already there");
      const t = now();
      const board = { type: "board", id: m.row.id };
      // Phase 1 (light reads: Team members only for the caller): who is on the scopes involved. Phase 2 reads again for exactly those people.
      const ctx0 = await registry.accessContext(board, { users: [identity.user] }), boardOpen = opens(m.access);
      if (!ctx0?.board) throw refused();
      const seen = await tenancy.effectiveMany(identity, [ctx0.space && { type: "space", id: ctx0.space.id }, ctx0.group && { type: "group", id: ctx0.group.id }, dst.ctx.group && { type: "group", id: dst.ctx.group.id }].filter(Boolean));
      const see = (type, id) => !id || seen.has(type + "\n" + id) ? opens(seen.get(type + "\n" + id)) : false;
      const visible = new Set([dst.row.id]);                               // the destination Space: the caller opens it (rule 2)
      for (const [type, c] of [["space", ctx0.space], ["group", ctx0.group], ["group", dst.ctx.group]]) if (c && see(type, c.id)) visible.add(c.id);
      const hidden = [[ctx0.space, ctx0.scoped.space], [ctx0.group, ctx0.scoped.group], [dst.ctx.group, dst.ctx.scoped.group]]
        .some(([c, g]) => c && !visible.has(c.id) && (g.length > 0 || c.generalRole != null));
      const shown = s => s.scope.type === "unit" || s.scope.type === "board" || visible.has(s.scope.id);   // a source from a container the caller can't open never counts
      const topOf = a => a.sources.filter(shown).reduce((r, s) => higher(r, s.ladder), null);

      // Who is named: the board's own rows (if the caller opens the board) and the grants of the containers the caller opens.
      const users = new Set([identity.user]), teams = new Set();
      const take = list => { for (const g of list ?? []) { if (UNIT_ROLES.includes(g.role)) continue; (g.subject.type === "user" ? users : teams).add(g.subject.id); } };
      const lists = [[ctx0.space, ctx0.scoped.space], [ctx0.group, ctx0.scoped.group], [dst.ctx.space, dst.ctx.scoped.space], [dst.ctx.group, dst.ctx.scoped.group]];
      for (const [c, g] of lists) if (c && visible.has(c.id)) take(g);
      if (boardOpen) { take(ctx0.scoped.board); for (const g of await registry.grants(m.row.id)) users.add(g.user); }
      let more = users.size > LIMITS.people || teams.size > LIMITS.teams;
      const userIds = [...users].slice(0, LIMITS.people), teamIds = [...teams].slice(0, LIMITS.teams);

      const dir = new Map();
      for (let i = 0; i < userIds.length; i += TEAMS.among) for (const r of await registry.membersAmong(m.unit.id, userIds.slice(i, i + TEAMS.among))) dir.set(r.user, r);
      const domainOf = r => { const d = String(r.email ?? "").split("@")[1]?.toLowerCase(); return m.unit.domains.includes(d) ? d : m.unit.domains[0] ?? null; };
      const ident = u => (u === identity.user ? identity : { user: u, email: dir.get(u)?.email ?? null, domain: dir.has(u) ? domainOf(dir.get(u)) : null });   // a directory row is a Unit member; anyone else is not (a guest never gets general access)
      const idents = userIds.map(ident);
      // Phase 2: the same rows, now and in the destination, through the resolver (the gateway's `resolveMany` path).
      const [ctx, tctx] = await Promise.all([registry.accessContext(board, { users: userIds }), registry.accessContext({ type: "space", id: dst.row.id }, { users: userIds })]);
      if (!ctx?.board || !tctx) throw refused();
      const per = await tenancy.resolveMany(m.row.id, idents, { ctx, target: tctx });
      const ghost = { user: GHOST, domain: m.unit.domains[0] ?? null };
      const after = movedContext(ctx, tctx);
      const asTeam = (c, id) => resolveAccess({ ctx: c, teams: new Set([id]) }, ghost, t).sources.filter(s => s.kind === "team" && s.team === id);
      const every = c => resolveAccess({ ctx: c, teams: new Set() }, ghost, t).sources.filter(s => s.kind === "general" || (s.kind === "unit" && s.role === "member"));
      const top = list => list.filter(shown).reduce((r, s) => higher(r, s.ladder), null);

      const names = new Map();
      for (let i = 0; i < teamIds.length; i += TEAMS.among) for (const r of await registry.teamsAmong(m.unit.id, teamIds.slice(i, i + TEAMS.among))) names.set(r.id, r.name);
      const entries = [];
      for (const id of idents) {
        const r = per.get(`${id.user}\n${id.email ?? ""}\n${id.domain ?? ""}`);
        if (r?.before) entries.push({ subject: { type: "user", id: id.user, name: dir.get(id.user)?.name ?? plainName(id.user) }, ...(id.user === identity.user ? { self: true } : {}), before: topOf(r.before), after: topOf(r.after) });
      }
      for (const id of teamIds) entries.push({ subject: { type: "team", id, name: names.get(id) ?? "Unknown team" }, before: top(asTeam(ctx, id)), after: top(asTeam(after, id)) });
      entries.push({ subject: { type: "everyone", name: "Everyone in the organization" }, before: top(every(ctx)), after: top(every(after)) });

      const rank = r => ROLES.indexOf(r);
      const gains = [], keeps = [], loses = [];
      for (const e of entries) {
        if (e.before == null && e.after == null) continue;
        const row = { ...e, before: roleView(e.before), after: roleView(e.after) };
        (rank(e.after) > rank(e.before) ? gains : rank(e.after) < rank(e.before) ? loses : keeps).push(row);
      }
      for (const l of [gains, keeps, loses]) { l.sort(byName); if (l.length > LIMITS.entries) { l.length = LIMITS.entries; more = true; } }
      const manage = m.access.permissions.has("members.manage");
      const live = x => !x.revoked && (x.expiresAt == null || x.expiresAt > t);
      const [inv, lnk] = manage ? await Promise.all([registry.invites(m.row.id), registry.links(m.row.id)]) : [null, null];
      const from = await openSpace(identity, m.unit, m.row.space) ?? { hidden: true };
      return {
        board: { id: m.row.id, title: m.row.title }, from, to: { id: dst.row.id, name: dst.row.name, personal: dst.row.kind === "personal" },
        gains, keeps, loses, invites: inv ? inv.filter(live).length : null, links: lnk ? lnk.filter(live).length : null, hidden, more,
      };
    },

    /**
     * POST /boards/:board/move: the compare-and-set move (rules 1 to 4, then the Registry's atomic step). `from`: the Space the caller believes the board is in (required: every board has one).
     * @param {import("./idp-port.js").Identity} identity @param {string} boardId @param {{ from?: string, to?: string }} body @param {import("./registry-port.js").Idem} [idem]
     */
    async move(identity, boardId, { from, to } = {}, idem) {
      if (!idOf(from)) throw bad("bad from");
      if (!idOf(to)) throw bad("bad to");
      if (from === to) throw bad("from and to are the same Space");
      const m = await mover(identity, boardId);
      const dst = await target(identity, m, to);
      const cur = m.row.space;
      if (cur !== to && cur !== from) throw new AdminError("moved", "the board is not in the Space you moved it from");   // stale `from`: the Registry would refuse too
      let out;
      try { out = await registry.moveBoard({ board: m.row.id, from, to: dst.row.id, idem }); }
      catch (e) { if (e?.code === "moved") throw new AdminError("moved", "the board has been moved since"); throw e; }
      return { board: { id: out.board.id, title: out.board.title, space: { id: dst.row.id, name: dst.row.name } }, moved: out.moved, undo: out.moved ? await undoNow(identity, out.board.id, from) : null };
    },

    /**
     * The replay of a keyed move by the same user (the key row is per user). `ref` is the Registry's stored answer, `<board>:moved` or `<board>:noop`, so `moved` is the real first
     * answer. The caller is re-checked only as far as no leak needs: they must still be able to OPEN the destination (not `move` on the source: the board is not there any more). A board
     * that is no longer in `to` answers `moved`.
     */
    async replay(identity, boardId, { from, to } = {}, ref = "") {
      const id = idOf(boardId), unit = await tenancy.tenantOf(identity);
      const row = unit && id ? await registry.board(id) : null;
      const dst = row && row.tenant === unit.id ? await openSpace(identity, unit, to) : null;
      if (!dst) throw refused();
      if (row.space !== to) throw new AdminError("moved", "the board has been moved since");
      const moved = String(ref).endsWith(":moved");
      return { board: { id: row.id, title: row.title, space: { id: dst.id, name: dst.name } }, moved, undo: moved ? await undoNow(identity, row.id, from) : null };
    },
  };
}
