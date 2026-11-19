// Trash port: the calls behind Move to Trash, its Undo, the Trash page and the board-URL notice (PROTOCOL.md § Trash and restore). Imports nothing. Contract test: test/web/adapters/trash-http.test.js
// (the http adapter over a fake fetch).
//
// Every call ALWAYS resolves (never rejects): a value, or `{ error }` with one of TRASH_ERRORS:
//   "auth" 401 · "forbidden" 403 (no `delete` there, or nothing to see: an unknown board answers the same) · "notfound" 404 · "invalid" 400/422 · "moved" 409 (the board is in another Space than the caller thought)
//   · "with-space" 409 (the board went to Trash with its Space: restore the Space) · "space-in-trash" 409 (its Space is in Trash) · "purged" 409 (being deleted for good)
//   · "unavailable" a 5xx, bad JSON, a wrong shape or no answer in time · "network" no answer at all
//
//   trash(board, { from }, key?)       → { result: TrashResult }    POST /boards/:board/trash   (`key`: the Idempotency-Key of one submit, reused by its retries)
//   restore(board, key?)               → { result: RestoreResult }  POST /boards/:board/restore
//   trashSpace(space, key?)            → { result: SpaceResult }    POST /spaces/:space/trash
//   restoreSpace(space, key?)          → { result: SpaceResult }    POST /spaces/:space/restore
//   notice(board)                      → { notice: Notice }         GET  /boards/:board/trash
//   list()                             → { list: { items: Item[], more: boolean } }   GET /trash

export const TRASH_ERRORS = Object.freeze(["auth", "forbidden", "notfound", "invalid", "moved", "with-space", "space-in-trash", "purged", "unavailable", "network"]);

/**
 * @typedef {{ board: { id: string, title: string, space: { id: string, name: string } }, trashed: boolean, trashedAt: number, expiresAt: number, undo: { restore: true }|null }} TrashResult
 * @typedef {{ board: { id: string, title: string, space: { id: string, name: string } }, restored: boolean }} RestoreResult
 * @typedef {{ space: { id: string, name: string }, trashed?: boolean, restored?: boolean, boards: number, undo?: { restore: true }|null }} SpaceResult
 * @typedef {{ board: { id: string, title: string }, trashedAt: number, expiresAt: number, daysLeft: number, canRestore: boolean, by?: { id: string, name: string },
 *   from?: { space: { id: string, name: string, personal: boolean }|null, group: { id: string, name: string }|null }, via?: { space: { id: string, name: string }|null, canRestore: boolean } }} Notice
 * @typedef {{ type: "board", id: string, title: string, from: { space: { id: string, name: string, personal: boolean }|null, group: { id: string, name: string }|null }, by: { id: string, name: string }|null, trashedAt: number, expiresAt: number, daysLeft: number }
 *   | { type: "space", id: string, name: string, group: { id: string, name: string|null }|null, boards: number, by: { id: string, name: string }|null, trashedAt: number, expiresAt: number, daysLeft: number }} Item
 * @typedef {object} TrashPort
 */
export {};
