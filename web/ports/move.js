// @ts-check
// Move port: the Move dialog's calls (PROTOCOL.md § Move board). Imports nothing. Contract test: test/web/adapters/move-http.test.js (the http adapter over a fake fetch).
//
// Every call ALWAYS resolves (never rejects): a value, or `{ error }` with one of MOVE_ERRORS:
//   "auth" 401 · "forbidden" 403 (not allowed to move this board, or into that Space; an unknown board answers the same) · "notfound" 404 · "invalid" 400/422 · "moved" 409 (the board is
//   no longer where the caller thought) · "unavailable" a 5xx, bad JSON, a wrong shape or no answer in time · "network" no answer at all
//
//   options(board)                     → { options: MoveOptions }            GET  /boards/:board/move
//   preview(board, to)                 → { diff: MoveDiff }                  GET  /boards/:board/move/preview?to=
//   move(board, { from, to }, key?)    → { result: MoveResult }              POST /boards/:board/move   (`key`: the Idempotency-Key of one submit, reused by its retries; Undo is a move with its own key)

export const MOVE_ERRORS = Object.freeze(["auth", "forbidden", "notfound", "invalid", "moved", "unavailable", "network"]);

/**
 * @typedef {{ id: string, name: string, personal: boolean, general: string|null, group: { id: string, name: string }|null }} Destination
 * @typedef {{ board: { id: string, title: string }, from: { id: string, name: string, personal: boolean }|{ hidden: true }, destinations: Destination[], more: boolean }} MoveOptions
 * @typedef {{ id: string, name: string }} RoleView
 * @typedef {{ subject: { type: "user"|"team"|"everyone", id?: string, name: string }, self?: boolean, before: RoleView|null, after: RoleView|null }} DiffEntry
 * @typedef {{ board: { id: string, title: string }, from: object|null, to: { id: string, name: string, personal: boolean }, gains: DiffEntry[], keeps: DiffEntry[], loses: DiffEntry[], invites: number|null, links: number|null, hidden: boolean, more: boolean }} MoveDiff
 * @typedef {{ board: { id: string, title: string, space: { id: string, name: string } }, moved: boolean, undo: { space: { id: string, name: string, personal: boolean } }|null }} MoveResult
 * @typedef {object} MovePort
 * @property {(board: string) => Promise<Record<string, any>>} options
 * @property {(board: string, to: string) => Promise<Record<string, any>>} preview
 * @property {(board: string, o: { from?: string, to: string }, key?: string|null) => Promise<Record<string, any>>} move
 */
export {};
