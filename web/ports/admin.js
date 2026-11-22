// @ts-check
// Admin & share API port: boards list/create, share links, email invites, member grants, and audit logs.
// Pure JSDoc contract — imports nothing at runtime (checked by test/web/architecture.test.js).
// Production adapter: web/adapters/admin/http.js (Bearer-authenticated over fetch).

/**
 * @typedef {{ status: number, code: string, message: string }} AdminHttpErrorShape
 * @typedef {{ id: string, name: string, domain: string | null, isAdmin: boolean }} AdminTenant
 * @typedef {{ id: string, tenant: string, title: string, memberRole: string | null, createdAt: number, role?: string }} AdminBoard
 * @typedef {{ id: string, board: string, role: string, expiresAt: number | null, revoked: boolean, by: string, createdAt: number }} AdminLink
 * @typedef {{ id: string, board: string, email: string, role: string, expiresAt: number | null, revoked: boolean, by: string, createdAt: number }} AdminInvite
 * @typedef {{ id: number, tenant: string, board: string | null, actor: string, action: string, target: string | null, detail: any, at: number }} AdminAuditEvent
 * @typedef {{ events: AdminAuditEvent[], nextBefore: string | null }} AdminAuditPage
 *
 * @typedef {object} AdminPort
 * @property {() => Promise<{ tenants: AdminTenant[] }>} listTenants
 * @property {(o: { name: string }) => Promise<{ tenant: AdminTenant }>} createTenant
 * @property {(tenant: string) => Promise<{ members: string[], admins: string[] }>} listTenantMembers
 * @property {(tenant: string, email: string) => Promise<{ email: string }>} addTenantMember
 * @property {(tenant: string, email: string) => Promise<void>} removeTenantMember
 * @property {() => Promise<{ boards: AdminBoard[], isAdmin: boolean }>} listBoards
 * @property {(o?: { title?: string, memberRole?: string | null, tenant?: string }) => Promise<{ board: AdminBoard }>} createBoard
 * @property {(board: string, patch: { title?: string, memberRole?: string | null }) => Promise<{ board: AdminBoard }>} updateBoard
 * @property {(board: string) => Promise<void>} deleteBoard
 * @property {(board: string) => Promise<{ links: AdminLink[] }>} listLinks
 * @property {(board: string, o: { role: string, expiresAt?: number | null }) => Promise<{ link: AdminLink, url?: string }>} createLink
 * @property {(board: string, id: string) => Promise<void>} revokeLink
 * @property {(board: string) => Promise<{ invites: AdminInvite[] }>} listInvites
 * @property {(board: string, o: { email: string, role: string, expiresAt?: number | null }) => Promise<{ invite: AdminInvite }>} createInvite
 * @property {(board: string, id: string) => Promise<void>} revokeInvite
 * @property {(board: string, user: string, role: string | null) => Promise<void>} setGrant
 * @property {(board: string, o?: { limit?: number, before?: string | null }) => Promise<AdminAuditPage>} boardAudit
 * @property {(o?: { tenant?: string | null, board?: string | null, limit?: number, before?: string | null }) => Promise<AdminAuditPage>} adminAudit
 */

export {};
