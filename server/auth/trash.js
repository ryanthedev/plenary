// @ts-check
// Trash and restore (PROTOCOL.md § Trash and restore, #54). Core: depends on the Registry port and `tenancy`, imports no adapter; the HTTP routes only translate.
//
// Every check is a PERMISSION read from the resolver's answer (`delete`), never a role name. A target in Trash answers `{ ladder: null, permissions: {delete?}, trashed }`
// (resolver.js), so the same `tenancy.effective` that gates every other route is the one that lets a `delete` holder through here and nobody else anywhere. Names are access (#51):
// a person, Space or Group the caller could not open is never named, and a caller with no say gets the one `forbidden`, an unknown board's answer included.

import { AdminError } from "../admin/boards.js";
import { TRASH, HOME, TEAMS } from "./registry-port.js";
import { gainContext } from "./move.js";
import { ownLadder } from "./resolver.js";
import { rank } from "./util.js";

/** What one read shows at most, and how much of the Unit's Trash a read looks at. */
export const LIMITS = Object.freeze({ items: 50, scanPages: 5, page: 100 });
const DAY = 24 * 3600_000;

const refused = () => new AdminError("forbidden", "not allowed");
const bad = m => new AdminError("bad-request", m);
const idOf = v => (typeof v === "string" && /^[\w-]{1,64}$/.test(v) ? v : null);
const plainName = id => String(id).replace(/^[a-z]+:/, "");
/** Could the caller open this target before it went to Trash (or can they open it now)? */
const could = a => (a.ladder ?? a.trashed?.ladder ?? null) != null;
/** Whole days left, rounded up: the last day reads 1, 0 only once it is due. */
const daysLeft = (at, t) => Math.max(0, Math.ceil((at + TRASH.ttlMs - t) / DAY));
/** The Registry's refusals of a restore, as the codes the route answers. */
const RESTORE_CODES = { "would-escalate": "restoring into your personal space would give you a higher role on the board than you hold", "with-space": "the board went to Trash with its Space: restore the Space", "space-in-trash": "the board's Space is in Trash: restore the Space first", purged: "it is being deleted for good" };

/**
 * @param {{ registry: import("./registry-port.js").Registry, tenancy: ReturnType<typeof import("./tenancy.js").tenancy>,
 *   spaces: Pick<ReturnType<typeof import("./spaces.js").spaceService>, "announceChange">, now?: () => number }} deps
 */
export function trashService({ registry, tenancy, spaces, now = Date.now }) {
  /** The board, the caller's access and their Unit, if they hold `delete` on it; else `forbidden` (unknown board, another Unit's, a guest and a caller with no say: one answer after the same reads). */
  async function deleter(identity, boardId) {
    const id = idOf(boardId);
    if (!id) throw refused();
    const [unit, row, access] = await Promise.all([tenancy.tenantOf(identity), registry.board(id), tenancy.effective(identity, id, { uniform: true })]);
    if (!unit || !row || row.tenant !== unit.id || !access.permissions.has("delete")) throw refused();
    return { unit, row, access };
  }
  // A board in a personal space is its owner's: the resolver gives `delete` there only to the owner, board-scope sources and a content-access admin (never a manage-only admin), so `delete` alone is the whole check (TECH-DEBT row 67).
  /** The Space, the caller's access and their Unit, if they hold `delete` on it and it is not personal. */
  async function spaceDeleter(identity, spaceId) {
    const id = idOf(spaceId);
    if (!id) throw refused();
    const [unit, row, access] = await Promise.all([tenancy.tenantOf(identity), registry.space(id), tenancy.effective(identity, { type: "space", id })]);
    if (!unit || !row || row.tenant !== unit.id || row.kind === "personal" || !access.permissions.has("delete")) throw refused();
    return { unit, row, access };
  }
  /** `{ id, name?, personal }` of a Space; the name only when the caller could open it. */
  async function spaceView(identity, id) {
    const [row, access] = await Promise.all([registry.space(id), tenancy.effective(identity, { type: "space", id })]);
    return row ? { id: row.id, ...(could(access) ? { name: row.name, personal: row.kind === "personal" } : {}) } : { id };
  }
  /** Names for user ids (the Unit's directory), by id. */
  async function namesOf(unit, ids) {
    const out = new Map(), want = [...new Set(ids.filter(Boolean))];
    for (let i = 0; i < want.length; i += TEAMS.among) for (const r of await registry.membersAmong(unit.id, want.slice(i, i + TEAMS.among))) out.set(r.user, r.name ?? plainName(r.user));
    return id => (id ? { id, name: out.get(id) ?? plainName(id) } : null);
  }
  const clockOf = at => ({ trashedAt: at, expiresAt: at + TRASH.ttlMs });
  /** The board as the caller may name it: its title only if they could open it before it went to Trash (names are access, #51); a manager who could not gets `{ id }`. */
  const boardOut = (row, space, access) => ({ id: row.id, ...(could(access) ? { title: row.title } : {}), space });
  /** The count a keyed Space call stored in its ref (`<space>:trashed:<n>`, `<space>:restored:<n>`); 0 for an older or a no-op ref. */
  const countOf = ref => Number(/:(?:trashed|restored):(\d+)$/.exec(String(ref))?.[1] ?? 0);
  /**
   * Where Restore puts an own-clock board whose Space is in Trash (J8 step 3): the caller's personal space, if their own role on the board does not rise there (#53's rule 4; no exemption: a holder of the content tier already carries the owner step). `null` = the board's Space is live (it goes back where it was); otherwise `{ space, ok }`, `ok` false = Restore would escalate.
   */
  async function destination(identity, d) {
    if (d.row.trashedWith != null || !d.row.space || (await registry.space(d.row.space))?.trashedAt == null) return null;
    // Only a lookup: nothing is written until the restore will proceed (`go` creates a missing personal space after the escalation check passed). 
    const space = await registry.personalSpace(d.unit.id, identity.user);
    // Rule 4, the per-person gain rule (move.js `gainContext`), against the board role the restorer holds WITHOUT the content tier (the tier never launders into a personal space they would own). A personal space that does not
    // exist yet will be created with its restorer as its owner: owner, a gain for anyone whose own step is lower.
    const own = ownLadder(d.access);
    return { space, ok: space ? !!(await gainContext(registry, identity, d.row.id, space.id, own, now())) : rank(own) >= rank("owner") };
  }

  const asAdminError = e => {
    if (e?.code === "moved") return new AdminError("moved", "the board has been moved since");
    if (e?.code in RESTORE_CODES) return new AdminError(e.code, RESTORE_CODES[e.code]);
    if (e?.code === "personal") return refused();
    return e;
  };

  return {
    /**
     * POST /boards/:board/trash `{ from }`: the compare-and-set (needs `delete` on the board; `from` = the Space the caller believes it is in).
     * @param {import("./idp-port.js").Identity} identity @param {string} boardId @param {{ from?: string }} body @param {import("./registry-port.js").Idem} [idem]
     */
    async trashBoard(identity, boardId, { from } = {}, idem) {
      if (!idOf(from)) throw bad("bad from");
      const d = await deleter(identity, boardId);
      let out;
      try { out = await registry.trashBoard({ board: d.row.id, from, by: identity.user, idem }); } catch (e) { throw asAdminError(e); }
      return { board: boardOut(out.board, await spaceView(identity, from), d.access), trashed: out.trashed, ...clockOf(out.board.trashedAt), undo: out.trashed ? { restore: true } : null };
    },
    /**
     * The replay of a keyed trash: the caller still holds `delete` (the resolver keeps it on a trashed board). `ref` is `<board>:trashed` or `<board>:noop`.
     * @param {any} identity
     * @param {string} boardId
     * @param {{ from?: string }} [o]
     * @param {string} [ref]
     */
    async replayTrash(identity, boardId, { from } = {}, ref = "") {
      const d = await deleter(identity, boardId);
      if (d.row.trashedAt == null) throw new AdminError("moved", "the board has been restored since");
      const trashed = String(ref).endsWith(":trashed");
      return { board: boardOut(d.row, await spaceView(identity, idOf(from) ?? d.row.space), d.access), trashed, ...clockOf(d.row.trashedAt), undo: trashed ? { restore: true } : null };
    },

    /** POST /boards/:board/restore (needs `delete` on the board). */
    async restoreBoard(identity, boardId, idem) {
      const d = await deleter(identity, boardId);
      const go = async dest => {
        if (dest && !dest.ok) throw asAdminError({ code: "would-escalate" });
        if (dest) dest.space ??= await registry.ensurePersonalSpace(d.unit.id, identity.user, { name: identity.name, email: identity.email });   // created only now: a refused restore leaves nothing behind
        return registry.restoreBoard({ board: d.row.id, idem, ...(dest ? { into: dest.space.id } : {}) });
      };
      let dest = d.row.trashedAt == null ? null : await destination(identity, d), out;
      try { out = await go(dest); }
      catch (e) {
        if (e?.code !== "space-in-trash" || dest) throw e instanceof AdminError ? e : asAdminError(e);
        // The Space went to Trash between the destination being chosen and the write (a narrow race): choose again, once, with the same no-escalation check.
        dest = await destination(identity, d);
        try { out = await go(dest); } catch (e2) { throw e2 instanceof AdminError ? e2 : asAdminError(e2); }
      }
      const moved = !!dest && out.restored;   // the answer says where it went: the caller's own personal space, which they may name
      return { board: boardOut(out.board, await spaceView(identity, out.board.space), d.access), restored: out.restored, ...(moved ? { movedTo: { id: dest.space.id, name: dest.space.name, personal: true } } : {}) };
    },
    async replayRestore(identity, boardId, ref = "") {
      const d = await deleter(identity, boardId);
      if (d.row.trashedAt != null) throw new AdminError("moved", "the board has been trashed since");
      return { board: boardOut(d.row, await spaceView(identity, d.row.space), d.access), restored: String(ref).endsWith(":restored") };
    },

    /** POST /spaces/:space/trash: the Space and every live board in it, atomically; then every board re-checks (closing open sockets). */
    async trashSpace(identity, spaceId, idem) {
      const d = await spaceDeleter(identity, spaceId);
      let out;
      try { out = await registry.trashSpace({ space: d.row.id, by: identity.user, idem }); } catch (e) { throw asAdminError(e); }
      if (out.trashed) spaces.announceChange(d.unit, { type: "space", id: d.row.id }, { revoke: true });
      return { space: { id: out.space.id, name: out.space.name }, trashed: out.trashed, boards: out.boards, ...clockOf(out.space.trashedAt), undo: out.trashed ? { restore: true } : null };
    },
    async replayTrashSpace(identity, spaceId, ref = "") {
      const d = await spaceDeleter(identity, spaceId);
      if (d.row.trashedAt == null) throw new AdminError("moved", "the Space has been restored since");
      const trashed = String(ref).includes(":trashed");
      return { space: { id: d.row.id, name: d.row.name }, trashed, boards: countOf(ref), ...clockOf(d.row.trashedAt), undo: trashed ? { restore: true } : null };
    },
    /** POST /spaces/:space/restore */
    async restoreSpace(identity, spaceId, idem) {
      const d = await spaceDeleter(identity, spaceId);
      let out;
      try { out = await registry.restoreSpace({ space: d.row.id, idem }); } catch (e) { throw asAdminError(e); }
      if (out.restored) spaces.announceChange(d.unit, { type: "space", id: d.row.id });
      return { space: { id: out.space.id, name: out.space.name }, restored: out.restored, boards: out.boards };
    },
    async replayRestoreSpace(identity, spaceId, ref = "") {
      const d = await spaceDeleter(identity, spaceId);
      if (d.row.trashedAt != null) throw new AdminError("moved", "the Space has been trashed since");
      return { space: { id: d.row.id, name: d.row.name }, restored: String(ref).includes(":restored"), boards: countOf(ref) };
    },

    /**
     * GET /boards/:board/trash: what the board URL shows. A caller who could open the board before (or holds `delete`) learns it is in Trash; who deleted it and where it was only a
     * `delete` holder; anyone else gets the one `forbidden`.
     */
    async notice(identity, boardId) {
      const id = idOf(boardId);
      if (!id) throw refused();
      const [unit, row, access] = await Promise.all([tenancy.tenantOf(identity), registry.board(id), tenancy.effective(identity, id, { uniform: true })]);
      const manage = access.permissions.has("delete") && !!row;
      if (!unit || !row || row.tenant !== unit.id || !access.trashed || !(manage || could(access))) throw refused();
      const t = now(), withSpace = row.trashedWith != null;
      /** @type {Record<string, any>} */
      const out = { board: { id: row.id, ...(could(access) ? { title: row.title } : {}) }, ...clockOf(access.trashed.at), daysLeft: daysLeft(access.trashed.at, t), canRestore: manage && !withSpace };
      if (out.canRestore) {
        const dest = await destination(identity, { unit, row, access });
        if (dest) { out.canRestore = dest.ok; if (dest.ok) out.into = dest.space ? { id: dest.space.id, name: dest.space.name, personal: true } : { id: null, name: null, personal: true }; }
      }
      if (withSpace) {
        const [sp, sa] = await Promise.all([registry.space(row.trashedWith), tenancy.effective(identity, { type: "space", id: row.trashedWith })]);
        out.via = { space: sp && (could(sa) || sa.permissions.has("delete")) ? { id: sp.id, name: sp.name } : null, canRestore: !!sp && sa.permissions.has("delete") };
      }
      if (manage) {
        const [name, space] = await Promise.all([namesOf(unit, [access.trashed.by]), spaceView(identity, row.space)]);
        const grp = row.space ? (await registry.space(row.space))?.group : null;
        const gAccess = grp ? await tenancy.effective(identity, { type: "group", id: grp }) : null;
        const g = grp && gAccess && could(gAccess) ? await registry.group(grp) : null;
        out.by = name(access.trashed.by);
        out.from = { space: "name" in space && space.name ? space : null, group: g ? { id: g.id, name: g.name } : null };
      }
      return out;
    },

    /**
     * GET /trash: the items the caller may restore (`delete` on them as resolved), newest first. Boards that went with their Space are not listed: the Space's row stands for them.
     * A bounded scan (LIMITS.scanPages pages of the Unit's Trash) returns at most LIMITS.items; `more` says something was left unread.
     * @param {import("./idp-port.js").Identity} identity
     */
    async list(identity) {
      const unit = await tenancy.tenantOf(identity);
      if (!unit) throw refused();
      const t = now(), items = [], who = [];
      let more = false;
      // Boards: each page's rows are resolved in one batch (a fixed number of statements), then the caller's `delete` decides.
      let after = null;
      for (let page = 0; ; page++) {
        const p = await registry.trashedBoards(unit.id, { after, limit: LIMITS.page });
        const got = p.boards.length ? await tenancy.accessMany(identity, p.boards.map(b => b.id).slice(0, HOME.batch)) : new Map();
        for (const b of p.boards) {
          const f = got.get(b.id);
          if (!f?.access.trashed || !f.access.permissions.has("delete")) continue;   // a personal space's boards come with `delete` only for those the resolver lets in (never a manage-only admin)
          if (items.length >= LIMITS.items) { more = true; break; }
          items.push({ type: "board", id: b.id, ...(could(f.access) ? { title: b.title } : {}), from: { space: f.spaceOpen && f.space ? { id: f.space.id, name: f.space.name, personal: f.space.kind === "personal" } : null, group: f.groupOpen && f.group ? { id: f.group.id, name: f.group.name } : null },
            by: b.trashedBy, trashedAt: b.trashedAt });
          who.push(b.trashedBy);
        }
        after = p.next;
        if (after == null || more) break;
        if (page + 1 >= LIMITS.scanPages) { more = true; break; }
      }
      // Spaces.
      after = null;
      for (let page = 0; ; page++) {
        const p = await registry.trashedSpaces(unit.id, { after, limit: LIMITS.page });
        const scopes = p.spaces.map(s => ({ type: /** @type {"space"} */ ("space"), id: s.id })).slice(0, HOME.batch);
        const got = scopes.length ? await tenancy.effectiveMany(identity, scopes) : new Map();
        const groups = [...new Set(p.spaces.map(s => s.group).filter(Boolean))].slice(0, HOME.batch);
        const gGot = groups.length ? await tenancy.effectiveMany(identity, groups.map(id => ({ type: /** @type {"group"} */ ("group"), id }))) : new Map();
        for (const s of p.spaces) {
          const a = got.get("space\n" + s.id);
          if (!a?.trashed || !a.permissions.has("delete")) continue;
          if (items.length >= LIMITS.items) { more = true; break; }
          const g = s.group && gGot.get("group\n" + s.group);
          items.push({ type: "space", id: s.id, name: s.name, group: g && could(g) ? { id: s.group } : null, boards: Math.min(s.boards ?? 0, TRASH.sizeCap), by: s.trashedBy, trashedAt: s.trashedAt });
          who.push(s.trashedBy);
        }
        after = p.next;
        if (after == null || more) break;
        if (page + 1 >= LIMITS.scanPages) { more = true; break; }
      }
      const name = await namesOf(unit, who);
      // Group names for the Space rows (the caller could open the Group).
      const gids = [...new Set(items.filter(i => i.type === "space" && i.group).map(i => i.group.id))];
      const gnames = new Map((await Promise.all(gids.map(id => registry.group(id)))).filter(Boolean).map(g => [g.id, g.name]));
      for (const i of items) if (i.type === "space" && i.group) i.group = { id: i.group.id, name: gnames.get(i.group.id) ?? null };
      items.sort((a, b) => b.trashedAt - a.trashedAt || (a.id < b.id ? -1 : 1));
      return { items: items.map(i => ({ ...i, by: name(i.by), expiresAt: i.trashedAt + TRASH.ttlMs, daysLeft: daysLeft(i.trashedAt, t) })), more };
    },
  };
}
