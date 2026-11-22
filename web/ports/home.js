// Home port: the Home screen's reads and the star toggle (PROTOCOL.md § Home, GET /home, GET /home/search, PUT/DELETE
// /home/stars/:board). Imports nothing. Contract test: test/web/adapters/home-http.test.js (the http adapter over a fake fetch).
//
// Contract: every call ALWAYS resolves (never rejects) to a value; a failure is `{ error }` with one of HOME_ERRORS:
//   "auth"         the server refused the token (401): sign in again
//   "forbidden"    star only: the person has no role on that board (403)
//   "unavailable"  a 5xx, bad JSON, a body of the wrong shape, or no answer in time
//   "network"      no answer at all
//
//   load()          → { home }   the shape of GET /home, normalised: { guest, user: { user, name }, unit: { id, kind } | null,
//                                  recent, starred, owned, shared: Card[], tree: Tree | null, limits }. A guest (no Unit) has no
//                                  starred and no tree; `owned` ("Your boards") is a guest's owner-granted boards, [] for a member
//   search(q)       → { q, results: Card[], more }   q is 1-100 chars (the caller checks)
//   star(board, on) → { ok: true }   (a guest's star is refused: "forbidden")
//   Card = { id, title, role, path: [{ type, id?, name }], starred, at? }; Tree = { groups: [{ id, name, spaces: [{ id, name, personal }] }],
//          spaces: [{ id, name, personal }], more }
// The token is a secret: the adapter sends it as `Authorization: Bearer` only and never logs it.

/** Every `error` value a call can resolve with. */
export const HOME_ERRORS = Object.freeze(["auth", "forbidden", "unavailable", "network"]);

/**
 * @typedef {{ type: "group"|"space"|"shared", id?: string, name: string }} PathPart   "shared": "Shared with you", what stands for a Space or Group the person can't open
 * @typedef {{ id: string, title: string, role: string, path: PathPart[], starred: boolean, at?: number }} Card
 * @typedef {{ id: string, name: string, personal: boolean }} SpaceNode
 * @typedef {{ groups: { id: string, name: string, spaces: SpaceNode[] }[], spaces: SpaceNode[], more: boolean }} Tree
 * @typedef {{ guest: boolean, user: { user: string, name: string }, unit: { id: string, kind: string } | null,
 *   recent: Card[], starred: Card[], owned: Card[], shared: Card[], tree: Tree | null, limits: Record<string, number>, can: { createGroup: boolean, manageAccess: boolean, manageRoles: boolean } }} HomeData
 * @typedef {object} HomePort
 * @property {() => Promise<{ home: HomeData } | { error: string }>} load
 * @property {(q: string) => Promise<{ q: string, results: Card[], more: boolean } | { error: string }>} search
 * @property {(board: string, on: boolean) => Promise<{ ok: true } | { error: string }>} star
 */
export {};
