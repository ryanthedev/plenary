// @ts-check
// Admin functions: invite / share-link / grant management, as plain functions (HTTP wiring: server/auth/http.js). Board creation is
// server/auth/spaces.js (`board.create` at a Space, or the personal space). A hello never creates a board.
//
// Who may do what:
//   invites and links:      whoever holds the `members.manage` PERMISSION on the board (its owner, a Unit admin, a custom role that carries it;
//                           never a role name: PROTOCOL.md § Share dialog). They need `tenancy` in the deps.
//   grants:                 a tenant admin sets any role, owner included. A board owner sets roles up to editor,
//                           and may change an owner's grant only if it is their own. Nobody removes or demotes a
//                           board's last owner (code `last-owner`; the Registry enforces it atomically too).
// Refusals throw AdminError. For anything naming a board, an unknown board and a caller without rights get the
// same `forbidden` error, so existence doesn't leak.

import { ROLES, LINK_ROLES, INVITE_ROLES, normEmail, verifiedEmail, isTenantAdminRecord } from "../auth/util.js";
import { isUnitAdmin, ladderExempt, ownLadder } from "../auth/resolver.js";
import { withinLadder } from "../auth/permissions.js";
import { hashPasscode, validateSharePolicy, checkLinkPolicy } from "../auth/share-policy.js";

/** @typedef {import("../../ports/registry.js").Registry} Registry */
/** @typedef {import("../../ports/idp.js").Identity} Identity */

export class AdminError extends Error {
  /**
   * @param {"forbidden"|"bad-request"|"not-found"|"last-owner"|"last-admin"|"removed"|"unknown-person"|"bad-role"|"too-large"|"in-use"|"confirm-required"|"rate-limited"|"moved"|"with-space"|"space-in-trash"|"purged"|"would-escalate"|"limit"|"personal"|"bad-recipient"|"is-admin"|"still-owns"|"superseded"} code
   * @param {string} [message]
   * @param {{ cause?: unknown, data?: Record<string, any> }} [extra]  `data`: fields the HTTP answer adds (`in-use`, `confirm-required`)
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    if (extra.cause !== undefined) this.cause = extra.cause;
    if (extra.data !== undefined) this.data = extra.data;
  }
}
const forbidden = () => new AdminError("forbidden", "not allowed");
const bad = m => new AdminError("bad-request", m);

/** Is the caller an admin of the tenant? The rule is the resolver's (server/auth/resolver.js, isUnitAdmin). */
async function isTenantAdmin(registry, caller, tenantId) {
  if (!caller || typeof caller.user !== "string" || typeof tenantId !== "string") return false;
  return liveAdmin(registry, await registry.tenant(tenantId), caller);
}
/** `isUnitAdmin` (or personal-tenant `isTenantAdminRecord`) for a person the Unit has NOT removed: a removed person is never an admin, whatever the admin list says (PROTOCOL.md § Leaver offboarding). Every admin check outside the resolver goes through this. */
export async function liveAdmin(registry, unit, caller) {
  if (!unit || (!isUnitAdmin(unit, caller) && !isTenantAdminRecord(unit, caller))) return false;
  return !(await registry.memberState?.(unit.id, caller.user))?.removed;
}

/** The board, if the caller may manage it; else throws `forbidden` (unknown board included). */
async function managed(registry, caller, boardId, tenancy = null) {
  if (!caller || typeof caller.user !== "string" || typeof boardId !== "string") throw forbidden();
  const b = await registry.board(boardId);
  if (!b || b.trashedAt != null) throw forbidden();   // a board in Trash has no management but Restore (PROTOCOL.md § Trash and restore)
  if ((await registry.grant(b.id, caller.user)) === "owner") return b;
  if (await isTenantAdmin(registry, caller, b.tenant)) {
    // A personal space's boards are their owner's: an admin manages one only where the resolver says they hold board content there (never merely by being an admin), TECH-DEBT row 67.
    if ((await registry.space(b.space))?.kind !== "personal") return b;
    if (tenancy && (await tenancy.effective(caller, b.id, { uniform: true })).permissions.has("members.manage")) return b;
  }
  throw forbidden();
}

/** Strict board-owner check (unknown board or non-owner throws `forbidden`). */
async function requireOwner(registry, caller, boardId) {
  if (!caller || typeof caller.user !== "string" || typeof boardId !== "string") throw forbidden();
  const b = await registry.board(boardId);
  if (!b || b.trashedAt != null) throw forbidden();
  if ((await registry.grant(b.id, caller.user)) === "owner") return b;
  throw forbidden();
}

// Control characters (C0, DEL, C1), line/paragraph separators, and bidi control characters (keeps ZWJ/emoji intact).
const CONTROL = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/u;
const UPDATE_TITLE_MAX = 120;

/**
 * May a NEW direct grant on `board` name `user`? Only a person the server has reason to know on this board: one in the board's Unit's directory (or an admin
 * of it named by id), one who already holds a grant here, or one who redeemed a link of this board (a guest the owner shared with). Never an `email:` entry,
 * never another Unit's member or an id nobody has seen. One rule for both routes that write a person's board grant (PROTOCOL.md § Teams and access).
 * @param {Registry} registry @param {{ id: string, tenant: string }} board @param {string} user
 */
export async function knownOnBoard(registry, board, user) {
  if (typeof user !== "string" || !user || user.length > 200 || /[\0\n]/.test(user) || user.startsWith("email:")) return false;
  if (await registry.grant(board.id, user)) return true;
  if ((await registry.membersAmong(board.tenant, [user])).some(m => !m.removed)) return true;   // a person the Unit removed gets no NEW grant (PROTOCOL.md § Leaver offboarding)
  if ((await registry.tenant(board.tenant))?.admins?.includes(user) && !(await registry.memberState(board.tenant, user))?.removed) return true;
  return (await registry.linkUses(board.id, user)).length > 0;
}

/**
 * The board, the caller's access to it and whether they are a Unit admin, if the caller holds `members.manage` on it (read from `tenancy.effective`, the answer every other
 * route reads: no second rule); else `forbidden`. An unknown board, another Unit's board and a caller with no say are one answer, after the same reads.
 */
async function sharer({ registry, tenancy }, caller, boardId) {
  if (!caller || typeof caller.user !== "string" || typeof boardId !== "string") throw forbidden();
  const [b, access] = await Promise.all([registry.board(boardId), tenancy.effective(caller, boardId, { uniform: true })]);
  if (!b || !access.permissions.has("members.manage")) throw forbidden();
  const unit = await registry.tenant(b.tenant);
  return { b, access, unit, admin: await liveAdmin(registry, unit, caller) };
}
/**
 * May this access hand out board role `role`? Nobody gives more than they hold WITHOUT the content tier (`ownLadder`); a holder of the tier at this board (`content.shared`, or `content.personal` on a personal one: `holdsTier`) is exempt.
 * A Unit admin without the tier is held to their own ladder like anyone (#88).
 */
const givable = (access, role) => withinLadder(ownLadder(access), role, ladderExempt(access));
/** `forbidden` unless `givable`. */
const mayGive = (s, role) => { if (!givable(s.access, role)) throw forbidden(); };

/** An invite's life when the request names none (JOURNEY J6); `null`, sent on purpose, is "never". */
export const INVITE_TTL_MS = 30 * 86_400_000;
/** Is `email` outside the Unit (none of its domains)? Such a person is a guest: they hold this board only, and never `owner` (INVITE_ROLES stops at editor). */
export const isGuestEmail = (email, unit) => !(unit?.domains ?? []).some(d => email.endsWith("@" + String(d).toLowerCase()));

/** An invite with its `guest` tag (the same answer the share read gives), so a create's answer needs no second read. */
const tagged = async (registry, board, invite) => ({ ...invite, guest: isGuestEmail(invite.email, await registry.tenant(board.tenant)) });

/** How far ahead an invite or link may expire: ten years. The same check for every adapter (a fraction or 1e300 would be stored differently, or not at all). */
export const MAX_EXPIRY_MS = 10 * 365 * 86_400_000;
const expiry = (v, now) => {
  if (v == null) return null;
  if (!Number.isSafeInteger(v) || v <= now) throw bad("expiresAt must be a whole number of ms in the future, at most 10 years ahead");
  if (v > now + MAX_EXPIRY_MS) throw bad("expiresAt may be at most 10 years ahead");
  return v;
};

async function recordAudit(registry, entry) {
  if (typeof registry.appendAudit === "function") await registry.appendAudit(entry);
}

/**
 * GET /boards. Lists every board in `tenant` the caller has access to (with effective role) plus `isAdmin`.
 * @param {{ caller: Identity, tenant: string }} req
 * @param {{ registry: Registry, now?: () => number }} deps
 */
export async function listBoards({ caller, tenant }, { registry, now = Date.now }) {
  if (!caller || typeof caller.user !== "string" || typeof tenant !== "string") return { boards: [], isAdmin: false };
  const t = await registry.tenant(tenant);
  const removed = Boolean((await registry.memberState?.(tenant, caller.user))?.removed);
  const isAdmin = removed ? false : await liveAdmin(registry, t, caller);
  const vEmail = verifiedEmail(caller);
  const isDomainMember = !removed && Boolean(t && caller.domain && (t.domains?.includes(caller.domain) || (t.domain && t.domain === caller.domain)));
  let isEmailMember = false;
  if (t && !removed && !isAdmin && !isDomainMember && vEmail) {
    if (typeof registry.isTenantMember === "function") isEmailMember = await registry.isTenantMember(tenant, vEmail);
    else if (typeof registry.tenantMembers === "function") isEmailMember = (await registry.tenantMembers(tenant)).includes(vEmail);
  }
  const isMember = Boolean(isDomainMember || isAdmin || isEmailMember);
  const email = caller.emailVerified === false ? null : (caller.email ?? null);
  const boards = await registry.listBoardsFor(tenant, caller.user, { email, isMember, at: now() });
  return { boards, isAdmin };
}

/**
 * POST /boards (admin/personal-org path). The caller must be an admin of `tenant`. Ensures the caller's personal space
 * when `space` is omitted, creates the board with the caller as owner, and logs `board.create`.
 * @param {{ caller: Identity, tenant: string, title?: string, memberRole?: string|null, space?: string|null }} req
 * @param {{ registry: Registry, now?: () => number }} deps
 */
export async function createBoard({ caller, tenant, title = "", memberRole = "viewer", space = null }, { registry, now = Date.now }) {
  if (!(await isTenantAdmin(registry, caller, tenant))) throw forbidden();
  if (memberRole !== null && (!ROLES.includes(memberRole) || memberRole === "owner")) throw bad("bad memberRole");
  if (typeof title !== "string" || title.length > 200) throw bad("bad title");
  if (space != null) {
    const sp = await registry.space(space);
    if (!sp || sp.tenant !== tenant || sp.trashedAt != null) throw bad("no such space");
    if (sp.kind === "personal" && sp.owner !== caller.user) throw forbidden();
  }
  let targetSpace = space;
  if (targetSpace == null) {
    if (memberRole !== null && typeof registry.spaces === "function") {
      const existing = (await registry.spaces(tenant)).find(s => s.kind !== "personal" && s.trashedAt == null);
      targetSpace = existing ? existing.id : (await registry.createSpace({ tenant, name: "General", generalRole: null })).id;
    } else {
      targetSpace = (await registry.ensurePersonalSpace(tenant, caller.user, { name: caller.name, email: caller.email })).id;
    }
  }
  const board = await registry.createBoard({ tenant, title, memberRole: /** @type {import("../../ports/registry.js").Role | null} */ (memberRole), space: targetSpace, owner: caller.user });
  await recordAudit(registry, {
    tenant: board.tenant,
    board: board.id,
    actor: caller.user,
    action: "board.create",
    target: board.id,
    detail: { title: board.title, memberRole: board.memberRole },
    at: now(),
  });
  return board;
}

/**
 * PATCH /boards/:board. Board owner only; unknown board or non-owner throws `forbidden`.
 * Validates non-empty patch (`title` and/or `memberRole`), trims/caps `title` (<= 120 chars, no control/bidi),
 * normalizes `memberRole` (`"none"` / `null` -> `null`, or viewer|commenter|annotator|editor), and logs `board.update`.
 * @param {{ caller: Identity, board: string, title?: unknown, memberRole?: unknown }} req
 * @param {{ registry: Registry, now?: () => number }} deps
 */
export async function updateBoard({ caller, board, title, memberRole }, { registry, now = Date.now }) {
  const b = await requireOwner(registry, caller, board);
  const hasTitle = title !== undefined;
  const hasRole = memberRole !== undefined;
  if (!hasTitle && !hasRole) throw bad("nothing to update");
  /** @type {{ title?: string, memberRole?: import("../../ports/registry.js").Role | "none" | null }} */
  const patch = {};
  if (hasTitle) {
    if (typeof title !== "string" || CONTROL.test(title)) throw bad("bad title");
    const trimmed = title.trim();
    if (trimmed.length > UPDATE_TITLE_MAX) throw bad("bad title");
    patch.title = trimmed;
  }
  if (hasRole) {
    if (!(await isTenantAdmin(registry, caller, b.tenant))) throw forbidden();
    if (memberRole === null || memberRole === "none") patch.memberRole = null;
    else if (typeof memberRole === "string" && INVITE_ROLES.includes(memberRole)) patch.memberRole = /** @type {import("../../ports/registry.js").Role} */ (memberRole);
    else throw bad("bad memberRole");
  }
  const updated = await registry.updateBoard(b.id, patch);
  if (!updated) throw forbidden();
  await recordAudit(registry, {
    tenant: updated.tenant,
    board: updated.id,
    actor: caller.user,
    action: "board.update",
    target: updated.id,
    detail: { title: updated.title, memberRole: updated.memberRole },
    at: now(),
  });
  return updated;
}

/**
 * DELETE /boards/:board. Board owner only; unknown board or non-owner throws `forbidden`.
 * Writes `board.delete` audit only after `deleteBoard` succeeds (reg_audit.board has no FK, so tenant & board ID are preserved).
 * @param {{ caller: Identity, board: string }} req
 * @param {{ registry: Registry, now?: () => number }} deps
 */
export async function deleteBoard({ caller, board }, { registry, now = Date.now }) {
  const b = await requireOwner(registry, caller, board);
  const deleted = await registry.deleteBoard(b.id);
  if (!deleted) throw forbidden();
  await recordAudit(registry, {
    tenant: b.tenant,
    board: b.id,
    actor: caller.user,
    action: "board.delete",
    target: b.id,
    detail: { title: b.title },
    at: now(),
  });
}

/** Give a user an explicit role on a board (or remove it with null). See the rules at the top. */
export async function setGrant({ caller, board, user, role }, { registry, tenancy = null, now = Date.now }) {
  const b = await managed(registry, caller, board, tenancy);
  if (role !== null && !ROLES.includes(role)) throw bad("bad role");
  if (typeof user !== "string" || !user) throw bad("bad user");
  // A holder of the content tier at this board is exempt from the ladder limit (#88); everyone else, a Unit admin included, gives at most their own role and never `owner`.
  const access = tenancy ? await tenancy.effective(caller, b.id, { uniform: true }) : null;
  const exempt = access ? ladderExempt(access) : await isTenantAdmin(registry, caller, b.tenant);
  const current = await registry.grant(b.id, user);
  if (!exempt) {
    if (role === "owner") throw forbidden();
    if (current === "owner" && user !== caller.user) throw forbidden();
    if (access && role !== null && !givable(access, role)) throw forbidden();
  }
  // Refusals by rank come first (a non-admin gives no owner to anyone); then who a NEW grant may name.
  if (role !== null && current == null && !(await knownOnBoard(registry, b, user))) throw new AdminError("unknown-person", "that person is not known on this board");
  if (current === "owner" && role !== "owner") {
    const owners = (await registry.grants(b.id)).filter(g => g.role === "owner");
    if (owners.length <= 1) throw new AdminError("last-owner", "a board keeps at least one owner");
  }
  // The check above is a fast path; the Registry re-checks atomically, which settles concurrent calls.
  try { await registry.setGrant(b.id, user, role); }
  catch (err) {
    if (err?.code === "last-owner") throw new AdminError("last-owner", "a board keeps at least one owner");
    throw err;
  }
  await recordAudit(registry, {
    tenant: b.tenant,
    board: b.id,
    actor: caller.user,
    action: "grant.set",
    target: user,
    detail: { role, previousRole: current },
    at: now(),
  });
  // The person now holds access they may have asked for (PROTOCOL.md § Access explanation and requests): close the request. Best effort.
  if (role !== null) await registry.closeAccessRequest?.({ type: "board", id: b.id }, user, "granted").catch(() => {});
}

/** Invite an email to a board. Works across domains. */
export async function createInvite({ caller, board, email, role, expiresAt, idem }, deps) {
  const { registry, now = Date.now } = deps;
  const s = await sharer(deps, caller, board), b = s.b;
  const e = normEmail(email);
  if (!e || !/^[^@\s]+@[^@\s]+$/.test(e) || e.length > 320) throw bad("bad email");
  if (!INVITE_ROLES.includes(role)) throw bad("bad role");
  mayGive(s, role);
  const invite = await registry.createInvite({ board: b.id, email: e, role, expiresAt: expiresAt === undefined ? now() + INVITE_TTL_MS : expiry(expiresAt, now()), by: caller.user, idem });
  await recordAudit(registry, {
    tenant: b.tenant,
    board: b.id,
    actor: caller.user,
    action: "invite.create",
    target: invite.id,
    detail: { email: invite.email, role: invite.role, expiresAt: invite.expiresAt },
    at: now(),
  });
  return tagged(registry, b, invite);
}
/** One live invite of a board the caller manages (the replay of a keyed create: PROTOCOL.md "Idempotent creates"); else `forbidden`, or `not-found` for a missing, revoked or expired one. */
export async function readInvite({ caller, board, invite }, deps) {
  const { registry, now = Date.now } = deps;
  const s = await sharer(deps, caller, board), b = s.b;
  const i = await registry.invite(invite);
  if (!i || i.board !== b.id || i.revoked || (i.expiresAt != null && i.expiresAt <= now())) throw new AdminError("not-found", "not found");   // a revoked or expired one is gone: 404, not a 201
  return tagged(registry, b, i);
}
export async function listInvites({ caller, board }, deps) {
  const s = await sharer(deps, caller, board), b = s.b;
  return deps.registry.invites(b.id);
}
/** Revoke is idempotent: a revoked, expired or repeated one answers as the first did. Another board's invite and an unknown one are `forbidden`. */
export async function revokeInvite({ caller, board, invite }, deps) {
  const { registry, now = Date.now } = deps;
  const s = await sharer(deps, caller, board), b = s.b;
  const i = await registry.invite(invite);
  if (!i || i.board !== b.id) throw forbidden();
  await registry.revokeInvite(i.id);
  await recordAudit(registry, {
    tenant: b.tenant,
    board: b.id,
    actor: caller.user,
    action: "invite.revoke",
    target: i.id,
    detail: { email: i.email, role: i.role },
    at: now(),
  });
}

/** Make a share link: an unguessable id, a role (editor, annotator or viewer), optional expiry, passcode and noDownload policy. */
export async function createLink({ caller, board, role, expiresAt = null, passcode = null, noDownload = false, idem }, deps) {
  const { registry, now = Date.now } = deps;
  const s = await sharer(deps, caller, board), b = s.b;
  if (!LINK_ROLES.includes(role)) throw bad("links carry only editor, annotator or viewer");
  mayGive(s, role);
  const t = now();
  const checked = validateSharePolicy({ passcode, noDownload, expiresAt }, t);
  if (!checked.ok) throw bad("error" in checked ? checked.error : "bad share policy");
  const { policy } = /** @type {{ ok: true, policy: { passcode: string|null, noDownload: boolean, expiresAt: number|null } }} */ (checked);
  const passcodeHash = policy.passcode != null ? hashPasscode(policy.passcode) : null;
  const link = await registry.createLink({
    board: b.id,
    role,
    expiresAt: policy.expiresAt,
    passcodeHash,
    noDownload: policy.noDownload,
    by: caller.user,
    idem,
  });
  await recordAudit(registry, {
    tenant: b.tenant,
    board: b.id,
    actor: caller.user,
    action: "link.create",
    target: link.id,
    detail: {
      role: link.role,
      expiresAt: link.expiresAt,
      ...(link.hasPasscode ? { hasPasscode: true } : {}),
      ...(link.noDownload ? { noDownload: true } : {}),
    },
    at: t,
  });
  return link;
}
/** One live link of a board the caller manages (the replay of a keyed create); else `forbidden`, or `not-found` for a missing, revoked or expired one. */
export async function readLink({ caller, board, link }, deps) {
  const { registry, now = Date.now } = deps;
  const s = await sharer(deps, caller, board), b = s.b;
  const l = await registry.link(link);
  if (!l || l.board !== b.id || l.revoked || (l.expiresAt != null && l.expiresAt <= now())) throw new AdminError("not-found", "not found");   // a revoked or expired one is gone: 404, not a 201
  return l;
}
export async function listLinks({ caller, board }, deps) {
  const s = await sharer(deps, caller, board), b = s.b;
  return deps.registry.links(b.id);
}
/**
 * Evaluate a share link's policy (expiry, passcode, brute-force rate limit, noDownload) against persisted registry state.
 * Never returns plaintext passcodes or passcode hashes.
 * @param {{ link: string, passcode?: unknown }} req
 * @param {{ registry: Registry, now?: () => number, rateLimiter?: import("../auth/share-policy.js").LinkRateLimiter|null }} deps
 * @returns {Promise<{ ok: true, board: string, role: import("../../ports/registry.js").Role, policy: { noDownload: boolean, expiresAt: number|null, hasPasscode: boolean } } | { ok: false, code: "expired"|"passcode-required"|"bad-passcode"|"rate-limited", retryAfterMs?: number }>}
 */
export async function verifyLinkAccess({ link, passcode = undefined }, { registry, now = Date.now, rateLimiter = null }) {
  if (typeof link !== "string" || !link) return { ok: false, code: /** @type {const} */ ("expired") };
  const row = await registry.link(link);
  if (!row) return { ok: false, code: /** @type {const} */ ("expired") };
  const passcodeHash = row.hasPasscode ? await registry.linkPasscodeHash(row.id) : null;
  const res = checkLinkPolicy(row, { passcode, passcodeHash, now: now(), rateLimiter });
  if (!res.ok) return /** @type {{ ok: false, code: "expired"|"passcode-required"|"bad-passcode"|"rate-limited", retryAfterMs?: number }} */ (res);
  const { policy } = /** @type {{ ok: true, policy: { noDownload: boolean, expiresAt: number|null, hasPasscode: boolean } }} */ (res);
  return { ok: true, board: row.board, role: row.role, policy };
}

/** Idempotent like revokeInvite. */
export async function revokeLink({ caller, board, link }, deps) {
  const { registry, now = Date.now } = deps;
  const s = await sharer(deps, caller, board), b = s.b;
  const l = await registry.link(link);
  if (!l || l.board !== b.id) throw forbidden();
  await registry.revokeLink(l.id);
  await recordAudit(registry, {
    tenant: b.tenant,
    board: b.id,
    actor: caller.user,
    action: "link.revoke",
    target: l.id,
    detail: { role: l.role },
    at: now(),
  });
}

/** GET /boards/:board/audit. Board owner or content-tier tenant admin; unknown/cross-tenant board gives `forbidden`. */
export async function listBoardAudit({ caller, board, limit = 50, before = null }, { registry, tenancy = null }) {
  const b = await managed(registry, caller, board, tenancy);
  return registry.listAudit({ tenant: b.tenant, board: b.id, limit, before });
}

/** GET /admin/audit. Tenant admin only; optional `board` filter stays scoped to `tenant`. */
export async function listTenantAudit({ caller, tenant, board = null, limit = 50, before = null }, { registry }) {
  if (!(await isTenantAdmin(registry, caller, tenant))) throw forbidden();
  return registry.listAudit({ tenant, board, limit, before });
}

/** What one Share read lists at most of each kind (newest first); `more` says there are more. */
export const SHARE_LIST_MAX = 200;
/**
 * GET /boards/:board/share: everything the Share dialog edits, in one permission-gated read: the board's live invites (each tagged `guest` when the address is outside
 * the Unit) and share links, the Unit's domains (so the form can tag a guest before sending; `unit` is null for a caller outside the Unit, who is told per invite),
 * and the roles (no higher than the caller's own without the content tier, unless they hold it) and default life an invite or link may take. Only a
 * `members.manage` holder gets it (an invite is an address, a link is a capability): anyone else is the one `forbidden`. Revoked and expired ones are not listed.
 */
export async function shareView({ caller, board }, deps) {
  const { registry, now = Date.now } = deps;
  const s = await sharer(deps, caller, board), b = s.b;
  const [invites, links] = await Promise.all([registry.invites(b.id), registry.links(b.id)]);
  const unit = s.unit, inside = (await deps.tenancy.tenantOf(caller))?.id === b.tenant;
  const may = role => givable(s.access, role);
  const t = now();
  const live = x => !x.revoked && (x.expiresAt == null || x.expiresAt > t);
  const newest = list => list.filter(live).sort((x, y) => y.createdAt - x.createdAt || (x.id < y.id ? -1 : 1));
  const inv = newest(invites), lnk = newest(links);
  return {
    board: { id: b.id, title: b.title },
    unit: inside ? { domains: unit?.domains ?? [] } : null,
    limits: { inviteRoles: INVITE_ROLES.filter(may), linkRoles: LINK_ROLES.filter(may), inviteTtlMs: INVITE_TTL_MS },
    invites: inv.slice(0, SHARE_LIST_MAX).map(i => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt, createdAt: i.createdAt, guest: isGuestEmail(i.email, unit) })),
    links: lnk.slice(0, SHARE_LIST_MAX).map(l => ({ id: l.id, role: l.role, expiresAt: l.expiresAt, createdAt: l.createdAt, ...(l.hasPasscode ? { hasPasscode: true } : {}), ...(l.noDownload ? { noDownload: true } : {}) })),
    more: inv.length > SHARE_LIST_MAX || lnk.length > SHARE_LIST_MAX,
  };
}
