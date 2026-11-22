// The Registry port (PROTOCOL.md § Registry): tenants, the board registry (`Registry.board(id)`; the Store has no
// board lookup), per-board grants, invites and share links. No adapter code here: adapters are server/auth/registry.js
// (memory) and server/registry/{sqlite,postgres}.js (engine). Every adapter passes test/auth/registry-contract.js.
// Method names are STABLE.
//
// Last owner: `setGrant` refuses to remove or demote a board's last `owner` grant, throwing an error whose
// `code` is "last-owner" (match on the code, not the class: other adapters throw their own). The check and the
// write are one atomic step (in one JS process: no await between them; in SQL: one transaction or a conditional
// write), and a refused call changes nothing. Caller rules (who may grant what) live in server/admin/boards.js.
//
// Failure semantics (what a second adapter must honour): a lookup of something absent resolves to null / [] /
// false; a write against a missing tenant / board / link rejects; an infrastructure failure (database down,
// timeout) REJECTS, never resolves to null, because callers turn null into a refusal ("no role") and a rejection
// into `unavailable` (server/auth/port.js, http.js). Reads return copies the caller may mutate freely.
// Consistency: reads see every write acknowledged before them (read-your-writes and no stale replica reads), so a
// revoked grant, invite or link stops working on the very next role().
//
// Batch (p5-load, OPTIONAL): `linkUsesFor(board, users)` answers `linkUses(board, u)` for every u in `users` in one
// round trip: a Map with an entry for each requested user that has at least one use on that board (absent = []),
// each list in the order `linkUses` gives. Callers pass at most 1000 users per call (tenancy.js USE_CHUNK), so a
// SQL adapter can bind them as one array parameter. An adapter without it is still a Registry: tenancy.js falls
// back to one `linkUses` per user. test/auth/registry-contract.js checks it when the adapter passes { batch: true }.
//
// Every method is async. Ids are server-minted over [a-z0-9-] (no ".", "*", ">"), never a domain name, so they
// are safe in bus subjects (PROTOCOL.md § Bus). Mint them with `mint` below, so every adapter shares the format.

import { randomId } from "./util.js";

/** Thrown by `setGrant` when the change would leave a board with no owner. Match on `err.code === "last-owner"`. */
export class RegistryError extends Error {
  /** @param {"last-owner"} code */
  constructor(code, message) { super(message); this.name = "RegistryError"; this.code = code; }
}

/** Tenant ids: "t-" + 12 of [a-z0-9]. Board ids: "b-" + 16. Invite ids: "i-" + 16. Link ids: 26 (≈ 134 bits). */
export const mint = {
  tenant: () => "t-" + randomId(12),
  board: () => "b-" + randomId(16),
  invite: () => "i-" + randomId(16),
  link: () => randomId(26),
};

/**
 * @typedef {"owner"|"editor"|"annotator"|"commenter"|"viewer"} Role
 * @typedef {{ id: string, domain: string|null, admins: string[], createdAt: number }} Tenant
 * @typedef {{ id: string, tenant: string, title: string, memberRole: Role|null, createdAt: number }} Board
 * @typedef {Board & { role: Role }} BoardAccess
 * @typedef {{ id: string, board: string, email: string, role: Role, expiresAt: number|null, revoked: boolean, by: string, createdAt: number }} Invite
 * @typedef {{ id: string, board: string, role: Role, expiresAt: number|null, revoked: boolean, by: string, createdAt: number }} Link
 * @typedef {{ id: number, tenant: string, board: string|null, actor: string, action: string, target: string|null, detail: any, at: number }} AuditEvent
 * @typedef {{ events: AuditEvent[], nextBefore: string|null }} AuditPage
 *
 * @typedef {{
 *   createTenant(o: { domain: string|null, admins?: string[] }): Promise<Tenant>,
 *   tenant(id: string): Promise<Tenant|null>,
 *   tenantByDomain(domain: string): Promise<Tenant|null>,
 *   addTenantAdmin(tenant: string, user: string): Promise<void>,
 *   createBoard(o: { tenant: string, title?: string, memberRole?: Role|null }): Promise<Board>,
 *   board(id: string): Promise<Board|null>,
 *   listBoards(tenant: string): Promise<Board[]>,
 *   listBoardsFor(tenant: string, user: string, opts?: { email?: string|null, isMember?: boolean, at?: number }): Promise<BoardAccess[]>,
 *   setGrant(board: string, user: string, role: Role|null): Promise<void>,   // rejects code "last-owner" (atomic)
 *   grant(board: string, user: string): Promise<Role|null>,
 *   grants(board: string): Promise<{ user: string, role: Role }[]>,
 *   createInvite(o: { board: string, email: string, role: Role, expiresAt?: number|null, by: string }): Promise<Invite>,
 *   invite(id: string): Promise<Invite|null>,
 *   invites(board: string): Promise<Invite[]>,
 *   invitesFor(board: string, email: string): Promise<Invite[]>,
 *   revokeInvite(id: string): Promise<boolean>,
 *   createLink(o: { board: string, role: Role, expiresAt?: number|null, by: string }): Promise<Link>,
 *   link(id: string): Promise<Link|null>,
 *   links(board: string): Promise<Link[]>,
 *   revokeLink(id: string): Promise<boolean>,
 *   addLinkUse(link: string, user: string): Promise<void>,
 *   linkUses(board: string, user: string): Promise<string[]>,
 *   linkUsesFor?(board: string, users: string[]): Promise<Map<string, string[]>>,   // OPTIONAL batch (below)
 *   appendAudit(o: { tenant: string, board?: string|null, actor: string, action: string, target?: string|null, detail?: any, at?: number }): Promise<AuditEvent>,
 *   listAudit(o: { tenant: string, board?: string|null, limit?: number, before?: string|null }): Promise<AuditPage>,
 * }} Registry
 */

export {};
