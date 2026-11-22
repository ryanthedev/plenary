// Access port: Teams, the access page of a scope and its grant writes, and the people/Team search the one picker uses (PROTOCOL.md § Teams and
// access). Imports nothing. Contract test: test/web/adapters/access-http.test.js (the http adapter over a fake fetch).
//
// Every call ALWAYS resolves (never rejects): a value, or `{ error, code? }` with one of ACCESS_ERRORS:
//   "auth"         401: sign in again
//   "forbidden"    403: not allowed (an unknown, hidden or other-Unit id answers the same)
//   "notfound"     404: a page the person can't open (or that is not there)
//   "invalid"      400: refused input; `code` "unknown-person" (not a member of this Unit) or "bad-role" (not a role for this scope) when the server says so
//   "limited"      429: too many requests for access (`retryAfter` seconds when the server says)
//   "conflict"     409: `code` "last-owner" (a Space or Group keeps one owner) or "too-large"
//   "unavailable"  a 5xx, bad JSON, a body of the wrong shape, or no answer in time
//   "network"      no answer at all
//
//   teams({ after?, q? })        → { teams: TeamRow[], next, can: { create } }
//   team(id, after?)             → { page: TeamPage }
//   createTeam(name)             → { team: TeamRow }
//   renameTeam(id, name)         → { team: TeamRow }
//   deleteTeam(id)               → {}
//   setMember(team, user, on)    → {}                                  PUT / DELETE /teams/:id/members/:user
//   directory(q)                 → { people: Person[], teams: TeamRow[] }
//   access(type, id, after?)     → { page: AccessPage }                type: unit | group | space | board
//   setGrant(type, id, subject, role) → { row: Row }                   subject = { type: "user"|"team", id }
//   removeGrant(type, id, subject)    → {}
//   ask(type, id, role, key?)         → { request: { role, roleName, at, state } }   POST /access/:type/:id/requests (Ask for access; `key` = the Idempotency-Key of one submit, reused by its retries;
//                                       type: group | space | board). "limited" (429) carries `retryAfter` seconds (or none).
//   dismissRequest(type, id, user)    → {}                              DELETE /access/:type/:id/requests/:user (an owner dismisses)
//   explainBoard(id)                  → { why: Explain }                GET /boards/:board/explain (the canvas pill; a guest gets their own sources only)

export const ACCESS_ERRORS = Object.freeze(["auth", "forbidden", "notfound", "invalid", "limited", "conflict", "unavailable", "network"]);

/**
 * @typedef {{ id: string, name: string, size: number }} TeamRow          size 1001 = more than 1000
 * @typedef {{ user: string, name: string, email: string|null }} Person
 * @typedef {{ type: "user"|"team", id: string, name: string, email?: string|null, size?: number }} Subject
 * @typedef {{ subject: Subject, role: string, roleName: string, via: "direct"|"team"|"inherited", can?: { change: boolean, remove: boolean }, scope?: { type: string, id: string, name?: string } }} Row
 * @typedef {{ id: string, name: string, custom: boolean, summary: string, ladder: string|null, people: boolean }} RoleOption
 * @typedef {{ team: TeamRow, can: { manage: boolean }, members: Person[], next: string|null }} TeamPage
 * @typedef {{ scope: { type: string, id: string, name?: string, personal?: boolean }, can: { manage: boolean }, hiddenAbove?: true, general: { scope: { type: string, id: string, name?: string }, role: string }[],
 *   admins?: Person[], rows: Row[], next: string|null, inherited: Row[], roles: RoleOption[], organization?: { admins: { user: string, name: string }[], more: boolean, memberRole: string|null },
 *   requests?: { user: { id: string, name: string, email: string|null }, role: string, roleName: string, at: number }[], why?: import("../core/explain.js").Explain }} AccessPage
 * @typedef {object} AccessPort
 */
export {};
