// @ts-check
// Move a board between Spaces (PROTOCOL.md § Move board, #53). Core: depends on the Registry port, `tenancy` and the Space service's destination rule, imports no adapter; the
// HTTP routes only translate.
//
// The access diff is the ENFORCING code's answer, not a second rule: the board's context and the destination's are read once, the context the board would have in the destination is
// built by the resolver's `movedContext`, and `resolveAccess` runs over both (people through `tenancy.resolveMany`, the gateway's own path). Every check is a PERMISSION read from the
// resolver's answer (`move` on the board, `board.create` at the destination), never a role name. Names are access (#51): a person, Team or container the caller may not see is never named.

import { AdminError } from "../admin/boards.js";
import { resolveAccess, movedContext, mayMove, ownLadder } from "./resolver.js";
import { UNIT_ROLES } from "./permissions.js";
import { LADDER_NAMES } from "./explain.js";
import { higher, rank, ROLES } from "./util.js";
import { HOME, TEAMS } from "../../ports/registry.js";

/** What one read shows at most: entries per list, people and Teams looked at, destinations offered. */
export const LIMITS = Object.freeze({ entries: 50, people: 100, teams: 100, destinations: 100 });

const refused = () => new AdminError("forbidden", "not allowed");
const bad = m => new AdminError("bad-request", m);
const idOf = v => (typeof v === "string" && /^[\w-]{1,64}$/.test(v) ? v : null);
const plainName = id => String(id).replace(/^[a-z]+:/, "");
const roleView = r => (r ? { id: r, name: LADDER_NAMES[r] ?? r } : null);
const byName = (a, b) => (a.subject.name.toLowerCase() < b.subject.name.toLowerCase() ? -1 : a.subject.name.toLowerCase() > b.subject.name.toLowerCase() ? 1 : (a.subject.id ?? "") < (b.subject.id ?? "") ? -1 : 1);
const opens = a => a?.ladder != null;
/** The board as a caller may name it: its title only when they open it (names are access, #51); a manager who does not learns nothing but the id. */
const boardView = (row, access) => (opens(access) ? { id: row.id, title: row.title } : { id: row.id });
const GHOST = "\0ghost";

/** Every user the destination's Space and Group and the Unit name in a grant (whose Team memberships a move check must read), and the mover. */
const namedUsers = (identity, ctxs) => [...new Set([identity.user, ...ctxs.flatMap(c => ["space", "group", "unit"].flatMap(t => (c.scoped?.[t] ?? []).filter(g => g.subject.type === "user" && !UNIT_ROLES.includes(g.role)).map(g => g.subject.id)))])];

/**
 * Rule 4, the PER-PERSON GAIN rule (#88; PROTOCOL.md § Move board): would the move raise anyone's board role above `own`, the mover's board role WITHOUT the content tier (`ownLadder`: the tier never lets its holder hand out
 * a role, so moving a board is not a back door to it)? "Anyone" is every person, Team and everybody-in-the-Unit that the destination's Space, Group or the Unit names in a grant, general access included, and the mover.
 * Each one's role is read now and as the board would have it in the destination (`movedContext`, the preview's own `gains`), hidden containers included: the answer is a yes/no, never a name. A Unit admin without the
 * tier has no exemption. The mover's own gain is held to the same limit, so a move never raises the mover's own role either (#53). Over the limits it cannot check: refused (fail closed).
 * @param {import("../../ports/registry.js").AccessContext} ctx the board's context, read with `namedUsers`  @param {import("../../ports/registry.js").AccessContext} tctx the destination Space's context, same users
 * @param {import("../../ports/idp.js").Identity} mover @param {string|null} moverBefore the mover's board role now, without the tier  @param {string|null} own  @param {number} t
 * @returns {boolean} true = the move would hand someone a role above `own`
 */
export function raisesAbove(ctx, tctx, mover, moverBefore, own, t) {
  const users = new Set([mover.user]), teams = new Set();
  for (const c of [tctx, ctx]) for (const type of ["space", "group", "unit"]) {
    if (c === ctx && type !== "unit") continue;                    // the board's current containers only lose; the Unit's grants change meaning when a board leaves a personal space
    for (const g of c.scoped?.[type] ?? []) if (!UNIT_ROLES.includes(g.role)) (g.subject.type === "user" ? users : teams).add(g.subject.id);
  }
  if (users.size > LIMITS.people || teams.size > LIMITS.teams) return true;
  const after = movedContext(ctx, tctx), lim = rank(own), raised = (before, now) => rank(now) > rank(before) && rank(now) > lim;
  const domain = ctx.tenant?.domains?.[0] ?? null, ghost = { user: GHOST, domain };
  const ladderOf = (c, id) => ownLadder(resolveAccess({ ctx: c }, id, t));   // the content tier is nobody's grant: what a tier holder opens on their own is not a gain the move hands them
  for (const u of users) {
    const id = u === mover.user ? mover : { user: u, domain };
    if (raised(u === mover.user ? moverBefore : ladderOf(ctx, id), ladderOf(after, id))) return true;
  }
  const team = (c, id) => resolveAccess({ ctx: c, teams: new Set([id]) }, ghost, t).sources.filter(s => s.kind === "team" && s.team === id).reduce((r, s) => higher(r, s.ladder), null);
  for (const id of teams) if (raised(team(ctx, id), team(after, id))) return true;
  const every = c => resolveAccess({ ctx: c, teams: new Set() }, ghost, t).sources.filter(s => s.kind === "general" || (s.kind === "unit" && s.role === "member")).reduce((r, s) => higher(r, s.ladder), null);
  return raised(every(ctx), every(after));
}

/**
 * Rule 4 for ONE destination, read fresh (used by a move and by Trash's restore-into-the-personal-space): the destination Space's context when the move raises nobody above `own`, else null (also null when a context is gone).
 * @param {import("../../ports/registry.js").Registry} registry @param {import("../../ports/idp.js").Identity} identity @param {string} boardId @param {string} spaceId @param {string|null} own the mover's board role without the tier @param {number} t
 */
export async function gainContext(registry, identity, boardId, spaceId, own, t) {
  const first = await registry.accessContext({ type: "space", id: spaceId }, { users: [identity.user] });
  if (!first) return null;
  const users = namedUsers(identity, [first]).slice(0, LIMITS.people + 1);
  const [ctx, tctx] = await Promise.all([registry.accessContext({ type: "board", id: boardId }, { users }), registry.accessContext({ type: "space", id: spaceId }, { users })]);
  return ctx?.board && tctx && !raisesAbove(ctx, tctx, identity, own, own, t) ? tctx : null;
}

/**
 * @param {{ registry: import("../../ports/registry.js").Registry, tenancy: ReturnType<typeof import("./tenancy.js").tenancy>,
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
    return { unit, row, access };
  }
  /** Rules 2 to 4 for one destination: its row, the caller's access and its context; else `forbidden`. Rule 4 is `raisesAbove` (per-person gain), read fresh with every named person's Teams. */
  async function target(identity, m, to) {
    const t = await spaces.createTarget(identity, m.unit, to);
    if (!t || !opens(t.access)) throw refused();                  // rule 2: the destination is one the caller opens (a manage-only admin who opens none moves nothing, and learns no name)
    const tctx = await gainContext(registry, identity, m.row.id, t.row.id, ownLadder(m.access), now());
    if (!tctx) throw refused();
    return { ...t, ctx: tctx };
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
     * @param {import("../../ports/idp.js").Identity} identity @param {string} boardId
     */
    async options(identity, boardId) {
      const m = await mover(identity, boardId);
      const [picked, from] = await Promise.all([spaces.boardPicker(identity), openSpace(identity, m.unit, m.row.space)]);
      const cand = picked.spaces.filter(s => s.id !== m.row.space).slice(0, HOME.batch);
      // Rule 4 for every candidate from batch reads: their contexts for the mover, then everyone they name (one union of users), the board's context and the candidates again with those users.
      const key = s => "space\n" + s.id;
      /** @type {import("../../ports/registry.js").ScopeRef[]} */
      const refs = cand.map(s => ({ type: "space", id: s.id }));
      const first = cand.length ? await registry.accessContexts(refs, { users: [identity.user] }) : new Map();
      const users = namedUsers(identity, [...first.values()].filter(Boolean)).slice(0, LIMITS.people + 1);
      const [ctxs, bctx] = cand.length ? await Promise.all([registry.accessContexts(refs, { users }), registry.accessContext({ type: "board", id: m.row.id }, { users })]) : [new Map(), null];
      const t = now(), own = ownLadder(m.access);
      const ok = cand.filter(s => { const c = ctxs.get(key(s)); return c && bctx?.board && !raisesAbove(bctx, c, identity, own, own, t); });
      return { board: boardView(m.row, m.access), from: from ?? { hidden: true }, destinations: ok.slice(0, LIMITS.destinations), more: picked.more || ok.length > LIMITS.destinations };
    },

    /**
     * GET /boards/:board/move/preview?to=: the access diff (module header). Read-only.
     * @param {import("../../ports/idp.js").Identity} identity @param {string} boardId @param {string} to
     */
    async preview(identity, boardId, to) {
      const m = await mover(identity, boardId);
      const dst = await target(identity, m, to);                     // first: a Space the caller can't open is the one 403, whether or not the board is in it
      if (m.row.space && m.row.space === to) throw bad("the board is already there");
      const t = now();
      /** @type {import("../../ports/registry.js").ScopeRef} */
      const board = { type: "board", id: m.row.id };
      // Phase 1 (light reads: Team members only for the caller): who is on the scopes involved. Phase 2 reads again for exactly those people.
      const ctx0 = await registry.accessContext(board, { users: [identity.user] }), boardOpen = opens(m.access);
      if (!ctx0?.board) throw refused();
      /** @type {{ type: "group"|"space"|"unit", id: string }[]} */
      const seenScopes = [
        ...(ctx0.space ? [{ type: /** @type {"space"} */ ("space"), id: ctx0.space.id }] : []),
        ...(ctx0.group ? [{ type: /** @type {"group"} */ ("group"), id: ctx0.group.id }] : []),
        ...(dst.ctx.group ? [{ type: /** @type {"group"} */ ("group"), id: dst.ctx.group.id }] : []),
      ];
      const seen = await tenancy.effectiveMany(identity, seenScopes);
      const see = (type, id) => !id || seen.has(type + "\n" + id) ? opens(seen.get(type + "\n" + id)) : false;
      const visible = new Set([dst.row.id]);                               // the destination Space: the caller opens it (rule 2)
      /** @type {[string, { id: string } | null][]} */
      const visList = [["space", ctx0.space], ["group", ctx0.group], ["group", dst.ctx.group]];
      for (const [type, c] of visList) if (c && see(type, c.id)) visible.add(c.id);
      /** @type {[{ id: string, generalRole?: string | null } | null, import("../../ports/registry.js").ScopedGrant[]][]} */
      const hiddenList = [[ctx0.space, ctx0.scoped.space], [ctx0.group, ctx0.scoped.group], [dst.ctx.group, dst.ctx.scoped.group]];
      const hidden = hiddenList.some(([c, g]) => c && !visible.has(c.id) && (g.length > 0 || c.generalRole != null));
      const shown = s => s.scope.type === "unit" || s.scope.type === "board" || visible.has(s.scope.id);   // a source from a container the caller can't open never counts
      const topOf = a => a.sources.filter(shown).reduce((r, s) => higher(r, s.ladder), null);

      // Who is named: the board's own rows (if the caller opens the board) and the grants of the containers the caller opens.
      const users = new Set([identity.user]), teams = new Set();
      const take = list => { for (const g of list ?? []) { if (UNIT_ROLES.includes(g.role)) continue; (g.subject.type === "user" ? users : teams).add(g.subject.id); } };
      /** @type {[{ id: string } | null, import("../../ports/registry.js").ScopedGrant[]][]} */
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
        board: boardView(m.row, m.access), from, to: { id: dst.row.id, name: dst.row.name, personal: dst.row.kind === "personal" },
        gains, keeps, loses, invites: inv ? inv.filter(live).length : null, links: lnk ? lnk.filter(live).length : null, hidden, more,
      };
    },

    /**
     * POST /boards/:board/move: the compare-and-set move (rules 1 to 4, then the Registry's atomic step). `from`: the Space the caller believes the board is in (required: every board has one).
     * @param {import("../../ports/idp.js").Identity} identity @param {string} boardId @param {{ from?: string, to?: string }} body @param {import("../../ports/registry.js").Idem} [idem]
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
      return { board: { ...boardView(out.board, m.access), space: { id: dst.row.id, name: dst.row.name } }, moved: out.moved, undo: out.moved ? await undoNow(identity, out.board.id, from) : null };
    },

    /**
     * The replay of a keyed move by the same user (the key row is per user). `ref` is the Registry's stored answer, `<board>:moved` or `<board>:noop`, so `moved` is the real first
     * answer. The caller is re-checked only as far as no leak needs: they must still be able to OPEN the destination (not `move` on the source: the board is not there any more). A board
     * that is no longer in `to` answers `moved`.
     * @param {import("../../ports/idp.js").Identity} identity
     * @param {string} boardId
     * @param {{ from?: string, to?: string }} [o]
     * @param {string} [ref]
     */
    async replay(identity, boardId, { from, to } = {}, ref = "") {
      const id = idOf(boardId), unit = await tenancy.tenantOf(identity);
      const row = unit && id ? await registry.board(id) : null;
      const dst = row && row.tenant === unit.id ? await openSpace(identity, unit, to) : null;
      if (!dst) throw refused();
      if (row.space !== to) throw new AdminError("moved", "the board has been moved since");
      const moved = String(ref).endsWith(":moved");
      const seen = await tenancy.effective(identity, row.id, { uniform: true });
      return { board: { ...boardView(row, seen), space: { id: dst.id, name: dst.name } }, moved, undo: moved ? await undoNow(identity, row.id, from) : null };
    },
  };
}
