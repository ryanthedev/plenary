// Offboarding port: the calls behind the leaver screen (PROTOCOL.md § Leaver offboarding). Imports nothing. Contract test: test/web/adapters/offboard-http.test.js (the http adapter over a fake fetch).
//
// Every call ALWAYS resolves (never rejects): a value, or `{ error, code? }` with one of OFFBOARD_ERRORS:
//   "auth" 401 · "forbidden" 403 (no `members.manage`, or an item the caller may not hand out: one answer) · "notfound" 404 (a person the Unit never saw)
//   · "invalid" 400/422 (`code` "bad-recipient": the new owner is not a live member) · "conflict" 409 (`code` "still-owns" | "is-admin")
//   · "unavailable" a 5xx, bad JSON, a wrong shape or no answer in time · "network" no answer at all
//
//   list(user, after?)                    → { page: Page }                GET  /members/:user/offboarding
//   reassign(user, { type, id, to }, key) → { result: Reassigned }        POST /members/:user/offboarding/reassign   (`key`: the Idempotency-Key of one submit, reused by its retries)
//   remove(user, key)                     → { result: Removed }           POST /members/:user/remove
//   people(q)                             → { people: Person[] }          GET  /directory?q=   (the recipient picker; people only)

export const OFFBOARD_ERRORS = Object.freeze(["auth", "forbidden", "notfound", "invalid", "conflict", "unavailable", "network"]);

/**
 * @typedef {{ id: string, name: string }} Person
 * @typedef {{ type: "space"|"group", id: string, name: string, personal: boolean, archived: boolean, trashed: boolean, boards?: number, boardsCapped?: boolean, can: { reassign: boolean, why?: string } }} Item
 * @typedef {{ member: { id: string, name: string, email: string|null, removed: boolean }, defaults: { recipient: Person, reason: "manager"|"remover" }, items: Item[], next: string|null, blocked: "admin"|null, canRemove: boolean }} Page
 * @typedef {{ item: { type: string, id: string, name: string, archived: boolean }, to: Person, done: boolean }} Reassigned
 * @typedef {{ removed: boolean, grants: number|null, scopedGrants: number|null, teams: number|null }} Removed
 * @typedef {object} OffboardPort
 */
export {};
