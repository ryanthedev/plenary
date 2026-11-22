// @ts-check
// Share port: the Share dialog's calls (PROTOCOL.md § Share dialog). Imports nothing. Contract test: test/web/adapters/share-http.test.js (the http adapter over a fake fetch).
//
// Every call ALWAYS resolves (never rejects): a value, or `{ error, code? }` with one of SHARE_ERRORS:
//   "auth" 401 · "forbidden" 403 (no members.manage here; an unknown board answers the same) · "notfound" 404 · "invalid" 400/422 · "conflict" 409 · "limited" 429
//   "unavailable" a 5xx, bad JSON, a wrong shape or no answer in time · "network" no answer at all
//
//   view(board)                          → { view: ShareView }                            GET /boards/:board/share
//   invite(board, { email, role, expiresAt? }, key?)  → { invite: Invite }               POST /boards/:board/invites   (`key`: the Idempotency-Key of one submit, reused by its retries; `expiresAt` omitted = the server's 30 days)
//   link(board, { role, expiresAt? }, key?)           → { link: Link }                   POST /boards/:board/links
//   revokeInvite(board, id)              → {}                                           DELETE /boards/:board/invites/:id   (idempotent)
//   revokeLink(board, id)                → {}                                           DELETE /boards/:board/links/:id     (idempotent)

export const SHARE_ERRORS = Object.freeze(["auth", "forbidden", "notfound", "invalid", "conflict", "limited", "unavailable", "network"]);

/**
 * @typedef {{ id: string, email: string, role: string, expiresAt: number|null, createdAt: number, guest: boolean }} Invite
 * @typedef {{ id: string, role: string, expiresAt: number|null, createdAt: number, url?: string }} Link
 * @typedef {{ board: { id: string, title: string }, unit: { domains: string[] }|null, limits: { inviteRoles: string[], linkRoles: string[], inviteTtlMs: number }, invites: Invite[], links: Link[], more: boolean }} ShareView
 * @typedef {object} SharePort
 * @property {(board: string) => Promise<Record<string, any>>} view
 * @property {(board: string, o: { email: string, role: string, expiresAt?: number|null }, key?: string|null) => Promise<Record<string, any>>} invite
 * @property {(board: string, o: { role: string, expiresAt?: number|null }, key?: string|null) => Promise<Record<string, any>>} link
 * @property {(board: string, id: string) => Promise<Record<string, any>>} revokeInvite
 * @property {(board: string, id: string) => Promise<Record<string, any>>} revokeLink
 */
export {};
