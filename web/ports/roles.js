// Roles port: the Roles screen's reads and writes (PROTOCOL.md § Roles). Imports nothing. Contract test: test/web/adapters/roles-http.test.js.
//
// Every call ALWAYS resolves (never rejects): a value, or `{ error, code?, ... }` with one of ROLES_ERRORS:
//   "auth"         401
//   "forbidden"    403: no `roles.manage`, or a role the caller may not touch (an unknown, hidden or other-Unit id answers the same)
//   "notfound"     404: GET /roles without `roles.manage`
//   "invalid"      400 / 422: refused input
//   "conflict"     409: `code` "confirm-required" with `impact: { places, people, capped }` (the edit reaches many people: ask, then send again with
//                  confirm), "in-use" with `used: { places, capped }`, or "too-large" (the Unit has the most custom roles it can)
//   "unavailable"  a 5xx, bad JSON, a body of the wrong shape, or no answer in time (a create is retried with its key while the server says in progress)
//   "network"      no answer at all
//
//   roles()                                  → { page: RolesPage }
//   createRole({ name, base?, boardRole, permissions, key? }) → { role: RoleView }      POST /roles with Idempotency-Key `key`
//   updateRole(id, { name?, boardRole?, permissions?, confirm? }) → { role: RoleView }
//   removeRole(id)                           → {}

export const ROLES_ERRORS = Object.freeze(["auth", "forbidden", "notfound", "invalid", "conflict", "unavailable", "network"]);

/**
 * @typedef {{ id: string, name: string, kind: "builtin"|"member"|"custom", editable: boolean, summary?: string, base?: string, ladder: string|null, permissions: string[],
 *   scopes: Record<"unit"|"group"|"space"|"board", string[]>, used: { places: number, capped: boolean }|{ members: number, capped: boolean }|null }} RoleView
 * @typedef {{ scopes: string[], permissions: { id: string, group: "content"|"management", scopes: string[] }[], content: Record<string, string[]>, ladders: string[], tickable: string[] }} Matrix
 * @typedef {{ roles: RoleView[], matrix: Matrix, can: { admin: boolean }, limits: { custom: number, many: { places: number, people: number } } }} RolesPage
 * @typedef {object} RolesPort
 */
export {};
