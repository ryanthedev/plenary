// Spaces port: the Space and Group pages, the New board / New space pickers, create, rename and general access
// (PROTOCOL.md § Spaces and Groups). Imports nothing. Contract test: test/web/adapters/spaces-http.test.js (the http adapter over a fake fetch).
//
// Every call ALWAYS resolves (never rejects) to a value; a failure is `{ error }` with one of SPACES_ERRORS:
//   "auth"         401: sign in again
//   "forbidden"    403: the person may not do that (an unknown or hidden id answers the same)
//   "notfound"     404: a page read of a Space or Group the person can't open (or that is not there)
//   "invalid"      400: the server refused the input (the page checks it first, so this is rare)
//   "unavailable"  a 5xx, bad JSON, a body of the wrong shape, or no answer in time
//   "network"      no answer at all
//
//   space(id)               → { page: SpacePage }
//   group(id, after?)       → { page: GroupPage }
//   boardSpaces()           → { spaces: PickSpace[], more }     GET /spaces?can=board.create
//   spaceGroups()           → { root, groups: { id, name }[], more }   GET /groups?can=space.create
//   createBoard({ title, space? })          → { board: { id } }
//   createSpace({ name, group?, general? }) → { space: { id, name } }
//   updateSpace(id, { name?, general? })    → { space }     updateGroup(id, patch) → { group }
//   renameBoard(id, title)                  → { board: { id, title } }
//   Card = { id, title, role, path, starred, can?: { rename } } (as Home's);  `general`: a role name or null (only people added)

/** Every `error` value a call can resolve with. */
export const SPACES_ERRORS = Object.freeze(["auth", "forbidden", "notfound", "invalid", "unavailable", "network"]);

/**
 * @typedef {{ id: string, name: string, personal: boolean, general: string|null, group: { id: string, name: string }|null }} SpaceInfo
 * @typedef {{ space: SpaceInfo, can: { createBoard: boolean, rename: boolean, general: boolean }, boards: object[], more: boolean }} SpacePage
 * @typedef {{ group: { id: string, name: string, general: string|null }, can: { createSpace: boolean, rename: boolean, general: boolean },
 *   spaces: { id: string, name: string, general: string|null }[], next: string|null }} GroupPage
 * @typedef {SpaceInfo} PickSpace
 * @typedef {object} SpacesPort
 * @property {(id: string) => Promise<{ page: SpacePage } | { error: string }>} space
 * @property {(id: string, after?: string|null) => Promise<{ page: GroupPage } | { error: string }>} group
 * @property {() => Promise<{ spaces: PickSpace[], more: boolean } | { error: string }>} boardSpaces
 * @property {() => Promise<{ root: boolean, groups: { id: string, name: string }[], more: boolean } | { error: string }>} spaceGroups
 * @property {(o: { title: string, space?: string|null }) => Promise<{ board: { id: string } } | { error: string }>} createBoard
 * @property {(o: { name: string, group?: string|null, general?: string|null }) => Promise<{ space: SpaceInfo } | { error: string }>} createSpace
 * @property {(id: string, patch: { name?: string, general?: string|null }) => Promise<{ space: SpaceInfo } | { error: string }>} updateSpace
 * @property {(id: string, patch: { name?: string, general?: string|null }) => Promise<{ group: { id: string, name: string, general: string|null } } | { error: string }>} updateGroup
 * @property {(id: string, title: string) => Promise<{ board: { id: string, title: string } } | { error: string }>} renameBoard
 */
export {};
