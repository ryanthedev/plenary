// Admin functions: POST /boards and invite / share-link management, as plain functions (HTTP wiring: server/auth/http.js).
// A hello never creates a board; only createBoard does.
//
// Who may do what:
//   createBoard:            an admin of the named tenant (by user id, or by email: isTenantAdmin below).
//   invites and links:      the board's owner (grant) or an admin of the board's tenant.
//   grants:                 a tenant admin sets any role, owner included. A board owner sets roles up to editor,
//                           and may change an owner's grant only if it is their own. Nobody removes or demotes a
//                           board's last owner (code `last-owner`; the Registry enforces it atomically too).
// Refusals throw AdminError. For anything naming a board, an unknown board and a caller without rights get the
// same `forbidden` error, so existence doesn't leak.

import { ROLES, LINK_ROLES, INVITE_ROLES, normEmail } from "../auth/util.js";

/** @typedef {import("../auth/registry-port.js").Registry} Registry */
/** @typedef {import("../auth/idp-port.js").Identity} Identity */

export class AdminError extends Error {
  /**
   * @param {"forbidden"|"bad-request"|"last-owner"|"owner-grant-failed"} code
   * @param {string} [message]
   * @param {{ board?: string, cause?: unknown }} [extra]  `board`: the id of a board created without its owner grant
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    if (extra.board) this.board = extra.board;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }
}
const forbidden = () => new AdminError("forbidden", "not allowed");
const bad = m => new AdminError("bad-request", m);

/**
 * A tenant admin is named by user id (google:<sub>, dev:<name>) or, before their first sign-in, by email
 * (`email:<addr>`, server/admin/tenants.js). An email entry matches only a caller whose email the IdP vouches for
 * (Identity.email is set only then) AND whose Workspace domain is the tenant's, so a guest from another domain
 * holding that address elsewhere never becomes admin.
 */
async function isTenantAdmin(registry, caller, tenantId) {
  if (!caller || typeof caller.user !== "string" || typeof tenantId !== "string") return false;
  const t = await registry.tenant(tenantId);
  if (!t) return false;
  if (t.admins.includes(caller.user)) return true;
  const email = normEmail(caller.email);
  return !!email && !!t.domain && caller.domain === t.domain && t.admins.includes("email:" + email);
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

const expiry = (v, now) => {
  if (v == null) return null;
  if (!Number.isFinite(v) || v <= now) throw bad("expiresAt must be a future time (ms)");
  return v;
};

/**
 * POST /boards. The caller must be an admin of `tenant`. Mints the board id, writes the registry, makes the
 * caller owner. `memberRole` = what Workspace members of the tenant get (default `viewer`; null = nothing).
 * @param {{ caller: Identity, tenant: string, title?: string, memberRole?: string|null }} req
 * @param {{ registry: Registry }} deps
 */
export async function createBoard({ caller, tenant, title = "", memberRole = "viewer" }, { registry }) {
  if (!(await isTenantAdmin(registry, caller, tenant))) throw forbidden();
  if (memberRole !== null && (!ROLES.includes(memberRole) || memberRole === "owner")) throw bad("bad memberRole");
  if (typeof title !== "string" || title.length > 200) throw bad("bad title");
  const board = await registry.createBoard({ tenant, title, memberRole });
  // PROTOCOL.md § Registry: createBoard takes no creator, so the owner grant is a second call. Retry it once; if it
  // still fails, report the failure WITH the board id (never success for an ownerless board). A tenant admin can
  // still fix that board: they manage every board of their tenant, owner grants included.
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await registry.setGrant(board.id, caller.user, "owner"); return board; }
    catch (err) { last = err; }
  }
  throw new AdminError("owner-grant-failed", `board ${board.id} was created but its owner grant failed`, { board: board.id, cause: last });
}

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
export async function createInvite({ caller, board, email, role, expiresAt = null }, { registry, now = Date.now }) {
  const b = await managed(registry, caller, board);
  const e = normEmail(email);
  if (!e || !/^[^@\s]+@[^@\s]+$/.test(e) || e.length > 320) throw bad("bad email");
  if (!INVITE_ROLES.includes(role)) throw bad("bad role");
  return registry.createInvite({ board: b.id, email: e, role, expiresAt: expiry(expiresAt, now()), by: caller.user });
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
export async function createLink({ caller, board, role, expiresAt = null }, { registry, now = Date.now }) {
  const b = await managed(registry, caller, board);
  if (!LINK_ROLES.includes(role)) throw bad("links carry only editor, annotator or viewer");
  return registry.createLink({ board: b.id, role, expiresAt: expiry(expiresAt, now()), by: caller.user });
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
