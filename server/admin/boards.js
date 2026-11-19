// Admin functions: invite / share-link / grant management, as plain functions (HTTP wiring: server/auth/http.js). Board creation is
// server/auth/spaces.js (`board.create` at a Space, or the personal space). A hello never creates a board.
//
// Who may do what:
//   invites and links:      the board's owner (grant) or an admin of the board's tenant.
//   grants:                 a tenant admin sets any role, owner included. A board owner sets roles up to editor,
//                           and may change an owner's grant only if it is their own. Nobody removes or demotes a
//                           board's last owner (code `last-owner`; the Registry enforces it atomically too).
// Refusals throw AdminError. For anything naming a board, an unknown board and a caller without rights get the
// same `forbidden` error, so existence doesn't leak.

import { ROLES, LINK_ROLES, INVITE_ROLES, normEmail } from "../auth/util.js";
import { isUnitAdmin } from "../auth/resolver.js";

/** @typedef {import("../auth/registry-port.js").Registry} Registry */
/** @typedef {import("../auth/idp-port.js").Identity} Identity */

export class AdminError extends Error {
  /**
   * @param {"forbidden"|"bad-request"|"not-found"|"last-owner"|"unknown-person"|"bad-role"|"too-large"} code
   * @param {string} [message]
   * @param {{ cause?: unknown }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }
}
const forbidden = () => new AdminError("forbidden", "not allowed");
const bad = m => new AdminError("bad-request", m);

/** Is the caller an admin of the tenant? The rule is the resolver's (server/auth/resolver.js, isUnitAdmin). */
async function isTenantAdmin(registry, caller, tenantId) {
  if (!caller || typeof caller.user !== "string" || typeof tenantId !== "string") return false;
  return isUnitAdmin(await registry.tenant(tenantId), caller);
}

/** The board, if the caller may manage it; else throws `forbidden` (unknown board included). */
async function managed(registry, caller, boardId) {
  if (!caller || typeof caller.user !== "string" || typeof boardId !== "string") throw forbidden();
  const b = await registry.board(boardId);
  if (!b) throw forbidden();
  if ((await registry.grant(b.id, caller.user)) === "owner") return b;
  if (await isTenantAdmin(registry, caller, b.tenant)) return b;
  throw forbidden();
}

/**
 * May a NEW direct grant on `board` name `user`? Only a person the server has reason to know on this board: one in the board's Unit's directory (or an admin
 * of it named by id), one who already holds a grant here, or one who redeemed a link of this board (a guest the owner shared with). Never an `email:` entry,
 * never another Unit's member or an id nobody has seen. One rule for both routes that write a person's board grant (PROTOCOL.md § Teams and access).
 * @param {Registry} registry @param {{ id: string, tenant: string }} board @param {string} user
 */
export async function knownOnBoard(registry, board, user) {
  if (typeof user !== "string" || !user || user.length > 200 || /[\0\n]/.test(user) || user.startsWith("email:")) return false;
  if (await registry.grant(board.id, user)) return true;
  if ((await registry.membersAmong(board.tenant, [user])).length) return true;
  if ((await registry.tenant(board.tenant))?.admins?.includes(user)) return true;
  return (await registry.linkUses(board.id, user)).length > 0;
}

const expiry = (v, now) => {
  if (v == null) return null;
  if (!Number.isFinite(v) || v <= now) throw bad("expiresAt must be a future time (ms)");
  return v;
};

/** Give a user an explicit role on a board (or remove it with null). See the rules at the top. */
export async function setGrant({ caller, board, user, role }, { registry }) {
  const b = await managed(registry, caller, board);
  if (role !== null && !ROLES.includes(role)) throw bad("bad role");
  if (typeof user !== "string" || !user) throw bad("bad user");
  const admin = await isTenantAdmin(registry, caller, b.tenant);
  const current = await registry.grant(b.id, user);
  if (!admin) {
    if (role === "owner") throw forbidden();
    if (current === "owner" && user !== caller.user) throw forbidden();
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
}

/** Invite an email to a board. Works across domains. */
export async function createInvite({ caller, board, email, role, expiresAt = null, idem }, { registry, now = Date.now }) {
  const b = await managed(registry, caller, board);
  const e = normEmail(email);
  if (!e || !/^[^@\s]+@[^@\s]+$/.test(e) || e.length > 320) throw bad("bad email");
  if (!INVITE_ROLES.includes(role)) throw bad("bad role");
  return registry.createInvite({ board: b.id, email: e, role, expiresAt: expiry(expiresAt, now()), by: caller.user, idem });
}
/** One live invite of a board the caller manages (the replay of a keyed create: PROTOCOL.md "Idempotent creates"); else `forbidden`, or `not-found` for a missing, revoked or expired one. */
export async function readInvite({ caller, board, invite }, { registry, now = Date.now }) {
  const b = await managed(registry, caller, board);
  const i = await registry.invite(invite);
  if (!i || i.board !== b.id || i.revoked || (i.expiresAt != null && i.expiresAt <= now())) throw new AdminError("not-found", "not found");   // a revoked or expired one is gone: 404, not a 201
  return i;
}
export async function listInvites({ caller, board }, { registry }) {
  const b = await managed(registry, caller, board);
  return registry.invites(b.id);
}
export async function revokeInvite({ caller, board, invite }, { registry }) {
  const b = await managed(registry, caller, board);
  const i = await registry.invite(invite);
  if (!i || i.board !== b.id) throw forbidden();
  await registry.revokeInvite(i.id);
}

/** Make a share link: an unguessable id, a role (editor, annotator or viewer), optional expiry. */
export async function createLink({ caller, board, role, expiresAt = null, idem }, { registry, now = Date.now }) {
  const b = await managed(registry, caller, board);
  if (!LINK_ROLES.includes(role)) throw bad("links carry only editor, annotator or viewer");
  return registry.createLink({ board: b.id, role, expiresAt: expiry(expiresAt, now()), by: caller.user, idem });
}
/** One live link of a board the caller manages (the replay of a keyed create); else `forbidden`, or `not-found` for a missing, revoked or expired one. */
export async function readLink({ caller, board, link }, { registry, now = Date.now }) {
  const b = await managed(registry, caller, board);
  const l = await registry.link(link);
  if (!l || l.board !== b.id || l.revoked || (l.expiresAt != null && l.expiresAt <= now())) throw new AdminError("not-found", "not found");   // a revoked or expired one is gone: 404, not a 201
  return l;
}
export async function listLinks({ caller, board }, { registry }) {
  const b = await managed(registry, caller, board);
  return registry.links(b.id);
}
export async function revokeLink({ caller, board, link }, { registry }) {
  const b = await managed(registry, caller, board);
  const l = await registry.link(link);
  if (!l || l.board !== b.id) throw forbidden();
  await registry.revokeLink(l.id);
}
