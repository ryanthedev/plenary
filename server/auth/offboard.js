// Leaver offboarding (PROTOCOL.md § Leaver offboarding, #55). Core: depends on the Registry port and `tenancy`, imports no adapter; the HTTP routes only translate.
//
// Three steps, in this order, each one atomic in the Registry: list what the leaver solely owns (`ownedAlone`), reassign each item (`reassignOwner`, a compare-and-set), then remove the
// person (`removeMember`, which REFUSES while anything is left, so an owner-less Space or Group cannot exist and a half-done offboarding leaves the leaver active).
// Every check is a PERMISSION read from the resolver's answer (`members.manage` at the Unit root; the owner role grantable at the item with the narrow exemption in `reassignable`, #52's no-escalation rule), never a role name.
// Board titles are never read here: a manage-only admin sees counts, not content.
// A PERSONAL space is not an item to reassign: it goes with the removal (`remove` body `to`), in the same atomic step, and only for a caller who could OPEN it (a ladder role there: its owner, or
// a holder of `content.personal`, #88). A manage-only admin can offboard everyone who has no personal space, and reassign every shared item to another member, but not read or hand over somebody's private boards.

import { AdminError } from "../admin/boards.js";
import { holdsTier, isUnitAdmin } from "./resolver.js";
import { grantable, idOf } from "./access.js";
import { RegistryError } from "./registry-port.js";
import { normEmail } from "./util.js";

/** What one page shows, and how many boards are counted per Space. */
export const LIMITS = Object.freeze({ items: 50, boards: 100 });

const refused = () => new AdminError("forbidden", "not allowed");
const bad = (m, code = "bad-request") => new AdminError(code, m);
const userIdOf = v => (typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\0\n]/.test(v) && !v.startsWith("email:") ? v : null);
const plainName = id => String(id).replace(/^[a-z]+:/, "");
const TYPES = ["space", "group"];
const NO_ROLES = new Map();
/** Board-content access on a Space: the permission to VIEW its boards (`board.view`), which only its owner or a holder of `content.personal` (the content tier, #88) has on a personal space (the resolver gives a Unit-wide role nothing else there). */
/**
 * May the caller hand out `owner` of this Space or Group (a SHARED item)? The owner permissions there and the NARROW exemption of the board-ladder limit that offboarding needs: a manage-only admin may give a leaver's item to ANOTHER live member
 * (the recipient check in `prepare`), never to themself; to themself needs the content tier. A personal space is not reassigned: it goes with the removal and needs `content.personal` (`holdsTier`).
 */
const reassignable = (a, type, admin) => !!grantable(a, "owner", type, NO_ROLES, admin);
const openable = a => !!a && a.ladder != null && a.permissions.has("board.view");
const cursorOf = v => { if (v == null) return null; if (typeof v !== "string" || v.length > 200 || !/^(space|group)\n[\w-]{1,64}$/.test(v)) throw bad("bad cursor"); return v; };

/**
 * @param {{ registry: import("./registry-port.js").Registry, tenancy: ReturnType<typeof import("./tenancy.js").tenancy>,
 *   announce?: (unit: { id: string }, scope: { type: string, id: string }, o?: { revoke?: boolean }) => void,
 *   managerOf?: (unit: { id: string }, user: string) => Promise<string|null>, forget?: (user: string) => void, now?: () => number }} deps
 *   managerOf: the seam for "their manager, if the directory knows them" (no manager field exists until SCIM / Entra sync, #36); the default knows nobody.
 *   forget: drops this node's warm role entries of a removed person at once (roleCache.forgetUser); the other nodes get the Unit-wide revocation.
 *   announce: hands a change to the announcement scheduler (spaceService.announceChange).
 */
export function offboardService({ registry, tenancy, announce = () => {}, managerOf = async () => null, forget = () => {} }) {
  /** The caller's Unit and their admin flag, if they hold `members.manage` at the Unit root; else `forbidden` (a guest, a removed member and a caller with no say are one answer). */
  async function gate(identity) {
    const unit = await tenancy.tenantOf(identity);
    if (!unit) throw refused();
    const access = await tenancy.effective(identity, { type: "unit", id: unit.id });
    if (!access.permissions.has("members.manage")) throw refused();
    return { unit, admin: isUnitAdmin(unit, identity) };
  }
  /** The leaver's directory row (404 for a person the Unit never saw). */
  async function leaverOf(unit, userId) {
    const id = userIdOf(userId);
    if (!id) throw refused();
    const row = await registry.memberState(unit.id, id);
    if (!row) throw new AdminError("not-found", "not found");
    return { ...row, name: row.name ?? plainName(id) };
  }
  const nameOf = async (unit, id) => { const r = await registry.memberState(unit.id, id); return r?.name ?? plainName(id); };

  /** The default recipient: the leaver's manager if they are a live member, else the caller (recorded in the directory first: a signed-in member always has a row). */
  async function defaultRecipient(unit, leaver, identity) {
    const m = await managerOf(unit, leaver.user).catch(() => null);
    const row = m && m !== leaver.user ? await registry.memberState(unit.id, m) : null;
    if (row && !row.removed) return { recipient: { id: row.user, name: row.name ?? plainName(row.user) }, reason: "manager" };
    let me = await registry.memberState(unit.id, identity.user);
    if (!me) { try { await registry.touchMember(unit.id, { user: identity.user, name: identity.name, email: identity.email }); } catch { /* best effort, like Home */ } me = await registry.memberState(unit.id, identity.user); }
    return { recipient: { id: identity.user, name: me?.name ?? identity.name ?? plainName(identity.user) }, reason: "remover" };
  }

  /** `{ id, name, archived, ... }` of the item as the page names it. */
  const itemView = (type, row, leaver) => ({
    type, id: row.id, personal: type === "space" && row.kind === "personal",
    name: type === "space" && row.kind === "personal" ? `${leaver.name}'s space` : row.name,
    archived: row.archivedAt != null, trashed: row.trashedAt != null,
  });

  /**
   * The checks of one reassignment, read once: the item in the caller's Unit, the caller able to hand out `owner` there (`grantable`, a Unit admin exempt from the board-role limit),
   * the recipient a live member and not the leaver. Anything but the recipient is `forbidden` (one answer for unknown, another Unit's and "may not").
   */
  async function prepare(identity, userId, body) {
    const type = body?.type, id = idOf(body?.id), to = userIdOf(body?.to);
    if (!TYPES.includes(type) || !id || !to) throw bad("bad item");
    const { unit, admin } = await gate(identity);
    const leaver = await leaverOf(unit, userId);
    const [row, access] = await Promise.all([type === "space" ? registry.space(id) : registry.group(id), tenancy.effective(identity, { type, id })]);
    if (!row || row.tenant !== unit.id) throw refused();
    if (type === "space" && row.kind === "personal") { if (!openable(access) || !holdsTier(access)) throw refused(); throw bad("a personal space is handed over with the removal", "personal"); }
    if (!reassignable(access, type, admin)) throw refused();
    if (to === identity.user && !holdsTier(access)) throw refused();               // handing a shared item to yourself is taking its content: it needs the tier (#88)
    const recipient = await registry.memberState(unit.id, to);
    if (!recipient || recipient.removed || to === leaver.user) throw bad("the recipient must be another live member of the Unit", "bad-recipient");
    return { unit, leaver, type, row, recipient: { id: recipient.user, name: recipient.name ?? plainName(recipient.user) } };
  }

  return {
    /**
     * GET /members/:user/offboarding. What the leaver solely owns, with defaults and what the caller may do.
     * @param {import("./idp-port.js").Identity} identity @param {string} userId @param {string|null} [after]
     */
    async list(identity, userId, after = null) {
      const cursor = cursorOf(after);
      const { unit, admin } = await gate(identity);
      const leaver = await leaverOf(unit, userId);
      const page = await registry.ownedAlone(unit.id, leaver.user, { after: cursor, limit: LIMITS.items });
      const rows = await Promise.all(page.items.map(i => (i.type === "space" ? registry.space(i.id) : registry.group(i.id))));
      const scopes = page.items.map(i => ({ type: i.type, id: i.id }));
      const access = scopes.length ? await tenancy.effectiveMany(identity, scopes) : new Map();
      const items = [];
      for (let k = 0; k < page.items.length; k++) {
        const { type, id } = page.items[k], row = rows[k];
        if (!row) continue;                                                     // purged between the two reads
        const a = access.get(type + "\n" + id), v = itemView(type, row, leaver);
        const may = !v.personal && reassignable(a, type, admin), handover = v.personal && openable(a) && holdsTier(a);
        if (type === "space") {                                                 // a COUNT of boards, never a title: a manage-only admin may not read what is in a personal space
          const b = await registry.boardsIn({ type: "space", id }, { limit: LIMITS.boards + 1, withTrashed: true });
          v.boards = Math.min(b.ids.length, LIMITS.boards); v.boardsCapped = b.ids.length > LIMITS.boards;
        }
        items.push({ ...v, can: v.personal ? { reassign: false, handover, why: handover ? "Goes with the removal" : "Private to its owner: needs the content.personal permission" }
          : { reassign: may, ...(may ? {} : { why: "Needs a Unit admin, or an owner of this" }) } });
      }
      const isAdmin = unit.admins.includes(leaver.user) || (!!leaver.email && unit.admins.includes("email:" + normEmail(leaver.email)));   // by id or by `email:` entry, as removeMember refuses
      const defaults = await defaultRecipient(unit, leaver, identity);
      return {
        member: { id: leaver.user, name: leaver.name, email: leaver.email ?? null, removed: leaver.removed },
        defaults, items, next: page.next, blocked: isAdmin ? "admin" : null,
        canRemove: !leaver.removed && !isAdmin && cursor == null && page.next == null && items.every(i => i.personal && i.can.handover),
      };
    },

    /**
     * POST /members/:user/offboarding/reassign `{ type, id, to }`: one item, one atomic compare-and-set.
     * @param {import("./registry-port.js").Idem} [idem]
     */
    async reassign(identity, userId, body, idem) {
      const p = await prepare(identity, userId, body);
      let out;
      try { out = await registry.reassignOwner({ scope: { type: p.type, id: p.row.id }, from: p.leaver.user, to: p.recipient.id, idem }); }
      catch (e) {
        if (e instanceof RegistryError && e.code === "bad-recipient") throw bad("the recipient must be another live member of the Unit", "bad-recipient");
        if (e instanceof RegistryError && e.code === "personal") throw bad("a personal space is handed over with the removal", "personal");
        if (/no such/.test(e?.message ?? "")) throw new AdminError("not-found", "not found");     // purged between the read and the write
        throw e;
      }
      if (out.done) announce(p.unit, { type: p.type, id: p.row.id }, { revoke: true });
      return this.view(p, out.done);
    },
    /** The replay of a keyed reassign: authorized again as the caller is now, rebuilt fresh. `ref` is `<scope id>:reassigned` or `<scope id>:noop`. */
    async replayReassign(identity, userId, body, ref = "") {
      const p = await prepare(identity, userId, body);
      return this.view(p, String(ref).endsWith(":reassigned"));
    },
    /** @private the answer of a reassignment, the item read fresh. */
    async view(p, done) {
      const row = await (p.type === "space" ? registry.space(p.row.id) : registry.group(p.row.id));
      return { item: { ...itemView(p.type, row ?? p.row, p.leaver), name: row?.name ?? p.row.name }, to: p.recipient, done };
    },

    /**
     * POST /members/:user/remove `{ to? }`: the last step. Refused (nothing changes) while the leaver still solely owns anything but a personal space; that goes with the removal to `to`
     * (required when it exists), archived, and only a caller with a ladder role on it (content access) may hand it over.
     * @param {import("./registry-port.js").Idem} [idem]
     */
    async remove(identity, userId, body, idem) {
      const { unit } = await gate(identity);
      const leaver = await leaverOf(unit, userId);
      if (leaver.user === identity.user) throw bad("you cannot remove yourself");
      const personal = await registry.personalSpace(unit.id, leaver.user);
      let handover;
      if (personal && !leaver.removed) {
        const access = await tenancy.effective(identity, { type: "space", id: personal.id });
        if (!openable(access) || !holdsTier(access)) throw refused();
        const to = userIdOf(body?.to), rec = to && await registry.memberState(unit.id, to);
        if (!rec || rec.removed || to === leaver.user) throw bad("the new owner of their personal space must be another live member of the Unit", "bad-recipient");
        handover = { to, name: `${leaver.name}'s space (archived)`.slice(0, 200) };
      }
      let out;
      try { out = await registry.removeMember({ tenant: unit.id, user: leaver.user, by: identity.user, ...(handover ? { handover } : {}), idem }); }
      catch (e) {
        if (e instanceof RegistryError && (e.code === "still-owns" || e.code === "is-admin")) throw new AdminError(e.code, e.message);
        if (e instanceof RegistryError && e.code === "bad-recipient") throw bad("the new owner of their personal space must be another live member of the Unit", "bad-recipient");
        if (/no such/.test(e?.message ?? "")) throw new AdminError("not-found", "not found");
        throw e;
      }
      // The leaver's sockets: everything of the Unit is re-checked as a revocation (never dropped); HTTP stopped at once (`tenantOf`).
      if (out.removed) { forget(leaver.user); announce(unit, { type: "unit", id: unit.id }, { revoke: true }); }
      return out;
    },
    /** The replay of a keyed remove: the same checks, the counts are not stored (null). `ref` is `<user>:removed` or `<user>:noop`. */
    async replayRemove(identity, userId, ref = "") {
      const { unit } = await gate(identity);
      const leaver = await leaverOf(unit, userId);
      return { removed: String(ref).endsWith(":removed"), grants: null, scopedGrants: null, teams: null, member: { id: leaver.user, name: leaver.name } };
    },
    nameOf,
  };
}
